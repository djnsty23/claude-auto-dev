#!/usr/bin/env node
'use strict';
// usage-digest.js: one short digest per Claude Code session, so "have we hit this before"
// finds the session that dealt with it.
//
// WHY. usage-mine.js counts failures. It cannot say what a session was for or which PR came
// out of it. A digest says that in a few lines, and memory-kb can index it.
//
// WHO WRITES WHAT. The local 4B writes ONE line, the topic. Code writes everything else:
// date, project, model, duration, the failure classes with counts (usage-mine's own
// extractor), the tool error count, the PRs the session created or acted on, commit shas
// and edited files. Measured on 20 sessions graded by Opus (2026-11-05): 4B prose with
// code-checked line anchors passed 7 of 20 and invented a fix in 2, while topic plus code
// facts passed 20 of 20 with no invented claim. So the model gets no free prose here.
//
// THE TOPIC IS REFUSED, and a code-made one used instead, when it is empty, names a person,
// quotes a human turn (any ten-word run), or uses words the log does not contain. A person
// is caught two ways: a denylist of known names, and a fail-closed check for a capitalised
// word that never appears lowercase in the log and never in a tool call. The second needs
// no list, so a name nobody wrote down still falls back. Edited files whose path carries a
// known name are left out.
//
// PRIVACY. Transcripts hold secrets, client data and the user's own words. The model reads
// them on this machine only. Client projects get no digest. Client markers and the names of
// real people are private, so they live in the local digest-config.json ("clientMarkers",
// "knownNames", "userNames"), never in this file, and with either of the first two missing
// nothing is digested at all. Every digest goes through the secret scanner before it is
// kept, and one the scanner does not clear is deleted. Digests and the ledger live under
// <config>/autodev/usage/digests/, which is never mirrored.
//
// INGEST is off until digest-config.json says "ingest": true. The embedding call it leads
// to is paid on a paid key, so it stays off until the key's tier is confirmed free.
//
//   node usage-digest.js run [--limit N] [--since YYYY-MM-DD] [--project <name>] [--dry-run]
//   node usage-digest.js one <transcript.jsonl> [--print]
//   node usage-digest.js status
//   node usage-digest.js ingest
//
// Exit 0 done, 1 a record failed in a way that needs a look, 2 called wrongly, not
// configured, or the local model is not answering.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { configDir } = require('./claude-paths.js');
const mine = require('./usage-mine.js');

const SMALL_URL = process.env.AUTODEV_LOCAL_SMALL_URL || 'http://127.0.0.1:8081';
const TOPIC_INPUT_CHARS = 60000; // the opening of a session says what it is for, and keeps a call near 3 s
const CALENDAR = /^(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
// gh subcommands that act on a PR the session owns. `gh pr list` and search output name other people's PRs.
const PR_ACTION = /\bgh\s+pr\s+(create|merge|view|edit|ready|close|reopen|comment|review|checks)\b/;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

function usageDir() { return process.env.AUTODEV_USAGE_DIR || path.join(configDir(), 'autodev', 'usage'); }
function digestDir() { return path.join(usageDir(), 'digests'); }
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); }
const config = () => readJson(path.join(usageDir(), 'digest-config.json'), {});

const strings = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsRe = (list, flags) => (list.length ? new RegExp(`\\b(${list.map(escapeRe).join('|')})\\b`, flags) : null);

/** The private lists, read from local config on every call so a test can swap them. */
function lists() {
    const c = config();
    return {
        marks: strings(c.clientMarkers).map((s) => s.toLowerCase()),
        known: wordsRe(strings(c.knownNames), 'i'),
        users: wordsRe(strings(c.userNames), 'gi'),
    };
}
const configured = (L) => L.marks.length > 0 && L.known !== null;
const NO_CONFIG = 'digest-config.json needs clientMarkers and knownNames, so nothing is digested';
const isClient = (s, marks) => marks.some((m) => String(s || '').toLowerCase().includes(m));

