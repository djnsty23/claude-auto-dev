#!/usr/bin/env node
'use strict';
/**
 * worker-reconcile.js - settle every reserved headless attempt from evidence the
 * worker could not have written for itself, and verify the ones that succeeded.
 *
 * WHY. Two gaps let a run end in a state nobody owned:
 *   - brain-judge closeStep closes only a headless run that is ALREADY settled,
 *     and settling was left to whoever remembered. A worker that exited, or one
 *     whose supervisor died in a reboot, could sit `started` for good.
 *   - an accept needs a receipt acceptance-receipt.js verified for the attempt,
 *     and nothing ran verify, so every judge accept escalated as receipt-missing.
 *
 * WHAT A TICK DOES, for every unattended record that is `started` on the
 * headless channel. Each attempt ends in exactly one outcome:
 *
 *   PENDING  the supervisor is alive and wrote no exit line. Look next tick.
 *   SETTLED  the run exited. Its headless record is settled (plain, or
 *            --unreported when the worker left no RESULT line) and the
 *            unattended record is closed in the same tick, so a worker that
 *            exited is settled within two clock intervals at the latest.
 *            succeeded needs this tick's own reading of the evidence: the
 *            supervisor's CLAUDE_EXIT=0 in the log AND a RESULT <code> done|stopped
 *            line in a report written after the attempt started. The ledger's
 *            settled result, the supervisor's exit line and the CLI's own
 *            stream-json result event are harness output: none of them is ever
 *            read as the worker's success.
 *   HELD     the run's login was refused. The attempt goes to the record's
 *            history (unattended-worker hold) and the record waits in `held`:
 *            not failed, not queued, never retried blind. It returns to queued
 *            only once brain-judge authHold clears for its config dir (a later
 *            run on that login succeeded, or a probe passed).
 *   UNKNOWN  supervision was lost (a reboot, a dead or reused supervisor pid,
 *            no exit line). The headless record settles `lost` and the task
 *            closes with runStatus unknown. Never success, whatever the report says.
 *   REJECT   a success claim that is not this attempt's: a report older than
 *            the attempt, a RESULT line missing or naming another code, a report
 *            a later run shares, or an attempt with no run of its own beside an
 *            older run's success. The task closes failed (or unknown when no run
 *            of its own exists) with the reason stored as settleReason.
 *   ORPHAN   a started record with no headless run and no success to reject.
 *            Only a person placed it, so it is reported and left.
 *
 * VERIFY. A closed record whose run succeeded, with no verdict yet, and whose
 * receipt gate refuses for a reason a fresh verify can answer (receipt-missing,
 * receipt-other-attempt, tree-changed, report-changed, authority-changed,
 * rubric-changed, criteria-changed), gets `acceptance-receipt.js verify` here,
 * outside the worker. Each verify reserves capacity class `verify`, runs under
 * its own budget (VERIFY_BUDGET_MS, apart from the judge's 180 s tick budget),
 * and at most VERIFY_TRIES_PER_ATTEMPT times per attempt. A live tick hands
 * verify to a detached child so the clock pass stays bounded; --wait runs it in
 * the tick. The judge's next tick then finds the receipt, and its accept stands.
 *
 * NEVER IN A WORKER. With AUTODEV_HEADLESS=1 every verb refuses
 * (reconciler-in-worker): a reconciler the worker can call is not independent.
 *
 * THE CLOCK LINE. The Brain clock calls, once per pass and before brain-judge:
 *     node "<plugin root>/scripts/worker-reconcile.js" tick --live
 *
 * Usage: see USAGE below.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const claudePaths = require('./claude-paths.js');
const hw = require('./headless-worker.js');
const uw = require('./unattended-worker.js');
const bj = require('./brain-judge.js');
const acceptance = require('./acceptance-receipt.js');
const capacity = require('./capacity.js');
const { acquireLock } = require('./ledger-lock.js');

const USAGE = [
    'Usage: node worker-reconcile.js tick [--live] [--wait] [--budget-sec 600] [--ledger <file>] [--headless-ledger <file>] [--state-dir <dir>] [--judge-state-dir <dir>]',
    '       node worker-reconcile.js verify [--budget-sec 600] [--task-id <id>] [--ledger <file>] [--state-dir <dir>]',
    'tick:   settle and close every started headless attempt (PENDING, SETTLED, HELD, UNKNOWN, REJECT, ORPHAN),',
    '        release held records whose login works again, and verify succeeded runs that have no receipt.',
    '        Without --live it writes nothing and says what it would do. A live tick runs verify in a detached',
    '        child unless --wait, so a clock pass stays bounded.',
    'verify: run acceptance-receipt.js verify for each succeeded, unverified record, under capacity class verify',
    '        and its own budget. Refused inside a headless worker.',
    'Clock line: node "<plugin root>/scripts/worker-reconcile.js" tick --live   (each pass, before brain-judge.js tick)',
    'Output: {"ok":true,"value":{...}} exit 0; {"ok":false,"error":{"code","message"}} exit 1.',
].join('\n') + '\n';

const VERIFY_BUDGET_MS = 600 * 1000;
const VERIFY_MIN_LEFT_MS = 20 * 1000;
const VERIFY_TRIES_PER_ATTEMPT = 3;
const SUCCESS_RESULTS = ['done', 'stopped'];
// Gate refusals a fresh verify can answer. Every other one (a missing or changed
// brief, no criteria, a failed criterion, a tampered index) needs a person.
const VERIFIABLE = ['receipt-missing', 'receipt-other-attempt', 'tree-changed', 'report-changed', 'authority-changed', 'rubric-changed', 'criteria-changed'];

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = { _: [] };
    const flags = ['help', 'live', 'wait'];
    const known = [...flags, 'ledger', 'headless-ledger', 'state-dir', 'judge-state-dir', 'budget-sec', 'task-id'];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const key = a.slice(2);
        if (!known.includes(key)) fault('usage', `unknown flag --${key}`);
        if (Object.prototype.hasOwnProperty.call(out, key)) fault('usage', `--${key} given twice`);
        if (flags.includes(key)) { out[key] = true; continue; }
        const value = argv[++i];
        if (value === undefined || value === '' || value.startsWith('--')) fault('usage', `--${key} needs a value`);
        out[key] = value;
    }
    return out;
}

function pathsFor(opts) {
    const autodev = path.join(claudePaths.configDir(), 'autodev');
    return {
        state: path.resolve(opts['state-dir'] || path.join(autodev, 'worker-reconcile')),
        judgeState: path.resolve(opts['judge-state-dir'] || path.join(autodev, 'brain-judge')),
        ledger: path.resolve(opts.ledger || path.join(autodev, 'unattended-workers.json')),
        headlessLedger: path.resolve(opts['headless-ledger'] || path.join(autodev, 'headless-workers.json')),
    };
}

function budgetOpt(opts) {
    if (opts['budget-sec'] === undefined) return VERIFY_BUDGET_MS;
    const n = Number(opts['budget-sec']);
    if (!Number.isFinite(n) || n <= 0) fault('usage', '--budget-sec is a positive number of seconds');
    return n * 1000;
}

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

function appendJsonl(file, row) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function readJsonl(file) {
    const text = readText(file);
    if (text === null) return [];
    const rows = [];
    for (const line of text.split(/\r?\n/)) { if (line.trim()) { try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped, never guessed */ } } }
    return rows;
}

