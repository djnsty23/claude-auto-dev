#!/usr/bin/env node
/**
 * test-full-gate-queue.js - drives plugins/autodev-core/scripts/full-gate-queue.js
 * as a SUBPROCESS.
 *
 * The property that matters is ORDER across processes: a newcomer that polls
 * first after a release must still lose to a waiter that arrived before it.
 * That is a property of runs, so every case starts the real script against a
 * lock path in a temp directory, with real long-lived processes standing in
 * for holders and waiters. The machine's real lock is never touched: every
 * spawn sets AUTODEV_GATE_LOCK_PATH, which matters most when this suite runs
 * inside a full gate that holds the real lock at the time.
 *
 * PLANTED DEFECTS. A green run of these scenarios says nothing until the same
 * scenarios have been seen to go red against the defect they exist to catch.
 * So the suite copies the subject, plants each defect by an exact anchor (the
 * anchor must match exactly once, or the plant itself is a failure), runs the
 * scenario against the copy, and requires it to FAIL:
 *   M1  any ticket may take a free lock, not only the oldest   -> newcomer jumps
 *   M2  a release hands the lock to the NEWEST ticket          -> newcomer jumps
 *   M3  liveness ignores ps, so an MSYS pid reads as dead      -> a live waiter is dropped
 *   M4  a waiter tries only lane 1                             -> a free lane 2 sits idle
 *   M5  a waiter that took a lane stays queued in the others   -> it blocks a lane it never uses
 *   M6  leave removes no ticket                                -> a stopped waiter keeps its place
 *   M7  serving order ignores the class                        -> an older harness ticket beats a product
 *   M8  no harness cap                                         -> harness gates take the last free lane
 *   M9  the cap is lanes - 1 even on one lane                  -> a lone harness gate never runs
 *   M10 no hand-over to a classless ticket at the front        -> an older version and a harness gate wait on each other
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'full-gate-queue.js');
const WIN = process.platform === 'win32';
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
// Real processes as holders and waiters.
// ---------------------------------------------------------------------------

const sleepers = [];
const trees = []; // processes with children of their own, killed as a tree

function sleeper() {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
    sleepers.push(c);
    return c.pid;
}

/** A pid that existed and has exited. */
function deadPid() {
    const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true });
    return Number(r.stdout.trim());
}

function killAll() {
    // A sleeper has no children, so killing it directly is enough and costs
    // nothing; taskkill /T runs only for the bash tree, at about a second each.
    for (const c of sleepers) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const c of trees) {
        if (WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(c.pid)], { stdio: 'ignore', windowsHide: true });
        else { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    }
}

// ---------------------------------------------------------------------------
// Fixtures and invocation.
// ---------------------------------------------------------------------------

/**
 * The checkout every subprocess runs in. The class now comes from the caller's
 * repository, and this suite's own tree is the harness, so the cases run from a
 * plain product repository: one commit, no harness marker.
 */
let productRepo = null;
function repoDir() {
    if (productRepo) return productRepo;
    productRepo = path.join(mkTemp('fgq-repo-'), 'shop');
    fs.mkdirSync(productRepo, { recursive: true });
    fs.writeFileSync(path.join(productRepo, 'package.json'), JSON.stringify({ name: 'shop', private: true }));
    const g = (args) => spawnSync('git', ['-C', productRepo, ...args], { encoding: 'utf8', windowsHide: true });
    g(['init', '-q']);
    g(['add', 'package.json']);
    g(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture']);
    return productRepo;
}

/** One boot-identity cache for every case, so the boot probe runs once per suite, not once per fixture. */
let bootCache = null;
function bootCacheFile() {
    if (!bootCache) bootCache = path.join(mkTemp('fgq-boot-'), 'boot.json');
    return bootCache;
}

function fixture() {
    const dir = path.join(mkTemp('fgq-'), 'locks');
    fs.mkdirSync(dir, { recursive: true });
    return { dir, lock: path.join(dir, 'full-gate.lock'), queue: path.join(dir, 'full-gate.queue') };
}

/** The suite's environment. A class or lane count set where the suite runs never leaks into a case. */
function envFor(fx, extra = {}) {
    const env = Object.assign({}, process.env, {
        AUTODEV_GATE_LOCK_PATH: fx.lock,
        AUTODEV_GATE_LOCK_POLL_MS: '100',
        AUTODEV_GATE_LOCK_REPORT_MS: '100000',
        AUTODEV_GATE_QUEUE_STALE_MS: '600000',
        AUTODEV_GATE_BOOT_CACHE: bootCacheFile(),
    }, extra);
    if (!('AUTODEV_GATE_CLASS' in extra)) delete env.AUTODEV_GATE_CLASS;
    if (!('AUTODEV_GATE_LANES' in extra)) delete env.AUTODEV_GATE_LANES;
    return env;
}

function run(subject, fx, args, extraEnv) {
    const r = spawnSync(process.execPath, [subject, ...args],
        { cwd: repoDir(), env: envFor(fx, extraEnv), encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, error: r.error };
}

const take = (s, fx, pid, more = [], extraEnv) => run(s, fx, ['take', '--pid', String(pid), '--what', `test waiter ${pid}`, ...more], extraEnv);
const release = (s, fx, pid) => run(s, fx, ['release', '--pid', String(pid)]);
const lockPid = (fx) => { try { return Number(fs.readFileSync(fx.lock, 'utf8').split(/\r?\n/)[0]); } catch { return null; } };
const tickets = (fx) => (fs.existsSync(fx.queue) ? fs.readdirSync(fx.queue).filter((f) => f.endsWith('.ticket')).sort() : []);
const ticketPids = (fx) => tickets(fx).map((f) => Number(f.split('-')[1].replace('.ticket', '')));
const asides = (fx, kind) => fs.readdirSync(fx.dir).filter((f) => f.startsWith(`full-gate.lock.${kind}-`));
/** A file's lines, or [] when it does not exist. */
const linesOf = (file) => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; } };
const pidIn = (file) => Number(linesOf(file)[0]) || null;
/** Line n (1-based) of `pid`'s ticket in `queueDir`, or null when it has none. */
function ticketLine(queueDir, pid, n) {
    const name = (fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : []).find((f) => f.endsWith(`-${String(pid).padStart(10, '0')}.ticket`));
    return name ? (linesOf(path.join(queueDir, name))[n - 1] || '') : null;
}

