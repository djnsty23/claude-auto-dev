#!/usr/bin/env node
'use strict';
/**
 * execution-budget.js - one shared spending ledger for every headless worker
 * and judge, with per-attempt ceilings the supervisor enforces. A library; it
 * prints nothing on import and nothing on a no-op.
 *
 * WHY. Workers (headless-worker.js) and judges (brain-judge.js) each carried
 * their own caps or none. A worker had no turn, wall or output ceiling at all,
 * and a backfill or manual judge spent outside the tick caps. `[measured
 * 2026-10-14]` over 186 headless runs on one machine: turns p95 315, max 444,
 * wall p95 179 min, max 1140 min, log bytes p95 11.4 MB, max 20.2 MB, notional
 * cost p95 $25, max $114.
 *
 * WHY NOT capacity.js. capacity.js reserves machine resources (disk, commit)
 * and deletes a reservation the moment its process ends. A spending budget has
 * to remember settled attempts: what each one cost within the window, and that
 * its id was used, so the same attempt is never started twice. So this is its
 * own ledger, with the same discipline: reserve under a lock before launch,
 * settle after, and fail closed on anything unreadable.
 *
 * THE RULES.
 *   - reserve() before launch, under ledger-lock.js. The attempt id must be new:
 *     an id the ledger has ever held is refused as attempt-restart, whatever
 *     state it is in. A launcher mints a fresh id for a retry.
 *   - The reservation holds the kind's ceilings: maxTurns turns and, for billed
 *     (API key) usage only, maxUsd dollars. It counts against its pool until
 *     settled, and the pool's window cap refuses a reservation that would pass it.
 *   - settle() after the run. Reported usage (the last stream-json result
 *     event's num_turns and total_cost_usd) replaces the reservation. MISSING
 *     usage keeps the whole reservation as the charge: an unmeasured run is
 *     charged its ceiling, never zero.
 *   - Subscription usage and billed dollars never mix. Each attempt names its
 *     billing: `api` when the child runs on an API key (ANTHROPIC_API_KEY, or
 *     Bedrock or Vertex), else `subscription`. The api pool caps dollars. Each
 *     subscription account (its config dir name) is its own pool and caps turns.
 *     A subscription run's total_cost_usd is recorded as notionalUsd and is
 *     never charged as a billed dollar.
 *   - The supervisor enforces turns, wall time and output bytes while the child
 *     runs (watch below). A child past one is stopped with its whole process
 *     tree (Windows: taskkill /T /F by pid, POSIX: SIGKILL to its process group),
 *     the log is kept, and the stop is recorded on the attempt.
 *
 * DEFAULT CEILINGS. Conservative, and the owner changes them once in the config file:
 *   worker  maxTurns 500, wallMs 6 h, outputBytes 64 MiB, maxUsd 40 (billed only)
 *   judge   maxTurns 4, wallMs 120 s, outputBytes 16 MiB, maxUsd 0.5 (brain-judge's own caps)
 *   window  24 h rolling: billedUsd 100 for the api pool, subscriptionTurns 10000 per account
 * The worker values sit above every measured run (max 444 turns, 20.2 MB) except
 * the 1140-minute outlier, which is the runaway this exists to stop.
 *
 * CONFIG. `<home>/.claude/autodev/execution-budget-config.json`, or the file
 * AUTODEV_BUDGET_CONFIG names. Any key overrides the default beside it:
 *   { "kinds": { "worker": { "maxTurns": N, "wallMs": N, "outputBytes": N, "maxUsd": N },
 *                "judge": { ... } },
 *     "window": { "ms": N, "billedUsd": N, "subscriptionTurns": N } }
 * A config that does not parse refuses every reservation: a ceiling nobody can
 * read is not a ceiling.
 *
 * LEDGER. `<home>/.claude/autodev/execution-budget.json`, or AUTODEV_BUDGET_LEDGER.
 * Machine-wide, not per config dir: a worker on a second account still spends
 * from this machine's ledger. Settled attempts leave after 90 days.
 *
 * ENVIRONMENT.
 *   AUTODEV_BUDGET_CONFIG=FILE   the config file
 *   AUTODEV_BUDGET_LEDGER=FILE   the ledger file
 *   AUTODEV_BUDGET_POLL_MS=N     how often the watchdog measures a running child (default 1000)
 *
 *   node execution-budget.js status [--json]   the pools, their window use and the open attempts
 *   node execution-budget.js --help
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withLedgerLock, writeAtomic } = require('./ledger-lock.js');

const MIB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULTS = Object.freeze({
    kinds: Object.freeze({
        worker: Object.freeze({ maxTurns: 500, wallMs: 6 * HOUR_MS, outputBytes: 64 * MIB, maxUsd: 40 }),
        judge: Object.freeze({ maxTurns: 4, wallMs: 120 * 1000, outputBytes: 16 * MIB, maxUsd: 0.5 }),
    }),
    window: Object.freeze({ ms: 24 * HOUR_MS, billedUsd: 100, subscriptionTurns: 10000 }),
});
const KINDS = Object.keys(DEFAULTS.kinds);
const CEILING_KEYS = ['maxTurns', 'wallMs', 'outputBytes', 'maxUsd'];
const RETENTION_MS = 90 * 24 * HOUR_MS;
const ATTEMPT_RE = /^[A-Za-z0-9][A-Za-z0-9:@._-]{0,159}$/;
const OPEN_STATES = ['reserved', 'running'];
const DEFAULT_POLL_MS = 1000;

function autodevDir() { return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude', 'autodev'); }
function ledgerPath(env = process.env) { return path.resolve(env.AUTODEV_BUDGET_LEDGER || path.join(autodevDir(), 'execution-budget.json')); }
function configPath(env = process.env) { return path.resolve(env.AUTODEV_BUDGET_CONFIG || path.join(autodevDir(), 'execution-budget-config.json')); }
function pollMs(env = process.env) {
    const n = Number(env.AUTODEV_BUDGET_POLL_MS);
    return env.AUTODEV_BUDGET_POLL_MS && Number.isFinite(n) && n >= 10 ? n : DEFAULT_POLL_MS;
}

const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** { config, why }: the defaults merged with the file, or config null when the file cannot be read. */
function loadConfig(env = process.env) {
    const file = configPath(env);
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT') return { config: null, why: `the budget config ${file} is unreadable (${e.code || e.message})` };
        raw = {};
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, why: `the budget config ${file} is not an object` };
    const kinds = {};
    for (const k of KINDS) {
        const over = (raw.kinds && raw.kinds[k]) || {};
        kinds[k] = {};
        for (const key of CEILING_KEYS) {
            if (over[key] !== undefined && pos(over[key]) === null) return { config: null, why: `the budget config ${file} sets kinds.${k}.${key} to ${JSON.stringify(over[key])}, not a number >= 0` };
            kinds[k][key] = over[key] !== undefined ? over[key] : DEFAULTS.kinds[k][key];
        }
    }
    const w = raw.window || {};
    const window = {};
    for (const key of Object.keys(DEFAULTS.window)) {
        if (w[key] !== undefined && pos(w[key]) === null) return { config: null, why: `the budget config ${file} sets window.${key} to ${JSON.stringify(w[key])}, not a number >= 0` };
        window[key] = w[key] !== undefined ? w[key] : DEFAULTS.window[key];
    }
    return { config: { kinds, window }, why: null, file };
}

