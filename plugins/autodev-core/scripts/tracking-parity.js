#!/usr/bin/env node
'use strict';
/**
 * tracking-parity.js - is every action tracked, and tracked exactly once?
 *
 * Analytics is the one surface no other gate reads. A redesign can drop a
 * tracking attribute, or wire a button so it fires its event twice, and every
 * typecheck, test and layout check stays green. Two subcommands, one per half:
 *
 *   static   reads SOURCE. Walks the public page files and everything they
 *            import, and flags every clickable JSX element that carries no
 *            action attribute (default data-cta), and every <form> without a
 *            form attribute (default data-form).
 *   judge    reads a HARVEST taken from a rendered page by the probe this
 *            script prints (--print-probe). Each element carrying the action
 *            attribute was clicked once; judge classifies what it pushed.
 *
 * ------------------------------------------------------------------ THE SPLIT
 *
 * Same shape as rendered-layout-gate.js and layout-probe.js: the plugin ships
 * the measurement, the calling session supplies the browser. The probe is a
 * function the caller evaluates in the page (the in-app Browser pane's
 * javascript_tool, chrome-devtools evaluate_script, Playwright page.evaluate),
 * so no browser is a dependency of this plugin.
 *
 * ------------------------------------------------------------------ EXIT CODES
 *
 *   0  everything checked is ok, and something WAS checked
 *   1  a finding: an untracked clickable or form, an untracked or double-firing
 *      element, or an event the baseline fired that the candidate never fires
 *   2  INDETERMINATE: no roots found, a config or harvest missing, empty or
 *      unparseable, or an element the probe could not click. Never a pass.
 *
 * ------------------------------------------------------------------ LIMITS
 *
 * The static reader is a scanner, not a parser. It strips comments, reads JSX
 * opening tags by balanced braces and quotes, and treats a `<` straight after
 * an identifier, `.`, `)` or `]` as a type argument rather than a tag. JSX text
 * containing a quote inside an attribute expression can confuse it. Every run
 * prints the population it read so a scan that saw too little is visible.
 * An element whose props come only from a spread is flagged: the attribute is
 * checked where the value is written, which is why primitive directories that
 * spread their props are skipped.
 */

const fs = require('fs');
const path = require('path');

const NONE = 'none';
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const CLICKABLE_TAGS = new Set(['button', 'a', 'Link', 'Button']);
const CLICKABLE_SUFFIX = /(?:Trigger|Close|Button)$/;
const SOURCE_EXT = ['.tsx', '.jsx', '.ts', '.js', '.mjs'];
const ALWAYS_IGNORED = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.vercel', '.turbo', 'coverage']);

const DEFAULT_CONFIG = {
    roots: ['app/**/page.{tsx,jsx,js}', 'src/app/**/page.{tsx,jsx,js}'],
    layout: null,
    private: [],
    aliases: { '@/': '' },
    skip: ['components/ui'],
    actionAttribute: 'data-cta',
    formAttribute: 'data-form',
};

// ------------------------------------------------------------------ usage

const USAGE = `tracking-parity.js - prove every action is tracked, and tracked exactly once.

Usage:
  node tracking-parity.js static <project-root> [--config <file.json>] [--json]
  node tracking-parity.js judge <harvest.json> [--json]
  node tracking-parity.js judge --baseline <before.json> --candidate <after.json> [--json]
  node tracking-parity.js judge --print-probe [--settle-ms 400] [--attribute data-cta]
  node tracking-parity.js <subcommand> --help

Exit: 0 all ok, 1 a finding, 2 INDETERMINATE (nothing checked, or unreadable input).`;

