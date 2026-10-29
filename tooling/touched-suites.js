#!/usr/bin/env node
'use strict';
// touched-suites.js: which tooling/test-*.js suites read a file the diff touched.
//
// WHY. gate:fast defers `npm test`, so a PR that edits a file a suite grades merges
// without that suite running. #425 did exactly that: it edited tooling/gate-lock.js,
// whose text a critical mutant in tooling/fixtures/gate-evidence/ anchors on, and
// test-gate-evidence.js went red on main. This selects every suite whose REACH holds
// a touched file, so gate:fast can run them.
//
// A suite's reach is a set of tracked files, built statically:
//   1. the suite itself;
//   2. every tracked file a string literal in the suite names, by repo path or by
//      basename (a basename shared by several files reaches all of them);
//   3. every file under tooling/fixtures/<d> when the suite names '<d>', and every
//      file under a literal multi-segment directory path ('plugins/x/skills');
//   4. the same literals inside a fixture file it reaches (a mutant names its file);
//   5. closed over require(): every module a reached .js file requires, by a
//      relative path or a basename literal inside the require call.
// Step 5 follows require edges only, never every name a module mentions, so a hub
// module does not pull the whole tree in.
//
// What it cannot see: a path built from a variable or a bare directory name
// ('skills') and walked at run time. Such a suite is selected only through a file
// it names. Selection is a floor on what must run, never a claim that the rest is
// unaffected: the full gate still runs every suite before a release.
//
//   node tooling/touched-suites.js [--root DIR] [--base REF] [--json]
//
// Exit 0 with the selection printed, 2 when the base or the file list cannot be read.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LITERAL = /(['"`])([^'"`\r\n]{2,240}?)\1/g;
const REQUIRE = /require\(([^)]*)\)/g;
const TEXT_MAX = 2 * 1024 * 1024;

function git(root, args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return !r.error && r.status === 0 ? r.stdout : null;
}

function readText(root, rel) {
    try {
        const p = path.join(root, rel);
        if (fs.statSync(p).size > TEXT_MAX) return '';
        return fs.readFileSync(p, 'utf8');
    } catch { return ''; }
}

/** Index of the tracked tree: paths, basenames, directory prefixes. */
function indexTree(files) {
    const set = new Set(files);
    const byBase = new Map();
    const dirs = new Map(); // dir -> files under it
    for (const f of files) {
        const b = f.slice(f.lastIndexOf('/') + 1);
        if (!byBase.has(b)) byBase.set(b, []);
        byBase.get(b).push(f);
        const parts = f.split('/');
        for (let i = 1; i < parts.length; i++) {
            const d = parts.slice(0, i).join('/');
            if (!dirs.has(d)) dirs.set(d, []);
            dirs.get(d).push(f);
        }
    }
    return { set, byBase, dirs };
}

/** Tracked files one string literal names. */
function resolveLiteral(lit, idx, fromDir) {
    const s = lit.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!s || /\s/.test(s)) return [];
    if (s.includes('/')) {
        const rel = fromDir && /^\.\.?\//.test(lit) ? path.posix.normalize(path.posix.join(fromDir, lit.replace(/\\/g, '/'))) : s.replace(/^\/+/, '');
        for (const c of [rel, `${rel}.js`]) if (idx.set.has(c)) return [c];
        if (rel.split('/').length >= 2 && idx.dirs.has(rel)) return idx.dirs.get(rel);
        return [];
    }
    if (/\.[A-Za-z0-9]{1,5}$/.test(s) && idx.byBase.has(s)) return idx.byBase.get(s);
    const fixtures = idx.dirs.get(`tooling/fixtures/${s}`);
    return fixtures || [];
}

function literalsOf(text) {
    const out = [];
    for (const m of text.matchAll(LITERAL)) out.push(m[2]);
    return out;
}

/** Modules a .js file requires: relative paths and basename literals inside require(). */
function requiresOf(text, rel, idx) {
    const out = [];
    const dir = path.posix.dirname(rel);
    for (const m of text.matchAll(REQUIRE)) {
        for (const lit of literalsOf(m[1])) {
            if (/^\.\.?\//.test(lit)) {
                const p = path.posix.normalize(path.posix.join(dir, lit));
                for (const c of [p, `${p}.js`, `${p}/index.js`]) if (idx.set.has(c)) { out.push(c); break; }
            } else if (/\.js(on)?$/.test(lit) && idx.byBase.has(lit)) {
                out.push(...idx.byBase.get(lit));
            }
        }
    }
    return out;
}

