#!/usr/bin/env node
'use strict';
// Suite for the version stamp in plugins/autodev-core/scripts/unattended-worker.js.
//
// WHY THIS SUITE EXISTS. [measured 2026-09-28] the unattended ledger held 50
// records and none carried a plugin version, so nobody could tell which release
// a worker had run. headless-worker.js already stamped one. The stamp is only
// worth something if it names the INSTALLED release, so the central case copies
// the script into a plugin-cache layout under a version the checkout never
// carries (9.9.9-cache) and drives brief, record and settle through the CLI.
// A stamp that read the checkout, a constant, or nothing would fail it.
//
// The control runs the checkout copy on the same fixture: it must stamp the
// repo's VERSION and say dev, so the cache case cannot pass by accident.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'plugins', 'autodev-core', 'scripts');
const CHECKOUT = path.join(SCRIPTS, 'unattended-worker.js');
const REPO_VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const CACHE_VERSION = '9.9.9-cache';

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail === undefined ? '' : '  (' + detail + ')')); }
}

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-version-')));
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_CONFIG_DIR;

// The three files the script loads, laid out as the plugin cache lays them out.
function plant(pluginDir, manifest) {
    fs.mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    for (const f of ['unattended-worker.js', 'headless-worker.js', 'claude-paths.js']) {
        fs.copyFileSync(path.join(SCRIPTS, f), path.join(pluginDir, 'scripts', f));
    }
    fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
    return path.join(pluginDir, 'scripts', 'unattended-worker.js');
}
const CACHED = plant(path.join(scratch, 'cfg', 'plugins', 'cache', 'autodev', 'autodev-core', CACHE_VERSION), { name: 'autodev-core', version: CACHE_VERSION });
const NO_VERSION = plant(path.join(scratch, 'cfg', 'plugins', 'cache', 'autodev', 'autodev-core', 'broken'), { name: 'autodev-core' });

function cli(script, args) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* a crash */ }
    return { status: r.status, stdout: r.stdout, json };
}
const val = (r) => (r.json && r.json.ok ? r.json.value : null);
function g(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const origin = path.join(scratch, 'origin.git');
const repo = path.join(scratch, 'repo');
g(scratch, 'init', '--bare', origin);
g(scratch, 'init', repo);
fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
g(repo, 'add', 'README.md');
g(repo, 'commit', '-m', 'init');
g(repo, 'branch', '-M', 'main');
g(repo, 'remote', 'add', 'origin', origin);
g(repo, 'push', '-q', 'origin', 'main');
g(repo, 'fetch', '-q', 'origin');
const ledger = path.join(scratch, 'ledger.json');
const briefFile = path.join(scratch, 'brief.md');
fs.writeFileSync(briefFile, 'MISSION. Add a guide.\n');
const sid = 'local_12345678-1234-1234-1234-123456789abc';

// brief, record, settle for one slug through one copy of the script.
function lifecycle(script, slug) {
    const brief = val(cli(script, ['brief', '--repo', repo, '--slug', slug, '--brief-file', briefFile, '--return', 'c', '--ledger', ledger]));
    const taskId = `worker-${slug}`;
    const record = val(cli(script, ['record', '--task-id', taskId, '--session', sid, '--ledger', ledger]));
    const settle = val(cli(script, ['settle', '--task-id', taskId, '--run-status', 'succeeded', '--report-read', '--ledger', ledger]));
    return { brief: brief && brief.record, record: record && record.record, settle: settle && settle.record };
}

try {
    check('control: the checkout VERSION is not the planted cache version', REPO_VERSION && REPO_VERSION !== CACHE_VERSION, REPO_VERSION);

    // 1. Installed copy: every step names the cache version and no dev flag.
    const inst = lifecycle(CACHED, 'from-cache');
    check('brief stamps the installed version', inst.brief && inst.brief.composedVersion === CACHE_VERSION && inst.brief.composedDev === false, JSON.stringify(inst.brief));
    check('record stamps version and dev as headless-worker.js names them', inst.record && inst.record.version === CACHE_VERSION && inst.record.dev === false, JSON.stringify(inst.record));
    check('settle stamps the installed version', inst.settle && inst.settle.state === 'settled' && inst.settle.settledVersion === CACHE_VERSION && inst.settle.settledDev === false, JSON.stringify(inst.settle));

    // 2. Control: the checkout copy names the repo version and says dev.
    const dev = lifecycle(CHECKOUT, 'from-checkout');
    check('control: a checkout copy stamps its own version', dev.record && dev.record.version === REPO_VERSION, dev.record && dev.record.version);
    check('control: a checkout copy says dev on every step', dev.brief && dev.brief.composedDev === true && dev.record.dev === true && dev.settle.settledDev === true);

    // 3. A settle that is refused writes no stamp.
    val(cli(CACHED, ['brief', '--repo', repo, '--slug', 'still-running', '--brief-file', briefFile, '--return', 'c', '--ledger', ledger]));
    val(cli(CACHED, ['record', '--task-id', 'worker-still-running', '--session', sid, '--ledger', ledger]));
    const refused = val(cli(CACHED, ['settle', '--task-id', 'worker-still-running', '--run-status', 'running', '--report-read', '--ledger', ledger]));
    check('a refused settle stamps nothing', refused && refused.decision.deleteSafe === false && !('settledVersion' in refused.record), refused && JSON.stringify(refused.record));

    // 4. A manifest with no version stamps null, never a guess.
    const blank = lifecycle(NO_VERSION, 'no-version');
    check('a manifest with no version stamps null', blank.record && blank.record.version === null && blank.settle.settledVersion === null, blank.record && JSON.stringify(blank.record.version));

    // 5. status counts which started records carry a version. A legacy record
    //    written before the stamp existed is planted beside them.
    const onDisk = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    onDisk.records.push({ taskId: 'worker-legacy', slug: 'legacy', state: 'deleted', sessionId: sid });
    onDisk.records.push({ taskId: 'worker-composed', slug: 'composed-only', state: 'composed', composedVersion: CACHE_VERSION });
    fs.writeFileSync(ledger, JSON.stringify(onDisk));
    const st = val(cli(CACHED, ['status', '--ledger', ledger]));
    // Started: from-cache, from-checkout, still-running (versioned); no-version, legacy (not).
    check('status counts the records that ran', st && st.ran === 5, st && st.ran);
    check('status counts versioned and unversioned runs', st && st.versioned === 3 && st.unversioned === 2, st && `${st.versioned}/${st.unversioned}`);
} finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a locked file on Windows; the OS temp cleaner owns it */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
