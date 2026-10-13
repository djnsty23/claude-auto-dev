#!/usr/bin/env node
// test-hook-budget.js: what every wired hook costs, and which way it fails.
//
// Every hook in plugins/*/hooks/hooks.json runs inside someone else's session,
// on every prompt, tool call or turn its event names. Two properties of each one
// were nowhere written down or tested as a population:
//
//   COST. How long the hook adds to the event it runs on. Each hook's suite
//   tests behaviour, and none of them notices a hook getting ten times slower.
//   `[measured 2026-09-24]` on a 14-core Windows box, 27 of the 30 wired entries
//   cost within 25 ms of node running an empty script. The outliers were session-start.js
//   (about 190 ms over the floor in a sandbox, and about 480 ms against a real
//   Desktop session store of 1,217 records) and agent-browser-cleanup.js (about
//   100 ms, three shell spawns). One entry, panel-recommendation.js, declared no
//   timeout at all, so the harness default applied to a hook in front of every
//   AskUserQuestion.
//
//   FAILURE DIRECTION. What the hook does when it cannot read its input. Each
//   hook's header states it (pre-tool-filter.js fails closed, coordinator-write-
//   guard.js fails open "EVERYWHERE"), but a statement in a header is not a test,
//   and the two directions are easy to swap by accident in a refactor.
//
// So this suite holds one written decision per hook file (DECISIONS, exhaustive
// over both hooks.json files in both directions, like test-hooks-profile.js) and
// one budget per event (BUDGET_MS), and drives every wired entry as a subprocess
// in a sandbox:
//
//   1. a valid payload for its event, its CPU measured min-of-RUNS against a
//      bare-node floor measured interleaved with it, and judged against the
//      event's budget;
//   2. garbage stdin and empty stdin, judged against the hook's decision;
//   3. a valid payload with every state directory pointing at a regular file,
//      which must never block the event (a guard that cannot write its ledger
//      has not seen a reason to refuse anything).
//
// BUDGETS ARE OVERHEAD, IN CPU MILLISECONDS. The hook process measures itself
// (tooling/cpu-telemetry.js, through a preload), and its Node descendants report
// too. A wall clock charged the hook for every other process on the machine, so
// a second gate in the other lane turned load into a red. Overhead is the hook's
// lowest CPU minus the lowest bare-node CPU beside it, so node's own startup is
// not charged to the hook. The budget still scales up (never down) by how
// expensive that floor is right now against FLOOR_REF_MS. Windows counts CPU in
// 15.6 ms ticks, so a figure here moves in steps of that size. A run with no CPU
// record is NOT MEASURED (exit 2 if nothing failed), never zero.
//
// What CPU does not see: time a hook spends waiting on a non-Node child (git,
// a shell, ps), or sleeping. So there is a second, separate judge:
//
//   4. ELAPSED. The same valid runs, judged on wall time over the bare-node
//      wall floor measured interleaved, min of RUNS, against a per-event wall
//      budget (WALL_BUDGET_MS) that scales up with the floor to a hard cap
//      (WALL_SCALE_MAX), and stays under every hook's harness timeout;
//   5. CUMULATIVE. Every hook wired on one event, its wall overhead summed,
//      against the event's ceiling (EVENT_WALL_CEILING_MS);
//   6. TIMEOUT DESCENDANTS. A canary hook that spawns a detached child and never
//      exits is killed at its timeout through the process-tree helper, and must
//      leave zero live descendants.
//
// Every judge is shown to fire: a real wired hook wrapped in a CPU burn past its
// budget must go over, the same hook wrapped in a SLEEP must stay inside the CPU
// budget (a wall clock would charge the sleep) and go OVER the wall budget,
// every decision flipped must disagree with what the hook actually did, a wired
// list with one timeout removed or one hook unclassified must be reported, and a
// root-only kill of the timeout canary must leave its child alive and counted.
//
// --report prints the cost tables and one summary line, which must read
//   sleep_control_cpu=PASS sleep_control_wall=FAIL timeout_descendants=0
// --installed also measures the installed plugin cache as a separate profile.
// It is never part of the default run (see installedProfile below).
//
// Nothing real is touched. HOME, USERPROFILE, CLAUDE_CONFIG_DIR, APPDATA,
// LOCALAPPDATA and XDG_CONFIG_HOME point into a temp dir, the cwd is a temp git
// repo, and ps, taskkill, tasklist, wmic and powershell are shadowed on PATH by
// shims that do nothing, because agent-browser-cleanup.js kills processes.
//
// Run: node tooling/test-hook-budget.js [--report] [--installed]

'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSyncCpu } = require('./cpu-telemetry.js');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = ['autodev-core', 'autodev-memory'];
const REPORT = process.argv.includes('--report');
const INSTALLED = process.argv.includes('--installed');
const RUNS = 3;

// CPU of an empty script under the preload. `[measured 2026-10-02]` single runs
// on a 16-core Windows 11 box read 15, 31, 46 and 62 ms (whole 15.6 ms ticks), so
// three ticks is the reference above which the budget starts to scale.
const FLOOR_REF_MS = 47;

// Overhead a hook may add to one event, in idle-machine milliseconds. The
// tighter an event's budget, the more often it fires: PreToolUse and PostToolUse
// run on every tool call, UserPromptSubmit on every prompt, Stop on every turn,
// SessionStart once, while the user waits for the first prompt.
const BUDGET_MS = {
    PreToolUse: 150,
    PostToolUse: 150,
    PostToolUseFailure: 150,
    UserPromptSubmit: 150,
    Stop: 250,
    StopFailure: 250,
    PreCompact: 250,
    PostCompact: 250,
    InstructionsLoaded: 250,
    SessionEnd: 250,
    SessionStart: 500,
};

