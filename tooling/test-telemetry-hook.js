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

// ---- the /tmp advisory ----
// It rides in this hook instead of its own because a dedicated Bash hook costs
// ~6.3 min/day here. The cases that matter are therefore about SILENCE: this
// hook prints on every tool call in the whole session, so a false positive is
// far more expensive than a missed advisory.
const advise = (payload) => {
  const r = run(payload);
  let out = null;
  try { out = JSON.parse(r.stdout || 'null'); } catch { /* asserted below */ }
  return { r, ctx: out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext };
};

const tmpFail = advise({ tool_name: 'Bash', tool_input: {},
  tool_response: "Error: Cannot find module '/tmp/ai.json'" });
check('a failed /tmp read gets the split explained', /\/tmp split|C:\tmp/.test(tmpFail.ctx || ''), String(tmpFail.ctx).slice(0, 90));
check('  and it is still recorded as a normal telemetry row', tmpFail.r.lines.length === 1);
check('  and the hook still exits 0', tmpFail.r.status === 0);

// Paired negatives. Each is a case the advisory must NOT fire on, and together
// they are why this can print from a hook that runs on every single call.
// This negative MUST carry the signature, or it passes on the signature check
// and never reaches the failed-only guard it claims to test. Verified by
// mutation: deleting `if (!failed)` turns this red. The first version used
// 'wrote /tmp/x.json ok', which matches no signature — so both guards could be
// removed and the suite stayed green.
check('a SUCCESSFUL command whose stdout CONTAINS the signature says nothing',
  advise({ tool_name: 'Bash', tool_input: {},
    tool_response: "grep found: Cannot find module '/tmp/ai.json'" }).ctx == null);
check('a failure that is NOT the /tmp split says nothing',
  advise({ tool_name: 'Bash', tool_input: {}, tool_response: 'Error: connection refused' }).ctx == null);
check('a non-Bash tool says nothing',
  advise({ tool_name: 'Read', tool_input: {}, tool_response: "Error: Cannot find module '/tmp/ai.json'" }).ctx == null);
check('the ordinary happy path prints nothing at all',
  (run({ tool_name: 'Bash', tool_input: {}, tool_response: 'ok' }).stdout || '') === '');

// ---- the advisory module, driven DIRECTLY ----
// The hook guards the call with its own `if (failed)` fast-path, which skips a
// require on the ~98% of calls that succeed. That guard SHADOWS the module's
// own, so driving the module only through the hook leaves the module's guard
// untestable — both could be deleted and the suite stayed green. Verified by
// mutation, which is the only reason this section exists.
const { adviseOnToolFailure } = require('../plugins/autodev-core/scripts/tool-failure-advisory.js');
const adviseOnTmpSplit = (t, r, f) => { const a = adviseOnToolFailure(t, r, f); return a && a.id === 'tmp-path-split' ? a.advice : null; };
const SIG = "Error: Cannot find module '/tmp/ai.json'";

check('module: advises on a failed Bash call carrying the signature',
  typeof adviseOnTmpSplit('Bash', SIG, true) === 'string');
check('module: SILENT when the same text came from a call that SUCCEEDED',
  adviseOnTmpSplit('Bash', SIG, false) === null);
check('module: silent for a non-Bash tool', adviseOnTmpSplit('Read', SIG, true) === null);
check('module: silent on a failure with no /tmp signature',
  adviseOnTmpSplit('Bash', 'Error: connection refused', true) === null);
check('module: silent when the signature is buried past the head of a long log',
  adviseOnTmpSplit('Bash', 'x'.repeat(900) + SIG, true) === null);

// shell-quoting joins the same advisory: 9 sessions in 24h, already documented,
// not falling. The negative matters more than the positive — this prints from a
// hook that runs on every call in the session.
// The "Error: Exit code N" prefix is not decoration — measured 2026-08-19,
// ALL 260 failed tool results in 24h are strings beginning "Error: ". A fixture
// without it is not a failed call and the hook correctly ignores it, which is
// how the first version of this case failed for the right reason.
const QUOTE_ERR = "Error: Exit code 2 /usr/bin/bash: -c: line 104: unexpected EOF while looking for matching quote";
check('module: advises on a quoting collapse',
  (adviseOnToolFailure('Bash', QUOTE_ERR, true) || {}).id === 'shell-quoting');
check('module: silent when the same text came from a call that SUCCEEDED',
  adviseOnToolFailure('Bash', QUOTE_ERR, false) === null);
const quoteHook = advise({ tool_name: 'Bash', tool_input: {}, tool_response: QUOTE_ERR });
check('the hook emits the quoting advisory end to end',
  /Write the script to a file/.test(quoteHook.ctx || ''), String(quoteHook.ctx).slice(0, 80));

