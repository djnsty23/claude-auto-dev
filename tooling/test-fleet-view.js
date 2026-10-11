#!/usr/bin/env node
'use strict';
// Tests for plugins/autodev-core/scripts/fleet-view.js, the local page that
// merges every worker ledger and both desktop stores.
// Run: node tooling/test-fleet-view.js
// Exit 0 all green, 1 on a red assertion, 2 when a child produced no verdict.
//
// EVERY CASE DRIVES THE REAL SCRIPT AS A SUBPROCESS against a fixture home and
// a fixture %APPDATA% under a temp root whose name carries a space. The server
// cases start it with --port 0, read the port from its first stdout line, and
// talk HTTP to it. Workers it relaunches or stops run through a FAKE claude
// binary, and every pid the suite learns about is killed BY PID at the end.
//
// The planted defects this suite is meant to catch: a source that goes missing
// from the page instead of rendering COULD-NOT-READ, a POST accepted without the
// token, an answer that overwrites an existing answer.json, and a stop that
// kills a process whose identity does not match the record.

const { classify, reason, runBudgeted, tally, exitCode } = require('./spawn-budget.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-view.js');
const HW_SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'headless-worker.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fv test-'));
const HOME = path.join(ROOT, 'home');
const APPDATA = path.join(ROOT, 'app data');
const LOCALAPPDATA = path.join(ROOT, 'local app data');
const AUTODEV = path.join(HOME, '.claude', 'autodev');
const FAKE = path.join(ROOT, 'fake claude.js');
const ACCT = '11111111-2222-3333-4444-555555555555';
const ORG = '99999999-8888-7777-6666-555555555555';
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3600 * 1000;

let pass = 0; let fail = 0; let infra = 0;
const failures = []; const indeterminate = []; const pids = [];

function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
}
function indeterminateCase(label, why) { infra++; indeterminate.push(`${label} (${why})`); console.error(`infrastructure: ${label} produced no verdict (${why})`); }

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); };
const writeJson = (file, v) => write(file, JSON.stringify(v, null, 2) + '\n');
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

function fv(args, env = {}) {
    const r = runBudgeted(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, HOME, USERPROFILE: HOME, APPDATA, LOCALAPPDATA, AUTODEV_FLEET_CONFIG_DIRS: '', ...env }, timeout: 30000, maxTimeout: 120000 });
    if (classify(r) === 'infrastructure') indeterminateCase('fv ' + args.slice(0, 2).join(' '), reason(r));
    let json = null;
    try { json = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { /* human output */ }
    return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

// ---------------------------------------------------------------- fixtures
write(FAKE, [
    "'use strict';",
    'const ms = Number(process.env.FAKE_SLEEP_MS || 0);',
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'fake-model', session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) + '\\n');",
    "process.stdout.write('PPID=' + process.ppid + '\\n');",
    "process.stdout.write('CONFIG_DIR=' + (process.env.CLAUDE_CONFIG_DIR || '') + '\\n');",
    'setTimeout(() => process.exit(0), ms);',
].join('\n') + '\n');

writeJson(path.join(HOME, '.claude.json'), { oauthAccount: { accountUuid: ACCT } });
// A stale nested file must not override the default account's home-level metadata.
writeJson(path.join(HOME, '.claude', '.claude.json'), { oauthAccount: { accountUuid: 'stale-nested-account' } });

// runs/: one live asking run, one old finished run (outside the window), one old run still asking.
const runDir = (job, stamp) => path.join(AUTODEV, 'runs', job, stamp);
const R1 = runDir('ask-job', '2026-01-01T00-00-00-000Z');
writeJson(path.join(R1, 'status.json'), { job: 'ask-job', cwd: path.join(ROOT, 'proj-alpha'), state: 'finished', started: iso(2 * H), finished: iso(H), exitCode: 0 });
write(path.join(R1, 'brief.md'), '# Ask job brief\nbody\n');
write(path.join(R1, 'progress.md'), '- [x] built it - https://github.com/o/r/pull/7\n- [!] needs a choice\n\nSTATUS: blocked\n');
writeJson(path.join(R1, 'ask.json'), { question: 'Seeded or production?', options: [{ label: 'Seeded (Recommended)' }, { label: 'Production' }] });
const R2 = runDir('old-job', '2026-01-02T00-00-00-000Z');
writeJson(path.join(R2, 'status.json'), { job: 'old-job', cwd: ROOT, state: 'finished', started: iso(400 * H), finished: iso(399 * H), exitCode: 0 });
fs.utimesSync(R2, new Date(NOW - 399 * H), new Date(NOW - 399 * H));
const R3 = runDir('old-asker', '2026-01-03T00-00-00-000Z');
writeJson(path.join(R3, 'status.json'), { job: 'old-asker', cwd: ROOT, state: 'running', started: iso(500 * H) });
writeJson(path.join(R3, 'ask.json'), { question: 'Still waiting?' });
for (const d of [R2, R3]) for (const f of fs.readdirSync(d)) fs.utimesSync(path.join(d, f), new Date(NOW - 399 * H), new Date(NOW - 399 * H));