/**
 * A ticket written by hand, `agoMs` in the past, as a queued waiter would have
 * left it. With `cls` it carries a class line as this version writes one.
 * Without one, it is a ticket from a version that had no classes.
 */
function plantTicket(fx, pid, agoMs, heartbeatAgoMs = 0, { cls = null, queueDir = fx.queue } = {}) {
    fs.mkdirSync(queueDir, { recursive: true });
    const d = new Date(Date.now() - agoMs);
    const name = `${d.toISOString().replace(/[-:.]/g, '')}-${String(pid).padStart(10, '0')}.ticket`;
    const file = path.join(queueDir, name);
    fs.writeFileSync(file, `${pid}\nplanted ticket ${pid}\n${d.toISOString()}\n${cls ? `class ${cls}\n` : ''}`);
    if (heartbeatAgoMs) { const h = new Date(Date.now() - heartbeatAgoMs); fs.utimesSync(file, h, h); }
    return file;
}

/** The same planted ticket in each of the first `lanes` lanes' queues, as a waiter queues in every lane. */
function plantEverywhere(fx, pid, agoMs, cls, lanes) {
    for (let k = 1; k <= lanes; k++) {
        plantTicket(fx, pid, agoMs, 0, { cls, queueDir: k === 1 ? fx.queue : path.join(fx.dir, `full-gate-${k}.queue`) });
    }
}

// ---------------------------------------------------------------------------
// Scenarios. Each returns [name, ok, detail] rows so it can be run against the
// real subject (every row must pass) and against a mutant (some row must fail).
// ---------------------------------------------------------------------------

/** The 2026-09-26 incident: a plain rename release, and the newcomer polls first. */
function scenarioNewcomerPollsFirst(subject) {
    const fx = fixture();
    const [h, a, b] = [sleeper(), sleeper(), sleeper()];
    fs.writeFileSync(fx.lock, `${h}\nhand-written holder\n`);
    const rows = [];
    const ra = take(subject, fx, a);
    rows.push(['A arrives while the lock is held: exit 3, place 1 of 1', ra.code === 3 && /place 1 of 1/.test(ra.out), ra.out]);
    const rb = take(subject, fx, b);
    rows.push(['B arrives after A: exit 3, place 2 of 2', rb.code === 3 && /place 2 of 2/.test(rb.out), rb.out]);
    fs.renameSync(fx.lock, `${fx.lock}.released-0000`);
    const rb2 = take(subject, fx, b);
    rows.push(['the holder releases by plain rename and B polls FIRST: B is still queued (exit 3)', rb2.code === 3, rb2.out]);
    rows.push(['B did not create the free lock', !fs.existsSync(fx.lock), fs.existsSync(fx.lock) ? fs.readFileSync(fx.lock, 'utf8') : '']);
    const ra2 = take(subject, fx, a);
    rows.push(['A polls second and takes the lock (exit 0, line 1 is A)', ra2.code === 0 && lockPid(fx) === a, ra2.out]);
    rows.push(['A\'s ticket is gone and B\'s remains', JSON.stringify(ticketPids(fx)) === JSON.stringify([b]), tickets(fx).join(', ')]);
    return rows;
}

/** Queue-aware release: the lock goes to the OLDEST ticket and never disappears. */
function scenarioHandoff(subject) {
    const fx = fixture();
    const [h, a, b] = [sleeper(), sleeper(), sleeper()];
    const rows = [];
    const rh = take(subject, fx, h);
    rows.push(['H takes a free lock with an empty queue (exit 0, line 1 is H)', rh.code === 0 && lockPid(fx) === h, rh.out]);
    rows.push(['H holds no ticket once it holds the lock', tickets(fx).length === 0, tickets(fx).join(', ')]);
    take(subject, fx, a);
    take(subject, fx, b);
    const rel = release(subject, fx, h);
    rows.push(['H releases: exit 0, the lock now names A, the oldest ticket', rel.code === 0 && lockPid(fx) === a, `${rel.out}\nlock: ${lockPid(fx)}`]);
    const rec = asides(fx, 'released');
    rows.push(['the release left a .released-HHMM record naming H',
        rec.length === 1 && fs.readFileSync(path.join(fx.dir, rec[0]), 'utf8').startsWith(`${h}\n`), rec.join(', ')]);
    const rb = take(subject, fx, b);
    rows.push(['B polls right after the handoff: still queued (exit 3)', rb.code === 3 && lockPid(fx) === a, rb.out]);
    const ra = take(subject, fx, a);
    rows.push(['A learns it holds the lock (exit 0)', ra.code === 0, ra.out]);
    const rel2 = release(subject, fx, a);
    rows.push(['A releases: the lock is handed to B', rel2.code === 0 && lockPid(fx) === b, rel2.out]);
    const rel3 = release(subject, fx, b);
    rows.push(['B releases with nobody queued: the lock is renamed aside, not handed over',
        rel3.code === 0 && !fs.existsSync(fx.lock) && asides(fx, 'released').length === 3 && /nobody was queued/.test(rel3.out), rel3.out]);
    return rows;
}

