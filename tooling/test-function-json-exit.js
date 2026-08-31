#!/usr/bin/env node
// Acceptance test for F6: JSON mode must reject coverage from a failing suite.
// Expected failure before the fix: the payload says suitePassed=false with no
// plugin file loaded, yet the process exits 0 because only dead functions feed
// the JSON exit status.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// PRIVATE ISOLATION, as a COPY of the invoking tree (Sol's rounds 13-14):
// the runner mutation happens in a plain temp-dir snapshot, so a forced
// kill strands nothing, no concurrent writer exists to race, and — unlike
// a worktree of HEAD — the population and the checker under test are
// exactly the invoking tree's, uncommitted changes and sweep stubs
// included. Ownership is the marker file; dead-owner sandboxes are
// reclaimed at startup and this one is removed on exit.
const SB_PREFIX = 'funcexit-sb-';
const SB_MARKER = '.acceptance-sandbox';
for (const d of fs.readdirSync(os.tmpdir())) {
    const m = d.match(new RegExp('^' + SB_PREFIX + '(\\d+)-'));
    if (!m) continue;
    const full = path.join(os.tmpdir(), d);
    if (!fs.existsSync(path.join(full, SB_MARKER))) continue;   // not provably ours
    let alive = false;
    try { process.kill(parseInt(m[1], 10), 0); alive = true; }
    catch (e) { alive = e.code === 'EPERM'; }
    if (!alive) { try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* next run */ } }
}
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), SB_PREFIX + process.pid + '-'));
fs.writeFileSync(path.join(SANDBOX, SB_MARKER), String(process.pid));
{
    const SKIP = new Set(['.git', '.claude', 'node_modules']);
    fs.cpSync(ROOT, SANDBOX, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
}
process.on('exit', () => {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* reclaimed next run */ }
});
const RUNNER = path.join(SANDBOX, 'tooling', 'test-all.js');
const CHECK = path.join(SANDBOX, 'tooling', 'find-untested-functions.js');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error?.message || 'none'}`;

const mutant =
    "#!/usr/bin/env node\n" +
    "console.error('intentional F6 baseline failure');\n" +
    "process.exit(1);\n";
let result = null;
let payload = null;
// Rename-based mutation, same discipline as the sweep engine: the original
// is renamed aside (never rewritten, ownership from the first syscall), the
// mutant is created O_EXCL, and the original returns via link(), which
// refuses over anything a concurrent writer recreated. Unexpected states
// are reported and fail the run rather than being absorbed.
const original = fs.readFileSync(RUNNER, 'utf8');   // for the restored-content control below
const RUNNER_ORIG = RUNNER + '.orig-' + crypto.randomBytes(6).toString('hex');
fs.renameSync(RUNNER, RUNNER_ORIG);
try {
    // Stop before any suite or plugin source is loaded. This makes an empty
    // coverage population while keeping the failure intentional and parseable.
    fs.writeFileSync(RUNNER, mutant, { flag: 'wx' });
    result = spawnSync(process.execPath, [CHECK, '--json'], {
        cwd: SANDBOX,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
    });
    try { payload = JSON.parse(result.stdout); } catch { /* controls report it */ }
} finally {
    try {
        const cap = RUNNER + '.cap-' + crypto.randomBytes(6).toString('hex');
        let claimed = false;
        try { fs.renameSync(RUNNER, cap); claimed = true; } catch { /* deleted */ }
        if (claimed) {
            if (fs.readFileSync(cap, 'utf8') === mutant) fs.unlinkSync(cap);
            else { console.error('NOT CLEANED: foreign content captured at ' + cap); process.exitCode = 1; }
        }
        fs.linkSync(RUNNER_ORIG, RUNNER);
        fs.unlinkSync(RUNNER_ORIG);
    } catch (e) {
        console.error('RESTORE INCOMPLETE for ' + RUNNER + ' (' + (e.code || e.message)
            + '); the original is at ' + RUNNER_ORIG);
        process.exitCode = 1;
    }
}

const restoredSyntax = spawnSync(process.execPath, ['--check', RUNNER], {
    cwd: SANDBOX,
    encoding: 'utf8',
    windowsHide: true,
});

check('control: JSON records the deliberately failed suite',
    payload?.suitePassed === false,
    `payload=${JSON.stringify(payload)}`);
check('control: the failed suite loaded zero plugin files',
    payload?.sourceFiles > 0
        && payload?.filesLoaded === 0
        && payload?.functionsSeen === 0
        && payload?.filesNeverLoaded?.length === payload?.sourceFiles,
    `payload=${JSON.stringify(payload)}`);
check('JSON mode exits 2 when its suite baseline is red',
    result?.status === 2 && result.signal === null && !result.error,
    result ? detail(result) : 'checker did not run');
check('control: the committed runner is restored with valid syntax',
    fs.readFileSync(RUNNER, 'utf8') === original
        && restoredSyntax.status === 0
        && restoredSyntax.signal === null
        && !restoredSyntax.error,
    detail(restoredSyntax));

let pass = 0;
let fail = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : (process.exitCode || 0));
