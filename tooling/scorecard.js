#!/usr/bin/env node
'use strict';
// scorecard.js: an evidence-bound reader for the harness scorecard.
//
// The scorecard used to be written by hand. A score could rest on a fixture that
// passed once, on a probe nobody re-ran after the code moved, or on a check whose
// population was zero. This reader grades each aspect only from receipts, and a
// receipt counts only while it is fresh, names a population, matches the code it
// measured, and comes from the kind of run the criterion asks for.
//
//   node tooling/scorecard.js record --manifest <file> --criterion <id> [--receipts <dir>]
//       Runs the criterion's probe command, matches its expect pattern, and writes
//       one receipt (PASS or FAIL) with the population, the time, HEAD and a hash
//       of the files the criterion watches. Receipts are append-only, so the first
//       red stays in the history.
//   node tooling/scorecard.js report --manifest <file> [--receipts <dir>] [--json]
//       Prints every criterion's status and each aspect's score.
//
// STATUSES, per criterion, from its newest receipt:
//   PASS             fresh, populated, code unchanged, and of the required kind
//   FAIL             the newest receipt failed
//   UNKNOWN          no receipt, older than maxAgeDays (default 14), population
//                    missing or zero, a watched file changed since the receipt, or
//                    the newest receipt is INDETERMINATE: the probe was killed from
//                    outside twice (see probe-exit-mark.js), which says nothing about
//                    the code. `record` exits 2 for it.
//   NOT_OPERATIONAL  the criterion needs an operational receipt and only fixture
//                    or installed receipts exist
//   OWNER_HELD       the criterion's kind is owner-held: it waits on a decision
//                    the owner has made and keeps, named in its `needs`. It has
//                    no probe, `record` refuses it, and no receipt can make it PASS.
//
// An aspect scores 10 x (weight of PASS criteria) / (weight of all its criteria).
// UNKNOWN, NOT_OPERATIONAL and OWNER_HELD count as zero, so a score falls when evidence
// expires. The overall score is the mean of the aspect scores, and the sum is
// printed beside it so the arithmetic can be checked.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_DAYS = 14;
const KINDS = ['fixture', 'installed', 'operational'];
// Not a strength of evidence, so it stays out of KINDS and its ordering.
const OWNER_HELD = 'owner-held';

function defaultReceiptsDir(env = process.env) {
    let base;
    try { base = require('../plugins/autodev-core/scripts/claude-paths.js').configDir(env); }
    catch { base = path.join(require('os').homedir(), '.claude'); }
    return path.join(base, 'autodev', 'scorecard', 'receipts');
}

/** Reads and checks a manifest: { aspects: [{ id, name, criteria: [{ id, probe, expect, populationCount, kind, watch, weight }] }] }. */
function loadManifest(file) {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problems = validateManifest(m);
    if (problems.length) throw new Error(`manifest ${file}: ${problems.join('; ')}`);
    return m;
}

function validateManifest(m) {
    const problems = [];
    if (!m || !Array.isArray(m.aspects) || !m.aspects.length) return ['no aspects'];
    const seen = new Set();
    for (const a of m.aspects) {
        if (!a.id || !Array.isArray(a.criteria) || !a.criteria.length) { problems.push(`aspect ${a.id || '?'} has no criteria`); continue; }
        for (const c of a.criteria) {
            if (!c.id) { problems.push(`a criterion in ${a.id} has no id`); continue; }
            if (seen.has(c.id)) problems.push(`criterion ${c.id} appears twice`);
            seen.add(c.id);
            if (c.kind === OWNER_HELD) {
                if (typeof c.needs !== 'string' || !c.needs.trim()) problems.push(`criterion ${c.id} is owner-held and must name the decision in needs`);
                if (c.probe !== undefined) problems.push(`criterion ${c.id} is owner-held and must have no probe`);
            } else if (!KINDS.includes(c.kind)) problems.push(`criterion ${c.id} kind must be one of ${KINDS.join(', ')}, or ${OWNER_HELD}`);
            if (c.weight !== undefined && !(Number.isFinite(c.weight) && c.weight > 0)) problems.push(`criterion ${c.id} weight must be positive`);
        }
    }
    return problems;
}

/** sha256 over the watched files, in order. A missing file hashes as its name plus MISSING, so deleting one changes the hash. */
function watchHash(watch, root) {
    const h = crypto.createHash('sha256');
    for (const rel of (watch || []).slice().sort()) {
        h.update(rel + '\0');
        try { h.update(fs.readFileSync(path.resolve(root, rel))); } catch { h.update('MISSING'); }
        h.update('\0');
    }
    return h.digest('hex');
}

