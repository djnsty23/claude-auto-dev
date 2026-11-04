#!/usr/bin/env node
'use strict';
/**
 * Qwen evaluation harness.
 *
 * Each task in manifest.json is a real fix commit: the parent commit is the
 * start state, the fix commit's test files are the hidden acceptance test.
 * One arm runs per invocation:
 *   a  Qwen alone, through the local OpenAI-compatible endpoint
 *   b  Qwen drafts once, then Claude reviews and fixes
 *   c  Claude alone
 * Every run appends one row to results.jsonl. The only network calls are the
 * model endpoints: the Qwen URL and the headless `claude -p` process.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
// The data dir holds manifest.json, results.jsonl and fixes.md. The public one
// here carries only this repo's tasks; tasks from private repos live in a
// private data dir passed with --data or QWEN_EVAL_DATA.
let MANIFEST; let RESULTS; let SYSTEM_PROMPT; let FIXES;
function setData(dir) {
  MANIFEST = path.join(dir, 'manifest.json');
  RESULTS = path.join(dir, 'results.jsonl');
  FIXES = path.join(dir, 'fixes.md');
  const own = path.join(dir, 'system-prompt.md');
  SYSTEM_PROMPT = fs.existsSync(own) ? own : path.join(HERE, 'system-prompt.md');
}
setData(process.env.QWEN_EVAL_DATA || HERE);

// "full" is the written task statement. "subject" is the fix commit's subject
// line alone: a terse ticket, the harder and more realistic delegation.
let BRIEF_MODE = 'full';
const briefOf = (task) => (BRIEF_MODE === 'subject' ? task.subject : task.brief);

const USAGE = `usage: node evals/qwen/run.js <command> [options]

commands:
  verify [--task <id>]          prove each acceptance test fails on the parent
                                and passes on the fix (no model call)
  run --arm a|b|c --task <id>   run one arm on one task (repeat --task, or
                                --task all), append rows to results.jsonl
  probe                         list the models the Qwen endpoint serves
  taxonomy                      rebuild fixes.md from the arm b rows
  summary                       print a per-arm table from results.jsonl

options:
  --data <dir>          dir with manifest.json, results.jsonl, fixes.md
                        (default $QWEN_EVAL_DATA or evals/qwen)
  --qwen-url <url>      default $QWEN_URL or http://127.0.0.1:8080/v1
  --qwen-model <id>     default $QWEN_MODEL or the first model the endpoint lists
  --claude-model <id>   default claude-opus-5-5
  --effort <level>      Claude effort, default medium
  --rounds <n>          fix rounds after the first attempt, default 2
  --brief full|subject  the written brief (default) or the fix commit's
                        subject line alone, a terse ticket
  --keep                keep the scratch worktree
  --budget-tokens N     stop before a task once the Claude tokens spent so far, projected over
                        the remaining tasks at the running average, would pass N
  --dry-run             print what would run, call no model
`;

function parseArgs(argv) {
  const out = { _: [], task: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['keep', 'dry-run', 'help'].includes(key)) { out[key] = true; continue; }
    const val = argv[++i];
    if (key === 'task') out.task.push(val); else out[key] = val;
  }
  return out;
}

const repoRoot = () => path.resolve(HERE, '..', '..');

function repoPath(name) {
  if (name === 'claude-auto-dev') return repoRoot();
  const base = process.env.QWEN_EVAL_REPOS || path.join(os.homedir(), 'Downloads', 'code');
  return path.join(base, name);
}

function loadManifest() {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  return m.tasks;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', error: r.error };
}

function git(cwd, args) {
  const r = sh('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.out.trim()}`);
  return r.stdout;
}

// ---------- scratch worktree ----------

function scratchRoot() {
  const d = path.join(os.tmpdir(), 'qwen-eval');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeWorktree(task, label) {
  const src = repoPath(task.repo);
  const wt = path.join(scratchRoot(), `${task.id}-${label}-${Date.now().toString(36)}`);
  git(src, ['worktree', 'add', '--detach', '--quiet', wt, task.parent]);
  // Dependencies: link the source checkout's node_modules instead of installing.
  const pkg = task.pkgDir || '.';
  const nm = path.join(src, pkg, 'node_modules');
  const link = path.join(wt, pkg, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(link)) fs.symlinkSync(nm, link, 'junction');
  return { src, wt, link };
}

function removeWorktree(h) {
  // Unlink the junction first so removal can never reach the shared node_modules.
  try { if (fs.lstatSync(h.link).isSymbolicLink()) fs.unlinkSync(h.link); } catch { /* no link */ }
  const r = sh('git', ['worktree', 'remove', '--force', h.wt], { cwd: h.src });
  if (r.code !== 0) {
    fs.rmSync(h.wt, { recursive: true, force: true });
    sh('git', ['worktree', 'prune'], { cwd: h.src });
  }
}

