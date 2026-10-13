#!/usr/bin/env node
'use strict';
/**
 * instruction-envelope.js - measure, budget and guard what loads into every session.
 *
 * WHY. Every `rules/*.md` in the profile's config dir that has no `paths:` frontmatter,
 * plus the profile's CLAUDE.md, loads into every session before any work, and the
 * project's CLAUDE.md loads beside them. A budget with no check grows back. A check that
 * only warns grows back too: the private predecessor of this script printed one line at
 * SessionStart while the set sat over its budget (`[measured 2026-10-14]` 32,264 bytes
 * against 32,000). So this script measures the envelope, and its preflight REFUSES a
 * change that would push the envelope over budget or drop a rule that must stay.
 *
 * WHAT IT MEASURES (the source manifest, one row per loaded file with its bytes):
 *   rule              <config>/rules/*.md with no `paths:` frontmatter     budgeted
 *   user-claude-md    <config>/CLAUDE.md                                    budgeted
 *   project-claude-md <project>/CLAUDE.md                                   its own budget
 *   output-style      the active outputStyle in <config>/settings.json      0 bytes unless a file
 * Paths-scoped rules are counted as skipped, never as loaded.
 *
 * REQUIRED RULES. `<config>/instruction-envelope.json` may declare
 *   { "budget": 32000, "projectBudget": 8192, "required": ["security.md", ...] }
 * A required rule must stay discoverable: present under rules/, always-on or paths-scoped.
 * A trim that drops one is RETAINED=fail, and the preflight blocks it.
 *
 * CONFLICTING STYLES. A small declared list of directive pairs that contradict each other
 * (STYLE_CONFLICTS). Two different loaded sources matching the two sides of one pair are
 * reported as DETECTED. Detection only: which side wins is the owner's call, so nothing
 * here edits, reorders or suppresses either source, and a conflict never changes an exit
 * code.
 *
 * THE UPDATE PATH. Claude Code owns `/plugin update`, and this plugin ships no file into
 * the profile's rules/, so there is no plugin-side install step to hook. The guarded path
 * is `apply`: it runs the preflight on the staged files and writes nothing when the
 * preflight blocks. Anything that installs rules (a sync script, a template) goes through it.
 *
 * Usage:
 *   node instruction-envelope.js [measure] [--config-dir <d>] [--project <d>] [--budget N] [--json]
 *   node instruction-envelope.js preflight --incoming <d> [--remove rules/x.md]... [--json]
 *   node instruction-envelope.js apply --incoming <d> [--remove rules/x.md]...
 *   node instruction-envelope.js --hook        SessionStart: zero bytes when healthy, exit 0 always
 * <incoming> mirrors the config dir: incoming/rules/*.md and incoming/CLAUDE.md.
 * Exit: measure 1 when over a budget or a required rule is missing. preflight and apply 1
 * when BLOCKED. 2 when the inputs could not be read (never a pass).
 */
const fs = require('node:fs');
const path = require('node:path');
const claudePaths = require('./claude-paths.js');

const DEFAULT_BUDGET = 32000;
const DEFAULT_PROJECT_BUDGET = 8192;
const CONFIG_FILE = 'instruction-envelope.json';

// Each pair names two directives that cannot both be followed. A pattern matches one
// line of one source. Kept deliberately narrow: a loose pattern turns every style rule
// into a "conflict" and the finding stops being read.
const STYLE_CONFLICTS = [
    {
        id: 'brevity-vs-length',
        a: { name: 'concise output', re: /\b(be (concise|brief|terse)|keep (your )?(responses|answers|replies) (short|brief)|output style: ?concise)\b/i },
        b: { name: 'long explanations', re: /\b((long|lengthy|detailed|exhaustive|in-depth) (explanations?|answers|responses)|explain (everything |each step )?in (full|great detail|detail)|always explain at length)\b/i },
    },
    {
        id: 'prose-vs-lists',
        a: { name: 'no lists', re: /\b(no (bullet points|bullets|bulleted lists)|never use (bullet points|bullets|lists))\b/i },
        b: { name: 'always lists', re: /\balways (use|answer (in|with)) (bullet points|bullets|lists)\b/i },
    },
    {
        id: 'headings',
        a: { name: 'no headings', re: /\b(no|never use) (markdown )?headings\b/i },
        b: { name: 'always headings', re: /\balways (use|start with) (markdown )?headings\b/i },
    },
    {
        id: 'emoji',
        a: { name: 'no emoji', re: /\b(no|never use) emojis?\b/i },
        b: { name: 'always emoji', re: /\balways (use|include|add) emojis?\b/i },
    },
];

