'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_MS = [5, 10, 20, 40, 80];
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

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

function reclaimAbandonedLock(lock) {
    const reclaim = lock + '.reclaim';
    let fd;
    try { fd = fs.openSync(reclaim, 'wx'); }
    catch (e) {
        if (e.code === 'EEXIST') {
            try {
                // Accepted residual: only a reclaimer abandoned inside this
                // microsecond section should leave a mutex older than 30 s.
                if (Date.now() - fs.statSync(reclaim).mtimeMs > 30000) fs.unlinkSync(reclaim);
            } catch { /* another reclaimer may already have recovered it */ }
        }
        return false; // Retry exclusive creation through the caller's deadline.
    }
    let identity;
    try {
        identity = fs.fstatSync(fd);
        // All judgment and main-lock deletion are serialized by this mutex.
        const judged = fs.statSync(lock);
        const content = fs.readFileSync(lock, 'utf8');
        let pid;
        try { pid = JSON.parse(content)?.pid; } catch { /* incomplete metadata */ }
        if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); return false; }
            catch (e) {
                // Permission errors and unknown failures do not prove death.
                if (e.code !== 'ESRCH') return false;
            }
        } else if (Date.now() - judged.mtimeMs <= 10 * 60 * 1000) {
            return false;
        }
        const current = fs.statSync(lock);
        if (current.dev !== judged.dev || current.ino !== judged.ino) return true;
        fs.unlinkSync(lock);
        return true;
    } catch (e) {
        // Another writer may have released/reclaimed it, or Windows may deny
        // access temporarily. Let the acquisition loop enforce its deadline.
        return e.code === 'ENOENT';
    } finally {
        fs.closeSync(fd);
        try {
            const current = fs.statSync(reclaim);
            if (identity && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(reclaim);
        } catch { /* do not remove another reclaimer's mutex */ }
    }
}

// Synchronous transaction only. Callers collect remote data before entering.
// A recorded live owner is never displaced by age, including a reused pid.
function withLedgerLock(file, fn, { waitMs = 10000 } = {}) {
    const lock = file + '.write-lock';
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const deadline = performance.now() + waitMs;
    const token = crypto.randomUUID();
    let fd;
    for (;;) {
        try { fd = fs.openSync(lock, 'wx'); break; }
        catch (e) {
            if (e.code !== 'EEXIST' && !RETRY_CODES.has(e.code)) throw e;
            const retryNow = e.code === 'EEXIST' && reclaimAbandonedLock(lock);
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw Object.assign(new Error('ledger lock unavailable: ' + lock), { code: 'LEDGER_LOCKED' });
            if (!retryNow) sleep(Math.min(5, remaining));
        }
    }
    const identity = fs.fstatSync(fd);
    try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
        return fn();
    } finally {
        fs.closeSync(fd);
        try {
            const current = fs.statSync(lock);
            if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(lock);
        } catch { /* do not remove another owner's lock */ }
    }
}

module.exports = { withLedgerLock, writeAtomic };