function readReceipts(dir) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const n of names) {
        try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { /* an unreadable receipt is no evidence */ }
    }
    return out;
}

/** The status of one criterion from its receipts. Never PASS without fresh, populated, matching evidence of the required kind. */
function criterionStatus(criterion, receipts, { now, currentHash, maxAgeDays = DEFAULT_MAX_AGE_DAYS }) {
    const mine = receipts.filter((r) => r && r.criterion === criterion.id && Number.isFinite(Date.parse(r.ranUtc)))
        .sort((a, b) => Date.parse(b.ranUtc) - Date.parse(a.ranUtc));
    const firstRed = mine.slice().reverse().find((r) => r.status === 'FAIL');
    const base = { id: criterion.id, firstRedUtc: firstRed ? firstRed.ranUtc : null, receipts: mine.length };
    if (criterion.kind === OWNER_HELD) return { ...base, status: 'OWNER_HELD', why: `owner-held: ${criterion.needs}` };
    if (!mine.length) return { ...base, status: 'UNKNOWN', why: 'no receipt' };
    const newest = mine[0];
    if (now - Date.parse(newest.ranUtc) > maxAgeDays * DAY_MS) return { ...base, status: 'UNKNOWN', why: `newest receipt is older than ${maxAgeDays} days` };
    if (newest.status === 'FAIL') return { ...base, status: 'FAIL', why: newest.why || 'probe failed' };
    if (newest.status === 'INDETERMINATE') return { ...base, status: 'UNKNOWN', why: newest.why || 'the probe was killed from outside' };
    if (!(Number.isFinite(newest.population) && newest.population > 0)) return { ...base, status: 'UNKNOWN', why: 'receipt names no population' };
    if (currentHash !== undefined && newest.watchHash !== currentHash) return { ...base, status: 'UNKNOWN', why: 'a watched file changed since the receipt' };
    const need = KINDS.indexOf(criterion.kind);
    const freshKinds = mine.filter((r) => r.status === 'PASS' && now - Date.parse(r.ranUtc) <= maxAgeDays * DAY_MS).map((r) => KINDS.indexOf(r.kind));
    if (Math.max(-1, ...freshKinds) < need) {
        return { ...base, status: criterion.kind === 'operational' ? 'NOT_OPERATIONAL' : 'UNKNOWN', why: `needs a ${criterion.kind} receipt, has only lesser kinds` };
    }
    return { ...base, status: 'PASS', why: `${newest.population} ${newest.populationLabel || 'items'}` };
}

/** Grades every aspect. Returns { aspects: [{ id, name, score, criteria }], sum, mean, max }. */
function grade(manifest, receipts, opts) {
    const aspects = manifest.aspects.map((a) => {
        const criteria = a.criteria.map((c) => criterionStatus(c, receipts, { ...opts, currentHash: opts.hashFor ? opts.hashFor(c) : undefined }));
        const total = a.criteria.reduce((s, c) => s + (c.weight || 1), 0);
        const passed = a.criteria.reduce((s, c, i) => s + (criteria[i].status === 'PASS' ? (c.weight || 1) : 0), 0);
        return { id: a.id, name: a.name || a.id, score: Math.round((10 * passed / total) * 10) / 10, criteria };
    });
    const sum = Math.round(aspects.reduce((s, a) => s + a.score, 0) * 10) / 10;
    return { aspects, sum, max: aspects.length * 10, mean: Math.round((sum / aspects.length) * 10) / 10 };
}

// Forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape.
const EXIT_MARK = path.join(__dirname, 'probe-exit-mark.js').split(path.sep).join('/');

/**
 * Runs the probe once with the exit-mark preload. `killed` is true when the probe's
 * node process started and never reached its exit event: it was terminated from
 * outside, so its status says nothing about the code it measures.
 */
function attempt(criterion, root, spawn) {
    const mark = path.join(require('os').tmpdir(), `probe-mark-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const env = { ...process.env, AUTODEV_PROBE_EXIT_MARK: mark, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${EXIT_MARK}"`.trim() };
    const r = spawn(criterion.probe, { cwd: root, shell: true, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env });
    let text = '';
    try { text = fs.readFileSync(mark, 'utf8'); } catch { /* no node process ran: no claim either way */ }
    try { fs.rmSync(mark, { force: true }); } catch { /* the OS temp sweep takes it */ }
    const killed = !r.error && (r.status !== 0 || Boolean(r.signal)) && /^start /m.test(text) && !/^exit /m.test(text);
    return { r, killed };
}

/**
 * Runs a criterion's probe and builds its receipt. The probe passes only on exit 0 AND a match of `expect`.
 * A probe killed from outside is run once more. Killed twice, the receipt is INDETERMINATE, never FAIL.
 */
