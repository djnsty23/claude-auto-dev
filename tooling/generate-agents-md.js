#!/usr/bin/env node
'use strict';
// generate-agents-md.js — distil the always-on rule-* skills into AGENTS.md.
//
// WHY. The 16 always-on `rule-*` skills under plugins/autodev-core/skills/ load
// into every Claude Code session by `paths:` glob. A Codex session in the same
// repo reads AGENTS.md instead, which was 4,200 bytes and hand-written, so the
// auditor never saw the conventions it was auditing against. A hand-maintained
// copy rots (the reference harness's own AGENTS.md was five months stale), and a
// verbatim copy costs every Codex turn the full 128 KB. So: generate the
// distillation from the rules, and gate drift between the two with --check.
//
// WHAT IT EMITS. AGENTS.md has two parts. Everything ABOVE the GENERATED marker
// is hand-maintained and copied through verbatim on every run — that is where
// the Codex-only facts live (cold start, channels, scope). Everything below the
// marker is regenerated from the rules and must not be edited by hand.
//
// Per rule, variant B (measured, see --measure): the frontmatter description,
// the `paths:` globs so a reader knows when the rule applies, the first
// paragraph of the body, every paragraph carrying a dated claim (`[measured …]`,
// `[stated …]`, or an ISO date) plus the code fence such a paragraph introduces,
// and every `**Never`/`**Always` line. `when_to_use` is emitted only in variant A:
// it restates the description in 15 of 16 rules and cost 1,701 bytes.
//
// The brief specified "every LINE that starts with a marker". `[measured
// 2026-09-08]` over the 16 real rules that keeps ZERO of 25 dated claims: no
// marker begins a line, they sit mid-sentence inside wrapped paragraphs, and
// the line shape (B′ in --measure) keeps 30 fragments of which 2 are whole
// claims. --measure reports both shapes so the decision is visible, not asserted.
//
// GATE SHAPE (rule-gate-integrity). --check runs THIS generator against the
// rules on disk, writes to a temp path, and compares with what is committed; it
// never regenerates in place and then reads its own output. It asserts a
// population floor (at least MIN_RULES rules parsed) and refuses a rule without
// frontmatter or without a description, loudly, rather than emitting a section
// with holes in it. Bare invocation prints usage and exits 2: this script
// declares how it wants to be driven rather than assuming bare is safe.
//
// Usage:
//   node tooling/generate-agents-md.js --measure          three-variant table, no writes
//   node tooling/generate-agents-md.js --write            regenerate AGENTS.md in place
//   node tooling/generate-agents-md.js --check            exit 1 with a diff summary if stale
//   node tooling/generate-agents-md.js --print            regenerated text to stdout
//   options: --variant A|B|C   --out <file>   --rules-dir <dir>   --version-file <file>
//            --root <dir>  (repo root; defaults to the parent of tooling/)
//
// Exit: 0 ok · 1 stale (--check) or a rule failed to parse · 2 usage / no rules.

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
    const lines = fs.readFileSync(__filename, 'utf8').split('\n');
    const head = [];
    for (const line of lines.slice(1)) {
        if (line.trim() === "'use strict';") continue;
        if (/^\s*(\/\/|$)/.test(line)) head.push(line.replace(/^\/\/ ?/, ''));
        else break;
    }
    console.log(head.join('\n').trim());
    process.exit(0);
}

const ROOT = path.resolve(val('--root', path.join(__dirname, '..')));
const RULES_DIR = path.resolve(ROOT, val('--rules-dir', path.join('plugins', 'autodev-core', 'skills')));
const OUT = path.resolve(ROOT, val('--out', 'AGENTS.md'));
const VERSION_FILE = path.resolve(ROOT, val('--version-file', 'VERSION'));
const VARIANT = (val('--variant', 'B') || 'B').toUpperCase();
const SOURCE_GLOB = 'plugins/autodev-core/skills/rule-*/SKILL.md';

// Population floor. The real tree has 16; a fixture dir may legitimately have
// fewer, so the floor is "at least one rule parsed", asserted separately from
// the comparison. Zero rules must never produce a green check or an AGENTS.md
// whose generated half is empty.
const MIN_RULES = 1;

const GENERATED_MARKER = '<!-- GENERATED BELOW — DO NOT EDIT BY HAND.';
const DATED = /\[(?:measured|stated)\b|\b20\d\d-\d\d-\d\d\b/;
const NEVER_ALWAYS = /^\s*(?:[-*]\s+)?\*\*(?:Never|Always)\b/;

// ---------------------------------------------------------------------------
// Frontmatter. A deliberately small YAML subset: scalars (quoted or bare) and
// block lists of scalars. Anything else in a rule's frontmatter is a defect in
// the rule, and this parser says so rather than guessing.
// ---------------------------------------------------------------------------
function unquote(s) {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1).replace(/\\"/g, '"');
    }
    return s;
}