// ---------------------------------------------------------------- condense
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} [...]` : s);

function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}

function relFile(p, cwd) {
    const f = String(p).replace(/\\/g, '/');
    const root = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && f.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return f.slice(root.length + 1);
    const wt = /\/\.claude\/worktrees\/[^/]+\/(.+)$/.exec(f);
    return wt ? wt[1] : path.basename(f); // never a home path in a digest
}

/** A transcript as a short ledger of turns, plus the facts code can read with certainty. */
function condense(file) {
    const out = [];
    const human = [];
    const facts = { session: null, cwd: null, model: null, first: null, last: null, prs: new Set(), commits: new Set(), files: new Set() };
    const prCalls = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.isSidechain) continue;
        if (o.sessionId && !facts.session) facts.session = o.sessionId;
        if (o.cwd && !facts.cwd) facts.cwd = o.cwd;
        if (o.timestamp) { facts.first = facts.first || o.timestamp; facts.last = o.timestamp; }
        const m = o.message;
        if (!m) continue;
        if (o.type === 'assistant' && m.model && m.model !== '<synthetic>') facts.model = m.model;
        const blocks = Array.isArray(m.content) ? m.content : [];
        if (o.type === 'user') {
            const t = textOf(m.content).replace(REMINDER, '').trim();
            if (t && !blocks.some((b) => b && b.type === 'tool_result')) {
                human.push(t);
                out.push(`USER: ${clip(t, 1500)}`);
            }
            for (const b of blocks) {
                if (!b || b.type !== 'tool_result') continue;
                const r = typeof b.content === 'string' ? b.content : textOf(b.content);
                if (prCalls.has(b.tool_use_id)) for (const u of r.match(PR_URL) || []) facts.prs.add(u);
                for (const c of r.matchAll(/^\[[\w./-]+ ([0-9a-f]{7,12})\]/gm)) facts.commits.add(c[1]);
                if (b.is_error) out.push(`ERROR: ${clip(r.replace(/\s+/g, ' '), 240)}`);
            }
        } else if (o.type === 'assistant') {
            for (const b of blocks) {
                if (!b) continue;
                if (b.type === 'text' && String(b.text || '').trim()) out.push(`ASSISTANT: ${clip(b.text.trim(), 800)}`);
                if (b.type !== 'tool_use') continue;
                const i = b.input || {};
                const what = i.command || i.file_path || i.pattern || i.url || i.query || i.description || '';
                out.push(`TOOL ${b.name}: ${clip(String(what).replace(/\s+/g, ' '), 200)}`);
                if ((b.name === 'Edit' || b.name === 'Write') && i.file_path) facts.files.add(relFile(i.file_path, facts.cwd));
                if (b.name === 'Bash' && PR_ACTION.test(String(i.command || ''))) {
                    prCalls.add(b.id);
                    for (const u of String(i.command).match(PR_URL) || []) facts.prs.add(u);
                }
            }
        }
    }
    return { lines: out, text: out.join('\n'), human, facts };
}

// ---------------------------------------------------------------- topic
const STOP = new Set('about after again also because been before being between both could does doing done during each from have having here into just like made make more most much must only other over same should since some such than that their them then there these they this those through under until very want were what when where which while will with would your the and for not but are was all any can had has her his its one our out own she who why how yes'.split(' '));
const stems = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 5)));

/** True when any ten-word run of the text appears in a human turn: a quote, not a paraphrase. */
function quotesHuman(text, human) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9ăâîșțşţ]+/gi, ' ').trim();
    const hay = ` ${norm(human.join(' \n '))} `;
    const w = norm(text).split(' ').filter(Boolean);
    for (let i = 0; i + 10 <= w.length; i++) if (hay.includes(` ${w.slice(i, i + 10).join(' ')} `)) return true;
    return false;
}

/** Capitalised words after the first that the log never writes lowercase and no tool call contains:
 * the shape of a personal name. A word sharing its first five letters with a lowercase log word is
 * an ordinary word written in title case ("Deployment" meets "deploy"). */
function nameSuspects(topic, lines) {
    const lower = new Set();
    for (const l of lines) for (const w of l.split(/[^A-Za-z]+/)) if (/^[a-z]+$/.test(w)) lower.add(w.slice(0, 5));
    const tools = lines.filter((l) => l.startsWith('TOOL ')).join(' ').toLowerCase();
    return topic.split(/\s+/).slice(1).map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''))
        .filter((w) => /^[A-Z][a-z]{2,}$/.test(w) && !CALENDAR.test(w) && !lower.has(w.toLowerCase().slice(0, 5)) && !tools.includes(w.toLowerCase()));
}

/** The model's topic survives only when it is short, names no one, quotes no human turn and is grounded in the log. */
function checkTopic(topic, c, L = lists()) {
    let t = String(topic || '');
    if (L.users) t = t.replace(L.users, 'the user');
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length > 140) t = t.slice(0, 140).replace(/\s+\S*$/, '');
    if (!t) return { ok: false, why: 'empty' };
    if ((L.known && L.known.test(t)) || nameSuspects(t, c.lines).length) return { ok: false, why: 'names a person' };
    if (quotesHuman(t, c.human)) return { ok: false, why: 'quotes a human turn' };
    const want = stems(t);
    const hay = stems(c.text);
    let hit = 0;
    for (const w of want) if (hay.has(w)) hit++;
    if (want.size < 2 || hit / want.size < 0.6) return { ok: false, why: `${hit} of ${want.size} topic words are in the log` };
    return { ok: true, topic: t };
}

const safeFiles = (c, L = lists()) => [...c.facts.files].filter((f) => !(L.known && L.known.test(f)));
function codeTopic(project, c, L = lists()) {
    const files = safeFiles(c, L).slice(0, 3).join(', ');
    return `${project} session${files ? `, edited ${files}` : ''}`;
}

// ---------------------------------------------------------------- local model
const TOPIC_SYSTEM = [
    'You name what one Claude Code working session was about, for a searchable engineering log.',
    'Answer with ONE JSON object and nothing else: {"topic": string}.',
    'The topic is one line of at most 20 words: the product or repo and the task, in your own words.',
    'Never copy a sentence from the USER lines. Never include a personal name, email, password, key or token.',
].join('\n');

// The 4B is used when it is up. When it is down and AUTODEV_SMALL_START names a start script,
// it is loaded for the run and AUTODEV_SMALL_STOP unloads it after. Both are machine state.
const START_SMALL = process.env.AUTODEV_SMALL_START || '';
const STOP_SMALL = process.env.AUTODEV_SMALL_STOP || '';
let startedSmall = false;
async function smallUp() { try { return (await fetch(`${SMALL_URL}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } }
async function ensureSmall() {
    if (await smallUp()) return true;
    if (process.platform !== 'win32' || !START_SMALL || !fs.existsSync(START_SMALL)) return false;
    spawnSync('pwsh.exe', ['-NoProfile', '-File', START_SMALL], { windowsHide: true, stdio: 'ignore', timeout: 150000 });
    for (let i = 0; i < 60 && !(await smallUp()); i++) await new Promise((r) => setTimeout(r, 2000));
    startedSmall = await smallUp();
    return startedSmall;
}
function releaseSmall() {
    if (startedSmall && STOP_SMALL && fs.existsSync(STOP_SMALL)) spawnSync('pwsh.exe', ['-NoProfile', '-File', STOP_SMALL], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
    startedSmall = false;
}

function parseJson(text) {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

async function askTopic(logText) {
    const res = await fetch(`${SMALL_URL}/v1/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(180000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3-4b', temperature: 0, max_tokens: 200, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: TOPIC_SYSTEM }, { role: 'user', content: `/no_think\nSESSION LOG\n${logText}` }] }),
    });
    if (!res.ok) throw new Error(`local model answered ${res.status}`);
    const j = await res.json();
    const raw = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const p = parseJson(raw);
    const u = j.usage || {};
    return { topic: p && typeof p.topic === 'string' ? p.topic : '', tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0) };
}

// ---------------------------------------------------------------- render and check
function minutes(a, b) { const m = (Date.parse(b) - Date.parse(a)) / 60000; return Number.isFinite(m) ? Math.round(m) : null; }

function render(topic, topicBy, c, counts, project, L = lists()) {
    const f = c.facts;
    const mins = minutes(f.first, f.last);
    const out = [`# ${topic}`, '',
        `date: ${String(f.first || '').slice(0, 10)} | project: ${project} | model: ${f.model || 'unknown'} | session: ${String(f.session || '').slice(0, 8)} | minutes: ${mins === null ? 'unknown' : mins} | topic by: ${topicBy}`, ''];
    const cls = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (cls.length) out.push('## Failure classes (counted by usage-mine)', ...cls.map(([k, n]) => `- ${k}: ${n}`), '');
    out.push(`Tool errors in the log: ${c.lines.filter((l) => l.startsWith('ERROR: ')).length}`, '');
    const links = [...f.prs].map((u) => `- PR ${u}`).concat([...f.commits].slice(0, 10).map((s) => `- commit ${s}`), safeFiles(c, L).slice(0, 15).map((x) => `- file ${x}`));
    if (links.length) out.push('## Links', ...links, '');
    return out.join('\n');
}

/** Fail closed: a digest is kept only when the scanner ran and printed its clean line. */
function scanClean(file) {
    const scanner = process.env.AUTODEV_SECRET_SCANNER || path.join(configDir(), 'scripts', 'scan-transcript-secrets.js');
    if (!fs.existsSync(scanner)) return { ok: false, why: 'secret scanner not found' };
    const r = spawnSync(process.execPath, [scanner, '--file', file], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (r.status === 0 && /No credential-shaped strings found/.test(r.stdout || '')) return { ok: true, why: '' };
    return { ok: false, why: r.status === 0 ? 'the scanner flagged it' : `scanner exited ${r.status}` };
}

// ---------------------------------------------------------------- one session
async function digestOne(file, opts = {}) {
    const L = lists();
    if (!configured(L)) return { status: 'retry', why: NO_CONFIG };
    const dirName = path.basename(path.dirname(file));
    const c = condense(file);
    const project = mine.projectOf(c.facts.cwd, dirName);
    if (isClient(project, L.marks) || isClient(dirName, L.marks) || isClient(c.facts.cwd, L.marks)) return { status: 'skipped', why: 'client project' };
    if (mine.isSynthetic(project)) return { status: 'skipped', why: 'synthetic eval session' };
    if (c.text.length < 400 || !c.human.length) return { status: 'skipped', why: 'too short to digest' };
    const ex = await mine.extractFile(file, { dirName });
    const counts = {};
    for (const e of ex.events) counts[e.c] = (counts[e.c] || 0) + 1;
    const ask = opts.askTopic || askTopic;
    const t0 = Date.now();
    let r;
    try { r = await ask(c.text.slice(0, TOPIC_INPUT_CHARS)); } catch (e) { return { status: 'retry', why: e.message }; }
    const chk = checkTopic(r.topic, c, L);
    const topic = chk.ok ? chk.topic : codeTopic(project, c, L);
    const body = render(topic, chk.ok ? '4B, checked' : `code (4B topic refused: ${chk.why})`, c, counts, project, L);
    const date = String(c.facts.first || '').slice(0, 10) || 'undated';
    const out = path.join(opts.outDir || digestDir(), project.replace(/[^\w.-]+/g, '_'), `${date}-${String(c.facts.session || path.basename(file, '.jsonl')).slice(0, 8)}.md`);
    const base = { ms: Date.now() - t0, tokens: r.tokens || 0, topicOk: chk.ok, topicWhy: chk.why || '' };
    if (opts.print) return { status: 'ok', body, out, ...base };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    const scan = scanClean(out);
    if (!scan.ok) { fs.rmSync(out, { force: true }); return { status: 'dropped', why: scan.why, ...base }; }
    return { status: 'ok', out, ...base };
}

// ---------------------------------------------------------------- ledger and run
function srcKey(file) { const s = fs.statSync(file); return crypto.createHash('sha1').update(`${s.size}:${Math.floor(s.mtimeMs)}`).digest('hex').slice(0, 16); }
const ledgerPath = () => path.join(digestDir(), 'ledger.json');

/** Top-level transcripts only: a subagent's transcript is part of its parent session. */
function transcripts(root) {
    const files = [];
    (function walk(d) {
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'subagents') walk(p); } else if (e.name.endsWith('.jsonl')) files.push(p);
        }
    })(root);
    return files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).map((x) => x.f);
}

