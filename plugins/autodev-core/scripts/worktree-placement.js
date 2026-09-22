#!/usr/bin/env node
'use strict';
/**
 * worktree-placement.js - find worktrees that live outside their repo's
 * `.claude/worktrees/`, and anything written loose into the directory that holds
 * the checkouts (the "code root").
 *
 * WHY. `[measured 2026-09-22]` briefs and skills said "a dedicated worktree" and
 * `cmd > f.log` without saying WHERE, so each worker resolved both against the
 * directory it stood in. Twelve worktrees landed as siblings of their repos in
 * the code root, one worker wrote 37 log, diff and exit files straight into it,
 * and another left a bare clone there. Nothing reported any of it: every sweep
 * asked whether a worktree was clean and pushed, and none asked where it was.
 * A sibling worktree is invisible to anyone looking inside the repo, and it reads
 * as one more project to anyone looking at the code root.
 *
 * TWO PROBES, because each is blind where the other sees:
 *   per repo    `git worktree list --porcelain`. Catches a misplaced worktree
 *               ANYWHERE, including outside the code root, but only for repos
 *               it was given.
 *   code root   one level of the directory holding the checkouts. Catches loose
 *               files, bare clones and worktrees of repos nobody listed, but
 *               only there. A worktree both probes see is reported once.
 *
 * CLASSES. A worktree is `main`, `placed` (under <main>/.claude/worktrees/),
 * `transient` (under a transient root, by default the OS temp dir, where gate
 * sweeps make private worktrees and remove them), `missing` (registered, no
 * directory) or MISPLACED. A code-root entry is `repo`, `dir` (not git, left
 * alone), or a STRAY: `file`, `worktree`, `bare-clone`. Dot-directories and OS
 * metadata files are not strays: a session opened in the code root keeps its
 * own `.claude/` there.
 *
 * Every run prints the population it scanned, so "0 misplaced" is a count over
 * a stated number of worktrees and never an empty scan.
 *
 * Usage:
 *   node worktree-placement.js [--code-root <dir>] [--repo <dir>]... [--json]
 * The code root defaults to claude-paths codeDir() (AUTODEV_CODE_DIR overrides).
 * AUTODEV_TRANSIENT_ROOTS replaces the transient roots (path-delimited; empty
 * means none), which is the seam the suite drives from inside the temp dir.
 * Exit 0 nothing misplaced, 1 a finding, 2 nothing could be scanned.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GIT_TIMEOUT_MS = 10000;
const OS_METADATA = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

function real(p) {
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** True when `child` is `parent` or inside it. Case-insensitive on win32 through path.relative. */
function isInside(child, parent) {
    const rel = path.relative(real(parent), real(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sameDir(a, b) { return path.relative(real(a), real(b)) === ''; }

function transientRoots() {
    const raw = process.env.AUTODEV_TRANSIENT_ROOTS;
    if (raw === undefined) return [os.tmpdir()];
    return raw.split(path.delimiter).filter(Boolean);
}

/** Records from `git worktree list --porcelain`. The first is the main worktree. */
function parseWorktreeList(text) {
    const out = [];
    let cur = null;
    for (const line of String(text).split(/\r?\n/)) {
        if (line.startsWith('worktree ')) { cur = { path: path.resolve(line.slice(9).trim()), branch: null, bare: false, prunable: false }; out.push(cur); continue; }
        if (!cur) continue;
        if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
        else if (line === 'detached') cur.branch = '(detached)';
        else if (line === 'bare') cur.bare = true;
        else if (line.startsWith('prunable')) cur.prunable = true;
    }
    return out;
}

/** One worktree's class relative to its main worktree. */
function classifyWorktree(mainRoot, wt, roots) {
    if (sameDir(wt.path, mainRoot)) return 'main';
    if (wt.prunable || !fs.existsSync(wt.path)) return 'missing';
    if (isInside(wt.path, path.join(mainRoot, '.claude', 'worktrees'))) return 'placed';
    if (roots.some((r) => isInside(wt.path, r))) return 'transient';
    return 'misplaced';
}

/** The repo a worktree's `.git` file points at, or null. */
function gitdirOwner(dotGitFile) {
    let text;
    try { text = fs.readFileSync(dotGitFile, 'utf8'); } catch { return null; }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return null;
    const gitdir = path.resolve(path.dirname(dotGitFile), m[1]);
    const i = gitdir.replace(/\\/g, '/').lastIndexOf('/.git/worktrees/');
    return i < 0 ? gitdir : path.resolve(gitdir.slice(0, i));
}

function isBareRepo(dir) {
    try {
        return fs.statSync(path.join(dir, 'HEAD')).isFile()
            && fs.statSync(path.join(dir, 'objects')).isDirectory()
            && fs.statSync(path.join(dir, 'refs')).isDirectory();
    } catch { return false; }
}

/** One level of the code root. Returns every entry with its kind; nothing is read below that level. */
function scanCodeRoot(dir) {
    const entries = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        let st;
        try { st = fs.statSync(p); } catch { entries.push({ name: d.name, path: p, kind: 'unreadable' }); continue; }
        if (!st.isDirectory()) {
            entries.push({ name: d.name, path: p, kind: OS_METADATA.has(d.name.toLowerCase()) ? 'metadata' : 'file' });
            continue;
        }
        if (d.name.startsWith('.')) { entries.push({ name: d.name, path: p, kind: 'dot-dir' }); continue; }
        const dotGit = path.join(p, '.git');
        let gst = null;
        try { gst = fs.statSync(dotGit); } catch { /* no .git */ }
        if (gst && gst.isFile()) entries.push({ name: d.name, path: p, kind: 'worktree', owner: gitdirOwner(dotGit) });
        else if (gst && gst.isDirectory()) entries.push({ name: d.name, path: p, kind: 'repo' });
        else if (isBareRepo(p)) entries.push({ name: d.name, path: p, kind: 'bare-clone' });
        else entries.push({ name: d.name, path: p, kind: 'dir' });
    }
    return entries;
}

function listWorktrees(root) {
    const r = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true });
    if (r.error) return { error: r.error.code === 'ETIMEDOUT' ? `timed out after ${GIT_TIMEOUT_MS} ms` : r.error.message };
    if (r.status !== 0) return { error: `git worktree list exited ${r.status}: ${(r.stderr || '').trim().split('\n')[0]}` };
    return { list: parseWorktreeList(r.stdout) };
}