function refuseInWorker() {
    if (process.env.AUTODEV_HEADLESS === '1') fault('reconciler-in-worker', 'worker-reconcile runs in the coordinator, never inside a headless worker');
}

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };

/** True when the file was last written more than a second before `startedAt`. */
function writtenBefore(file, startedAt) {
    const t = ms(startedAt);
    if (t === null) return false;
    try { return fs.statSync(file).mtimeMs < t - 1000; } catch { return false; }
}

// ---------------------------------------------------------------- the success rule

/**
 * Whether a SETTLED headless run succeeded, read again from the files rather
 * than from the ledger's settled result. Returns { outcome, runStatus, why }.
 * `records` is the run's headless ledger, so a report a later run shares is seen.
 */
function successEvidence(h, records = []) {
    if (!SUCCESS_RESULTS.includes(h.result)) return { outcome: 'SETTLED', runStatus: 'failed', why: `settled ${h.result}` };
    const later = hw.laterRuns(h, records);
    const shares = (k) => later.some((l) => l[k] && h[k] && path.resolve(l[k]) === path.resolve(h[k]));
    if (shares('report') || shares('log')) {
        return { outcome: 'REJECT', runStatus: 'failed', why: `a later run at ${h.code} writes the same ${shares('report') ? 'report' : 'log'}, so it is not this attempt's word` };
    }
    const logText = readText(h.log);
    const logExit = logText === null ? null : hw.exitCodeOf(logText);
    if (logExit !== 0 || h.exit !== 0) {
        return { outcome: 'SETTLED', runStatus: 'failed', why: `the supervisor recorded exit ${logExit === null ? 'none' : logExit} (ledger ${h.exit ?? 'none'})` };
    }
    const reportText = readText(h.report);
    if (reportText === null) {
        return { outcome: 'REJECT', runStatus: 'failed', why: `the ledger says ${h.result}, but ${h.report} does not exist: a harness record is not the worker's word` };
    }
    if (writtenBefore(h.report, h.startedAt)) {
        return { outcome: 'REJECT', runStatus: 'failed', why: `${h.report} was written before this attempt started at ${h.startedAt}: an older attempt's success` };
    }
    const parsed = hw.parseResult(reportText, h.code);
    if (!parsed) {
        return { outcome: 'REJECT', runStatus: 'failed', why: `the ledger says ${h.result}, but ${h.report} has no RESULT ${h.code} line: a harness record is not the worker's word` };
    }
    if (!SUCCESS_RESULTS.includes(parsed.state)) {
        return { outcome: 'SETTLED', runStatus: 'failed', why: `the report says ${parsed.state}, though the ledger says ${h.result}` };
    }
    return { outcome: 'SETTLED', runStatus: 'succeeded', why: `exit 0 and RESULT ${h.code} ${parsed.state}, written after the attempt started` };
}

