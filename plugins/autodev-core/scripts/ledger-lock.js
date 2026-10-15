'use strict';
/**
 * ledger-lock.js - one writer at a time for a shared file, safe across crashes.
 *
 * THE LOCK. `<lock>` is created with flag wx and then carries its owner:
 * { pid, start, token, ...meta }. `start` is the owner's process creation time
 * and `token` is unique to the acquisition.
 *
 * WHO OWNS IT. An owner is judged by identity, never by age:
 *   - its pid does not answer a liveness probe (ESRCH): dead;
 *   - its pid answers, but that pid now belongs to a process created after the
 *     recorded `start` (gate-identity.js reads creation times): the pid was
 *     reused, so dead;
 *   - anything else, including a probe that cannot tell: alive.
 * A recorded live owner is never displaced, however old its lock is. A lock
 * with no readable owner (a writer that died between creating the file and
 * writing its body, or a writer from before owners were recorded) is the only
 * thing judged by age: it is abandoned after OWNERLESS_MS.
 *
 * RECLAIMING. Judging an abandoned lock and deleting it is a check-then-act, so
 * two reclaimers must never run it at once. They serialize through tickets:
 * `<lock>.reclaim-<key>.<n>`, where <key> names the exact lock file being
 * judged (inode and mtime) and <n> counts up. A ticket is created atomically
 * with its owner's identity in it (a hard link from a temp file), and ticket n+1
 * may be created only once ticket n is finished (`.done`) or its reclaimer is
 * judged dead by the same identity rule. So an abandoned or slow reclaimer is
 * never aged out: a live one is waited for, a dead one is recovered at once.
 * The highest ticket of a key is never deleted while that lock file exists, so
 * two reclaimers cannot both win. Tickets of any other key name a lock file
 * that is gone for good, and are swept.
 *
 * RELEASING. Only the holder releases: the file must be the one it created and
 * carry its token. A foreign or a successor's release is a no-op that says why.
 *
 * PIDS. Every body is written by a Node process, so `pid` is always the native
 * pid, also on Windows under Git Bash. gate-identity.js maps MSYS pids for
 * callers that record shell pids. This lock never stores one.
 *
 * Test seam: AUTODEV_LOCK_TEST_SKEW_MS shifts this module's clock, so a suite
 * can hold a lock "for hours" in seconds.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_MS = [5, 10, 20, 40, 80];
const OWNERLESS_MS = 10 * 60 * 1000;
// A process probe costs a process listing, so only a lock this old pays for one.
const PROBE_AFTER_MS = 2000;
// Our own start comes from process.uptime(). The OS creation time is a little earlier.
const START_TOLERANCE_MS = 2000;
const OWN_START = new Date(Date.now() - process.uptime() * 1000).toISOString();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

function now() {
    const skew = Number(process.env.AUTODEV_LOCK_TEST_SKEW_MS);
    return Date.now() + (Number.isFinite(skew) ? skew : 0);
}

// Same bounded replacement policy as keyed-ledger. A failed publish keeps the
// old file intact and removes only this call's unique staging file.
function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
        fs.writeFileSync(tmp, data, 'utf8');
        for (let attempt = 0; ; attempt++) {
            try { fs.renameSync(tmp, file); break; }
            catch (e) {
                if (!RETRY_CODES.has(e.code) || attempt >= RETRY_MS.length) throw e;
                sleep(RETRY_MS[attempt]);
            }
        }
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* published or never created */ }
    }
}

function parseOwner(text) {
    try {
        const o = JSON.parse(text);
        return o && Number.isInteger(o.pid) && o.pid > 0 ? o : null;
    } catch { return null; }
}

let gateIdentity;
function identityLib() {
    if (gateIdentity === undefined) {
        try { gateIdentity = require('./gate-identity.js'); } catch { gateIdentity = null; }
    }
    return gateIdentity;
}

// A reason when `owner.pid` provably belongs to a later process, else null.
function pidReused(owner, stat) {
    const recorded = Date.parse(owner.start);
    const g = identityLib();
    if (!Number.isFinite(recorded) || !g) return null;
    let snap = g.snapshot({ maxAgeMs: 5000 });
    // A listing from before the body was written cannot speak for its owner.
    if (snap.ok && snap.takenMs <= stat.mtimeMs) { g.forgetSnapshot(); snap = g.snapshot(); }
    if (!snap.ok) return null;
    const p = snap.procs.get(owner.pid);
    const current = p && p.startUtc ? Date.parse(p.startUtc) : NaN;
    if (!(current > recorded + START_TOLERANCE_MS)) return null;
    return `pid ${owner.pid} now belongs to a process created ${p.startUtc}, after its owner (created ${owner.start})`;
}

