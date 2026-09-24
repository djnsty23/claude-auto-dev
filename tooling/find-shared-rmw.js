#!/usr/bin/env node
/**
 * find-shared-rmw.js: finds a read-modify-write of a shared file in hook code.
 *
 * `[measured 2026-09-22]` 20 concurrent Stops left 1 of 220 entries in a shared
 * JSON ledger. Each hook read the whole file, changed its own entry and wrote
 * the whole file back, so the last writer won. Every session runs the same
 * hooks, often at once, so a file the hooks share is written concurrently, and
 * a whole-file rewrite of it loses whatever landed between the read and the write.
 *
 * A finding is a write to a path that the file also reads:
 *   rewrite  writeFileSync(P) after a read of P
 *   replace  renameSync(tmp, P) or copyFileSync(src, P) after a read of P
 *   consume  unlinkSync(P) after a read of P, which deletes what arrived since
 *
 * A read is readFileSync(P) or a call to a local helper that reads its own first
 * parameter, and a write is the same for the write calls, so
 * `const s = readState(p); ...; writeState(p, s)` pairs. P is compared after
 * resolving plain identifiers through their declarations and assignments in
 * scope, so `const p = ledgerPath()` matches `readJson(ledgerPath())`.
 *
 * Within one function the read must come first. Across functions the path must
 * be FIXED: built only from module-level names and globals, like `ledgerPath()`.
 * That is the 8.171.0 context-depth-nudge shape, where the top level read the
 * shared ledger and a writeLedger() function wrote it back.
 *
 * ACCEPTED lists the findings a reader has judged safe, each with its reason.
 * An entry that no longer matches a finding fails the run, so the list cannot
 * outlive the code it excuses.
 *
 * A path built from a session, process or key identifier (sid, sessionId,
 * process.pid, key, id) belongs to one writer and is never a finding. Nor is an
 * append: one small append is atomic on a local filesystem.
 *
 * Scope: every hook, and every local module a hook requires, transitively.
 * Those run in every session. A CLI script runs when someone runs it, and
 * `--all` scans those too, for an audit.
 *
 * Textual, not a parser: it can miss a path built in another function. The
 * suite that runs it plants the shapes it must catch.
 *
 * Usage: node tooling/find-shared-rmw.js [--json] [--all] [file ...]
 *   Prints what it scanned, then one line per finding. Exit 1 with findings, 0 without.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAX_HOPS = 6;
const GLOBALS = new Set(['process', 'path', 'fs', 'os', '__dirname', '__filename', 'require', 'JSON', 'Date', 'String', 'Number', 'Math']);

/**
 * Findings judged safe. Matched on file, kind and the resolved path text, never
 * on a line number, so an edit elsewhere in the file does not stale an entry.
 */
const ACCEPTED = [
    { file: 'plugins/autodev-core/hooks/agent-browser-cleanup.js', kind: 'rewrite', path: 'prefsPath',
        why: 'Chrome Preferences of an agent-browser profile. Every run of this hook sets the same two keys to false, so a lost update rewrites the same values. The only other writer is Chrome.' },
    { file: 'plugins/autodev-core/hooks/peer-send-ledger.js', kind: 'replace', path: 'file',
        why: 'The prune holds an exclusive lock against other prunes and copies every byte appended after its read before the rename. What remains is an append between its last stat and the rename, only when the ledger passes PRUNE_BYTES.' },
    { file: 'plugins/autodev-core/hooks/session-register.js', kind: 'consume', path: 'path.join(DIR, name)',
        why: 'One record per session, named by the session id (read from the directory, so the key is not visible here). Deleted only when its own session has not written it for RETAIN_DAYS.' },
    { file: 'plugins/autodev-core/hooks/stop-auto-check.js', kind: 'rewrite', path: 'notesLedger',
        why: 'auto-flag.js pathsFor() names it stop-notes.<sid>: one file per session, with one writer.' },
    { file: 'plugins/autodev-core/scripts/check-queue-drained.js', kind: 'rewrite', path: 'stateFile',
        why: 'The caller keys it by a hash of the transcript path, so one session owns each file. Losing it costs one full reprint.' },
    { file: 'plugins/autodev-core/scripts/fleet-intent.js', kind: 'rewrite', path: "recordPath('r', 'claude/x', tmp)",
        why: 'The --selftest writes a temp dir it created.' },
];
const PRIVATE_TOKEN = /(sid|sessionid|session_id|pid|uuid|runid|agentid)$|^(sid|key|id|sessionid|session_id)/i;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'function']);

