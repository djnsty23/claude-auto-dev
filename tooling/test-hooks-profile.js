#!/usr/bin/env node
// Tests for autodev-core's advisory hook switches: plugin userConfig booleans.
//
// Ported from ECC's hook profiles on 2026-09-07
// (docs/evidence-ecc-comparison-2026-09-07.md) as one string, `hooks_profile`.
// Replaced 2026-09-13 by one boolean per advisory hook, because a boolean is
// the only userConfig type the Config tab renders as a fixed choice: the field
// schema is strict and has no enum (read out of the 2.1.270 binary, which also
// shows the env contract: key upper-cased, value `String(v)`, so off arrives
// as CLAUDE_PLUGIN_OPTION_<KEY>="false").
//
// The property this suite exists for is the SPLIT. A guard that honoured a
// switch would be a guard the model can switch off by asking the user for a
// setting, so the two lists below are exhaustive over hooks.json: every wired
// hook is in exactly one, each advisory hook reads its own switch, and the
// guarding ones read no plugin option at all. A new hook fails here until it
// is classified.
//
// Run: node tooling/test-hooks-profile.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'autodev-core');
const HOOKS = path.join(PLUGIN, 'hooks');
const OPTION = 'CLAUDE_PLUGIN_OPTION_';
const envKey = (key) => OPTION + key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);

// Hooks that only advise, each with the userConfig key that switches it off.
const ADVISORY = {
    'post-tool-typecheck.js': 'typecheck',
    'stop-typecheck.js': 'typecheck',
    'telemetry.js': 'telemetry',
    'context-depth-nudge.js': 'context_nudge',
    'inbox-notify.js': 'inbox_notify',
    'user-prompt-image-scan.js': 'image_scan',
    'instructions-loaded.js': 'instructions_ledger',
    // #200's Stop note: names a lost workflow run and its resume command, as a
    // systemMessage with no decision key. It advises.
    'stop-workflow-wall-note.js': 'workflow_wall_note',
};
// Hooks that guard, block, or keep state the sprint and the Brain depend on.
const GUARDING = [
    'pre-tool-filter.js', 'coordinator-write-guard.js', 'panel-recommendation.js', 'peer-message-budget.js',
    'stop-auto-check.js', 'stop-brain-report.js', 'stop-failure-note.js', 'session-start.js',
    'agent-browser-cleanup.js', 'pre-compact.js', 'post-compact.js',
];

// ---------------------------------------------------------------- manifest

{
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    const cfg = manifest.userConfig || {};
    const keys = [...new Set(Object.values(ADVISORY))];
    check('plugin.json no longer declares the free-text hooks_profile', !('hooks_profile' in cfg));
    check('  and declares exactly one switch per advisory key', JSON.stringify(Object.keys(cfg).sort()) === JSON.stringify(keys.sort()), Object.keys(cfg));
    for (const k of keys) {
        const f = cfg[k];
        check(`  ${k} is a boolean defaulting to on, with a title and description`,
            !!f && f.type === 'boolean' && f.default === true && !!f.title && !!f.description, f);
    }
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
    const classified = new Set([...Object.keys(ADVISORY), ...GUARDING]);
    const unclassified = [...wired].filter((w) => !classified.has(w));
    const stale = [...classified].filter((c) => !wired.has(c));
    check('every wired hook is classified advisory or guarding', unclassified.length === 0, unclassified);
    check('  and nothing in the lists has been unwired', stale.length === 0, stale);
    check('  and no hook is in both lists', Object.keys(ADVISORY).every((a) => !GUARDING.includes(a)));

    for (const [f, key] of Object.entries(ADVISORY)) {
        const src = fs.readFileSync(path.join(HOOKS, f), 'utf8');
        const read = [...new Set(src.match(/CLAUDE_PLUGIN_OPTION_[A-Z0-9_]+/g) || [])];
        check(`${f} reads its own switch and no other`, read.length === 1 && read[0] === envKey(key), read);
    }
    for (const f of GUARDING) {
        const src = fs.readFileSync(path.join(HOOKS, f), 'utf8');
        check(`${f} reads no plugin option (a guard the model could switch off is no guard)`, !src.includes(OPTION));
    }
}

// The guard must sit where a `'use strict'` directive still counts: a
// statement inserted above the directive turns it into a no-op expression.
{
    for (const [f, key] of Object.entries(ADVISORY)) {
        const lines = fs.readFileSync(path.join(HOOKS, f), 'utf8').split('\n');
        const strict = lines.findIndex((l) => /^\s*['"]use strict['"];?\s*$/.test(l));
        const guard = lines.findIndex((l) => l.includes(envKey(key)) && /process\.exit\(0\)/.test(l));
        check(`${f}: the switch exits before any work`, guard >= 0, { guard });
        if (strict >= 0) check(`${f}: the switch sits below 'use strict'`, guard > strict, { strict, guard });
    }
}

// ---------------------------------------------------------------- behaviour

// Two advisory hooks with an observable side effect, each with a control run
// in a fresh directory, so neither case can pass on a hook that does nothing.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-')));
let n = 0;
const fresh = () => { const d = path.join(TMP, 'd' + ++n); fs.mkdirSync(d, { recursive: true }); return d; };
function runHook(file, dir, payload, options) {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    for (const k of Object.keys(env)) if (k.startsWith(OPTION)) delete env[k];
    for (const [k, v] of Object.entries(options || {})) env[envKey(k)] = v;
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
    const writes = (options) => { const d = fresh(); const r = runHook('telemetry.js', d, payload(d), options); return { r, count: reports(d).length }; };

    const off = writes({ telemetry: 'false' });
    check('telemetry=false writes no report', silent(off.r) && off.count === 0);
    check('  control: telemetry=true writes one', writes({ telemetry: 'true' }).count === 1);
    check('  and an unset switch reads as on', writes({}).count === 1);
    // Per-key, not global: switching a DIFFERENT hook off must not silence this one.
    check('  and another hook\'s switch does not reach it', writes({ context_nudge: 'false', typecheck: 'false' }).count === 1);
    // Only the exact value the host sends for off counts; anything else runs.
    check('  and a value the host never sends reads as on', writes({ telemetry: 'no' }).count === 1);
}

{
    const payload = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } };
    const pendingIn = (dir) => fs.existsSync(path.join(dir, '.claude', '.typecheck-pending'));
    const project = () => { const d = fresh(); fs.writeFileSync(path.join(d, 'package.json'), '{"name":"p","scripts":{}}'); return d; };
    const off = project();
    const r = runHook('post-tool-typecheck.js', off, payload, { typecheck: 'false' });
    check('post-tool-typecheck with typecheck=false records nothing', silent(r) && !pendingIn(off));
    const on = project();
    runHook('post-tool-typecheck.js', on, payload, {});
    check('  control: with no switch set it records', pendingIn(on));
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