function readAt(h, rev, file) {
  const r = sh('git', ['show', `${rev}:${file}`], { cwd: h.wt });
  return r.code === 0 ? r.stdout : null;
}

function placeTests(h, task) {
  for (const f of task.tests) {
    const body = readAt(h, task.fix, f);
    if (body === null) throw new Error(`test ${f} missing at ${task.fix}`);
    fs.mkdirSync(path.dirname(path.join(h.wt, f)), { recursive: true });
    fs.writeFileSync(path.join(h.wt, f), body);
  }
}

function restoreTests(h, task) {
  for (const f of task.tests) {
    const body = readAt(h, task.parent, f);
    const p = path.join(h.wt, f);
    if (body === null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, body);
  }
}

function runAcceptance(h, task) {
  placeTests(h, task);
  const t0 = Date.now();
  const r = sh(task.accept, [], { cwd: path.join(h.wt, task.pkgDir || '.'), shell: true, timeout: 300000, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
  restoreTests(h, task);
  const pass = r.code === 0 && new RegExp(task.passLine, 'm').test(r.out);
  return { pass, code: r.code, ms: Date.now() - t0, tail: r.out.slice(-3000) };
}

// ---------- verify ----------

function verify(tasks) {
  let bad = 0;
  for (const task of tasks) {
    const h = makeWorktree(task, 'verify');
    try {
      const before = runAcceptance(h, task);
      for (const f of changedSource(h, task)) {
        const body = readAt(h, task.fix, f);
        if (body === null) fs.rmSync(path.join(h.wt, f), { force: true });
        else { fs.mkdirSync(path.dirname(path.join(h.wt, f)), { recursive: true }); fs.writeFileSync(path.join(h.wt, f), body); }
      }
      const after = runAcceptance(h, task);
      const ok = !before.pass && after.pass;
      if (!ok) bad++;
      console.log(`${ok ? 'OK  ' : 'BAD '} ${task.id}  parent=${before.pass ? 'pass' : 'fail'}(${before.code})  fix=${after.pass ? 'pass' : 'fail'}(${after.code})  ${after.ms}ms`);
      if (!ok) console.log(`  parent tail: ${before.tail.slice(-600).replace(/\n/g, '\n  ')}\n  fix tail: ${after.tail.slice(-900).replace(/\n/g, '\n  ')}`);
    } catch (e) {
      bad++;
      console.log(`ERR  ${task.id}  ${e.message}`);
    } finally { removeWorktree(h); }
  }
  console.log(`verified ${tasks.length - bad}/${tasks.length}`);
  return bad === 0 ? 0 : 1;
}

function changedSource(h, task) {
  const files = git(h.wt, ['diff-tree', '--no-commit-id', '--name-only', '-r', task.fix]).split('\n').filter(Boolean);
  return files.filter((f) => !task.tests.includes(f));
}

// ---------- edit blocks ----------

/**
 * Qwen answers with blocks of this shape (plain markers, no git conflict markers):
 *   ### FILE: path/to/file
 *   @@ SEARCH
 *   exact old lines
 *   @@ REPLACE
 *   new lines
 *   @@ END
 * An empty SEARCH writes REPLACE as the whole file.
 */
function parseBlocks(text) {
  const blocks = [];
  const re = /^###\s*FILE:\s*(.+?)\s*\n@@ SEARCH\n([\s\S]*?)^@@ REPLACE\n([\s\S]*?)^@@ END\s*$/gm;
  let m;
  while ((m = re.exec(text))) blocks.push({ file: m[1].replace(/^`|`$/g, ''), search: m[2], replace: m[3] });
  return blocks;
}

function applyBlocks(wt, blocks) {
  const errors = [];
  for (const b of blocks) {
    const p = path.join(wt, b.file);
    if (!path.resolve(p).startsWith(path.resolve(wt))) { errors.push(`${b.file}: outside the repo`); continue; }
    if (b.search.trim() === '') {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, b.replace);
      continue;
    }
    if (!fs.existsSync(p)) { errors.push(`${b.file}: file does not exist`); continue; }
    let body = fs.readFileSync(p, 'utf8');
    const crlf = body.includes('\r\n');
    if (crlf) body = body.replace(/\r\n/g, '\n');
    let idx = body.indexOf(b.search);
    let search = b.search;
    if (idx < 0) {
      // Tolerate trailing-whitespace drift, nothing looser.
      const norm = (s) => s.split('\n').map((l) => l.trimEnd()).join('\n');
      const nb = norm(body); const ns = norm(b.search);
      if (nb.indexOf(ns) >= 0) { body = nb; search = ns; idx = nb.indexOf(ns); }
    }
    if (idx < 0) { errors.push(`${b.file}: SEARCH text not found:\n${b.search.slice(0, 400)}`); continue; }
    body = body.slice(0, idx) + b.replace + body.slice(idx + search.length);
    fs.writeFileSync(p, crlf ? body.replace(/\n/g, '\r\n') : body);
  }
  return errors;
}

// ---------- Qwen ----------

async function qwenModel(url) {
  const r = await fetch(`${url}/models`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Qwen /models answered ${r.status}`);
  const j = await r.json();
  return j.data.map((d) => d.id);
}

async function qwenChat(cfg, messages) {
  const t0 = Date.now();
  const r = await fetch(`${cfg.qwenUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.qwenModel, messages, max_tokens: 24000, temperature: 0.6, top_p: 0.95 }),
    signal: AbortSignal.timeout(900000),
  });
  if (!r.ok) throw new Error(`Qwen chat answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return { text: j.choices[0].message.content || '', usage: j.usage || {}, ms: Date.now() - t0 };
}

function fileContext(h, task) {
  return task.files.map((f) => {
    const body = readAt(h, task.parent, f);
    return body === null ? `### ${f}\n(new file)` : `### ${f}\n\`\`\`\n${body}\n\`\`\``;
  }).join('\n\n');
}

