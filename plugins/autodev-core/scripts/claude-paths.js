'use strict';
/**
 * Where the Claude app and the operator's checkouts live, resolved once.
 *
 * WHY THIS EXISTS. Three scripts each hardcoded one machine's layout, and every
 * one of them turned a wrong path into a confident zero rather than an error:
 *
 *   session-sweep.js   `~/.config/Claude/...` -> "POPULATION: 0 session records"
 *                      and "BLOCKED: 0 (none - every finished own-repo session is
 *                      committed and pushed)". 22 records existed.
 *   brain-panels.js    `~/Downloads/code` -> "panels DENIED in 0 location(s)"
 *                      while five live sessions kept their panels.
 *   fleet-status.js    `~/.config/Claude/...` -> loadSessionIndex() returned an
 *                      empty Map, so EVERY session rendered "(not addressable)"
 *                      and the boot reported "0 addressable". Those sessions were
 *                      addressable the whole time; three were messaged that day.
 *
 * All three were the same mistake written three times, so it is written once here
 * and the callers ask. `[measured 2026-08-28]`
 *
 * Both resolvers return null rather than a plausible path that does not exist.
 * A caller that receives null must say COULD NOT READ - never render it as a zero.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '';

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/*
 * THE ACTIVE PROFILE. Claude Code keeps one profile per config dir: the
 * default `~/.claude`, or whatever CLAUDE_CONFIG_DIR names. A second profile
 * (a work account next to a personal one) is a second config dir under the
 * same home. Every hook and script that means "this profile's state" asks
 * configDir(); none joins `<home>/.claude` itself, because a hand-joined path
 * is the personal profile's state whichever profile is running. That is how a
 * work-profile session came to read the personal brain-role.json and write
 * the personal nudge ledgers.
 *
 * autodev-memory cannot require this file (CLAUDE_PLUGIN_ROOT resolves per
 * plugin), so it ships a copy at plugins/autodev-memory/scripts/config-dir.js.
 * tooling/test-config-dir-isolation.js holds the two to the same answers.
 *
 * Read at CALL time, not require time, so a suite can move the env between
 * calls, and every function takes an optional env for callers that inject
 * one. The home order is this module's HOME convention, then os.homedir():
 * on a real machine all three agree, and in a suite either variable works.
 */
function homeDir(env = process.env) {
    return env.USERPROFILE || env.HOME || os.homedir();
}

/** CLAUDE_CONFIG_DIR when set and non-empty, else `<home>/.claude`. */
function configDir(env = process.env) {
    const v = env.CLAUDE_CONFIG_DIR;
    return v ? v : path.join(homeDir(env), '.claude');
}

/** True when the active profile is the default one: CLAUDE_CONFIG_DIR unset,
 *  empty, or naming `<home>/.claude` itself. */
function isDefaultConfigDir(env = process.env) {
    const v = env.CLAUDE_CONFIG_DIR;
    if (!v) return true;
    const a = path.resolve(v);
    const b = path.resolve(homeDir(env), '.claude');
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The fleet's shared memory checkout, `~/claude-memory` by default. It sits
 * OUTSIDE the config dir, so configDir() alone would leave it shared by every
 * profile. Under a non-default profile it moves to `<configDir>/claude-memory`,
 * which does not exist until that profile opts in, so every reader that treats
 * absence as "no fleet" goes quiet instead of reading the personal one. Each
 * caller's own env override (AUTODEV_FLEET_INTENT_DIR, AUTODEV_AWAY_FILE, ...)
 * still wins: that is how two profiles share a fleet on purpose.
 */
function fleetMemoryDir(env = process.env) {
    return isDefaultConfigDir(env)
        ? path.join(homeDir(env), 'claude-memory')
        : path.join(configDir(env), 'claude-memory');
}

/**
 * The per-user application-data directory holding `Claude/claude-code-sessions`.
 * `~/.config` is correct on Linux ONLY; macOS uses ~/Library/Application Support
 * and Windows uses APPDATA. Returns the full store path, or null when the
 * platform's directory is not there.
 *
 * CLAUDE_SESSION_STORE overrides everything, and is the seam suites drive.
 */
function sessionStore() {
    // An override is validated like everything else. Returning an unchecked path
    // reintroduces exactly the bug this module exists for, just with the wrong
    // path supplied by a human instead of by a hardcoded default.
    if (process.env.CLAUDE_SESSION_STORE) {
        return isDir(process.env.CLAUDE_SESSION_STORE) ? process.env.CLAUDE_SESSION_STORE : null;
    }
    const bases = [];
    if (process.platform === 'win32' && process.env.APPDATA) bases.push(process.env.APPDATA);
    if (process.platform === 'darwin') bases.push(path.join(HOME, 'Library', 'Application Support'));
    // APPDATA is consulted on EVERY platform, not just win32. It is normally unset
    // off Windows, but the fleet suites use it as their store seam and the code it
    // replaced read `APPDATA || ~/.config` unconditionally — narrowing it to win32
    // silently emptied the store under four suites at once. It sits after the
    // platform-native location so a real macOS store still wins on macOS.
    if (process.env.APPDATA) bases.push(process.env.APPDATA);
    bases.push(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'));
    // Every platform's directory is tried last, because a store that exists
    // somewhere unexpected still beats reporting an empty fleet.
    bases.push(path.join(HOME, 'Library', 'Application Support'), path.join(HOME, '.config'));
    for (const b of bases) {
        if (!b) continue;
        const p = path.join(b, 'Claude', 'claude-code-sessions');
        if (isDir(p)) return p;
    }
    return null;
}

/**
 * The directory holding the operator's checkouts. AUTODEV_CODE_DIR overrides;
 * otherwise the first candidate that exists wins. Returns null when none does.
 *
 * Note for anyone extending the list: on macOS the filesystem is usually
 * case-INSENSITIVE, so `~/Code` and `~/code` are one directory. A test that
 * relies on only those two cannot tell whether either entry is actually used.
 */
function codeDir() {
    // Validated, for the same reason as sessionStore(): an override pointing at a
    // directory that is not there must be null, so the caller refuses rather than
    // surveying nothing and printing "0 repos".
    if (process.env.AUTODEV_CODE_DIR) {
        return isDir(process.env.AUTODEV_CODE_DIR) ? process.env.AUTODEV_CODE_DIR : null;
    }
    for (const c of [
        path.join(HOME, 'Code'),
        path.join(HOME, 'code'),
        path.join(HOME, 'Downloads', 'code'),
        path.join(HOME, 'Projects'),
        path.join(HOME, 'src'),
    ]) {
        if (isDir(c)) return c;
    }
    return null;
}

module.exports = { sessionStore, codeDir, HOME, homeDir, configDir, isDefaultConfigDir, fleetMemoryDir };