// headless-worker ledger: an exited worker to settle, a stopped one to relaunch.
const WDIR = path.join(ROOT, 'workers dir');
const LEDGER = path.join(AUTODEV, 'headless-workers.json');
function worker(code, { exit = 0, result = 'done', startedAgo = H, cwd = ROOT, extra = {} } = {}) {
    const log = path.join(WDIR, `${code}.jsonl`);
    const report = path.join(WDIR, `${code}.report.md`);
    const promptFile = path.join(WDIR, `${code}.md`);
    write(promptFile, `# ${code} brief\nDo the thing.\n`);
    write(log, JSON.stringify({ type: 'system', subtype: 'init', cwd, model: 'm1', session_id: `${code.toLowerCase()}-0000-0000-0000-000000000000` }) + '\n'
        + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `${code} last words` }] } }) + '\n'
        + (exit === null ? '' : `CLAUDE_EXIT=${exit}\n`));
    if (result) write(report, `Report\nRESULT ${code} ${result}: it ${result}\n`);
    return { code, pid: 0, startedAt: iso(startedAgo), log, report, promptFile, configDir: null, model: 'm1', effort: null, permissionMode: 'default', cwd, state: 'running', ...extra };
}
const records = [worker('W-SETTLE'), worker('W-STOPPED', { result: 'stopped', extra: { dev: true } })];
writeJson(LEDGER, { version: 1, records });
// W-STOPPED asked and was answered: relaunch must carry the answer.
writeJson(path.join(WDIR, 'W-STOPPED', 'ask.json'), { question: 'Which base?' });
writeJson(path.join(WDIR, 'W-STOPPED', 'answer.json'), { label: 'origin/main', note: 'rebase first' });

writeJson(path.join(AUTODEV, 'unattended-workers.json'), { version: 1, records: [
    { taskId: 'worker-slug-a', repo: path.join(ROOT, 'repo-a'), slug: 'slug-a', worktree: path.join(ROOT, 'repo-a', '.claude', 'worktrees', 'slug-a'), state: 'started', composedAt: iso(H), startedAt: iso(H) },
] });
write(path.join(AUTODEV, 'reports', 'worker-slug-a', 'REPORT.md'), 'work\nRESULT slug-a done: shipped https://github.com/o/r/pull/9\n');
writeJson(path.join(AUTODEV, 'bg-runner.json'), { version: 1, workers: [{ code: 'BG-1', id: 'abcd1234', cwd: path.join(ROOT, 'repo-b'), state: 'running', startedAt: iso(H) }] });

const DESK = path.join(APPDATA, 'Claude', 'claude-code-sessions', ACCT, ORG);
writeJson(path.join(DESK, 'local_one.json'), { sessionId: 'local_one', cliSessionId: 'c1', cwd: path.join(ROOT, 'desk-proj'), title: 'Desk session one', isArchived: false, lastActivityAt: NOW - H, createdAt: NOW - 2 * H });
writeJson(path.join(DESK, 'local_xss.json'), { sessionId: 'local_xss', cwd: ROOT, title: '<script>alert(1)</script>', isArchived: false, lastActivityAt: NOW - H });
writeJson(path.join(DESK, 'local_arch.json'), { sessionId: 'local_arch', cwd: ROOT, title: 'Archived one', isArchived: true, lastActivityAt: NOW - H });
writeJson(path.join(DESK, 'scheduled-tasks.json'), { scheduledTasks: [
    { id: 'nightly-thing', displayName: 'Nightly thing', cronExpression: '0 3 * * *', enabled: true, cwd: ROOT, createdAt: NOW - H },
    { id: 'off-thing', displayName: 'Disabled', enabled: false, cwd: ROOT },
] });

