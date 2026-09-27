#!/usr/bin/env node
'use strict';
/**
 * check-conflict-markers.js - no tracked file carries a git merge-conflict marker.
 *
 * WHY. `[stated 2026-09-27]` on claude/security-gate-meta-csp-v2 a rebase
 * conflict was resolved by a script that failed silently, and the markers were
 * committed inside a template-literal usage string in
 * plugins/autodev-core/scripts/security-gate.js. Inside a string they are valid
 * JavaScript, so `node --check`, `npm test` and that script's own suite all
 * passed. Only a human reading the diff caught it. A suite can guard one file
 * (its suite now asserts the --help text); this guards every tracked file.
 *
 * WHAT COUNTS. A line that starts with exactly seven `<`, `=` or `>` and is
 * followed by a space or the end of the line, which is how git writes them:
 * `<<<<<<< HEAD`, `=======`, `>>>>>>> <ref>`. A trailing CR is treated as end of
 * line, so a CRLF checkout reads the same as an LF one. Eight `=` is not a
 * marker, and neither is a marker indented or preceded by other text. The diff3
 * base marker (seven `|`) is not graded: git never writes it without the `<` and
 * `>` lines around it.
 *
 * MARKDOWN IS THE ONE DELIBERATE EXCEPTION. A doc may show a conflict inside a
 * fenced example, so in .md/.markdown/.mdx files a line inside a ``` or ~~~ fence
 * is not graded. Outside a fence it is, including a setext heading underlined
 * with exactly seven `=`: that reads the same as a marker, and the cure is an
 * ATX `#` heading. If a markdown file's fences never close, the fence cannot be
 * told from a conflict that swallowed a fence line, so every marker in that
 * file is graded as though no fence existed.
 *
 * POPULATION. `git ls-files` at the root, read from the working tree and printed
 * on every run. Binary files (a NUL in the first 8000 bytes, git's own test),
 * symlinks, gitlinks and tracked paths deleted from the working tree are counted
 * and named in the summary, never silently dropped.
 *
 *   node tooling/check-conflict-markers.js               # this repo
 *   node tooling/check-conflict-markers.js --root <dir>  # another git work tree
 *
 * Exit 0 no marker, 1 at least one (file:line each), 2 no verdict: git failed,
 * the population is empty, or a file could not be read.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tooling/check-conflict-markers.js [--root <dir>]');
    console.log('Scans every `git ls-files` path for a line starting with exactly seven <, = or >');
    console.log('followed by a space or end of line. Markdown lines inside ``` or ~~~ fences are skipped.');
    console.log('Exit 0 clean, 1 a marker (file:line each), 2 no verdict (git failed, no files, a read failed).');
    process.exitCode = 0;
    return;
}
const rootAt = argv.indexOf('--root');
if (rootAt !== -1 && (argv[rootAt + 1] === undefined || argv[rootAt + 1].startsWith('--'))) {
    console.error('--root needs a directory');
    process.exitCode = 2;
    return;
}
const ROOT = rootAt !== -1 ? path.resolve(argv[rootAt + 1]) : path.resolve(__dirname, '..');

const MARKER = /^(<{7}|={7}|>{7})(?: |$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** Paths git tracks under ROOT, or { error } when git gave no answer. */
function trackedFiles(root) {
    const r = spawnSync('git', ['-C', root, 'ls-files', '-z'], {
        encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) return { error: `git could not run: ${r.error.code || r.error.message}` };
    if (r.signal || r.status !== 0) {
        const why = String(r.stderr || '').trim().split('\n')[0] || `exit ${r.status} signal ${r.signal}`;
        return { error: `git ls-files failed: ${why}` };
    }
    return { files: r.stdout.split('\0').filter(Boolean) };
}

/**
 * The 1-based line numbers of every marker in `text`. In markdown, lines inside
 * a balanced fence are skipped; an unclosed fence voids the exemption.
 */
function markerLines(text, markdown) {
    const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
    const all = [];
    const fenced = new Set();
    let open = null;
    lines.forEach((line, i) => {
        if (markdown) {
            const f = FENCE.exec(line);
            if (open === null && f) { open = f[1]; return; }
            if (open !== null) {
                // A closing fence is the opening character, at least as long, and nothing after it.
                const close = f && f[1][0] === open[0] && f[1].length >= open.length
                    && line.trim() === f[1];
                if (close) { open = null; return; }
                if (MARKER.test(line)) { all.push(i + 1); fenced.add(i + 1); }
                return;
            }
        }
        if (MARKER.test(line)) all.push(i + 1);
    });
    if (open !== null) return all;
    return all.filter((n) => !fenced.has(n));
}

/** True when the buffer looks binary by git's test: a NUL in the first 8000 bytes. */
function isBinary(buf) {
    return buf.subarray(0, 8000).includes(0);
}

function main() {
    const listed = trackedFiles(ROOT);
    if (listed.error) {
        console.error(`[conflict-markers] NO VERDICT: ${listed.error} (root ${ROOT})`);
        process.exitCode = 2;
        return;
    }
    if (!listed.files.length) {
        console.error(`[conflict-markers] NO VERDICT: git ls-files listed 0 files under ${ROOT}`);
        process.exitCode = 2;
        return;
    }

    const found = [];
    const unread = [];
    const skipped = { binary: 0, symlink: 0, directory: 0, missing: 0 };
    let scanned = 0;
    for (const rel of listed.files) {
        const abs = path.join(ROOT, rel);
        let st;
        try { st = fs.lstatSync(abs); } catch (e) {
            if (e.code === 'ENOENT') { skipped.missing++; continue; }
            unread.push(`${rel} (${e.code || e.message})`);
            continue;
        }
        if (st.isSymbolicLink()) { skipped.symlink++; continue; }
        if (st.isDirectory()) { skipped.directory++; continue; }
        let buf;
        try { buf = fs.readFileSync(abs); } catch (e) {
            unread.push(`${rel} (${e.code || e.message})`);
            continue;
        }
        if (isBinary(buf)) { skipped.binary++; continue; }
        scanned++;
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        for (const n of markerLines(text, MARKDOWN.test(rel))) {
            found.push(`${rel}:${n}: ${lines[n - 1].replace(/\r$/, '').slice(0, 80)}`);
        }
    }

    const skippedText = Object.entries(skipped).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`[conflict-markers] ${listed.files.length} tracked file(s), ${scanned} scanned as text`
        + `${skippedText ? `, skipped ${skippedText}` : ''}, ${unread.length} unreadable, `
        + `${found.length} marker line(s)`);
    for (const f of found) console.log('  [FAIL] ' + f);
    for (const u of unread) console.log('  [NOT CHECKED] ' + u);
    process.exitCode = found.length ? 1 : (unread.length ? 2 : 0);
}

main();
