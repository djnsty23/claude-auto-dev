#!/usr/bin/env node
'use strict';
// check-reference-contents.js - every long skill reference file opens with a
// contents list that matches its headings.
//
// WHY. A session that opens a reference file often previews it (`head -100`)
// to decide whether to read the rest. A section that starts after line 100 is
// invisible to that preview unless a contents list near the top names it.
// Anthropic's skill authoring guide asks for a contents list on any reference
// file over 100 lines for this reason.
//
// SCOPE. Markdown under plugins/<plugin>/skills/<skill>/, except SKILL.md, over
// LIMIT lines. SKILL.md is loaded whole when the skill fires, so the preview
// problem does not apply to it.
//
// WHAT PASSES. The first `##` heading outside a code fence is `## Contents`, it
// sits within the first CONTENTS_BY lines, and its list matches the file: every
// `##` heading is listed, and every listed entry names a real `##` or `###`
// heading. A stale entry fails as surely as a missing one, because a contents
// list that names a section the file no longer has sends the reader nowhere.
//
// Usage: node tooling/check-reference-contents.js [root]
// Exit codes: 0 = pass, 1 = at least one file fails

const fs = require('fs');
const path = require('path');

const LIMIT = 100;
const CONTENTS_BY = 50;

// Headings outside fenced code. A `#` line inside a fence is a shell comment or
// an example document, not a section of this file.
function headings(text) {
    const out = [];
    let fence = null;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const f = lines[i].match(/^\s*(`{3,}|~{3,})/);
        if (f) {
            if (!fence) fence = f[1][0];
            else if (f[1][0] === fence) fence = null;
            continue;
        }
        if (fence) continue;
        const h = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (h) out.push({ level: h[1].length, text: h[2], line: i + 1 });
    }
    return out;
}

// `[Text](#anchor)` and `Text` both name the heading "Text".
function entryText(raw) {
    return raw.replace(/^\[(.+)\]\([^)]*\)$/, '$1').trim();
}

// The list under `## Contents`: blank lines are skipped, and the first line that
// is neither blank nor a list item ends it. Reading on to the next heading would
// take any later list (a frontmatter `paths:` block, a checklist) as entries.
function contentsEntries(text, startLine) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = startLine; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const m = lines[i].match(/^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/);
        if (!m) break;
        out.push(entryText(m[1]));
    }
    return out;
}

// Lines as `wc -l` counts them: a final newline ends a line, it does not start one.
function lineCount(text) {
    return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

// Problems with one file's text, as strings. Empty means it passes.
function problems(text) {
    const lines = lineCount(text);
    if (lines <= LIMIT) return [];
    const hs = headings(text);
    const h2 = hs.filter((h) => h.level === 2);
    const first = h2[0];
    if (!first || !/^contents$/i.test(first.text)) {
        return [`${lines} lines and no "## Contents" as the first ## heading`];
    }
    const out = [];
    if (first.line > CONTENTS_BY) out.push(`"## Contents" is on line ${first.line}, after line ${CONTENTS_BY}`);
    const entries = contentsEntries(text, first.line);
    if (!entries.length) out.push('"## Contents" lists nothing');
    const sections = h2.slice(1).map((h) => h.text);
    const named = new Set(hs.filter((h) => h.level === 2 || h.level === 3).map((h) => h.text));
    for (const s of sections) if (!entries.includes(s)) out.push(`section "${s}" is missing from the contents`);
    for (const e of entries) if (!named.has(e)) out.push(`contents entry "${e}" names no ## or ### heading`);
    return out;
}

function referenceFiles(root) {
    const out = [];
    const plugins = path.join(root, 'plugins');
    if (!fs.existsSync(plugins)) return out;
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.md') && e.name !== 'SKILL.md') out.push(p);
        }
    };
    for (const plugin of fs.readdirSync(plugins)) {
        const skills = path.join(plugins, plugin, 'skills');
        if (fs.existsSync(skills) && fs.statSync(skills).isDirectory()) walk(skills);
    }
    return out.sort();
}

// The whole tree: { scanned, long, failures: [{ file, problems }] }.
function checkTree(root) {
    const files = referenceFiles(root);
    let long = 0;
    const failures = [];
    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        if (lineCount(text) > LIMIT) long++;
        const p = problems(text);
        if (p.length) failures.push({ file: path.relative(root, f).replace(/\\/g, '/'), problems: p });
    }
    return { scanned: files.length, long, failures };
}

function main(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write('Usage: node tooling/check-reference-contents.js [root]\n'
            + `  Every skill reference file over ${LIMIT} lines opens with a "## Contents" list matching its headings.\n`
            + 'Exit codes: 0 = pass, 1 = at least one file fails\n');
        return 0;
    }
    const root = argv[0] ? path.resolve(argv[0]) : path.resolve(__dirname, '..');
    const r = checkTree(root);
    for (const f of r.failures) {
        console.log(`FAIL ${f.file}`);
        for (const p of f.problems) console.log(`       ${p}`);
    }
    console.log(`Reference contents: ${r.long - r.failures.length} of ${r.long} reference file(s) over ${LIMIT} lines carry a matching contents list (${r.scanned} reference file(s) scanned)`);
    return r.failures.length ? 1 : 0;
}

module.exports = { LIMIT, lineCount, headings, contentsEntries, problems, referenceFiles, checkTree };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
