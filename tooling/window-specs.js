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
        if (log === null) throw new Error('git log origin/main failed, so merge days are unknown');
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
    source: 'autodev/headless-workers.json records (headless-worker.js)',
    // worker-authority landed 2026-10-14 (ebe493b6); every run before it was bypassPermissions.
    admissibleFrom: '2026-10-15',
    load(ctx) {
        const json = ctx.readJson(at(ctx.home, 'headless-workers.json'));
        if (!json) throw new Error('headless-workers.json cannot be read');
        const recs = records(json).filter((r) => r && r.startedAt).map((r) => {
            const ok = r.permissionMode === 'dontAsk' && Boolean(r.profile);
            return { at: r.startedAt, ok, why: ok ? null : `${r.code}: ran ${r.permissionMode || 'with no permission mode'}${r.profile ? '' : ' and no profile'}, outside the boundary` };
        });
        return { records: recs, totals: [noWriter('a boundary escape (a call the policy should deny that ran); denials reach only free-text worker logs, so zero escapes cannot be shown')] };
    },
};

// ---------------------------------------------------------------------------
// A4 hook-window
// ---------------------------------------------------------------------------

const hookWindow = {
    id: 'hook-window',
    source: 'autodev/windows/hook-wall.jsonl (no writer yet); Claude Code transcripts time Stop hooks only',
    admissibleFrom: '2026-10-19',
    load(ctx) {
        const rows = ledger(ctx, 'windows', 'hook-wall.jsonl');
        return {
            records: rows.map((r) => ({ at: r.at, ok: Number.isFinite(r.p95Ms) && Number.isFinite(r.budgetMs) && r.p95Ms <= r.budgetMs, why: `${r.event} p95 ${r.p95Ms} ms, budget ${r.budgetMs} ms` })),
            totals: [noWriter('installed-profile hook wall time per event with an idle or load tag; transcripts carry Stop-hook timing only, with no profile or load label')],
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
            const started = Date.parse(a.startedAt || a.reservedAt);
            if (a.state === 'settled' || a.state === 'cancelled') {
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
            perProfile.push(days);
        }
        // A day counts only when every profile started a fresh session on it.
        const coveredDays = new Set(ctx.windowDays.filter((day) => perProfile.length && perProfile.every((p) => p.has(day))));
        return { records: recs, coveredDays };
    },
};

// ---------------------------------------------------------------------------
// A7 skill-window, A8 cost-window
// ---------------------------------------------------------------------------

const skillWindow = {
    id: 'skill-window',
    source: 'autodev/frontier/runs.jsonl rows with a route (tooling/frontier/run.js)',
    admissibleFrom: '2026-10-19',
    load(ctx) {
        const rows = ledger(ctx, 'frontier', 'runs.jsonl').filter((r) => r && (r.route || r.routedTo));
        return {
            records: rows.map((r) => ({ at: r.finishedAt || r.startedAt, ok: r.pass === true, why: `${r.run}: routed ${r.routedTo || r.route}, pass ${r.pass}` })),
            totals: [noWriter('a production routing outcome on a held-out split with a non-inferiority comparison')],
        };
    },
};

const costWindow = {
    id: 'cost-window',
    source: 'autodev/delivery/outcomes.jsonl (delivery-outcomes.js), never written in production',
    admissibleFrom: '2026-10-19',
    load(ctx) {
        const rows = ledger(ctx, 'delivery', 'outcomes.jsonl');
        const accepted = rows.filter((r) => r && r.accepted && Number.isFinite(r.costUsd));
        return {
            records: rows.map((r) => ({ at: r.at, ok: Number.isFinite(r.costUsd), why: `${r.taskId}: no cost` })),
            totals: [
                { ok: accepted.length > 0, why: `${accepted.length} accepted tasks carry a cost` },
                noWriter('matched repeats with a quality comparison for cost per accepted task'),
            ],
        };
    },
};

// ---------------------------------------------------------------------------
// A9 acceptance-window
// ---------------------------------------------------------------------------

const acceptanceWindow = {
    id: 'acceptance-window',
    source: 'autodev/brain-judge/judgements.jsonl (brain-judge.js) and brain-clock passes',
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
        const expected = days.length * TICKS_PER_DAY;
        const share = n / expected;
        return {
            records: recs,
            coveredDays: clockDays(ctx),
            totals: [
                // No record says when the host or the task was enabled, so every hour of the window is the denominator.
                { ok: share >= 0.995, why: `host ticks ${n} of ${expected} (${(share * 100).toFixed(1)}%), needs 99.5%` },
                noWriter('an accept later found wrong, the unsafe accept the needs counts'),
                noWriter('a recovery drill'),
            ],
        };
    },
};