/** Two lanes: a waiter takes whichever is free, and one that took a lane leaves the other queue. */
function scenarioLanes(subject) {
    const fx = fixture();
    const lane2 = path.join(fx.dir, 'full-gate-2.lock');
    const queue2 = path.join(fx.dir, 'full-gate-2.queue');
    const pidOf = (f) => { try { return Number(fs.readFileSync(f, 'utf8').split(/\r?\n/)[0]); } catch { return null; } };
    const ticketsIn = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.ticket')) : []);
    const [h, w, x] = [sleeper(), sleeper(), sleeper()];
    const rows = [];
    const set = run(subject, fx, ['lanes', '2']);
    rows.push(['"lanes 2" writes full-gate.lanes beside the lock', set.code === 0 &&
        fs.readFileSync(path.join(fx.dir, 'full-gate.lanes'), 'utf8').trim() === '2', set.out]);
    fs.writeFileSync(fx.lock, `${h}\nlane 1 holder\n`);
    const rw = take(subject, fx, w);
    rows.push(['lane 1 held, lane 2 free: W takes lane 2 (exit 0, full-gate-2.lock names W)',
        rw.code === 0 && pidOf(lane2) === w && lockPid(fx) === h, rw.out]);
    rows.push(['W holds no ticket in lane 1 once it holds lane 2', ticketsIn(fx.queue).length === 0, ticketsIn(fx.queue).join(', ')]);
    const rx = take(subject, fx, x);
    rows.push(['both lanes held: X is queued (exit 3) with a ticket in each lane',
        rx.code === 3 && ticketsIn(fx.queue).length === 1 && ticketsIn(queue2).length === 1, rx.out]);
    const st = run(subject, fx, ['status']);
    rows.push(['status names the lane count, its source and both lanes',
        /lanes: {2}2 \(from full-gate\.lanes\)/.test(st.out) && st.out.includes(`lane 1: holder: pid ${h}`) && st.out.includes(`lane 2: holder: pid ${w}`), st.out]);
    const rel = release(subject, fx, w);
    rows.push(['W releases: lane 2 is handed to X, lane 1 is untouched',
        rel.code === 0 && pidOf(lane2) === x && lockPid(fx) === h && /lane 2 of 2/.test(rel.out), rel.out]);
    const rx2 = take(subject, fx, x);
    rows.push(['X learns it holds lane 2 (exit 0) and leaves the lane 1 queue',
        rx2.code === 0 && ticketsIn(fx.queue).length === 0, `${rx2.out}\nlane 1 tickets: ${ticketsIn(fx.queue).join(', ')}`]);
    return rows;
}

/** A waiter whose pid is an MSYS (Git Bash) pid: tasklist cannot see it, ps can. */
function scenarioMsysWaiter(subject, msys) {
    const fx = fixture();
    const h = sleeper();
    fs.writeFileSync(fx.lock, `${h}\nhand-written holder\n`);
    plantTicket(fx, msys, 60000);
    fs.writeFileSync(fx.lock, `${h}\nhand-written holder\n`);
    const rows = [];
    const rel = run(subject, fx, ['release', '--pid', String(h)]);
    rows.push([`H releases: the lock is handed to the live MSYS pid ${msys}, not dropped`,
        rel.code === 0 && lockPid(fx) === msys, `${rel.out}\nlock: ${lockPid(fx)}`]);
    return rows;
}

/**
 * leave: a waiter stopped from outside keeps its tickets while its shell lives.
 * Two lanes, so the tickets to remove sit in two queues, beside another live
 * pid's ticket that must stay and a lock that must not move.
 */
function scenarioLeave(subject) {
    const fx = fixture();
    const queue2 = path.join(fx.dir, 'full-gate-2.queue');
    const [h, x, y] = [sleeper(), sleeper(), sleeper()];
    const pidsIn = (d) => (fs.existsSync(d)
        ? fs.readdirSync(d).filter((f) => f.endsWith('.ticket')).sort().map((f) => Number(f.split('-')[1].replace('.ticket', '')))
        : []);
    const lane2Ticket = (pid, agoMs) => {
        fs.mkdirSync(queue2, { recursive: true });
        const d = new Date(Date.now() - agoMs);
        const name = `${d.toISOString().replace(/[-:.]/g, '')}-${String(pid).padStart(10, '0')}.ticket`;
        fs.writeFileSync(path.join(queue2, name), `${pid}\nplanted lane 2 ticket ${pid}\n${d.toISOString()}\n`);
    };
    const holderText = `${h}\nlane 1 holder\n`;
    fs.writeFileSync(fx.lock, holderText);
    plantTicket(fx, x, 90000);
    plantTicket(fx, y, 60000);
    lane2Ticket(x, 90000);
    const leave = (pid) => run(subject, fx, ['leave', '--pid', String(pid), '--lanes', '2']);
    const rows = [];
    rows.push(['setup: X has a ticket in lane 1 and in lane 2, Y has one in lane 1',
        JSON.stringify(pidsIn(fx.queue)) === JSON.stringify([x, y]) && JSON.stringify(pidsIn(queue2)) === JSON.stringify([x]),
        `lane 1: ${pidsIn(fx.queue).join()} lane 2: ${pidsIn(queue2).join()}`]);
    const first = leave(x);
    rows.push(['leave --pid X exits 0 and reports "removed 2 ticket(s)"', first.code === 0 && /removed 2 ticket\(s\)/.test(first.out), first.out]);
    rows.push(['X has no ticket left in lane 1 or lane 2', !pidsIn(fx.queue).includes(x) && pidsIn(queue2).length === 0,
        `lane 1: ${pidsIn(fx.queue).join()} lane 2: ${pidsIn(queue2).join()}`]);
    rows.push(['Y\'s ticket in lane 1 remains', JSON.stringify(pidsIn(fx.queue)) === JSON.stringify([y]), pidsIn(fx.queue).join()]);
    rows.push(['the lane 1 lock held by H is untouched',
        fs.existsSync(fx.lock) && fs.readFileSync(fx.lock, 'utf8') === holderText && asides(fx, 'released').length === 0 && asides(fx, 'stale').length === 0,
        fs.existsSync(fx.lock) ? fs.readFileSync(fx.lock, 'utf8') : 'no lock']);
    const again = leave(x);
    rows.push(['a second leave --pid X exits 0 and says "nothing to remove"', again.code === 0 && /nothing to remove/.test(again.out), again.out]);
    const d = deadPid();
    plantTicket(fx, d, 45000);
    const dead = leave(d);
    rows.push(['a dead pid\'s planted ticket is removed with exit 0, not refused as "not running"',
        dead.code === 0 && /removed 1 ticket\(s\)/.test(dead.out) && !/not running/.test(dead.out) && !pidsIn(fx.queue).includes(d),
        `${dead.out}\nlane 1: ${pidsIn(fx.queue).join()}`]);
    const holder = leave(h);
    rows.push(['the holder H running leave --pid H exits 0, keeps the lock, and is told to run release',
        holder.code === 0 && lockPid(fx) === h && /still holds/.test(holder.out) && /run release/.test(holder.out) &&
        fs.readFileSync(fx.lock, 'utf8') === holderText, `${holder.out}\nlock: ${lockPid(fx)}`]);
    rows.push(['Y\'s ticket still remains after every leave', JSON.stringify(pidsIn(fx.queue)) === JSON.stringify([y]), pidsIn(fx.queue).join()]);
    return rows;
}

