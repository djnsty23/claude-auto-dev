#!/usr/bin/env node
'use strict';
// A synthetic account switch, never a login or a paid model call. Queue ownership
// stays explicit through --ledger while the launching profile changes from A to B.
// A queued dependency must survive byte-for-byte, and the first task must execute
// through the real headless launcher under B and close through worker-reconcile.
// This proves the explicit shared-queue procedure, not automatic profile migration.
// Schedule as {id:"account-switch",script:"account-switch-drill.js",everyMin:1440}.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { configDir } = require('./claude-paths.js');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function drill() {
    const started = Date.now();
    const row = { at: new Date().toISOString(), kind: 'account-switch', mode: 'synthetic-shared-queue', ok: false,
        queued: 0, kept: 0, launched: 0, reconciled: 0, configSwitched: false, durationMs: 0 };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-switch-drill-'));
    let pid = null;
    try {
        const a = path.join(root, 'profile-a');
        const b = path.join(root, 'profile-b');
        const repo = path.join(root, 'repo');
        for (const p of [a, b, repo]) fs.mkdirSync(p);
        const baseEnv = {};
        for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'Path']) if (process.env[key]) baseEnv[key] = process.env[key];
        Object.assign(baseEnv, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: root,
            TMP: root, TEMP: root, TMPDIR: root, AUTODEV_CAPACITY: 'off', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
            GIT_AUTHOR_NAME: 'fixture', GIT_COMMITTER_NAME: 'fixture', GIT_AUTHOR_EMAIL: ['fixture', 'invalid'].join('@'), GIT_COMMITTER_EMAIL: ['fixture', 'invalid'].join('@') });
        const invoke = (exe, args, profile = a) => {
            const r = spawnSync(exe, args, { cwd: repo, env: { ...baseEnv, CLAUDE_CONFIG_DIR: profile }, encoding: 'utf8', timeout: 20000, windowsHide: true });
            if (r.error || r.status !== 0) throw new Error(`${path.basename(args[0] || exe)}: ${r.error?.code || r.status}: ${(r.stderr || r.stdout || '').slice(-500)}`);
            return r.stdout;
        };
        const cli = (name, args, profile = a) => {
            const text = invoke(process.execPath, [path.join(__dirname, name), ...args], profile);
            const doc = JSON.parse(text);
            if (!doc.ok) throw new Error(`${name} refused`);
            return doc.value;
        };
        fs.writeFileSync(path.join(root, 'commit.txt'), 'chore: initialize drill fixture\n');
        invoke('git', ['init', '-q', '-b', 'main']);
        invoke('git', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-F', path.join(root, 'commit.txt')]);
        invoke('git', ['remote', 'add', 'origin', repo]);
        invoke('git', ['fetch', '--quiet', 'origin']);
        const brief = path.join(root, 'brief.md');
        fs.writeFileSync(brief, 'Synthetic queue survival drill. No model executes this brief.\n');
        const ledger = path.join(a, 'autodev', 'unattended-workers.json');
        const first = cli('unattended-worker.js', ['enqueue', '--repo', repo, '--slug', 'switch-first', '--task-id', 'switch-first',
            '--brief-file', brief, '--return', 'fixture', '--config-dir', b, '--ledger', ledger]).record;
        const second = cli('unattended-worker.js', ['enqueue', '--repo', repo, '--slug', 'switch-next', '--task-id', 'switch-next',
            '--brief-file', brief, '--return', 'fixture', '--after', 'switch-first', '--config-dir', b, '--ledger', ledger]).record;
        row.queued = 2;
        const readQueue = () => JSON.parse(fs.readFileSync(ledger, 'utf8')).records;
        const before = readQueue();
        const ready = cli('unattended-worker.js', ['ready', '--ledger', ledger], b);
        if (!ready.ready.includes('switch-first') || ready.ready.includes('switch-next')) throw new Error('switched profile lost readiness or dependency');
        if (JSON.stringify(readQueue()) !== JSON.stringify(before)) throw new Error('switch changed queued records');
        const observed = path.join(root, 'observed.json');
        const fake = path.join(root, 'fake-claude.js');
        fs.writeFileSync(fake, [
            "const fs=require('fs');",
            `fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({config:process.env.CLAUDE_CONFIG_DIR, args:process.argv.slice(2)}));`,
            `fs.writeFileSync(${JSON.stringify(first.report)}, 'RESULT switch-first done: fixture completed\\n');`,
            "console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'fixture',usage:{input_tokens:0,output_tokens:0}}));",
        ].join('\n'));
        const launch = cli('unattended-worker.js', ['launch', '--task-id', 'switch-first', '--ledger', ledger, '--claude-bin', fake, '--dev'], b);
        pid = launch.record.headless.pid;
        const deadline = Date.now() + 20000;
        let text = '';
        while (Date.now() < deadline) {
            try { text = fs.readFileSync(launch.record.headless.log, 'utf8'); } catch { /* supervisor not started yet */ }
            if (/^CLAUDE_EXIT=0\s*$/m.test(text)) break;
            sleep(50);
        }
        if (!/^CLAUDE_EXIT=0\s*$/m.test(text)) throw new Error('fake worker did not finish');
        pid = null; // supervisor has finished; never kill a PID that could be reused
        const seen = JSON.parse(fs.readFileSync(observed, 'utf8'));
        row.configSwitched = seen.config === b && seen.args.includes('stream-json');
        if (!row.configSwitched) throw new Error('worker ran with the wrong config dir');
        row.launched = 1;
        cli('worker-reconcile.js', ['tick', '--live', '--wait', '--ledger', ledger,
            '--headless-ledger', path.join(b, 'autodev', 'headless-workers.json'), '--state-dir', path.join(b, 'reconcile'), '--judge-state-dir', path.join(b, 'judge')], b);
        const after = readQueue();
        const done = after.find((r) => r.taskId === first.taskId);
        const pending = after.find((r) => r.taskId === second.taskId);
        if (!done || done.state !== 'closed' || done.runStatus !== 'succeeded') throw new Error('reconciler did not close the switched run');
        row.reconciled = 1;
        const stable = ['taskId', 'briefSha256', 'briefFile', 'after', 'queuedAt', 'launch'];
        row.kept = before.filter((r) => {
            const match = after.find((x) => x.taskId === r.taskId);
            return match && stable.every((key) => JSON.stringify(match[key]) === JSON.stringify(r[key])) && fs.readFileSync(match.briefFile, 'utf8') === fs.readFileSync(brief, 'utf8');
        }).length;
        if (row.kept !== row.queued || JSON.stringify(pending) !== JSON.stringify(second)) throw new Error('queued work or dependency changed');
        row.ok = true;
    } catch (e) { row.why = String(e.message).replaceAll(root, '<scratch>'); }
    finally {
        if (pid) {
            // Only the supervisor created by this drill, never a process-name kill.
            if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
            else { try { process.kill(pid, 'SIGTERM'); } catch { /* already ended */ } }
        }
        try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { row.ok = false; row.why = 'scratch cleanup failed'; }
        row.durationMs = Date.now() - started;
    }
    return row;
}
function main(argv) {
    if (argv.includes('--help')) { console.log('Usage: node account-switch-drill.js [--json]'); return 0; }
    const row = drill();
    const home = process.env.BRAIN_CLOCK_CLAUDE_DIR || configDir();
    const file = path.join(home, 'autodev', 'windows', 'account-switch-drills.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    if (argv.includes('--json')) console.log(JSON.stringify(row));
    return row.ok ? 0 : 1;
}
if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (e) { console.error(`account-switch-drill: ${e.code || e.message}`); process.exitCode = 2; }
}
module.exports = { drill, main };
