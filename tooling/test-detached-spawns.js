#!/usr/bin/env node
// Every detached spawn the plugins ship is a reviewed one.
// Run: node tooling/test-detached-spawns.js
// Exits 1 on any failure; 0 if all pass.
//
// On Windows a detached child has no console. Any console program that child starts without
// windowsHide gets a new VISIBLE console window, which steals focus from whatever Andy is doing.
// On 2026-10-26 a dev-server launcher spawned doppler detached and next-server opened a window
// over a game. A detached node process is safe only while every spawn under it passes windowsHide,
// so each detached site below names why it is allowed, and a new one fails here until reviewed.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REVIEWED = new Map([
    ['plugins/autodev-core/scripts/fleet-view.js', 'takeover opens a console on purpose: the user asked for one'],
    ['plugins/autodev-core/scripts/headless-worker.js', 'the node supervisor spawns claude with windowsHide, so claude gets a hidden console'],
    ['plugins/autodev-core/scripts/worker-reconcile.js', 'the node verify child; its spawns pass windowsHide (unattended-worker git() included)'],
]);

let failed = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) failed++;
};

/** The detached spawn sites in one source text, as 1-based line numbers. */
function detachedSites(text) {
    const lines = [];
    const re = /detached:\s*true/g;
    let m;
    while ((m = re.exec(text))) lines.push(text.slice(0, m.index).split('\n').length);
    return lines;
}

function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
    }
    return out;
}

// The detector fires on a planted site before its pass is believed.
check('planted detached spawn is found', detachedSites("spawn('doppler', [], { detached: true })").length === 1);
check('a hidden attached spawn is not', detachedSites("spawn('doppler', [], { windowsHide: true })").length === 0);

const files = walk(path.join(ROOT, 'plugins'), []);
check('population: plugin sources found', files.length > 50, `${files.length} files`);
const found = new Map();
for (const f of files) {
    const sites = detachedSites(fs.readFileSync(f, 'utf8'));
    if (sites.length) found.set(path.relative(ROOT, f).replace(/\\/g, '/'), sites);
}
for (const [f, sites] of found) {
    check(`detached spawn in ${f}:${sites.join(',')} is reviewed`, REVIEWED.has(f), REVIEWED.get(f) || 'add a reason to REVIEWED, or spawn it attached with windowsHide');
}
for (const f of REVIEWED.keys()) check(`reviewed site ${f} still exists`, found.has(f), 'drop it from REVIEWED once it is gone');

// The verify child reaches unattended-worker's git(): it must not open a console.
const uw = fs.readFileSync(path.join(ROOT, 'plugins/autodev-core/scripts/unattended-worker.js'), 'utf8');
const gitCall = (uw.match(/spawnSync\('git', \['-C', repo[^\n]*/) || [''])[0];
check('unattended-worker git() passes windowsHide', /windowsHide:\s*true/.test(gitCall), gitCall ? 'call found' : 'call not found');

process.exitCode = failed ? 1 : 0;
