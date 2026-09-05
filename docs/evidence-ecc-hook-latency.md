# Hook cost per tool call, ECC against autodev: measured evidence

`[measured 2026-09-05]` on one Windows 11 machine, Node v24.15.0, against
`affaan-m/ecc` at commit `e04ea0b` and this repo at `21e5314`. Every number
comes from running each repo's real `hooks.json` command strings, never a
reconstruction of them. The decision this supports is in `decisions.md`
under the same date.

## Method

- One harness (`hook-ab.js`, reproduced at the end) loads both `hooks.json`
  files, selects the hook groups whose matcher matches the tool in each
  payload, and runs every hook N=8 times with a fixed payload on stdin.
- Payloads are shaped like Claude Code's: `session_id`, a real
  `transcript_path` on disk, `cwd` pointing at a throwaway git repo with one
  commit, `hook_event_name`, `tool_name`, `tool_input`, and for PostToolUse a
  `tool_response`.
- HOME, USERPROFILE and XDG_DATA_HOME point at a sandbox, so neither harness
  writes into the live `~/.claude`. ECC's `CLAUDE_PLUGIN_ROOT` is its clone;
  its hook profile is the default `standard`.
- ECC hooks run through `bash -c`, which the inline `node -e` bootstrap in
  every one of its command strings needs. autodev's hooks ship in the
  shell-free `command` + `args` form and run that way (labelled "direct"); a
  `bash -c` control run is included so the runner is not the explanation.
- **Blocking** is the slowest synchronous hook in the group, because the
  harness runs a matcher group in parallel and waits for all. **CPU** is the
  sum over every hook in the group, async included. Medians throughout.

The first run of the harness measured autodev at 78 ms with every hook
exiting 1: the harness had dropped `args` and run a bare `node` that read the
JSON payload as a script. A probe artifact, caught by reading the per-hook
status column rather than the totals. The runs below are after that fix.

## Results

| event | hooks (sync) ECC | ECC blocking | ECC cpu | hooks (sync) autodev | autodev blocking | autodev cpu |
|---|---|---|---|---|---|---|
| PreToolUse/Bash | 4 (3) | 183 ms | 2,297 ms | 1 (1) | 42 ms | 42 ms |
| PreToolUse/Edit | 6 (5) | 173 ms | 2,621 ms | 1 (1) | 45 ms | 45 ms |
| PreToolUse/Read | 2 (1) | 166 ms | 2,173 ms | 1 (1) | 43 ms | 43 ms |
| PostToolUse/Read | 2 (1) | 87 ms | 1,973 ms | 2 (2) | 48 ms | 92 ms |
| PostToolUse/Bash | 2 (1) | 107 ms | 1,885 ms | 2 (2) | 46 ms | 90 ms |
| PostToolUse/Edit | 2 (1) | 91 ms | 2,141 ms | 3 (3) | 48 ms | 138 ms |
| Stop | 7 (3) | 263 ms | 1,101 ms | 2 (2) | 47 ms | 90 ms |

autodev through the `bash -c` control: 60 to 84 ms blocking, 60 to 190 ms
CPU. The shell adds about 20 ms per hook and changes no conclusion.

autodev's numbers count both installed plugins, `autodev-core` and
`autodev-memory`, since both run on this machine. The Stop row predates
`context-depth-nudge.js`, which was added the same day.

## Per-hook medians, ECC

```text
PreToolUse/Bash
  pre:bash:dispatcher                    122 ms
  pre:observe:continuous-learning async 1874 ms
  pre:governance-capture                 118 ms
  pre:mcp-health-check                   183 ms
PreToolUse/Edit
  pre:edit-write:suggest-compact         173 ms
  pre:observe:continuous-learning async 1933 ms
  pre:governance-capture                 113 ms
  pre:config-protection                  123 ms
  pre:mcp-health-check                   161 ms
  pre:edit-write:gateguard-fact-force    117 ms
PreToolUse/Read
  pre:observe:continuous-learning async 2007 ms
  pre:mcp-health-check                   166 ms
PostToolUse/Read
  post:dispatcher:sync                    87 ms
  post:dispatcher:async            async 1887 ms
PostToolUse/Bash
  post:dispatcher:sync                   107 ms
  post:dispatcher:async            async 1778 ms
PostToolUse/Edit
  post:dispatcher:sync                    91 ms
  post:dispatcher:async            async 2050 ms
Stop
  stop:plan-canvas-pending               106 ms
  stop:format-typecheck                  105 ms
  stop:check-console-log                 263 ms
  stop:session-end                 async 223 ms
  stop:evaluate-session            async 149 ms
  stop:cost-tracker                async 148 ms
  stop:desktop-notify              async 109 ms
```

