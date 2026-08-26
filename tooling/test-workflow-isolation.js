#!/usr/bin/env node
// Tests that a workflow agent pointed at a FOREIGN repo never asks the harness
// for `isolation: 'worktree'`.
//
// WHY THIS EXISTS. `isolation: 'worktree'` builds the worktree from the SESSION's
// repo, never from the repo named in the agent's prompt. For a workflow whose
// agents each operate on a different repo — heal-sweep is the whole category —
// that is worse than no isolation at all:
//
//   - the agent lands in a worktree of the WRONG repo, so every edit it makes to
//     the target lands in the target's MAIN CLONE, which is exactly where other
//     live sessions keep uncommitted work;
//   - and when the session's own cwd is not a git repo, every fix agent dies with
//     "Cannot create agent worktree: not in a git repository" AFTER the find and
//     verify stages have been paid for. That happened on the first real heal run,
//     2026-08-22, and the whole fix stage was lost.
//
// The skill documented the trap and prescribed the remedy; the script never
// received it, and nothing here could see the gap because no suite read this file
// at all. Four fix agents worked around it by hand on 2026-08-26 before it was
// fixed properly.
//
// THE POPULATION IS PRINTED, not just a verdict. A gate that reports only PASS is
// indistinguishable from one that scanned nothing.
//
// Run: node tooling/test-workflow-isolation.js

const fs = require('fs');
const path = require('path');

const PLUGINS = path.resolve(__dirname, '..', 'plugins');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);

// ── collect every workflow script that ships ─────────────────────────────────
function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (/\.workflow\.js$/.test(e.name)) out.push(full);
    }
    return out;
}

const scripts = walk(PLUGINS);
const rel = (f) => path.relative(path.resolve(__dirname, '..'), f).replace(/\\/g, '/');

// A script is "foreign-target" when its agents are pointed at a path supplied by
// the CALLER rather than at the session's own tree. The tell is a prompt that
// interpolates a `.path` off an args-derived object. Deliberately not a filename
// allowlist: the next such workflow must be covered on the day it lands.
const FOREIGN = /\$\{\s*\w+\.path\s*\}/;
const ISOLATION = /isolation:\s*['"]worktree['"]/;

let agentCalls = 0;
let isolationUses = 0;
const offenders = [];
const foreignScripts = [];

for (const file of scripts) {
    const src = fs.readFileSync(file, 'utf8');
    // Strip block comments so a comment SAYING "no isolation here" is not read as
    // a use of it. Without this the fix's own explanatory comment trips the gate,
    // which is the sort of false positive that gets a detector muted.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    agentCalls += (code.match(/\bagent\(/g) || []).length;
    const uses = (code.match(new RegExp(ISOLATION.source, 'g')) || []).length;
    isolationUses += uses;
    const foreign = FOREIGN.test(code);
    if (foreign) foreignScripts.push(rel(file));
    if (foreign && uses > 0) offenders.push(rel(file));
}

check(
    'no foreign-target workflow asks for isolation: worktree',
    offenders.length === 0,
    offenders.length ? 'offending: ' + offenders.join(', ') : null
);

// ── the specific script this was found in ────────────────────────────────────
const HEAL = path.join(PLUGINS, 'autodev-core', 'scripts', 'heal-sweep.workflow.js');
const healExists = fs.existsSync(HEAL);
check('heal-sweep.workflow.js is present', healExists);

if (healExists) {
    const src = fs.readFileSync(HEAL, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    check('heal-sweep is recognised as foreign-target', FOREIGN.test(code));
    check('heal-sweep uses no isolation flag', !ISOLATION.test(code));

    // The flag's REPLACEMENT has to be present, or removing it just leaves the
    // agent editing the main clone with no instruction not to. Absence of the bug
    // is not presence of the fix.
    check(
        'the fix prompt tells the agent to create a worktree inside the target',
        /git worktree add/.test(src) && /cd "\$\{repo\.path\}"/.test(src)
    );
    check(
        'the fix prompt warns the agent it is NOT already in the target worktree',
        /NOT already in a worktree of this repo/i.test(src)
    );

    // A completion line hardcoded to a repo count under-reports on any other size.
    check(
        'the done line counts the real repo total, not a literal',
        /\$\{clean\.length\}\/\$\{REPOS\.length\}/.test(src)
    );
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(
    `[workflow-isolation] ${scripts.length} workflow script(s) scanned · ` +
    `${agentCalls} agent call(s) · ${foreignScripts.length} foreign-target · ` +
    `${isolationUses} isolation:worktree use(s) · ${offenders.length} offending`
);
if (foreignScripts.length) console.log('  foreign-target: ' + foreignScripts.join(', '));

// A zero population means this gate proved nothing. Say so rather than passing.
if (scripts.length === 0) {
    console.error('\n✗ no workflow scripts found under plugins/ — the probe is blind, not the tree clean');
    process.exit(1);
}
if (foreignScripts.length === 0) {
    console.error('\n✗ no foreign-target workflow found — this gate cannot fire, so it is not evidence');
    process.exit(1);
}

let failed = 0;
for (const [label, ok, detail] of cases) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ' — ' + detail : ''}`);
    if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
