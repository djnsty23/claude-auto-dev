#!/usr/bin/env node
'use strict';
// assert-transcripts.js - check worker rules against what sessions actually did.
//
// analyze-session-patterns.js ranks the errors sessions HIT. This asserts the
// rules a session must keep even when nothing errors, over the same surface:
// every transcript under <config>/projects, subagents included.
//
//   commit-without-check     a git commit after a file edit, with no test, gate,
//                            lint, typecheck or build command in between
//   merged-claim-unverified  assistant text saying "#N merged" with no earlier
//                            tool call or result about PR N in that session
//   forbidden-git            --no-verify, a force push or reset --hard that ran
//                            (a call the hook refused is not counted)
//
// A finding is a hypothesis to read, not a verdict: the user may have asked
// for the forbidden command, and a check may have run in another session.
//
// Usage:
//   node assert-transcripts.js [--days N] [--root DIR] [--project SUBSTR]
//                              [--json] [--strict] [--selftest]
//
// Exit: 0 read and reported, 1 findings under --strict, 2 nothing to read
// (an empty population is indeterminate, never clean).
//
// --selftest derives its negatives from the subject: it takes a compliant
// commit and a verified claim from the real population, removes the check or
// the probe, writes the copy to a temp dir apart from the subject, and requires
// the assertion to fire on it. No positive control in the population: exit 2.
//
// PRIVACY: read-only. Findings print a session key, a time, a PR number or the
// forbidden flag. Never a whole command, never message text.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Quoted text and heredoc bodies are data: a brief that says "never --no-verify"
// inside cat <<'EOF' is not a --no-verify. 18 of the first 42 forbidden-git
// findings were that shape.
function stripQuotes(cmd) {
    return String(cmd)
        .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|$)/g, '<<')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
}

