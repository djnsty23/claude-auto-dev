#!/usr/bin/env node
'use strict';
/**
 * memory-export.js: print every stored Claude Code memory as one export, in five
 * categories, oldest first, ready to paste into another assistant.
 *
 * Shape (the export format of claude.ai's "export all stored memories"):
 *
 *     ```
 *     ## Instructions
 *     [2026-08-25] - never use em dashes
 *     ## Identity
 *     ...
 *     ## Career
 *     ## Projects
 *     ## Preferences
 *     ```
 *     Export: complete, 41 entries from 30 memory files.
 *
 * WHERE IT READS. Every `*.md` under `<config>/memory/` and `<config>/projects/<p>/memory/`,
 * where `<config>` is CLAUDE_CONFIG_DIR or `~/.claude`. `MEMORY*.md` files are indexes:
 * they are not exported, but their `- [Title](file.md) — hook` lines supply a date
 * when the file itself carries none. `--root <dir>` (repeatable) replaces the defaults.
 *
 * HOW A FILE IS CLASSIFIED. By its frontmatter `type` (top level or under `metadata:`):
 *   feedback            -> Instructions, one entry from its description
 *   user                -> Career when it names a role, company or employer, else Identity
 *   project             -> Projects, one entry, "<name>: <description>"
 *   reference, other    -> Preferences only when it states a taste or working style, else skipped
 * Any non-feedback file also contributes its body lines that read as a rule (an `always` or
 * `never` line, or a `[stated YYYY-MM-DD]` line with an instruction verb) to Instructions.
 *
 * DATES. The earliest `[stated|measured|inferred YYYY-MM-DD]` tag in the file, else the
 * earliest MM-DD in the file's index hook (year taken from the index file's mtime, one year
 * back if that lands in the future), else the frontmatter `modified`/`created` date, else
 * `[unknown]`. Undated entries sort last.
 *
 * PII. By default an entry whose text holds an email address, a phone number, an IBAN or a
 * company registration id (CUI, J40/123/2020) is withheld, and the closing line says the
 * export is partial and how many were withheld. `--with-pii` keeps them.
 *
 * Usage: node memory-export.js [--root <dir>]... [--format md|json] [--with-pii] [--counts]
 * Exit 0 on an export (empty included), 2 on bad arguments or no readable root.
 */
const fs = require('fs');
const path = require('path');
const { configDir } = require('./config-dir');

const CATEGORIES = ['Instructions', 'Identity', 'Career', 'Projects', 'Preferences'];
const MAX_TEXT = 300;

const USAGE = `Usage: node memory-export.js [--root <dir>]... [--format md|json] [--with-pii] [--counts]
  --root <dir>   memory directory to read; repeatable; replaces the defaults
                 (<config>/memory and <config>/projects/*/memory)
  --format       md (default): one code block plus a complete/partial line; json: structured
  --with-pii     keep entries holding emails, phone numbers, IBANs or registration ids
  --counts       print only the entry count per category and the complete/partial line`;

function parseArgs(argv) {
    const opts = { roots: [], format: 'md', withPii: false, counts: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') opts.help = true;
        else if (a === '--with-pii') opts.withPii = true;
        else if (a === '--counts') opts.counts = true;
        else if (a === '--root' || a === '--format') {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
            if (a === '--root') opts.roots.push(path.resolve(v));
            else if (v === 'md' || v === 'json') opts.format = v;
            else throw new Error(`--format must be md or json, got ${v}`);
        } else throw new Error(`unknown argument ${a}`);
    }
    return opts;
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function defaultRoots() {
    const cfg = configDir();
    const roots = [path.join(cfg, 'memory')];
    const projects = path.join(cfg, 'projects');
    let names = [];
    try { names = fs.readdirSync(projects); } catch { /* no projects dir: global memory only */ }
    for (const n of names.sort()) roots.push(path.join(projects, n, 'memory'));
    return roots.filter(isDir);
}

function listMarkdown(dir, depth = 0) {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3 && !e.name.startsWith('.')) out.push(...listMarkdown(p, depth + 1));
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
    }
    return out;
}

const isIndex = (file) => /^MEMORY.*\.md$/i.test(path.basename(file));

/** Minimal frontmatter reader: top-level and one-level-nested `key: value` pairs. */
function parseFrontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!m) return { fm: {}, body: text };
    const fm = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!kv) continue;
        let v = kv[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        const key = kv[1];
        // First occurrence wins, so a top-level key beats a nested one written after it.
        if (v && fm[key] === undefined) fm[key] = v;
    }
    return { fm, body: text.slice(m[0].length) };
}

