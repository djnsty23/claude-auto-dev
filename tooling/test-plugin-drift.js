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

// ------------------------------------------- 4. the pipe delivers every byte
//
// node's process.stdout is ASYNCHRONOUS when it is a pipe on darwin and
// synchronous when it is a pipe on linux/win32, and process.exit() does not
// drain a pending async write. A run that prints past the 64KiB OS pipe buffer
// and then exits hands its caller exactly 65536 bytes under a status that says
// nothing failed — the shape rendered-layout-gate.js shipped with until
// 2026-09-07. --json here carries one result per installed plugin, so it grows
// with the manifest.
//
// TWO ASSERTIONS, and the first is what stops the second passing by
// construction: the output must EXCEED one pipe buffer, and the piped byte count
// must equal the same run redirected to a FILE, where the write is synchronous
// on every platform.
{
    const PIPE_BUF = 64 * 1024;
    // Entries whose install path does not exist. checkPlugin() returns on the
    // first branch for those, so this fixture costs no git and no file walk —
    // it is a large manifest and nothing else. The point here is the byte count
    // at the exit, not which verdict produced the bytes.
    const many = {};
    for (let i = 0; i < 300; i++) {
        many['fixture-plugin-' + String(i).padStart(4, '0') + '@' + MARKET] = [{
            version: '1.2.3',
            gitCommitSha: SHA,
            installPath: path.join(ROOT, 'no-such-install', 'a'.repeat(60), 'plugin-' + i),
            scope: 'user',
        }];
    }
    fs.writeFileSync(MANIFEST, JSON.stringify({ plugins: many }, null, 2));

    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: CFG });
    const viaFileBytes = (args) => {
        const out = path.join(ROOT, 'via-file.out');
        const fd = fs.openSync(out, 'w');
        spawnSync(process.execPath, [SUBJECT].concat(args), { stdio: ['ignore', fd, 'ignore'], env });
        fs.closeSync(fd);
        return fs.statSync(out).size;
    };
    const piped = spawnSync(process.execPath, [SUBJECT, '--json'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
    const pipeBytes = Buffer.byteLength(piped.stdout || '', 'utf8');
    const fileBytes = viaFileBytes(['--json']);

    check('--json over a large manifest exceeds one pipe buffer, so the next check is not vacuous',
        fileBytes > PIPE_BUF, JSON.stringify({ bytes: fileBytes, buffer: PIPE_BUF }));
    check('--json through a PIPE delivers every byte it writes to a FILE',
        pipeBytes === fileBytes, JSON.stringify({ pipe: pipeBytes, file: fileBytes }));
    check('the piped JSON still parses at that size',
        (() => { try { return JSON.parse(piped.stdout).results.length === 300; } catch { return false; } })(),
        'tail ' + JSON.stringify((piped.stdout || '').slice(-40)));

    // The human report shares the exit path, so it shares the defect. BE CLEAR
    // WHAT THIS LINE CATCHES: it is a stream of small console.log calls, which
    // drain opportunistically while the parent reads, so it strands far less at
    // the exit than the single JSON write — measurably so on the sibling suites,
    // where the equivalent line stays green under the mutation even above the
    // buffer. It states the equality; it is not cover for this defect.
    const reportPipe = spawnSync(process.execPath, [SUBJECT],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
    check('the human report through a PIPE also delivers every byte',
        Buffer.byteLength(reportPipe.stdout || '', 'utf8') === viaFileBytes([]),
        Buffer.byteLength(reportPipe.stdout || '', 'utf8'));
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
