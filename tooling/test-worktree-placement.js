#!/usr/bin/env node
'use strict';
// Tests for plugins/autodev-core/scripts/worktree-placement.js, the detector for
// worktrees outside <repo>/.claude/worktrees/ and loose files in the code root.
// Run: node tooling/test-worktree-placement.js
//
// Every case drives the script as a SUBPROCESS over REAL git repos and real
// worktrees in a temp fixture, because the subject's whole job is reading what
// git and the filesystem say. The fixture lives under the OS temp dir, which is
// also the detector's default transient root, so every run pins
// AUTODEV_TRANSIENT_ROOTS: left unset, every fixture worktree would be exempt
// and the suite would pass on a detector that flags nothing.
//
// The assertions come in pairs: each planted stray must be reported AND each
// correctly placed worktree must not be, or a detector that flags everything
// passes as well as one that flags correctly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'worktree-placement.js');
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wt placement-')));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
    if (ok) { passed++; return; }
    failures.push(name + (detail ? '\n      ' + String(detail).slice(0, 600) : ''));
}

const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
function git(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
    return r.stdout.trim();
}
function repo(dir) {
    mk(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'suite@example.invalid');
    git(dir, 'config', 'user.name', 'suite');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'init');
    return dir;
}
function run(args, env = {}) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], {
        encoding: 'utf8', cwd: ROOT,
        env: { ...process.env, AUTODEV_CODE_DIR: '', AUTODEV_TRANSIENT_ROOTS: path.join(ROOT, 'transient'), ...env },
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* text mode */ }
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}
const has = (list, p) => list.some((x) => path.relative(x.path, p) === '');

// ---------------------------------------------------------------- fixture
// code/alpha                      repo in the code root
// code/alpha/.claude/worktrees/ok placed          -> not a finding
// code/alpha-sibling              sibling worktree -> MISPLACED, reported once
// transient/alpha-gate            under the transient root -> not a finding
// code/stray.log                  loose file      -> stray
// code/scratch.git                bare clone      -> stray
// code/notes                      non-git dir     -> left alone
// code/.claude, code/desktop.ini  harness dir, OS metadata -> left alone
// elsewhere/beta                  repo OUTSIDE the code root, given by --repo
// elsewhere/beta-side             its sibling worktree -> MISPLACED, only via --repo
// code/gamma-wt                   worktree of a repo nobody listed -> stray worktree
const CODE = mk(ROOT, 'code');
const alpha = repo(path.join(CODE, 'alpha'));
git(alpha, 'worktree', 'add', '-q', path.join('.claude', 'worktrees', 'ok'), '-b', 'ok');
git(alpha, 'worktree', 'add', '-q', path.join(CODE, 'alpha-sibling'), '-b', 'sib');
mk(ROOT, 'transient');
git(alpha, 'worktree', 'add', '-q', '--detach', path.join(ROOT, 'transient', 'alpha-gate'));
fs.writeFileSync(path.join(CODE, 'stray.log'), 'x\n');
git(ROOT, 'clone', '-q', '--bare', alpha, path.join(CODE, 'scratch.git'));
mk(CODE, 'notes');
mk(CODE, '.claude', 'reports');
fs.writeFileSync(path.join(CODE, 'desktop.ini'), '[.ShellClassInfo]\n');
const beta = repo(path.join(ROOT, 'elsewhere', 'beta'));
git(beta, 'worktree', 'add', '-q', path.join(ROOT, 'elsewhere', 'beta-side'), '-b', 'side');
const gamma = repo(path.join(ROOT, 'unlisted', 'gamma'));
git(gamma, 'worktree', 'add', '-q', path.join(CODE, 'gamma-wt'), '-b', 'g');

