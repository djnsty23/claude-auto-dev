#!/usr/bin/env node
'use strict';
/**
 * Survey every repo a session is working in, from git and gh only.
 *
 * This is the half of overseeing that MEASURES. It exists because the other
 * half — telling a session what to do next — was evaluated twice by peers and
 * scored at zero: every wrong steer was a claim about a session's own tree,
 * queue or intent, and every useful one was a fact about code, git or platform
 * metadata. So this reads the second kind and refuses to guess at the first.
 *
 * Nothing here looks inside a session. It cannot: a session's uncommitted work,
 * its decisions and its intent are not readable from outside, and filling that
 * in with confident prose is the failure mode. Join sessions to this output on
 * cwd AND branch, then ASK them about anything this does not print.
 *
 * Every field is read. Anything unreadable prints COULD NOT CHECK rather than
 * an empty value, because "no open PRs" and "gh cannot answer for a bitbucket
 * remote" are opposite facts that look identical once flattened to zero.
 *
 *   node auto-brain-survey.js                  survey the default repo list
 *   node auto-brain-survey.js --root <dir>     survey every git repo under dir
 *   node auto-brain-survey.js --json           machine-readable
 */
if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    // Print this file's own header block. A probe asking what this script is
    // must never cause it to DO what this script does: several entry points
    // here reach the network, and one made 21 registry calls from a --help
    // probe before this branch existed.
    const lines = require('fs').readFileSync(__filename, 'utf8').split('\n');
    const head = [];
    for (const line of lines.slice(1)) {
        if (line.trim() === "'use strict';") continue;
        if (/^\s*(\/\/|\/\*|\*|$)/.test(line)) head.push(line);
        else break;
    }
    console.log(head.join('\n').trim());
    process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const HOME = process.env.USERPROFILE || process.env.HOME || '';
// The default was `~/Downloads/code`, one machine's layout. Elsewhere the survey
// silently covered nothing. Resolve instead, and keep --root as the override.
// See claude-paths.js for the two other scripts that made the same mistake.
// Degrades rather than throws — a missing sibling leaves ROOT null, and the
// refusal below says so, instead of crashing before it can.
const ROOT_RAW = val('--root', null) || (() => {
    try { return require(path.join(__dirname, 'claude-paths.js')).codeDir(); }
    catch { return null; }
})();
const ROOT = ROOT_RAW ? path.resolve(ROOT_RAW) : null;

// Repos the operator has NAMED as client work, regardless of where their origin
// points. Read from the machine-local config so no client name is ever
// committed to this public repo. Missing file, missing key and a malformed file
// all degrade to an empty list, which is the pre-existing bitbucket-only
// behaviour — so `clientListFound` is tracked separately and printed, because
// "no repo is named" and "the list could not be read" are opposite facts that
// both flatten to zero matches.
let clientNames = [];
let clientListFound = false;
try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'brain-brief.json'), 'utf8'));
    if (Array.isArray(cfg.clients)) {
        clientNames = cfg.clients.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase());
        clientListFound = true;
    }
} catch { /* no config, or unreadable: clientNames stays empty */ }

// Match a repo by directory name or full path, both lowercased. A path match is
// allowed so a list entry can disambiguate two repos sharing a basename.
const repoKey = (p, name) => ((p || '') + ' ' + (name || '')).toLowerCase();

