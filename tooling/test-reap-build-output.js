#!/usr/bin/env node
/**
 * test-reap-build-output.js - drives plugins/autodev-core/scripts/reap-build-output.js
 * as a SUBPROCESS against fixture repositories in temp directories: real git
 * repos with registered worktrees, a `.next` and a `node_modules` in each, and
 * the full gate's lock, tickets and leases in a temp lock directory.
 *
 * Every scenario runs against the real subject (every row must pass) and then
 * against a copy with one defect planted by an exact anchor (some row must
 * fail). The anchor must match exactly once, or the plant itself fails:
 *   P1  a dry run deletes                         -> the dry run removes .next (S1)
 *   P2  node_modules is an output directory       -> --apply deletes node_modules (S2)
 *   P3  leases are ignored                        -> a running gate's .next is deleted (S3)
 *   P4  an unreadable lease covers nothing        -> a malformed lease's .next is deleted (S4)
 *   P5  locks and tickets are ignored             -> a held worktree's .next is deleted (S5)
 *   P6  command lines are not matched             -> a dev server's .next is deleted (S6)
 *   P6b an unreadable process listing is empty    -> .next is deleted blind (S6)
 *   P7  the mtime scan stops one level early      -> a .next written an hour ago is deleted (S7)
 *   P8  links are followed, containment unchecked -> a junction is renamed and removed (S8)
 *   P9  tracked output is not refused             -> a committed .next is deleted (S9)
 *   P10 a failed rename deletes in place          -> an open .next is deleted under its user (S10)
 *   P11 no recheck inside the mutex               -> a lease published after assessment is ignored (S11)
 *   P11b no worktree mutex                        -> a runner holding the mutex is ignored (S11)
 *   P12 a failed delete counts as completed       -> the failure is not reported, exit 0 (S12)
 *   P13 only the first registered worktree is read -> linked worktrees are never assessed (S13)
 *
 * The machine's real lock and repositories are never touched: every spawn sets
 * AUTODEV_GATE_LOCK_PATH to a temp directory and names only fixture repos.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'reap-build-output.js');
const LIBS = ['reap-build-output.js', 'full-gate-queue.js', 'gate-identity.js', 'gate-records.js'];
const ident = require(path.join(SCRIPTS, 'gate-identity.js'));
const records = require(path.join(SCRIPTS, 'gate-records.js'));
const WIN = process.platform === 'win32';
const HOUR = 3600000;
const NEXT_BYTES = 10 + 100 + 1000;
let failed = 0;
let passed = 0;

function check(name, cond, detail) {
    if (cond) { passed++; console.log(`PASS  ${name}`); return; }
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(String(detail).split('\n').map((l) => '      ' + l).join('\n'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temps = [];
const mkTemp = (p) => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p))); temps.push(d); return d; };
const kids = [];

function sleeper(extraArgs = []) {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', ...extraArgs], { stdio: 'ignore', windowsHide: true });
    kids.push(c);
    return c.pid;
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function git(dir, args) {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
        { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
}

function ageTree(dir, ms) {
    const t = new Date(Date.now() - ms);
    const walk = (p) => {
        const st = fs.lstatSync(p);
        if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
        if (!st.isSymbolicLink()) fs.utimesSync(p, t, t);
    };
    walk(dir);
}

/** `.next` with three files at depths 1, 2 and 3, and a node_modules, all 72 h old. */
function addOutput(wt) {
    const n = path.join(wt, '.next');
    fs.mkdirSync(path.join(n, 'server'), { recursive: true });
    fs.mkdirSync(path.join(n, 'cache', 'webpack'), { recursive: true });
    fs.writeFileSync(path.join(n, 'BUILD_ID'), 'x'.repeat(10));
    fs.writeFileSync(path.join(n, 'server', 'page.js'), 'p'.repeat(100));
    fs.writeFileSync(path.join(n, 'cache', 'webpack', 'a.pack'), 'a'.repeat(1000));
    fs.mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), 'm'.repeat(50));
    ageTree(n, 72 * HOUR);
    ageTree(path.join(wt, 'node_modules'), 72 * HOUR);
}

