#!/usr/bin/env node
// local-model.js - send a step to a local model when the routing table says it
// can do that step, and hand it back otherwise.
//
// WHY. A local Qwen answers some mechanical reads as well as Claude does, at no
// quota cost. An offload eval measured each task type on a 4B model (loaded per
// task) and a 27B model (run by the operator, attach-only). ROUTES below is that
// table. A step goes local only where the eval passed it on every case.
//
// THE RULE FOR A NEW ROW. A step you can describe without the words judge,
// decide, assess or summarize is code, not a model call. A merge-lock receipt
// check is the example: it has one right answer, and merge-lock.js already
// computes it (sha line, closing `gate-receipt: exit 0`, tree match). A model
// pass there adds cost and variance and catches nothing, so `receipt` routes to
// code.
//
// THE HELPER. The model call itself is made by a machine-local helper,
// `local.mjs`, which owns the prompts, the endpoints and loading the small
// model. Its path is machine state, so it never lives in this repo: it comes
// from $AUTODEV_LOCAL_HELPER or from {"helper": "<path>"} in
// <claude dir>/autodev/local-model.json ($AUTODEV_LOCAL_CONFIG overrides).
// Contract: `node <helper> <task> <args...>`, exit 0 with the answer on stdout,
// exit 3 for "use Claude".
//
// THE LARGE MODEL IS ATTACH-ONLY. Before a large-model route this script checks
// the endpoint's /v1/models itself, and when it does not answer it hands back
// without running the helper. Nothing here starts the large model.
//
// NEVER A RED. A missing helper, a down endpoint, a timeout, a crash or an
// empty answer all exit 3, the same as a route that belongs to Claude. A caller
// treats exit 3 as "do it yourself", so a gate or a skill never fails because
// the local model is absent.
//
// THE CALL LOG. Every routed call appends one JSON line to
// <claude dir>/autodev/local-model-calls.jsonl ($AUTODEV_LOCAL_LOG overrides):
// ts, task, route, model, outcome (ok or fallback), latencyMs, and on a
// fallback, fallbackTo (claude or code) and reason. It exists to measure what
// the local models save, so `local-model.js stats` reads it back with its
// population. A log that cannot be written costs a stderr line, never the
// answer or the exit code.
//
// EXIT: 0 the local answer is on stdout; 3 hand back (stderr says why);
//       2 this script was called wrongly.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// route: 'small' (4B, loaded per task), 'big' (27B, attach-only), 'claude', 'code'.
// measured: the offload eval, 2026-11-05 [measured, qwen-eval session].
const ROUTES = {
  triage: { route: 'small', args: '<file|->', measured: '4B 4/4, 27B 4/4', why: 'label an inbox item LEAD, ACTION, FYI or SPAM' },
  browse: { route: 'small', args: '<file|-> <question>', measured: '4B 3/3, 27B 3/3', why: 'pull a fact out of page text' },
  locate: { route: 'big', args: '<repo-dir> <question>', measured: '27B 4/4, 4B 2/4', why: 'find where code lives' },
  commit: { route: 'big', args: '<diff-file|->', measured: '27B 3/3, 4B 1/3', why: 'draft a commit message for review' },
  receipt: { route: 'code', measured: '4B 5/5, 27B 5/5', why: 'merge-lock.js validates the receipt in code' },
  copy: { route: 'claude', measured: '27B 4/5, 4B 3/5', why: 'RO/EN copy' },
  flake: { route: 'claude', measured: '27B 4/6, 4B 3/6', why: 'gate flake or real' },
  status: { route: 'claude', measured: '27B 2/3, 4B 2/3', why: 'status lines' },
  coding: { route: 'claude', measured: '27B 2/3, 4B 1/3', why: 'writing code' },
};

