#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/mission-dispatch.js: a request becomes a
// real child with a pid, cwd and base read back and matched against the contract,
// or an explicit non-start; a crash between request and response never yields a
// second worker. Every worker is the protocol fixture in
// tooling/fixtures/mission-runtime/protocol-worker.cjs, forked in a disposable
// repository under the temp dir. Run: node tooling/test-mission-dispatch.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ENTRY = path.resolve(__dirname, '../plugins/autodev-core/scripts/mission-dispatch.js');
const STORE_CLI = path.resolve(__dirname, '../plugins/autodev-core/scripts/mission-store.js');
const WORKER = path.resolve(__dirname, 'fixtures/mission-runtime/protocol-worker.cjs');

// HOST BOUNDARY: the store needs node:sqlite and POSIX ownership checks; without them
// this suite proves the explicit refusal and says what it did not run.
{
    const posix = typeof process.getuid === 'function';
    let sqlite = false; try { sqlite = typeof require('node:sqlite').DatabaseSync === 'function'; } catch { /* absent */ }
    if (!(posix && sqlite)) {
        const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mission-dispatch-host-'));
        const r = spawnSync(process.execPath, [STORE_CLI, 'init', '--store', path.join(dir, 'store')], { input: '{}', encoding: 'utf8', timeout: 10000 });
        let out = null; try { out = JSON.parse(r.stdout); } catch { /* not json */ }
        fs.rmSync(dir, { recursive: true, force: true });
        const why = !posix ? 'POSIX ownership checks (win32)' : 'node:sqlite';
        if (!(r.status === 1 && out && out.error && out.error.code === 'runtime-unavailable')) { console.error(`mission-dispatch: host lacks ${why} and the store did NOT refuse explicitly`); process.exitCode = 1; return; }
        console.log(`mission-dispatch: 1/1 passed — host lacks ${why}; the store refuses with runtime-unavailable. 13 POSIX+SQLite cases not run on this host.`);
        return;
    }
}

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'mission-dispatch-'));
const children = new Set();
let passed = 0; const failures = [];
function check(name, cond, detail) { if (cond) { passed++; return; } failures.push(name + (detail === undefined ? '' : '\n      -> ' + String(detail).slice(0, 400))); }
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args, env = {}) {
    const r = spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* usage text */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, value: json && json.value };
}
function storeCli(command, store, payload) {
    const r = spawnSync(process.execPath, [STORE_CLI, command, '--store', store], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* not json */ }
    return { status: r.status, json, value: json && json.value };
}
let n = 0;
function fixture(name) {
    const repo = path.join(ROOT, name); fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(ROOT, 'no-hooks'), '-c', 'commit.gpgSign=false', '-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n'); git('add', 'README.md');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
    const store = path.join(ROOT, name + '-store');
    const init = storeCli('init', store, {}); if (!init.json || !init.json.ok) throw new Error('store init failed: ' + JSON.stringify(init));
    const real = fs.realpathSync.native(repo);
    const contract = { repo: { id: name, root: real, commonDir: fs.realpathSync.native(path.join(repo, '.git')), baseSha: git('rev-parse', 'HEAD') }, scope: { paths: ['owned.js'], effects: ['read', 'write'] }, target: { kind: 'local', identifier: name }, acceptance: [{ id: 'behaviour', description: 'The owned module exports a function returning ok.' }], retry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 5 } };
    const admit = storeCli('admit', store, { missionId: name, eventId: 'admit-' + (++n), contract }); if (!admit.json || !admit.json.ok) throw new Error('admit failed: ' + JSON.stringify(admit));
    return { name, repo: real, store, contract, status: () => storeCli('status', store, { missionId: name }).value };
}
const startArgs = (f, extra = []) => ['start', '--store', f.store, '--mission', f.name, '--owner', 'brain', '--adapter', 'local-node', '--worker', WORKER, ...extra];
// The dispatcher forks with a minimal environment, so a fixture's mode travels in a
// file beside its store, which the protocol worker reads after the assignment.
const mode = (f, m) => { fs.writeFileSync(f.store + '.mode', m); return f; };

