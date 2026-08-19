#!/usr/bin/env node
// Suite for hooks/telemetry.js.
//
// Two properties carry the weight. First, PRIVACY: the hook's whole claim is
// that it records sizes and never content, and that claim is worth an assertion
// rather than a comment — it is the reason this is safe to leave enabled in a
// repo that handles credentials. The case below feeds a recognisable secret
// through every field a tool call can carry and greps the written line for it.
//
// Second, NEVER BLOCKING: a PostToolUse hook that exits non-zero, or prints,
// costs something on every single tool call. Both are asserted on the failure
// paths, not just the happy one.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'telemetry.js');
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

let seq = 0;
function run(payload, env = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'telem-' + seq++ + '-'));
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, CLAUDE_TELEMETRY_DISABLED: '', CLAUDE_OTEL_ENDPOINT: '', ...env },
  });
  const dir = path.join(cwd, '.claude', 'reports');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const lines = files.flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean));
  return { ...r, files, lines, cwd };
}

console.log('test-telemetry-hook');

// Every payload below uses the key names the CLI actually sends. The suite used
// to hand-feed `tool_output`/`tool_error`, which the CLI has never sent — so the
// error case asserted `ok === false` against a shape that does not exist and was
// green while the field was dead in 878/878 real rows. A fixture you invent
// cannot test a contract you got wrong; these come from the payload the binary
// builds: { tool_name, tool_input, tool_response, tool_use_id, duration_ms, ... }

// ---- happy path ----
const ok = run({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: 'a\nb\n', duration_ms: 42, session_id: 'sess-abc' });
check('exits 0', ok.status === 0, 'exit ' + ok.status);
check('writes exactly one JSONL line', ok.lines.length === 1, JSON.stringify(ok.lines));
check('the file is named for today', ok.files[0] === `telemetry-${new Date().toISOString().slice(0, 10)}.jsonl`, ok.files[0]);

let ev = {};
try { ev = JSON.parse(ok.lines[0]); } catch { /* reported below */ }
check('the line is valid JSON with the documented fields',
  ['ts', 'session', 'cwd', 'tool', 'input_size', 'output_size', 'duration_ms', 'ok'].every((k) => k in ev), JSON.stringify(ev));
check('records the tool name', ev.tool === 'Bash', ev.tool);
check('records sizes as numbers', typeof ev.input_size === 'number' && typeof ev.output_size === 'number');
// The regression guard. `output_size` was 0 on every row ever written here
// because the hook read a key the CLI does not send. Reverting to `tool_output`
// turns this red, which the old suite could not do.
check('output_size is measured from tool_response, not a 7.x key name',
  ev.output_size === 'a\nb\n'.length, String(ev.output_size));
check('duration_ms is carried through from the payload', ev.duration_ms === 42, String(ev.duration_ms));
// The regression this port exists to fix: 7.x read an env var 8.x never sets,
// so every event on this machine recorded a null session.
check('session comes from the hook payload, not a dead env var', ev.session === 'sess-abc', String(ev.session));
check('a hook with nothing to say is silent on both streams',
  (ok.stdout || '') === '' && (ok.stderr || '') === '', JSON.stringify({ o: ok.stdout, e: ok.stderr }));

// ---- privacy: the load-bearing property ----
const SECRET = 'sk-live-CANARY-51N3z9';
const priv = run({
  tool_name: 'Bash',
  tool_input: { command: `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com`, secret: SECRET },
  tool_response: `response contained ${SECRET}`,
  session_id: 'sess-priv',
});
check('no tool CONTENT reaches the log', !priv.lines.join('\n').includes(SECRET), priv.lines.join('\n').slice(0, 120));
check('  but the call was still recorded', priv.lines.length === 1);
check('  and its size reflects the content it did not log', JSON.parse(priv.lines[0] || '{}').input_size > SECRET.length);

// ---- failure paths must not block ----
const bad = run('this is not json');
check('unparseable input exits 0', bad.status === 0, 'exit ' + bad.status);
check('unparseable input writes nothing', bad.lines.length === 0);
check('unparseable input is silent', (bad.stderr || '') === '', bad.stderr);

const off = run({ tool_name: 'Bash', tool_input: {} }, { CLAUDE_TELEMETRY_DISABLED: '1' });
check('CLAUDE_TELEMETRY_DISABLED=1 writes nothing', off.lines.length === 0 && off.status === 0);
// Paired positive: without the flag the same payload DOES write, so the case
// above cannot be passing because the hook is broken for every input.
const on = run({ tool_name: 'Bash', tool_input: {} });
check('  and the same payload without the flag does write', on.lines.length === 1);

// ---- ok:false, against the shape the CLI really sends ----
// This is the assertion the old suite believed it was making. `ok` is the only
// field that answers "did this tool call fail", and it had never once been
// false on this machine.
const okOf = (r) => JSON.parse(r.lines[0] || '{}').ok;

const errStr = run({ tool_name: 'Bash', tool_input: {}, tool_response: 'Error: File does not exist.' });
check('a string "Error: ..." response is recorded ok:false', okOf(errStr) === false, errStr.lines[0]);

const errObj = run({ tool_name: 'Bash', tool_input: {}, tool_response: { is_error: true, content: 'boom' } });
check('a structured is_error response is recorded ok:false', okOf(errObj) === false, errObj.lines[0]);

const errLegacy = run({ tool_name: 'Bash', tool_input: {}, tool_output: '[error] boom', tool_error: true });
check('  the 7.x fallback shape still resolves to ok:false', okOf(errLegacy) === false, errLegacy.lines[0]);

// Paired negatives, so the three above cannot be passing because `ok` is simply
// always false now — the mirror of the bug being fixed.
const fine = run({ tool_name: 'Bash', tool_input: {}, tool_response: 'all good' });
check('a successful call is still ok:true', okOf(fine) === true, fine.lines[0]);
// stdout that merely mentions an error is NOT a failed tool call. This is why
// the prefix test ranks below the structured flags.
const noisy = run({ tool_name: 'Bash', tool_input: {}, tool_response: { stdout: 'Error: 0 found', is_error: false } });
check('  stdout that mentions an error does not fake a failure', okOf(noisy) === true, noisy.lines[0]);

// An unreachable exporter must not delay or fail the call.
const t0 = Date.now();
const slow = run({ tool_name: 'Read', tool_input: { file_path: 'x' } }, { CLAUDE_OTEL_ENDPOINT: 'http://127.0.0.1:9/none' });
check('an unreachable OTLP endpoint still exits 0', slow.status === 0, 'exit ' + slow.status);
check('  and still writes locally', slow.lines.length === 1);
check('  and does not hang the tool call', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