/** The ceilings for a kind, from the config, or the defaults when the config cannot be read. */
function ceilingsFor(kind, env = process.env) {
    if (!KINDS.includes(kind)) throw new Error(`unknown budget kind ${JSON.stringify(kind)}; one of ${KINDS.join(', ')}`);
    const c = loadConfig(env).config;
    return { ...(c ? c.kinds[kind] : DEFAULTS.kinds[kind]) };
}

/** `api` when the child env spends billed dollars, else `subscription`. */
function billingOf(env = process.env) {
    const set = (k) => typeof env[k] === 'string' && env[k].trim() !== '' && env[k] !== '0';
    return set('ANTHROPIC_API_KEY') || set('CLAUDE_CODE_USE_BEDROCK') || set('CLAUDE_CODE_USE_VERTEX') ? 'api' : 'subscription';
}

function poolOf(a) { return a.billing === 'api' ? 'api' : `subscription:${a.account || 'default'}`; }

/** What an attempt counts against its pool now: { turns, usd }. */
function chargeOf(a) {
    if (a.state === 'cancelled') return { turns: 0, usd: 0 };
    if (OPEN_STATES.includes(a.state) || !a.charged) return { turns: a.reserved.turns, usd: a.reserved.usd };
    return { turns: a.charged.turns, usd: a.charged.usd };
}

/** The pool's use within the window: open attempts whatever their age, settled ones reserved inside it. */
function windowUse(ledger, pool, config, nowMs = Date.now()) {
    let turns = 0;
    let usd = 0;
    let attempts = 0;
    for (const a of Object.values(ledger.attempts)) {
        if (poolOf(a) !== pool) continue;
        const t = Date.parse(a.reservedAt || '');
        if (!OPEN_STATES.includes(a.state) && Number.isFinite(t) && nowMs - t > config.window.ms) continue;
        const c = chargeOf(a);
        turns += c.turns;
        usd += c.usd;
        attempts++;
    }
    return { turns, usd: Math.round(usd * 1e6) / 1e6, attempts };
}

