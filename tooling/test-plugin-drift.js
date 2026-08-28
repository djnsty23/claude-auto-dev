#!/usr/bin/env node
'use strict';
// Suite for check-plugin-drift.js.
//
// The case that matters is the one this detector exists for and that no
// version-based check can produce: the installed files DIFFER from the commit
// they claim to be, while every version number agrees. Running the tool against
// the real install only ever exercises the passing branch, which looks identical
// to a tool that compared nothing.
//
// Hermetic: CLAUDE_CONFIG_DIR points at a fixture holding its own manifest, its
// own cache directory and its own marketplace clone (a real git repo, because
// the subject reads the tree with git ls-tree). The developer's actual install is
// never touched.
//
// Run: node tooling/test-plugin-drift.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-plugin-drift.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-drift-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 400) : ''));
}

const PLUGIN = 'testplug';
const MARKET = 'testmkt';
const VERSION = '1.2.3';

const CFG = path.join(ROOT, 'config');
const CLONE = path.join(CFG, 'plugins', 'marketplaces', MARKET);
const CACHE = path.join(CFG, 'plugins', 'cache', MARKET, PLUGIN, VERSION);
const MANIFEST = path.join(CFG, 'plugins', 'installed_plugins.json');

const FILES = {
    'scripts/a.js': 'console.log("a");\n',
    'scripts/nested/b.js': 'module.exports = 1;\n',
    'skills/x/SKILL.md': '# x\n\nbody\n',
};

function git(argv, cwd = CLONE) {
    return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeAll(base, files) {
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(base, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body, 'utf8');
    }
}

// ---- build the fixture marketplace clone and commit the plugin tree ----
fs.mkdirSync(CLONE, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'suite@example.invalid']);
git(['config', 'user.name', 'suite']);
writeAll(path.join(CLONE, 'plugins', PLUGIN), FILES);
git(['add', '-A']);
git(['commit', '-q', '-m', 'fixture']);
const SHA = git(['rev-parse', 'HEAD']).trim();

function writeManifest(entry) {
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify({
        plugins: { [`${PLUGIN}@${MARKET}`]: [Object.assign({
            version: VERSION, gitCommitSha: SHA, installPath: CACHE, scope: 'user',
        }, entry || {})] },
    }, null, 2));
}

function resetCache() {
    fs.rmSync(CACHE, { recursive: true, force: true });
    fs.mkdirSync(CACHE, { recursive: true });
    writeAll(CACHE, FILES);
}

function run(extraArgs) {
    const r = spawnSync(process.execPath, [SUBJECT, '--json'].concat(extraArgs || []), {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: CFG }),
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* left null on purpose */ }
    return { r, json, one: json && json.results && json.results[0] };
}

// ---------------------------------------------------------------- 1. clean

writeManifest();
resetCache();
{
    const { r, one } = run();
    check('clean install MATCHES', one && one.status === 'MATCHES', r.stdout + r.stderr);
    check('clean install exits 0', r.status === 0, 'status ' + r.status);
    check('clean install reports how many files it compared',
        one && one.scanned === Object.keys(FILES).length, one && one.scanned);
}

// -------------------------------------------- 2. THE CASE THIS EXISTS FOR
//
// Same version, same recorded sha, one byte different. Every version-based check
// in the repo passes here; this is the only one that can fail.

{
    resetCache();
    fs.writeFileSync(path.join(CACHE, 'scripts/a.js'), 'console.log("TAMPERED");\n', 'utf8');
    const { r, one } = run();
    check('a changed byte is DRIFTED', one && one.status === 'DRIFTED', r.stdout + r.stderr);
    check('and exits non-zero', r.status === 1, 'status ' + r.status);
    // By NAME, not merely a count: "something drifted" sends a reader to the
    // wrong file as easily as the right one.
    check('names the file that differs',
        one && one.differing.includes('scripts/a.js'), one && one.differing);
    check('does not accuse the untouched files',
        one && one.differing.length === 1, one && one.differing);
}

