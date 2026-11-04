#!/usr/bin/env node
'use strict';
// recheck-passed.js - sample work already marked done, so a second pass can
// re-verify it, and keep each disagreement as a new case.
//
// WHY. A story at `passes: true` is never looked at again. drift-audit reads
// only stories nobody touched, and the judge reads only work in flight. So a
// pass that was wrong when it was written stays wrong and stays invisible: the
// judge-zero-accepts incident (2026-10-30) was 47 of 62 verdicts wrong for
// weeks. The pattern comes from the Second Brain OS evals course (studied
// 2026-11, item S4): a weekly random re-check of passed records, each
// disagreement becoming a golden-set case.
//
// WHAT IT DOES. `sample` draws up to --per-week stories at passes: true from
// every prd.json under the code directory, spread across repos, and appends
// them to <claude dir>/autodev/recheck/ledger.jsonl. It runs two read-only
// checks on each: a shipped sha must exist and sit on the default branch, and
// the story must carry at least one evidence field. The judgement re-check is
// not this script's: the Brain reads `status`, re-verifies each open sample in
// a fresh context, and records `verdict`. A --disagree verdict appends the
// story to cases.jsonl, which is where the golden set grows.
//
// It is a brain-clock observer: read-only on every repo, one ledger of its own,
// under the clock's 90 s budget. A week is sampled once however often it runs,
// the draw is seeded by the ISO week so a rerun reproduces it, and a story
// sampled in the last 12 weeks is not drawn again.
//
// Usage:
//   node recheck-passed.js sample [--per-week 5] [--extra <dir>[,<dir>]] [--json]
//   node recheck-passed.js status [--json]
//   node recheck-passed.js verdict <repo>:<id> --agree|--disagree [--note <text>]
//   node recheck-passed.js --selftest
//
// Exit 0 on success, 1 when a verdict names no open sample, 2 when there is
// nothing to sample (an empty population is a fact about the probe), when the
// selftest has no passed story to derive from, or on a usage error.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const claudePaths = require('./claude-paths.js');
const prdStates = require('./prd-states.js');

const PER_WEEK = 5;
const RESAMPLE_DAYS = 84;
const SHA_FIELDS = ['shippedSha', 'sha', 'commit', 'mergedSha', 'mergeSha'];
const EVIDENCE_FIELDS = ['verify', 'verified', 'verification', 'acceptance', 'acceptanceCriteria',
    'resolution', 'gate', 'evidence', 'proof', 'reverified', 'passes_note', 'pr', 'test', 'tests', ...SHA_FIELDS];

const USAGE = `usage: node recheck-passed.js sample [--per-week ${PER_WEEK}] [--extra <dir>[,<dir>]] [--json]
       node recheck-passed.js status [--json]
       node recheck-passed.js verdict <repo>:<id> --agree|--disagree [--note <text>]
       node recheck-passed.js --selftest

Samples stories at passes: true for a second look, flags a shipped sha that is not on
the default branch and a story with no evidence field, and records verdicts. Ledger:
<claude dir>/autodev/recheck/ (RECHECK_STATE_DIR overrides it).`;

const stateDir = () => process.env.RECHECK_STATE_DIR || path.join(claudePaths.configDir(), 'autodev', 'recheck');
const now = () => (process.env.RECHECK_NOW ? new Date(process.env.RECHECK_NOW) : new Date());

function isoWeek(d) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear();
    const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
    return `${y}-W${String(w).padStart(2, '0')}`;
}

// A small seeded generator, so one week's draw is the same on every run.
function rng(seed) {
    let a = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function shuffle(list, rand) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function git(cwd, args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return { ok: r.status === 0, out: String(r.stdout || '').trim() };
}
const canon = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };

