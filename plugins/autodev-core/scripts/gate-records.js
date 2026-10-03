#!/usr/bin/env node
/**
 * gate-records.js - the files beside the machine's full-gate lock that say who
 * may run, and the small readers other tools import. A library for
 * full-gate-queue.js, tooling/gate-lock.js and the build-output reaper; it
 * prints nothing on import and nothing on a no-op.
 *
 * Beside lane 1's lock (`full-gate.lock` in `<home>/.claude/autodev/locks/`):
 *
 *   full-gate.admission      the ADMISSION MUTEX. One per machine, shared by every
 *                            lane. Ticket registration, the class and cap checks,
 *                            acquisition, hand-over, fencing and leaving the other
 *                            queues all run while holding it, so two waiters
 *                            released at once cannot both take a lane the cap
 *                            allows only one of. Held for milliseconds.
 *   full-gate.fence          the last FENCING TOKEN minted, one number. Every
 *                            admission mints the next one under the mutex. A
 *                            release, renewal or settlement that carries a token
 *                            must match the lock's, so a late release from an
 *                            earlier admission cannot free a newer holder's lane.
 *   full-gate.boot           a cache of this boot's identity (gate-identity.js).
 *   full-gate.runs/<id>.json a run's EXECUTION JOURNAL: its chain root, every
 *                            descendant observed with native pid, parent and
 *                            creation time, and each attempt's outcome.
 *   full-gate.leases/<key>.json  a WORKTREE LEASE: run id, token, canonical
 *                            worktree, owner and execution identities, heartbeat
 *                            and state. Written before a gate's chain starts.
 *   full-gate.leases/<key>.mutex the per-worktree EXCLUSION MUTEX that lease
 *                            writers and the reaper share.
 *
 * Lock and ticket files keep their legacy lines (pid, what, then arrival and
 * `class` for a ticket, `class` for a lock) and append one `meta {json}` line,
 * so older versions still read them. A meta line that does not parse is
 * MALFORMED, which is never read as vacant: a malformed holder is unknown.
 *
 *   node gate-records.js --help
 *   node gate-records.js leases [--json]   # lists every lease, read-only
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA = 1;
const META_PREFIX = 'meta ';

// ---------------------------------------------------------------------------
// Paths, all derived from lane 1's lock.
// ---------------------------------------------------------------------------

function stem(base) { return /\.lock$/.test(base) ? base.replace(/\.lock$/, '') : base; }
function admissionPath(base) { return `${stem(base)}.admission`; }
function fencePath(base) { return `${stem(base)}.fence`; }
function bootCachePath(base) { return `${stem(base)}.boot`; }
function runsDir(base) { return `${stem(base)}.runs`; }
function leasesDir(base) { return `${stem(base)}.leases`; }

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));

// ---------------------------------------------------------------------------
// The meta line.
// ---------------------------------------------------------------------------

const ISO7 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/;

/** Why an identity ({ pid, startUtc, bootId, msysPid?, msysWinpid? }) cannot be judged, or null. */
function identityFault(id, label) {
    if (id === null || id === undefined) return null;
    if (typeof id !== 'object' || Array.isArray(id)) return `${label} is not an object`;
    if (!Number.isInteger(id.pid) || id.pid <= 0) return `${label}.pid is not a pid`;
    if (id.startUtc !== null && id.startUtc !== undefined && !(typeof id.startUtc === 'string' && ISO7.test(id.startUtc))) return `${label}.startUtc is not a creation time`;
    if (id.bootId !== null && id.bootId !== undefined && !(typeof id.bootId === 'string' && /^[^|]+\|\S+$/.test(id.bootId))) return `${label}.bootId is not a boot identity`;
    for (const k of ['msysPid', 'msysWinpid']) if (id[k] !== undefined && id[k] !== null && !(Number.isInteger(id[k]) && id[k] > 0)) return `${label}.${k} is not a pid`;
    return null;
}

/**
 * Why a parsed meta object cannot be trusted, or null. A record of another
 * schema, a token that is not a safe integer, or an identity with a field of
 * the wrong shape would otherwise be judged against the live process table as
 * if it were sound, and a nonsense creation time reads as "a reused pid".
 */