/** True when the text opens with frontmatter that declares `paths:`. */
function isPathsScoped(text) {
    const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
    return Boolean(m && /^paths\s*:/m.test(m[1]));
}

function readConfig(configDir) {
    const file = path.join(configDir, CONFIG_FILE);
    if (!fs.existsSync(file)) return { file, present: false, budget: null, projectBudget: null, required: [] };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
    const required = Array.isArray(raw.required) ? raw.required.filter((r) => typeof r === 'string') : [];
    return { file, present: true, budget: num(raw.budget), projectBudget: num(raw.projectBudget), required };
}

const ruleName = (r) => path.basename(String(r).replace(/\\/g, '/'));

function activeOutputStyle(configDir) {
    const settings = path.join(configDir, 'settings.json');
    if (!fs.existsSync(settings)) return null;
    let style;
    try { style = JSON.parse(fs.readFileSync(settings, 'utf8')).outputStyle; } catch { return null; }
    if (typeof style !== 'string' || !style.trim()) return null;
    const dir = path.join(configDir, 'output-styles');
    const file = fs.existsSync(dir)
        ? fs.readdirSync(dir).find((n) => n.toLowerCase() === `${style.toLowerCase()}.md`)
        : null;
    const body = file ? fs.readFileSync(path.join(dir, file)) : null;
    return {
        source: file ? `output-styles/${file}` : `settings.json outputStyle`,
        kind: 'output-style',
        bytes: body ? body.length : 0,
        text: `Output style: ${style}\n${body ? body.toString('utf8') : ''}`,
    };
}

/**
 * The envelope as it stands in configDir, with `overlay` applied when given:
 * overlay.files maps a config-relative path (rules/x.md, CLAUDE.md) to a Buffer,
 * overlay.remove lists config-relative paths that will be gone.
 */
function measureEnvelope({ configDir, projectDir = null, budget = null, projectBudget = null, overlay = null }) {
    const cfg = readConfig(configDir);
    const ruleBudget = budget || cfg.budget || DEFAULT_BUDGET;
    const projBudget = projectBudget || cfg.projectBudget || DEFAULT_PROJECT_BUDGET;
    const files = new Map();
    const rulesDir = path.join(configDir, 'rules');
    for (const name of fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir) : []) {
        if (name.endsWith('.md')) files.set(`rules/${name}`, () => fs.readFileSync(path.join(rulesDir, name)));
    }
    const userClaude = path.join(configDir, 'CLAUDE.md');
    if (fs.existsSync(userClaude)) files.set('CLAUDE.md', () => fs.readFileSync(userClaude));
    if (overlay) {
        for (const r of overlay.remove || []) files.delete(r.replace(/\\/g, '/'));
        for (const [rel, buf] of Object.entries(overlay.files || {})) files.set(rel, () => buf);
    }

    const sources = [];
    const skipped = [];
    const present = new Set();
    for (const [rel, read] of [...files.entries()].sort()) {
        const buf = read();
        if (rel === 'CLAUDE.md') {
            sources.push({ source: 'CLAUDE.md', kind: 'user-claude-md', bytes: buf.length, text: buf.toString('utf8') });
            continue;
        }
        if (!/^rules\/[^/]+\.md$/.test(rel)) continue;
        present.add(path.basename(rel));
        const text = buf.toString('utf8');
        if (isPathsScoped(text)) { skipped.push(rel); continue; }
        sources.push({ source: rel, kind: 'rule', bytes: buf.length, text });
    }
    const rulesTotal = sources.reduce((s, f) => s + f.bytes, 0);

    let project = null;
    if (projectDir) {
        const file = path.join(path.resolve(projectDir), 'CLAUDE.md');
        const isFile = fs.existsSync(file);
        const buf = isFile ? fs.readFileSync(file) : null;
        project = { file, present: isFile, bytes: buf ? buf.length : 0, budget: projBudget, over: Boolean(buf && buf.length > projBudget) };
        if (buf) sources.push({ source: 'project CLAUDE.md', kind: 'project-claude-md', bytes: buf.length, text: buf.toString('utf8') });
    }
    const style = activeOutputStyle(configDir);
    if (style) sources.push(style);

    const required = cfg.required.map(ruleName);
    const missing = required.filter((r) => !present.has(r));
    const conflicts = detectConflicts(sources);
    const manifest = sources.map(({ source, kind, bytes }) => ({ source, kind, bytes }));
    return {
        configDir,
        config: { file: cfg.file, present: cfg.present },
        budget: ruleBudget,
        rulesTotal,
        over: rulesTotal > ruleBudget,
        envelopeTotal: manifest.reduce((s, f) => s + f.bytes, 0),
        project,
        manifest,
        pathsScopedSkipped: skipped,
        required: { declared: required.length, missing },
        conflicts,
    };
}

