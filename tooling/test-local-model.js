#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/local-model.js, the router that sends
// a step to a local model only where the offload eval passed it.
// Run: node tooling/test-local-model.js
// Exits 1 on any failure; 0 if all pass.
//
// WHAT MUST HOLD.
//   1. A route the table gives to Claude or to code never runs the helper.
//   2. The large model is attach-only: with its endpoint down, the helper is
//      not even run, so nothing can start it.
//   3. Every way the local path can break (no config, missing helper, helper
//      exit 3, crash, timeout, empty answer) exits 3, never 1. A caller treats
//      3 as "do it yourself", so an absent model never fails a gate.
//   4. A working helper's answer reaches stdout with exit 0, stdin included.
//
// THE SEAM. Every case runs the shipped CLI as a subprocess against a fake
// helper this suite writes. The fake records each call in a marker file, so
// "the helper did not run" is read from the disk, not inferred from output.
// AUTODEV_LOCAL_CONFIG points at a temp path, so nothing reads this machine's
// real config or reaches its real models. The "large model up" case uses an
// HTTP server on an ephemeral port; the "down" case uses a port that server
// just released.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'local-model.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-'));
const marker = path.join(tmp, 'calls.jsonl');
const helper = path.join(tmp, 'local.mjs');
fs.writeFileSync(helper, `
import fs from 'node:fs';
const input = process.argv[3] === '-' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), input, big: process.env.BIG_LLM_URL }) + '\\n');
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'ok') console.log(process.argv[2] === 'commit' ? 'feat(core): fake answer for commit\\n\\nBody.' : 'ACTION\\nfake answer for ' + process.argv[2]);
else if (mode === 'labels') console.log('**LEAD**\\n**ACTION**\\n**FYI**\\n**SPAM**\\n\\n**ACTION**\\nThanks.');
else if (mode === 'bold') console.log('**ACTION**\\n\\nReply draft.');
else if (mode === 'badsubject') console.log('Updated some files\\n\\nBody.');
else if (mode === 'echo') console.log('got:' + input.trim());
else if (mode === 'handback') { console.error('local model failed: HTTP 500'); process.exitCode = 3; }
else if (mode === 'crash') throw new Error('boom');
else if (mode === 'empty') {}
else if (mode === 'hang') setTimeout(() => {}, 60000);
`);
const configOk = path.join(tmp, 'local-model.json');
fs.writeFileSync(configOk, JSON.stringify({ helper }));
const configMissingHelper = path.join(tmp, 'missing.json');
fs.writeFileSync(configMissingHelper, JSON.stringify({ helper: path.join(tmp, 'nope.mjs') }));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
}

