#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/mission-store.js: actual CLI processes over
// disposable local Git and SQLite fixtures. Concurrent claims race as real
// processes; SIGKILL lands at the actual COMMIT boundary; nothing under the repo
// is touched. Run: node tooling/test-mission-store.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const ENTRY = path.resolve(__dirname, '../plugins/autodev-core/scripts/mission-store.js');

// HOST BOUNDARY. The store requires node:sqlite and POSIX ownership checks and
// answers `runtime-unavailable` without them. On such a host this suite proves
// that refusal and nothing else, and says so; it does not pass on an empty
// population, and a host that lacks the runtime but does NOT refuse is red.
{
  const posix = typeof process.getuid === 'function';
  let sqlite = false; try { sqlite = typeof require('node:sqlite').DatabaseSync === 'function'; } catch {}
  if (!(posix && sqlite)) {
    const cp = require('node:child_process'), osm = require('node:os'), fsm = require('node:fs'), pm = require('node:path');
    const dir = fsm.mkdtempSync(pm.join(fsm.realpathSync(osm.tmpdir()), 'mission-store-host-'));
    const store = pm.join(dir, 'store');
    const r = cp.spawnSync(process.execPath, [ENTRY, 'init', '--store', store], { input: '{}', encoding: 'utf8', timeout: 10000 });
    let out = null; try { out = JSON.parse(r.stdout); } catch {}
    const refused = r.status === 1 && out && out.ok === false && out.error && out.error.code === 'runtime-unavailable' && !fsm.existsSync(store);
    fsm.rmSync(dir, { recursive: true, force: true });
    const why = !posix ? 'POSIX ownership checks (win32)' : 'node:sqlite';
    if (!refused) { console.error('mission-store: host lacks ' + why + ' and the store did NOT refuse explicitly: exit ' + r.status + ' ' + String(r.stdout).slice(0, 200)); process.exitCode = 1; return; }
    console.log('mission-store: 1/1 passed — host lacks ' + why + '; the store refuses with runtime-unavailable and creates nothing. 22 POSIX+SQLite cases not run on this host.');
    return;
  }
}
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'autodev-mission-store-'));
const children = new Set();
const cases = [];
let passed = 0;
const test = (name, fn) => cases.push([name, fn]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch(command, store, payload = {}, preload, writeInput = true) {
  const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), ENTRY, command, '--store', store], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  // A child that refuses before reading stdin can close the pipe before the
  // payload write lands (EPIPE). Its verdict is exit code plus stdout; anything
  // else on stdin is recorded and fails the assertion that reads stderr.
  child.stdin.on('error', (e) => { if (e.code !== 'EPIPE') stderr += 'stdin ' + e.code + ' '; });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI exceeded 10s: ' + command)); }, 10000);
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout); children.delete(child);
      let data; try { data = JSON.parse(stdout); } catch {}
      resolve({ code, signal, data, stdout, stderr });
    });
  });
  if (writeInput) child.stdin.end(Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
  return { child, done };
}
const run = (...args) => launch(...args).done;
function good(r) { assert.equal(r.code, 0, r.stderr + r.stdout); assert.equal(r.data.ok, true); return r.data.value; }
function bad(r, code) { assert.equal(r.code, 1, r.stdout + r.stderr); assert.equal(r.data?.error?.code, code, r.stdout + r.stderr); }
function preload(name, source) { const p = path.join(root, name + '.cjs'); fs.writeFileSync(p, source); return p; }
const clock = ms => preload('clock-' + ms, 'Date.now = () => ' + ms + ';');
const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), '-c', 'commit.gpgSign=false', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
const baseSha = git('rev-parse', 'HEAD');
const commonDir = fs.realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
const contract = () => ({ repo: { id: 'fixture-origin', root: repo, commonDir, baseSha }, scope: { paths: ['src/'], effects: ['read', 'write'] }, target: { kind: 'local', identifier: 'fixture-local' }, acceptance: [{ id: 'http-response', description: 'A verified local response meets the fixture contract.' }], retry: { maxAttempts: 2, backoffMs: 100, maxBackoffMs: 1000 } });
function independentContract(label) {
  const c = contract(), worktree = path.join(root, 'worktree-' + label);
  git('worktree', 'add', '--detach', '-q', worktree, baseSha); c.repo.root = fs.realpathSync(worktree); return c;
}
let serial = 0;
async function fixture(name, options = {}) {
  const store = path.join(root, name); good(await run('init', store));
  const missionId = name, c = contract(); if (options.maxAttempts) c.retry.maxAttempts = options.maxAttempts;
  const admitted = good(await run('admit', store, { eventId: 'admit-' + (++serial), missionId, contract: c }, clock(1000)));
  return { store, missionId, contract: c, contractHash: admitted.contractHash };
}
const claim = f => ({ eventId: 'claim-' + (++serial), missionId: f.missionId, owner: 'owner-a' });
const fence = (f, a) => ({ missionId: f.missionId, attemptId: a.attemptId, owner: a.owner, generation: a.generation });
const result = f => ({ resultId: 'result-' + (++serial), contractHash: f.contractHash, repoId: f.contract.repo.id, baseSha, candidateSha: baseSha, acceptanceIds: ['http-response'], artifacts: [{ path: 'evidence/local.json', sha256: 'a'.repeat(64) }] });
async function read(f) { return good(await run('status', f.store, { missionId: f.missionId })); }
async function waitFile(file) { for (let i = 0; i < 400; i++) { if (fs.existsSync(file)) return; await pause(10); } throw new Error('Child did not reach pending transaction'); }

