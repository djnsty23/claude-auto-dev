#!/usr/bin/env node
'use strict';
/**
 * judge-panel.js - a panel of independent vision judges over blind
 * before/after pairs, used as a ratchet when hill-climbing a UI: an iteration
 * is kept only when the panel prefers the after side and finds no real
 * regression.
 *
 *   node judge-panel.js run <pairs dir> [--judges 3] [--model <id>] [--batch 6]
 *        [--max-loss-share 0.1] [--reference <dir>] [--owner <picks.json>]
 *        [--claude-bin <path>] [--config-dir <dir>] [--json]
 *
 * <pairs dir> is what `unslop-sweep.js pairs` writes: pairs.json (ids and
 * image names) and .key.json (which side is the after). Judges see the images
 * and pairs.json only, never the key. Every capture appears in both orders, so
 * a judge reading by position scores nothing (unslop-sweep.js scorePairs).
 *
 * WHY A PANEL. One model's preference is noise with a confident voice. Each
 * judge takes a different lens (product designer, first-time phone visitor,
 * conversion reviewer) and answers alone; the panel's verdict per pair is the
 * majority, and the agreement rate is printed beside it. `--owner` scores the
 * panel against the owner's own picks for the same ids: until that agreement
 * is known, the panel is a ratchet against regressions, not calibration of
 * taste.
 *
 * JUDGES. A tool-less `claude -p` per batch, images sent as stream-json
 * content blocks, verdicts returned under --json-schema. Each call reserves a
 * judge attempt in the shared execution budget and machine capacity, as
 * brain-judge.js does, and settles it with the cost the CLI reported.
 * `[measured 2026-10-29]` a tool-less claude -p 2.1.312 read two images sent
 * this way and named both colours correctly.
 *
 * --reference <dir>: up to 4 approved reference screenshots shown to every
 * judge as the quality bar. Pass only references the owner approved.
 *
 * --judges takes 2 to 7, and a decision needs a majority of them and never
 * fewer than 2 complete judges. A pairs.json marked `blind: false` (made with
 * `--seed`) is refused: its key can be rebuilt from the seed.
 *
 * Writes <pairs dir>/panel.json. Exit: 0 KEEP (after preferred, losses within
 * --max-loss-share of judged captures), 1 REVERT, 2 could not judge (fewer
 * than a quorum of judges answered every pair, or a bad argument).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const hw = require('./headless-worker.js');
const capacity = require('./capacity.js');
const budget = require('./execution-budget.js');
const { scorePairs } = require('./unslop-sweep.js');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_REFERENCES = 4;
// The fewest complete judges behind any decision, whatever the panel size.
const MIN_JUDGES = 2;
const LENSES = [
    'a senior product designer judging craft: visual hierarchy, alignment, spacing rhythm, typography, contrast and finish',
    'a first-time visitor on a phone deciding in five seconds whether this business is trustworthy and what to do next',
    'a conversion reviewer: is the primary action obvious, is the copy clear, does anything distract, overlap or look broken',
];
const VERDICT_SCHEMA = {
    type: 'object',
    properties: {
        verdicts: { type: 'object', additionalProperties: { type: 'string', enum: ['a', 'b', 'tie'] } },
        notes: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['verdicts'],
};

class Bail extends Error { constructor(code, msg) { super(msg); this.exitCode = code; } }

function parseArgs(argv) {
    const o = { _: [], judges: 3, model: DEFAULT_MODEL, batch: 6, maxLossShare: 0.1, json: false };
    const num = (v, name, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Bail(2, `--${name} takes ${lo} to ${hi}`); return n; };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') o.json = true;
        // One judge is one model's preference, not a panel: it could KEEP alone.
        else if (a === '--judges') o.judges = num(argv[++i], 'judges', MIN_JUDGES, 7);
        else if (a === '--batch') o.batch = num(argv[++i], 'batch', 1, 12);
        else if (a === '--max-loss-share') o.maxLossShare = num(argv[++i], 'max-loss-share', 0, 1);
        else if (a === '--model') o.model = argv[++i];
        else if (a === '--reference') o.reference = argv[++i];
        else if (a === '--owner') o.owner = argv[++i];
        else if (a === '--claude-bin') o.claudeBin = argv[++i];
        else if (a === '--config-dir') o.configDir = argv[++i];
        else if (a.startsWith('--')) throw new Bail(2, `unknown flag ${a}`);
        else o._.push(a);
    }
    return o;
}

const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
function imageBlock(file) {
    const media = MEDIA[path.extname(file).toLowerCase()];
    if (!media) throw new Bail(2, `not an image: ${file}`);
    return { type: 'image', source: { type: 'base64', media_type: media, data: fs.readFileSync(file).toString('base64') } };
}

function referenceFiles(dir) {
    if (!dir) return [];
    return fs.readdirSync(dir).filter((n) => MEDIA[path.extname(n).toLowerCase()]).sort().slice(0, MAX_REFERENCES).map((n) => path.join(dir, n));
}

/** One judge call's user message: the lens, the references, then each pair as A and B. */
function buildMessage(lens, pairs, dir, refs) {
    const content = [{ type: 'text', text: `You are ${lens}. You judge screenshots of the same screen before and after a change, shown in a random order. `
        + 'For each pair, answer which image is the better UI by your lens: "a", "b", or "tie" when you cannot tell them apart or neither is better. '
        + 'Judge the interface, not the data shown in it. Judge each pair on its own. Add a short note for any pair you do not call a tie.' }];
    if (refs.length) {
        content.push({ type: 'text', text: 'Approved references for the quality bar this product aims at (not part of any pair):' });
        for (const r of refs) content.push(imageBlock(r));
    }
    for (const p of pairs) {
        content.push({ type: 'text', text: `Pair ${p.id}, image A:` }, imageBlock(path.join(dir, p.a)),
            { type: 'text', text: `Pair ${p.id}, image B:` }, imageBlock(path.join(dir, p.b)));
    }
    content.push({ type: 'text', text: `Return verdicts for exactly these ids: ${pairs.map((p) => p.id).join(', ')}.` });
    return { type: 'user', message: { role: 'user', content } };
}