/** A repo with linked worktrees `names`, each with old output, and its own lock directory. */
function fixture(id, names = ['wt-a']) {
    const root = mkTemp(`reap-${id}-`);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const wts = {};
    for (const n of names) {
        const dir = path.join(root, n);
        git(repo, ['worktree', 'add', '-q', '-b', `b-${n}`, dir]);
        addOutput(dir);
        wts[n] = dir;
    }
    const lockDir = path.join(root, 'locks');
    fs.mkdirSync(lockDir);
    const base = path.join(lockDir, 'full-gate.lock');
    const procsFile = path.join(root, 'procs.json');
    fs.writeFileSync(procsFile, JSON.stringify([{ pid: 4, ppid: 0, commandLine: 'System', executablePath: null }]));
    const env = { ...process.env, AUTODEV_GATE_LOCK_PATH: base, AUTODEV_REAP_TEST_PROCS: procsFile, AUTODEV_REAP_MUTEX_TIMEOUT_MS: '3000' };
    delete env.AUTODEV_REAP_TEST_FAIL_DELETE;
    delete env.AUTODEV_REAP_TEST_HANDSHAKE;
    return { root, repo, wts, base, procsFile, env };
}

const keyOf = (dir) => ident.pathKey(ident.canonicalPath(dir));
const nextOf = (dir) => path.join(dir, '.next');
const exists = (p) => fs.existsSync(p);
const asides = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.next.reaped-'));
const fileCount = (dir) => { let n = 0; const w = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { if (e.isDirectory()) w(path.join(p, e.name)); else n++; } }; try { w(dir); } catch { return -1; } return n; };

function writeLease(fx, dir, value) {
    records.writeJsonAtomic(records.leasePath(fx.base, keyOf(dir)), { schema: 1, runId: 'r-test', token: 7, worktree: ident.canonicalPath(dir), state: 'running', ...value });
}

function liveOwner() {
    const pid = sleeper();
    ident.forgetSnapshot();
    return ident.identityOf(pid, { snap: ident.snapshot() });
}

const DEAD_OWNER = { pid: 4242, startUtc: '2000-01-01T00:00:00.0000000Z', bootId: 'otherhost|2000-01-01T00:00:00.0000000Z' };

// ---------------------------------------------------------------------------
// Running the subject.
// ---------------------------------------------------------------------------

function run(subject, fx, args, extraEnv = {}) {
    const r = spawnSync(process.execPath, [subject, ...args], { encoding: 'utf8', windowsHide: true, env: { ...fx.env, ...extraEnv }, timeout: 120000 });
    let json = null;
    if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { /* reported by the rows */ } }
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

function runAsync(subject, fx, args, extraEnv = {}) {
    return new Promise((resolve) => {
        const c = spawn(process.execPath, [subject, ...args], { windowsHide: true, env: { ...fx.env, ...extraEnv } });
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d) => { stdout += d; });
        c.stderr.on('data', (d) => { stderr += d; });
        c.on('close', (code) => { let json = null; try { json = JSON.parse(stdout); } catch { /* rows report it */ } resolve({ code, stdout, stderr, json }); });
    });
}

const cand = (res, dir) => (res.json ? res.json.candidates.find((c) => ident.canonicalPath(c.path) === ident.canonicalPath(nextOf(dir))) : null);
const why = (res) => `exit ${res.code}\n${res.stdout.slice(0, 1500)}\n${res.stderr.slice(0, 500)}`;

// ---------------------------------------------------------------------------
// Scenarios. Each returns rows [name, ok, detail].
// ---------------------------------------------------------------------------

