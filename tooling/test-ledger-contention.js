'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-contention-'));
const worker = path.resolve(__dirname, '../plugins/autodev-core/scripts/unattended-worker.js');
const hook = path.resolve(__dirname, '../plugins/autodev-core/hooks/peer-send-ledger.js');
const preload = path.join(root, 'contention.cjs');
fs.writeFileSync(preload, `
const fs = require('fs');
const original = fs.writeFileSync;
let attempts = 0;
fs.writeFileSync = function(file, ...args) {
    if (file === process.env.LOCK_TARGET && args[1]?.flag === 'wx') {
        attempts++;
        original(process.env.ATTEMPTS, String(attempts));
        if (attempts <= Number(process.env.FAILURES)) {
            throw Object.assign(new Error('LOCK-CREATE-PLANT'), { code: process.env.FAILURE_CODE });
        }
    }
    return original.call(this, file, ...args);
};
`);
let passed = 0;
try {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        for (const failures of [2, 1000000]) {
            const file = path.join(root, code + failures + '.json');
            const attempts = file + '.attempts';
            fs.writeFileSync(file, JSON.stringify({ version: 1, records: [{ taskId: 'probe', state: 'queued' }] }));
            const r = spawnSync(process.execPath, ['--require', preload, worker, 'retire', '--ledger', file, '--task-id', 'probe'], {
                encoding: 'utf8', timeout: 5000, windowsHide: true,
                env: { ...process.env, LOCK_TARGET: file + '.lock', ATTEMPTS: attempts, FAILURE_CODE: code,
                    FAILURES: String(failures),
                    // Two planted failures sleep 50 ms each, which overran 150 ms on a slow macOS
                    // runner. The case that must succeed gets room; the one that must refuse stays short.
                    AUTODEV_LEDGER_LOCK_WAIT_MS: failures === 2 ? '5000' : '150' },
            });
            assert.equal(r.error, undefined);
            assert.equal(r.status, failures === 2 ? 0 : 1, r.stdout + r.stderr);
            assert.ok(Number(fs.readFileSync(attempts)) > 1, 'lock creation must retry ' + code);
            assert.equal(JSON.parse(fs.readFileSync(file)).records[0].state, failures === 2 ? 'retired' : 'queued');
            assert.ok(!fs.existsSync(file + '.lock'));
            if (failures !== 2) assert.match(r.stdout, /ledger-locked/);
            console.log('PASS worker create ' + code + ' failures=' + failures);
            passed++;
        }
    }
    const file = path.join(root, 'peer.jsonl');
    const payload = JSON.stringify({ tool_name: 'mcp__ccd_session_mgmt__send_message',
        tool_input: { session_id: 'target', message: 'fixture' },
        tool_response: '(delivery: queued; message_id: probe)' });
    const runHook = (input) => spawnSync(process.execPath, [hook], {
        input, encoding: 'utf8', timeout: 4500, windowsHide: true,
        env: { ...process.env, AUTODEV_PEER_LEDGER: file },
    });
    fs.writeFileSync(file + '.write-lock', 'other owner');
    const start = performance.now();
    const blocked = runHook(payload);
    assert.equal(blocked.error, undefined);
    assert.equal(blocked.status, 0);
    assert.equal(blocked.stdout + blocked.stderr, '');
    // The hook waits 2 s for a held lock, then skips. It must finish inside the
    // 5 s timeout hooks.json gives it, with room for node startup.
    assert.ok(performance.now() - start < 4000);
    assert.ok(!fs.existsSync(file), 'failed acquisition must skip append');
    assert.equal(fs.readFileSync(file + '.write-lock', 'utf8'), 'other owner');
    const ignored = runHook('{}');
    assert.equal(ignored.status, 0);
    assert.equal(ignored.stdout + ignored.stderr, '');
    fs.unlinkSync(file + '.write-lock');
    const control = runHook(payload);
    assert.equal(control.status, 0);
    assert.equal(control.stdout + control.stderr, '');
    assert.equal(JSON.parse(fs.readFileSync(file)).messageId, 'probe');
    console.log('PASS held hook lock skips silently within bound with positive write control');
    passed++;
    console.log(`PASS ${passed}/${passed} writer contention controls`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
