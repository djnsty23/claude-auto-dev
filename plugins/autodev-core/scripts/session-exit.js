#!/usr/bin/env node
'use strict';
/**
 * Write a RESUME file for THIS session, from measured state.
 *
 * Why this exists, and what it deliberately does NOT do.
 *
 * There was no exit procedure. Turn-level state is saved automatically (the
 * Stop hook writes a fleet heartbeat) and archived sessions get a stub from
 * `session-sweep --write-resume`, but a live session ending had nothing: what
 * was unpushed, what was open, what was decided, all of it lived in a
 * transcript nobody reads.
 *
 * It writes ONE session file - its own. It cannot write a peer's, and that is a
 * property of the fleet rather than a gap here: a session cannot read another
 * session's working tree, uncommitted changes, or decisions. Filling that in
 * with confident assertion is how every wrong steer gets made. So `--peers`
 * prints the request to send instead, and the session sends it. Asking costs
 * one turn and asserts nothing; guessing costs a wrong brief that becomes
 * built work.
 *
 * Every field below is READ, never remembered. A resume file written from a
 * session's recollection is the stale-premise failure in durable form.
 *
 *   node session-exit.js                 write RESUME.md in the cwd
 *   node session-exit.js --out <path>    write somewhere else
 *   node session-exit.js --print         print it, write nothing
 *   node session-exit.js --peers         also print the peer request block
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const CWD = process.cwd();

function run(cmd, a) {
    try {
        return execFileSync(cmd, a, { cwd: CWD, encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch { return null; }
}
const git = (a) => run('git', a);
const gh = (a) => run('gh', a);

// --- measure ---------------------------------------------------------------
//
// Each of these can legitimately be null, and null must render as COULD NOT
// READ rather than as an empty section. "no unpushed commits" and "git was
// never asked" are opposite facts that look identical once flattened to a
// blank, and the blank is the one a reader trusts.

const inRepo = git(['rev-parse', '--is-inside-work-tree']) === 'true';
const branch = inRepo ? git(['branch', '--show-current']) : null;
const upstream = inRepo ? git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) : null;

let unpushed = null;
if (inRepo && upstream) {
    const log = git(['log', '--format=%h %s', upstream + '..HEAD']);
    if (log !== null) unpushed = log ? log.split('\n') : [];
}

const dirty = inRepo ? git(['status', '--porcelain=v1']) : null;
const dirtyLines = dirty === null ? null : (dirty ? dirty.split('\n') : []);

let prs = null;
const prJson = inRepo
    ? gh(['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,headRefName,url'])
    : null;
if (prJson !== null) { try { prs = JSON.parse(prJson); } catch { prs = null; } }

const worktrees = inRepo ? git(['worktree', 'list']) : null;
const headWhen = inRepo ? git(['log', '-1', '--format=%cI']) : null;

// --- render ----------------------------------------------------------------

function section(title, value, renderer, absentNote) {
    const out = ['## ' + title, ''];
    if (value === null) {
        out.push('**COULD NOT READ.** ' + absentNote);
        out.push('');
        out.push('This is not "none". Nothing was measured, so treat it as unknown.');
    } else if (Array.isArray(value) && value.length === 0) {
        out.push('None. A real zero: the command ran and returned nothing.');
    } else {
        out.push.apply(out, renderer(value));
    }
    out.push('');
    return out;
}

const lines = [
    '# RESUME',
    '',
    'Written by `session-exit.js` from state READ at generation time, never from',
    'a recollection. Every number came from a command; anything a command could',
    'not answer says so rather than rendering as empty.',
    '',
    '| field | value |',
    '|---|---|',
    '| directory | `' + CWD + '` |',
    '| branch | ' + (branch ? '`' + branch + '`' : '_not a git repo_') + ' |',
    '| upstream | ' + (upstream ? '`' + upstream + '`' : '_none tracked_') + ' |',
    '| HEAD committed | ' + (headWhen || '_not read_') + ' |',
    '',
    '**Re-read before acting on any of this.** A resume file is a snapshot, and',
    'the two facts most likely to have moved are the two below: someone may have',
    'pushed, and someone may have merged.',
    '',
];

lines.push.apply(lines, section(
    'Unpushed commits',
    unpushed,
    (v) => v.map((l) => '- `' + l + '`'),
    'No upstream is tracked for this branch, or git could not be reached, so "ahead of origin" has no answer here.',
));

lines.push.apply(lines, section(
    'Uncommitted changes',
    dirtyLines,
    (v) => v.map((l) => '- `' + l + '`'),
    'git status did not run.',
));

lines.push.apply(lines, section(
    'Open PRs',
    prs,
    (v) => v.map((p) => '- [#' + p.number + '](' + p.url + ') `' + p.headRefName + '` - ' + p.title),
    'gh did not answer: not a GitHub remote, not authenticated, or gh absent. An empty PR list and an unanswerable one are different facts.',
));

if (worktrees) {
    lines.push('## Worktrees', '',
        'Another session may hold one of these. Run `git status` in a tree before',
        'touching it: a dirty tree you did not dirty means someone is in there.',
        '', '```', worktrees, '```', '');
}

// The closing advice is DERIVED, not fixed.
//
// It used to prescribe a gate script and CHANGELOG.md unconditionally. Reported
// 2026-08-25 by a session in a GTM/analytics engagement with neither: a reader
// following it "burns its first minutes looking for files that do not exist".
// That is this script's own failure mode turned on itself - it exists to stop
// unverified things rendering as fact, and its last section asserted two.
//
// So look before prescribing, and when nothing is found say THAT rather than
// falling silent: a missing section reads as "nothing to do here".
const hasFile = (f) => { try { return fs.statSync(path.join(CWD, f)).isFile(); } catch { return false; } };

let scripts = null;
if (hasFile('package.json')) {
    try { scripts = JSON.parse(fs.readFileSync(path.join(CWD, 'package.json'), 'utf8')).scripts || {}; }
    catch { scripts = null; }
}
// Order matters, and `validate` goes LAST on purpose. It is often a real script
// AND a subset of the fuller run - in this repo `npm test` runs every suite and
// then validate, so naming validate would send a reader to a narrower gate that
// still passes. Prefer the name that means "everything".
const gateName = scripts
    ? ['gate', 'preflight', 'test', 'validate'].filter((n) => scripts[n])[0] || null
    : null;

const docs = ['CHANGELOG.md', 'DECISIONS.md', 'README.md', 'TASKS.md', 'SPEC.md'].filter(hasFile);

const steps = ['1. `git fetch`, then re-check the sections above. They decay fastest.'];
let n = 2;
if (gateName) {
    steps.push(n++ + '. Run `npm run ' + gateName + '` before believing anything is green.'
        + ' That name was read from `package.json` here, not assumed.');
} else if (scripts) {
    steps.push(n++ + '. `package.json` exists but names no gate, preflight, validate or'
        + ' test script, so there is nothing standard to run. Do not go looking for one.');
} else {
    steps.push(n++ + '. There is no `package.json` here, so this is not a code project'
        + ' and there is no gate to run. Do not spend the first minutes hunting for one.');
}
if (docs.length) {
    steps.push(n++ + '. Read ' + docs.map((d) => '`' + d + '`').join(', ')
        + ' - present in this directory, checked rather than assumed.');
}
if (inRepo) {
    steps.push(n++ + '. Read recent commit bodies. Many projects put the reasoning there'
        + ' rather than in a separate design note.');
}

lines.push('## What a reader should do first', '');
lines.push.apply(lines, steps);
lines.push('');
lines.push('_These steps were derived from what is actually in `' + CWD + '`._');
lines.push('');

const doc = lines.join('\n');

// The marker that says a RESUME.md is OURS and safe to replace.
//
// `[measured 2026-08-25]` by a peer, an hour after this shipped: RESUME.md is a
// project-doc convention in at least two repos here, and one keeps a 2,427-line
// hand-written handoff there under version control. A bare run replaced it with
// a 3kB snapshot. Restored with `git checkout`, nothing survived - but the file
// was TRACKED and the script did not look.
//
// Refusing on "tracked" alone would be wrong the other way: this repo commits
// its own generated RESUME.md deliberately, and a tool that cannot update its
// own output is a tool nobody runs twice. So the test is authorship, not
// tracking - overwrite what we wrote, never what a person wrote.
const MARKER = 'Written by `session-exit.js`';

// Anything we are about to write is a snapshot of a few kB. A foreign file much
// larger than that is a document somebody maintains.
const SUSPICIOUS_BYTES = 20000;

function refuseToClobber(out, aboutToWrite) {
    let existing;
    try { existing = fs.readFileSync(out, 'utf8'); } catch { return null; }   // absent: fine
    if (existing.indexOf(MARKER) !== -1) return null;                          // ours: fine

    let tracked = true;
    try {
        execFileSync('git', ['ls-files', '--error-unmatch', '--', out],
            { cwd: path.dirname(out), stdio: 'pipe' });
    } catch { tracked = false; }

    // SIZE, not just tracking. The first version of this guard refused only when
    // the target was tracked, and a peer named the hole immediately: a repo
    // where RESUME.md is untracked "loses it outright". Tracking is what made
    // the first two incidents RECOVERABLE, not what made them wrong — and a
    // guard that only fires where `git restore` would have saved you anyway is
    // protecting the case that needed it least.
    //
    // `[measured 2026-08-25]` the file destroyed in the third incident was
    // 458 KB and 6,132 lines against a 5 KB snapshot. Two orders of magnitude is
    // not a warning, it is a hard stop.
    const huge = existing.length >= SUSPICIOUS_BYTES
        && existing.length > (aboutToWrite || 0) * 4;

    if (!tracked && !huge) return null;   // small, foreign, untracked: replaceable

    const why = tracked && huge ? 'It is tracked by git AND is ' + existing.length + ' bytes'
        : tracked ? 'It is tracked by git'
        : 'It is ' + existing.length + ' bytes — far larger than the ' + aboutToWrite
            + ' this would write';
    return 'REFUSING to overwrite ' + out + '\n'
        + '  ' + why + ', and it was not written by this script.\n'
        + '  A hand-written project handoff at RESUME.md is a convention in some\n'
        + '  repos — one is 458 KB and is named in its CLAUDE.md as the cold-start\n'
        + '  entry point. Replacing one loses work no snapshot reconstructs, and\n'
        + '  an untracked one is not recoverable at all.\n'
        + '  Write elsewhere with --out <path>, or --force if you are certain.';
}

if (has('--print')) {
    process.stdout.write(doc);
} else {
    const out = path.resolve(val('--out', path.join(CWD, 'RESUME.md')));
    const refusal = has('--force') ? null : refuseToClobber(out, doc.length);
    if (refusal) { console.error(refusal); process.exit(3); }
    fs.writeFileSync(out, doc, 'utf8');
    console.log('wrote ' + out + ' (' + doc.length + ' bytes)');
    console.log('  measured: '
        + (unpushed === null ? 'unpushed UNKNOWN' : unpushed.length + ' unpushed') + ', '
        + (dirtyLines === null ? 'dirty UNKNOWN' : dirtyLines.length + ' dirty') + ', '
        + (prs === null ? 'PRs UNKNOWN' : prs.length + ' open PR(s)'));
}

if (has('--peers')) {
    const say = (s) => console.log(s);
    say('');
    say('--- PEERS: this script cannot write their files, only ask ---');
    say('');
    say('A session cannot read another session working tree, uncommitted changes');
    say('or decisions. Asserting them is how wrong briefs become built work. So');
    say('ASK once, and let each session answer for itself:');
    say('');
    say('  "Wrapping up. Please run session-exit.js in your worktree and reply');
    say('   with: what you finished (commits), what you verified (the command and');
    say('   what it printed), what is blocked and on whom, and whether you are');
    say('   idle. I cannot see your branch."');
    say('');
    say('  Find them with list_sessions. Join on cwd AND branch, never on id:');
    say('  pipe names and session-list ids are separate identifier spaces and');
    say('  nothing joins them, so one session can look like two.');
}