const USAGE_STATIC = `Usage: node tracking-parity.js static <project-root> [--config <file.json>] [--json]

Walks the public page files (roots) and every relative or alias import they
reach, and reads each JSX opening tag. Clickables are button, a, Link, Button,
any component whose name ends in Trigger, Close or Button, and any element with
onClick. Each must carry the action attribute with a snake_case literal, an
expression, or "none" for an element that is deliberately not an action. Each
<form> must carry the form attribute with a snake_case literal or an expression.

Config (JSON, every key optional):
  roots            globs for public page files   default app/**/page.{tsx,jsx,js}, src/app/...
  layout           the root layout, also a root   default app/layout.* or src/app/layout.* if present
  private          globs removed from roots and never walked into
  aliases          { "@/": "src/" }  import prefix -> directory under the root
  skip             directories never read (UI primitives that spread their props)
  actionAttribute  default data-cta
  formAttribute    default data-form

Prints the population on every run: roots, files reached, tags read,
clickables checked. Exit 0 clean, 1 on any violation, 2 when no root was found
or the config cannot be read.`;

const USAGE_JUDGE = `Usage:
  node tracking-parity.js judge <harvest.json> [--json]
  node tracking-parity.js judge --baseline <before.json> --candidate <after.json> [--json]
  node tracking-parity.js judge --print-probe [--settle-ms 400] [--attribute data-cta]

--print-probe prints an expression to evaluate in the page under test. It wraps
window.dataLayer.push (and window.gtag when present), clicks every element
carrying the action attribute one at a time (skipping value "none"), waits the
settle window after each click, and resolves to the harvest object. A
capture-phase listener calls preventDefault on every click and submit, and
window.open is stubbed, so links do not navigate and forms do not submit.
Handlers still run: harvest from a local or staging build, never production.
Save the resolved object as JSON and pass it to judge.

Classes: ok (exactly one event), untracked (none), double (two or more events
with the same name), multi (several distinct names, reported, not failing),
error (the click threw). With two harvests, every event name the baseline fired
and the candidate never fires is a lost-event.

Exit 0 when every element is ok or multi, 1 on any untracked, double or
lost-event, 2 when a harvest is missing, empty or unparseable or an element
errored.`;

// ------------------------------------------------------------------ args

function parseArgs(argv) {
    const out = { _: [], flags: {} };
    const takesValue = new Set(['--config', '--baseline', '--candidate', '--settle-ms', '--attribute']);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (takesValue.has(a)) { out.flags[a] = argv[i + 1]; i++; } else if (a.startsWith('--')) out.flags[a] = true;
        else out._.push(a);
    }
    return out;
}

// ------------------------------------------------------------------ glob

function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
        } else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else if (c === '{') {
            const end = glob.indexOf('}', i);
            const alts = glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&'));
            re += `(?:${alts.join('|')})`;
            i = end;
        } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}

function listFiles(root) {
    const out = [];
    (function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (ALWAYS_IGNORED.has(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join('/'));
        }
    }(root));
    return out.sort();
}

// ------------------------------------------------------------------ imports

// Blank comments while keeping every newline, so line numbers survive. A `//`
// only opens a comment at a line start or after whitespace, so "https://x"
// inside a string is left alone.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[ \t])\/\/[^\n]*/gm, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

function importSpecifiers(src) {
    const specs = [];
    const re = /(?:\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?|\bexport\s+[\w*{}\s,]+\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) specs.push(m[1]);
    return specs;
}

function resolveImport(root, fromFile, spec, cfg, fileSet) {
    let base = null;
    if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    else {
        for (const [prefix, target] of Object.entries(cfg.aliases || {})) {
            if (spec.startsWith(prefix)) {
                base = path.posix.normalize(path.posix.join(target || '.', spec.slice(prefix.length)));
                break;
            }
        }
    }
    if (base === null) return null;
    base = base.replace(/^\.\//, '');
    const candidates = [base, ...SOURCE_EXT.map((e) => base + e), ...SOURCE_EXT.map((e) => `${base}/index${e}`)];
    return candidates.find((c) => fileSet.has(c)) || null;
}

// ------------------------------------------------------------------ JSX tags

// Index just past the `}` that closes the `{` at i, skipping strings and
// template literals (with their own ${} nesting).
function skipBraces(src, i) {
    let depth = 0;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'") {
            const end = src.indexOf(c, i + 1);
            if (end < 0) return src.length;
            i = end;
        } else if (c === '`') {
            i++;
            while (i < src.length && src[i] !== '`') {
                if (src[i] === '\\') i++;
                else if (src[i] === '$' && src[i + 1] === '{') i = skipBraces(src, i + 1) - 1;
                i++;
            }
        } else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    }
    return src.length;
}

