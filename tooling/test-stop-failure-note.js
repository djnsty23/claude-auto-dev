#!/usr/bin/env node
// Suite for stop-failure-note.js.
//
// The hook exists because a turn that dies on an API error ends through
// StopFailure, where stop-auto-check.js never runs, so an unattended sprint
// stalled with no record. The assertions that matter are therefore about what
// gets WRITTEN, not about the exit code: this hook exits 0 on every path by
// design, so an exit-code-only suite would pass against a hook that recorded
// nothing at all.
//
// Hermetic: every case builds its own temp repo. Nothing here touches a real
// .claude/reports directory.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'stop-failure-note.js');
let pass = 0;
let fail = 0;

const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
};

function repo({ autoActive }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stopfail-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  if (autoActive) fs.writeFileSync(path.join(root, '.claude', 'auto-active'), '', 'utf8');
  return root;
}

function fire(root, payload) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function records(root) {
  const dir = path.join(root, '.claude', 'reports');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('auto-stalls-'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    );
}

// 1. A stalled sprint is recorded, and flagged as a sprint.
{
  const root = repo({ autoActive: true });
  const r = fire(root, { session_id: 'abc-123', cwd: root, hook_event_name: 'StopFailure', reason: 'rate_limit' });
  const rows = records(root);
  ok('exits 0', r.status === 0, 'exit ' + r.status);
  ok('writes exactly one record', rows.length === 1, JSON.stringify(rows));
  ok('marks auto_active true when a sprint was live', rows[0] && rows[0].auto_active === true, JSON.stringify(rows[0]));
  ok('carries the session id', rows[0] && rows[0].session === 'abc-123', JSON.stringify(rows[0]));
  ok('carries the failure reason', rows[0] && rows[0].reason === 'rate_limit', JSON.stringify(rows[0]));
  ok('tells the operator on stderr', /sprint still active/i.test(r.stderr || ''), JSON.stringify(r.stderr));
}

// 2. An ordinary failed turn is still recorded, but not as a sprint, and stays
//    quiet. A hook that speaks every time gets ignored.
{
  const root = repo({ autoActive: false });
  const r = fire(root, { session_id: 'no-sprint', cwd: root, hook_event_name: 'StopFailure' });
  const rows = records(root);
  ok('records a failed turn with no sprint', rows.length === 1 && rows[0].auto_active === false, JSON.stringify(rows));
  ok('stays quiet when no sprint was live', !/sprint still active/i.test(r.stderr || ''), JSON.stringify(r.stderr));
}

// 3. Garbage stdin must not turn one failure into two.
{
  const r = fire(null, 'not json at all');
  ok('exits 0 on unparseable stdin', r.status === 0, 'exit ' + r.status);
}

// 4. The record lands at the REPO root, not in a subdirectory the turn happened
//    to be in. Same collapsing rule telemetry.js uses.
{
  const root = repo({ autoActive: true });
  const deep = path.join(root, 'src', 'nested');
  fs.mkdirSync(deep, { recursive: true });
  fire(root, { session_id: 'deep', cwd: deep, hook_event_name: 'StopFailure' });
  ok('collapses a nested cwd onto the repo root', records(root).length === 1, 'root records');
  ok('writes nothing under the nested dir', !fs.existsSync(path.join(deep, '.claude')), 'nested .claude exists');
}

// 5. The reason field takes whatever the harness actually sent. The field name
//    has moved between versions, so assert the fallback rather than one spelling.
{
  const root = repo({ autoActive: false });
  fire(root, { cwd: root, hook_event_name: 'StopFailure', error: 'overloaded_error' });
  const rows = records(root);
  ok('falls back across reason field spellings', rows[0] && rows[0].reason === 'overloaded_error', JSON.stringify(rows[0]));
}

console.log((fail ? 'FAIL' : 'PASS') + ` stop-failure-note: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
