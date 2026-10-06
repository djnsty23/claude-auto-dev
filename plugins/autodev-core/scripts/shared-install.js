#!/usr/bin/env node
/**
 * shared-install.js - give a new linked worktree the main checkout's npm
 * install as a tree of hardlinks, instead of a fresh install, when both trees
 * have the same lockfile. Disk cost is the directory entries only, and setup
 * takes seconds instead of a full `npm ci`.
 *
 *   node shared-install.js link    <worktree> [--main <checkout>] [--json]
 *   node shared-install.js unshare <worktree> [--json]
 *   node shared-install.js status  <worktree> [--json]
 *
 * WHY HARDLINKS. `[measured 2026-10-05]` on a product-sized Next.js 16 app
 * (30,848 files, 530 MB): a directory junction to the main checkout's
 * node_modules costs nothing, but `next build` under Turbopack refuses it
 * ("Symlink [project]/node_modules is invalid, it points out of the
 * filesystem root"), and every tool that writes a cache under node_modules
 * (Vite's `.vite`) would write into the main checkout's copy. A hardlink tree
 * gives the worktree its own directories over the same file data: resolution
 * sees an ordinary node_modules inside the project, and a new file written
 * there lands in the worktree only. pnpm installs the same way from its store.
 *
 * WHAT IS LINKED. Each tracked package-lock.json is an install root. A root is
 * linked only when ALL of these hold, and otherwise the worktree is told to
 * run its own install:
 *   1. the worktree's package-lock.json is byte-identical to the main
 *      checkout's at the same path;
 *   2. the main checkout's node_modules is a real directory and its hidden
 *      lockfile (node_modules/.package-lock.json) agrees with that lockfile,
 *      so the tree being shared is what the lockfile describes;
 *   3. git ignores `node_modules` in the worktree;
 *   4. the worktree has no node_modules yet (an existing private install is
 *      left alone).
 * Nested node_modules directories the lockfile names (workspace packages) are
 * linked with their root. Cache directories (.cache, .vite, .vite-temp,
 * .vitest) are left out, so each tree builds its own.
 *
 * WHAT IS COPIED, NOT LINKED. npm rewrites some files IN PLACE, and a hardlink
 * rewritten in place changes both trees. The top-level files of each
 * node_modules (the hidden lockfile among them) and every `.bin` shim are
 * copied. Package files are linked: npm replaces a changed package by
 * renaming its folder aside and extracting fresh files, so even an install
 * would not reach the main checkout through them, but an install script can
 * write in place. Hence the guard below.
 *
 * THE GUARD. Each shared node_modules carries a marker, `.autodev-shared.json`.
 * The PreToolUse hook `shared-install-guard.js` denies a package-manager
 * install (npm, pnpm, yarn, bun, patch-package, prisma generate) in a tree
 * that has one, and names `unshare` as the first command. `unshare` removes
 * the worktree's links (the main checkout's files are untouched), and the
 * install that follows is private. `link` also unshares a root whose lockfile
 * no longer matches the hash in its marker. A marker in state "linking" is a
 * link that was interrupted: the next `link` or `unshare` removes it.
 *
 * Exit: 0 every root is shared or already has its own install, 1 at least one
 * root needs its own install (the command is printed), 2 a usage error or a run
 * that could not start. `unshare` and `status` exit 0 on success.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MARKER = '.autodev-shared.json';
const LOCKFILE = 'package-lock.json';
const HIDDEN_LOCK = '.package-lock.json';
const SKIP_TOP = new Set(['.cache', '.vite', '.vite-temp', '.vitest']);
const OTHER_MANAGERS = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const TAG = '[shared-install]';

function usageFault(msg) { const e = new Error(msg); e.usage = true; return e; }

function parseArgs(argv) {
    const out = { cmd: null, target: null, main: null, json: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--json') out.json = true;
        else if (a === '--main') {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw usageFault('--main needs a value');
            out.main = v;
        } else if (a.startsWith('--')) throw usageFault(`unknown flag ${a}`);
        else if (!out.cmd) out.cmd = a;
        else if (!out.target) out.target = a;
        else throw usageFault(`unexpected argument ${a}`);
    }
    return out;
}

function git(cwd, args) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// One spelling per directory: macOS /var is /private/var and a Windows temp path can be an 8.3 short
// name, while git reports the long real path. Only the native realpath expands 8.3 names.
const canon = (p) => {
    const r = path.resolve(p);
    try { return fs.realpathSync.native(r); } catch { return r; }
};

const sameDir = (a, b) => {
    const n = (p) => canon(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** The worktree's top and the main checkout's top, or a thrown fault. */
