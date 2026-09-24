#!/usr/bin/env node
'use strict';
/**
 * check-hook-parse.js - every hook file parses under `node --check`, as CI checks it.
 *
 * WHY. CI runs `for f in plugins/*\/hooks/*.js; do node --check "$f"; done` and
 * the local gate had no equivalent, so "the gate is green" and "CI is green" were
 * claims about different checks. A hook ships into someone else's session, and a
 * syntax error there kills their turn on every event it is wired to. Most hooks
 * are also driven by a suite, which would catch the error, but not every file in
 * hooks/ is wired, and the suite that drives a hook can be skipped by platform.
 * This closes the gap by running the same command over the same population.
 *
 * POPULATION. plugins/<name>/hooks/*.js, printed on every run. Zero files is exit
 * 2, never a pass: a parse check over nothing has checked nothing.
 *
 *   node tooling/check-hook-parse.js               # this repo
 *   node tooling/check-hook-parse.js --root <dir>  # another tree of the same shape
 *
 * Exit 0 every file parses, 1 at least one does not, 2 no verdict (no files, or
 * node itself could not be run).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tooling/check-hook-parse.js [--root <dir>]');
    console.log('Runs `node --check` over plugins/*/hooks/*.js, the same loop CI runs.');
    console.log('Exit 0 all parse, 1 a file does not, 2 no verdict (no files, or node could not run).');
    process.exitCode = 0;
    return;
}
const rootAt = argv.indexOf('--root');
if (rootAt !== -1 && (argv[rootAt + 1] === undefined || argv[rootAt + 1].startsWith('--'))) {
    console.error('--root needs a directory');
    process.exitCode = 2;
    return;
}
const ROOT = rootAt !== -1 ? path.resolve(argv[rootAt + 1]) : path.resolve(__dirname, '..');

function hookFiles() {
    const out = [];
    const plugins = path.join(ROOT, 'plugins');
    if (!fs.existsSync(plugins)) return out;
    for (const plugin of fs.readdirSync(plugins).sort()) {
        const hooks = path.join(plugins, plugin, 'hooks');
        if (!fs.existsSync(hooks) || !fs.statSync(hooks).isDirectory()) continue;
        for (const f of fs.readdirSync(hooks).sort()) {
            if (f.endsWith('.js')) out.push(path.join(hooks, f));
        }
    }
    return out;
}

const files = hookFiles();
if (!files.length) {
    console.error(`[hook-parse] NO VERDICT: 0 hook files under ${path.join(ROOT, 'plugins')}/*/hooks/*.js`);
    process.exitCode = 2;
    return;
}

const broken = [];
const unrun = [];
for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (r.error || r.signal || r.status === null) {
        unrun.push(rel + ' (' + (r.error ? (r.error.code || r.error.message) : (r.signal || 'no status')) + ')');
    } else if (r.status !== 0) {
        // node prints the file, the line, a caret and the error. The first
        // lines carry all of it; the stack below is node's own internals.
        const why = String(r.stderr || '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, 4).join(' | ');
        broken.push(rel + ': ' + why);
    }
}

console.log(`[hook-parse] ${files.length} hook file(s) under plugins/*/hooks/*.js, `
    + `${files.length - broken.length - unrun.length} parse, ${broken.length} do not, ${unrun.length} not checked`);
for (const b of broken) console.log('  [FAIL] ' + b);
for (const u of unrun) console.log('  [NOT CHECKED] ' + u);
process.exitCode = broken.length ? 1 : (unrun.length ? 2 : 0);
