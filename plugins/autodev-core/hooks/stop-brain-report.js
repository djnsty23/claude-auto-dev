#!/usr/bin/env node
// Stop hook — nudges a session to report finished work to the coordinator.
//
// THE PROBLEM IT EXISTS FOR, measured 2026-09-03 across one overnight fleet run:
// every spawned session's brief said "message the Brain when you finish or are
// blocked rather than idling", and 4 of ~13 did. The ones that stayed silent
// were the ones that had FINISHED: one opened a PR, another merged three, and
// the coordinator learned about both by reading git rather than from them. The
// operator was pressing tab-enter per session to make them report.
//
// A brief is a request. This is the deterministic trigger that a request lacks.
// It does not send anything itself: a hook has no messaging tool. It detects
// unreported work and puts that fact in front of the model at the moment a turn
// ends, which is the point where a session would otherwise go quiet.
//
// WHY COMMITS ARE THE SIGNAL, and not "the session went idle". Idle and finished
// are indistinguishable from outside, which is the whole reason the coordinator
// was polling. A commit is evidence that something was DELIVERED, it is local,
// it costs one `git rev-parse`, and it needs no network. `gh pr view` would be a
// better signal and is a network round trip inside a 5s hook budget, so it is
// deliberately not used.
//
// WHY IT IS THROTTLED. Each notice the coordinator receives wakes it and re-reads
// its whole context. [measured 2026-09-03] a main-thread turn on that fleet
// averaged 324,223 cache-read tokens, and a stop watch firing on every quiet
// session cost 72 wakes in one night. A hook that fired on every commit would be
// worse than the polling it replaces. So: at most one notice per cooldown window,
// default 20 minutes, and only when commits actually landed.
//
// INERT BY DEFAULT. No `~/.claude/brain-role.json` means no coordinator is
// running and there is nobody to report to, so this emits nothing. Same role file
// and same env override as coordinator-write-guard.js, deliberately: one claim
// mechanism, not two. Extra keys in that file are ignored by both.
//
// IT NEVER BLOCKS. A Stop hook can refuse to end a turn. This one must not: it
// ships installed, a defect here would strand every user's session, and nothing
// it reports is worth holding a turn for. Every path exits 0.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const COOLDOWN_MIN_DEFAULT = 20;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('stop-brain-report.js — Stop hook.\n'
        + 'Tells a session to report to the coordinator when it has committed work\n'
        + 'since its last report. Reads the same role file as coordinator-write-guard:\n'
        + '$AUTODEV_BRAIN_ROLE_FILE, else ~/.claude/brain-role.json. Absent = inert.\n'
        + 'Throttle: $AUTODEV_BRAIN_REPORT_COOLDOWN_MIN, default ' + COOLDOWN_MIN_DEFAULT + ' minutes.\n'
        + 'State:    $AUTODEV_BRAIN_REPORT_STATE, else ~/.claude/brain-report-state.json.\n'
        + 'Never blocks a turn; every path exits 0.');
    process.exit(0);
}

/** Nothing to say. A hook with no opinion must emit zero bytes on both streams. */
function silent() {
    process.exit(0);
}

function roleFilePath() {
    return process.env.AUTODEV_BRAIN_ROLE_FILE
        || path.join(os.homedir(), '.claude', 'brain-role.json');
}

function statePath() {
    return process.env.AUTODEV_BRAIN_REPORT_STATE
        || path.join(os.homedir(), '.claude', 'brain-report-state.json');
}

function readJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

/** HEAD sha for `cwd`, or null when this is not a git repo or git is unavailable. */
function headSha(cwd) {
    try {
        const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
        if (r.status !== 0) return null;
        const s = (r.stdout || '').trim();
        return /^[0-9a-f]{7,40}$/.test(s) ? s : null;
    } catch {
        return null;
    }
}

