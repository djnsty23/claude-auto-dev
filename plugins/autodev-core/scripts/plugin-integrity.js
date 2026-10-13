#!/usr/bin/env node
'use strict';
/**
 * plugin-integrity.js - is the plugin this script was loaded from the tree a
 * release shipped, byte for byte?
 *
 * WHY. headless-worker.js used to accept any script whose path contained
 * `/plugins/cache/`. A path is a name, not evidence: a hand-edited cache copy,
 * a checkout copied into a cache-shaped folder, or a cache left half-updated
 * all passed. A worker started from such a copy runs code no release shipped.
 *
 * WHAT IS CHECKED. The plugin root must sit at
 * `<config>/plugins/cache/<marketplace>/<plugin>/<version>`. Then:
 *   1. `<config>/plugins/installed_plugins.json` must name `<plugin>@<marketplace>`
 *      with an installPath equal to that root and a gitCommitSha.
 *   2. The marketplace clone `<config>/plugins/marketplaces/<marketplace>` must
 *      hold that commit, and its marketplace.json at that commit names the
 *      plugin's source directory.
 *   3. Every file `git ls-tree` lists under that directory must exist in the
 *      root with the same git blob hash (a CRLF checkout of the same text also
 *      matches). Every file in the root must be in the tree, except the
 *      `.in_use/` and `.orphaned_at` markers Claude Code writes itself.
 * The launcher (the script asking) is one of those files, and its expected and
 * actual hashes are reported on their own.
 *
 * FAILS CLOSED. Any missing record, clone, commit, file or hash is DENIED.
 * Nothing here repairs or rewrites the install.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const IGNORED_EXTRAS = [/^\.in_use\//, /^\.orphaned_at$/];
const GIT_TIMEOUT_MS = 15000;

function blobSha(buf) {
    return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function blobShas(buf) {
    const out = [blobSha(buf)];
    if (buf.includes(13)) out.push(blobSha(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')));
    return out;
}

function samePath(a, b) {
    const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function listFiles(root) {
    const out = [];
    const walk = (dir, rel) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
            else out.push(r);
        }
    };
    walk(root, '');
    return out;
}

function git(cwd, args) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'buffer', windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, out: r.stdout || Buffer.alloc(0), err: (r.stderr || '').toString().trim() || (r.error && r.error.code) || '' };
}

/** Where a plugin root sits, read from its path. Null when it is not cache-shaped. */
function layoutOf(pluginRoot) {
    const parts = path.resolve(pluginRoot).split(/[\\/]+/);
    const n = parts.length;
    if (n < 6 || parts[n - 4].toLowerCase() !== 'cache' || parts[n - 5].toLowerCase() !== 'plugins') return null;
    return {
        configDir: parts.slice(0, n - 5).join(path.sep) || path.sep,
        marketplace: parts[n - 3], plugin: parts[n - 2], version: parts[n - 1],
    };
}

function denied(code, why, extra = {}) { return { verdict: 'DENIED', code, why, ...extra }; }

/**
 * verifyInstall({ pluginRoot, launcher }) -> { verdict: 'ALLOWED'|'DENIED', code, why, ... }
 * `launcher` is the script asking, relative paths resolved inside pluginRoot.
 */
