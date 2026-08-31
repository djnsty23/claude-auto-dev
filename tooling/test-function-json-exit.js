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
const canonPath = (p) => {
    const r = path.resolve(p);
    let real;
    try { real = fs.realpathSync(r); } catch { real = r; }
    return process.platform === 'win32' ? real.toLowerCase() : real;
};
const CANON_ROOT = canonPath(ROOT);

// NO automatic reclamation of other runs' sandboxes (Sol's round-16
// recommendation, adopted whole): every ownership proof for a plain dir in
// a shared tmpdir is forgeable and every claim/rollback dance has one more
// race, so this run deletes NOTHING it did not create. Stale sandboxes are
// reported for a human to verify and delete.
const SB_SKIP = new Set(['.git', '.claude', 'node_modules']);
// Symlinks and junctions are skipped, not copied — a link out of the tree
// would let sandbox mutations escape the sandbox.
const sbKeep = (src) => !SB_SKIP.has(path.basename(src)) && !fs.lstatSync(src).isSymbolicLink();
// CONTENT+MODE manifest (round-16: size+mtime missed same-size edits, mode
// changes, and link swaps). Links are recorded, not skipped, so a
// file-to-link swap between the source passes cannot hide.
const sbManifest = (root) => {
    const out = new Map();
    const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(root, rel || '.'), { withFileTypes: true })) {
            if (SB_SKIP.has(e.name)) continue;
            const r = rel ? rel + '/' + e.name : e.name;
            const fp = path.join(root, r);
            const st = fs.lstatSync(fp);
            if (st.isSymbolicLink()) { out.set(r, 'LINK'); continue; }
            if (e.isDirectory()) walk(r);
            else out.set(r, crypto.createHash('sha1').update(fs.readFileSync(fp)).digest('hex')
                + ':' + (st.mode & 0o777));
        }
    };
    walk('');
    return out;
};
// Cleanup registers BEFORE creation, null-guarded (rounds 17-18), and a
// FAILED cleanup is loud: it logs the stranded path and forces exit 2
// rather than letting a locked sandbox survive a green exit.
let SANDBOX = null;
process.on('exit', () => {
    if (!SANDBOX) return;
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); }
    catch (e) {
        console.error('sandbox cleanup FAILED (' + (e.code || e.message) + ') — left at ' + SANDBOX);
        process.exitCode = 2;
    }
});
try {
    // Everything from temp enumeration to the snapshot proof is
    // INFRASTRUCTURE: exceptions exit 2, never 1 (rounds 17-18).
    for (const d of fs.readdirSync(os.tmpdir())) {
        const m = d.match(new RegExp('^' + SB_PREFIX + '(\\d+)-'));
        if (!m) continue;
        let alive = false;
        try { process.kill(parseInt(m[1], 10), 0); alive = true; }
        catch (e) { alive = e.code === 'EPERM'; }
        if (!alive) {
            console.error('note: stale sandbox left by dead pid ' + m[1] + ' at '
                + path.join(os.tmpdir(), d) + ' — verify and delete it manually');
        }
    }
    if (canonPath(os.tmpdir()) === CANON_ROOT || canonPath(os.tmpdir()).startsWith(CANON_ROOT + path.sep)) {
        console.error('refusing: TMPDIR is inside the source tree — the snapshot would recurse into itself');
        process.exit(2);
    }
    SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), SB_PREFIX + process.pid + '-'));
    // Three-way proof: source-before, destination, source-after must agree,
    // and the destination must contain no links. Any disagreement refuses.
    const before = sbManifest(ROOT);
    fs.cpSync(ROOT, SANDBOX, { recursive: true, filter: sbKeep });
    const dest = sbManifest(SANDBOX);
    const after = sbManifest(ROOT);
    const refuse = (why) => {
        console.error('refusing: ' + why + ' — re-run when the tree is quiet');
        process.exit(2);
    };
    if (before.size !== after.size) refuse('the source tree changed while it was being snapshotted');
    for (const [k, v] of before) if (after.get(k) !== v) refuse('the source tree changed while it was being snapshotted');
    let files = 0;
    for (const [k, v] of before) {
        if (v === 'LINK') { if (dest.has(k)) refuse('a link was copied into the sandbox'); continue; }
        files++;
        if (dest.get(k) !== v) refuse('the sandbox does not match the source it was copied from');
    }
    for (const v of dest.values()) if (v === 'LINK') refuse('the sandbox contains a link');
    if (dest.size !== files) refuse('the sandbox holds files the source manifest does not');
} catch (e) {
    // Snapshot INFRASTRUCTURE failing is indeterminate, not a finding — an
    // exit 1 here would read as the suite going red, which the sweep could
    // score as a successful canary (round-17).
    console.error('snapshot infrastructure failed: ' + (e.code || e.message));
    process.exit(2);
}
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
