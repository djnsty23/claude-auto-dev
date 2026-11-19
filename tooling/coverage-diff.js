#!/usr/bin/env node
'use strict';
// coverage-diff.js: the release gate's coverage question, asked of one diff.
//
// WHY. `check:coverage` grades a receipt that only a full `npm test` publishes,
// so gate:fast (the PR merge bar) defers it. #556 added readRange() and sleep()
// to ledger-rotate.js, no suite entered either on win32, and the count went from
// 37 to 39 against a ceiling of 37. gate:fast merged it green and the release
// gate found it. The full census needs every suite. This module answers the
// narrower question the census exists for, "did this change add a plugin
// function that no suite enters?", from the suites gate:fast already runs.
//
// HOW. gate:fast runs the touched suites (touched-suites.js). When the diff
// changes a plugin source, each of those suites runs with NODE_V8_COVERAGE
// pointed at its own temp directory, and the dumps are folded through
// coverage-receipt.js's attribution, the same one the release census uses.
// A function is ADDED BY THE DIFF when V8 places its start on a line the diff
// added AND the base version of the file declares no function of that name.
// Both halves, because each alone is wrong in a measured way:
//   - a declaration line that was only edited (a renamed parameter) would read
//     as new on the line test alone, and flag a function the floor already holds;
//   - a name test alone misses a declaration style the regex does not know,
//     and then flags an old never-called function as new.
// An added function graded never-entered by every touched suite is the
// regression. So is an added plugin source no touched suite loaded.
//
// PARITY WITH THE RELEASE GATE. Whatever the release gate accepts, this accepts:
//   - files coverage-floors.js REFUSED_BY_DESIGN lists for this host, while
//     the precondition holds, are reported and not graded;
//   - a diff that raises FLOORS[platform].untested (or .neverLoaded) by k may
//     add k never-entered functions (or never-loaded files). That is the release
//     gate's own allowance, read from the base and head tables.
//
// WHAT IT CANNOT SEE, and the release gate still catches:
//   - a removed or weakened test that stops entering a function (no plugin
//     source changed, so nothing is graded here; the #556 follow-up shape);
//   - an existing function a change stops calling;
//   - a new function entered only by a suite outside the touched set (a path
//     built at run time). That reads as a FAIL here: name the file in a string
//     literal in the suite that enters it, and touched-suites.js selects it.
//
//   node tooling/coverage-diff.js --help
//
// Exports only. gate-fast.js drives it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const receipts = require('./coverage-receipt.js');

const FLOORS_FILE = 'tooling/coverage-floors.js';
const posix = (p) => p.split(path.sep).join('/');

function git(root, args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return !r.error && r.status === 0 ? r.stdout : null;
}