// Every repo with a prd.json, one entry per repo however many worktrees it has.
// The main checkout wins over a worktree, as in drift-audit.
function repos(extra) {
    const dirs = [];
    const code = claudePaths.codeDir();
    if (code) {
        for (const name of fs.readdirSync(code)) {
            const dir = path.join(code, name);
            try { if (fs.statSync(dir).isDirectory()) dirs.push(dir); } catch { /* unreadable entry */ }
        }
    }
    dirs.push(...extra);
    const byKey = new Map();
    for (const dir of dirs) {
        if (!fs.existsSync(path.join(dir, 'prd.json'))) continue;
        const common = git(dir, ['rev-parse', '--git-common-dir']);
        const isGit = common.ok && common.out;
        const key = isGit ? canon(path.resolve(dir, common.out)) : canon(dir);
        const isMain = isGit ? key === canon(path.resolve(dir, '.git')) : true;
        const seen = byKey.get(key);
        if (!seen || (isMain && !seen.isMain)) byKey.set(key, { dir, isMain, isGit: !!isGit });
    }
    return [...byKey.values()].sort((x, y) => x.dir.localeCompare(y.dir));
}

function defaultRef(dir) {
    const head = git(dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
    if (head.ok && head.out) return head.out;
    for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
        if (git(dir, ['rev-parse', '-q', '--verify', ref + '^{commit}']).ok) return ref;
    }
    return null;
}

function present(v) {
    if (v === undefined || v === null || v === false) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
}

// The two read-only checks. Each flag is a reason for the second look to start
// there, not a verdict.
function flagsFor(repo, story, ref) {
    const flags = [];
    if (!EVIDENCE_FIELDS.some((f) => present(story[f]))) flags.push('no-evidence');
    const sha = SHA_FIELDS.map((f) => story[f]).find((v) => typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v.trim()));
    if (sha && repo.isGit) {
        if (!git(repo.dir, ['cat-file', '-e', sha.trim() + '^{commit}']).ok) flags.push('sha-missing');
        else if (ref && !git(repo.dir, ['merge-base', '--is-ancestor', sha.trim(), ref]).ok) flags.push('sha-not-on-default');
    }
    return flags;
}

function evidenceOf(story) {
    const out = {};
    for (const f of EVIDENCE_FIELDS) if (present(story[f])) out[f] = typeof story[f] === 'string' ? story[f].slice(0, 400) : story[f];
    return out;
}

function readLedger(dir) {
    const p = path.join(dir, 'ledger.jsonl');
    if (!fs.existsSync(p)) return [];
    const rows = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped, not fatal */ }
    }
    return rows;
}
function append(dir, file, row) {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, file), JSON.stringify(row) + '\n');
}
const keyOf = (repoDir, id) => canon(repoDir) + '\u0000' + id;

function openSamples(rows) {
    const closed = new Set(rows.filter((r) => r.type === 'verdict').map((r) => keyOf(r.repo, r.id)));
    return rows.filter((r) => r.type === 'sample' && !closed.has(keyOf(r.repo, r.id)));
}

// Draw the sample. Pure apart from the git reads, so the selftest can run it on
// its own population without touching the real ledger.
function draw(repoList, rows, at, perWeek) {
    const week = isoWeek(at);
    const recent = new Set(rows.filter((r) => r.type === 'sample' && at - Date.parse(r.sampledAt) < RESAMPLE_DAYS * 86400000)
        .map((r) => keyOf(r.repo, r.id)));
    const rand = rng('recheck:' + week);
    let total = 0, skipped = 0;
    const pools = [];
    for (const repo of repoList) {
        let prd = null;
        try { prd = JSON.parse(fs.readFileSync(path.join(repo.dir, 'prd.json'), 'utf8')); } catch { continue; }
        const done = Object.entries(prdStates.storiesOf(prd)).filter(([, s]) => prdStates.isDone(s));
        total += done.length;
        const fresh = done.filter(([id]) => !recent.has(keyOf(repo.dir, id)));
        skipped += done.length - fresh.length;
        if (fresh.length) pools.push({ repo, list: shuffle(fresh, rand) });
    }
    const order = shuffle(pools, rand);
    const picked = [];
    for (let round = 0; picked.length < perWeek && order.some((p) => p.list.length > round); round++) {
        for (const p of order) {
            if (picked.length >= perWeek) break;
            if (p.list[round]) picked.push({ repo: p.repo, id: p.list[round][0], story: p.list[round][1] });
        }
    }
    const refs = new Map();
    const out = picked.map(({ repo, id, story }) => {
        if (!refs.has(repo.dir)) refs.set(repo.dir, repo.isGit ? defaultRef(repo.dir) : null);
        return { type: 'sample', week, sampledAt: at.toISOString(), repo: repo.dir, id,
            title: String(story.title || '').slice(0, 200), evidence: evidenceOf(story),
            flags: flagsFor(repo, story, refs.get(repo.dir)) };
    });
    return { week, total, skipped, repoCount: repoList.length, picked: out };
}