{
    // A nested file, because a walker that only reads the top level would pass
    // every assertion above.
    resetCache();
    fs.writeFileSync(path.join(CACHE, 'scripts/nested/b.js'), 'module.exports = 2;\n', 'utf8');
    const { one } = run();
    check('a changed byte in a NESTED file is caught',
        one && one.status === 'DRIFTED' && one.differing.includes('scripts/nested/b.js'),
        one && JSON.stringify(one.differing));
}

{
    // Deleting from the install is drift too — a partial unpack is exactly the
    // 2026-08-18 shape, where a cache directory was written but incompletely.
    resetCache();
    fs.rmSync(path.join(CACHE, 'skills/x/SKILL.md'));
    const { one } = run();
    check('a file missing from the install is DRIFTED', one && one.status === 'DRIFTED');
    check('and it is reported as missing, not as differing',
        one && one.missing.includes('skills/x/SKILL.md') && !one.differing.includes('skills/x/SKILL.md'),
        one && JSON.stringify({ missing: one.missing, differing: one.differing }));
}

{
    // An EXTRA file is not drift. An install can legitimately carry files the
    // published tree does not, and calling that a mismatch cries wolf on every
    // plugin — which is how a detector gets ignored.
    resetCache();
    fs.writeFileSync(path.join(CACHE, 'scripts/local-note.txt'), 'scratch\n', 'utf8');
    const { r, one } = run();
    check('an extra file is NOT drift', one && one.status === 'MATCHES', r.stdout);
    check('but it is still reported as extra',
        one && one.extra.includes('scripts/local-note.txt'), one && one.extra);
}

// ------------------------------------- 3. the three-outcome discipline
//
// Each of these is a COULD NOT CHECK. None may render as a pass: "I compared and
// they match" and "I could not compare" are opposite facts.

{
    resetCache();
    writeManifest({ gitCommitSha: null });
    const { r, one } = run();
    check('no recorded sha: COULD NOT CHECK, not MATCHES', one && one.status === 'COULD NOT CHECK', r.stdout);
    check('no recorded sha: says there is no anchor',
        one && /no anchor|gitCommitSha/.test(one.reason || ''), one && one.reason);
}

{
    writeManifest({ gitCommitSha: '0'.repeat(40) });
    const { r, one } = run();
    check('unknown sha: COULD NOT CHECK', one && one.status === 'COULD NOT CHECK', r.stdout);
    check('unknown sha: names the fix command',
        one && /marketplace update/.test(one.reason || ''), one && one.reason);
}

{
    writeManifest({ installPath: path.join(ROOT, 'no-such-install') });
    const { one } = run();
    check('missing install path: COULD NOT CHECK', one && one.status === 'COULD NOT CHECK');
}

{
    // A COULD NOT CHECK must not be reported as a failure either — exit 1 is
    // reserved for confirmed drift, so a stale clone cannot wedge a gate red.
    writeManifest({ gitCommitSha: '0'.repeat(40) });
    const { r } = run();
    check('COULD NOT CHECK exits 0, not 1 — unknown is not confirmed drift',
        r.status === 0, 'status ' + r.status);
}

{
    // No manifest at all: refuse loudly. This is the failure mode the whole repo
    // has been fixing today — an unreadable source rendering as a clean zero.
    const emptyCfg = path.join(ROOT, 'empty-config');
    fs.mkdirSync(emptyCfg, { recursive: true });
    const r = spawnSync(process.execPath, [SUBJECT], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: emptyCfg }),
    });
    check('no manifest: exits 2', r.status === 2, 'status ' + r.status);
    check('no manifest: says it is NOT "no drift"', /NOT "no drift"/.test(r.stderr || ''), r.stderr);
    check('no manifest: prints no population line on stdout',
        !/POPULATION/.test(r.stdout || ''), r.stdout);
}

// -------------------------------------------------------------------- report

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`plugin-drift: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`plugin-drift: ${passed}/${total} passed — content drift, extras, and all three COULD-NOT-CHECK routes`);
