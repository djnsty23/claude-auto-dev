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
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '';

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
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

module.exports = { sessionStore, codeDir, HOME };
