#!/usr/bin/env node
'use strict';
/**
 * mission-supervisor.js — one bounded supervisor tick (backlog item B08).
 *
 * WHY. The store persists attempts, backoff and exhaustion; the dispatcher
 * starts a worker and reads it back; the consumer delivers its result. Nothing
 * yet decides, from a prd.json and a store, what to do next without a person
 * transporting state between them. This tick does exactly that, once, and
 * stops: it never loops, never sleeps, and never writes prd.json.
 *
 * WHAT ONE TICK DOES, in order, for the stories `workPlan(prd)` says are
 * dependency-ready or that already have a mission in the store:
 *   1. settle: a claimed mission with a launch is reconciled; a terminal launch
 *      has its result delivered; a delivered result that matches the contract
 *      after a clean run (exit 0, hook and native status completed) is accepted
 *      as an envelope, otherwise the attempt is failed with a code the store's
 *      retry policy understands (blocked hook: deterministic; anything else:
 *      transient); a live or unknown worker is left alone and reported.
 *   2. dispatch: a ready mission, or a retry-wait mission whose backoff has
 *      elapsed, is admitted if needed (through mission-contract.js) and started
 *      through mission-dispatch.js, then settled the same way; at most
 *      --max-dispatch starts per tick. With --worktrees <dir> each mission is
 *      admitted in its own detached worktree of the repository at HEAD, because
 *      the store lets one worktree hold one live reservation and an accepted but
 *      unverified attempt still holds it; without the flag, missions sharing the
 *      root queue behind that reservation and are reported as worktree-held.
 *   3. report: exhausted missions, blocked stories (needs-setup, unmet or cyclic
 *      dependencies) and invalid stories are listed by name with their reason;
 *      an accepted envelope is reported as awaiting verification, never done.
 *
 * WHAT IT IS NOT. It does not verify anything (every answer says
 * `verified: false`) and it does not mark a story passed: only an independent
 * verifier may write prd.json. It does not schedule itself; the caller decides
 * when a tick runs. The only adapter is local-node, as in the dispatcher.
 *
 * Usage:
 *   node mission-supervisor.js tick --prd <prd.json> --root <repo> --store <dir> --owner <name> \
 *        --adapter local-node --worker <script.js> [--paths <a,b>] [--worktrees <dir>] \
 *        [--max-dispatch 1] [--wait-ms N] [--max-attempts N] [--backoff-ms N] [--max-backoff-ms N]
 * Output: {"ok":true,"value":{...}} exit 0; {"ok":false,"error":{"code","message"}} exit 1.
 * Attempts, backoff and exhaustion live in the store, so a tick after a restart
 * sees exactly what the last one left.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { execute } = require('./mission-store.js');
const { workPlan, storiesOf } = require('./prd-states.js');
const contract = require('./mission-contract.js');
const dispatch = require('./mission-dispatch.js');
const deliverer = require('./mission-deliver.js');

const USAGE = [
    'Usage: node mission-supervisor.js tick --prd <prd.json> --root <repo> --store <dir> --owner <name>',
    '         --adapter local-node --worker <script.js> [--paths <a,b>] [--worktrees <dir>]',
    '         [--max-dispatch 1] [--wait-ms N] [--max-attempts N] [--backoff-ms N] [--max-backoff-ms N]',
    '--worktrees <dir>: admit each mission in its own detached worktree of the repository at HEAD',
    '         (one worktree holds one live reservation in the store; without it, missions sharing',
    '         the root queue behind an accepted-but-unverified attempt and report worktree-held).',
    'One bounded pass: settle claimed missions (reconcile, deliver, accept or fail), dispatch what is',
    'ready or past its backoff, report exhausted, blocked and invalid by name. Never loops, never',
    'writes prd.json, never verifies; an accepted envelope is reported as awaiting verification.',
].join('\n') + '\n';

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }
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
    const known = ['_', 'help', 'prd', 'root', 'store', 'owner', 'adapter', 'worker', 'paths', 'worktrees', 'max-dispatch', 'wait-ms', 'max-attempts', 'backoff-ms', 'max-backoff-ms'];
    for (const k of Object.keys(out)) if (!known.includes(k)) fault('usage', `unknown flag --${k}`);
    return out;
}
const call = (store, command, payload) => execute(command, store, payload);
function statusOrNull(store, missionId) { try { return call(store, 'status', { missionId }); } catch (e) { if (e.publicCode === 'mission-missing') return null; throw e; } }
const eventId = (label, id) => `${label}:${id}:${Date.now()}:${process.pid}`;

// One detached worktree per mission, created once at the repository's HEAD and
// reused on later ticks. Its git common dir is the repository's, which is what
// the contract records and the store verifies at admission.
function missionRoot(opts, id) {
    if (!opts.worktrees) return opts.root;
    const dir = path.join(path.resolve(opts.worktrees), id);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(path.resolve(opts.worktrees), { recursive: true });
        execFileSync('git', ['-C', path.resolve(opts.root), 'worktree', 'add', '--detach', '-q', dir, 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    }
    return dir;
}

// Settle one claimed mission: reconcile its launch, deliver, then accept or fail.
function settle(opts, store, missionId, s) {
    const fence = { missionId, attemptId: s.mission.activeAttempt, owner: s.mission.owner, generation: s.mission.generation };
    if (s.mission.owner !== opts.owner) return { action: 'held-by-other-owner', owner: s.mission.owner };
    const launch = s.launches.find((l) => l.attempt_id === fence.attemptId);
    if (!launch) return { action: 'claimed-without-launch', hint: 'a claim from outside this supervisor; left alone' };
    if (launch.state === 'prepared' || launch.state === 'registered') {
        const rec = dispatch.reconcile({ store, mission: missionId, owner: fence.owner, attempt: fence.attemptId, generation: String(fence.generation) }).value;
        if (rec.state !== 'terminal') return { action: 'worker-' + rec.state, reservationHeld: true, detail: rec.hint || null };
        s = call(store, 'status', { missionId });
    }
    const current = s.launches.find((l) => l.attempt_id === fence.attemptId);
    if (current.state === 'never-started') return { action: 'never-started', detail: 'the attempt was already failed by the dispatcher' };
    const delivered = deliverer.deliver(store, missionId);
    s = call(store, 'status', { missionId });
    const observation = current.observation_json ? JSON.parse(current.observation_json) : null;
    const result = s.results.find((r) => r.attempt_id === fence.attemptId);
    const clean = observation && observation.exitCode === 0 && observation.hookStatus === 'completed' && observation.nativeStatus === 'completed';
    if (result && result.state === 'envelope-accepted') return { action: 'awaiting-verification', delivered: delivered.delivered.length };
    if (clean && result && result.state === 'received') {
        try { call(store, 'accept-envelope', { ...fence, eventId: 'accept:' + result.id, resultId: result.id }); return { action: 'envelope-accepted', resultId: result.id, delivered: delivered.delivered.length, verified: false }; }
        catch (e) { if (e.publicCode !== 'envelope-mismatch') throw e; const f = call(store, 'fail', { ...fence, eventId: eventId('fail', missionId), code: 'envelope-invalid' }); return { action: 'failed', code: 'envelope-invalid', next: f.state, nextEligibleAt: f.nextEligibleAt }; }
    }
    const code = observation && observation.hookStatus === 'blocked' ? 'deterministic' : 'transient';
    const f = call(store, 'fail', { ...fence, eventId: eventId('fail', missionId), code });
    return { action: 'failed', code, exitCode: observation ? observation.exitCode : null, hookStatus: observation ? observation.hookStatus : null, resultState: result ? result.state : 'none', next: f.state, nextEligibleAt: f.nextEligibleAt };
}

async function tick(opts) {
    for (const r of ['prd', 'root', 'store', 'owner', 'adapter', 'worker']) if (!opts[r]) fault('usage', `--${r} is required`);
    const maxDispatch = Number(opts['max-dispatch'] === undefined ? 1 : opts['max-dispatch']); if (!Number.isInteger(maxDispatch) || maxDispatch < 0) fault('usage', '--max-dispatch must be a non-negative integer');
    const store = path.resolve(opts.store); const prdPath = path.resolve(opts.prd);
    let prd; try { prd = JSON.parse(fs.readFileSync(prdPath, 'utf8')); } catch (e) { fault('prd-unreadable', `${prdPath}: ${e.code || e.name}`); }
    const plan = workPlan(prd); const stories = storiesOf(prd);
    const readyIds = plan.ready.map(([id]) => id);
    const candidates = new Set(readyIds);
    for (const id of Object.keys(stories)) if (!readyIds.includes(id) && statusOrNull(store, id)) candidates.add(id);
    const missions = []; let dispatched = 0; const now = Date.now();
    for (const id of candidates) {
        let s = statusOrNull(store, id);
        const before = s ? s.mission.state : 'unadmitted';
        const row = { id, before };
        try {
            if (s && s.mission.state === 'claimed') { Object.assign(row, settle(opts, store, id, s)); }
            else if (s && ['result-received', 'envelope-accepted'].includes(s.mission.state)) { Object.assign(row, s.mission.state === 'envelope-accepted' ? { action: 'awaiting-verification' } : settle(opts, store, id, { ...s, mission: { ...s.mission, state: 'claimed' } })); }
            else if (s && s.mission.state === 'exhausted') { Object.assign(row, { action: 'exhausted', reason: s.mission.terminalReason, attempts: s.mission.attemptCount }); }
            else if (s && s.mission.state === 'retry-wait' && s.mission.nextEligibleAt !== null && now < s.mission.nextEligibleAt) { Object.assign(row, { action: 'waiting', nextEligibleAt: s.mission.nextEligibleAt, attempts: s.mission.attemptCount }); }
            else if (!readyIds.includes(id) && !s) { Object.assign(row, { action: 'not-ready' }); }
            else if (dispatched >= maxDispatch) { Object.assign(row, { action: 'deferred-this-tick', hint: `--max-dispatch ${maxDispatch} reached` }); }
            else {
                if (!s) {
                    const story = stories[id];
                    const paths = Array.isArray(story.paths) && story.paths.length ? story.paths.join(',') : opts.paths;
                    if (!paths) fault('usage', `story ${id} has no paths and --paths was not given`);
                    const payload = contract.build({ prd: prdPath, story: id, root: missionRoot(opts, id), paths, 'max-attempts': opts['max-attempts'], 'backoff-ms': opts['backoff-ms'], 'max-backoff-ms': opts['max-backoff-ms'] });
                    call(store, 'admit', payload); row.admitted = true;
                }
                dispatched++;
                const started = await dispatch.start({ store, mission: id, owner: opts.owner, adapter: opts.adapter, worker: opts.worker, 'wait-ms': opts['wait-ms'] });
                row.dispatch = started.value.state;
                if (started.value.state === 'terminal' || started.value.state === 'closed-unobserved') { s = call(store, 'status', { missionId: id }); Object.assign(row, settle(opts, store, id, s)); }
                else if (started.value.state === 'awaiting-start') { Object.assign(row, { action: 'awaiting-start', reason: started.value.reason }); }
                else { Object.assign(row, { action: started.value.state }); }
            }
        } catch (e) {
            if (!e.publicCode) throw e;
            // A held worktree is a queue, not a fault: the store allows one live reservation per worktree.
            if (e.publicCode === 'worktree-conflict') { row.action = 'worktree-held'; row.hint = 'another mission holds this worktree until its attempt is released; use --worktrees for one per mission'; }
            else { row.action = 'error'; row.code = e.publicCode; row.message = e.message; }
        }
        const after = statusOrNull(store, id); row.after = after ? after.mission.state : 'unadmitted'; row.attempts = after ? after.mission.attemptCount : 0;
        missions.push(row);
    }
    const totals = {};
    for (const m of missions) totals[m.action || 'none'] = (totals[m.action || 'none'] || 0) + 1;
    return { tick: { at: new Date(now).toISOString(), prd: prdPath, store, dispatched, maxDispatch }, missions, blocked: plan.blocked, invalid: plan.invalid, summary: plan.summary, prdComplete: plan.complete, totals, verified: false };
}

module.exports = { tick, parseArgs };

if (require.main === module) {
    (async () => {
        try {
            const opts = parseArgs(process.argv.slice(2));
            if (opts.help || !opts._.length) { process.stdout.write(USAGE); return; }
            if (opts._.length !== 1 || opts._[0] !== 'tick') fault('usage', 'command must be tick');
            process.stdout.write(JSON.stringify({ ok: true, value: await tick(opts) }) + '\n');
        } catch (e) {
            const code = e.publicCode || 'error';
            process.stdout.write(JSON.stringify({ ok: false, error: { code, message: e.publicCode ? e.message : code } }) + '\n'); process.exitCode = 1;
        }
    })();
}