// Read one opening tag starting at the `<` at i. Returns null when this `<`
// is not a tag opening.
function readTag(src, i) {
    const prev = src[i - 1];
    if (prev && /[\w$.)\]]/.test(prev)) return null; // useState<T>, a<b, Array<X>
    const m = /^<([A-Za-z][\w.]*)/.exec(src.slice(i, i + 200));
    if (!m) return null;
    const name = m[1];
    const attrs = new Map();
    let j = i + m[0].length;
    while (j < src.length) {
        while (/\s/.test(src[j])) j++;
        if (src[j] === '>' || (src[j] === '/' && src[j + 1] === '>')) return { name, attrs, end: j };
        if (src[j] === '{') { j = skipBraces(src, j); continue; } // {...spread}
        const an = /^[A-Za-z_][\w:.-]*/.exec(src.slice(j, j + 100));
        if (!an) return null; // not a tag after all (for example `<T,>(x) =>`)
        j += an[0].length;
        if (src[j] !== '=') { attrs.set(an[0], { kind: 'bool', value: true }); continue; }
        j++;
        const q = src[j];
        if (q === '"' || q === "'") {
            const end = src.indexOf(q, j + 1);
            if (end < 0) return null;
            attrs.set(an[0], { kind: 'literal', value: src.slice(j + 1, end) });
            j = end + 1;
        } else if (q === '{') {
            const end = skipBraces(src, j);
            const inner = src.slice(j + 1, end - 1).trim();
            const lit = /^(['"`])([^'"`$]*)\1$/.exec(inner);
            attrs.set(an[0], lit ? { kind: 'literal', value: lit[2] } : { kind: 'expr', value: inner });
            j = end;
        } else return null;
    }
    return null;
}

function readTags(src) {
    const clean = stripComments(src);
    const tags = [];
    for (let i = clean.indexOf('<'); i >= 0; i = clean.indexOf('<', i + 1)) {
        const t = readTag(clean, i);
        if (!t) continue;
        t.line = clean.slice(0, i).split('\n').length;
        tags.push(t);
    }
    return tags;
}

function isClickable(el) {
    const last = el.name.split('.').pop();
    if (CLICKABLE_TAGS.has(el.name)) return true;
    if (CLICKABLE_SUFFIX.test(last)) return true;
    if (el.attrs.has('onClick')) return true;
    return false;
}

function checkElement(el, cfg) {
    const out = [];
    if (isClickable(el)) {
        const v = el.attrs.get(cfg.actionAttribute);
        if (!v) out.push({ kind: 'clickable', reason: `missing ${cfg.actionAttribute}` });
        else if (v.kind === 'bool') out.push({ kind: 'clickable', reason: `${cfg.actionAttribute} has no value` });
        else if (v.kind === 'literal') {
            if (!SNAKE.test(v.value) && v.value !== NONE) {
                out.push({ kind: 'clickable', reason: `${cfg.actionAttribute}="${v.value}" is not snake_case` });
            }
        }
        if (!out.length) out.push({ kind: 'clickable', ok: true });
    }
    if (el.name === 'form') {
        const v = el.attrs.get(cfg.formAttribute);
        if (!v) out.push({ kind: 'form', reason: `missing ${cfg.formAttribute}` });
        else if (v.kind === 'bool') out.push({ kind: 'form', reason: `${cfg.formAttribute} has no value` });
        else if (v.kind === 'literal' && !SNAKE.test(v.value)) {
            out.push({ kind: 'form', reason: `${cfg.formAttribute}="${v.value}" is not snake_case` });
        } else out.push({ kind: 'form', ok: true });
    }
    return out;
}

// ------------------------------------------------------------------ static

function loadConfig(file) {
    const cfg = { ...DEFAULT_CONFIG };
    if (!file) return { cfg };
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        return { error: `config ${file} could not be read: ${e.message}` };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `config ${file} is not a JSON object` };
    Object.assign(cfg, raw);
    for (const k of ['roots', 'private', 'skip']) if (!Array.isArray(cfg[k])) cfg[k] = cfg[k] ? [cfg[k]] : [];
    return { cfg };
}

