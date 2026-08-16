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

// Tracked files PLUS untracked-but-not-ignored ones.
//
// `git ls-files` alone was the gap, and it let a real leak through the same day
// this file shipped: a handoff doc naming all three private repos was written,
// `validate.js` was run and passed, and only THEN was the file `git add`ed and
// pushed to the public remote. The check could not see it, because it was not
// tracked yet — which is precisely the moment a new file needs checking. The
// window is every new file, every time, and it closed only after the push.
//
// `--others --exclude-standard` adds untracked files while still honouring
// .gitignore, so scratch and build output stay out.
// Returns [] rather than throwing when git is unavailable or this is not a work
// tree. The throw was worse than the false pass it replaced: an uncaught
// ENOENT/fatal killed the script before the population floor below could give a
// readable refusal, so the failure mode was a stack trace instead of an answer.
const listed = (args) => {
    try {
        return execSync(`git ls-files ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\n').filter(Boolean);
    } catch { return []; }
};
const tracked = [...new Set([...listed(''), ...listed('--others --exclude-standard')])];

// POPULATION FLOOR. `git ls-files` returning nothing — run outside a work tree,
// a broken git, an empty index — would make this report "0 files, clean" and
// exit 0. A false all-clear on a PUBLIC repo is the one answer this check must
// never give, and it is indistinguishable from a real pass in the output.
if (!tracked.length && !process.argv.includes('--list')) {
    console.error('\n[no-private-names] REFUSING: git listed 0 files.\n');
    console.error('This check cannot clear a repo it could not read. Verify you are inside the');
    console.error('work tree and that `git ls-files` returns something.\n');
    process.exit(1);
}

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
    console.log(`[no-private-names] ${tracked.length} files (tracked + untracked), ${NAMES.length} names — clean`);
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