try {
    // 1. The full survey, both probes.
    const full = run(['--code-root', CODE, '--repo', beta, '--json']);
    const r = full.json;
    check('1. a finding exits 1', full.status === 1, full.status + ' ' + full.stderr);
    check('1. JSON parses', !!r, full.stdout.slice(0, 300));
    if (r) {
        check('1. population: alpha and beta scanned, gamma not (not in the code root, not given)', r.reposScanned.length === 2, JSON.stringify(r.reposScanned));
        check('1. the sibling worktree in the code root is MISPLACED', has(r.misplaced, path.join(CODE, 'alpha-sibling')), JSON.stringify(r.misplaced));
        check('1. a sibling OUTSIDE the code root is MISPLACED through --repo', has(r.misplaced, path.join(ROOT, 'elsewhere', 'beta-side')), JSON.stringify(r.misplaced));
        check('1. the worktree under .claude/worktrees is not a finding', !has(r.misplaced, path.join(alpha, '.claude', 'worktrees', 'ok')) && r.counts.placed === 1, JSON.stringify(r.counts));
        check('1. the worktree under the transient root is counted transient, not misplaced', r.counts.transient === 1 && !has(r.misplaced, path.join(ROOT, 'transient', 'alpha-gate')), JSON.stringify(r.counts));
        check('1. exactly two misplaced, and the counts add up', r.counts.misplaced === 2 && r.counts.total === r.counts.main + r.counts.placed + r.counts.transient + r.counts.missing + r.counts.misplaced, JSON.stringify(r.counts));
        check('1. the loose file is a stray', r.strays.some((s) => s.kind === 'file' && path.basename(s.path) === 'stray.log'), JSON.stringify(r.strays));
        check('1. the bare clone is a stray', r.strays.some((s) => s.kind === 'bare-clone' && path.basename(s.path) === 'scratch.git'), JSON.stringify(r.strays));
        check('1. a worktree of an unlisted repo is a stray worktree naming its owner',
            r.strays.some((s) => s.kind === 'worktree' && path.basename(s.path) === 'gamma-wt' && path.relative(s.owner, gamma) === ''), JSON.stringify(r.strays));
        check('1. the sibling both probes see is reported once, not again as a stray', !r.strays.some((s) => path.basename(s.path) === 'alpha-sibling'), JSON.stringify(r.strays));
        check('1. non-git dir, .claude and desktop.ini are not strays',
            !r.strays.some((s) => ['notes', '.claude', 'desktop.ini'].includes(path.basename(s.path))) && r.strays.length === 3, JSON.stringify(r.strays));
    }

    // 2. The text report states its population before any verdict.
    const text = run(['--code-root', CODE, '--repo', beta]);
    check('2. text: population line with repo and worktree counts', /population: 2 repo\(s\) listed 6 worktree\(s\): 2 main, 1 under \.claude\/worktrees, 1 transient, 0 missing on disk, 2 MISPLACED/.test(text.stdout), text.stdout);
    check('2. text: code root line counts every entry kind', /code root .*: 8 entries \(1 repo, 1 dir, 1 dot-dir, 1 file, 2 worktree, 1 bare-clone, 1 metadata\)/.test(text.stdout), text.stdout);

    // 3. The same tree with the strays gone reads clean, and says so over a population.
    const cleanCode = mk(ROOT, 'clean-code');
    const delta = repo(path.join(cleanCode, 'delta'));
    git(delta, 'worktree', 'add', '-q', path.join('.claude', 'worktrees', 'w1'), '-b', 'w1');
    const clean = run(['--code-root', cleanCode]);
    check('3. a clean tree exits 0', clean.status === 0, clean.stdout);
    check('3. a clean tree still prints its population and a stated zero', /population: 1 repo\(s\) listed 2 worktree\(s\)/.test(clean.stdout) && /none misplaced, no strays/.test(clean.stdout), clean.stdout);

    // 4. With the transient root unset to nothing, the gate worktree is a finding again:
    // the exemption comes from the root, not from a hardcoded path.
    const noTransient = run(['--code-root', CODE, '--repo', beta, '--json'], { AUTODEV_TRANSIENT_ROOTS: '' });
    check('4. no transient roots: the temp-dir worktree becomes MISPLACED', noTransient.json && has(noTransient.json.misplaced, path.join(ROOT, 'transient', 'alpha-gate')), noTransient.stdout.slice(0, 300));

    // 5. Nothing scannable is exit 2 and COULD NOT CHECK, never a clean zero.
    const blind = run([], { AUTODEV_CODE_DIR: path.join(ROOT, 'no such dir') });
    check('5. no code root and no repos exits 2', blind.status === 2, blind.status + ' ' + blind.stdout);
    check('5. and says COULD NOT CHECK instead of "none misplaced"', /COULD NOT CHECK - code root/.test(blind.stdout), blind.stdout);

    // 6. A repo git cannot read is named, not dropped.
    const bogus = mk(ROOT, 'not-a-repo');
    const unreadable = run(['--code-root', cleanCode, '--repo', bogus, '--json']);
    check('6. an unreadable --repo is listed with a reason', unreadable.json && unreadable.json.reposUnreadable.length === 1, unreadable.stdout.slice(0, 300));

    // 7. --help returns without scanning.
    const help = run(['--help']);
    check('7. --help exits 0 and prints the header', help.status === 0 && /worktree-placement\.js/.test(help.stdout), help.stdout.slice(0, 200));
} finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp dir; leave it */ }
}

const total = passed + failures.length;
if (failures.length) {
    console.error('worktree-placement: ' + passed + '/' + total + ' passed, ' + failures.length + ' FAILED\n');
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log('worktree-placement: ' + passed + '/' + total + ' passed over real repos: 2 misplaced, 3 strays, 1 placed, 1 transient, and the clean, blind and unreadable controls');
