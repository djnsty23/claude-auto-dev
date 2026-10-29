'use strict';
// window-specs.js: one spec per scorecard "<x>-window" criterion, read by window-probe.js.
//
// A spec names its source, the first day its writer recorded the evidence completely
// (`admissibleFrom`), and a load(ctx) that returns
//   { records: [{ at, ok, why }], coveredDays?: Set<day>, totals?: [{ ok, why }] }
// or throws when its source cannot be read. The engine grades the 14 complete days.
//
// Three rules hold for every spec:
//   1. A record never counts before admissibleFrom, so nothing is backfilled.
//   2. A day is covered by evidence of that day, or by an independent heartbeat that
//      proves the source was live and the day legitimately had no work. Absence alone
//      never covers a day.
//   3. Where the needs ask for something no writer records, the spec says so in a
//      total (`no writer records ...`) and fails. It never substitutes a proxy.
//
// Data sources were measured on 2026-10-19 against the operator's config dir. Each
// admissibleFrom cites the commit or record that set it.

const fs = require('fs');
const path = require('path');

const CLOCK_MS = 5 * 60 * 1000; // brain-clock.js ticks every 5 minutes
const TICKS_PER_DAY = 24 * 60 * 60 * 1000 / CLOCK_MS;

const at = (home, ...p) => path.join(home, 'autodev', ...p);
const noWriter = (what) => ({ ok: false, why: `no writer records ${what}` });

/** Rows of a JSONL file that may legitimately not exist yet. Throws only when the autodev dir itself is missing. */
function ledger(ctx, ...p) {
    if (!fs.existsSync(path.join(ctx.home, 'autodev'))) throw new Error(`${path.join(ctx.home, 'autodev')} does not exist`);
    const rows = ctx.readJsonl(at(ctx.home, ...p));
    return rows || [];
}

/** brain-clock passes: the heartbeat. Required: a spec that leans on it cannot read without it. */
function clockRows(ctx) {
    const rows = ctx.readJsonl(at(ctx.home, 'brain-clock', 'passes.jsonl'));
    if (!rows) throw new Error('brain-clock/passes.jsonl cannot be read, so no day can be shown live');
    return rows.filter((r) => r && Number.isFinite(Date.parse(r.at)) && (r.status === 'ok' || r.status === 'degraded'));
}

/** Days on which the clock ticked at least once. A day the host was down is a gap. */
function clockDays(ctx) { return new Set(clockRows(ctx).map((r) => ctx.dayOf(Date.parse(r.at)))); }

function records(json) {
    if (!json) return [];
    const v = json.records || json.attempts || json;
    return Array.isArray(v) ? v : Object.values(v);
}

// ---------------------------------------------------------------------------
// A1 gate-window
// ---------------------------------------------------------------------------

/** Complete evidence for one runner record: 13 rows, the red step with exit and tail, nothing unknown or lost. */
function gateEvidenceFault(rec) {
    const ev = rec.evidence;
    if (!Array.isArray(ev) || !ev.length) return 'no step evidence';
    const of = ev[0].of;
    if (!Number.isInteger(of) || ev.length !== of) return `evidence names ${ev.length} of ${of} steps`;
    const bad = ev.find((e) => e.status === 'unknown' || e.status === 'lost');
    if (bad) return `step ${bad.index} (${bad.step}) reads ${bad.status.toUpperCase()}`;
    if (rec.exit === 0) {
        const notPass = ev.find((e) => e.status !== 'pass');
        return notPass ? `exit 0 but step ${notPass.index} reads ${notPass.status}` : null;
    }
    const failed = ev.filter((e) => e.status === 'fail');
    if (failed.length !== 1) return `a red run names ${failed.length} failed steps`;
    const f = failed[0];
    if (!(Number.isInteger(f.exit) || f.signal)) return `failed step ${f.index} has no exit or signal`;
    if (!f.tail || typeof f.tail.text !== 'string') return `failed step ${f.index} (${f.step}) has no output tail`;
    if (ev.some((e) => e.index < f.index && e.status !== 'pass')) return `a step before the failed step ${f.index} did not pass`;
    if (ev.some((e) => e.index > f.index && e.status !== 'not-run')) return `a step after the failed step ${f.index} is not NOT RUN`;
    return null;
}

/**
 * Complete evidence for one gate-fast run record (tooling/gate-fast.js): every fast step and
 * every touched suite carries a status and an exit or signal, a failed one its output tail,
 * and the selection either ran or says why it could not.
 */
function fastEvidenceFault(rec) {
    const steps = Array.isArray(rec.evidence) ? rec.evidence : [];
    if (!steps.length) return 'no step evidence';
    const t = rec.touched;
    if (!t || typeof t !== 'object') return 'no touched-suite selection';
    if (t.error && rec.exit !== 2) return `the selection failed (${t.error}) but the run exited ${rec.exit}`;
    const suites = t.error ? [] : (Array.isArray(t.evidence) ? t.evidence : null);
    if (!suites) return 'no touched-suite evidence';
    if (!t.error && (!Array.isArray(t.selected) || t.selected.length !== suites.length)) return `selected ${(t.selected || []).length} suites but recorded ${suites.length}`;
    for (const e of [...steps, ...suites]) {
        if (!['pass', 'fail', 'indeterminate'].includes(e.status)) return `${e.step} reads ${e.status}`;
        if (!(Number.isInteger(e.exit) || e.signal) && e.status !== 'indeterminate') return `${e.step} has no exit or signal`;
        if (e.status === 'fail' && (!e.tail || typeof e.tail.text !== 'string')) return `${e.step} failed with no output tail`;
    }
    const all = [...steps, ...suites];
    if (rec.exit === 0 && all.some((e) => e.status !== 'pass')) return `exit 0 but ${all.find((e) => e.status !== 'pass').step} reads ${all.find((e) => e.status !== 'pass').status}`;
    if (rec.exit === 1 && !all.some((e) => e.status === 'fail')) return 'exit 1 with no failed step';
    return null;
}