function calls() {
  try { return fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

function runCli(args, { env = {}, stdin } = {}) {
  try { fs.rmSync(marker, { force: true }); } catch { /* absent */ }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AUTODEV_LOCAL_CONFIG: configOk, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, calls: calls() }));
    child.stdin.end(stdin || '');
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  const up = await listen((req, res) => { res.writeHead(req.url === '/v1/models' ? 200 : 404); res.end('{}'); });
  const upUrl = `http://127.0.0.1:${up.address().port}`;
  const gone = await listen(() => {});
  const downUrl = `http://127.0.0.1:${gone.address().port}`;
  await new Promise((r) => gone.close(r));

  console.log('routing table');
  let r = await runCli(['--help']);
  check('--help exits 0 and names the exit codes', r.code === 0 && /Exit 3/.test(r.stdout), r.stdout);
  r = await runCli(['routes']);
  for (const t of ['triage', 'browse', 'locate', 'commit', 'receipt', 'copy', 'flake', 'status', 'coding']) {
    check(`routes lists ${t}`, new RegExp(`^${t}\\s`, 'm').test(r.stdout), r.stdout);
  }
  check('routes sends receipt to code', /^receipt\s+code\b/m.test(r.stdout));

  console.log('claude and code routes never run the helper');
  for (const t of ['copy', 'flake', 'status', 'coding']) {
    r = await runCli([t, 'x']);
    check(`${t} exits 3 with no helper call`, r.code === 3 && r.calls.length === 0 && /stays on Claude/.test(r.stderr), `code ${r.code}, calls ${r.calls.length}, ${r.stderr}`);
  }
  r = await runCli(['receipt', 'r.log']);
  check('receipt exits 3, names merge-lock, no helper call', r.code === 3 && r.calls.length === 0 && /merge-lock/.test(r.stderr), `code ${r.code}, calls ${r.calls.length}, ${r.stderr}`);

  console.log('small routes');
  r = await runCli(['triage', '-'], { stdin: 'Supabase alert: database size limit' });
  check('triage answer reaches stdout with exit 0', r.code === 0 && /fake answer for triage/.test(r.stdout), `code ${r.code}, ${r.stdout}${r.stderr}`);
  check('triage passes stdin through to the helper', r.calls.length === 1 && /Supabase alert/.test(r.calls[0].input), JSON.stringify(r.calls));
  r = await runCli(['browse', '-', 'what', 'is', 'the', 'price'], { stdin: 'Price: 5 EUR', env: { FAKE_MODE: 'echo' } });
  check('browse passes the question as arguments', r.code === 0 && r.calls[0] && r.calls[0].argv.join(' ') === 'browse - what is the price', JSON.stringify(r.calls));

  console.log('answer shape is checked in code');
  r = await runCli(['triage', '-'], { env: { FAKE_MODE: 'labels' } });
  check('triage naming several labels hands back', r.code === 3 && /names 4 labels/.test(r.stderr) && r.stdout === '', `code ${r.code}, ${r.stderr}`);
  r = await runCli(['triage', '-'], { env: { FAKE_MODE: 'bold' } });
  check('a bold single label is normalised to line 1', r.code === 0 && r.stdout.split('\n')[0] === 'ACTION' && /Reply draft/.test(r.stdout), JSON.stringify(r.stdout));
  r = await runCli(['commit', '-'], { stdin: 'd', env: { FAKE_MODE: 'badsubject', AUTODEV_LOCAL_BIG_URL: upUrl } });
  check('commit without a conventional subject hands back', r.code === 3 && /conventional/.test(r.stderr), `code ${r.code}, ${r.stderr}`);

  console.log('large routes are attach-only');
  r = await runCli(['commit', '-'], { stdin: 'diff', env: { AUTODEV_LOCAL_BIG_URL: downUrl } });
  check('commit with the 27B down exits 3 and never runs the helper', r.code === 3 && r.calls.length === 0 && /attach-only/.test(r.stderr), `code ${r.code}, calls ${r.calls.length}, ${r.stderr}`);
  r = await runCli(['locate', tmp, 'where', 'is', 'x'], { env: { AUTODEV_LOCAL_BIG_URL: downUrl } });
  check('locate with the 27B down exits 3 and never runs the helper', r.code === 3 && r.calls.length === 0, `code ${r.code}, calls ${r.calls.length}`);
  r = await runCli(['commit', '-'], { stdin: 'diff --git a b', env: { AUTODEV_LOCAL_BIG_URL: upUrl } });
  check('commit with the 27B up runs the helper and answers', r.code === 0 && r.calls.length === 1 && /fake answer for commit/.test(r.stdout), `code ${r.code}, ${r.stderr}`);
  check('the helper is told the same 27B URL that was checked', r.calls[0] && r.calls[0].big === upUrl, JSON.stringify(r.calls));

  console.log('every broken local path hands back with exit 3');
  r = await runCli(['triage', '-'], { env: { AUTODEV_LOCAL_CONFIG: path.join(tmp, 'absent.json') } });
  check('no config: exit 3', r.code === 3 && /no helper configured/.test(r.stderr), `code ${r.code}, ${r.stderr}`);
  r = await runCli(['triage', '-'], { env: { AUTODEV_LOCAL_CONFIG: configMissingHelper } });
  check('helper path missing: exit 3', r.code === 3 && /helper not found/.test(r.stderr), `code ${r.code}, ${r.stderr}`);
  r = await runCli(['triage', '-'], { env: { AUTODEV_LOCAL_HELPER: helper, AUTODEV_LOCAL_CONFIG: path.join(tmp, 'absent.json') } });
  check('AUTODEV_LOCAL_HELPER wins over an absent config', r.code === 0 && r.calls.length === 1, `code ${r.code}, ${r.stderr}`);
  for (const [mode, re] of [['handback', /exited 3: local model failed/], ['crash', /exited 1/], ['empty', /nothing/]]) {
    r = await runCli(['triage', '-'], { env: { FAKE_MODE: mode } });
    check(`helper ${mode}: exit 3, reason on stderr`, r.code === 3 && re.test(r.stderr) && r.stdout === '', `code ${r.code}, ${r.stderr}`);
  }
  r = await runCli(['triage', '-'], { env: { FAKE_MODE: 'hang', AUTODEV_LOCAL_TIMEOUT_MS: '1500' } });
  check('helper past its budget: exit 3', r.code === 3 && /ran past 1500 ms/.test(r.stderr), `code ${r.code}, ${r.stderr}`);

  console.log('called wrongly');
  r = await runCli(['summarize', 'x']);
  check('unknown task exits 2', r.code === 2, `code ${r.code}`);
  r = await runCli(['browse', '-']);
  check('browse without a question exits 2', r.code === 2, `code ${r.code}`);

  up.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed (population: ${pass + fail} checks)`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