/** { alive, why } for the owner recorded in a lock or ticket file with this stat. */
function judgeOwner(owner, stat) {
    if (!owner) {
        const age = now() - stat.mtimeMs;
        return age > OWNERLESS_MS
            ? { alive: false, why: `no recorded owner for ${Math.round(age / 1000)}s` }
            : { alive: true, why: 'no recorded owner yet, an acquisition may be in progress' };
    }
    try { process.kill(owner.pid, 0); }
    catch (e) {
        // Permission errors and unknown failures do not prove death.
        if (e.code === 'ESRCH') return { alive: false, why: `pid ${owner.pid} has exited` };
        return { alive: true, why: `pid ${owner.pid} cannot be probed (${e.code})` };
    }
    if (typeof owner.start === 'string' && now() - stat.mtimeMs > PROBE_AFTER_MS) {
        const reused = pidReused(owner, stat);
        if (reused) return { alive: false, why: reused };
    }
    return { alive: true, why: `pid ${owner.pid} is running` };
}

function ownerBody(token, meta = {}) {
    return JSON.stringify({ ...meta, pid: process.pid, start: OWN_START, token });
}

const lockKey = (st) => `${st.ino}-${Math.round(st.mtimeMs)}`;

function ticketPattern(lock) {
    const base = path.basename(lock).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + base + '\\.reclaim-(\\d+-\\d+)\\.(\\d+)(\\.done|\\.[0-9a-f-]+\\.tmp)?$');
}

function listTickets(lock) {
    const re = ticketPattern(lock);
    let names;
    try { names = fs.readdirSync(path.dirname(lock)); } catch { return []; }
    const out = [];
    for (const name of names) {
        const m = re.exec(name);
        if (m) out.push({ name, key: m[1], n: Number(m[2]), suffix: m[3] || '' });
    }
    return out;
}

// Tickets of a key other than the current lock file's name a file that is gone.
function sweepTickets(lock) {
    let keep = null;
    try { keep = lockKey(fs.statSync(lock)); } catch (e) { if (e.code !== 'ENOENT') return; }
    for (const t of listTickets(lock)) {
        if (t.key === keep) continue;
        try { fs.unlinkSync(path.join(path.dirname(lock), t.name)); } catch { /* already swept */ }
    }
}

// Exclusive create with the body already in place: false when the target exists.
function createWithBody(target, data) {
    const tmp = target + '.' + crypto.randomUUID() + '.tmp';
    try {
        fs.writeFileSync(tmp, data, 'utf8');
        try { fs.linkSync(tmp, target); return true; }
        catch (e) {
            if (e.code === 'EEXIST') return false;
            // No hard links on this volume: exclusive create, then the body.
            let fd;
            try { fd = fs.openSync(target, 'wx'); }
            catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
            try { fs.writeFileSync(fd, data, 'utf8'); } finally { fs.closeSync(fd); }
            return true;
        }
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* linked or never written */ }
    }
}

// True when the caller should retry exclusive creation at once.
function reclaimAbandonedLock(lock, state, token) {
    let judged;
    try { judged = fs.statSync(lock); } catch (e) { return e.code === 'ENOENT'; }
    const key = lockKey(judged);
    const prefix = `${lock}.reclaim-${key}.`;
    let top = -1;
    for (const t of listTickets(lock)) if (t.key === key && !t.suffix && t.n > top) top = t.n;
    if (top >= 0 && !fs.existsSync(prefix + top + '.done')) {
        let owner, st;
        try { st = fs.statSync(prefix + top); owner = parseOwner(fs.readFileSync(prefix + top, 'utf8')); }
        catch { return false; }
        const v = judgeOwner(owner, st);
        if (v.alive) { state.why = `another reclaimer holds ticket ${top}: ${v.why}`; return false; }
        try { fs.writeFileSync(prefix + top + '.done', 'abandoned: ' + v.why, { flag: 'wx' }); }
        catch (e) { if (e.code !== 'EEXIST') return false; }
    }
    const mine = prefix + (top + 1);
    if (!createWithBody(mine, ownerBody(token))) return false;
    try {
        // All judgment and deletion of this lock file happen under the ticket.
        const current = fs.statSync(lock);
        if (lockKey(current) !== key) return true;
        const owner = parseOwner(fs.readFileSync(lock, 'utf8'));
        const v = judgeOwner(owner, current);
        if (v.alive) { state.why = v.why; state.holder = owner; return false; }
        if (lockKey(fs.statSync(lock)) !== key) return true;
        fs.unlinkSync(lock);
        state.reclaimed = { owner, why: v.why };
        return true;
    } catch (e) {
        // Another writer may have released it, or Windows may deny access
        // temporarily. Let the acquisition loop enforce its deadline.
        return e.code === 'ENOENT';
    } finally {
        try { fs.writeFileSync(mine + '.done', 'finished', { flag: 'wx' }); } catch { /* swept already */ }
        sweepTickets(lock);
    }
}

