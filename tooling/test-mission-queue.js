#!/usr/bin/env node
// Tests for the mission queue (plugins/autodev-core/scripts/mission-queue.js)
// and its hold on the Stop hook.
//
// The defect it closes: a Brain mission has no prd.json, so stop-auto-check let
// its turn end with work queued, and one failed command idled the fleet for six
// hours. Every case drives the real hook as a child process, in a private
// profile, so no case reads or writes the operator's state.
//
// The summary line is the contract scored by docs/scorecard-criteria.json:
//   pending=BLOCK peer=IGNORED delegated=APPROVE no_progress=RELEASED corrupt=APPROVE auto_exit=CLEARED stalled=DETECTED
//
// Run: node tooling/test-mission-queue.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sb = require('./spawn-budget.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'stop-auto-check.js');
const MQ = path.join(PLUGIN_ROOT, 'scripts', 'mission-queue.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mission-queue-test-')));
const CFG = path.join(TMP, 'cfg');
const env = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: CFG };
delete env.AUTODEV_MISSIONS_DIR;
// The library reads the same private profile as the hook children.
process.env.CLAUDE_CONFIG_DIR = CFG;
delete process.env.AUTODEV_MISSIONS_DIR;
const mq = require(MQ);

let passed = 0;
let failed = 0;
const fields = {};
function check(name, ok, detail) {
    if (ok) { passed++; console.log(`ok ${name}`); } else { failed++; console.log(`FAIL ${name}${detail ? ' | ' + detail : ''}`); }
    return ok;
}

let n = 0;
function project() {
    const dir = path.join(TMP, 'proj' + ++n);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    return dir;
}

function stop(dir, sid = 'sess-a') {
    const r = sb.runVerdict(process.execPath, [HOOK], {
        input: JSON.stringify({ session_id: sid, cwd: dir, hook_event_name: 'Stop' }),
        encoding: 'utf8', cwd: dir, env,
    });
    let d = null;
    try { d = JSON.parse(r.stdout); } catch { /* stays null */ }
    return d || { decision: null, raw: r.stdout, err: r.stderr };
}

function cli(dir, ...args) {
    return spawnSync(process.execPath, [MQ, ...args, '--cwd', dir], { encoding: 'utf8', env });
}

