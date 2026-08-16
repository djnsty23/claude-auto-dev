#!/usr/bin/env node
// check-no-private-names.js — this repo is PUBLIC; private project names are not.
//
// Why this exists, and why it is a denylist rather than a scan:
//
// Four tracked files named three private codebases — one of them a client
// deliverable — alongside their per-repo defect rates. Nothing was secret, and
// that was never the point: a team's defect rate is theirs to publish, and this
// tool had published it for them. Found by asking whether the repo should be
// private, not by anything failing.
//
// The precedent is one of those repos' own preflight, which carries a tripwire
// against verbatim chat quotes in tracked markdown, reasoning "every private
// repo is eventually public". That repo is private and has the guard. This one
// is public and had none.
//
// A GENERIC detector was considered and rejected: "a lowercase word that looks
// like a project name" has no precision at all in a repo full of skill names,
// hook names and CLI flags. A denylist of the names you actually work with is
// small, exact, and the failure mode is benign — you add a name when you start
// a project, and forget one only for a project this repo never discusses.
//
// Extend NAMES when you take on a new private codebase.
//
// Usage: node tooling/check-no-private-names.js [--list]

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Private codebases discussed in this repo's docs, and anything else that
// should never appear in a public artefact. Case-insensitive, word-bounded.
const NAMES = [
    'fitmito',
    'spotivibly',
    'ecommercebenchmark',
    'shopifybenchmark',
    'crobenchmark',
    'omniconvert',
];

// Files that may legitimately carry a name: none today. Kept so an exemption is
// a deliberate, reviewed line rather than a regex someone loosened.
const ALLOW = new Set([
    'tooling/check-no-private-names.js',   // this file IS the list
]);

const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);

if (process.argv.includes('--list')) {
    console.log(NAMES.join('\n'));
    process.exit(0);
}

const re = new RegExp('\\b(' + NAMES.join('|') + ')\\b', 'gi');
const hits = [];

for (const rel of tracked) {
    if (ALLOW.has(rel)) continue;
    const full = path.join(ROOT, rel);
    let src;
    // Binary and unreadable files are not text to scan; skip rather than throw.
    try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (src.includes('\0')) continue;

    const lines = src.split('\n');
    lines.forEach((line, i) => {
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m) hits.push({ rel, ln: i + 1, name: m[1], text: line.trim().slice(0, 90) });
    });
}

if (!hits.length) {
    console.log(`[no-private-names] ${tracked.length} tracked files, ${NAMES.length} names — clean`);
    process.exit(0);
}

console.error(`\n[no-private-names] ${hits.length} occurrence(s) of a private project name in a PUBLIC repo:\n`);
for (const h of hits) console.error(`  ${h.rel}:${h.ln}  (${h.name})\n      ${h.text}`);
console.error(
    '\nAnonymise them (Project A/B/C, keeping the numbers and the product shape), or add a\n'
    + 'reviewed exemption to ALLOW in tooling/check-no-private-names.js.\n'
    + '\nNote: this catches the working tree only. Names already in git history stay there —\n'
    + 'redaction is not removal, and a history rewrite is a separate, deliberate decision.\n'
);
process.exit(1);
