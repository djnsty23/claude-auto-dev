#!/usr/bin/env node
/**
 * test-gate-ownership.js - drives plugins/autodev-core/scripts/full-gate-queue.js
 * as a SUBPROCESS for the ownership records: the admission mutex, the class
 * derived from the checkout, arrival across a hand-over, the judgement of a
 * lock's owner (boot, creation time, MSYS pid, execution descendants) and the
 * fencing token on release.
 *
 * Every scenario runs against the real subject (every row must pass) and
 * against a copy with one defect planted by an exact anchor (some row must
 * fail). The anchor must match exactly once, or the plant itself fails:
 *   P1  admission runs without the mutex          -> two harness lanes on a cap of one (S1, S2)
 *   P2  the class is the declared one              -> a harness checkout queues as product (S3)
 *   P3  arrival is the admission time              -> a hand-over forgets when the ticket arrived (S4)
 *   P4  the judgement ignores the boot             -> a pre-boot lock on a live pid holds forever (S5)
 *   P4b the no-creation-time path ignores the boot -> the same, for an owner recorded from a ticket (S5)
 *   P5  a record matches by pid alone              -> a reused pid keeps a dead owner's lock (S6)
 *   P5b a reused pid's own children count          -> its console host keeps the dead owner alive (S6)
 *   P6  the MSYS pid is never checked              -> a live Git Bash owner reads dead (S7)
 *   P7  execution processes are ignored            -> a live chain under a dead owner is taken over (S8)
 *   P8  release ignores the fencing token          -> a late release frees a later admission (S9)
 *   P9  a malformed meta line reads as legacy      -> an unreadable record is taken over (S10)
 *   P10o a lane-lock reader drops the meta line    -> the reaper cannot tell whose run holds a lane (S11)
 *   P10l a lease renewal ignores run and token     -> a late writer overwrites a newer lease (S11)
 *   P11o --repo vouches for the caller             -> a harness checkout naming a product queues as product (S3)
 *   P12o a ticket-identity owner skips its journal -> its live chain is taken over (S8)
 *   P13o a run id alone does not fence a release   -> a late release of an earlier run frees a later one (S9)
 *   P14o a meta line that parses is trusted        -> a nonsense creation time reads as a reused pid (S10b)
 *   P15o an unreadable creation time is a reuse    -> a live owner reads dead (S12)
 *   P16o the fencing counter passes 2^53 - 1       -> two admissions share a token (S12)
 *   P17o a pre-boot mutex is held by its pid        -> every admission times out after a reboot (S12)
 *   P18o admission's default calls a holder dead    -> a live admission's mutex is broken under it (S13)
 *   P19o the worktree mutex's default does the same -> a lease writer's mutex is broken under it (S13)
 *   P20o a lease's default calls every run finished -> a second gate overwrites a running lease (S13)
 *   P21o any lock naming the pid is the caller's    -> a reused pid inherits a dead run's lane (S13)
 *   P22o iso7 formats an unparseable time           -> an odd creation time throws in the judgement (S13)
 *   P23o the POSIX probes answer with a fixed boot  -> a boot identity that no reboot changes (S13)
 *   P24o a parent seen gone adopts later children   -> a stopped shell's orphan holds the lane (S14)
 *   P25o the journal never records a process gone   -> the same, from the journal side (S14)
 *
 * The machine's real lock is never touched: every spawn sets
 * AUTODEV_GATE_LOCK_PATH to a temp directory.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'full-gate-queue.js');
const LIBS = ['full-gate-queue.js', 'gate-identity.js', 'gate-records.js'];
const ident = require(path.join(SCRIPTS, 'gate-identity.js'));
const records = require(path.join(SCRIPTS, 'gate-records.js'));
const WIN = process.platform === 'win32';
const EXIT_QUEUED = 3;
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
const mkTemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };

// ---------------------------------------------------------------------------
// Processes.
// ---------------------------------------------------------------------------

const kids = [];
const trees = [];

function sleeper() {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
    kids.push(c);
    return c.pid;
}

/**
 * A sleeper that starts a child of its own and waits for it, on every
 * platform: the reused pid in S6 must have a child created after it, or a
 * defect that adopts a reused pid's children has nothing to adopt (on POSIX a
 * plain sleeper has none; on Windows only a console host). Resolves
 * { pid, child }, or { pid: null, why }.
 */
async function sleeperWithChild() {
    const out = path.join(mkTemp('gown-kid-'), 'child');
    const code = [
        "const { spawn } = require('child_process'); const fs = require('fs');",
        "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });",
        `fs.writeFileSync(${JSON.stringify(out)}, c.pid + '\\n');`,
        'setTimeout(() => {}, 600000);',
    ].join('\n');
    const p = spawn(process.execPath, ['-e', code], { stdio: 'ignore', windowsHide: true });
    trees.push(p);
    let text = '';
    for (let i = 0; i < 200 && !/\n/.test(text); i++) {
        await sleep(100);
        try { text = fs.readFileSync(out, 'utf8'); } catch { /* not yet */ }
    }
    const child = Number(text.trim());
    if (!child) return { pid: null, why: 'the sleeper did not start its child within 20 s' };
    detached.push(child);
    return { pid: p.pid, child };
}

function deadPid() {
    const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true });
    return Number(r.stdout.trim());
}