/** The source with comments blanked, newlines and string bodies preserved. */
function stripComments(src) {
    let out = '';
    let i = 0;
    let quote = null;
    while (i < src.length) {
        const c = src[i];
        const d = src[i + 1];
        if (quote) {
            out += c;
            if (c === '\\') { out += d === undefined ? '' : d; i += 2; continue; }
            if (c === quote) quote = null;
            i++;
            continue;
        }
        if (c === '/' && d === '/') {
            while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
            continue;
        }
        if (c === '/' && d === '*') {
            out += '  ';
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
            out += '  ';
            i += 2;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') quote = c;
        out += c;
        i++;
    }
    return out;
}

/** Index of the bracket matching the opener at `open`, skipping strings. */
function matchAt(text, open) {
    let depth = 0;
    let quote = null;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
    }
    return text.length;
}

/** The top-level arguments of the call whose open paren is at `open`. */
function argsAt(text, open) {
    const close = matchAt(text, open);
    const inner = text.slice(open + 1, close);
    const args = [];
    let depth = 0;
    let start = 0;
    let quote = null;
    for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) { args.push(inner.slice(start, i).trim()); start = i + 1; }
    }
    const last = inner.slice(start).trim();
    if (last || args.length) args.push(last);
    return args;
}

/**
 * Every function body as { name, params, start, end }. A body is a `{` that
 * follows a parameter list which is not an if/for/while/switch/catch head.
 */