function runStatic(root, cfg) {
    const all = listFiles(root);
    const fileSet = new Set(all);
    const rootRes = cfg.roots.map(globToRegExp);
    const privRes = cfg.private.map(globToRegExp);
    const skipDirs = cfg.skip.map((d) => d.replace(/\/+$/, '') + '/');
    const isPrivate = (f) => privRes.some((r) => r.test(f));
    const isSkipped = (f) => skipDirs.some((d) => f.startsWith(d));

    let layout = cfg.layout;
    if (!layout) layout = ['app/layout.tsx', 'app/layout.jsx', 'app/layout.js', 'src/app/layout.tsx', 'src/app/layout.jsx', 'src/app/layout.js'].find((f) => fileSet.has(f)) || null;
    const configError = cfg.layout && !fileSet.has(cfg.layout) ? `configured layout ${cfg.layout} does not exist` : null;

    const matched = all.filter((f) => rootRes.some((r) => r.test(f)));
    const roots = matched.filter((f) => !isPrivate(f));
    if (layout && fileSet.has(layout) && !roots.includes(layout)) roots.push(layout);
    const population = {
        roots: roots.length, files: 0, tags: 0, clickables: 0, forms: 0,
        privateExcluded: matched.length - matched.filter((f) => !isPrivate(f)).length, skipped: 0,
    };
    const violations = [];
    const seen = new Set();
    const skippedSeen = new Set();
    const queue = [...roots];
    while (queue.length) {
        const f = queue.shift();
        if (seen.has(f)) continue;
        if (isSkipped(f)) { skippedSeen.add(f); continue; }
        if (isPrivate(f) && !roots.includes(f)) continue;
        seen.add(f);
        let src;
        try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
        population.files++;
        for (const spec of importSpecifiers(stripComments(src))) {
            const r = resolveImport(root, f, spec, cfg, fileSet);
            if (r && !seen.has(r)) queue.push(r);
        }
        for (const el of readTags(src)) {
            population.tags++;
            for (const res of checkElement(el, cfg)) {
                if (res.kind === 'clickable') population.clickables++;
                else population.forms++;
                if (!res.ok) violations.push({ file: f, line: el.line, tag: el.name, reason: res.reason });
            }
        }
    }
    population.skipped = skippedSeen.size;
    return { population, violations, configError, reached: [...seen].sort() };
}