// The browser rules are tool-agnostic, so they must be driven with a non-Bash
// tool name — a rule that only ever fired on Bash would be silently dead for the
// surface it was written for.
const CHROME_ERR = "Error: Multiple Chrome browsers are connected to this account and none has been selected";
const NAV_ERR = "Error: Failed to execute JavaScript: Inspected target navigated or closed";
check('module: a browser rule fires for an MCP browser tool, not just Bash',
  (adviseOnToolFailure('mcp__claude-in-chrome__computer', CHROME_ERR, true) || {}).id === 'browser-blocked-on-user');
check('module: names the self-destroying eval',
  (adviseOnToolFailure('mcp__claude-in-chrome__javascript_tool', NAV_ERR, true) || {}).id === 'browser-self-destroyed-eval');
check('module: browser rules stay silent on a call that SUCCEEDED',
  adviseOnToolFailure('mcp__claude-in-chrome__computer', CHROME_ERR, false) === null);
// Paired negative for the tool filter: the Bash-only rules must NOT fire for a
// browser tool, or `tools` is decorative.
check('module: a Bash-only rule does not fire for a browser tool',
  adviseOnToolFailure('mcp__claude-in-chrome__computer', "Error: Cannot find module '/tmp/x.json'", true) === null);

// The last two rules. Both are tool-agnostic: the SQL failures arrive through
// Bash (a script hitting the REST API), the schema violations through the agent
// layer, so pinning either to a tool name would make it dead on arrival.
const SQL_ERR = "Error: Exit code 127 HTTP 400: Failed to run sql query: ERROR: 42703: column anon_fingerprint does not exist";
const SCHEMA_ERR = "Error: Output does not match required schema: root: must NOT have additional properties";
check('module: names a guessed column',
  (adviseOnToolFailure('Bash', SQL_ERR, true) || {}).id === 'sql-schema-guess');
check('module: names a subagent schema mismatch',
  (adviseOnToolFailure('Task', SCHEMA_ERR, true) || {}).id === 'agent-schema-violation');
check('module: both stay silent on a call that SUCCEEDED',
  adviseOnToolFailure('Bash', SQL_ERR, false) === null
  && adviseOnToolFailure('Task', SCHEMA_ERR, false) === null);

// An unreachable exporter must not delay or fail the call.
const t0 = Date.now();
const slow = run({ tool_name: 'Read', tool_input: { file_path: 'x' } }, { CLAUDE_OTEL_ENDPOINT: 'http://127.0.0.1:9/none' });
check('an unreachable OTLP endpoint still exits 0', slow.status === 0, 'exit ' + slow.status);
check('  and still writes locally', slow.lines.length === 1);
check('  and does not hang the tool call', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);

// ---- where the report is written ----
//
// The hook used to build its path from process.cwd(), which follows the
// session's SHELL. A Bash call that cds anywhere left a .claude/reports/ there,
// and one landed inside plugins/autodev-core/skills/ and broke validate. These
// assert the report lands once per repo, at the repo root, regardless of where
// the shell or the payload starts.
{
  const mk = (...parts) => { const d = path.join(...parts); fs.mkdirSync(d, { recursive: true }); return d; };
  const reportsIn = (root) => {
    const dir = path.join(root, '.claude', 'reports');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };
  const fire = (spawnCwd, payloadCwd) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      tool_response: 'y',
      ...(payloadCwd === undefined ? {} : { cwd: payloadCwd }),
    }),
    encoding: 'utf8',
    cwd: spawnCwd,
    env: { ...process.env, CLAUDE_TELEMETRY_DISABLED: '', CLAUDE_OTEL_ENDPOINT: '' },
  });

  // A repo whose shell has wandered into a subdirectory.
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telem-repo-')));
  mk(repo, '.git');
  const deep = mk(repo, 'plugins', 'core', 'skills');

  // Control: the fixture is a repo as far as the hook is concerned.
  check('report-root: the .git fixture exists (control)', fs.existsSync(path.join(repo, '.git')));

  let r = fire(deep, deep);
  check('a payload deep in a repo writes at the repo ROOT', r.status === 0 && reportsIn(repo).length === 1);
  check('  and writes nothing into the subdirectory', reportsIn(deep).length === 0);

  // The shell wandering must not move the report: payload cwd is the session's.
  const repo2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telem-repo2-')));
  mk(repo2, '.git');
  const stray = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telem-stray-')));
  r = fire(stray, repo2);
  check('a wandering shell does not move the report', r.status === 0 && reportsIn(repo2).length === 1);
  check('  and leaves the wandered-into directory clean', reportsIn(stray).length === 0);

  // No repo above it: the start directory is used, unchanged.
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telem-bare-')));
  r = fire(bare, bare);
  check('with no repo above it, the start directory is used', r.status === 0 && reportsIn(bare).length === 1);

  // No payload cwd at all — the 7.x shape must still write somewhere valid.
  const legacy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telem-legacy-')));
  r = fire(legacy, undefined);
  check('a payload with no cwd still writes, from process.cwd()',
    r.status === 0 && reportsIn(legacy).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
