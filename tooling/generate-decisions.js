#!/usr/bin/env node
'use strict';
// generate-decisions.js — one file per decision under docs/decisions/, and
// docs/decisions.md generated from them.
//
// WHY. `docs/decisions.md` said "one entry per decision, newest first", so every
// session recording a decision prepended at the same line, and every PR that
// added an entry conflicted with every other PR that added one.
// `[measured 2026-09-08]` of the 13 open PRs, 6 touched the file; all 15 pairs
// among those 6 conflict, and all 15 conflict ON `docs/decisions.md`. That is a
// complete graph — the file is a single shared insertion point.
//
// The same root cause did worse damage in the filenames beside it. Two sessions
// each created `docs/DECISIONS-2026-09-07.md` on the same day; replaying one
// rename over the other produced a 48 KB weld of two unrelated documents with no
// copy of either original, and every test passed, because a file made of two real
// documents still has resolvable paths and real script names in it. **A date is
// not a name.** So the topic segment here is not decoration: it is the thing that
// makes two sessions' filenames differ, and NAME_RE below rejects a date-only
// name loudly rather than letting the collision happen again.
//
// WHAT IT EMITS. `docs/decisions.md` has two parts, following
// tooling/generate-agents-md.js (#198). Everything ABOVE the GENERATED marker is
// hand-maintained and copied through verbatim. Below it, the entries, newest
// first.
//
// THE GENERATOR NEVER REWRITES ENTRY TEXT. It orders and concatenates, nothing
// else — no reflow, no re-wrap, no heading rewrite. That is deliberate: a
// migration that silently reflows an entry is worse than the churn it fixes, and
// a transform-free generator cannot do it. The property is asserted, not merely
// intended: --verify-split splits the committed file in memory, reassembles it in
// its original order, and byte-compares.
//
// ORDER is (date DESCENDING, then slug ASCENDING). It has to be a total order
// derived only from per-file data, because any shared sequence counter would be a
// new shared insertion point — the defect this replaces. The cost is visible and
// reported by --measure: the committed file is NOT in the order its own header
// claims (entries 1-6 descend, 7-18 ascend), so sorting moves the legacy tail.
// Ordering changes; entry bytes do not.
//
// GATE SHAPE (rule-gate-integrity). --check runs THIS generator against the
// files on disk, writes to a temp path, and compares with what is committed; it
// never regenerates in place and then reads its own output. It asserts a
// population floor separately from the comparison, so an empty or missing
// docs/decisions/ is reported as INERT rather than passing quietly — "no output
// never differs from no output". It refuses a malformed name or a heading whose
// date disagrees with its filename, loudly, rather than emitting a file with
// holes in it.
//
// Usage:
//   node tooling/generate-decisions.js --check          exit 1 with a diff summary if stale
//   node tooling/generate-decisions.js --lint           exit 1 on a welded, empty or duplicated entry
//   node tooling/generate-decisions.js --write          regenerate docs/decisions.md in place
//   node tooling/generate-decisions.js --print          regenerated text to stdout
//   node tooling/generate-decisions.js --measure        entry/byte/order table, no writes
//   node tooling/generate-decisions.js --split          MIGRATION: docs/decisions.md -> docs/decisions/*.md
//   node tooling/generate-decisions.js --verify-split   prove the split is byte-lossless, no writes
//   options: --dir <dir>  --out <file>  --root <dir>  --force (allow --split to overwrite)
//
// Exit: 0 ok · 1 stale, malformed, or a lossless check failed · 2 usage / empty population.

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
    process.exitCode = 0;
    return;
}

const ROOT = path.resolve(val('--root', path.join(__dirname, '..')));
const DIR = path.resolve(ROOT, val('--dir', path.join('docs', 'decisions')));
const OUT = path.resolve(ROOT, val('--out', path.join('docs', 'decisions.md')));

// Population floor, asserted separately from the drift comparison. A fixture dir
// may legitimately hold one entry, so the floor is "at least one" — the point is
// that ZERO must never read as green.
const MIN_ENTRIES = 1;

const GENERATED_MARKER = '<!-- GENERATED BELOW — DO NOT EDIT BY HAND.';

// `<YYYY-MM-DD>-<topic>.md`. The topic group is `+`, not `*`: a date-only name is
// the collision this file exists to prevent, so it must not parse.
const NAME_RE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