function runIdTime(id) {
    const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/.exec(id || '');
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

const gateWindow = {
    id: 'gate-window',
    source: 'locks/full-gate.runs/<run>.json runner records (gate-lock.js), locks/fast-gate.runs/<run>.json (gate-fast.js), and origin/main first-parent history in the repo',
    // Runner records carry step evidence from 2026-10-13T22:46Z (tail: 641f844d), so the
    // first complete day is 10-14. The gated head is recorded from this change on; a day
    // with a merge counts only through a gate whose head tree is a tree origin/main took.
    admissibleFrom: '2026-10-14',
    load(ctx) {
        const dir = at(ctx.home, 'locks', 'full-gate.runs');
        let names;
        try { names = fs.readdirSync(dir); } catch (e) { throw new Error(`${dir}: ${e.code || e.message}`); }
        const recs = [];
        const gated = []; // { day, tree }
        for (const n of names.filter((x) => x.endsWith('.json') && !x.startsWith('readmit-'))) {
            const j = ctx.readJson(path.join(dir, n));
            if (!j) { recs.push({ at: runIdTime(n), ok: false, why: `${n} does not parse` }); continue; }
            for (const a of j.attempts || []) {
                const rec = a.record;
                if (!rec) {
                    // The chain never started (a capacity deferral or a refused go): no step ran, so no step is red.
                    const notRun = a.exit === 2 && a.finished === false && /did not run|NOT run|never said go|deferr/i.test(a.why || '');
                    recs.push({ at: runIdTime(j.runId || n), ok: notRun, why: notRun ? null : `${j.runId}: exit ${a.exit} left no runner record (${a.why || 'no reason'})` });
                    continue;
                }
                const fault = gateEvidenceFault(rec);
                recs.push({ at: rec.startUtc, ok: !fault, why: fault ? `${j.runId}: ${fault}` : null });
                if (!fault && rec.exit === 0 && /^[0-9a-f]{40}$/.test(rec.head || '')) {
                    const tree = ctx.git(['rev-parse', `${rec.head}^{tree}`]);
                    if (tree) gated.push({ day: ctx.dayOf(Date.parse(rec.endUtc || rec.startUtc)), tree });
                }
            }
        }
        // gate:fast is the merge bar for an ordinary PR (CLAUDE.md, 2026-10-17), and from
        // 2026-10-19 it records the head it read, whether the tree was dirty, and every fast
        // step and touched suite. A clean, complete, passing record covers its tree. A dirty
        // one never does: its head is not the tree it graded.
        const fastDir = at(ctx.home, 'locks', 'fast-gate.runs');
        let fastNames = [];
        try { fastNames = fs.readdirSync(fastDir).filter((x) => x.endsWith('.json')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`${fastDir}: ${e.code || e.message}`); }
        for (const n of fastNames) {
            const rec = ctx.readJson(path.join(fastDir, n));
            if (!rec) { recs.push({ at: runIdTime(n), ok: false, why: `fast ${n} does not parse` }); continue; }
            const fault = fastEvidenceFault(rec);
            recs.push({ at: rec.startUtc, ok: !fault, why: fault ? `fast ${rec.runId}: ${fault}` : null });
            if (!fault && rec.exit === 0 && rec.dirty === false && /^[0-9a-f]{40}$/.test(rec.head || '')) {
                const tree = ctx.git(['rev-parse', `${rec.head}^{tree}`]);
                if (tree) gated.push({ day: ctx.dayOf(Date.parse(rec.endUtc || rec.startUtc)), tree });
            }
        }
        // A day is covered when nothing landed on origin/main, or when a passing gate's
        // head tree equals a tree that landed that day.
        const since = `${ctx.windowDays[0]}T00:00:00Z`;
        const log = ctx.git(['log', 'origin/main', '--first-parent', `--since=${since}`, '--format=%T %cI']);
        if (log === null) throw new Error(`git log origin/main failed (${ctx.git.lastError || 'no cause recorded'}), so merge days are unknown`);
        const landed = new Map(); // day -> Set<tree>
        for (const line of log.split(/\r?\n/).filter(Boolean)) {
            const [tree, when] = line.split(' ');
            const d = ctx.dayOf(Date.parse(when));
            if (!landed.has(d)) landed.set(d, new Set());
            landed.get(d).add(tree);
        }
        const gatedTrees = new Set(gated.map((g) => g.tree));
        const coveredDays = new Set();
        for (const d of ctx.windowDays) {
            const trees = landed.get(d);
            if (!trees) coveredDays.add(d);
            else if ([...trees].some((t) => gatedTrees.has(t))) coveredDays.add(d);
        }
        return { records: recs.filter((r) => r.at), coveredDays };
    },
};

// ---------------------------------------------------------------------------
// A2 release-window
// ---------------------------------------------------------------------------

const releaseWindow = {
    id: 'release-window',
    source: 'autodev/windows/release-protection.jsonl, appended by `node tooling/release-protection.js --observe` (live GitHub reads)',
    // The --observe writer lands with this change. The release-protections receipts before
    // it graded a synthetic state (test-release-protection.js), not GitHub, so they never count.
    admissibleFrom: '2026-10-19',
    load(ctx) {
        const rows = ledger(ctx, 'windows', 'release-protection.jsonl');
        return {
            records: rows.map((r) => {
                const f = r.fields || {};
                const ok = !r.error && f.direct_write === 'DENIED' && f.tag_replace === 'DENIED' && f.tag_delete === 'DENIED' && f.authorized_publish === 'PASS';
                return { at: r.at, ok, why: ok ? null : (r.error || `direct_write=${f.direct_write} tag_replace=${f.tag_replace} tag_delete=${f.tag_delete} authorized_publish=${f.authorized_publish}`) };
            }),
        };
    },
};

// ---------------------------------------------------------------------------
// A3 authority-window
// ---------------------------------------------------------------------------

const authorityWindow = {
    id: 'authority-window',
    source: 'autodev/headless-workers.json and autodev/windows/authority-audit.jsonl (authority-audit.js)',
    // The audit writer starts this window; earlier launch metadata alone cannot prove containment.
    admissibleFrom: '2026-10-29',
    load(ctx) {
        const json = ctx.readJson(at(ctx.home, 'headless-workers.json'));
        if (!json) throw new Error('headless-workers.json cannot be read');
        const recs = records(json).filter((r) => r && r.startedAt).map((r) => {
            const ok = r.permissionMode === 'dontAsk' && Boolean(r.profile);
            return { at: r.startedAt, ok, why: ok ? null : `${r.code}: ran ${r.permissionMode || 'with no permission mode'}${r.profile ? '' : ' and no profile'}, outside the boundary` };
        });
        const runs = records(json).filter((r) => r && r.startedAt && ctx.windowDays.includes(ctx.dayOf(Date.parse(r.startedAt))));
        const audits = ledger(ctx, 'windows', 'authority-audit.jsonl');
        const audited = runs.map((r) => audits.find((a) => a.runKey === `${r.code}@${r.startedAt}`));
        const complete = audited.filter((a) => a && a.complete === true && Number.isInteger(a.callsChecked) && a.callsChecked >= 0
            && Number.isInteger(a.denials) && a.denials >= 0 && a.denials <= a.callsChecked && Number.isInteger(a.escapes) && a.escapes >= 0 && a.escapes <= a.denials && a.unknown === 0);
        const escapes = complete.reduce((n, a) => n + a.escapes, 0);
        return { records: recs, totals: [{ ok: runs.length > 0 && complete.length === runs.length && escapes === 0,
            why: `${escapes} boundary escapes over ${complete.length} of ${runs.length} audited runs, needs all runs complete and zero escapes` }] };
    },
};

// ---------------------------------------------------------------------------
// A4 hook-window
// ---------------------------------------------------------------------------

const hookWindow = {
    id: 'hook-window',
    source: 'autodev/windows/hook-wall.jsonl (hook-wall.js), installed code with isolated representative inputs',
    admissibleFrom: '2026-10-29',
    load(ctx) {
        const rows = ledger(ctx, 'windows', 'hook-wall.jsonl');
        const measured = rows.filter((r) => r && ctx.windowDays.includes(ctx.dayOf(Date.parse(r.at))));
        const valid = (r) => r.profile && Object.keys(r.profile).length > 0 && ['idle', 'load'].includes(r.load)
            && r.errors === 0 && Number.isInteger(r.hooks) && r.hooks > 0 && Array.isArray(r.samples) && r.samples.length >= 5
            && r.samples.every((n) => Number.isFinite(n) && n > 0) && Array.isArray(r.eventInventory) && r.eventInventory.includes(r.event)
            && r.p95Ms === r.samples.slice().sort((a, b) => a - b)[Math.ceil(r.samples.length * 0.95) - 1];
        const profileKey = (r) => JSON.stringify(Object.entries(r.profile || {}).sort());
        const events = [...new Set(measured.flatMap((r) => (r.eventInventory || [r.event]).map((e) => `${profileKey(r)}:${e}`)))];
        const paired = events.filter((key) => ['idle', 'load'].every((load) => measured.some((r) => `${profileKey(r)}:${r.event}` === key && r.load === load && valid(r))));
        return {
            records: rows.map((r) => ({ at: r.at, ok: valid(r) && Number.isFinite(r.p95Ms) && Number.isFinite(r.budgetMs) && r.p95Ms > 0 && r.budgetMs > 0 && r.p95Ms <= r.budgetMs, why: `${r.event} p95 ${r.p95Ms} ms, budget ${r.budgetMs} ms` })),
            totals: [{ ok: events.length > 0 && paired.length === events.length, why: `${paired.length} of ${events.length} hook events sampled idle and load with installed profiles, needs every event` }],
        };
    },
};

// ---------------------------------------------------------------------------
// A5 worker-window
// ---------------------------------------------------------------------------

const workerWindow = {
    id: 'worker-window',
    source: 'autodev/execution-budget.json attempts (execution-budget.js), brain-clock passes as the heartbeat',
    // execution-budget.js landed 2026-10-14 (b025d619); its first attempt is 10-15T08:43Z.
    admissibleFrom: '2026-10-15',
    load(ctx) {
        const json = ctx.readJson(at(ctx.home, 'execution-budget.json'));
        if (!json) throw new Error('execution-budget.json cannot be read');
        const limit = 2 * CLOCK_MS;
        const recs = records(json).filter((a) => a && a.reservedAt).map((a) => {
            // launchedAt is after the capacity wait. Rows before it was recorded fall back to
            // startedAt, which counts queue time as settle lag.
            const started = Date.parse(a.launchedAt || a.startedAt || a.reservedAt);
            if (a.state === 'settled' || a.state === 'cancelled') {
                // A cancel never launched (cancel() settles exactly that), so it has no exit to time.
                if (a.state === 'cancelled' && !a.launchedAt && a.wallMs == null && a.exit == null) return { at: a.reservedAt, ok: true, why: null };
                if (!Number.isFinite(a.wallMs)) return { at: a.reservedAt, ok: false, why: `${a.attemptId}: settled with no wall time, so its exit time is unknown` };
                const lag = Date.parse(a.settledAt) - (started + a.wallMs);
                return { at: a.reservedAt, ok: lag <= limit, why: lag <= limit ? null : `${a.attemptId}: settled ${Math.round(lag / 60000)} min after it exited, over two clock intervals` };
            }
            const ceiling = (a.ceilings && a.ceilings.wallMs) || 0;
            const overdue = ctx.now - started > ceiling + limit;
            return { at: a.reservedAt, ok: !overdue, why: overdue ? `${a.attemptId}: still ${a.state} past its wall ceiling plus two clock intervals` : null };
        });
        // A day with no reservation is covered only when the clock ran that day.
        return { records: recs, coveredDays: clockDays(ctx) };
    },
};

// ---------------------------------------------------------------------------
// A6 instruction-window
// ---------------------------------------------------------------------------

/** The config dirs of every host profile: this one and `<this>-<name>` siblings that keep `log`. */
function profileDirs(home, log) {
    const parent = path.dirname(home);
    const base = path.basename(home);
    let sib = [];
    try { sib = fs.readdirSync(parent).filter((n) => n.startsWith(`${base}-`)).map((n) => path.join(parent, n)); } catch { /* only this profile */ }
    return [home, ...sib.filter((d) => fs.existsSync(path.join(d, 'logs', log)))];
}

// A profile whose login was given up writes `logs/instruction-envelope.retired.json`,
// { retiredAt: 'YYYY-MM-DD', reason }. From that day it is no longer required to start a session,
// and its earlier rows still count. A fresh session on or after retiredAt voids the marker, so a
// profile still in use cannot be excused. Amended 2026-10-29 for ~/.claude-b, expired 2026-10-25.
function retiredDay(ctx, dir) {
    const m = ctx.readJson(path.join(dir, 'logs', 'instruction-envelope.retired.json'));
    return m && typeof m.retiredAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.retiredAt)
        && typeof m.reason === 'string' && m.reason.trim() ? m.retiredAt : null;
}

