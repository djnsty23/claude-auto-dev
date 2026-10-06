#!/usr/bin/env node
// Tests for scripts/shared-install.js and hooks/shared-install-guard.js: a
// worktree gets the main checkout's node_modules as hardlinks, and nothing the
// worktree does may change the main checkout's files.
// Run: node tooling/test-shared-install.js
// Exits 1 on any failure, 0 if all pass, 2 if a spawn produced no verdict.
//
// THE TWO PLANTED CASES are the point of this suite, and each asserts on the
// MAIN checkout, not on what the script printed:
//
//   A. LOCKFILE DIVERGENCE. The worktree's package-lock.json differs from the
//      main checkout's. `link` must refuse, create nothing, and name `npm ci`.
//      Then the divergence is planted AFTER a link: `link` again must remove
//      the worktree's links, and the main checkout's files must be back to one
//      link each with their bytes unchanged.
//   B. THE WORKER RUNS AN INSTALL. The guard hook gets `npm install` from
//      inside a shared worktree and must deny it, naming `unshare`. The suite
//      runs the command the deny names, and the same payload must then pass
//      with zero bytes. The marker is the only variable between the arms.
//
// No network and no real npm: the fixture's lockfile, hidden lockfile and
// packages are written by hand, so the suite measures this code and nothing
// the registry does. The real-app run (Next.js 16, Vitest, Vite, Playwright)
// is recorded in docs/shared-install.md.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classify, reason, runBudgeted, tally, exitCode } = require('./spawn-budget.js');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'shared-install.js');
const HOOK = path.join(ROOT, 'plugins', 'autodev-core', 'hooks', 'shared-install-guard.js');
const si = require(SCRIPT);
const guard = require(HOOK);

let pass = 0;
let fail = 0;
let infra = 0;
const failures = [];