function metaFault(m) {
    if (m.schema !== undefined && m.schema !== SCHEMA) return `schema ${JSON.stringify(m.schema)} is not ${SCHEMA}`;
    if (m.token !== undefined && m.token !== null && !(Number.isSafeInteger(m.token) && m.token > 0)) return 'token is not a positive safe integer';
    if (m.runId !== undefined && m.runId !== null && typeof m.runId !== 'string') return 'runId is not a string';
    return identityFault(m.owner, 'owner');
}

/**
 * { meta, malformed, fault }: meta is the parsed object or null; malformed
 * when a meta line did not parse or did not validate (`fault` says why).
 */
function parseMeta(lines) {
    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (!line.startsWith(META_PREFIX)) continue;
        let m;
        try { m = JSON.parse(line.slice(META_PREFIX.length)); } catch { return { meta: null, malformed: true, fault: 'the meta line is not JSON' }; }
        if (!m || typeof m !== 'object' || Array.isArray(m)) return { meta: null, malformed: true, fault: 'the meta line is not an object' };
        const fault = metaFault(m);
        if (fault) return { meta: null, malformed: true, fault };
        return { meta: m, malformed: false, fault: null };
    }
    return { meta: null, malformed: false, fault: null };
}

function metaLine(obj) { return `${META_PREFIX}${JSON.stringify({ schema: SCHEMA, ...obj })}`; }

// ---------------------------------------------------------------------------
// Small atomic file helpers. A rename over a file Windows has open fails with
// EPERM, EACCES or EBUSY for a moment; it is retried, never replaced by a
// partial in-place write of an ownership record.
// ---------------------------------------------------------------------------

function tryCreate(file, body) {
    let fd;
    try { fd = fs.openSync(file, 'wx'); } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
    }
    try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
    return true;
}

function renameRetry(from, to, tries = 80) {
    for (let i = 0; ; i++) {
        try { fs.renameSync(from, to); return; } catch (e) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || i >= tries) throw e;
            sleepMs(25);
        }
    }
}

/** Writes JSON through a unique temp file and a retried rename. Throws on failure. */
function writeJsonAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    try { renameRetry(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

/** { state: 'absent' | 'ok' | 'malformed', value, error } */
function readJson(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return { state: 'absent', value: null };
        return { state: 'malformed', value: null, error: e.code || e.message };
    }
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' ? { state: 'ok', value: v } : { state: 'malformed', value: null, error: 'not an object' };
    } catch (e) { return { state: 'malformed', value: null, error: e.message }; }
}

// ---------------------------------------------------------------------------
// The admission mutex.
// ---------------------------------------------------------------------------

let admissionDepth = 0;

/**
 * Runs fn() while holding the admission mutex beside `base`. Re-entrant within
 * one process. A holder that is dead (`isDead(pid)` true) is moved aside under a
 * second exclusive file, after re-reading that the mutex still says what was
 * judged. Throws EADMISSION after `timeoutMs` without it. The test seam
 * AUTODEV_GATE_TEST_ADMIT_PAUSE_MS is read by callers, not here.
 */
function withAdmission(base, fn, { timeoutMs = 30000, isDead = () => false } = {}) {
    if (admissionDepth > 0) {
        admissionDepth++;
        try { return fn(); } finally { admissionDepth--; }
    }
    const file = admissionPath(base);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const until = Date.now() + timeoutMs;
    const body = `${process.pid}\n${new Date().toISOString()}\n`;
    for (;;) {
        if (tryCreate(file, body)) break;
        let text = null;
        try { text = fs.readFileSync(file, 'utf8'); } catch { /* released between the two calls */ }
        if (text !== null && holderGone(file, text, isDead)) breakAdmission(file, text);
        if (Date.now() > until) {
            const e = new Error(`the admission mutex ${path.basename(file)} stayed held for ${timeoutMs} ms`);
            e.code = 'EADMISSION';
            throw e;
        }
        sleepMs(15 + Math.floor(Math.random() * 20));
    }
    admissionDepth = 1;
    try { return fn(); } finally {
        admissionDepth = 0;
        try {
            const now = fs.readFileSync(file, 'utf8');
            if (now === body) fs.unlinkSync(file);
        } catch { /* already gone */ }
    }
}