// A fresh session is a start whose source is startup or clear, counted once per session id.
// resume and compact continue a session that was already measured.
const FRESH = new Set(['startup', 'clear']);

const instructionWindow = {
    id: 'instruction-window',
    source: 'logs/instruction-envelope.jsonl(.1) in every profile config dir (hooks/instruction-envelope.js)',
    // The hook writes the ledger from the release that ships it. A day before its first row is
    // a gap, never a pass, so a date earlier than the install only delays green.
    admissibleFrom: '2026-10-20',
    load(ctx) {
        const dirs = profileDirs(ctx.home, 'instruction-envelope.jsonl');
        const recs = [];
        const perProfile = [];
        for (const d of dirs) {
            const logs = path.join(d, 'logs');
            const days = new Set();
            const seen = new Set();
            for (const n of ['instruction-envelope.jsonl.1', 'instruction-envelope.jsonl']) {
                for (const r of ctx.readJsonl(path.join(logs, n)) || []) {
                    if (!r || !FRESH.has(r.source) || typeof r.sessionId !== 'string' || !Number.isFinite(Date.parse(r.at))) continue;
                    if (seen.has(r.sessionId)) continue;
                    seen.add(r.sessionId);
                    days.add(ctx.dayOf(Date.parse(r.at)));
                    recs.push({ at: r.at, ok: r.inside === true, why: r.inside === true ? null
                        : `${path.basename(d)}: session ${r.sessionId.slice(0, 8)} started outside the envelope (rules ${r.rulesTotal} of ${r.budget}, ${r.missing} missing, ${r.conflicts} conflicts)` });
                }
            }
            const retired = retiredDay(ctx, d);
            perProfile.push({ days, retired: retired && ![...days].some((day) => day >= retired) ? retired : null });
        }
        // A day counts only when every profile not yet retired on it started a fresh session on it.
        const coveredDays = new Set(ctx.windowDays.filter((day) => perProfile.length
            && perProfile.every((p) => (p.retired && day >= p.retired) || p.days.has(day))));
        return { records: recs, coveredDays };
    },
};