test('missing store and missing SQLite are explicit and do not initialize on read', async () => {
  const missing = path.join(root, 'missing'); bad(await run('status', missing, { missionId: 'absent' }), 'store-missing'); assert.equal(fs.existsSync(missing), false);
  const unavailable = preload('unavailable', `const Module=require('node:module'); const old=Module._load; Module._load=function(id,...args){if(id==='node:sqlite')throw new Error('fixture unavailable');return old.call(this,id,...args)};`);
  bad(await run('init', missing, {}, unavailable), 'runtime-unavailable'); assert.equal(fs.existsSync(missing), false);
  bad(await run('init', 'relative-store'), 'invalid-store-path');
});
test('split UTF-8 survives actual child pipe chunks after acknowledged first-chunk consumption', async () => {
  const store = path.join(root, 'utf8'); good(await run('init', store));
  const c = contract(); c.target.identifier = 'Café';
  const control = { missionId: 'utf8-control', eventId: 'utf8-control', contract: c };
  good(await run('admit', store, control));
  assert.equal(good(await run('status', store, { missionId: control.missionId })).mission.contract.target.identifier, 'Café');
  const payload = { ...control, missionId: 'utf8-split', eventId: 'utf8-split' }, bytes = Buffer.from(JSON.stringify(payload));
  const cut = bytes.indexOf(Buffer.from('é')) + 1; assert.equal(bytes[cut - 1], 0xc3); assert.equal(bytes[cut], 0xa9);
  const acknowledgement = path.join(root, 'stdin-first-chunk.json');
  // The wrapper acknowledges only after the real consumer processed each yielded
  // Buffer. It does not change the bytes or decode them. No sleep decides the cut.
  const observe = preload('observe-stdin', `const fs=require('node:fs');const original=process.stdin[Symbol.asyncIterator].bind(process.stdin);process.stdin[Symbol.asyncIterator]=async function*(){let seen=0;for await(const part of original()){yield part;seen+=part.length;fs.writeFileSync(${JSON.stringify(acknowledgement)},JSON.stringify({seen,lastByte:part[part.length-1]}))}};`);
  const pending = launch('admit', store, {}, observe, false);
  pending.child.stdin.write(bytes.subarray(0, cut));
  let observed;
  for (let i = 0; i < 400; i++) { try { observed = JSON.parse(fs.readFileSync(acknowledgement, 'utf8')); } catch {} if (observed?.seen === cut) break; await pause(10); }
  assert.deepEqual(observed, { seen: cut, lastByte: 0xc3 });
  pending.child.stdin.end(bytes.subarray(cut)); good(await pending.done);
  const saved = good(await run('status', store, { missionId: payload.missionId }));
  assert.equal(saved.mission.contract.target.identifier, 'Café'); assert.deepEqual(saved.mission.contract, c);
  assert.equal(saved.mission.contractHash, good(await run('status', store, { missionId: control.missionId })).mission.contractHash);
});
test('malformed UTF-8 and malformed JSON fail before creating or admitting state', async () => {
  const missing = path.join(root, 'invalid-json-input'); bad(await run('init', missing, Buffer.from('{')), 'invalid-json'); assert.equal(fs.existsSync(missing), false);
  const store = path.join(root, 'invalid-utf8'); good(await run('init', store));
  for (const [index, invalid] of [[0, [0xff]], [1, [0xc3]], [2, [0xc0, 0xaf]]]) {
    const c = contract(); c.target.identifier = 'BYTE_MARKER';
    const payload = { missionId: 'invalid-byte-' + index, eventId: 'invalid-byte-' + index, contract: c }, bytes = Buffer.from(JSON.stringify(payload)), at = bytes.indexOf('BYTE_MARKER');
    const input = Buffer.concat([bytes.subarray(0, at), Buffer.from(invalid), bytes.subarray(at + 'BYTE_MARKER'.length)]);
    bad(await run('admit', store, input), 'invalid-json'); bad(await run('status', store, { missionId: payload.missionId }), 'mission-missing');
  }
});
test('256 KiB input bound counts bytes, accepts the exact limit, and rejects excess without writes', async () => {
  const exact = Buffer.from('{}' + ' '.repeat(262144 - 2)); assert.equal(exact.length, 262144);
  const store = path.join(root, 'exact-byte-limit'); good(await run('init', store, exact));
  const tooLarge = path.join(root, 'too-large-input'); bad(await run('init', tooLarge, Buffer.concat([exact, Buffer.from(' ')])), 'input-too-large'); assert.equal(fs.existsSync(tooLarge), false);
  const c = contract(); c.acceptance = Array.from({ length: 600 }, (_, i) => ({ id: 'criterion-' + i, description: 'é'.repeat(250) }));
  const payload = { missionId: 'too-many-bytes', eventId: 'too-many-bytes', contract: c }, json = JSON.stringify(payload);
  assert.ok(json.length < 262144); assert.ok(Buffer.byteLength(json) > 262144);
  bad(await run('admit', store, Buffer.from(json)), 'input-too-large'); bad(await run('status', store, { missionId: payload.missionId }), 'mission-missing');
});
test('explicit init is private, exclusive and status of unknown mission fails', async () => {
  const store = path.join(root, 'private'); good(await run('init', store));
  assert.equal(fs.statSync(store).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(store, 'missions.sqlite')).mode & 0o777, 0o600);
  bad(await run('init', store), 'store-exists'); bad(await run('status', store, { missionId: 'missing' }), 'mission-missing');
  const link = path.join(root, 'store-link'); fs.symlinkSync(store, link); bad(await run('status', link, { missionId: 'missing' }), 'invalid-store-path');
  fs.chmodSync(store, 0o755); bad(await run('status', store, { missionId: 'missing' }), 'store-not-private');
});
test('invalid database/schema is not silently initialized', async () => {
  const store = path.join(root, 'corrupt'); fs.mkdirSync(store, { mode: 0o700 }); fs.writeFileSync(path.join(store, 'missions.sqlite'), 'invalid', { mode: 0o600 });
  const before = fs.readFileSync(path.join(store, 'missions.sqlite')); bad(await run('status', store, { missionId: 'missing' }), 'store-invalid'); assert.deepEqual(fs.readFileSync(path.join(store, 'missions.sqlite')), before);
});
test('admission persists immutable contract across process restart with read-only status', async () => {
  const f = await fixture('persist'); const before = fs.readdirSync(f.store); const digest = fs.readFileSync(path.join(f.store, 'missions.sqlite'));
  const s = await read(f); assert.deepEqual(s.mission.contract, f.contract); assert.equal(s.mission.contractHash, f.contractHash); assert.equal(s.mission.state, 'ready'); assert.equal(s.verified, false); assert.equal(s.attempts.length, 0);
  assert.deepEqual(fs.readdirSync(f.store), before); assert.deepEqual(fs.readFileSync(path.join(f.store, 'missions.sqlite')), digest);
  const c = contract(); c.scope.paths = ['other/']; bad(await run('admit', f.store, { missionId: f.missionId, eventId: 'changed', contract: c }), 'mission-exists'); assert.deepEqual((await read(f)).mission.contract, f.contract);
});
test('scope/repo/base/target/acceptance/retry malformed contracts rejected without mission', async () => {
  const store = path.join(root, 'invalid-contract'); good(await run('init', store));
  const edits = [c => c.scope.paths = ['../escape'], c => c.scope.effects = ['anything'], c => c.repo.commonDir = repo, c => c.repo.baseSha = '0'.repeat(40), c => c.target.identifier = '', c => c.acceptance = [], c => c.acceptance.push(c.acceptance[0]), c => c.retry.maxAttempts = 0, c => c.extra = true];
  for (let i = 0; i < edits.length; i++) { const c = contract(); edits[i](c); const r = await run('admit', store, { missionId: 'invalid-' + i, eventId: 'invalid-' + i, contract: c }); bad(r, 'invalid-contract'); bad(await run('status', store, { missionId: 'invalid-' + i }), 'mission-missing'); }
});
test('two real processes race for one claim: exactly one allocation, unrelated mission remains claimable', async () => {
  const f = await fixture('race'); const payloads = [claim(f), { ...claim(f), owner: 'owner-b' }];
  const attempts = await Promise.all(payloads.map(p => run('claim', f.store, p, clock(1000)))); assert.equal(attempts.filter(r => r.code === 0).length, 1); bad(attempts.find(r => r.code !== 0), 'claim-conflict');
  const s = await read(f); assert.equal(s.attempts.length, 1); assert.equal(s.mission.attemptCount, 1); assert.equal(s.events.filter(e => e.kind === 'claim').length, 1); assert.equal(s.mission.state, 'claimed'); assert.equal(s.verified, false);
  const c = independentContract('race'); good(await run('admit', f.store, { missionId: 'independent', eventId: 'admit-independent', contract: c })); good(await run('claim', f.store, { missionId: 'independent', eventId: 'claim-independent', owner: 'owner-c' }));
});
test('different mission IDs cannot reserve the same worktree, including after envelope acceptance', async () => {
  const f = await fixture('worktree-exclusive'); const a = good(await run('claim', f.store, claim(f)));
  good(await run('admit', f.store, { missionId: 'overlapping', eventId: 'admit-overlapping', contract: contract() }));
  const p = { missionId: 'overlapping', eventId: 'claim-overlapping', owner: 'owner-overlap' };
  bad(await run('claim', f.store, p), 'worktree-conflict');
  const r = result(f); good(await run('receive', f.store, { ...fence(f, a), eventId: 'receive-exclusive', result: r })); good(await run('accept-envelope', f.store, { ...fence(f, a), eventId: 'accept-exclusive', resultId: r.resultId }));
  bad(await run('claim', f.store, p), 'worktree-conflict');
  const s = good(await run('status', f.store, { missionId: 'overlapping' })); assert.equal(s.mission.attemptCount, 0); assert.equal(s.mission.state, 'ready');
});
test('duplicate event is idempotent and changed reuse conflicts', async () => {
  const f = await fixture('idempotent'); const p = claim(f); const first = good(await run('claim', f.store, p)); const again = good(await run('claim', f.store, p)); assert.deepEqual(again, first);
  bad(await run('claim', f.store, { ...p, owner: 'owner-b' }), 'event-conflict'); assert.equal((await read(f)).attempts.length, 1);
});
test('concurrent replay returns one stable allocation and independent missions both advance', async () => {
  const f = await fixture('concurrent-replay'); const p = claim(f);
  const rs = await Promise.all([run('claim', f.store, p), run('claim', f.store, p)]); assert.deepEqual(good(rs[0]), good(rs[1])); assert.equal((await read(f)).attempts.length, 1);
  for (const id of ['parallel-a', 'parallel-b']) good(await run('admit', f.store, { missionId: id, eventId: 'admit-' + id, contract: independentContract(id) }));
  const independent = await Promise.all(['parallel-a', 'parallel-b'].map(id => run('claim', f.store, { missionId: id, eventId: 'claim-' + id, owner: id })));
  assert.equal(independent.filter(r => r.code === 0).length, 2); for (const r of independent) assert.equal(good(r).number, 1);
});
test('backoff doubles and caps across restarts; backward clock does not bypass a wait', async () => {
  const f = await fixture('backoff-cap', { maxAttempts: 7 });
  let now = 1000;
  for (const delay of [100, 200, 400, 800, 1000, 1000]) {
    const a = good(await run('claim', f.store, claim(f), clock(now)));
    const s = good(await run('fail', f.store, { ...fence(f, a), eventId: 'backoff-' + now, code: 'transient' }, clock(now)));
    assert.equal(s.nextEligibleAt, now + delay); bad(await run('claim', f.store, claim(f), clock(0)), 'backoff-active'); now += delay;
  }
  assert.equal(good(await run('claim', f.store, claim(f), clock(now))).number, 7);
});
test('age alone cannot reclaim or allocate another attempt', async () => {
  const f = await fixture('no-steal'); good(await run('claim', f.store, claim(f), clock(1000))); bad(await run('claim', f.store, { ...claim(f), owner: 'other' }, clock(999999999)), 'claim-conflict'); assert.equal((await read(f)).mission.attemptCount, 1);
});
test('failure, backoff and exhaustion survive restarts without duplicate debit', async () => {
  const f = await fixture('budget'); const p = claim(f); const a = good(await run('claim', f.store, p, clock(1000))); const failed = { ...fence(f, a), eventId: 'failed-first', code: 'transient' };
  const failure = good(await run('fail', f.store, failed, clock(1000))); assert.equal(failure.nextEligibleAt, 1100); assert.equal(failure.state, 'retry-wait'); assert.deepEqual(good(await run('fail', f.store, failed, clock(1200))), failure);
  bad(await run('claim', f.store, claim(f), clock(1099)), 'backoff-active'); const b = good(await run('claim', f.store, claim(f), clock(1100))); assert.equal(b.number, 2); assert.equal(b.generation, 2);
  good(await run('fail', f.store, { ...fence(f, b), eventId: 'failed-second', code: 'deterministic' }, clock(1100))); const s = await read(f); assert.equal(s.mission.state, 'exhausted'); assert.equal(s.mission.attemptCount, 2); assert.equal(s.mission.terminalReason, 'attempt-budget-exhausted');
  bad(await run('claim', f.store, claim(f), clock(999999)), 'attempts-exhausted'); assert.deepEqual(good(await run('claim', f.store, p)), a); assert.equal((await read(f)).attempts.length, 2);
});
test('stale owner and wrong attempt cannot settle newer generation', async () => {
  const f = await fixture('fencing'); const a = good(await run('claim', f.store, claim(f), clock(1000))); good(await run('fail', f.store, { ...fence(f, a), eventId: 'retired', code: 'transient' }, clock(1000)));
  const b = good(await run('claim', f.store, { ...claim(f), owner: 'owner-b' }, clock(1100)));
  bad(await run('fail', f.store, { ...fence(f, a), eventId: 'stale-fail', code: 'transient' }), 'stale-owner');
  assert.equal(good(await run('receive', f.store, { ...fence(f, a), eventId: 'stale-result', result: result(f) })).state, 'quarantined');
  bad(await run('fail', f.store, { ...fence(f, b), owner: 'owner-a', eventId: 'wrong-owner', code: 'transient' }), 'stale-owner'); assert.equal((await read(f)).mission.state, 'claimed');
});
test('received is distinct from accepted; mismatched envelope stays unaccepted', async () => {
  const f = await fixture('envelope-wrong'); const a = good(await run('claim', f.store, claim(f))); const r = result(f); r.contractHash = 'b'.repeat(64);
  good(await run('receive', f.store, { ...fence(f, a), eventId: 'received-wrong', result: r })); assert.equal((await read(f)).mission.state, 'result-received');
  bad(await run('accept-envelope', f.store, { ...fence(f, a), eventId: 'accept-wrong', resultId: r.resultId }), 'envelope-mismatch'); const s = await read(f); assert.equal(s.results[0].state, 'received'); assert.equal(s.verified, false);
});
test('envelope matching is metadata only and never proves execution, artifacts or verification', async () => {
  const f = await fixture('envelope-correct'); const a = good(await run('claim', f.store, claim(f))); const r = result(f), payload = { ...fence(f, a), eventId: 'received-correct', result: r };
  const receipt = good(await run('receive', f.store, payload)); assert.deepEqual(good(await run('receive', f.store, payload)), receipt);
  const accepted = { ...fence(f, a), eventId: 'accept-correct', resultId: r.resultId }; good(await run('accept-envelope', f.store, accepted)); good(await run('accept-envelope', f.store, accepted));
  const s = await read(f); assert.equal(s.mission.state, 'envelope-accepted'); assert.equal(s.results[0].state, 'envelope-accepted'); assert.equal(s.results.length, 1); assert.equal(s.verified, false); assert.equal(s.executionObserved, false); assert.equal(s.events.filter(e => e.kind === 'accept-envelope').length, 1);
  assert.equal(fs.existsSync(path.join(repo, r.artifacts[0].path)), false); bad(await run('claim', f.store, claim(f)), 'mission-not-claimable');
});
test('repo/base/acceptance/artifact mismatch cannot accept an envelope', async () => {
  const edits = [r => r.repoId = 'wrong-repo', r => r.baseSha = 'b'.repeat(40), r => r.acceptanceIds = [], r => r.artifacts = []];
  for (let i = 0; i < edits.length; i++) { const f = await fixture('mismatch-' + i); const a = good(await run('claim', f.store, claim(f))); const r = result(f); edits[i](r); good(await run('receive', f.store, { ...fence(f, a), eventId: 'receive-' + i, result: r })); bad(await run('accept-envelope', f.store, { ...fence(f, a), eventId: 'accept-' + i, resultId: r.resultId }), 'envelope-mismatch'); assert.equal((await read(f)).mission.state, 'result-received'); }
});
test('result identity reuse conflicts and wrong-generation acceptance is fenced', async () => {
  const f = await fixture('result-identity'); const a = good(await run('claim', f.store, claim(f))); const r = result(f);
  const p = { ...fence(f, a), eventId: 'result-original', result: r }; good(await run('receive', f.store, p));
  bad(await run('receive', f.store, { ...p, result: { ...r, candidateSha: 'c'.repeat(40) } }), 'event-conflict');
  bad(await run('accept-envelope', f.store, { ...fence(f, a), generation: a.generation + 1, eventId: 'accept-stale', resultId: r.resultId }), 'stale-owner');
  const c = independentContract('result'); good(await run('admit', f.store, { missionId: 'result-independent', eventId: 'result-independent', contract: c }));
  const b = good(await run('claim', f.store, { missionId: 'result-independent', eventId: 'claim-result-independent', owner: 'owner-b' }));
  bad(await run('receive', f.store, { ...fence({ missionId: 'result-independent' }, b), eventId: 'result-collision', result: r }), 'result-conflict');
  assert.equal((await read(f)).results.length, 1); assert.equal((await read(f)).results[0].state, 'received');
});
test('SIGKILL before acceptance COMMIT retains received state and replay accepts once', async () => {
  const f = await fixture('ack-rollback'); const a = good(await run('claim', f.store, claim(f))); const r = result(f);
  good(await run('receive', f.store, { ...fence(f, a), eventId: 'receive-before-kill', result: r }));
  const signal = path.join(root, 'accept-pending');
  const hold = preload('hold-accept', `const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');const old=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'){fs.writeFileSync(${JSON.stringify(signal)},'pending');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,9000);}return old.call(this,sql)};`);
  const payload = { ...fence(f, a), eventId: 'accept-after-kill', resultId: r.resultId }, pending = launch('accept-envelope', f.store, payload, hold);
  await waitFile(signal); pending.child.kill('SIGKILL'); assert.equal((await pending.done).signal, 'SIGKILL');
  const before = await read(f); assert.equal(before.mission.state, 'result-received'); assert.equal(before.results[0].state, 'received'); assert.equal(before.events.filter(e => e.kind === 'accept-envelope').length, 0);
  const receipt = good(await run('accept-envelope', f.store, payload)); assert.deepEqual(good(await run('accept-envelope', f.store, payload)), receipt);
  assert.equal((await read(f)).events.filter(e => e.kind === 'accept-envelope').length, 1);
});
test('SIGKILL before COMMIT rolls back ownership, debit and event; busy error is bounded', async () => {
  const f = await fixture('rollback'); const signal = path.join(root, 'transaction-pending');
  const hold = preload('hold-commit', `const fs=require('node:fs'); const {DatabaseSync}=require('node:sqlite'); const old=DatabaseSync.prototype.exec; DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'){fs.writeFileSync(${JSON.stringify(signal)}, 'pending'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,9000);}return old.call(this,sql)};`);
  const p = claim(f), pending = launch('claim', f.store, p, hold); await waitFile(signal);
  bad(await run('claim', f.store, { ...claim(f), owner: 'contender' }), 'store-busy'); pending.child.kill('SIGKILL'); assert.equal((await pending.done).signal, 'SIGKILL');
  const s = await read(f); assert.equal(s.mission.state, 'ready'); assert.equal(s.mission.attemptCount, 0); assert.equal(s.attempts.length, 0); assert.equal(s.events.length, 1);
  const a = good(await run('claim', f.store, p)); assert.equal(a.number, 1); assert.equal((await read(f)).events.length, 2);
});
(async () => {
  try { for (const [name, fn] of cases) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { console.error('FAIL ' + name + ': ' + e.message); } } }
  finally { await Promise.all([...children].map(child => new Promise(resolve => { child.once('close', resolve); child.kill('SIGKILL'); }))); fs.rmSync(root, { recursive: true, force: true }); }
  console.log(JSON.stringify({ passed, failed: cases.length - passed, population: cases.length }));
  console.log('mission-store: ' + passed + '/' + cases.length + ' passed — private init, immutable contracts, racing claims, fencing, backoff, envelopes, and SIGKILL at COMMIT');
  process.exitCode = passed === cases.length && cases.length > 0 ? 0 : 1;
})();