function killPid(pid) {
    if (WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

const detached = [];
function killAll() {
    for (const c of kids) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const c of trees) killPid(c.pid);
    for (const pid of detached) killPid(pid);
}

function gitUsrBin(exe) {
    const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    if (ex.error || ex.status !== 0) return null;
    const p = path.resolve(ex.stdout.trim(), '..', '..', '..', 'usr', 'bin', exe);
    return fs.existsSync(p) ? p : null;
}

/** A Git Bash that sleeps; its MSYS pid, or null with a reason. */
async function msysSleeper() {
    if (!WIN) return { pid: null, why: 'not Windows, so there is no second pid table' };
    const bash = gitUsrBin('bash.exe');
    if (!bash) return { pid: null, why: 'Git Bash not found' };
    const pidFile = path.join(mkTemp('gown-msys-'), 'pid');
    const c = spawn(bash, ['-c', `echo $$ > '${pidFile.replace(/\\/g, '/')}'; for i in $(seq 1 300); do sleep 1; done`],
        { stdio: 'ignore', windowsHide: true });
    trees.push(c);
    let text = '';
    for (let i = 0; i < 200 && !/\n/.test(text); i++) {
        await sleep(100);
        try { text = fs.readFileSync(pidFile, 'utf8'); } catch { /* not yet */ }
    }
    const pid = Number(text.trim());
    if (!pid) return { pid: null, why: 'bash did not write its pid within 20 s' };
    const t = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    if (new RegExp(`^"[^"]*","${pid}"`, 'm').test(t.stdout || '')) return { pid: null, why: `MSYS pid ${pid} is also a live Windows pid` };
    ident.forgetMsys();
    const table = ident.msysTable();
    if (!table.ok || !table.byMsys.has(pid)) return { pid: null, why: `ps -W does not list MSYS pid ${pid}` };
    return { pid, winpid: table.byMsys.get(pid), why: null };
}

/**
 * A process that starts a detached child, then exits once `go` exists: the
 * child outlives the recorded owner, as a gate's grandchild outlives a killed
 * wrapper. Resolves { parent, child } pids.
 */
async function parentWithOrphan() {
    const dir = mkTemp('gown-orphan-');
    const out = path.join(dir, 'pids');
    const go = path.join(dir, 'go');
    const code = [
        "const { spawn } = require('child_process'); const fs = require('fs');",
        "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true, windowsHide: true });",
        'c.unref();',
        `fs.writeFileSync(${JSON.stringify(out)}, process.pid + ' ' + c.pid + '\\n');`,
        `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) clearInterval(t); }, 50);`,
    ].join('\n');
    const p = spawn(process.execPath, ['-e', code], { stdio: 'ignore', windowsHide: true });
    kids.push(p);
    let text = '';
    for (let i = 0; i < 200 && !/\n/.test(text); i++) {
        await sleep(100);
        try { text = fs.readFileSync(out, 'utf8'); } catch { /* not yet */ }
    }
    const [parent, child] = text.trim().split(' ').map(Number);
    if (child) detached.push(child);
    const exited = new Promise((r) => p.on('exit', r));
    return { parent, child, release: async () => { fs.writeFileSync(go, ''); await exited; } };
}

// ---------------------------------------------------------------------------
// Fixtures and invocation.
// ---------------------------------------------------------------------------

function gitRepo(name, files) {
    const dir = path.join(mkTemp('gown-repo-'), name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
    const g = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
    g(['init', '-q']);
    g(['add', '.']);
    g(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture']);
    return dir;
}

let productRepo = null;
const repoDir = () => productRepo || (productRepo = gitRepo('shop', { 'package.json': JSON.stringify({ name: 'shop', private: true }) }));

let bootCache = null;
const bootCacheFile = () => bootCache || (bootCache = path.join(mkTemp('gown-boot-'), 'boot.json'));

function fixture(lanes = 1) {
    const dir = path.join(mkTemp('gown-'), 'locks');
    fs.mkdirSync(dir, { recursive: true });
    if (lanes > 1) fs.writeFileSync(path.join(dir, 'full-gate.lanes'), `${lanes}\n`);
    const lane = (k) => path.join(dir, k === 1 ? 'full-gate.lock' : `full-gate-${k}.lock`);
    const queue = (k) => path.join(dir, k === 1 ? 'full-gate.queue' : `full-gate-${k}.queue`);
    return { dir, lock: lane(1), lane, queue, lanes };
}

function envFor(fx, extra = {}) {
    const env = Object.assign({}, process.env, {
        AUTODEV_GATE_LOCK_PATH: fx.lock,
        AUTODEV_GATE_LOCK_POLL_MS: '100',
        AUTODEV_GATE_LOCK_REPORT_MS: '100000',
        AUTODEV_GATE_QUEUE_STALE_MS: '600000',
        AUTODEV_GATE_BOOT_CACHE: bootCacheFile(),
    }, extra);
    for (const k of ['AUTODEV_GATE_CLASS', 'AUTODEV_GATE_LANES', 'AUTODEV_GATE_TEST_ADMIT_PAUSE_MS']) if (!(k in extra)) delete env[k];
    return env;
}

function run(subject, fx, args, { env = {}, cwd = repoDir() } = {}) {
    const r = spawnSync(process.execPath, [subject, ...args], { cwd, env: envFor(fx, env), encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function runAsync(subject, fx, args, { env = {}, cwd = repoDir() } = {}) {
    return new Promise((resolve) => {
        const c = spawn(process.execPath, [subject, ...args], { cwd, env: envFor(fx, env), windowsHide: true });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { out += d; });
        c.on('close', (code) => resolve({ code, out }));
    });
}

function readLockFile(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const lines = text.split(/\r?\n/);
    return { text, pid: Number(lines[0]), cls: (lines[2] || '').replace(/^class /, ''), ...records.parseMeta(lines) };
}

function plantTicket(queueDir, pid, agoMs, cls) {
    fs.mkdirSync(queueDir, { recursive: true });
    const d = new Date(Date.now() - agoMs);
    const file = path.join(queueDir, `${d.toISOString().replace(/[-:.]/g, '')}-${String(pid).padStart(10, '0')}.ticket`);
    fs.writeFileSync(file, `${pid}\nplanted ticket ${pid}\n${d.toISOString()}\nclass ${cls}\n`);
    return { file, arrived: d.toISOString() };
}

const tokenOf = (out) => { const m = /token (\d+)\)/.exec(out); return m ? Number(m[1]) : null; };

/** A lock written by a gate whose owner is `owner`, as admission writes it. */
function metaLock(fx, owner, { runId = `run-${Math.random().toString(36).slice(2, 8)}`, cls = 'product' } = {}) {
    const meta = { runId, token: 1, lane: 1, admittedUtc: new Date().toISOString(), arrival: null, cls, owner, repo: null };
    fs.mkdirSync(fx.dir, { recursive: true });
    fs.writeFileSync(fx.lock, `${owner.pid}\ngate of an earlier writer\nclass ${cls}\n${records.metaLine(meta)}\n`);
    return { runId, text: fs.readFileSync(fx.lock, 'utf8') };
}

/** Rows: a newcomer's take against `fx`'s lock, which is expected to be judged `alive` (kept) or dead (taken). */
function takeRows(subject, fx, label, alive) {
    const before = fs.readFileSync(fx.lock, 'utf8');
    const w = sleeper();
    const r = run(subject, fx, ['take', '--pid', String(w), '--what', `newcomer ${w}`]);
    const after = readLockFile(fx.lock);
    if (alive) {
        return [
            [`${label}: the newcomer is queued (exit 3)`, r.code === EXIT_QUEUED, r.out],
            [`${label}: the lock is untouched`, Boolean(after) && after.text === before, after ? after.text : '(no lock)'],
        ];
    }
    return [
        [`${label}: the newcomer takes the lane (exit 0)`, r.code === 0, r.out],
        [`${label}: the lock now names the newcomer`, Boolean(after) && after.pid === w, after ? after.text : '(no lock)'],
        [`${label}: the dead record is kept as .stale-HHMM`, fs.readdirSync(fx.dir).some((n) => /^full-gate\.lock\.stale-\d{4}/.test(n)), fs.readdirSync(fx.dir).join(', ')],
    ];
}

let bootId = null;
let snapNow = null;
function freshSnap() { ident.forgetSnapshot(); snapNow = ident.snapshot(); bootId = snapNow.ok ? snapNow.boot.id : null; return snapNow; }
const OLD_START = '2020-01-01T00:00:00.0000000Z';

// ---------------------------------------------------------------------------
// Scenarios: each returns [name, ok, detail] rows.
// ---------------------------------------------------------------------------

/** S1: two harness takes race for two free lanes under a cap of one. */
async function s1HarnessRace(subject) {
    const fx = fixture(2);
    const [a, b] = [sleeper(), sleeper()];
    const env = { AUTODEV_GATE_TEST_ADMIT_PAUSE_MS: '4000' };
    const pa = runAsync(subject, fx, ['take', '--pid', String(a), '--what', 'harness A', '--class', 'harness'], { env });
    await sleep(1200);
    const pb = runAsync(subject, fx, ['take', '--pid', String(b), '--what', 'harness B', '--class', 'harness'], { env });
    const [ra, rb] = await Promise.all([pa, pb]);
    const held = [1, 2].map((k) => readLockFile(fx.lane(k))).filter(Boolean);
    const harness = held.filter((h) => h.cls === 'harness');
    return [
        ['S1: exactly one harness gate holds a lane (cap 1 of 2)', harness.length === 1, `held: ${held.map((h) => `${h.pid}/${h.cls}`).join(', ')}\nA: ${ra.out}\nB: ${rb.out}`],
        ['S1: one take exits 0 and the other is queued (exit 3)', [ra.code, rb.code].sort().join() === `0,${EXIT_QUEUED}`, `A=${ra.code} B=${rb.code}`],
    ];
}

/** S2: two product holders release at once, a harness ticket at the front of each lane. */
async function s2ConcurrentRelease(subject) {
    const fx = fixture(2);
    const [p1, p2, h1, h2] = [sleeper(), sleeper(), sleeper(), sleeper()];
    fs.writeFileSync(fx.lane(1), `${p1}\nproduct holder 1\nclass product\n`);
    fs.writeFileSync(fx.lane(2), `${p2}\nproduct holder 2\nclass product\n`);
    plantTicket(fx.queue(1), h1, 5000, 'harness');
    plantTicket(fx.queue(2), h2, 4000, 'harness');
    const env = { AUTODEV_GATE_TEST_ADMIT_PAUSE_MS: '3000' };
    const [r1, r2] = await Promise.all([
        runAsync(subject, fx, ['release', '--pid', String(p1)], { env }),
        runAsync(subject, fx, ['release', '--pid', String(p2)], { env }),
    ]);
    const held = [1, 2].map((k) => readLockFile(fx.lane(k))).filter(Boolean);
    const harness = held.filter((h) => h.cls === 'harness');
    return [
        ['S2: both releases exit 0', r1.code === 0 && r2.code === 0, `${r1.out}\n${r2.out}`],
        ['S2: at most one lane is handed to a harness ticket', harness.length === 1, `held: ${held.map((h) => `${h.pid}/${h.cls}`).join(', ')}\n${r1.out}\n${r2.out}`],
        ['S2: the other release says the lane is kept for product gates', /kept for product gates/.test(r1.out + r2.out), `${r1.out}\n${r2.out}`],
    ];
}

/** S3: the class comes from the checkout, never from the flag. */
function s3DerivedClass(subject) {
    const rows = [];
    const marked = gitRepo('autodev-fork', {
        'package.json': JSON.stringify({ name: 'some-fork', private: true }),
        '.claude-plugin/marketplace.json': JSON.stringify({ name: 'm', plugins: [{ name: 'autodev-core', source: './plugins/autodev-core' }] }),
    });
    const wt = path.join(mkTemp('gown-wt-'), 'wt');
    const add = spawnSync('git', ['-C', marked, 'worktree', 'add', '-q', '--detach', wt], { encoding: 'utf8', windowsHide: true });
    const plain = mkTemp('gown-nogit-');
    const cases = [
        ['a checkout whose marketplace lists autodev-core', marked, 'harness'],
        ['a git worktree of that checkout', wt, 'harness'],
        ['a directory git cannot name', plain, 'harness'],
        ['a product checkout (control)', repoDir(), 'product'],
    ];
    for (const [label, cwd, want] of cases) {
        const fx = fixture(1);
        const w = sleeper();
        const r = run(subject, fx, ['take', '--pid', String(w), '--what', 'class probe', '--class', 'product'], { cwd });
        const l = readLockFile(fx.lock);
        rows.push([`S3: ${label} with --class product takes the lane as ${want}`,
            r.code === 0 && Boolean(l) && l.cls === want && (!l.meta || l.meta.cls === want), `${add.status === 0 ? '' : `worktree add failed: ${add.stderr}\n`}${r.out}\n${l ? l.text : '(no lock)'}`]);
    }
    // --repo names a product checkout, but the caller runs from the harness.
    const fx = fixture(1);
    const w = sleeper();
    const r = run(subject, fx, ['take', '--pid', String(w), '--what', 'class probe', '--class', 'product', '--repo', repoDir()], { cwd: marked });
    const l = readLockFile(fx.lock);
    rows.push(['S3: a harness checkout naming a product with --repo still takes the lane as harness',
        r.code === 0 && Boolean(l) && l.cls === 'harness' && Boolean(l.meta) && l.meta.cls === 'harness', `${r.out}\n${l ? l.text : '(no lock)'}`]);
    return rows;
}

/** S4: a hand-over records the ticket's arrival, not the moment of hand-over. */
function s4ArrivalSurvives(subject) {
    const fx = fixture(1);
    const [h, w] = [sleeper(), sleeper()];
    fs.writeFileSync(fx.lock, `${h}\nproduct holder\nclass product\n`);
    const t = plantTicket(fx.queue(1), w, 60000, 'product');
    const rel = run(subject, fx, ['release', '--pid', String(h)]);
    const l = readLockFile(fx.lock);
    const arrival = l && l.meta ? l.meta.arrival : null;
    return [
        ['S4: the release hands the lane to the waiter', rel.code === 0 && Boolean(l) && l.pid === w, `${rel.out}\n${l ? l.text : '(no lock)'}`],
        ['S4: the lock records the ticket\'s arrival, 60 s ago', arrival === t.arrived, `arrival=${arrival} ticket=${t.arrived}`],
    ];
}

/** S5: a lock from an earlier boot is dead, whatever runs under its pid now. */
function s5PreBoot(subject) {
    const s = freshSnap();
    if (!s.ok) return [['S5: a process snapshot is available', false, s.why]];
    const pid = sleeper();
    const me = ident.identityOf(pid, { snap: freshSnap() });
    const earlier = `${bootId.split('|')[0]}|2020-01-01T00:00:00.0000000Z`;
    const rows = [];
    let fx = fixture(1);
    metaLock(fx, { pid, startUtc: me.startUtc, bootId: earlier });
    rows.push(...takeRows(subject, fx, 'S5 (full identity, earlier boot)', false));
    fx = fixture(1);
    metaLock(fx, { pid: sleeper(), startUtc: null, bootId: earlier });
    rows.push(...takeRows(subject, fx, 'S5 (ticket identity, earlier boot)', false));
    return rows;
}

/** S6: a reused pid (same number, later creation time) does not keep a dead owner's lock. */
async function s6ReusedPid(subject) {
    const reused = await sleeperWithChild();
    if (!reused.pid) return [['S6: a reused pid with a child of its own', false, reused.why]];
    const s = freshSnap();
    if (!s.ok) return [['S6: a process snapshot is available', false, s.why]];
    const kid = s.procs.get(reused.child);
    const rows = [['S6: the reused pid\'s own child is running, its parent is the reused pid', Boolean(kid) && kid.ppid === reused.pid,
        JSON.stringify(kid || null)]];
    const fx = fixture(1);
    metaLock(fx, { pid: reused.pid, startUtc: OLD_START, bootId });
    return [...rows, ...takeRows(subject, fx, 'S6 (pid reused by a later process with a child)', false)];
}

/**
 * S14: a journaled chain process exits, its pid goes to a process that exits in
 * turn, and that one's orphan (a tail left by a stopped shell) carries the
 * reused pid as its parent. reusedAt sees no current holder, so only the time
 * the journal first missed the parent stops the orphan from holding the lane.
 * A synthetic snapshot: deterministic on every platform.
 */
function s14DeadParentOrphan(subject) {
    const dir = path.dirname(subject);
    const id = require(path.join(dir, 'gate-identity.js'));
    const rec = require(path.join(dir, 'gate-records.js'));
    const rows = [];
    const T = (s) => `2026-01-01T00:00:${s}.0000000Z`;
    const chainRoot = { pid: 900, startUtc: T('00') };
    const kid = { pid: 100, ppid: 900, startUtc: T('01') };
    const live = { pid: 101, ppid: 900, startUtc: T('02') };
    const reusedKid = { pid: 102, ppid: 900, startUtc: T('02') };
    const unreadable = { pid: 103, ppid: 900, startUtc: T('02') };
    const snapOf = (...ps) => ({ ok: true, procs: new Map(ps.map((p) => [p.pid, p])) });
    let j = rec.mergeDescendants([], [kid, live, reusedKid, unreadable], '2026-01-01T00:00:03.000Z', undefined,
        snapOf(kid, live, reusedKid, unreadable));
    rows.push(['S14: no journaled process is stamped while a snapshot shows each one running',
        j.length === 4 && j.every((d) => !d.goneBy), JSON.stringify(j)]);
    j = rec.mergeDescendants(j, [live], '2026-01-01T00:00:05.000Z', undefined,
        snapOf(live, { pid: 102, ppid: 1, startUtc: T('04') }, { pid: 103, ppid: 900, startUtc: null }));
    const by = (pid) => j.find((d) => d.pid === pid) || {};
    rows.push(['S14: a journaled process absent from a later snapshot is stamped goneBy that time',
        by(100).goneBy === '2026-01-01T00:00:05.000Z', JSON.stringify(by(100))]);
    rows.push(['S14: one whose pid a later process holds is stamped with that holder\'s creation time',
        by(102).goneBy === T('04'), JSON.stringify(by(102))]);
    rows.push(['S14: one still running, or whose creation time cannot be read, carries no goneBy',
        !by(101).goneBy && !by(103).goneBy, JSON.stringify([by(101), by(103)])]);
    rows.push(['S14: without a snapshot nothing is stamped (the old record stays as it was)',
        rec.mergeDescendants([{ ...kid, firstSeen: 'x', lastSeen: 'x' }], [], '2026-01-01T00:00:09.000Z').every((d) => !d.goneBy), '']);
    const orphanOfOriginal = { pid: 300, ppid: 100, startUtc: T('04') };
    const orphanOfReuser = { pid: 200, ppid: 100, startUtc: T('40') };
    const procs = new Map([[300, orphanOfOriginal], [200, orphanOfReuser]]);
    const snap = { ok: true, procs, children: new Map([[100, [orphanOfOriginal, orphanOfReuser]]]) };
    const found = id.liveDescendants([chainRoot, ...j], snap).map((p) => p.pid).sort();
    rows.push(['S14: an orphan created after its parent was seen gone is not the chain\'s', !found.includes(200), JSON.stringify(found)]);
    rows.push(['S14: an orphan created before that is still the chain\'s', found.includes(300), JSON.stringify(found)]);
    return rows;
}

/** S7: an owner recorded by its MSYS pid alone is alive while Git Bash still lists it. */
async function s7Msys(subject, msys) {
    if (!msys.pid) return [['S7: an MSYS pid to test with', !WIN, msys.why]];
    freshSnap();
    const fx = fixture(1);
    metaLock(fx, { pid: msys.pid, startUtc: null, bootId, msysPid: msys.pid, msysWinpid: msys.winpid });
    return takeRows(subject, fx, 'S7 (live MSYS owner)', true);
}

/** S8: a dead owner whose execution still runs (its chain root, or an orphaned grandchild) keeps the lane. */
async function s8Descendants(subject, orphan) {
    const s = freshSnap();
    if (!s.ok) return [['S8: a process snapshot is available', false, s.why]];
    const rows = [];
    let fx = fixture(1);
    const chain = sleeper();
    const chainRoot = ident.identityOf(chain, { snap: freshSnap() });
    const { runId } = metaLock(fx, { pid: deadPid(), startUtc: OLD_START, bootId });
    records.updateRun(fx.lock, runId, (v) => ({ ...v, chainRoot }));
    rows.push(...takeRows(subject, fx, 'S8 (dead owner, live chain root)', true));
    fx = fixture(1);
    metaLock(fx, orphan.owner);
    rows.push(...takeRows(subject, fx, 'S8 (dead owner, live detached grandchild)', true));
    // An owner recorded from a ticket (no creation time) that died while the
    // chain root its journal names runs on.
    fx = fixture(1);
    const chain2 = sleeper();
    const root2 = ident.identityOf(chain2, { snap: freshSnap() });
    const t = metaLock(fx, { pid: deadPid(), startUtc: null, bootId });
    records.updateRun(fx.lock, t.runId, (v) => ({ ...v, chainRoot: root2 }));
    rows.push(...takeRows(subject, fx, 'S8 (dead ticket-identity owner, live chain root)', true));
    return rows;
}

/** S9: a release carrying an earlier admission's token frees nothing. */
function s9Fence(subject) {
    const fx = fixture(1);
    const h = sleeper();
    const runId = 'run-fence-s9';
    const t1 = run(subject, fx, ['take', '--pid', String(h), '--run-id', runId]);
    const tok1 = tokenOf(t1.out);
    const r1 = run(subject, fx, ['release', '--pid', String(h), '--run-id', runId, '--token', String(tok1)]);
    const t2 = run(subject, fx, ['take', '--pid', String(h), '--run-id', runId]);
    const tok2 = tokenOf(t2.out);
    const late = run(subject, fx, ['release', '--pid', String(h), '--run-id', runId, '--token', String(tok1)]);
    const l = readLockFile(fx.lock);
    // A late release that names only an earlier run (no token) of the same pid.
    const fx2 = fixture(1);
    const h2 = sleeper();
    const a1 = run(subject, fx2, ['take', '--pid', String(h2), '--run-id', 'run-s9-a']);
    const a2 = run(subject, fx2, ['release', '--pid', String(h2), '--run-id', 'run-s9-a']);
    const b1 = run(subject, fx2, ['take', '--pid', String(h2), '--run-id', 'run-s9-b']);
    const lateRun = run(subject, fx2, ['release', '--pid', String(h2), '--run-id', 'run-s9-a']);
    const l2 = readLockFile(fx2.lock);
    return [
        ['S9: a late release naming only an earlier run exits 1 and run b keeps the lane', a1.code === 0 && a2.code === 0 && b1.code === 0 &&
            lateRun.code === 1 && /not released/.test(lateRun.out) && Boolean(l2) && Boolean(l2.meta) && l2.meta.runId === 'run-s9-b',
            `${a1.out}\n${a2.out}\n${b1.out}\n${lateRun.out}\n${l2 ? l2.text : '(no lock)'}`],
        ['S9: the first admission and its release succeed', t1.code === 0 && tok1 !== null && r1.code === 0, `${t1.out}\n${r1.out}`],
        ['S9: the re-admission gets a later token', t2.code === 0 && tok2 !== null && tok2 > tok1, `${t2.out}`],
        ['S9: the late release with the first token exits 1 and says why', late.code === 1 && /not released/.test(late.out), late.out],
        ['S9: the lock still carries the later token', Boolean(l) && l.meta && l.meta.token === tok2, l ? l.text : '(no lock)'],
    ];
}

/** S10: a lock whose meta line does not parse is never vacant. */
function s10Malformed(subject) {
    const fx = fixture(1);
    fs.mkdirSync(fx.dir, { recursive: true });
    fs.writeFileSync(fx.lock, `${deadPid()}\ngate with a torn record\nclass product\nmeta {"runId": "torn\n`);
    return takeRows(subject, fx, 'S10 (malformed meta, dead pid)', true);
}

/**
 * S10b: a meta line that parses but cannot be trusted (a creation time that is
 * not one, on a live pid) is never judged against the process table.
 */
function s10bSemantic(subject) {
    const fx = fixture(1);
    metaLock(fx, { pid: sleeper(), startUtc: 'not-a-time', bootId });
    return takeRows(subject, fx, 'S10b (meta with a nonsense creation time, live pid)', true);
}

/**
 * S12: the library answers for inputs a live machine rarely produces: a
 * snapshot that holds the owner's pid without a readable creation time, a
 * fencing counter at the end of the safe integers, and an admission mutex
 * left by an earlier boot whose pid now names a live process.
 */
function s12Library(subject) {
    const dir = path.dirname(subject);
    const id = require(path.join(dir, 'gate-identity.js'));
    const rec = require(path.join(dir, 'gate-records.js'));
    const rows = [];
    const procs = new Map([[4242, { pid: 4242, ppid: 1, startUtc: null }]]);
    const snap = { ok: true, boot: { id: 'host|2026-01-01T00:00:00.0000000Z' }, procs, children: new Map([[1, [procs.get(4242)]]]) };
    const j = id.judgeExecution({ owner: { pid: 4242, startUtc: '2026-01-01T00:00:01.0000000Z', bootId: snap.boot.id }, snap, boot: snap.boot, msys: { ok: true, byMsys: new Map(), ambiguous: new Set() } });
    rows.push(['S12: an owner pid whose creation time cannot be read is unknown, not dead', j.alive === null, JSON.stringify(j)]);
    const fx = fixture(1);
    fs.writeFileSync(rec.fencePath(fx.lock), `${Number.MAX_SAFE_INTEGER}\n`);
    let minted = null;
    let err = null;
    try { minted = rec.mintToken(fx.lock); } catch (e) { err = e.code; }
    rows.push(['S12: a fencing counter at 2^53 - 1 refuses to mint (EFENCE), never repeats a token', minted === null && err === 'EFENCE', `minted=${minted} err=${err}`]);
    const fx2 = fixture(1);
    const live = sleeper();
    const mutex = rec.admissionPath(fx2.lock);
    fs.writeFileSync(mutex, `${live}\n2020-01-01T00:00:00.000Z\n`);
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(mutex, old, old);
    let got = null;
    try { got = rec.withAdmission(fx2.lock, () => 'entered', { timeoutMs: 1500, isDead: () => false }); } catch (e) { got = e.code || e.message; }
    rows.push(['S12: an admission mutex written before this boot is broken although its pid is live', got === 'entered', String(got)]);
    return rows;
}

const attempt = (fn) => { try { return fn(); } catch (e) { return `threw ${e.code || e.message}`; } };

/** A pid whose process has already exited. */
function exitedPid() { return spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid; }

/**
 * S13a: the defaults a caller gets by leaving an option out. Without `isDead`
 * a mutex written this boot is never judged dead, so it times out and is kept
 * rather than broken. Without `isLive` another run's active lease is not
 * provably finished, so a first publication is refused.
 */
function s13Records(subject) {
    const rec = require(path.join(path.dirname(subject), 'gate-records.js'));
    const rows = [];
    const fx = fixture(1);
    const body = `${exitedPid()}\n${new Date().toISOString()}\n`;
    const admission = rec.admissionPath(fx.lock);
    fs.writeFileSync(admission, body);
    const a = attempt(() => rec.withAdmission(fx.lock, () => 'entered', { timeoutMs: 400 }));
    rows.push(['S13 admission: without isDead, a mutex held this boot times out (EADMISSION) and is kept',
        a === 'threw EADMISSION' && attempt(() => fs.readFileSync(admission, 'utf8')) === body, String(a)]);
    const key = '0123456789abcdef';
    const mutex = path.join(rec.leasesDir(fx.lock), `${key}.mutex`);
    fs.mkdirSync(path.dirname(mutex), { recursive: true });
    fs.writeFileSync(mutex, body);
    const m = attempt(() => rec.withWorktreeMutex(fx.lock, key, () => 'entered', { timeoutMs: 400 }));
    rows.push(['S13 worktree mutex: without isDead, a mutex held this boot times out (ELEASEMUTEX) and is kept',
        m === 'threw ELEASEMUTEX' && attempt(() => fs.readFileSync(mutex, 'utf8')) === body, String(m)]);
    const leaseKey = 'fedcba9876543210';
    rec.writeJsonAtomic(rec.leasePath(fx.lock, leaseKey), { schema: rec.SCHEMA, runId: 'run-s13-a', token: 1, state: 'running' });
    const w = attempt(() => rec.writeLease(fx.lock, leaseKey, { runId: 'run-s13-b', token: 2, state: 'admitted' }));
    const kept = rec.readLease(fx.lock, leaseKey).value || {};
    rows.push(['S13 lease: without isLive, another run\'s running lease is not provably finished and is kept',
        Boolean(w) && w.written === false && /not provably finished/.test(w.why || '') && kept.runId === 'run-s13-a', JSON.stringify(w)]);
    return rows;
}

/**
 * S13b: a lock naming the caller's pid under another run id is the caller's
 * only when its recorded creation time is the caller's own. With another
 * creation time the pid was reused, so the lock is taken over as dead, never
 * handed over.
 */
function s13Handover(subject) {
    const rows = [];
    const h = sleeper();
    const me = ident.identityOf(h, { snap: freshSnap() });
    if (!me || !me.startUtc) return [['S13 hand-over: the sleeper\'s creation time can be read', false, JSON.stringify(me)]];
    const fx = fixture(1);
    const other = metaLock(fx, { pid: h, startUtc: OLD_START, bootId }, { runId: 'run-s13-old' });
    const t1 = run(subject, fx, ['take', '--pid', String(h), '--run-id', 'run-s13-new']);
    const after1 = readLockFile(fx.lock);
    rows.push(['S13 hand-over: another creation time is not handed over; the lock is taken anew under the new run id',
        t1.code === 0 && Boolean(after1) && after1.text !== other.text && Boolean(after1.meta) && after1.meta.runId === 'run-s13-new',
        `${t1.out}\n${after1 ? after1.text : '(no lock)'}`]);
    const fx2 = fixture(1);
    const own = metaLock(fx2, { pid: h, startUtc: me.startUtc, bootId }, { runId: 'run-s13-old' });
    const t2 = run(subject, fx2, ['take', '--pid', String(h), '--run-id', 'run-s13-new']);
    const after2 = readLockFile(fx2.lock);
    rows.push(['S13 hand-over: its own creation time is handed over; the lock keeps the earlier run',
        t2.code === 0 && Boolean(after2) && after2.text === own.text && /run run-s13-old/.test(t2.out),
        `${t2.out}\n${after2 ? after2.text : '(no lock)'}`]);
    return rows;
}

/**
 * S13c: creation times in any shape compare as seven-digit ISO strings, an
 * unparseable one is null rather than a throw, and the POSIX probes answer
 * for the platform they run on: no boot source on Windows, a host|time boot
 * identity and a listing holding this process elsewhere.
 */
function s13Identity(subject) {
    const id = require(path.join(path.dirname(subject), 'gate-identity.js'));
    const rows = [];
    const rfc = attempt(() => id.normaliseTime('Thu, 01 Jan 2026 00:00:00 GMT'));
    rows.push(['S13 time: a creation time in another shape is normalised to seven fractional digits',
        rfc === '2026-01-01T00:00:00.0000000Z', String(rfc)]);
    const bad = attempt(() => id.normaliseTime('not a time'));
    const nan = attempt(() => id.iso7(NaN));
    rows.push(['S13 time: an unparseable creation time is null, not a throw', bad === null && nan === null, `normaliseTime=${bad} iso7(NaN)=${nan}`]);
    const boot = attempt(() => id.posixBoot());
    const snap = attempt(() => id.posixSnapshot());
    const shown = JSON.stringify({ boot, snap: snap && typeof snap === 'object' ? { ok: snap.ok, why: snap.why, boot: snap.boot } : snap });
    if (WIN) {
        rows.push(['S13 posix: on Windows no POSIX boot source answers, and the POSIX snapshot says so',
            boot === null && Boolean(snap) && snap.ok === false && snap.why === 'no boot time source answered', shown]);
    } else {
        rows.push(['S13 posix: the boot identity is host|time with seven fractional digits, from a named source',
            Boolean(boot) && typeof boot === 'object' && /\|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(boot.id) && typeof boot.source === 'string', shown]);
        rows.push(['S13 posix: the snapshot carries that boot and lists this process',
            Boolean(snap) && snap.ok === true && Boolean(boot) && snap.boot.id === boot.id && snap.procs.has(process.pid), shown]);
    }
    return rows;
}

const s13Defaults = (subject) => [...s13Records(subject), ...s13Handover(subject), ...s13Identity(subject)];

/**
 * S11: the readers the reaper imports see what admission wrote: lane locks with
 * their meta, tickets, and leases; a lease renewal from another run is refused.
 * `subject` is a full-gate-queue.js whose siblings are the libraries to load.
 */
function s11Readers(subject) {
    const dir = path.dirname(subject);
    const q = require(path.join(dir, 'full-gate-queue.js'));
    const rec = require(path.join(dir, 'gate-records.js'));
    const fx = fixture(2);
    const [h, w] = [sleeper(), sleeper()];
    const t = run(subject, fx, ['take', '--pid', String(h), '--run-id', 'run-s11']);
    plantTicket(fx.queue(2), w, 1000, 'product');
    const wt = mkTemp('gown-lease-wt-');
    const key = ident.pathKey(ident.canonicalPath(wt));
    const first = rec.writeLease(fx.lock, key, { runId: 'run-s11', token: 1, worktree: wt, state: 'admitted' });
    const stale = rec.writeLease(fx.lock, key, { runId: 'run-older', token: 0, worktree: wt, state: 'released' }, { expect: { runId: 'run-older', token: 0 } });
    const raw = rec.readLaneLocks(fx.lock);
    const judged = q.readLaneLocks(fx.lock);
    const tix = rec.readTicketRecords(fx.queue(2));
    const laneTix = q.readLaneTickets(fx.lock);
    const lease = q.leaseFor(fx.lock, wt);
    const all = q.readLeases(fx.lock);
    const cli = spawnSync(process.execPath, [path.join(dir, 'gate-records.js'), 'leases', '--json'],
        { env: envFor(fx), encoding: 'utf8', windowsHide: true });
    let listed = null;
    try { listed = JSON.parse(cli.stdout); } catch { /* not JSON */ }
    return [
        ['S11: the take is admitted with run run-s11', t.code === 0, t.out],
        ['S11: gate-records reads both lanes, lane 1 with its meta', raw.length === 2 && Boolean(raw[0].lock) && raw[0].lock.pid === h &&
            Boolean(raw[0].lock.meta) && raw[0].lock.meta.runId === 'run-s11' && raw[1].lock === null, JSON.stringify(raw)],
        ['S11: the queue judges lane 1 alive', judged.length === 2 && judged[0].alive === true && judged[1].lock === null, JSON.stringify(judged)],
        ['S11: the ticket readers both see the planted lane-2 ticket', tix.length === 1 && tix[0].pid === w &&
            laneTix[1].tickets.length === 1 && laneTix[1].tickets[0].pid === w, `${JSON.stringify(tix)}\n${JSON.stringify(laneTix)}`],
        ['S11: a renewal from another run is refused and the lease is unchanged', first.written && !stale.written &&
            lease.state === 'ok' && lease.value.runId === 'run-s11' && lease.key === key, `${JSON.stringify(stale)}\n${JSON.stringify(lease)}`],
        ['S11: readLeases and "gate-records leases --json" list the one lease', all.length === 1 && cli.status === 0 &&
            Array.isArray(listed) && listed.length === 1 && listed[0].value.runId === 'run-s11', `${JSON.stringify(all)}\n${cli.stdout}${cli.stderr}`],
    ];
}

// ---------------------------------------------------------------------------
// Plants.
// ---------------------------------------------------------------------------

function mutant(id, file, edits) {
    const dir = mkTemp(`gown-${id}-`);
    for (const lib of LIBS) fs.copyFileSync(path.join(SCRIPTS, lib), path.join(dir, lib));
    const target = path.join(dir, file);
    let src = fs.readFileSync(target, 'utf8');
    for (const [anchor, replacement] of edits) {
        const count = src.split(anchor).length - 1;
        check(`${id}: the anchor matches exactly once in ${file} (found ${count})`, count === 1, anchor);
        if (count !== 1) return null;
        src = src.replace(anchor, replacement);
    }
    fs.writeFileSync(target, src);
    return path.join(dir, 'full-gate-queue.js');
}

function report(label, rows) {
    for (const [name, ok, detail] of rows) check(name, ok, detail);
    return rows;
}

function expectRed(id, what, rows) {
    const red = rows.filter(([, ok]) => !ok).map(([name]) => name);
    check(`${id} planted (${what}): the scenario goes red (${red.length} of ${rows.length} rows fail)`,
        red.length > 0, red.length ? `failing: ${red.join(' | ')}` : 'every row passed against the defect');
}

async function main() {
    const only = process.env.GATE_OWNERSHIP_ONLY ? process.env.GATE_OWNERSHIP_ONLY.split(',') : null;
    const want = (id) => !only || only.includes(id);
    const msys = await msysSleeper();
    freshSnap();
    const op = await parentWithOrphan();
    const owner = ident.identityOf(op.parent, { snap: freshSnap() });
    await op.release();
    const orphan = { owner: { pid: owner.pid, startUtc: owner.startUtc, bootId } };

    const real = {
        S1: () => s1HarnessRace(SUBJECT), S2: () => s2ConcurrentRelease(SUBJECT), S3: () => s3DerivedClass(SUBJECT),
        S4: () => s4ArrivalSurvives(SUBJECT), S5: () => s5PreBoot(SUBJECT), S6: () => s6ReusedPid(SUBJECT),
        S7: () => s7Msys(SUBJECT, msys), S8: () => s8Descendants(SUBJECT, orphan), S9: () => s9Fence(SUBJECT),
        S10: () => s10Malformed(SUBJECT), S10b: () => s10bSemantic(SUBJECT), S11: () => s11Readers(SUBJECT), S12: () => s12Library(SUBJECT),
        S13: () => s13Defaults(SUBJECT), S14: () => s14DeadParentOrphan(SUBJECT),
    };
    for (const [id, fn] of Object.entries(real)) if (want(id)) report(id, await fn());

    const plants = [
        ['P1', 'admission without the mutex', 'full-gate-queue.js',
            [['    return records.withAdmission(lockPaths[0], fn, { timeoutMs: ADMISSION_TIMEOUT_MS, isDead: (p) => isAlive(p) === false });', '    return fn();']],
            async (s) => [...await s1HarnessRace(s), ...await s2ConcurrentRelease(s)], ['S1', 'S2']],
        ['P2', 'the declared class wins', 'full-gate-queue.js',
            [['const cls = repo.harness ? HARNESS : declared.cls;', 'const cls = declared.cls;']], (s) => s3DerivedClass(s), ['S3']],
        ['P3', 'arrival is the admission time', 'full-gate-queue.js',
            [['function arrivalOf(ticket) {\n    return ticket.arrived;', 'function arrivalOf(ticket) {\n    return new Date().toISOString();']], (s) => s4ArrivalSurvives(s), ['S4']],
        ['P4', 'no boot check in the judgement', 'gate-identity.js',
            [['if (owner.bootId && boot && boot.id && owner.bootId !== boot.id) {', 'if (false) {']], (s) => s5PreBoot(s).slice(0, 3), ['S5']],
        ['P4b', 'no boot check for a ticket identity', 'full-gate-queue.js',
            [["if (owner.bootId && boot && owner.bootId !== boot.id) return { alive: false, why: 'it was written in an earlier boot' };", '']], (s) => s5PreBoot(s).slice(3), ['S5']],
        ['P5', 'a record matches by pid alone', 'gate-identity.js',
            [['return Boolean(p && p.startUtc === rec.startUtc);', 'return Boolean(p);']], (s) => s6ReusedPid(s), ['S6']],
        ['P5b', 'a reused pid\'s children count as the owner\'s', 'gate-identity.js',
            [['            if (reusedAt && c.startUtc >= reusedAt) continue;\n', '']], (s) => s6ReusedPid(s), ['S6']],
        ['P6', 'the MSYS pid is never checked', 'gate-identity.js',
            [['else if (msys.byMsys.has(owner.msysPid) && (!owner.msysWinpid || msys.byMsys.get(owner.msysPid) === owner.msysWinpid)) {', 'else if (false) {']],
            (s) => s7Msys(s, msys), ['S7']],
        ['P7', 'execution processes are ignored', 'gate-identity.js',
            [['for (const r of recorded.slice(1)) {', 'for (const r of []) {'], ['const live = liveDescendants(recorded, snap);', 'const live = [];']],
            (s) => s8Descendants(s, orphan), ['S8']],
        ['P8', 'release ignores the token', 'full-gate-queue.js',
            [['if (fence) return { released: false, fenced: true, why: fence };', 'if (false) return { released: false, fenced: true, why: fence };']], (s) => s9Fence(s), ['S9']],
        ['P9', 'a malformed meta line reads as a legacy lock', 'full-gate-queue.js',
            [['    if (held.malformed) return null;\n', '']], (s) => s10Malformed(s), ['S10']],
        ['P10o', 'a lane-lock reader drops the meta line', 'gate-records.js',
            [["what: (lines[1] || '').trim(), cls, ...parseMeta(lines) };", "what: (lines[1] || '').trim(), cls };"]], (s) => s11Readers(s), ['S11']],
        ['P10l', 'a lease renewal ignores the run and token', 'gate-records.js',
            [['if (cur.value.runId !== expect.runId || cur.value.token !== expect.token) {', 'if (false) {']], (s) => s11Readers(s), ['S11']],
        ['P11o', '--repo vouches for the caller', 'full-gate-queue.js',
            [['    if (args.repo && !repo.harness) {', '    if (false) {']], (s) => s3DerivedClass(s).slice(-1), ['S3']],
        ['P12o', 'a ticket-identity owner skips its journal', 'full-gate-queue.js',
            [['        if (!recordsExecution) return { alive: a,', '        return { alive: a,']], async (s) => (await s8Descendants(s, orphan)).slice(-2), ['S8']],
        ['P13o', 'a release fenced by run id alone is not fenced', 'full-gate-queue.js',
            [['    const runOff = Boolean(runId) && Boolean(held.meta.runId) && held.meta.runId !== runId;', '    const runOff = false;']], (s) => s9Fence(s), ['S9']],
        ['P14o', 'a meta line that parses is trusted', 'gate-records.js',
            [['        const fault = metaFault(m);', '        const fault = null;']], (s) => s10bSemantic(s), ['S10b']],
        ['P15o', 'an unreadable creation time reads as a reused pid', 'gate-identity.js',
            [['        if (recordUnreadable(owner, snap)) unknown = `pid ${owner.pid} is running, but its creation time could not be read`;\n', '']],
            (s) => s12Library(s).slice(0, 1), ['S12']],
        ['P16o', 'the fencing counter mints past the safe integers', 'gate-records.js',
            [['    if (!Number.isSafeInteger(next)) {', '    if (false) {']], (s) => s12Library(s).slice(1, 2), ['S12']],
        ['P17o', 'a mutex from an earlier boot is held by its reused pid', 'gate-records.js',
            [['        return Number.isFinite(bootMs) && fs.statSync(file).mtimeMs < bootMs - 60000;', '        return false;']], (s) => s12Library(s).slice(2), ['S12']],
        ['P18o', 'the admission mutex\'s default calls every holder dead', 'gate-records.js',
            [['function withAdmission(base, fn, { timeoutMs = 30000, isDead = () => false } = {}) {', 'function withAdmission(base, fn, { timeoutMs = 30000, isDead = () => true } = {}) {']],
            (s) => s13Records(s).filter(([n]) => n.startsWith('S13 admission')), ['S13']],
        ['P19o', 'the worktree mutex\'s default calls every holder dead', 'gate-records.js',
            [['function withWorktreeMutex(base, key, fn, { timeoutMs = 30000, isDead = () => false } = {}) {', 'function withWorktreeMutex(base, key, fn, { timeoutMs = 30000, isDead = () => true } = {}) {']],
            (s) => s13Records(s).filter(([n]) => n.startsWith('S13 worktree mutex')), ['S13']],
        ['P20o', 'a lease\'s default calls every other run finished', 'gate-records.js',
            [['isLive = () => null } = {}) {', 'isLive = () => false } = {}) {']],
            (s) => s13Records(s).filter(([n]) => n.startsWith('S13 lease')), ['S13']],
        ['P21o', 'any lock naming the pid belongs to the caller', 'full-gate-queue.js',
            [['    return !me || !me.startUtc || me.startUtc === start;', '    return true;']], (s) => s13Handover(s), ['S13']],
        ['P22o', 'iso7 formats an unparseable time', 'gate-identity.js',
            [['    if (!Number.isFinite(ms)) return null;\n', '']], (s) => s13Identity(s).filter(([n]) => n.startsWith('S13 time')), ['S13']],
        ['P23o', 'the POSIX probes answer with a fixed boot', 'gate-identity.js',
            [["source: '/proc/stat btime' };", "source: '/proc/stat btime', id: 'planted' };"],
                ["source: 'sysctl kern.boottime' };", "source: 'sysctl kern.boottime', id: 'planted' };"],
                ['    return null;\n}\n\nfunction posixSnapshot() {', "    return { id: 'planted', source: 'planted' };\n}\n\nfunction posixSnapshot() {"]],
            (s) => s13Identity(s).filter(([n]) => n.startsWith('S13 posix')), ['S13']],
        ['P24o', 'a parent seen gone still adopts later children', 'gate-identity.js',
            [['            if (Number.isFinite(goneMs) && Date.parse(c.startUtc) >= goneMs) continue;\n', '']],
            (s) => s14DeadParentOrphan(s).filter(([n]) => n.includes('not the chain')), ['S14']],
        ['P25o', 'the journal never records a process gone', 'gate-records.js',
            [['            d.goneBy = later ? now.startUtc : nowIso;\n', '']],
            (s) => s14DeadParentOrphan(s).filter(([n]) => n.includes('is stamped') || n.includes('not the chain')), ['S14']],
    ];
    for (const [id, what, file, edits, scenario, covers] of plants) {
        if (!want(id) && !covers.some(want)) continue;
        if (id === 'P6' && !msys.pid) { check(`${id}: an MSYS pid to plant against`, !WIN, msys.why); continue; }
        const m = mutant(id, file, edits);
        if (!m) continue;
        expectRed(id, what, await scenario(m));
    }
}

main()
    .catch((e) => { failed++; console.log(`FAIL  the suite threw: ${e.stack || e.message}`); })
    .finally(() => {
        killAll();
        for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a child may hold it */ } }
        console.log(`\n${passed} passed, ${failed} failed`);
        if (failed) { console.log(`${failed} gate-ownership check(s) failed`); process.exitCode = 1; } else console.log('all gate-ownership checks passed');
    });