const TAG_RE = /\[(?:stated|measured|inferred)\s+(\d{4}-\d{2}-\d{2})/g;
function tagDates(text) {
    const out = [];
    for (const m of text.matchAll(TAG_RE)) if (validDate(m[1])) out.push(m[1]);
    return out.sort();
}
function validDate(s) {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const earliest = (dates) => dates.filter(Boolean).sort()[0] || null;
// win32 paths compare case-insensitively.
const hookKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * Resolved file path -> earliest YYYY-MM-DD from an MM-DD in its index hook. Keyed by the
 * link resolved against the index's own folder, so two projects' same-named memory files
 * never share a date.
 */
function readIndexHooks(indexFiles) {
    const hooks = new Map();
    for (const file of indexFiles) {
        let text;
        let mtime;
        try { text = fs.readFileSync(file, 'utf8'); mtime = fs.statSync(file).mtime; } catch { continue; }
        for (const line of text.split(/\r?\n/)) {
            const link = /\]\(([^)]+\.md)\)(.*)$/.exec(line);
            if (!link) continue;
            const target = hookKey(path.resolve(path.dirname(file), link[1]));
            const dates = [];
            for (const m of link[2].matchAll(/(?<![\d-])(\d{2})-(\d{2})(?![\d-])/g)) {
                let year = mtime.getUTCFullYear();
                let iso = `${year}-${m[1]}-${m[2]}`;
                if (!validDate(iso)) continue;
                if (new Date(`${iso}T00:00:00Z`) > mtime) { year -= 1; iso = `${year}-${m[1]}-${m[2]}`; }
                if (validDate(iso)) dates.push(iso);
            }
            const d = earliest(dates);
            if (d) hooks.set(target, earliest([hooks.get(target), d]));
        }
    }
    return hooks;
}