function isCommit(cmd) {
    return /(^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?commit\b/.test(stripQuotes(cmd));
}

const CHECK = new RegExp([
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|gate|check|lint|typecheck|build|validate)\b`,
    String.raw`\bnpx\s+(?:tsc|vitest|jest|playwright|eslint)\b`,
    String.raw`\b(?:pytest|tsc)\b`, String.raw`\bgo\s+test\b`, String.raw`\bcargo\s+(?:test|check|clippy)\b`,
    String.raw`\bnode\s+\S*(?:test|check|gate|validate)[-\w.]*\.m?js\b`, String.raw`\bfast-lane\.js\b`,
    String.raw`\bfor\s+\w+\s+in\b[^;]*\btest-`,
].join('|'));
function isCheck(cmd) { return CHECK.test(stripQuotes(cmd)); }

function forbiddenFlag(cmd) {
    const c = stripQuotes(cmd);
    if (/\bgit\b[^|;&]*\s--no-verify\b/.test(c)) return '--no-verify';
    // --force-with-lease on a session's own rebased branch is the merge-lock
    // re-cut flow, and the rulesets refuse any force push to main or stable.
    if (/\bgit\s+push\b[^|;&]*\s(?:--force(?![-\w])|-f\b)/.test(c)) return 'push --force';
    if (/\bgit\s+reset\s+(?:\S+\s+)*--hard\b/.test(c)) return 'reset --hard';
    return null;
}

const NEGATION = /\b(?:not|never|un|until|once|unless|if|before|when|wait|waiting|after|whether)\b|n't\b|\?/i;
function mergedClaims(text) {
    const out = new Set();
    const s = String(text);
    for (const m of s.matchAll(/#(\d{1,6})\b/g)) {
        const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 40).split(/[#\n.]/)[0];
        const lead = s.slice(Math.max(0, m.index - 30), m.index).split(/[\n.,]/).pop();
        const at = tail.search(/\bmerged\b/i);
        if (at !== -1 && !NEGATION.test(tail.slice(0, at)) && !NEGATION.test(lead)) out.add(m[1]);
    }
    for (const m of s.matchAll(/\bmerged\b([\s:]*(?:PR\s*|pull request\s*)?)#(\d{1,6})\b/gi)) {
        const head = s.slice(Math.max(0, m.index - 20), m.index).split(/[\n.]/).pop();
        if (!NEGATION.test(head)) out.add(m[2]);
    }
    return [...out];
}

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

function textOf(content) {
    if (Array.isArray(content)) return content.map((x) => (x && x.text) || '').join(' ');
    return String(content == null ? '' : content);
}

// One transcript, one forward pass. Returns the counts and findings for it,
// plus the line indexes the selftest needs to derive a negative.
function assessLines(lines, sessionKey, cutoffISO) {
    const pop = { commits: 0, commitsAfterEdit: 0, mergedClaims: 0, gitCommands: 0, toolCalls: 0 };
    const findings = [];
    const controls = { commit: null, claim: null };
    const pending = new Map(); // tool_use id -> { kind, cmd, line, name }
    // dirty: edits inside the session's cwd since the last check. An edit outside
    // it (a commit message in a scratchpad) is not repo work. On the first real
    // run, 284 of 434 findings were that shape.
    let dirty = false;
    let codeEdit = false;
    let cwd = '';
    const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
    let lastCheckLines = [];   // the check calls since the last edit, for the selftest
    const evidence = [];       // { text, line } from tool calls and results
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (!ln) continue;
        let d;
        try { d = JSON.parse(ln); } catch { continue; }
        if (typeof d.timestamp === 'string' && d.timestamp < cutoffISO) continue;
        if (typeof d.cwd === 'string' && d.cwd) cwd = norm(d.cwd);
        const content = d && d.message && d.message.content;
        if (d.isCompactSummary) evidence.push({ text: textOf(content), line: i });
        if (!Array.isArray(content)) continue;
        for (const b of content) {
            if (!b || typeof b !== 'object') continue;
            if (b.type === 'tool_use') {
                pop.toolCalls++;
                const input = b.input || {};
                const cmd = typeof input.command === 'string' ? input.command : '';
                evidence.push({ text: JSON.stringify(input), line: i });
                pending.set(b.id, { name: b.name, cmd, file: String(input.file_path || input.notebook_path || ''), line: i, ts: d.timestamp });
            } else if (b.type === 'tool_result') {
                const u = pending.get(b.tool_use_id);
                evidence.push({ text: textOf(b.content), line: i });
                if (!u) continue;
                pending.delete(b.tool_use_id);
                if (b.is_error) continue; // refused or failed: it did not happen
                if (EDIT_TOOLS.has(u.name)) {
                    const f = norm(u.file);
                    // <repo>/.claude/ is gitignored session state (commit messages,
                    // receipts), not repo work.
                    const inRepo = !cwd || (f.startsWith(cwd) && !f.slice(cwd.length).includes('/.claude/'));
                    if (inRepo) {
                        dirty = true;
                        if (!/\.(md|mdx|txt)$/i.test(u.file)) codeEdit = true;
                        lastCheckLines = [];
                    }
                    continue;
                }
                if (u.name !== 'Bash' || !u.cmd) continue;
                if (/\bgit\b/.test(u.cmd)) pop.gitCommands++;
                const flag = forbiddenFlag(u.cmd);
                if (flag) findings.push({ assertion: 'forbidden-git', session: sessionKey, at: u.ts || d.timestamp, detail: flag });
                if (isCommit(u.cmd)) {
                    pop.commits++;
                    // `npm test && git commit` checks first, in the same call.
                    const before = u.cmd.slice(0, stripQuotes(u.cmd).search(/\bgit\s+(?:-C\s+\S+\s+)?commit\b/));
                    if (dirty && isCheck(before)) { dirty = false; lastCheckLines = [u.line, i]; }
                    if (dirty) {
                        pop.commitsAfterEdit++;
                        findings.push({ assertion: 'commit-without-check', session: sessionKey, at: u.ts || d.timestamp,
                            detail: `git commit after ${codeEdit ? 'a code' : 'a docs-only'} edit, no check in between` });
                    } else if (lastCheckLines.length && !controls.commit) {
                        pop.commitsAfterEdit++;
                        controls.commit = { drop: [...lastCheckLines] };
                    } else if (lastCheckLines.length) {
                        pop.commitsAfterEdit++;
                    }
                    dirty = false;
                    codeEdit = false;
                    lastCheckLines = [];
                } else if (isCheck(u.cmd)) {
                    if (dirty) lastCheckLines.push(u.line, i);
                    dirty = false;
                    codeEdit = false;
                }
            } else if (b.type === 'text' && d.type === 'assistant') {
                for (const n of mergedClaims(b.text)) {
                    pop.mergedClaims++;
                    const re = new RegExp(`(?:#|\\b(?:pr|pull)[\\s/=-]*|--pr\\s+|\\s)${n}\\b`, 'i');
                    const hits = evidence.filter((e) => re.test(' ' + e.text));
                    if (!hits.length) {
                        findings.push({ assertion: 'merged-claim-unverified', session: sessionKey, at: d.timestamp,
                            detail: `#${n} called merged with no earlier probe of it` });
                    } else if (!controls.claim) {
                        controls.claim = { drop: hits.map((e) => e.line) };
                    }
                }
            }
        }
    }
    return { pop, findings, controls };
}

