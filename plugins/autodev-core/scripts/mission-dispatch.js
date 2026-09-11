#!/usr/bin/env node
'use strict';
/**
 * mission-dispatch.js — start ONE worker for a claimed mission through a supported
 * adapter, and read back what actually started (backlog item B06).
 *
 * WHY. A dispatch record in a conversation says "started"; a chip says "clickable";
 * a redispatch proposal says "restartable". None is a process. This script is the
 * boundary where a request becomes a real child with a pid, a cwd, a base and an
 * identity registered in the mission store, or an explicit non-start.
 *
 * WHAT IT DOES. `start`: claims the mission for the owner (or reuses the owner's
 * live claim), records a launch (`prepare-start`), spends one bootstrap permit
 * (`authorize-bootstrap`), forks the worker with an argv array and no shell in the
 * contract's repository root, hands it the assignment over IPC, waits for the
 * worker to register itself with the store, and reads back cwd, HEAD and origin
 * as the worker reports them. A readback that disagrees with the contract ends the
 * worker and fails the attempt as `admission`. On close it writes a private close
 * receipt BEFORE touching the store, then records the terminal observation.
 * `reconcile`: after a crash between request and response, reads the launch and
 * any close receipt and never starts a second worker: it reports prepared,
 * terminal (recovered from the receipt), live, or unknown, and holds the claim.
 *
 * WHAT IT IS NOT. The only adapter is `local-node`: a Node script speaking the IPC
 * protocol below. Any other adapter, or a missing worker script, is reported as
 * `awaiting-start` and nothing is recorded. There is no scheduler, no model, no
 * result verification (`verified: false` everywhere), and no exactly-once spawn:
 * a permit spent before an uncertain fork stays spent by design.
 *
 * WORKER PROTOCOL (IPC, `process.on('message')`).
 *   parent -> worker  {kind:'assignment', store, fence:{missionId,attemptId,owner,generation},
 *                      nonce, contract, operationKey}
 *   worker -> parent  {kind:'registered', identity:{host,pid,nonce}, cwd, head, origin}
 *                     after calling the store's register-executor with that identity
 *   worker -> parent  {kind:'completion', hookStatus, nativeStatus}   before exit 0
 *   worker -> parent  {kind:'refused', code}                           before exit 1
 * The worker owns its result: it enqueues through the store itself.
 *
 * HOST. Needs node:sqlite and POSIX ownership checks through the store; anywhere
 * else every command answers `runtime-unavailable`.
 *
 * Usage:
 *   node mission-dispatch.js start --store <dir> --mission <id> --owner <name> \
 *        --adapter local-node --worker <script.js> [--wait-ms 600000] [--register-ms 30000]
 *   node mission-dispatch.js reconcile --store <dir> --mission <id> --owner <name> \
 *        --attempt <id> --generation <n>
 * Output: {"ok":true,"value":{...}} exit 0; {"ok":false,"error":{"code","message"}} exit 1;
 *         an explicit non-start ({"state":"awaiting-start"}) exits 2.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { execute, canonical } = require('./mission-store.js');

const USAGE = [
    'Usage: node mission-dispatch.js start --store <dir> --mission <id> --owner <name> --adapter local-node --worker <script.js> [--wait-ms N] [--register-ms N]',
    '       node mission-dispatch.js reconcile --store <dir> --mission <id> --owner <name> --attempt <id> --generation <n>',
    'start: claim (or reuse the owner\'s live claim), prepare-start, authorize-bootstrap, fork the',
    '       worker in the contract root, read back its cwd/HEAD/origin, observe it to close.',
    'reconcile: after a crash, report prepared | terminal (from the close receipt) | live | unknown;',
    '       never starts a second worker. Exit 0 ok, 1 error, 2 explicit non-start (awaiting-start).',
    'Adapters: local-node only; anything else is awaiting-start, not an error.',
].join('\n') + '\n';

const ADAPTERS = ['local-node'];
function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }
function word(s) { return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s); }

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const eq = a.indexOf('='); const key = eq > 0 ? a.slice(2, eq) : a.slice(2); const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined) fault('usage', `--${key} needs a value`);
        if (Object.prototype.hasOwnProperty.call(out, key)) fault('usage', `--${key} given twice`);
        out[key] = value;
    }
    const known = ['_', 'help', 'store', 'mission', 'owner', 'adapter', 'worker', 'wait-ms', 'register-ms', 'attempt', 'generation'];
    for (const k of Object.keys(out)) if (!known.includes(k)) fault('usage', `unknown flag --${k}`);
    return out;
}
function integer(raw, fallback, name, min, max) {
    if (raw === undefined) return fallback;
    const n = Number(raw); if (!Number.isSafeInteger(n) || n < min || n > max) fault('usage', `--${name} must be an integer in [${min}, ${max}]`);
    return n;
}
function call(store, command, payload) { return execute(command, store, payload); }
const status = (store, missionId) => call(store, 'status', { missionId });
const event = (label) => `${label}:${randomUUID()}`;

// Private, atomic receipt beside the store: written before any store call that
// depends on it, so a crash between the two leaves the receipt, never a lie.
function atomicWrite(file, value) {
    const temp = file + '.' + randomUUID() + '.tmp'; let fd;
    try {
        fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
        fs.renameSync(temp, file);
        const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { if (fd !== null && fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function readReceipt(file) {
    const st = fs.lstatSync(file, { throwIfNoEntry: false }); if (!st) return null;
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) fault('invalid-receipt', 'close receipt is not a private regular file: ' + file);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const closeReceiptPath = (store, attemptId, nonce) => path.join(store, `close-${attemptId}-${nonce}.json`);
const requestReceiptPath = (store, attemptId) => path.join(store, `dispatch-${attemptId}.json`);

function fenceFor(store, missionId, owner) {
    const s = status(store, missionId); const m = s.mission;
    if (m.state === 'claimed' && m.owner === owner) return { fence: { missionId, attemptId: m.activeAttempt, owner, generation: m.generation }, status: s, claimed: false };
    if (['ready', 'retry-wait'].includes(m.state)) {
        const a = call(store, 'claim', { missionId, eventId: event('claim'), owner });
        return { fence: { missionId, attemptId: a.attemptId, owner, generation: a.generation }, status: status(store, missionId), claimed: true };
    }
    fault(m.state === 'claimed' ? 'claim-conflict' : 'mission-not-claimable', `mission ${missionId} is ${m.state}` + (m.owner ? ` (owner ${m.owner})` : ''));
}

function realOrNull(p) { try { return fs.realpathSync.native(p); } catch { return null; } }

async function start(opts) {
    for (const r of ['store', 'mission', 'owner', 'adapter', 'worker']) if (!opts[r]) fault('usage', `--${r} is required for start`);
    if (!word(opts.mission) || !word(opts.owner)) fault('usage', '--mission and --owner must be mission words');
    const store = path.resolve(opts.store);
    const waitMs = integer(opts['wait-ms'], 600000, 'wait-ms', 1000, 86400000);
    const registerMs = integer(opts['register-ms'], 30000, 'register-ms', 100, 3600000);

    // Capability first: an unsupported adapter or a missing worker is a non-start,
    // reported as such, with nothing recorded and no permit spent.
    const worker = path.resolve(opts.worker);
    const workerStat = fs.statSync(worker, { throwIfNoEntry: false });
    if (!ADAPTERS.includes(opts.adapter)) return { exit: 2, value: { state: 'awaiting-start', reason: 'adapter-unsupported', adapter: opts.adapter, supported: ADAPTERS, verified: false } };
    if (!workerStat || !workerStat.isFile()) return { exit: 2, value: { state: 'awaiting-start', reason: 'worker-missing', worker, verified: false } };

    const { fence, status: s0, claimed } = fenceFor(store, opts.mission, opts.owner);
    const contract = s0.mission.contract;
    const existing = s0.launches.find((l) => l.attempt_id === fence.attemptId);
    if (existing) return { exit: 0, value: { state: 'already-requested', launch: existing.state, ...reconcileLaunch(store, fence, s0), hint: 'use reconcile; a second start never spawns beside an existing launch' } };

    const operationKey = `dispatch:${fence.attemptId}`;
    call(store, 'prepare-start', { ...fence, eventId: event('prepare'), operationKey, expectedRevision: status(store, opts.mission).mission.revision });
    const nonce = randomUUID();
    call(store, 'authorize-bootstrap', { ...fence, eventId: event('bootstrap'), nonce });
    atomicWrite(requestReceiptPath(store, fence.attemptId), { fence, operationKey, nonce, adapter: opts.adapter, worker, cwd: contract.repo.root, requestedAt: new Date().toISOString() });

    const child = fork(worker, [], { cwd: contract.repo.root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const messages = []; let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; }); child.stdout.resume();
    child.on('message', (m) => messages.push(m));
    const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    child.on('error', (e) => messages.push({ kind: 'spawn-error', code: e.code }));
    child.send({ kind: 'assignment', store, fence, nonce, contract, operationKey });
    const identity = { host: os.hostname(), pid: child.pid, nonce };

    // Registration: the worker registers itself with the store and reports what it
    // sees. We accept only an identity the store now holds, then compare the readback.
    const registered = await waitFor(() => messages.find((m) => m.kind === 'registered' || m.kind === 'refused' || m.kind === 'spawn-error'), registerMs, closed);
    const finish = async (extra) => {
        const end = await closed;
        const observation = terminalObservation(messages, end);
        atomicWrite(closeReceiptPath(store, fence.attemptId, nonce), { fence, identity, observation, source: 'owned-child-close', signal: end.signal, closedAt: new Date().toISOString() });
        const launch = status(store, opts.mission).launches.find((l) => l.attempt_id === fence.attemptId);
        if (launch && launch.identity_json === canonical(identity)) call(store, 'observe-worker', { ...fence, eventId: event('close'), identity, observation });
        return { end, observation, launchState: launch ? (launch.identity_json === canonical(identity) ? 'terminal' : launch.state) : 'missing', ...extra };
    };
    if (!registered || registered.kind !== 'registered') {
        const r = await finish({});
        // Closed without registering: the launch is still `prepared`; failing it marks never-started.
        call(store, 'fail', { ...fence, eventId: event('fail'), code: 'admission' });
        return { exit: 0, value: { state: 'never-started', attemptId: fence.attemptId, nonce, exitCode: r.end.code, signal: r.end.signal, refused: registered && registered.kind === 'refused' ? registered.code : null, stderr: stderr.slice(0, 500), verified: false } };
    }
    const launchNow = status(store, opts.mission).launches.find((l) => l.attempt_id === fence.attemptId);
    const readback = { pid: registered.identity && registered.identity.pid, cwd: registered.cwd, head: registered.head, origin: registered.origin };
    const problems = [];
    if (!launchNow || launchNow.state !== 'registered' || launchNow.identity_json !== canonical(identity)) problems.push('store identity differs from the child we forked');
    if (realOrNull(readback.cwd) !== contract.repo.root) problems.push(`cwd ${readback.cwd} is not the contract root ${contract.repo.root}`);
    if (readback.head !== contract.repo.baseSha) problems.push(`HEAD ${readback.head} is not the contract base ${contract.repo.baseSha}`);
    if (problems.length) {
        child.kill('SIGKILL'); const r = await finish({});
        call(store, 'fail', { ...fence, eventId: event('fail'), code: 'admission' });
        return { exit: 0, value: { state: 'refused-readback', attemptId: fence.attemptId, identity, readback, problems, launchState: r.launchState, verified: false } };
    }
    const done = await Promise.race([closed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), waitMs).unref())]);
    if (!done) {
        // Still running past the wait: report it as running, hand the child off, never kill.
        child.unref(); if (child.channel) child.disconnect();
        return { exit: 0, value: { state: 'running', attemptId: fence.attemptId, identity, readback, claimed, receipt: requestReceiptPath(store, fence.attemptId), verified: false } };
    }
    const r = await finish({});
    return { exit: 0, value: { state: r.launchState === 'terminal' ? 'terminal' : 'closed-unobserved', attemptId: fence.attemptId, identity, readback, claimed, exitCode: r.end.code, signal: r.end.signal, observation: r.observation, receipt: closeReceiptPath(store, fence.attemptId, nonce), verified: false, executionObserved: r.launchState === 'terminal' } };
}
function terminalObservation(messages, end) {
    const completion = messages.find((m) => m.kind === 'completion');
    return { kind: 'terminal', exitCode: end.code === null ? null : end.code, hookStatus: completion && ['completed', 'blocked', 'failed', 'unknown'].includes(completion.hookStatus) ? completion.hookStatus : 'unknown', nativeStatus: completion && ['completed', 'failed', 'unknown'].includes(completion.nativeStatus) ? completion.nativeStatus : 'unknown' };
}
function waitFor(probe, ms, closed) {
    return new Promise((resolve) => {
        let settled = false; const settle = (v) => { if (!settled) { settled = true; clearInterval(iv); clearTimeout(to); resolve(v); } };
        const iv = setInterval(() => { const v = probe(); if (v) settle(v); }, 10);
        const to = setTimeout(() => settle(null), ms);
        closed.then(() => setTimeout(() => settle(probe() || null), 20));
    });
}

// Reconcile: read, never spawn. The claim is held while the disposition is unknown.
function reconcileLaunch(store, fence, s) {
    const launch = s.launches.find((l) => l.attempt_id === fence.attemptId);
    if (!launch) return { state: 'not-requested' };
    if (launch.state === 'never-started' || launch.state === 'terminal') return { state: launch.state, observation: launch.observation_json ? JSON.parse(launch.observation_json) : null };
    if (launch.state === 'prepared') return { state: 'prepared', executionObserved: false, hint: 'awaiting-start: no worker registered; a retry needs a new attempt after fail' };
    const identity = JSON.parse(launch.identity_json);
    const receipt = readReceipt(closeReceiptPath(store, fence.attemptId, identity.nonce));
    if (receipt) {
        if (canonical(receipt.fence) !== canonical(fence) || canonical(receipt.identity) !== canonical(identity) || receipt.source !== 'owned-child-close') fault('close-receipt-mismatch', 'the close receipt does not describe this launch');
        call(store, 'observe-worker', { ...fence, eventId: event('recover'), identity, observation: receipt.observation });
        return { state: 'terminal', recovered: true, observation: receipt.observation };
    }
    let alive = false; try { process.kill(identity.pid, 0); alive = true; } catch { alive = false; }
    if (alive && identity.host === os.hostname()) {
        call(store, 'observe-worker', { ...fence, eventId: event('observe'), identity, observation: { kind: 'live', exitCode: null, hookStatus: 'unknown', nativeStatus: 'unknown' } });
        return { state: 'live', identity, reservationHeld: true, hint: 'pid alive on this host; identity is pid+nonce, not a proof of the same process' };
    }
    try { call(store, 'poll-worker', { ...fence, eventId: event('poll') }); }
    catch (e) { if (['backoff-active', 'reconciliation-exhausted'].includes(e.publicCode)) return { state: e.publicCode, identity, reservationHeld: true }; throw e; }
    call(store, 'observe-worker', { ...fence, eventId: event('observe'), identity, observation: { kind: 'unknown', exitCode: null, hookStatus: 'unknown', nativeStatus: 'unknown' } });
    const outbox = s.outbox.filter((b) => b.attempt_id === fence.attemptId).map((b) => b.state);
    return { state: 'unknown', identity, reservationHeld: true, outbox, hint: outbox.length ? 'the worker enqueued a result before it was lost; disposition still unknown' : 'no result and no receipt; do not spawn a second worker' };
}
function reconcile(opts) {
    for (const r of ['store', 'mission', 'owner', 'attempt', 'generation']) if (!opts[r]) fault('usage', `--${r} is required for reconcile`);
    const store = path.resolve(opts.store);
    const fence = { missionId: opts.mission, attemptId: opts.attempt, owner: opts.owner, generation: integer(opts.generation, undefined, 'generation', 1, Number.MAX_SAFE_INTEGER) };
    const s = status(store, opts.mission);
    if (s.mission.activeAttempt !== fence.attemptId || s.mission.owner !== fence.owner || s.mission.generation !== fence.generation) return { exit: 0, value: { state: 'stale-owner', current: { attemptId: s.mission.activeAttempt, owner: s.mission.owner, generation: s.mission.generation }, verified: false } };
    return { exit: 0, value: { attemptId: fence.attemptId, ...reconcileLaunch(store, fence, s), verified: false } };
}

module.exports = { start, reconcile, parseArgs };

if (require.main === module) {
    (async () => {
        try {
            const opts = parseArgs(process.argv.slice(2));
            if (opts.help || !opts._.length) { process.stdout.write(USAGE); return; }
            const cmd = opts._[0];
            if (opts._.length !== 1 || !['start', 'reconcile'].includes(cmd)) fault('usage', 'command must be start or reconcile');
            const r = cmd === 'start' ? await start(opts) : reconcile(opts);
            process.stdout.write(JSON.stringify({ ok: true, value: r.value }) + '\n'); process.exitCode = r.exit;
        } catch (e) {
            const code = e.publicCode || 'error';
            process.stdout.write(JSON.stringify({ ok: false, error: { code, message: e.publicCode ? e.message : code } }) + '\n'); process.exitCode = 1;
        }
    })();
}
