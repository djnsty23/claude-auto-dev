#!/usr/bin/env node
'use strict';
/**
 * Does the INSTALLED plugin code match the commit it claims to be?
 *
 * WHY A VERSION CHECK CANNOT ANSWER THIS. `CLAUDE.md`: "A version number is a
 * plugin-cache key, so two trees must never share one." On 2026-08-21 two
 * sessions released 8.98.0 from one clone within minutes with different trees.
 * The cache is keyed on the number, so `claude plugin update` reported *"already
 * at the latest version"* and installed a build missing one session's change
 * entirely — a green message describing a number rather than the code behind it.
 *
 * Every existing check compares NUMBERS: installed vs catalog, marketplace
 * freshness, the version-drift table. All of them pass while the bytes differ.
 * This compares CONTENT against a commit, which is the only thing that can.
 *
 * The anchor is `gitCommitSha` in installed_plugins.json — the commit the
 * installer says it took the files from. Each installed file is hashed and
 * compared with the blob at that path in that commit. Three outcomes per plugin,
 * never two: MATCHES, DRIFTED (with the files named), or COULD NOT CHECK (with
 * the reason). An unreadable anchor is not a pass.
 *
 *   node check-plugin-drift.js            human output, exit 1 on drift
 *   node check-plugin-drift.js --json     machine-readable
 *   node check-plugin-drift.js --quiet    print only when something is wrong
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const AS_JSON = has('--json');
const QUIET = has('--quiet');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const MANIFEST = path.join(CFG, 'plugins', 'installed_plugins.json');
const MARKETS = path.join(CFG, 'plugins', 'marketplaces');

// Files that legitimately differ or are not part of the published tree.
const IGNORE = new Set(['.DS_Store', '.orphaned_at']);
const IGNORE_DIRS = new Set(['node_modules', '.git']);

function sha1(buf) {
    return crypto.createHash('sha1').update(buf).digest('hex');
}

function walk(dir, base = dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (IGNORE_DIRS.has(e.name) || IGNORE.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, base, out);
        else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
    }
    return out;
}

function git(repo, argv) {
    try {
        return execFileSync('git', ['-C', repo].concat(argv), {
            encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
    } catch { return null; }
}

/**
 * Every path in the commit under `prefix`, mapped to its blob sha.
 *
 * git's own blob sha is a sha1 over "blob <len>\0<content>", so it is compared
 * against the same construction below rather than a bare file hash. Using
 * `cat-file` per file instead would be one subprocess per file — this is one.
 */
function treeAt(repo, sha, prefix) {
    const out = git(repo, ['ls-tree', '-r', '-z', sha, '--', prefix]);
    if (out === null) return null;
    const map = new Map();
    for (const rec of out.toString('utf8').split('\0')) {
        if (!rec) continue;
        // "<mode> <type> <sha>\t<path>"
        const tab = rec.indexOf('\t');
        if (tab < 0) continue;
        const meta = rec.slice(0, tab).split(/\s+/);
        const p = rec.slice(tab + 1);
        if (meta[1] !== 'blob') continue;   // submodules and trees are not files
        map.set(p.slice(prefix.length + 1), meta[2]);
    }
    return map;
}

function gitBlobSha(buf) {
    return sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
}