/** A record is done when its source has not changed since it was digested or skipped. A retry or drop runs again. */
const isDone = (rec, key) => Boolean(rec && rec.key === key && (rec.status === 'ok' || rec.status === 'skipped'));

async function run(opts) {
    if (!configured(lists())) return { error: NO_CONFIG };
    const ledger = readJson(ledgerPath(), { files: {} });
    const since = opts.since ? Date.parse(opts.since) : 0;
    const todo = transcripts(opts.root || path.join(configDir(), 'projects')).filter((f) => {
        if (since && fs.statSync(f).mtimeMs < since) return false;
        if (opts.project && !path.basename(path.dirname(f)).toLowerCase().includes(opts.project.toLowerCase())) return false;
        return !isDone(ledger.files[f], srcKey(f));
    });
    const batch = opts.limit ? todo.slice(0, opts.limit) : todo;
    if (opts.dryRun) return { todo: todo.length, batch: batch.length, tally: {} };
    if (!opts.askTopic && !(await ensureSmall())) return { error: 'the local model is not answering' };
    const tally = {};
    try {
        for (const f of batch) {
            let r;
            try { r = await digestOne(f, opts); } catch (e) { r = { status: 'retry', why: e.message }; }
            tally[r.status] = (tally[r.status] || 0) + 1;
            ledger.files[f] = { key: srcKey(f), status: r.status, why: r.why || '', out: r.out || '', topicOk: r.topicOk, at: new Date().toISOString() };
            writeJson(ledgerPath(), ledger);
        }
    } finally { releaseSmall(); }
    return { todo: todo.length, batch: batch.length, tally };
}