// THE ANSWER'S SHAPE IS CHECKED IN CODE. A caller reads line 1 of a triage
// answer as the label, so an answer that names several labels would be filed
// under whichever came first. [measured 2026-11-05] the 4B answered a database
// size alert with LEAD, ACTION, FYI and SPAM on their own lines before settling
// on ACTION. A malformed answer hands back; a well-formed one is normalised so
// line 1 is the label alone.
const LABELS = ['LEAD', 'ACTION', 'FYI', 'SPAM'];
const bare = (line) => line.replace(/[*_`#>:.\s]/g, '').toUpperCase();
const SHAPES = {
  triage(text) {
    const lines = text.split(/\r?\n/);
    const found = [...new Set(lines.map(bare).filter((l) => LABELS.includes(l)))];
    if (found.length !== 1) return { ok: false, why: found.length ? `answer names ${found.length} labels (${found.join(', ')})` : 'answer names no label' };
    const rest = lines.filter((l) => !LABELS.includes(bare(l))).join('\n').trim();
    return { ok: true, text: rest ? `${found[0]}\n${rest}` : found[0] };
  },
  commit(text) {
    const subject = text.split(/\r?\n/)[0].trim();
    if (!/^[a-z]+(\([\w./-]+\))?!?: \S/.test(subject) || subject.length > 72) return { ok: false, why: 'subject is not a conventional commit line of at most 72 characters' };
    return { ok: true, text };
  },
};

const USAGE = [
  'usage: node local-model.js <task> <args...>',
  '       node local-model.js routes',
  '       node local-model.js stats [--days=7]',
  '',
  'Runs a task on a local model when the routing table sends it there.',
  'Exit 0: the answer is on stdout. Exit 3: hand back, do the step yourself',
  '(stderr says why). Exit 2: called wrongly. Absent models never exit 1.',
  '',
  'Environment:',
  '  AUTODEV_LOCAL_HELPER   path to the machine helper local.mjs',
  '  AUTODEV_LOCAL_CONFIG   config file, default <claude dir>/autodev/local-model.json',
  '  AUTODEV_LOCAL_BIG_URL  large-model base URL, default $BIG_LLM_URL or http://127.0.0.1:8080',
  '  AUTODEV_LOCAL_TIMEOUT_MS  helper budget, default 330000',
  '  AUTODEV_LOCAL_LOG      call log, default <claude dir>/autodev/local-model-calls.jsonl',
].join('\n');

function routesTable() {
  const rows = ['task     route   measured           what'];
  for (const [task, r] of Object.entries(ROUTES)) {
    rows.push(`${task.padEnd(8)} ${r.route.padEnd(7)} ${r.measured.padEnd(18)} ${r.why}`);
  }
  rows.push('', 'small = 4B, loaded per task. big = 27B, used only when already running.',
    'claude and code exit 3 at once: the caller does the step.');
  return rows.join('\n');
}

function configPath(env) {
  return env.AUTODEV_LOCAL_CONFIG || path.join(os.homedir(), '.claude', 'autodev', 'local-model.json');
}

/** The helper path, or null with the reason. Never throws. */
function resolveHelper(env) {
  let helper = env.AUTODEV_LOCAL_HELPER || '';
  let source = 'AUTODEV_LOCAL_HELPER';
  if (!helper) {
    const cfg = configPath(env);
    source = cfg;
    try {
      const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      helper = parsed && typeof parsed.helper === 'string' ? parsed.helper : '';
    } catch (e) {
      return { helper: null, reason: e.code === 'ENOENT' ? `no helper configured (${cfg} absent)` : `config unreadable: ${e.message}` };
    }
    if (!helper) return { helper: null, reason: `no "helper" in ${cfg}` };
  }
  if (!fs.existsSync(helper)) return { helper: null, reason: `helper not found at the path from ${source}` };
  return { helper, reason: null };
}

async function bigIsUp(baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Decide and run one task. Returns { code, stdout, reason, route } and never
 * throws: every failure of the local path becomes code 3.
 */
async function run(argv, env, stdinText) {
  const [task, ...rest] = argv;
  const spec = ROUTES[task];
  if (!spec) return { code: 2, reason: `unknown task "${task}"\n${USAGE}` };
  if (spec.route === 'claude') return { code: 3, route: spec.route, reason: `${task} stays on Claude (${spec.why}, eval ${spec.measured})` };
  if (spec.route === 'code') return { code: 3, route: spec.route, reason: `${task} is code, not a model call: ${spec.why}` };
  const needs = spec.args.split(' ').length;
  if (rest.length < needs) return { code: 2, reason: `${task} needs ${spec.args}` };

  const bigUrl = env.AUTODEV_LOCAL_BIG_URL || env.BIG_LLM_URL || 'http://127.0.0.1:8080';
  if (spec.route === 'big' && !(await bigIsUp(bigUrl))) {
    return { code: 3, route: spec.route, reason: '27B not running; it is attach-only, so nothing was started' };
  }
  const { helper, reason } = resolveHelper(env);
  if (!helper) return { code: 3, route: spec.route, reason };

  const timeout = Number(env.AUTODEV_LOCAL_TIMEOUT_MS) || 330000;
  const res = spawnSync(process.execPath, [helper, task, ...rest], {
    input: rest[0] === '-' ? stdinText : undefined,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 16 << 20,
    env: { ...env, BIG_LLM_URL: bigUrl },
  });
  if (res.error) {
    const why = res.error.code === 'ETIMEDOUT' ? `helper ran past ${timeout} ms` : `helper did not run: ${res.error.message}`;
    return { code: 3, route: spec.route, reason: why };
  }
  const out = String(res.stdout || '').trim();
  if (res.status === 0 && out) {
    const shape = SHAPES[task] ? SHAPES[task](out) : { ok: true, text: out };
    if (!shape.ok) return { code: 3, route: spec.route, reason: `answer rejected: ${shape.why}` };
    return { code: 0, route: spec.route, stdout: shape.text };
  }
  const tail = String(res.stderr || '').trim().split('\n').slice(-1)[0] || '';
  const why = res.status === 0 ? 'helper answered with nothing' : `helper exited ${res.status}${tail ? `: ${tail}` : ''}`;
  return { code: 3, route: spec.route, reason: why };
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === 'routes') {
    console.log(routesTable());
    return 0;
  }
  if (argv[0] === 'stats') {
    const days = Number((argv.find((a) => a.startsWith('--days=')) || '').slice(7)) || 7;
    console.log(stats(readLog(logPath(process.env)), days, Date.now()));
    return 0;
  }
  const spec = ROUTES[argv[0]];
  const stdinText = spec && spec.route !== 'claude' && spec.route !== 'code' && argv[1] === '-' ? readStdin() : undefined;
  const started = Date.now();
  const r = await run(argv, process.env, stdinText);
  if (r.code !== 2) {
    const why = logCall(process.env, record(argv[0], r, Date.now() - started));
    if (why) process.stderr.write(`[local-model] call log not written: ${why}\n`);
  }
  if (r.stdout) process.stdout.write(r.stdout + '\n');
  if (r.reason) process.stderr.write(`[local-model] ${r.code === 3 ? 'hand back: ' : ''}${r.reason}\n`);
  return r.code;
}

const MODEL_OF = { small: '4B', big: '27B' };

function logPath(env) {
  return env.AUTODEV_LOCAL_LOG || path.join(os.homedir(), '.claude', 'autodev', 'local-model-calls.jsonl');
}

/** One log line for one routed call. */
function record(task, r, latencyMs) {
  const local = r.route === 'small' || r.route === 'big';
  const rec = { ts: new Date().toISOString(), task, route: r.route, model: MODEL_OF[r.route] || null, outcome: r.code === 0 ? 'ok' : 'fallback', latencyMs };
  if (r.code !== 0) {
    rec.fallbackTo = r.route === 'code' ? 'code' : 'claude';
    rec.attempted = local;
    rec.reason = String(r.reason || '').slice(0, 300);
  }
  return rec;
}

/** Append one record. Returns null, or why it could not be written. Never throws. */
function logCall(env, rec) {
  try {
    const file = logPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return null;
  } catch (e) {
    return e.message;
  }
}

function readLog(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { file, missing: e.code === 'ENOENT', rows: [], bad: 0 }; }
  const rows = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o.task === 'string' && (o.outcome === 'ok' || o.outcome === 'fallback') && !Number.isNaN(Date.parse(o.ts))) rows.push(o);
      else bad++;
    } catch { bad++; }
  }
  return { file, missing: false, rows, bad };
}

/** The saving, with the population that produced it. */
function stats(log, days, now) {
  const since = now - days * 864e5;
  const rows = log.rows.filter((o) => Date.parse(o.ts) >= since);
  const head = `${rows.length} call(s) in the last ${days} day(s) from ${log.file}` +
    (log.missing ? ' (file absent)' : '') + (log.bad ? `, ${log.bad} unparseable line(s)` : '');
  if (!rows.length) return head;
  const by = {};
  for (const o of rows) {
    const t = by[o.task] || (by[o.task] = { ok: 0, fallback: 0, attempted: 0, ms: [] });
    t[o.outcome]++;
    if (o.outcome === 'ok' || o.attempted) { t.attempted++; if (Number.isFinite(o.latencyMs)) t.ms.push(o.latencyMs); }
  }
  const median = (a) => { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); const m = s[Math.floor(s.length / 2)]; return m < 1000 ? `${m}ms` : `${Math.round(m / 100) / 10}s`; };
  const lines = [head, '', 'task     ok  fallback  local tries  median latency'];
  for (const [task, t] of Object.entries(by)) {
    lines.push(`${task.padEnd(8)} ${String(t.ok).padStart(3)}  ${String(t.fallback).padStart(8)}  ${String(t.attempted).padStart(11)}  ${median(t.ms)}`);
  }
  const ok = rows.filter((o) => o.outcome === 'ok').length;
  const reasons = {};
  for (const o of rows) if (o.outcome === 'fallback' && o.attempted) reasons[o.reason] = (reasons[o.reason] || 0) + 1;
  lines.push('', `${ok} step(s) answered locally, ${(ok / days).toFixed(1)} a day: reads Claude did not make.`);
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) lines.push('', 'local tries that fell back:', ...top.map(([r, n]) => `  ${n}x ${r}`));
  return lines.join('\n');
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    // A bug in this script is still not a reason to fail the caller's step.
    process.stderr.write(`[local-model] hand back: internal error: ${e && e.message}\n`);
    process.exitCode = 3;
  });
}

module.exports = { ROUTES, run, resolveHelper, routesTable, record, readLog, stats };