// ELAPSED. The CPU budget above cannot see a hook waiting on git, a shell or
// ps, or sleeping, and the user waits for all of it. So each hook is also judged
// on wall time over the bare-node wall floor measured interleaved with it, min
// of RUNS. Min-of-RUNS minus an interleaved floor is what keeps machine load out
// of the verdict: load inflates both sides, and the minimum keeps the quietest
// sample of each.
//
// WALL_FLOOR_REF_MS: the wall time of an empty script under the preload, the
// spawn included. `[measured 2026-10-13]` three idle runs of this suite on a
// 16-core Windows 11 box, Node 24.15.0, read a per-hook floor minimum between
// 50 and 62 ms, so 55 ms is the reference above which wall budgets scale.
const WALL_FLOOR_REF_MS = 55;
// The wall budget scales with the floor measured beside it, upward only, and
// never past this factor: a baseline that keeps slowing cannot keep widening
// the budget. Past the cap a loaded machine reads red, which says the machine
// was too busy to judge on, and the CPU verdict above still stands.
const WALL_SCALE_MAX = 3;
// Wall overhead one hook may add to one event, in idle-machine milliseconds.
// `[measured 2026-10-13]` same three runs, min-of-3 wall over the floor: every
// PreToolUse, PostToolUse and UserPromptSubmit hook read -4 to 13 ms, every
// Stop, compact, InstructionsLoaded and SessionEnd hook -5 to 21 ms. On
// SessionStart, session-start.js read 283 to 330 ms (git and the session store)
// and agent-browser-cleanup.js 113 to 136 ms (three shell spawns), the rest
// under 20 ms. Budgets sit about 5x over the per-tool readings and about 2x over
// session-start.js, and each one at WALL_SCALE_MAX stays under the shortest
// harness timeout on its event (asserted below).
const WALL_BUDGET_MS = {
    PreToolUse: 100,
    PostToolUse: 100,
    PostToolUseFailure: 100,
    UserPromptSubmit: 100,
    Stop: 150,
    StopFailure: 150,
    PreCompact: 150,
    PostCompact: 150,
    InstructionsLoaded: 150,
    SessionEnd: 150,
    SessionStart: 650,
};
// Wall overhead of every hook wired on one event, summed. Claude Code may start
// matching hooks in parallel, so the sum is an upper bound on the wait, and it
// counts every matcher as if one tool call matched them all. That is the
// conservative reading: a ceiling the sum fits under, the real wait fits under.
// `[measured 2026-10-13]` same three runs, summed per event: SessionStart 423
// to 500 ms over 5 hooks, PreToolUse 18 to 40 over 7, PostToolUse 14 to 24 over
// 4, Stop 32 to 38 over 6, SessionEnd 25 to 33 over 3, every other event under
// 16 ms. The ceiling also caps growth by count: the next hook on a tool event
// spends from the same few hundred milliseconds as the ones already there.
const EVENT_WALL_CEILING_MS = {
    PreToolUse: 250,
    PostToolUse: 200,
    PostToolUseFailure: 100,
    UserPromptSubmit: 150,
    Stop: 300,
    StopFailure: 150,
    PreCompact: 200,
    PostCompact: 150,
    InstructionsLoaded: 150,
    SessionEnd: 250,
    SessionStart: 1000,
};

// What each hook does when its stdin is garbage or empty.
//   open:   exits 0 with nothing on stderr. `says` is what stdout may carry: null
//           means zero bytes, a RegExp a fixed line, and INFORMS a hook that
//           reports on the cwd rather than the payload, so bad input still gets
//           its context but never a decision.
//   closed: exits 2 with a reason on stderr and nothing on stdout.
// `extra` adds inputs with their own expected direction.
const OPEN = (why, says = null) => ({ bad: 'open', says, why });
const CLOSED = (why, extra = []) => ({ bad: 'closed', says: null, why, extra });

// Empty, or one JSON object that only informs: no decision, no stop, and no key
// outside the informational ones. `required` names a field that must be present.
const INFORMS = (required = {}) => {
    const says = (stdout) => {
        if (stdout.trim() === '') return Object.keys(required).length === 0;
        let o;
        try { o = JSON.parse(stdout); } catch { return false; }
        if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
        if (Object.keys(o).some((k) => !['systemMessage', 'hookSpecificOutput', 'suppressOutput'].includes(k))) return false;
        if (o.hookSpecificOutput && Object.keys(o.hookSpecificOutput).some((k) => !['hookEventName', 'additionalContext'].includes(k))) return false;
        return Object.entries(required).every(([k, re]) => typeof o[k] === 'string' && re.test(o[k]));
    };
    says.toString = () => `INFORMS(${Object.keys(required).join(', ') || 'optional'})`;
    return says;
};
const saysOk = (says, stdout) => (says instanceof RegExp ? says.test(stdout) : says(stdout));
const STOP_NEVER_BLOCKS = 'a Stop hook that cannot read its payload must let the turn end, or the session hangs';
const DECISIONS = {
    'plugins/autodev-core/hooks/session-start.js': OPEN(
        'SessionStart informs and never blocks, and the banner and working-tree context read the cwd, not the payload',
        INFORMS({ systemMessage: /^\[Auto-Dev v\d+\.\d+\.\d+\]$/ })),
    'plugins/autodev-core/hooks/agent-browser-cleanup.js': OPEN(
        'it kills processes on positive evidence only, and a payload is not evidence'),
    'plugins/autodev-core/hooks/session-register.js': OPEN(
        'a registry must never be the reason a session cannot start or end'),
    'plugins/autodev-core/hooks/instruction-envelope.js': OPEN(
        'it reports on the profile, not the payload, and a session cannot repair its rules before it starts',
        INFORMS()),
    'plugins/autodev-core/hooks/session-env-dedupe.js': OPEN(
        'it is silent by contract and exits 0 on every path: a payload without a session id names no directory, so it rewrites nothing'),
    'plugins/autodev-core/hooks/user-prompt-image-scan.js': OPEN(
        'a degraded scan is better than a prompt that cannot be sent'),
    'plugins/autodev-core/hooks/inbox-notify.js': OPEN(
        'an inbox note is advice, and advice never blocks a prompt'),
    'plugins/autodev-core/hooks/pre-tool-filter.js': CLOSED(
        'an unreadable payload may be a write, and a filter that cannot read its input must not pass it',
        // Open for a Read it can still name: a Read has nothing for a refusal to
        // protect, so failing closed there only cost the session its reads.
        [{ label: 'truncated JSON naming Read', input: '{"tool_name":"Read","tool_input":{"file_path":', bad: 'open' }]),
    'plugins/autodev-core/hooks/panel-recommendation.js': OPEN(
        'it ships installed, so a defect here must not block every panel until a reinstall'),
    'plugins/autodev-core/hooks/peer-message-budget.js': OPEN(
        'an unreadable ledger is not zero sends, and a budget it cannot count is not exceeded'),
    'plugins/autodev-core/hooks/coordinator-write-guard.js': OPEN(
        'it fails open everywhere: an unreadable payload is the harness\'s problem, not a reason to refuse a command'),
    'plugins/autodev-core/hooks/headless-guard.js': OPEN(
        'any throw, a non-JSON stdin included, exits 0 with zero bytes'),
    'plugins/autodev-core/hooks/shared-install-guard.js': OPEN(
        'it ships installed, and an install it cannot judge is the private install the tree already had before any link'),
    'plugins/autodev-core/hooks/artifact-write-guard.js': OPEN(
        'it ships installed, so a defect here must not block every shared-database write'),
    'plugins/autodev-core/hooks/peer-send-ledger.js': OPEN(
        'a PostToolUse ledger cannot undo the send it records, so it only ever records'),
    'plugins/autodev-core/hooks/post-tool-typecheck.js': OPEN(
        'a typecheck note is advice on an edit that already happened'),
    'plugins/autodev-core/hooks/telemetry.js': OPEN(
        'telemetry records, and a record it cannot make changes nothing the user asked for'),
    'plugins/autodev-core/hooks/stop-auto-check.js': OPEN(
        STOP_NEVER_BLOCKS + ', so it approves explicitly',
        /^\{"decision":"approve"\}\n?$/),
    'plugins/autodev-core/hooks/stop-brain-report.js': OPEN(STOP_NEVER_BLOCKS),
    'plugins/autodev-core/hooks/context-depth-nudge.js': OPEN(STOP_NEVER_BLOCKS),
    'plugins/autodev-core/hooks/stop-workflow-wall-note.js': OPEN(STOP_NEVER_BLOCKS),
    'plugins/autodev-core/hooks/stop-typecheck.js': OPEN(STOP_NEVER_BLOCKS),
    'plugins/autodev-core/hooks/stop-intent-record.js': OPEN(STOP_NEVER_BLOCKS),
    'plugins/autodev-core/hooks/stop-failure-note.js': OPEN(
        'the turn has already failed, and a note about it must not add a second failure'),
    'plugins/autodev-core/hooks/pre-compact.js': OPEN(
        'compaction goes ahead whatever this hook saves, so it must not stop it'),
    'plugins/autodev-core/hooks/post-compact.js': OPEN(
        'the resume hint does not depend on the payload, so it is printed either way',
        /^\[PostCompact\] Context was compacted\./),
    'plugins/autodev-core/hooks/instructions-loaded.js': OPEN(
        'its exit code is ignored by the harness, so a block here would only look like one'),
    'plugins/autodev-memory/hooks/memory-session-start.js': OPEN(
        'memory is context, and a session starts without it; the memory it injects is keyed on the cwd, so bad input may still get it',
        INFORMS()),
    'plugins/autodev-memory/hooks/memory-capture.js': OPEN(
        'a capture that fails loses one memory, never the tool result'),
    'plugins/autodev-memory/hooks/memory-session-end.js': OPEN(
        'the session is already ending, so a memory write that fails must not delay it'),
};