// ---------------------------------------------------------------------------
// A7 skill-window, A8 cost-window
// ---------------------------------------------------------------------------

const skillWindow = {
    id: 'skill-window',
    source: 'autodev/frontier/runs.jsonl and routing-comparisons.jsonl (frontier-evidence.js observer)',
    admissibleFrom: '2026-10-19',
    load(ctx) {
        const rows = ledger(ctx, 'frontier', 'runs.jsonl').filter((r) => r && (r.route || r.routedTo));
        const comparisons = new Map();
        for (const r of ledger(ctx, 'frontier', 'routing-comparisons.jsonl')) {
            if (r?.type !== 'routing-comparison' || !r.splitId || !Number.isFinite(Date.parse(r.at))) continue;
            if (!comparisons.has(r.splitId) || r.at >= comparisons.get(r.splitId).at) comparisons.set(r.splitId, r);
        }
        const current = [...comparisons.values()].filter((r) => Number.isFinite(Date.parse(r.evidenceAt)) && ctx.windowDays.includes(ctx.dayOf(Date.parse(r.evidenceAt))));
        const good = current.filter((r) => r.complete === true && r.nonInferior === true && r.expected > 0 && r.paired === r.expected
            && r.margin === 0.05 && Number.isFinite(r.delta) && r.delta >= -r.margin
            && r.method === 'paired finite-task pass-rate difference');
        return {
            records: rows.map((r) => ({ at: r.finishedAt || r.startedAt, ok: r.pass === true, why: `${r.run}: routed ${r.routedTo || r.route}, pass ${r.pass}` })),
            totals: [{ ok: current.length > 0 && good.length === current.length,
                why: `${good.length} of ${current.length} held-out routing comparisons meet the fixed non-inferiority margin` }],
        };
    },
};

