#!/usr/bin/env node
// Tests for scripts/worktree-reap.js: a linked worktree is removed only when
// its work landed, nothing is lost with it, and nobody is using it.
// Run: node tooling/test-worktree-reap.js
// Exits 1 on any failure, 0 if all pass, 2 if a spawn produced no verdict.
//
// One fixture repository with a bare origin carries a worktree per case. Each
// case is built with real git (merge commit, fast-forward, cherry-pick,
// squash) so the evidence the reaper reads is the evidence git writes. Pull
// requests, the process list and the transcript directories are planted
// through the reaper's own seams, so no network and no real session is read.
// Every assertion about a removal is made on disk, not on what was printed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classify, reason, runBudgeted, tally, exitCode } = require('./spawn-budget.js');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'worktree-reap.js');
const reaper = require(SCRIPT);
const residue = require(path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'worktree-residue.js'));
const WIN = process.platform === 'win32';

let pass = 0;
let fail = 0;
let infra = 0;
const failures = [];

function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `  (${detail})` : ''}`);
}

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) process.env[k] = v;

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wtr')));
const NOHOOKS = path.join(TMP, 'nohooks');

function g(cwd, ...args) {
    const r = spawnSync('git', ['-c', `core.hooksPath=${NOHOOKS}`, '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
    return r.stdout.trim();
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function commit(dir, file, text, msg) { write(path.join(dir, file), text); g(dir, 'add', file); g(dir, 'commit', '-q', '-m', msg); return g(dir, 'rev-parse', 'HEAD'); }

const PROJECTS = path.join(TMP, 'projects');
const PROCS = path.join(TMP, 'procs.json');
const PRS = path.join(TMP, 'prs.json');
const LOCK = path.join(TMP, 'gate', 'full-gate.lock');
write(PROCS, JSON.stringify([{ pid: 1, ppid: 0, commandLine: 'idle', executablePath: '' }]));
write(PRS, '[]');
const ENV = { ...process.env, AUTODEV_REAP_PROJECTS_DIRS: PROJECTS, AUTODEV_REAP_TEST_PROCS: PROCS, AUTODEV_REAP_TEST_PRS: PRS, AUTODEV_GATE_LOCK_PATH: LOCK };

/** Backdates a worktree's git admin files, so the idle check sees it as untouched for `hours`. */
function age(main, wt, hours = 3) {
    const admin = g(wt, 'rev-parse', '--absolute-git-dir');
    const t = (Date.now() - hours * 3600000) / 1000;
    for (const f of ['HEAD', 'index', path.join('logs', 'HEAD')]) { try { fs.utimesSync(path.join(admin, f), t, t); } catch { /* absent */ } }
}

// ---------------------------------------------------------------------------
// The fixture.
// ---------------------------------------------------------------------------

const origin = path.join(TMP, 'origin.git');
const main = path.join(TMP, 'main');
spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
fs.mkdirSync(main);
g(main, 'init', '-q', '-b', 'main');
g(main, 'remote', 'add', 'origin', origin);
write(path.join(main, '.gitignore'), 'node_modules/\n.env.local\n.claude/\n');
write(path.join(main, '.env.local'), 'KEY=shared\n');
commit(main, 'a.txt', 'a\n', 'init');
g(main, 'add', '.gitignore'); g(main, 'commit', '-q', '-m', 'ignore');
g(main, 'push', '-q', '-u', 'origin', 'main');
g(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
g(main, 'remote', 'set-head', 'origin', 'main');

const W = {};
const wtPath = (name) => path.join(main, '.claude', 'worktrees', name);
function addWt(name, opts = {}) {
    const dir = wtPath(name);
    if (opts.detach) g(main, 'worktree', 'add', '-q', '--detach', dir, 'main');
    else g(main, 'worktree', 'add', '-q', '-b', `b/${name}`, dir, 'main');
    W[name] = dir;
    return dir;
}
const syncMain = () => { g(main, 'push', '-q', 'origin', 'main'); g(main, 'fetch', '-q', 'origin'); };

// merge: merged into main by a merge commit, branch pushed.
let d = addWt('merge');
commit(d, 'm.txt', 'm\n', 'merge work');
g(d, 'push', '-q', 'origin', 'b/merge');
g(main, 'merge', '-q', '--no-ff', '-m', 'merge b/merge', 'b/merge');
// ff: fast-forwarded into main, never pushed as a branch.
d = addWt('ff');
commit(d, 'f.txt', 'f\n', 'ff work');
syncMain();
g(main, 'merge', '-q', '--ff-only', 'b/ff');
// rebase: rewritten onto main by cherry-pick, the branch itself never pushed.
d = addWt('rebase');
commit(d, 'r.txt', 'r\n', 'rebase work');
// Main moves first: a pick onto the branch's own parent in the same second
// reproduces the identical commit, and the case would test a fast-forward.
commit(main, 'base.txt', 'b\n', 'main moves first');
g(main, 'cherry-pick', 'b/rebase');
// pr: squashed into main under a different commit, with a merged pull request at its HEAD.
d = addWt('pr');
const prHead = commit(d, 'p.txt', 'p\n', 'pr work');
g(d, 'push', '-q', 'origin', 'b/pr');
write(path.join(main, 'p.txt'), 'p\n'); g(main, 'add', 'p.txt'); g(main, 'commit', '-q', '-m', 'squash of pr');
// open: merged by a merge commit, but an open pull request names the branch.
d = addWt('open');
commit(d, 'o.txt', 'o\n', 'open work');
g(main, 'merge', '-q', '--no-ff', '-m', 'merge b/open', 'b/open');
// more: merged, then a commit nobody pushed.
d = addWt('more');
commit(d, 'x.txt', 'x\n', 'more work');
g(main, 'merge', '-q', '--no-ff', '-m', 'merge b/more', 'b/more');
commit(d, 'x2.txt', 'x2\n', 'after the merge');
// dirty, envsame, envdiff, active, transcript, proc, junction: each merged by a merge commit.
for (const name of ['dirty', 'envsame', 'envdiff', 'active', 'transcript', 'served', 'junction', 'recheck']) {
    d = addWt(name);
    commit(d, `${name}.txt`, `${name}\n`, `${name} work`);
    g(main, 'merge', '-q', '--no-ff', '-m', `merge b/${name}`, `b/${name}`);
}
write(path.join(W.dirty, 'notes.txt'), 'only here\n');
write(path.join(W.envsame, '.env.local'), 'KEY=shared\n');
write(path.join(W.envdiff, '.env.local'), 'KEY=only-here\n');
write(path.join(W.envsame, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
// fresh: created at main's tip, nothing committed. detached, locked: no branch or a lock.
addWt('fresh');
addWt('detached', { detach: true });
d = addWt('locked');
commit(d, 'l.txt', 'l\n', 'locked work');
g(main, 'merge', '-q', '--no-ff', '-m', 'merge b/locked', 'b/locked');
g(main, 'worktree', 'lock', W.locked);
syncMain();

// A junction (a directory symlink off Windows) in node_modules pointing out of the worktree.
const outside = path.join(TMP, 'outside');
write(path.join(outside, 'canary.txt'), 'alive\n');
fs.mkdirSync(path.join(W.junction, 'node_modules'), { recursive: true });
fs.symlinkSync(outside, path.join(W.junction, 'node_modules', 'link'), WIN ? 'junction' : 'dir');

write(PRS, JSON.stringify([
    { number: 7, state: 'MERGED', headRefName: 'b/pr', headRefOid: prHead },
    { number: 8, state: 'OPEN', headRefName: 'b/open', headRefOid: g(W.open, 'rev-parse', 'HEAD') },
]));
for (const name of Object.keys(W)) if (name !== 'active') age(main, W[name]);
const slugDir = residue.transcriptDirs(W.transcript, ENV)[0];
write(path.join(slugDir, 'session.jsonl'), '{}\n');
write(PROCS, JSON.stringify([{ pid: 1, ppid: 0, commandLine: 'idle', executablePath: '' },
    { pid: 4242, ppid: 1, commandLine: `node server.js --root "${W.served}"`, executablePath: '' }]));

function run(args, env = ENV, expect) {
    const r = runBudgeted(process.execPath, [SCRIPT, ...args], { cwd: TMP, env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxTimeout: 600000 });
    if (classify(r, expect) === 'infrastructure') { infra++; console.error(`infrastructure: worktree-reap ${args.join(' ')} produced no verdict (${reason(r)})`); }
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not json */ }
    return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}
const rowOf = (res, name) => (res.json ? res.json.worktrees.find((w) => path.resolve(w.path) === path.resolve(W[name])) : null);
const reasons = (row) => (row ? row.reasons.join(' | ') : 'no row');

// ---------------------------------------------------------------------------
// 1. The dry run judges every case and removes nothing.
// ---------------------------------------------------------------------------

const names = Object.keys(W);
console.log(`Population: ${names.length} linked worktrees in one repo (${names.join(', ')}), plus its main checkout.`);
console.log('Subject: worktree-reap.js removes a worktree only when its work landed, it is idle and clean, and nothing claims it.\n');

const dry = run(['--repo', main, '--json', '--idle-hours', '1', '--no-fetch']);
check('dry run exits 0 and prints JSON', dry.exit === 0 && dry.json !== null, dry.stderr || dry.stdout.slice(0, 300));
check('the main checkout is never a candidate', dry.json && !dry.json.worktrees.some((w) => path.resolve(w.path) === path.resolve(main)));
check('every linked worktree is judged', dry.json && dry.json.worktrees.length === names.length, dry.json && dry.json.worktrees.length);

const eligible = { merge: /merged into origin\/main/, ff: /fast-forwarded into origin\/main/, rebase: /rebased in/, pr: /pull request #7 is merged/, envsame: /merged into/, junction: /merged into/ };
for (const [name, re] of Object.entries(eligible)) {
    const row = rowOf(dry, name);
    check(`${name}: landed, idle and clean, so it is a candidate (${re.source})`, row && row.eligible && re.test(row.evidence || ''), row ? `${row.evidence} / ${reasons(row)}` : 'no row');
}
const kept = {
    open: /pull request #8 for its branch is open/,
    more: /1 of its 1 commits have no equivalent/,
    dirty: /1 changed or untracked: notes\.txt/,
    envdiff: /1 ignored file exist[s]? only here: \.env\.local/,
    active: /within the 1h idle window/,
    transcript: /a session transcript was written/,
    served: /pid 4242 runs with this worktree's path/,
    fresh: /where the branch was created/,
    detached: /HEAD is detached/,
    locked: /git has it locked/,
};
for (const [name, re] of Object.entries(kept)) {
    const row = rowOf(dry, name);
    check(`${name}: kept, and the reason says why (${re.source})`, row && !row.eligible && re.test(reasons(row)), reasons(row));
}
check('the dry run removed nothing', names.every((n) => fs.existsSync(W[n])));
const human = run(['--repo', main, '--idle-hours', '1', '--no-fetch']);
check('the human report names the dry run and every kept worktree', human.exit === 0 && /Dry run: pass --apply/.test(human.stdout) && /keep\s+.*fresh/.test(human.stdout), human.stdout.slice(-400));

// ---------------------------------------------------------------------------
// 2. Fail closed: pull requests unreadable, origin unreachable.
// ---------------------------------------------------------------------------

const PRS_BAD = path.join(TMP, 'prs-bad.json');
write(PRS_BAD, JSON.stringify({ unreadable: 'gh is not signed in' }));
const noPr = run(['--repo', main, '--json', '--idle-hours', '1', '--no-fetch'], { ...ENV, AUTODEV_REAP_TEST_PRS: PRS_BAD });
for (const name of ['merge', 'ff', 'rebase', 'pr']) {
    const row = rowOf(noPr, name);
    check(`${name}: kept when pull requests cannot be read`, row && !row.eligible && /pull requests cannot be read|not landed/.test(reasons(row)), reasons(row));
}

const lone = path.join(TMP, 'lone');
fs.mkdirSync(lone);
g(lone, 'init', '-q', '-b', 'main');
commit(lone, 'a.txt', 'a\n', 'init');
g(lone, 'remote', 'add', 'origin', path.join(TMP, 'no-such-origin.git'));
const loneWt = path.join(lone, '.claude', 'worktrees', 'x');
g(lone, 'worktree', 'add', '-q', '-b', 'x', loneWt);
const fetchFail = run(['--repo', lone, '--json', '--idle-hours', '1']);
const loneRow = fetchFail.json && fetchFail.json.worktrees[0];
check('a failed fetch keeps every worktree of that repo and says so', fetchFail.exit === 0 && loneRow && !loneRow.eligible && /fetching origin failed/.test(reasons(loneRow)), fetchFail.stdout.slice(0, 400));
const both = run(['--repo', path.join(TMP, 'missing'), '--repo', main, '--json', '--idle-hours', '1', '--no-fetch']);
check('a repo that cannot be read is reported and the others still run', both.exit === 0 && both.json && both.json.repos[0].why && both.json.worktrees.length === names.length, both.stdout.slice(0, 300));

// ---------------------------------------------------------------------------
// 3. A worktree that changes between the assessment and the removal is kept.
// ---------------------------------------------------------------------------

const opts = reaper.parseArgs(['--repo', main, '--idle-hours', '1', '--no-fetch']);
const report = reaper.assess({ repos: [main], base: LOCK, opts, env: ENV });
const recheckRow = report.worktrees.find((w) => path.resolve(w.path) === path.resolve(W.recheck));
check('recheck: a candidate at assessment time', recheckRow && recheckRow.eligible, recheckRow && recheckRow.reasons.join(' | '));
write(path.join(W.recheck, 'late.txt'), 'written after the assessment\n');
const onlyRecheck = { worktrees: report.worktrees.filter((w) => w === recheckRow) };
const res = reaper.apply(onlyRecheck, LOCK, opts, ENV);
check('recheck: judged again inside the mutex, kept, and not removed', res.length === 1 && res[0].outcome === 'kept' && /no longer eligible/.test(res[0].why) && fs.existsSync(W.recheck), JSON.stringify(res));

// ---------------------------------------------------------------------------
// 4. --apply removes the candidates, and only them.
// ---------------------------------------------------------------------------

const applied = run(['--repo', main, '--json', '--idle-hours', '1', '--no-fetch', '--apply']);
check('--apply exits 0 with no failed removal', applied.exit === 0 && applied.json && applied.json.failed === 0, applied.stdout.slice(0, 600) + applied.stderr);
for (const name of Object.keys(eligible)) check(`${name}: removed from disk and from git's list`, !fs.existsSync(W[name]) && !new RegExp(`refs/heads/b/${name}(\\n|$)`).test(g(main, 'worktree', 'list', '--porcelain')));
for (const name of [...Object.keys(kept), 'recheck']) check(`${name}: still on disk`, fs.existsSync(W[name]));
check('the branches of removed worktrees are kept', ['merge', 'ff', 'rebase', 'pr'].every((n) => g(main, 'branch', '--list', `b/${n}`) !== ''));
check('a junction out of a removed worktree was not followed: the canary outside survives', fs.readFileSync(path.join(outside, 'canary.txt'), 'utf8') === 'alive\n');
check("the main checkout's own .env.local is untouched", fs.readFileSync(path.join(main, '.env.local'), 'utf8') === 'KEY=shared\n');
const again = run(['--repo', main, '--json', '--idle-hours', '1', '--no-fetch', '--apply']);
check('a second --apply finds nothing more to remove', again.exit === 0 && again.json && again.json.removed === 0, again.stdout.slice(0, 300));

