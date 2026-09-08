#!/usr/bin/env node
// Acceptance tests for F2: both public live entrypoints must carry an
// UNREACHABLE verdict in their process status. Expected failures before the
// fix: JSON mode exits 0 unconditionally, and the npm command diverts into the
// synthetic selftest instead of inspecting the supplied repository.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'check-rules-reachable.js');
const bundledNpm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCli = process.env.npm_execpath || (fs.existsSync(bundledNpm) ? bundledNpm : null);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reachable-entrypoints-'));
const fixtureRepo = path.join(tempRoot, 'repo');
const configDir = path.join(tempRoot, 'config');
const emptyConfigDir = path.join(tempRoot, 'empty-config');
const logDir = path.join(configDir, 'logs');
const logFile = path.join(logDir, 'instructions-loaded.jsonl');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error?.message || 'none'}`;

const runNode = (args, config) => spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    encoding: 'utf8',
    windowsHide: true,
});

try {
    fs.mkdirSync(fixtureRepo, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(emptyConfigDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureRepo, 'CLAUDE.md'), '# unconditional fixture\n');
    fs.writeFileSync(logFile, JSON.stringify({
        reason: 'session_start',
        at: '2026-01-01T00:00:00Z',
        cwd: fixtureRepo,
        file: path.join(fixtureRepo, '.claude', 'observed.md'),
    }) + '\n');

    // Known-positive control: the text entrypoint already computes the intended
    // red verdict. This pins the fixture so either F2 assertion cannot pass from
    // an unrelated CLI failure.
    const text = runNode([CHECK, fixtureRepo], configDir);
    check('control: the live text analyzer exits 1 for the fixture',
        text.status === 1 && text.signal === null && !text.error,
        detail(text));

    const json = runNode([CHECK, fixtureRepo, '--json'], configDir);
    let payload = null;
    try { payload = JSON.parse(json.stdout); } catch { /* control below reports it */ }
    check('control: JSON mode computed exactly one unreachable rule',
        payload?.onDisk === 1 && payload?.reached === 0 && payload?.unreachable?.length === 1,
        `payload=${JSON.stringify(payload)}`);
    check('JSON mode exits 1 when its payload contains an unreachable rule',
        json.status === 1 && json.signal === null && !json.error,
        detail(json));

    const named = npmCli
        ? spawnSync(process.execPath,
            [npmCli, 'run', '--silent', 'check:reachable', '--', fixtureRepo, '--json'], {
            cwd: ROOT,
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
            encoding: 'utf8',
            windowsHide: true,
            })
        : spawnSync('npm',
            ['run', '--silent', 'check:reachable', '--', fixtureRepo, '--json'], {
                cwd: ROOT,
                env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
                encoding: 'utf8',
                windowsHide: true,
            });
    check('the named check:reachable command analyzes the supplied live repository',
        named.status === 1 && named.signal === null && !named.error,
        detail(named));

    // Known-negative control: no startup evidence must remain a successful
    // inconclusive result, even though an unconditional file exists on disk.
    const noEvidence = runNode([CHECK, fixtureRepo, '--json'], emptyConfigDir);
    check('control: JSON mode preserves NO EVIDENCE as exit 0',
        noEvidence.status === 0 && noEvidence.signal === null && !noEvidence.error,
        detail(noEvidence));

    // ---- the pipe delivers every byte -----------------------------------------
    //
    // node's process.stdout is ASYNCHRONOUS when it is a pipe on darwin and
    // synchronous when it is a pipe on linux/win32, and process.exit() does not
    // drain a pending async write. A run that prints and then exits hands its
    // caller a TRUNCATED document under a status that says nothing failed -- the
    // shape rendered-layout-gate.js shipped with until 2026-09-07.
    //
    // THIS DOES NOT INFLATE THE FIXTURE PAST 64 KiB, and the difference matters in
    // both directions. Sizing a fixture past the buffer is not portable: it needs
    // long paths, long ref names or hundreds of rows, and `[measured 2026-09-08]`
    // this suite's 400-file rule tree did not clear the buffer on
    // ubuntu-latest, so its own vacuity guard went RED and the equality beside
    // it was proving nothing anyway. It is also not NECESSARY -- the buffer does not have to be
    // filled by this script's output, only to be full when the write happens.
    // tooling/pipe-drain.js fills it with zeroes first, so a few-hundred-byte
    // report is dropped exactly as completely as a 94 KB one.
    //
    // It carries its own control -- a fixture that prints then exits must arrive
    // truncated to zero before any verdict counts -- and reports `skipped` on
    // linux and win32, where a pipe is synchronous and the defect cannot occur.
    {
        const drained = require('./pipe-drain').run({
            argv: [CHECK, fixtureRepo, '--json'],
            env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: configDir }),
        });
        check('--json arrives whole through a stalled pipe', drained.ok, drained.detail);
    }
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
