#!/usr/bin/env node
'use strict';
// Installed-profile sampler. Runs the installed hooks with representative inputs in
// disposable state, never against the user's project or session store. This measures
// the installed code's fixture path, not the latency of a real interactive session.
// Event ceilings follow tooling/test-hook-budget.js EVENT_WALL_CEILING_MS. We record
// raw summed wall time, so add the measured bare-node startup per hook to that ceiling.
// p95 is nearest-rank across five event samples. CPU >= 50% or a live worker tags load.
// Schedule as {id:"hook-wall",script:"hook-wall.js",everyMin:60}.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const { configDir } = require('./claude-paths.js');
const BUDGET = { PreToolUse: 250, PostToolUse: 200, PostToolUseFailure: 100, UserPromptSubmit: 150,
    Stop: 300, StopFailure: 150, PreCompact: 200, PostCompact: 150, InstructionsLoaded: 150, SessionEnd: 250, SessionStart: 1000 };
const SAMPLES = 5;
const p95 = (values) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

function installed(home) {
    const manifest = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'installed_plugins.json'), 'utf8'));
    const settingsFile = path.join(home, 'settings.json');
    const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    const hooks = [];
    const versions = {};
    for (const [key, entries] of Object.entries(manifest.plugins || {})) {
        if (!/^autodev-/.test(key) || settings.enabledPlugins?.[key] === false) continue;
        const entry = entries.find((x) => x.scope === 'user') || entries[entries.length - 1];
        if (!entry || !entry.installPath) throw new Error('invalid installed plugin entry');
        const file = path.join(entry.installPath, 'hooks', 'hooks.json');
        if (!fs.existsSync(file)) continue; // stack plugin has no hooks
        versions[key] = entry.version;
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [event, groups] of Object.entries(doc.hooks || {})) {
            if (!(event in BUDGET)) throw new Error(`no event budget for ${event}`);
            for (const group of groups) for (const hook of group.hooks || []) {
                if (hook.type !== 'command' || hook.command !== 'node' || !Array.isArray(hook.args)) throw new Error(`unsupported hook command for ${event}`);
                hooks.push({ event, matcher: group.matcher || '', root: entry.installPath, args: hook.args,
                    timeoutMs: Math.min(5000, (hook.timeout || 5) * 1000) });
            }
        }
    }
    if (!hooks.length) throw new Error('no installed hooks to sample');
    return { hooks, versions };
}