function runProbe(criterion, { root, now = Date.now(), spawn = spawnSync } = {}) {
    let { r, killed } = attempt(criterion, root, spawn);
    let attempts = 1;
    if (killed) { ({ r, killed } = attempt(criterion, root, spawn)); attempts = 2; }
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (killed) {
        let head = null;
        try { head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim() || null; } catch { /* outside git */ }
        return {
            criterion: criterion.id, kind: criterion.kind, ranUtc: new Date(now).toISOString(), head,
            status: 'INDETERMINATE', population: null, populationLabel: criterion.populationLabel || null, attempts,
            watchHash: watchHash(criterion.watch, root),
            why: `terminated from outside twice (status ${r.signal || r.status}, no exit event)`,
            tail: out.slice(-600),
        };
    }
    const m = criterion.expect ? new RegExp(criterion.expect, 'm').exec(out) : null;
    // A suite that prints no count can still name its population: `populationCount` is a
    // pattern, and the population is the number of output lines it matches.
    const population = criterion.populationCount
        ? (out.match(new RegExp(criterion.populationCount, 'gm')) || []).length
        : (m && m.groups && m.groups.population !== undefined ? Number(m.groups.population) : null);
    const ok = r.status === 0 && !r.signal && Boolean(m);
    let head = null;
    try { head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim() || null; } catch { /* outside git */ }
    return {
        criterion: criterion.id, kind: criterion.kind, ranUtc: new Date(now).toISOString(), head,
        status: ok ? 'PASS' : 'FAIL', population: ok ? population : null, populationLabel: criterion.populationLabel || null, attempts,
        watchHash: watchHash(criterion.watch, root),
        why: ok ? null : (r.status !== 0 ? `exit ${r.signal ? r.signal : r.status}` : `output did not match ${criterion.expect}`),
        tail: out.slice(-600),
    };
}

function writeReceipt(dir, receipt) {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${receipt.ranUtc.replace(/[:.]/g, '-')}-${receipt.criterion.replace(/[^\w.-]/g, '_')}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return path.join(dir, name);
}

function formatReport(g) {
    const lines = [];
    for (const a of g.aspects) {
        lines.push(`${a.id.padEnd(4)} ${String(a.score).padStart(4)}  ${a.name}`);
        for (const c of a.criteria) lines.push(`       ${c.status.padEnd(15)} ${c.id}: ${c.why}${c.firstRedUtc ? ` (first red ${c.firstRedUtc})` : ''}`);
    }
    const n = g.aspects.reduce((s, a) => s + a.criteria.length, 0);
    lines.push(`overall ${g.mean}/10, sum ${g.sum} of ${g.max}, over ${g.aspects.length} aspects and ${n} criteria`);
    return lines.join('\n');
}

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; args[k] = v; } else args._.push(a);
    }
    return args;
}

function main(argv = process.argv.slice(2), io = { log: console.log, err: console.error }) {
    const args = parseArgs(argv);
    const cmd = args._[0];
    if (!cmd || args.help || !['record', 'report'].includes(cmd) || typeof args.manifest !== 'string') {
        io.err('usage: scorecard.js record --manifest <file> --criterion <id> [--receipts <dir>] | report --manifest <file> [--receipts <dir>] [--json]');
        return 2;
    }
    const manifest = loadManifest(args.manifest);
    const root = path.resolve(path.dirname(args.manifest), manifest.root || '.');
    const dir = typeof args.receipts === 'string' ? args.receipts : defaultReceiptsDir();
    if (cmd === 'record') {
        const c = manifest.aspects.flatMap((a) => a.criteria).find((x) => x.id === args.criterion);
        if (!c) { io.err(`no criterion ${args.criterion} in ${args.manifest}`); return 2; }
        if (c.kind === OWNER_HELD) { io.err(`${c.id} is owner-held (${c.needs}): there is nothing to record`); return 2; }
        const receipt = runProbe(c, { root });
        const file = writeReceipt(dir, receipt);
        io.log(`${receipt.status} ${c.id}${receipt.population !== null ? ` population ${receipt.population}` : ''}${receipt.why ? ` (${receipt.why})` : ''} -> ${file}`);
        return receipt.status === 'PASS' ? 0 : receipt.status === 'INDETERMINATE' ? 2 : 1;
    }
    const g = grade(manifest, readReceipts(dir), { now: Date.now(), hashFor: (c) => watchHash(c.watch, root) });
    io.log(args.json ? JSON.stringify(g, null, 2) : formatReport(g));
    return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { loadManifest, validateManifest, watchHash, readReceipts, criterionStatus, grade, runProbe, writeReceipt, formatReport, parseArgs, main, defaultReceiptsDir, KINDS, OWNER_HELD };