function cmdStatic(args) {
    if (args.flags['--help']) { console.log(USAGE_STATIC); return 0; }
    const root = args._[1];
    const asJson = !!args.flags['--json'];
    const refuse = (msg) => {
        if (asJson) console.log(JSON.stringify({ verdict: 'INDETERMINATE', exit: 2, reason: msg }, null, 2));
        else console.log(`INDETERMINATE: ${msg}`);
        return 2;
    };
    if (!root) return refuse('no project root given, so nothing was checked');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return refuse(`project root ${root} is not a directory`);
    const { cfg, error } = loadConfig(args.flags['--config']);
    if (error) return refuse(error);
    const res = runStatic(root, cfg);
    if (res.configError) return refuse(res.configError);
    const p = res.population;
    const popLine = `population: ${p.roots} roots, ${p.files} files reached, ${p.tags} tags read, ${p.clickables} clickables checked, ${p.forms} forms checked (private roots excluded: ${p.privateExcluded}, skipped primitive files: ${p.skipped})`;
    let code = res.violations.length ? 1 : 0;
    if (p.roots === 0) code = 2;
    if (asJson) {
        const verdict = code === 2 ? 'INDETERMINATE' : (code === 1 ? 'FAIL' : 'PASS');
        console.log(JSON.stringify({ verdict, exit: code, population: p, violations: res.violations, reached: res.reached }, null, 2));
        return code;
    }
    console.log(popLine);
    for (const v of res.violations) console.log(`  ${v.file}:${v.line}  <${v.tag}>  ${v.reason}`);
    if (code === 2) console.log(`INDETERMINATE: 0 roots matched ${cfg.roots.join(', ')}, so nothing was checked.`);
    else if (code === 1) console.log(`FAIL: ${res.violations.length} untracked or malformed element(s) in ${p.files} files.`);
    else console.log(`PASS: ${p.clickables} clickables and ${p.forms} forms in ${p.files} files all carry their attribute.`);
    return code;
}

// ------------------------------------------------------------------ probe

// Runs IN THE PAGE. Self-contained: it may reference nothing outside itself,
// because it is serialised with toString() and evaluated elsewhere.
async function harvest(opt) {
    const attr = opt.attribute || 'data-cta';
    const settleMs = typeof opt.settleMs === 'number' ? opt.settleMs : 400;
    const SENSITIVE = /cookie|user_?id|userid|client_?id|clientid|session_?id|email|phone|token|^uid$/i;
    const DROP = /^(?:eventCallback|eventTimeout|gtm\.uniqueEventId)$/;
    const clean = (v, depth) => {
        if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
        if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) : v;
        if (typeof v !== 'object' || depth > 3) return undefined;
        const out = Array.isArray(v) ? [] : {};
        for (const k of Object.keys(v)) {
            if (DROP.test(k)) continue;
            const c = SENSITIVE.test(k) ? '[redacted]' : clean(v[k], depth + 1);
            if (c !== undefined) out[k] = c;
        }
        return out;
    };
    const dl = (window.dataLayer = window.dataLayer || []);
    const originalPush = dl.push;
    const originalGtag = typeof window.gtag === 'function' ? window.gtag : null;
    const originalOpen = window.open;
    let current = null;
    let inGtag = false;
    const record = (entry) => {
        if (!current || !entry.name || /^gtm\./.test(entry.name)) return;
        current.events.push(entry);
    };
    dl.push = function trackingParityPush(...items) {
        if (!inGtag) {
            for (const it of items) {
                if (it && typeof it === 'object' && typeof it.length === 'number' && it[0] === 'event') {
                    record({ name: String(it[1]), params: clean(it[2] || {}, 0) || {} });
                } else if (it && typeof it === 'object' && typeof it.event === 'string') {
                    const params = {};
                    for (const k of Object.keys(it)) if (k !== 'event') params[k] = it[k];
                    record({ name: it.event, params: clean(params, 0) || {} });
                }
            }
        }
        return originalPush.apply(this, items);
    };
    if (originalGtag) {
        window.gtag = function trackingParityGtag(...a) {
            if (a[0] === 'event') record({ name: String(a[1]), params: clean(a[2] || {}, 0) || {} });
            inGtag = true;
            try { return originalGtag.apply(this, a); } finally { inGtag = false; }
        };
    }
    const block = (e) => { e.preventDefault(); };
    window.addEventListener('click', block, true);
    window.addEventListener('submit', block, true);
    window.open = function trackingParityOpen() { return null; };
    const selectorFor = (el) => {
        const parts = [];
        let node = el;
        for (let depth = 0; node && node.tagName && depth < 4; depth++) {
            let part = node.tagName.toLowerCase();
            if (node.id) { parts.unshift(`${part}#${node.id}`); break; }
            const parent = node.parentElement;
            if (parent && parent.children) {
                const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
                if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
            }
            parts.unshift(part);
            node = parent;
        }
        return parts.join(' > ');
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const elements = [];
    let skippedNone = 0;
    const occurrences = {};
    try {
        const nodes = Array.prototype.slice.call(document.querySelectorAll(`[${attr}]`));
        for (const el of nodes) {
            const value = el.getAttribute(attr);
            if (value === 'none') { skippedNone++; continue; }
            occurrences[value] = (occurrences[value] || 0) + 1;
            current = { selector: selectorFor(el), value, occurrence: occurrences[value], events: [], error: null };
            try { el.click(); } catch (err) { current.error = String(err && err.message ? err.message : err); }
            await wait(settleMs);
            elements.push(current);
            current = null;
        }
    } finally {
        current = null;
        dl.push = originalPush;
        if (originalGtag) window.gtag = originalGtag;
        window.open = originalOpen;
        window.removeEventListener('click', block, true);
        window.removeEventListener('submit', block, true);
    }
    return { url: String(location.href), attribute: attr, settleMs, skippedNone, elements };
}