/** Lines outside fenced code, so a rule quoting a banned form is not read as one. */
function proseLines(text) {
    const out = [];
    let fenced = false;
    String(text).split(/\r?\n/).forEach((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
        if (!fenced) out.push({ n: i + 1, line });
    });
    return out;
}

function detectConflicts(sources, pairs = STYLE_CONFLICTS) {
    const hits = (src, re) => proseLines(src.text).filter(({ line }) => re.test(line));
    const found = [];
    for (const pair of pairs) {
        const sideA = [];
        const sideB = [];
        for (const src of sources) {
            const a = hits(src, pair.a.re);
            const b = hits(src, pair.b.re);
            if (a.length) sideA.push({ source: src.source, line: a[0].n, text: a[0].line.trim().slice(0, 120) });
            if (b.length) sideB.push({ source: src.source, line: b[0].n, text: b[0].line.trim().slice(0, 120) });
        }
        for (const a of sideA) for (const b of sideB) {
            if (a.source === b.source) continue;
            found.push({ id: pair.id, a: { directive: pair.a.name, ...a }, b: { directive: pair.b.name, ...b } });
        }
    }
    return found;
}

function readIncoming(incomingDir) {
    const files = {};
    const rules = path.join(incomingDir, 'rules');
    if (fs.existsSync(rules)) {
        for (const n of fs.readdirSync(rules)) if (n.endsWith('.md')) files[`rules/${n}`] = fs.readFileSync(path.join(rules, n));
    }
    const claude = path.join(incomingDir, 'CLAUDE.md');
    if (fs.existsSync(claude)) files['CLAUDE.md'] = fs.readFileSync(claude);
    return files;
}

/**
 * BLOCKED when the change grows a rules set that ends over budget, or when a required
 * rule is absent afterwards. A change that shrinks an already-oversize set passes: a trim
 * is how the set gets back under, and blocking it would keep the envelope over for good.
 */
function preflight({ configDir, incomingDir = null, files = null, remove = [], budget = null }) {
    const overlay = { files: files || (incomingDir ? readIncoming(incomingDir) : {}), remove };
    const before = measureEnvelope({ configDir, budget });
    const after = measureEnvelope({ configDir, budget, overlay });
    const reasons = [];
    if (after.over && after.rulesTotal > before.rulesTotal) {
        reasons.push(`rules set would be ${after.rulesTotal} bytes, over the ${after.budget} budget (now ${before.rulesTotal})`);
    }
    for (const m of after.required.missing) reasons.push(`required rule ${m} would not be present`);
    return {
        verdict: reasons.length ? 'BLOCKED' : 'PASS',
        reasons,
        before: { rulesTotal: before.rulesTotal, missing: before.required.missing },
        after: { rulesTotal: after.rulesTotal, missing: after.required.missing, manifest: after.manifest },
        budget: after.budget,
        changed: Object.keys(overlay.files).length,
        removed: overlay.remove.length,
    };
}

