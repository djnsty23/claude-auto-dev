#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/mission-deliver.js: a worker's durable
// result is consumed exactly once, a lost acknowledgement is recovered from the
// saved receipt without a second send, an exhausted send budget is reported and
// not retried, a retired attempt's result is quarantined rather than dropped,
// and sent, received, quarantined, rejected and accepted stay separate counts.
// Results come from real workers started by mission-dispatch.js in disposable
// repositories. Run: node tooling/test-mission-deliver.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ENTRY = path.resolve(__dirname, '../plugins/autodev-core/scripts/mission-deliver.js');
const DISPATCH = path.resolve(__dirname, '../plugins/autodev-core/scripts/mission-dispatch.js');
const STORE_CLI = path.resolve(__dirname, '../plugins/autodev-core/scripts/mission-store.js');
const WORKER = path.resolve(__dirname, 'fixtures/mission-runtime/protocol-worker.cjs');

{ // HOST BOUNDARY, as in the other mission suites
    const posix = typeof process.getuid === 'function';
    let sqlite = false; try { sqlite = typeof require('node:sqlite').DatabaseSync === 'function'; } catch { /* absent */ }
    if (!(posix && sqlite)) {
        const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mission-deliver-host-'));
        const r = spawnSync(process.execPath, [STORE_CLI, 'init', '--store', path.join(dir, 'store')], { input: '{}', encoding: 'utf8', timeout: 10000 });
        let out = null; try { out = JSON.parse(r.stdout); } catch { /* not json */ }
        fs.rmSync(dir, { recursive: true, force: true });
        const why = !posix ? 'POSIX ownership checks (win32)' : 'node:sqlite';
        if (!(r.status === 1 && out && out.error && out.error.code === 'runtime-unavailable')) { console.error(`mission-deliver: host lacks ${why} and the store did NOT refuse explicitly`); process.exitCode = 1; return; }
        console.log(`mission-deliver: 1/1 passed — host lacks ${why}; the store refuses with runtime-unavailable. 8 POSIX+SQLite scenarios not run on this host.`);
        return;
    }
}

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'mission-deliver-'));
let passed = 0; const failures = [];
function check(name, cond, detail) { if (cond) { passed++; return; } failures.push(name + (detail === undefined ? '' : '\n      -> ' + String(detail).slice(0, 400))); }

function cli(args, preload) {
    const r = spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), ENTRY, ...args], { encoding: 'utf8', timeout: 60000 });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* usage */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, value: json && json.value };
}
function storeCli(command, store, payload, preload) {
    const r = spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), STORE_CLI, command, '--store', store], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* not json */ }
    return { status: r.status, json, value: json && json.value };
}
function clock(ms) { const p = path.join(ROOT, 'clock-' + ms + '.cjs'); fs.writeFileSync(p, 'Date.now = () => ' + ms + ';'); return p; }
let n = 0;
function fixture(name) {
    const repo = path.join(ROOT, name); fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(ROOT, 'no-hooks'), '-c', 'commit.gpgSign=false', '-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n'); git('add', 'README.md');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
    const store = path.join(ROOT, name + '-store'); storeCli('init', store, {});
    const real = fs.realpathSync.native(repo);
    const contract = { repo: { id: name, root: real, commonDir: fs.realpathSync.native(path.join(repo, '.git')), baseSha: git('rev-parse', 'HEAD') }, scope: { paths: ['owned.js'], effects: ['read', 'write'] }, target: { kind: 'local', identifier: name }, acceptance: [{ id: 'behaviour', description: 'The owned module exports a function returning ok.' }], retry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 5 } };
    const admit = storeCli('admit', store, { missionId: name, eventId: 'admit-' + (++n), contract }); if (!admit.json || !admit.json.ok) throw new Error('admit failed: ' + JSON.stringify(admit));
    // A real worker, started by the dispatcher, leaves one pending outbox row.
    const d = spawnSync(process.execPath, [DISPATCH, 'start', '--store', store, '--mission', name, '--owner', 'brain', '--adapter', 'local-node', '--worker', WORKER, '--wait-ms', '30000'], { encoding: 'utf8', timeout: 60000 });
    let dj = null; try { dj = JSON.parse(d.stdout).value; } catch { /* not json */ }
    if (!dj || dj.state !== 'terminal') throw new Error('dispatch did not reach terminal: ' + d.stdout + d.stderr);
    const s = storeCli('status', store, { missionId: name }).value;
    return { name, store, status: () => storeCli('status', store, { missionId: name }).value, fence: { missionId: name, owner: 'brain', attemptId: s.mission.activeAttempt, generation: s.mission.generation }, messageId: s.outbox[0].message_id, resultId: JSON.parse(s.outbox[0].payload_json).result.resultId };
}
const fenceArgs = (f) => ['--store', f.store, '--mission', f.name, '--owner', f.fence.owner, '--attempt', f.fence.attemptId, '--generation', String(f.fence.generation)];