(async () => {
    try {
        // ---- usage ----
        check('--help exits 0 with usage', cli(['--help']).status === 0 && /^Usage: node mission-dispatch\.js/.test(cli(['--help']).stdout));
        check('no arguments prints usage and returns', cli([]).status === 0 && /Usage/.test(cli([]).stdout));
        const bad = cli(['launch']); check('an unknown command is a usage refusal', bad.status === 1 && bad.json && bad.json.error.code === 'usage', bad.stdout);
        const missing = cli(['start', '--store', ROOT]); check('start without its flags names the missing one', missing.status === 1 && missing.json && missing.json.error.code === 'usage' && /--mission/.test(missing.json.error.message), missing.stdout);

        // ---- the normal path: a real child, read back and matched ----
        {
            const f = fixture('normal');
            const r = cli(startArgs(f, ['--wait-ms', '30000']));
            const v = r.value || {};
            check('normal: exit 0 and state terminal', r.status === 0 && v.state === 'terminal', r.stdout + r.stderr);
            check('normal: the readback names the forked pid, the contract root and the base', v.readback && v.readback.pid === (v.identity || {}).pid && v.readback.cwd === f.repo && v.readback.head === f.contract.repo.baseSha, JSON.stringify(v.readback));
            check('normal: the worker exited 0 with completed hook and native status', v.exitCode === 0 && v.observation && v.observation.hookStatus === 'completed' && v.observation.nativeStatus === 'completed', JSON.stringify(v.observation));
            check('normal: execution observed, never verified', v.executionObserved === true && v.verified === false);
            check('normal: the owned artifact exists in the contract root', fs.existsSync(path.join(f.repo, 'owned.js')));
            const s = f.status();
            check('normal: store shows one registered bootstrap, a terminal launch, a pending result', s.bootstraps.length === 1 && s.bootstraps[0].state === 'registered' && s.launches.length === 1 && s.launches[0].state === 'terminal' && s.outbox.length === 1 && s.outbox[0].state === 'pending', JSON.stringify({ b: s.bootstraps, l: s.launches.map((l) => l.state), o: s.outbox.map((o) => o.state) }));
            check('normal: the store identity is the child we forked', JSON.parse(s.launches[0].identity_json).pid === v.identity.pid && JSON.parse(s.launches[0].identity_json).nonce === v.identity.nonce);
            const req = path.join(f.store, `dispatch-${v.attemptId}.json`), close = v.receipt;
            check('normal: request and close receipts exist, private, and the close receipt names the same identity', fs.existsSync(req) && fs.existsSync(close) && (fs.statSync(close).mode & 0o077) === 0 && JSON.stringify(JSON.parse(fs.readFileSync(close, 'utf8')).identity) === JSON.stringify(v.identity), close);
            const rec = cli(['reconcile', '--store', f.store, '--mission', f.name, '--owner', 'brain', '--attempt', v.attemptId, '--generation', String(s.mission.generation)]);
            check('normal: reconcile reports terminal from the store', rec.status === 0 && rec.value && rec.value.state === 'terminal', rec.stdout);
            const again = cli(startArgs(f));
            check('normal: a second start beside the existing launch spawns nothing', again.status === 0 && again.value && again.value.state === 'terminal' && f.status().launches.length === 1 && f.status().bootstraps.length === 1, again.stdout);
            const stale = cli(['reconcile', '--store', f.store, '--mission', f.name, '--owner', 'someone-else', '--attempt', v.attemptId, '--generation', String(s.mission.generation)]);
            check('normal: reconcile with the wrong owner is stale-owner, not a verdict', stale.value && stale.value.state === 'stale-owner', stale.stdout);
        }

        // ---- explicit non-starts: nothing recorded, no permit spent ----
        {
            const f = fixture('nonstart');
            const a = cli(['start', '--store', f.store, '--mission', f.name, '--owner', 'brain', '--adapter', 'codex-exec', '--worker', WORKER]);
            check('unsupported adapter: exit 2, awaiting-start, names the supported set', a.status === 2 && a.value && a.value.state === 'awaiting-start' && a.value.reason === 'adapter-unsupported' && Array.isArray(a.value.supported), a.stdout);
            const w = cli(['start', '--store', f.store, '--mission', f.name, '--owner', 'brain', '--adapter', 'local-node', '--worker', path.join(ROOT, 'absent.js')]);
            check('missing worker: exit 2, awaiting-start, worker-missing', w.status === 2 && w.value && w.value.reason === 'worker-missing', w.stdout);
            const s = f.status();
            check('non-starts leave the mission ready with no claim, launch or bootstrap', s.mission.state === 'ready' && s.attempts.length === 0 && s.launches.length === 0 && s.bootstraps.length === 0, JSON.stringify(s.mission));
        }

        // ---- readback that disagrees with the contract is refused ----
        {
            const f = fixture('chdir');
            mode(f, 'chdir'); const r = cli(startArgs(f, ['--register-ms', '15000']));
            const v = r.value || {};
            check('wrong cwd: refused-readback names the cwd problem', r.status === 0 && v.state === 'refused-readback' && Array.isArray(v.problems) && v.problems.some((p) => /cwd/.test(p)), r.stdout);
            const s = f.status();
            check('wrong cwd: the attempt failed as admission and the mission waits to retry', s.mission.state === 'retry-wait' && s.attempts[0].failure_code === 'admission', JSON.stringify(s.mission));
            check('wrong cwd: the worker was ended and its launch observed terminal', s.launches[0].state === 'terminal', JSON.stringify(s.launches));
            check('wrong cwd: no artifact was written', !fs.existsSync(path.join(f.repo, 'owned.js')));
        }

        // ---- a worker that refuses before registering ----
        {
            const f = fixture('refuse');
            mode(f, 'refuse'); const r = cli(startArgs(f));
            const v = r.value || {};
            check('refusing worker: never-started with the refusal code', v.state === 'never-started' && v.refused === 'fixture-refuses' && v.exitCode === 1, r.stdout);
            const s = f.status();
            check('refusing worker: launch never-started, permit spent, mission retry-wait', s.launches[0].state === 'never-started' && s.bootstraps.length === 1 && s.mission.state === 'retry-wait', JSON.stringify({ l: s.launches.map((l) => l.state), b: s.bootstraps.length, m: s.mission.state }));
        }

        // ---- a completion the hooks blocked is recorded as blocked, not success ----
        {
            const f = fixture('blocked');
            mode(f, 'blocked'); const r = cli(startArgs(f));
            const v = r.value || {};
            check('blocked hook: terminal with hookStatus blocked and exit 0, no artifact', v.state === 'terminal' && v.observation && v.observation.hookStatus === 'blocked' && v.exitCode === 0 && !fs.existsSync(path.join(f.repo, 'owned.js')), r.stdout);
        }

        // ---- a worker that dies after writing: observed, nothing invented ----
        {
            const f = fixture('die');
            mode(f, 'die-after-write'); const r = cli(startArgs(f));
            const v = r.value || {};
            check('die after write: terminal, hook status unknown, artifact present, no result enqueued', v.state === 'terminal' && v.observation && v.observation.hookStatus === 'unknown' && fs.existsSync(path.join(f.repo, 'owned.js')) && f.status().outbox.length === 0, r.stdout);
        }

        // ---- crash between request and response: no second worker, ever ----
        {
            const f = fixture('crash');
            mode(f, 'hold');
            const dispatcher = spawn(process.execPath, [ENTRY, ...startArgs(f, ['--wait-ms', '60000'])], { stdio: ['ignore', 'pipe', 'pipe'] });
            children.add(dispatcher); dispatcher.stdout.resume(); dispatcher.stderr.resume();
            let s = null; for (let i = 0; i < 600; i++) { s = f.status(); if (s.launches.length && s.launches[0].state === 'registered') break; await pause(50); }
            check('crash: the worker registered while the dispatcher was alive', s && s.launches.length === 1 && s.launches[0].state === 'registered', JSON.stringify(s && s.launches));
            const identity = JSON.parse(s.launches[0].identity_json);
            dispatcher.kill('SIGKILL'); await new Promise((r) => dispatcher.once('close', r)); children.delete(dispatcher);
            const fence = ['--store', f.store, '--mission', f.name, '--owner', 'brain', '--attempt', s.mission.activeAttempt, '--generation', String(s.mission.generation)];
            const first = cli(['reconcile', ...fence]);
            check('crash: reconcile holds the claim and reports live or unknown, never a verdict', first.status === 0 && first.value && ['live', 'unknown'].includes(first.value.state) && first.value.reservationHeld === true, first.stdout);
            const second = cli(startArgs(f));
            check('crash: a second start beside the registered launch spawns nothing', second.status === 0 && second.value && second.value.state !== 'terminal' && f.status().launches.length === 1 && f.status().bootstraps.length === 1, second.stdout);
            const fail = storeCli('fail', f.store, { missionId: f.name, eventId: 'fail-crash', owner: 'brain', attemptId: s.mission.activeAttempt, generation: s.mission.generation, code: 'transient' });
            check('crash: the store refuses to release the attempt while the disposition is unknown', fail.status === 1 && fail.json && fail.json.error.code === 'worker-disposition-unknown', JSON.stringify(fail.json));
            try { process.kill(identity.pid, 'SIGKILL'); } catch { /* already gone */ }
            await pause(200);
            const after = cli(['reconcile', ...fence]);
            check('crash: with the pid gone and no receipt, reconcile stays unknown or exhausts its polls, still holding the claim', after.value && ['unknown', 'backoff-active', 'reconciliation-exhausted'].includes(after.value.state) && after.value.reservationHeld === true, after.stdout);
        }

        // ---- a worker still running past the wait is reported running, not killed ----
        {
            const f = fixture('running');
            mode(f, 'hold'); const r = cli(startArgs(f, ['--wait-ms', '1500']));
            const v = r.value || {};
            check('running past --wait-ms: state running with identity and readback, and no kill signal', v.state === 'running' && v.identity && v.readback && v.readback.cwd === f.repo && v.signal === undefined, r.stdout);
            check('running: the store still holds a registered launch, not a terminal one', f.status().launches[0].state === 'registered', JSON.stringify(f.status().launches.map((l) => l.state)));
            try { process.kill(v.identity.pid, 'SIGKILL'); } catch { /* gone */ }
        }
    } finally {
        for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }
    }
    const total = passed + failures.length;
    if (failures.length) { console.error(`mission-dispatch: ${passed}/${total} passed, ${failures.length} FAILED\n`); for (const f of failures) console.error('  x ' + f); process.exitCode = 1; }
    else console.log(`mission-dispatch: ${passed}/${total} passed — a forked worker read back and matched, explicit non-starts, refused readback, blocked hooks, a crash that never spawns twice, and a worker left running`);
})();