function status() {
    const ledger = readJson(ledgerPath(), { files: {} });
    const t = {};
    let codeTopics = 0;
    for (const r of Object.values(ledger.files)) { t[r.status] = (t[r.status] || 0) + 1; if (r.status === 'ok' && r.topicOk === false) codeTopics++; }
    return { records: Object.keys(ledger.files).length, byStatus: t, codeTopics, configured: configured(lists()), ingest: ingestEnabled() };
}

// ---------------------------------------------------------------- ingest
function ingestEnabled() { return config().ingest === true; }

/** Off unless the config file turns it on. Nothing is spawned while it is off. */
function ingest() {
    if (!ingestEnabled()) return { ran: false, why: 'ingest is off: set "ingest": true in digest-config.json once the embedding key is confirmed free tier' };
    const kb = process.env.AUTODEV_KB_DIR;
    const script = kb ? path.join(kb, 'memory-kb', 'ingest.py') : '';
    if (!kb || !fs.existsSync(script)) return { ran: false, why: 'AUTODEV_KB_DIR does not point at a kb checkout with memory-kb/ingest.py' };
    const win = process.platform === 'win32';
    const r = spawnSync(win ? 'py' : 'python3', win ? ['-3', script] : [script], { cwd: kb, stdio: 'inherit', windowsHide: true });
    return { ran: true, status: r.status };
}