function functionSpans(text) {
    const spans = [];
    const re = /\{/g;
    let m;
    while ((m = re.exec(text))) {
        let j = m.index - 1;
        while (j >= 0 && /\s/.test(text[j])) j--;
        let arrow = false;
        if (text[j] === '>' && text[j - 1] === '=') { arrow = true; j -= 2; while (j >= 0 && /\s/.test(text[j])) j--; }
        let params = [];
        let head = '';
        if (text[j] === ')') {
            let depth = 0;
            let k = j;
            for (; k >= 0; k--) {
                if (text[k] === ')') depth++;
                else if (text[k] === '(') { depth--; if (depth === 0) break; }
            }
            params = text.slice(k + 1, j).split(',').map((s) => s.trim().replace(/=.*$/, '').trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
            let h = k - 1;
            while (h >= 0 && /\s/.test(text[h])) h--;
            const word = /([A-Za-z_$][\w$]*)$/.exec(text.slice(Math.max(0, h - 60), h + 1));
            head = word ? word[1] : '';
            if (!arrow && KEYWORDS.has(head) && head !== 'function') continue;
            if (!arrow && !head) continue;
            if (head === 'function' || arrow || !KEYWORDS.has(head)) {
                let name = head === 'function' ? '' : head;
                if (arrow || head === 'function' || head === 'async') {
                    const before = text.slice(Math.max(0, k - 120), k);
                    const n = /(?:function\s+([A-Za-z_$][\w$]*)\s*$)|(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?$)/.exec(before);
                    name = n ? (n[1] || n[2]) : '';
                }
                spans.push({ name, params, start: m.index, end: matchAt(text, m.index) });
            }
        } else if (arrow && /[A-Za-z_$]/.test(text[j])) {
            const w = /([A-Za-z_$][\w$]*)$/.exec(text.slice(Math.max(0, j - 60), j + 1));
            const before = text.slice(Math.max(0, j - 60 - 120), j + 1 - (w ? w[1].length : 0));
            const n = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?$/.exec(before);
            spans.push({ name: n ? n[1] : '', params: w ? [w[1]] : [], start: m.index, end: matchAt(text, m.index) });
        }
    }
    return spans;
}

const innermost = (spans, at) => spans.filter((s) => s.start < at && at < s.end).sort((a, b) => (b.start - a.start))[0] || null;
const norm = (s) => String(s || '').replace(/\s+/g, '');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/** The expression text after `at` up to the end of its statement. */
function exprFrom(text, at) {
    let depth = 0;
    let quote = null;
    let end = at;
    for (; end < text.length; end++) {
        const c = text[end];
        if (quote) { if (c === '\\') { end++; continue; } if (c === quote) quote = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
        else if ((c === ';' || c === '\n' || c === ',') && depth === 0) break;
    }
    return text.slice(at, end).trim();
}

/**
 * Every expression a path may hold: itself, then each declaration or assignment
 * of an identifier it names, followed through MAX_HOPS levels. Only bindings
 * above `at` count, from the enclosing function or the module top level.
 */
function resolve(text, spans, expr, at) {
    const out = [expr];
    const seen = new Set();
    let frontier = [expr];
    for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
        const next = [];
        for (const e of frontier) {
            if (!/^[A-Za-z_$][\w$]*$/.test(e) || seen.has(e)) continue;
            seen.add(e);
            const re = new RegExp(`(?:\\b(?:const|let|var)\\s+|(?<![\\w$.]))${e.replace(/\$/g, '\\$')}\\s*=(?![=>])\\s*`, 'g');
            let m;
            while ((m = re.exec(text))) {
                if (m.index >= at) break;
                const owner = innermost(spans, m.index);
                const here = innermost(spans, at);
                if (owner && owner !== here && !(here && owner.start < here.start && here.end < owner.end)) continue;
                const v = exprFrom(text, m.index + m[0].length);
                if (v && v !== 'null' && v !== 'undefined') { out.push(v); next.push(v); }
            }
        }
        frontier = next;
    }
    return out;
}

/** True when any identifier in the expressions names a session, process or key. */
function isPrivate(chain) {
    for (const e of chain) {
        const idents = e.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ').match(/[A-Za-z_$][\w$]*/g) || [];
        if (idents.some((w) => PRIVATE_TOKEN.test(w))) return true;
    }
    return false;
}

/** True when every name the expression uses is a global or a module-level binding. */
function isFixed(text, spans, expr) {
    const bare = expr.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ');
    const re = /(?<![\w$.])[A-Za-z_$][\w$]*/g;
    let m;
    while ((m = re.exec(bare))) {
        const name = m[0];
        if (GLOBALS.has(name)) continue;
        const decl = new RegExp(`\\b(?:const|let|var|function)\\s+${name.replace(/\$/g, '\\$')}\\b`, 'g');
        let d;
        let top = false;
        while ((d = decl.exec(text))) if (!innermost(spans, d.index)) { top = true; break; }
        if (!top) return false;
    }
    return true;
}

const DIRECT = /\b(?:fs\.)?(readFileSync|writeFileSync|renameSync|copyFileSync|unlinkSync)\s*\(/g;
const KIND = { writeFileSync: 'rewrite', renameSync: 'replace', copyFileSync: 'replace', unlinkSync: 'consume' };

function directCalls(text) {
    const calls = [];
    let m;
    DIRECT.lastIndex = 0;
    while ((m = DIRECT.exec(text))) {
        const args = argsAt(text, m.index + m[0].length - 1);
        const name = m[1];
        const target = name === 'renameSync' || name === 'copyFileSync' ? args[1] : args[0];
        if (!target || target === '0') continue;
        calls.push({ at: m.index, arg: target, op: name === 'readFileSync' ? 'read' : KIND[name], via: name });
    }
    return calls;
}

/** Every `if` and `else` block as { start, end }. */
function branchBlocks(text) {
    const out = [];
    const re = /\{/g;
    let m;
    while ((m = re.exec(text))) {
        let j = m.index - 1;
        while (j >= 0 && /\s/.test(text[j])) j--;
        let head = '';
        if (text[j] === ')') {
            let depth = 0;
            let k = j;
            for (; k >= 0; k--) {
                if (text[k] === ')') depth++;
                else if (text[k] === '(') { depth--; if (depth === 0) break; }
            }
            const w = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(Math.max(0, k - 20), k));
            head = w ? w[1] : '';
        } else if (/\belse$/.test(text.slice(Math.max(0, j - 4), j + 1))) head = 'else';
        if (head === 'if' || head === 'else') out.push({ start: m.index, end: matchAt(text, m.index) });
    }
    return out;
}

function scanText(src, file) {
    const text = stripComments(src);
    const spans = functionSpans(text);
    const branches = branchBlocks(text);
    const direct = directCalls(text);

    // Helpers: named functions that read or write their own first parameter, and
    // named functions that read or write a FIXED path. A call to either is that
    // read or write, at the call site, so `const l = readJson(ledgerPath())` at
    // the top level pairs with a later `writeLedger(l)` whose body writes
    // ledgerPath().
    const helpers = new Map();
    for (const s of spans) {
        if (!s.name) continue;
        const ops = [];
        const p0 = s.params[0];
        for (const c of direct) {
            if (innermost(spans, c.at) !== s) continue;
            const chain = resolve(text, spans, c.arg, c.at);
            if (p0 && chain.some((e) => norm(e) === p0 || norm(e).startsWith(p0 + '+'))) { ops.push({ op: c.op, fixed: null }); continue; }
            const fixed = chain.find((e) => isFixed(text, spans, e));
            if (fixed && !isPrivate(chain)) ops.push({ op: c.op, fixed });
        }
        if (ops.length) helpers.set(s.name, ops);
    }

    const calls = direct.slice();
    for (const [name, ops] of helpers) {
        const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(text))) {
            if (/function\s*$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
            const first = argsAt(text, m.index + m[0].length - 1)[0];
            for (const { op, fixed } of ops) {
                const arg = fixed || first;
                if (arg) calls.push({ at: m.index, arg, op, via: name, helper: true });
            }
        }
    }
    calls.sort((a, b) => a.at - b.at);

    // A read cannot reach a write when a branch holding the read, and not the
    // write, always leaves (its last statement exits, returns or throws), or
    // when the write sits in that branch's else. fleet-brief.js reads in its
    // --show branch, which exits, and writes in --set.
    const exitsAtEnd = (b) => /(?:process\.exit\s*\([^()]*\)|\breturn\b[^;{}]*|\bthrow\b[^;{}]*)\s*;?\s*$/.test(text.slice(b.start + 1, b.end).trim());
    const elseOf = (b, w) => {
        const after = /^\s*else\b/.exec(text.slice(b.end + 1, b.end + 40));
        if (!after) return false;
        const next = branches.find((x) => x.start > b.end && x.start <= b.end + 1 + after[0].length + 200);
        return !!next && next.start < w.at && w.at < next.end;
    };
    const reaches = (r, w) => branches.every((b) => {
        if (!(b.start < r.at && r.at < b.end) || (b.start < w.at && w.at < b.end)) return true;
        return !exitsAtEnd(b) && !elseOf(b, w);
    });

    const findings = [];
    const reported = new Set();
    for (const w of calls) {
        if (w.op === 'read') continue;
        const fn = innermost(spans, w.at);
        const wChain = resolve(text, spans, w.arg, w.at);
        if (isPrivate(wChain)) continue;
        const wKeys = new Set(wChain.map(norm));
        const read = calls.find((r) => r.op === 'read' && r.at < w.at && innermost(spans, r.at) === fn && reaches(r, w)
            && resolve(text, spans, r.arg, r.at).some((e) => wKeys.has(norm(e))));
        if (!read) continue;
        const line = lineOf(text, w.at);
        const id = `${line}|${w.op}`;
        if (reported.has(id)) continue;
        reported.add(id);
        findings.push({
            file, line, kind: w.op, readLine: lineOf(text, read.at), fn: fn ? fn.name || '(anonymous)' : '(top level)',
            path: wChain[wChain.length - 1].replace(/\s+/g, ' ').slice(0, 100), via: `${read.via} -> ${w.via}`,
        });
    }
    return findings;
}

/** Hooks, and the local modules they require, transitively. */
function hookClosure() {
    const out = new Set();
    const queue = [];
    const plugins = path.join(ROOT, 'plugins');
    for (const p of fs.readdirSync(plugins)) {
        const dir = path.join(plugins, p, 'hooks');
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names) if (n.endsWith('.js')) queue.push(path.join(dir, n));
    }
    while (queue.length) {
        const f = queue.shift();
        if (out.has(f) || !fs.existsSync(f)) continue;
        out.add(f);
        const src = fs.readFileSync(f, 'utf8');
        const pluginDir = f.slice(0, f.lastIndexOf(path.sep + (f.includes(path.sep + 'hooks' + path.sep) ? 'hooks' : 'scripts') + path.sep));
        const re = /require\(\s*(?:path\.join\(\s*(__dirname|PLUGIN_ROOT)\s*,\s*((?:'[^']*'\s*,?\s*)+)\)|'(\.{1,2}\/[^']+)')\s*\)/g;
        let m;
        while ((m = re.exec(src))) {
            let target;
            if (m[3]) target = path.resolve(path.dirname(f), m[3]);
            else {
                const parts = m[2].match(/'[^']*'/g).map((s) => s.slice(1, -1));
                target = path.resolve(m[1] === '__dirname' ? path.dirname(f) : pluginDir, ...parts);
            }
            if (!target.endsWith('.js')) target += '.js';
            queue.push(target);
        }
    }
    return [...out].sort();
}

function allPluginFiles() {
    const out = [];
    const plugins = path.join(ROOT, 'plugins');
    for (const p of fs.readdirSync(plugins)) {
        for (const sub of ['hooks', 'scripts']) {
            const dir = path.join(plugins, p, sub);
            let names = [];
            try { names = fs.readdirSync(dir); } catch { continue; }
            for (const n of names) if (n.endsWith('.js')) out.push(path.join(dir, n));
        }
    }
    return out.sort();
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function scanFiles(files) {
    const findings = [];
    for (const f of files) findings.push(...scanText(fs.readFileSync(f, 'utf8'), rel(f)));
    return findings;
}

/**
 * Splits findings into open and accepted, and names every ACCEPTED entry that
 * matched nothing. `scannedFiles` limits the stale check to entries whose file
 * was scanned, so a run over named files does not call the rest stale.
 */
function judge(findings, scannedFiles, accepted = ACCEPTED) {
    const matches = (a, f) => a.file === f.file && a.kind === f.kind && a.path === f.path;
    const open = findings.filter((f) => !accepted.some((a) => matches(a, f)));
    const kept = findings.filter((f) => accepted.some((a) => matches(a, f)));
    const scanned = new Set(scannedFiles);
    const stale = accepted.filter((a) => scanned.has(a.file) && !findings.some((f) => matches(a, f)));
    return { open, accepted: kept, stale };
}

module.exports = { scanText, scanFiles, hookClosure, allPluginFiles, functionSpans, stripComments, isPrivate, isFixed, judge, ACCEPTED };

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('find-shared-rmw.js [--json] [--all] [file ...]: finds a read-modify-write of a shared file. Default scope: hooks and the modules they require. --all adds every plugin script. Exit 1 on an open finding or a stale ACCEPTED entry.');
    } else {
        const named = argv.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
        const files = named.length ? named : argv.includes('--all') ? allPluginFiles() : hookClosure();
        const findings = scanFiles(files);
        const v = judge(findings, files.map(rel));
        if (argv.includes('--json')) {
            process.stdout.write(JSON.stringify({ scanned: files.map(rel), ...v }, null, 2) + '\n');
        } else {
            console.log(`scanned ${files.length} file(s): ${findings.length} finding(s), ${v.accepted.length} accepted, ${v.open.length} open, ${v.stale.length} stale accepted entr${v.stale.length === 1 ? 'y' : 'ies'}`);
            for (const f of v.open) console.log(`OPEN   ${f.file}:${f.line}  ${f.kind} of ${f.path}  in ${f.fn} (read at :${f.readLine}, ${f.via})`);
            for (const a of v.stale) console.log(`STALE  ${a.file}  ${a.kind} of ${a.path}: no longer found, remove it from ACCEPTED`);
        }
        process.exitCode = v.open.length || v.stale.length ? 1 : 0;
    }
}