let pass = 0;
let fail = 0;
let notMeasured = 0;
// The three facts the --report summary line states, each set only by the check
// that measured it. null prints as NOT_MEASURED, which never matches.
const summary = { sleepCpu: null, sleepWall: null, descendants: null };
const EXPECTED_SUMMARY = 'sleep_control_cpu=PASS sleep_control_wall=FAIL timeout_descendants=0';
const check = (label, ok, detail) => {
    if (ok) { pass++; console.log('PASS', label); } else { fail++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)); }
};
// A CPU figure that could not be read is no verdict, in either direction.
const unmeasured = (label, why) => { notMeasured++; console.log('NOT MEASURED', label, why); };

// ---------------------------------------------------------------- the wired list

// roots maps each plugin to the directory holding its hooks/hooks.json: the
// repo copy by default, the installed cache under --installed.
const repoRoots = () => Object.fromEntries(PLUGINS.map((p) => [p, path.join(ROOT, 'plugins', p)]));
function readWired(roots = repoRoots()) {
    const wired = [];
    for (const plugin of PLUGINS) {
        const pluginRoot = roots[plugin];
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
        for (const [event, groups] of Object.entries(manifest.hooks || {})) {
            for (const group of groups) {
                for (const h of group.hooks || []) {
                    const arg = (h.args || []).find((a) => a.includes('${CLAUDE_PLUGIN_ROOT}')) || h.command;
                    const rel = String(arg).replace('${CLAUDE_PLUGIN_ROOT}/', '');
                    wired.push({ plugin, pluginRoot, event, matcher: group.matcher || '', rel, key: `plugins/${plugin}/${rel}`, timeout: h.timeout });
                }
            }
        }
    }
    return wired;
}

// The installed profile: the plugin cache Claude Code actually loads hooks from,
// resolved the way check-plugin-drift.js resolves it, from installed_plugins.json
// under the config dir. A user-scope entry wins over a project-scope one. Returns
// { roots, versions } or { why } when any plugin has no installed hooks.json.
function installedRoots() {
    const claudePaths = require(path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'claude-paths.js'));
    const manifest = path.join(claudePaths.configDir(), 'plugins', 'installed_plugins.json');
    let m;
    try { m = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch (e) { return { why: `cannot read ${manifest}: ${e.code || e.message}` }; }
    const keys = Object.keys((m && m.plugins) || {});
    const roots = {};
    const versions = {};
    for (const plugin of PLUGINS) {
        const key = keys.find((k) => k === `${plugin}@autodev`) || keys.find((k) => k.startsWith(`${plugin}@`));
        const entries = key && Array.isArray(m.plugins[key]) ? m.plugins[key] : [];
        const e = entries.find((x) => x && x.scope === 'user') || entries[entries.length - 1];
        if (!e || !e.installPath || !fs.existsSync(path.join(e.installPath, 'hooks', 'hooks.json'))) {
            return { why: `${plugin} has no installed hooks.json in ${manifest}` };
        }
        roots[plugin] = e.installPath;
        versions[plugin] = e.version;
    }
    return { roots, versions };
}

// Every wired hook classified, every decision wired: a hook added to hooks.json
// fails here until someone writes down which way it fails, and a decision left
// behind by a removed hook fails too.
function classification(wired, decisions) {
    const keys = new Set(wired.map((w) => w.key));
    return {
        unclassified: [...keys].filter((k) => !(k in decisions)).sort(),
        stale: Object.keys(decisions).filter((k) => !keys.has(k)).sort(),
    };
}

// A hook with no timeout gets the harness default, which is minutes, not seconds.
const missingTimeouts = (wired) => wired.filter((w) => !(Number.isFinite(w.timeout) && w.timeout > 0)).map((w) => `${w.event} ${w.key}`);

const unbudgeted = (wired) => [...new Set(wired.map((w) => w.event))].filter((e) => !(e in BUDGET_MS));
const wallBudgetOverTimeout = (wired) => wired
    .filter((w) => w.event in WALL_BUDGET_MS && Number.isFinite(w.timeout) && !(WALL_BUDGET_MS[w.event] * WALL_SCALE_MAX < w.timeout * 1000))
    .map((w) => `${w.event} ${w.key} (${WALL_BUDGET_MS[w.event] * WALL_SCALE_MAX} ms vs ${w.timeout} s)`);
const wallUnbudgeted = (wired) => [...new Set(wired.map((w) => w.event))].filter((e) => !(e in WALL_BUDGET_MS) || !(e in EVENT_WALL_CEILING_MS));

// ---------------------------------------------------------------- the judges

// Overhead over budget, with the budget scaled by the floor measured beside it.
function judgeCost(event, hookMinMs, floorMinMs) {
    const scale = Math.max(1, floorMinMs / FLOOR_REF_MS);
    const budget = BUDGET_MS[event] * scale;
    const overhead = hookMinMs - floorMinMs;
    return { over: overhead > budget, overhead, budget, scale };
}

// The wall scale: upward only, capped, so a slow floor widens the budget a
// bounded amount and no further.
const wallScale = (floorWallMs) => Math.min(WALL_SCALE_MAX, Math.max(1, floorWallMs / WALL_FLOOR_REF_MS));

// Elapsed overhead over the event's wall budget. Separate from judgeCost on
// purpose: a sleep or a wait on a non-Node child is invisible to one and not to
// the other, and the sleep canary below holds each to its own answer.
function judgeWall(event, hookWallMinMs, floorWallMinMs) {
    const scale = wallScale(floorWallMinMs);
    const budget = WALL_BUDGET_MS[event] * scale;
    const overhead = hookWallMinMs - floorWallMinMs;
    return { over: overhead > budget, overhead, budget, scale };
}