function run(cmd, a, cwd) {
    try { return execFileSync(cmd, a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
    catch { return null; }
}

function discover(root) {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const dir = path.join(root, e.name);
        if (fs.existsSync(path.join(dir, '.git'))) out.push([e.name, dir]);
    }
    return out;
}

function survey(name, dir) {
    const g = (a) => run('git', a, dir);
    g(['fetch', '--quiet']);

    const r = { name, dir };
    r.branch = g(['branch', '--show-current']) || g(['rev-parse', '--short', 'HEAD']);
    // WHY THIS IS NOT `rev-parse origin/HEAD` ALONE. That reads
    // refs/remotes/origin/HEAD, which git writes ONCE AT CLONE TIME and never
    // updates on fetch. So it is a cache, and it can be months stale.
    // [measured 2026-09-01] two clones of one project here still resolved it to a
    // branch that had been retired two days earlier, and this survey printed
    // that as `trunk`. A session read it, concluded the repo's real trunk was
    // the retired branch, briefed another session with that, and three merges
    // were needed to undo it. The header two lines below already warns that a
    // wrong trunk INVERTS verdicts -- and the value it warned about came from
    // here.
    // So ask the REMOTE, which is authoritative and costs nothing extra (this
    // function has already run `git fetch`). Keep the cached value, compare
    // them, and surface a disagreement loudly rather than silently preferring
    // one: a clone whose cache disagrees with its remote is exactly the repo
    // where every ahead/behind number below is measured against the wrong base.
    r.trunkCached = g(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
    const symref = g(['ls-remote', '--symref', 'origin', 'HEAD']);
    const m = symref && symref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    r.trunkRemote = m ? 'origin/' + m[1] : null;
    // Prefer the remote. Fall back to the cache only when the remote could not
    // answer -- an offline run, or a client repo behind auth -- and say so,
    // because a fallback that looks like a measurement is how this broke.
    r.trunk = r.trunkRemote || r.trunkCached;
    r.trunkFromCache = !r.trunkRemote && !!r.trunkCached;
    r.trunkStale = !!(r.trunkRemote && r.trunkCached && r.trunkRemote !== r.trunkCached);

    const remote = g(['remote', 'get-url', 'origin']);
    r.remote = remote;
    // A bitbucket remote means client work. It is not a lesser repo, it is a
    // repo whose rules differ: never push it to a personal remote, and never
    // assume gh can answer anything about it.
    //
    // ⚠️ A HOST IS A HINT, NOT THE ANSWER. Client work can sit on a personal
    // GitHub remote, and when it does this heuristic clears it. [measured
    // 2026-09-04] one repo on this machine is named as client work by the
    // operator's own mandate and has an `https://github.com/<personal>/...`
    // origin, so it scored as the operator's own in every survey ever run here
    // while carrying two live sessions. The mandate is the authority and the
    // remote is a guess, so a hand-maintained list has to be able to OVERRIDE
    // the guess in the direction of caution.
    //
    // The list lives in the machine-local config rather than here on purpose:
    // this repo is public and a client's name is exactly what must not be
    // committed to it. An absent config therefore degrades to the old
    // behaviour, which is the unsafe direction, so `clientWhy` records which
    // signal fired and the summary prints when no list was found at all.
    const named = clientNames.some((n) => n && repoKey(r.dir, r.name).indexOf(n) !== -1);
    r.isClient = named || (!!remote && remote.indexOf('bitbucket') !== -1);
    r.clientWhy = named ? 'named in the client list' : (r.isClient ? 'bitbucket remote' : null);
    r.isGitHub = !!remote && remote.indexOf('github') !== -1;

    const dirty = g(['status', '--porcelain=v1']);
    r.dirty = dirty === null ? null : (dirty ? dirty.split('\n').length : 0);

    if (r.trunk) {
        const ahead = g(['rev-list', '--count', r.trunk + '..HEAD']);
        const behind = g(['rev-list', '--count', 'HEAD..' + r.trunk]);
        r.ahead = ahead === null ? null : Number(ahead);
        r.behind = behind === null ? null : Number(behind);
        r.trunkTip = g(['log', '-1', '--format=%cI %s', r.trunk]);
        // A trunk whose name is not main/master is worth surfacing loudly: one
        // repo here has a main two months behind its real trunk, and comparing
        // a worktree against the wrong one inverts the verdict rather than
        // merely dating it.
        r.trunkIsUnusual = !/\/(main|master)$/.test(r.trunk);
    }

    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
        try {
            const s = JSON.parse(fs.readFileSync(pj, 'utf8')).scripts || {};
            r.gates = ['gate', 'preflight', 'test', 'validate', 'typecheck', 'lint', 'build']
                .filter((n) => s[n]);
        } catch { r.gates = null; }
    } else { r.gates = []; r.notNode = true; }

    if (r.isGitHub) {
        const prs = run('gh', ['pr', 'list', '--state', 'open', '--limit', '20',
            '--json', 'number,title,headRefName'], dir);
        if (prs === null) r.prs = null;
        else { try { r.prs = JSON.parse(prs); } catch { r.prs = null; } }
    } else {
        r.prs = null;
        r.prsWhy = r.isClient ? 'origin is not a GitHub remote (client repo)' : 'origin is not a GitHub remote';
    }

    const wt = g(['worktree', 'list']);
    r.worktrees = wt === null ? null : wt.split('\n').length;

    r.docs = {};
    for (const f of ['RESUME.md', 'PUBLISH-QUEUE.md', 'DECISIONS.md', 'prd.json', 'TASKS.md', 'CLAUDE.md']) {
        const p = path.join(dir, f);
        try {
            const st = fs.statSync(p);
            r.docs[f] = { bytes: st.size, modified: st.mtime.toISOString().slice(0, 10) };
        } catch { /* absent */ }
    }
    return r;
}

// No root means nothing was scanned, which is not the same as scanning and
// finding nothing. Say so and exit non-zero rather than printing a survey of
// zero repos that reads exactly like a tidy machine.
if (!ROOT) {
    console.error('COULD NOT SURVEY: no code directory found — this is NOT "0 repos".');
    console.error('  tried AUTODEV_CODE_DIR, ~/Code, ~/code, ~/Downloads/code, ~/Projects, ~/src');
    console.error('  Pass --root <dir>, or set AUTODEV_CODE_DIR.');
    process.exit(2);
}

const list = discover(ROOT);
const results = list.map(([n, d]) => survey(n, d));

if (has('--json')) {
    console.log(JSON.stringify({ root: ROOT, scanned: list.length, repos: results }, null, 2));
    process.exit(0);
}

console.log('\nAUTO-BRAIN SURVEY');
console.log('  root: ' + ROOT);
console.log('  population: ' + list.length + ' git repo(s) found UNDER THAT ROOT');
console.log('  Everything below is READ from git and gh. Nothing here knows what a');
console.log('  session is doing — join on cwd AND branch, then ASK about the rest.');
console.log('');
console.log('  !! THIS SCAN IS ONE DIRECTORY DEEP UNDER ONE ROOT, AND A SESSION MAY');
console.log('     BE WORKING SOMEWHERE IT CANNOT SEE. [measured 2026-08-25] a session');
console.log('     whose cwd was a repo listed below does all of its work in a project');
console.log('     on a DIFFERENT DRIVE. Briefing it from this output described the');
console.log('     wrong repo entirely — right facts, wrong subject.');
console.log('     A repo absent here is not a repo nobody is working in. Ask each');
console.log('     session which project it is actually in before briefing it, and');
console.log('     pass --root to cover another tree.\n');

for (const r of results) {
    console.log('### ' + r.name + (r.isClient ? '   [CLIENT — ' + (r.clientWhy || 'unknown signal') + ']' : ''));
    console.log('  branch ' + r.branch + '   trunk ' + (r.trunk || 'COULD NOT CHECK'));
    if (r.trunkStale) {
        console.log('  !! THE CACHED origin/HEAD IN THIS CLONE IS STALE: it says ' + r.trunkCached);
        console.log('     the remote says ' + r.trunkRemote + '. refs/remotes/origin/HEAD is');
        console.log('     written at clone time and NEVER updated by fetch, so any tool');
        console.log('     reading it here has been getting the wrong trunk. The numbers');
        console.log('     below use the REMOTE value and are correct; other tools may not.');
        console.log('     Fix the clone with:  git -C "' + r.dir + '" remote set-head origin -a');
    }
    if (r.trunkFromCache) {
        console.log('  !! trunk is the CACHED origin/HEAD, NOT confirmed against the remote');
        console.log('     (git ls-remote could not answer). It may be stale. Treat every');
        console.log('     ahead/behind number below as unverified rather than as measured.');
    }
    if (r.trunkIsUnusual) {
        console.log('  !! trunk is NOT main/master. Comparing against origin/main here');
        console.log('     inverts verdicts rather than merely dating them.');
    }
    const pos = [];
    if (r.ahead !== null && r.ahead !== undefined) pos.push(r.ahead + ' ahead');
    if (r.behind !== null && r.behind !== undefined) pos.push(r.behind + ' behind');
    console.log('  ' + (pos.join(', ') || 'position COULD NOT CHECK')
        + '   dirty ' + (r.dirty === null ? 'COULD NOT CHECK' : r.dirty)
        + '   worktrees ' + (r.worktrees === null ? 'COULD NOT CHECK' : r.worktrees));
    if (r.trunkTip) console.log('  trunk tip: ' + r.trunkTip.slice(0, 96));
    console.log('  gate: ' + (r.gates === null ? 'package.json UNPARSEABLE'
        : r.notNode ? 'not a node project — no gate to run'
        : (r.gates.length ? r.gates.join(', ') : 'package.json names NONE')));
    if (r.prs === null) console.log('  open PRs: COULD NOT CHECK — ' + (r.prsWhy || 'gh did not answer'));
    else console.log('  open PRs: ' + r.prs.length
        + (r.prs.length ? ' -> ' + r.prs.map((p) => '#' + p.number + ' ' + p.title.slice(0, 44)).join(' | ') : ''));
    const docs = Object.keys(r.docs);
    if (docs.length) {
        console.log('  docs: ' + docs.map((d) => d + ' (' + r.docs[d].bytes + 'b, ' + r.docs[d].modified + ')').join(', '));
        if (r.docs['RESUME.md'] && r.docs['RESUME.md'].bytes > 20000) {
            console.log('  !! RESUME.md is large and probably hand-written. Do not let a');
            console.log('     generator overwrite it — session-exit.js refuses, others may not.');
        }
    }
    console.log('');
}

const clients = results.filter((r) => r.isClient).map((r) => r.name);
const stale = results.filter((r) => typeof r.behind === 'number' && r.behind > 50).map((r) => r.name + ' (' + r.behind + ')');
const noGate = results.filter((r) => r.gates && r.gates.length === 0 && !r.notNode).map((r) => r.name);

console.log('SUMMARY');
console.log('  client repos (never push to a personal remote): ' + (clients.join(', ') || 'none'));
// Print the POPULATION the client check ran against, not just its result. An
// empty client list and an unreadable config produce the same zero matches, and
// only one of those is safe to act on: without this line a survey that failed to
// read the list looks exactly like a machine that has no client work on it.
console.log('  client list: ' + (clientListFound
    ? clientNames.length + ' name(s) from ~/.claude/brain-brief.json, plus any bitbucket remote'
    : 'NOT FOUND in ~/.claude/brain-brief.json — falling back to the bitbucket remote alone, which CANNOT see client work on a personal GitHub remote'));
console.log('  more than 50 behind trunk: ' + (stale.join(', ') || 'none'));
console.log('  node projects naming no gate script: ' + (noGate.join(', ') || 'none'));
console.log('  repos where gh could not answer: '
    + (results.filter((r) => r.prs === null).map((r) => r.name).join(', ') || 'none'));
console.log('');