/**
 * What a started record's SETTLED headless run means for the task. Pure over the
 * files: { outcome, action: hold|close, runStatus?, why }.
 */
function closeDecision(h, records = []) {
    if (h.result === 'auth-refused') return { outcome: 'HELD', action: 'hold', why: `login refused: ${String(h.reason || '').slice(0, 200)}` };
    if (h.result === 'lost') return { outcome: 'UNKNOWN', action: 'close', runStatus: 'unknown', why: `supervision lost: ${String(h.reason || 'no exit line').slice(0, 200)}` };
    return { action: 'close', ...successEvidence(h, records) };
}

// ---------------------------------------------------------------- settling the headless record

function hwSettle(file, h, extra = []) {
    return hw.run(['settle', '--code', h.code, '--started-at', h.startedAt, '--ledger', file, ...extra]);
}

/** Move a stale report aside so settle can record that this attempt left none. */
function moveStaleAside(h) {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const ext = path.extname(h.report);
    const to = path.join(path.dirname(h.report), `${path.basename(h.report, ext)}.stale-${stamp}${ext}`);
    fs.renameSync(h.report, to);
    return to;
}

/**
 * Bring one unsettled headless run to settled, or say why not yet. Live only.
 * Returns { settled: bool, outcome?, why, rejected? }.
 */