// Every hook wired on one event, summed. A negative overhead (a hook that read
// faster than the floor beside it) counts as zero, never as credit.
function judgeEvents(rows) {
    const by = new Map();
    for (const r of rows) {
        const e = by.get(r.event) || { event: r.event, hooks: 0, sum: 0, floors: [] };
        e.hooks++;
        e.sum += Math.max(0, r.wallOverhead);
        e.floors.push(r.floorWallMin);
        by.set(r.event, e);
    }
    return [...by.values()].map((e) => {
        const floor = e.floors.sort((a, b) => a - b)[Math.floor(e.floors.length / 2)];
        const scale = wallScale(floor);
        const ceiling = EVENT_WALL_CEILING_MS[e.event] * scale;
        return { event: e.event, hooks: e.hooks, sum: e.sum, ceiling, scale, over: !(e.sum <= ceiling) };
    });
}

// Does one run on bad input match the decision it was held to?
function judgeBad(run, expect, says) {
    if (run.error) return { ok: false, why: `did not finish (${run.error})` };
    if (expect === 'closed') {
        const ok = run.status === 2 && run.stdout === '' && run.stderr.trim() !== '';
        return { ok, why: ok ? '' : `expected exit 2 with a stderr reason, got exit ${run.status}, ${run.stdout.length}+${run.stderr.length} bytes` };
    }
    if (run.status !== 0) return { ok: false, why: `expected exit 0, got ${run.status}` };
    if (run.stderr !== '') return { ok: false, why: `expected no stderr, got ${run.stderr.length} bytes` };
    if (says === null) return { ok: run.stdout === '', why: run.stdout === '' ? '' : `expected zero bytes, got ${run.stdout.length}: ${JSON.stringify(run.stdout.slice(0, 300))}` };
    const ok = saysOk(says, run.stdout);
    return { ok, why: ok ? '' : `stdout did not match ${says}: ${JSON.stringify(run.stdout.slice(0, 300))}` };
}

const flip = (d) => (d === 'open' ? 'closed' : 'open');

// ---------------------------------------------------------------- the sandbox

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-budget-'));
const HOME = path.join(SB, 'home');
const CWD = path.join(SB, 'proj');
const BIN = path.join(SB, 'shim-bin');
const SHIM_LOG = path.join(SB, 'shim-calls.log');
const BLOCKER = path.join(SB, 'not-a-directory');
const TRANSCRIPT = path.join(SB, 'transcript.jsonl');
for (const d of [HOME, path.join(HOME, '.claude'), CWD, BIN, path.join(SB, 'appdata'), path.join(SB, 'localappdata'), path.join(SB, 'xdg')]) {
    fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(BLOCKER, 'a regular file where every state directory should be\n');
fs.writeFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
fs.writeFileSync(path.join(CWD, 'README.md'), 'fixture\n');
const gitId = ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture'];
execFileSync('git', ['init', '-q'], { cwd: CWD, stdio: 'ignore' });
execFileSync('git', [...gitId, 'add', '.'], { cwd: CWD, stdio: 'ignore' });
execFileSync('git', [...gitId, 'commit', '-qm', 'fixture'], { cwd: CWD, stdio: 'ignore' });
for (const tool of ['ps', 'taskkill', 'tasklist', 'wmic', 'powershell']) {
    if (process.platform === 'win32') {
        fs.writeFileSync(path.join(BIN, tool + '.cmd'), `@echo ${tool}>>"${SHIM_LOG}"\r\n@exit /b 1\r\n`);
    } else {
        const p = path.join(BIN, tool);
        fs.writeFileSync(p, `#!/bin/sh\necho ${tool} >> '${SHIM_LOG}'\nexit 1\n`);
        fs.chmodSync(p, 0o755);
    }
}

const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
function sandboxEnv(pluginRoot, broken) {
    const env = {};
    // The session running this suite sets its own CLAUDE_*, AUTODEV_* and sweep
    // variables, and several hooks read them. None may leak into a measurement.
    for (const [k, v] of Object.entries(process.env)) {
        if (!/^(CLAUDE_|AUTODEV_|AUTO_DEV_|SESSION_SWEEP_|QUOTA_BURN)/i.test(k)) env[k] = v;
    }
    const home = broken ? BLOCKER : HOME;
    Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: broken ? BLOCKER : path.join(HOME, '.claude'),
        APPDATA: broken ? BLOCKER : path.join(SB, 'appdata'),
        LOCALAPPDATA: broken ? BLOCKER : path.join(SB, 'localappdata'),
        XDG_CONFIG_HOME: broken ? BLOCKER : path.join(SB, 'xdg'),
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        [PATH_KEY]: BIN + path.delimiter + (process.env[PATH_KEY] || ''),
    });
    return env;
}