function verifyInstall({ pluginRoot, launcher = null } = {}) {
    if (!pluginRoot) return denied('no-root', 'no plugin root was given');
    const root = path.resolve(pluginRoot);
    const layout = layoutOf(root);
    if (!layout) return denied('not-cache-layout', `${root} is not <config>/plugins/cache/<marketplace>/<plugin>/<version>`);
    const base = { pluginRoot: root, ...layout };
    const indexFile = path.join(layout.configDir, 'plugins', 'installed_plugins.json');
    let index;
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (e) {
        return denied('no-install-record', `cannot read ${indexFile}: ${e.code || e.message}`, base);
    }
    const key = `${layout.plugin}@${layout.marketplace}`;
    const entries = [].concat((index && index.plugins ? index.plugins : index || {})[key] || []);
    const entry = entries.find((e) => e && typeof e.installPath === 'string' && samePath(e.installPath, root));
    if (!entry) return denied('no-install-record', `${indexFile} has no ${key} entry installed at this root`, base);
    const commit = typeof entry.gitCommitSha === 'string' && /^[0-9a-f]{40}$/i.test(entry.gitCommitSha) ? entry.gitCommitSha.toLowerCase() : null;
    if (!commit) return denied('no-commit', `${key} names no gitCommitSha, so there is no release to compare against`, base);
    base.commit = commit;
    const clone = path.join(layout.configDir, 'plugins', 'marketplaces', layout.marketplace);
    const has = git(clone, ['cat-file', '-e', `${commit}^{commit}`]);
    if (!has.ok) return denied('commit-missing', `the marketplace clone ${clone} does not hold ${commit}: ${has.err}`, base);
    const mj = git(clone, ['show', `${commit}:.claude-plugin/marketplace.json`]);
    let source = null;
    try {
        const m = JSON.parse(mj.out.toString('utf8'));
        const p = (m.plugins || []).find((x) => x && x.name === layout.plugin);
        source = p && typeof p.source === 'string' ? p.source.replace(/^\.\//, '').replace(/\/+$/, '') : null;
    } catch { source = null; }
    if (!mj.ok || !source) return denied('no-source', `marketplace.json at ${commit} names no local source for ${layout.plugin}`, base);
    const ls = git(clone, ['ls-tree', '-r', '-z', commit, '--', source]);
    if (!ls.ok) return denied('tree-unreadable', `git ls-tree failed: ${ls.err}`, base);
    const expected = new Map();
    for (const rec of ls.out.toString('utf8').split('\0')) {
        const m = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(rec);
        if (!m || m[2] !== 'blob') continue;
        expected.set(m[4].slice(source.length + 1), m[3]);
    }
    if (!expected.size) return denied('empty-tree', `${source} at ${commit} lists no files`, base);
    const mismatched = [];
    const missing = [];
    for (const [rel, sha] of expected) {
        let buf;
        try { buf = fs.readFileSync(path.join(root, rel)); } catch { missing.push(rel); continue; }
        if (!blobShas(buf).includes(sha)) mismatched.push(rel);
    }
    let onDisk = [];
    try { onDisk = listFiles(root); } catch (e) { return denied('root-unreadable', `cannot list ${root}: ${e.code || e.message}`, base); }
    const extras = onDisk.filter((rel) => !expected.has(rel) && !IGNORED_EXTRAS.some((re) => re.test(rel)));
    let launcherHash = null;
    if (launcher) {
        const rel = path.relative(root, path.resolve(launcher)).replace(/\\/g, '/');
        let actual = null;
        try { actual = blobSha(fs.readFileSync(path.resolve(launcher))); } catch { actual = null; }
        launcherHash = { file: rel, expected: expected.get(rel) || null, actual };
        if (!launcherHash.expected) return denied('launcher-untracked', `the launcher ${rel} is not in ${source} at ${commit}`, { ...base, launcher: launcherHash });
    }
    const result = { ...base, source, checked: expected.size, mismatched, missing, extras, launcher: launcherHash };
    if (mismatched.length || missing.length || extras.length) {
        const parts = [];
        if (mismatched.length) parts.push(`${mismatched.length} changed (${mismatched.slice(0, 3).join(', ')})`);
        if (missing.length) parts.push(`${missing.length} missing (${missing.slice(0, 3).join(', ')})`);
        if (extras.length) parts.push(`${extras.length} not in the release (${extras.slice(0, 3).join(', ')})`);
        return { verdict: 'DENIED', code: 'hash-mismatch', why: `the loaded plugin differs from ${commit}: ${parts.join('; ')}`, ...result };
    }
    return { verdict: 'ALLOWED', code: 'verified', why: `${expected.size} files match ${commit}`, ...result };
}

function run(argv) {
    const [cmd, ...rest] = argv;
    const opts = {};
    for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    if (cmd !== 'verify') {
        process.stderr.write('usage: plugin-integrity.js verify [--plugin-root <dir>] [--launcher <file>]\n'
            + '  Without --plugin-root it checks the plugin this file was loaded from. Exit 0 ALLOWED, 1 DENIED.\n');
        return 2;
    }
    const pluginRoot = typeof opts['plugin-root'] === 'string' ? opts['plugin-root'] : path.join(__dirname, '..');
    const launcher = typeof opts.launcher === 'string' ? opts.launcher : null;
    const r = verifyInstall({ pluginRoot, launcher });
    process.stdout.write(JSON.stringify(r) + '\n');
    return r.verdict === 'ALLOWED' ? 0 : 1;
}

if (require.main === module) {
    try { process.exitCode = run(process.argv.slice(2)); } catch (e) {
        process.stdout.write(JSON.stringify({ verdict: 'DENIED', code: 'crashed', why: e.message }) + '\n');
        process.exitCode = 1;
    }
}

module.exports = { verifyInstall, layoutOf, blobSha, blobShas, IGNORED_EXTRAS, run };
