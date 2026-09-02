#!/usr/bin/env node
// check-runtime.js — does the version that EXECUTES match the version you edited?
//
// Three copies of this plugin exist and only one of them runs:
//
//   1. source repo      ~/claude-auto-dev                     where you edit
//   2. marketplace clone ~/.claude/plugins/marketplaces/autodev  a git mirror
//   3. the ACTIVE pin   ~/.claude/plugins/installed_plugins.json  WHAT ACTUALLY RUNS
//
// installed_plugins.json pins each plugin to a version, a gitCommitSha and an
// installPath, and only `claude plugin update` rewrites that pin. On 2026-08-17
// the gap reached SEVEN releases and a fix was "verified" against a source tree
// the runtime had never seen. Hence a script instead of a habit.
//
// THE AUDIT CORRECTION (codex adversarial audit 2026-08-30, F4). The first
// version of this script sorted the cache directories and called the HIGHEST
// one the runtime — while its own comment said the manifest pins the executable
// version. An inert newer cache directory therefore hid an older active pin,
// and the check printed "population: 3 plugin(s)" from a constant while
// inspecting only autodev-core. Both are exactly the false-verdict class this
// repo's gates exist to reject. The manifest is the authority now, all three
// plugins are actually validated, and the cache listing is informational only.
// Acceptance test: tooling/test-runtime-authority.js.
//
// Version strings are checked first, then CONTENT markers, because a matching
// version number only proves a manifest was copied — not that the tree beneath
// it is the one you think. Run: node tooling/check-runtime.js  (npm run check:runtime)

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SRC = path.resolve(__dirname, '..');
const CLONE = path.join(HOME, '.claude', 'plugins', 'marketplaces', 'autodev');
const CACHE = path.join(HOME, '.claude', 'plugins', 'cache', 'autodev');
const MANIFEST = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');

const PLUGINS = ['autodev-core', 'autodev-memory', 'autodev-stack'];

// --pre-release: the source is SUPPOSED to be ahead of the install before a
// push, so gate:release chaining this check could never pass. That is worse
// than no check: a gate that always fails at the one moment you must run it
// teaches people to skip it. With the flag, an install merely BEHIND the source
// is INFO. Every other mismatch, including an install AHEAD of the source or a
// sha that disagrees, still FAILs, because those mean the code you edited is
// not the code that runs and no push fixes them.
const PRE = process.argv.includes('--pre-release');

const cmpV = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
};

let fail = 0;
let deferred = 0;
const log = (tag, msg) => {
    console.log('[' + tag + '] ' + msg);
    if (tag === 'FAIL') fail++;
    if (tag === 'INFO') deferred++;
};

