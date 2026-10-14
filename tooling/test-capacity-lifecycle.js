#!/usr/bin/env node
/**
 * test-capacity-lifecycle.js - capacity lifecycle and working retention
 * (plugins/autodev-core/scripts/lifecycle.js, with worktree-reap.js,
 * shared-install.js and capacity.js under it).
 *
 * Its last line is exactly
 *
 *   growth_reconciled=PASS expired_eligible=REMOVED protected=KEPT missed_retention=DETECTED lifecycle_recovery=PASS
 *
 * and any other value sets a nonzero exit code. Each field is a measurement:
 *   growth_reconciled   two snapshots of nested roots with a hardlink and a junction:
 *                       every byte counted once, logical never replaced by allocated,
 *                       and a planted volume change split exactly into roots,
 *                       pagefile and residual.
 *   expired_eligible    an expired scratch unit and a landed, recorded, idle
 *                       worktree are gone from disk after apply (REMOVED), and the
 *                       expired unit holding unresolved evidence is in a tar first.
 *   protected           pagefile, kernel dumps, shader cache, transcripts and vendor
 *                       caches in an expired scratch root, the reported dump, a fresh
 *                       unit, and worktrees that are dirty, hold ignored unique
 *                       content, have unmerged commits, a junction, hardlinks, a
 *                       shared install, no record or a live lease: all on disk after
 *                       apply, each kept for its own reason (KEPT, or DELETED).
 *   missed_retention    a missing and a stale receipt read overdue, a fresh one does
 *                       not; scratch over the cap stops producers with bounded
 *                       diagnostics; a stream over its cap stops its producer
 *                       (DETECTED, or MISSED).
 *   lifecycle_recovery  a removed worktree comes back from its branch at its HEAD; an
 *                       interrupted journal resolves without deleting; an archive is
 *                       refused without capacity admission and round-trips with it.
 *
 * Everything runs on fixture trees in a temp directory. HOME and USERPROFILE
 * point at a fake home, every probe is injected (volume, pagefile, capacity,
 * processes, pull requests, transcript dirs), and the suite asserts that
 * nothing landed in the fake home's or the real profile's lifecycle state.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REAL_HOME = os.homedir();
const REAL_WATCH = [
    path.join(REAL_HOME, '.claude', 'autodev', 'lifecycle'),
    path.join(REAL_HOME, '.claude', 'autodev', 'locks', 'full-gate.capacity.json'),
];
const statOf = (p) => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return 'absent'; } };
const realBefore = REAL_WATCH.map(statOf);

for (const k of ['AUTODEV_CAPACITY', 'AUTODEV_CAPACITY_CONFIG', 'AUTODEV_CAPACITY_PROBE_FILE', 'AUTODEV_CAPACITY_SAMPLE_MS', 'AUTODEV_CAPACITY_TEST_PAUSE_MS',
    'AUTODEV_LIFECYCLE_CONFIG', 'AUTODEV_LIFECYCLE_VOLUME_FILE', 'AUTODEV_LIFECYCLE_PAGEFILE_BYTES', 'AUTODEV_REAP_TEST_PRS', 'AUTODEV_REAP_TEST_PROCS',
    'AUTODEV_REAP_PROJECTS_DIRS', 'AUTODEV_GATE_LOCK_PATH', 'CLAUDE_CONFIG_DIR']) delete process.env[k];

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lcy')));
const FAKE_HOME = path.join(TMP, 'home');
fs.mkdirSync(FAKE_HOME);
const WIN = process.platform === 'win32';
const DAY = 24 * 3600000;
const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SCRIPT = path.join(SCRIPTS, 'lifecycle.js');

const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const VOLUME = path.join(TMP, 'volume.json');
const CAPPROBE = path.join(TMP, 'capacity-probe.json');
const PROCS = path.join(TMP, 'procs.json');
const PRS = path.join(TMP, 'prs.json');
const PROJECTS = path.join(TMP, 'projects');
fs.mkdirSync(PROJECTS);
const AMPLE = { diskFreeBytes: 500 * 1024 ** 3, diskTotalBytes: 1000 * 1024 ** 3, commitFreeBytes: 64 * 1024 ** 3 };
const SHORT = { diskFreeBytes: 1024 ** 3, diskTotalBytes: 1000 * 1024 ** 3, commitFreeBytes: 64 * 1024 ** 3 };
write(CAPPROBE, JSON.stringify(AMPLE));
write(PROCS, JSON.stringify([{ pid: 1, ppid: 0, commandLine: 'idle', executablePath: '' }]));
write(PRS, '[]');

Object.assign(process.env, {
    HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, AUTODEV_GATE_LOCK_PATH: path.join(TMP, 'gate', 'full-gate.lock'),
    AUTODEV_CAPACITY_PROBE_FILE: CAPPROBE, AUTODEV_LIFECYCLE_VOLUME_FILE: VOLUME, AUTODEV_LIFECYCLE_PAGEFILE_BYTES: String(4 * 1024 * 1024),
    AUTODEV_REAP_TEST_PROCS: PROCS, AUTODEV_REAP_TEST_PRS: PRS, AUTODEV_REAP_PROJECTS_DIRS: PROJECTS, CLAUDE_CONFIG_DIR: path.join(TMP, 'profile'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});

const lc = require(SCRIPT);
const capacity = require(path.join(SCRIPTS, 'capacity.js'));

const problems = { growth_reconciled: [], expired_eligible: [], protected: [], missed_retention: [], lifecycle_recovery: [] };
let protectedLost = false;
// Every passing check is counted, so the scorecard can read this suite's population.
const passedChecks = [];
const note = (field, cond, why) => { if (!cond) problems[field].push(why); else passedChecks.push(field); return Boolean(cond); };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

function cli(args, extraEnv = {}) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: TMP, env: { ...process.env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 600000 });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* text */ }
    return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