/** Preflight, then write only when it passes. Returns the preflight result plus `applied`. */
function apply(opts) {
    const r = preflight(opts);
    if (r.verdict !== 'PASS') return { ...r, applied: false };
    const files = opts.files || (opts.incomingDir ? readIncoming(opts.incomingDir) : {});
    for (const [rel, buf] of Object.entries(files)) {
        const dest = path.join(opts.configDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
    }
    for (const rel of opts.remove || []) fs.rmSync(path.join(opts.configDir, rel), { force: true });
    return { ...r, applied: true };
}

/** One line when something needs saying, null when healthy. */
function hookLine(env) {
    const r = measureEnvelope({ configDir: claudePaths.configDir(env) });
    const parts = [];
    if (r.over) parts.push(`always-on rules are ${r.rulesTotal} bytes, over the ${r.budget} budget`);
    if (r.required.missing.length) parts.push(`required rule missing: ${r.required.missing.join(', ')}`);
    if (r.conflicts.length) {
        const c = r.conflicts[0];
        parts.push(`conflicting styles: ${c.a.source} (${c.a.directive}) vs ${c.b.source} (${c.b.directive})`
            + (r.conflicts.length > 1 ? `, ${r.conflicts.length - 1} more` : ''));
    }
    return parts.length ? `[instruction-envelope] ${parts.join('. ')}. Run: node instruction-envelope.js` : null;
}

function render(r) {
    const out = [];
    for (const f of [...r.manifest].sort((a, b) => b.bytes - a.bytes)) out.push(`${String(f.bytes).padStart(6)}  ${f.kind.padEnd(17)} ${f.source}`);
    out.push(`${r.manifest.length} sources loaded, ${r.pathsScopedSkipped.length} paths-scoped skipped, envelope ${r.envelopeTotal} bytes`);
    out.push(`rules set ${r.rulesTotal} bytes, budget ${r.budget}: ${r.over ? 'OVER' : 'ok'}`);
    if (r.project) out.push(`project CLAUDE.md ${r.project.bytes} bytes, budget ${r.project.budget}: ${r.project.present ? (r.project.over ? 'OVER' : 'ok') : 'absent'}`);
    out.push(`required rules: ${r.required.declared} declared, ${r.required.missing.length} missing${r.required.missing.length ? ` (${r.required.missing.join(', ')})` : ''}`);
    out.push(`conflicting styles: ${r.conflicts.length} of ${STYLE_CONFLICTS.length} declared pairs ${r.conflicts.length ? 'DETECTED' : 'clear'}`);
    for (const c of r.conflicts) out.push(`  ${c.id}: ${c.a.source}:${c.a.line} "${c.a.text}" vs ${c.b.source}:${c.b.line} "${c.b.text}"`);
    return out.join('\n') + '\n';
}

function parseArgs(argv) {
    const o = { cmd: 'measure', remove: [], json: false, hook: false, help: false };
    const val = (i) => { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') o.help = true;
        else if (a === '--json') o.json = true;
        else if (a === '--hook') o.hook = true;
        else if (a === '--config-dir') o.configDir = val(i++);
        else if (a === '--project') o.project = val(i++);
        else if (a === '--incoming') o.incoming = val(i++);
        else if (a === '--remove') o.remove.push(val(i++));
        else if (a === '--budget') { o.budget = Number(val(i++)); if (!(o.budget > 0)) throw new Error('--budget needs a positive number'); }
        else if (['measure', 'preflight', 'apply'].includes(a)) o.cmd = a;
        else throw new Error(`unknown argument ${a}`);
    }
    return o;
}

const USAGE = 'usage: node instruction-envelope.js [measure|preflight|apply] [--config-dir <d>] [--project <d>]\n'
    + '         [--budget N] [--incoming <d>] [--remove rules/x.md] [--json] | --hook\n'
    + 'Measures the always-on instruction envelope, enforces its budget and required rules,\n'
    + 'reports conflicting style directives, and blocks an update that would break the budget.\n';

function main(argv, env = process.env) {
    let o;
    try { o = parseArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n${USAGE}`); return 2; }
    if (o.help) { process.stdout.write(USAGE); return 0; }
    if (o.hook) {
        try {
            const line = hookLine(env);
            if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n');
        } catch { /* advisory at SessionStart: an unreadable profile is not a reason to speak or block */ }
        return 0;
    }
    const configDir = o.configDir ? path.resolve(o.configDir) : claudePaths.configDir(env);
    try {
        if (o.cmd === 'measure') {
            const r = measureEnvelope({ configDir, projectDir: o.project || process.cwd(), budget: o.budget });
            process.stdout.write(o.json ? JSON.stringify(r, (k, v) => (k === 'text' ? undefined : v), 2) + '\n' : render(r));
            return r.over || r.required.missing.length || (r.project && r.project.over) ? 1 : 0;
        }
        if (!o.incoming && !o.remove.length) { process.stderr.write(`${o.cmd} needs --incoming or --remove\n`); return 2; }
        if (o.incoming && !fs.existsSync(o.incoming)) { process.stderr.write(`incoming dir not found: ${o.incoming}\n`); return 2; }
        const fn = o.cmd === 'apply' ? apply : preflight;
        const r = fn({ configDir, incomingDir: o.incoming || null, remove: o.remove, budget: o.budget });
        if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
        else {
            process.stdout.write(`preflight: ${r.verdict} (${r.changed} files staged, ${r.removed} removed, rules set ${r.before.rulesTotal} -> ${r.after.rulesTotal} bytes, budget ${r.budget})`
                + (o.cmd === 'apply' ? `, ${r.applied ? 'applied' : 'nothing written'}` : '') + '\n');
        }
        if (r.verdict !== 'PASS') { for (const why of r.reasons) process.stderr.write(`BLOCKED: ${why}\n`); return 1; }
        return 0;
    } catch (e) {
        process.stderr.write(`could not read the envelope: ${e.message}\n`);
        return 2;
    }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
    DEFAULT_BUDGET, DEFAULT_PROJECT_BUDGET, STYLE_CONFLICTS, CONFIG_FILE,
    isPathsScoped, measureEnvelope, detectConflicts, preflight, apply, hookLine, main,
};