function settleHeadless(file, h, boot) {
    const logText = readText(h.log);
    const exit = logText === null ? null : hw.exitCodeOf(logText);
    if (exit === null) {
        const lost = hw.lostReason(h, boot);
        if (!lost) return { settled: false, outcome: 'PENDING', why: 'no exit line yet and the supervisor is not provably gone' };
        hwSettle(file, h, ['--lost']);
        return { settled: true, why: lost };
    }
    try {
        hwSettle(file, h);
        return { settled: true, why: `exited ${exit}` };
    } catch (e) {
        const code = e.publicCode || 'internal';
        if (code === 'no-result' || code === 'stale-report') {
            let rejected = null;
            try {
                if (code === 'stale-report') {
                    // settle --unreported refuses a stale report too; only once the
                    // supervisor is provably gone is the old report moved aside.
                    const gone = ['dead', 'reused'].includes(hw.supervisorLiveness(h)) || (ms(h.startedAt) !== null && ms(h.startedAt) < boot);
                    if (!gone) return { settled: false, outcome: 'PENDING', why: 'a stale report and a supervisor not provably gone' };
                    rejected = `${h.report} was written before the attempt started (moved to ${path.basename(moveStaleAside(h))})`;
                }
                hwSettle(file, h, ['--unreported']);
                return { settled: true, why: rejected || `exited ${exit} with no RESULT line`, rejected };
            } catch (e2) {
                const c2 = e2.publicCode || 'internal';
                if (c2 === 'still-running') return { settled: false, outcome: 'PENDING', why: e2.message };
                return { settled: false, outcome: 'STUCK', why: `${c2}: ${e2.message}` };
            }
        }
        return { settled: false, outcome: 'STUCK', why: `${code}: ${e.message}` };
    }
}

// ---------------------------------------------------------------- one tick

function runsIn(cache, file) {
    if (!cache.has(file)) { try { cache.set(file, hw.readLedger(file).records); } catch (e) { cache.set(file, e); } }
    return cache.get(file);
}

/** One started record to its outcome. Mutates the ledgers only when live. */
function reconcileStarted(rec, ctx) {
    const { p, live, boot, cache } = ctx;
    const file = path.resolve((rec.headless && rec.headless.ledger) || p.headlessLedger);
    const runs = runsIn(cache, file);
    if (runs instanceof Error) return { outcome: 'PENDING', why: `${file} could not be read (${runs.publicCode || runs.code || 'error'})` };
    let h = bj.headlessRunOf(rec, runs);
    const code = (rec.headless && rec.headless.code) || rec.slug;
    if (!h) {
        const older = runs.filter((r) => r.code === code && r.state === 'settled' && SUCCESS_RESULTS.includes(r.result));
        if (!older.length) return { outcome: 'ORPHAN', why: `no headless run at ${code} for this attempt` };
        const d = { outcome: 'REJECT', action: 'close', runStatus: 'unknown',
            why: `no run of this attempt at ${code}; the success there belongs to the run started ${older[older.length - 1].startedAt}` };
        return live ? apply(rec, d, ctx) : { ...d, wouldApply: true };
    }
    let settledNote = null;
    if (h.state !== 'settled') {
        if (!live) return { outcome: 'PENDING', why: 'headless run not settled (dry: nothing is settled)' };
        const s = settleHeadless(file, h, boot);
        if (!s.settled) return { outcome: s.outcome, why: s.why };
        settledNote = s;
        cache.delete(file);
        const fresh = runsIn(cache, file);
        h = Array.isArray(fresh) ? fresh.find((r) => r.code === h.code && r.startedAt === h.startedAt) : null;
        if (!h) return { outcome: 'STUCK', why: 'the settled run vanished from its ledger' };
    }
    let d = closeDecision(h, runsIn(cache, file));
    if (settledNote && settledNote.rejected) d = { outcome: 'REJECT', action: 'close', runStatus: 'failed', why: settledNote.rejected };
    return live ? apply(rec, d, ctx) : { ...d, wouldApply: true };
}

function apply(rec, d, { p }) {
    try {
        if (d.action === 'hold') uw.run(['hold', '--task-id', rec.taskId, '--reason', d.why, '--ledger', p.ledger]);
        else uw.run(['settle', '--task-id', rec.taskId, '--run-status', d.runStatus, '--report-read', '--reason', `${d.outcome}: ${d.why}`, '--ledger', p.ledger]);
        return { ...d, applied: true };
    } catch (e) {
        return { ...d, applied: false, error: `${e.publicCode || 'internal'}: ${e.message}` };
    }
}

