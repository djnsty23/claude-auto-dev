#!/usr/bin/env node
// Tests for autodev-core's SessionStart hook: hooks/agent-browser-cleanup.js.
//
// 231 lines, wired at SessionStart, and it had no tests. Found by
// tooling/find-untested-hooks.js.
//
// Most of it shells out to taskkill/wmic/PowerShell and is Windows-only, which
// is not reachable from here. But one part is neither: disableAutostartPreferences
// WRITES to JSON files under the user's Temp and home directories. That is the
// piece worth pinning down, because its failure mode is not "the hook did not
// help" — it is "the hook rewrote a file it should never have touched".
//
// So the assertions below are mostly about RESTRAINT and about not corrupting
// anything: which directories it will consider, what it leaves alone, and what
// happens to a malformed file it cannot parse.
//
// Run: node tooling/test-agent-browser-cleanup.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'agent-browser-cleanup.js');
const mod = require(HOOK);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abc-test-')));
const cases = [];
const check = (label, ok) => cases.push([label, ok]);

// The function reads LOCALAPPDATA and os.homedir() at CALL time, so a fixture
// can be pointed at without reloading the module.
let n = 0;
function sandbox() {
    const home = path.join(TMP, 'home' + ++n);
    const localAppData = path.join(home, 'AppData', 'Local');
    fs.mkdirSync(path.join(localAppData, 'Temp'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agent-browser'), { recursive: true });
    return { home, tempRoot: path.join(localAppData, 'Temp'), dotRoot: path.join(home, '.agent-browser'), localAppData };
}

function profile(root, dirName, prefs) {
    const p = path.join(root, dirName, 'Default');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, 'Preferences');
    fs.writeFileSync(file, typeof prefs === 'string' ? prefs : JSON.stringify(prefs));
    return file;
}

function withSandbox(sb, fn) {
    const prevHome = process.env.HOME, prevLad = process.env.LOCALAPPDATA, prevUp = process.env.USERPROFILE;
    process.env.HOME = sb.home;
    process.env.USERPROFILE = sb.home;
    process.env.LOCALAPPDATA = sb.localAppData;
    try { fn(); } finally {
        process.env.HOME = prevHome;
        process.env.LOCALAPPDATA = prevLad;
        process.env.USERPROFILE = prevUp;
    }
}

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ------------------------------------------------------------- what it patches

{
    const sb = sandbox();
    const file = profile(sb.tempRoot, 'agent-browser-chrome-abc123', {
        browser: { auto_launch_chrome_on_startup: true, other_setting: 'keep me' },
        background_mode: { enabled: true },
        unrelated: { deeply: { nested: 1 } },
    });
    withSandbox(sb, () => mod.disableAutostartPreferences());
    const after = read(file);

    check('disables autostart in an agent-browser profile',
        after.browser.auto_launch_chrome_on_startup === false);
    check('disables background mode', after.background_mode.enabled === false);
    // It rewrites the whole file, so everything it did not come for must survive.
    check('  preserves unrelated keys in the same object', after.browser.other_setting === 'keep me');
    check('  preserves unrelated top-level keys', after.unrelated.deeply.nested === 1);
}

// The .agent-browser root has no name filter — every directory under it counts.
{
    const sb = sandbox();
    const file = profile(sb.dotRoot, 'session-xyz', { browser: {}, background_mode: {} });
    withSandbox(sb, () => mod.disableAutostartPreferences());
    check('patches profiles under ~/.agent-browser regardless of name',
        read(file).browser.auto_launch_chrome_on_startup === false);
}

// -------------------------------------------------------------- what it spares

// The Temp directory is shared with everything else on the machine. Only
// directories named agent-browser-chrome-* are ours, and the prefix check is the
// only thing standing between this hook and every other app's Preferences file.
{
    const sb = sandbox();
    const mine = profile(sb.tempRoot, 'agent-browser-chrome-x', { browser: {}, background_mode: {} });
    const theirs = profile(sb.tempRoot, 'some-other-app', { browser: { auto_launch_chrome_on_startup: true } });
    const before = fs.readFileSync(theirs, 'utf8');

    withSandbox(sb, () => mod.disableAutostartPreferences());

    check('patches our own Temp profile', read(mine).browser.auto_launch_chrome_on_startup === false);
    check("  and does NOT touch another app's Temp profile",
        fs.readFileSync(theirs, 'utf8') === before);
}

// A file it cannot parse must be left exactly as it was, not truncated or
// half-written. This is a user's browser profile.
{
    const sb = sandbox();
    const broken = profile(sb.tempRoot, 'agent-browser-chrome-broken', '{ not valid json');
    const before = fs.readFileSync(broken, 'utf8');
    let threw = false;
    withSandbox(sb, () => { try { mod.disableAutostartPreferences(); } catch { threw = true; } });

    check('a malformed Preferences file does not throw', !threw);
    check('  and is left byte-for-byte unchanged', fs.readFileSync(broken, 'utf8') === before);
}

// Already-correct preferences must not be rewritten. The `dirty` flag exists so
// a SessionStart hook does not touch the mtime of every profile on every start.
{
    const sb = sandbox();
    const file = profile(sb.tempRoot, 'agent-browser-chrome-clean', {
        browser: { auto_launch_chrome_on_startup: false },
        background_mode: { enabled: false },
    });
    const before = fs.statSync(file).mtimeMs;
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(file, oldTime, oldTime);
    const stamped = fs.statSync(file).mtimeMs;

    withSandbox(sb, () => mod.disableAutostartPreferences());
    check('an already-correct profile is not rewritten',
        fs.statSync(file).mtimeMs === stamped && stamped !== before);
}

// Missing roots are the normal case on a machine that has never run
// agent-browser. It must not create them, and must not throw.
{
    const home = path.join(TMP, 'empty-home');
    fs.mkdirSync(home, { recursive: true });
    const sb = { home, localAppData: path.join(home, 'AppData', 'Local') };
    let threw = false;
    withSandbox(sb, () => { try { mod.disableAutostartPreferences(); } catch { threw = true; } });
    check('missing profile roots: does not throw', !threw);
    check('  and does not create them', !fs.existsSync(path.join(home, '.agent-browser')));
}

// LOCALAPPDATA is a Windows variable and is simply absent elsewhere, so the
// `|| path.join(os.homedir(), 'AppData', 'Local')` fallback is the path actually
// taken on any machine that does not set it. Every case above sets the variable,
// so the fallback was never exercised.
{
    const home = path.join(TMP, 'fallback-home');
    const tempRoot = path.join(home, 'AppData', 'Local', 'Temp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const file = profile(tempRoot, 'agent-browser-chrome-fb', { browser: {}, background_mode: {} });

    const prevHome = process.env.HOME, prevLad = process.env.LOCALAPPDATA, prevUp = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.LOCALAPPDATA;
    try { mod.disableAutostartPreferences(); } finally {
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevUp;
        if (prevLad === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = prevLad;
    }

    check('with LOCALAPPDATA unset, falls back to ~/AppData/Local',
        read(file).browser.auto_launch_chrome_on_startup === false);
}

// ------------------------------------------------- deliberately not covered
//
// The remaining survivors on this file are all `isWin` platform gates plus the
// `require.main === module` entrypoint guard. On a non-Windows machine the
// Windows branches are unreachable, and forcing them on would have this hook
// shell out to taskkill and PowerShell from a test run. pre-tool-filter.js
// solved the same problem with an injectable platform, but that file only
// consults denylists; this one KILLS PROCESSES, and an env var that makes a
// macOS session take the Windows path is a worse thing to own than the gap.
// Recorded rather than forced.

// ------------------------------------------------------------------ entrypoint

// SessionStart must never be blocked, and the hook must stay silent on the happy
// path — it runs at the start of every session.
{
    const sb = sandbox();
    const r = spawnSync(process.execPath, [HOOK], {
        encoding: 'utf8',
        env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, LOCALAPPDATA: sb.localAppData },
    });
    check('run as a hook: exits 0', r.status === 0);
    check('  and says nothing on stdout', (r.stdout || '') === '');
}

// The Windows-only paths must be inert elsewhere, or a macOS session start would
// shell out to taskkill on every launch.
if (process.platform !== 'win32') {
    let threw = false;
    try { mod.restoreSnippingToolHotkey(); } catch { threw = true; }
    check('restoreSnippingToolHotkey is a no-op off Windows', !threw);
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