function s1DryRun(subject) {
    const fx = fixture('s1');
    const a = fx.wts['wt-a'];
    const res = run(subject, fx, ['--repo', fx.repo, '--json']);
    const c = cand(res, a);
    const text = run(subject, fx, ['--repo', fx.repo]);
    return [
        ['S1: a dry run exits 0', res.code === 0, why(res)],
        ['S1: the old .next is listed as eligible with its logical size', Boolean(c && c.eligible && c.bytes === NEXT_BYTES && c.files === 3), JSON.stringify(c)],
        ['S1: a dry run deletes nothing and renames nothing', exists(nextOf(a)) && fileCount(nextOf(a)) === 3 && asides(a).length === 0, fs.readdirSync(a).join(', ')],
        ['S1: the summary is a dry run that deleted nothing', Boolean(res.json && res.json.summary.mode === 'dry-run' && res.json.summary.completed === 0 && res.json.summary.removedBytes === 0), JSON.stringify(res.json && res.json.summary)],
        ['S1: the text report names the path, its size and that nothing was deleted', /ELIGIBLE\s+1\.1 KB\s+\S*\.next/.test(text.stdout) && /dry run: nothing deleted/.test(text.stdout), text.stdout],
    ];
}

function s2Apply(subject) {
    const fx = fixture('s2');
    const a = fx.wts['wt-a'];
    const res = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']);
    const s = res.json ? res.json.summary : {};
    const vols = Object.values(s.volumes || {});
    return [
        ['S2: --apply exits 0', res.code === 0, why(res)],
        ['S2: the eligible .next is gone and no renamed sibling is left', !exists(nextOf(a)) && asides(a).length === 0, fs.readdirSync(a).join(', ')],
        ['S2: node_modules is untouched', fileCount(path.join(a, 'node_modules')) === 1, String(fileCount(path.join(a, 'node_modules')))],
        ['S2: one completed deletion and its logical bytes are reported', s.completed === 1 && s.removedBytes === NEXT_BYTES && s.failures.length === 0, JSON.stringify(s)],
        ['S2: the volume\'s free bytes are reported before and after', vols.length === 1 && Number.isFinite(vols[0].before) && Number.isFinite(vols[0].after), JSON.stringify(s.volumes)],
        ['S2: the worktree\'s tracked files survive', exists(path.join(a, 'README.md')), fs.readdirSync(a).join(', ')],
    ];
}

function s3Lease(subject, owner) {
    const fx = fixture('s3', ['wt-live', 'wt-dead', 'wt-done']);
    writeLease(fx, fx.wts['wt-live'], { owner, state: 'running' });
    writeLease(fx, fx.wts['wt-dead'], { owner: DEAD_OWNER, state: 'running' });
    writeLease(fx, fx.wts['wt-done'], { owner, state: 'released' });
    const res = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']);
    const live = cand(res, fx.wts['wt-live']);
    return [
        ['S3: a live lease keeps its .next, with the lease as the reason', Boolean(live && !live.eligible && live.reasons.some((r) => /holds a lease/.test(r))) && fileCount(nextOf(fx.wts['wt-live'])) === 3, JSON.stringify(live)],
        ['S3: a lease from an earlier boot covers nothing', !exists(nextOf(fx.wts['wt-dead'])), JSON.stringify(cand(res, fx.wts['wt-dead']))],
        ['S3: a released lease covers nothing', !exists(nextOf(fx.wts['wt-done'])), JSON.stringify(cand(res, fx.wts['wt-done']))],
    ];
}

function s4MalformedLease(subject) {
    const fx = fixture('s4');
    const a = fx.wts['wt-a'];
    fs.mkdirSync(records.leasesDir(fx.base), { recursive: true });
    fs.writeFileSync(records.leasePath(fx.base, keyOf(a)), '{ half a lease');
    const res = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']);
    const c = cand(res, a);
    return [
        ['S4: an unreadable lease keeps the .next', fileCount(nextOf(a)) === 3, fs.readdirSync(a).join(', ')],
        ['S4: the reason names the unreadable lease', Boolean(c && c.reasons.some((r) => /lease .* cannot be read/.test(r))), JSON.stringify(c)],
    ];
}