/** The last `result` event of a stream-json run, as verdicts or an error. Never throws. */
function parseRun(r, ids) {
    if (r.error) return { ok: false, error: r.error.code === 'ETIMEDOUT' ? 'timeout' : `spawn-${r.error.code || 'failed'}` };
    const events = String(r.stdout || '').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const res = events.filter((e) => e && e.type === 'result').pop();
    if (!res) return { ok: false, error: `no-result-exit-${r.status}` };
    const cost = typeof res.total_cost_usd === 'number' ? res.total_cost_usd : null;
    const turns = typeof res.num_turns === 'number' ? res.num_turns : null;
    if (res.is_error || r.status !== 0) return { ok: false, error: `judge-error: ${String(res.result || res.subtype || `exit ${r.status}`).slice(0, 160)}`, costUsd: cost, turns };
    const v = res.structured_output && res.structured_output.verdicts;
    if (!v || typeof v !== 'object') return { ok: false, error: 'no-structured-verdicts', costUsd: cost, turns };
    const verdicts = {};
    for (const id of ids) if (['a', 'b', 'tie'].includes(v[id])) verdicts[id] = v[id];
    const missing = ids.filter((id) => !verdicts[id]);
    if (missing.length) return { ok: false, error: `unanswered ${missing.join(',')}`, costUsd: cost, turns };
    const notes = res.structured_output.notes && typeof res.structured_output.notes === 'object' ? res.structured_output.notes : {};
    return { ok: true, verdicts, notes, costUsd: cost, turns };
}

