#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const script = process.env.AUTHORITY_AUDIT_SUBJECT || path.resolve(__dirname, '../plugins/autodev-core/scripts/authority-audit.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-audit-test-'));
let passed = 0;
let failed = 0;
function check(name, ok) { if (ok) passed++; else { failed++; console.log(`FAIL ${name}`); } }
const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root, BRAIN_CLOCK_CLAUDE_DIR: root };
const dir = path.join(root, 'autodev');
fs.mkdirSync(dir);
const ledger = path.join(dir, 'headless-workers.json');
const log = path.join(dir, 'windows', 'authority-audit.jsonl');
const call = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, error = false, content = 'done', execution) => ({ type: 'user', tool_use_result: execution, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content }] } });
function record(code, events, extra = {}) {
    const file = path.join(root, code + '.jsonl');
    fs.writeFileSync(file, events.concat({ type: 'result', subtype: 'success' }).map(JSON.stringify).join('\n') + '\nCLAUDE_EXIT=0\n');
    return { code, startedAt: '2026-10-29T10:00:00Z', state: 'settled', cwd: root, profile: 'builder', tools: ['Bash', 'Write', 'Edit'], secrets: [], log: file, ...extra };
}
const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
try {
    const records = [
        record('safe', [call('s', 'Bash', { command: 'git status' }), result('s')]),
        record('blocked', [call('b', 'Bash', { command: 'git push' }), result('b', true, 'worker-authority denied Bash [git-push]')]),
        record('escape', [call('e', 'Bash', { command: 'git push' }), result('e')]),
        record('write', [call('w', 'Write', { file_path: path.join(root, '..', 'outside.txt') }), result('w')]),
        record('edit', [call('x', 'Edit', { file_path: path.join(root, '..', 'outside.txt') }), result('x')]),
        record('unknown', [call('u', 'Bash', { command: 'git push' }), result('other')]),
        record('error', [call('z', 'Bash', { command: 'git push' }), result('z', true, 'validation failed')]),
        record('ran-error', [call('r', 'Bash', { command: 'git push' }), result('r', true, 'exit 1', { stdout: '', exitCode: 1 })]),
        record('spoofed', [call('p', 'Bash', { command: 'git push' }), result('p', true, 'worker-authority denied Bash', { stdout: 'worker-authority denied Bash' })]),
        record('active', [], { state: 'running' }),
        record('missing', [], { log: path.join(root, 'absent') }),
        record('scope', [], { tools: undefined }),
    ];
    fs.writeFileSync(ledger, JSON.stringify({ records }));
    const r = run('--json');
    check('escape batch exits 1', r.status === 1);
    const rows = JSON.parse(r.stdout);
    const by = (key) => rows.find((x) => x.runKey.startsWith(key + '@'));
    check('one row per settled run', rows.length === 11 && !by('active'));
    check('allowed control checked', by('safe').callsChecked === 1 && by('safe').complete && by('safe').denials === 0);
    check('denial prevented execution', by('blocked').denials === 1 && by('blocked').escapes === 0 && by('blocked').complete);
    for (const key of ['escape', 'write', 'edit', 'ran-error', 'spoofed']) check(`${key} execution is an escape`, by(key).escapes === 1 && by(key).complete);
    for (const key of ['unknown', 'error', 'missing', 'scope']) check(`${key} cannot prove zero escapes`, by(key).complete === false);
    const before = fs.readFileSync(log, 'utf8');
    const again = run();
    check('rerun is silent and idempotent', again.status === 0 && again.stdout === '' && again.stderr === '' && fs.readFileSync(log, 'utf8') === before);
    const broken = record('broken', [call('q', 'Bash', { command: 'git push' }), result('q')]);
    fs.appendFileSync(broken.log, '{bad json\n');
    const truncated = record('truncated', []);
    fs.writeFileSync(truncated.log, 'CLAUDE_EXIT=0\n');
    const lost = record('lost', []);
    fs.writeFileSync(lost.log, JSON.stringify({ type: 'result' }) + '\n');
    fs.writeFileSync(ledger, JSON.stringify({ records: [broken, truncated, lost] }));
    const gaps = run('--json');
    check('malformed and truncated transcripts never pass', gaps.status === 1 && JSON.parse(gaps.stdout).length === 3 && JSON.parse(gaps.stdout).every((x) => x.complete === false));
    fs.writeFileSync(ledger, '{');
    check('unreadable ledger exits 2', run().status === 2);
    check('help runs without reading ledger', run('--help').status === 0);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`authority-audit: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