// ---------------------------------------------------------------------------
// 5. Helpers and the CLI surface.
// ---------------------------------------------------------------------------

const st = reaper.parseStatusZ('R  new.txt\0old.txt\0?? u.txt\0!! node_modules/\0');
check('parseStatusZ drops a rename source and keeps the others', st.length === 3 && st[0].path === 'new.txt' && st[1].xy === '??' && st[2].path === 'node_modules/', JSON.stringify(st));
check('residue: node_modules and .next are regenerable, .claude/handoffs is not',
    residue.isRegenerable('node_modules/') && residue.isRegenerable('site/.next/') && !residue.isRegenerable('.claude/handoffs/h.md'));
check('residue: every profile directory under the home is read', residue.transcriptDirs('C:/x/y', { USERPROFILE: TMP, HOME: TMP }).length >= 1);
const help = run(['--help']);
check('--help exits 0, prints the header, and runs nothing', help.exit === 0 && /removes the linked worktrees whose work has landed/.test(help.stdout) && !/\[worktree-reap\]/.test(help.stdout), help.stdout.slice(0, 200));
for (const [args, re] of [[[], /name at least one --repo/], [['--repo'], /--repo needs a value/], [['--repo', main, '--idle-hours', '0'], /--idle-hours must be/], [['--bogus'], /unknown argument --bogus/]]) {
    const r = run(args, ENV, 'exit2');
    check(`usage error exits 2: ${args.join(' ') || '(no arguments)'}`, r.exit === 2 && re.test(r.stderr), r.stderr);
}

try { g(main, 'worktree', 'unlock', W.locked); } catch { /* best effort */ }
fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });

console.log(`\n${tally(pass, fail, infra)}`);
if (failures.length) console.log(`Failed:\n  ${failures.join('\n  ')}`);
process.exitCode = exitCode(fail, infra);