/**
 * Release `lock` only when it is the file this acquisition created and still
 * names this process and its token. { released, why }. A refusal changes nothing.
 */
function releaseLock(lock, { token, identity = null } = {}) {
    let st;
    try { st = fs.statSync(lock); }
    catch (e) { return { released: false, why: e.code === 'ENOENT' ? 'the lock is already gone' : `the lock cannot be read (${e.code})` }; }
    const replaced = { released: false, why: 'the lock file was replaced by another acquisition' };
    if (identity && (st.dev !== identity.dev || st.ino !== identity.ino)) return replaced;
    let owner;
    try { owner = parseOwner(fs.readFileSync(lock, 'utf8')); }
    catch (e) { return { released: false, why: `the lock cannot be read (${e.code})` }; }
    if (!owner) return { released: false, why: 'the lock records no owner' };
    // ext4 gives a freed inode to the next file at once, so a replacement can carry
    // this acquisition's dev and ino. Its token is what tells the two apart.
    if (identity && owner.token !== token) return replaced;
    if (owner.pid !== process.pid || owner.start !== OWN_START) {
        return { released: false, why: `the lock belongs to pid ${owner.pid}, not to this process` };
    }
    if (typeof token !== 'string' || owner.token !== token) {
        return { released: false, why: `the lock belongs to another acquisition of pid ${owner.pid}, not to this token` };
    }
    fs.unlinkSync(lock);
    sweepTickets(lock);
    return { released: true, why: null };
}

/**
 * Take `lock`, waiting up to waitMs. Acquired: { acquired: true, token,
 * reclaimed, release() }. Not acquired: { acquired: false, holder, why }.
 * `meta` joins the recorded owner (a "by" or an "at" field, say).
 */
function acquireLock(lock, { waitMs = 10000, meta = {} } = {}) {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const deadline = performance.now() + waitMs;
    const token = crypto.randomUUID();
    const state = {};
    let lateRetries = 0;
    for (;;) {
        let fd;
        try { fd = fs.openSync(lock, 'wx'); }
        catch (e) {
            if (e.code !== 'EEXIST' && !RETRY_CODES.has(e.code)) throw e;
            state.why = null;
            state.holder = undefined;
            const retryNow = e.code === 'EEXIST' && reclaimAbandonedLock(lock, state, token);
            const remaining = deadline - performance.now();
            // Progress made just now earns a few attempts past the deadline.
            if (remaining <= 0 && !(retryNow && ++lateRetries <= 3)) {
                let holder = state.holder;
                if (holder === undefined) { try { holder = parseOwner(fs.readFileSync(lock, 'utf8')); } catch { holder = null; } }
                return { acquired: false, holder, why: state.why || (e.code === 'EEXIST' ? 'the lock is held' : `exclusive create failed (${e.code})`) };
            }
            if (!retryNow) sleep(Math.min(5, remaining));
            continue;
        }
        const st = fs.fstatSync(fd);
        const identity = { dev: st.dev, ino: st.ino };
        let mine;
        try {
            fs.writeFileSync(fd, ownerBody(token, meta));
            // Ours unless a reclaimer judged the file ownerless before the body landed.
            const current = fs.statSync(lock);
            mine = current.dev === identity.dev && current.ino === identity.ino;
        } catch (e) {
            fs.closeSync(fd);
            try {
                const current = fs.statSync(lock);
                if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(lock);
            } catch { /* do not remove another owner's lock */ }
            sweepTickets(lock);
            throw e;
        }
        fs.closeSync(fd);
        if (!mine) continue;
        return {
            acquired: true, token, identity, reclaimed: state.reclaimed || null,
            release: () => releaseLock(lock, { token, identity }),
        };
    }
}

// Synchronous transaction only. Callers collect remote data before entering.
function withLedgerLock(file, fn, { waitMs = 10000 } = {}) {
    const lock = file + '.write-lock';
    const held = acquireLock(lock, { waitMs });
    if (!held.acquired) {
        throw Object.assign(new Error('ledger lock unavailable: ' + lock), { code: 'LEDGER_LOCKED', holder: held.holder, why: held.why });
    }
    try { return fn(); }
    finally { held.release(); }
}

module.exports = { withLedgerLock, writeAtomic, acquireLock, releaseLock, judgeOwner, OWNERLESS_MS };