const costWindow = {
    id: 'cost-window',
    source: 'autodev/delivery/outcomes.jsonl (delivery-outcomes.js) and cost-comparisons.jsonl (cost-repeats.js)',
    // `sync` first ran in production at 2026-10-24T22:59Z and runs from the clock after it, so
    // 10-25 is the first day whose tasks were synced by a live writer.
    admissibleFrom: '2026-10-25',
    load(ctx) {
        // sync appends an attempt row per attempt and an outcome row per task, and appends again
        // whenever one changes, stamping `at` with the sync time. The evidence is the task, so
        // each task is graded once, on its newest outcome row, on the day of its last attempt.
        // A first sync over old tasks therefore lands on their own days, never on the sync day.
        const latest = new Map();
        for (const r of ledger(ctx, 'delivery', 'outcomes.jsonl')) {
            if (!r || r.type !== 'outcome' || typeof r.taskId !== 'string' || !Number.isFinite(Date.parse(r.at))) continue;
            const prev = latest.get(r.taskId);
            if (!prev || Date.parse(r.at) >= Date.parse(prev.at)) latest.set(r.taskId, r);
        }
        const tasks = [...latest.values()].filter((r) => Number.isFinite(Date.parse(r.lastAttemptAt)));
        const days = new Set(ctx.windowDays.filter((d) => d >= costWindow.admissibleFrom));
        const accepted = tasks.filter((r) => r.accepted === true && Number.isFinite(r.costUsd) && days.has(ctx.dayOf(Date.parse(r.lastAttemptAt))));
        const pairs = new Map();
        for (const r of ledger(ctx, 'delivery', 'cost-comparisons.jsonl')) {
            if (!r || r.type !== 'cost-comparison' || !r.baseline?.taskId || !r.candidate?.taskId || !Number.isFinite(Date.parse(r.at))) continue;
            const key = JSON.stringify([r.baseline.taskId, r.candidate.taskId]);
            if (!pairs.has(key) || Date.parse(r.at) >= Date.parse(pairs.get(key).at)) pairs.set(key, r);
        }
        const comparisons = [...pairs.values()].filter((r) => days.has(ctx.dayOf(Date.parse(r.comparedAt)))
            && r.baseline.taskId !== r.candidate.taskId && typeof r.match === 'string' && /^(slug|brief):.+/.test(r.match)
            && [r.baseline, r.candidate].every((s) => {
                const o = latest.get(s.taskId);
                return o && Number.isFinite(s.costUsd) && s.costUsd >= 0 && s.costUsd === o.costUsd && s.accepted === o.accepted
                    && s.lastAttemptAt === o.lastAttemptAt && s.standingDay7 === (o.standingDay7 ?? null)
                    && ['accept', 'follow-up', 'escalate', 'reject'].includes(s.judgeOutcome)
                    && (s.judgeOutcome === 'accept') === s.accepted && Date.parse(s.judgedAt) >= Date.parse(s.lastAttemptAt);
            }));
        const quality = comparisons.filter((r) => r.baseline.accepted && r.candidate.accepted
            && r.baseline.costPerAcceptedTask === r.baseline.costUsd && r.candidate.costPerAcceptedTask === r.candidate.costUsd
            && r.qualityNonInferior === true && (r.baseline.standingDay7 !== true || r.candidate.standingDay7 === true));
        return {
            records: tasks.map((r) => ({ at: r.lastAttemptAt, ok: Number.isFinite(r.costUsd), why: `${r.taskId}: no cost` })),
            totals: [
                { ok: accepted.length > 0, why: `${accepted.length} accepted tasks carry a cost` },
                { ok: quality.length > 0 && quality.length === comparisons.length,
                    why: `${quality.length} of ${comparisons.length} matched repeats have cost per accepted task and non-inferior quality` },
            ],
        };
    },
};

// ---------------------------------------------------------------------------
// A9 acceptance-window
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
// host-uptime.js's day file: the ms the host was up that UTC day, or null when absent or malformed.
function hostUpMs(ctx, day) {
    const r = ctx.readJson(at(ctx.home, 'windows', 'host-up', `${day}.json`));
    if (!r || r.day !== day || typeof r.source !== 'string' || !Number.isFinite(r.upMs) || r.upMs < 0 || r.upMs > DAY_MS) return null;
    return r.upMs;
}

const acceptanceWindow = {
    id: 'acceptance-window',
    source: 'autodev/brain-judge judgements.jsonl (brain-judge.js), acceptance-audits.jsonl (acceptance-audit.js), and brain-clock passes',
    // An accept needs a verified acceptance receipt from 2026-10-14 (0493392b).
    admissibleFrom: '2026-10-15',
    load(ctx) {
        const rows = ledger(ctx, 'brain-judge', 'judgements.jsonl').filter((r) => r && r.mode === 'live');
        const recs = rows.map((r) => {
            const unsafe = r.decision === 'accept' && r.applied !== true;
            return { at: r.at, ok: !unsafe, why: unsafe ? `${r.taskId}: an accept that did not apply (${r.note || 'no note'})` : null };
        });
        const ticks = clockRows(ctx);
        const days = ctx.windowDays;
        const from = Date.parse(`${days[0]}T00:00:00Z`);
        const to = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 24 * 60 * 60 * 1000;
        const n = ticks.filter((t) => Date.parse(t.at) >= from && Date.parse(t.at) < to).length;
        // host-uptime.js gives each day the time the host was up, from the OS event log. A day with
        // no readable record keeps all 24 hours in the denominator, so a missing record never helps.
        const up = days.map((d) => hostUpMs(ctx, d));
        const known = up.filter((u) => u !== null).length;
        const expected = Math.round(up.reduce((a, u) => a + (u === null ? DAY_MS : u), 0) / CLOCK_MS);
        const share = expected ? n / expected : 0;
        const passing = drillRows(ctx).filter((r) => r.ok === true && days.includes(ctx.dayOf(Date.parse(r.at))));
        const audits = ledger(ctx, 'brain-judge', 'acceptance-audits.jsonl').filter((r) => r && r.type === 'acceptance-audit'
            && days.includes(ctx.dayOf(Date.parse(r.at))) && Date.parse(r.at) > Date.parse(r.acceptedAt));
        const accepts = rows.filter((r) => r.decision === 'accept' && r.applied === true && days.includes(ctx.dayOf(Date.parse(r.at))));
        const checked = accepts.filter((r) => audits.some((a) => a.taskId === r.taskId && a.acceptedAt === r.at && typeof a.foundWrong === 'boolean'));
        const wrong = audits.filter((r) => r.foundWrong === true);
        return {
            records: recs,
            coveredDays: clockDays(ctx),
            totals: [
                { ok: expected > 0 && share >= 0.995, why: `host ticks ${n} of ${expected} (${(share * 100).toFixed(1)}%), needs 99.5%, host up time known for ${known} of ${days.length} days` },
                { ok: checked.length > 0 && checked.length === accepts.length && wrong.length === 0,
                    why: `${checked.length} of ${accepts.length} accepts later audited; ${wrong.length} found wrong` },
                drillTotal(passing),
            ],
        };
    },
};

// ---------------------------------------------------------------------------
// A10 queue-window
// ---------------------------------------------------------------------------

