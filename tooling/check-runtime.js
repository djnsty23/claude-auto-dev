#!/usr/bin/env node
// check-runtime.js — does the version that EXECUTES match the version you edited?
//
// Three copies of this plugin exist and only one of them runs:
//
//   1. source repo      ~/claude-auto-dev                     where you edit
//   2. marketplace clone ~/.claude/plugins/marketplaces/autodev  a git mirror
//   3. runtime cache    ~/.claude/plugins/cache/autodev/...    WHAT ACTUALLY RUNS
//
// The cache is keyed by version, and the key is created by the app when it loads
// the plugin. So a bump plus a push plus a `git pull` in the clone still leaves the
// old version executing until the app restarts. On 2026-08-17 that gap reached SEVEN
// releases: the clone had drifted to 8.73.0 while source was at 8.79.0, and every
// detector rule and hook fix shipped in between had never once run.
//
// It cost real time twice in one session — a fix was "verified" against a source
// tree the runtime had never seen, and 18 blocked `node -e` calls were nearly blamed
// on the plugin when they came from a flat install the runtime had also never
// dropped. Hence a script instead of a habit.
//
// Version strings are checked first, then CONTENT markers, because a matching
// version number only proves a manifest was copied — not that the tree beneath it is
// the one you think. Run: node tooling/check-runtime.js   (or npm run check:runtime)

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SRC = path.resolve(__dirname, '..');
const CLONE = path.join(HOME, '.claude', 'plugins', 'marketplaces', 'autodev');
const CACHE = path.join(HOME, '.claude', 'plugins', 'cache', 'autodev');

const PLUGINS = ['autodev-core', 'autodev-memory', 'autodev-stack'];

let fail = 0;
const log = (tag, msg) => {
    console.log(`[${tag}] ${msg}`);
    if (tag === 'FAIL') fail++;
};

function version(root, plugin) {
    const f = path.join(root, 'plugins', plugin, '.claude-plugin', 'plugin.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).version; } catch { return null; }
}

// Semver-ish compare so "8.9.0" does not sort above "8.73.0" as a string would.
const cmp = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
};

console.log('Runtime check — which version actually executes?\n');

const srcV = version(SRC, 'autodev-core');
const cloneV = version(CLONE, 'autodev-core');
if (!srcV) { log('FAIL', 'cannot read the source version — is this the repo?'); process.exit(2); }

console.log(`  source repo      ${srcV}`);
console.log(`  marketplace clone ${cloneV || '(absent)'}`);

// The cache holds one directory per version ever loaded. The highest is what a new
// session picks up; the others are inert leftovers.
let keys = [];
try {
    keys = fs.readdirSync(path.join(CACHE, 'autodev-core'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
        .map((d) => d.name)
        .sort(cmp);
} catch { /* stays empty */ }

console.log(`  runtime cache     ${keys.length ? keys.join(', ') : '(none)'}`);
const top = keys.length ? keys[keys.length - 1] : null;
console.log(`\npopulation: ${PLUGINS.length} plugin(s), ${keys.length} cached version(s), highest = ${top || 'none'}\n`);

if (!cloneV) {
    log('WARN', 'no marketplace clone — the plugin may be installed from elsewhere');
} else if (cloneV !== srcV) {
    log('FAIL', `clone is at ${cloneV}, source at ${srcV} — run: claude plugin marketplace update autodev`);
} else {
    log('PASS', `clone matches source (${srcV})`);
}

if (!top) {
    log('WARN', 'nothing cached yet — the plugin has not been loaded on this machine');
} else if (cmp(top, srcV) < 0) {
    // "Restart the app" was this script's original advice and it is WRONG — that
    // is what the first version said, and a real restart on 2026-08-17 changed
    // nothing. installed_plugins.json pins each plugin to a VERSION and a
    // gitCommitSha, and only `claude plugin update` rewrites that pin. Restart
    // applies a pin that already moved; on its own it re-loads the same one, so
    // the gap survives any number of restarts. Pulling the clone by hand does not
    // help either: it changes the files the pin does not point at.
    log('FAIL', `runtime is ${top} but source is ${srcV} — ${countReleases(top, srcV)} release(s) have never executed.`);
    console.log('         Fix, in this order (a restart alone will NOT work):');
    console.log('           claude plugin marketplace update autodev');
    for (const p of PLUGINS) console.log(`           claude plugin update ${p}@autodev`);
    console.log('           then restart, and re-run this check');
} else {
    log('PASS', `runtime cache carries ${top}`);
}

function countReleases(from, to) {
    const a = from.split('.').map(Number), b = to.split('.').map(Number);
    if (a[0] !== b[0]) return 'several major';
    return Math.max(1, b[1] - a[1]);
}

// ---- content markers -------------------------------------------------------
//
// A version string only proves a manifest was copied. These assert that the tree
// under the cache key is really the tree you shipped. Each marker names the release
// that introduced it, so a failure says WHICH change did not land.
const MARKERS = [
    {
        since: '8.80.0',
        what: 'agent-browser cleanup hook restored and wired',
        check: (root) => {
            const hook = path.join(root, 'hooks', 'agent-browser-cleanup.js');
            const hooks = path.join(root, 'hooks', 'hooks.json');
            if (!fs.existsSync(hook)) return false;
            try { return fs.readFileSync(hooks, 'utf8').includes('agent-browser-cleanup.js'); }
            catch { return false; }
        },
    },
    {
        since: '8.79.0',
        what: 'browser skill removed (migrated to the built-in tools)',
        check: (root) => !fs.existsSync(path.join(root, 'skills', 'browser')),
    },
    {
        since: '8.74.0',
        what: 'rule-options-protocol skill present',
        check: (root) => fs.existsSync(path.join(root, 'skills', 'rule-options-protocol')),
    },
];

if (top) {
    console.log('\ncontent markers in the cached tree:');
    const root = path.join(CACHE, 'autodev-core', top);
    for (const m of MARKERS) {
        const ok = m.check(root);
        const applies = cmp(top, m.since) >= 0;
        if (!applies) {
            console.log(`  [skip] ${m.what} — needs ${m.since}, cache has ${top}`);
            continue;
        }
        log(ok ? 'PASS' : 'FAIL', `${m.what} (since ${m.since})`);
    }
}

console.log(`\n${fail === 0 ? 'Runtime is current.' : fail + ' problem(s) — the code you edited is not the code that runs.'}`);
process.exit(fail > 0 ? 1 : 0);
