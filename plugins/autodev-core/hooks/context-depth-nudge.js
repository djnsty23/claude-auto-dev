#!/usr/bin/env node
// The `context_nudge` switch (plugin userConfig, CLAUDE_PLUGIN_OPTION_CONTEXT_NUDGE="false")
// skips this hook: it advises, it never guards. tooling/test-hooks-profile.js holds the list.
if (process.env.CLAUDE_PLUGIN_OPTION_CONTEXT_NUDGE === 'false') process.exit(0);

// Stop hook: past the SOFT line, holds the turn open ONCE per band so the
// session saves its state at a natural break, before compaction lands.
//
// THE RULE IT ENFORCES. Context depth is the bill: measured over 19,419
// requests in one weekly quota window, 77% of weighted cost was cache READ, the
// average main-thread request re-read 405k tokens to emit 1,063, and the second
// half of a session cost 1.44x the first half for the same turn count. The rule
// that came out of it says: past ~300k, finish the step, write the handoff, and
// shed the context.
//
// HOW THE CONTEXT IS SHED. Until 8.171.0 the only way was a continuation chip
// (spawn_task), and a chip needs a person to click it. The harness can instead
// compact in place: `autoCompactWindow` in settings, or
// CLAUDE_CODE_AUTO_COMPACT_WINDOW, sets the window and compaction fires near the
// top of it. What compaction cannot do is choose its moment, so it can land
// mid-edit with nothing saved. This hook supplies the moment. At the soft line
// (default 250k, below a recommended 320k window) it blocks the Stop once, with
// a reason telling the model to finish the unit it is in, refresh its handoff
// with session-exit.js, and end the turn. Compaction then lands after the state
// is on disk, and session-start.js points the compacted session back at it.
//
// When no window is configured, compaction is not coming, so the reason falls
// back to the continuation chip. When one is configured but the depth is
// already at or past it, compaction evidently did not fire, and the chip text
// is used for the same reason.
//
// WHY A BLOCK CANNOT LOOP. A blocked Stop makes the model take another turn and
// then Stop again, with stop_hook_active set. This hook is silent whenever that
// flag is set, and it records the band BEFORE it speaks: a state it cannot
// write, or a state file it cannot parse, means silence rather than a block,
// because a block it cannot remember is a block every turn.
//
// STATE IS ONE FILE PER SESSION, written to a temp name and renamed. The
// previous single shared ledger was a read-modify-write on one JSON file, and
// concurrent Stops in two sessions wiped each other's entries. Falling below
// the line (a compaction) deletes the file, so the next climb speaks again.
//
// SILENT MEANS ZERO BYTES on both streams. A hook with nothing to say emits
// nothing, and the suite asserts that against every quiet path.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SOFT_LINE_DEFAULT = 250_000;
const BAND_DEFAULT = 50_000;
const CHUNK = 256 * 1024;        // bytes read per backward step
const MAX_SCAN = 16 * 1024 * 1024; // give up past this much tail; a row can be big
const STATE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('context-depth-nudge.js — Stop hook.\n'
        + 'Reads the latest assistant row\'s usage from transcript_path and, once per\n'
        + 'band past the soft line, blocks the Stop with a reason: finish the unit,\n'
        + 'refresh the handoff with session-exit.js --out, then end the turn.\n'
        + 'With an auto-compact window configured, compaction follows. Without one,\n'
        + 'the reason orders a continuation chip instead.\n'
        + 'Line:     $AUTODEV_CONTEXT_SOFT_LINE, default ' + SOFT_LINE_DEFAULT
        + ' ($AUTODEV_CONTEXT_NUDGE_TOKENS is read when it is unset).\n'
        + 'Band:     $AUTODEV_CONTEXT_NUDGE_STEP, default ' + BAND_DEFAULT + '.\n'
        + 'Window:   $CLAUDE_CODE_AUTO_COMPACT_WINDOW, else autoCompactWindow (or env.\n'
        + '          CLAUDE_CODE_AUTO_COMPACT_WINDOW) in the local, project or user settings.\n'
        + 'State:    one file per session in $AUTODEV_CONTEXT_NUDGE_STATE_DIR, else\n'
        + '          ~/.claude/autodev/context-nudge/, written with a temp file and a rename.\n'
        + 'Disable:  AUTODEV_CONTEXT_NUDGE=off.\n'
        + 'Silent while stop_hook_active is set; every path exits 0; silence is zero bytes.');
    process.exit(0);
}

/** Nothing to say. */
function silent() {
    process.exit(0);
}