/** Sets every mtime under `p` (links excluded) to `days` ago, children before parents. */
function ageTree(p, days) {
    const t = (Date.now() - days * DAY) / 1000;
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) ageTree(path.join(p, n), days);
    fs.utimesSync(p, t, t);
}

// ---------------------------------------------------------------------------
// growth_reconciled
// ---------------------------------------------------------------------------

function growth() {
    const A = path.join(TMP, 'disk', 'a');
    const N = path.join(A, 'nested');
    const B = path.join(TMP, 'disk', 'b');
    write(path.join(A, 'x.bin'), Buffer.alloc(1000, 1));
    write(path.join(N, 'y.bin'), Buffer.alloc(3000, 2));
    write(path.join(B, 'z.bin'), Buffer.alloc(500, 3));
    fs.linkSync(path.join(A, 'x.bin'), path.join(B, 'hl.bin'));
    fs.symlinkSync(B, path.join(A, 'link'), WIN ? 'junction' : 'dir');
    const state = path.join(TMP, 'state-growth');
    const cfg = path.join(TMP, 'growth.json');
    write(cfg, JSON.stringify({ stateDir: state, roots: [A, N, B], reportPaths: [] }));
    const MB = 1024 * 1024;
    write(VOLUME, JSON.stringify({ usedBytes: 10 * MB, totalBytes: 100 * MB }));
    const s1 = cli(['snapshot', '--config', cfg, '--json'], { AUTODEV_LIFECYCLE_PAGEFILE_BYTES: String(4 * MB) });
    if (!note('growth_reconciled', s1.exit === 0 && s1.json, `first snapshot exit ${s1.exit}: ${s1.stderr.slice(0, 300)}`)) return;
    const snap = s1.json.snapshot;
    const r = (p) => snap.roots.find((x) => x.root === p) || {};
    note('growth_reconciled', snap.totals.uniqueLogicalBytes === 4500, `unique logical ${snap.totals.uniqueLogicalBytes}, want 4500 (each byte once)`);
    note('growth_reconciled', r(A).logicalBytes === 1000 && r(A).skippedNested === 1, `root a counted ${r(A).logicalBytes}, skipped ${r(A).skippedNested} nested: the parent summed its child`);
    note('growth_reconciled', r(A).linksNotFollowed === 1, `root a links not followed ${r(A).linksNotFollowed}, want 1`);
    note('growth_reconciled', r(B).duplicateBytes === 1000, `root b hardlink duplication ${r(B).duplicateBytes}, want 1000`);
    note('growth_reconciled', r(N).nestedIn === A, `nested root says it is inside ${r(N).nestedIn}`);
    note('growth_reconciled', snap.totals.allocatedBytes === null || snap.totals.allocatedBytes !== snap.totals.uniqueLogicalBytes || /never substituted/.test(snap.totals.basis),
        'allocated bytes stood in for logical');
    note('growth_reconciled', s1.json.reconcile === null, 'a first snapshot reconciled against nothing');
    note('growth_reconciled', r(A).coverage && r(A).coverage.complete && snap.complete, 'a fixture scan read as incomplete');
    // Growth: 9000 bytes in two roots, 1 MiB of pagefile, 12345 bytes nothing measured.
    write(path.join(N, 'g.bin'), Buffer.alloc(7000, 4));
    write(path.join(B, 'h.bin'), Buffer.alloc(2000, 5));
    write(VOLUME, JSON.stringify({ usedBytes: 10 * MB + 9000 + MB + 12345, totalBytes: 100 * MB }));
    const s2 = cli(['snapshot', '--config', cfg, '--json'], { AUTODEV_LIFECYCLE_PAGEFILE_BYTES: String(5 * MB) });
    const rec = s2.json && s2.json.reconcile;
    if (!note('growth_reconciled', s2.exit === 0 && rec, `second snapshot exit ${s2.exit}: ${s2.stderr.slice(0, 300)}`)) return;
    note('growth_reconciled', rec.attributedBytes === 9000, `attributed ${rec.attributedBytes}, want 9000`);
    note('growth_reconciled', rec.pagefileDeltaBytes === MB, `pagefile delta ${rec.pagefileDeltaBytes}, want ${MB}`);
    note('growth_reconciled', rec.residualBytes === 12345, `residual ${rec.residualBytes}, want 12345`);
    note('growth_reconciled', rec.volumeDeltaBytes === 9000 + MB + 12345 && rec.basis === 'logical', `volume delta ${rec.volumeDeltaBytes}, basis ${rec.basis}`);
    const unk = lc.reconcile({ ...snap, pagefile: { bytes: null } }, s2.json.snapshot);
    note('growth_reconciled', unk.pagefileDeltaBytes === null && unk.why.some((w) => /pagefile/.test(w)), 'an unmeasured pagefile was treated as zero without saying so');
    note('growth_reconciled', lc.probePagefile({ AUTODEV_LIFECYCLE_PAGEFILE_BYTES: 'unknown' }).bytes === null, 'an unknown pagefile fixture read as a number');
    note('growth_reconciled', lc.probePagefile({}, 'linux').bytes === null, 'a platform with no pagefile probe returned a number');
    const lines = fs.readFileSync(path.join(state, 'snapshots.jsonl'), 'utf8').trim().split('\n');
    note('growth_reconciled', lines.length === 2, `snapshots kept ${lines.length}, want 2`);
}