function parseFrontmatter(src, rel) {
    const lines = src.split(/\r?\n/);
    if (lines[0] !== '---') throw new Error(`${rel}: no frontmatter (first line is not ---)`);
    let end = -1;
    for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { end = i; break; }
    if (end < 0) throw new Error(`${rel}: frontmatter never closes`);
    const fm = {};
    let listKey = null;
    for (const raw of lines.slice(1, end)) {
        if (!raw.trim()) continue;
        const item = /^\s+-\s+(.*)$/.exec(raw);
        if (item && listKey) { fm[listKey].push(unquote(item[1])); continue; }
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
        if (!kv) throw new Error(`${rel}: unparseable frontmatter line: ${raw}`);
        if (kv[2] === '') { fm[kv[1]] = []; listKey = kv[1]; }
        else { fm[kv[1]] = unquote(kv[2]); listKey = null; }
    }
    if (!fm.name) throw new Error(`${rel}: frontmatter has no name`);
    if (!fm.description) throw new Error(`${rel}: frontmatter has no description`);
    return { fm, body: lines.slice(end + 1).join('\n') };
}

// ---------------------------------------------------------------------------
// Body → blocks. A block is a run of non-blank lines, except that a fenced code
// block is one block however many blank lines it contains, so a date inside a
// fence never drags half a fence into the output.
// ---------------------------------------------------------------------------
function toBlocks(body) {
    const blocks = [];
    let cur = [];
    let inFence = false;
    const flush = () => { if (cur.length) { blocks.push(cur.join('\n')); cur = []; } };
    for (const line of body.split('\n')) {
        if (/^\s*```/.test(line)) {
            cur.push(line);
            inFence = !inFence;
            if (!inFence) flush();
            continue;
        }
        if (inFence) { cur.push(line); continue; }
        if (!line.trim()) { flush(); continue; }
        cur.push(line);
    }
    flush();
    return blocks;
}

const isHeading = (b) => /^#{1,6}\s/.test(b);

function distil(body) {
    const blocks = toBlocks(body);
    const prose = blocks.filter((b) => !isHeading(b));
    const first = prose[0] || '';
    // A dated paragraph that ends with a colon is introducing the block after
    // it, usually a fence with the command or the numbers. Carry that block, or
    // the claim arrives without the evidence it points at.
    const datedBlocks = [];
    for (let i = 0; i < prose.length; i++) {
        if (!DATED.test(prose[i])) continue;
        const next = prose[i + 1];
        if (/:\s*$/.test(prose[i]) && next && /^\s*```/.test(next)) datedBlocks.push(prose[i] + '\n\n' + next);
        else datedBlocks.push(prose[i]);
    }
    const datedLines = body.split('\n').filter((l) => DATED.test(l));
    const neverAlways = body.split('\n').filter((l) => NEVER_ALWAYS.test(l));
    return { blocks, first, datedBlocks, datedLines, neverAlways };
}