/** How many commits `cwd` is ahead of its tracked upstream. null when unknowable. */
function aheadOfUpstream(cwd) {
    try {
        const r = spawnSync('git', ['rev-list', '--count', '@{upstream}..HEAD'],
            { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
        if (r.status !== 0) return null;          // no upstream is normal, not an error
        const n = Number((r.stdout || '').trim());
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

function branchName(cwd) {
    try {
        const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
            { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
        return r.status === 0 ? (r.stdout || '').trim() : null;
    } catch {
        return null;
    }
}

let raw = '';
try {
    raw = fs.readFileSync(0, 'utf8');
} catch {
    silent();
}

let input = null;
try {
    input = JSON.parse(raw);
} catch {
    silent();                                      // unparseable stdin is not this hook's problem
}
if (!input || typeof input !== 'object') silent();

const role = readJson(roleFilePath());
if (!role) silent();                               // no coordinator claimed this machine

const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
if (!sessionId) silent();

// Never nudge the coordinator to report to itself.
if (role.session_id && role.session_id === sessionId) silent();

const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
const sha = headSha(cwd);
if (!sha) silent();                                // not a git repo: no delivery evidence available

const state = readJson(statePath()) || {};
const prior = state[sessionId] && typeof state[sessionId] === 'object' ? state[sessionId] : null;

const now = Date.now();
const cooldownMin = Number(process.env.AUTODEV_BRAIN_REPORT_COOLDOWN_MIN);
const cooldownMs = (Number.isFinite(cooldownMin) && cooldownMin >= 0
    ? cooldownMin
    : COOLDOWN_MIN_DEFAULT) * 60 * 1000;

// FIRST SIGHTING IS NOT A REPORT. A session this hook has never seen has no
// "since last time" to measure, and firing on it would notify once for every
// session the moment a coordinator starts, which is a thundering herd rather
// than a signal. Record the baseline and stay quiet.
if (!prior || typeof prior.sha !== 'string') {
    writeState(state, sessionId, { sha, at: now, reportedAt: null });
    silent();
}

if (prior.sha === sha) silent();                   // no commit landed since last look

// A commit landed. Throttle on the last NOTICE, not the last look, so a session
// committing every turn produces one notice per window rather than one per commit.
const lastNotice = Number(prior.reportedAt) || 0;
if (lastNotice && now - lastNotice < cooldownMs) {
    writeState(state, sessionId, { sha, at: now, reportedAt: lastNotice });
    silent();
}

const branch = branchName(cwd);
const ahead = aheadOfUpstream(cwd);
writeState(state, sessionId, { sha, at: now, reportedAt: now });

const where = [
    branch ? 'branch ' + branch : null,
    'HEAD ' + sha.slice(0, 8),
    ahead === null ? null : ahead + ' ahead of upstream',
].filter(Boolean).join(', ');

const addr = [
    role.peer_name ? 'peer name `' + role.peer_name + '`' : null,
    role.session_id ? 'desktop session id `' + role.session_id + '`' : null,
].filter(Boolean).join(', ') || 'the coordinator session';

// additionalContext is the field that reaches the model. Plain stdout on exit 0
// goes to the debug log and would be invisible here.
console.log(JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
            'YOU HAVE COMMITTED WORK THE COORDINATOR HAS NOT BEEN TOLD ABOUT (' + where + ').\n'
            + 'Message it before you go quiet: ' + addr + '.\n'
            + 'Say what landed, what you verified naming the command and what it printed, '
            + 'what is blocked and on whom, and what you propose next. From outside, a '
            + 'finished session and a dead one look identical, so silence is the one '
            + 'signal it cannot read.\n'
            + 'If you have already reported this work, ignore this and carry on.',
    },
}));
process.exit(0);

function writeState(all, id, entry) {
    try {
        all[id] = entry;
        // Keep the ledger from growing without bound: drop entries older than 30 days.
        const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
        for (const k of Object.keys(all)) {
            if (all[k] && Number(all[k].at) && Number(all[k].at) < cutoff) delete all[k];
        }
        const p = statePath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(all, null, 2) + '\n');
    } catch {
        /* a ledger we cannot write costs a duplicate notice, never a broken turn */
    }
}
