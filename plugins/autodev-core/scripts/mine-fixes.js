#!/usr/bin/env node
// mine-fixes.js — rank the failure classes THIS project actually ships.
//
// A `fix` commit touching a file a `feat`/`refactor` commit changed in the
// previous few days is not maintenance: it is the feature having shipped
// broken. Cluster those by stated root cause and you get an evidence-ranked
// list of what to gate, instead of inheriting someone else's checklist.
//
// Usage: node mine-fixes.js [repo-path] [--json] [--window-days N]
//
// Pure Node, no dependencies, read-only. Never writes to the repo.

const { execSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const repo = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
const asJson = args.includes('--json');
const windowDays = Number((args.find((a) => a.startsWith('--window-days=')) || '').split('=')[1]) || 3;

function git(a) {
    return execSync(`git ${a}`, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

// NUL record separator: --name-only puts a blank line between the format line
// and the file list, so splitting on a blank line mis-frames every record.
let RAW;
try {
    RAW = git('log --format=%x00%H%x01%ct%x01%s --name-only --no-merges');
} catch (e) {
    console.error(`Not a git repository, or git failed: ${repo}`);
    process.exit(1);
}

const all = [];
for (const rec of RAW.split('\x00')) {
    if (!rec.trim()) continue;
    const lines = rec.split('\n');
    // The subject is everything AFTER the second separator, rejoined.
    //
    // This destructured three fields, and git preserves a literal 0x01 inside a
    // commit subject — measured, not assumed. Such a subject split into four or
    // more parts, the destructure kept three, and everything past the embedded
    // byte was discarded. The record was not dropped, which is what made it
    // quiet: it still counted as a fix and as rework, but its truncated subject
    // matched no class, so it vanished from the ranking while inflating the
    // totals the ranking is read against.
    //
    // The whole job of this script is deciding which failure class a project
    // builds a gate for. A record that counts but cannot be classified moves the
    // wrong class to the top, and that is not visible in the output.
    const parts = lines[0].split('\x01');
    const hash = parts[0];
    const ts = parts[1];
    const subject = parts.slice(2).join('\x01');
    if (!hash) continue;
    all.push({ hash, ts: Number(ts), subject: subject || '', files: lines.slice(1).filter(Boolean) });
}
all.reverse();

// Commits that record application data rather than engineering work would
// otherwise drown the signal. Tune this if a project uses other prefixes.
const DATA_COMMIT = /^(checkoffs|plate|nudge|vice|stats|profile|plan|coach|distribution|weight|sleep|mood|backup|mirror|snapshot)\b/i;
const commits = all.filter((c) => !DATA_COMMIT.test(c.subject));

const typeOf = (s) => {
    const m = s.match(/^(\w+)(\([^)]*\))?!?:/);
    return m ? m[1].toLowerCase() : '(none)';
};

const feats = commits.filter((c) => ['feat', 'refactor'].includes(typeOf(c.subject)));
const fixes = commits.filter((c) => typeOf(c.subject) === 'fix');

if (fixes.length === 0) {
    const msg = 'No conventional `fix:` commits found — this analysis needs conventional commit subjects.';
    if (asJson) console.log(JSON.stringify({ error: msg, commits: commits.length }));
    else console.log(msg);
    process.exit(0);
}

// ---- Rework: a fix landing on code a feature just touched
const DAY = 86400;
const WINDOW = windowDays * DAY;
const rework = [];
const reworkFiles = {};
for (const fix of fixes) {
    const ff = new Set(fix.files);
    const cause = feats.find(
        (f) => f.ts < fix.ts && fix.ts - f.ts < WINDOW && f.files.some((x) => ff.has(x))
    );
    if (cause) {
        rework.push({ fix: fix.subject, hash: fix.hash.slice(0, 8), introducedBy: cause.subject });
        for (const f of fix.files) if (cause.files.includes(f)) reworkFiles[f] = (reworkFiles[f] || 0) + 1;
    }
}

// ---- Structural failure classes. These are the eight in rule-ramifications.
const CLASSES = [
    ['ordering / async race', /\b(race|order|before|after|await|defer|boot|init|mount|timing|too early|too late|concurrent|parallel)\b/i],
    ['unhandled state in a flow', /\b(empty state|first[- ]run|cold start|no data|blank|loading state|error state|offline|logged.?out|returning|second (visit|run)|edge case|missing|never)\b/i],
    ['cache / key scoping', /\b(cache key|keyed by|per[- ](user|account|tenant|locale)|invalidat|stale|memo(iz)?e|revalidat|swr|tenant)\b/i],
    ['duplicated derivation', /\b(single[- ]source|one home|disagree|drift(ed|ing)?|two sources|both places|in \w+ places|duplicat|recompute)\b/i],
    ['units / references / formats', /\b(unit|percent|ref(erence)? value|rounding|precision|currency|locale|format|timezone|utc|midnight|dst)\b/i],
    ['lifecycle not cleaned up', /\b(cleanup|unsubscrib|dispose|teardown|leak|stacked|duplicate (listener|loop|interval|timer)|raf|removeeventlistener|abort)\b/i],
    ['cross-surface consistency', /\b(every(where| surface| view| screen)|all (views|screens|surfaces|tabs)|other (view|screen|page)|sibling|the same (value|number|label)|parity)\b/i],
    ['config / env targeting', /\b(wrong (project|env|key|url|bucket|table)|prod(uction)? vs|staging|env var|point(ed|s)? at)\b/i],
    ['copy / i18n drift', /\b(copy|wording|typo|placeholder|microcopy|translat|i18n|locale key|string)\b/i],
    ['reachability / dead path', /\b(unreachable|dead|never (fires|runs|called|rendered)|no-?op|orphan|not wired|nested inside)\b/i],
];

const classCounts = {};
const classExamples = {};
for (const r of rework) {
    for (const [name, re] of CLASSES) {
        if (re.test(r.fix)) {
            classCounts[name] = (classCounts[name] || 0) + 1;
            (classExamples[name] = classExamples[name] || []).push(r.fix.slice(0, 110));
        }
    }
}

const ranked = Object.entries(classCounts).sort((a, b) => b[1] - a[1]);

if (asJson) {
    console.log(JSON.stringify({
        repo,
        commits: commits.length,
        feats: feats.length,
        fixes: fixes.length,
        fixesPerFeature: Number((fixes.length / Math.max(feats.length, 1)).toFixed(2)),
        reworkCount: rework.length,
        reworkPct: Math.round(rework.length / fixes.length * 100),
        classes: ranked.map(([name, count]) => ({ name, count, examples: (classExamples[name] || []).slice(0, 3) })),
        hotFiles: Object.entries(reworkFiles).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, count]) => ({ file, count })),
    }, null, 2));
    process.exit(0);
}