// ---------------------------------------------------------------- http helpers
function request(port, method, urlPath, { body = null, host = `127.0.0.1:${port}` } = {}) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { Host: host, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
            let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
        req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

function startServer(extra = []) {
    return new Promise((resolve) => {
        // stdin is a pipe the suite closes at the end, so the server exits normally
        // and V8 writes its coverage dump. A kill writes none on Windows.
        const child = spawn(process.execPath, [SCRIPT, 'serve', '--port', '0', '--claude-bin', FAKE, '--until-stdin-closes', ...extra], { cwd: ROOT, env: { ...process.env, HOME, USERPROFILE: HOME, APPDATA, LOCALAPPDATA, AUTODEV_FLEET_CONFIG_DIRS: '' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        pids.push(child.pid);
        let out = ''; let err = '';
        // Three outcomes, kept apart. A listening line is a port. The subject EXITING
        // first is a verdict about the subject (a stub, a crash). Only a live process
        // that stays silent for 20 s, or a spawn that fails, is infrastructure.
        const timer = setTimeout(() => resolve({ child, port: null, exited: null, out, err }), 20000);
        child.on('error', (e) => { clearTimeout(timer); resolve({ child, port: null, exited: null, out, err: err + String(e && e.message) }); });
        child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ child, port: null, exited: { code, signal }, out, err }); });
        child.stdout.on('data', (c) => { out += c; const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(out); if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), out, get err() { return err; } }); } });
        child.stderr.on('data', (c) => { err += c; });
    });
}