/** One lane: a product ticket goes before an older harness ticket, at a release and after it. */
function scenarioClassOrder(subject) {
    const fx = fixture();
    const [h, a, p] = [sleeper(), sleeper(), sleeper()];
    fs.writeFileSync(fx.lock, `${h}\nhand-written holder\n`);
    plantTicket(fx, a, 90000, 0, { cls: 'harness' });
    const rows = [];
    const rp = take(subject, fx, p);
    rows.push(['product P arrives after harness A: queued (exit 3) at place 1 of 2, ahead of A', rp.code === 3 && /place 1 of 2/.test(rp.out), rp.out]);
    const ra = take(subject, fx, a);
    rows.push(['harness A, the older ticket, is at place 2 of 2', ra.code === 3 && /place 2 of 2/.test(ra.out), ra.out]);
    const rel = release(subject, fx, h);
    rows.push(['H releases: the lock is handed to product P, not to the older harness A',
        rel.code === 0 && lockPid(fx) === p, `${rel.out}\nlock: ${lockPid(fx)}`]);
    rows.push(['the lock handed to P says "class product" on line 3', linesOf(fx.lock)[2] === 'class product', linesOf(fx.lock).join(' | ')]);
    take(subject, fx, p);
    const rel2 = release(subject, fx, p);
    rows.push(['P releases with only harness A waiting on a one-lane machine: the lock is handed to A',
        rel2.code === 0 && lockPid(fx) === a, `${rel2.out}\nlock: ${lockPid(fx)}`]);
    rows.push(['the lock handed to A says "class harness" on line 3', linesOf(fx.lock)[2] === 'class harness', linesOf(fx.lock).join(' | ')]);
    return rows;
}

/** One lane, free: a harness ticket that arrived first still waits while a product ticket waits. */
function scenarioHarnessWaits(subject) {
    const fx = fixture();
    const [a, p] = [sleeper(), sleeper()];
    plantTicket(fx, a, 90000, 0, { cls: 'harness' });
    plantTicket(fx, p, 30000, 0, { cls: 'product' });
    const rows = [];
    const ra = take(subject, fx, a);
    rows.push(['the lock is free and harness A, the older ticket, polls first: A stays queued (exit 3) at place 2 of 2',
        ra.code === 3 && /place 2 of 2/.test(ra.out), ra.out]);
    rows.push(['A did not create the free lock', !fs.existsSync(fx.lock), linesOf(fx.lock).join(' | ')]);
    const rp = take(subject, fx, p);
    rows.push(['product P, which arrived later, takes the free lock (exit 0)', rp.code === 0 && lockPid(fx) === p, rp.out]);
    return rows;
}

/**
 * A ticket with no class line, as every version before classes wrote it, is a
 * product. That version takes a free lock only as the OLDEST ticket, so the
 * harness ticket ahead of it in arrival hands the free lane over.
 */
function scenarioOlderVersion(subject) {
    const fx = fixture();
    const [a, o] = [sleeper(), sleeper()];
    plantTicket(fx, a, 90000, 0, { cls: 'harness' });
    plantTicket(fx, o, 30000);
    const rows = [];
    let parsed = null;
    try { parsed = JSON.parse(run(subject, fx, ['status', '--json']).out); } catch { /* reported below */ }
    const q = parsed && parsed.lanes ? parsed.lanes[0].queue : [];
    rows.push(['status --json reads the classless ticket O as a product, served before the older harness A',
        q.length === 2 && q[0].pid === o && q[0].class === 'product' && q[1].pid === a && q[1].class === 'harness', JSON.stringify(q)]);
    const ra = take(subject, fx, a);
    rows.push(['harness A polls the free lock: A stays queued (exit 3)', ra.code === 3, ra.out]);
    rows.push(['A handed the lock to O, as a release would, and said so', lockPid(fx) === o && new RegExp(`handed the free lock to pid ${o}`).test(ra.out),
        `${ra.out}\nlock: ${linesOf(fx.lock).join(' | ')}`]);
    rows.push(['O\'s ticket is consumed and A\'s remains', JSON.stringify(ticketPids(fx)) === JSON.stringify([a]), tickets(fx).join(', ')]);
    const ro = take(subject, fx, o);
    rows.push(['O takes the handed-over lock (exit 0)', ro.code === 0 && lockPid(fx) === o, ro.out]);
    return rows;
}

/** Two lanes, then three: harness gates hold at most lanes - 1, so one lane stays open to products. */
function scenarioReserve(subject) {
    const rows = [];
    {
        const fx = fixture();
        fs.writeFileSync(path.join(fx.dir, 'full-gate.lanes'), '2\n');
        const lane2 = path.join(fx.dir, 'full-gate-2.lock');
        const queue2 = path.join(fx.dir, 'full-gate-2.queue');
        const [h, a, p, b, q] = [sleeper(), sleeper(), sleeper(), sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nharness gate on lane 1\nclass harness\n`);
        plantEverywhere(fx, a, 90000, 'harness', 2);
        const ra = take(subject, fx, a);
        rows.push(['2 lanes, harness H holds lane 1: harness A is refused the free lane 2 (exit 3, no lane 2 lock)',
            ra.code === 3 && !fs.existsSync(lane2), `${ra.out}\nlane 2: ${linesOf(lane2).join(' | ')}`]);
        rows.push(['A is told the lane is kept for product gates',
            /kept for product gates: harness gates already hold 1 of 2 lane\(s\)/.test(ra.out), ra.out]);
        const rp = take(subject, fx, p);
        rows.push(['product P, arriving later, takes lane 2 at once (exit 0)', rp.code === 0 && pidIn(lane2) === p, rp.out]);
        const relH = release(subject, fx, h);
        rows.push(['harness H releases lane 1 while product P holds lane 2: lane 1 is handed to harness A',
            relH.code === 0 && lockPid(fx) === a, `${relH.out}\nlane 1: ${lockPid(fx)}`]);
        take(subject, fx, a);
        plantEverywhere(fx, b, 10000, 'harness', 2);
        const relP = release(subject, fx, p);
        rows.push(['product P releases lane 2 while harness A holds lane 1: not handed to harness B, renamed aside',
            relP.code === 0 && !fs.existsSync(lane2) && new RegExp(`not handed to harness pid ${b}`).test(relP.out), relP.out]);
        rows.push(['B stays queued for lane 2', ticketLine(queue2, b, 1) === String(b), fs.existsSync(queue2) ? fs.readdirSync(queue2).join(', ') : '']);
        const rq = take(subject, fx, q);
        rows.push(['product Q takes lane 2 ahead of the older harness B (exit 0)', rq.code === 0 && pidIn(lane2) === q, rq.out]);
    }
    {
        const fx = fixture();
        fs.writeFileSync(path.join(fx.dir, 'full-gate.lanes'), '3\n');
        const lane2 = path.join(fx.dir, 'full-gate-2.lock');
        const lane3 = path.join(fx.dir, 'full-gate-3.lock');
        const [h, a, b] = [sleeper(), sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nharness gate on lane 1\nclass harness\n`);
        plantEverywhere(fx, a, 90000, 'harness', 3);
        plantEverywhere(fx, b, 60000, 'harness', 3);
        const ra = take(subject, fx, a);
        rows.push(['3 lanes, harness on lane 1: a second harness gate A takes lane 2 (exit 0)', ra.code === 0 && pidIn(lane2) === a, ra.out]);
        const rb = take(subject, fx, b);
        rows.push(['harness on 2 of 3 lanes: a third harness gate B is refused the free lane 3 (exit 3)',
            rb.code === 3 && !fs.existsSync(lane3) && /harness gates already hold 2 of 3 lane\(s\)/.test(rb.out), rb.out]);
    }
    return rows;
}