// Two heading shapes are already in the corpus: `## <date>: <title>` and
// `## <date> — <title>`. Both are kept verbatim in the entry text; this only
// reads the date and the title out of them.
const HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*(?:[:—–-]\s*)?(.*)$/;

const ENTRY_START = /^##\s+\d{4}-\d{2}-\d{2}/;

// ---------------------------------------------------------------------------
// Split a decisions.md into { preamble, entries }. An entry runs from its `##`
// heading to the line before the next one. Entry text is trimmed of trailing
// blank lines and rejoined with exactly one blank line between entries, which
// reproduces the committed file byte-for-byte — verified, not assumed, by
// --verify-split. See the uniformity check in that mode.
// ---------------------------------------------------------------------------
function splitDocument(src, rel) {
    const text = src.replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const starts = [];
    for (let i = 0; i < lines.length; i++) if (ENTRY_START.test(lines[i])) starts.push(i);
    if (!starts.length) throw new Error(`${rel}: no entry headings matched /^## <YYYY-MM-DD>/`);
    const preamble = lines.slice(0, starts[0]).join('\n').replace(/\s+$/, '') + '\n';
    const entries = [];
    for (let k = 0; k < starts.length; k++) {
        const from = starts[k];
        const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
        const body = lines.slice(from, to).join('\n').replace(/\s+$/, '') + '\n';
        const m = HEADING_RE.exec(lines[from]);
        if (!m) throw new Error(`${rel}:${from + 1}: heading did not parse: ${JSON.stringify(lines[from])}`);
        entries.push({ date: m[1], title: m[2].trim(), text: body, seq: k });
    }
    return { preamble, entries };
}

// ---------------------------------------------------------------------------
// Slug. Deterministic, from the title: lowercase, non-alphanumerics to hyphens,
// then whole words until MAX_SLUG chars. Uniqueness is resolved by taking more
// words and then by a numeric suffix, so the same corpus always slugs the same
// way. The slug is also the tie-break in the sort, which is why it may not
// depend on anything outside the entry.
// ---------------------------------------------------------------------------
const MAX_SLUG = 32;

// Dropped when a title does not fit MAX_SLUG: articles, prepositions, and the
// one-letter residue of possessives and contractions ("a permission rule's fix"
// -> "rule s fix"). NEGATIONS AND VERBS ARE NOT IN THIS LIST — dropping "not"
// from "do not add a cap" would invert the name of the decision.
const SLUG_FILLER = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'that', 'this', 'its', 'it', 's', 't']);

function slugWords(title, dropFiller) {
    const all = String(title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!dropFiller) return all;
    const kept = all.filter((w) => !SLUG_FILLER.has(w));
    return kept.length ? kept : all;
}

function slugify(title, taken) {
    // Full words first; only a title that does not fit loses its filler, so a
    // short title keeps exactly the words its author wrote.
    const full = slugWords(title, false);
    if (!full.length) throw new Error(`cannot slug an empty title`);
    const words = full.join('-').length > MAX_SLUG ? slugWords(title, true) : full;
    let base = '';
    for (const w of words) {
        const next = base ? base + '-' + w : w;
        if (next.length > MAX_SLUG && base) break;
        base = next;
    }
    base = base.replace(/-+$/, '');
    if (!taken) return base;
    if (!taken.has(base)) { taken.add(base); return base; }
    // Collision: grow the slug one WORD at a time first, because a longer name
    // carries more of the topic than a numeric suffix does. Only then fall back
    // to a suffix, so the function is still total.
    const baseWords = base.split('-').length;
    for (let n = baseWords + 1; n <= words.length; n++) {
        const cand = words.slice(0, n).join('-');
        if (!taken.has(cand)) { taken.add(cand); return cand; }
    }
    for (let i = 2; i < 100; i++) {
        const cand = `${base}-${i}`;
        if (!taken.has(cand)) { taken.add(cand); return cand; }
    }
    throw new Error(`could not make a unique slug for ${JSON.stringify(title)}`);
}