/**
 * The whole survey. `repos` are any directories inside a repo; the code root's
 * own repos are added to them, and every repo is listed once by its main root.
 */
function survey({ repos = [], codeRoot = null } = {}) {
    const roots = transientRoots();
    const result = {
        codeRoot, transientRoots: roots, codeRootError: null, rootEntries: [],
        reposScanned: [], reposUnreadable: [],
        counts: { total: 0, main: 0, placed: 0, transient: 0, missing: 0, misplaced: 0 },
        misplaced: [], strays: [],
    };
    if (codeRoot) {
        try { result.rootEntries = scanCodeRoot(codeRoot); } catch (e) { result.codeRootError = e.code || e.message; }
    }
    const candidates = repos.concat(result.rootEntries.filter((e) => e.kind === 'repo').map((e) => e.path));
    const seenMain = [];
    for (const dir of candidates) {
        const got = listWorktrees(dir);
        if (got.error) { result.reposUnreadable.push({ dir, reason: got.error }); continue; }
        const main = got.list[0];
        if (!main || seenMain.some((m) => sameDir(m, main.path))) continue;
        seenMain.push(main.path);
        result.reposScanned.push(main.path);
        for (const wt of got.list) {
            const cls = classifyWorktree(main.path, wt, roots);
            result.counts.total++;
            result.counts[cls]++;
            if (cls === 'misplaced') result.misplaced.push({ path: wt.path, repo: main.path, branch: wt.branch });
        }
    }
    for (const e of result.rootEntries) {
        if (e.kind === 'file' || e.kind === 'bare-clone') result.strays.push({ path: e.path, kind: e.kind });
        else if (e.kind === 'worktree' && !result.misplaced.some((m) => sameDir(m.path, e.path))) {
            result.strays.push({ path: e.path, kind: 'worktree', owner: e.owner });
        }
    }
    return result;
}