// ---------------------------------------------------------------------------
// A10 queue-window
// ---------------------------------------------------------------------------

const queueWindow = {
    id: 'queue-window',
    source: 'autodev/worker-reconcile/events.jsonl (worker-reconcile.js) for lost tasks, brain-clock passes',
    // worker-reconcile.js landed 2026-10-14 (90da59d9); its first event is 10-15T08:18Z.
    admissibleFrom: '2026-10-15',
    load(ctx) {
        const rows = ledger(ctx, 'worker-reconcile', 'events.jsonl');
        const recs = rows.filter((r) => r && r.at).map((r) => {
            const lost = r.outcome === 'UNKNOWN' || r.outcome === 'REJECT';
            return { at: r.at, ok: !lost, why: lost ? `${r.taskId}: ${r.outcome} (${r.why || ''})` : null };
        });
        return { records: recs, coveredDays: clockDays(ctx), totals: [noWriter('an account switch drill')] };
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
    source: 'autodev/owner-asks/ledger.jsonl owner-time rows (owner-asks.js)',
    admissibleFrom: '2026-10-15',
    load(ctx) {
        const rows = ledger(ctx, 'owner-asks', 'ledger.jsonl').filter((r) => r && r.at && /^owner-time-/.test(r.type || ''));
        return {
            records: rows.map((r) => ({ at: r.at, ok: true, why: null })),
            coveredDays: clockDays(ctx),
            totals: [
                { ok: rows.length > 0, why: `${rows.length} owner-time rows in the ledger` },
                noWriter('a baseline of owner minutes per accepted task'),
            ],
        };
    },
};

// ---------------------------------------------------------------------------
// A12 locking-window, A13 learning-window
// ---------------------------------------------------------------------------

const lockingWindow = {
    id: 'locking-window',
    source: 'ledger-lock.js leaves .done files and sweeps them; brain-clock passes',
    admissibleFrom: '2026-10-19',
    load(ctx) {
        return { records: [], coveredDays: clockDays(ctx), totals: [noWriter('which inventoried writer took the ledger lock, on which installed version')] };
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
        return {
            records: counted.map((r) => ({ at: r.startedAt, ok: Number.isFinite(r.exit) && r.exit === 0, why: `${r.run}: exit ${r.exit}` })),
            coveredDays: clockDays(ctx),
            totals: [
                { ok: counted.length >= 108, why: `${counted.length} of 108 bounded calibration runs with a plan arm` },
                noWriter('that a run\'s held-out task was sealed'),
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

const capacityWindow = {
    id: 'capacity-window',
    source: 'autodev/lifecycle/journal.jsonl and snapshots.jsonl (lifecycle.js), never written in production',
    admissibleFrom: '2026-10-19',
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
        const snapDays = new Set(snaps.filter((s) => s && (s.utc || s.at)).map((s) => ctx.dayOf(Date.parse(s.utc || s.at))));
        return { records: recs, coveredDays: snapDays, totals: [noWriter('an admission breach (a run admitted past capacity)')] };
    },
};

const recoveryWindow = {
    id: 'recovery-window',
    source: 'autodev/events.jsonl runtime events (runtime-release.js) and runtime/backups',
    admissibleFrom: '2026-10-19',
    load(ctx) {
        const rows = ledger(ctx, 'events.jsonl').filter((r) => r && typeof r.type === 'string' && /^runtime\.restore/.test(r.type));
        return {
            records: rows.map((r) => ({ at: r.at, ok: true, why: null })),
            coveredDays: clockDays(ctx),
            totals: [noWriter('a restore drill with its duration and the intents it kept')],
        };
    },
};

const SPECS = [gateWindow, releaseWindow, authorityWindow, hookWindow, workerWindow, instructionWindow, skillWindow,
    costWindow, acceptanceWindow, queueWindow, visibilityWindow, lockingWindow, learningWindow, deliveryWindow,
    capacityWindow, ownerWindow, recoveryWindow];

module.exports = { SPECS, gateEvidenceFault, fastEvidenceFault, CLOCK_MS, TICKS_PER_DAY };
