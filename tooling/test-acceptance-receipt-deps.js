#!/usr/bin/env node
'use strict';
// acceptance-receipt.js verify runs each check in a fresh detached worktree. A
// fresh tree has no node_modules, so a product check that needs a dependency
// could never pass there `[measured 2026-11-16]`: "playwright-core: not
// installed", "'next' is not recognized". verify now links the main checkout's
// install into the tree with shared-install.js before the checks run.
//
// Real git repos in a temp dir, the real CLI as a subprocess, HOME pointed at the
// temp dir. No network and no real npm: the lockfile, the hidden lockfile and the
// package are written by hand.
//   L1  with the main checkout installed, a check that requires the dependency passes
//   L2  the receipt records the install root as shared
//   L3  the main checkout's install is intact afterwards, and the clean tree is gone
//   L4  control: with no install in the main checkout the same check fails, the
//       receipt says install, and verify installs nothing
process.env.AUTODEV_CAPACITY = 'off';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const SUBJECT = process.env.ACCEPTANCE_RECEIPT_SUBJECT || path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'acceptance-receipt.js');
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-deps-')));
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: '0', AUTODEV_LEDGER_LOCK_WAIT_MS: '300', AUTODEV_CAPACITY: 'off' };
delete env.CLAUDE_CONFIG_DIR;
delete env.AUTODEV_HEADLESS;
const ledger = path.join(home, '.claude', 'autodev', 'unattended-workers.json');
let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main',
    '-c', 'core.hooksPath=' + path.join(scratch, 'no-hooks'), ...args], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// One dependency the check requires. Its text is what the check must print.
const DEP_TEXT = 'fixture dependency loaded';
const LOCK = { name: 'fx', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'fx', version: '1.0.0', dependencies: { 'fx-dep': '1.0.0' } },
    'node_modules/fx-dep': { version: '1.0.0' },
} };
const BRIEF = ['MISSION. Use the dependency.', '', '## Acceptance criteria', '- AC1: the dependency loads',
    '  check: node use-dep.js', `  expect: /^${DEP_TEXT}$/`, ''].join('\n');

function repoWith(name, installed) {
    const repo = path.join(scratch, name);
    g(scratch, 'init', '-q', repo);
    write(path.join(repo, '.gitignore'), 'node_modules/\n');
    write(path.join(repo, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', dependencies: { 'fx-dep': '1.0.0' } }, null, 2) + '\n');
    write(path.join(repo, 'package-lock.json'), JSON.stringify(LOCK, null, 2) + '\n');
    write(path.join(repo, 'use-dep.js'), "console.log(require('fx-dep'));\n");
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'init');
    if (installed) {
        const nm = path.join(repo, 'node_modules');
        write(path.join(nm, 'fx-dep', 'package.json'), JSON.stringify({ name: 'fx-dep', version: '1.0.0', main: 'index.js' }) + '\n');
        write(path.join(nm, 'fx-dep', 'index.js'), `module.exports = '${DEP_TEXT}';\n`);
        write(path.join(nm, '.package-lock.json'), JSON.stringify({ ...LOCK, packages: { ...LOCK.packages } }, null, 2) + '\n');
    }
    // The worker's branch: one commit of work on top.
    g(repo, 'branch', 'claude/work');
    const wt = path.join(scratch, `wt-${name}`);
    g(repo, 'worktree', 'add', '-q', wt, 'claude/work');
    write(path.join(wt, 'work.txt'), 'work\n');
    g(wt, 'add', 'work.txt');
    g(wt, 'commit', '-q', '-m', 'work');
    g(repo, 'worktree', 'remove', '--force', wt);
    return repo;
}

function task(slug, repo) {
    const taskId = `worker-${slug}`;
    const dir = path.join(home, '.claude', 'autodev', 'reports', taskId);
    write(path.join(dir, 'BRIEF.md'), BRIEF);
    write(path.join(dir, 'REPORT.md'), `did it\nRESULT ${slug} done: x\n`);
    const l = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : { version: 1, records: [] };
    l.records.push({ taskId, repo, slug, branch: 'claude/work', state: 'closed', channel: 'headless', runStatus: 'succeeded',
        startedAt: new Date().toISOString(), attemptId: crypto.randomUUID(), briefFile: path.join(dir, 'BRIEF.md'), briefSha256: sha(BRIEF),
        report: path.join(dir, 'REPORT.md'), launch: { model: null, effort: null, permissionMode: 'bypassPermissions', configDir: null },
        headless: { code: slug, version: 'test', keepTools: [] } });
    write(ledger, JSON.stringify(l, null, 2));
    return taskId;
}

function verify(taskId) {
    const r = spawnSync(process.execPath, [SUBJECT, 'verify', '--task-id', taskId, '--ledger', ledger], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* a crash */ }
    return { status: r.status, value: json && json.ok ? json.value : null, detail: `${r.status} ${(r.stdout || '').slice(0, 600)} ${(r.stderr || '').slice(0, 300)}` };
}
const worktrees = (repo) => g(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

try {
    const repo = repoWith('installed', true);
    const depFile = path.join(repo, 'node_modules', 'fx-dep', 'index.js');
    const v = verify(task('installed', repo));
    const vv = v.value || {};
    const ac1 = (vv.criteria || [])[0] || {};
    check('L1. with the main checkout installed, the dependency check passes', v.status === 0 && vv.complete === true && ac1.pass === true && ac1.exit === 0, v.detail);
    const receipt = vv.file && fs.existsSync(vv.file) ? JSON.parse(fs.readFileSync(vv.file, 'utf8')) : {};
    const root = ((receipt.dependencies || {}).roots || [])[0] || {};
    check('L2. the receipt records the install root as shared', root.root === '.' && root.state === 'shared' && receipt.dependencies.exit === 0, JSON.stringify(receipt.dependencies));
    check('L3. the main checkout\'s install is intact afterwards', fs.existsSync(depFile) && fs.readFileSync(depFile, 'utf8').includes(DEP_TEXT)
        && fs.existsSync(path.join(repo, 'node_modules', '.package-lock.json')), depFile);
    check('L3. the clean tree is removed afterwards', worktrees(repo) === 1, `${worktrees(repo)} worktrees registered`);

    const bare = repoWith('bare', false);
    const b = verify(task('bare', bare));
    const bv = b.value || {};
    const bc = (bv.criteria || [])[0] || {};
    const broot = (((bv.dependencies || {}).roots) || [])[0] || {};
    check('L4. control: with no install in the main checkout the check fails', b.status === 0 && bv.complete === false && bc.pass === false && bc.exit !== 0, b.detail);
    check('L4. control: the receipt says the root needs its own install', broot.state === 'install' && /no node_modules/.test(broot.reason), JSON.stringify(bv.dependencies));
    check('L4. control: verify installed nothing in the main checkout', !fs.existsSync(path.join(bare, 'node_modules')), bare);
} catch (e) {
    check('the suite ran to the end', false, e.stack.split('\n').slice(0, 3).join(' | '));
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`acceptance-receipt-deps: ${total} checks, ${failed} failed`);
process.exitCode = failed || total !== 7 ? 1 : 0;
