#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const script = process.env.HOOK_WALL_SUBJECT || path.resolve(__dirname, '../plugins/autodev-core/scripts/hook-wall.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-wall-test-'));
const plugin = path.join(root, 'plugins', 'fixture');
fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
let passed = 0;
let failed = 0;
function check(name, ok) { if (ok) passed++; else { failed++; console.log(`FAIL ${name}`); } }
const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root, BRAIN_CLOCK_CLAUDE_DIR: root };
const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
const manifest = path.join(root, 'plugins', 'installed_plugins.json');
const hook = path.join(plugin, 'hooks', 'fixture.js');
const hookBody = "const fs=require('fs'); let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{const p=JSON.parse(s); if(p.tool_name!=='Bash'||p.tool_input.command!=='git status'||process.env.HOME===process.env.CLAUDE_PLUGIN_ROOT) process.exitCode=1; fs.writeFileSync(process.env.HOME+'/sample-marker','ok'); });\n";
try {
    fs.writeFileSync(manifest, JSON.stringify({ plugins: { 'autodev-core@test': [{ scope: 'user', version: '1', installPath: plugin }] } }));
    fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/fixture.js'], timeout: 2 }] }] } }));
    fs.writeFileSync(hook, hookBody);
    let r = run('--json');
    let row = JSON.parse(r.stdout)[0];
    check('installed profile and representative stdin ran', r.status === 0 && row.errors === 0 && row.hooks === 1 && row.profile['autodev-core@test'] === '1');
    check('p95 is measured from five wall samples', row.samples.length === 5 && row.samples.every((x) => x > 0) && row.p95Ms === Math.max(...row.samples));
    check('budget uses existing event ceiling and startup', Math.abs(row.budgetMs - row.startupMs - 250) < 0.001);
    check('sample carries load classification', ['idle', 'load'].includes(row.load) && typeof row.cpuBusy === 'number');
    check('hook state stays disposable', !fs.existsSync(path.join(root, 'sample-marker')));
    fs.writeFileSync(path.join(root, 'autodev', 'headless-workers.json'), JSON.stringify({ records: [{ state: 'running', pid: process.pid }] }));
    r = run('--json');
    row = JSON.parse(r.stdout)[0];
    check('live worker tags load', row.load === 'load' && row.worker === true);
    fs.writeFileSync(hook, hookBody + 'setTimeout(()=>{},650);\n');
    r = run('--json');
    row = JSON.parse(r.stdout)[0];
    check('slow hook exceeds budget', r.status === 1 && row.p95Ms > row.budgetMs && row.errors === 0);
    fs.writeFileSync(hook, 'process.exitCode=1;\n');
    r = run('--json');
    row = JSON.parse(r.stdout)[0];
    check('failed hooks are recorded as failures', r.status === 1 && row.errors === 5);
    const rows = fs.readFileSync(path.join(root, 'autodev/windows/hook-wall.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    check('one dated row per sampled event', rows.length === 4 && rows.every((x) => Number.isFinite(Date.parse(x.at))));
    fs.writeFileSync(manifest, '{"plugins":{}}');
    check('empty installed population exits 2', run().status === 2);
    check('help needs no installed profile', run('--help').status === 0);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`hook-wall: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