function s5Locks(subject) {
    const fx = fixture('s5', ['wt-lock', 'wt-ticket', 'wt-free']);
    fs.writeFileSync(fx.base, `${process.pid}\nnpm run gate\nclass product\n${records.metaLine({ runId: 'r-held', token: 3, repo: { worktree: ident.canonicalPath(fx.wts['wt-lock']) } })}\n`);
    const q = path.join(path.dirname(fx.base), 'full-gate-2.queue');
    fs.mkdirSync(q, { recursive: true });
    fs.writeFileSync(path.join(q, `20261002T100000000Z-${String(process.pid).padStart(10, '0')}.ticket`),
        `${process.pid}\nnpm run gate, branch b-wt-ticket, head abc1234, worktree wt-ticket, queued 10:00Z\n2026-10-02T10:00:00.000Z\nclass product\n`);
    const first = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']);
    // A record that says nothing about its worktree names every worktree.
    const fx2 = fixture('s5b');
    fs.writeFileSync(path.join(path.dirname(fx2.base), 'full-gate-3.lock'), `${process.pid}\nwritten by hand\n`);
    const second = run(subject, fx2, ['--repo', fx2.repo, '--apply', '--json']);
    return [
        ['S5: a lane lock naming the worktree keeps its .next', fileCount(nextOf(fx.wts['wt-lock'])) === 3, JSON.stringify(cand(first, fx.wts['wt-lock']))],
        ['S5: a queued ticket naming the worktree keeps its .next', fileCount(nextOf(fx.wts['wt-ticket'])) === 3, JSON.stringify(cand(first, fx.wts['wt-ticket']))],
        ['S5: a worktree no record names is reaped', !exists(nextOf(fx.wts['wt-free'])), JSON.stringify(cand(first, fx.wts['wt-free']))],
        ['S5: a lock that names no worktree keeps every .next', fileCount(nextOf(fx2.wts['wt-a'])) === 3, why(second)],
    ];
}

function s6Processes(subject) {
    const fx = fixture('s6', ['wt-used', 'wt-idle']);
    const used = fx.wts['wt-used'];
    const fwd = ident.canonicalPath(used).split('\\').join('/');
    fs.writeFileSync(fx.procsFile, JSON.stringify([
        { pid: 4, ppid: 0, commandLine: 'System', executablePath: null },
        { pid: 9001, ppid: 4, commandLine: `node ${fwd}/node_modules/next/dist/bin/next dev`, executablePath: 'C:\\Program Files\\nodejs\\node.exe' },
    ]));
    const first = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']);
    const fx2 = fixture('s6b');
    fs.writeFileSync(fx2.procsFile, JSON.stringify({ unreadable: 'a planted probe failure' }));
    const second = run(subject, fx2, ['--repo', fx2.repo, '--apply', '--json']);
    const c2 = cand(second, fx2.wts['wt-a']);
    return [
        ['S6: a process naming the worktree in its command line keeps the .next', fileCount(nextOf(used)) === 3, JSON.stringify(cand(first, used))],
        ['S6: an idle worktree beside it is reaped', !exists(nextOf(fx.wts['wt-idle'])), JSON.stringify(cand(first, fx.wts['wt-idle']))],
        ['S6: an unreadable process listing keeps every .next', fileCount(nextOf(fx2.wts['wt-a'])) === 3 && Boolean(c2 && c2.reasons.some((r) => /cannot be listed/.test(r))), JSON.stringify(c2)],
    ];
}

/** The real probe: a live process started with the worktree's path in its arguments. */
async function s6RealProbe(subject) {
    const fx = fixture('s6r');
    const a = fx.wts['wt-a'];
    const pid = sleeper([ident.canonicalPath(a)]);
    await sleep(500);
    const env = { ...fx.env };
    delete env.AUTODEV_REAP_TEST_PROCS;
    const res = run(subject, { ...fx, env }, ['--repo', fx.repo, '--json']);
    const c = cand(res, a);
    return [
        ['S6r: the real process probe finds a live process whose arguments name the worktree', Boolean(c && !c.eligible && c.reasons.some((r) => r.includes(`pid ${pid} `))), JSON.stringify(c)],
    ];
}