/** Held records whose login works again go back to the queue. */
function releaseHeld(records, ctx) {
    const { p, live, cache } = ctx;
    const out = [];
    const probes = readJsonl(path.join(p.judgeState, 'probes.jsonl'));
    const ledgers = new Map([[p.headlessLedger, runsIn(cache, p.headlessLedger)]]);
    for (const r of records) {
        const last = Array.isArray(r.attempts) && r.attempts.length ? r.attempts[r.attempts.length - 1] : null;
        const f = last && last.headless && last.headless.ledger ? path.resolve(last.headless.ledger) : null;
        if (f && !ledgers.has(f)) ledgers.set(f, runsIn(cache, f));
    }
    for (const r of records.filter((x) => x.state === 'held')) {
        const cfg = bj.cfgKey(r.held && r.held.configDir);
        const hold = bj.authHold(ledgers, probes, cfg);
        if (hold) { out.push({ taskId: r.taskId, outcome: 'HELD', why: hold.line }); continue; }
        if (!live) { out.push({ taskId: r.taskId, outcome: 'RELEASE', wouldApply: true, why: 'the login works again' }); continue; }
        try {
            uw.run(['release', '--task-id', r.taskId, '--reason', 'the login works again: brain-judge authHold cleared', '--ledger', p.ledger]);
            out.push({ taskId: r.taskId, outcome: 'RELEASE', applied: true, why: 'the login works again' });
        } catch (e) {
            out.push({ taskId: r.taskId, outcome: 'HELD', applied: false, why: `${e.publicCode || 'internal'}: ${e.message}` });
        }
    }
    return out;
}

/** Records that succeeded, have no verdict, and whose receipt gate a verify can answer. */
function verifyCandidates(records, p, taskId = null) {
    const tries = new Map();
    for (const row of readJsonl(path.join(p.state, 'verify.jsonl'))) {
        const k = `${row.taskId}\u0000${row.attemptId}`;
        tries.set(k, (tries.get(k) || 0) + 1);
    }
    const out = [];
    for (const rec of records) {
        if (taskId && rec.taskId !== taskId) continue;
        if (rec.channel !== 'headless' || !uw.FINISHED.includes(rec.state) || rec.runStatus !== 'succeeded' || rec.verdict) continue;
        const attemptId = acceptance.attemptOf(rec);
        if ((tries.get(`${rec.taskId}\u0000${attemptId}`) || 0) >= VERIFY_TRIES_PER_ATTEMPT) continue;
        let g;
        try { g = acceptance.gate(rec); } catch (e) { g = { ok: false, code: 'gate-error', why: e.message }; }
        if (!g.ok && VERIFIABLE.includes(g.code)) out.push({ rec, gate: g.code });
    }
    return out;
}

function readRecords(p) { return uw.run(['status', '--ledger', p.ledger]).records; }

function tick(opts) {
    refuseInWorker();
    const p = pathsFor(opts);
    const live = opts.live === true;
    const lock = acquireLock(path.join(p.state, 'tick.lock'), { waitMs: 0, meta: { by: 'worker-reconcile tick' } });
    if (!lock.acquired) return { skipped: `another tick holds the lock (${lock.why})`, outcomes: [], line: 'tick skipped: another tick holds the lock' };
    try {
        const ctx = { p, live, boot: hw.bootAt(), cache: new Map() };
        const outcomes = [];
        for (const rec of readRecords(p).filter((r) => r.state === 'started' && r.channel === 'headless')) {
            outcomes.push({ taskId: rec.taskId, ...reconcileStarted(rec, ctx) });
        }
        ctx.cache.clear();
        const released = releaseHeld(readRecords(p), ctx);
        const pending = verifyCandidates(readRecords(p), p);
        let verify;
        if (!pending.length) verify = { pending: 0 };
        else if (!live) verify = { pending: pending.length, wouldVerify: pending.map((c) => ({ taskId: c.rec.taskId, gate: c.gate })) };
        else if (opts.wait) verify = { pending: pending.length, ...verifyStep(opts) };
        else verify = { pending: pending.length, ...spawnVerify(opts, p) };
        const at = new Date().toISOString();
        for (const o of [...outcomes, ...released]) if (live && o.outcome !== 'PENDING') appendJsonl(path.join(p.state, 'events.jsonl'), { at, ...o });
        const count = (k) => outcomes.filter((o) => o.outcome === k).length;
        const line = `reconcile (${live ? 'live' : 'dry'}): ${outcomes.length} started, ${count('SETTLED')} settled, ${count('HELD')} held, `
            + `${count('UNKNOWN')} unknown, ${count('REJECT')} rejected, ${count('PENDING')} pending, ${count('ORPHAN')} orphan, ${count('STUCK')} stuck; `
            + `${released.filter((r) => r.outcome === 'RELEASE').length} released; ${verify.pending} to verify`;
        return { live, outcomes, released, verify, line };
    } finally { lock.release(); }
}

