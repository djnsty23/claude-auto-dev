#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/mission-supervisor.js: one bounded tick
// per process, against a prd.json with a ready story, a dependent story, a story
// whose worker always refuses, a needs-setup story, a done one and a deferred one.
// Across four ticks: the ready story is admitted, dispatched, delivered and its
// envelope accepted (reported as awaiting verification, never done); the refusing
// story retries with the store's backoff until its attempt budget is exhausted,
// then is reported exhausted and never reselected; the dependent, needs-setup,
// done and deferred stories are never dispatched; prd.json is never written.
// Run: node tooling/test-mission-supervisor.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ENTRY = path.resolve(__dirname, '../plugins/autodev-core/scripts/mission-supervisor.js');
const STORE_CLI = path.resolve(__dirname, '../plugins/autodev-core/scripts/mission-store.js');
const WORKER = path.resolve(__dirname, 'fixtures/mission-runtime/protocol-worker.cjs');

{ // HOST BOUNDARY, as in the other mission suites
    const posix = typeof process.getuid === 'function';
    let sqlite = false; try { sqlite = typeof require('node:sqlite').DatabaseSync === 'function'; } catch { /* absent */ }
    if (!(posix && sqlite)) {
        const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mission-supervisor-host-'));
        const r = spawnSync(process.execPath, [STORE_CLI, 'init', '--store', path.join(dir, 'store')], { input: '{}', encoding: 'utf8', timeout: 10000 });
        let out = null; try { out = JSON.parse(r.stdout); } catch { /* not json */ }
        fs.rmSync(dir, { recursive: true, force: true });
        const why = !posix ? 'POSIX ownership checks (win32)' : 'node:sqlite';
        if (!(r.status === 1 && out && out.error && out.error.code === 'runtime-unavailable')) { console.error(`mission-supervisor: host lacks ${why} and the store did NOT refuse explicitly`); process.exitCode = 1; return; }
        console.log(`mission-supervisor: 1/1 passed — host lacks ${why}; the store refuses with runtime-unavailable. 4 ticks not run on this host.`);
        return;
    }
}

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'mission-supervisor-'));
let passed = 0; const failures = [];
function check(name, cond, detail) { if (cond) { passed++; return; } failures.push(name + (detail === undefined ? '' : '\n      -> ' + String(detail).slice(0, 500))); }
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const repo = path.join(ROOT, 'repo'); fs.mkdirSync(repo);
const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(ROOT, 'no-hooks'), '-c', 'commit.gpgSign=false', '-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-q'); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n'); git('add', 'README.md');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
const store = path.join(ROOT, 'store'); spawnSync(process.execPath, [STORE_CLI, 'init', '--store', store], { input: '{}', encoding: 'utf8' });
const prd = path.join(ROOT, 'prd.json');
fs.writeFileSync(prd, JSON.stringify({ stories: {
    S1: { id: 'S1', title: 'Ready', passes: null, notes: 'The owned module exports a function returning ok.', paths: ['owned.js'] },
    S2: { id: 'S2', title: 'Depends on S1', passes: null, blockedBy: ['S1'], notes: 'Uses the owned module after it exists.', paths: ['second.js'] },
    S3: { id: 'S3', title: 'Always refused', passes: null, notes: 'A worker that refuses every time.', paths: ['third.js'] },
    S4: { id: 'S4', title: 'Blocked on a key', passes: 'needs-setup', blockedReason: 'vendor API key', notes: 'Needs the key.', paths: ['fourth.js'] },
    S5: { id: 'S5', title: 'Done', passes: true, notes: 'Verified earlier.' },
    S6: { id: 'S6', title: 'Deferred', passes: 'deferred', notes: 'A decision not to do it.' },
} }, null, 2));
// Per-mission worker modes: S3's worker refuses; the rest run normally.
fs.writeFileSync(store + '.mode.S3', 'refuse');
const prdBefore = sha(prd);