// ---------------------------------------------------------------------------
// Load the per-decision files. Every rejection is loud and names the file.
// ---------------------------------------------------------------------------
function loadEntries() {
    if (!fs.existsSync(DIR)) return { entries: [], errors: [], present: false };
    const names = fs.readdirSync(DIR).filter((n) => n.endsWith('.md')).sort();
    const entries = [];
    const errors = [];
    const seenLower = new Map();
    for (const name of names) {
        const rel = path.relative(ROOT, path.join(DIR, name)).split(path.sep).join('/');
        const m = NAME_RE.exec(name);
        if (!m) {
            errors.push(/^\d{4}-\d{2}-\d{2}\.md$/.test(name)
                ? `${rel}: a date is not a name. Two sessions pick the same date; the topic segment is what makes their filenames differ. Rename to <date>-<topic>.md.`
                : `${rel}: filename must be <YYYY-MM-DD>-<topic>.md with a lowercase hyphenated topic.`);
            continue;
        }
        const [, date, slug] = m;
        const prior = seenLower.get(name.toLowerCase());
        if (prior) { errors.push(`${rel}: collides with ${prior} when case is folded, and macOS folds it.`); continue; }
        seenLower.set(name.toLowerCase(), rel);
        const src = fs.readFileSync(path.join(DIR, name), 'utf8').replace(/\r\n/g, '\n');
        const first = src.split('\n')[0];
        const h = HEADING_RE.exec(first || '');
        if (!h) { errors.push(`${rel}: first line must be "## <YYYY-MM-DD>: <title>"; got ${JSON.stringify((first || '').slice(0, 80))}`); continue; }
        if (h[1] !== date) { errors.push(`${rel}: heading date ${h[1]} disagrees with the filename date ${date}.`); continue; }
        if (src.split('\n').filter((l) => ENTRY_START.test(l)).length !== 1) {
            errors.push(`${rel}: holds more than one entry heading. One file, one decision.`);
            continue;
        }
        entries.push({ date, slug, title: h[2].trim(), text: src.replace(/\s+$/, '') + '\n', rel, name });
    }
    return { entries, errors, present: true };
}