/**
 * Is the holder of mutex `file` (body `text`) provably gone? Its pid is dead,
 * or the file was last written before this boot began: after a reboot the pid
 * may name an unrelated live process, and a mutex is held for milliseconds,
 * never across a restart. An mtime or uptime that cannot be read proves nothing.
 */
function holderGone(file, text, isDead) {
    const pid = Number((text.split(/\r?\n/)[0] || '').trim());
    if (Number.isInteger(pid) && pid > 0 && isDead(pid)) return true;
    try {
        const bootMs = Date.now() - os.uptime() * 1000;
        return Number.isFinite(bootMs) && fs.statSync(file).mtimeMs < bootMs - 60000;
    } catch { return false; }
}

function breakAdmission(file, judged) {
    const breaker = `${file}.break`;
    if (!tryCreate(breaker, `${process.pid}\n`)) {
        try { if (Date.now() - fs.statSync(breaker).mtimeMs > 60000) fs.unlinkSync(breaker); } catch { /* gone */ }
        return;
    }
    try {
        let now = null;
        try { now = fs.readFileSync(file, 'utf8'); } catch { return; }
        if (now !== judged) return;
        try { renameRetry(file, `${file}.stale-${Date.now()}-${process.pid}`); } catch { /* another breaker won */ }
    } finally {
        try { fs.unlinkSync(breaker); } catch { /* gone */ }
    }
}

function text0(file) { try { return fs.readFileSync(file, 'utf8').trim().slice(0, 40); } catch { return 'unreadable'; } }