function judgeBatch({ lens, pairs, dir, refs, o, judgeIndex }) {
    const message = buildMessage(lens, pairs, dir, refs);
    const ceilings = budget.ceilingsFor('judge');
    const argv = [hw.resolveClaudeBin(o.claudeBin || 'claude'), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
        '--max-turns', String(ceilings.maxTurns), '--max-budget-usd', String(ceilings.maxUsd),
        '--json-schema', JSON.stringify(VERDICT_SCHEMA), '--model', o.model];
    const plan = hw.spawnPlan(argv);
    const { env } = hw.buildEnv(process.env, { code: 'judge-panel', configDir: o.configDir || null, kind: 'judge' });
    const c = capacity.admit({ cls: 'judge', path: dir, note: `judge-panel ${judgeIndex}` });
    if (!c.admitted) return { ok: false, error: `capacity-deferred: ${c.why}`, costUsd: 0 };
    const attemptId = `panel-${judgeIndex}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const b = budget.reserve({ attemptId, kind: 'judge', billing: budget.billingOf(env), account: o.configDir ? path.basename(o.configDir) : 'default', note: 'judge-panel' });
    if (!b.ok) { capacity.release(c.id); return { ok: false, error: `budget-deferred: ${b.why}`, costUsd: 0 }; }
    budget.begin(attemptId, { pid: process.pid });
    const started = Date.now();
    let out = null;
    try {
        const r = spawnSync(plan.command, plan.args, { input: JSON.stringify(message) + '\n', encoding: 'utf8', timeout: ceilings.wallMs, windowsHide: true, env, cwd: dir, maxBuffer: ceilings.outputBytes });
        out = parseRun(r, pairs.map((p) => p.id));
        return out;
    } finally {
        capacity.release(c.id);
        const usage = out && typeof out.costUsd === 'number' && typeof out.turns === 'number' ? { turns: out.turns, costUsd: out.costUsd } : null;
        budget.settle(attemptId, { usage, wallMs: Date.now() - started, reason: out && !out.ok ? out.error : null });
    }
}

/** Majority per id over the judges that answered it; no majority is a tie. */
function majority(judgeVerdicts, ids) {
    const panel = {};
    let unanimous = 0;
    for (const id of ids) {
        const votes = judgeVerdicts.map((v) => v[id]).filter(Boolean);
        const count = { a: 0, b: 0, tie: 0 };
        for (const v of votes) count[v]++;
        const top = Object.entries(count).sort((x, y) => y[1] - x[1]);
        panel[id] = top[0][1] > votes.length / 2 ? top[0][0] : 'tie';
        if (votes.length && votes.every((v) => v === votes[0])) unanimous++;
    }
    return { panel, agreement: ids.length ? Math.round((unanimous / ids.length) * 1000) / 1000 : null };
}

/** KEEP when the after side wins more captures than it loses and losses stay within the share allowed. */
function decide(score, maxLossShare) {
    if (!score.judged) return 'REVERT';
    return score.wins > score.losses && score.losses <= maxLossShare * score.judged ? 'KEEP' : 'REVERT';
}

function ownerAgreement(panel, picks) {
    const ids = Object.keys(picks).filter((id) => panel[id]);
    if (!ids.length) return null;
    return { compared: ids.length, agreed: ids.filter((id) => panel[id] === picks[id]).length };
}

function run(o) {
    const dir = path.resolve(o._[1] || '');
    if (!o._[1] || !fs.existsSync(path.join(dir, 'pairs.json'))) throw new Bail(2, 'run needs a pairs dir holding pairs.json (unslop-sweep.js pairs)');
    const pairsFile = JSON.parse(fs.readFileSync(path.join(dir, 'pairs.json'), 'utf8'));
    if (pairsFile.blind === false) throw new Bail(2, 'pairs.json is not blind: it was made with --seed, so its key can be rebuilt. Make the pairs again without --seed');
    const manifest = pairsFile.pairs;
    const key = JSON.parse(fs.readFileSync(path.join(dir, '.key.json'), 'utf8'));
    if (!Array.isArray(manifest) || !manifest.length) throw new Bail(2, 'pairs.json holds no pairs');
    const refs = referenceFiles(o.reference);
    const ids = manifest.map((p) => p.id);
    const judges = [];
    for (let j = 0; j < o.judges; j++) {
        const lens = LENSES[j % LENSES.length];
        const verdicts = {}; const notes = {}; const errors = []; let costUsd = 0;
        // Each judge sees the pairs in its own order, so batch position is not shared across judges.
        const order = [...manifest].sort((x, y) => crypto.createHash('sha1').update(`${j}:${x.id}`).digest('hex').localeCompare(crypto.createHash('sha1').update(`${j}:${y.id}`).digest('hex')));
        for (let i = 0; i < order.length; i += o.batch) {
            const r = judgeBatch({ lens, pairs: order.slice(i, i + o.batch), dir, refs, o, judgeIndex: j + 1 });
            costUsd += r.costUsd || 0;
            if (!r.ok) { errors.push(r.error); break; }
            Object.assign(verdicts, r.verdicts); Object.assign(notes, r.notes);
        }
        const complete = !errors.length && ids.every((id) => verdicts[id]);
        judges.push({ judge: j + 1, lens, complete, errors, costUsd: Math.round(costUsd * 10000) / 10000, verdicts, notes,
            score: complete ? (({ per, ...s }) => s)(scorePairs(key, verdicts)) : null });
    }
    const answered = judges.filter((j) => j.complete);
    const quorum = Math.max(MIN_JUDGES, Math.floor(o.judges / 2) + 1);
    const result = { at: new Date().toISOString(), model: o.model, judges: judges.length, answered: answered.length, quorum, references: refs.map((r) => path.basename(r)), perJudge: judges };
    if (answered.length < quorum) {
        result.decision = 'INDETERMINATE';
        result.why = `${answered.length} of ${o.judges} judges answered every pair; ${quorum} needed`;
    } else {
        const m = majority(answered.map((j) => j.verdicts), ids);
        const score = scorePairs(key, m.panel);
        result.panel = m.panel;
        result.agreement = m.agreement;
        result.score = score;
        result.decision = decide(score, o.maxLossShare);
        if (o.owner) result.owner = ownerAgreement(m.panel, JSON.parse(fs.readFileSync(path.resolve(o.owner), 'utf8')));
    }
    result.costUsd = Math.round(judges.reduce((a, j) => a + j.costUsd, 0) * 10000) / 10000;
    fs.writeFileSync(path.join(dir, 'panel.json'), JSON.stringify(result, null, 1));
    return result;
}

function summary(r) {
    const lines = [`judge-panel: ${r.decision}${r.why ? `: ${r.why}` : ''}; ${r.answered} of ${r.judges} judges answered, $${r.costUsd}`];
    if (r.score) {
        const s = r.score;
        lines.push(`after preferred in ${s.wins} of ${s.judged} captures, before in ${s.losses}, tie ${s.ties}, inconsistent ${s.inconsistent}; judges unanimous on ${Math.round(r.agreement * 100)}% of pairs`);
        for (const p of s.per) if (p.preferred === 'before') lines.push(`  regressed: ${p.capture}`);
    }
    if (r.owner) lines.push(`owner agreement: ${r.owner.agreed} of ${r.owner.compared} picks`);
    for (const j of r.perJudge) if (!j.complete) lines.push(`  judge ${j.judge} incomplete: ${j.errors.join('; ') || 'pairs unanswered'}`);
    return lines.join('\n');
}

function main(argv) {
    const o = parseArgs(argv);
    if (o._[0] !== 'run') throw new Bail(2, 'usage: judge-panel.js run <pairs dir> [--judges 3] [--model id] [--batch 6] [--max-loss-share 0.1] [--reference dir] [--owner picks.json] [--json]');
    const r = run(o);
    console.log(o.json ? JSON.stringify(r) : summary(r));
    return r.decision === 'KEEP' ? 0 : r.decision === 'REVERT' ? 1 : 2;
}

module.exports = { majority, decide, ownerAgreement, parseRun, buildMessage, LENSES, VERDICT_SCHEMA, MIN_JUDGES };

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (e) { console.error(`judge-panel: ${e instanceof Bail ? e.message : (e && e.stack) || e}`); process.exitCode = e instanceof Bail ? e.exitCode : 2; }
}