function positiveInt(raw, fallback) {
    const n = Number.parseInt(String(raw == null ? '' : raw), 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function configDir() {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function stateDir() {
    return process.env.AUTODEV_CONTEXT_NUDGE_STATE_DIR
        || path.join(configDir(), 'autodev', 'context-nudge');
}

/** A session id as a file name: anything outside [A-Za-z0-9_-] becomes _. */
function stateFile(id) {
    return path.join(stateDir(), id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) + '.json');
}

/**
 * The per-session state: { kind: 'absent' } when there is no file,
 * { kind: 'ok', value } when it parses to an object, and { kind: 'bad' } when it
 * exists and does not. 'bad' is kept apart from 'absent' because the two call
 * for opposite actions: an absent file may be written, a bad one must not be.
 */
function readState(p) {
    let text;
    try {
        text = fs.readFileSync(p, 'utf8');
    } catch (e) {
        return e && e.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'bad' };
    }
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' ? { kind: 'ok', value: v } : { kind: 'bad' };
    } catch {
        return { kind: 'bad' };
    }
}

/** Writes via a temp name and a rename, so a reader never sees half a file. True on success. */
function writeState(p, entry) {
    const tmp = p + '.' + process.pid + '.tmp';
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(entry) + '\n');
        fs.renameSync(tmp, p);
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* never created */ }
        return false;
    }
    pruneState(path.dirname(p), p);
    return true;
}

/** Deletes other sessions' state files older than a week. Best effort. */
function pruneState(dir, keep) {
    try {
        const cutoff = Date.now() - STATE_MAX_AGE_MS;
        for (const name of fs.readdirSync(dir)) {
            const f = path.join(dir, name);
            if (f === keep || !name.endsWith('.json')) continue;
            try { if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch { /* raced */ }
        }
    } catch { /* a directory we cannot list costs stale files, nothing more */ }
}

function readJsonObject(p) {
    try {
        const v = JSON.parse(fs.readFileSync(p, 'utf8'));
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

/**
 * The configured auto-compact window in tokens, or null. The environment wins,
 * then local, project and user settings in that order, each read for both
 * `autoCompactWindow` and an `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` entry.
 */
function autoCompactWindow(cwd) {
    const fromEnv = positiveInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, null);
    if (fromEnv) return fromEnv;
    const files = [];
    if (cwd) {
        files.push(path.join(cwd, '.claude', 'settings.local.json'));
        files.push(path.join(cwd, '.claude', 'settings.json'));
    }
    files.push(path.join(configDir(), 'settings.json'));
    for (const f of files) {
        const s = readJsonObject(f);
        if (!s) continue;
        const direct = positiveInt(s.autoCompactWindow, null);
        if (direct) return direct;
        const viaEnv = s.env && typeof s.env === 'object'
            ? positiveInt(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, null) : null;
        if (viaEnv) return viaEnv;
    }
    return null;
}

/**
 * Context depth of the latest assistant call in a transcript, read from the
 * tail backwards so a multi-megabyte transcript costs one stat and a few
 * chunk reads. Returns null when no assistant row with usage is found within
 * MAX_SCAN bytes, or the file cannot be read.
 *
 * Why backwards and chunked rather than "read the last 256KB": a single
 * attachment row (a large tool result) can exceed any fixed tail, and a fixed
 * tail with no usage row in it would read as "no depth", which is a silence
 * that means the probe was too small rather than the session too shallow.
 */
function latestContextDepth(transcriptPath) {
    let fd;
    try {
        fd = fs.openSync(transcriptPath, 'r');
        const size = fs.fstatSync(fd).size;
        let end = size;
        let carry = '';
        let scanned = 0;
        while (end > 0 && scanned < MAX_SCAN) {
            const start = Math.max(0, end - CHUNK);
            const buf = Buffer.alloc(end - start);
            fs.readSync(fd, buf, 0, end - start, start);
            scanned += end - start;
            const text = buf.toString('utf8') + carry;
            const lines = text.split('\n');
            // The first element may be a partial line cut by the chunk boundary;
            // it is carried into the next (earlier) chunk and completed there.
            carry = start > 0 ? lines.shift() : '';
            for (let i = lines.length - 1; i >= 0; i--) {
                const depth = depthOfRow(lines[i]);
                if (depth != null) return depth;
            }
            end = start;
        }
        // Reached the file start: the carry is now a whole first line.
        return carry ? depthOfRow(carry) : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* nothing to recover */ }
        }
    }
}

/** Context depth from one transcript row, or null if it is not an assistant row with usage. */
function depthOfRow(line) {
    if (!line || line.indexOf('"usage"') === -1) return null;
    let row;
    try {
        row = JSON.parse(line);
    } catch {
        return null; // a truncated or foreign line; keep scanning
    }
    if (!row || row.type !== 'assistant' || !row.message || !row.message.usage) return null;
    const u = row.message.usage;
    const n = (Number(u.input_tokens) || 0)
        + (Number(u.cache_read_input_tokens) || 0)
        + (Number(u.cache_creation_input_tokens) || 0);
    return n > 0 ? n : null;
}

