#!/usr/bin/env node
// The auto-mode flags, keyed on the session that set them.
//
// `auto` writes `.claude/auto-active` with the Write tool, and the Stop hook
// blocks while it exists. That file was keyed on the DIRECTORY, so two sessions
// in one checkout shared it: a session that never ran `auto` was held at every
// Stop by a peer's sprint, and a peer's `auto-exit` or stale-flag cleanup ended
// the other's sprint. The model cannot key the file itself, because it does not
// know its own session id. Hooks do: every payload carries `session_id`.
//
// So the model keeps writing the plain name, and a hook CLAIMS it at once by
// renaming it to `.claude/auto-active.<session>`. PostToolUse on the Write
// claims it within the same tool call; Stop claims anything left (a flag
// written through Bash). rename is atomic, so two sessions racing for one file
// end with exactly one owner and the loser sees ENOENT.
//
// Run with --help for usage.

const fs = require('fs');
const path = require('path');

const CLAIMABLE = ['auto-active', 'auto-exit'];

/** The payload's session id, reduced to a safe file-name segment. */
function sidOf(payload) {
    const raw = payload && typeof payload.session_id === 'string' ? payload.session_id : '';
    return raw ? raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) : 'no-session';
}

function pathsFor(cwd, sid) {
    const dir = path.join(cwd, '.claude');
    return {
        dir,
        active: path.join(dir, 'auto-active.' + sid),
        exit: path.join(dir, 'auto-exit.' + sid),
        idle: path.join(dir, 'auto-idle-triggered.' + sid),
        // Stop notes already handed to the model this session (stop-auto-check.js).
        notes: path.join(dir, 'stop-notes.' + sid),
    };
}

/**
 * Rename any plain flag in `cwd` to this session's key. Returns the names
 * claimed. Never throws: a flag that cannot be claimed stays where it is.
 */
function claim(cwd, sid) {
    const claimed = [];
    const dir = path.join(cwd, '.claude');
    for (const name of CLAIMABLE) {
        try {
            fs.renameSync(path.join(dir, name), path.join(dir, name + '.' + sid));
            claimed.push(name);
        } catch { /* absent, or a peer claimed it first */ }
    }
    return claimed;
}

function isActive(cwd, sid) {
    try { return fs.existsSync(pathsFor(cwd, sid).active); } catch { return false; }
}

/** True when `filePath` is one of the plain claimable flags. */
function isFlagPath(filePath) {
    if (typeof filePath !== 'string' || !filePath) return false;
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts.length >= 2 && parts[parts.length - 2] === '.claude' && CLAIMABLE.includes(parts[parts.length - 1]);
}

module.exports = { sidOf, pathsFor, claim, isActive, isFlagPath, CLAIMABLE };

if (require.main === module) {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log('auto-flag.js: the auto-mode flags, keyed per session.\n'
            + 'Library for stop-auto-check.js and post-tool-typecheck.js. The model writes\n'
            + '.claude/auto-active or .claude/auto-exit; a hook renames it to\n'
            + '.claude/<name>.<session_id> so sessions sharing a directory never share a flag.\n'
            + 'Usage: node auto-flag.js --list [dir]   lists the keyed flags under dir/.claude');
        process.exit(0);
    }
    if (process.argv.includes('--list')) {
        const cwd = process.argv[process.argv.indexOf('--list') + 1] || process.cwd();
        let names = [];
        try { names = fs.readdirSync(path.join(cwd, '.claude')).filter((n) => /^auto-(active|exit|idle-triggered)(\.|$)/.test(n)); } catch { /* none */ }
        console.log(`${names.length} auto flag(s) under ${path.join(cwd, '.claude')}`);
        for (const n of names) console.log('  ' + n);
        process.exit(0);
    }
    console.log('Nothing to do. Run with --help.');
}
