#!/usr/bin/env node
// Tests for autodev-core's hook profile: plugin userConfig `hooks_profile`.
//
// Ported from ECC's hook profiles on 2026-09-07
// (docs/evidence-ecc-comparison-2026-09-07.md), as one boolean-shaped choice
// rather than three tiers: `minimal` keeps every hook that guards or blocks
// and skips every hook that only advises. Claude Code hands a plugin's
// userConfig to its hooks as CLAUDE_PLUGIN_OPTION_<KEY> (read out of the
// shipping binary, 2.1.233: "they become CLAUDE_PLUGIN_OPTION_<KEY> env vars
// in hooks"), which is the only plumbing this needs.
//
// The property this suite exists for is the SPLIT. A guard that honoured the
// profile would be a guard the model can switch off by asking the user for a
// setting, so the two lists below are exhaustive over hooks.json: every wired
// hook is in exactly one, the advisory ones carry the guard line, and the
// guarding ones must NOT. A new hook fails here until it is classified.
//
// Run: node tooling/test-hooks-profile.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'autodev-core');
const HOOKS = path.join(PLUGIN, 'hooks');
const GUARD = 'CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE';

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);

// Hooks that only advise: under `minimal` they exit before reading stdin.
const ADVISORY = [
    'post-tool-typecheck.js', 'stop-typecheck.js', 'telemetry.js', 'context-depth-nudge.js',
    'inbox-notify.js', 'user-prompt-image-scan.js', 'instructions-loaded.js',
    // #200's Stop note: names a lost workflow run and its resume command, as a
    // systemMessage with no decision key. It advises.
    'stop-workflow-wall-note.js',
];
// Hooks that guard, block, or keep state the sprint and the Brain depend on.
const GUARDING = [
    'pre-tool-filter.js', 'coordinator-write-guard.js', 'panel-recommendation.js', 'peer-message-budget.js',
    'stop-auto-check.js', 'stop-brain-report.js', 'stop-failure-note.js', 'session-start.js',
    'agent-browser-cleanup.js', 'pre-compact.js', 'post-compact.js',
    // #214's checkpoint: it does not advise, it ACTS — stages the at-risk paths, commits,
    // pushes, and writes the fleet-intent record the Brain reads. `minimal` exists to cut
    // chatter; a reader who set it to be talked to less must not thereby lose the rescue
    // that runs when their session is about to die. It guards.
    'usage-checkpoint.js',
];

// ---------------------------------------------------------------- manifest

{
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    const cfg = manifest.userConfig && manifest.userConfig.hooks_profile;
    check('plugin.json declares userConfig.hooks_profile', !!cfg);
    check('  as a string defaulting to full', cfg && cfg.type === 'string' && cfg.default === 'full');
    check('  and its description names minimal', cfg && /minimal/.test(cfg.description || ''));
}

// ---------------------------------------------------------------- the split

{
    const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
    const wired = new Set();
    for (const groups of Object.values(cfg.hooks || {})) {
        for (const g of groups) for (const h of g.hooks || []) {
            const a = (h.args || []).find((x) => /\/hooks\/[^/]+\.js$/.test(x));
            if (a) wired.add(path.basename(a));
        }
    }
    const classified = new Set([...ADVISORY, ...GUARDING]);
    const unclassified = [...wired].filter((w) => !classified.has(w));
    const stale = [...classified].filter((c) => !wired.has(c));
    check('every wired hook is classified advisory or guarding', unclassified.length === 0, unclassified);
    check('  and nothing in the lists has been unwired', stale.length === 0, stale);
    check('  and no hook is in both lists', ADVISORY.every((a) => !GUARDING.includes(a)));

    for (const f of ADVISORY) {
        const src = fs.readFileSync(path.join(HOOKS, f), 'utf8');
        check(`${f} honours the profile`, src.includes(GUARD));
    }
    for (const f of GUARDING) {
        const src = fs.readFileSync(path.join(HOOKS, f), 'utf8');
        check(`${f} does NOT honour it (a guard the model could switch off is no guard)`, !src.includes(GUARD));
    }
}