// ---------------------------------------------------------------------------
// The worktree fixture.
// ---------------------------------------------------------------------------

const NOHOOKS = path.join(TMP, 'nohooks');
function g(cwd, ...args) {
    const r = spawnSync('git', ['-c', `core.hooksPath=${NOHOOKS}`, '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
    return r.stdout.trim();
}
function commit(dir, file, text, msg) { write(path.join(dir, file), text); g(dir, 'add', file); g(dir, 'commit', '-q', '-m', msg); return g(dir, 'rev-parse', 'HEAD'); }
function ageAdmin(wt, hours) {
    const admin = g(wt, 'rev-parse', '--absolute-git-dir');
    const t = (Date.now() - hours * 3600000) / 1000;
    const log = path.join(admin, 'logs', 'HEAD');
    try { fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace(/> \d+ ([+-]\d{4})/g, `> ${Math.floor(t)} $1`)); } catch { /* absent */ }
    for (const f of ['HEAD', 'index', path.join('logs', 'HEAD')]) { try { fs.utimesSync(path.join(admin, f), t, t); } catch { /* absent */ } }
}

const main = path.join(TMP, 'main');
const W = {};
function worktrees() {
    const origin = path.join(TMP, 'origin.git');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
    fs.mkdirSync(main);
    g(main, 'init', '-q', '-b', 'main');
    g(main, 'remote', 'add', 'origin', origin);
    write(path.join(main, '.gitignore'), 'node_modules/\n.env.local\n');
    write(path.join(main, '.env.local'), 'KEY=shared\n');
    commit(main, 'a.txt', 'a\n', 'init');
    g(main, 'add', '.gitignore'); g(main, 'commit', '-q', '-m', 'ignore');
    g(main, 'push', '-q', '-u', 'origin', 'main');
    g(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    g(main, 'remote', 'set-head', 'origin', 'main');
    for (const name of ['reapme', 'dirty', 'ignored', 'unmerged', 'junction', 'hardlink', 'shared', 'norecord', 'leased']) {
        const d = path.join(main, '.claude', 'worktrees', name);
        g(main, 'worktree', 'add', '-q', '-b', `b/${name}`, d, 'main');
        W[name] = d;
        commit(d, `${name}.txt`, `${name}\n`, `${name} work`);
        if (name !== 'unmerged') g(main, 'merge', '-q', '--no-ff', '-m', `merge b/${name}`, `b/${name}`);
    }
    g(main, 'push', '-q', 'origin', 'main');
    g(main, 'push', '-q', 'origin', 'b/unmerged');
    write(path.join(W.dirty, 'notes.txt'), 'only here\n');
    write(path.join(W.ignored, '.env.local'), 'KEY=only-here\n');
    const outside = path.join(TMP, 'outside');
    write(path.join(outside, 'canary.txt'), 'alive\n');
    fs.mkdirSync(path.join(W.junction, 'node_modules'), { recursive: true });
    fs.symlinkSync(outside, path.join(W.junction, 'node_modules', 'link'), WIN ? 'junction' : 'dir');
    write(path.join(TMP, 'hl-source.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(W.hardlink, 'node_modules', 'pkg'), { recursive: true });
    fs.linkSync(path.join(TMP, 'hl-source.js'), path.join(W.hardlink, 'node_modules', 'pkg', 'index.js'));
    const shared = require(path.join(SCRIPTS, 'shared-install.js'));
    write(path.join(W.shared, 'node_modules', shared.MARKER), JSON.stringify({ state: 'shared' }));
    write(path.join(W.shared, 'node_modules', 'pkg', 'index.js'), 'module.exports = 2;\n');
    for (const d of Object.values(W)) ageAdmin(d, 3);
}

// ---------------------------------------------------------------------------
// One apply over scratch, worktrees and reported paths.
// ---------------------------------------------------------------------------

const S = path.join(TMP, 'scratch');
const STATE = path.join(TMP, 'state');
const CFG = path.join(TMP, 'lifecycle.json');
const U = {
    old: path.join(S, 'old-run'), fresh: path.join(S, 'fresh-run'), evidence: path.join(S, 'evidence-run'),
    dumps: path.join(S, 'LiveKernelReports'), shader: path.join(S, 'gpu'), pagefile: path.join(S, 'pagefile.sys'),
    transcripts: path.join(S, 'profile-copy'), vendor: path.join(S, 'ms-playwright'),
};
const REPORTED = path.join(TMP, 'sys', 'LiveKernelReports');

function retention() {
    write(path.join(U.old, 'out.log'), Buffer.alloc(2048, 7));
    write(path.join(U.fresh, 'out.log'), 'fresh\n');
    write(path.join(U.evidence, 'trace.txt'), 'the only copy of a failing trace\n');
    write(path.join(U.evidence, lc.EVIDENCE_MARKER), JSON.stringify({ resolved: false, what: 'gate red on run 41' }));
    write(path.join(U.dumps, 'WATCHDOG', 'gpu.dmp'), Buffer.alloc(4096, 9));
    write(path.join(U.shader, 'NVIDIA', 'DXCache', 'cache.bin'), Buffer.alloc(4096, 8));
    write(U.pagefile, Buffer.alloc(1024, 6));
    write(path.join(U.transcripts, '.claude', 'projects', 'p', 'session.jsonl'), '{}\n');
    write(path.join(U.vendor, 'chromium-1', 'chrome.bin'), Buffer.alloc(1024, 5));
    for (const p of Object.values(U)) if (p !== U.fresh) ageTree(p, 10);
    write(path.join(REPORTED, 'big.dmp'), Buffer.alloc(8192, 1));
    ageTree(path.dirname(REPORTED), 10);
    write(CFG, JSON.stringify({ stateDir: STATE, scratchRoots: [S], repos: [main], reportPaths: [REPORTED], archiveDir: path.join(TMP, 'archives'), idleHours: 1 }));
    const config = lc.loadConfig(CFG).config;
    const old = Date.now() - 3 * DAY;
    for (const n of ['reapme', 'dirty', 'ignored', 'unmerged', 'junction', 'hardlink', 'shared']) {
        const r = lc.recordWorktree(config, { worktree: W[n], owner: `session-${n}`, task: `task ${n}`, now: old });
        note('protected', r.ok, `record ${n}: ${r.why}`);
    }
    const leased = cli(['record', '--config', CFG, '--worktree', W.leased, '--owner', 'session-leased', '--task', 'still going', '--lease-hours', '48']);
    note('protected', leased.exit === 0, `record via the CLI exited ${leased.exit}: ${leased.stderr}`);
    const noRec = cli(['touch', '--config', CFG, '--worktree', W.norecord]);
    note('protected', noRec.exit === 2 && /no record/.test(noRec.stderr), `touch without a record exited ${noRec.exit}`);
    const reapHead = g(W.reapme, 'rev-parse', 'HEAD');

    const dry = cli(['plan', '--config', CFG, '--json']);
    if (!note('expired_eligible', dry.exit === 0 && dry.json, `plan exited ${dry.exit}: ${dry.stderr.slice(0, 400)}`)) return null;
    note('expired_eligible', Object.values(U).every(exists) && Object.values(W).every(exists), 'plan, a dry run, removed something');
    const unit = (res, p) => res.json.scratch.find((u) => u.path === p) || {};
    const row = (res, n) => res.json.worktrees.find((w) => path.resolve(w.path) === path.resolve(W[n])) || {};
    note('expired_eligible', unit(dry, U.old).verdict === 'remove', `old unit planned ${unit(dry, U.old).verdict}: ${unit(dry, U.old).why}`);
    note('expired_eligible', unit(dry, U.evidence).verdict === 'archive', `evidence unit planned ${unit(dry, U.evidence).verdict}`);
    note('expired_eligible', row(dry, 'reapme').verdict === 'remove', `reapme planned ${row(dry, 'reapme').verdict}: ${row(dry, 'reapme').why}`);

    const ap = cli(['apply', '--config', CFG, '--json']);
    if (!note('expired_eligible', ap.json, `apply printed no JSON (exit ${ap.exit}): ${ap.stderr.slice(0, 400)}`)) return null;
    note('expired_eligible', ap.exit === 0, `apply exited ${ap.exit}`);
    note('expired_eligible', !exists(U.old), 'the expired scratch unit is still on disk');
    note('expired_eligible', !exists(W.reapme), 'the landed, recorded, idle worktree is still on disk');
    const arch = unit(ap, U.evidence);
    note('expired_eligible', arch.outcome === 'archived' && !exists(U.evidence), `the evidence unit came out ${arch.outcome}: ${arch.outcomeWhy}`);
    const tars = exists(path.join(TMP, 'archives')) ? fs.readdirSync(path.join(TMP, 'archives')).filter((f) => f.endsWith('.tar')) : [];
    note('expired_eligible', tars.length === 1, `archives written: ${tars.length}`);

    const keptUnits = { fresh: /window/, dumps: /kernel-dumps/, shader: /shader-cache/, pagefile: /pagefile/, transcripts: /transcripts/, vendor: /vendor-cache/ };
    for (const [k, re] of Object.entries(keptUnits)) {
        const u = unit(ap, U[k]);
        if (!exists(U[k])) { protectedLost = true; note('protected', false, `${k} was deleted`); continue; }
        note('protected', u.verdict === 'keep' && re.test(u.why || ''), `${k} kept for the wrong reason: ${u.verdict} ${u.why}`);
    }
    if (!exists(path.join(REPORTED, 'big.dmp'))) { protectedLost = true; note('protected', false, 'the reported dump was deleted'); }
    const rep = ap.json.reported.find((p) => p.path === REPORTED);
    note('protected', rep && rep.logicalBytes === 8192 && rep.cls === 'kernel-dumps', `the dump report reads ${JSON.stringify(rep)}`);
    const keptTrees = { dirty: /changed or untracked/, ignored: /exist only here/, unmerged: /not landed/, junction: /junction/, hardlink: /hardlinked/,
        shared: /shared install/, norecord: /no owner record/, leased: /lease/ };
    for (const [n, re] of Object.entries(keptTrees)) {
        const w = row(ap, n);
        if (!exists(W[n])) { protectedLost = true; note('protected', false, `worktree ${n} was removed`); continue; }
        note('protected', w.verdict === 'keep' && re.test(w.why || ''), `worktree ${n}: ${w.verdict} ${w.why}`);
    }
    note('protected', fs.readFileSync(path.join(TMP, 'outside', 'canary.txt'), 'utf8') === 'alive\n', 'the junction target lost its canary');
    note('protected', exists(path.join(TMP, 'hl-source.js')), 'the hardlink source was deleted');
    note('protected', lc.removeUnit(lc.loadConfig(CFG).config, U.pagefile).removed === false && exists(U.pagefile), 'removeUnit deleted a protected path when asked directly');
    note('protected', lc.removeUnit(lc.loadConfig(CFG).config, path.join(TMP, 'hl-source.js')).removed === false, 'removeUnit deleted a path outside every scratch root');
    note('protected', ['C:\\pagefile.sys', '/x/.claude-b/projects/s/a.jsonl', 'D:\\Data\\AppData\\Local\\NVIDIA\\GLCache\\a'].every((p) => lc.protectedClass(p)),
        'a protected spelling was not classified');
    note('protected', lc.protectedClass(path.join(TMP, 'scratch', 'old-run')) === null, 'an ordinary scratch path was classified protected');
    return { reapHead };
}

// ---------------------------------------------------------------------------
// missed_retention
// ---------------------------------------------------------------------------

async function missed() {
    note('missed_retention', lc.RETENTION_DAYS === 7 && lc.SCRATCH_CAP_BYTES === 8 * 1024 ** 3 && lc.STREAM_CAP_BYTES === 128 * 1024 ** 2,
        `defaults ${lc.RETENTION_DAYS} days, ${lc.SCRATCH_CAP_BYTES} scratch, ${lc.STREAM_CAP_BYTES} stream`);
    const fresh = cli(['check-receipt', '--config', CFG]);
    note('missed_retention', fresh.exit === 0 && /fresh/.test(fresh.stdout), `the receipt apply just wrote read ${fresh.exit}: ${fresh.stdout}`);
    const st2 = path.join(TMP, 'state-receipt');
    const cfg2 = path.join(TMP, 'receipt.json');
    write(cfg2, JSON.stringify({ stateDir: st2, reportPaths: [] }));
    const none = cli(['check-receipt', '--config', cfg2]);
    note('missed_retention', none.exit === 1 && /never completed/.test(none.stdout), `a missing receipt read exit ${none.exit}: ${none.stdout}`);
    const config2 = lc.loadConfig(cfg2).config;
    lc.writeReceipt(config2, { removed: 0 }, Date.now() - 30 * 3600000);
    const stale = cli(['check-receipt', '--config', cfg2, '--json']);
    note('missed_retention', stale.exit === 1 && stale.json && stale.json.overdue === true, `a 30 h old receipt read exit ${stale.exit}: ${stale.stdout}`);
    note('missed_retention', lc.receiptStatus(config2, { now: Date.now() - 6 * 3600000 }).overdue === false, 'a 24 h old receipt read overdue at the 26 h limit');
    write(lc.receiptPath(config2), '{not json');
    note('missed_retention', lc.receiptStatus(config2).overdue === true, 'an unreadable receipt read fresh');

    // Overflow: 5000 bytes of fresh scratch against a 1000-byte cap.
    const s3 = path.join(TMP, 'scratch-overflow');
    const cfg3 = path.join(TMP, 'overflow.json');
    write(cfg3, JSON.stringify({ stateDir: path.join(TMP, 'state-overflow'), scratchRoots: [s3], scratchCapBytes: 1000, reportPaths: [] }));
    for (let i = 0; i < 12; i++) write(path.join(s3, `run-${i}`, 'out.log'), Buffer.alloc(500, i));
    const over = cli(['apply', '--config', cfg3, '--json']);
    const config3 = lc.loadConfig(cfg3).config;
    const flag = (() => { try { return JSON.parse(fs.readFileSync(path.join(config3.stateDir, 'scratch-overflow.json'), 'utf8')); } catch { return null; } })();
    note('missed_retention', over.json && over.json.overflow.overflow === true && flag && flag.largest.length === 10, `overflow not flagged with ten diagnostics: ${over.stdout.slice(0, 300)}`);
    note('missed_retention', lc.scratchAdmission(config3).ok === false, 'a producer was admitted while scratch is over the cap');
    note('missed_retention', fs.readdirSync(s3).length === 12, 'overflow deleted fresh scratch instead of stopping producers');
    for (let i = 0; i < 11; i++) fs.rmSync(path.join(s3, `run-${i}`), { recursive: true });
    cli(['apply', '--config', cfg3]);
    note('missed_retention', lc.scratchAdmission(config3).ok === true, 'the overflow flag stayed set after scratch fell under the cap');

    // A producer streaming 3 MiB against a 1 MiB cap is stopped at the cap.
    const out = path.join(TMP, 'attempt', 'stdout.log');
    const child = spawn(process.execPath, ['-e', 'const b=Buffer.alloc(65536,65);let n=0;function w(){while(n<48){n++;if(!process.stdout.write(b))return process.stdout.once("drain",w)}require("fs").writeFileSync(process.argv[1],"finished")}w()', path.join(TMP, 'attempt', 'finished')],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
    const res = await lc.capStream({ stream: child.stdout, file: out, capBytes: 1024 * 1024, stop: () => child.kill() });
    await exited;
    const diag = (() => { try { return JSON.parse(fs.readFileSync(`${out}.overflow.json`, 'utf8')); } catch { return null; } })();
    note('missed_retention', res.overflowed && fs.statSync(out).size === 1024 * 1024, `stream overflow ${res.overflowed}, file ${exists(out) ? fs.statSync(out).size : 'absent'} bytes`);
    note('missed_retention', diag && diag.tail.length > 0 && diag.tail.length <= 4096 && diag.capBytes === 1024 * 1024, 'the overflow diagnostics are missing or unbounded');
    note('missed_retention', !exists(path.join(TMP, 'attempt', 'finished')), 'the producer ran to completion past its cap');
    const small = path.join(TMP, 'attempt2', 'stdout.log');
    const c2 = spawn(process.execPath, ['-e', 'process.stdout.write("ok")'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const r2 = await lc.capStream({ stream: c2.stdout, file: small, capBytes: 1024, stop: () => c2.kill() });
    note('missed_retention', !r2.overflowed && fs.readFileSync(small, 'utf8') === 'ok' && !exists(`${small}.overflow.json`), 'output under its cap was cut or flagged');
}

// ---------------------------------------------------------------------------
// lifecycle_recovery
// ---------------------------------------------------------------------------

function recovery(ctx) {
    const back = cli(['restore', '--config', CFG, '--worktree', W.reapme]);
    note('lifecycle_recovery', back.exit === 0 && exists(W.reapme) && ctx && g(W.reapme, 'rev-parse', 'HEAD') === ctx.reapHead, `restore exited ${back.exit}: ${back.stdout}${back.stderr}`);
    const again = cli(['restore', '--config', CFG, '--worktree', W.reapme]);
    note('lifecycle_recovery', again.exit === 1 && /exists already/.test(again.stdout), 'a second restore over a live worktree did not refuse');

    // An interrupted pass: one intent whose target is gone, one whose target is still there.
    const s4 = path.join(TMP, 'scratch-journal');
    const cfg4 = path.join(TMP, 'journal.json');
    write(cfg4, JSON.stringify({ stateDir: path.join(TMP, 'state-journal'), scratchRoots: [s4], reportPaths: [] }));
    const config4 = lc.loadConfig(cfg4).config;
    const present = path.join(s4, 'half-done');
    write(path.join(present, 'out.log'), 'still here\n');
    write(lc.journalPath(config4), [
        JSON.stringify({ id: 'gone1', op: 'remove', path: path.join(s4, 'removed-before-crash'), state: 'intent' }),
        JSON.stringify({ id: 'here1', op: 'remove', path: present, state: 'intent' }),
    ].join('\n') + '\n');
    const r = lc.apply(config4);
    note('lifecycle_recovery', r.recovered.resolved.length === 1 && r.recovered.rejudge.length === 1, `recovered ${JSON.stringify(r.recovered)}`);
    note('lifecycle_recovery', exists(present), 'recovery deleted a target it had not judged');
    note('lifecycle_recovery', lc.recoverJournal(config4).resolved.length === 0 && lc.recoverJournal(config4).rejudge.length === 0, 'a recovered intent was recovered twice');

    // Archive creation needs capacity admission.
    const cfg5 = path.join(TMP, 'archive.json');
    write(cfg5, JSON.stringify({ stateDir: path.join(TMP, 'state-archive'), scratchRoots: [path.join(TMP, 'scratch-archive')], archiveDir: path.join(TMP, 'archives-5'), reportPaths: [] }));
    const config5 = lc.loadConfig(cfg5).config;
    const src = path.join(TMP, 'scratch-archive', 'proof');
    write(path.join(src, 'a.txt'), 'first file\n');
    write(path.join(src, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 3, 255]));
    write(CAPPROBE, JSON.stringify(SHORT));
    // Its own ledger: a deferral holds the class until three healthy samples, and the admitted case below must not inherit that.
    const refused = lc.archiveUnit(config5, src, { env: { ...process.env, AUTODEV_GATE_LOCK_PATH: path.join(TMP, 'gate-short', 'full-gate.lock') } });
    note('lifecycle_recovery', !refused.archived && /capacity admission refused/.test(refused.why) && !exists(config5.archiveDir), `a short disk still archived: ${JSON.stringify(refused)}`);
    write(CAPPROBE, JSON.stringify(AMPLE));
    const ok = lc.archiveUnit(config5, src);
    if (note('lifecycle_recovery', ok.archived, `an admitted archive failed: ${ok.why}`)) {
        const ex = path.join(TMP, 'extract');
        fs.mkdirSync(ex);
        const x = spawnSync('tar', ['-xf', path.relative(ex, ok.file).replace(/\\/g, '/')], { cwd: ex, encoding: 'utf8' });
        note('lifecycle_recovery', x.status === 0 && fs.readFileSync(path.join(ex, 'proof', 'sub', 'b.bin')).equals(Buffer.from([0, 1, 2, 3, 255])), `the archive did not round-trip: ${x.stderr}`);
    }
    const ledger = capacity.status({ base: process.env.AUTODEV_GATE_LOCK_PATH, isAlive: () => true });
    note('lifecycle_recovery', ledger.ledger && ledger.ledger.reservations.length === 0, 'an archive reservation was never released');
    note('lifecycle_recovery', capacity.CLASSES.includes('archive'), 'capacity has no archive class');
}

// ---------------------------------------------------------------------------

function parseAndUsage() {
    const help = cli(['--help']);
    note('lifecycle_recovery', help.exit === 0 && /plan/.test(help.stdout) && !exists(path.join(FAKE_HOME, '.claude')), `--help exited ${help.exit} or wrote state`);
    const bad = cli(['explode']);
    note('lifecycle_recovery', bad.exit === 2, `an unknown verb exited ${bad.exit}`);
    const p = lc.parseArgs(['record', '--worktree']);
    note('lifecycle_recovery', /needs a value/.test(p.error || ''), 'a flag with no value parsed');
    const cfgBad = path.join(TMP, 'bad.json');
    write(cfgBad, '[1]');
    note('lifecycle_recovery', cli(['plan', '--config', cfgBad]).exit === 2, 'a config that is not an object was used');
    note('lifecycle_recovery', lc.defaultReportPaths({ SystemRoot: 'X:\\Win', LOCALAPPDATA: 'X:\\L' }, 'win32').every((q) => lc.protectedClass(q)), 'a default reported path is not a protected class');
    note('lifecycle_recovery', lc.defaultStateDir({ USERPROFILE: FAKE_HOME }).startsWith(FAKE_HOME), 'the default state dir ignores the profile');
}

(async () => {
    try {
        growth();
        worktrees();
        const ctx = retention();
        await missed();
        recovery(ctx);
        parseAndUsage();
        const text = cli(['plan', '--config', CFG]);
        note('lifecycle_recovery', text.exit === 0 && /dry run/.test(text.stdout), 'the text plan did not print');
    } catch (e) {
        problems.lifecycle_recovery.push(`the suite threw: ${e.stack}`);
    }
    note('lifecycle_recovery', !exists(path.join(FAKE_HOME, '.claude')), 'something defaulted into the profile dir');
    note('lifecycle_recovery', REAL_WATCH.map(statOf).join('|') === realBefore.join('|'), 'the real profile lifecycle or capacity state changed');
    for (const [k, v] of Object.entries(problems)) for (const w of v) process.stderr.write(`${k}: ${w}\n`);
    const fields = {
        growth_reconciled: problems.growth_reconciled.length ? 'FAIL' : 'PASS',
        expired_eligible: problems.expired_eligible.length ? 'KEPT' : 'REMOVED',
        protected: protectedLost ? 'DELETED' : problems.protected.length ? 'FAIL' : 'KEPT',
        missed_retention: problems.missed_retention.length ? 'MISSED' : 'DETECTED',
        lifecycle_recovery: problems.lifecycle_recovery.length ? 'FAIL' : 'PASS',
    };
    const line = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a held file: the OS temp sweep takes it */ }
    process.stdout.write(passedChecks.map((f, i) => `ok ${f} ${i + 1}\n`).join(''));
    process.stdout.write(`${line}\n`);
    process.exitCode = line === 'growth_reconciled=PASS expired_eligible=REMOVED protected=KEPT missed_retention=DETECTED lifecycle_recovery=PASS' ? 0 : 1;
})();