function qwenPrompt(h, task) {
  return `Task (repo ${task.repo}):\n${briefOf(task)}\n\nRelevant files at the start state:\n\n${fileContext(h, task)}\n\n` +
    'Answer with edit blocks only, in exactly this shape, one per change:\n' +
    '### FILE: <path from the repo root>\n@@ SEARCH\n<exact lines copied from the file>\n@@ REPLACE\n<new lines>\n@@ END\n' +
    'SEARCH must match the file exactly and be unique. Keep blocks small. Do not edit test files.';
}

async function qwenAttempt(cfg, h, task, rounds) {
  const sys = fs.existsSync(SYSTEM_PROMPT) ? fs.readFileSync(SYSTEM_PROMPT, 'utf8') : 'You are a careful software engineer.';
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: qwenPrompt(h, task) }];
  const log = { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
  let firstPass = null; let accept = null; let round = 0;
  for (; round <= rounds; round++) {
    const res = await qwenChat(cfg, messages);
    log.calls++; log.ms += res.ms;
    log.promptTokens += res.usage.prompt_tokens || 0; log.completionTokens += res.usage.completion_tokens || 0;
    messages.push({ role: 'assistant', content: res.text });
    const blocks = parseBlocks(res.text);
    const errors = blocks.length ? applyBlocks(h.wt, blocks) : ['no edit blocks found in the answer'];
    accept = errors.length ? { pass: false, code: null, tail: errors.join('\n') } : runAcceptance(h, task);
    if (firstPass === null) firstPass = accept.pass;
    if (accept.pass || round === rounds) break;
    messages.push({ role: 'user', content: `That did not pass. Output:\n${accept.tail.slice(-2500)}\nSend corrected edit blocks against the files as they are now.` });
  }
  return { firstPass, pass: accept.pass, fixRounds: Math.min(round, rounds), qwen: log, tail: accept.tail.slice(-800) };
}

