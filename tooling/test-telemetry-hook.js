#!/usr/bin/env node
// Tests for hooks/telemetry.js — verifies opt-IN gating, JSONL logging, and privacy safety.
// Run: node tooling/test-telemetry-hook.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'telemetry.js');

// Run in a temp dir so we don't pollute .claude/reports of the repo
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
process.chdir(TMP);

// Telemetry is opt-in, so the default harness run enables it explicitly. Cases
// that test the gate pass their own AUTODEV_TELEMETRY value.
function run(payload, env = {}) {
  const input = JSON.stringify(payload);
  return spawnSync('node', [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AUTODEV_TELEMETRY: '1', ...env }
  });
}

function lastEvent() {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(TMP, '.claude', 'reports', `telemetry-${day}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

const cases = [];

// 1. Basic event — file + fields
let r = run({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_output: 'file1\nfile2\n', session_id: 'sess-abc', cwd: TMP });
cases.push(['basic event exit 0', r.status === 0]);
const evt1 = lastEvent();
cases.push(['event has tool field', evt1?.tool === 'Bash']);
cases.push(['event has timestamp', typeof evt1?.ts === 'string' && evt1.ts.includes('T')]);
cases.push(['event has cwd', typeof evt1?.cwd === 'string']);
cases.push(['event has input_size', typeof evt1?.input_size === 'number' && evt1.input_size > 0]);
cases.push(['event has output_size', typeof evt1?.output_size === 'number']);
cases.push(['event has ok=true for normal output', evt1?.ok === true]);
// Regression: this was read from AUTO_DEV_SESSION_ID, which nothing ever set,
// so every event in every log was written with session: null.
cases.push(['event carries the payload session id', evt1?.session === 'sess-abc']);

// 2. No tool input/output contents leaked
const secretInput = { command: 'export STRIPE_SECRET=sk_live_real_secret_value_12345' };
run({ tool_name: 'Bash', tool_input: secretInput, tool_output: 'ok' });
const evt2 = lastEvent();
const serialized = JSON.stringify(evt2);
cases.push(['no secret value in log', !serialized.includes('sk_live_real_secret_value_12345')]);
cases.push(['no command content in log', !serialized.includes('STRIPE_SECRET')]);

// 3. Error-looking output → ok=false
run({ tool_name: 'Read', tool_input: { file_path: '/missing' }, tool_output: '[error] file not found' });
const evt3 = lastEvent();
cases.push(['error output → ok=false', evt3?.ok === false]);

// 4. Opt-in gate: nothing is recorded unless AUTODEV_TELEMETRY=1.
const day = new Date().toISOString().slice(0, 10);
const todayFile = path.join(TMP, '.claude', 'reports', `telemetry-${day}.jsonl`);
const countLines = () => fs.readFileSync(todayFile, 'utf8').trim().split('\n').length;

let linesBefore = countLines();
r = run({ tool_name: 'Bash', tool_input: { command: 'x' } }, { AUTODEV_TELEMETRY: '' });
cases.push(['not opted in → exit 0', r.status === 0]);
cases.push(['not opted in → no line written', linesBefore === countLines()]);

// The pre-8.0 opt-OUT variable still wins for anyone who set it.
linesBefore = countLines();
r = run({ tool_name: 'Bash', tool_input: { command: 'y' } }, { CLAUDE_TELEMETRY_DISABLED: '1' });
cases.push(['explicit disable → exit 0', r.status === 0]);
cases.push(['explicit disable beats opt-in → no line written', linesBefore === countLines()]);

// 5. Malformed stdin → exit 0, no crash
r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, AUTODEV_TELEMETRY: '1' } });
cases.push(['malformed stdin → exit 0', r.status === 0]);

// 6. Unreachable OTEL endpoint → still exits cleanly (fire and forget)
r = run(
  { tool_name: 'Read', tool_input: { file_path: 'x.txt' }, tool_output: 'hi' },
  { CLAUDE_OTEL_ENDPOINT: 'http://127.0.0.1:1/nope' }  // port 1 = likely unreachable
);
cases.push(['unreachable OTEL → exit 0', r.status === 0]);

// 7. Hook speed — should complete in well under 500ms
const start = Date.now();
run({ tool_name: 'Bash', tool_input: { command: 'z' } });
const elapsed = Date.now() - start;
cases.push([`fast (<500ms): took ${elapsed}ms`, elapsed < 500]);

// Report
let pass = 0, fail = 0;
cases.forEach(([label, ok]) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  ok ? pass++ : fail++;
});
console.log(`\n${pass} passed, ${fail} failed`);

// Cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