Where the two seconds go: `observe-runner.js` spawns bash, which spawns
python three times per call (cwd extraction, agent-id check, payload parse)
and `git rev-parse` once, on every tool including Read and Grep, in both the
Pre and Post phases. `mcp-health-check` runs synchronously on every tool
call with a `.*` matcher, MCP or not.

## Per-hook medians, autodev (direct)

```text
PreToolUse/Bash     coordinator-write-guard.js   42 ms
PreToolUse/Edit     pre-tool-filter.js           45 ms
PreToolUse/Read     pre-tool-filter.js           43 ms
PostToolUse/Read    telemetry.js 43 ms   memory-capture.js 48 ms
PostToolUse/Bash    telemetry.js 43 ms   memory-capture.js 46 ms
PostToolUse/Edit    post-tool-typecheck.js 43 ms   telemetry.js 47 ms   memory-capture.js 48 ms
Stop                stop-auto-check.js 47 ms   stop-brain-report.js 43 ms
```

Roughly 4x blocking and 15 to 50x CPU per tool call. On a machine that has
run 16 concurrent sessions, the CPU figure is the one that matters.

## What this does not measure

- What the hooks are worth. A slow hook that prevents a bad edit can be
  worth its cost; the decision record weighs that separately, per hook.
- Real-repo typecheck cost. `post-tool-typecheck.js` exited fast here
  because the sandbox repo has no `typecheck` script. ECC batches typecheck
  at Stop instead; comparing the two needs a real TypeScript repo and was
  not done.
- Anything on macOS or Linux. The python and bash spawns cost less there,
  and the ratio will be smaller.

## The harness

Kept here so the measurement can be repeated without rebuilding it. Clone
ECC beside this file, adjust the two root paths, run `node hook-ab.js 8`,
then `ONLY=autodev RUNNER=direct node hook-ab.js 8` for the production form.

```js
#!/usr/bin/env node
// Hook latency A/B: ECC vs autodev, per tool-call event, on this machine.
// Runs the REAL command strings from each repo's hooks.json (never a
// reconstruction). Sandboxed HOME so neither harness writes into ~/.claude.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRATCH = __dirname;
const ECC_ROOT = path.join(SCRATCH, 'ecc');                       // clone of affaan-m/ecc
const OURS_ROOT = path.join(SCRATCH, '..', 'plugins', 'autodev-core');
const OURS_MEM_ROOT = path.join(SCRATCH, '..', 'plugins', 'autodev-memory');
const N = parseInt(process.argv[2] || '10', 10);

const SANDBOX = path.join(SCRATCH, 'ab-sandbox');
const FAKE_HOME = path.join(SANDBOX, 'home');
const PROJ = path.join(SANDBOX, 'proj');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects', 'x'), { recursive: true });
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
fs.writeFileSync(path.join(PROJ, 'package.json'), JSON.stringify({ name: 'proj', version: '1.0.0', scripts: { test: 'echo ok' } }));
fs.writeFileSync(path.join(PROJ, 'src', 'a.js'), 'module.exports = 1;\n');
execFileSync('git', ['init', '-q'], { cwd: PROJ });
execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '.'], { cwd: PROJ });
execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: PROJ });
const TRANSCRIPT = path.join(FAKE_HOME, '.claude', 'projects', 'x', '0f3a2b1c-1111-4222-8333-444455556666.jsonl');
fs.writeFileSync(TRANSCRIPT, [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the thing' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] } }),
].join('\n') + '\n');

const base = { session_id: 'ab-session', transcript_path: TRANSCRIPT, cwd: PROJ };
const A = path.join(PROJ, 'src', 'a.js');
const PAYLOADS = {
  'PreToolUse/Bash': { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status --short' } },
  'PreToolUse/Edit': { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: A, old_string: '1', new_string: '2' } },
  'PreToolUse/Read': { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: A } },
  'PostToolUse/Read': { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: A }, tool_response: { file: { filePath: A, content: 'module.exports = 1;', numLines: 1 } } },
  'PostToolUse/Bash': { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status --short' }, tool_response: { stdout: '', stderr: '', interrupted: false } },
  'PostToolUse/Edit': { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: A, old_string: '1', new_string: '2' }, tool_response: { filePath: A, success: true } },
  'Stop': { ...base, hook_event_name: 'Stop', stop_hook_active: false },
};

function matches(matcher, tool) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*' || matcher === '.*') return true;
  try { return new RegExp('^(' + matcher + ')$').test(tool); } catch { return false; }
}

function loadHooks(file, root, substitute) {
  const h = JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
  const out = {};
  for (const [ev, groups] of Object.entries(h)) {
    out[ev] = [];
    for (const g of groups) {
      for (const hk of g.hooks) {
        if (hk.type !== 'command') continue;
        const args = Array.isArray(hk.args) ? hk.args.map(substitute) : null;
        const shellCmd = args ? [substitute(hk.command), ...args.map(a => `'${a.replace(/'/g, `'\\''`)}'`)].join(' ') : substitute(hk.command);
        const id = g.id || (args ? path.basename(args[args.length - 1]) : (hk.command.match(/hooks\/([\w.-]+\.js)/)?.[1] || '?'));
        out[ev].push({ id, matcher: g.matcher, async: !!hk.async, timeout: hk.timeout, command: shellCmd, argv: args ? [substitute(hk.command), ...args] : null, root });
      }
    }
  }
  return out;
}