function readLedger(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return { ledger: { schema: 1, attempts: {} } };
        return { ledger: null, why: `the budget ledger ${file} is unreadable (${e.code || e.message})` };
    }
    try {
        const l = JSON.parse(text);
        if (!l || typeof l.attempts !== 'object' || Array.isArray(l.attempts) || l.attempts === null) return { ledger: null, why: `the budget ledger ${file} has no attempts map` };
        return { ledger: l };
    } catch (e) { return { ledger: null, why: `the budget ledger ${file} is not JSON (${e.message})` }; }
}

/** Lock, read, prune, apply fn(ledger) -> { value, write }, write when asked. Returns { value } or { error }. */
function transact(file, fn) {
    try {
        return withLedgerLock(file, () => {
            const r = readLedger(file);
            if (!r.ledger) return { error: r.why };
            const nowMs = Date.now();
            for (const [id, a] of Object.entries(r.ledger.attempts)) {
                const t = Date.parse(a.settledAt || '');
                if (!OPEN_STATES.includes(a.state) && Number.isFinite(t) && nowMs - t > RETENTION_MS) delete r.ledger.attempts[id];
            }
            const out = fn(r.ledger, nowMs);
            if (out.write) writeAtomic(file, JSON.stringify(r.ledger, null, 2) + '\n');
            return { value: out.value };
        });
    } catch (e) {
        return { error: `the budget ledger could not be locked or written (${e.code || e.message})` };
    }
}

/**
 * Reserve an attempt before anything is launched. { ok: true, attempt } or
 * { ok: false, code, why }, never throws. code is usage, attempt-restart,
 * config-unreadable, ledger-unreadable or window-exhausted.
 */
function reserve(req, { env = process.env, ledger: file = ledgerPath(env) } = {}) {
    const { attemptId, kind } = req || {};
    if (typeof attemptId !== 'string' || !ATTEMPT_RE.test(attemptId)) return { ok: false, code: 'usage', why: `attempt id ${JSON.stringify(attemptId)} does not match ${ATTEMPT_RE}` };
    if (!KINDS.includes(kind)) return { ok: false, code: 'usage', why: `budget kind ${JSON.stringify(kind)} is not one of ${KINDS.join(', ')}` };
    const cfg = loadConfig(env);
    if (!cfg.config) return { ok: false, code: 'config-unreadable', why: `${cfg.why}; nothing is reserved until it parses` };
    const ceilings = cfg.config.kinds[kind];
    const billing = req.billing === 'api' || req.billing === 'subscription' ? req.billing : billingOf(env);
    const r = transact(file, (ledger, nowMs) => {
        if (Object.prototype.hasOwnProperty.call(ledger.attempts, attemptId)) {
            const was = ledger.attempts[attemptId];
            return { value: { ok: false, code: 'attempt-restart', why: `attempt ${attemptId} was already ${was.state} (reserved ${was.reservedAt}). The same attempt is never started twice, so a retry needs a new attempt id`, attempt: was } };
        }
        const attempt = {
            attemptId, kind, billing, account: req.account || 'default', state: 'reserved', reservedAt: new Date(nowMs).toISOString(),
            ceilings: { ...ceilings }, reserved: { turns: ceilings.maxTurns, usd: billing === 'api' ? ceilings.maxUsd : 0 },
            pid: null, log: req.log || null, note: req.note ? String(req.note).slice(0, 200) : null,
        };
        const pool = poolOf(attempt);
        const used = windowUse(ledger, pool, cfg.config, nowMs);
        const over = billing === 'api'
            ? (used.usd + attempt.reserved.usd > cfg.config.window.billedUsd ? `billed $${used.usd} used + $${attempt.reserved.usd} asked passes the $${cfg.config.window.billedUsd} window cap` : null)
            : (used.turns + attempt.reserved.turns > cfg.config.window.subscriptionTurns ? `${used.turns} turns used + ${attempt.reserved.turns} asked passes the ${cfg.config.window.subscriptionTurns}-turn window cap` : null);
        if (over) return { value: { ok: false, code: 'window-exhausted', why: `${pool}: ${over} (window ${Math.round(cfg.config.window.ms / HOUR_MS)} h)`, used } };
        ledger.attempts[attemptId] = attempt;
        return { write: true, value: { ok: true, attempt, used } };
    });
    return r.error ? { ok: false, code: 'ledger-unreadable', why: `${r.error}; nothing is reserved` } : r.value;
}