function resolveTrees(target, mainOpt) {
    const top = git(target, ['rev-parse', '--show-toplevel']);
    if (!top.ok) throw usageFault(`${target} is not inside a git work tree`);
    const wt = path.resolve(top.out);
    let main = mainOpt ? path.resolve(mainOpt) : null;
    if (!main) {
        const list = git(wt, ['worktree', 'list', '--porcelain']);
        const first = list.ok ? list.out.split('\n').find((l) => l.startsWith('worktree ')) : null;
        if (!first) throw usageFault(`cannot list the worktrees of ${wt}`);
        main = path.resolve(first.slice('worktree '.length));
    }
    return { wt, main, isMain: sameDir(wt, main) };
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Install roots: directories, relative to the top, holding a tracked package-lock.json. */
function installRoots(wt) {
    const r = git(wt, ['ls-files', '-z', '--', LOCKFILE, `**/${LOCKFILE}`]);
    if (!r.ok) return [];
    return r.out.split('\0').filter(Boolean)
        .filter((f) => !f.split('/').includes('node_modules'))
        .map((f) => path.posix.dirname(f))
        .map((d) => (d === '.' ? '' : d));
}

/** The node_modules directories, relative to an install root, that its lockfile names. */
function moduleDirs(lock) {
    const dirs = new Set(['node_modules']);
    for (const key of Object.keys((lock && lock.packages) || {})) {
        const at = key.indexOf('node_modules/');
        if (at > 0 && !key.slice(0, at).split('/').includes('node_modules')) dirs.add(key.slice(0, at) + 'node_modules');
    }
    return [...dirs];
}

/**
 * Does the hidden lockfile npm wrote into node_modules agree with the lockfile?
 * Every installed entry must be in the lockfile at the same version, and every
 * lockfile entry under node_modules must be installed unless it is optional
 * (a platform package for another OS). Null when they agree, else the reason.
 */
function hiddenLockMismatch(lock, hidden) {
    const want = (lock && lock.packages) || {};
    const have = (hidden && hidden.packages) || {};
    const isModule = (k) => k.split('/').includes('node_modules');
    const same = (a, b) => a.version === b.version && (!a.link || a.resolved === b.resolved);
    for (const [k, v] of Object.entries(have)) {
        if (!isModule(k)) continue;
        if (!want[k]) return `${k} is installed but not in the lockfile`;
        if (!same(want[k], v)) return `${k} is installed at ${v.version || v.resolved}, the lockfile says ${want[k].version || want[k].resolved}`;
    }
    for (const [k, v] of Object.entries(want)) {
        if (!isModule(k) || have[k] || v.optional) continue;
        return `${k} is in the lockfile but not installed`;
    }
    return null;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readMarker(dir) { return readJson(path.join(dir, MARKER)); }

/** Remove a directory tree. A hardlinked file removed here leaves the other tree's copy intact. */
function removeTree(dir) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** Recreate a symlink or junction found in the source, pointing into the worktree when it pointed into the main checkout. */
function relink(src, dest, mainTop, wtTop) {
    const raw = fs.readlinkSync(src);
    const abs = path.resolve(path.dirname(src), raw);
    const rel = path.relative(canon(mainTop), canon(abs));
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const target = inside ? path.join(wtTop, rel) : abs;
    let isDir = false;
    try { isDir = fs.statSync(abs).isDirectory(); } catch { /* dangling: recreate as given */ }
    fs.symlinkSync(target, dest, isDir ? 'junction' : 'file');
}

/** Hardlink (or copy) one node_modules tree. Returns counts. Throws on a fault that makes the tree unusable. */
function linkTree(src, dest, mainTop, wtTop) {
    const counts = { files: 0, linked: 0, copied: 0, links: 0 };
    const walk = (from, to, depth, inBin) => {
        fs.mkdirSync(to, { recursive: true });
        for (const e of fs.readdirSync(from, { withFileTypes: true })) {
            if (depth === 0 && (SKIP_TOP.has(e.name) || e.name === MARKER)) continue;
            const s = path.join(from, e.name);
            const d = path.join(to, e.name);
            if (e.isSymbolicLink()) { relink(s, d, mainTop, wtTop); counts.links++; continue; }
            if (e.isDirectory()) { walk(s, d, depth + 1, depth === 0 && e.name === '.bin'); continue; }
            counts.files++;
            if (depth === 0 || inBin) { fs.copyFileSync(s, d); counts.copied++; continue; }
            try { fs.linkSync(s, d); counts.linked++; } catch (err) {
                // EXDEV: another volume, so linking cannot work for any file. EMLINK:
                // this one file reached NTFS's 1023-link cap, so copy just it.
                if (err.code !== 'EMLINK') throw err;
                fs.copyFileSync(s, d); counts.copied++;
            }
        }
    };
    walk(src, dest, 0, false);
    return counts;
}

function writeMarker(dir, data) {
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(data, null, 2) + '\n');
}

function installCommand(wt, root) {
    return `cd "${path.join(wt, root).replace(/\\/g, '/')}" && npm ci`;
}

/** Unshare every shared node_modules under one install root. Returns the directories removed. */
function unshareRoot(wt, root) {
    const base = path.join(wt, root);
    const removed = [];
    const lock = readJson(path.join(base, LOCKFILE));
    const dirs = new Set([...moduleDirs(lock), 'node_modules']);
    for (const rel of dirs) {
        const dir = path.join(base, rel);
        if (!fs.existsSync(path.join(dir, MARKER))) continue;
        removeTree(dir);
        removed.push(path.join(root, rel).replace(/\\/g, '/'));
    }
    return removed;
}

/** Decide and do one install root. */
function linkRoot(trees, root) {
    const { wt, main } = trees;
    const label = root || '.';
    const wtBase = path.join(wt, root);
    const mainBase = path.join(main, root);
    const res = { root: label, state: null, reason: '', install: null };
    const needInstall = (reason) => Object.assign(res, { state: 'install', reason, install: installCommand(wt, root) });

    const wtNm = path.join(wtBase, 'node_modules');
    const marker = readMarker(wtNm);
    const wtLock = path.join(wtBase, LOCKFILE);
    const mainLock = path.join(mainBase, LOCKFILE);
    if (!fs.existsSync(wtLock)) return needInstall(`${LOCKFILE} is missing in the worktree`);
    const wtSha = sha(wtLock);

    if (marker) {
        if (marker.state === 'shared' && marker.lockSha === wtSha) return Object.assign(res, { state: 'shared', reason: 'already shared, lockfile unchanged' });
        const removed = unshareRoot(wt, root);
        if (marker.state !== 'shared') res.reason = `removed an interrupted link (${removed.join(', ')}); `;
        else return needInstall(`the lockfile changed since it was shared, so the links were removed (${removed.join(', ')})`);
    } else if (fs.existsSync(wtNm)) {
        return Object.assign(res, { state: 'private', reason: 'node_modules already exists and is not shared; left alone' });
    }

    if (!fs.existsSync(mainLock)) return needInstall(`the main checkout has no ${label}/${LOCKFILE}`);
    if (sha(mainLock) !== wtSha) return needInstall(`${LOCKFILE} differs from the main checkout's`);
    const mainNm = path.join(mainBase, 'node_modules');
    let st;
    try { st = fs.lstatSync(mainNm); } catch { return needInstall('the main checkout has no node_modules'); }
    if (!st.isDirectory() || st.isSymbolicLink()) return needInstall('the main checkout\'s node_modules is not a real directory');
    if (readMarker(mainNm)) return needInstall('the main checkout\'s node_modules is itself shared');
    const lock = readJson(mainLock);
    const hidden = readJson(path.join(mainNm, HIDDEN_LOCK));
    if (!lock || !hidden) return needInstall(`the main checkout's ${HIDDEN_LOCK} is missing or unreadable, so its install cannot be matched to the lockfile`);
    const mismatch = hiddenLockMismatch(lock, hidden);
    if (mismatch) return needInstall(`the main checkout's install does not match its lockfile: ${mismatch}`);
    const ignored = git(wt, ['check-ignore', '-q', '--', path.posix.join(root, 'node_modules', 'x').replace(/^\//, '')]);
    if (!ignored.ok) return needInstall('git does not ignore node_modules here, so a link would show up as untracked files');

    const started = Date.now();
    const totals = { files: 0, linked: 0, copied: 0, links: 0 };
    const made = [];
    try {
        for (const rel of moduleDirs(lock)) {
            const src = path.join(mainBase, rel);
            const dest = path.join(wtBase, rel);
            if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
            fs.mkdirSync(dest, { recursive: true });
            made.push(dest);
            const pending = { v: 1, state: 'linking', source: src, lockSha: wtSha, at: new Date().toISOString() };
            writeMarker(dest, pending);
            const c = linkTree(src, dest, main, wt);
            for (const k of Object.keys(totals)) totals[k] += c[k];
            writeMarker(dest, { ...pending, state: 'shared', ...c });
        }
    } catch (err) {
        for (const dir of made) { try { removeTree(dir); } catch { /* reported below */ } }
        const why = err.code === 'EXDEV' ? 'the worktree is on another volume than the main checkout' : `${err.code || 'error'}: ${err.message}`;
        return needInstall(`linking failed and was rolled back (${why})`);
    }
    return Object.assign(res, {
        state: 'shared',
        reason: `${res.reason}linked ${totals.linked} files, copied ${totals.copied}, recreated ${totals.links} links in ${Date.now() - started} ms`,
        counts: totals,
    });
}

/** The status of every install root, without changing anything. */
function statusRoots(trees) {
    const out = [];
    for (const root of installRoots(trees.wt)) {
        const nm = path.join(trees.wt, root, 'node_modules');
        const marker = readMarker(nm);
        const lock = path.join(trees.wt, root, LOCKFILE);
        let state = 'absent';
        if (marker) {
            const fresh = fs.existsSync(lock) && marker.lockSha === sha(lock);
            state = marker.state !== 'shared' ? 'interrupted' : (fresh ? 'shared' : 'stale');
        } else if (fs.existsSync(nm)) state = 'private';
        out.push({ root: root || '.', state });
    }
    return out;
}

function otherManagers(wt) {
    return OTHER_MANAGERS.filter((f) => fs.existsSync(path.join(wt, f)));
}

function run(opts) {
    if (!['link', 'unshare', 'status'].includes(opts.cmd)) throw usageFault('the command is link, unshare or status');
    if (!opts.target) throw usageFault(`${opts.cmd} needs a worktree path`);
    const trees = resolveTrees(opts.target, opts.main);
    if (trees.isMain && opts.cmd !== 'status') throw usageFault(`${trees.wt} is the main checkout; ${opts.cmd} works on a linked worktree`);
    const report = { cmd: opts.cmd, worktree: trees.wt, main: trees.main, roots: [], exit: 0 };
    if (opts.cmd === 'status') { report.roots = statusRoots(trees); return report; }
    if (opts.cmd === 'unshare') {
        for (const root of installRoots(trees.wt)) report.roots.push({ root: root || '.', removed: unshareRoot(trees.wt, root) });
        return report;
    }
    const roots = installRoots(trees.wt);
    if (!roots.length) {
        const others = otherManagers(trees.wt);
        report.note = others.length
            ? `no tracked ${LOCKFILE}; ${others.join(', ')} found, and that manager installs from its own store, so run its install`
            : `no tracked ${LOCKFILE}: nothing to share`;
        report.exit = others.length ? 1 : 0;
        return report;
    }
    for (const root of roots) report.roots.push(linkRoot(trees, root));
    report.exit = report.roots.some((r) => r.state === 'install') ? 1 : 0;
    return report;
}

function print(report, json) {
    if (json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return; }
    const lines = [`${TAG} ${report.cmd} ${report.worktree}`];
    if (report.note) lines.push(`  ${report.note}`);
    else if (!report.roots.length) lines.push('  no tracked package-lock.json here, so there is nothing to share or install');
    for (const r of report.roots) {
        if (report.cmd === 'unshare') lines.push(`  ${r.root}: ${r.removed.length ? 'removed ' + r.removed.join(', ') : 'nothing shared'}`);
        else if (report.cmd === 'status') lines.push(`  ${r.root}: ${r.state}`);
        else lines.push(`  ${r.root}: ${r.state}, ${r.reason}${r.install ? `\n    run: ${r.install}` : ''}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
}

function helpText() {
    const lines = fs.readFileSync(__filename, 'utf8').split('\n');
    const end = lines.findIndex((l) => l.trim() === '*/');
    return lines.slice(2, end).map((l) => l.replace(/^ \* ?/, '')).join('\n');
}

function main(argv = process.argv.slice(2)) {
    let opts;
    try { opts = parseArgs(argv); } catch (e) { process.stderr.write(`${TAG} ${e.message}\n`); return 2; }
    if (opts.help || !opts.cmd) { process.stdout.write(helpText() + '\n'); return opts.help ? 0 : 2; }
    let report;
    try { report = run(opts); } catch (e) {
        process.stderr.write(`${TAG} ${e.usage ? '' : 'could not run: '}${e.message}\n`);
        return 2;
    }
    print(report, opts.json);
    return report.exit;
}

module.exports = {
    parseArgs, resolveTrees, installRoots, moduleDirs, hiddenLockMismatch, readMarker, linkTree, relink,
    linkRoot, unshareRoot, statusRoots, otherManagers, run, print, helpText, main, MARKER,
};

if (require.main === module) process.exitCode = main();
