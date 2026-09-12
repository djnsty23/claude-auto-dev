#!/usr/bin/env node
'use strict';
/**
 * Explicit local mission runtime store. No scheduler or native model integration.
 * A claim is a database reservation, not proof of a subprocess. Envelope
 * acceptance validates declared metadata only, never execution or artifacts.
 * Private same-user storage is a trust boundary; owner names are not credentials.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const APP_ID = 0x41554456;
const VERSION = 3;
const COMMANDS = ['init', 'status', 'admit', 'claim', 'fail', 'receive', 'accept-envelope', 'prepare-start', 'authorize-bootstrap', 'register-executor', 'observe-worker', 'poll-worker', 'reject-result', 'enqueue-result', 'begin-delivery', 'ack-delivery'];
function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }
function requireThat(value, code = 'invalid-input') { if (!value) fault(code); }
function shape(value, keys, code = 'invalid-input') {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), code);
  requireThat(Object.keys(value).sort().join('|') === [...keys].sort().join('|'), code);
}
function word(s) { return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s); }
function text(s) { return typeof s === 'string' && s.trim().length > 0 && s.length <= 2048 && !/[\x00-\x1f\x7f]/.test(s); }
function sha(s) { return typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s); }
function digest(s) { return createHash('sha256').update(s).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function relative(s) {
  return text(s) && !s.includes('\\') && !s.startsWith('/') && !s.includes(':') && s.split('/').every((part, i, all) => part === '' ? i === all.length - 1 : !['.', '..', '.git'].includes(part));
}
function validateContract(c) {
  const code = 'invalid-contract';
  shape(c, ['repo', 'scope', 'target', 'acceptance', 'retry'], code);
  shape(c.repo, ['id', 'root', 'commonDir', 'baseSha'], code);
  requireThat(text(c.repo.id) && typeof c.repo.root === 'string' && typeof c.repo.commonDir === 'string' && path.isAbsolute(c.repo.root) && path.isAbsolute(c.repo.commonDir) && sha(c.repo.baseSha), code);
  shape(c.scope, ['paths', 'effects'], code);
  requireThat(Array.isArray(c.scope.paths) && c.scope.paths.length > 0 && c.scope.paths.length <= 1000 && c.scope.paths.every(relative) && new Set(c.scope.paths).size === c.scope.paths.length, code);
  requireThat(Array.isArray(c.scope.effects) && c.scope.effects.length > 0 && c.scope.effects.every(v => ['read', 'write', 'commit', 'publish', 'deploy'].includes(v)) && new Set(c.scope.effects).size === c.scope.effects.length, code);
  shape(c.target, ['kind', 'identifier'], code);
  requireThat(['local', 'preview', 'production'].includes(c.target.kind) && text(c.target.identifier), code);
  requireThat(Array.isArray(c.acceptance) && c.acceptance.length > 0 && c.acceptance.length <= 1000, code);
  for (const a of c.acceptance) { shape(a, ['id', 'description'], code); requireThat(word(a.id) && text(a.description), code); }
  requireThat(new Set(c.acceptance.map(a => a.id)).size === c.acceptance.length, code);
  shape(c.retry, ['maxAttempts', 'backoffMs', 'maxBackoffMs'], code);
  requireThat(Number.isInteger(c.retry.maxAttempts) && c.retry.maxAttempts >= 1 && c.retry.maxAttempts <= 100, code);
  requireThat(Number.isSafeInteger(c.retry.backoffMs) && c.retry.backoffMs >= 1 && Number.isSafeInteger(c.retry.maxBackoffMs) && c.retry.maxBackoffMs >= c.retry.backoffMs && c.retry.maxBackoffMs <= 86400000, code);
  // Validate local identity at admission only. No later worker context is inferred.
  try {
    const git = (...args) => execFileSync('git', ['-C', c.repo.root, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    requireThat(fs.realpathSync(c.repo.root) === c.repo.root && fs.realpathSync(git('rev-parse', '--show-toplevel')) === c.repo.root, code);
    requireThat(fs.realpathSync(c.repo.commonDir) === c.repo.commonDir && fs.realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir')) === c.repo.commonDir, code);
    requireThat(git('rev-parse', '--verify', c.repo.baseSha + '^{commit}') === c.repo.baseSha && git('rev-parse', 'HEAD') === c.repo.baseSha, code);
  } catch { fault(code, 'Repository identity/base could not be verified at admission'); }
}
function sqliteRuntime() {
  if (typeof process.getuid !== 'function') fault('runtime-unavailable', 'This slice requires POSIX ownership/mode checks');
  try { const { DatabaseSync } = require('node:sqlite'); if (typeof DatabaseSync !== 'function') throw new Error(); return DatabaseSync; }
  catch { fault('runtime-unavailable', 'node:sqlite DatabaseSync is required; no fallback store was created'); }
}
function storePath(root) {
  requireThat(typeof root === 'string' && path.isAbsolute(root) && root === path.resolve(root), 'invalid-store-path');
  try { requireThat(fs.realpathSync(path.dirname(root)) === path.dirname(root), 'invalid-store-path'); }
  catch (e) { if (e.publicCode) throw e; fault('invalid-store-path', 'Store parent must already exist at its canonical path'); }
  return path.join(root, 'missions.sqlite');
}
function privatePath(p, directory) {
  const s = fs.lstatSync(p);
  requireThat(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile()), 'invalid-store-path');
  requireThat(s.uid === process.getuid() && (s.mode & 0o077) === 0, 'store-not-private');
}
function initialize(root, DatabaseSync) {
  const file = storePath(root);
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') fault('store-exists'); throw e; }
  privatePath(root, true);
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    db.exec(`
      PRAGMA application_id=${APP_ID}; PRAGMA user_version=${VERSION};
      CREATE TABLE missions (
        id TEXT PRIMARY KEY, contract_json TEXT NOT NULL, contract_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('ready','claimed','retry-wait','exhausted','result-received','envelope-accepted')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count>=0), generation INTEGER NOT NULL CHECK(generation>=0),
        owner TEXT, active_attempt TEXT, next_eligible_at INTEGER, terminal_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), number INTEGER NOT NULL,
        generation INTEGER NOT NULL, owner TEXT NOT NULL, worktree_root TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','failed','result-received','envelope-accepted')),
        claimed_at INTEGER NOT NULL, settled_at INTEGER, failure_code TEXT,
        UNIQUE(mission_id, number), UNIQUE(mission_id, generation)
      );
      CREATE UNIQUE INDEX one_active_claim ON attempts(mission_id) WHERE state IN ('claimed','result-received');
      CREATE UNIQUE INDEX one_worktree_reservation ON attempts(worktree_root) WHERE state IN ('claimed','result-received','envelope-accepted');
      CREATE TABLE results (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
        envelope_json TEXT NOT NULL, envelope_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('received','rejected','quarantined','envelope-accepted')), received_at INTEGER NOT NULL, accepted_at INTEGER, ingestion_receipt TEXT NOT NULL
      );
      CREATE TABLE metadata (id TEXT PRIMARY KEY);
      CREATE TABLE launches (
        attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), operation_key TEXT NOT NULL UNIQUE,
        assignment_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','registered','terminal','never-started')),
        identity_json TEXT, observation_json TEXT, poll_count INTEGER NOT NULL DEFAULT 0,
        next_poll_at INTEGER, requested_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE bootstraps (
        nonce TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES launches(attempt_id),
        state TEXT NOT NULL CHECK(state IN ('issued','registered')),
        issued_at INTEGER NOT NULL, registered_at INTEGER
      );
      CREATE TABLE outbox (
        message_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
        payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, receiver_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','exhausted','acked')), send_count INTEGER NOT NULL DEFAULT 0,
        next_send_at INTEGER, receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    db.prepare('INSERT INTO metadata(id) VALUES(?)').run(randomUUID());
    db.exec('COMMIT'); return { schemaVersion: VERSION, initialized: true, verified: false };
  } finally { db.close(); }
}
function openStore(root, DatabaseSync, readOnly) {
  const file = storePath(root);
  if (!fs.existsSync(root) || !fs.existsSync(file)) fault('store-missing');
  privatePath(root, true); privatePath(file, false);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly });
    db.exec('PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const app = db.prepare('PRAGMA application_id').get().application_id;
    requireThat(version === VERSION && app === APP_ID, 'store-invalid', 'Unsupported store schema');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    requireThat(canonical(tables) === canonical(['attempts', 'bootstraps', 'events', 'launches', 'metadata', 'missions', 'outbox', 'results']), 'store-invalid');
    if (!readOnly) db.exec('PRAGMA synchronous=FULL;');
    return db;
  } catch (e) { if (db) db.close(); if (e.publicCode) throw e; fault('store-invalid'); }
}
function mission(db, id) { const row = db.prepare('SELECT * FROM missions WHERE id=?').get(id); if (!row) fault('mission-missing'); return row; }
function status(db, id) {
  const m = mission(db, id);
  return {
    mission: { missionId: m.id, revision: m.revision, contract: JSON.parse(m.contract_json), contractHash: m.contract_hash, state: m.state, attemptCount: m.attempt_count, generation: m.generation, owner: m.owner, activeAttempt: m.active_attempt, nextEligibleAt: m.next_eligible_at, terminalReason: m.terminal_reason },
    attempts: db.prepare('SELECT * FROM attempts WHERE mission_id=? ORDER BY number').all(id),
    results: db.prepare('SELECT * FROM results WHERE mission_id=? ORDER BY received_at,id').all(id).map(r => ({ ...r, envelope: JSON.parse(r.envelope_json) })),
    events: db.prepare('SELECT id,kind,created_at FROM events WHERE mission_id=? ORDER BY created_at,id').all(id),
    storeId: storeId(db),
    launches: db.prepare('SELECT * FROM launches WHERE attempt_id IN (SELECT id FROM attempts WHERE mission_id=?)').all(id),
    bootstraps: db.prepare('SELECT * FROM bootstraps WHERE attempt_id IN (SELECT id FROM attempts WHERE mission_id=?) ORDER BY issued_at,nonce').all(id),
    outbox: db.prepare('SELECT * FROM outbox WHERE mission_id=? ORDER BY created_at,message_id').all(id),
    verified: false, executionObserved: false
  };
}
function validFence(db, m, input) {
  requireThat(m.owner === input.owner && m.generation === input.generation && m.active_attempt === input.attemptId, 'stale-owner');
  const a = db.prepare('SELECT * FROM attempts WHERE id=? AND mission_id=?').get(input.attemptId, m.id);
  requireThat(a && a.owner === input.owner && a.generation === input.generation, 'stale-owner'); return a;
}
function validateInput(command, input) {
  const keys = {
    init: [], status: ['missionId'], admit: ['missionId', 'eventId', 'contract'], claim: ['missionId', 'eventId', 'owner'],
    fail: ['missionId', 'eventId', 'owner', 'attemptId', 'generation', 'code'],
    receive: ['missionId', 'eventId', 'owner', 'attemptId', 'generation', 'result'],
    'accept-envelope': ['missionId', 'eventId', 'owner', 'attemptId', 'generation', 'resultId'],
    'prepare-start': ['missionId','eventId','owner','attemptId','generation','operationKey','expectedRevision'],
    'authorize-bootstrap': ['missionId','eventId','owner','attemptId','generation','nonce'],
    'register-executor': ['missionId','eventId','owner','attemptId','generation','identity'],
    'observe-worker': ['missionId','eventId','owner','attemptId','generation','identity','observation'],
    'poll-worker': ['missionId','eventId','owner','attemptId','generation'],
    'reject-result': ['missionId','eventId','owner','attemptId','generation','resultId','code'],
    'enqueue-result': ['missionId','eventId','owner','attemptId','generation','messageId','result','artifactBundle'],
    'begin-delivery': ['missionId','eventId','messageId'],
    'ack-delivery': ['missionId','eventId','messageId','receipt']
  };
  shape(input, keys[command]);
  if (command !== 'init') requireThat(word(input.missionId));
  if (!['init', 'status'].includes(command)) requireThat(word(input.eventId));
  if ('owner' in input) requireThat(word(input.owner));
  if ('attemptId' in input) requireThat(word(input.attemptId) && Number.isSafeInteger(input.generation) && input.generation > 0);
  if (command === 'prepare-start') requireThat(word(input.operationKey) && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0);
  if (command === 'authorize-bootstrap') requireThat(word(input.nonce));
  if ('identity' in input) { shape(input.identity,['host','pid','nonce']); requireThat(word(input.identity.host) && word(input.identity.nonce) && Number.isSafeInteger(input.identity.pid) && input.identity.pid > 0); }
  if (command === 'observe-worker') { shape(input.observation,['kind','exitCode','hookStatus','nativeStatus']); const o=input.observation; requireThat(['live','unknown','terminal'].includes(o.kind) && (o.exitCode===null || Number.isInteger(o.exitCode)) && ['completed','blocked','failed','unknown'].includes(o.hookStatus) && ['completed','failed','unknown'].includes(o.nativeStatus)); requireThat(o.kind==='terminal' || o.exitCode===null); }
  if (command === 'reject-result') requireThat(word(input.resultId) && ['evidence-rejected','context-invalid','hook-blocked'].includes(input.code));
  if ('messageId' in input) requireThat(word(input.messageId));
  if (command === 'ack-delivery') { const r=input.receipt; shape(r,['receiverId','resultId','envelopeHash','eventId','state']); requireThat(word(r.receiverId) && word(r.resultId) && /^[a-f0-9]{64}$/.test(r.envelopeHash) && word(r.eventId) && ['received','quarantined'].includes(r.state)); }
  if (command === 'enqueue-result') { requireThat(Array.isArray(input.artifactBundle) && input.artifactBundle.length > 0 && input.artifactBundle.length <= 1000); for(const a of input.artifactBundle) { shape(a,['path','content']); requireThat(relative(a.path) && typeof a.content==='string'); } requireThat(new Set(input.artifactBundle.map(a=>a.path)).size===input.artifactBundle.length); }
  if (command === 'fail') requireThat(['transient', 'deterministic', 'admission', 'envelope-invalid'].includes(input.code));
  if (command === 'accept-envelope') requireThat(word(input.resultId));
  if (['receive','enqueue-result'].includes(command)) {
    const r = input.result;
    shape(r, ['resultId', 'contractHash', 'repoId', 'baseSha', 'candidateSha', 'acceptanceIds', 'artifacts']);
    requireThat(word(r.resultId) && /^[a-f0-9]{64}$/.test(r.contractHash) && text(r.repoId) && sha(r.baseSha) && sha(r.candidateSha));
    requireThat(Array.isArray(r.acceptanceIds) && r.acceptanceIds.length <= 1000 && r.acceptanceIds.every(word) && new Set(r.acceptanceIds).size === r.acceptanceIds.length);
    requireThat(Array.isArray(r.artifacts) && r.artifacts.length <= 1000);
    for (const a of r.artifacts) { shape(a, ['path', 'sha256']); requireThat(relative(a.path) && /^[a-f0-9]{64}$/.test(a.sha256)); }
  }
}
function apply(db, command, p, now) {
  if (command === 'admit') {
    if (db.prepare('SELECT id FROM missions WHERE id=?').get(p.missionId)) fault('mission-exists');
    validateContract(p.contract); const json = canonical(p.contract), hash = digest(json);
    db.prepare("INSERT INTO missions(id,contract_json,contract_hash,state,attempt_count,generation,created_at,updated_at) VALUES(?,?,?,'ready',0,0,?,?)").run(p.missionId, json, hash, now, now);
    return { missionId: p.missionId, contractHash: hash, state: 'ready', verified: false };
  }
  const m = mission(db, p.missionId), c = JSON.parse(m.contract_json);
  now = Math.max(now, m.updated_at); // Backward clock adjustments cannot erase persisted wait time.
  if (command === 'claim') {
    if (['claimed', 'result-received'].includes(m.state)) fault('claim-conflict');
    if (m.state === 'exhausted' || m.attempt_count >= c.retry.maxAttempts) fault('attempts-exhausted');
    requireThat(['ready', 'retry-wait'].includes(m.state), 'mission-not-claimable');
    if (m.next_eligible_at !== null && now < m.next_eligible_at) fault('backoff-active');
    if (db.prepare("SELECT id FROM attempts WHERE worktree_root=? AND state IN ('claimed','result-received','envelope-accepted')").get(c.repo.root)) fault('worktree-conflict');
    const id = randomUUID(), number = m.attempt_count + 1, generation = m.generation + 1;
    db.prepare("INSERT INTO attempts(id,mission_id,number,generation,owner,worktree_root,state,claimed_at) VALUES(?,?,?,?,?,?,'claimed',?)").run(id, m.id, number, generation, p.owner, c.repo.root, now);
    db.prepare("UPDATE missions SET state='claimed',attempt_count=?,generation=?,owner=?,active_attempt=?,next_eligible_at=NULL,updated_at=? WHERE id=?").run(number, generation, p.owner, id, now, m.id);
    return { missionId: m.id, attemptId: id, number, generation, owner: p.owner, contractHash: m.contract_hash, state: 'claimed', executionObserved: false };
  }
  if (command === 'receive') return ingest(db,m,p,now);
  if (['enqueue-result','begin-delivery','ack-delivery'].includes(command)) return transport(db,m,p,command,now);
  const a = validFence(db, m, p);
  if (['prepare-start','authorize-bootstrap','register-executor','observe-worker','poll-worker'].includes(command)) return launchTransition(db,m,a,p,command,now);
  if (command === 'fail' || command === 'reject-result') {
    requireThat(['claimed', 'result-received','envelope-accepted'].includes(a.state), 'attempt-not-active');
    const launch = db.prepare('SELECT * FROM launches WHERE attempt_id=?').get(a.id);
    // A registered bootstrap may still write. Unknown age/observation never releases it.
    requireThat(!launch || ['prepared','terminal','never-started'].includes(launch.state), 'worker-disposition-unknown');
    if (command === 'reject-result') requireThat(db.prepare('SELECT id FROM results WHERE id=? AND attempt_id=?').get(p.resultId,a.id),'result-missing');
    if (launch && launch.state === 'prepared') db.prepare("UPDATE launches SET state='never-started',updated_at=? WHERE attempt_id=?").run(now,a.id);
    const exhausted = m.attempt_count >= c.retry.maxAttempts;
    const delay = Math.min(c.retry.maxBackoffMs, c.retry.backoffMs * 2 ** Math.min(30, m.attempt_count - 1));
    const next = exhausted ? null : now + delay, state = exhausted ? 'exhausted' : 'retry-wait';
    db.prepare("UPDATE attempts SET state='failed',settled_at=?,failure_code=? WHERE id=?").run(now, p.code, a.id);
    db.prepare("UPDATE results SET state='rejected' WHERE attempt_id=? AND state IN ('received','envelope-accepted')").run(a.id);
    db.prepare('UPDATE missions SET state=?,owner=NULL,active_attempt=NULL,next_eligible_at=?,terminal_reason=?,updated_at=? WHERE id=?').run(state, next, exhausted ? 'attempt-budget-exhausted' : null, now, m.id);
    return { missionId: m.id, state, nextEligibleAt: next, attemptCount: m.attempt_count, verified: false };
  }
  requireThat(command === 'accept-envelope' && a.state === 'result-received', 'attempt-not-active');
  const row = db.prepare('SELECT * FROM results WHERE id=? AND attempt_id=?').get(p.resultId, a.id);
  requireThat(row && row.state === 'received', 'result-missing');
  const r = JSON.parse(row.envelope_json);
  requireThat(r.contractHash === m.contract_hash && r.repoId === c.repo.id && r.baseSha === c.repo.baseSha && canonical([...r.acceptanceIds].sort()) === canonical(c.acceptance.map(x => x.id).sort()) && r.artifacts.length > 0, 'envelope-mismatch');
  db.prepare("UPDATE results SET state='envelope-accepted',accepted_at=? WHERE id=?").run(now, row.id);
  db.prepare("UPDATE attempts SET state='envelope-accepted',settled_at=? WHERE id=?").run(now, a.id);
  db.prepare("UPDATE missions SET state='envelope-accepted',updated_at=? WHERE id=?").run(now, m.id);
  return { resultId: row.id, state: 'envelope-accepted', verified: false, executionObserved: false };
}

function storeId(db) { return db.prepare('SELECT id FROM metadata').get().id; }
function knownAttempt(db,m,p) {
  const a=db.prepare('SELECT * FROM attempts WHERE id=? AND mission_id=?').get(p.attemptId,m.id);
  requireThat(a && a.owner===p.owner && a.generation===p.generation,'stale-owner'); return a;
}
function ingest(db,m,p,now) {
  const a=knownAttempt(db,m,p), json=canonical(p.result), hash=digest(json);
  const prior=db.prepare('SELECT * FROM results WHERE id=? OR attempt_id=?').get(p.result.resultId,a.id);
  if(prior) { requireThat(prior.id===p.result.resultId && prior.attempt_id===a.id && prior.envelope_hash===hash,'result-conflict'); return JSON.parse(prior.ingestion_receipt); }
  const current=m.owner===p.owner && m.generation===p.generation && m.active_attempt===a.id && a.state==='claimed';
  const state=current?'received':'quarantined';
  const receipt={receiverId:storeId(db),resultId:p.result.resultId,envelopeHash:hash,eventId:p.eventId,state};
  db.prepare('INSERT INTO results(id,mission_id,attempt_id,envelope_json,envelope_hash,state,received_at,ingestion_receipt) VALUES(?,?,?,?,?,?,?,?)').run(p.result.resultId,m.id,a.id,json,hash,state,now,canonical(receipt));
  if(current) { db.prepare("UPDATE attempts SET state='result-received' WHERE id=?").run(a.id); db.prepare("UPDATE missions SET state='result-received',updated_at=? WHERE id=?").run(now,m.id); }
  return receipt;
}
function launchTransition(db,m,a,p,command,now) {
  const l=db.prepare('SELECT * FROM launches WHERE attempt_id=?').get(a.id);
  if(command==='prepare-start') {
    requireThat(a.state==='claimed' && m.revision===p.expectedRevision,'start-conflict');
    requireThat(!l,'start-already-prepared');
    const c=JSON.parse(m.contract_json); requireThat(c.target.kind==='local' && c.scope.effects.every(e=>['read','write'].includes(e)),'unsupported-execution-scope');
    validateContract(c); // Revalidate exact repository/base before recording a local execution request.
    const assignmentHash=digest(canonical({storeId:storeId(db),contractHash:m.contract_hash,attemptId:a.id,generation:a.generation,owner:a.owner,operationKey:p.operationKey}));
    if(db.prepare('SELECT attempt_id FROM launches WHERE operation_key=?').get(p.operationKey)) fault('operation-conflict');
    db.prepare("INSERT INTO launches(attempt_id,operation_key,assignment_hash,state,requested_at,updated_at) VALUES(?,?,?,'prepared',?,?)").run(a.id,p.operationKey,assignmentHash,now,now);
    return {attemptId:a.id,state:'prepared',assignmentHash,executionObserved:false};
  }
  requireThat(l,'start-missing');
  now=Math.max(now,l.updated_at);
  if(command==='authorize-bootstrap') {
    requireThat(l.state==='prepared' && a.state==='claimed','bootstrap-not-claimable');
    requireThat(!db.prepare('SELECT nonce FROM bootstraps WHERE nonce=?').get(p.nonce),'bootstrap-conflict');
    const spent=db.prepare('SELECT count(*) AS n FROM bootstraps WHERE attempt_id=?').get(a.id).n;
    requireThat(spent<3,'bootstrap-budget-exhausted');
    // The durable permit precedes fork. An uncertain spawn consumes it permanently.
    // A new nonce is another bounded permit, never a replay or refund of this one.
    db.prepare("INSERT INTO bootstraps(nonce,attempt_id,state,issued_at) VALUES(?,?,'issued',?)").run(p.nonce,a.id,now);
    return {attemptId:a.id,nonce:p.nonce,spawnAuthorized:true,bootstrapCount:spent+1,executionObserved:false};
  }
  if(command==='register-executor') {
    requireThat(l.state==='prepared' && !l.identity_json,'executor-already-registered');
    requireThat(a.state==='claimed','attempt-not-active'); validateContract(JSON.parse(m.contract_json));
    const permit=db.prepare('SELECT * FROM bootstraps WHERE nonce=? AND attempt_id=?').get(p.identity.nonce,a.id);
    requireThat(permit && permit.state==='issued','bootstrap-not-authorized');
    db.prepare("UPDATE bootstraps SET state='registered',registered_at=? WHERE nonce=?").run(now,p.identity.nonce);
    db.prepare("UPDATE launches SET state='registered',identity_json=?,updated_at=? WHERE attempt_id=?").run(canonical(p.identity),now,a.id);
    return {attemptId:a.id,registered:true,executionObserved:false};
  }
  if(command==='poll-worker') {
    requireThat(l.state==='registered','worker-not-reconcilable'); requireThat(l.poll_count<3,'reconciliation-exhausted');
    requireThat(l.next_poll_at===null || now>=l.next_poll_at,'backoff-active');
    const next=now+Math.min(1000,100*2**l.poll_count);
    db.prepare('UPDATE launches SET poll_count=poll_count+1,next_poll_at=?,updated_at=? WHERE attempt_id=?').run(next,now,a.id);
    return {attemptId:a.id,pollCount:l.poll_count+1,nextEligibleAt:next,identity:JSON.parse(l.identity_json)};
  }
  requireThat(l.identity_json===canonical(p.identity),'executor-mismatch');
  requireThat(l.state==='registered' || l.state==='terminal','worker-not-observable');
  requireThat(l.state!=='terminal' || l.observation_json===canonical(p.observation),'terminal-observation-conflict');
  db.prepare('UPDATE launches SET state=?,observation_json=?,updated_at=? WHERE attempt_id=?').run(p.observation.kind==='terminal'?'terminal':'registered',canonical(p.observation),now,a.id);
  return {attemptId:a.id,state:p.observation.kind==='terminal'?'terminal':'registered',observation:p.observation,verified:false};
}
function transport(db,m,p,command,now) {
  if(command==='enqueue-result') {
    const a=knownAttempt(db,m,p);
    const expected=new Map(p.result.artifacts.map(a=>[a.path,a.sha256]));
    requireThat(expected.size===p.result.artifacts.length && expected.size===p.artifactBundle.length && p.artifactBundle.every(a=>expected.get(a.path)===digest(a.content)),'artifact-bundle-mismatch');
    const payload={owner:p.owner,attemptId:a.id,generation:p.generation,result:p.result,artifactBundle:p.artifactBundle}, json=canonical(payload),hash=digest(json);
    const prior=db.prepare('SELECT * FROM outbox WHERE message_id=? OR attempt_id=?').get(p.messageId,a.id);
    if(prior) { requireThat(prior.message_id===p.messageId && prior.mission_id===m.id && prior.payload_hash===hash,'message-conflict'); return {messageId:p.messageId,payloadHash:hash,receiverId:prior.receiver_id,staged:true}; }
    const receiver=storeId(db);
    db.prepare("INSERT INTO outbox(message_id,mission_id,attempt_id,payload_json,payload_hash,receiver_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?)").run(p.messageId,m.id,a.id,json,hash,receiver,now,now);
    return {messageId:p.messageId,payloadHash:hash,receiverId:receiver,staged:true};
  }
  const row=db.prepare('SELECT * FROM outbox WHERE message_id=? AND mission_id=?').get(p.messageId,m.id);requireThat(row,'message-missing');
  now=Math.max(now,row.updated_at);
  if(command==='begin-delivery') {
    requireThat(row.state!=='acked','already-acked'); requireThat(row.send_count<3,'delivery-exhausted');
    requireThat(row.next_send_at===null || now>=row.next_send_at,'backoff-active');
    db.prepare('UPDATE outbox SET send_count=send_count+1,state=?,next_send_at=?,updated_at=? WHERE message_id=?').run(row.send_count===2?'exhausted':'pending',now+Math.min(1000,100*2**row.send_count),now,p.messageId);
    return {messageId:row.message_id,payloadHash:row.payload_hash,receiverId:row.receiver_id,payload:JSON.parse(row.payload_json),sendCount:row.send_count+1};
  }
  const payload=JSON.parse(row.payload_json), saved=db.prepare('SELECT ingestion_receipt FROM results WHERE id=? AND attempt_id=?').get(payload.result.resultId,row.attempt_id);
  requireThat(p.receipt.receiverId===row.receiver_id && p.receipt.envelopeHash===digest(canonical(payload.result)) && saved && canonical(p.receipt)===saved.ingestion_receipt,'ack-mismatch');
  db.prepare("UPDATE outbox SET state='acked',receipt_json=?,updated_at=? WHERE message_id=?").run(canonical(p.receipt),now,p.messageId);
  return {messageId:p.messageId,state:'acked',receipt:p.receipt,verified:false};
}

function transact(db, command, input) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const hash = digest(canonical(input));
    const prior = db.prepare('SELECT * FROM events WHERE id=?').get(input.eventId);
    if (prior) {
      requireThat(prior.kind === command && prior.payload_hash === hash, 'event-conflict');
      // Registration is a one-shot execution gate: historical success cannot authorize another bootstrap.
      
      if (command === 'register-executor') fault('executor-already-registered');
      if (command === 'begin-delivery') fault('delivery-already-issued');
      if (command === 'poll-worker') fault('poll-already-issued');
      const value = JSON.parse(prior.response_json); db.exec('COMMIT'); return value;
    }
    const now = Date.now(); requireThat(Number.isSafeInteger(now) && now >= 0, 'clock-invalid');
    const value = apply(db, command, input, now);
    db.prepare('UPDATE missions SET revision=revision+1 WHERE id=?').run(input.missionId);
    db.prepare('INSERT INTO events(id,mission_id,kind,payload_hash,response_json,created_at) VALUES(?,?,?,?,?,?)').run(input.eventId, input.missionId, command, hash, canonical(value), now);
    db.exec('COMMIT'); return value;
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
function execute(command, root, input) {
  requireThat(COMMANDS.includes(command),'usage');
  const encoded=Buffer.from(JSON.stringify(input)); requireThat(encoded.length <= 262144,'input-too-large');
  validateInput(command,input); storePath(root); const DatabaseSync=sqliteRuntime();
  if(command==='init') return initialize(root,DatabaseSync);
  const db=openStore(root,DatabaseSync,command==='status');
  try { return command==='status' ? status(db,input.missionId) : transact(db,command,input); } finally { db.close(); }
}
module.exports={execute,canonical,digest};
async function main() {
  let db;
  try {
    const [command, flag, root, ...extra] = process.argv.slice(2);
    requireThat(COMMANDS.includes(command) && flag === '--store' && !extra.length, 'usage', 'Use command --store /absolute/private/directory and a JSON object on stdin');
    storePath(root); const DatabaseSync = sqliteRuntime();
    const chunks = []; let byteLength = 0;
    for await (const part of process.stdin) {
      byteLength += part.length; requireThat(byteLength <= 262144, 'input-too-large'); chunks.push(part);
    }
    let input;
    try {
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, byteLength));
      input = JSON.parse(raw);
    } catch { fault('invalid-json'); }
    validateInput(command, input);
    let value;
    if (command === 'init') value = initialize(root, DatabaseSync);
    else { db = openStore(root, DatabaseSync, command === 'status'); value = command === 'status' ? status(db, input.missionId) : transact(db, command, input); }
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
  } catch (e) {
    let code = e.publicCode;
    if (!code) code = e.errcode === 5 || e.errcode === 6 ? 'store-busy' : ['EACCES', 'EROFS', 'ENOSPC'].includes(e.code) ? 'store-unwritable' : 'store-error';
    // Avoid echoing contract text, paths, SQL, Git stderr or arbitrary exceptions.
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message: e.publicCode ? e.message : code } }) + '\n'); process.exitCode = 1;
  } finally { if (db) db.close(); }
}
if (require.main === module) main();