function s7Mtime(subject) {
    const fx = fixture('s7');
    const a = fx.wts['wt-a'];
    const t = new Date(Date.now() - HOUR);
    fs.utimesSync(path.join(a, '.next', 'server', 'page.js'), t, t);
    const res = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']);
    const c = cand(res, a);
    return [
        ['S7: a file two levels down written an hour ago keeps the .next', fileCount(nextOf(a)) === 3, JSON.stringify(c)],
        ['S7: the reason names the recent modification', Boolean(c && c.reasons.some((r) => /within the last 24 hours/.test(r))), JSON.stringify(c)],
    ];
}

function s8Junction(subject) {
    const fx = fixture('s8');
    const a = fx.wts['wt-a'];
    fs.rmSync(nextOf(a), { recursive: true, force: true });
    const target = path.join(fx.root, 'elsewhere');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'k'.repeat(20));
    fs.symlinkSync(target, nextOf(a), WIN ? 'junction' : 'dir');
    ageTree(target, 72 * HOUR);
    // The link's own times are old too, so only the shape check can refuse it.
    const old = new Date(Date.now() - 72 * HOUR);
    fs.lutimesSync(nextOf(a), old, old);
    const res = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']);
    const c = cand(res, a);
    let isLink = false;
    try { isLink = fs.lstatSync(nextOf(a)).isSymbolicLink(); } catch { /* gone */ }
    return [
        ['S8: a .next that is a junction or symlink is not eligible, and is measured as 0 bytes, not its target',
            Boolean(c && !c.eligible && c.bytes === 0 && c.reasons.some((r) => /junction or symlink/.test(r))), JSON.stringify(c)],
        ['S8: the link is still in place', isLink && asides(a).length === 0, fs.readdirSync(a).join(', ')],
        ['S8: the link\'s target is untouched', exists(path.join(target, 'keep.txt')), fs.readdirSync(target).join(', ')],
    ];
}

function s9Tracked(subject) {
    const fx = fixture('s9');
    const a = fx.wts['wt-a'];
    git(a, ['add', '-f', '.next/BUILD_ID']);
    git(a, ['commit', '-q', '-m', 'commit build output']);
    ageTree(nextOf(a), 72 * HOUR);
    const res = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']);
    const c = cand(res, a);
    return [
        ['S9: a .next with tracked files is kept, and the reason says so', fileCount(nextOf(a)) === 3 && Boolean(c && c.reasons.some((r) => /tracks files/.test(r))), JSON.stringify(c)],
    ];
}

function s10LockedRename(subject) {
    const fx = fixture('s10');
    const a = fx.wts['wt-a'];
    const root = process.getuid && process.getuid() === 0;
    if (root) return [['S10: a rename that fails (skipped: root ignores directory permissions)', true, '']];
    let fd = null;
    if (WIN) fd = fs.openSync(path.join(a, '.next', 'server', 'page.js'), 'r');
    else fs.chmodSync(a, 0o555);
    let res;
    try { res = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']); } finally {
        if (fd !== null) fs.closeSync(fd);
        else fs.chmodSync(a, 0o755);
    }
    const s = res.json ? res.json.summary : {};
    return [
        ['S10: an eligible .next whose rename fails keeps every file', fileCount(nextOf(a)) === 3, fs.readdirSync(a).join(', ')],
        ['S10: it is reported as skipped at apply, not completed or failed', (s.skippedAtApply || []).length === 1 && /rename aside failed/.test(s.skippedAtApply[0].why) && s.completed === 0 && s.failures.length === 0, JSON.stringify(s)],
        ['S10: a skip is not a failure: exit 0', res.code === 0, why(res)],
    ];
}