/** One lane: the cap is that lane, so a harness gate with nobody else waiting takes it. */
function scenarioOneLane(subject) {
    const fx = fixture();
    const a = sleeper();
    plantTicket(fx, a, 30000, 0, { cls: 'harness' });
    const ra = take(subject, fx, a);
    return [['one lane, free, a lone harness ticket: it takes the lock (exit 0) and line 3 says "class harness"',
        ra.code === 0 && lockPid(fx) === a && linesOf(fx.lock)[2] === 'class harness', `${ra.out}\nlock: ${linesOf(fx.lock).join(' | ')}`]];
}

function report(label, rows) {
    for (const [name, ok, detail] of rows) check(`${label}: ${name}`, ok, detail);
}

/** Copies the subject with `anchor` replaced; null (and a FAIL) unless it matches exactly once. */
function mutant(id, anchor, replacement) {
    const src = fs.readFileSync(SUBJECT, 'utf8');
    const count = src.split(anchor).length - 1;
    check(`${id}: the anchor matches exactly once in the subject (found ${count})`, count === 1, anchor);
    if (count !== 1) return null;
    const dir = mkTemp(`fgq-${id}-`);
    const file = path.join(dir, 'full-gate-queue.js');
    fs.writeFileSync(file, src.replace(anchor, replacement));
    // The libraries it requires, copied beside it unchanged.
    for (const lib of ['gate-identity.js', 'gate-records.js']) fs.copyFileSync(path.join(path.dirname(SUBJECT), lib), path.join(dir, lib));
    return file;
}

function expectRed(id, what, rows) {
    const red = rows.filter(([, ok]) => !ok).map(([name]) => name);
    check(`${id} planted (${what}): the scenario goes red (${red.length} of ${rows.length} rows fail)`,
        red.length > 0, red.length ? `failing: ${red.join(' | ')}` : 'every row passed against the defect');
}

// ---------------------------------------------------------------------------
// The MSYS pid, when this machine has Git Bash.
// ---------------------------------------------------------------------------

function gitUsrBin(exe) {
    const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    if (ex.error || ex.status !== 0) return null;
    const p = path.resolve(ex.stdout.trim(), '..', '..', '..', 'usr', 'bin', exe);
    return fs.existsSync(p) ? p : null;
}

/** Starts a Git Bash that prints its own MSYS pid and sleeps. Resolves the pid, or null with a reason. */
async function msysPid() {
    if (!WIN) return { pid: null, why: 'not Windows, so there is no second pid table' };
    const bash = gitUsrBin('bash.exe');
    const ps = gitUsrBin('ps.exe');
    if (!bash || !ps) return { pid: null, why: 'Git Bash (usr/bin/bash.exe and ps.exe) not found' };
    // The pid goes to a FILE, not a pipe: a pipe inherited by the sleeping
    // grandchild keeps this suite alive until the sleep ends, whatever is killed.
    // One-second sleeps, so an orphan left by the tree kill is gone in a second.
    const pidFile = path.join(mkTemp('fgq-msys-'), 'pid');
    const c = spawn(bash, ['-c', `echo $$ > '${pidFile.replace(/\\/g, '/')}'; for i in $(seq 1 300); do sleep 1; done`],
        { stdio: 'ignore', windowsHide: true });
    trees.push(c);
    let text = '';
    for (let i = 0; i < 200 && !/\n/.test(text); i++) {
        await sleep(100);
        try { text = fs.readFileSync(pidFile, 'utf8'); } catch { /* not written yet */ }
    }
    const pid = Number(text.trim());
    if (!pid) return { pid: null, why: 'bash did not write its pid within 20 s' };
    const t = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    if (new RegExp(`^"[^"]*","${pid}"`, 'm').test(t.stdout || '')) return { pid: null, why: `MSYS pid ${pid} is also a live Windows pid, so it proves nothing` };
    const p = spawnSync(ps, ['-p', String(pid)], { encoding: 'utf8', windowsHide: true });
    if (!(p.stdout || '').split(/\r?\n/).some((l) => l.trim().split(/\s+/)[0] === String(pid))) return { pid: null, why: `ps -p ${pid} did not list it` };
    return { pid, why: null };
}

// ---------------------------------------------------------------------------