module.exports = { condense, checkTopic, nameSuspects, quotesHuman, codeTopic, render, scanClean, digestOne, run, status, ingest, ingestEnabled, transcripts, isDone, lists };

// ---------------------------------------------------------------- cli
if (require.main === module) {
    const argv = process.argv.slice(2);
    const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
    const cmd = argv[0];
    (async () => {
        if (cmd === 'run') {
            const limit = flag('--limit') ? Number(flag('--limit')) : 0;
            if (flag('--limit') && !(limit > 0)) { console.error('--limit takes a positive number'); process.exitCode = 2; return; }
            const dryRun = argv.includes('--dry-run');
            const r = await run({ limit, since: flag('--since'), project: flag('--project'), dryRun });
            if (r.error) { console.error(r.error); process.exitCode = 2; return; }
            console.log(`${r.todo} transcript(s) need a digest, ${r.batch} in this batch${dryRun ? ' (dry run, nothing read)' : ''}`);
            for (const [k, n] of Object.entries(r.tally)) console.log(`  ${k}: ${n}`);
            process.exitCode = r.tally.dropped || r.tally.retry ? 1 : 0;
        } else if (cmd === 'one' && argv[1]) {
            const r = await digestOne(path.resolve(argv[1]), { print: argv.includes('--print') });
            if (r.body) console.log(r.body);
            console.log(`status: ${r.status}${r.why ? ` (${r.why})` : ''}${r.out && !r.body ? ` -> ${r.out}` : ''}`);
            process.exitCode = r.status === 'ok' || r.status === 'skipped' ? 0 : r.why === NO_CONFIG ? 2 : 1;
        } else if (cmd === 'status') {
            console.log(JSON.stringify(status(), null, 1));
        } else if (cmd === 'ingest') {
            const r = ingest();
            console.log(r.ran ? `ingest exited ${r.status}` : r.why);
            process.exitCode = r.ran && r.status !== 0 ? 1 : 0;
        } else {
            console.error('usage: usage-digest.js run [--limit N] [--since YYYY-MM-DD] [--project name] [--dry-run] | one <file> [--print] | status | ingest');
            process.exitCode = 2;
        }
    })();
}