function tick(extra = []) {
    const r = spawnSync(process.execPath, [ENTRY, 'tick', '--prd', prd, '--root', repo, '--store', store, '--owner', 'brain', '--adapter', 'local-node', '--worker', WORKER, '--worktrees', path.join(ROOT, 'wt'), '--max-dispatch', '2', '--wait-ms', '30000', '--max-attempts', '3', '--backoff-ms', '1', '--max-backoff-ms', '5', ...extra], { encoding: 'utf8', timeout: 120000 });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* not json */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, value: json && json.value };
}
const row = (v, id) => (v.missions || []).find((m) => m.id === id) || {};
const status = (id) => { const r = spawnSync(process.execPath, [STORE_CLI, 'status', '--store', store], { input: JSON.stringify({ missionId: id }), encoding: 'utf8' }); try { return JSON.parse(r.stdout).value; } catch { return null; } };

check('--help exits 0 with usage', spawnSync(process.execPath, [ENTRY, '--help'], { encoding: 'utf8' }).stdout.startsWith('Usage: node mission-supervisor.js'));
const bad = spawnSync(process.execPath, [ENTRY, 'run'], { encoding: 'utf8' }); check('an unknown command is a usage refusal', bad.status === 1 && /"usage"/.test(bad.stdout), bad.stdout);

// ---- tick 1 ----
const t1 = tick();
check('tick 1: exit 0 and a report', t1.status === 0 && t1.value && Array.isArray(t1.value.missions), t1.stdout + t1.stderr);
check('tick 1: S1 admitted, dispatched, delivered and its envelope accepted, reported as awaiting verification', row(t1.value, 'S1').admitted === true && row(t1.value, 'S1').dispatch === 'terminal' && row(t1.value, 'S1').action === 'envelope-accepted' && row(t1.value, 'S1').after === 'envelope-accepted', JSON.stringify(row(t1.value, 'S1')));
check('tick 1: S1 wrote its artifact in its own worktree, not the repository root', fs.existsSync(path.join(ROOT, 'wt', 'S1', 'owned.js')) && !fs.existsSync(path.join(repo, 'owned.js')));
check('tick 1: S3 dispatched, its worker refused, the attempt failed and the mission waits to retry', row(t1.value, 'S3').dispatch === 'never-started' && row(t1.value, 'S3').after === 'retry-wait' && row(t1.value, 'S3').attempts === 1, JSON.stringify(row(t1.value, 'S3')));
check('tick 1: S2 is blocked by S1 and never dispatched; S4 is blocked on setup', t1.value.blocked.some((b) => b.id === 'S2' && /blocked by S1/.test(b.reason)) && t1.value.blocked.some((b) => b.id === 'S4' && /needs-setup/.test(b.reason)) && !row(t1.value, 'S2').dispatch && !row(t1.value, 'S4').dispatch, JSON.stringify(t1.value.blocked));
check('tick 1: done and deferred stories are not candidates', !t1.value.missions.some((m) => m.id === 'S5' || m.id === 'S6'));
check('tick 1: the tick never reports the prd complete or anything verified', t1.value.prdComplete === false && t1.value.verified === false);

// ---- tick 2: a fresh process sees what tick 1 left ----
const t2 = tick();
check('tick 2: S1 is awaiting verification, not re-dispatched', row(t2.value, 'S1').action === 'awaiting-verification' && status('S1').mission.attemptCount === 1, JSON.stringify(row(t2.value, 'S1')));
check('tick 2: S3 retried after its backoff, attempt 2, waits again', row(t2.value, 'S3').dispatch === 'never-started' && row(t2.value, 'S3').attempts === 2 && row(t2.value, 'S3').after === 'retry-wait', JSON.stringify(row(t2.value, 'S3')));

// ---- tick 3: the budget runs out ----
const t3 = tick();
check('tick 3: S3 attempt 3 exhausts the budget and the mission is terminal', row(t3.value, 'S3').attempts === 3 && row(t3.value, 'S3').after === 'exhausted', JSON.stringify(row(t3.value, 'S3')));