const PII = [
    { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
    { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/ },
    { kind: 'registration', re: /\bJ\d{1,2}\/\d+\/\d{4}\b|\bCUI\b\W{0,3}(?:RO)?\s?\d{2,10}\b|\bRO\d{6,10}\b/i },
];
function hasPhone(text) {
    for (const m of text.matchAll(/\+?\d[\d\s().-]{7,}\d/g)) {
        const s = m[0];
        const digits = s.replace(/\D/g, '');
        if (digits.length < 9 || digits.length > 15) continue;
        if (/^\d{4}-\d{2}-\d{2}/.test(s.trim())) continue; // a date, possibly followed by more numbers
        if (/^[\d,.]+$/.test(s) && !s.startsWith('0')) continue; // a plain quantity like 1,234,567,890
        return true;
    }
    return false;
}
function piiKind(text) {
    for (const p of PII) if (p.re.test(text)) return p.kind;
    return hasPhone(text) ? 'phone' : null;
}

function clean(text) {
    let t = String(text || '')
        .replace(/\*\*/g, '')
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (t.length > MAX_TEXT) t = `${t.slice(0, MAX_TEXT - 3).trimEnd()}...`;
    return t;
}

const CAREER_RE = /\b(role|company|works? at|working at|employer|employed|job|career|founder|co-?founder|agency|freelanc\w*|consultant|client work|position|title)\b/i;
const PREFERENCE_RE = /\b(prefer\w*|likes?|dislikes?|wants?|style|tone|voice|taste|habit|working style|by default|always|never|favou?rite)\b/i;
const RULE_START_RE = /^(always|never)\b/i;
const INSTRUCTION_RE = /\b(always|never|must|do not|don't|only|instead of)\b/i;

function firstBodyLine(body) {
    for (const raw of body.split(/\r?\n/)) {
        const l = raw.trim();
        if (!l || l.startsWith('#') || l.startsWith('```') || l === '---') continue;
        return l;
    }
    return '';
}

/** Body lines of a non-feedback file that read as a standing rule. */
function ruleLines(body) {
    const out = [];
    let inFence = false;
    for (const raw of body.split(/\r?\n/)) {
        if (raw.trim().startsWith('```')) { inFence = !inFence; continue; }
        if (inFence) continue;
        const l = clean(raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
        if (!l || l.startsWith('#') || l.startsWith('|')) continue;
        const stated = /\[stated\s+\d{4}-\d{2}-\d{2}/.test(l);
        const bare = l.replace(/^`?\[[^\]]*\]`?\s*/, '');
        if (RULE_START_RE.test(bare)) out.push(l);
        else if (stated && INSTRUCTION_RE.test(l)) out.push(l);
    }
    return out;
}

function classify(file, text, hooks) {
    const { fm, body } = parseFrontmatter(text);
    const type = String(fm.type || '').toLowerCase();
    const name = fm.name || path.basename(file, '.md');
    const description = fm.description || firstBodyLine(body);
    const fmDate = /^(\d{4}-\d{2}-\d{2})/.exec(fm.modified || fm.created || fm.date || '');
    const fileDate = earliest(tagDates(text)) || hooks.get(hookKey(file))
        || (fmDate && validDate(fmDate[1]) ? fmDate[1] : null);
    const entries = [];
    const source = path.basename(file);
    let skipped = false;
    if (type === 'feedback') {
        entries.push({ category: 'Instructions', date: fileDate, text: clean(description), source });
    } else if (type === 'user') {
        const cat = CAREER_RE.test(`${description}\n${body}`) ? 'Career' : 'Identity';
        entries.push({ category: cat, date: fileDate, text: clean(description), source });
    } else if (type === 'project') {
        entries.push({ category: 'Projects', date: fileDate, text: clean(`${name}: ${description}`), source });
    } else if (PREFERENCE_RE.test(description)) {
        entries.push({ category: 'Preferences', date: fileDate, text: clean(description), source });
    } else {
        skipped = true;
    }
    if (type !== 'feedback') {
        for (const l of ruleLines(body)) {
            entries.push({ category: 'Instructions', date: earliest(tagDates(l)) || fileDate, text: l, source });
        }
    }
    return { entries: entries.filter((e) => e.text), skipped: skipped && entries.length === 0 };
}

function buildExport(roots, { withPii }) {
    const files = [];
    for (const r of roots) files.push(...listMarkdown(r));
    const hooks = readIndexHooks(files.filter(isIndex));
    const memoryFiles = files.filter((f) => !isIndex(f));
    const stats = { files: memoryFiles.length, unreadable: 0, skipped: 0, withheld: {}, duplicates: 0 };
    const seen = new Set();
    const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
    for (const file of memoryFiles) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { stats.unreadable++; continue; }
        const { entries, skipped } = classify(file, text, hooks);
        if (skipped) stats.skipped++;
        for (const e of entries) {
            const kind = withPii ? null : piiKind(e.text);
            if (kind) { stats.withheld[kind] = (stats.withheld[kind] || 0) + 1; continue; }
            const key = `${e.category}\u0000${e.text.toLowerCase()}`;
            if (seen.has(key)) { stats.duplicates++; continue; }
            seen.add(key);
            byCat[e.category].push(e);
        }
    }
    for (const c of CATEGORIES) {
        byCat[c].sort((a, b) => {
            if (a.date !== b.date) {
                if (!a.date) return 1;
                if (!b.date) return -1;
                return a.date < b.date ? -1 : 1;
            }
            return a.text.localeCompare(b.text);
        });
    }
    const withheld = Object.values(stats.withheld).reduce((n, v) => n + v, 0);
    const total = CATEGORIES.reduce((n, c) => n + byCat[c].length, 0);
    const complete = withheld === 0 && stats.unreadable === 0;
    return { byCat, stats, withheld, total, complete };
}

function statusLine(x) {
    const extra = [];
    if (x.withheld) {
        const kinds = Object.entries(x.stats.withheld).map(([k, v]) => `${v} ${k}`).join(', ');
        extra.push(`${x.withheld} withheld for PII (${kinds}); rerun with --with-pii to include them`);
    }
    if (x.stats.unreadable) extra.push(`${x.stats.unreadable} files unreadable`);
    const head = `${x.complete ? 'complete' : 'partial'}, ${x.total} entries from ${x.stats.files} memory files`;
    const skipped = x.stats.skipped ? ` ${x.stats.skipped} reference or untyped files stated no preference and were left out by design.` : '';
    return `Export: ${head}${extra.length ? `: ${extra.join('; ')}` : ''}.${skipped}`;
}

function renderMd(x) {
    const lines = ['```'];
    for (const c of CATEGORIES) {
        lines.push(`## ${c}`);
        if (!x.byCat[c].length) lines.push('(none)');
        for (const e of x.byCat[c]) lines.push(`[${e.date || 'unknown'}] - ${e.text}`);
        lines.push('');
    }
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push('```', statusLine(x));
    return `${lines.join('\n')}\n`;
}

function renderJson(x) {
    return `${JSON.stringify({
        categories: Object.fromEntries(CATEGORIES.map((c) => [c, x.byCat[c].map((e) => ({ date: e.date, text: e.text, source: e.source }))])),
        complete: x.complete,
        entries: x.total,
        files: x.stats.files,
        withheld: x.stats.withheld,
        unreadable: x.stats.unreadable,
        skipped: x.stats.skipped,
        status: statusLine(x),
    }, null, 2)}\n`;
}

function renderCounts(x) {
    return `${CATEGORIES.map((c) => `${c}: ${x.byCat[c].length}`).join('\n')}\n${statusLine(x)}\n`;
}

function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
        process.stderr.write(`memory-export: ${e.message}\n${USAGE}\n`);
        process.exitCode = 2;
        return;
    }
    if (opts.help) { process.stdout.write(`${USAGE}\n`); return; }
    const roots = opts.roots.length ? opts.roots : defaultRoots();
    const readable = roots.filter(isDir);
    if (!readable.length) {
        process.stderr.write(`memory-export: COULD NOT READ any memory root (${roots.length} given)\n`);
        process.exitCode = 2;
        return;
    }
    const x = buildExport(readable, opts);
    if (readable.length < roots.length) {
        x.stats.unreadable += roots.length - readable.length;
        x.complete = false;
    }
    const out = opts.counts ? renderCounts(x) : opts.format === 'json' ? renderJson(x) : renderMd(x);
    process.stdout.write(out);
}

if (require.main === module) main();

module.exports = { parseArgs, parseFrontmatter, tagDates, piiKind, ruleLines, classify, buildExport, renderMd, CATEGORIES };