/** Mark a reserved attempt running. Anything but `reserved` is refused: that is a second launch of one attempt. */
function begin(attemptId, { pid = null, env = process.env, ledger: file = ledgerPath(env) } = {}) {
    const r = transact(file, (ledger, nowMs) => {
        const a = ledger.attempts[attemptId];
        if (!a) return { value: { ok: false, code: 'unknown-attempt', why: `attempt ${attemptId} was never reserved, so it does not launch` } };
        if (a.state !== 'reserved') return { value: { ok: false, code: 'attempt-restart', why: `attempt ${attemptId} is ${a.state}, not reserved. The same attempt is never launched twice`, attempt: a } };
        Object.assign(a, { state: 'running', startedAt: new Date(nowMs).toISOString(), pid });
        return { write: true, value: { ok: true, attempt: a } };
    });
    return r.error ? { ok: false, code: 'ledger-unreadable', why: r.error } : r.value;
}

/**
 * Settle an attempt. `usage` is { turns, costUsd } as the run reported it, or
 * null when it reported none: then the reservation stays the charge. Idempotent:
 * a settled attempt comes back unchanged with already true.
 */
function settle(attemptId, { usage = null, stop = null, exit = null, outputBytes = null, wallMs = null, cancelled = false, reason = null, env = process.env, ledger: file = ledgerPath(env) } = {}) {
    const r = transact(file, (ledger, nowMs) => {
        const a = ledger.attempts[attemptId];
        if (!a) return { value: { ok: false, code: 'unknown-attempt', why: `attempt ${attemptId} is not in the budget ledger` } };
        if (!OPEN_STATES.includes(a.state)) return { value: { ok: true, already: true, attempt: a } };
        const measured = Boolean(usage) && pos(usage.turns) !== null && pos(usage.costUsd) !== null;
        const charged = cancelled ? { turns: 0, usd: 0 }
            : measured ? { turns: usage.turns, usd: a.billing === 'api' ? usage.costUsd : 0 }
            : { ...a.reserved };
        Object.assign(a, {
            state: cancelled ? 'cancelled' : 'settled', settledAt: new Date(nowMs).toISOString(), charged,
            usageMissing: !cancelled && !measured,
            notionalUsd: measured && a.billing !== 'api' ? usage.costUsd : 0,
            stop, exit, outputBytes, wallMs, reason,
        });
        return { write: true, value: { ok: true, attempt: a } };
    });
    return r.error ? { ok: false, code: 'ledger-unreadable', why: r.error } : r.value;
}

/** Settle an attempt that never launched: it charges nothing, and its id stays used. */
function cancel(attemptId, reason, opts = {}) { return settle(attemptId, { ...opts, cancelled: true, reason }); }

/** One attempt as the ledger holds it, or null. */
function attemptOf(attemptId, { env = process.env, ledger: file = ledgerPath(env) } = {}) {
    const r = readLedger(file);
    return r.ledger && r.ledger.attempts[attemptId] ? r.ledger.attempts[attemptId] : null;
}

/** { turns, costUsd } from the LAST stream-json or json result event in a log, or null when it has none. */
function usageFromLog(text) {
    let last = null;
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.startsWith('{') || !line.includes('"type":"result"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j && j.type === 'result') last = j;
    }
    if (!last || pos(last.num_turns) === null || pos(last.total_cost_usd) === null) return null;
    return { turns: last.num_turns, costUsd: last.total_cost_usd };
}

/**
 * Stop a process and every descendant. Windows: taskkill /T /F walks the tree by
 * parent pid. POSIX: the child was spawned as a process-group leader, so the
 * whole group gets SIGKILL. Returns how it went, never throws.
 */
function killTree(pid, { platform = process.platform, run = spawnSync } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, why: 'no pid' };
    try {
        if (platform === 'win32') {
            const r = run('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
            return { ok: Boolean(r) && r.status === 0, how: 'taskkill /T /F', status: r ? r.status : null };
        }
        try { process.kill(-pid, 'SIGKILL'); return { ok: true, how: 'SIGKILL to the process group' }; } catch {
            process.kill(pid, 'SIGKILL');
            return { ok: true, how: 'SIGKILL to the pid (no process group)' };
        }
    } catch (e) { return { ok: false, why: e.code || e.message }; }
}

/**
 * The supervisor's watchdog over one running child whose stdout is `logFile`.
 * Every `every` ms it measures wall time since launch, bytes the log grew since
 * launch, and turns (distinct assistant message ids in the stream-json). The
 * first ceiling passed calls onStop({ field, limit, seen }) once and stops
 * watching. Returns { stop(), measure() }.
 */