const queueWindow = {
    id: 'queue-window',
    source: 'autodev/worker-reconcile/events.jsonl, brain-clock passes and windows/account-switch-drills.jsonl (account-switch-drill.js)',
    // The account-switch drill writer starts this window.
    admissibleFrom: '2026-10-29',
    load(ctx) {
        const rows = ledger(ctx, 'worker-reconcile', 'events.jsonl');
        const recs = rows.filter((r) => r && r.at).map((r) => {
            const lost = r.outcome === 'UNKNOWN' || r.outcome === 'REJECT';
            return { at: r.at, ok: !lost, why: lost ? `${r.taskId}: ${r.outcome} (${r.why || ''})` : null };
        });
        const drills = ledger(ctx, 'windows', 'account-switch-drills.jsonl').filter((r) => r && ctx.windowDays.includes(ctx.dayOf(Date.parse(r.at))));
        const valid = (r) => r.ok === true && r.kind === 'account-switch' && r.mode === 'synthetic-shared-queue'
            && Number.isInteger(r.queued) && r.queued >= 2 && r.kept === r.queued && r.configSwitched === true
            && r.launched === 1 && r.reconciled === 1 && Number.isFinite(r.durationMs) && r.durationMs > 0 && r.durationMs < 90000;
        const passing = drills.filter(valid);
        return { records: recs.concat(drills.map((r) => ({ at: r.at, ok: valid(r), why: `account switch drill failed: ${r.why || 'incomplete evidence'}` }))),
            coveredDays: clockDays(ctx), totals: [{ ok: passing.length > 0, why: `${passing.length} passing account switch drill(s) in the window, needs 1` }] };
    },
};

// ---------------------------------------------------------------------------
// A11 visibility-window, A16 owner-window
// ---------------------------------------------------------------------------

const visibilityWindow = {
    id: 'visibility-window',
    source: 'autodev/owner-asks/ledger.jsonl (owner-asks.js)',
    // The ledger's first row is 2026-10-14T16:51Z.
    admissibleFrom: '2026-10-15',
    load(ctx) {
        const rows = ledger(ctx, 'owner-asks', 'ledger.jsonl').filter((r) => r && r.at);
        const recs = rows.filter((r) => r.type === 'os-submitted').map((r) => ({ at: r.at, ok: r.exit === 0, why: r.exit === 0 ? null : `${r.key}: delivery via ${r.via} exited ${r.exit}` }));
        const from = `${ctx.windowDays[0]}T00:00:00Z`;
        const acks = rows.filter((r) => r.type === 'receipt' && r.by === 'owner' && r.at >= from
            && rows.some((s) => s.type === 'os-submitted' && s.key === r.key && s.at <= r.at));
        return {
            records: recs,
            coveredDays: clockDays(ctx),
            totals: [{ ok: acks.length > 0, why: `${acks.length} owner acknowledgments (a receipt after a delivered ask) in the window` }],
        };
    },
};