const ECC = loadHooks(path.join(ECC_ROOT, 'hooks', 'hooks.json'), ECC_ROOT, c => c);
const sub = (root) => (c) => c.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root);
const OURS = loadHooks(path.join(OURS_ROOT, 'hooks', 'hooks.json'), OURS_ROOT, sub(OURS_ROOT));
const OURS_MEM = loadHooks(path.join(OURS_MEM_ROOT, 'hooks', 'hooks.json'), OURS_MEM_ROOT, sub(OURS_MEM_ROOT));
for (const ev of new Set([...Object.keys(OURS), ...Object.keys(OURS_MEM)])) OURS[ev] = [...(OURS[ev] || []), ...(OURS_MEM[ev] || [])];

function envFor(root) {
  const e = { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, XDG_DATA_HOME: path.join(FAKE_HOME, '.local', 'share'), CLAUDE_PLUGIN_ROOT: root, ECC_HOOK_PROFILE: 'standard', GATEGUARD_STATE_DIR: path.join(FAKE_HOME, '.gateguard'), CLAUDE_CODE_ENTRYPOINT: 'cli' };
  delete e.CLAUDE_PROJECT_DIR;
  return e;
}

function runOne(hook, payload) {
  const t0 = process.hrtime.bigint();
  const direct = process.env.RUNNER === 'direct' && hook.argv;
  const opts = { input: JSON.stringify(payload), encoding: 'utf8', env: envFor(hook.root), timeout: 60000, windowsHide: true };
  const r = direct
    ? spawnSync(hook.argv[0], hook.argv.slice(1), { ...opts, cwd: PROJ })
    : spawnSync('bash', ['-c', hook.command], { ...opts, cwd: hook.root });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, status: r.status, err: (r.stderr || '').slice(0, 200).replace(/\s+/g, ' ') };
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

function bench(name, hooks) {
  const rows = [];
  for (const [label, payload] of Object.entries(PAYLOADS)) {
    const [ev, tool] = label.split('/');
    const per = (hooks[ev] || []).filter(h => matches(h.matcher, tool || '')).map(h => ({ ...h, samples: [], statuses: new Set(), lastErr: '' }));
    for (let i = 0; i < N; i++) for (const p of per) { const r = runOne(p, payload); p.samples.push(r.ms); p.statuses.add(r.status); p.lastErr = r.err; }
    const syncMax = per.filter(p => !p.async).reduce((m, p) => Math.max(m, median(p.samples)), 0);
    const sum = per.reduce((s, p) => s + median(p.samples), 0);
    rows.push({ harness: name, event: label, hooks: per.length, sync: per.filter(p => !p.async).length, blocking_ms: Math.round(syncMax), cpu_sum_ms: Math.round(sum),
      detail: per.map(p => `${p.id}${p.async ? '(async)' : ''}=${Math.round(median(p.samples))}ms st=${[...p.statuses].join('/')}${p.lastErr ? ' ERR:' + p.lastErr.slice(0, 90) : ''}`) });
  }
  return rows;
}

const which = process.env.ONLY || 'both';
const runner = process.env.RUNNER === 'direct' ? 'direct argv' : 'bash -c';
const all = [...(which !== 'autodev' ? bench('ECC', ECC) : []), ...(which !== 'ECC' ? bench('autodev (' + runner + ')', OURS) : [])];
console.log(`N=${N} runs per hook, medians, HOME sandboxed, platform=${process.platform} node=${process.version}`);
console.log('harness                  | event            | hooks | sync | blocking(max sync) ms | cpu(sum all) ms');
for (const r of all) console.log(`${r.harness.padEnd(24)} | ${r.event.padEnd(16)} | ${String(r.hooks).padStart(5)} | ${String(r.sync).padStart(4)} | ${String(r.blocking_ms).padStart(21)} | ${String(r.cpu_sum_ms).padStart(15)}`);
for (const r of all) { console.log(`## ${r.harness} ${r.event}`); for (const d of r.detail) console.log('   ' + d); }
```

Read the per-hook `st=` column before the totals. A hook that exits non-zero
on every run is measuring its own failure, which is how the first autodev
run lied.