function watch({ logFile, ceilings, onStop, every = pollMs(), now = Date.now }) {
    const launchedAt = now();
    let startSize = 0;
    try { startSize = fs.statSync(logFile).size; } catch { startSize = 0; }
    let offset = startSize;
    let carry = '';
    const ids = new Set();
    let stopped = false;
    const readNew = () => {
        let fd;
        try {
            fd = fs.openSync(logFile, 'r');
            const size = fs.fstatSync(fd).size;
            const want = Math.min(size - offset, 4 * MIB);
            if (want > 0) {
                const buf = Buffer.alloc(want);
                const n = fs.readSync(fd, buf, 0, want, offset);
                offset += n;
                const lines = (carry + buf.subarray(0, n).toString('utf8')).split('\n');
                carry = lines.pop();
                if (carry.length > MIB) carry = '';
                for (const line of lines) {
                    if (!line.startsWith('{"type":"assistant"')) continue;
                    try { const j = JSON.parse(line); if (j.message && j.message.id) ids.add(j.message.id); } catch { /* a torn line is not a turn */ }
                }
            }
            return size;
        } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
    };
    const measure = () => {
        const size = readNew();
        return { wallMs: now() - launchedAt, outputBytes: size === null ? null : size - startSize, turns: ids.size };
    };
    let timer = null;
    const tick = () => {
        if (stopped) return;
        const m = measure();
        let hit = null;
        if (m.turns > ceilings.maxTurns) hit = { field: 'turns', limit: ceilings.maxTurns, seen: m.turns };
        else if (m.outputBytes !== null && m.outputBytes > ceilings.outputBytes) hit = { field: 'output', limit: ceilings.outputBytes, seen: m.outputBytes };
        else if (m.wallMs > ceilings.wallMs) hit = { field: 'wall', limit: ceilings.wallMs, seen: m.wallMs };
        if (hit) { stopped = true; clearInterval(timer); onStop(hit); }
    };
    timer = setInterval(tick, every);
    return { stop: () => { stopped = true; clearInterval(timer); }, measure };
}

/** Every pool's use in the window, and the open attempts. */
function status({ env = process.env } = {}) {
    const cfg = loadConfig(env);
    const file = ledgerPath(env);
    const r = readLedger(file);
    if (!r.ledger) return { ok: false, why: r.why, ledger: file };
    const config = cfg.config || { kinds: DEFAULTS.kinds, window: DEFAULTS.window };
    const pools = [...new Set(Object.values(r.ledger.attempts).map(poolOf))];
    const open = Object.values(r.ledger.attempts).filter((a) => OPEN_STATES.includes(a.state)).map((a) => ({ attemptId: a.attemptId, kind: a.kind, state: a.state, reservedAt: a.reservedAt }));
    return {
        ok: true, ledger: file, config: cfg.config, configWhy: cfg.why, configFile: configPath(env),
        pools: Object.fromEntries(pools.map((p) => [p, windowUse(r.ledger, p, config)])), open,
    };
}

module.exports = {
    DEFAULTS, KINDS, ATTEMPT_RE, RETENTION_MS,
    loadConfig, ceilingsFor, billingOf, poolOf, chargeOf, windowUse, reserve, begin, settle, cancel, attemptOf,
    usageFromLog, killTree, watch, status, ledgerPath, configPath, pollMs,
};

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (!argv[0] || argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write('usage: node execution-budget.js status [--json]\n'
            + 'The shared spending ledger for headless workers and judges: each pool\'s use in the window and the open attempts.\n');
    } else if (argv[0] === 'status') {
        const s = status();
        if (!s.ok) { process.stderr.write(`execution-budget: ${s.why}\n`); process.exitCode = 1; }
        else if (argv.includes('--json')) process.stdout.write(JSON.stringify(s, null, 2) + '\n');
        else {
            const lines = [`execution-budget: ${s.ledger}${s.configWhy ? ` (config refused: ${s.configWhy})` : ''}`];
            for (const [p, u] of Object.entries(s.pools)) lines.push(`  ${p}: ${u.attempts} attempt(s), ${u.turns} turns, $${u.usd} billed in the window`);
            for (const a of s.open) lines.push(`  open ${a.attemptId} ${a.kind} ${a.state} since ${a.reservedAt}`);
            process.stdout.write(lines.join('\n') + '\n');
        }
    } else { process.stderr.write(`execution-budget: unknown command ${argv[0]}; see --help\n`); process.exitCode = 1; }
}
