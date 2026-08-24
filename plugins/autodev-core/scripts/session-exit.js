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

lines.push(
    '## What a reader should do first',
    '',
    '1. `git fetch`, then re-check the two sections above. They decay fastest.',
    '2. Run the gate before believing anything is green. Check `package.json` for',
    '   its name at the commit you are on rather than assuming one.',
    '3. Read `CHANGELOG.md` and recent commit bodies: this project puts the',
    '   reasoning in the commit, not in a separate design note.',
    '',
);

const doc = lines.join('\n');

if (has('--print')) {
    process.stdout.write(doc);
} else {
    const out = path.resolve(val('--out', path.join(CWD, 'RESUME.md')));
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