async function s11Mutex(subject, owner) {
    // (a) A runner holds the worktree mutex: the reaper waits, then skips.
    const fx = fixture('s11a');
    const a = fx.wts['wt-a'];
    const mutex = path.join(records.leasesDir(fx.base), `${keyOf(a)}.mutex`);
    fs.mkdirSync(path.dirname(mutex), { recursive: true });
    fs.writeFileSync(mutex, `${process.pid}\n${new Date().toISOString()}\n`);
    const held = run(subject, fx, ['--repo', fx.repo, '--apply', '--json'], { AUTODEV_REAP_MUTEX_TIMEOUT_MS: '400' });
    const hs = held.json ? held.json.summary : {};
    // (b) A runner publishes its lease after the reaper assessed the worktree.
    const fx2 = fixture('s11b');
    const b = fx2.wts['wt-a'];
    const hand = path.join(fx2.root, 'hand');
    fs.mkdirSync(hand);
    const pending = runAsync(subject, fx2, ['--repo', fx2.repo, '--apply', '--json'], { AUTODEV_REAP_TEST_HANDSHAKE: hand });
    const until = Date.now() + 60000;
    while (!exists(path.join(hand, 'assessed')) && Date.now() < until) await sleep(50);
    const assessed = exists(path.join(hand, 'assessed'));
    writeLease(fx2, b, { owner, state: 'admitted' });
    fs.writeFileSync(path.join(hand, 'go'), '');
    const late = await pending;
    const ls = late.json ? late.json.summary : {};
    const lc = cand(late, b);
    return [
        ['S11: a held worktree mutex keeps the .next', fileCount(nextOf(a)) === 3 && asides(a).length === 0, fs.readdirSync(a).join(', ')],
        ['S11: the skip names the mutex', (hs.skippedAtApply || []).some((x) => /mutex/.test(x.why)), JSON.stringify(hs)],
        ['S11: the reaper assessed the worktree as eligible before the lease appeared', assessed && Boolean(lc && lc.eligible), JSON.stringify(lc)],
        ['S11: a lease published after assessment keeps the .next', fileCount(nextOf(b)) === 3, why(late)],
        ['S11: the skip says the worktree is no longer eligible', (ls.skippedAtApply || []).some((x) => /no longer eligible/.test(x.why) && /lease/.test(x.why)), JSON.stringify(ls)],
    ];
}

function s12DeleteFailure(subject) {
    const fx = fixture('s12');
    const a = fx.wts['wt-a'];
    const first = run(subject, fx, ['--repo', fx.repo, '--apply', '--json'], { AUTODEV_REAP_TEST_FAIL_DELETE: '1' });
    const s = first.json ? first.json.summary : {};
    const left = asides(a);
    const second = run(subject, fx, ['--repo', fx.repo, '--apply', '--json']);
    const s2 = second.json ? second.json.summary : {};
    return [
        ['S12: a failed delete exits 1', first.code === 1, why(first)],
        ['S12: the failure is reported apart from completed deletions', s.completed === 0 && (s.failures || []).length === 1 && s.removedBytes === 0, JSON.stringify(s)],
        ['S12: the renamed sibling is left behind, not the .next', !exists(nextOf(a)) && left.length === 1, fs.readdirSync(a).join(', ')],
        ['S12: the next --apply deletes the left-behind sibling', second.code === 0 && s2.completed === 1 && s2.removedBytes === NEXT_BYTES && asides(a).length === 0, why(second)],
    ];
}

function s13Enumeration(subject) {
    const fx = fixture('s13', ['wt-a', 'wt-b', 'wt-gone']);
    addOutput(fx.repo);
    fs.rmSync(fx.wts['wt-gone'], { recursive: true, force: true });
    const notRepo = mkTemp('reap-s13-plain-');
    const res = run(subject, fx, ['--repo', notRepo, '--repo', fx.repo, '--json']);
    const paths = res.json ? res.json.candidates.map((c) => ident.canonicalPath(c.path)).sort() : [];
    const want = [fx.repo, fx.wts['wt-a'], fx.wts['wt-b']].map((d) => ident.canonicalPath(nextOf(d))).sort();
    const repos = res.json ? res.json.summary.repos : [];
    const mod = require(subject);
    const parsed = mod.parsePorcelain('worktree C:/r\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\nworktree C:/r/.claude/worktrees/x y\r\nHEAD def\r\nprunable gitdir file points to non-existent location\r\n\r\nworktree C:/bare\r\nbare\r\n');
    return [
        ['S13: every registered worktree with a .next is a candidate, the main one included', JSON.stringify(paths) === JSON.stringify(want), `${JSON.stringify(paths)}\nwanted ${JSON.stringify(want)}`],
        ['S13: a path that is not a repository is reported and the others still run', res.code === 0 && repos.length === 2 && Boolean(repos[0].why) && repos[1].worktrees === 3, JSON.stringify(repos)],
        ['S13: the porcelain parser reads CRLF, spaces, prunable and bare', parsed.length === 3 && parsed[1].path === 'C:/r/.claude/worktrees/x y' && parsed[1].prunable && parsed[2].bare && !parsed[0].prunable, JSON.stringify(parsed)],
    ];
}