const ownerWindow = {
    id: 'owner-window',
    source: 'autodev/owner-asks/ledger.jsonl owner-time rows (owner-asks.js and owner-time-baseline.js)',
    admissibleFrom: '2026-10-15',
    load(ctx) {
        const rows = ledger(ctx, 'owner-asks', 'ledger.jsonl').filter((r) => r && r.at && /^owner-time-/.test(r.type || ''));
        const latest = new Map();
        for (const r of rows) if (r.type === 'owner-time-baseline' && Number.isFinite(Date.parse(r.at)) && /^\d{4}-\d{2}-\d{2}$/.test(r.weekStart || '')) {
            if (!latest.has(r.weekStart) || Date.parse(r.at) >= Date.parse(latest.get(r.weekStart).at)) latest.set(r.weekStart, r);
        }
        const weeks = [...latest.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
        const valid = (r) => r.measured === true && r.source === 'active-owner-time' && r.openTimer === false
            && Number.isFinite(r.ownerMinutes) && r.ownerMinutes >= 0 && Number.isInteger(r.acceptedTasks) && r.acceptedTasks > 0
            && r.deliveredAsks > 0 && r.timingRecords > 0 && Number.isFinite(r.minutesPerAcceptedTask)
            && Math.abs(r.minutesPerAcceptedTask - r.ownerMinutes / r.acceptedTasks) < 1e-9
            && Date.parse(r.weekEnd) - Date.parse(r.weekStart) === 7 * DAY_MS && Date.parse(r.at) >= Date.parse(r.weekEnd);
        const baseline = weeks.find((r) => valid(r) && r.weekEnd <= ctx.windowDays[0] && r.minutesPerAcceptedTask > 0);
        const current = weeks.filter((r) => ctx.windowDays.includes(ctx.dayOf(Date.parse(r.weekEnd) - 1)));
        const reduced = current.filter((r) => valid(r) && baseline && r.minutesPerAcceptedTask <= 0.8 * baseline.minutesPerAcceptedTask);
        return {
            records: rows.map((r) => ({ at: r.at, ok: true, why: null })),
            coveredDays: clockDays(ctx),
            totals: [
                { ok: rows.length > 0, why: `${rows.length} owner-time rows in the ledger` },
                { ok: !!baseline && current.length > 0 && reduced.length === current.length,
                    why: `${reduced.length} of ${current.length} measured weeks at most 0.8 of ${baseline ? baseline.minutesPerAcceptedTask : 'unknown'} baseline owner minutes per accepted task` },
            ],
        };
    },
};

// ---------------------------------------------------------------------------
// A12 locking-window, A13 learning-window
// ---------------------------------------------------------------------------

// Every shipped module that requires ledger-lock.js, as `<dir>~<file>`. test-window-probe.js
// greps the plugins for those requires and fails when the grep and this list disagree.
const LOCK_WRITERS = ['hooks~peer-send-ledger.js', 'scripts~ask-queue.js', 'scripts~brain-clock.js', 'scripts~delivery-outcomes.js', 'scripts~execution-budget.js',
    'scripts~frontier-evidence.js', 'scripts~production-signals.js', 'scripts~radar-learning.js', 'scripts~watch-panels.js', 'scripts~worker-reconcile.js'];

const lockingWindow = {
    id: 'locking-window',
    source: 'autodev/windows/lock-writers/<day>/<writer>@<version> marks (ledger-lock.js), brain-clock passes',
    // ledger-lock.js marks from the release that ships it. A writer not yet seen fails the total.
    admissibleFrom: '2026-10-20',
    load(ctx) {
        const base = at(ctx.home, 'windows', 'lock-writers');
        const recs = [];
        const seen = new Set();
        for (const day of ctx.windowDays) {
            let names = [];
            try { names = fs.readdirSync(path.join(base, day)); } catch { continue; }
            for (const n of names.sort()) {
                const m = /^(.+)@(.+)$/.exec(n);
                const writer = m ? m[1] : n;
                const known = LOCK_WRITERS.includes(writer);
                const versioned = Boolean(m) && m[2] !== 'unknown';
                if (known && versioned) seen.add(writer);
                recs.push({ at: `${day}T00:00:00Z`, ok: known && versioned,
                    why: !known ? `${n} took a lock but is not in the inventory` : versioned ? null : `${n} took a lock with no plugin version` });
            }
        }
        const missing = LOCK_WRITERS.filter((w) => !seen.has(w));
        return {
            records: recs,
            coveredDays: clockDays(ctx),
            totals: [{ ok: !missing.length, why: `${LOCK_WRITERS.length - missing.length} of ${LOCK_WRITERS.length} inventoried writers took a lock on the installed layer${missing.length ? `, not ${missing.join(', ')}` : ''}` }],
        };
    },
};

const learningWindow = {
    id: 'learning-window',
    source: 'autodev/frontier/runs.jsonl (tooling/frontier/run.js), rows that name a plan arm',
    // The plan arm is recorded from 2026-10-18 (8e06ed7a); the plan was preregistered 10-14.
    admissibleFrom: '2026-10-18',
    load(ctx) {
        const rows = ledger(ctx, 'frontier', 'runs.jsonl').filter((r) => r && r.startedAt);
        const counted = rows.filter((r) => r.arm && r.startedAt >= '2026-10-18');
        const heldOut = rows.filter((r) => r.split === 'held-out' && Number.isFinite(Date.parse(r.startedAt))
            && ctx.windowDays.includes(ctx.dayOf(Date.parse(r.startedAt))));
        const sealed = heldOut.filter((r) => r.sealed === true && /^[a-f0-9]{64}$/.test(r.heldOutHash || '')
            && /^[a-f0-9]{64}$/.test(r.splitId || '') && /^[a-f0-9]{64}$/.test(r.taskIdHash || '')
            && r.seal?.contentMatches === true && r.seal.currentHash === r.heldOutHash && r.seal.visibleToLearning === false
            && Array.isArray(r.seal.errors) && r.seal.errors.length === 0 && Array.isArray(r.seal.hits) && r.seal.hits.length === 0
            && Date.parse(r.splitAt) <= Date.parse(r.seal.checkedAt) && Date.parse(r.seal.checkedAt) <= Date.parse(r.startedAt));
        return {
            records: counted.map((r) => ({ at: r.startedAt, ok: Number.isFinite(r.exit) && r.exit === 0, why: `${r.run}: exit ${r.exit}` })),
            coveredDays: clockDays(ctx),
            totals: [
                { ok: counted.length >= 108, why: `${counted.length} of 108 bounded calibration runs with a plan arm` },
                { ok: heldOut.length > 0 && sealed.length === heldOut.length,
                    why: `${sealed.length} of ${heldOut.length} held-out runs were sealed before execution` },
            ],
        };
    },
};

// ---------------------------------------------------------------------------
// A14 delivery-window
// ---------------------------------------------------------------------------

const deliveryWindow = {
    id: 'delivery-window',
    source: 'autodev/unattended-workers.json records and brain-judge/judgements.jsonl live verdicts',
    // The acceptance rule changed on 2026-10-14 (0493392b): accepts before it are another kind.
    admissibleFrom: '2026-10-15',
    load(ctx) {
        const json = ctx.readJson(at(ctx.home, 'unattended-workers.json'));
        if (!json) throw new Error('unattended-workers.json cannot be read');
        const from = `${ctx.windowDays[0]}T00:00:00Z`;
        const tasks = records(json).filter((r) => r && r.taskId && (r.startedAt || r.composedAt || '') >= from
            && (r.startedAt || r.composedAt || '') >= `${this.admissibleFrom}T00:00:00Z`);
        const verdicts = ledger(ctx, 'brain-judge', 'judgements.jsonl').filter((r) => r && r.mode === 'live');
        const first = (id) => verdicts.filter((v) => v.taskId === id).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
        const accepted = tasks.filter((t) => { const v = first(t.taskId); return v && v.decision === 'accept' && v.applied === true; });
        const rate = tasks.length ? accepted.length / tasks.length : 0;
        return {
            records: tasks.map((t) => ({ at: t.startedAt || t.composedAt, ok: true, why: null })),
            coveredDays: clockDays(ctx),
            totals: [
                { ok: tasks.length >= 30, why: `${tasks.length} real tasks, needs 30` },
                { ok: tasks.length > 0 && rate >= 0.9, why: `first-attempt acceptance ${accepted.length} of ${tasks.length}, needs 90%` },
            ],
        };
    },
};

// ---------------------------------------------------------------------------
// A15 capacity-window, A17 recovery-window
// ---------------------------------------------------------------------------

// The trend looks this far ahead of the newest snapshot in the window.
const TREND_DAYS = 14;
const GIB = 1024 * 1024 * 1024;
const gib = (b) => `${(b / GIB).toFixed(1)} GiB`;

/**
 * The stable-trend total: a least-squares line through each day's last volume reading,
 * projected TREND_DAYS past the newest one, must leave the free space capacity.js
 * admits against (its disk reserve for that volume size). Fewer than two days of
 * readings is short, never a pass.
 */
function volumeTrend(snaps, windowDays, dayOf, diskReserve) {
    const byDay = new Map();
    for (const s of snaps) {
        const t = Date.parse(s.takenUtc);
        const v = s.volume;
        if (!v || !Number.isFinite(v.usedBytes) || !Number.isFinite(v.totalBytes) || v.totalBytes <= 0) continue;
        const d = dayOf(t);
        if (!windowDays.includes(d)) continue;
        const prev = byDay.get(d);
        if (!prev || t > prev.t) byDay.set(d, { t, used: v.usedBytes, total: v.totalBytes });
    }
    const pts = [...byDay.values()].sort((a, b) => a.t - b.t);
    if (pts.length < 2) return { ok: false, why: `${pts.length} day(s) of volume readings in the window, the trend needs 2` };
    const x = pts.map((p) => (p.t - pts[0].t) / 86400000);
    const mx = x.reduce((a, b) => a + b, 0) / x.length;
    const my = pts.reduce((a, p) => a + p.used, 0) / pts.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < pts.length; i++) { num += (x[i] - mx) * (pts[i].used - my); den += (x[i] - mx) ** 2; }
    const slope = den ? num / den : 0;
    const last = pts[pts.length - 1];
    const projectedFree = last.total - (my + slope * (x[x.length - 1] + TREND_DAYS - mx));
    const reserve = diskReserve(last.total);
    const sign = slope >= 0 ? '+' : '-';
    return {
        ok: projectedFree >= reserve,
        why: `volume ${sign}${gib(Math.abs(slope))}/day over ${pts.length} days leaves ${gib(projectedFree)} free in ${TREND_DAYS} days, ${projectedFree >= reserve ? 'inside' : 'under'} the ${gib(reserve)} reserve`,
    };
}