function probeSource(opt) {
    return `(${harvest.toString()})(${JSON.stringify(opt)})`;
}

// ------------------------------------------------------------------ judge

function classify(el) {
    if (el.error) return 'error';
    const events = Array.isArray(el.events) ? el.events : [];
    if (events.length === 0) return 'untracked';
    const counts = {};
    for (const e of events) counts[e.name] = (counts[e.name] || 0) + 1;
    const repeated = Object.values(counts).some((n) => n >= 2);
    if (repeated) return 'double';
    if (events.length === 1) return 'ok';
    return 'multi';
}

function readHarvest(file) {
    if (!file) return { error: 'no harvest file given' };
    if (!fs.existsSync(file)) return { error: `harvest ${file} does not exist` };
    let h;
    try { h = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        return { error: `harvest ${file} is not valid JSON: ${e.message}` };
    }
    if (!h || typeof h !== 'object' || !Array.isArray(h.elements)) return { error: `harvest ${file} has no elements array` };
    return { h };
}

function eventNames(h) {
    const s = new Set();
    for (const el of h.elements) for (const e of el.events || []) if (e && e.name) s.add(e.name);
    return s;
}

function cmdJudge(args) {
    if (args.flags['--help']) { console.log(USAGE_JUDGE); return 0; }
    if (args.flags['--print-probe']) {
        const settle = args.flags['--settle-ms'] !== undefined ? Number(args.flags['--settle-ms']) : 400;
        console.log(probeSource({ attribute: args.flags['--attribute'] || 'data-cta', settleMs: settle }));
        return 0;
    }
    const asJson = !!args.flags['--json'];
    const refuse = (msg) => {
        if (asJson) console.log(JSON.stringify({ verdict: 'INDETERMINATE', exit: 2, reason: msg }, null, 2));
        else console.log(`INDETERMINATE: ${msg}. Nothing was judged, so this is not a pass.`);
        return 2;
    };
    const baselineFile = args.flags['--baseline'];
    const candidateFile = args.flags['--candidate'] || args._[1];
    if (args.flags['--baseline'] && !args.flags['--candidate']) return refuse('--baseline needs --candidate');
    const hs = [];
    for (const f of baselineFile ? [baselineFile, candidateFile] : [candidateFile]) {
        const { h, error } = readHarvest(f);
        if (error) return refuse(error);
        if (!h.elements.length) return refuse(`harvest ${f} is empty: nothing was clicked`);
        hs.push(h);
    }
    const cand = hs[hs.length - 1];
    const elements = cand.elements.map((el) => ({
        selector: el.selector, value: el.value, class: classify(el),
        events: (el.events || []).map((e) => e.name), error: el.error || null,
    }));
    let lostEvents = [];
    if (hs.length === 2) {
        const baseNames = eventNames(hs[0]);
        const candNames = eventNames(cand);
        const lost = [...baseNames].filter((n) => !candNames.has(n)).sort();
        lostEvents = lost;
    }
    const byClass = {};
    for (const e of elements) byClass[e.class] = (byClass[e.class] || 0) + 1;
    const findings = (byClass.untracked || 0) + (byClass.double || 0) + lostEvents.length;
    const code = findings ? 1 : (byClass.error ? 2 : 0);
    const verdict = code === 1 ? 'FAIL' : (code === 2 ? 'INDETERMINATE' : 'PASS');
    const population = {
        elements: elements.length, byClass,
        baselineElements: hs.length === 2 ? hs[0].elements.length : null,
        skippedNone: cand.skippedNone || 0, url: cand.url || null,
    };
    if (asJson) {
        console.log(JSON.stringify({ verdict, exit: code, population, elements, lostEvents }, null, 2));
        return code;
    }
    const classes = Object.entries(byClass).map(([k, n]) => `${n} ${k}`).join(', ');
    console.log(`population: ${elements.length} elements judged (${classes})${hs.length === 2 ? `, baseline ${hs[0].elements.length} elements` : ''}, url ${cand.url || 'unknown'}`);
    for (const e of elements) {
        if (e.class === 'ok') continue;
        const detail = e.class === 'error' ? e.error : (e.events.join(', ') || 'no events');
        console.log(`  ${e.class.padEnd(9)} ${e.value}  ${e.selector || ''}  ${detail}`);
    }
    for (const n of lostEvents) console.log(`  lost-event ${n}  fired in the baseline, never in the candidate`);
    if (code === 1) console.log(`FAIL: ${findings} finding(s).`);
    else if (code === 2) console.log(`INDETERMINATE: ${byClass.error} element(s) could not be clicked, so they were not measured.`);
    else console.log(`PASS: all ${elements.length} elements fired, none twice${hs.length === 2 ? ', and no baseline event was lost' : ''}.`);
    return code;
}