function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `  (${detail})` : ''}`);
}

function sh(cwd, cmd, args) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
}

function runNode(file, args, input, expect) {
    const r = runBudgeted(process.execPath, [file, ...args], {
        input: input === undefined ? '' : input, encoding: 'utf8', windowsHide: true, timeout: 30000, maxTimeout: 300000,
    });
    if (classify(r, expect) === 'infrastructure') {
        infra++;
        console.error(`infrastructure: ${path.basename(file)} ${args.join(' ')} produced no verdict (${reason(r)})`);
    }
    return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const cli = (...args) => runNode(SCRIPT, args);
// A usage error exits 2 by contract, so these calls tell classify() that 2 is the verdict.
const cli2 = (...args) => runNode(SCRIPT, args, undefined, 'exit2');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const nlink = (file) => fs.statSync(file).nlink;
const sameFile = (a, b) => { const x = fs.statSync(a), y = fs.statSync(b); return x.ino === y.ino && x.dev === y.dev; };

const LOCK = {
    name: 'fx', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
        '': { name: 'fx', version: '1.0.0', workspaces: ['packages/a'], dependencies: { 'left-pad': '1.3.0' } },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/tool': { version: '2.0.0', dev: true, bin: { tool: 'bin/tool.js' } },
        'node_modules/fsevents': { version: '2.3.3', optional: true },
        'node_modules/@ws/a': { resolved: 'packages/a', link: true },
        'packages/a': { name: '@ws/a', version: '0.1.0' },
        'packages/a/node_modules/left-pad': { version: '1.1.0' },
    },
};

/** A main checkout with an npm install written by hand, and one linked worktree. */
function fixture(tag, root = os.tmpdir()) {
    const base = fs.mkdtempSync(path.join(root, `si${tag}`));
    const main = path.join(base, 'main');
    fs.mkdirSync(main);
    sh(main, 'git', ['init', '-q', '-b', 'main']);
    sh(main, 'git', ['config', 'user.email', 'fx@example.invalid']);
    sh(main, 'git', ['config', 'user.name', 'fx']);
    sh(main, 'git', ['config', 'core.autocrlf', 'false']);
    write(path.join(main, '.gitignore'), 'node_modules\n');
    write(path.join(main, 'package.json'), '{"name":"fx","version":"1.0.0","workspaces":["packages/a"]}\n');
    write(path.join(main, 'package-lock.json'), JSON.stringify(LOCK, null, 2) + '\n');
    write(path.join(main, 'packages', 'a', 'package.json'), '{"name":"@ws/a","version":"0.1.0"}\n');
    write(path.join(main, 'packages', 'a', 'index.js'), 'module.exports = "a";\n');
    sh(main, 'git', ['add', '.']);
    sh(main, 'git', ['commit', '-q', '-m', 'fixture']);
    const nm = path.join(main, 'node_modules');
    write(path.join(nm, 'left-pad', 'index.js'), 'module.exports = "1.3.0";\n');
    write(path.join(nm, 'left-pad', 'package.json'), '{"name":"left-pad","version":"1.3.0"}\n');
    write(path.join(nm, 'tool', 'bin', 'tool.js'), 'console.log("tool");\n');
    write(path.join(nm, '.bin', 'tool.cmd'), '@node "%~dp0\\..\\tool\\bin\\tool.js" %*\n');
    write(path.join(nm, '.vite', 'deps', '_metadata.json'), '{"hash":"main"}\n');
    write(path.join(nm, '.cache', 'x'), 'cache\n');
    fs.mkdirSync(path.join(nm, '@ws'), { recursive: true });
    fs.symlinkSync(path.join(main, 'packages', 'a'), path.join(nm, '@ws', 'a'), 'junction');
    write(path.join(main, 'packages', 'a', 'node_modules', 'left-pad', 'index.js'), 'module.exports = "1.1.0";\n');
    const hidden = { name: 'fx', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { ...LOCK.packages } };
    delete hidden.packages[''];
    delete hidden.packages['node_modules/fsevents'];
    write(path.join(nm, '.package-lock.json'), JSON.stringify(hidden, null, 2) + '\n');
    const wt = path.join(main, '.claude', 'worktrees', 'w');
    sh(main, 'git', ['worktree', 'add', '-q', wt, '-b', 'w']);
    return { base, main, wt, nm, wtNm: path.join(wt, 'node_modules') };
}

function cleanup(fx) {
    try { fs.rmSync(fx.base, { recursive: true, force: true }); } catch { /* the runner removes the temp root */ }
}

const payload = (command, cwd) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });

// 1. Happy path: every package file is a hardlink, top-level files and .bin are copies, caches are left out.
{
    const fx = fixture('a');
    const r = cli('link', fx.wt);
    check('1a. link exits 0 on a matching lockfile', r.exit === 0, `${r.exit} ${r.stdout}${r.stderr}`);
    const lp = path.join('left-pad', 'index.js');
    check('1b. a package file is the same file as the main checkout\'s', sameFile(path.join(fx.nm, lp), path.join(fx.wtNm, lp)));
    check('1c. the hidden lockfile is a copy, not a link',
        fs.existsSync(path.join(fx.wtNm, '.package-lock.json')) && !sameFile(path.join(fx.nm, '.package-lock.json'), path.join(fx.wtNm, '.package-lock.json')));
    check('1d. a .bin shim is a copy, not a link', !sameFile(path.join(fx.nm, '.bin', 'tool.cmd'), path.join(fx.wtNm, '.bin', 'tool.cmd')));
    check('1e. .vite and .cache are left out', !fs.existsSync(path.join(fx.wtNm, '.vite')) && !fs.existsSync(path.join(fx.wtNm, '.cache')));
    const wsLink = path.join(fx.wtNm, '@ws', 'a');
    check('1f. a workspace junction is recreated pointing into the worktree',
        fs.lstatSync(wsLink).isSymbolicLink() && path.resolve(fs.realpathSync(wsLink)).toLowerCase() === path.resolve(fs.realpathSync(path.join(fx.wt, 'packages', 'a'))).toLowerCase());
    const nested = path.join('packages', 'a', 'node_modules', 'left-pad', 'index.js');
    check('1g. a nested node_modules the lockfile names is linked too', sameFile(path.join(fx.main, nested), path.join(fx.wt, nested)));
    const marker = si.readMarker(fx.wtNm);
    check('1h. the marker says shared and carries the lockfile hash', marker && marker.state === 'shared' && /^[0-9a-f]{64}$/.test(marker.lockSha));
    check('1i. git status in the worktree is clean', sh(fx.wt, 'git', ['status', '--porcelain']) === '');
    const again = cli('link', fx.wt);
    check('1j. a second link reports already shared and exits 0', again.exit === 0 && /already shared/.test(again.stdout), again.stdout);
    const st = cli('status', fx.wt, '--json');
    check('1k. status reports shared', st.exit === 0 && JSON.parse(st.stdout).roots[0].state === 'shared', st.stdout);
    // A cache the worktree writes is its own: the main checkout's .vite keeps its bytes.
    write(path.join(fx.wtNm, '.vite', 'deps', '_metadata.json'), '{"hash":"worktree"}\n');
    check('1l. a cache written in the worktree does not reach the main checkout',
        fs.readFileSync(path.join(fx.nm, '.vite', 'deps', '_metadata.json'), 'utf8') === '{"hash":"main"}\n');
    cleanup(fx);
}

// 1m. The checkout is reached through an alias (macOS /var is /private/var, a Windows runner's temp is an
// 8.3 short name), so a link target spells the main checkout differently from what git reports. It must
// still be recognised as inside the main checkout and repointed into the worktree.
{
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'sialias'));
    const alias = real + '-via';
    fs.symlinkSync(real, alias, 'junction');
    const fx = fixture('m', alias);
    const r = cli('link', fx.wt);
    const wsLink = path.join(fx.wtNm, '@ws', 'a');
    let into = false;
    try { into = fs.realpathSync.native(wsLink).toLowerCase() === fs.realpathSync.native(path.join(fx.wt, 'packages', 'a')).toLowerCase(); }
    catch { /* no link: the check below fails */ }
    check('1m. under an aliased path, a workspace junction still points into the worktree', r.exit === 0 && into,
        `${r.exit} ${r.stdout}${r.stderr}`);
    cleanup(fx);
    try { fs.unlinkSync(alias); } catch { /* the runner removes the temp root */ }
    try { fs.rmSync(real, { recursive: true, force: true }); } catch { /* the runner removes the temp root */ }
}

// 2. PLANTED A: the worktree's lockfile diverges before any link.
{
    const fx = fixture('b');
    const lock = JSON.parse(fs.readFileSync(path.join(fx.wt, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/left-pad'].version = '1.4.0';
    write(path.join(fx.wt, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    const r = cli('link', fx.wt, '--json');
    const out = r.exit === 1 ? JSON.parse(r.stdout) : null;
    check('2a. PLANTED: a divergent lockfile is refused with exit 1', r.exit === 1, `${r.exit} ${r.stdout}${r.stderr}`);
    check('2b. the refusal names the divergence and npm ci',
        out && out.roots[0].state === 'install' && /differs/.test(out.roots[0].reason) && /npm ci/.test(out.roots[0].install));
    check('2c. no node_modules was created in the worktree', !fs.existsSync(fx.wtNm));
    check('2d. the main checkout\'s files still have one link each', nlink(path.join(fx.nm, 'left-pad', 'index.js')) === 1);
    cleanup(fx);
}

// 3. PLANTED A, after a link: the lockfile changes under a shared tree.
{
    const fx = fixture('c');
    const file = path.join(fx.nm, 'left-pad', 'index.js');
    const before = fs.readFileSync(file, 'utf8');
    cli('link', fx.wt);
    const linked = nlink(file);
    const lock = JSON.parse(fs.readFileSync(path.join(fx.wt, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/zod'] = { version: '3.0.0' };
    write(path.join(fx.wt, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    const r = cli('link', fx.wt);
    check('3a. PLANTED: a lockfile changed after linking unshares, exit 1', r.exit === 1 && /changed since it was shared/.test(r.stdout), `${r.exit} ${r.stdout}`);
    check('3b. the worktree\'s links are gone, the nested ones too',
        !fs.existsSync(fx.wtNm) && !fs.existsSync(path.join(fx.wt, 'packages', 'a', 'node_modules')));
    check('3c. the main checkout\'s file is back to one link with its bytes unchanged',
        linked >= 2 && nlink(file) === 1 && fs.readFileSync(file, 'utf8') === before, `linked ${linked}, now ${nlink(file)}`);
    cleanup(fx);
}

// 4. The main checkout's install does not match its own lockfile.
{
    const fx = fixture('d');
    const hiddenFile = path.join(fx.nm, '.package-lock.json');
    const hidden = JSON.parse(fs.readFileSync(hiddenFile, 'utf8'));
    hidden.packages['node_modules/left-pad'].version = '1.2.0';
    write(hiddenFile, JSON.stringify(hidden));
    const r = cli('link', fx.wt);
    check('4a. a main install out of step with its lockfile is refused', r.exit === 1 && /does not match its lockfile/.test(r.stdout), r.stdout);
    fs.rmSync(hiddenFile);
    const r2 = cli('link', fx.wt);
    check('4b. a missing hidden lockfile is refused', r2.exit === 1 && /missing or unreadable/.test(r2.stdout), r2.stdout);
    cleanup(fx);
}

// 5. Refusals that leave the worktree as it was.
{
    const fx = fixture('e');
    write(path.join(fx.wtNm, 'own', 'index.js'), 'private\n');
    const r = cli('link', fx.wt);
    check('5a. an existing private install is left alone, exit 0', r.exit === 0 && /not shared; left alone/.test(r.stdout), r.stdout);
    fs.rmSync(fx.wtNm, { recursive: true, force: true });
    write(path.join(fx.wt, '.gitignore'), 'dist\n');
    const r2 = cli('link', fx.wt);
    check('5b. node_modules not ignored by git is refused', r2.exit === 1 && /does not ignore/.test(r2.stdout), r2.stdout);
    const r3 = cli2('link', fx.main);
    check('5c. the main checkout itself is refused with exit 2', r3.exit === 2 && /main checkout/.test(r3.stderr), r3.stderr);
    cleanup(fx);
}

// 6. An interrupted link is removed and redone.
{
    const fx = fixture('f');
    write(path.join(fx.wtNm, si.MARKER), JSON.stringify({ v: 1, state: 'linking' }));
    write(path.join(fx.wtNm, 'left-pad', 'partial.js'), 'half\n');
    const r = cli('link', fx.wt);
    check('6a. an interrupted link is removed and relinked', r.exit === 0 && /interrupted link/.test(r.stdout)
        && !fs.existsSync(path.join(fx.wtNm, 'left-pad', 'partial.js')) && si.readMarker(fx.wtNm).state === 'shared', r.stdout);
    const st = cli('status', fx.wt, '--json');
    check('6b. status of a relinked tree is shared', JSON.parse(st.stdout).roots[0].state === 'shared');
    cleanup(fx);
}

// 7. PLANTED B: the worker runs npm install in a shared tree.
{
    const fx = fixture('g');
    const file = path.join(fx.nm, 'left-pad', 'index.js');
    const before = fs.readFileSync(file, 'utf8');
    cli('link', fx.wt);
    const bytes = payload('npm install', fx.wt);
    const denied = runNode(HOOK, [], bytes);
    let decision = null;
    try { decision = JSON.parse(denied.stdout).hookSpecificOutput; } catch { /* checked below */ }
    check('7a. PLANTED: npm install in a shared worktree is denied', decision && decision.permissionDecision === 'deny'
        && denied.exit === 0 && denied.stderr === '', `${denied.exit} ${denied.stdout}${denied.stderr}`);
    const m = decision && decision.permissionDecisionReason.match(/node "([^"]+)" unshare "([^"]+)"/);
    check('7b. the deny names the unshare command for this worktree', !!m && path.resolve(m[2]).toLowerCase() === path.resolve(fx.wt).toLowerCase(), decision && decision.permissionDecisionReason);
    const un = m ? runNode(m[1], ['unshare', m[2]]) : { exit: -1, stdout: '' };
    check('7c. the named command runs and removes the links', un.exit === 0 && !fs.existsSync(fx.wtNm), `${un.exit} ${un.stdout}`);
    const allowed = runNode(HOOK, [], bytes);
    check('7d. MUTATION: the same bytes, marker gone, pass with zero bytes',
        allowed.exit === 0 && allowed.stdout === '' && allowed.stderr === '', `${allowed.stdout}${allowed.stderr}`);
    check('7e. the main checkout\'s file has one link and its bytes', nlink(file) === 1 && fs.readFileSync(file, 'utf8') === before);
    cleanup(fx);
}

// 8. The guard's command shapes, against one shared tree.
{
    const fx = fixture('h');
    cli('link', fx.wt);
    const away = fx.base;
    const wtSlash = fx.wt.replace(/\\/g, '/');
    const deny = [
        ['cd "<wt>" && npm ci', `cd "${wtSlash}" && npm ci`, away],
        ['W=<wt>; cd "$W" && npm i', `W="${wtSlash}"; cd "$W" && npm i`, away],
        ['npm --prefix <wt> install', `npm --prefix "${wtSlash}" install`, away],
        ['npm install --prefix=<wt> zod', `npm install --prefix="${wtSlash}" zod`, away],
        ['pnpm add zod', 'pnpm add zod', fx.wt],
        ['bare yarn', 'yarn', fx.wt],
        ['bun install', 'bun install', fx.wt],
        ['npx patch-package', 'npx patch-package', fx.wt],
        ['npx prisma generate', 'npx prisma generate', fx.wt],
        ['npm.cmd uninstall x', 'npm.cmd uninstall x', fx.wt],
        ['from a subdirectory', 'npm install', path.join(fx.wt, 'packages', 'a')],
        ['after another segment', 'git status && npm install 2>&1 | tail -3', fx.wt],
    ];
    for (const [label, cmd, cwd] of deny) {
        check(`8. denies: ${label}`, !!guard.decide(cmd, cwd));
    }
    const allow = [
        ['npm run build', 'npm run build', fx.wt],
        ['npm test', 'npm test', fx.wt],
        ['npx vitest run', 'npx vitest run', fx.wt],
        ['grep "npm install" README', 'grep "npm install" README.md', fx.wt],
        ['echo npm ci', 'echo npm ci', fx.wt],
        ['npm install in the main checkout', 'npm install', fx.main],
        ['cd elsewhere then install', `cd "${fx.main.replace(/\\/g, '/')}" && npm install`, fx.wt],
        ['bun upgrade (bun itself)', 'bun upgrade', fx.wt],
        ['prisma studio', 'npx prisma studio', fx.wt],
        ['heredoc body', `cat > x.sh <<'EOF'\nnpm install\nEOF`, fx.wt],
    ];
    for (const [label, cmd, cwd] of allow) {
        check(`8. allows: ${label}`, guard.decide(cmd, cwd) === null);
    }
    const silent = (label, input) => {
        const r = runNode(HOOK, [], input);
        check(`8. ${label}: exit 0 and zero bytes`, r.exit === 0 && r.stdout === '' && r.stderr === '', `${r.stdout}${r.stderr}`);
    };
    silent('not Bash', JSON.stringify({ tool_name: 'Read', tool_input: { command: 'npm install' }, cwd: fx.wt }));
    silent('malformed stdin', '{nope');
    silent('empty stdin', '');
    silent('no command', JSON.stringify({ tool_name: 'Bash', tool_input: {}, cwd: fx.wt }));
    silent('an allowed command in a shared tree', payload('npm run build', fx.wt));
    cleanup(fx);
}

// 9. In-process branches: one file at NTFS's link cap is copied, and another volume rolls back.
{
    const fx = fixture('i');
    const realLink = fs.linkSync;
    let calls = 0;
    fs.linkSync = (a, b) => { calls++; if (calls === 1) { const e = new Error('too many links'); e.code = 'EMLINK'; throw e; } return realLink(a, b); };
    let res;
    try { res = si.linkRoot({ wt: fx.wt, main: fx.main, isMain: false }, ''); } finally { fs.linkSync = realLink; }
    check('9a. EMLINK on one file copies that file and links the rest', res.state === 'shared' && res.counts.copied >= 1 && res.counts.linked >= 1, JSON.stringify(res));
    si.unshareRoot(fx.wt, '');
    fs.linkSync = () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
    try { res = si.linkRoot({ wt: fx.wt, main: fx.main, isMain: false }, ''); } finally { fs.linkSync = realLink; }
    check('9b. EXDEV rolls the link back and asks for an install', res.state === 'install' && /another volume/.test(res.reason) && !fs.existsSync(fx.wtNm), JSON.stringify(res));
    cleanup(fx);
}

// 10. Pure helpers and the CLI surface.
{
    const want = { packages: { 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '1.0.0', optional: true }, 'src': {} } };
    check('10a. an optional package not installed is a match', si.hiddenLockMismatch(want, { packages: { 'node_modules/a': { version: '1.0.0' } } }) === null);
    check('10b. a missing required package is a mismatch', /not installed/.test(si.hiddenLockMismatch(want, { packages: {} })));
    check('10c. an installed package the lockfile lacks is a mismatch', /not in the lockfile/.test(si.hiddenLockMismatch(want, { packages: { 'node_modules/a': { version: '1.0.0' }, 'node_modules/c': { version: '1.0.0' } } })));
    check('10d. a moved link target is a mismatch', /installed at/.test(si.hiddenLockMismatch(
        { packages: { 'node_modules/w': { link: true, resolved: 'packages/w' } } }, { packages: { 'node_modules/w': { link: true, resolved: 'packages/x' } } })));
    check('10e. moduleDirs names nested trees and never one inside node_modules', JSON.stringify(si.moduleDirs(
        { packages: { 'node_modules/a': {}, 'apps/web/node_modules/b': {}, 'node_modules/a/node_modules/c': {} } })) === JSON.stringify(['node_modules', 'apps/web/node_modules']));
    const help = cli('--help');
    check('10f. --help exits 0 and prints the header', help.exit === 0 && /hardlinks/.test(help.stdout));
    check('10g. no command prints usage and exits 2', cli2().exit === 2);
    check('10h. an unknown flag exits 2', cli2('link', '.', '--nope').exit === 2);
    check('10i. --main without a value exits 2', cli2('link', '.', '--main').exit === 2);
    check('10j. an unknown command exits 2', cli2('copy', '.').exit === 2);
    check('10k. a path outside git exits 2', cli2('link', os.tmpdir()).exit === 2);
    const fx = fixture('j');
    fs.rmSync(path.join(fx.main, 'package-lock.json'));
    sh(fx.main, 'git', ['rm', '-q', '--cached', 'package-lock.json']);
    write(path.join(fx.main, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    sh(fx.main, 'git', ['add', 'pnpm-lock.yaml']);
    sh(fx.main, 'git', ['commit', '-q', '-m', 'pnpm']);
    const wt2 = path.join(fx.main, '.claude', 'worktrees', 'p');
    sh(fx.main, 'git', ['worktree', 'add', '-q', wt2, '-b', 'p']);
    const r = cli('link', wt2);
    check('10l. a pnpm repo is told to run its own install, exit 1', r.exit === 1 && /pnpm-lock\.yaml/.test(r.stdout), r.stdout);
    const un = cli('unshare', fx.wt);
    check('10m. unshare with nothing shared exits 0 and says so', un.exit === 0 && /nothing shared/.test(un.stdout), un.stdout);
    const m = cli('link', fx.wt, '--main', fx.main, '--json');
    check('10n. --main is honoured', m.stdout.includes('"main"'), m.stdout);
    cleanup(fx);
}

console.log(`\n${tally(pass, fail, infra)}`);
console.log(`subjects: ${path.relative(ROOT, SCRIPT)} (CLI as a subprocess, two branches in-process) and `
    + `${path.relative(ROOT, HOOK)} (subprocess for every byte-level case, decide() for command shapes); `
    + 'fixtures are hand-written npm installs in git repos with one linked worktree each, no network.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exitCode = exitCode(fail, infra);
