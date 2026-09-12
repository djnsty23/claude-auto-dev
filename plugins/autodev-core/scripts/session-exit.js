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
 * Every MEASURED field below is READ, never remembered. A resume file written
 * from a session's recollection is the stale-premise failure in durable form.
 * The AUTHORED fields (goal, changes made, failed attempts, next steps) are the
 * exception no command can fill, so they render as `_Not written._` until the
 * ending session writes them, and a rerun carries them forward.
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

// --help MUST NOT WRITE. `[measured 2026-09-02]` it did: running this with
// --help to find out what it does regenerated RESUME.md in the working tree.
// The flag was simply unrecognised and fell through to the main path.
//
// That is worse than an ordinary missing feature, because --help is the one
// argument a reader uses to learn what a script does BEFORE deciding to run it,
// and check-entrypoints.js probes every plugins/*/scripts/*.js with exactly
// this flag. That probe was not harmed — it copies the repo to a scratch dir
// first, and its header says that isolation exists for actions like this one —
// but the isolation is what contained it, not this script's own behaviour, and
// a human at a prompt has no such copy.
if (has('--help') || has('-h')) {
    console.log('usage: session-exit.js [--print] [--out <path>] [--force] [--peers]\n'
        + 'Writes RESUME.md for the next session, with six fields: goal, current state,\n'
        + 'files in flight, changes made, failed attempts (each with why it failed), next\n'
        + 'steps. Current state and files in flight are read at generation time; the\n'
        + 'other four are written by the ending session, and a rerun keeps them.\n'
        + '  --print   write to stdout instead of a file  (the only non-writing mode)\n'
        + '  --out P   write somewhere other than ./RESUME.md\n'
        + '  --force   skip the refuse-to-clobber check\n'
        + '  --peers   also print what peer sessions must do themselves\n'
        + 'WRITES A FILE unless --print is given.');
    process.exit(0);
}

const CWD = process.cwd();

// RESUME.md gets COMMITTED, and a committed file must not carry a home path.
//
// `[measured 2026-08-25]` this script put `C:\Users\<name>\...` into the one
// RESUME.md it had written, in a PUBLIC repo. The private-name gate did not
// catch it — that gate protects project NAMES, and a home directory is neither
// a project name nor a secret, so nothing was looking. It was the only personal
// path in 246 tracked files, and this script put it there.
//
// Redact rather than omit: a reader still needs to know WHICH directory the
// snapshot describes, and `~/code/thing` answers that without naming anyone.
const HOMEDIR = process.env.USERPROFILE || process.env.HOME || '';
function tilde(p) {
    if (!HOMEDIR || !p) return p;
    const norm = (s) => s.split(path.sep).join('/');
    const a = norm(p), b = norm(HOMEDIR);
    return a.toLowerCase().startsWith(b.toLowerCase()) ? '~' + a.slice(b.length) : a;
}

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
    const out = ['### ' + title, ''];
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

// --- the six fields ----------------------------------------------------------
//
// ONE field list, in this order, shared with hooks/context-depth-nudge.js and
// skills/brain/SKILL.md: goal, current state, files in flight, changes made,
// failed attempts (each with why it failed), next steps.
//
// Two are MEASURED here. Four are AUTHORED by the session that is ending,
// because no command can read them. Failed attempts is why the authored half
// exists: a handoff that carries only progress sends the next session straight
// back into every dead end the last one already found, and it will try each
// again because nothing says it failed.
//
// An unwritten authored field renders as `_Not written._`, never as an empty
// section, for the same reason a measured null renders as COULD NOT READ: an
// empty "Failed attempts" reads as "nothing failed".
const AUTHORED = {
    'Goal': '_Not written._ What this session set out to do, in a sentence or two, so'
        + ' the next one can tell finished work from abandoned work.',
    'Changes made': '_Not written._ What this session changed, each with the command that'
        + ' verified it and what that command printed. Unpushed commits are listed'
        + ' under Current state.',
    'Failed attempts': '_Not written._ Every approach tried that did not work, each with'
        + ' the reason it failed. Write "None" if nothing failed, so this field cannot'
        + ' be mistaken for one nobody filled in.',
    'Next steps': '_Not written._ What to do next, in order, and what each step is'
        + ' blocked on.',
};