// ------------------------------------------------------------------ selftest

// A known positive and a known negative through the real static path, so a
// clean run is distinguishable from a reader that can see nothing.
function selftest() {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracking-parity-selftest-'));
    try {
        fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default function P() { return <main><button data-cta="go_now">Go</button></main>; }');
        const clean = runStatic(dir, { ...DEFAULT_CONFIG });
        fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default function P() { return <main><button>Go</button></main>; }');
        const planted = runStatic(dir, { ...DEFAULT_CONFIG });
        const ok = clean.violations.length === 0 && clean.population.clickables === 1
            && planted.violations.length === 1 && planted.violations[0].tag === 'button';
        console.log(`selftest: clean ${clean.violations.length} violations of ${clean.population.clickables} clickables, planted ${planted.violations.length} violation(s): ${ok ? 'PASS' : 'FAIL'}`);
        return ok ? 0 : 1;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ------------------------------------------------------------------ main

function main(argv) {
    const args = parseArgs(argv);
    const sub = args._[0];
    if (args.flags['--selftest']) return selftest();
    if (sub === 'static') return cmdStatic(args);
    if (sub === 'judge') return cmdJudge(args);
    if (args.flags['--print-probe']) return cmdJudge({ ...args, _: ['judge'] });
    if (args.flags['--help'] || !sub) { console.log(USAGE); return args.flags['--help'] ? 0 : 2; }
    console.log(`unknown subcommand ${sub}\n\n${USAGE}`);
    return 2;
}

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (e) {
        console.error(`tracking-parity: ${e && e.stack ? e.stack : e}`);
        process.exitCode = 2;
    }
}

module.exports = { harvest, probeSource, classify, runStatic, readTags, globToRegExp };