// ---- usage ----
check('--help exits 0 with usage', cli(['--help']).status === 0 && /^Usage: node mission-deliver\.js/.test(cli(['--help']).stdout));
check('no arguments prints usage and returns', cli([]).status === 0 && /Usage/.test(cli([]).stdout));
const bad = cli(['consume', '--store', ROOT, '--mission', 'x']); check('an unknown command is a usage refusal', bad.status === 1 && bad.json && bad.json.error.code === 'usage', bad.stdout);

// ---- the normal path: consumed once, then idempotent ----
{
    const f = fixture('normal');
    const before = cli(['status', '--store', f.store, '--mission', f.name]).value;
    check('before delivery: one pending row, nothing received', before && before.counters.pending === 1 && before.counters.received === 0, JSON.stringify(before));
    const d = cli(['deliver', '--store', f.store, '--mission', f.name]);
    const v = d.value || {};
    check('deliver: one row acknowledged via a send, result received', d.status === 0 && v.delivered.length === 1 && v.delivered[0].state === 'acked' && v.delivered[0].via === 'sent' && v.delivered[0].sendCount === 1 && v.delivered[0].resultState === 'received', d.stdout);
    check('deliver: counters keep acked and received apart, never verified', v.counters.acked === 1 && v.counters.received === 1 && v.counters.pending === 0 && v.counters.accepted === 0 && v.verified === false, JSON.stringify(v.counters));
    const again = cli(['deliver', '--store', f.store, '--mission', f.name]);
    check('deliver again: nothing left to consume, no second send', again.status === 0 && again.value.delivered.length === 0 && f.status().outbox[0].send_count === 1, again.stdout);
    const acc = cli(['accept', ...fenceArgs(f), '--result', f.resultId]);
    check('accept: envelope accepted, still unverified', acc.status === 0 && acc.value.state === 'envelope-accepted' && acc.value.verified === false, acc.stdout);
    const acc2 = cli(['accept', ...fenceArgs(f), '--result', f.resultId]);
    check('accept again: the same answer (same event, replayed), not a refusal', acc2.status === 0 && acc2.value.state === 'envelope-accepted', acc2.stdout);
    const st = cli(['status', '--store', f.store, '--mission', f.name]).value;
    check('status: accepted 1, received 0 (the row moved), mission envelope-accepted', st.counters.accepted === 1 && st.counters.received === 0 && st.mission.state === 'envelope-accepted', JSON.stringify(st));
    const rej = cli(['reject', ...fenceArgs(f), '--result', f.resultId, '--code', 'evidence-rejected']);
    check('reject after acceptance: recorded, mission back to retry-wait', rej.status === 0 && rej.value.state === 'retry-wait' && f.status().results[0].state === 'rejected', rej.stdout);
    const st2 = cli(['status', '--store', f.store, '--mission', f.name]).value;
    check('status: rejected 1, accepted 0, result row preserved', st2.counters.rejected === 1 && st2.counters.accepted === 0 && f.status().results.length === 1, JSON.stringify(st2.counters));
    const badCode = cli(['reject', ...fenceArgs(f), '--result', f.resultId, '--code', 'because']);
    check('reject with an unknown code is a usage refusal', badCode.status === 1 && badCode.json.error.code === 'usage', badCode.stdout);
}