/** The reach of one suite: a Set of tracked paths. */
function reachOf(root, suite, idx) {
    const reach = new Set([suite]);
    const named = (text, fromDir) => literalsOf(text).flatMap((l) => resolveLiteral(l, idx, fromDir));
    const first = named(readText(root, suite), path.posix.dirname(suite));
    for (const f of first) reach.add(f);
    // Fixture files name further files (a mutant's "file"), one hop.
    for (const f of first.filter((x) => x.startsWith('tooling/fixtures/') && /\.(json|jsonl|md|txt|ya?ml)$/.test(x))) {
        for (const g of named(readText(root, f), null)) reach.add(g);
    }
    // Close over require edges of every reached .js file.
    const queue = [...reach].filter((f) => f.endsWith('.js'));
    const seen = new Set();
    while (queue.length) {
        const f = queue.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        for (const g of requiresOf(readText(root, f), f, idx)) {
            reach.add(g);
            if (g.endsWith('.js') && !seen.has(g)) queue.push(g);
        }
    }
    return reach;
}

/** Suites (repo paths) whose reach holds a touched file, each with the files that selected it. */
function selectSuites(root, tracked, touched) {
    // Deleted inputs still belong to dependency reach; only extant suites run.
    const idx = indexTree([...new Set([...tracked, ...touched])]);
    const suites = tracked.filter((f) => /^tooling\/test-[^/]+\.js$/.test(f)).sort();
    const hit = [];
    const touchedSet = new Set(touched);
    for (const s of suites) {
        const reach = reachOf(root, s, idx);
        const why = [...touchedSet].filter((t) => reach.has(t));
        if (why.length) hit.push({ suite: s, because: why });
    }
    return { suites: suites.length, selected: hit };
}

/** Files that differ from the merge base with `base`, committed or not. null when unreadable. */
function touchedFiles(root, base) {
    const mb = git(root, ['merge-base', 'HEAD', base]);
    if (!mb) return null;
    const b = mb.trim();
    const diff = git(root, ['diff', '--name-only', '--no-renames', b]);
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
    if (diff === null || untracked === null) return null;
    const files = [...new Set([...diff.split(/\r?\n/), ...untracked.split(/\r?\n/)].map((s) => s.trim()).filter(Boolean))];
    return { base: b, files };
}

function trackedFiles(root) {
    const out = git(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
    return out === null ? null : out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** The whole question for one tree: { base, touched, suites, selected } or { error }. */
function plan(root, base = 'origin/main') {
    const t = touchedFiles(root, base);
    if (!t) return { error: `cannot read the diff against the merge base with ${base}` };
    const tracked = trackedFiles(root);
    if (!tracked) return { error: 'cannot list the tracked files' };
    const sel = selectSuites(root, tracked, t.files);
    return { base: t.base, touched: t.files, suites: sel.suites, selected: sel.selected };
}

function main(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('usage: node tooling/touched-suites.js [--root DIR] [--base REF] [--json]');
        console.log('Lists the tooling/test-*.js suites whose static reach holds a file changed since the merge base.');
        return 0;
    }
    const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
    const root = path.resolve(val('--root', path.join(__dirname, '..')));
    const p = plan(root, val('--base', 'origin/main'));
    if (p.error) { console.error(`COULD NOT READ ${p.error}`); return 2; }
    if (argv.includes('--json')) { console.log(JSON.stringify(p, null, 2)); return 0; }
    for (const s of p.selected) console.log(`${s.suite}  <- ${s.because.slice(0, 3).join(', ')}${s.because.length > 3 ? ` +${s.because.length - 3}` : ''}`);
    console.log(`touched=${p.touched.length} suites=${p.suites} selected=${p.selected.length} base=${p.base.slice(0, 12)}`);
    return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { plan, selectSuites, reachOf, indexTree, touchedFiles, trackedFiles, resolveLiteral };