function s14Cli(subject) {
    const fx = fixture('s14');
    const none = run(subject, fx, []);
    const bad = run(subject, fx, ['--repo', fx.repo, '--min-age-hours', '0']);
    const help = run(subject, fx, ['--help']);
    const imp = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(subject)})`], { encoding: 'utf8', windowsHide: true, env: fx.env });
    return [
        ['S14: no --repo is a usage error, exit 2, with no default list', none.code === 2 && /no --repo given/.test(none.stderr), why(none)],
        ['S14: --min-age-hours under 1 is refused, exit 2', bad.code === 2 && exists(nextOf(fx.wts['wt-a'])), why(bad)],
        ['S14: --help prints usage and exits 0', help.code === 0 && /usage: node reap-build-output\.js/.test(help.stdout), why(help)],
        ['S14: importing the module prints nothing', imp.status === 0 && imp.stdout === '' && imp.stderr === '', `${imp.status} ${imp.stdout} ${imp.stderr}`],
    ];
}

// ---------------------------------------------------------------------------
// Plants.
// ---------------------------------------------------------------------------

function mutant(id, edits) {
    const dir = mkTemp(`reap-${id}-`);
    for (const lib of LIBS) fs.copyFileSync(path.join(SCRIPTS, lib), path.join(dir, lib));
    const target = path.join(dir, 'reap-build-output.js');
    let src = fs.readFileSync(target, 'utf8');
    for (const [anchor, replacement] of edits) {
        const count = src.split(anchor).length - 1;
        check(`${id}: the anchor matches exactly once (found ${count})`, count === 1, anchor);
        if (count !== 1) return null;
        src = src.replace(anchor, replacement);
    }
    fs.writeFileSync(target, src);
    return target;
}

function expectRed(id, what, rows) {
    const red = rows.filter(([, ok]) => !ok).map(([name]) => name);
    check(`${id} planted (${what}): the scenario goes red (${red.length} of ${rows.length} rows fail)`,
        red.length > 0, red.length ? `failing: ${red.join(' | ')}` : 'every row passed against the defect');
}

async function main() {
    const only = process.env.REAP_ONLY ? process.env.REAP_ONLY.split(',') : null;
    const want = (id) => !only || only.includes(id);
    const owner = liveOwner();
    check('a live owner identity to plant leases with', Boolean(owner && owner.startUtc && owner.bootId), JSON.stringify(owner));

    const real = {
        S1: () => s1DryRun(SUBJECT), S2: () => s2Apply(SUBJECT), S3: () => s3Lease(SUBJECT, owner), S4: () => s4MalformedLease(SUBJECT),
        S5: () => s5Locks(SUBJECT), S6: () => s6Processes(SUBJECT), S6r: () => s6RealProbe(SUBJECT), S7: () => s7Mtime(SUBJECT),
        S8: () => s8Junction(SUBJECT), S9: () => s9Tracked(SUBJECT), S10: () => s10LockedRename(SUBJECT), S11: () => s11Mutex(SUBJECT, owner),
        S12: () => s12DeleteFailure(SUBJECT), S13: () => s13Enumeration(SUBJECT), S14: () => s14Cli(SUBJECT),
    };
    for (const [id, fn] of Object.entries(real)) if (want(id)) for (const [name, ok, detail] of await fn()) check(name, ok, detail);

    const plants = [
        ['P1', 'a dry run deletes', [['const result = args.apply ? apply(report,', 'const result = true ? apply(report,']], (s) => s1DryRun(s), ['S1']],
        ['P2', 'node_modules is an output directory', [["const OUTPUT_DIRS = ['.next'];", "const OUTPUT_DIRS = ['.next', 'node_modules'];"]], (s) => s2Apply(s), ['S2']],
        ['P3', 'leases are ignored', [["    if (l.state === 'absent') return null;\n", '    return null;\n']], (s) => s3Lease(s, owner), ['S3']],
        ['P4', 'an unreadable lease covers nothing', [["    if (l.state !== 'ok') return `its lease", "    if (l.state !== 'ok') return null; if (0) return `its lease"]], (s) => s4MalformedLease(s), ['S4']],
        ['P5', 'locks and tickets are ignored', [['    if (claims.blockAll) return claims.blockAll;\n', '    return null;\n']], (s) => s5Locks(s), ['S5']],
        ['P6', 'command lines are not matched', [['        if (spellings.some((s) => hay.includes(s))) return', '        if (false) return']],
            async (s) => [...s6Processes(s).slice(0, 2), ...await s6RealProbe(s)], ['S6', 'S6r']],
        ['P6b', 'an unreadable process listing reads as empty', [['    if (!procs.ok) return `running processes cannot be listed', '    if (!procs.ok) return null; if (0) return `running processes cannot be listed']],
            (s) => s6Processes(s).slice(2), ['S6']],
        ['P7', 'the mtime scan stops one level early', [['        if (depth >= 2 || !st.isDirectory()) return;', '        if (depth >= 1 || !st.isDirectory()) return;']], (s) => s7Mtime(s), ['S7']],
        ['P8', 'links are followed and containment is unchecked', [['    try { st = fs.lstatSync(target); }', '    try { st = fs.statSync(target); }'],
            ['    if (real !== ident.canonicalPath(path.join(wt.dir, name))) return', '    if (false) return']], (s) => s8Junction(s), ['S8']],
        ['P9', 'tracked output is not refused', [["    if (tracked.out.length) return 'git tracks files under it';\n", '']], (s) => s9Tracked(s), ['S9']],
        ['P10', 'a failed rename deletes in place', [['            try { fs.renameSync(cand.path, aside); } catch (e) {\n', '            try { fs.renameSync(cand.path, aside); } catch (e) {\n                if (e) return { aside: cand.path, why: null };\n']],
            (s) => s10LockedRename(s), ['S10']],
        ['P11', 'no recheck inside the mutex', [['            const again = blockers(context(base, minAgeHours, env, true), wt, cand);', '            const again = [];']],
            async (s) => (await s11Mutex(s, owner)).slice(2), ['S11']],
        ['P11b', 'no worktree mutex', [['        return records.withWorktreeMutex(base, key, () => {', '        return ((f) => f())(() => {']],
            async (s) => (await s11Mutex(s, owner)).slice(0, 2), ['S11']],
        ['P12', 'a failed delete counts as completed', [['        if (d.why) result.failures.push(', '        if (false) result.failures.push(']], (s) => s12DeleteFailure(s), ['S12']],
        ['P13', 'only the first registered worktree is read', [['    for (const w of parsePorcelain(r.out)) {', '    for (const w of parsePorcelain(r.out).slice(0, 1)) {']], (s) => s13Enumeration(s), ['S13']],
    ];
    for (const [id, what, edits, scenario, covers] of plants) {
        if (!want(id) && !covers.some(want)) continue;
        const m = mutant(id, edits);
        if (!m) continue;
        const rows = await scenario(m);
        if (process.env.REAP_DEBUG) for (const r of rows) console.log(`DEBUG ${id} ${r[0]}: ${r[2]}`);
        expectRed(id, what, rows);
    }
}

main()
    .catch((e) => { failed++; console.log(`FAIL  the suite threw: ${e.stack || e.message}`); })
    .finally(() => {
        for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
        for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a child may hold it */ } }
        console.log(`\n${passed} passed, ${failed} failed`);
        if (failed) { console.log(`${failed} reap-build-output check(s) failed`); process.exitCode = 1; } else console.log('all reap-build-output checks passed');
    });