// ---------------------------------------------------------------------------
// Load every rule. Sorted by directory name so the output is deterministic.
// ---------------------------------------------------------------------------
function loadRules() {
    if (!fs.existsSync(RULES_DIR)) throw new Error(`rules dir does not exist: ${RULES_DIR}`);
    const dirs = fs.readdirSync(RULES_DIR).filter((d) => d.startsWith('rule-')).sort();
    const rules = [];
    const errors = [];
    for (const d of dirs) {
        const file = path.join(RULES_DIR, d, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        try {
            const { fm, body } = parseFrontmatter(src, rel);
            rules.push({ dir: d, rel, fm, body, bytes: Buffer.byteLength(src), ...distil(body) });
        } catch (e) {
            errors.push(e.message);
        }
    }
    return { rules, errors };
}

// ---------------------------------------------------------------------------
// Render one rule under a variant.
// ---------------------------------------------------------------------------
function appliesLine(fm) {
    const paths = Array.isArray(fm.paths) ? fm.paths : [];
    if (paths.length) return '**paths:** ' + paths.map((p) => '`' + p + '`').join(', ');
    // No glob: the rule has nothing to attach to, so it is load-on-request.
    return '**paths:** none — applies to any work; load it by name'
        + (fm['user-invocable'] === 'true' ? ' (user-invocable)' : '');
}

function renderRule(r, variant) {
    const out = [];
    out.push(`### ${r.fm.name}`);
    out.push('');
    out.push(appliesLine(r.fm));
    out.push('');
    out.push(r.fm.description.trim());
    if (variant === 'C') {
        out.push('');
        out.push(`Full text: \`${r.rel}\``);
        return out.join('\n');
    }
    if (variant === 'A') {
        if (r.fm.when_to_use) { out.push(''); out.push('**When:** ' + String(r.fm.when_to_use).trim()); }
        out.push('');
        out.push(r.body.trim());
        return out.join('\n');
    }
    // Variant B. Paragraph shape ("B") or line shape ("B-LINE"), both with the
    // first paragraph and the Never/Always lines. Emitted once each: a first
    // paragraph that is itself dated is not repeated.
    const emitted = new Set();
    const push = (block) => {
        const key = block.trim();
        if (!key || emitted.has(key)) return;
        emitted.add(key);
        out.push('');
        out.push(key);
    };
    push(r.first);
    if (variant === 'B-LINE') for (const l of r.datedLines) push(l);
    else for (const b of r.datedBlocks) push(b);
    for (const l of r.neverAlways) push(l);
    out.push('');
    out.push(`Full text: \`${r.rel}\``);
    return out.join('\n');
}

function renderGenerated(rules, variant, version, measurement) {
    const lines = [];
    lines.push(GENERATED_MARKER);
    lines.push(`     Generator: tooling/generate-agents-md.js`);
    lines.push(`     Source:    ${SOURCE_GLOB} (${rules.length} rules)`);
    lines.push(`     Version:   autodev ${version}`);
    lines.push(`     Variant:   ${variant}`);
    lines.push(`     Regenerate with: node tooling/generate-agents-md.js --write`);
    lines.push(`     Drift gate:      node tooling/generate-agents-md.js --check   (npm run check:agents-md) -->`);
    lines.push('');
    lines.push('## Conventions this repo enforces (generated)');
    lines.push('');
    lines.push('Distilled from the always-on `rule-*` skills that every Claude Code session in');
    lines.push('this repo loads by path glob. Each entry names the globs that trigger the rule,');
    lines.push('its description, its opening paragraph, and every dated measurement in it, so a');
    lines.push('reader outside Claude Code sees the same conventions and the incidents that');
    lines.push('produced them. The `Full text` path is the authority; this is the index.');
    lines.push('');
    if (measurement) {
        lines.push('Why this shape and not the full text or the descriptions alone, measured at');
        lines.push('generation time over the rules on disk:');
        lines.push('');
        lines.push('| variant | bytes | dated claims kept |');
        lines.push('|---|---|---|');
        for (const row of measurement.rows) {
            const mark = row.key === variant ? ' ← emitted' : '';
            lines.push(`| ${row.label}${mark} | ${row.bytes.toLocaleString('en-US')} | ${row.kept} of ${measurement.total} |`);
        }
        lines.push('');
    }
    for (const r of rules) {
        lines.push(renderRule(r, variant));
        lines.push('');
    }
    return lines.join('\n').replace(/\n+$/, '\n');
}

// Everything above the marker is the hand-maintained half. A file with no
// marker yet (first run) is treated as entirely hand-written, which is what it
// is. A missing file gets a one-line placeholder so the shape is visible.
function handSection(outPath) {
    if (!fs.existsSync(outPath)) {
        return '# AGENTS.md\n\n<!-- Hand-maintained section. Everything above the GENERATED marker is kept verbatim. -->\n\n';
    }
    const cur = fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n');
    const i = cur.indexOf(GENERATED_MARKER);
    const hand = i >= 0 ? cur.slice(0, i) : cur;
    return hand.replace(/\s+$/, '') + '\n\n';
}

// Count dated claims the way a reader would: one per body paragraph that carries
// a marker or a date. The same paragraph with two dates is one claim.
function measure(rules) {
    const total = rules.reduce((n, r) => n + r.datedBlocks.length, 0);
    const version = readVersion();
    const rows = [];
    const variants = [
        ['A', 'A  full body'],
        ['B', 'B  description + first paragraph + dated PARAGRAPHS + Never/Always'],
        ['B-LINE', 'B′ same, but dated LINES instead of paragraphs'],
        ['C', 'C  description only'],
    ];
    for (const [key, label] of variants) {
        const text = renderGenerated(rules, key, version, null);
        // Kept = dated paragraphs whose full text survives in the output.
        let kept = 0;
        for (const r of rules) for (const b of r.datedBlocks) if (text.includes(b.trim())) kept++;
        rows.push({ key, label, bytes: Buffer.byteLength(text), kept });
    }
    return { rows, total };
}

function readVersion() {
    if (!fs.existsSync(VERSION_FILE)) throw new Error(`VERSION file missing: ${VERSION_FILE}`);
    const v = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`VERSION is not x.y.z: ${JSON.stringify(v)}`);
    return v;
}

