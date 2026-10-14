#!/usr/bin/env node
'use strict';
/**
 * ask-queue.js - the local canonical queue of asks, with a durable outbox per ask.
 *
 * WHY. An ask used to live only on the Open Loops board or as a line in the Inbox mirror. A session
 * whose account could not reach the board had nowhere durable to put it, and a line re-applied after
 * a crash could land twice. Here accepting an ask writes only a local record, so ingestion works under
 * any account. Delivery to the board is a separate, fenced step that the queue reconciles.
 *
 * RECORD. <queue>/intents/<intentId>.json, one per ask, written by temp file and rename under the
 * per-record ledger lock. <queue> is ASK_QUEUE_DIR, else <claude dir>/autodev/ask-queue, where
 * <claude dir> is BRAIN_CLOCK_CLAUDE_DIR, else ~/.claude.
 *   intentId   ask- plus a hash of source and key. The key defaults to the body, so the same ask
 *              accepted twice is one intent.
 *   revs       every body ever accepted or edited, each with its parents. A head is a rev no other
 *              rev names as parent. Two heads is a conflict: both are kept and nothing is delivered
 *              until `resolve` merges them.
 *   fence      the highest attempt epoch ever issued. A claim gets fence + 1. Every write an attempt
 *              makes (start, ack, release) is refused unless its epoch is still the fence, so a stale
 *              claimant cannot write.
 *   claim      { epoch, pid, host, start, at, leaseUntil }. Stale when the lease has passed, or when
 *              the owner is on this host and its pid is gone.
 *   outbox     { epoch, rev, at }, written BEFORE the effect. An outbox with a stale claim means an
 *              effect may have happened with no ack. That intent is HELD and never replayed: only
 *              `reconcile`, which looks the intent up on the board, clears it.
 *   held       why it is held. deliveries lists each acknowledged delivery with its receipt.
 *
 * VERBS. Each prints one JSON line: { ok: true, value } or { ok: false, error: { code, message } }.
 *   accept --source <s> --body <text> [--key <k>] [--by <who>]
 *   edit --intent <id> --base-rev <n> --body <text> [--by <who>]
 *   resolve --intent <id> --body <text> [--by <who>]   merges every head into one rev
 *   claim --intent <id> [--lease-ms 600000]             a fenced attempt: { epoch, rev, body }
 *   start --intent <id> --epoch <n>                     the outbox mark, just before the effect
 *   ack --intent <id> --epoch <n> [--receipt <text>]    the effect landed
 *   release --intent <id> --epoch <n>                   no effect happened (access denied)
 *   dispatch --intent <id> [--lease-ms]                 claim, start, the board adapter, then ack
 *   drain [--lease-ms]                                  dispatch every deliverable intent
 *   reconcile --intent <id>                             look a held intent up on the board
 *   status                                              counts by state
 * Exit codes: 0 done, 1 a named failure, 4 refused by the fence.
 *
 * A session that writes the board itself uses claim, start, ack (or release). A script uses dispatch
 * or drain with a board adapter: ASK_QUEUE_BOARD, else askQueue.board in
 * <claude dir>/autodev/runtime/config.json. The adapter is a node script run as `deliver` or `lookup`
 * with the intent JSON on stdin. deliver exits 0 with { receipt } on stdout, or 3 when access was
 * denied and nothing was written. Any other outcome is uncertain, and the intent is HELD. lookup exits
 * 0 with { found }, or 3 when denied. With no adapter an ask stays retained, never lost.
 *
 * Test seams, for tooling/test-queue-recovery.js: ASK_QUEUE_CRASH_AT=<point> kills this process at that
 * point, ASK_QUEUE_PAUSE_AT=<point> with ASK_QUEUE_PAUSE_FILE=<file> waits there until <file> exists.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ledgerLock = require('./ledger-lock.js');

const CLAUDE_DIR = process.env.BRAIN_CLOCK_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const AUTODEV = path.join(CLAUDE_DIR, 'autodev');
const SCHEMA = 1;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const ADAPTER_TIMEOUT_MS = 60 * 1000;
const LOCK_WAIT_MS = 10 * 1000;
const PAUSE_MAX_MS = 60 * 1000;
const OWN_START = new Date(Date.now() - process.uptime() * 1000).toISOString();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

class Refusal extends Error {
    constructor(code, message, exit = 1) { super(message); this.code = code; this.exit = exit; }
}

function queueDir() { return process.env.ASK_QUEUE_DIR || path.join(AUTODEV, 'ask-queue'); }
function intentsDir() { return path.join(queueDir(), 'intents'); }
function recordPath(id) {
    if (!/^ask-[0-9a-f]{20}$/.test(String(id))) throw new Refusal('bad-intent', `not an intent id: ${String(id).slice(0, 60)}`);
    return path.join(intentsDir(), `${id}.json`);
}
function intentIdOf(source, key) {
    return 'ask-' + crypto.createHash('sha256').update(`${source}\u0000${key}`).digest('hex').slice(0, 20);
}

// ---------- test seams ----------
function point(name) {
    if (process.env.ASK_QUEUE_CRASH_AT === name) process.kill(process.pid, 'SIGKILL');
    if (process.env.ASK_QUEUE_PAUSE_AT === name && process.env.ASK_QUEUE_PAUSE_FILE) {
        const gate = process.env.ASK_QUEUE_PAUSE_FILE;
        fs.writeFileSync(`${gate}.reached`, String(process.pid));
        const until = Date.now() + PAUSE_MAX_MS;
        while (!fs.existsSync(gate) && Date.now() < until) Atomics.wait(sleeper, 0, 0, 20);
    }
}

// ---------- the record ----------
function readRecord(id) {
    const file = recordPath(id);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const rec = JSON.parse(text);
    if (!rec || rec.intentId !== id || !Array.isArray(rec.revs)) throw new Refusal('unreadable', `the record of ${id} is not an intent record`);
    return rec;
}
function writeRecord(rec, crashName) {
    const file = recordPath(rec.intentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    if (crashName) point(crashName);
    try { fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}
// Every read-modify-write of one record runs under its ledger lock.
function locked(id, fn) {
    return ledgerLock.withLedgerLock(recordPath(id), () => fn(readRecord(id)), { waitMs: LOCK_WAIT_MS });
}
function mustExist(rec, id) {
    if (!rec) throw new Refusal('no-intent', `no intent ${id} in the queue`);
    return rec;
}
function heads(rec) {
    const parents = new Set(rec.revs.flatMap((r) => r.parents));
    return rec.revs.filter((r) => !parents.has(r.rev));
}
function headRev(rec) { const h = heads(rec); return h.length === 1 ? h[0] : null; }
function addRev(rec, parents, body, by) {
    const rev = rec.revs.length + 1;
    rec.revs.push({ rev, parents, body, by: by || null, at: new Date().toISOString() });
    return rev;
}

function claimStale(claim, now) {
    if (!claim) return true;
    if (now > claim.leaseUntil) return true;
    if (claim.host !== os.hostname()) return false;
    const judged = ledgerLock.judgeOwner({ pid: claim.pid, start: claim.start }, { mtimeMs: Date.parse(claim.at) || 0 });
    return !judged.alive;
}
function stateOf(rec, now = Date.now()) {
    if (heads(rec).length > 1) return 'conflict';
    if (rec.held) return 'held';
    if (rec.outbox) return claimStale(rec.claim, now) ? 'unacknowledged' : 'in-flight';
    if (rec.claim && !claimStale(rec.claim, now)) return 'claimed';
    return rec.deliveredRev === headRev(rec).rev ? 'delivered' : 'pending';
}

// ---------- accept and edit ----------
function accept({ source, body, key, by }) {
    if (typeof source !== 'string' || !source) throw new Refusal('usage', 'accept needs --source');
    if (typeof body !== 'string' || !body.trim()) throw new Refusal('usage', 'accept needs a non-empty --body');
    const k = typeof key === 'string' && key ? key : body;
    const id = intentIdOf(source, k);
    return locked(id, (rec) => {
        if (rec) {
            if (rec.revs.some((r) => r.body === body)) return { intentId: id, created: false, state: stateOf(rec) };
            // The same key with another body and no base: a second root, kept beside the first.
            const rev = addRev(rec, [], body, by);
            writeRecord(rec);
            return { intentId: id, created: false, rev, state: stateOf(rec) };
        }
        const fresh = { schema: SCHEMA, intentId: id, source, key: k, acceptedAt: new Date().toISOString(), revs: [], fence: 0, claim: null, outbox: null, held: null, deliveredRev: null, deliveries: [] };
        addRev(fresh, [], body, by);
        writeRecord(fresh, 'accept-before-publish');
        point('after-accept');
        return { intentId: id, created: true, state: 'pending' };
    });
}
function edit({ intent, baseRev, body, by }) {
    const base = Number(baseRev);
    if (!Number.isInteger(base) || base < 1) throw new Refusal('usage', 'edit needs --base-rev <n>');
    if (typeof body !== 'string' || !body.trim()) throw new Refusal('usage', 'edit needs a non-empty --body');
    return locked(intent, (r) => {
        const rec = mustExist(r, intent);
        if (!rec.revs.some((x) => x.rev === base)) throw new Refusal('no-rev', `${intent} has no rev ${base}`);
        // An edit names the rev it read. If that rev is no longer a head, someone else edited first:
        // the new rev branches from the base, and both heads are kept.
        const rev = addRev(rec, [base], body, by);
        writeRecord(rec);
        return { intentId: intent, rev, conflict: heads(rec).length > 1, state: stateOf(rec) };
    });
}
function resolve({ intent, body, by }) {
    if (typeof body !== 'string' || !body.trim()) throw new Refusal('usage', 'resolve needs a non-empty --body');
    return locked(intent, (r) => {
        const rec = mustExist(r, intent);
        const hs = heads(rec).map((h) => h.rev);
        const rev = addRev(rec, hs, body, by);
        writeRecord(rec);
        return { intentId: intent, rev, merged: hs, state: stateOf(rec) };
    });
}

// ---------- the fenced attempt ----------
function claim({ intent, leaseMs }) {
    const lease = leaseMs === undefined ? DEFAULT_LEASE_MS : Number(leaseMs);
    if (!(lease > 0)) throw new Refusal('usage', '--lease-ms needs a positive number');
    const now = Date.now();
    return locked(intent, (r) => {
        const rec = mustExist(r, intent);
        const st = stateOf(rec, now);
        if (st === 'unacknowledged') {
            // An effect may have happened with no ack. Hold it and retire the old epoch.
            rec.fence += 1;
            rec.held = { reason: `epoch ${rec.outbox.epoch} started an effect on rev ${rec.outbox.rev} and never acknowledged it`, at: new Date(now).toISOString(), epoch: rec.outbox.epoch };
            rec.claim = null;
            writeRecord(rec);
            return { intentId: intent, claimed: false, state: 'held' };
        }
        if (st !== 'pending') return { intentId: intent, claimed: false, state: st };
        rec.fence += 1;
        const head = headRev(rec);
        rec.claim = { epoch: rec.fence, pid: process.pid, host: os.hostname(), start: OWN_START, at: new Date(now).toISOString(), leaseUntil: now + lease };
        writeRecord(rec);
        return { intentId: intent, claimed: true, epoch: rec.fence, rev: head.rev, body: head.body, source: rec.source, key: rec.key };
    });
}
function fenced(rec, intent, epoch, what) {
    const e = Number(epoch);
    if (!rec.claim || rec.fence !== e || rec.claim.epoch !== e) {
        throw new Refusal('fenced', `${what} for ${intent} refused: epoch ${epoch} is not the live claim (fence ${rec.fence})`, 4);
    }
}
function start({ intent, epoch }) {
    return locked(intent, (r) => {
        const rec = mustExist(r, intent);
        fenced(rec, intent, epoch, 'start');
        const head = headRev(rec);
        if (!head) throw new Refusal('conflict', `${intent} has conflicting heads, resolve them first`);
        rec.outbox = { epoch: Number(epoch), rev: head.rev, at: new Date().toISOString() };
        writeRecord(rec);
        return { intentId: intent, epoch: Number(epoch), rev: head.rev };
    });
}
function ack({ intent, epoch, receipt }) {
    return locked(intent, (r) => {
        const rec = mustExist(r, intent);
        fenced(rec, intent, epoch, 'ack');
        if (!rec.outbox || rec.outbox.epoch !== Number(epoch)) throw new Refusal('no-outbox', `ack for ${intent} refused: epoch ${epoch} never started an effect`);
        rec.deliveredRev = rec.outbox.rev;
        rec.deliveries.push({ rev: rec.outbox.rev, epoch: Number(epoch), at: new Date().toISOString(), receipt: receipt === undefined ? null : receipt });
        rec.outbox = null;
        rec.claim = null;
        writeRecord(rec);
        return { intentId: intent, delivered: rec.deliveredRev };
    });
}
function release({ intent, epoch }) {
    return locked(intent, (r) => {
        const rec = mustExist(r, intent);
        fenced(rec, intent, epoch, 'release');
        rec.outbox = null;
        rec.claim = null;
        writeRecord(rec);
        return { intentId: intent, state: stateOf(rec) };
    });
}
function hold(intent, epoch, reason) {
    return locked(intent, (r) => {
        const rec = mustExist(r, intent);
        fenced(rec, intent, epoch, 'hold');
        rec.fence += 1;
        rec.held = { reason, at: new Date().toISOString(), epoch: Number(epoch) };
        rec.claim = null;
        writeRecord(rec);
        return { intentId: intent, state: 'held' };
    });
}

// ---------- the board adapter ----------
function runtimeConfig() {
    try {
        const c = JSON.parse(fs.readFileSync(path.join(AUTODEV, 'runtime', 'config.json'), 'utf8'));
        return c && c.askQueue && typeof c.askQueue === 'object' ? c.askQueue : {};
    } catch { return {}; }
}
function adapterPath() {
    const p = process.env.ASK_QUEUE_BOARD || runtimeConfig().board;
    return typeof p === 'string' && p ? p : null;
}
function callAdapter(verb, payload) {
    const adapter = adapterPath();
    if (!adapter) return { outcome: 'no-adapter' };
    const r = spawnSync(process.execPath, [adapter, verb], { input: JSON.stringify(payload), encoding: 'utf8', timeout: ADAPTER_TIMEOUT_MS, windowsHide: true });
    if (r.error || r.status === null) return { outcome: 'uncertain', why: r.error ? r.error.code || r.error.message : `killed by ${r.signal}` };
    if (r.status === 3) return { outcome: 'denied' };
    if (r.status !== 0) return { outcome: 'uncertain', why: `exit ${r.status}: ${String(r.stderr || '').trim().slice(0, 200)}` };
    try { return { outcome: 'ok', value: JSON.parse(r.stdout) }; }
    catch { return { outcome: 'uncertain', why: 'the adapter exited 0 with no JSON' }; }
}

function dispatch({ intent, leaseMs }) {
    const c = claim({ intent, leaseMs });
    if (!c.claimed) return { intentId: intent, outcome: c.state === 'delivered' ? 'already-delivered' : c.state };
    point('after-claim');
    if (!adapterPath()) {
        release({ intent, epoch: c.epoch });
        return { intentId: intent, outcome: 'retained', why: 'no board adapter' };
    }
    start({ intent, epoch: c.epoch });
    point('after-outbox');
    const res = callAdapter('deliver', { intentId: intent, epoch: c.epoch, rev: c.rev, body: c.body, source: c.source, key: c.key });
    point('after-effect');
    if (res.outcome === 'denied') {
        release({ intent, epoch: c.epoch });
        return { intentId: intent, outcome: 'retained', why: 'board access denied' };
    }
    if (res.outcome !== 'ok') {
        hold(intent, c.epoch, `the board adapter gave no clear answer (${res.why})`);
        return { intentId: intent, outcome: 'held' };
    }
    ack({ intent, epoch: c.epoch, receipt: res.value && res.value.receipt !== undefined ? res.value.receipt : null });
    point('after-ack');
    return { intentId: intent, outcome: 'delivered', rev: c.rev, epoch: c.epoch };
}

function listIds() {
    let names;
    try { names = fs.readdirSync(intentsDir()); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names.filter((f) => /^ask-[0-9a-f]{20}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
}
function drain({ leaseMs }) {
    const counts = {};
    const results = [];
    for (const id of listIds()) {
        let r;
        try { r = dispatch({ intent: id, leaseMs }); }
        catch (e) {
            if (!(e instanceof Refusal) && e.code !== 'LEDGER_LOCKED') throw e;
            r = { intentId: id, outcome: e.code === 'LEDGER_LOCKED' ? 'busy' : e.code };
        }
        counts[r.outcome] = (counts[r.outcome] || 0) + 1;
        results.push(r);
    }
    return { counts, results };
}

function reconcile({ intent }) {
    const rec = mustExist(readRecord(intent), intent);
    const st = stateOf(rec);
    if (st !== 'held' && st !== 'unacknowledged') return { intentId: intent, state: st, reconciled: false };
    if (st === 'unacknowledged') claim({ intent });
    const now = mustExist(readRecord(intent), intent);
    const rev = now.outbox ? now.outbox.rev : headRev(now) && headRev(now).rev;
    const res = callAdapter('lookup', { intentId: intent, rev });
    if (res.outcome !== 'ok' || typeof (res.value && res.value.found) !== 'boolean') {
        return { intentId: intent, state: 'held', reconciled: false, why: res.outcome === 'ok' ? 'the lookup gave no found flag' : res.outcome };
    }
    return locked(intent, (r) => {
        const cur = mustExist(r, intent);
        if (res.value.found) {
            cur.deliveredRev = rev;
            cur.deliveries.push({ rev, epoch: cur.held ? cur.held.epoch : null, at: new Date().toISOString(), receipt: res.value.receipt === undefined ? 'found by reconcile' : res.value.receipt });
        }
        cur.held = null;
        cur.outbox = null;
        cur.claim = null;
        writeRecord(cur);
        return { intentId: intent, state: stateOf(cur), reconciled: true, found: res.value.found };
    });
}

function status() {
    const counts = { pending: 0, claimed: 0, 'in-flight': 0, unacknowledged: 0, held: 0, conflict: 0, delivered: 0, unreadable: 0 };
    const intents = {};
    const now = Date.now();
    for (const id of listIds()) {
        let st;
        try { st = stateOf(readRecord(id), now); } catch { st = 'unreadable'; }
        counts[st] += 1;
        intents[id] = st;
    }
    return { total: Object.keys(intents).length, counts, intents, adapter: adapterPath() ? 'configured' : 'none' };
}

// ---------- CLI ----------
function args(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
            else { out[a.slice(2)] = next; i++; }
        } else out._.push(a);
    }
    return out;
}
const VERBS = {
    accept: (o) => accept({ source: o.source, body: o.body, key: o.key, by: o.by }),
    edit: (o) => edit({ intent: o.intent, baseRev: o['base-rev'], body: o.body, by: o.by }),
    resolve: (o) => resolve({ intent: o.intent, body: o.body, by: o.by }),
    claim: (o) => claim({ intent: o.intent, leaseMs: o['lease-ms'] }),
    start: (o) => start({ intent: o.intent, epoch: o.epoch }),
    ack: (o) => ack({ intent: o.intent, epoch: o.epoch, receipt: o.receipt }),
    release: (o) => release({ intent: o.intent, epoch: o.epoch }),
    dispatch: (o) => dispatch({ intent: o.intent, leaseMs: o['lease-ms'] }),
    drain: (o) => drain({ leaseMs: o['lease-ms'] }),
    reconcile: (o) => reconcile({ intent: o.intent }),
    status: () => status(),
};
function main(argv) {
    const o = args(argv);
    const verb = VERBS[o._[0]];
    try {
        if (!verb) throw new Refusal('usage', `unknown verb ${o._[0] || '(none)'}. Verbs: ${Object.keys(VERBS).join(', ')}`);
        process.stdout.write(JSON.stringify({ ok: true, value: verb(o) }) + '\n');
        return 0;
    } catch (e) {
        const r = e instanceof Refusal ? e : new Refusal(e && e.code === 'LEDGER_LOCKED' ? 'busy' : 'error', String(e && e.message || e));
        process.stdout.write(JSON.stringify({ ok: false, error: { code: r.code, message: r.message } }) + '\n');
        return r.exit;
    }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { accept, edit, resolve, claim, start, ack, release, dispatch, drain, reconcile, status, stateOf, heads, intentIdOf, listIds, readRecord, queueDir, SCHEMA };