function payload(hook, root) {
    const p = { session_id: 'hook-wall-fixture', transcript_path: path.join(root, 'transcript.jsonl'), cwd: root, hook_event_name: hook.event,
        source: 'startup', prompt: 'Describe this repository', stop_hook_active: false, trigger: 'auto', reason: 'other', error: 'fixture failure' };
    let name = 'Read';
    let input = { file_path: path.join(root, 'README.md') };
    if (/Bash/.test(hook.matcher)) { name = 'Bash'; input = { command: 'git status' }; }
    else if (/Write|Edit/.test(hook.matcher)) { name = 'Write'; input = { file_path: path.join(root, 'notes.md'), content: 'fixture' }; }
    else if (/AskUserQuestion/.test(hook.matcher)) { name = 'AskUserQuestion'; input = { questions: [{ question: 'Which option?', header: 'Pick', options: [{ label: 'A (Recommended)', description: 'first' }, { label: 'B', description: 'second' }] }] }; }
    else if (/ArtifactData/.test(hook.matcher)) { name = 'ArtifactData'; input = { action: 'get', collection: 'fixture', doc_id: 'fixture' }; }
    else if (/send_message/.test(hook.matcher)) { name = 'mcp__ccd_session_mgmt__send_message'; input = { to: 'fixture', message: 'fixture' }; }
    return { ...p, tool_name: name, tool_input: input, tool_response: { success: true }, file_path: path.join(root, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' };
}

function cpu() {
    return os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((n, v) => n + v, 0) }), { idle: 0, total: 0 });
}
function liveWorker(home) {
    const file = path.join(home, 'autodev', 'headless-workers.json');
    if (!fs.existsSync(file)) return false;
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(ledger.records)) throw new Error('unreadable worker population');
    return ledger.records.some((r) => {
        if (!['starting', 'running'].includes(r.state) || !Number.isInteger(r.pid) || r.pid <= 0) return false;
        try { process.kill(r.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
    });
}

function sample(home) {
    const profile = installed(home);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-wall-'));
    try {
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin);
        for (const name of ['ps', 'taskkill', 'tasklist', 'wmic', 'powershell', 'pwsh']) {
            const file = path.join(bin, name + (process.platform === 'win32' ? '.cmd' : ''));
            fs.writeFileSync(file, process.platform === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        }
        const env = {};
        for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'Path']) if (process.env[key]) env[key] = process.env[key];
        const pk = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
        env[pk] = bin + path.delimiter + (env[pk] || '');
        Object.assign(env, { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'config'), APPDATA: root, LOCALAPPDATA: root,
            XDG_CONFIG_HOME: root, TMP: root, TEMP: root, TMPDIR: root });
        for (const name of ['README.md', 'CLAUDE.md', 'transcript.jsonl']) fs.writeFileSync(path.join(root, name), '');
        const rows = [];
        const deadline = Date.now() + 75000;
        for (const event of [...new Set(profile.hooks.map((h) => h.event))]) {
            const hooks = profile.hooks.filter((h) => h.event === event);
            const values = [];
            const floors = [];
            const before = cpu();
            const worker = liveWorker(home);
            let errors = 0;
            for (let i = 0; i < SAMPLES; i++) {
                let wall = 0;
                const start = performance.now();
                const floor = spawnSync(process.execPath, ['-e', ''], { env, cwd: root, windowsHide: true, timeout: 3000 });
                floors.push(performance.now() - start);
                if (floor.error || floor.status !== 0) errors++;
                for (const h of hooks) {
                    if (Date.now() > deadline) throw new Error('sampling deadline exceeded');
                    const t = performance.now();
                    const r = spawnSync(process.execPath, h.args.map((a) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', h.root)), {
                        env: { ...env, CLAUDE_PLUGIN_ROOT: h.root }, cwd: root, input: JSON.stringify(payload(h, root)), encoding: 'utf8', windowsHide: true, timeout: h.timeoutMs });
                    wall += performance.now() - t;
                    if (r.error || r.signal || r.status !== 0) errors++;
                }
                values.push(wall);
            }
            const after = cpu();
            const busy = after.total > before.total ? 1 - (after.idle - before.idle) / (after.total - before.total) : null;
            rows.push({ at: new Date().toISOString(), event, profile: profile.versions, mode: 'isolated-representative',
                eventInventory: [...new Set(profile.hooks.map((h) => h.event))].sort(),
                load: worker || busy === null || busy >= 0.5 ? 'load' : 'idle', cpuBusy: busy, worker,
                samples: values, hooks: hooks.length, p95Ms: p95(values), budgetMs: BUDGET[event] + p95(floors) * hooks.length,
                startupMs: p95(floors), errors });
        }
        return rows;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function main(argv) {
    if (argv.includes('--help')) { console.log('Usage: node hook-wall.js [--json]'); return 0; }
    const home = process.env.BRAIN_CLOCK_CLAUDE_DIR || configDir();
    const rows = sample(home);
    const file = path.join(home, 'autodev', 'windows', 'hook-wall.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    if (argv.includes('--json')) console.log(JSON.stringify(rows));
    return rows.some((r) => r.errors || r.p95Ms > r.budgetMs) ? 1 : 0;
}
if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (e) { console.error(`hook-wall: ${e.code || e.message}`); process.exitCode = 2; }
}
module.exports = { installed, payload, cpu, liveWorker, sample, main };
