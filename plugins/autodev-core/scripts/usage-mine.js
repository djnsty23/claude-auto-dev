#!/usr/bin/env node
'use strict';
// usage-mine.js: index the failures in every Claude Code transcript on this
// machine, rank them by week, and give eval cases one extractor to grade with.
//
// WHY. analyze-session-patterns.js answers "what errored in the last N days" by
// re-reading the window on every run. A rule change needs the other question:
// did this class fall in the weeks after the change landed? That needs history
// kept somewhere cheap to re-read, a fixed class vocabulary, and a cost beside
// each count. This keeps that history as a local index and leaves the
// transcripts where they are.
//
// WHAT IT READS. <config>/projects/**/*.jsonl (top-level sessions and the
// subagents/ files under them), streamed line by line, never loaded whole.
// `extract --log <file>` reads one stream-json worker.log or a replay through
// the same extractor, which is what evals/usage grades with.
//
// WHAT IT WRITES. <config>/autodev/usage/ only: files.json (what was mined, by
// size and mtime), events.jsonl (one row per failure event), sessions.jsonl
// (one row per transcript), report-latest.json and history.jsonl. PRIVACY: no
// row holds transcript text, a tool input or a path. A row holds a class from a
// fixed vocabulary, a tool name, a model id, a skill name, a project basename,
// a date and token counts. The index stays on this machine: the claude-memory
// mirror copies named autodev files only, and this directory is not one.
//
// FAILURE CLASSES, each keyed on a field measured present in the real corpus on
// 2026-11-05 (see the sample counts in docs/usage-evals.md):
//   permission-denied/<reason>  permissionDecision.decision "reject" from config,
//                               the classifier or the user; "text" when only the
//                               refusal text says so (older transcripts)
//   hook-block/<hook>           a reject whose source is a hook (labelled by its
//                               autodev-fn rule, script or Stop status), or a
//                               hook_blocking_error attachment
//   tool-error/<class>          an is_error tool_result, classed by
//                               session-error-classes.js (one shared taxonomy)
//   retry-identical             a tool call byte-identical to an earlier call in
//                               the session whose result was an error
//   gate-red                    a test, build, lint or gate command that failed;
//                               r counts the reruns after the first red, the
//                               green one included (attempts minus one)
//   user-correction             a human turn that opens by overruling the agent
//   user-interrupt              "[Request interrupted by user"
//   no-blocker-line             the brief asked for a BLOCKER: line, none came
//   hook-timeout/<hook>         a hook cancelled for running past its timeout
//   max-turns, api-error/<status>
//
// COST. tok on an event is the uncached tokens (input + cache creation +
// output) of the assistant message that made the failing call plus the next
// assistant message, the one that reacted to the failure. A proxy, applied the
// same way every week, so a trend in it is real even where a level is rough.
//
// Usage:
//   node usage-mine.js mine    [--root <dir>] [--out <dir>] [--budget-ms N] [--full]
//   node usage-mine.js report  [--out <dir>] [--weeks N] [--top N] [--json] [--class <prefix>] [--include-synthetic] [--since YYYY-MM-DD]
//   node usage-mine.js observe [--root <dir>] [--out <dir>] [--budget-ms N]
//   node usage-mine.js extract --log <file> [--json]
//   node usage-mine.js --selftest
// Exit 0 done, 1 selftest failed, 2 could not run (bad argument, unreadable root).
// A report over an index with zero files mined exits 2: zero events from zero
// files is not a clean week.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { configDir } = require('./claude-paths.js');
const { classify } = require('./session-error-classes.js');

const DAY = 86400000;