const line = '='.repeat(70);
console.log(`\n${line}\n${path.basename(repo)} — ${commits.length} engineering commits\n${line}`);
console.log(`\n  ${fixes.length} fixes : ${feats.length} features  =  ${(fixes.length / Math.max(feats.length, 1)).toFixed(2)} fixes per feature`);
console.log(`  ${rework.length} of them (${Math.round(rework.length / fixes.length * 100)}%) landed on code a feature touched in the previous ${windowDays} days.`);
console.log('  Those are first-pass failures, not maintenance.\n');

if (!commits.length) {
    // Nothing was read, so nothing can be concluded. Without this, an empty
    // window and a project that genuinely never fails print the same line.
    console.log('  COULD NOT CLASSIFY: 0 engineering commits in the window.');
    console.log('  The probe is blind, not the history clean. Widen --days or check the repo path.');
} else if (!ranked.length) {
    console.log(`  No failure class matched across ${commits.length} commit(s) — subjects may be too terse to classify.`);
} else {
    const max = ranked[0][1];
    console.log('What this project actually gets wrong:\n');
    for (const [name, count] of ranked) {
        const bar = '█'.repeat(Math.max(1, Math.round(count / max * 28)));
        console.log(`  ${String(count).padStart(4)}  ${name.padEnd(28)} ${bar}`);
    }
    console.log('\nExamples:');
    for (const [name] of ranked.slice(0, 4)) {
        console.log(`\n  [${name}]`);
        (classExamples[name] || []).slice(0, 3).forEach((s) => console.log(`    · ${s}`));
    }
}

const hot = Object.entries(reworkFiles).sort((a, b) => b[1] - a[1]).slice(0, 8);
if (hot.length) {
    console.log('\nFiles most often fixed right after a feature touched them:');
    hot.forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}`));
}

console.log('\nThe top classes are the ones worth an executable gate. A checklist');
console.log('nobody runs changes nothing — see docs/failure-evidence.md.\n');