function checkPlugin(key, entry) {
    // key is "<plugin>@<marketplace>"
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : key;
    const market = at > 0 ? key.slice(at + 1) : null;
    const res = { plugin: name, marketplace: market, version: entry.version, sha: entry.gitCommitSha || null };

    const installPath = entry.installPath
        || (market ? path.join(CFG, 'plugins', 'cache', market, name, String(entry.version)) : null);
    res.installPath = installPath;

    if (!installPath || !fs.existsSync(installPath)) {
        res.status = 'COULD NOT CHECK';
        res.reason = `install path not found: ${installPath || '(none recorded)'}`;
        return res;
    }
    if (!market) {
        res.status = 'COULD NOT CHECK';
        res.reason = 'no marketplace in the manifest key — a dev checkout has no published commit to compare against';
        return res;
    }
    if (!entry.gitCommitSha) {
        res.status = 'COULD NOT CHECK';
        res.reason = 'manifest records no gitCommitSha, so there is no anchor to compare content against';
        return res;
    }

    const clone = path.join(MARKETS, market);
    if (!fs.existsSync(path.join(clone, '.git'))) {
        res.status = 'COULD NOT CHECK';
        res.reason = `no marketplace clone at ${clone}`;
        return res;
    }
    if (git(clone, ['cat-file', '-e', `${entry.gitCommitSha}^{commit}`]) === null) {
        res.status = 'COULD NOT CHECK';
        res.reason = `commit ${entry.gitCommitSha.slice(0, 12)} is not in the clone — it may have been pruned, or the clone is behind. Run: claude plugin marketplace update ${market}`;
        return res;
    }

    const prefix = `plugins/${name}`;
    const tree = treeAt(clone, entry.gitCommitSha, prefix);
    if (!tree || !tree.size) {
        res.status = 'COULD NOT CHECK';
        res.reason = `no files under ${prefix} at that commit`;
        return res;
    }

    const differing = [], extra = [];
    const files = walk(installPath);
    for (const rel of files) {
        const want = tree.get(rel);
        if (!want) { extra.push(rel); continue; }
        let buf;
        try { buf = fs.readFileSync(path.join(installPath, rel)); } catch { differing.push(rel + ' (unreadable)'); continue; }
        if (gitBlobSha(buf) !== want) differing.push(rel);
        tree.delete(rel);
    }
    const missing = [...tree.keys()];

    res.scanned = files.length;
    res.differing = differing;
    res.extra = extra;
    res.missing = missing;
    res.status = (differing.length || missing.length) ? 'DRIFTED' : 'MATCHES';
    // `extra` alone is not drift: an install can carry files the published tree
    // does not, and calling that a mismatch would cry wolf on every plugin.
    return res;
}

// ------------------------------------------------------------------- main

const manifest = (() => {
    try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
})();

if (!manifest || !manifest.plugins) {
    console.error('COULD NOT READ the plugin manifest — this is NOT "no drift".');
    console.error(`  path: ${MANIFEST}`);
    console.error('  Nothing was compared, so no verdict here would have meant anything.');
    process.exit(2);
}

const results = [];
for (const [key, arr] of Object.entries(manifest.plugins)) {
    for (const entry of (Array.isArray(arr) ? arr : [arr])) results.push(checkPlugin(key, entry));
}

if (AS_JSON) {
    console.log(JSON.stringify({ manifest: MANIFEST, results }, null, 2));
    process.exit(results.some((r) => r.status === 'DRIFTED') ? 1 : 0);
}

const drifted = results.filter((r) => r.status === 'DRIFTED');
const unknown = results.filter((r) => r.status === 'COULD NOT CHECK');
const matched = results.filter((r) => r.status === 'MATCHES');

if (!QUIET || drifted.length || unknown.length) {
    console.log(`POPULATION: ${results.length} installed plugin(s) from ${MANIFEST}`);
    console.log(`  ${matched.length} match their recorded commit, ${drifted.length} DRIFTED, ${unknown.length} COULD NOT BE CHECKED`);
    console.log('  Content, not version numbers: two trees can share a version, and the cache is keyed on the number.\n');
}

for (const r of drifted) {
    console.log(`DRIFTED  ${r.plugin} v${r.version} vs ${String(r.sha).slice(0, 12)}`);
    console.log(`  ${r.installPath}`);
    for (const f of r.differing.slice(0, 20)) console.log(`    differs: ${f}`);
    if (r.differing.length > 20) console.log(`    ...and ${r.differing.length - 20} more differing`);
    for (const f of r.missing.slice(0, 10)) console.log(`    missing from the install: ${f}`);
    if (r.missing.length > 10) console.log(`    ...and ${r.missing.length - 10} more missing`);
    console.log('  The installed code is NOT the code at that commit. Reinstall, or find out');
    console.log(`  who wrote it: claude plugin marketplace update ${r.marketplace} && claude plugin update ${r.plugin}@${r.marketplace} -y\n`);
}

for (const r of unknown) {
    console.log(`COULD NOT CHECK  ${r.plugin} v${r.version}`);
    console.log(`  ${r.reason}`);
    console.log('  That is not a pass. Nothing was compared.\n');
}

if (!QUIET && matched.length) {
    for (const r of matched) {
        console.log(`MATCHES  ${r.plugin} v${r.version} — ${r.scanned} file(s) identical to ${String(r.sha).slice(0, 12)}`);
    }
}

process.exit(drifted.length ? 1 : 0);