/** The next fencing token. Call only inside withAdmission. A malformed counter throws: it is never reset to zero. */
function mintToken(base) {
    const file = fencePath(base);
    let last = 0;
    try {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (!/^\d+$/.test(text)) { const e = new Error(`${path.basename(file)} does not hold a number`); e.code = 'EFENCE'; throw e; }
        last = Number(text);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const next = last + 1;
    // Past 2^53 - 1 a Number cannot hold the successor, so two admissions would
    // share a token. Refuse, never wrap or repeat.
    if (!Number.isSafeInteger(next)) { const e = new Error(`${path.basename(file)} is exhausted (${text0(file)})`); e.code = 'EFENCE'; throw e; }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${next}\n`);
    renameRetry(tmp, file);
    return next;
}

// ---------------------------------------------------------------------------
// Readers the reaper and status tools import.
// ---------------------------------------------------------------------------

/** One lane lock: { file, text, pid, what, cls, meta, malformed } or null when absent. */
function readLaneLock(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
    const lines = text.split(/\r?\n/);
    const first = (lines[0] || '').trim();
    let cls = 'product';
    for (const line of lines.slice(2)) { const m = /^class (product|harness)$/.exec(line.trim()); if (m) { cls = m[1]; break; } }
    return { file, text, pid: /^\d+$/.test(first) ? Number(first) : null, what: (lines[1] || '').trim(), cls, ...parseMeta(lines) };
}

/** Every lane lock that exists, for `count` lanes (count defaults to the lanes file, else 1). */
function readLaneLocks(base, count = null) {
    let n = count;
    if (!n) {
        try { const t = fs.readFileSync(`${stem(base)}.lanes`, 'utf8').trim(); n = /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 8 ? Number(t) : 1; } catch { n = 1; }
    }
    const out = [];
    for (let k = 1; k <= n; k++) {
        const file = k === 1 ? base : (/\.lock$/.test(base) ? base.replace(/\.lock$/, `-${k}.lock`) : `${base}-${k}`);
        let lock = null;
        try { lock = readLaneLock(file); } catch (e) { lock = { file, unreadable: e.code || e.message }; }
        out.push({ lane: k, file, lock });
    }
    return out;
}

/** Every ticket in one lane's queue directory, parsed with its meta. */
function readTicketRecords(queueDir) {
    let names;
    try { names = fs.readdirSync(queueDir); } catch { return []; }
    const out = [];
    for (const name of names.sort()) {
        if (!/^\d{8}T\d{9}Z-\d{10}\.ticket$/.test(name)) continue;
        let text;
        try { text = fs.readFileSync(path.join(queueDir, name), 'utf8'); } catch { continue; }
        const lines = text.split(/\r?\n/);
        out.push({ file: path.join(queueDir, name), pid: Number(lines[0]) || null, what: (lines[1] || '').trim(), arrived: (lines[2] || '').trim() || null, ...parseMeta(lines) });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Run journals.
// ---------------------------------------------------------------------------

function runPath(base, runId) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(runId))) throw new Error(`not a run id: ${runId}`);
    return path.join(runsDir(base), `${runId}.json`);
}

/** { state, value } as readJson. */
function readRun(base, runId) {
    try { return readJson(runPath(base, runId)); } catch (e) { return { state: 'malformed', value: null, error: e.message }; }
}

/** Read-modify-write of a run journal. `mutate(value)` returns the new value. */
function updateRun(base, runId, mutate) {
    const cur = readRun(base, runId);
    if (cur.state === 'malformed') throw new Error(`run journal ${runId} is malformed (${cur.error}); not overwritten`);
    const next = mutate(cur.value || { schema: SCHEMA, runId, descendants: [], attempts: [] });
    writeJsonAtomic(runPath(base, runId), next);
    return next;
}

/**
 * Merges observed processes into a journal's descendants (pid, ppid, startUtc,
 * firstSeen, lastSeen; other fields such as goneUtc are kept). At the cap a new
 * process is dropped, but a journaled one is still refreshed: a stalled
 * lastSeen would bound its children too early in gate-identity executionRecords.
 */
function mergeDescendants(list, observed, nowIso, cap = 500) {
    const out = Array.isArray(list) ? list.slice() : [];
    for (const p of observed) {
        const hit = out.find((d) => d.pid === p.pid && d.startUtc === p.startUtc);
        if (hit) hit.lastSeen = nowIso;
        else if (out.length < cap) out.push({ pid: p.pid, ppid: p.ppid, startUtc: p.startUtc, firstSeen: nowIso, lastSeen: nowIso });
    }
    return out;
}

/**
 * Removes run journals older than `maxAgeMs`. Best effort. A re-admission
 * counter (`readmit-*.json`, tooling/gate-recovery.js) shares the directory
 * and is never pruned: deleting it would hand an old head a fresh budget.
 */
function pruneRuns(base, maxAgeMs = 14 * 86400000) {
    let names = [];
    try { names = fs.readdirSync(runsDir(base)); } catch { return 0; }
    let n = 0;
    for (const name of names) {
        if (name.startsWith('readmit-')) continue;
        const f = path.join(runsDir(base), name);
        try { if (Date.now() - fs.statSync(f).mtimeMs > maxAgeMs) { fs.unlinkSync(f); n++; } } catch { /* in use or gone */ }
    }
    return n;
}

// ---------------------------------------------------------------------------
// Worktree leases.
// ---------------------------------------------------------------------------

function leasePath(base, key) { return path.join(leasesDir(base), `${key}.json`); }

/**
 * Runs fn() holding the per-worktree exclusion mutex for `key`. The reaper and
 * every lease writer take it, so a lease is published before a chain starts
 * and a reaper that holds it sees every lease that exists. A dead holder's
 * mutex (by `isDead`) is moved aside. Throws ELEASEMUTEX on timeout.
 */
function withWorktreeMutex(base, key, fn, { timeoutMs = 30000, isDead = () => false } = {}) {
    const file = path.join(leasesDir(base), `${key}.mutex`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = `${process.pid}\n${new Date().toISOString()}\n`;
    const until = Date.now() + timeoutMs;
    for (;;) {
        if (tryCreate(file, body)) break;
        let text = null;
        try { text = fs.readFileSync(file, 'utf8'); } catch { /* released */ }
        if (text !== null && holderGone(file, text, isDead)) breakAdmission(file, text);
        if (Date.now() > until) {
            const e = new Error(`the worktree mutex ${path.basename(file)} stayed held for ${timeoutMs} ms`);
            e.code = 'ELEASEMUTEX';
            throw e;
        }
        sleepMs(20);
    }
    try { return fn(); } finally {
        try { if (fs.readFileSync(file, 'utf8') === body) fs.unlinkSync(file); } catch { /* gone */ }
    }
}

/** { state, value } for one worktree's lease. */
function readLease(base, key) { return readJson(leasePath(base, key)); }

/** Every lease file: [{ key, file, state, value }]. */
function readLeases(base) {
    let names = [];
    try { names = fs.readdirSync(leasesDir(base)); } catch { return []; }
    return names.filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).sort().map((n) => {
        const key = n.slice(0, 16);
        return { key, file: leasePath(base, key), ...readLease(base, key) };
    });
}

/**
 * Writes a lease inside the worktree mutex. With `expect` ({ runId, token }),
 * the lease on disk must carry the same run id and token, or the write is
 * refused: a renewal or settlement from an earlier admission never overwrites
 * a newer one. Without `expect` (a first publication) the write is refused
 * while the lease on disk is unreadable, or is another run's active lease and
 * `isLive(lease)` does not answer false: one worktree runs one gate at a time.
 * Returns { written, why, value }.
 */
const ACTIVE_LEASE = new Set(['admitted', 'running', 'awaiting-clearance', 'requeued', 'lingering']);

function writeLease(base, key, value, { expect = null, isDead, isLive = () => null } = {}) {
    return withWorktreeMutex(base, key, () => {
        const cur = readLease(base, key);
        if (expect) {
            if (cur.state !== 'ok') return { written: false, why: `no readable lease to renew (${cur.state})`, value: cur.value };
            if (cur.value.runId !== expect.runId || cur.value.token !== expect.token) {
                return { written: false, why: `the lease belongs to run ${cur.value.runId} token ${cur.value.token}`, value: cur.value };
            }
        } else if (cur.state === 'malformed') {
            return { written: false, why: `the lease ${leasePath(base, key)} is unreadable (${cur.error}); it is kept, not overwritten`, value: null };
        } else if (cur.state === 'ok' && cur.value.runId !== value.runId && ACTIVE_LEASE.has(cur.value.state)) {
            let live = null;
            try { live = isLive(cur.value); } catch { live = null; }
            if (live !== false) {
                return { written: false, why: `run ${cur.value.runId} holds this worktree (lease ${cur.value.state}, ${live === true ? 'running' : 'not provably finished'})`, value: cur.value };
            }
        }
        const next = { schema: SCHEMA, ...value };
        writeJsonAtomic(leasePath(base, key), next);
        return { written: true, why: null, value: next };
    }, { isDead });
}

module.exports = {
    SCHEMA, ACTIVE_LEASE, parseMeta, metaLine, admissionPath, fencePath, bootCachePath, runsDir, leasesDir, leasePath,
    withAdmission, mintToken, readLaneLock, readLaneLocks, readTicketRecords, readRun, updateRun, mergeDescendants,
    pruneRuns, withWorktreeMutex, readLease, readLeases, writeLease, writeJsonAtomic, readJson, renameRetry, tryCreate,
};

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv[0] === 'leases') {
        const base = path.resolve(process.env.AUTODEV_GATE_LOCK_PATH || path.join(os.homedir(), '.claude', 'autodev', 'locks', 'full-gate.lock'));
        const leases = readLeases(base);
        if (argv.includes('--json')) console.log(JSON.stringify(leases, null, 2));
        else {
            console.log(`gate-records: ${leases.length} lease(s) in ${leasesDir(base)}`);
            for (const l of leases) {
                const v = l.value || {};
                console.log(`  ${l.key} ${l.state}${l.state === 'ok' ? `: ${v.state}, run ${v.runId}, token ${v.token}, heartbeat ${v.heartbeatUtc}, ${v.worktree}` : ''}`);
            }
        }
    } else {
        console.log('usage: node gate-records.js [leases [--json]]\n\nA library for the full-gate queue: the admission mutex, fencing tokens,\nrun journals and worktree leases beside the full-gate lock. "leases" lists\nthe worktree leases, read-only.');
    }
}