function findingCount(r) { return r.misplaced.length + r.strays.length; }

/** Report lines, population first. `limit` caps each finding list; the counts above it stay whole. */
function render(r, { limit = 40 } = {}) {
    const lines = [];
    const byKind = {};
    for (const e of r.rootEntries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const c = r.counts;
    lines.push(`  population: ${r.reposScanned.length} repo(s) listed ${c.total} worktree(s): ${c.main} main, ${c.placed} under .claude/worktrees, `
        + `${c.transient} transient, ${c.missing} missing on disk, ${c.misplaced} MISPLACED`);
    if (!r.codeRoot) lines.push('  !! COULD NOT CHECK - code root: none found (set AUTODEV_CODE_DIR). Loose files and worktrees of unlisted repos are invisible.');
    else if (r.codeRootError) lines.push(`  !! COULD NOT CHECK - code root ${r.codeRoot}: ${r.codeRootError}`);
    else {
        const kinds = ['repo', 'dir', 'dot-dir', 'file', 'worktree', 'bare-clone', 'metadata', 'unreadable'].filter((k) => byKind[k]).map((k) => `${byKind[k]} ${k}`);
        lines.push(`  code root ${r.codeRoot}: ${r.rootEntries.length} entries (${kinds.join(', ') || 'empty'})`);
    }
    lines.push(`  transient roots: ${r.transientRoots.length ? r.transientRoots.join(', ') : 'none'}`);
    for (const u of r.reposUnreadable) lines.push(`  ? could not list worktrees of ${u.dir}: ${u.reason}`);
    const list = (items, fmt) => {
        for (const it of items.slice(0, limit)) lines.push(fmt(it));
        if (items.length > limit) lines.push(`     ... and ${items.length - limit} more (node worktree-placement.js lists all)`);
    };
    if (r.misplaced.length) {
        lines.push(`  !! ${r.misplaced.length} worktree(s) outside <repo>/.claude/worktrees/:`);
        list(r.misplaced, (m) => `     ${m.path}   [${m.branch || '?'} of ${m.repo}]`);
    }
    if (r.strays.length) {
        lines.push(`  !! ${r.strays.length} stray(s) in the code root:`);
        list(r.strays, (s) => `     ${s.kind.padEnd(10)} ${s.path}${s.owner ? `   [worktree of ${s.owner}]` : ''}`);
    }
    if (!findingCount(r)) lines.push('  none misplaced, no strays in the code root');
    else lines.push('  Check each is clean and pushed before removing it; `git worktree remove` for a worktree, never rm.');
    return lines;
}

function parseArgs(argv) {
    const o = { repos: [], codeRoot: undefined, json: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') o.help = true;
        else if (a === '--json') o.json = true;
        else if (a === '--repo' && argv[i + 1]) o.repos.push(argv[++i]);
        else if (a === '--code-root' && argv[i + 1]) o.codeRoot = argv[++i];
        else throw new Error(`unknown or incomplete argument ${a}`);
    }
    return o;
}

function main(argv) {
    let o;
    try { o = parseArgs(argv); } catch (e) { process.stderr.write(e.message + '\n'); return 2; }
    if (o.help) { process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0] + '*/\n'); return 0; }
    const codeRoot = o.codeRoot !== undefined ? o.codeRoot : require('./claude-paths.js').codeDir();
    const r = survey({ repos: o.repos, codeRoot });
    if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else process.stdout.write(['worktree placement', ...render(r, { limit: Infinity })].join('\n') + '\n');
    if (!r.reposScanned.length && (!codeRoot || r.codeRootError)) return 2;
    return findingCount(r) ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseWorktreeList, classifyWorktree, scanCodeRoot, survey, render, findingCount, isInside };