async function main() {
    // --help and argument errors.
    {
        const fx = fixture();
        const h = run(SUBJECT, fx, ['--help']);
        check('--help exits 0 and names all five commands',
            h.code === 0 && ['take', 'wait', 'release', 'leave', 'status'].every((c) => h.out.includes(c)), h.out);
        check('--help touches nothing', fs.readdirSync(fx.dir).length === 0, fs.readdirSync(fx.dir).join(', '));
        const bad = run(SUBJECT, fx, ['grab']);
        check('an unknown command exits 1 and points at --help', bad.code === 1 && /--help/.test(bad.out), bad.out);
        const badPid = run(SUBJECT, fx, ['take', '--pid', 'abc']);
        check('a non-numeric --pid exits 1', badPid.code === 1 && /whole number/.test(badPid.out), badPid.out);
        const dead = run(SUBJECT, fx, ['take', '--pid', String(deadPid())]);
        check('a --pid that is not running exits 1 and queues nothing',
            dead.code === 1 && /not running/.test(dead.out) && tickets(fx).length === 0, dead.out);
    }

    report('newcomer polls first', scenarioNewcomerPollsFirst(SUBJECT));
    report('handoff', scenarioHandoff(SUBJECT));

    // A dead waiter's ticket is dropped, and it does not hold up the queue.
    {
        const fx = fixture();
        const [d, a] = [deadPid(), sleeper()];
        const planted = plantTicket(fx, d, 120000);
        const ra = take(SUBJECT, fx, a);
        check('dead ticket: a live waiter behind a dead pid\'s older ticket takes the free lock',
            ra.code === 0 && lockPid(fx) === a, ra.out);
        check('dead ticket: the dead pid\'s ticket file is removed and the drop is reported',
            !fs.existsSync(planted) && new RegExp(`dropped the ticket of pid ${d}`).test(ra.out), ra.out);
    }

    // A live pid whose ticket heartbeat is stale is skipped at release.
    {
        const fx = fixture();
        const [h, s, a] = [sleeper(), sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const staleTicket = plantTicket(fx, s, 30 * 60000, 20 * 60000);
        take(SUBJECT, fx, a);
        const rel = release(SUBJECT, fx, h);
        check('stale heartbeat: the release skips an older ticket with no heartbeat for 20 min and hands to A',
            rel.code === 0 && lockPid(fx) === a && !fs.existsSync(staleTicket), `${rel.out}\nlock: ${lockPid(fx)}`);
    }

    // A dead holder: only the head of the queue moves its lock aside.
    {
        const fx = fixture();
        const [d, a, b] = [deadPid(), sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${d}\ncrashed holder\n`);
        plantTicket(fx, a, 60000);
        const rb = take(SUBJECT, fx, b);
        check('dead holder: B, not the head, leaves the dead holder\'s lock in place (exit 3)',
            rb.code === 3 && lockPid(fx) === d && asides(fx, 'stale').length === 0, rb.out);
        const ra = take(SUBJECT, fx, a);
        check('dead holder: A, the head, moves it to .stale-HHMM and takes the lock',
            ra.code === 0 && lockPid(fx) === a && asides(fx, 'stale').length === 1, ra.out);
    }

    // A live holder the queue cannot judge is waited for, never moved.
    {
        const fx = fixture();
        const a = sleeper();
        fs.writeFileSync(fx.lock, 'not-a-pid\nsomething odd\n');
        const ra = take(SUBJECT, fx, a);
        check('unjudgeable holder: a lock whose line 1 is not a pid is waited for, not moved',
            ra.code === 3 && fs.readFileSync(fx.lock, 'utf8').startsWith('not-a-pid'), ra.out);
    }

    // release refuses what is not its own.
    {
        const fx = fixture();
        const [h, x] = [sleeper(), sleeper()];
        const none = release(SUBJECT, fx, x);
        check('release with no lock exits 1', none.code === 1 && /nothing to release/.test(none.out), none.out);
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const other = release(SUBJECT, fx, x);
        check('release by a pid that does not hold the lock exits 1 and leaves the lock untouched',
            other.code === 1 && lockPid(fx) === h && asides(fx, 'released').length === 0, other.out);
    }

    // status is read-only and lists the queue in arrival order.
    {
        const fx = fixture();
        const [h, a, b, d] = [sleeper(), sleeper(), sleeper(), deadPid()];
        fs.writeFileSync(fx.lock, `${h}\nholder text\n`);
        plantTicket(fx, a, 90000);
        plantTicket(fx, b, 60000);
        plantTicket(fx, d, 30000);
        const before = tickets(fx).join(',');
        const st = run(SUBJECT, fx, ['status']);
        const ia = st.out.indexOf(`pid ${a},`);
        const ib = st.out.indexOf(`pid ${b},`);
        check('status: prints the live holder and the queue oldest first',
            st.code === 0 && st.out.includes(`holder: pid ${h} (alive, product): holder text`) && ia > 0 && ib > ia, st.out);
        check('status: marks the dead ticket and deletes nothing',
            /will be dropped: pid \d+ is not running/.test(st.out) && tickets(fx).join(',') === before, st.out);
        const js = run(SUBJECT, fx, ['status', '--json']);
        let parsed = null;
        try { parsed = JSON.parse(js.out); } catch { /* reported below */ }
        const lane1 = parsed && parsed.lanes && parsed.lanes[0];
        check('status --json: parses, one lane by default, three tickets read, in arrival order',
            parsed && parsed.laneCount === 1 && parsed.laneSource === 'default' && parsed.lanes.length === 1 &&
            lane1.ticketFilesRead === 3 && lane1.queue.map((t) => t.pid).join() === [a, b, d].join(), js.out);
    }

    report('two lanes', scenarioLanes(SUBJECT));
    report('leave', scenarioLeave(SUBJECT));
    report('class order', scenarioClassOrder(SUBJECT));
    report('harness waits', scenarioHarnessWaits(SUBJECT));
    report('older version', scenarioOlderVersion(SUBJECT));
    report('harness cap', scenarioReserve(SUBJECT));
    report('one lane', scenarioOneLane(SUBJECT));

    // The class a take queues as: --class, then AUTODEV_GATE_CLASS, then product.
    {
        const fx = fixture();
        const [h, a, b, c, d] = [sleeper(), sleeper(), sleeper(), sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const ra = take(SUBJECT, fx, a, ['--class', 'harness']);
        check('class: --class harness queues (exit 3), says so, and line 4 of the ticket is "class harness"',
            ra.code === 3 && /as harness/.test(ra.out) && ticketLine(fx.queue, a, 4) === 'class harness', `${ra.out}\nline 4: ${ticketLine(fx.queue, a, 4)}`);
        const rb = take(SUBJECT, fx, b);
        check('class: with no --class and no env the ticket is "class product"',
            rb.code === 3 && ticketLine(fx.queue, b, 4) === 'class product', `${rb.out}\nline 4: ${ticketLine(fx.queue, b, 4)}`);
        const rc = take(SUBJECT, fx, c, [], { AUTODEV_GATE_CLASS: 'harness' });
        check('class: AUTODEV_GATE_CLASS=harness queues as harness',
            rc.code === 3 && ticketLine(fx.queue, c, 4) === 'class harness', `${rc.out}\nline 4: ${ticketLine(fx.queue, c, 4)}`);
        const rd = take(SUBJECT, fx, d, [], { AUTODEV_GATE_CLASS: 'urgent' });
        check('class: an AUTODEV_GATE_CLASS that is no class queues as product and is named in a note',
            rd.code === 3 && ticketLine(fx.queue, d, 4) === 'class product' && /AUTODEV_GATE_CLASS=urgent is not product or harness/.test(rd.out), rd.out);
        const bad = take(SUBJECT, fx, d, ['--class', 'urgent']);
        check('class: --class urgent exits 1 and names the two classes', bad.code === 1 && /--class needs product or harness, got urgent/.test(bad.out), bad.out);
        const fx2 = fixture();
        const rf = take(SUBJECT, fx2, a, ['--class', 'harness']);
        check('class: a harness take of a free lock writes "class harness" on line 3 of the lock',
            rf.code === 0 && linesOf(fx2.lock)[2] === 'class harness', `${rf.out}\nlock: ${linesOf(fx2.lock).join(' | ')}`);
    }

    // status names each holder's and each ticket's class, in the order they are served.
    {
        const fx = fixture();
        const [h, a, p] = [sleeper(), sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nharness holder\nclass harness\n`);
        plantTicket(fx, a, 90000, 0, { cls: 'harness' });
        plantTicket(fx, p, 30000, 0, { cls: 'product' });
        const st = run(SUBJECT, fx, ['status']);
        const ip = st.out.indexOf(`pid ${p}, product,`);
        const ia = st.out.indexOf(`pid ${a}, harness,`);
        check('status: the holder line names its class, and the product ticket is listed before the older harness one',
            st.out.includes(`holder: pid ${h} (alive, harness): harness holder`) && ip > 0 && ia > ip, st.out);
        check('status: it states the order and the harness cap', /Harness gates hold at most 1 of 1 lane\(s\)/.test(st.out), st.out);
        let parsed = null;
        try { parsed = JSON.parse(run(SUBJECT, fx, ['status', '--json']).out); } catch { /* reported below */ }
        const lane = parsed && parsed.lanes && parsed.lanes[0];
        check('status --json: holder.class, each ticket\'s class in serving order, and harnessCap',
            Boolean(lane) && lane.holder.class === 'harness' && parsed.harnessCap === 1 &&
            lane.queue.map((t) => `${t.pid}:${t.class}`).join() === `${p}:product,${a}:harness`, JSON.stringify(parsed));
    }

    // The lane count: flag over env over file, and a bad value is named, not guessed at.
    {
        const fx = fixture();
        fs.writeFileSync(path.join(fx.dir, 'full-gate.lanes'), 'lots\n');
        const bad = run(SUBJECT, fx, ['lanes']);
        check('lanes: an unreadable count in the file is named and the count falls back to 1',
            bad.code === 0 && /1 lane\(s\), from default/.test(bad.out) && /does not hold 1 to 8; ignored/.test(bad.out), bad.out);
        fs.writeFileSync(path.join(fx.dir, 'full-gate.lanes'), '3\n');
        const envRun = spawnSync(process.execPath, [SUBJECT, 'status'],
            { env: Object.assign(envFor(fx), { AUTODEV_GATE_LANES: '2' }), encoding: 'utf8', windowsHide: true });
        check('lanes: AUTODEV_GATE_LANES wins over the file', /lanes: {2}2 \(from AUTODEV_GATE_LANES\)/.test(envRun.stdout), envRun.stdout);
        const flag = run(SUBJECT, fx, ['status', '--lanes', '1']);
        check('lanes: --lanes wins over the file for one call', /lanes: {2}1 \(from --lanes\)/.test(flag.out), flag.out);
        const badFlag = run(SUBJECT, fx, ['status', '--lanes', '0']);
        check('lanes: --lanes 0 exits 1', badFlag.code === 1 && /1 to 8/.test(badFlag.out), badFlag.out);
        const badSet = run(SUBJECT, fx, ['lanes', '9']);
        check('lanes: setting 9 exits 1 and leaves the file alone',
            badSet.code === 1 && fs.readFileSync(path.join(fx.dir, 'full-gate.lanes'), 'utf8').trim() === '3', badSet.out);
    }

    // wait blocks until the handoff, then exits 0.
    {
        const fx = fixture();
        const [h, a] = [sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const w = spawn(process.execPath, [SUBJECT, 'wait', '--pid', String(a), '--what', 'waiting test'],
            { env: envFor(fx), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        w.stdout.on('data', (d) => { out += d; });
        w.stderr.on('data', (d) => { out += d; });
        const done = new Promise((r) => w.on('close', (code) => r(code)));
        for (let i = 0; i < 300 && !/waiting: place 1 of 1/.test(out); i++) await sleep(100);
        check('wait: reports its place while the lock is held', /waiting: place 1 of 1/.test(out), out);
        const rel = release(SUBJECT, fx, h);
        let timer;
        const bound = new Promise((r) => { timer = setTimeout(() => r('timeout'), 60000); });
        const code = await Promise.race([done, bound]);
        clearTimeout(timer); // a pending 60 s timer would hold the suite open after its summary
        if (code === 'timeout') { try { w.kill(); } catch { /* gone */ } }
        check('wait: exits 0 once the release hands it the lock, and the lock names its pid',
            code === 0 && lockPid(fx) === a, `${rel.out}\n${out}\nexit ${code}`);
    }

    // wait --timeout-ms gives up and removes its ticket.
    {
        const fx = fixture();
        const [h, a] = [sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const w = run(SUBJECT, fx, ['wait', '--pid', String(a), '--what', 'impatient', '--timeout-ms', '300']);
        check('wait --timeout-ms: exits 3, removes its ticket, leaves the lock with its holder',
            w.code === 3 && tickets(fx).length === 0 && lockPid(fx) === h && /NOT taken/.test(w.out), w.out);
    }

    // A poll that throws is retried; only a run of them gives the ticket up. A
    // directory at the lock path makes every read throw EISDIR, on every OS.
    {
        const fx = fixture();
        const a = sleeper();
        fs.mkdirSync(fx.lock);
        const w = spawn(process.execPath, [SUBJECT, 'wait', '--pid', String(a), '--what', 'retrying'],
            { env: envFor(fx), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        w.stdout.on('data', (d) => { out += d; });
        w.stderr.on('data', (d) => { out += d; });
        const done = new Promise((r) => w.on('close', (code) => r(code)));
        for (let i = 0; i < 300 && !/attempt 2 of/.test(out); i++) await sleep(20);
        fs.rmdirSync(fx.lock);
        const code = await done;
        check('failed polls: wait retries after a throwing poll and takes the lock once reads work',
            code === 0 && lockPid(fx) === a && /poll failed/.test(out), `${out}\nexit ${code}`);
        const fx2 = fixture();
        fs.mkdirSync(fx2.lock);
        const g = run(SUBJECT, fx2, ['wait', '--pid', String(a), '--what', 'giving up']);
        check('failed polls: ten in a row exit 1 and remove the ticket',
            g.code === 1 && /gave up after 10 failed polls/.test(g.out) && tickets(fx2).length === 0, g.out);
    }

    // With no --what, line 2 describes the checkout; with no lock path, the
    // default is under the OS home directory.
    {
        const fx = fixture();
        const a = sleeper();
        const r = run(SUBJECT, fx, ['take', '--pid', String(a)]);
        const line2 = fs.existsSync(fx.lock) ? fs.readFileSync(fx.lock, 'utf8').split(/\r?\n/)[1] : '';
        check('no --what: line 2 names the branch, head and worktree, and when the lock was taken',
            r.code === 0 && /^npm run gate, branch \S+, head \S+, worktree \S+, queued \d\d:\d\dZ, lock taken \d\d:\d\dZ$/.test(line2), `${r.out}\nline 2: ${line2}`);
        const home = mkTemp('fgq-home-');
        const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home });
        delete env.AUTODEV_GATE_LOCK_PATH;
        const st = spawnSync(process.execPath, [SUBJECT, 'status'], { env, encoding: 'utf8', windowsHide: true });
        const want = path.join(home, '.claude', 'autodev', 'locks', 'full-gate.lock');
        check('no AUTODEV_GATE_LOCK_PATH: the lock defaults to <home>/.claude/autodev/locks/full-gate.lock',
            st.status === 0 && st.stdout.includes(want), st.stdout + st.stderr);
    }

    // A signal stops wait without taking the lock. Windows cannot deliver one
    // that a handler sees, so this runs where it can.
    if (!WIN) {
        const fx = fixture();
        const [h, a] = [sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const w = spawn(process.execPath, [SUBJECT, 'wait', '--pid', String(a), '--what', 'signalled'],
            { env: envFor(fx), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        w.stdout.on('data', (d) => { out += d; });
        const done = new Promise((r) => w.on('close', (code) => r(code)));
        for (let i = 0; i < 300 && !/waiting: place/.test(out); i++) await sleep(100);
        w.kill('SIGTERM');
        const code = await done;
        check('wait on SIGTERM: exits 2, removes its ticket, leaves the lock with its holder',
            code === 2 && tickets(fx).length === 0 && lockPid(fx) === h, `${out}\nexit ${code}`);
    } else {
        console.log('SKIP  wait on SIGTERM: Windows delivers no signal a handler can see');
    }

    // The planted defects. Each must turn a scenario above red.
    const m1 = mutant('M1', 'if (mine !== 0) return queued(held);', 'if (mine < 0) return queued(held);');
    if (m1) expectRed('M1', 'any ticket may take a free lock', scenarioNewcomerPollsFirst(m1));
    const m2 = mutant('M2', 'const next = live[0];', 'const next = live[live.length - 1];');
    if (m2) expectRed('M2', 'release hands the lock to the newest ticket', scenarioHandoff(m2));
    const m4 = mutant('M4', 'for (const lane of lockPaths) {', 'for (const lane of lockPaths.slice(0, 1)) {');
    if (m4) expectRed('M4', 'a waiter tries only lane 1', scenarioLanes(m4));
    const m5 = mutant('M5', 'leaveQueues(others, pid);', '/* planted: stays queued */');
    if (m5) expectRed('M5', 'a waiter that took a lane stays queued in the others', scenarioLanes(m5));
    const m6 = mutant('M6', 'leaveQueues(lockPaths, leaving);', '/* planted: leaves nothing */');
    if (m6) expectRed('M6', 'leave removes nothing', scenarioLeave(m6));
    const m7 = mutant('M7', 'return [...tickets.filter((t) => t.cls === PRODUCT), ...tickets.filter((t) => t.cls === HARNESS)];', 'return tickets;');
    if (m7) {
        expectRed('M7', 'serving order ignores the class', scenarioClassOrder(m7));
        expectRed('M7', 'serving order ignores the class', scenarioHarnessWaits(m7));
    }
    const m8 = mutant('M8', 'return held + 1 > cap ? { held, cap, lanes: lockPaths.length } : null;', 'return null;');
    if (m8) expectRed('M8', 'no harness cap', scenarioReserve(m8));
    const m9 = mutant('M9', 'return Math.max(1, laneCount - 1);', 'return laneCount - 1;');
    if (m9) expectRed('M9', 'the cap is lanes - 1 on one lane too', scenarioOneLane(m9));
    const m10 = mutant('M10', 'if (front.classed || front === oldest) return false;', 'return false;');
    if (m10) expectRed('M10', 'no hand-over to a classless front', scenarioOlderVersion(m10));

    const msys = await msysPid();
    if (msys.pid) {
        report('MSYS waiter', scenarioMsysWaiter(SUBJECT, msys.pid));
        const m3 = mutant('M3', 'if (found) return true;', 'if (found) { /* planted: ps ignored */ }');
        if (m3) expectRed('M3', 'liveness ignores ps', scenarioMsysWaiter(m3, msys.pid));
    } else {
        console.log(`SKIP  MSYS waiter and planted M3: ${msys.why}`);
    }
}

main()
    .catch((e) => { failed++; console.log(`FAIL  the suite threw: ${e && e.stack ? e.stack : e}`); })
    .finally(() => {
        killAll();
        for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exitCode = failed ? 1 : 0;
    });
