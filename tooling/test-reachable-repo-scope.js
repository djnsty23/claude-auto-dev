#!/usr/bin/env node
// Acceptance test for F3: startup evidence belongs only to the repository that
// produced it. Expected failure before the fix: a session_start row from a
// different repository makes the target repository's unseen rule look proven
// unreachable instead of yielding the safe NO EVIDENCE result.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.env.REACHABLE_CHECK
    ? path.resolve(process.env.REACHABLE_CHECK)
    : path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'check-rules-reachable.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reachable-scope-'));
const targetRepo = path.join(tempRoot, 'target-repo');
const otherRepo = path.join(tempRoot, 'other-repo');
const configDir = path.join(tempRoot, 'config');
const logDir = path.join(configDir, 'logs');
const logFile = path.join(logDir, 'instructions-loaded.jsonl');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error?.message || 'none'}`;

const runTarget = () => spawnSync(process.execPath, [CHECK, targetRepo], {
    cwd: ROOT,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    encoding: 'utf8',
    windowsHide: true,
});
const runTargetJson = () => {
    const result = spawnSync(process.execPath, [CHECK, '--json', targetRepo], {
        cwd: ROOT,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        encoding: 'utf8',
        windowsHide: true,
    });
    let json = null;
    try { json = JSON.parse(result.stdout); } catch { /* asserted below */ }
    return { result, json };
};

const writeRows = (rows) => fs.writeFileSync(logFile,
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

try {
    fs.mkdirSync(targetRepo, { recursive: true });
    fs.mkdirSync(otherRepo, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const targetRule = path.join(targetRepo, 'CLAUDE.md');
    fs.writeFileSync(targetRule, '# unconditional target fixture\n');

    writeRows([{
        reason: 'session_start',
        at: '2026-01-01T00:00:00Z',
        cwd: targetRepo,
        file: path.join(targetRepo, '.claude', 'observed.md'),
    }]);
    const sameRepoUnseen = runTarget();
    check('control: same-repository startup evidence can prove the target rule unreachable',
        sameRepoUnseen.status === 1 && sameRepoUnseen.signal === null && !sameRepoUnseen.error,
        detail(sameRepoUnseen));

    writeRows([{
        reason: 'session_start',
        at: '2026-01-01T00:00:00Z',
        cwd: targetRepo,
        file: targetRule,
    }]);
    const sameRepoSeen = runTarget();
    check('control: same-repository evidence for the target rule remains green',
        sameRepoSeen.status === 0 && sameRepoSeen.signal === null && !sameRepoSeen.error,
        detail(sameRepoSeen));

    writeRows([{
        reason: 'session_start',
        at: '2026-01-01T00:00:00Z',
        cwd: otherRepo,
        file: path.join(otherRepo, 'CLAUDE.md'),
    }]);
    const otherRepoOnly = runTarget();
    check('other-repository startup evidence leaves the target at NO EVIDENCE',
        otherRepoOnly.status === 0 && otherRepoOnly.signal === null && !otherRepoOnly.error,
        detail(otherRepoOnly));

    writeRows([{
        reason: 'session_start',
        at: '2026-01-01T00:00:00Z',
        cwd: otherRepo,
        file: targetRule,
    }]);
    const contradictory = runTargetJson();
    // Expected failure before the amendment: the target file path wins through
    // an OR even though the recorded cwd says the row came from another repo.
    check('cwd is authoritative when cwd and loaded-file scope contradict',
        contradictory.result.status === 0 && contradictory.result.signal === null
            && !contradictory.result.error && contradictory.json?.rows === 0
            && contradictory.json?.sawStart === false,
        `${detail(contradictory.result)} rows=${contradictory.json?.rows} sawStart=${contradictory.json?.sawStart}`);
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let pass = 0;
let fail = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