function assess(root, { days = 7, project = '' } = {}) {
    const cutoff = Date.now() - days * 86400_000;
    const cutoffISO = new Date(cutoff).toISOString();
    const all = walk(root);
    const files = all.filter((f) => {
        if (project && !f.toLowerCase().includes(project.toLowerCase())) return false;
        try { return fs.statSync(f).mtimeMs >= cutoff; } catch { return false; }
    });
    const population = { transcriptsSeen: all.length, transcripts: files.length, sessionsWithTools: 0,
        toolCalls: 0, commits: 0, commitsAfterEdit: 0, mergedClaims: 0, gitCommands: 0 };
    const findings = [];
    const controls = [];
    for (const f of files) {
        let raw;
        try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
        const key = path.basename(f, '.jsonl').slice(0, 8);
        const lines = raw.split('\n');
        const r = assessLines(lines, key, cutoffISO);
        if (r.pop.toolCalls) population.sessionsWithTools++;
        for (const k of Object.keys(r.pop)) population[k] += r.pop[k];
        findings.push(...r.findings);
        for (const kind of ['commit', 'claim']) {
            if (r.controls[kind]) controls.push({ kind, file: f, key, lines, drop: r.controls[kind].drop });
        }
    }
    return { population, findings, controls };
}

// Derive a negative from each kind of positive control, write it apart from
// the subject, and require the matching assertion to fire on it.
function selftest(root, opts) {
    const { controls } = assess(root, opts);
    const want = { commit: 'commit-without-check', claim: 'merged-claim-unverified' };
    const out = [];
    let ok = true;
    for (const kind of Object.keys(want)) {
        const c = controls.find((x) => x.kind === kind);
        if (!c) { out.push(`selftest: no ${kind} positive control in the population`); ok = null; continue; }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-transcripts-selftest-'));
        try {
            const drop = new Set(c.drop);
            fs.writeFileSync(path.join(dir, `${c.key}-derived.jsonl`),
                c.lines.filter((_, i) => !drop.has(i)).join('\n'));
            const r = assess(dir, { days: opts.days });
            const fired = r.findings.some((f) => f.assertion === want[kind]);
            out.push(`selftest: ${want[kind]} derived from ${c.key}, ${drop.size} line(s) removed: ${fired ? 'fired' : 'DID NOT FIRE'}`);
            if (!fired && ok !== null) ok = false;
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    return { ok, lines: out };
}

function main() {
    const args = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = args.indexOf(`--${name}`);
        return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
    };
    if (args.includes('--help') || args.includes('-h')) {
        console.log('usage: assert-transcripts.js [--days N] [--root DIR] [--project SUBSTR] [--json] [--strict] [--selftest]');
        return;
    }
    let root = flag('root', null);
    if (!root) {
        try { root = path.join(require('./claude-paths.js').configDir(), 'projects'); }
        catch { root = path.join(os.homedir(), '.claude', 'projects'); }
    }
    const opts = { days: Number(flag('days', 7)) || 7, project: flag('project', '') };

    if (args.includes('--selftest')) {
        const r = selftest(root, opts);
        console.log(r.lines.join('\n'));
        process.exitCode = r.ok === null ? 2 : (r.ok ? 0 : 1);
        return;
    }

    const { population: p, findings } = assess(root, opts);
    if (args.includes('--json')) {
        console.log(JSON.stringify({ root, days: opts.days, population: p, findings }, null, 2));
    } else {
        console.log(`POPULATION: ${p.transcripts} transcript(s) in the last ${opts.days}d (of ${p.transcriptsSeen} under ${root}), `
            + `${p.sessionsWithTools} with tool calls, ${p.toolCalls} tool calls, ${p.commits} commits `
            + `(${p.commitsAfterEdit} after an edit), ${p.mergedClaims} merged claims, ${p.gitCommands} git commands`);
        const by = new Map();
        for (const f of findings) { if (!by.has(f.assertion)) by.set(f.assertion, []); by.get(f.assertion).push(f); }
        for (const name of ['commit-without-check', 'merged-claim-unverified', 'forbidden-git']) {
            const list = by.get(name) || [];
            console.log(`  ${name}: ${list.length}`);
            for (const f of list.slice(0, 5)) console.log(`    ${f.session} ${String(f.at || '').slice(0, 16)} ${f.detail}`);
            if (list.length > 5) console.log(`    ... ${list.length - 5} more (--json for all)`);
        }
    }
    if (!p.transcripts) { console.error('assert-transcripts: no transcripts in the window: nothing was checked'); process.exitCode = 2; return; }
    process.exitCode = args.includes('--strict') && findings.length ? 1 : 0;
}

module.exports = { stripQuotes, isCommit, isCheck, forbiddenFlag, mergedClaims, assessLines, assess, selftest };
if (require.main === module) main();