/** A detached verify child, so the clock pass that ran the tick is not held for it. */
function spawnVerify(opts, p) {
    const args = [__filename, 'verify', '--ledger', p.ledger, '--state-dir', p.state];
    if (opts['budget-sec'] !== undefined) args.push('--budget-sec', String(opts['budget-sec']));
    fs.mkdirSync(p.state, { recursive: true });
    const fd = fs.openSync(path.join(p.state, 'verify.log'), 'a');
    try {
        const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env });
        child.on('error', () => { /* the next tick finds the record still unverified and tries again */ });
        child.unref();
        return { spawned: true, pid: child.pid || null };
    } finally { fs.closeSync(fd); }
}

function verifyStep(opts) {
    refuseInWorker();
    const p = pathsFor(opts);
    const budgetMs = budgetOpt(opts);
    const started = Date.now();
    const left = () => budgetMs - (Date.now() - started);
    const lock = acquireLock(path.join(p.state, 'verify.lock'), { waitMs: 0, meta: { by: 'worker-reconcile verify' } });
    if (!lock.acquired) return { skipped: 'another verify holds the lock', verified: [] };
    const verified = [];
    try {
        for (const c of verifyCandidates(readRecords(p), p, opts['task-id'] || null)) {
            const rec = c.rec;
            const row = { at: new Date().toISOString(), taskId: rec.taskId, attemptId: acceptance.attemptOf(rec), gate: c.gate };
            if (left() < VERIFY_MIN_LEFT_MS) { verified.push({ ...row, deferred: `${Math.round(left() / 1000)} s left of the verify budget` }); break; }
            const adm = capacity.admit({ cls: 'verify', path: rec.repo, note: `verify ${rec.taskId}` });
            if (!adm.admitted) { verified.push({ ...row, deferred: `capacity: ${adm.why}` }); break; }
            try {
                let n = 1;
                try { n = Math.max(1, acceptance.parseCriteria(fs.readFileSync(rec.briefFile, 'utf8')).criteria.length); } catch { n = 1; }
                const timeoutMs = Math.max(1000, Math.floor((left() - 5000) / n));
                const r = acceptance.verify(rec, { timeoutMs });
                Object.assign(row, { ok: true, complete: r.complete, failed: r.failed, receipt: r.receipt, tree: r.tree });
            } catch (e) {
                Object.assign(row, { ok: false, error: e.publicCode || 'internal', message: String(e.message).slice(0, 300) });
            } finally {
                if (adm.id) capacity.release(adm.id);
            }
            appendJsonl(path.join(p.state, 'verify.jsonl'), row);
            verified.push(row);
        }
    } finally { lock.release(); }
    return { verified, budgetMs };
}

function run(argv) {
    const opts = parseArgs(argv);
    if (opts.help) return { help: true };
    const cmd = opts._[0];
    if (cmd === 'tick') { budgetOpt(opts); return tick(opts); }
    if (cmd === 'verify') return verifyStep(opts);
    fault('usage', cmd ? `unknown command ${cmd}` : 'a command is required');
}

if (require.main === module) {
    try {
        const value = run(process.argv.slice(2));
        if (value.help) process.stdout.write(USAGE);
        else process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
        process.exitCode = 0;
    } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: e.publicCode || 'internal', message: e.message } }) + '\n');
        process.exitCode = 1;
    }
}

module.exports = { successEvidence, closeDecision, settleHeadless, reconcileStarted, releaseHeld, verifyCandidates, verifyStep, tick, run, parseArgs,
    VERIFIABLE, VERIFY_BUDGET_MS, VERIFY_TRIES_PER_ATTEMPT, SUCCESS_RESULTS };