// ---------------------------------------------------------------- vocabulary
// A human turn that opens by overruling. Anchored at the start: "no" deep in a
// sentence is usually not a correction. Measured precision is in docs/usage-evals.md.
// `[measured 2026-11-05]` 22 of 32 hits were real overrules on a read of the most recent
// 1,500 transcripts; the misses were "no idea", "no it's fine", "stop the server" (an order,
// not a correction) and "i already pay". Those shapes are excluded below: 22 of 26.
const CORRECTION_NOT = /^(?:no (?:idea|problem|worries|need|rush)\b|no,? (?:it'?s|that'?s) fine\b|stop the\b|i already (?!said|told|asked))/i;
const CORRECTION_HEAD = /^(?:no+\b|nope\b|wrong\b|stop\b|don'?t\b|do not\b|why (?:did|are|would|is) (?:you|it|this)\b|we (?:already|just) (?:did|done|have|had|fixed|tried)\b|i (?:said|told you|asked you|already)\b|that'?s (?:not|wrong|incorrect)\b|not what i\b|undo\b|revert\b|you (?:broke|forgot|missed|didn'?t|did not|ignored)\b|nu\b|gre[sș]it\b|stai\b|opre[sș]te\b)/i;
const CORRECTION_ANY = /\b(?:we already did this|i already told you|as i (?:said|told you)|you keep (?:doing|making|forgetting)|still (?:broken|wrong|not working|doesn'?t work))\b/i;
const INTERRUPT = /^\[Request interrupted by user/;
// A test, build, lint, typecheck or gate run. The key is the matched words, so
// "cd x && npm test" and "npm test" are one gate.
const GATE = /\b(npm (?:run )?(?:test|gate[\w:-]*|build|lint|typecheck|check[\w:-]*)|npx (?:tsc|vitest|jest|playwright|eslint)|pnpm (?:test|build|lint)|tsc\b(?! --version)|vitest|jest\b|pytest|cargo (?:test|build)|go test|tooling\/(?:test-all|gate-fast|gate-lock)\.js|tooling\/test-[\w-]+\.js)/;
const BLOCKER_LINE = /(?:^|\n)\s*(?:[-*]\s*)?\**BLOCKER\**:/;
// The parse filter. Escaped quotes inside strings never match a bare "type":"user".
const WANT = ['"type":"user"', '"type":"assistant"', '"hook_blocking_error"', '"hook_cancelled"', '"max_turns_reached"', '"type":"result"'];

function week(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const n = Math.ceil(((t - y0) / DAY + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(n).padStart(2, '0')}`;
}

function projectOf(cwd, dirName) {
    if (typeof cwd === 'string' && cwd) {
        const base = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '').replace(/[\\/]+$/, '');
        return path.basename(base.replace(/\\/g, '/')) || dirName;
    }
    return dirName;
}

/** Where a write was aimed, as a category: never the path itself. */
function targetOf(input, cfg) {
    const p = input && (input.file_path || input.notebook_path || input.path);
    const cmd = input && typeof input.command === 'string' ? input.command : '';
    const s = String(p || (/>\s*"?([A-Za-z]:[\\/][^"\s]+|\/[^"\s]+)/.exec(cmd) || [])[1] || '').replace(/\\/g, '/').toLowerCase();
    if (!s) return null;
    const c = cfg.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (s.startsWith(c + '/') || /(^|\/)\.claude\/(autodev|projects|rules|skills)\//.test(s) && !/\/\.claude\/worktrees\//.test(s)) return 'config-dir';
    if (/\/\.claude\/worktrees\//.test(s)) return 'worktree';
    if (/\/(temp|tmp)\//.test(s)) return 'temp';
    return 'other';
}

/**
 * The hook that refused or timed out, as a label its config defines: an autodev-fn rule id,
 * a hook script's basename, or a Stop hook's status message as a slug. Never refusal text.
 * `[measured 2026-11-05]` hook rejects carry no hookName (reasonType "hook" only), so
 * without this every PreToolUse refusal ranked as one anonymous hook-block/hook.
 */
function hookLabel(text, status) {
    const t = String(text || '').slice(0, 600);
    let m = /autodev-fn \(([\w-]{2,40})\)/.exec(t);
    if (m) return `autodev-fn:${m[1]}`;
    m = /hooks[\\/]([\w.-]{2,40}?)\.(?:m?js|py|cmd|ps1|sh)\b/i.exec(t) || /\b([\w-]{3,40})\.(?:m?js|py)(?=["'\]\s:])/.exec(t);
    if (m && !/^node$/i.test(m[1])) return m[1];
    // Refusals that name no script, by the message the refusing guard always prints.
    // `[measured 2026-11-05]` the three largest unnamed shapes in the corpus.
    if (/<tool_use_error>Blocked: (?:standalone )?sleep\b/.test(t)) return 'sleep-blocker';
    if (/running in an isolated git worktree/.test(t)) return 'worktree-guard';
    if (/This session runs headless/.test(t)) return 'headless-guard';
    const s = String(status || '').toLowerCase().replace(/[^a-z ]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 40);
    return s || null;
}

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
    return '';
}

function tokensOf(usage) {
    if (!usage || typeof usage !== 'object') return 0;
    return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
}

function hashOf(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }

function isHumanTurn(o, text) {
    if (o.isMeta || o.isCompactSummary) return false;
    const kind = o.origin && o.origin.kind;
    if (kind) return kind === 'human';
    if (o.turnOrigin) return o.turnOrigin === 'human';
    if (o.promptSource === 'system') return false;
    return !/^\s*</.test(text) && !/^Caveat:/.test(text);
}

function isCorrection(text) {
    const t = text.trim().slice(0, 400);
    if (CORRECTION_NOT.test(t)) return false;
    return CORRECTION_HEAD.test(t) || CORRECTION_ANY.test(t);
}

// ---------------------------------------------------------------- extractor
/**
 * One transcript's state machine. feed() each parsed line in order, then end().
 * Works on a session transcript and on a stream-json log alike: both carry the
 * same user and assistant lines.
 */
function createExtractor(meta = {}) {
    const cfg = meta.configDir || configDir();
    const st = {
        events: [], session: meta.session || null, cwd: null, first: null, last: null, model: null,
        entry: null, mode: null, tok: 0, msgTok: new Map(), calls: new Map(), errHashes: new Set(),
        gates: new Map(), seenDenied: new Set(), skill: null, react: [], askedBlocker: false, sawBlocker: false,
        humanTurns: 0, toolResults: 0, lines: 0,
    };
    const emit = (c, extra, call, ts) => {
        const e = { c, d: (ts || st.last || '').slice(0, 10), t: call ? call.name : null, m: (call && call.model) || st.model,
            k: (call && call.skill) || st.skill, tok: call ? call.tok : 0, r: 0, ...extra };
        // Identity across files: a forked session copies its parent's lines, tool ids and
        // timestamps included, so the report counts one event once however many files hold it.
        e.u = hashOf(`${c}\0${(call && call.id) || ''}\0${extra.u || ts || ''}`).slice(0, 10);
        st.events.push(e);
        st.react.push(e);
        return e;
    };
    function onAssistant(o) {
        const msg = o.message || {};
        if (msg.model && msg.model !== '<synthetic>') st.model = msg.model;
        const id = msg.id || o.uuid;
        let tok = 0;
        if (id && !st.msgTok.has(id)) {
            tok = tokensOf(msg.usage);
            st.msgTok.set(id, tok);
            st.tok += tok;
            // The first assistant message after a failure is the reaction to it.
            for (const e of st.react) e.tok += tok;
            st.react = [];
        } else if (id) tok = st.msgTok.get(id);
        if (o.isApiErrorMessage) emit(`api-error/${o.apiErrorStatus || 'unknown'}`, {}, null, o.timestamp);
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
            if (b.type === 'text' && BLOCKER_LINE.test(b.text || '')) st.sawBlocker = true;
            if (b.type !== 'tool_use') continue;
            const input = b.input || {};
            const raw = JSON.stringify(input);
            if (b.name === 'Skill' && typeof input.skill === 'string') st.skill = input.skill;
            const h = hashOf(b.name + '\0' + raw);
            const call = { id: b.id, name: b.name, hash: h, model: st.model, skill: o.attributionSkill || st.skill, tok: tok || 0, input, ts: o.timestamp };
            // A BLOCKER line inside a write counts once the write lands: a refused report reached nobody.
            if (BLOCKER_LINE.test(raw.replace(/\\n/g, '\n'))) call.blocker = true;
            if (b.name === 'Bash' && typeof input.command === 'string') {
                const g = GATE.exec(input.command);
                if (g) call.gate = g[1];
            }
            st.calls.set(b.id, call);
            if (st.errHashes.has(h)) emit('retry-identical', {}, call, o.timestamp);
        }
    }
    function onToolResult(o, b) {
        st.toolResults++;
        const call = st.calls.get(b.tool_use_id) || { name: null, tok: 0 };
        const pd = o.permissionDecision;
        const text = textOf(b.content);
        if (pd && pd.decision === 'reject' && !st.seenDenied.has(b.tool_use_id)) {
            st.seenDenied.add(b.tool_use_id);
            if (pd.source === 'hook') emit(`hook-block/${hookLabel(text) || pd.hookName || 'hook'}`, {}, call, o.timestamp);
            else if (pd.source === 'user_reject') emit('permission-denied/user-reject', {}, call, o.timestamp);
            else emit(`permission-denied/${pd.reasonCode || pd.reasonType || pd.source || 'config'}`, { tg: targetOf(call.input, cfg) }, call, o.timestamp);
        } else if (b.is_error && !st.seenDenied.has(b.tool_use_id)) {
            const cls = classify(text);
            if (cls === 'permission-denied') { st.seenDenied.add(b.tool_use_id); emit(/don'?t ask mode/i.test(text) ? 'permission-denied/mode:dontAsk' : 'permission-denied/text',{ tg: targetOf(call.input, cfg) }, call, o.timestamp); }
            else if (cls === 'hook-blocked-command') { st.seenDenied.add(b.tool_use_id); emit(`hook-block/${hookLabel(text) || 'text'}`, {}, call, o.timestamp); }
            else if (cls !== 'shell-exit-may-be-the-answer') emit(`tool-error/${cls}`, {}, call, o.timestamp);
        }
        if (b.is_error && call.hash) st.errHashes.add(call.hash);
        if (call.blocker && !b.is_error && !st.seenDenied.has(b.tool_use_id)) st.sawBlocker = true;
        if (call.gate) {
            const open = st.gates.get(call.gate);
            if (b.is_error) {
                if (open) open.r++;
                else st.gates.set(call.gate, emit('gate-red', { r: 0 }, call, o.timestamp));
            } else if (open) {
                // r is every rerun after the first red, the green one included: attempts minus one.
                open.r++;
                open.green = true;
                st.gates.delete(call.gate);
            }
        }
    }
    function onUser(o) {
        const msg = o.message || {};
        const content = msg.content;
        if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
            for (const b of content) if (b && b.type === 'tool_result') onToolResult(o, b);
            return;
        }
        const text = textOf(content);
        if (!text) return;
        if (!st.askedBlocker && /BLOCKER/.test(text) && st.humanTurns + st.toolResults < 3) st.askedBlocker = true;
        if (INTERRUPT.test(text.trim())) { emit('user-interrupt', {}, null, o.timestamp); return; }
        if (!isHumanTurn(o, text)) return;
        st.humanTurns++;
        if (st.toolResults > 0 && isCorrection(text)) emit('user-correction', {}, null, o.timestamp);
    }
    return {
        feed(o) {
            st.lines++;
            if (o.timestamp) { st.first = st.first || o.timestamp; st.last = o.timestamp; }
            if (o.cwd && !st.cwd) st.cwd = o.cwd;
            if (o.sessionId && !st.session) st.session = o.sessionId;
            if (o.session_id && !st.session) st.session = o.session_id;
            if (o.entrypoint && !st.entry) st.entry = o.entrypoint;
            if (o.permissionMode) st.mode = o.permissionMode;
            if (o.type === 'system' && o.subtype === 'init') { st.cwd = st.cwd || o.cwd; st.mode = o.permissionMode || st.mode; st.model = o.model || st.model; }
            if (o.type === 'assistant') onAssistant(o);
            else if (o.type === 'user') onUser(o);
            else if (o.type === 'attachment' && o.attachment) {
                const a = o.attachment;
                if (a.type === 'hook_blocking_error' && !(a.toolUseID && st.seenDenied.has(a.toolUseID))) {
                    if (a.toolUseID) st.seenDenied.add(a.toolUseID);
                    const be = a.blockingError && typeof a.blockingError === 'object' ? a.blockingError : {};
                    emit(`hook-block/${hookLabel(be.command, be.command) || a.hookName || a.hookEvent || 'hook'}`, {}, st.calls.get(a.toolUseID) || null, o.timestamp);
                } else if (a.type === 'hook_cancelled') {
                    emit(`hook-timeout/${hookLabel(a.command, a.command) || String(a.hookName || a.hookEvent || 'hook').split(':')[0]}`, {}, st.calls.get(a.toolUseID) || null, o.timestamp);
                }
                else if (a.type === 'max_turns_reached') emit('max-turns', {}, null, o.timestamp);
            } else if (o.type === 'result' && Array.isArray(o.permission_denials)) {
                // A stream-json log's own tally. Each denial already met as a tool_result counts once.
                for (const d of o.permission_denials) {
                    if (!d || st.seenDenied.has(d.tool_use_id)) continue;
                    st.seenDenied.add(d.tool_use_id);
                    emit('permission-denied/result', { tg: targetOf(d.tool_input, cfg) }, { name: d.tool_name, tok: 0 }, o.timestamp);
                }
            }
        },
        end() {
            if (st.askedBlocker && !st.sawBlocker) emit('no-blocker-line', { u: `${st.session}` }, null, st.last);
            const project = projectOf(st.cwd, meta.dirName || null);
            const wk = week(st.first || st.last || '');
            for (const e of st.events) { e.p = project; e.w = week(e.d) || wk; e.s = st.session ? String(st.session).slice(0, 8) : null; if (meta.sub) e.sa = 1; if (e.tg == null) delete e.tg; if (!e.r) delete e.r; }
            return {
                events: st.events,
                session: { s: st.session ? String(st.session).slice(0, 8) : null, p: project, d0: (st.first || '').slice(0, 10), d1: (st.last || '').slice(0, 10),
                    w: wk, m: st.model, ent: st.entry, mode: st.mode, tok: st.tok, n: st.events.length, sub: meta.sub ? 1 : 0,
                    lines: st.lines, results: st.toolResults, human: st.humanTurns, askedBlocker: st.askedBlocker ? 1 : 0 },
            };
        },
    };
}

/** Stream one file through a fresh extractor. Lines that cannot matter are never parsed. */
async function extractFile(file, meta = {}) {
    const ex = createExtractor(meta);
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    let bad = 0;
    for await (const line of rl) {
        if (!line || !WANT.some((w) => line.includes(w))) continue;
        let o;
        try { o = JSON.parse(line); } catch { bad++; continue; }
        ex.feed(o);
    }
    const out = ex.end();
    out.session.bad = bad;
    return out;
}

// ---------------------------------------------------------------- the index
function defaultOut() { return path.join(configDir(), 'autodev', 'usage'); }

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    const rows = [];
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l) continue; try { rows.push(JSON.parse(l)); } catch { /* a torn last line */ } }
    return rows;
}

function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

async function mine({ root, out, budgetMs = Infinity, full = false, now = Date.now(), progress = false }) {
    if (!fs.existsSync(root)) throw Object.assign(new Error(`root ${root} does not exist`), { exit: 2 });
    const statePath = path.join(out, 'files.json');
    const state = full || !fs.existsSync(statePath) ? { files: {} } : JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const all = walk(root);
    const changed = [];
    const present = new Set();
    for (const f of all) {
        const rel = path.relative(root, f).replace(/\\/g, '/');
        present.add(rel);
        let s;
        try { s = fs.statSync(f); } catch { continue; }
        const prev = state.files[rel];
        if (!prev || prev.size !== s.size || prev.mtime !== Math.floor(s.mtimeMs)) changed.push({ f, rel, size: s.size, mtime: Math.floor(s.mtimeMs) });
    }
    // Oldest first, so a budgeted run makes steady progress through a backlog.
    changed.sort((a, b) => a.mtime - b.mtime);
    const t0 = Date.now();
    const fresh = new Map();
    let mined = 0, bytes = 0;
    for (const c of changed) {
        if (Date.now() - t0 > budgetMs) break;
        const parts = c.rel.split('/');
        const r = await extractFile(c.f, { dirName: parts[0], sub: parts.includes('subagents') });
        const h = hashOf(c.rel);
        for (const e of r.events) e.f = h;
        r.session.f = h;
        fresh.set(h, r);
        state.files[c.rel] = { h, size: c.size, mtime: c.mtime, n: r.events.length };
        mined++;
        bytes += c.size;
        if (progress && mined % 250 === 0) process.stderr.write(`  ${mined}/${changed.length} files, ${(bytes / 1e9).toFixed(1)} GB, ${Math.round((Date.now() - t0) / 1000)} s\n`);
    }
    // A file that vanished (cleanup) keeps its rows: history outlives the transcript.
    const keepEv = readJsonl(path.join(out, 'events.jsonl')).filter((e) => !fresh.has(e.f));
    const keepSe = readJsonl(path.join(out, 'sessions.jsonl')).filter((s) => !fresh.has(s.f));
    for (const r of fresh.values()) { keepEv.push(...r.events); keepSe.push(r.session); }
    writeAtomic(path.join(out, 'events.jsonl'), keepEv.map((e) => JSON.stringify(e)).join('\n') + (keepEv.length ? '\n' : ''));
    writeAtomic(path.join(out, 'sessions.jsonl'), keepSe.map((s) => JSON.stringify(s)).join('\n') + (keepSe.length ? '\n' : ''));
    state.minedAt = new Date(now).toISOString();
    state.root = root;
    writeAtomic(statePath, JSON.stringify(state));
    const gone = Object.keys(state.files).filter((k) => !present.has(k)).length;
    return { files: all.length, changed: changed.length, mined, pending: changed.length - mined, gone, bytes, ms: Date.now() - t0, events: keepEv.length, sessions: keepSe.length };
}

// ---------------------------------------------------------------- the report
/** The top level a class is ranked at: permission-denied/mode:dontAsk stays whole, tool-error/x stays whole. */
function rankKey(e) { return e.c; }

// Eval harnesses run `claude -p` in throwaway dirs, and their transcripts land in the same
// store. `[measured 2026-11-05]` skill-trigger-eval-* alone was 3,856 events and ranked
// first and second (max-turns, hook-block/hook): the harness's own max-turns 1 design,
// not fleet failures. Only harness-named dirs match, so a real session in Temp still counts.
const SYNTHETIC = /^(?:skill-)?trigger-eval-|^usage-(?:replay|eval)-/i;
const isSynthetic = (p) => SYNTHETIC.test(p || '');

function report({ out, weeks = 8, top = 10, classPrefix = null, now = Date.now(), includeSynthetic = false, since = null }) {
    const statePath = path.join(out, 'files.json');
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { files: {} };
    const mined = Object.keys(state.files).length;
    // --since keeps the ranking to classes still live: a class fixed in week 2 stops outranking one rising now.
    const allEvents = readJsonl(path.join(out, 'events.jsonl')).filter((e) => (!classPrefix || e.c.startsWith(classPrefix)) && (!since || (e.d || '') >= since));
    const allSessions = readJsonl(path.join(out, 'sessions.jsonl')).filter((x) => !since || (x.d1 || x.d0 || '') >= since);
    const events = includeSynthetic ? allEvents : allEvents.filter((e) => !isSynthetic(e.p));
    const sessions = includeSynthetic ? allSessions : allSessions.filter((s) => !isSynthetic(s.p));
    const synthetic = { events: allEvents.length - events.length, sessions: allSessions.length - sessions.length, included: includeSynthetic };
    const wkList = [];
    for (let i = weeks - 1; i >= 0; i--) wkList.push(week(new Date(now - i * 7 * DAY).toISOString()));
    const sessionsPerWeek = Object.fromEntries(wkList.map((w) => [w, sessions.filter((s) => s.w === w && !s.sub).length]));
    const by = new Map();
    const seenU = new Set();
    let dupes = 0;
    for (const e of events) {
        if (e.u) { if (seenU.has(e.u)) { dupes++; continue; } seenU.add(e.u); }
        const k = rankKey(e);
        let c = by.get(k);
        if (!c) { c = { class: k, count: 0, sessions: new Set(), tok: 0, retries: 0, weeks: {}, weekTok: {}, tools: {}, models: {}, skills: {}, projects: {}, targets: {} }; by.set(k, c); }
        c.count++;
        c.sessions.add(e.f || e.s);
        c.tok += e.tok || 0;
        c.retries += e.r || 0;
        if (e.w) { c.weeks[e.w] = (c.weeks[e.w] || 0) + 1; c.weekTok[e.w] = (c.weekTok[e.w] || 0) + (e.tok || 0); }
        for (const [field, key] of [['tools', e.t], ['models', e.m], ['skills', e.k], ['projects', e.p], ['targets', e.tg]]) if (key) c[field][key] = (c[field][key] || 0) + 1;
    }
    const topOf = (o, n = 3) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`);
    const rows = [...by.values()].map((c) => ({
        class: c.class, count: c.count, sessions: c.sessions.size, tok: c.tok, retries: c.retries,
        tokPerEvent: c.count ? Math.round(c.tok / c.count) : 0,
        weekly: wkList.map((w) => c.weeks[w] || 0), weeklyTok: wkList.map((w) => c.weekTok[w] || 0),
        tools: topOf(c.tools), models: topOf(c.models), skills: topOf(c.skills), projects: topOf(c.projects), targets: topOf(c.targets),
    }));
    const byCount = [...rows].sort((a, b) => b.sessions - a.sessions || b.count - a.count).slice(0, top);
    const byCost = [...rows].sort((a, b) => b.tok - a.tok).slice(0, top);
    const days = events.map((e) => e.d).filter(Boolean).sort();
    return {
        generatedAt: new Date(now).toISOString(), minedAt: state.minedAt || null,
        population: { filesMined: mined, sessions: sessions.length, topLevelSessions: sessions.filter((s) => !s.sub).length, events: events.length - dupes, duplicatesDropped: dupes, synthetic, since,
            firstDay: days[0] || null, lastDay: days[days.length - 1] || null, weeks: wkList, sessionsPerWeek },
        byCount, byCost, classes: rows.length,
    };
}

function fmtTok(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n); }

function printReport(r) {
    const p = r.population;
    const lines = [];
    lines.push(`usage-mine report, ${r.generatedAt.slice(0, 16)}Z, index mined ${r.minedAt || 'never'}`);
    lines.push(`population: ${p.filesMined} transcript files mined (${p.topLevelSessions} top-level sessions, ${p.sessions - p.topLevelSessions} subagent files), ${p.events} failure events (${p.duplicatesDropped} copies in forked transcripts dropped), ${p.firstDay} to ${p.lastDay}`);
    if (p.since) lines.push(`only events and sessions on or after ${p.since} (--since)`);
    if (p.synthetic) lines.push(p.synthetic.included ? 'eval-harness transcripts INCLUDED (--include-synthetic)' : `eval-harness transcripts left out: ${p.synthetic.sessions} files, ${p.synthetic.events} events (--include-synthetic counts them)`);
    lines.push(`sessions per week (top-level): ${p.weeks.map((w) => `${w.slice(5)} ${p.sessionsPerWeek[w]}`).join(', ')}`);
    lines.push('');
    lines.push(`ranked by SESSIONS affected, then events. weekly columns: ${p.weeks.map((w) => w.slice(5)).join(' ')}`);
    lines.push(`${'class'.padEnd(44)} ${'sess'.padStart(6)} ${'events'.padStart(7)} ${'tokens'.padStart(7)} ${'retry'.padStart(5)}  weekly`);
    for (const x of r.byCount) lines.push(`${x.class.slice(0, 44).padEnd(44)} ${String(x.sessions).padStart(6)} ${String(x.count).padStart(7)} ${fmtTok(x.tok).padStart(7)} ${String(x.retries).padStart(5)}  ${x.weekly.join(' ')}`);
    lines.push('');
    lines.push('ranked by TOKEN COST (failing call + the reaction to it, uncached)');
    for (const x of r.byCost) lines.push(`${x.class.slice(0, 44).padEnd(44)} ${fmtTok(x.tok).padStart(7)}  ${x.count} events, ${fmtTok(x.tokPerEvent)}/event, tools ${x.tools.join(', ') || '-'}`);
    return lines.join('\n');
}

// ---------------------------------------------------------------- selftest
function selftest() {
    let pass = 0, fail = 0;
    const check = (label, ok, detail) => { if (ok) { pass++; console.log(`ok    ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`); } };
    const cfg = 'C:/Users/someone/.claude';
    const asst = (id, blocks, extra = {}) => ({ type: 'assistant', timestamp: '2026-11-05T10:00:00Z', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: blocks }, ...extra });
    const res = (id, isErr, text, extra = {}) => ({ type: 'user', timestamp: '2026-11-05T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isErr, content: text }] }, ...extra });
    const run = (lines) => { const ex = createExtractor({ configDir: cfg, dirName: 'proj' }); lines.forEach((l) => ex.feed(l)); return ex.end(); };
    const cls = (r) => r.events.map((e) => e.c);

    // The known positive this index exists for: dontAsk refused a Write into the config dir.
    const a = run([
        { type: 'user', timestamp: '2026-11-05T10:00:00Z', cwd: 'C:/x/.claude/worktrees/w1', message: { content: 'Brief. Write a report whose last lines carry BLOCKER: and RESULT.' } },
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: `${cfg}/autodev/reports/w/REPORT.md`, content: 'x' } }]),
        res('t1', true, 'Permission to use Write has been denied because Claude Code is running in don\'t ask mode.', { permissionDecision: { decision: 'reject', source: 'config', reasonType: 'mode', reasonCode: 'mode:dontAsk' } }),
        asst('m2', [{ type: 'text', text: 'Could not write the report.' }]),
    ]);
    check('a dontAsk reject is one permission-denied/mode:dontAsk event', cls(a).filter((c) => c === 'permission-denied/mode:dontAsk').length === 1, cls(a).join(','));
    check('  aimed at the config dir', a.events[0].tg === 'config-dir', a.events[0].tg);
    check('  costed with the reaction message', a.events[0].tok === 30, a.events[0].tok);
    check('  and the session asked for a BLOCKER line it never gave', cls(a).includes('no-blocker-line'));
    check('  project is the repo, not the worktree', a.events[0].p === 'x', a.events[0].p);
    // Control: the same session that does write a BLOCKER line is not flagged.
    const b = run([
        { type: 'user', timestamp: '2026-11-05T10:00:00Z', message: { content: 'Brief. End with a BLOCKER: line.' } },
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'C:/tmp/out/REPORT.md', content: 'done\nBLOCKER: none\nRESULT x done' } }]),
        res('t1', false, 'ok'),
    ]);
    check('control: a report carrying BLOCKER: raises no no-blocker-line', !cls(b).includes('no-blocker-line'), cls(b).join(','));
    check('control: a successful write is no event', b.events.length === 0, cls(b).join(','));

    // Retry of an identical failing call, and a gate that went red twice then green.
    const c = run([
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]),
        res('t1', true, 'Exit code 1\nError: boom'),
        asst('m2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }]),
        res('t2', true, 'Exit code 1\nError: boom'),
        asst('m3', [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'cd a && npm test' } }]),
        res('t3', false, 'ok'),
    ]);
    const gate = c.events.find((e) => e.c === 'gate-red');
    check('an identical rerun of a failed call is retry-identical', cls(c).filter((x) => x === 'retry-identical').length === 1, cls(c).join(','));
    check('one gate-red per red streak, retries counted to green', !!gate && gate.r === 2 && cls(c).filter((x) => x === 'gate-red').length === 1, JSON.stringify(gate));
    check('the failing shell output is classed by the shared taxonomy', cls(c).includes('tool-error/shell-fault'), cls(c).join(','));
    // Control: a changed command after a failure is not a retry-identical.
    const c2 = run([
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls a' } }]),
        res('t1', true, 'Exit code 2\nfatal: no'),
        asst('m2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls b' } }]),
        res('t2', false, 'ok'),
    ]);
    check('control: a changed call after an error is no retry-identical', !cls(c2).includes('retry-identical'), cls(c2).join(','));

    // Human corrections: origin human, after work started; not a peer, not the opening prompt.
    const d = run([
        { type: 'user', origin: { kind: 'human' }, message: { content: 'No, start over' }, timestamp: '2026-11-05T10:00:00Z' },
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }]),
        res('t1', false, 'x'),
        { type: 'user', origin: { kind: 'human' }, message: { content: 'no, we already did this yesterday' }, timestamp: '2026-11-05T10:01:00Z' },
        { type: 'user', origin: { kind: 'peer', from: 'local_x' }, message: { content: 'no, wrong branch' }, timestamp: '2026-11-05T10:02:00Z' },
        { type: 'user', origin: { kind: 'human' }, message: { content: 'Nothing else, thanks. Notice the no-op.' }, timestamp: '2026-11-05T10:03:00Z' },
        { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, timestamp: '2026-11-05T10:04:00Z' },
    ]);
    check('one user-correction: a human overrule after work began', cls(d).filter((x) => x === 'user-correction').length === 1, cls(d).join(','));
    check('  a peer message is never a user correction, "Nothing" is not "no"', cls(d).filter((x) => x === 'user-correction').length === 1);
    check('an interrupt is user-interrupt', cls(d).includes('user-interrupt'));

    // Hook blocks by both shapes, counted once per call.
    const e = run([
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push --force' } }]),
        { type: 'attachment', attachment: { type: 'hook_blocking_error', hookName: 'PreToolUse:Bash', toolUseID: 't1' } },
        res('t1', true, 'PreToolUse:Bash hook error: blocked', { permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook' } }),
        { type: 'attachment', attachment: { type: 'max_turns_reached' } },
    ]);
    check('a hook block reported twice (attachment and reject) counts once', cls(e).filter((x) => x.startsWith('hook-block/')).length === 1, cls(e).join(','));
    // Hand-written refusal shapes, one per label source: an autodev-fn rule, a script path, a Stop status.
    const hk = run([
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat <<EOF' } }]),
        res('t1', true, '<tool_use_error>autodev-fn (heredoc-backslash): On Windows the Bash tool delivers', {}),
        asst('m2', [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'x' } }]),
        res('t2', true, 'PreToolUse:Write hook error: [node C:/p/autodev-core/8.1.0/hooks/pre-tool-filter.js]: Blocked: no', { permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook' } }),
        { type: 'attachment', attachment: { type: 'hook_blocking_error', hookName: 'Stop', hookEvent: 'Stop', blockingError: { blockingError: 'CONTEXT DEPTH IS 251,000', command: 'Checking context depth...' } } },
        { type: 'attachment', attachment: { type: 'hook_cancelled', hookName: 'UserPromptSubmit', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/inbox-notify.js' } },
        // The real Stop timeouts carry the hook's statusMessage as command, not a script path.
        { type: 'attachment', attachment: { type: 'hook_cancelled', hookName: 'Stop', hookEvent: 'Stop', command: 'Checking for unreported work...', timedOut: true, timeoutMs: 5000 } },
    ]);
    check('a quoted script path and a known guard message are labelled too',
        hookLabel('PreToolUse:Bash hook error: ["C:/Program Files/nodejs/node.exe" "C:/x/scripts/release-guard.mjs" guard]') === 'release-guard'
        && hookLabel('<tool_use_error>Blocked: sleep 45 followed by: tail -5 x') === 'sleep-blocker'
        && hookLabel('PreToolUse:Bash hook error: an unknown refusal') === null);
    check('hook blocks are labelled by rule, script and status, never by refusal text',
        ['hook-block/autodev-fn:heredoc-backslash', 'hook-block/pre-tool-filter', 'hook-block/checking-context-depth', 'hook-timeout/inbox-notify', 'hook-timeout/checking-for-unreported-work'].every((c) => cls(hk).includes(c)), cls(hk).join(','));
    check('max-turns is its own class', cls(e).includes('max-turns'));

    // A stream-json result tally adds only denials not already seen.
    const f = run([
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: `${cfg}/autodev/x/REPORT.md` } }]),
        res('t1', true, 'Permission to use Write has been denied', { permissionDecision: { decision: 'reject', source: 'config', reasonType: 'mode', reasonCode: 'mode:dontAsk' } }),
        { type: 'result', permission_denials: [{ tool_name: 'Write', tool_use_id: 't1', tool_input: {} }, { tool_name: 'Bash', tool_use_id: 't9', tool_input: { command: `cat > "${cfg}/autodev/x/REPORT.md"` } }] },
    ]);
    check('a result tally adds the unseen denial only', cls(f).filter((x) => x.startsWith('permission-denied/')).length === 2, cls(f).join(','));
    check('  and classes a heredoc redirect into the config dir as config-dir', f.events.some((x) => x.c === 'permission-denied/result' && x.tg === 'config-dir'));

    // A stream-json log carries no permissionDecision: the refusal text alone must land in the same class.
    const g = run([
        asst('m1', [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: `${cfg}/autodev/x/REPORT.md` } }]),
        res('t1', true, 'Permission to use Write has been denied because Claude Code is running in don\'t ask mode. IMPORTANT: ...'),
    ]);
    check('a text-only dontAsk refusal is permission-denied/mode:dontAsk too', cls(g).join(',') === 'permission-denied/mode:dontAsk', cls(g).join(','));

    check('ISO week of 2026-11-05 is 2026-W45', week('2026-11-05T12:00:00Z') === '2026-W45', week('2026-11-05T12:00:00Z'));
    check('ISO week of 2026-01-01 is 2026-W01', week('2026-01-01T12:00:00Z') === '2026-W01', week('2026-01-01T12:00:00Z'));
    check('no event row carries text or a path', [a, b, c, d, e, f, hk].every((r) => r.events.every((x) => Object.values(x).every((v) => typeof v !== 'string' || v.length < 60 && !/[\\/]/.test(v.replace(/^(permission-denied|hook-block|hook-timeout|tool-error|api-error)\//, ''))))));
    console.log(`\n${pass} passed, ${fail} failed`);
    return fail ? 1 : 0;
}

// ---------------------------------------------------------------- CLI
const HELP = `usage-mine.js: index Claude Code transcript failures, rank them weekly.
  node usage-mine.js mine    [--root <dir>] [--out <dir>] [--budget-ms N] [--full]
  node usage-mine.js report  [--out <dir>] [--weeks N] [--top N] [--json] [--class <prefix>] [--include-synthetic] [--since YYYY-MM-DD]
  node usage-mine.js observe [--root <dir>] [--out <dir>] [--budget-ms N]   (brain-clock observer: mine, then report)
  node usage-mine.js extract --log <file> [--json]                         (one transcript or stream-json log)
  node usage-mine.js --selftest
Defaults: --root <config>/projects, --out <config>/autodev/usage. Writes only under --out.
Exit 0 done, 1 selftest failed, 2 could not run.`;

function parseArgs(argv) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { o._.push(a); continue; }
        const [k, v] = a.slice(2).split('=');
        if (v !== undefined) o[k] = v;
        else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
        else o[k] = true;
    }
    return o;
}

async function main(argv) {
    const o = parseArgs(argv);
    if (o.help || o.h) { console.log(HELP); return 0; }
    if (o.selftest) return selftest();
    const cmd = o._[0];
    const out = path.resolve(o.out || defaultOut());
    const root = path.resolve(o.root || path.join(configDir(), 'projects'));
    const budgetMs = o['budget-ms'] ? Number(o['budget-ms']) : Infinity;
    if (cmd === 'mine' || cmd === 'observe') {
        const m = await mine({ root, out, budgetMs: cmd === 'observe' && !o['budget-ms'] ? 70000 : budgetMs, full: o.full === true, progress: o.progress === true });
        console.log(`mined ${m.mined} of ${m.changed} changed files (${(m.bytes / 1e6).toFixed(0)} MB, ${m.ms} ms), ${m.pending} still pending, ${m.files} files under the root, ${m.gone} indexed files since removed; index holds ${m.events} events over ${m.sessions} files`);
        if (cmd === 'mine') return 0;
        const r = report({ out });
        writeAtomic(path.join(out, 'report-latest.json'), JSON.stringify({ ...r, pending: m.pending }, null, 2));
        fs.appendFileSync(path.join(out, 'history.jsonl'), JSON.stringify({ at: r.generatedAt, pending: m.pending, population: r.population, top: r.byCount.map((x) => ({ class: x.class, count: x.count, sessions: x.sessions, tok: x.tok, thisWeek: x.weekly[x.weekly.length - 1] })) }) + '\n');
        if (!r.population.filesMined) { console.log('report: 0 files mined, so nothing was measured'); return 2; }
        const t = r.byCount[0];
        console.log(`usage report: ${r.population.events} events over ${r.population.filesMined} files; top ${t ? `${t.class} (${t.sessions} sessions, ${t.weekly[t.weekly.length - 1]} this week)` : 'none'}; ${m.pending} files pending`);
        return 0;
    }
    if (cmd === 'report') {
        const r = report({ out, weeks: Number(o.weeks) || 8, top: Number(o.top) || 10, classPrefix: typeof o.class === 'string' ? o.class : null, includeSynthetic: !!o['include-synthetic'], since: typeof o.since === 'string' ? o.since : null });
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else console.log(printReport(r));
        if (!r.population.filesMined) { console.error('0 files mined: run `usage-mine.js mine` first. Nothing was measured.'); return 2; }
        return 0;
    }
    if (cmd === 'extract') {
        if (typeof o.log !== 'string' || !fs.existsSync(o.log)) { console.error('extract needs --log <existing file>'); return 2; }
        const r = await extractFile(o.log, { dirName: path.basename(path.dirname(o.log)) });
        if (o.json) console.log(JSON.stringify(r));
        else { console.log(`${r.session.lines} lines parsed, ${r.session.results} tool results, ${r.events.length} events`); for (const e of r.events) console.log(`  ${e.c}${e.t ? ` tool=${e.t}` : ''}${e.tg ? ` target=${e.tg}` : ''}`); }
        return 0;
    }
    console.error(HELP);
    return 2;
}

module.exports = { isSynthetic, hookLabel, createExtractor, extractFile, mine, report, printReport, week, projectOf, targetOf, isCorrection, isHumanTurn, GATE, CORRECTION_HEAD };

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(String(e && e.stack || e)); process.exitCode = e && e.exit ? e.exit : 2; });
}