function generate() {
    const { rules, errors } = loadRules();
    if (errors.length) {
        for (const e of errors) console.error('FAIL ' + e);
        console.error(`${errors.length} rule(s) failed to parse; refusing to emit a file with holes in it.`);
        process.exit(1);
    }
    if (rules.length < MIN_RULES) {
        console.error(`FAIL read ${rules.length} rules under ${path.relative(ROOT, RULES_DIR) || '.'}, so nothing was generated.`);
        process.exit(2);
    }
    const version = readVersion();
    const m = measure(rules);
    const text = handSection(OUT) + renderGenerated(rules, VARIANT === 'B' ? 'B' : VARIANT, version, m);
    return { rules, text, m };
}

function diffSummary(a, b) {
    const al = a.split('\n'), bl = b.split('\n');
    let first = -1;
    const n = Math.max(al.length, bl.length);
    for (let i = 0; i < n; i++) if (al[i] !== bl[i]) { first = i; break; }
    const out = [];
    out.push(`  committed: ${al.length} lines, ${Buffer.byteLength(a)} bytes`);
    out.push(`  generated: ${bl.length} lines, ${Buffer.byteLength(b)} bytes`);
    if (first >= 0) {
        out.push(`  first difference at line ${first + 1}:`);
        out.push(`    committed: ${JSON.stringify((al[first] || '').slice(0, 120))}`);
        out.push(`    generated: ${JSON.stringify((bl[first] || '').slice(0, 120))}`);
    }
    return out.join('\n');
}

function main() {
    const modes = ['--measure', '--write', '--check', '--print'].filter(has);
    if (modes.length !== 1) {
        console.error('usage: node tooling/generate-agents-md.js --measure | --write | --check | --print  [--variant A|B|C] [--out FILE]');
        console.error('       (bare invocation does nothing on purpose; say which action you want)');
        return 2;
    }
    const mode = modes[0];
    const { rules, text, m } = generate();
    const relOut = path.relative(ROOT, OUT) || OUT;

    if (mode === '--measure') {
        console.log(`generate-agents-md --measure: ${rules.length} rules read from ${path.relative(ROOT, RULES_DIR)}, `
            + `${rules.reduce((n, r) => n + r.bytes, 0).toLocaleString('en-US')} bytes of SKILL.md, `
            + `${m.total} dated paragraphs (${rules.reduce((n, r) => n + r.datedLines.length, 0)} dated lines)`);
        console.log('');
        console.log('| variant | bytes | dated paragraphs kept |');
        console.log('|---|---|---|');
        for (const row of m.rows) console.log(`| ${row.label} | ${row.bytes.toLocaleString('en-US')} | ${row.kept} of ${m.total} |`);
        console.log('');
        console.log('per rule: bytes, dated paragraphs, dated lines, never/always lines');
        for (const r of rules) console.log(`  ${r.fm.name.padEnd(26)} ${String(r.bytes).padStart(6)}  ${r.datedBlocks.length}  ${r.datedLines.length}  ${r.neverAlways.length}`);
        return 0;
    }
    if (mode === '--print') { process.stdout.write(text); return 0; }
    if (mode === '--write') {
        fs.writeFileSync(OUT, text, 'utf8');
        console.log(`wrote ${relOut}: ${Buffer.byteLength(text).toLocaleString('en-US')} bytes from ${rules.length} rules (variant ${VARIANT})`);
        return 0;
    }
    // --check: regenerate to a temp path, compare with what is on disk.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-check-'));
    const tmp = path.join(tmpDir, 'AGENTS.md');
    try {
        fs.writeFileSync(tmp, text, 'utf8');
        const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
        const generated = fs.readFileSync(tmp, 'utf8');
        if (committed === generated) {
            console.log(`check:agents-md OK — ${relOut} matches ${rules.length} rules under ${SOURCE_GLOB} (${Buffer.byteLength(generated).toLocaleString('en-US')} bytes)`);
            return 0;
        }
        console.error(`check:agents-md STALE — ${relOut} does not match the rules on disk.`);
        console.error(diffSummary(committed, generated));
        console.error('  fix: node tooling/generate-agents-md.js --write   (then commit AGENTS.md)');
        return 1;
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

if (require.main === module) {
    try {
        process.exit(main());
    } catch (e) {
        console.error('FAIL ' + (e && e.message ? e.message : e));
        process.exit(1);
    }
}

module.exports = { parseFrontmatter, toBlocks, distil, GENERATED_MARKER, DATED, NEVER_ALWAYS };
