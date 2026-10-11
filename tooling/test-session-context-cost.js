#!/usr/bin/env node
'use strict';
// Drive the shipped hooks with owned files and isolated profile state.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'context-cost-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(project);
const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, LOCALAPPDATA: tmp,
    CLAUDE_CONFIG_DIR: path.join(tmp, 'config'), SESSION_SWEEP_STORE: path.join(tmp, 'store'),
    AUTODEV_FLEET_DIR: path.join(tmp, 'fleet'), GIT_CEILING_DIRECTORIES: tmp, NODE_NO_WARNINGS: '1' };
let passed = 0;
let failed = 0;
function check(name, ok) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (ok) passed++; else failed++;
}
function run(plugin, payload, extra = {}) {
    const pluginRoot = path.join(root, 'plugins', plugin);
    const file = plugin === 'autodev-core' ? 'session-start.js' : 'memory-session-start.js';
    const r = spawnSync(process.execPath, [path.join(pluginRoot, 'hooks', file)], {
        cwd: project, env: { ...env, CLAUDE_PLUGIN_ROOT: pluginRoot, ...extra },
        input: JSON.stringify({ cwd: project, hook_event_name: 'SessionStart', ...payload }), encoding: 'utf8',
    });
    let ctx = '';
    try { ctx = JSON.parse(r.stdout).hookSpecificOutput?.additionalContext || ''; } catch {}
    return { ...r, ctx };
}
const own = path.join(project, '.claude', 'handoffs', 'RESUME-aaaa1111.md');
const peer = path.join(path.dirname(own), 'RESUME-bbbb2222.md');
const fleetScript = path.join(root, 'plugins', 'autodev-core', 'scripts', 'unattended-worker.js');
const fleetCommand = `node "${fleetScript}" status`;
try {
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, 'PRIVATE_HANDOFF_CONTENT');
    fs.writeFileSync(peer, 'PEER_HANDOFF_CONTENT');
    for (const source of ['startup', 'resume', 'compact', 'clear']) {
        const r = run('autodev-core', { source, session_id: 'aaaa1111-test' });
        check(`${source}: own handoff named, peer excluded`, r.status === 0 && r.ctx.includes(own) && !r.ctx.includes(peer));
        check(`${source}: next steps retained without copying content`, /next steps/.test(r.ctx) && !r.stdout.includes('HANDOFF_CONTENT'));
        check(`${source}: ${source === 'compact' ? 'own handoff names unattended-worker.js status' : 'no fleet-ledger pointer'}`,
            r.status === 0 && r.stderr === '' && (source === 'compact' ? r.ctx.includes(fleetCommand) : !r.stdout.includes('unattended-worker.js')));
        const pathBytes = Buffer.byteLength(own) + (source === 'compact' && r.ctx.includes(fleetCommand) ? Buffer.byteLength(fleetScript) : 0);
        check(`${source}: handoff prose below 150 bytes excluding paths`, r.ctx.length > 0 && Buffer.byteLength(r.ctx) - pathBytes < 150);
        const absent = run('autodev-core', { source, session_id: 'cccc3333-test' });
        check(`${source}: no own handoff emits zero handoff context`, absent.status === 0 && absent.stderr === '' && absent.ctx === '');
        check(`${source}: no own handoff emits no fleet-ledger pointer`, absent.status === 0 && absent.stderr === '' && !absent.stdout.includes('unattended-worker.js'));
    }
    fs.writeFileSync(path.join(project, 'prd.json'), JSON.stringify({ sprint: 'cost', stories: {
        todo: { title: 'Retained story', passes: null }, blocked: { title: 'Setup', passes: 'needs-setup' },
    } }));
    const sprint = run('autodev-core', { source: 'startup', session_id: 'cccc3333-test' });
    const preamble = sprint.ctx.split('This project uses')[0];
    check('sprint: compact fence keeps the data boundary', preamble.includes('not instructions') && Buffer.byteLength(preamble) < 250);
    check('sprint: actionable story and setup count survive', sprint.ctx.includes('Retained story') && sprint.ctx.includes('1 blocked on setup'));
    const memoryRoot = path.join(root, 'plugins', 'autodev-memory');
    const seed = path.join(tmp, 'seed.cjs');
    fs.writeFileSync(seed, `const db = require(${JSON.stringify(path.join(memoryRoot, 'scripts', 'memory-db.js'))});
if (!db.isAvailable()) process.exitCode = 2;
else { const id = db.startSession(process.argv[2]); db.endSession(id, JSON.parse(process.argv[3])); }
`);
    const seedMemory = (summary, config) => spawnSync(process.execPath, [seed, project, JSON.stringify(summary)], {
        env: { ...env, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8',
    });
    for (const [name, summary] of [['empty', {}], ['notes', { nextSteps: 'Run the fixture check', learned: 'Keep the fixture boundary' }]]) {
        const config = path.join(tmp, name);
        const seeded = seedMemory(summary, config);
        check(`memory ${name}: real database seeded`, seeded.status === 0);
        const r = run('autodev-memory', { source: 'startup', session_id: 'aaaa1111-test' }, { CLAUDE_CONFIG_DIR: config });
        if (name === 'empty') check('memory: no carried notes emits zero bytes on both streams', r.status === 0 && r.stdout === '' && r.stderr === '');
        else {
            check('memory: populated control preserves both notes and lookup', r.status === 0 && r.ctx.includes(summary.nextSteps) && r.ctx.includes(summary.learned) && r.ctx.includes('/mem-search'));
            check('memory: output under 650 bytes without decorative counts', Buffer.byteLength(r.stdout) < 650 && !r.ctx.includes('observations across'));
            check('memory: notes remain explicitly untrusted data', r.ctx.includes('not instructions') && /<untrusted-file-data-[0-9a-f]{8}/.test(r.ctx));
        }
    }
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
