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
    const r = runBudgeted(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, HOME, USERPROFILE: HOME, APPDATA, LOCALAPPDATA, ...env }, timeout: 30000, maxTimeout: 120000 });
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
    'setTimeout(() => process.exit(0), ms);',
].join('\n') + '\n');

writeJson(path.join(HOME, '.claude.json'), { oauthAccount: { accountUuid: ACCT } });

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
const records = [worker('W-SETTLE'), worker('W-STOPPED', { result: 'stopped' })];
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
        const child = spawn(process.execPath, [SCRIPT, 'serve', '--port', '0', '--claude-bin', FAKE, ...extra], { cwd: ROOT, env: { ...process.env, HOME, USERPROFILE: HOME, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        pids.push(child.pid);
        let out = ''; let err = '';
        const timer = setTimeout(() => resolve({ child, port: null, out, err }), 20000);
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

    // ------------------------------------------------------------ 4. the server
    const srv = await startServer(['--takeover-script', path.join(ROOT, 'takeover.ps1'), '--no-launch']);
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
        '--log', path.join(WDIR, 'W-LIVE.jsonl'), '--claude-bin', FAKE, '--ledger', LEDGER, '--cwd', ROOT],
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
    srv.child.kill();
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
