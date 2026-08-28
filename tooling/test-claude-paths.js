#!/usr/bin/env node
'use strict';
// Tests for plugins/autodev-core/scripts/claude-paths.js — the one resolver three
// fleet scripts now share.
//
// It reads HOME at require time, so every case runs in a SUBPROCESS with HOME
// faked. Requiring it in-process would pin the developer's real home and make
// every assertion below a statement about this machine rather than about the code.
//
// Run: node tooling/test-claude-paths.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'claude-paths.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-paths-'));

let passed = 0;
const failures = [];
function check(name, actual, expected) {
    const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
    if (ok) { passed++; return; }
    failures.push(name + '\n      expected: ' + (typeof expected === 'function' ? expected.toString() : JSON.stringify(expected))
        + '\n      actual:   ' + JSON.stringify(actual));
}

let homeCount = 0;
function makeHome() {
    const h = path.join(ROOT, 'home-' + (homeCount++));
    fs.mkdirSync(h, { recursive: true });
    return h;
}
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };

// Ask the module, in a child, with a controlled environment.
function ask(fnName, env) {
    const code = 'const m=require(' + JSON.stringify(SUBJECT) + ');'
        + 'process.stdout.write(JSON.stringify(m.' + fnName + '()));';
    const r = spawnSync(process.execPath, ['-e', code], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, env),
    });
    if (r.status !== 0) return { __error: (r.stderr || '').slice(0, 300) };
    try { return JSON.parse(r.stdout); } catch { return { __unparsed: r.stdout }; }
}

// A child env that starts from a clean slate. Leaving the developer's own
// AUTODEV_CODE_DIR or XDG_CONFIG_HOME in place would let the real machine
// answer a question this suite is asking about a fixture.
function env(home, extra) {
    return Object.assign({
        HOME: home, USERPROFILE: home,
        AUTODEV_CODE_DIR: '', CLAUDE_SESSION_STORE: '', XDG_CONFIG_HOME: '',
    }, extra || {});
}

// ---------------------------------------------------------------- codeDir()

{
    const home = makeHome();
    const dir = mk(home, 'Code');
    check('codeDir: finds ~/Code', ask('codeDir', env(home)), dir);
}

{
    // ~/Projects has no case twin. macOS is usually case-INSENSITIVE, so ~/Code
    // and ~/code are ONE directory there and a test using only those cannot tell
    // whether either candidate is really consulted — a mutation dropping ~/Code
    // survived for exactly that reason. Same family as the /var vs /private/var
    // trap this repo already tracks.
    const home = makeHome();
    const dir = mk(home, 'Projects');
    check('codeDir: finds ~/Projects (no case twin)', ask('codeDir', env(home)), dir);
}

{
    const home = makeHome();
    mk(home, 'Downloads', 'code');
    check('codeDir: still finds the legacy ~/Downloads/code', ask('codeDir', env(home)),
        path.join(home, 'Downloads', 'code'));
}

{
    const home = makeHome();
    const decoy = mk(home, 'Code');
    const real = mk(ROOT, 'override-target');
    check('codeDir: AUTODEV_CODE_DIR wins over a present ~/Code',
        ask('codeDir', env(home, { AUTODEV_CODE_DIR: real })), real);
    check('codeDir: and the decoy is not what came back',
        ask('codeDir', env(home, { AUTODEV_CODE_DIR: real })), (v) => v !== decoy);
}

{
    // The override is VALIDATED. Returning it unchecked reintroduces the original
    // bug with the bad path supplied by a human instead of a hardcoded default:
    // auto-brain-survey.js then surveyed nothing and printed "0 repos".
    const home = makeHome();
    mk(home, 'Code');
    check('codeDir: a non-existent AUTODEV_CODE_DIR is null, not echoed back',
        ask('codeDir', env(home, { AUTODEV_CODE_DIR: path.join(ROOT, 'no-such-dir') })), null);
}

{
    const home = makeHome(); // nothing inside it at all
    check('codeDir: null when no candidate exists', ask('codeDir', env(home)), null);
}

// ------------------------------------------------------------ sessionStore()

{
    const home = makeHome();
    const store = mk(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
    const got = ask('sessionStore', env(home));
    if (process.platform === 'darwin') {
        check('sessionStore: finds the macOS Application Support store', got, store);
        check('sessionStore: does NOT resolve to ~/.config on macOS', got,
            (v) => !String(v).includes(path.join(home, '.config')));
    } else {
        // Not darwin: the macOS location is still tried as a fallback, because a
        // store found somewhere unexpected beats reporting an empty fleet.
        check('sessionStore: macOS location works as a fallback off-darwin', got, store);
    }
}

{
    // PRIORITY, not merely presence. Both stores exist here. The macOS location is
    // also listed as a universal fallback, so a test with only ONE store present
    // still passes after the darwin branch is deleted — that mutant survived until
    // this case existed. With both on disk, only the ordering can decide.
    const home = makeHome();
    const mac = mk(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
    const xdg = mk(home, '.config', 'Claude', 'claude-code-sessions');
    const got = ask('sessionStore', env(home));
    if (process.platform === 'darwin') {
        check('sessionStore: on darwin, Application Support beats ~/.config', got, mac);
    } else {
        check('sessionStore: off darwin, ~/.config beats the mac fallback', got, xdg);
    }
}

{
    const home = makeHome();
    const store = mk(home, '.config', 'Claude', 'claude-code-sessions');
    check('sessionStore: finds the XDG store', ask('sessionStore', env(home)), store);
}

{
    const home = makeHome();
    const real = mk(ROOT, 'store-override');
    check('sessionStore: CLAUDE_SESSION_STORE wins',
        ask('sessionStore', env(home, { CLAUDE_SESSION_STORE: real })), real);
    check('sessionStore: a non-existent override is null, not echoed back',
        ask('sessionStore', env(home, { CLAUDE_SESSION_STORE: path.join(ROOT, 'nope') })), null);
}

{
    // THE ASSERTION THE WHOLE MODULE EXISTS FOR. Returning a plausible path that
    // is not there is what let session-sweep print "POPULATION: 0 session records"
    // and fleet-status render every session "(not addressable)". Null forces the
    // caller to say COULD NOT READ instead.
    const home = makeHome();
    check('sessionStore: null when no store exists anywhere', ask('sessionStore', env(home)), null);
}

// -------------------------------------------------------------------- report

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error('claude-paths: ' + passed + '/' + total + ' passed, ' + failures.length + ' FAILED\n');
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log('claude-paths: ' + passed + '/' + total + ' passed — both resolvers, their overrides, and the null cases');