// ---------- Claude ----------

function claude(cfg, h, prompt, resume) {
  const args = ['-p', '--model', cfg.claudeModel, '--effort', cfg.effort, '--output-format', 'json',
    '--setting-sources', 'local', '--strict-mcp-config', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Edit,Write,Glob,Grep',
    '--disallowedTools', 'Bash,WebFetch,WebSearch,Task,Agent'];
  if (resume) args.push('--resume', resume);
  const t0 = Date.now();
  // On Windows `claude` is a .cmd shim that needs a shell. Every arg is a fixed
  // token with no spaces, so one joined command line is exact; the prompt goes on stdin.
  const win = process.platform === 'win32';
  const r = win
    ? sh(['claude', ...args].join(' '), [], { cwd: h.wt, input: prompt, timeout: 900000, shell: true })
    : sh('claude', args, { cwd: h.wt, input: prompt, timeout: 900000 });
  let j = null;
  try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
  if (!j) throw new Error(`claude -p gave no JSON (exit ${r.code}): ${r.out.slice(-400)}`);
  const u = j.usage || {};
  return {
    text: j.result || '', session: j.session_id, ms: Date.now() - t0, isError: !!j.is_error,
    tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 },
    costUsd: j.total_cost_usd || 0,
  };
}

function addTokens(acc, c) {
  acc.calls++; acc.ms += c.ms; acc.costUsd += c.costUsd;
  for (const k of Object.keys(c.tokens)) acc.tokens[k] += c.tokens[k];
}