const form = (o) => new URLSearchParams(o).toString();
const events = () => (read(path.join(AUTODEV, 'fleet-events.jsonl')) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rowsOf = async (port) => JSON.parse((await request(port, 'GET', '/rows.json')).body).rows;

async function main() {
    // ------------------------------------------------------------ 1. help and selftest, nothing on stderr
    const help = fv(['--help']);
    check('1. --help exits 0 with usage and nothing on stderr', help.exit === 0 && help.stdout.startsWith('Usage:') && help.stderr === '', help.stderr);
    const self = fv(['--selftest']);
    check('1. --selftest passes and prints nothing on stderr', self.exit === 0 && self.json && self.json.ok && self.stderr === '', self.stdout + self.stderr);
    const bad = fv(['--nope']);
    check('1. an unknown flag exits 1 with a usage error', bad.exit === 1 && bad.json && bad.json.error.code === 'usage');

    // ------------------------------------------------------------ 2. the merge: every source, its population, its rows
    const list = fv(['list', '--json']);
    const view = list.json;
    check('2. list --json exits 0 with nothing on stderr', list.exit === 0 && !!view && list.stderr === '', list.stderr);
    const src = (name) => (view ? view.sources.find((x) => x.source === name) : null) || {};
    for (const name of ['runs', 'headless-worker', 'unattended-worker', 'bg-runner', 'desktop-sessions', 'desktop-routines']) {
        check(`2. ${name} is readable and prints a population line`, src(name).readable === true && /\d+/.test(src(name).population || ''), JSON.stringify(src(name)).slice(0, 200));
    }
    const rows = view ? view.rows : [];
    const row = (code) => rows.find((r) => r.code === code);
    check('2. the missions source renders a COULD-NOT-READ row, not nothing', rows.some((r) => r.source === 'missions' && r.process === 'COULD-NOT-READ'));
    check('2. a run row carries its project, last progress, STATUS, PR and open question',
        !!row('ask-job') && row('ask-job').project === 'proj-alpha' && row('ask-job').result === 'blocked' && row('ask-job').progress === '- [!] needs a choice'
        && row('ask-job').pr === 'https://github.com/o/r/pull/7' && row('ask-job').question && row('ask-job').question.text === 'Seeded or production?', JSON.stringify(row('ask-job')));
    check('2. a finished run outside the window is not shown', !row('old-job'));
    check('2. an old run that still asks is shown, and is not read as running', !!row('old-asker') && /^unknown/.test(row('old-asker').process), JSON.stringify(row('old-asker') || {}).slice(0, 200));
    check('2. a headless worker row carries account, cwd project and last words', !!row('W-SETTLE') && row('W-SETTLE').account === 'default' && row('W-SETTLE').progress === 'W-SETTLE last words' && row('W-SETTLE').process === 'exited');
    check('2. an unattended row reads its RESULT line and PR from the report', !!row('slug-a') && /^done: shipped/.test(row('slug-a').result) && row('slug-a').pr === 'https://github.com/o/r/pull/9');
    check('2. a bg-runner row is shown', !!row('BG-1') && row('BG-1').project === 'repo-b');
    check('2. a desktop session row takes its account label from the config dir', !!row('Desk session one') && row('Desk session one').account === 'default');
    check('2. an archived desktop session is never shown', !row('Archived one'));
    check('2. an enabled routine is shown with its schedule, a disabled one is not', !!row('nightly-thing') && row('nightly-thing').process === 'cron 0 3 * * *' && !row('off-thing'));
    check('2. actions: answer on the asking run, settle on the exited worker, relaunch on the stopped one',
        !!row('ask-job') && row('ask-job').actions.includes('answer') && row('W-SETTLE').actions.includes('settle')
        && !row('W-SETTLE').actions.includes('relaunch') && row('W-STOPPED').actions.includes('relaunch'), JSON.stringify(rows.map((r) => [r.code, r.actions])).slice(0, 400));

    const human = fv(['list']);
    check('2. list prints every population line before the rows', human.exit === 0 && human.stdout.split('\n').slice(0, 7).every((l) => /^(runs|headless-worker|unattended-worker|bg-runner|missions|desktop-sessions|desktop-routines):/.test(l)), human.stdout.slice(0, 600));

    // Two accounts deliberately reuse a job code and stamp to expose key collisions.
    const configA = path.join(HOME, '.claude');
    const configB = path.join(ROOT, 'second account');
    const askB = path.join(configB, 'autodev', 'runs', 'ask-job', path.basename(R1));
    writeJson(path.join(askB, 'status.json'), { job: 'ask-job', state: 'finished', started: iso(H), finished: iso(H) });
    writeJson(path.join(askB, 'ask.json'), { question: 'Second account choice?' });
    const ledgerB = path.join(configB, 'autodev', 'headless-workers.json');
    writeJson(ledgerB, { version: 1, records: [worker('B-STOPPED', { result: 'stopped', extra: { dev: true } })] });
    writeJson(path.join(configB, 'autodev', 'unattended-workers.json'), { version: 1, records: [{ taskId: 'B-TASK', state: 'started', startedAt: iso(H) }] });
    writeJson(path.join(configB, 'autodev', 'bg-runner.json'), { workers: [{ code: 'B-BG', state: 'running', startedAt: iso(H) }] });
    const accountB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeJson(path.join(configB, '.claude.json'), { oauthAccount: { accountUuid: accountB } });
    writeJson(path.join(APPDATA, 'Claude', 'claude-code-sessions', accountB, ORG, 'local_b.json'), { sessionId: 'local_b', title: 'Second desk', lastActivityAt: NOW });
    const flags = ['--config-dir', configA, '--config-dir', configB];
    const both = fv(['list', '--json', ...flags]);
    const bothRows = both.json && both.json.rows || [];
    const asks = bothRows.filter((r) => r.code === 'ask-job');
    const labelFor = (dir) => dir === configA ? 'default' : path.basename(dir);
    check('2. two config dirs show both asking runs with exact account labels', both.exit === 0 && asks.length === 2
        && [configA, configB].every((dir) => asks.some((r) => r.account === labelFor(dir) && r.configDir === dir)), both.stdout);
    check('2. every explicit config row names its directory and has a unique key', bothRows.length > 0
        && bothRows.every((r) => flags.includes(r.configDir) && r.account === labelFor(r.configDir))
        && new Set(bothRows.map((r) => r.key)).size === bothRows.length);
    check('2. Desktop fixture rows carry exactly default and the second directory basename',
        bothRows.find((r) => r.code === 'Desk session one')?.account === 'default'
        && bothRows.find((r) => r.code === 'Second desk')?.account === path.basename(configB));
    check('2. every second-account worker store and its Desktop session appear once', ['B-STOPPED', 'B-TASK', 'B-BG', 'Second desk'].every((code) =>
        bothRows.filter((r) => r.code === code && r.configDir === configB).length === 1)
        && bothRows.filter((r) => r.code === 'Desk session one').length === 1, both.stdout);
    const bothHuman = fv(['list', ...flags]);
    check('2. human output names both accounts on their asking rows', bothHuman.exit === 0 && [configA, configB].every((dir) =>
        bothHuman.stdout.split('\n').some((line) => line.startsWith('ask-job  ') && line.split('  ')[2] === labelFor(dir))), bothHuman.stdout);
    const defaultDesktop = fv(['list', '--json']);
    check('2. an unmatched Desktop account is reported without guessing a config or printing a hash',
        defaultDesktop.exit === 0 && defaultDesktop.json.rows.find((r) => r.code === 'Second desk')?.account === 'default (Desktop account mismatch)');
    const envBoth = fv(['list', '--json'], { AUTODEV_FLEET_CONFIG_DIRS: JSON.stringify([configA, configB]) });
    check('2. the env list reads the same two accounts', envBoth.exit === 0 && envBoth.json.rows.filter((r) => r.code === 'ask-job').length === 2, envBoth.stdout);
    const missingDir = path.join(ROOT, 'missing account');
    const fileDir = path.join(ROOT, 'not a directory');
    write(fileDir, 'cannot read this as a config directory');
    for (const badDir of [missingDir, fileDir]) {
        const partial = fv(['list', '--json', '--config-dir', badDir, '--config-dir', configB]);
        check('2. an unreadable config dir is named while the other account survives', partial.exit === 0 && partial.json
            && partial.json.rows.some((r) => r.configDir === badDir && r.process === 'COULD-NOT-READ')
            && partial.json.rows.some((r) => r.configDir === configB && r.question && r.question.text === 'Second account choice?'), partial.stdout);
    }
    const precedence = fv(['list', '--json', '--config-dir', configB], { AUTODEV_FLEET_CONFIG_DIRS: JSON.stringify([missingDir]) });
    check('2. explicit flags override the environment list', precedence.exit === 0 && precedence.json.rows.every((r) => r.configDir === configB), precedence.stdout);
    const invalid = fv(['list', '--json'], { AUTODEV_FLEET_CONFIG_DIRS: '{broken' });
    check('2. a malformed env list is a usage error', invalid.exit === 1 && invalid.json && invalid.json.error.code === 'usage', invalid.stdout);

    // Captured from the unchanged list entry point before multi-account support.
    const base = path.join(ROOT, 'baseline');
    const baseAd = path.join(base, '.claude', 'autodev');
    const baseApp = path.join(base, 'appdata');
    fs.mkdirSync(path.join(baseAd, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(baseApp, 'Claude', 'claude-code-sessions'), { recursive: true });
    writeJson(path.join(baseAd, 'headless-workers.json'), { version: 1, records: [] });
    writeJson(path.join(baseAd, 'unattended-workers.json'), { version: 1, records: [] });
    writeJson(path.join(baseAd, 'bg-runner.json'), { workers: [{ code: 'BASE', id: 'base', state: 'running' }] });
    const baseline = fv(['list'], { HOME: base, USERPROFILE: base, APPDATA: baseApp });
    const expected = [
        `runs: 0 run(s) read under ${path.join(baseAd, 'runs')}, 0 shown`,
        `headless-worker: ${path.join(baseAd, 'headless-workers.json')}: 0 record(s), 0 shown`,
        `unattended-worker: ${path.join(baseAd, 'unattended-workers.json')}: 0 record(s), 0 shown`,
        `bg-runner: ${path.join(baseAd, 'bg-runner.json')}: 1 worker(s), 1 shown`,
        'missions: COULD NOT READ (no --mission-store given, and the store has no default location)',
        `desktop-sessions: 0 session file(s) across 0 account folder(s) under ${path.join(baseApp, 'Claude', 'claude-code-sessions')}, 0 shown`,
        'desktop-routines: 0 routine(s) in 0 scheduled-tasks.json file(s), 0 enabled, 0 shown',
        'window: live, asking, or touched in the last 48 h. 2 row(s).',
        'COULD-NOT-READ  -  -  missions  COULD-NOT-READ  -  -  | missions: COULD NOT READ (no --mission-store given, and the store has no default location)',
        'BASE  -  default  bg-runner  running  none  -', '',
    ].join('\n');
    check('2. default single-dir output matches the before fixture byte for byte', baseline.exit === 0 && baseline.stderr === '' && baseline.stdout === expected, baseline.stdout);

    // ------------------------------------------------------------ 3. an unreadable ledger is a row, never an absence
    const saved = read(LEDGER);
    write(LEDGER, '{ not json');
    const broken = fv(['list', '--json']).json;
    check('3. a ledger that does not parse renders COULD-NOT-READ for its source',
        !!broken && broken.rows.some((r) => r.source === 'headless-worker' && r.process === 'COULD-NOT-READ'), broken && JSON.stringify(broken.sources.map((s) => s.population)));
    write(LEDGER, saved);
    fs.renameSync(path.join(AUTODEV, 'bg-runner.json'), path.join(AUTODEV, 'bg-runner.json.away'));
    const missing = fv(['list', '--json']).json;
    check('3. a missing ledger renders COULD-NOT-READ for its source', !!missing && missing.rows.some((r) => r.source === 'bg-runner' && r.process === 'COULD-NOT-READ'));
    fs.renameSync(path.join(AUTODEV, 'bg-runner.json.away'), path.join(AUTODEV, 'bg-runner.json'));
    const noApp = fv(['list', '--json', '--appdata', path.join(ROOT, 'no such dir')]).json;
    check('3. an unreadable desktop store renders COULD-NOT-READ for sessions and routines',
        !!noApp && ['desktop-sessions', 'desktop-routines'].every((n) => noApp.rows.some((r) => r.source === n && r.process === 'COULD-NOT-READ')));
    // The MSIX Desktop package: outside the app, %APPDATA%/Claude is empty and the real store sits
    // under %LOCALAPPDATA%/Packages/Claude_<id>/LocalCache/Roaming. Without --appdata that copy is read.
    const pkgRoot = path.join(ROOT, 'pkg local');
    const pkgDesk = path.join(pkgRoot, 'Packages', 'Claude_test123', 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions', ACCT, ORG);
    writeJson(path.join(pkgDesk, 'local_pkg.json'), { sessionId: 'local_pkg', cwd: ROOT, title: 'Package session', isArchived: false, lastActivityAt: NOW - H });
    fs.mkdirSync(path.join(ROOT, 'empty app data'), { recursive: true });
    const pkg = fv(['list', '--json'], { APPDATA: path.join(ROOT, 'empty app data'), LOCALAPPDATA: pkgRoot }).json;
    check('3. without --appdata, an empty %APPDATA% falls back to the MSIX package copy of the desktop store',
        !!pkg && pkg.rows.some((r) => r.code === 'Package session') && !pkg.rows.some((r) => r.source === 'desktop-sessions' && r.process === 'COULD-NOT-READ'),
        JSON.stringify(((pkg && pkg.rows) || []).filter((r) => /desktop/.test(r.source || '')).slice(0, 3)));

    // The page and its POST must use the account-qualified key, even with duplicate job names.
    const multiSrv = await startServer(flags);
    if (!multiSrv.port) {
        if (multiSrv.exited) check('3. multi-account server starts', false, JSON.stringify(multiSrv.exited));
        else indeterminateCase('3. multi-account server', multiSrv.err);
        multiSrv.child.stdin.end();
    } else {
        const page = await request(multiSrv.port, 'GET', '/');
        const token = (/name="token" value="([0-9a-f]+)"/.exec(page.body) || [])[1];
        check('3. one page renders both account labels and both asks', page.status === 200 && page.body.includes(configA)
            && page.body.includes(configB) && page.body.includes('Second account choice?') && page.body.includes('Seeded or production?'));
        const rows = await rowsOf(multiSrv.port);
        const second = rows.find((r) => r.configDir === configB && r.code === 'ask-job');
        const answered = await request(multiSrv.port, 'POST', '/action', { body: form({ token, action: 'answer', key: second && second.key, label: 'Second only' }) });
        check('3. answering account B writes only account B answer.json', answered.status === 303
            && JSON.parse(read(path.join(askB, 'answer.json')) || '{}').label === 'Second only'
            && !fs.existsSync(path.join(R1, 'answer.json')), answered.headers.location);
        const stopped = rows.find((r) => r.code === 'B-STOPPED');
        const relaunched = await request(multiSrv.port, 'POST', '/action', { body: form({ token, action: 'relaunch', key: stopped && stopped.key }) });
        const newRecord = JSON.parse(read(ledgerB)).records.find((r) => r.code === 'B-STOPPED-R2');
        if (newRecord && newRecord.pid) pids.push(newRecord.pid);
        for (let i = 0; i < 40 && newRecord && !(read(newRecord.log) || '').includes('CONFIG_DIR='); i++) await sleep(50);
        check('3. account B relaunch retains its config even when the old record omitted it', relaunched.status === 303 && newRecord
            && newRecord.configDir === path.basename(configB) && (read(newRecord.log) || '').includes('CONFIG_DIR=' + configB),
            decodeURIComponent(relaunched.headers.location || ''));
        const ended = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 15000);
            multiSrv.child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
        });
        multiSrv.child.stdin.end();
        check('3. multi-account server exits cleanly', await ended === 0 && multiSrv.err === '', multiSrv.err);
    }

    if (process.argv.includes('--multi-config-only')) return;

    // ------------------------------------------------------------ 4. the server
    const srv = await startServer(['--takeover-script', path.join(ROOT, 'takeover.ps1'), '--no-launch']);
    if (!srv.port && srv.exited) { check('4. serve stays up and prints its listening line', false, `exited ${srv.exited.code === null ? srv.exited.signal : srv.exited.code} before listening: ${srv.out} ${srv.err}`); return; }
    if (!srv.port) { indeterminateCase('4. server start', `no listening line within 20 s: ${srv.out} ${srv.err}`); return; }
    const port = srv.port;
    const page = await request(port, 'GET', '/');
    const token = (/name="token" value="([0-9a-f]+)"/.exec(page.body) || [])[1];
    check('4. GET / renders the page with a token and every population line', page.status === 200 && !!token && page.body.includes('desktop-routines:') && page.body.includes('COULD NOT READ'), page.status);
    check('4. GET / escapes worker text: a session titled with a script tag renders as text', !page.body.includes('<script') && page.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    const evil = await request(port, 'GET', '/', { host: 'evil.example:80' });
    check('4. a non-loopback Host header is refused', evil.status === 421, evil.status);

    const keyOf = async (code) => ((await rowsOf(port)).find((r) => r.code === code) || {}).key;
    const askKey = await keyOf('ask-job');
    const noToken = await request(port, 'POST', '/action', { body: form({ action: 'answer', key: askKey, label: 'Production' }) });
    check('4. a POST without the token is refused with 403 and writes nothing', noToken.status === 403 && !fs.existsSync(path.join(R1, 'answer.json')), noToken.status);
    const wrongToken = await request(port, 'POST', '/action', { body: form({ token: token.replace(/.$/, (c) => (c === '0' ? '1' : '0')), action: 'answer', key: askKey, label: 'Production' }) });
    check('4. a POST with a wrong token is refused', wrongToken.status === 403 && !fs.existsSync(path.join(R1, 'answer.json')));
    check('4. a refused POST is still an event line', events().some((e) => e.ok === false && /token/.test(e.detail)));

    // answer
    const ans = await request(port, 'POST', '/action', { body: form({ token, action: 'answer', key: askKey, label: 'Seeded (Recommended)', note: 'label it on the page' }) });
    const answer = JSON.parse(read(path.join(R1, 'answer.json')) || '{}');
    check('4. answer writes answer.json beside ask.json with the label and note', ans.status === 303 && answer.label === 'Seeded (Recommended)' && answer.note === 'label it on the page', ans.body);
    check('4. answer appends an ok event line', events().some((e) => e.action === 'answer' && e.ok === true && e.code === 'ask-job'));
    const again = await request(port, 'POST', '/action', { body: form({ token, action: 'answer', key: askKey, label: 'Production' }) });
    check('4. a second answer is refused and the first is untouched', again.status === 303 && /refused/.test(decodeURIComponent(again.headers.location || ''))
        && JSON.parse(read(path.join(R1, 'answer.json'))).label === 'Seeded (Recommended)', again.headers.location);

    // settle
    const settle = await request(port, 'POST', '/action', { body: form({ token, action: 'settle', key: await keyOf('W-SETTLE') }) });
    const settled = JSON.parse(read(LEDGER)).records.find((r) => r.code === 'W-SETTLE');
    check('4. settle marks the worker settled in its ledger', settle.status === 303 && settled.state === 'settled' && settled.result === 'done', settle.headers.location);

    // relaunch
    const rel = await request(port, 'POST', '/action', { body: form({ token, action: 'relaunch', key: await keyOf('W-STOPPED') }) });
    const relaunched = JSON.parse(read(LEDGER)).records.find((r) => r.code === 'W-STOPPED-R2');
    if (relaunched && relaunched.pid) pids.push(relaunched.pid);
    const relPrompt = read(path.join(WDIR, 'W-STOPPED-R2.md')) || '';
    check('4. relaunch starts a new code with the same model, mode and cwd', rel.status === 303 && !!relaunched && relaunched.model === 'm1'
        && relaunched.permissionMode === 'default' && path.resolve(relaunched.cwd) === path.resolve(ROOT), decodeURIComponent(rel.headers.location || ''));
    check('4. a relaunch of a --dev record is started with --dev too', !!relaunched && relaunched.dev === true, relaunched ? String(relaunched.dev) : 'no record');
    check('4. the relaunch prompt is the same brief plus the answer', relPrompt.startsWith('# W-STOPPED brief') && relPrompt.includes('origin/main') && relPrompt.includes('rebase first'), relPrompt.slice(-300));

    // takeover: win32 only, and --no-launch records the command without opening a window
    const tRows = await rowsOf(port);
    const stoppedRow = tRows.find((r) => r.code === 'W-STOPPED');
    if (process.platform === 'win32') {
        const tk = await request(port, 'POST', '/action', { body: form({ token, action: 'takeover', key: stoppedRow.key }) });
        check('4. takeover with --no-launch records the console command and opens nothing', tk.status === 303
            && events().some((e) => e.action === 'takeover' && e.ok && /not launched/.test(e.detail) && e.detail.includes('-Code W-STOPPED')), decodeURIComponent(tk.headers.location || ''));
    } else {
        check('4. takeover is not offered off win32', !stoppedRow.actions.includes('takeover'));
    }

    // stop: a real headless worker whose fake claude sleeps, and a decoy whose identity does not match.
    const hwStart = runBudgeted(process.execPath, [HW_SCRIPT, 'start', '--code', 'W-LIVE', '--prompt-file', path.join(WDIR, 'W-SETTLE.md'),
        '--log', path.join(WDIR, 'W-LIVE.jsonl'), '--claude-bin', FAKE, '--ledger', LEDGER, '--cwd', ROOT, '--dev'],
    { encoding: 'utf8', cwd: ROOT, env: { ...process.env, HOME, USERPROFILE: HOME, FAKE_SLEEP_MS: '60000' }, timeout: 30000, maxTimeout: 120000 });
    let live = null;
    try { live = JSON.parse(String(hwStart.stdout).trim().split('\n').pop()).value; } catch { /* reported below */ }
    if (!live || !live.supervisorPid) { indeterminateCase('4. stop', `could not start a live worker: ${hwStart.stdout} ${hwStart.stderr}`); } else {
        pids.push(live.supervisorPid);
        // The decoy: a different process given W-LIVE's identity in a second record.
        const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
        pids.push(decoy.pid);
        const l = JSON.parse(read(LEDGER));
        l.records.push({ ...l.records.find((r) => r.code === 'W-LIVE'), code: 'W-DECOY', pid: decoy.pid });
        write(LEDGER, JSON.stringify(l, null, 2));
        await sleep(1500);
        const decoyKey = await keyOf('W-DECOY');
        const refused = await request(port, 'POST', '/action', { body: form({ token, action: 'stop', key: decoyKey }) });
        await sleep(500);
        check('4. stop refuses a pid whose identity does not match the record, and it keeps running',
            /identity-mismatch/.test(decodeURIComponent(refused.headers.location || '')) && alive(decoy.pid), decodeURIComponent(refused.headers.location || ''));
        const liveKey = await keyOf('W-LIVE');
        const stop = await request(port, 'POST', '/action', { body: form({ token, action: 'stop', key: liveKey }) });
        let gone = false;
        for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = !alive(live.supervisorPid); }
        check('4. stop kills the matching worker by pid', /stopped pid/.test(decodeURIComponent(stop.headers.location || '')) && gone, decodeURIComponent(stop.headers.location || ''));
    }
    check('4. the server wrote nothing to stderr', srv.err === '', srv.err);
    const exited = new Promise((resolve) => {
        if (srv.child.exitCode !== null) resolve({ code: srv.child.exitCode, signal: null });
        else srv.child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    srv.child.stdin.end();
    const end = await Promise.race([exited, sleep(15000).then(() => null)]);
    check('4. serve exits 0 when its stdin closes (a normal exit writes coverage, a kill does not)',
        !!end && end.code === 0 && end.signal === null, JSON.stringify(end));
    if (!end) srv.child.kill();
}

main().catch((e) => { fail++; failures.push(`crash: ${e.stack}`); console.log(`FAIL  the suite crashed: ${e.stack}`); }).finally(() => {
    for (const pid of pids) {
        if (!pid || !alive(pid)) continue;
        if (process.platform === 'win32') require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        else { try { process.kill(pid); } catch { /* gone */ } }
    }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* a handle may still be closing */ }
    console.log(`\n${tally(pass, fail, infra)}`);
    console.log(`subject: plugins/autodev-core/scripts/fleet-view.js, driven as a subprocess over ${pass + fail} assertion(s) against a fixture home with 7 sources.`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
    process.exitCode = exitCode(fail, infra);
});