// ---- a lost acknowledgement is recovered from the saved receipt, without a second send ----
{
    const f = fixture('lost-ack');
    const sent = storeCli('begin-delivery', f.store, { missionId: f.name, eventId: 'manual-send', messageId: f.messageId }).value;
    const p = sent.payload;
    const receipt = storeCli('receive', f.store, { missionId: f.name, eventId: 'manual-receive', owner: p.owner, attemptId: p.attemptId, generation: p.generation, result: p.result }).value;
    check('setup: ingested but never acknowledged', receipt && receipt.state === 'received' && f.status().outbox[0].state === 'pending' && f.status().outbox[0].send_count === 1, JSON.stringify(receipt));
    const d = cli(['deliver', '--store', f.store, '--mission', f.name]);
    const v = d.value || {};
    check('deliver: acknowledged from the saved receipt, no send spent', d.status === 0 && v.delivered[0].state === 'acked' && v.delivered[0].via === 'saved-receipt' && f.status().outbox[0].send_count === 1 && f.status().outbox[0].state === 'acked', d.stdout);
}

// ---- the send budget: two spent sends, the third delivers; three spent, exhausted and reported ----
{
    const f = fixture('budget');
    let t = Date.now() + 60000;
    for (let i = 1; i <= 2; i++) { const r = storeCli('begin-delivery', f.store, { missionId: f.name, eventId: 'lost-send-' + i, messageId: f.messageId }, clock(t)); if (!r.json || !r.json.ok) throw new Error('setup send ' + i + ': ' + JSON.stringify(r.json)); t += 5000; }
    const d = cli(['deliver', '--store', f.store, '--mission', f.name], clock(t));
    check('two sends lost: the third send delivers and acknowledges', d.status === 0 && d.value.delivered[0].state === 'acked' && d.value.delivered[0].sendCount === 3, d.stdout);
    const g = fixture('exhausted');
    t = Date.now() + 60000;
    for (let i = 1; i <= 3; i++) { const r = storeCli('begin-delivery', g.store, { missionId: g.name, eventId: 'lost-send-' + i, messageId: g.messageId }, clock(t)); if (!r.json || !r.json.ok) throw new Error('setup send ' + i + ': ' + JSON.stringify(r.json)); t += 5000; }
    const e = cli(['deliver', '--store', g.store, '--mission', g.name], clock(t));
    check('three sends lost: reported delivery-exhausted, not retried, mission still claimed and incomplete', e.status === 0 && e.value.delivered[0].state === 'delivery-exhausted' && e.value.counters.exhausted === 1 && e.value.mission.state === 'claimed', e.stdout);
}

// ---- a retired attempt's result is quarantined, not dropped, and the current claim is untouched ----
{
    const f = fixture('late');
    const failed = storeCli('fail', f.store, { ...f.fence, eventId: 'fail-late', code: 'transient' });
    check('setup: the attempt was retired', failed.json && failed.json.ok, JSON.stringify(failed.json));
    const next = storeCli('claim', f.store, { missionId: f.name, eventId: 'claim-next', owner: 'brain' }, clock(Date.now() + 60000)).value;
    check('setup: a new attempt holds the mission', next && next.number === 2, JSON.stringify(next));
    const d = cli(['deliver', '--store', f.store, '--mission', f.name]);
    const v = d.value || {};
    check('deliver: the old result is acknowledged as quarantined', d.status === 0 && v.delivered[0].state === 'acked' && v.delivered[0].resultState === 'quarantined' && v.counters.quarantined === 1 && v.counters.received === 0, d.stdout);
    check('deliver: the current attempt is untouched', v.mission.activeAttempt === next.attemptId && v.mission.state === 'claimed', JSON.stringify(v.mission));
    const acc = cli(['accept', ...fenceArgs(f), '--result', f.resultId]);
    check('accept with the retired fence is refused as stale-owner', acc.status === 1 && acc.json.error.code === 'stale-owner', acc.stdout);
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }
const total = passed + failures.length;
if (failures.length) { console.error(`mission-deliver: ${passed}/${total} passed, ${failures.length} FAILED\n`); for (const f of failures) console.error('  x ' + f); process.exitCode = 1; }
else console.log(`mission-deliver: ${passed}/${total} passed — consumed once, idempotent re-runs, lost ack recovered without a send, budget exhaustion reported, retired result quarantined, counts kept apart`);
