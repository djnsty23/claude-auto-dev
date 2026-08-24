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
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const ROOT = path.resolve(val('--root', path.join(HOME, 'Downloads', 'code')));

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
    r.trunk = g(['rev-parse', '--abbrev-ref', 'origin/HEAD']);

    const remote = g(['remote', 'get-url', 'origin']);
    r.remote = remote;
    // A bitbucket remote means client work. It is not a lesser repo, it is a
    // repo whose rules differ: never push it to a personal remote, and never
    // assume gh can answer anything about it.
    r.isClient = !!remote && remote.indexOf('bitbucket') !== -1;
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

const list = discover(ROOT);
const results = list.map(([n, d]) => survey(n, d));

if (has('--json')) {
    console.log(JSON.stringify({ root: ROOT, scanned: list.length, repos: results }, null, 2));
    process.exit(0);
}

console.log('\nAUTO-BRAIN SURVEY');
console.log('  root: ' + ROOT);
console.log('  population: ' + list.length + ' git repo(s) found');
console.log('  Everything below is READ from git and gh. Nothing here knows what a');
console.log('  session is doing — join on cwd AND branch, then ASK about the rest.\n');

for (const r of results) {
    console.log('### ' + r.name + (r.isClient ? '   [CLIENT — bitbucket remote]' : ''));
    console.log('  branch ' + r.branch + '   trunk ' + (r.trunk || 'COULD NOT CHECK'));
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
console.log('  more than 50 behind trunk: ' + (stale.join(', ') || 'none'));
console.log('  node projects naming no gate script: ' + (noGate.join(', ') || 'none'));
console.log('  repos where gh could not answer: '
    + (results.filter((r) => r.prs === null).map((r) => r.name).join(', ') || 'none'));
console.log('');