try {
    // No queue: the hook behaves exactly as before.
    {
        const dir = project();
        const d = stop(dir);
        check('no queue approves', d.decision === 'approve', JSON.stringify(d));
    }

    // Pending work holds the turn open, and the reason names the next item.
    {
        const dir = project();
        const a = cli(dir, 'start', '--mission', 'raise the score');
        const b = cli(dir, 'add', 'pr', 'open the wave PR');
        check('cli start and add exit 0', a.status === 0 && b.status === 0, a.stderr + b.stderr);
        const d = stop(dir);
        const ok = check('pending item blocks the stop', d.decision === 'block' && /next: pr \(open the wave PR\)/.test(d.reason || ''), JSON.stringify(d));
        check('block reason names the retry rule', /never a reason to stop/.test(d.reason || ''));
        check('first stopping session owns the queue', (mq.read(dir) || {}).owner === 'sess-a');
        fields.pending = ok ? 'BLOCK' : 'ALLOW';

        // A peer session in the same directory is not held by it.
        const p = stop(dir, 'sess-b');
        fields.peer = check('peer session is not held', p.decision === 'approve', JSON.stringify(p)) ? 'IGNORED' : 'HELD';

        // Delegated or person-blocked items do not hold the turn.
        cli(dir, 'set', 'pr', 'inflight', '--note', 'worker W1, wakes on completion');
        cli(dir, 'add', 'token', 'rotate the token');
        cli(dir, 'set', 'token', 'blocked', '--note', 'Andy: dashboard toggle');
        const s = cli(dir, 'status');
        check('status counts each state', /pending=0 inflight=1 blocked=1/.test(s.stdout), s.stdout);
        const d2 = stop(dir);
        fields.delegated = check('inflight and blocked items approve', d2.decision === 'approve', JSON.stringify(d2)) ? 'APPROVE' : 'BLOCK';
    }

    // No progress across the limit releases the turn, with a note; progress re-arms it.
    {
        const dir = project();
        cli(dir, 'start', '--mission', 'm');
        cli(dir, 'add', 'x', 'stuck item');
        const seen = [];
        for (let i = 0; i < mq.NO_PROGRESS_LIMIT + 1; i++) seen.push(stop(dir));
        const blocks = seen.slice(0, mq.NO_PROGRESS_LIMIT).every((d) => d.decision === 'block');
        const last = seen[seen.length - 1];
        const released = last.decision === 'approve' && /unchanged across/.test(last.systemMessage || '');
        check(`${mq.NO_PROGRESS_LIMIT} unchanged stops block`, blocks, seen.map((d) => d.decision).join(','));
        fields.no_progress = check('the next unchanged stop releases with a note', released, JSON.stringify(last)) ? 'RELEASED' : 'LOOPS';
        cli(dir, 'set', 'x', 'pending', '--note', 'retried');
        check('a queue write re-arms the hold', stop(dir).decision === 'block');
    }

    // A corrupt queue fails open.
    {
        const dir = project();
        fs.mkdirSync(path.dirname(mq.fileFor(dir)), { recursive: true });
        fs.writeFileSync(mq.fileFor(dir), '{not json');
        const d = stop(dir);
        fields.corrupt = check('corrupt queue approves', d.decision === 'approve', JSON.stringify(d)) ? 'APPROVE' : 'BLOCK';
    }

    // The operator's auto-exit signal ends the mission too.
    {
        const dir = project();
        cli(dir, 'start', '--mission', 'm');
        cli(dir, 'add', 'y');
        fs.writeFileSync(path.join(dir, '.claude', 'auto-exit'), '');
        const d = stop(dir);
        const ok = d.decision === 'approve' && !fs.existsSync(mq.fileFor(dir));
        fields.auto_exit = check('auto-exit approves and clears the queue', ok, JSON.stringify(d)) ? 'CLEARED' : 'KEPT';
    }

    // stalled: pending work whose owner stopped and went quiet.
    {
        const old = project();
        cli(old, 'start', '--mission', 'overnight');
        cli(old, 'add', 'z');
        const q = mq.read(old);
        const twoHoursAgo = new Date(Date.now() - 2 * 3600e3).toISOString();
        Object.assign(q, { owner: 'sess-a', updatedAt: twoHoursAgo, lastStopAt: twoHoursAgo, lastDecision: 'approve' });
        fs.writeFileSync(mq.fileFor(old), JSON.stringify(q));

        const fresh = project();
        cli(fresh, 'start', '--mission', 'busy');
        cli(fresh, 'add', 'w');

        const quiet = project();
        cli(quiet, 'start', '--mission', 'waiting');
        cli(quiet, 'add', 'v');
        cli(quiet, 'set', 'v', 'inflight');
        const q3 = mq.read(quiet);
        q3.updatedAt = twoHoursAgo;
        fs.writeFileSync(mq.fileFor(quiet), JSON.stringify(q3));

        const list = mq.stalled(60);
        const cwds = list.map((s) => s.cwd);
        const hit = list.find((s) => s.cwd === path.resolve(old));
        check('a stopped mission with pending work is stalled', !!hit && hit.reason === 'turn ended with pending work', JSON.stringify(list));
        check('a fresh mission is not stalled', !cwds.includes(path.resolve(fresh)));
        check('an old mission with only inflight work is not stalled', !cwds.includes(path.resolve(quiet)));
        const c = cli(old, 'stalled', '--minutes', '60');
        check('stalled verb prints the count', c.status === 0 && /^1 stalled mission/.test(c.stdout), c.stdout + c.stderr);
        fields.stalled = hit && !cwds.includes(path.resolve(fresh)) && !cwds.includes(path.resolve(quiet)) ? 'DETECTED' : 'MISSED';
    }

    // The CLI refuses an unknown state and an unknown verb.
    {
        const dir = project();
        cli(dir, 'start');
        const bad = cli(dir, 'set', 'a', 'finished');
        const unk = cli(dir, 'frobnicate');
        check('unknown state and verb exit 1', bad.status === 1 && unk.status === 1, `${bad.status} ${unk.status}`);
    }
} catch (e) {
    check('suite ran to the end', false, e && e.stack);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }

const order = ['pending', 'peer', 'delegated', 'no_progress', 'corrupt', 'auto_exit', 'stalled'];
console.log(order.map((k) => `${k}=${fields[k] || 'UNKNOWN'}`).join(' '));
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
