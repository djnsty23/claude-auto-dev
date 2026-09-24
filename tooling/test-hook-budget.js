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
//   1. a valid payload for its event, timed min-of-RUNS against a bare-node floor
//      measured interleaved with it, and judged against the event's budget;
//   2. garbage stdin and empty stdin, judged against the hook's decision;
//   3. a valid payload with every state directory pointing at a regular file,
//      which must never block the event (a guard that cannot write its ledger
//      has not seen a reason to refuse anything).
//
// BUDGETS ARE OVERHEAD, IN IDLE-MACHINE MILLISECONDS. Overhead is the hook's
// fastest run minus the fastest bare-node run beside it, so node's own startup
// is not charged to the hook. The budget scales up (never down) by how slow that
// floor is right now against FLOOR_REF_MS, so a contended machine slows the
// budget with the hook instead of turning load into a red.
//
// Every judge is shown to fire: a real wired hook wrapped in a sleep past its
// budget must go over, every decision flipped must disagree with what the hook
// actually did, and a wired list with one timeout removed or one hook
// unclassified must be reported.
//
// Nothing real is touched. HOME, USERPROFILE, CLAUDE_CONFIG_DIR, APPDATA,
// LOCALAPPDATA and XDG_CONFIG_HOME point into a temp dir, the cwd is a temp git
// repo, and ps, taskkill, tasklist, wmic and powershell are shadowed on PATH by
// shims that do nothing, because agent-browser-cleanup.js kills processes.
//
// Run: node tooling/test-hook-budget.js [--report]

'use strict';
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = ['autodev-core', 'autodev-memory'];
const REPORT = process.argv.includes('--report');
const RUNS = 3;

// `[measured 2026-09-24]` fastest run of an empty script on the box that set these budgets.
const FLOOR_REF_MS = 50;

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
    'plugins/autodev-memory/hooks/memory-prompt-capture.js': OPEN(
        'a capture that fails loses one memory, never the prompt'),
    'plugins/autodev-memory/hooks/memory-capture.js': OPEN(
        'a capture that fails loses one memory, never the tool result'),
    'plugins/autodev-memory/hooks/memory-session-end.js': OPEN(
        'the session is already ending, so a memory write that fails must not delay it'),
};

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
    if (ok) { pass++; console.log('PASS', label); } else { fail++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)); }
};

// ---------------------------------------------------------------- the wired list

function readWired(root = ROOT) {
    const wired = [];
    for (const plugin of PLUGINS) {
        const pluginRoot = path.join(root, 'plugins', plugin);
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

// ---------------------------------------------------------------- the judges

// Overhead over budget, with the budget scaled by the floor measured beside it.
function judgeCost(event, hookMinMs, floorMinMs) {
    const scale = Math.max(1, floorMinMs / FLOOR_REF_MS);
    const budget = BUDGET_MS[event] * scale;
    const overhead = hookMinMs - floorMinMs;
    return { over: overhead > budget, overhead, budget, scale };
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

function run(file, input, env, timeoutMs) {
    const t = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [file], { cwd: CWD, input, encoding: 'utf8', env, timeout: timeoutMs, windowsHide: true });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const error = r.error ? r.error.code || String(r.error) : r.signal ? `killed by ${r.signal}` : null;
    return { ms, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error };
}

// An empty script, run through run() like a hook, so the floor pays exactly what
// a hook pays before its first line: the spawn, the module load, cwd, env and
// stdin. `node -e ""` looks equivalent and is not: passed as a file argument it
// became `node -e` with no script, which exits on the usage error and read 28 ms
// against the 47 ms a real empty module costs.
const EMPTY = path.join(SB, 'empty.js');
fs.writeFileSync(EMPTY, '');
const floorRun = (env) => run(EMPTY, '', env, 30000);
function measure(file, input, env, timeoutMs) {
    const hook = [];
    const floor = [];
    let last;
    for (let i = 0; i < RUNS; i++) {
        floor.push(floorRun(env).ms);
        last = run(file, input, env, timeoutMs);
        hook.push(last.ms);
    }
    return { hookMin: Math.min(...hook), hookMed: hook.sort((a, b) => a - b)[Math.floor(RUNS / 2)], floorMin: Math.min(...floor), last };
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

// ---------------------------------------------------------------- cost, per wired entry

const rows = [];
for (const w of wired) {
    if (!(w.event in BUDGET_MS)) continue;
    const file = path.join(w.pluginRoot, w.rel);
    const env = sandboxEnv(w.pluginRoot, false);
    const timeoutMs = (w.timeout || 60) * 1000;
    const m = measure(file, JSON.stringify(payloadFor(w)), env, timeoutMs);
    const j = judgeCost(w.event, m.hookMin, m.floorMin);
    const label = `${w.event}${w.matcher ? ` [${w.matcher}]` : ''} ${w.key}`;
    // A crash is fast. A timing only means something for a run that finished its
    // work, so the valid run must have exited 0 before its time is believed.
    check(`${label}: a valid payload exits 0`, m.last.status === 0 && !m.last.error, { status: m.last.status, error: m.last.error, stderr: m.last.stderr.slice(0, 200) });
    check(`${label}: ${j.overhead.toFixed(0)} ms over the node floor, budget ${j.budget.toFixed(0)} ms`, !j.over,
        { hookMin: +m.hookMin.toFixed(1), floorMin: +m.floorMin.toFixed(1), scale: +j.scale.toFixed(2) });
    rows.push({ label, event: w.event, hookMin: m.hookMin, hookMed: m.hookMed, floorMin: m.floorMin, overhead: j.overhead, budget: j.budget, timeout: w.timeout });
}

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

// A real wired hook, wrapped in a sleep past its event's budget, must go over.
// The sleep is wall time (Atomics.wait), so it adds at least its length on a
// machine of any speed, and the budget it has to beat is the scaled one.
{
    const w = wired.find((x) => x.key === 'plugins/autodev-core/hooks/telemetry.js' && x.event === 'PostToolUse') || wired[0];
    const env = sandboxEnv(w.pluginRoot, false);
    const floorNow = Math.min(...Array.from({ length: RUNS }, () => floorRun(env).ms));
    const sleepMs = Math.ceil(BUDGET_MS[w.event] * Math.max(1, floorNow / FLOOR_REF_MS) * 1.5) + 100;
    const slow = path.join(SB, 'slow-' + path.basename(w.rel));
    fs.writeFileSync(slow, `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${sleepMs});\nrequire(${JSON.stringify(path.join(w.pluginRoot, w.rel))});\n`);
    const m = measure(slow, JSON.stringify(payloadFor(w)), env, 30000);
    const j = judgeCost(w.event, m.hookMin, m.floorMin);
    check(`known positive: ${w.key} slowed by ${sleepMs} ms goes over its ${j.budget.toFixed(0)} ms budget (overhead ${j.overhead.toFixed(0)} ms)`, j.over);
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
}

// ---------------------------------------------------------------- report

if (REPORT) {
    console.log('\nevent               overhead  budget  hook min/med  floor  timeout  hook');
    for (const r of rows.sort((a, b) => b.overhead - a.overhead)) {
        console.log(`${r.event.padEnd(18)} ${r.overhead.toFixed(0).padStart(8)} ${r.budget.toFixed(0).padStart(7)}  ${r.hookMin.toFixed(0).padStart(5)}/${r.hookMed.toFixed(0).padEnd(5)} ${r.floorMin.toFixed(0).padStart(6)} ${String(r.timeout).padStart(7)}s  ${r.label.replace(/^\S+ /, '')}`);
    }
}

try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* a locked temp file is the OS's to clear */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