const capacityWindow = {
    id: 'capacity-window',
    source: 'autodev/lifecycle/journal.jsonl and snapshots.jsonl (lifecycle.js), autodev/locks/full-gate.capacity-observe.jsonl (capacity.js observe)',
    // The observer runs from the brain clock once a release carries `capacity.js observe`.
    admissibleFrom: '2026-10-20',
    load(ctx) {
        const journal = ledger(ctx, 'lifecycle', 'journal.jsonl');
        const snaps = ledger(ctx, 'lifecycle', 'snapshots.jsonl');
        // A removal journal row carries no protected flag, so each removed path is
        // classified by lifecycle.js's own PROTECTED table, the definition of protected.
        const { protectedClass } = require('../plugins/autodev-core/scripts/lifecycle.js');
        const recs = journal.filter((r) => r && r.utc).map((r) => {
            const cls = r.op === 'remove' && r.state === 'done' && r.path ? protectedClass(r.path) : null;
            return { at: r.utc, ok: !cls, why: cls ? `removed ${r.path}, protected class ${cls}` : null };
        });
        // lifecycle.js stamps a snapshot `takenUtc` and a journal row `utc`.
        const goodSnaps = snaps.filter((s) => s && Number.isFinite(Date.parse(s.takenUtc)));
        const snapDays = new Set(goodSnaps.map((s) => ctx.dayOf(Date.parse(s.takenUtc))));
        // capacity.js observe: a breach is admitted load past a reserve. An unknown probe
        // row is neither a breach nor coverage.
        const obs = ledger(ctx, 'locks', 'full-gate.capacity-observe.jsonl').filter((r) => r && Number.isFinite(Date.parse(r.at)) && !r.unknown);
        for (const r of obs) recs.push({ at: r.at, ok: r.breach !== true, why: r.breach === true ? `admission breach with ${r.reservations} reservation(s): ${r.why}` : null });
        const obsDays = new Set(obs.map((r) => ctx.dayOf(Date.parse(r.at))));
        const covered = new Set([...snapDays].filter((d) => obsDays.has(d)));
        const { diskReserve } = require('../plugins/autodev-core/scripts/capacity.js');
        return { records: recs, coveredDays: covered, totals: [volumeTrend(goodSnaps, ctx.windowDays, ctx.dayOf, (t) => diskReserve(t))] };
    },
};

// restore-drill.js rows. A drill passes only inside 60 minutes with every delivered intent kept,
// which the writer checks; the reader checks the numbers again rather than trust `ok` alone.
const DRILL_LIMIT_MS = 60 * 60 * 1000;
function drillRows(ctx) {
    return ledger(ctx, 'windows', 'restore-drills.jsonl').filter((r) => r && Number.isFinite(Date.parse(r.at))).map((r) => {
        const kept = Number.isInteger(r.intentsDelivered) && r.intentsKept === r.intentsDelivered;
        const fast = Number.isFinite(r.durationMs) && r.durationMs <= DRILL_LIMIT_MS;
        if (r.ok === true && (!kept || !fast)) return { ...r, ok: false, why: `marked passed with ${r.intentsKept} of ${r.intentsDelivered} intents kept in ${r.durationMs} ms` };
        return r;
    });
}
function drillTotal(passing) {
    const n = passing.length;
    return { ok: n > 0, why: `${n} passing restore drill(s) in the window, needs 1${n ? `, the slowest ${Math.max(...passing.map((r) => r.durationMs))} ms` : ''}` };
}

const recoveryWindow = {
    id: 'recovery-window',
    source: 'autodev/windows/restore-drills.jsonl (restore-drill.js) and brain-clock passes',
    // The drill runs from the brain clock once a release carries restore-drill.js.
    admissibleFrom: '2026-10-20',
    load(ctx) {
        const rows = drillRows(ctx);
        const days = new Set(ctx.windowDays);
        const passing = rows.filter((r) => r.ok === true && days.has(ctx.dayOf(Date.parse(r.at))));
        return {
            records: rows.map((r) => ({ at: r.at, ok: r.ok === true, why: r.ok === true ? null : `restore drill failed: ${r.why || 'no reason recorded'}` })),
            coveredDays: clockDays(ctx),
            totals: [drillTotal(passing)],
        };
    },
};

const SPECS = [gateWindow, releaseWindow, authorityWindow, hookWindow, workerWindow, instructionWindow, skillWindow,
    costWindow, acceptanceWindow, queueWindow, visibilityWindow, lockingWindow, learningWindow, deliveryWindow,
    capacityWindow, ownerWindow, recoveryWindow];

module.exports = { SPECS, LOCK_WRITERS, gateEvidenceFault, fastEvidenceFault, CLOCK_MS, TICKS_PER_DAY };
