#!/usr/bin/env node
'use strict';
// check-skill-layout.js - every SKILL.md stays under the line limit, and every
// other markdown file in a skill is linked from that skill's own SKILL.md.
//
// WHY. SKILL.md is loaded whole when the skill fires, so every line costs the
// session context on each use. Anthropic's skill authoring guide caps it at 500
// lines and moves detail into files the skill links, one level deep, so the
// model reads one only when the task needs it. A file nothing links is the other
// half of that failure: the model cannot find it, so it is dead weight that
// still reads as guidance to a human.
//
// SCOPE. Each directory under plugins/<plugin>/skills/ that holds a SKILL.md.
// Markdown files below it, except SKILL.md, belong to the nearest such skill.
//
// WHAT PASSES. SKILL.md has at most LIMIT lines, counted as `wc -l` counts them.
// Each other markdown file's path relative to the skill directory, such as
// `references/x.md` or `rules/x.md`, appears in that SKILL.md's text. A link
// from another reference does not count: one level deep is the rule.
//
// Usage: node tooling/check-skill-layout.js [root]
// Exit codes: 0 = pass, 1 = at least one skill fails

const fs = require('fs');
const path = require('path');
const { lineCount } = require('./check-reference-contents.js');

const LIMIT = 500;

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whether SKILL.md text names a file by its path relative to the skill. A path
// character before the match means a longer name, `other-references/x.md`.
function links(skillText, rel) {
    return new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(rel)}(?![A-Za-z0-9_-])`, 'm').test(skillText);
}

// Problems with one skill, as strings. `files` are paths relative to the skill
// directory, with forward slashes.
function problems(skillText, files) {
    const out = [];
    const lines = lineCount(skillText);
    if (lines > LIMIT) out.push(`SKILL.md is ${lines} lines, over ${LIMIT}`);
    for (const rel of files) if (!links(skillText, rel)) out.push(`${rel} is not linked from SKILL.md`);
    return out;
}

// [{ dir, files }] for every skill under plugins/*/skills, files relative to dir.
function skills(root) {
    const out = [];
    const plugins = path.join(root, 'plugins');
    if (!fs.existsSync(plugins)) return out;
    const walk = (dir, owner) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const here = entries.some((e) => e.isFile() && e.name === 'SKILL.md')
            ? { dir, files: [] } : owner;
        if (here !== owner) out.push(here);
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, here);
            else if (here && e.name.endsWith('.md') && e.name !== 'SKILL.md') {
                here.files.push(path.relative(here.dir, p).replace(/\\/g, '/'));
            }
        }
    };
    for (const plugin of fs.readdirSync(plugins)) {
        const dir = path.join(plugins, plugin, 'skills');
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) walk(dir, null);
    }
    for (const s of out) s.files.sort();
    return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

// The whole tree: { skills, files, failures: [{ skill, problems }] }.
function checkTree(root) {
    const all = skills(root);
    const failures = [];
    let files = 0;
    for (const s of all) {
        files += s.files.length;
        const p = problems(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'), s.files);
        if (p.length) failures.push({ skill: path.relative(root, s.dir).replace(/\\/g, '/'), problems: p });
    }
    return { skills: all.length, files, failures };
}

function main(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write('Usage: node tooling/check-skill-layout.js [root]\n'
            + `  Every SKILL.md has at most ${LIMIT} lines and links each other markdown file in its skill.\n`
            + 'Exit codes: 0 = pass, 1 = at least one skill fails\n');
        return 0;
    }
    const root = argv[0] ? path.resolve(argv[0]) : path.resolve(__dirname, '..');
    const r = checkTree(root);
    for (const f of r.failures) {
        console.log(`FAIL ${f.skill}`);
        for (const p of f.problems) console.log(`       ${p}`);
    }
    console.log(`Skill layout: ${r.skills - r.failures.length} of ${r.skills} skill(s) are at most ${LIMIT} lines and link all ${r.files} reference file(s) they hold`);
    return r.failures.length ? 1 : 0;
}

module.exports = { LIMIT, links, problems, skills, checkTree };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