/** `FIX: <code or NEW> | <rule> | <example>` lines from Claude's review; `FIX: none` yields nothing. */
function parseFixLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.replace(/[*`]/g, '').match(/^\s*(?:[-•]\s*)?FIX:\s*(.+)$/);
    if (!m || /^none\b/i.test(m[1].trim())) continue;
    // Fields are split on a spaced pipe only: an example can be a regex with a bare | in it.
    const parts = m[1].split(/\s+\|\s+/).map((s) => s.trim());
    if (/^(Q\d+|NEW)$/i.test(parts[0])) {
      out.push({ code: parts[0].toUpperCase(), rule: parts[1] || '', example: parts.slice(2).join(' | ') });
    } else {
      out.push({ code: 'NEW', rule: m[1].trim(), example: '' });
    }
  }
  return out;
}

function fixCodes() {
  if (!fs.existsSync(FIXES)) return '';
  return fs.readFileSync(FIXES, 'utf8').split('\n').filter((l) => /^\| Q\d+ /.test(l)).join('\n');
}

async function claudeAttempt(cfg, h, task, rounds, review) {
  const acc = { calls: 0, ms: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
  const hint = `Likely files: ${task.files.join(', ')}.`;
  let prompt;
  if (review) {
    const codes = fixCodes();
    prompt = `Task (repo ${task.repo}):\n${briefOf(task)}\n${hint}\n\n` +
      'A junior model already edited the working tree for this task. Its diff:\n```diff\n' + review + '\n```\n' +
      'Review it against the task, then fix whatever is wrong or missing, with the smallest change. You cannot run commands. Do not edit test files.\n' +
      'End your answer with one line per correction you made, in this form:\n' +
      'FIX: <code or NEW> | <rule the junior broke> | <one-line example from this diff>\n' +
      'Write FIX: none if the draft was correct as it stood.' + (codes ? `\nKnown codes:\n${codes}` : '');
  } else {
    prompt = `Task (repo ${task.repo}):\n${briefOf(task)}\n${hint}\n\nMake the change with the smallest edit. You cannot run commands. Do not edit test files.`;
  }
  let session = null; let firstPass = null; let accept = null; let round = 0; const fixes = [];
  for (; round <= rounds; round++) {
    const c = claude(cfg, h, prompt, session);
    addTokens(acc, c); session = c.session;
    for (const f of parseFixLines(c.text)) fixes.push({ ...f, round });
    accept = runAcceptance(h, task);
    if (firstPass === null) firstPass = accept.pass;
    if (accept.pass || round === rounds) break;
    prompt = `The hidden acceptance test failed. Output:\n${accept.tail.slice(-2500)}\nFix the code (not the tests).` + (review ? ' Add FIX: lines for anything new you correct.' : '');
  }
  return { firstPass, pass: accept.pass, fixRounds: Math.min(round, rounds), claude: acc, fixes, tail: accept.tail.slice(-800) };
}

// ---------- run ----------

async function runOne(cfg, task, arm) {
  const h = makeWorktree(task, arm);
  const t0 = Date.now();
  const row = { ts: new Date().toISOString(), task: task.id, repo: task.repo, arm, parent: task.parent, fix: task.fix,
    qwenModel: arm === 'c' ? null : cfg.qwenModel, claudeModel: arm === 'a' ? null : cfg.claudeModel, effort: arm === 'a' ? null : cfg.effort,
    maxRounds: cfg.rounds, brief: BRIEF_MODE };
  try {
    if (arm === 'a') {
      Object.assign(row, await qwenAttempt(cfg, h, task, cfg.rounds));
    } else if (arm === 'c') {
      Object.assign(row, await claudeAttempt(cfg, h, task, cfg.rounds, null));
    } else {
      const draft = await qwenAttempt(cfg, h, task, 0);
      row.qwenDraftPass = draft.pass; row.qwen = draft.qwen;
      const diff = git(h.wt, ['diff']) || '(the draft changed nothing)';
      // Snapshot the draft so Claude's own change can be diffed against it for the taxonomy.
      let draftTree = null;
      try { stageAll(h.wt); draftTree = git(h.wt, ['write-tree']).trim(); } catch (e) { row.diffError = e.message.slice(0, 300); }
      const fixed = await claudeAttempt(cfg, h, task, cfg.rounds, diff.slice(0, 40000));
      Object.assign(row, fixed);
      row.draftDiff = diff.slice(0, 8000);
      // A failed snapshot must not cost the row its grade, so it is recorded apart from row.error.
      if (draftTree) {
        try { stageAll(h.wt); row.claudeDiff = git(h.wt, ['diff', '--cached', draftTree, '--']).slice(0, 8000); } catch (e) { row.diffError = e.message.slice(0, 300); }
      }
      row.firstPass = draft.pass; // first attempt is the Qwen draft
      row.reviewFirstPass = fixed.firstPass;
    }
  } catch (e) {
    row.error = e.message.slice(0, 500); row.pass = false;
  } finally {
    row.wallMs = Date.now() - t0;
    if (cfg.keep) row.worktree = h.wt; else removeWorktree(h);
  }
  fs.appendFileSync(RESULTS, scrub(JSON.stringify(row)) + '\n');
  const ct = row.claude ? row.claude.tokens : null;
  console.log(`${task.id} arm=${arm} first=${row.firstPass} pass=${row.pass} rounds=${row.fixRounds} wall=${(row.wallMs / 1000).toFixed(0)}s` +
    (ct ? ` claudeTokens in=${ct.input} out=${ct.output} cw=${ct.cacheWrite} cr=${ct.cacheRead}` : '') + (row.error ? ` ERROR ${row.error}` : ''));
  return row;
}

/** Stage the tree for a diff; the node_modules junction can read as a symlink that ignore rules ending in / miss. */
function stageAll(wt) {
  git(wt, ['add', '-A', '--', '.', ':(exclude,glob)**/node_modules', ':(exclude,glob)**/node_modules/**']);
}

function claudeTotal(row) {
  if (!row.claude) return 0;
  const t = row.claude.tokens;
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}

/** Test output can carry the home directory; a results row may be committed to a public repo. */
function scrub(json) {
  const home = os.homedir();
  const forms = [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\'), JSON.stringify(home).slice(1, -1)];
  let out = json;
  for (const f of [...new Set(forms)].sort((a, b) => b.length - a.length)) out = out.split(f).join('~');
  return out;
}

// ---------- taxonomy / summary ----------

function readRows() {
  if (!fs.existsSync(RESULTS)) return [];
  return fs.readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function taxonomy() {
  const existing = new Map();
  if (fs.existsSync(FIXES)) {
    for (const l of fs.readFileSync(FIXES, 'utf8').split('\n')) {
      const m = l.match(/^\| (Q\d+) \| (.+?) \| (.+?) \| (\d+) \|/);
      if (m) existing.set(m[1], { rule: m[2], example: m[3], count: 0 });
    }
  }
  let next = existing.size + 1;
  const byRule = new Map([...existing].map(([k, v]) => [v.rule.toLowerCase(), k]));
  for (const row of readRows().filter((r) => r.arm === 'b')) {
    for (const f of row.fixes || []) {
      let code = /^Q\d+$/.test(f.code) && existing.has(f.code) ? f.code : byRule.get((f.rule || '').toLowerCase());
      if (!code) { code = `Q${next++}`; existing.set(code, { rule: f.rule, example: f.example, count: 0 }); byRule.set((f.rule || '').toLowerCase(), code); }
      existing.get(code).count++;
    }
  }
  const esc = (s) => String(s || '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const rows = [...existing].map(([k, v]) => `| ${k} | ${esc(v.rule)} | ${esc(v.example)} | ${v.count} |`);
  const head = fs.existsSync(FIXES) ? fs.readFileSync(FIXES, 'utf8').split('\n| Code |')[0] : '# Qwen fix taxonomy\n';
  fs.writeFileSync(FIXES, `${head}\n| Code | Rule Qwen broke | Example | Count |\n|---|---|---|---|\n${rows.join('\n')}\n`);
  console.log(`fixes.md: ${rows.length} codes`);
}

/**
 * Per arm and brief mode: the latest graded row of each task. A row with
 * `error` (endpoint down, claude -p gave no JSON) graded nothing, so it is
 * counted apart and never as a failure: [measured 2026-11-04] a Qwen server
 * restart mid-run turned 18 fetch failures into an apparent 2/20.
 */
function summarise(rows) {
  const latest = new Map(); const errors = {};
  for (const r of rows) {
    const key = `${r.arm}/${r.brief || 'full'}`;
    if (r.error) { errors[key] = (errors[key] || 0) + 1; continue; }
    latest.set(`${key} ${r.task}`, { key, r });
  }
  const arms = {};
  for (const { key, r } of latest.values()) {
    const a = (arms[key] = arms[key] || { n: 0, first: 0, pass: 0, rounds: 0, wall: 0, tokens: 0, cost: 0, errors: 0 });
    a.n++; a.first += r.firstPass ? 1 : 0; a.pass += r.pass ? 1 : 0; a.rounds += r.fixRounds || 0; a.wall += r.wallMs || 0;
    if (r.claude) { const t = r.claude.tokens; a.tokens += t.input + t.output + t.cacheWrite + t.cacheRead; a.cost += r.claude.costUsd; }
  }
  for (const [k, n] of Object.entries(errors)) (arms[k] = arms[k] || { n: 0, first: 0, pass: 0, rounds: 0, wall: 0, tokens: 0, cost: 0, errors: 0 }).errors = n;
  return arms;
}

function summary() {
  const arms = summarise(readRows());
  const avg = (x, n) => (n ? x / n : 0);
  console.log('arm/brief  tasks  first-pass  final-pass  avg-rounds  avg-wall-s  avg-claude-tokens  avg-api-equiv-usd  error-rows');
  for (const [k, a] of Object.entries(arms)) {
    console.log(`${k}    ${a.n}     ${a.first}/${a.n}         ${a.pass}/${a.n}         ${avg(a.rounds, a.n).toFixed(2)}        ${avg(a.wall, a.n * 1000).toFixed(0)}          ${Math.round(avg(a.tokens, a.n))}             ${avg(a.cost, a.n).toFixed(3)}    ${a.errors}`);
  }
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || !cmd) { process.stdout.write(USAGE); return 0; }
  if (args.data) setData(path.resolve(args.data));
  if (args.brief) {
    if (!['full', 'subject'].includes(args.brief)) throw new Error('--brief must be full or subject');
    BRIEF_MODE = args.brief;
  }
  const tasks = loadManifest();
  const pick = () => {
    if (!args.task.length || args.task.includes('all')) return tasks;
    const sel = tasks.filter((t) => args.task.includes(t.id));
    if (sel.length !== args.task.length) throw new Error(`unknown task in ${args.task.join(',')}`);
    return sel;
  };
  if (cmd === 'verify') return verify(pick());
  if (cmd === 'taxonomy') { taxonomy(); return 0; }
  if (cmd === 'summary') { summary(); return 0; }
  const cfg = {
    qwenUrl: args['qwen-url'] || process.env.QWEN_URL || 'http://127.0.0.1:8080/v1',
    qwenModel: args['qwen-model'] || process.env.QWEN_MODEL || null,
    claudeModel: args['claude-model'] || 'claude-opus-5-5',
    effort: args.effort || 'medium',
    rounds: args.rounds === undefined ? 2 : Number(args.rounds),
    keep: !!args.keep,
  };
  if (cmd === 'probe') { console.log((await qwenModel(cfg.qwenUrl)).join('\n')); return 0; }
  if (cmd !== 'run') { process.stderr.write(USAGE); return 2; }
  if (!['a', 'b', 'c'].includes(args.arm)) throw new Error('--arm must be a, b or c');
  if (!args.task.length) throw new Error('name --task <id> or --task all');
  if (args.arm !== 'c' && !cfg.qwenModel) cfg.qwenModel = (await qwenModel(cfg.qwenUrl))[0];
  const sel = pick();
  if (args['dry-run']) { for (const t of sel) console.log(`would run arm ${args.arm} on ${t.id} (${t.repo} ${t.parent})`); return 0; }
  const budget = args['budget-tokens'] === undefined ? Infinity : Number(args['budget-tokens']);
  let spent = 0; let done = 0;
  for (let i = 0; i < sel.length; i++) {
    const projected = done ? spent + (spent / done) * (sel.length - i) : 0;
    if (projected > budget) {
      console.log(`budget: stopping before ${sel[i].id}: ${spent} Claude tokens spent on ${done} tasks, ${Math.round(projected)} projected for all ${sel.length}, over ${budget}`);
      return 3;
    }
    const row = await runOne(cfg, sel[i], args.arm);
    spent += claudeTotal(row); done++;
    if (row.claude) console.log(`budget: ${spent} Claude tokens after ${done} of ${sel.length} tasks`);
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`run.js: ${e.message}\n`); process.exitCode = 1; });
}

module.exports = { parseBlocks, applyBlocks, parseArgs, parseFixLines, scrub, summarise };