function readPayload() {
    try {
        if (process.stdin.isTTY) return null;
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return null;
    }
}

const disabled = String(process.env.AUTODEV_CONTEXT_NUDGE || '').trim().toLowerCase();
if (disabled === 'off' || disabled === '0' || disabled === 'false') silent();

const payload = readPayload();
if (!payload || typeof payload !== 'object') silent();

// The block this hook issued last turn is what set this flag. Speaking again
// here is the loop.
if (payload.stop_hook_active === true) silent();

const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
const transcriptPath = typeof payload.transcript_path === 'string' && payload.transcript_path ? payload.transcript_path : null;
if (!sessionId || !transcriptPath) silent();
const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

const softLine = positiveInt(process.env.AUTODEV_CONTEXT_SOFT_LINE,
    positiveInt(process.env.AUTODEV_CONTEXT_NUDGE_TOKENS, SOFT_LINE_DEFAULT));
const band = positiveInt(process.env.AUTODEV_CONTEXT_NUDGE_STEP, BAND_DEFAULT);

const depth = latestContextDepth(transcriptPath);
if (depth == null) silent();

const statePath = stateFile(sessionId);
if (depth < softLine) {
    // Below the line, usually after a compaction: forget the bands spoken in the
    // last climb so the next one speaks again.
    try { fs.unlinkSync(statePath); } catch { /* nothing recorded */ }
    silent();
}

// 0 in the first band past the line, 1 in the next, and so on.
const bucket = Math.floor((depth - softLine) / band);

const state = readState(statePath);
if (state.kind === 'bad') silent();
if (state.kind === 'ok' && Number.isInteger(state.value.bucket) && state.value.bucket >= bucket) silent();

if (!writeState(statePath, { bucket, depth, at: Date.now() })) silent();

const k = (n) => Math.round(n / 1000) + 'k';
const window = autoCompactWindow(cwd);
const compactionFollows = window != null && depth < window;
const handoff = path.join(cwd, '.claude', 'handoffs', 'RESUME-' + sessionId.slice(0, 8) + '.md');
const sessionExit = path.join(__dirname, '..', 'scripts', 'session-exit.js');

// THE SIX RESUME FIELDS, in the order session-exit.js renders them. Failed
// attempts is the one a progress-only handoff drops, and it is the one that
// costs most to lose: a session that does not know an approach already failed
// tries it again. tooling/test-context-depth-nudge.js spells all six, so
// removing one here goes red.
const save = 'Finish the unit of work you are in and do not start a new one. Then refresh '
    + 'the handoff: node "' + sessionExit + '" --out "' + handoff + '" (a path git '
    + 'ignores: check with git check-ignore, and add .claude/handoffs/ to .gitignore if '
    + 'it is not). session-exit.js fills the measured fields and keeps what you write in '
    + 'the others. The six fields are: goal; current state; files in flight; changes '
    + 'made, each with the command that verified it; failed attempts, each with why it '
    + 'failed, so the next session does not try them again; next steps.';
let forModel = 'CONTEXT DEPTH IS ' + depth.toLocaleString('en-US') + ' TOKENS, PAST THE '
    + k(softLine) + ' SOFT LINE. Every turn re-reads this whole conversation, so the '
    + 'context is about to be shed. ' + save + ' ';
let forOperator = 'Context depth ' + k(depth) + ' tokens, past the ' + k(softLine) + ' soft line. ';
if (compactionFollows) {
    forModel += 'Then end the turn. Auto-compaction is configured at a ' + k(window)
        + ' window, so it follows at this break, and the session start after it points '
        + 'you back at the handoff. Do not spawn a continuation chip.';
    forOperator += 'Saving the handoff before auto-compaction (' + k(window) + ' window).';
} else {
    forModel += (window != null
        ? 'The ' + k(window) + ' auto-compact window is already exceeded, so compaction is not coming. '
        : 'No auto-compact window is configured, so compaction is not coming. ')
        + 'Call spawn_task for a continuation chip BEFORE you go quiet: a fresh worktree '
        + 'does not contain the gitignored handoff, so its prompt names the handoff by '
        + 'ABSOLUTE path, repeats the first move and the traps inline, and ends with this '
        + 'same rule so the chain continues. Say so to whoever is coordinating, and end the turn.';
    forOperator += 'Saving the handoff, then a continuation chip.';
}

console.log(JSON.stringify({
    decision: 'block',
    reason: forModel,
    systemMessage: forOperator,
}));
process.exit(0);