/** The text of `rel` at `base`, or null when the file did not exist there. */
function baseText(root, base, rel) {
    const r = spawnSync('git', ['show', `${base}:${rel}`], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return !r.error && r.status === 0 ? r.stdout : null;
}

/** Head line numbers (1-based) a `git diff -U0` adds, per file. */
function parseAddedLines(diffText) {
    const out = new Map();
    let file = null;
    for (const line of String(diffText || '').split(/\r?\n/)) {
        const f = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
        if (f) { file = f[1] === '/dev/null' ? null : f[1]; if (file && !out.has(file)) out.set(file, new Set()); continue; }
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (h && file) {
            const start = Number(h[1]);
            const n = h[2] === undefined ? 1 : Number(h[2]);
            for (let i = 0; i < n; i++) out.get(file).add(start + i);
        }
    }
    return out;
}

/** Added lines for each of `files` against `base`. A file absent at base has every line added. */
function addedLines(root, base, files) {
    const diff = git(root, ['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', base, '--', ...files]);
    if (diff === null) return null;
    const map = parseAddedLines(diff);
    for (const rel of files) {
        if (map.has(rel)) continue;
        // Untracked files are not in `git diff`: every line is new.
        let text = null;
        try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { /* deleted */ }
        if (text !== null && baseText(root, base, rel) === null) {
            const n = text.split('\n').length;
            map.set(rel, new Set(Array.from({ length: n }, (_, i) => i + 1)));
        } else map.set(rel, new Set());
    }
    return map;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `text` declare a function, method or class called `name`? */
function declares(text, name) {
    if (!text) return false;
    const n = esc(name);
    return [
        new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*\\(`),
        new RegExp(`\\bclass\\s+${n}\\b`),
        new RegExp(`(^|[^\\w$.])${n}\\s*[=:]\\s*(async\\s+)?(function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)`, 'm'),
        new RegExp(`\\.${n}\\s*=\\s*(async\\s+)?(function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)`),
        new RegExp(`^\\s*(?:(?:async|static|get|set)\\s+)*\\*?\\s*${n}\\s*\\([^)]*\\)\\s*\\{`, 'm'),
    ].some((re) => re.test(text));
}

/** 1-based line of a character offset. */
function lineOf(text, offset) {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
}

/**
 * Fold a directory of V8 dumps into `acc`, keeping only `want` files (posix
 * rel paths), with the start offsets V8 gives each named function.
 * acc: { dumps, unreadable, files: { rel: { name: { count, offsets: Set } } } }
 */
function foldDir(dir, attr, want, acc) {
    const out = acc || { dumps: 0, unreadable: 0, files: {} };
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const f of names) {
        if (!f.endsWith('.json')) continue;
        let data;
        try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { out.unreadable++; continue; }
        out.dumps++;
        for (const script of (data && data.result) || []) {
            const abs = attr.attribute(script.url);
            if (!abs) continue;
            const rel = posix(abs);
            if (!want.has(rel)) continue;
            // Offsets from a fixture COPY count too: suites copy a script into a temp
            // tree and run it there, and a copy is the file's own bytes. A copy that was
            // edited can map a name to another line; the base-name test still applies.
            const fns = out.files[rel] || (out.files[rel] = {});
            for (const fn of script.functions || []) {
                if (!fn.functionName) continue;
                const r0 = fn.ranges && fn.ranges[0];
                const count = (r0 && r0.count) || 0;
                const e = fns[fn.functionName] || (fns[fn.functionName] = { count: 0, offsets: new Set() });
                if (count > e.count) e.count = count;
                if (r0) e.offsets.add(r0.startOffset);
            }
        }
    }
    return out;
}

/** Load a coverage-floors.js text without running anything else. null if absent or unreadable. */
function evalFloors(text) {
    if (text === null || text === undefined) return null;
    try {
        const module = { exports: {} };
        vm.runInNewContext(text, { module, exports: module.exports, process, require: () => ({}) }, { timeout: 1000 });
        return module.exports && module.exports.FLOORS ? module.exports : null;
    } catch { return null; }
}

/**
 * The allowance the release gate itself grants this diff on `platform`: how far
 * the diff raised each ceiling. A base with no floors file grants nothing.
 */
function allowance(root, base, platform) {
    let head = null;
    try { head = evalFloors(fs.readFileSync(path.join(root, FLOORS_FILE), 'utf8')); } catch { /* none */ }
    const was = evalFloors(baseText(root, base, FLOORS_FILE));
    const h = head && head.FLOORS[platform];
    const b = was && was.FLOORS[platform];
    if (!h || !b) return { untested: 0, neverLoaded: 0 };
    return { untested: Math.max(0, h.untested - b.untested), neverLoaded: Math.max(0, h.neverLoaded - b.neverLoaded) };
}

/** The files REFUSED_BY_DESIGN excludes on this host, with the reason. */
function refused(root) {
    let floors = null;
    try { floors = require(path.join(root, FLOORS_FILE)); } catch { return new Map(); }
    const host = floors.REFUSED_BY_DESIGN && floors.REFUSED_BY_DESIGN[process.platform];
    const out = new Map();
    if (host && host.holds()) for (const f of host.files) out.set(f, `${host.reason} (${host.precondition})`);
    return out;
}

/**
 * Which changed files the census grades, before any suite runs.
 * Returns { changed: [rel], refused: [{file, reason}] }.
 */
function changedSources(root, touched) {
    const attr = receipts.attribution(root);
    const all = new Set([...attr.allSources].map(posix));
    const skip = refused(root);
    const hit = [...new Set(touched.map(posix))].filter((f) => all.has(f)).sort();
    return {
        attr,
        changed: hit.filter((f) => !skip.has(f)),
        refused: hit.filter((f) => skip.has(f)).map((file) => ({ file, reason: skip.get(file) })),
    };
}

/**
 * The verdict. `census` is foldDir's accumulator over every touched suite.
 * Returns { status: PASS|FAIL|INDETERMINATE, reason, added, neverLoaded, notGraded, allow }.
 */
function grade({ root, base, changed, census, suitesRan, platform = process.platform }) {
    const res = { status: 'PASS', reason: '', added: [], unentered: [], neverLoaded: [], notGraded: [], allow: { untested: 0, neverLoaded: 0 } };
    if (!changed.length) { res.reason = '0 changed plugin sources, nothing graded'; return res; }
    if (suitesRan > 0 && census.dumps === 0) {
        res.status = 'INDETERMINATE';
        res.reason = `${suitesRan} suite(s) ran under coverage and left 0 dumps, so nothing was measured`;
        return res;
    }
    const lines = addedLines(root, base, changed);
    if (!lines) { res.status = 'INDETERMINATE'; res.reason = `cannot read the diff against ${String(base).slice(0, 12)}`; return res; }
    for (const rel of changed) {
        let head;
        try { head = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
        const was = baseText(root, base, rel);
        const fns = census.files[rel];
        if (!fns) {
            if (was === null) res.neverLoaded.push(rel);
            else res.notGraded.push(rel);
            continue;
        }
        const added = lines.get(rel) || new Set();
        for (const [name, e] of Object.entries(fns)) {
            const onAdded = [...e.offsets].some((o) => added.has(lineOf(head, o)));
            if (!onAdded || declares(was, name)) continue;
            const row = { file: rel, name, line: Math.min(...[...e.offsets].map((o) => lineOf(head, o))), count: e.count };
            res.added.push(row);
            if (e.count === 0) res.unentered.push(row);
        }
    }
    res.allow = allowance(root, base, platform);
    const over = res.unentered.length > res.allow.untested || res.neverLoaded.length > res.allow.neverLoaded;
    res.status = over ? 'FAIL' : 'PASS';
    res.reason = `${changed.length} changed plugin source(s), ${census.dumps} dump(s): ${res.added.length} added function(s), `
        + `${res.unentered.length} never entered (allowance ${res.allow.untested}), `
        + `${res.neverLoaded.length} added source(s) never loaded (allowance ${res.allow.neverLoaded})`;
    return res;
}

/** Human lines for a verdict. */
function render(v) {
    const out = [`coverage of the diff: ${v.status}, ${v.reason}`];
    for (const r of v.unentered) out.push(`      ✗ ${r.file}:${r.line} ${r.name}() added and entered by no touched suite`);
    for (const f of v.neverLoaded) out.push(`      ✗ ${f} added and loaded by no touched suite`);
    for (const f of v.notGraded) out.push(`      ? ${f} changed, loaded by no touched suite, not graded here (the release gate grades it)`);
    for (const r of v.refused || []) out.push(`      ~ ${r.file} refused by design on ${process.platform}, not graded: ${r.reason}`);
    if (v.status === 'FAIL') {
        out.push('      The release gate (check:coverage) counts each of these against FLOORS in tooling/coverage-floors.js.');
        out.push('      Drive it from a suite. If a suite outside the touched set enters it, name the file in that suite.');
    }
    return out.join('\n');
}

if (require.main === module) {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log('usage: required by tooling/gate-fast.js, which runs the touched suites under coverage');
        console.log('and grades every plugin function the diff added. No standalone run.');
    } else {
        console.error('coverage-diff.js has no standalone run: `npm run gate:fast` drives it.');
        process.exitCode = 2;
    }
}

module.exports = { parseAddedLines, addedLines, declares, lineOf, foldDir, evalFloors, allowance, refused, changedSources, grade, render, baseText };