const stateRows = [
    '| field | value |',
    '|---|---|',
    // FIRST row, because it dates every other row. Without it a reader cannot
    // tell a snapshot taken a minute ago from one taken last week, and the two
    // render identically - the same defect this suite exists to prevent one
    // level up, where a null section and an empty section look alike.
    // `[measured 2026-09-05]` the copy of RESUME.md on this repo's own trunk
    // listed PR #127 as open (merged 6 minutes after that snapshot was taken),
    // two commits as unpushed (both merged), and 3 of 6 worktrees that no
    // longer exist - and nothing in the file let a reader date any of it.
    '| generated | ' + new Date().toISOString() + ' |',
    '| directory | `' + tilde(CWD) + '` |',
    '| branch | ' + (branch ? '`' + branch + '`' : '_not a git repo_') + ' |',
    '| upstream | ' + (upstream ? '`' + upstream + '`' : '_none tracked_') + ' |',
    '| HEAD committed | ' + (headWhen || '_not read_') + ' |',
    '',
    '**Re-read before acting on any of this.** A resume file is a snapshot, and',
    'the two facts most likely to have moved are the two below: someone may have',
    'pushed, and someone may have merged.',
    '',
];

// The measured sub-blocks keep their old names as `###` headings on purpose.
// check-doc-staleness.js recognises `Unpushed commits`, `Uncommitted changes`
// and `Open PRs` as machine-written status blocks at any heading level, so
// renaming them would blind that detector to every snapshot written from now on.
const measuredState = [].concat(
    section(
        'Unpushed commits',
        unpushed,
        (v) => v.map((l) => '- `' + l + '`'),
        'No upstream is tracked for this branch, or git could not be reached, so "ahead of origin" has no answer here.',
    ),
    section(
        'Open PRs',
        prs,
        (v) => v.map((p) => '- [#' + p.number + '](' + p.url + ') `' + p.headRefName + '` - ' + p.title),
        'gh did not answer: not a GitHub remote, not authenticated, or gh absent. An empty PR list and an unanswerable one are different facts.',
    ),
    worktrees
        ? ['### Worktrees', '',
            'Another session may hold one of these. Run `git status` in a tree before',
            'touching it: a dirty tree you did not dirty means someone is in there.',
            '', '```', worktrees.split('\n').map(tilde).join('\n'), '```', '']
        : [],
);

const measuredInFlight = section(
    'Uncommitted changes',
    dirtyLines,
    (v) => v.map((l) => '- `' + l + '`'),
    'git status did not run.',
);

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

const readerFirst = ['## What a reader should do first', ''].concat(steps, [
    '',
    '_These steps were derived from what is actually in `' + tilde(CWD) + '`._',
    '',
]);

function authored(title, carried) {
    return ['## ' + title, '', carried[title] || AUTHORED[title], ''];
}

/** The whole document, with `carried` authored bodies in place of their placeholders. */
function render(carried) {
    return [
        '# RESUME',
        '',
        'Written by `session-exit.js`. Six fields, in this order: goal, current state,',
        'files in flight, changes made, failed attempts, next steps. Current state and',
        'files in flight were READ from commands at generation time, never from a',
        'recollection, and anything a command could not answer says so rather than',
        'rendering as empty. The other four cannot be read by any command: the session',
        'that ends writes them under their headings, and a rerun of this script keeps',
        'what it wrote there. Anything written inside a measured field is regenerated.',
        '',
    ].concat(
        authored('Goal', carried),
        ['## Current state', ''], stateRows, measuredState,
        ['## Files in flight', ''], measuredInFlight,
        authored('Changes made', carried),
        authored('Failed attempts', carried),
        authored('Next steps', carried),
        readerFirst,
    ).join('\n');
}

/**
 * The authored bodies of an existing RESUME.md, keyed by heading.
 *
 * A RERUN MUST NOT ERASE WHAT A SESSION WROTE. The measured fields are rebuilt
 * on every run; without this, a session that recorded its failed attempts and
 * then refreshed the snapshot would lose exactly the dead ends the file exists
 * to carry, and nothing would say so.
 *
 * Read only from a file carrying MARKER: these headings are a contract of our
 * own output, and a foreign file's `## Goal` is somebody else's structure. A
 * body still equal to its placeholder is not carried, so an unwritten field
 * stays recognisably unwritten rather than being frozen as content.
 */