// (date DESC, slug ASC). Total, and derived only from per-file data.
function sortEntries(entries) {
    return entries.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

function handSection(outPath) {
    if (!fs.existsSync(outPath)) {
        return '# Decisions\n\nNon-obvious choices, and where the work that implements them actually landed.\n';
    }
    const cur = fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n');
    const i = cur.indexOf(GENERATED_MARKER);
    // No marker yet: the hand-written half is everything before the first entry.
    const hand = i >= 0 ? cur.slice(0, i) : cur.split('\n').slice(0, (() => {
        const ls = cur.split('\n');
        for (let k = 0; k < ls.length; k++) if (ENTRY_START.test(ls[k])) return k;
        return ls.length;
    })()).join('\n');
    return hand.replace(/\s+$/, '') + '\n';
}

function renderGenerated(entries) {
    const lines = [];
    lines.push('');
    lines.push(GENERATED_MARKER);
    lines.push('     Generator: tooling/generate-decisions.js');
    lines.push(`     Source:    docs/decisions/<date>-<topic>.md (${entries.length} entries)`);
    lines.push('     Order:     date descending, then topic slug ascending');
    lines.push('     Add a decision: write a NEW file under docs/decisions/. Never edit below this marker.');
    lines.push('     Regenerate with: node tooling/generate-decisions.js --write');
    lines.push('     Drift gate:      node tooling/generate-decisions.js --check   (npm run check:decisions) -->');
    lines.push('');
    const linkBase = path.relative(path.dirname(OUT), DIR).split(path.sep).join('/');
    for (const e of entries) {
        lines.push(`<!-- ${linkBase}/${e.name} -->`);
        lines.push(e.text.replace(/\n$/, ''));
        lines.push('');
    }
    return lines.join('\n').replace(/\n+$/, '\n');
}

function generate() {
    const { entries, errors, present } = loadEntries();
    if (errors.length) {
        for (const e of errors) console.error('FAIL ' + e);
        console.error(`${errors.length} decision file(s) rejected; refusing to emit a file with holes in it.`);
        process.exitCode = 1;
        return null;
    }
    if (entries.length < MIN_ENTRIES) {
        const where = path.relative(ROOT, DIR) || '.';
        console.error(present
            ? `INERT read 0 entries under ${where}/, so nothing was generated and nothing was checked.`
            : `INERT ${where}/ does not exist, so nothing was generated and nothing was checked. The migration has not been run.`);
        process.exitCode = 2;
        return null;
    }
    const sorted = sortEntries(entries);
    return { entries: sorted, text: handSection(OUT) + renderGenerated(sorted) };
}

function diffSummary(a, b) {
    const al = a.split('\n'), bl = b.split('\n');
    let first = -1;
    for (let i = 0; i < Math.max(al.length, bl.length); i++) if (al[i] !== bl[i]) { first = i; break; }
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

// ---------------------------------------------------------------------------
// --lint: grade the AGGREGATE for the damage a botched conflict resolution
// leaves behind. This runs on the single-file document as it exists today, so it
// is useful BEFORE the migration and after it.
//
// `[measured 2026-09-08]` It was written against a real defect, not a
// hypothetical one. Open PR #208's docs/decisions.md carries the heading
// "## 2026-09-08: the quota wall …" TWICE: once at line 60 with no body under
// it, and once at line 112 welded onto the end of "…with a verified backup
// first." with no newline between them. Markdown renders the welded copy as
// paragraph text, so one decision reads as empty and its body is absorbed into
// the decision above it. Nothing in the repo noticed: the file still resolves
// every path it names and still names real scripts, which is exactly why the
// earlier 48 KB weld passed every test too.
//
// The three findings are separate because they fail separately, and each names
// the line it was decided on.
// ---------------------------------------------------------------------------
// The char before `##` must be neither whitespace (or it IS a heading) nor `#`
// (or an `###` subheading dated in its title matches itself). The date is
// closed with `\b`, NOT `\s`: the real corpus writes `## 2026-09-08: title`
// and `## 2026-08-19 — title`, so requiring whitespace after the date misses
// every colon form — which is the form the one real weld is in. That version
// of this regex went red on PR #208 anyway, on the empty-body finding, and
// reading the exit code instead of the finding would have banked it as proof.
const WELDED_HEADING = /^(.*?[^\s#])(##\s+\d{4}-\d{2}-\d{2}\b)/;

function lint() {
    const rel = path.relative(ROOT, OUT) || OUT;
    if (!fs.existsSync(OUT)) { console.error(`FAIL ${rel} does not exist.`); return 1; }
    const text = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const findings = [];

    // 1. A heading welded into a paragraph. It is not a heading any more, so the
    //    entry it names disappears and its body joins its neighbour.
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
        if (inFence) continue;
        if (ENTRY_START.test(lines[i])) continue;
        const m = WELDED_HEADING.exec(lines[i]);
        if (m) findings.push(`${rel}:${i + 1}: an entry heading is welded into a paragraph, so it does not render as a heading and its entry is absorbed into the one above: ${JSON.stringify(lines[i].slice(Math.max(0, m[1].length - 30), m[1].length + 60))}`);
    }

    // 2. An entry with a heading and no body.
    const { entries } = splitDocument(text, rel);
    for (const e of entries) {
        const body = e.text.split('\n').slice(1).join('\n').trim();
        if (!body) findings.push(`${rel}: entry ${JSON.stringify(e.date + ': ' + e.title)} has a heading and no body.`);
    }

    // 3. The same decision recorded twice.
    const seen = new Map();
    for (const e of entries) {
        const key = e.date + '\u0000' + e.title;
        if (seen.has(key)) findings.push(`${rel}: entry ${JSON.stringify(e.date + ': ' + e.title)} appears more than once.`);
        else seen.set(key, e);
    }

    // The count comes after the work and names what was read, so an empty scan
    // is visible instead of reassuring (rule-gate-integrity 2).
    if (entries.length < MIN_ENTRIES) { console.error(`INERT ${rel}: 0 entries parsed, so nothing was linted.`); return 2; }
    if (findings.length) {
        for (const f of findings) console.error('FAIL ' + f);
        console.error(`lint:decisions — ${findings.length} finding(s) over ${entries.length} entries, ${lines.length} lines of ${rel}.`);
        return 1;
    }
    console.log(`lint:decisions OK — ${entries.length} entries, ${lines.length} lines of ${rel}: no welded headings, no empty entries, no duplicates.`);
    return 0;
}

// ---------------------------------------------------------------------------
// --verify-split: the losslessness proof. Split the committed document in
// memory, reassemble it in its ORIGINAL order, and byte-compare. This grades the
// parse/serialise round trip against the real file, not against a fixture, and
// it writes nothing.
// ---------------------------------------------------------------------------
function verifySplit() {
    const rel = path.relative(ROOT, OUT) || OUT;
    if (!fs.existsSync(OUT)) { console.error(`FAIL ${rel} does not exist.`); return 1; }
    const original = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    const { preamble, entries } = splitDocument(original, rel);
    if (entries.length < MIN_ENTRIES) { console.error(`INERT ${rel}: 0 entries parsed.`); return 2; }
    const rebuilt = [preamble.replace(/\s+$/, ''), ...entries.map((e) => e.text.replace(/\s+$/, ''))].join('\n\n') + '\n';
    const ok = rebuilt === original;
    console.log(`verify-split: ${rel} -> ${entries.length} entries -> reassembled in original order`);
    console.log(`  original:    ${Buffer.byteLength(original)} bytes, ${original.split('\n').length} lines`);
    console.log(`  reassembled: ${Buffer.byteLength(rebuilt)} bytes, ${rebuilt.split('\n').length} lines`);
    console.log(`  byte-identical: ${ok ? 'YES' : 'NO'}`);
    if (!ok) { console.error(diffSummary(original, rebuilt)); return 1; }
    // The ordering delta, reported rather than hidden: the shipped order is
    // (date desc, slug asc) and the committed file is not in it.
    const taken = new Set();
    const withSlug = entries.map((e) => ({ ...e, slug: slugify(e.title, taken) }));
    const sorted = sortEntries(withSlug);
    let moved = 0;
    for (let i = 0; i < sorted.length; i++) if (sorted[i].seq !== withSlug[i].seq) moved++;
    console.log(`  entries whose position changes under (date desc, slug asc): ${moved} of ${entries.length}`);
    console.log(`  entry bytes changed by the reorder: 0 (the generator concatenates; it never rewrites entry text)`);
    return 0;
}

// ---------------------------------------------------------------------------
// --split: the migration. Reads the committed document, writes one file per
// entry, then re-reads them and asserts the set on disk equals the set parsed.
// It refuses to overwrite without --force and it deletes nothing.
// ---------------------------------------------------------------------------
function split() {
    const rc = verifySplit();
    if (rc !== 0) { console.error('FAIL refusing to split a document that does not round-trip.'); return rc; }
    const rel = path.relative(ROOT, OUT) || OUT;
    const original = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    const { entries } = splitDocument(original, rel);
    const taken = new Set();
    const planned = entries.map((e) => {
        const slug = slugify(e.title, taken);
        return { ...e, slug, name: `${e.date}-${slug}.md` };
    });
    for (const p of planned) {
        if (!NAME_RE.test(p.name)) { console.error(`FAIL planned name is not <date>-<topic>.md: ${p.name}`); return 1; }
    }
    fs.mkdirSync(DIR, { recursive: true });
    const existing = new Set(fs.readdirSync(DIR).filter((n) => n.endsWith('.md')));
    const clashes = planned.filter((p) => existing.has(p.name)).map((p) => p.name);
    if (clashes.length && !has('--force')) {
        console.error(`FAIL ${clashes.length} target file(s) already exist: ${clashes.join(', ')}`);
        console.error('  pass --force to overwrite, having checked they hold nothing you need.');
        return 1;
    }
    for (const p of planned) fs.writeFileSync(path.join(DIR, p.name), p.text, 'utf8');
    // Read back and assert the disk equals the parse. A write that dropped an
    // entry must not be able to report success.
    const back = loadEntries();
    if (back.errors.length) { for (const e of back.errors) console.error('FAIL ' + e); return 1; }
    const wrote = new Map(planned.map((p) => [p.name, p.text]));
    let mismatched = 0;
    for (const [name, text] of wrote) {
        const got = back.entries.find((e) => e.name === name);
        if (!got || got.text !== text) { console.error(`FAIL read-back mismatch for ${name}`); mismatched++; }
    }
    if (mismatched) return 1;
    const parsedBytes = planned.reduce((n, p) => n + Buffer.byteLength(p.text), 0);
    console.log(`split ${rel}: wrote ${planned.length} files under ${path.relative(ROOT, DIR)}/, ${parsedBytes} bytes of entry text, read back byte-identical`);
    for (const p of planned) console.log(`  ${p.name}`);
    console.log('next: node tooling/generate-decisions.js --write   (regenerates docs/decisions.md from them)');
    return 0;
}

function measure() {
    const { entries, errors, present } = loadEntries();
    if (errors.length) { for (const e of errors) console.error('FAIL ' + e); return 1; }
    const where = path.relative(ROOT, DIR) || '.';
    if (!entries.length) {
        console.log(`measure: ${present ? `0 entries under ${where}/` : `${where}/ does not exist`} — the migration has not been run.`);
        const rel = path.relative(ROOT, OUT) || OUT;
        if (fs.existsSync(OUT)) {
            const { entries: inFile } = splitDocument(fs.readFileSync(OUT, 'utf8'), rel);
            const dates = inFile.map((e) => e.date);
            const desc = dates.every((d, i) => i === 0 || dates[i - 1] >= d);
            console.log(`  ${rel} holds ${inFile.length} entries in one file, ${Buffer.byteLength(fs.readFileSync(OUT, 'utf8'))} bytes`);
            console.log(`  its header claims newest-first; measured over the file: ${desc ? 'true' : 'FALSE'}`);
            if (!desc) {
                const breaks = [];
                for (let i = 1; i < dates.length; i++) if (dates[i - 1] < dates[i]) breaks.push(`${i} (${dates[i - 1]} then ${dates[i]})`);
                console.log(`  ascending steps at entry index: ${breaks.join(', ')}`);
            }
        }
        return 0;
    }
    const sorted = sortEntries(entries);
    const bytes = sorted.reduce((n, e) => n + Buffer.byteLength(e.text), 0);
    console.log(`measure: ${entries.length} entries under ${where}/, ${bytes} bytes of entry text`);
    console.log(`  generated ${path.relative(ROOT, OUT)}: ${Buffer.byteLength(handSection(OUT) + renderGenerated(sorted))} bytes`);
    console.log('');
    console.log('| # | date | slug | bytes |');
    console.log('|---|---|---|---|');
    sorted.forEach((e, i) => console.log(`| ${i + 1} | ${e.date} | ${e.slug} | ${Buffer.byteLength(e.text)} |`));
    return 0;
}

function main() {
    const modes = ['--measure', '--write', '--check', '--print', '--split', '--verify-split', '--lint'].filter(has);
    if (modes.length !== 1) {
        console.error('usage: node tooling/generate-decisions.js --check | --lint | --write | --print | --measure | --split | --verify-split');
        console.error('       (bare invocation does nothing on purpose; say which action you want)');
        return 2;
    }
    const mode = modes[0];
    if (mode === '--lint') return lint();
    if (mode === '--verify-split') return verifySplit();
    if (mode === '--split') return split();
    if (mode === '--measure') return measure();

    const g = generate();
    if (!g) return process.exitCode || 1;
    const relOut = path.relative(ROOT, OUT) || OUT;

    if (mode === '--print') { process.stdout.write(g.text); return 0; }
    if (mode === '--write') {
        fs.writeFileSync(OUT, g.text, 'utf8');
        console.log(`wrote ${relOut}: ${Buffer.byteLength(g.text)} bytes from ${g.entries.length} entries`);
        return 0;
    }
    // --check: regenerate to a temp path and compare. Never in place.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-check-'));
    const tmp = path.join(tmpDir, 'decisions.md');
    try {
        fs.writeFileSync(tmp, g.text, 'utf8');
        const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
        const generated = fs.readFileSync(tmp, 'utf8');
        if (committed === generated) {
            console.log(`check:decisions OK — ${relOut} matches ${g.entries.length} entries under ${path.relative(ROOT, DIR)}/ (${Buffer.byteLength(generated)} bytes)`);
            return 0;
        }
        console.error(`check:decisions STALE — ${relOut} does not match the entries on disk.`);
        console.error(diffSummary(committed, generated));
        console.error('  fix: node tooling/generate-decisions.js --write   (then commit docs/decisions.md)');
        return 1;
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

if (require.main === module) {
    try {
        // process.exitCode, never process.exit(): on darwin stdout to a PIPE is
        // async, and process.exit() after a large write delivers exactly 65536
        // bytes and exits 0. --print emits the whole document.
        const rc = main();
        if (rc) process.exitCode = rc;
    } catch (e) {
        console.error('FAIL ' + (e && e.message ? e.message : e));
        process.exitCode = 1;
    }
}

module.exports = { splitDocument, slugify, sortEntries, loadEntries, lint, WELDED_HEADING, NAME_RE, HEADING_RE, GENERATED_MARKER, MIN_ENTRIES };