function parseArgs(argv) {
    const a = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const x = argv[i];
        if (x === '--per-week' || x === '--extra' || x === '--note') a[x.slice(2)] = argv[++i];
        else if (x.startsWith('--')) a[x.slice(2)] = true;
        else a._.push(x);
    }
    return a;
}

function cmdSample(a) {
    const per = a['per-week'] === undefined ? PER_WEEK : Number(a['per-week']);
    if (!Number.isInteger(per) || per < 1 || per > 20) { console.error('recheck: --per-week must be 1 to 20'); return 2; }
    const extra = a.extra ? String(a.extra).split(',').filter(Boolean) : [];
    const dir = stateDir();
    const rows = readLedger(dir);
    const at = now();
    const week = isoWeek(at);
    const list = repos(extra);
    const already = rows.filter((r) => r.type === 'sample' && r.week === week);
    if (already.length) {
        const line = `recheck: ${week} already sampled (${already.length}), ${openSamples(rows).length} open, from ${list.length} repos`;
        if (a.json) console.log(JSON.stringify({ week, already: already.length, open: openSamples(rows).length }));
        console.log(line);
        return 0;
    }
    const d = draw(list, rows, at, per);
    if (!d.total) {
        console.log(`recheck: population 0: no story at passes: true in ${d.repoCount} repos with a prd.json under ${claudePaths.codeDir() || '(no code dir)'}`);
        return 2;
    }
    for (const row of d.picked) append(dir, 'ledger.jsonl', row);
    const flagged = d.picked.filter((r) => r.flags.length).length;
    if (a.json) console.log(JSON.stringify(d, null, 2));
    else for (const r of d.picked) console.log(`  ${path.basename(r.repo)}:${r.id}  ${r.title}${r.flags.length ? '  [' + r.flags.join(', ') + ']' : ''}`);
    console.log(`recheck: ${d.week} sampled ${d.picked.length} of ${d.total} passed stories across ${d.repoCount} repos `
        + `(${d.skipped} sampled in the last ${RESAMPLE_DAYS / 7} weeks skipped), ${flagged} flagged, ${openSamples(readLedger(dir)).length} open`);
    return 0;
}

function cmdStatus(a) {
    const rows = readLedger(stateDir());
    const open = openSamples(rows);
    const verdicts = rows.filter((r) => r.type === 'verdict');
    const disagreed = verdicts.filter((r) => r.verdict === 'disagree').length;
    if (a.json) { console.log(JSON.stringify({ open, verdicts: verdicts.length, disagreed }, null, 2)); return 0; }
    for (const r of open) console.log(`  ${path.basename(r.repo)}:${r.id}  ${r.week}  ${r.title}${r.flags && r.flags.length ? '  [' + r.flags.join(', ') + ']' : ''}`);
    console.log(`recheck: ${open.length} open of ${rows.filter((r) => r.type === 'sample').length} sampled, ${verdicts.length} verdicts, ${disagreed} disagreements`);
    return 0;
}

