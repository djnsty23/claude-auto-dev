#!/usr/bin/env node
// Tests for hooks/telemetry.js — verifies JSONL logging, privacy safety, and opt-out.
// Run: node scripts/test-telemetry-hook.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'telemetry.js');

// Run in a temp dir so we don't pollute .claude/reports of the repo
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
process.chdir(TMP);

function run(payload, env = {}) {
  const input = JSON.stringify(payload);
  return spawnSync('node', [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env }
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
let r = run({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_output: 'file1\nfile2\n' });
cases.push(['basic event exit 0', r.status === 0]);
const evt1 = lastEvent();
cases.push(['event has tool field', evt1?.tool === 'Bash']);
cases.push(['event has timestamp', typeof evt1?.ts === 'string' && evt1.ts.includes('T')]);
cases.push(['event has cwd', typeof evt1?.cwd === 'string']);
cases.push(['event has input_size', typeof evt1?.input_size === 'number' && evt1.input_size > 0]);
cases.push(['event has output_size', typeof evt1?.output_size === 'number']);
cases.push(['event has ok=true for normal output', evt1?.ok === true]);

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

// 4. CLAUDE_TELEMETRY_DISABLED=1 → no write
const prevCount = fs.readdirSync(path.join(TMP, '.claude', 'reports')).length;
r = run({ tool_name: 'Bash', tool_input: { command: 'x' } }, { CLAUDE_TELEMETRY_DISABLED: '1' });
cases.push(['disabled → exit 0', r.status === 0]);
// Re-count lines in today's file — should be same as before
const day = new Date().toISOString().slice(0, 10);
const todayFile = path.join(TMP, '.claude', 'reports', `telemetry-${day}.jsonl`);
const linesBefore = fs.readFileSync(todayFile, 'utf8').trim().split('\n').length;
r = run({ tool_name: 'Bash', tool_input: { command: 'y' } }, { CLAUDE_TELEMETRY_DISABLED: '1' });
const linesAfter = fs.readFileSync(todayFile, 'utf8').trim().split('\n').length;
cases.push(['disabled → no new line written', linesBefore === linesAfter]);

// 5. Malformed stdin → exit 0, no crash
r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
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
