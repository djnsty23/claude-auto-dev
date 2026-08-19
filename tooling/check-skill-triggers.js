#!/usr/bin/env node
// check-skill-triggers.js — a skill description is a TRIGGER, not a summary.
//
// The model never reads a skill until it decides to. All it sees beforehand is
// the name and the description, so the description's only job is to fire the
// skill at the right moment. A description that reads as a category label
// ("Handles deployment") gives the model nothing to match a situation against;
// it loads on vibes, or never.
//
// Every description is resident in context for every session on this machine,
// so the set has a standing cost whether or not any skill is ever used. This
// prints that cost alongside the classification, because "add another skill" is
// usually discussed as free.
//
// Heuristic, deliberately: it flags candidates and prints them for a human to
// judge, rather than pretending to grade prose. Read the flagged lines.
//
// Usage: node tooling/check-skill-triggers.js [--all]

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'plugins');
const SHOW_ALL = process.argv.includes('--all');

// Words that name a CONDITION — the thing that makes a description matchable
// against a situation the model is actually in.
const CONDITION_MARKERS = [
    'use when', 'load when', 'load before', 'load it', 'the moment', 'whenever',
    'when ', 'before ', 'after ', 'if the', 'if you', 'triggers', 'trigger',
];

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name === 'SKILL.md') out.push(p);
    }
    return out;
}

function frontmatter(text) {
    if (!text.startsWith('---')) return null;
    const end = text.indexOf('\n---', 3);
    if (end === -1) return null;
    const block = text.slice(3, end);
    const out = {};
    let key = null;
    for (const line of block.split('\n')) {
        const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
        if (m) { key = m[1]; out[key] = m[2].trim(); }
        else if (key && line.trim()) out[key] += ' ' + line.trim();
    }
    return out;
}

const files = walk(ROOT);
const rows = [];
let bytes = 0;

for (const f of files) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const fm = frontmatter(text);
    if (!fm || !fm.description) continue;
    const desc = fm.description.replace(/^["']|["']$/g, '');
    const whenToUse = (fm.when_to_use || '').replace(/^["']|["']$/g, '');
    const combined = (desc + ' ' + whenToUse).toLowerCase();
    bytes += desc.length + whenToUse.length;
    rows.push({
        name: fm.name || path.basename(path.dirname(f)),
        desc,
        len: desc.length,
        hasCondition: CONDITION_MARKERS.some((m) => combined.includes(m)),
        hasWhenToUse: Boolean(whenToUse),
    });
}

rows.sort((a, b) => a.name.localeCompare(b.name));
const label = rows.filter((r) => !r.hasCondition);
const long = rows.filter((r) => r.len > 320);

console.log(`skill trigger audit — ${rows.length} skills with a description`);
console.log(`standing context cost: ${bytes} bytes of description + when_to_use, resident every session`);
console.log(`  roughly ${Math.round(bytes / 4)} tokens, paid whether or not a single skill loads\n`);

console.log(`names no condition (loads on vibes, or never): ${label.length} of ${rows.length}`);
for (const r of label) console.log(`  ${r.name.padEnd(28)} ${r.desc.slice(0, 96)}`);

console.log(`\noverlong (>320 chars, crowds every other description): ${long.length}`);
for (const r of long) console.log(`  ${r.name.padEnd(28)} ${r.len} chars`);

const noWhen = rows.filter((r) => !r.hasWhenToUse);
console.log(`\nno when_to_use field: ${noWhen.length} of ${rows.length}`);

if (SHOW_ALL) {
    console.log('\nall descriptions:');
    for (const r of rows) console.log(`  ${r.hasCondition ? 'T' : ' '} ${r.name.padEnd(28)} ${r.desc.slice(0, 90)}`);
}
