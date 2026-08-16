#!/usr/bin/env node
// find-orphan-checks.js — find verification code that nothing runs.
//
// The failure shape, in one production repo's own words:
//
//   "THE OTHER 60 GATES, which nothing ran ... two had been failing since
//    2026-07-22 ... the only thing in the repo that objected was a harness
//    nobody ran, and it objected for eight days."
//
// A check nobody runs is worse than no check: it reads as coverage. This finds
// scripts that assert something and are reachable from no runner.
//
// Usage: node find-orphan-checks.js [repo] [--json] [--all]
//        --all  also list non-assertion scripts (one-off migrations etc.)
//
// Read-only. Pure Node, no dependencies.
//
// TWO WAYS THIS ANALYSIS GETS IT WRONG, both found by running it for real:
//
//   1. A script referenced exactly once — from package.json and nowhere else —
//      looks unreferenced if you discount a "self-mention" that most files do
//      not actually contain. Exclude the file's own text instead of subtracting.
//   2. Test runners include files by GLOB, not by name. `vite.config.ts` with
//      include: ["scripts/**/*.test.mjs"] runs a file whose name appears
//      nowhere. Name-only search reported five such files as abandoned when
//      every one of them ran on every CI build.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const REPO = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
const asJson = args.includes('--json');
const showAll = args.includes('--all');

const SCRIPT_DIRS = ['scripts', 'tools', 'bin', 'tooling'];
const CODE_EXT = /\.(mjs|cjs|js|ts|tsx)$/;

function walk(dir, base = '') {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const rel = path.join(base, e.name);
        if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
        else if (CODE_EXT.test(e.name)) out.push(rel);
    }
    return out;
}

// ---- the scripts under consideration
const scripts = [];
for (const d of SCRIPT_DIRS) {
    const full = path.join(REPO, d);
    if (fs.existsSync(full)) for (const f of walk(full)) scripts.push(path.join(d, f));
}

if (!scripts.length) {
    const msg = `No script directories found in ${REPO} (looked for ${SCRIPT_DIRS.join(', ')}).`;
    console.log(asJson ? JSON.stringify({ error: msg }) : msg);
    process.exit(0);
}

// ---- callers: everything that could invoke a script by name
const callers = [];
const addFile = (p) => { try { callers.push(fs.readFileSync(p, 'utf8')); } catch {} };

addFile(path.join(REPO, 'package.json'));
for (const dir of ['.github/workflows', '.github', '.circleci']) {
    const full = path.join(REPO, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
        if (/\.(ya?ml)$/.test(f)) addFile(path.join(full, f));
    }
}
for (const f of ['Makefile', 'justfile', 'Taskfile.yml', 'vercel.json', 'netlify.toml']) {
    const full = path.join(REPO, f);
    if (fs.existsSync(full)) addFile(full);
}

// ---- glob includes from test-runner configs (see failure mode 2 above)
const CONFIG_FILES = fs.readdirSync(REPO).filter((f) =>
    /^(vite|vitest|jest|playwright|karma)\.config\.[cm]?[jt]s$/.test(f) || f === 'jest.config.json'
);
const includeGlobs = [];
for (const f of CONFIG_FILES) {
    let text;
    try { text = fs.readFileSync(path.join(REPO, f), 'utf8'); } catch { continue; }
    // include: [...] / testMatch: [...] / testRegex
    for (const m of text.matchAll(/(?:include|testMatch|testPathPatterns)\s*:\s*\[([^\]]*)\]/g)) {
        for (const g of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) includeGlobs.push(g[1]);
    }
}
// package.json jest config too
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    for (const g of (pkg.jest && pkg.jest.testMatch) || []) includeGlobs.push(g);
} catch {}

function globToRe(glob) {
    const T = { DIRSTAR: '\u0001', STARSTAR: '\u0002', STAR: '\u0003', OPEN: '\u0004', CLOSE: '\u0005', SEP: '\u0006' };

    let s = glob
        .replace(/\*\*\//g, T.DIRSTAR)
        .replace(/\*\*/g, T.STARSTAR)
        .replace(/\*/g, T.STAR)
        .replace(/\{/g, T.OPEN)
        .replace(/\}/g, T.CLOSE)
        .replace(/,/g, T.SEP);

    s = s.replace(/[.+^|[\]\\?]/g, '\\$&');

    s = s
        .split(T.DIRSTAR).join('(?:[^/]+/)*')
        .split(T.STARSTAR).join('.*')
        .split(T.STAR).join('[^/]*')
        .split(T.OPEN).join('(')
        .split(T.CLOSE).join(')')
        .split(T.SEP).join('|');

    return new RegExp('^' + s + '$');
}

const includeRes = includeGlobs.map(globToRe);

// ---- does the file assert anything? A migration is not a gate.
const ASSERTION = /\b(assert|expect|describe\s*\(|\bit\s*\(|test\s*\(|should|throw new Error|process\.exit\(1\)|fail\(|✗|FAIL)\b/;
const ONE_OFF = /^(migrate|import|export|backfill|seed|fix|push|resync|create|setup|gen)[-.]/i;

const results = scripts.map((s) => {
    const abs = path.join(REPO, s);
    const own = fs.readFileSync(abs, 'utf8');
    const base = path.basename(s);

    // Referenced by name anywhere EXCEPT its own text (failure mode 1).
    const others = callers.concat(
        scripts.filter((x) => x !== s).map((x) => {
            try { return fs.readFileSync(path.join(REPO, x), 'utf8'); } catch { return ''; }
        })
    ).join('\n');
    const byName = others.includes(base);

    // Matched by a runner's include glob (failure mode 2).
    const posix = s.split(path.sep).join('/');
    const byGlob = includeRes.some((re) => re.test(posix));

    return {
        script: posix,
        referenced: byName || byGlob,
        via: byName ? 'name' : byGlob ? 'glob' : null,
        asserts: ASSERTION.test(own),
        oneOff: ONE_OFF.test(base),
        lines: own.split('\n').length,
    };
});

const orphanChecks = results.filter((r) => !r.referenced && r.asserts && !r.oneOff);
const orphanOther = results.filter((r) => !r.referenced && (!r.asserts || r.oneOff));

if (asJson) {
    console.log(JSON.stringify({
        repo: REPO, total: results.length,
        includeGlobs,
        orphanChecks, orphanOther: showAll ? orphanOther : undefined,
    }, null, 2));
    process.exit(orphanChecks.length ? 1 : 0);
}

console.log(`\n${path.basename(REPO)} — ${results.length} scripts`);
if (includeGlobs.length) console.log(`  runner include globs honoured: ${includeGlobs.join(', ')}`);
console.log(`  reachable from a runner: ${results.filter((r) => r.referenced).length}`);
console.log(`  orphaned ASSERTIONS:     ${orphanChecks.length}`);
console.log(`  orphaned one-offs:       ${orphanOther.length}${showAll ? '' : '  (--all to list)'}\n`);

if (orphanChecks.length) {
    console.log('Verification code that NOTHING runs — wire it or delete it:');
    orphanChecks.forEach((r) => console.log(`  ✗ ${r.script}  (${r.lines} lines)`));
    console.log('\nA check nobody runs is worse than no check: it reads as coverage.');
} else {
    console.log('Every assertion in this repo is reachable from a runner.');
}

if (showAll && orphanOther.length) {
    console.log('\nUnreferenced non-assertion scripts (usually one-off migrations — fine to keep):');
    orphanOther.forEach((r) => console.log(`  · ${r.script}`));
}

process.exit(orphanChecks.length ? 1 : 0);