function cmdVerdict(a) {
    const target = a._[1];
    const v = a.agree ? 'agree' : a.disagree ? 'disagree' : null;
    if (!target || !v || (a.agree && a.disagree)) { console.error(USAGE); return 2; }
    const cut = target.lastIndexOf(':');
    const repoPart = target.slice(0, cut), id = target.slice(cut + 1);
    if (cut < 1 || !id) { console.error('recheck: name the sample as <repo>:<id>'); return 2; }
    const dir = stateDir();
    const open = openSamples(readLedger(dir)).filter((r) => r.id === id
        && (path.basename(r.repo).toLowerCase() === repoPart.toLowerCase() || canon(r.repo) === canon(repoPart)));
    if (open.length !== 1) {
        console.log(`recheck: ${open.length ? 'more than one' : 'no'} open sample matches ${target}`);
        return 1;
    }
    const s = open[0];
    const at = now().toISOString();
    const note = a.note ? String(a.note).slice(0, 1000) : '';
    append(dir, 'ledger.jsonl', { type: 'verdict', repo: s.repo, id: s.id, verdict: v, note, at });
    if (v === 'disagree') {
        append(dir, 'cases.jsonl', { repo: s.repo, id: s.id, title: s.title, evidence: s.evidence, flags: s.flags, note, week: s.week, at });
        console.log(`recheck: ${path.basename(s.repo)}:${s.id} disagreed, kept as a case. Reopen the story in its prd.json.`);
    } else {
        console.log(`recheck: ${path.basename(s.repo)}:${s.id} agreed`);
    }
    return 0;
}

// The planted negatives are derived from a real passed story: one copy whose
// shipped sha is moved off the default branch, one stripped of its evidence,
// and an unmodified copy as the control. They live in a temp repo and a temp
// ledger, never the real one.
function cmdSelftest() {
    const list = repos([]);
    let subject = null;
    for (const repo of list) {
        let prd = null;
        try { prd = JSON.parse(fs.readFileSync(path.join(repo.dir, 'prd.json'), 'utf8')); } catch { continue; }
        const hit = Object.entries(prdStates.storiesOf(prd)).find(([, s]) => prdStates.isDone(s) && EVIDENCE_FIELDS.some((f) => present(s[f])));
        if (hit) { subject = { repo, id: hit[0], story: hit[1] }; break; }
    }
    if (!subject) { console.log(`recheck selftest: no passed story with evidence in ${list.length} repos, so no positive control can be derived`); return 2; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-selftest-'));
    try {
        const dir = path.join(tmp, 'subject');
        fs.mkdirSync(dir);
        const g = (...args) => git(dir, args);
        g('init', '-q', '-b', 'main');
        g('config', 'user.email', 'selftest@example.invalid');
        g('config', 'user.name', 'selftest');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
        g('add', 'a.txt'); g('commit', '-q', '-m', 'main');
        const onMain = g('rev-parse', 'HEAD').out;
        g('checkout', '-q', '-b', 'side');
        fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
        g('add', 'b.txt'); g('commit', '-q', '-m', 'side');
        const offMain = g('rev-parse', 'HEAD').out;
        g('checkout', '-q', 'main');
        const base = { ...subject.story };
        for (const f of SHA_FIELDS) delete base[f];
        const stripped = { ...subject.story };
        for (const f of EVIDENCE_FIELDS) delete stripped[f];
        const stories = { control: { ...base, shippedSha: onMain }, moved: { ...base, shippedSha: offMain }, bare: stripped };
        fs.writeFileSync(path.join(dir, 'prd.json'), JSON.stringify({ stories }));
        const d = draw([{ dir, isMain: true, isGit: true }], [], now(), 3);
        const by = Object.fromEntries(d.picked.map((r) => [r.id, r.flags]));
        const ok = (by.control || ['?']).length === 0 && (by.moved || []).includes('sha-not-on-default') && (by.bare || []).includes('no-evidence');
        console.log(`recheck selftest: derived from ${path.basename(subject.repo.dir)}:${subject.id}, `
            + `control ${JSON.stringify(by.control)}, moved sha ${JSON.stringify(by.moved)}, no evidence ${JSON.stringify(by.bare)}: ${ok ? 'both negatives fired, control clean' : 'FAILED'}`);
        return ok ? 0 : 1;
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
    }
}

function main(argv) {
    const a = parseArgs(argv);
    if (a.help || a.h) { console.log(USAGE); return 0; }
    if (a.selftest) return cmdSelftest();
    const cmd = a._[0];
    if (cmd === 'sample') return cmdSample(a);
    if (cmd === 'status') return cmdStatus(a);
    if (cmd === 'verdict') return cmdVerdict(a);
    console.error(USAGE);
    return 2;
}

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (e) { console.error('recheck: ' + (e && e.message || e)); process.exitCode = 2; }
}

module.exports = { isoWeek, draw, flagsFor, openSamples, repos };
