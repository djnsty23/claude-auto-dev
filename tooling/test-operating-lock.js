#!/usr/bin/env node
'use strict';
/**
 * Suite for ledger-lock.js as an operating lock, with real child processes.
 *
 * Contention: 20 writers each append one record under the lock while a foreign
 * process keeps trying to release it, with a random token and with the
 * holder's own token read from the lock file. A writer that finds another
 * writer inside the critical section counts an overlap.
 *
 * Crash points, each in its own directory:
 *   create   a writer killed after creating the lock and before its body
 *   holding  a writer killed while holding
 *   reclaim  a reclaimer killed mid-reclaim, after taking its ticket
 *   aged     a live owner held a day past any age limit (clock seam)
 *   reused   a lock naming a live pid that now belongs to a later process
 *
 * Prints exactly one line:
 *   writers=20 committed=20 overlap=0 foreign_release=0 crash_points=PASS
 * and sets a nonzero exitCode on any mismatch. Failing checks go to stderr.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SUBJECT = process.env.OPERATING_LOCK_SUBJECT || path.resolve(__dirname, '../plugins/autodev-core/scripts/ledger-lock.js');
const WRITERS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

if (process.argv[2] === '--child') child(JSON.parse(process.argv[3]));
else main().catch((e) => { process.stderr.write(`suite crashed: ${e && e.stack}\n`); process.exitCode = 1; });

// ---------------------------------------------------------------- children
function child(o) {
    const lib = require(SUBJECT);
    const done = (v) => { fs.writeSync(1, JSON.stringify(v) + '\n'); };
    const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 60 * 1000);
    if (o.role === 'writer') {
        const h = lib.acquireLock(o.lock, { waitMs: o.waitMs });
        if (!h.acquired) return done({ id: o.id, acquired: false, why: h.why });
        let overlap = false;
        try { fs.writeFileSync(o.marker, String(o.id), { flag: 'wx' }); } catch { overlap = true; }
        let recs = [];
        try { recs = JSON.parse(fs.readFileSync(o.ledger, 'utf8')); } catch { /* first writer */ }
        recs.push(o.id);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + (o.id % 4) * 5);
        lib.writeAtomic(o.ledger, JSON.stringify(recs));
        if (!overlap) fs.unlinkSync(o.marker);
        const r = h.release();
        return done({ id: o.id, acquired: true, overlap, released: r.released, why: r.why, reclaimed: h.reclaimed && h.reclaimed.why });
    }
    if (o.role === 'hold') {
        const h = lib.acquireLock(o.lock, { waitMs: 5000 });
        fs.writeFileSync(o.signal, JSON.stringify({ acquired: h.acquired, pid: process.pid }));
        if (!h.acquired) return;
        const t = setInterval(() => {
            if (!fs.existsSync(o.releaseSignal)) return;
            clearInterval(t);
            done(h.release());
        }, 20);
        return;
    }
    if (o.role === 'create-only') {
        fs.openSync(o.lock, 'wx');
        fs.writeFileSync(o.signal, 'created');
        return block();
    }
    if (o.role === 'reclaim-pause') {
        // The first read of the main lock happens under the reclaim ticket.
        const original = fs.readFileSync;
        fs.readFileSync = function (target, ...rest) {
            if (target === o.lock) { original.call(fs, o.lock); fs.writeFileSync(o.signal, 'mid-reclaim'); block(); }
            return original.call(this, target, ...rest);
        };
        lib.acquireLock(o.lock, { waitMs: 60000 });
        return undefined;
    }
    if (o.role === 'foreign') {
        let tries = 0;
        let released = 0;
        const until = Date.now() + o.durationMs;
        while (Date.now() < until && !fs.existsSync(o.stop)) {
            let stolen = null;
            try { stolen = JSON.parse(fs.readFileSync(o.lock, 'utf8')).token; } catch { /* free or mid-write */ }
            for (const token of [crypto.randomUUID(), stolen]) {
                if (!token) continue;
                tries++;
                if (lib.releaseLock(o.lock, { token }).released) released++;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        return done({ tries, released });
    }
    throw new Error('unknown role ' + o.role);
}

// ---------------------------------------------------------------- parent
function run(o, env = {}) {
    const p = spawn(process.execPath, [__filename, '--child', JSON.stringify(o)],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.result = new Promise((resolve) => p.on('exit', (code) => {
        let json = null;
        try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ }
        resolve({ code, json, out, err });
    }));
    return p;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return true; await wait(20); }
    return false;
}
async function kill(p) {
    p.kill('SIGKILL');
    await p.result;
}
function deadPid() {
    const r = require('node:child_process').spawnSync(process.execPath, ['-e', '0']);
    return r.pid;
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operating-lock-'));
    const fails = [];
    const expect = (name, cond, detail) => { if (!cond) fails.push(`${name}${detail ? ': ' + String(detail).slice(0, 400) : ''}`); };
    const scenario = (name) => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir);
        return { dir, lock: path.join(dir, 'ledger.json.write-lock'), ledger: path.join(dir, 'ledger.json'), marker: path.join(dir, 'inside') };
    };
    const writer = (s, id, waitMs, env) => run({ role: 'writer', lock: s.lock, ledger: s.ledger, marker: s.marker, id, waitMs }, env);
    const records = (s) => { try { return JSON.parse(fs.readFileSync(s.ledger, 'utf8')); } catch { return []; } };
    const leftovers = (s) => fs.readdirSync(s.dir).filter((n) => n.includes('.reclaim') || n.endsWith('.write-lock'));
    let committed = 0;
    let overlap = 0;
    let foreignRelease = 0;
    try {
        // ---------------------------------------------------- contention
        {
            const s = scenario('contention');
            const stop = path.join(s.dir, 'stop');
            const foreign = run({ role: 'foreign', lock: s.lock, stop, durationMs: 120000 });
            const ws = Array.from({ length: WRITERS }, (_, i) => writer(s, i + 1, 60000));
            const results = await Promise.all(ws.map((w) => w.result));
            fs.writeFileSync(stop, '');
            const f = await foreign.result;
            const recs = records(s);
            committed = new Set(recs).size === recs.length ? recs.length : -1;
            overlap = results.filter((r) => r.json && r.json.overlap).length;
            foreignRelease = f.json ? f.json.released : -1;
            expect('contention: every writer acquired and released its own lock',
                results.every((r) => r.json && r.json.acquired && r.json.released), results.filter((r) => !(r.json && r.json.released)).map((r) => r.out + r.err).join(' | '));
            expect('contention: the foreign releaser ran', f.json && f.json.tries > 0, f.out + f.err);
            expect('contention: nothing left behind', leftovers(s).length === 0, leftovers(s));
        }
        // ---------------------------------------------------- create: killed before its body
        {
            const s = scenario('create');
            const signal = path.join(s.dir, 'created');
            const c = run({ role: 'create-only', lock: s.lock, signal });
            expect('create: the writer created the lock', await until(() => fs.existsSync(signal)));
            await kill(c);
            const young = await writer(s, 1, 300).result;
            expect('create: a fresh ownerless lock is respected', young.json && young.json.acquired === false, young.out + young.err);
            const late = await writer(s, 2, 5000, { AUTODEV_LOCK_TEST_SKEW_MS: String(11 * 60 * 1000) }).result;
            expect('create: an ownerless lock past its limit is recovered', late.json && late.json.acquired && late.json.released && /no recorded owner/.test(late.json.reclaimed || ''), late.out + late.err);
            expect('create: one record, nothing left behind', records(s).length === 1 && leftovers(s).length === 0, JSON.stringify(records(s)) + leftovers(s));
        }
        // ---------------------------------------------------- holding: killed while holding
        {
            const s = scenario('holding');
            const signal = path.join(s.dir, 'held');
            const h = run({ role: 'hold', lock: s.lock, signal, releaseSignal: path.join(s.dir, 'release') });
            expect('holding: the holder acquired', await until(() => fs.existsSync(signal)));
            await kill(h);
            const w = await writer(s, 1, 5000).result;
            expect('holding: a dead holder is recovered at once', w.json && w.json.acquired && /has exited/.test(w.json.reclaimed || ''), w.out + w.err);
            expect('holding: nothing left behind', leftovers(s).length === 0, leftovers(s));
        }
        // ---------------------------------------------------- reclaim: a reclaimer killed mid-reclaim
        {
            const s = scenario('reclaim');
            fs.writeFileSync(s.lock, JSON.stringify({ pid: deadPid(), token: 'dead owner' }));
            const signal = path.join(s.dir, 'paused');
            const r = run({ role: 'reclaim-pause', lock: s.lock, signal });
            expect('reclaim: the reclaimer paused under its ticket', await until(() => fs.existsSync(signal)));
            const a = await writer(s, 1, 500).result;
            expect('reclaim: a live reclaimer keeps a second reclaimer out', a.json && a.json.acquired === false && /another reclaimer/.test(a.json.why), a.out + a.err);
            const b = await writer(s, 2, 3000, { AUTODEV_LOCK_TEST_SKEW_MS: String(DAY_MS) }).result;
            expect('reclaim: a live reclaimer is never aged out', b.json && b.json.acquired === false && /another reclaimer/.test(b.json.why), b.out + b.err);
            await kill(r);
            const c = await writer(s, 3, 5000).result;
            expect('reclaim: a dead reclaimer is recovered at once', c.json && c.json.acquired && c.json.released, c.out + c.err);
            expect('reclaim: one record, nothing left behind', JSON.stringify(records(s)) === '[3]' && leftovers(s).length === 0, JSON.stringify(records(s)) + leftovers(s));
        }
        // ---------------------------------------------------- aged: a live owner a day past any limit
        {
            const s = scenario('aged');
            const signal = path.join(s.dir, 'held');
            const releaseSignal = path.join(s.dir, 'release');
            const h = run({ role: 'hold', lock: s.lock, signal, releaseSignal });
            expect('aged: the holder acquired', await until(() => fs.existsSync(signal)));
            const old = new Date(Date.now() - 60 * 60 * 1000);
            fs.utimesSync(s.lock, old, old);
            const w = await writer(s, 1, 3000, { AUTODEV_LOCK_TEST_SKEW_MS: String(DAY_MS) }).result;
            expect('aged: a live owner is never displaced by age', w.json && w.json.acquired === false && /is running/.test(w.json.why), w.out + w.err);
            fs.writeFileSync(releaseSignal, '');
            const rel = await h.result;
            expect('aged: the holder releases its own lock', rel.json && rel.json.released === true, rel.out + rel.err);
            const after = await writer(s, 2, 5000).result;
            expect('aged: the next writer acquires after the release', after.json && after.json.acquired && !after.json.reclaimed, after.out + after.err);
        }
        // ---------------------------------------------------- reused: the pid now belongs to a later process
        {
            const s = scenario('reused');
            const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore', windowsHide: true });
            try {
                const g = require(path.join(path.dirname(SUBJECT), 'gate-identity.js'));
                await wait(300);
                const snap = g.snapshot();
                const real = snap.ok && snap.procs.get(sleeper.pid);
                expect('reused: the sleeper is listed with a creation time', real && real.startUtc, snap.why);
                const old = new Date(Date.now() - 60 * 60 * 1000);
                const plant = (start) => {
                    fs.writeFileSync(s.lock, JSON.stringify({ pid: sleeper.pid, start, token: 'ghost' }));
                    fs.utimesSync(s.lock, old, old);
                };
                plant(new Date(Date.parse(real.startUtc)).toISOString());
                const same = await writer(s, 1, 3000).result;
                expect('reused: the same process at that pid keeps its lock', same.json && same.json.acquired === false, same.out + same.err);
                plant('2000-01-01T00:00:00.000Z');
                const later = await writer(s, 2, 10000).result;
                expect('reused: a later process at that pid does not', later.json && later.json.acquired && /now belongs to a process created/.test(later.json.reclaimed || ''), later.out + later.err);
                expect('reused: one record, nothing left behind', JSON.stringify(records(s)) === '[2]' && leftovers(s).length === 0, JSON.stringify(records(s)) + leftovers(s));
            } finally { sleeper.kill('SIGKILL'); }
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    const crash = fails.length ? 'FAIL' : 'PASS';
    for (const f of fails) process.stderr.write(`FAIL ${f}\n`);
    process.stdout.write(`writers=${WRITERS} committed=${committed} overlap=${overlap} foreign_release=${foreignRelease} crash_points=${crash}\n`);
    if (fails.length || committed !== WRITERS || overlap !== 0 || foreignRelease !== 0) process.exitCode = 1;
}