// The guard must sit where a `'use strict'` directive still counts: a
// statement inserted above the directive turns it into a no-op expression.
{
    for (const f of ADVISORY) {
        const lines = fs.readFileSync(path.join(HOOKS, f), 'utf8').split('\n');
        const strict = lines.findIndex((l) => /^\s*['"]use strict['"];?\s*$/.test(l));
        const guard = lines.findIndex((l) => l.includes(GUARD) && /process\.exit\(0\)/.test(l));
        if (strict >= 0) check(`${f}: the guard sits below 'use strict'`, guard > strict, { strict, guard });
    }
}

// ---------------------------------------------------------------- behaviour

// Two advisory hooks with an observable side effect, each with a control run
// under `full` in a fresh directory, so neither case can pass on a hook that
// does nothing at all.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-')));
let n = 0;
const fresh = () => { const d = path.join(TMP, 'd' + ++n); fs.mkdirSync(d, { recursive: true }); return d; };
function runHook(file, dir, payload, profile) {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    delete env.CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE;
    delete env.CLAUDE_PLUGIN_OPTION_hooks_profile;
    if (profile !== undefined) env.CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE = profile;
    const r = spawnSync(process.execPath, [path.join(HOOKS, file)], {
        input: JSON.stringify(payload), encoding: 'utf8', cwd: dir, env,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const silent = (r) => r.status === 0 && r.stdout === '' && r.stderr === '';

{
    const payload = (dir) => ({
        hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
        tool_response: { stdout: '', stderr: '' }, session_id: 'x', cwd: dir, duration_ms: 1,
    });
    const reports = (dir) => {
        try { return fs.readdirSync(path.join(dir, '.claude', 'reports')).filter((f) => f.startsWith('telemetry-')); } catch { return []; }
    };
    const off = fresh();
    const r = runHook('telemetry.js', off, payload(off), 'minimal');
    check('telemetry under minimal writes no report', silent(r) && reports(off).length === 0);
    const on = fresh();
    runHook('telemetry.js', on, payload(on), 'full');
    check('  control: telemetry under full writes one', reports(on).length === 1, reports(on));
    const upper = fresh();
    const u = runHook('telemetry.js', upper, payload(upper), 'MINIMAL');
    check('  the value is case-insensitive', silent(u) && reports(upper).length === 0);
    const other = fresh();
    runHook('telemetry.js', other, payload(other), 'strict');
    check('  and any other value reads as full', reports(other).length === 1);
}

{
    const payload = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } };
    const pendingIn = (dir) => fs.existsSync(path.join(dir, '.claude', '.typecheck-pending'));
    const off = fresh();
    fs.writeFileSync(path.join(off, 'package.json'), '{"name":"p","scripts":{}}');
    const r = runHook('post-tool-typecheck.js', off, payload, 'minimal');
    check('post-tool-typecheck under minimal records nothing', silent(r) && !pendingIn(off));
    const on = fresh();
    fs.writeFileSync(path.join(on, 'package.json'), '{"name":"p","scripts":{}}');
    runHook('post-tool-typecheck.js', on, payload, undefined);
    check('  control: with no profile set it records', pendingIn(on));
}

// The lowercase key variant, in case the host does not upper-case the key.
{
    const dir = fresh();
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"p","scripts":{}}');
    const env = { ...process.env, CLAUDE_PLUGIN_OPTION_hooks_profile: 'minimal' };
    delete env.CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE;
    const r = spawnSync(process.execPath, [path.join(HOOKS, 'post-tool-typecheck.js')], {
        input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } }), encoding: 'utf8', cwd: dir, env,
    });
    check('the lowercase env key is honoured too', r.status === 0 && r.stdout === '' && !fs.existsSync(path.join(dir, '.claude', '.typecheck-pending')));
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok, detail] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || detail === undefined ? '' : '\n      -> ' + JSON.stringify(detail)));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