function version(root, plugin) {
    const f = path.join(root, 'plugins', plugin, '.claude-plugin', 'plugin.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).version; } catch { return null; }
}

function installedVersion(installPath) {
    const f = path.join(installPath, '.claude-plugin', 'plugin.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).version; } catch { return null; }
}

// The clone's HEAD, resolved through the filesystem so this stays dependency-
// free. Unresolvable is returned as null and treated as unknown, never as a
// silent match.
function cloneHead() {
    try {
        const head = fs.readFileSync(path.join(CLONE, '.git', 'HEAD'), 'utf8').trim();
        if (!head.startsWith('ref: ')) return head;
        const ref = head.slice(5).trim();
        try {
            return fs.readFileSync(path.join(CLONE, '.git', ref), 'utf8').trim();
        } catch {
            const packed = fs.readFileSync(path.join(CLONE, '.git', 'packed-refs'), 'utf8');
            for (const line of packed.split('\n')) {
                if (line.endsWith(' ' + ref)) return line.split(' ')[0];
            }
            return null;
        }
    } catch { return null; }
}

console.log('Runtime check — which version actually executes?\n');

const srcCore = version(SRC, 'autodev-core');
if (!srcCore) { log('FAIL', 'cannot read the source version — is this the repo?'); process.exit(2); }

// ---- the manifest is the authority ----------------------------------------

let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { /* reported below */ }

let cacheKeys = [];
try {
    cacheKeys = fs.readdirSync(path.join(CACHE, 'autodev-core'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
        .map((d) => d.name);
} catch { /* stays empty */ }

const pins = {};
if (manifest && manifest.plugins) {
    for (const p of PLUGINS) {
        const entries = manifest.plugins[p + '@autodev'];
        if (Array.isArray(entries) && entries.length) pins[p] = entries[0];
    }
}

console.log('  source repo       ' + srcCore + ' (autodev-core)');
console.log('  marketplace clone ' + (version(CLONE, 'autodev-core') || '(absent)'));
console.log('  active pins       ' + PLUGINS.map((p) => pins[p] ? p + '@' + pins[p].version : p + '@(unpinned)').join('  '));
console.log('  core cache dirs   ' + (cacheKeys.length ? cacheKeys.join(', ') : '(none)')
    + '  (informational — an inert directory is not the runtime)');
console.log('\npopulation: ' + PLUGINS.length + ' plugin(s) declared, '
    + Object.keys(pins).length + ' pinned in the manifest, '
    + cacheKeys.length + ' core cache version(s)\n');

if (!manifest) {
    log('FAIL', 'no readable manifest at ' + MANIFEST
        + ' — the active install cannot be established, which is a failure, not a pass');
}

const head = cloneHead();

for (const p of PLUGINS) {
    const srcV = version(SRC, p);
    const cloneV = version(CLONE, p);
    const pin = pins[p];

    if (!cloneV) log('WARN', p + ': no marketplace clone copy — installed from elsewhere?');
    else if (srcV && cloneV !== srcV) {
        const behind = PRE && cmpV(cloneV, srcV) < 0;
        log(behind ? 'INFO' : 'FAIL', p + ': clone is at ' + cloneV + ', source at ' + srcV
            + (behind
                ? ', expected before publishing; the clone advances on push plus marketplace update'
                : ' — run: claude plugin marketplace update autodev'));
    }

    if (!pin) {
        if (manifest) {
            log('FAIL', p + ': declared by this repo but absent from the manifest — the plugin'
                + ' is not installed, which the old cache-scan reported as clean');
        }
        continue;
    }
    if (srcV && pin.version !== srcV && PRE && cmpV(pin.version, srcV) < 0) {
        log('INFO', p + ': active pin is ' + pin.version + ', source is ' + srcV
            + ', expected before publishing; run check:runtime with no flag after'
            + ' the push and the plugin update');
        continue;
    }
    if (srcV && pin.version !== srcV) {
        // "Restart the app" was this script's original advice and it is WRONG —
        // only `claude plugin update` rewrites the pin; a restart re-loads the
        // same one, so the gap survives any number of restarts.
        log('FAIL', p + ': active pin is ' + pin.version + ', source is ' + srcV
            + ' — a newer cache directory does not change what runs.'
            + ' Fix: claude plugin marketplace update autodev; claude plugin update '
            + p + '@autodev; then restart');
        continue;
    }
    const iv = installedVersion(pin.installPath || '');
    if (iv === null) {
        log('FAIL', p + ': pinned installPath is missing or unreadable (' + pin.installPath
            + ') — the pin points at nothing');
        continue;
    }
    if (iv !== pin.version) {
        log('FAIL', p + ': pinned tree says ' + iv + ' but the pin says ' + pin.version
            + ' — the manifest and the tree disagree');
        continue;
    }
    if (head && pin.gitCommitSha && pin.gitCommitSha !== head) {
        // Two trees, one version number: the 8.98.0 incident. A version match
        // with a sha mismatch means the clone moved under an unchanged pin.
        log('FAIL', p + ': pin sha ' + String(pin.gitCommitSha).slice(0, 9)
            + ' != clone HEAD ' + head.slice(0, 9)
            + ' at the same version — run: claude plugin update ' + p + '@autodev');
        continue;
    }
    log('PASS', p + ': pin ' + pin.version + ' matches source, tree, and clone sha');
}

// ---- content markers -------------------------------------------------------
//
// A version string only proves a manifest was copied. These assert that the
// ACTIVE PINNED tree — not the newest cache directory — is really the tree you
// shipped. Each marker names the release that introduced it.
const cmp = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
};

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

const corePin = pins['autodev-core'];
if (corePin && corePin.installPath && installedVersion(corePin.installPath) !== null) {
    console.log('\ncontent markers in the ACTIVE pinned tree:');
    for (const m of MARKERS) {
        if (cmp(corePin.version, m.since) < 0) {
            console.log('  [skip] ' + m.what + ' — needs ' + m.since + ', pin is ' + corePin.version);
            continue;
        }
        log(m.check(corePin.installPath) ? 'PASS' : 'FAIL', m.what + ' (since ' + m.since + ')');
    }
}

// Never print "current" over a DEFERRED check. A reassuring label on a skip
// converts an absent check into a reported pass, which is worse than having no
// opinion: it closes the question rather than opening one. Introduced and
// caught in the same session, 2026-09-02, by reading the run rather than the
// exit code.
console.log('\n' + (fail > 0
    ? fail + ' problem(s), the code you edited is not the code that runs.'
    : deferred > 0
        ? deferred + ' check(s) DEFERRED: the install is behind the source, which is'
            + ' expected before a push. Nothing else is wrong. Run verify:release'
            + ' after publishing and updating the plugins.'
        : 'Runtime is current.'));
process.exit(fail > 0 ? 1 : 0);