function carriedFrom(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
    if (text.indexOf(MARKER) === -1) return {};
    const rows = text.split(/\r?\n/);
    const out = {};
    for (let i = 0; i < rows.length; i++) {
        const m = rows[i].match(/^## (.+?)\s*$/);
        if (!m || !Object.prototype.hasOwnProperty.call(AUTHORED, m[1]) || m[1] in out) continue;
        let end = i + 1;
        while (end < rows.length && !/^## /.test(rows[end])) end++;
        const body = rows.slice(i + 1, end).join('\n').trim();
        if (body && body !== AUTHORED[m[1]]) out[m[1]] = body;
        i = end - 1;
    }
    return out;
}

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

    // THE MARKER IS A STRING A DOCUMENT CAN QUOTE, so it may only ever DOWNGRADE
    // a refusal, never grant permission. `[measured 2026-09-05]` this test used to
    // run FIRST and return null on a hit, so a 25,790-byte hand-written RESUME.md
    // that quoted the marker inside a paragraph explaining the file is NOT
    // generated was classified as ours, and one bare invocation would have replaced
    // it with a 2.4 kB snapshot without a prompt. The A/B was one string: marker
    // present, overwrite; marker removed, exit 3.
    //
    // Ordering is the whole fix, and SIZE is why it works: our own output is about
    // the size of what we are about to write, never four times it. So a huge file
    // is not ours whatever it contains, and the marker is consulted only among
    // files that are already plausibly ours. This is the third route into the same
    // destruction and the first that defeats both guards rather than falling
    // between them.
    const quoted = existing.indexOf(MARKER) !== -1;
    if (quoted && !huge) return null;     // ours, and not big enough to be a handoff

    if (!tracked && !huge) return null;   // small, foreign, untracked: replaceable

    const why = quoted
        ? 'It is ' + existing.length + ' bytes and QUOTES this script\'s marker'
        : tracked && huge ? 'It is tracked by git AND is ' + existing.length + ' bytes'
        : tracked ? 'It is tracked by git'
        : 'It is ' + existing.length + ' bytes — far larger than the ' + aboutToWrite
            + ' this would write';
    return 'REFUSING to overwrite ' + out + '\n'
        + '  ' + why + (quoted
            ? ', which a hand-written document explaining the convention will do.\n'
            : ', and it was not written by this script.\n')
        + '  A hand-written project handoff at RESUME.md is a convention in some\n'
        + '  repos — one is 458 KB and is named in its CLAUDE.md as the cold-start\n'
        + '  entry point. Replacing one loses work no snapshot reconstructs, and\n'
        + '  an untracked one is not recoverable at all.\n'
        + '  Write elsewhere with --out <path>, or --force if you are certain.';
}

const target = path.resolve(val('--out', path.join(CWD, 'RESUME.md')));
const carried = carriedFrom(target);
const doc = render(carried);

if (has('--print')) {
    process.stdout.write(doc);
} else {
    // THE GUARD IS SIZED AGAINST THE MEASURED SNAPSHOT, NEVER THE CARRIED ONE.
    // Carried bodies come from the file being replaced, so sizing against them
    // lets a large file inflate the very output it is compared with: a 60 kB
    // hand-written handoff that quotes MARKER and has a `## Next steps` heading
    // would carry its own bulk forward, stop looking four times larger than
    // what replaces it, and be overwritten without a prompt. That is the
    // quoted-marker destruction route again, reopened by this feature.
    const refusal = has('--force') ? null : refuseToClobber(target, render({}).length);
    if (refusal) { console.error(refusal); process.exit(3); }
    fs.writeFileSync(target, doc, 'utf8');
    console.log('wrote ' + target + ' (' + doc.length + ' bytes)');
    console.log('  measured: '
        + (unpushed === null ? 'unpushed UNKNOWN' : unpushed.length + ' unpushed') + ', '
        + (dirtyLines === null ? 'dirty UNKNOWN' : dirtyLines.length + ' dirty') + ', '
        + (prs === null ? 'PRs UNKNOWN' : prs.length + ' open PR(s)'));
    const names = Object.keys(AUTHORED);
    const kept = names.filter((t) => carried[t]);
    const missing = names.filter((t) => !carried[t]);
    console.log('  authored: '
        + (kept.length ? 'kept ' + kept.join(', ') : 'none kept')
        + (missing.length ? '; NOT WRITTEN, write these by hand: ' + missing.join(', ') : ''));
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
    say('');
    say('  PUT YOUR OWN SESSION ID IN EVERY MESSAGE YOU SEND.');
    say('  [measured 2026-08-25] four peers were asked to report; every one that');
    say('  answered said the sender id did not resolve, because they reached for');
    say('  ListAgents - which lists in-process SUBAGENTS, not sessions. They had');
    say('  to guess the sender by title, and one nearly gave up. A request with');
    say('  no return address is a request that arrives and cannot be answered.');
    say('');
    say('    Reply to: mcp__ccd_session_mgmt__send_message, session_id <yours>');
    say('');
    say('  ASK FOR SHORT ROLLING SUMMARIES, not only a report at the end.');
    say('  One message per COMPLETED UNIT of work - not per commit, not on a');
    say('  timer. Three to five lines: what changed, what was verified with the');
    say('  command and what it printed, and what is next or blocked. The long');
    say('  four-part report is for going idle. Say "short" and mean it, or every');
    say('  update costs both sides a full turn and awareness stops being cheap.');
}