// ---- tick 4: exhaustion is reported, never reselected ----
const t4 = tick();
check('tick 4: S3 is reported exhausted with its reason and not dispatched again', row(t4.value, 'S3').action === 'exhausted' && /attempt-budget-exhausted/.test(row(t4.value, 'S3').reason) && status('S3').mission.attemptCount === 3 && status('S3').launches.length === 3, JSON.stringify(row(t4.value, 'S3')));
check('tick 4: S1 still awaiting verification with one attempt; S2 still blocked', row(t4.value, 'S1').action === 'awaiting-verification' && status('S1').mission.attemptCount === 1 && t4.value.blocked.some((b) => b.id === 'S2'), JSON.stringify(row(t4.value, 'S1')));
check('tick 4: the tick counted its actions apart', t4.value.totals['awaiting-verification'] === 1 && t4.value.totals.exhausted === 1, JSON.stringify(t4.value.totals));
check('prd.json is byte-identical after four ticks: the supervisor never writes it', sha(prd) === prdBefore);

// ---- max-dispatch is a real bound ----
{
    fs.writeFileSync(prd, JSON.stringify({ stories: { A: { id: 'A', passes: null, notes: 'Story A owns its module.', paths: ['a.js'] }, B: { id: 'B', passes: null, notes: 'Story B owns its module.', paths: ['b.js'] } } }, null, 2));
    const store2 = path.join(ROOT, 'store2'); spawnSync(process.execPath, [STORE_CLI, 'init', '--store', store2], { input: '{}', encoding: 'utf8' });
    const one = spawnSync(process.execPath, [ENTRY, 'tick', '--prd', prd, '--root', repo, '--store', store2, '--owner', 'brain', '--adapter', 'local-node', '--worker', WORKER, '--worktrees', path.join(ROOT, 'wt2'), '--max-dispatch', '1', '--wait-ms', '30000', '--backoff-ms', '1', '--max-backoff-ms', '5'], { encoding: 'utf8', timeout: 120000 });
    let v = null; try { v = JSON.parse(one.stdout).value; } catch { /* not json */ }
    check('--max-dispatch 1: exactly one start this tick, the other deferred by name', v && v.tick.dispatched === 1 && v.missions.filter((m) => m.dispatch).length === 1 && v.missions.some((m) => m.action === 'deferred-this-tick'), one.stdout);
    // Without --worktrees, two missions on one root: the second queues behind the first's reservation, by name.
    const store3 = path.join(ROOT, 'store3'); spawnSync(process.execPath, [STORE_CLI, 'init', '--store', store3], { input: '{}', encoding: 'utf8' });
    const shared = spawnSync(process.execPath, [ENTRY, 'tick', '--prd', prd, '--root', repo, '--store', store3, '--owner', 'brain', '--adapter', 'local-node', '--worker', WORKER, '--max-dispatch', '2', '--wait-ms', '30000', '--backoff-ms', '1', '--max-backoff-ms', '5'], { encoding: 'utf8', timeout: 120000 });
    let w = null; try { w = JSON.parse(shared.stdout).value; } catch { /* not json */ }
    check('one root, no --worktrees: the second mission is reported worktree-held, not errored, and not started', w && w.missions.some((m) => m.action === 'envelope-accepted') && w.missions.some((m) => m.action === 'worktree-held' && !m.dispatch), shared.stdout);
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }
const total = passed + failures.length;
if (failures.length) { console.error(`mission-supervisor: ${passed}/${total} passed, ${failures.length} FAILED\n`); for (const f of failures) console.error('  x ' + f); process.exitCode = 1; }
else console.log(`mission-supervisor: ${passed}/${total} passed — one bounded tick per process: admit, dispatch, deliver, accept as unverified, retry with backoff, exhaust and report, never touch prd.json`);