const SESSION_ID = '0b0e5a1e-7e57-4b0d-9e7e-000000000024';
function payloadFor(w) {
    const base = { session_id: SESSION_ID, transcript_path: TRANSCRIPT, cwd: CWD, hook_event_name: w.event };
    const tool = (tool_name, tool_input) => {
        const p = { ...base, tool_name, tool_input };
        if (w.event === 'PostToolUse') p.tool_response = { success: true };
        if (w.event === 'PostToolUseFailure') p.error = 'fixture failure';
        return p;
    };
    switch (w.event) {
        case 'SessionStart': return { ...base, source: 'startup' };
        case 'UserPromptSubmit': return { ...base, prompt: 'what does this repo do?' };
        case 'PreToolUse':
        case 'PostToolUse':
        case 'PostToolUseFailure':
            if (/send_message/.test(w.matcher)) return tool('mcp__ccd_session_mgmt__send_message', { to: 'peer', message: 'status: done' });
            if (w.matcher === 'AskUserQuestion') {
                return tool('AskUserQuestion', { questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A (Recommended)', description: 'first' }, { label: 'B', description: 'second' }] }] });
            }
            if (w.matcher === 'Bash') return tool('Bash', { command: 'git status' });
            if (w.matcher === 'ArtifactData') return tool('ArtifactData', { action: 'get', url: 'https://claude.ai/artifact/fixture', collection: 'c', doc_id: 'd' });
            if (w.matcher === 'Write|Edit') return tool('Write', { file_path: path.join(CWD, 'notes.md'), content: 'x' });
            return tool('Read', { file_path: path.join(CWD, 'README.md') });
        case 'Stop': return { ...base, stop_hook_active: false };
        case 'StopFailure': return { ...base, error: 'rate_limit' };
        case 'PreCompact': return { ...base, trigger: 'auto', custom_instructions: '' };
        case 'PostCompact': return { ...base, trigger: 'auto' };
        case 'InstructionsLoaded': return { ...base, file_path: path.join(CWD, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' };
        case 'SessionEnd': return { ...base, reason: 'other' };
        default: return base;
    }
}

// cpuMs is the CPU the hook process and its Node descendants spent, read from
// their own records; null when the hook left no record (killed, or the preload
// did not load). The timeout stays: it is the wall-clock watchdog.
function run(file, input, env, timeoutMs) {
    const r = spawnSyncCpu(process.execPath, [file], { cwd: CWD, input, encoding: 'utf8', env, timeout: timeoutMs, windowsHide: true });
    const error = r.error ? r.error.code || String(r.error) : r.signal ? `killed by ${r.signal}` : null;
    return { cpuMs: r.cpu.cpuMs, cpuWhy: r.cpu.why, wallMs: r.wallMs, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error };
}

// An empty script, run through run() like a hook, so the floor pays exactly what
// a hook pays before its first line: the spawn, the module load, cwd, env and
// stdin. `node -e ""` looks equivalent and is not: passed as a file argument it
// became `node -e` with no script, which exits on the usage error and read 28 ms
// against the 47 ms a real empty module costs.
const EMPTY = path.join(SB, 'empty.js');
fs.writeFileSync(EMPTY, '');
const floorRun = (env) => run(EMPTY, '', env, 30000);
// `missing` names the first run with no CPU record; its figures are then not
// a measurement and the caller reports NOT MEASURED.
function measure(file, input, env, timeoutMs, sampleFloor = floorRun) {
    const hook = [];
    const floor = [];
    const hookWall = [];
    const floorWall = [];
    let last;
    let missing = null;
    for (let i = 0; i < RUNS; i++) {
        const f = sampleFloor(env);
        last = run(file, input, env, timeoutMs);
        if (f.cpuMs === null) missing = missing || `floor run: ${f.cpuWhy}`;
        if (last.cpuMs === null) missing = missing || `hook run: ${last.cpuWhy}`;
        floor.push(f.cpuMs);
        hook.push(last.cpuMs);
        floorWall.push(f.wallMs);
        hookWall.push(last.wallMs);
    }
    // Wall time is read whether or not a CPU record exists: a hook killed at its
    // timeout writes no CPU record and is exactly the case the wall judge is for.
    const wall = { hookWallMin: Math.min(...hookWall), floorWallMin: Math.min(...floorWall) };
    if (missing) return { missing, last, ...wall };
    return { hookMin: Math.min(...hook), hookMed: hook.sort((a, b) => a - b)[Math.floor(RUNS / 2)], floorMin: Math.min(...floor), last, ...wall };
}

// Keep the canary construction in one place so a scripted floor change can
// exercise the same subprocess and judge as the live control.
function measureCanary(w, env, mode, sampleFloor = floorRun) {
    const samples = Array.from({ length: RUNS }, () => sampleFloor(env));
    const floors = samples.map((f) => f.cpuMs);
    if (floors.some((f) => f === null)) return { missing: 'the floor run left no CPU record' };
    const floorMin = Math.min(...floors);
    // A scripted floor carries no wall figure; the reference stands in for it.
    const walls = samples.map((f) => f.wallMs).filter(Number.isFinite);
    const floorWallMin = walls.length ? Math.min(...walls) : WALL_FLOOR_REF_MS;
    // Bind the plant and its verdict to one calibration. A second floor can
    // raise the scaled budget after the burn was sized. Include the floor in
    // the burn too, since judgeCost subtracts it from the measured total CPU.
    const cpuExtraMs = Math.ceil(floorMin + BUDGET_MS[w.event] * Math.max(1, floorMin / FLOOR_REF_MS) * 1.5) + 100;
    // The sleep must also clear the scaled WALL budget, or the wall judge could
    // pass it for being short rather than miss it for being blind. It is never
    // shorter than before, so the CPU judge sees the same sleep it always did.
    const wallExtraMs = Math.ceil(WALL_BUDGET_MS[w.event] * wallScale(floorWallMin) * 1.5) + 100;
    const extraMs = mode === 'sleep' ? Math.max(cpuExtraMs, wallExtraMs) : cpuExtraMs;
    const file = path.join(SB, mode + '-' + path.basename(w.rel));
    const real = JSON.stringify(path.join(w.pluginRoot, w.rel));
    const prefix = mode === 'burn'
        ? `{ const t = process.cpuUsage(); for (;;) { const d = process.cpuUsage(t); if ((d.user + d.system) / 1000 >= ${extraMs}) break; } }\n`
        : mode === 'sleep' ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${extraMs});\n` : '';
    fs.writeFileSync(file, prefix + `require(${real});\n`);
    return { ...measure(file, JSON.stringify(payloadFor(w)), env, 60000, () => ({ cpuMs: floorMin, wallMs: floorWallMin })), extraMs };
}

// ---------------------------------------------------------------- the wired list, checked

const wired = readWired();
const hookFiles = [...new Set(wired.map((w) => w.key))];
console.log(`population: ${wired.length} wired entries, ${hookFiles.length} hook files, ${new Set(wired.map((w) => w.event)).size} events, across ${PLUGINS.join(', ')}`);
check(`the wired list is not empty (${wired.length} entries)`, wired.length > 0);
{
    const { unclassified, stale } = classification(wired, DECISIONS);
    check('every wired hook has a written failure decision', unclassified.length === 0, unclassified);
    check('every failure decision names a wired hook', stale.length === 0, stale);
}
check('every wired hook declares a timeout', missingTimeouts(wired).length === 0, missingTimeouts(wired));
check('every wired event has a budget', unbudgeted(wired).length === 0, unbudgeted(wired));
check('every wired event has a wall budget and an event ceiling', wallUnbudgeted(wired).length === 0, wallUnbudgeted(wired));
// The wall budget is the bound BELOW the harness timeout: at its widest scale
// it must still end before the harness would kill the hook, or it bounds
// nothing the timeout did not already.
{
    const loose = wallBudgetOverTimeout(wired);
    check(`every wall budget at ${WALL_SCALE_MAX}x stays under its hook's timeout`, loose.length === 0, loose);
}

// ---------------------------------------------------------------- cost, per wired entry

// CPU and wall cost of every entry in one wired list, plus the event sums.
// `prefix` names the profile in each check line, so an installed-profile run
// reads apart from the repo run.
function costRows(list, prefix = '') {
    const rows = [];
    for (const w of list) {
        if (!(w.event in BUDGET_MS)) continue;
        const file = path.join(w.pluginRoot, w.rel);
        const env = sandboxEnv(w.pluginRoot, false);
        const timeoutMs = (w.timeout || 60) * 1000;
        const m = measure(file, JSON.stringify(payloadFor(w)), env, timeoutMs);
        const label = `${prefix}${w.event}${w.matcher ? ` [${w.matcher}]` : ''} ${w.key}`;
        // A crash is fast. A timing only means something for a run that finished its
        // work, so the valid run must have exited 0 before its time is believed.
        check(`${label}: a valid payload exits 0`, m.last.status === 0 && !m.last.error, { status: m.last.status, error: m.last.error, stderr: m.last.stderr.slice(0, 200) });
        const jw = judgeWall(w.event, m.hookWallMin, m.floorWallMin);
        check(`${label}: ${jw.overhead.toFixed(0)} wall ms over the node floor, wall budget ${jw.budget.toFixed(0)} ms`, !jw.over && !m.last.error,
            { hookWallMin: +m.hookWallMin.toFixed(1), floorWallMin: +m.floorWallMin.toFixed(1), scale: +jw.scale.toFixed(2), error: m.last.error });
        const wallRow = { wallOverhead: jw.overhead, wallBudget: jw.budget, hookWallMin: m.hookWallMin, floorWallMin: m.floorWallMin };
        if (m.missing) { unmeasured(`${label}: CPU cost`, m.missing); rows.push({ label, event: w.event, timeout: w.timeout, ...wallRow }); continue; }
        const j = judgeCost(w.event, m.hookMin, m.floorMin);
        check(`${label}: ${j.overhead.toFixed(0)} CPU ms over the node floor, budget ${j.budget.toFixed(0)} ms`, !j.over,
            { hookMin: +m.hookMin.toFixed(1), floorMin: +m.floorMin.toFixed(1), scale: +j.scale.toFixed(2) });
        rows.push({ label, event: w.event, hookMin: m.hookMin, hookMed: m.hookMed, floorMin: m.floorMin, overhead: j.overhead, budget: j.budget, timeout: w.timeout, ...wallRow });
    }

    // Cumulative latency: what the user waits on one event, every wired hook summed.
    const eventRows = judgeEvents(rows);
    for (const e of eventRows) {
        check(`${prefix}${e.event}: ${e.hooks} hooks add ${e.sum.toFixed(0)} wall ms together, event ceiling ${e.ceiling.toFixed(0)} ms`, !e.over, e);
    }
    {
        const measuredEvents = new Set(rows.map((r) => r.event)).size;
        const wiredEvents = new Set(list.filter((w) => w.event in BUDGET_MS).map((w) => w.event)).size;
        check(`${prefix}every wired event was measured for cumulative latency (${eventRows.length} of ${wiredEvents})`, wiredEvents > 0 && eventRows.length === wiredEvents && measuredEvents === wiredEvents);
    }
    return { rows, eventRows };
}
const { rows, eventRows } = costRows(wired);

// ---------------------------------------------------------------- failure direction, per hook file

const badRuns = [];   // every bad-input run, kept for the flip check
for (const key of hookFiles) {
    const d = DECISIONS[key];
    if (!d) continue;
    const w = wired.find((x) => x.key === key);
    const file = path.join(w.pluginRoot, w.rel);
    const env = sandboxEnv(w.pluginRoot, false);
    const timeoutMs = (w.timeout || 60) * 1000;
    const inputs = [
        { label: 'garbage stdin', input: '{not json', bad: d.bad, says: d.says },
        { label: 'empty stdin', input: '', bad: d.bad, says: d.says },
        // An extra input's open direction is the silent one: exit 0, zero bytes.
        ...(d.extra || []).map((e) => ({ ...e, says: null })),
    ];
    for (const inp of inputs) {
        const r = run(file, inp.input, env, timeoutMs);
        const j = judgeBad(r, inp.bad, inp.says);
        check(`${key}: ${inp.label} fails ${inp.bad} (${d.why})`, j.ok, j.why);
        badRuns.push({ key, inp, r });
    }
}

// ---------------------------------------------------------------- unwritable state never blocks

for (const w of wired) {
    const file = path.join(w.pluginRoot, w.rel);
    const r = run(file, JSON.stringify(payloadFor(w)), sandboxEnv(w.pluginRoot, true), (w.timeout || 60) * 1000);
    const blocks = r.status === 2 || /"decision"\s*:\s*"block"/.test(r.stdout);
    check(`${w.event} ${w.key}: an unwritable state directory does not block the event`, !r.error && r.status === 0 && !blocks,
        { status: r.status, error: r.error, stdout: r.stdout.slice(0, 120), stderr: r.stderr.slice(0, 120) });
}

// Nothing reached a real process tool: every call landed on a shim. The shims log
// their own name, so a hook that bypassed PATH would leave the log short, and one
// that found the real binary would have run it. On Windows the cleanup hook's
// hotkey reset always calls taskkill, so an empty log there means the shims were
// never reached and the isolation above is unproven.
if (process.platform === 'win32') {
    const calls = fs.existsSync(SHIM_LOG) ? fs.readFileSync(SHIM_LOG, 'utf8').trim().split(/\s+/).filter(Boolean) : [];
    check(`process tools resolved to the shims (${calls.length} shim calls)`, calls.length > 0 && calls.every((c) => ['ps', 'taskkill', 'tasklist', 'wmic', 'powershell'].includes(c)), calls.slice(0, 10));
}

// ---------------------------------------------------------------- every judge fires

// A real wired hook, wrapped in a CPU burn past its event's budget, must go
// over. The burn spins until process.cpuUsage() has advanced by its length, so
// it adds at least that much CPU on a machine of any speed, and the budget it
// has to beat is the scaled one.
//
// The same hook wrapped in a SLEEP of the same length must NOT go over. A sleep
// costs wall time and no CPU, which is exactly what a loaded machine does to a
// subject: this is the control that a wall clock crept back into the
// measurement, or that the parent's CPU is being read in place of the hook's
// (that reads near zero, so the burn above would stop going over).
{
    const w = wired.find((x) => x.key === 'plugins/autodev-core/hooks/telemetry.js' && x.event === 'PostToolUse') || wired[0];
    const env = sandboxEnv(w.pluginRoot, false);
    {
        const hot = measureCanary(w, env, 'burn');
        if (hot.missing) unmeasured('known positive', hot.missing);
        else {
            const j = judgeCost(w.event, hot.hookMin, hot.floorMin);
            check(`known positive: ${w.key} burning ${hot.extraMs} CPU ms goes over its ${j.budget.toFixed(0)} ms budget (overhead ${j.overhead.toFixed(0)} ms)`, j.over);
        }
        const idle = measureCanary(w, env, 'sleep');
        if (idle.missing) unmeasured('known negative', idle.missing);
        else {
            const j = judgeCost(w.event, idle.hookMin, idle.floorMin);
            check(`known negative: ${w.key} sleeping ${idle.extraMs} ms stays inside its ${j.budget.toFixed(0)} ms budget (overhead ${j.overhead.toFixed(0)} CPU ms)`, !j.over);
            summary.sleepCpu = j.over ? 'FAIL' : 'PASS';
        }
        // The same sleep, judged on elapsed time, must go OVER: the wall judge
        // exists for exactly the cost the CPU judge is shown above to miss. Its
        // wall figure is read even when the CPU record is missing.
        if (Number.isFinite(idle.hookWallMin)) {
            const jw = judgeWall(w.event, idle.hookWallMin, idle.floorWallMin);
            check(`known positive: ${w.key} sleeping ${idle.extraMs} ms goes over its ${jw.budget.toFixed(0)} ms wall budget (overhead ${jw.overhead.toFixed(0)} wall ms)`, jw.over, jw);
            summary.sleepWall = jw.over ? 'FAIL' : 'PASS';
        } else unmeasured('wall known positive', 'the sleep canary left no wall figure');
    }

    // Model scheduling drift without competing with other suites for CPU.
    // The hook still runs as a real subprocess under the telemetry preload.
    let floorCalls = 0;
    const drift = measureCanary(w, env, 'burn', () => ({ cpuMs: ++floorCalls <= RUNS ? 47 : 141 }));
    if (drift.missing) unmeasured('canary calibration regression', drift.missing);
    else {
        const j = judgeCost(w.event, drift.hookMin, drift.floorMin);
        check('canary calibration: the burn and verdict use the same floor', floorCalls === RUNS && drift.floorMin === 47,
            { floorCalls, floorMin: drift.floorMin, extraMs: drift.extraMs });
        check('canary calibration: a later higher floor cannot hide the planted burn', j.over, j);
    }

    const clean = measureCanary(w, env, 'bare');
    if (clean.missing) unmeasured('plant removed', clean.missing);
    else {
        const j = judgeCost(w.event, clean.hookMin, clean.floorMin);
        check('plant removed: 0 cost findings across 1 real hook', !j.over && clean.last.status === 0 && !clean.last.error, j);
    }
}

// Every bad-input decision, flipped, must disagree with what the hook did. A
// judge that accepted both directions would pass every hook whatever it did.
{
    const agreeing = badRuns.filter(({ inp, r }) => judgeBad(r, flip(inp.bad), inp.says).ok).map(({ key, inp }) => `${key} ${inp.label}`);
    check(`known negative: all ${badRuns.length} bad-input verdicts go red with the direction flipped`, badRuns.length > 0 && agreeing.length === 0, agreeing);
    // A silent hook held to a `says` it does not print must go red too, or the
    // stdout half of the open judge is decoration.
    const silent = badRuns.filter(({ inp, r }) => inp.bad === 'open' && inp.says === null && judgeBad(r, 'open', null).ok);
    const wrongSays = silent.filter(({ r }) => judgeBad(r, 'open', /^\{"decision":"approve"\}/).ok);
    check(`known negative: ${silent.length} silent hooks go red when held to a banner they do not print`, silent.length > 0 && wrongSays.length === 0, wrongSays.map((x) => x.key));
    // INFORMS admits context and must refuse anything that steers the session,
    // or a hook that started blocking on bad input would pass as informing.
    const steering = ['{"decision":"block","reason":"x"}', '{"continue":false}', '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}', 'plain text'];
    const admitted = steering.filter((s) => INFORMS()(s));
    check(`known negative: INFORMS refuses ${steering.length} outputs that steer the session`, admitted.length === 0, admitted);
}

// The population checks report what they are shown to miss.
{
    const one = wired.find((w) => Number.isFinite(w.timeout)) || wired[0];
    const droppedTimeout = wired.map((w) => (w === one ? { ...w, timeout: undefined } : w));
    check(`known positive: ${one.key} with its timeout removed is reported`,
        missingTimeouts(droppedTimeout).length === missingTimeouts(wired).length + 1);
    const partial = { ...DECISIONS };
    delete partial[one.key];
    partial['plugins/autodev-core/hooks/no-such-hook.js'] = OPEN('fixture');
    const c = classification(wired, partial);
    check('known positive: an unclassified hook and a stale decision are both reported',
        c.unclassified.length === 1 && c.unclassified[0] === one.key && c.stale.length === 1);
    const saved = WALL_BUDGET_MS[one.event];
    delete WALL_BUDGET_MS[one.event];
    const missingWall = wallUnbudgeted(wired);
    WALL_BUDGET_MS[one.event] = saved;
    check(`known positive: ${one.event} with its wall budget removed is reported`, missingWall.length === 1 && missingWall[0] === one.event, missingWall);
    const longTimeout = wallBudgetOverTimeout(wired.map((w) => (w === one ? { ...w, timeout: 0.1 } : w)));
    check(`known positive: ${one.key} with a 0.1 s timeout under its wall budget is reported`, longTimeout.length === 1, longTimeout);
}

// The wall judges, on hand-written figures that cannot move with the subject.
{
    // Scale is capped: a floor ten times the reference widens the budget three
    // times, not ten, so a hook 2,000 ms over still reads over.
    const capped = judgeWall('PreToolUse', 550 + 2000, 550);
    check(`known positive: a ${550} ms floor scales the wall budget to the ${WALL_SCALE_MAX}x cap, and 2000 ms over it is reported`,
        capped.scale === WALL_SCALE_MAX && capped.over, capped);
    // Scale never shrinks: a fast floor leaves the frozen budget whole.
    const fast = judgeWall('PreToolUse', 10 + 50, 10);
    check('known negative: a floor under the reference keeps the full wall budget', fast.scale === 1 && !fast.over, fast);
    // Two hooks each under their own wall budget, summing over the event ceiling.
    const pair = judgeEvents([
        { event: 'PreToolUse', wallOverhead: 90, floorWallMin: 55 },
        { event: 'PreToolUse', wallOverhead: 90, floorWallMin: 55 },
        { event: 'PreToolUse', wallOverhead: 90, floorWallMin: 55 },
    ]);
    check('known positive: three PreToolUse hooks at 90 wall ms each, inside each own budget, go over the event ceiling together',
        pair.length === 1 && pair[0].hooks === 3 && pair[0].sum === 270 && pair[0].over, pair);
    const credit = judgeEvents([{ event: 'Stop', wallOverhead: -500, floorWallMin: 55 }, { event: 'Stop', wallOverhead: 320, floorWallMin: 55 }]);
    check('known positive: a hook faster than its floor is no credit against another hook over the ceiling', credit[0].over, credit);
}

// ---------------------------------------------------------------- a hook killed at its timeout

// A hook that spawns a child and is then killed at its timeout must not leave
// that child running in the user's session. Killing only the hook's own pid does
// leave it (Windows does not take children down with a parent, and POSIX
// reparents them), so the harness path here kills the TREE, through
// tooling/suite-process-tree.js, and the check counts what is still alive after.
//
// The count is taken apart from the helper that does the killing: identities
// (pid plus creation time) of the hook's descendants are read from a snapshot
// while the hook is alive, and looked up again after. A root-only kill of the
// same canary is the known positive: it must leave the child alive, and the
// count must see it, or a count of zero means nothing. The child the canary
// reports by its own pid is the provenance: the count must have found THAT one.
//
// The child is spawned detached. On Windows libuv puts a Node process's
// ordinary children in a job object that dies with it, so a plain child of a
// Node hook dies with the hook anyway. A detached one breaks away, which is the
// only way a Node hook leaves something behind there.
const { snapshot, trackTree } = require('./suite-process-tree.js');
const { spawn } = require('child_process');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CANARY_TIMEOUT_MS = 2500;

function descendantsOf(rows, rootPid) {
    const root = rows.find((r) => r.pid === rootPid);
    if (!root) return [];
    const out = [];
    const frontier = [root];
    while (frontier.length) {
        const p = frontier.pop();
        for (const r of rows) {
            if (r.parent === p.pid && r.pid !== p.pid && r.born >= p.born && !out.includes(r)) { out.push(r); frontier.push(r); }
        }
    }
    return out;
}

async function killedAtTimeout(how) {
    const ready = path.join(SB, `timeout-ready-${how}`);
    const file = path.join(SB, `timeout-canary-${how}.js`);
    // The child exits by itself after 30 s, so a failed cleanup cannot leave it
    // running for long. The hook never exits: only its timeout ends it.
    fs.writeFileSync(file, [
        "const { spawn } = require('child_process');",
        "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true, detached: true });",
        'c.unref();',
        `require('fs').writeFileSync(${JSON.stringify(ready)}, String(c.pid));`,
        'setInterval(() => {}, 1000);',
    ].join('\n') + '\n');
    const env = sandboxEnv(wired[0].pluginRoot, false);
    const started = Date.now();
    const child = spawn(process.execPath, [file], { cwd: CWD, env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const tree = trackTree(child.pid, started);
    const exited = new Promise((resolve) => child.once('exit', () => { tree.exited(); resolve(); }));
    child.stdin.end('{}');
    while (!fs.existsSync(ready) && Date.now() - started < CANARY_TIMEOUT_MS) await sleep(25);
    const before = await snapshot(20000);
    const born = descendantsOf(before, child.pid);
    await sleep(Math.max(0, started + CANARY_TIMEOUT_MS - Date.now()));
    const killedAtMs = Date.now() - started;
    if (how === 'tree') await tree.terminate();
    else { tree.stop(); child.kill('SIGKILL'); }
    await exited;
    const after = await snapshot(20000);
    const live = born.filter((d) => after.some((r) => r.pid === d.pid && r.born === d.born));
    let reported = null;
    try { reported = Number(fs.readFileSync(ready, 'utf8')); } catch { /* the canary never got as far as its child */ }
    const reportedFound = born.some((d) => d.pid === reported);
    return { descendants: born.length, live, killedAtMs, reported, reportedFound };
}

async function timeoutDescendants() {
    let tree;
    try { tree = await killedAtTimeout('tree'); } catch (e) { unmeasured('timeout descendants', `the process snapshot failed: ${e.message}`); return; }
    check(`a canary hook killed at its ${CANARY_TIMEOUT_MS} ms timeout had its own child among ${tree.descendants} descendants before the kill`, tree.reportedFound, tree);
    check(`a canary hook killed at its ${CANARY_TIMEOUT_MS} ms timeout leaves ${tree.live.length} live descendants`, tree.reportedFound && tree.live.length === 0,
        tree.live.map((r) => r.pid));
    if (tree.reportedFound) summary.descendants = tree.live.length;

    let root;
    try { root = await killedAtTimeout('root'); } catch (e) { unmeasured('timeout descendants known positive', `the process snapshot failed: ${e.message}`); return; }
    check(`known positive: the same canary with only its own pid killed leaves its detached child alive, and the count sees it (${root.live.length} of ${root.descendants} descendants live)`,
        root.reportedFound && root.live.some((r) => r.pid === root.reported), { reported: root.reported, descendants: root.descendants, live: root.live.map((r) => r.pid) });
    // Clean up the survivors the control was built to leave.
    for (const r of root.live) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* already gone */ } }
}

// ---------------------------------------------------------------- the installed profile

// --installed measures the hooks the plugin cache holds, the copy Claude Code
// actually runs, with the same cost, wall and event judges, and reports it as a
// separate profile. It is off in the default run, and so off in npm test and
// the gate: its subject is whatever this machine last installed, so its verdict
// says nothing about the tree under review, and a stale install would turn a
// green tree red.
function installedProfile() {
    const got = installedRoots();
    if (got.why) { unmeasured('installed profile', got.why); return null; }
    const list = readWired(got.roots);
    console.log(`installed population: ${list.length} wired entries, ${new Set(list.map((w) => w.key)).size} hook files, ${new Set(list.map((w) => w.event)).size} events, from ${PLUGINS.map((p) => `${p} ${got.versions[p]} at ${got.roots[p]}`).join('; ')}`);
    const unb = [...unbudgeted(list), ...wallUnbudgeted(list)];
    check('installed: every wired event has a CPU and wall budget', unb.length === 0, unb);
    return { list, ...costRows(list, 'installed: ') };
}

// ---------------------------------------------------------------- report

function printTable(title, rowsIn, eventRowsIn) {
    const n = (v) => (Number.isFinite(v) ? v.toFixed(0) : '-');
    console.log(`\n${title}`);
    console.log('event               overhead  budget  hook min/med  floor   wall over  budget  floor  timeout  hook');
    for (const r of [...rowsIn].sort((a, b) => b.wallOverhead - a.wallOverhead)) {
        console.log(`${r.event.padEnd(18)} ${n(r.overhead).padStart(8)} ${n(r.budget).padStart(7)}  ${n(r.hookMin).padStart(5)}/${n(r.hookMed).padEnd(5)} ${n(r.floorMin).padStart(6)}  ${n(r.wallOverhead).padStart(9)} ${n(r.wallBudget).padStart(7)} ${n(r.floorWallMin).padStart(6)} ${String(r.timeout).padStart(7)}s  ${r.label.replace(/^(installed: )?\S+ /, '')}`);
    }
    console.log('\nevent               hooks  wall sum  ceiling');
    for (const e of eventRowsIn) console.log(`${e.event.padEnd(18)} ${String(e.hooks).padStart(5)} ${n(e.sum).padStart(9)} ${n(e.ceiling).padStart(8)}`);
}

async function tail() {
    await timeoutDescendants();
    const installed = INSTALLED ? installedProfile() : null;
    if (REPORT) {
        printTable(`repo profile: ${rows.length} hooks measured on ${eventRows.length} events`, rows, eventRows);
        if (installed) printTable(`installed profile: ${installed.rows.length} hooks measured on ${installed.eventRows.length} events`, installed.rows, installed.eventRows);
        else console.log(`\ninstalled profile: ${INSTALLED ? 'not measured' : 'not run (pass --installed)'}`);
        const line = `sleep_control_cpu=${summary.sleepCpu || 'NOT_MEASURED'} sleep_control_wall=${summary.sleepWall || 'NOT_MEASURED'} timeout_descendants=${summary.descendants === null ? 'NOT_MEASURED' : summary.descendants}`;
        console.log(`\npopulation: ${rows.length} hooks on ${eventRows.length} events (repo)${installed ? `, ${installed.rows.length} hooks on ${installed.eventRows.length} events (installed)` : ''}`);
        console.log(line);
        if (line !== EXPECTED_SUMMARY) { fail++; console.log('FAIL the summary line differs from', EXPECTED_SUMMARY); }
    }
}

tail().catch((e) => { fail++; console.log('FAIL the suite tail threw', e && e.stack); }).finally(() => {
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* a locked temp file is the OS's to clear */ }
    console.log(`\n${pass} passed, ${fail} failed${notMeasured ? `, ${notMeasured} not measured` : ''}`);
    process.exitCode = fail ? 1 : notMeasured ? 2 : 0;
});
