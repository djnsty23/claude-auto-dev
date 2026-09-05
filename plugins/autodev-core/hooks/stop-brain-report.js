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

/**
 * Is HEAD already reachable from the trunk? null when it cannot be determined.
 *
 * `aheadOfUpstream` above answers "how far is HEAD from THIS BRANCH's tracked
 * ref", which is a different question from "is this work published", and the
 * hook was printing the first while the reader acted on the second.
 *
 * `[reported 2026-09-05]` by a session that had pushed everything to the trunk
 * and was then told it was carrying three commits the coordinator had not been
 * told about. Its own measurement: `@{u}...HEAD` was `0 3` while
 * `origin/main...HEAD` was `0 0` and `merge-base --is-ancestor HEAD origin/main`
 * succeeded. Every number was real and the sentence built from them was false.
 *
 * It is not a rare shape. Any session whose work reaches a trunk by MERGE rather
 * than by pushing its own branch ref leaves that branch's upstream behind
 * permanently, and in a worktree fleet that is most of them. The cost is not the
 * one wrong line: a nudge that fires on published work trains the reader to
 * ignore the nudge, and then it misses the session that really has not reported.
 *
 * `origin/HEAD` is resolved rather than assuming `origin/main`, because one repo
 * in this fleet has a `main` two months behind its real trunk.
 */
function publishedOnTrunk(cwd) {
    const run = (args) => spawnSync('git', args,
        { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
    try {
        let trunk = null;
        const sym = run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
        if (sym.status === 0) trunk = (sym.stdout || '').trim().replace(/^refs\/remotes\//, '');
        if (!trunk) {
            // No origin/HEAD is normal in a fresh clone. Fall back only to a ref
            // that exists, so a missing trunk reads as UNKNOWN rather than as
            // "not published", which is the direction that invents a nudge.
            const probe = run(['rev-parse', '--verify', '--quiet', 'origin/main']);
            if (probe.status === 0) trunk = 'origin/main'; else return null;
        }
        const anc = run(['merge-base', '--is-ancestor', 'HEAD', trunk]);
        if (anc.status === 0) return true;
        if (anc.status === 1) return false;
        return null;                              // any other status is unknowable
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
const published = publishedOnTrunk(cwd);
writeState(state, sessionId, { sha, at: now, reportedAt: now });

/* BOTH FACTS WHEN THEY DISAGREE, rather than replacing one with the other.
   A branch-local count of 3 on work that is already on the trunk is not noise
   to be suppressed: it says the branch ref was left behind by a merge, which is
   worth seeing. What was wrong was printing it ALONE, where it reads as "three
   commits nobody has been told about". Where the two agree, the trunk clause is
   omitted, because "0 ahead" and "on the trunk" say the same thing twice. */
const aheadClause = ahead === null ? null
    : published === true
        ? (ahead > 0
            ? ahead + ' ahead of its branch upstream, but already on the trunk'
            : 'on the trunk')
        : ahead + ' ahead of upstream';

const where = [
    branch ? 'branch ' + branch : null,
    'HEAD ' + sha.slice(0, 8),
    aheadClause,
].filter(Boolean).join(', ');

/* ⚠️ `session_id` IS NOT AN ADDRESS, AND PRINTING IT AS ONE SENT PEERS TO A DEAD
   ONE. This read `'desktop session id `' + role.session_id + '`'` until
   2026-09-04. It is neither: `session_id` is the Claude Code SESSION UUID this
   hook compares against `input.session_id` to exempt the coordinator from its
   own nudge, and the desktop registry keys on a different space entirely
   (`local_<uuid>`). A peer reported `Session not found` against it TWICE, and
   reached the coordinator in the end by matching a worktree path through
   list_sessions.
   One field cannot serve both: exemption needs the value the hook payload
   carries, addressing needs the value the messaging tool accepts. So the
   address is built only from fields that ARE addresses, and `session_id` is
   never one of them. `desktop_session_id` is optional and separate; a role file
   that omits it says so rather than substituting a lookalike.
   The failure is quiet by construction — a wrong address produces a lookup
   miss in the RECIPIENT's session, so the sender never learns the message went
   nowhere. */
/* THE RECORD IS CHECKED BEFORE IT IS HANDED OUT AS AN ADDRESS, AND THERE IS NO
   cwd FALLBACK. `[measured 2026-09-04]` this file named a session archived the
   previous afternoon for a whole day. Every Stop hook read it and routed idle
   reports to a dead Brain, and the old third address line ("or find it by cwd
   under <home_repos[0]>") sent them to whichever session later occupied that
   worktree: three inside one hour, two of them client sessions. A worktree
   outlives the session in it, so a directory names a place, not a correspondent.
   The fallback was the bug, not the mitigation.
   The check reads ~/.claude/sessions/<pid>.json and the desktop store, no MCP
   call, and it cannot throw. If the sibling script is missing (a broken
   install) the record is handed out unchecked, WITHOUT the cwd line, and the
   text says it was unchecked: absent coverage must not read as coverage. */
let verdict = null;
try {
    const { checkBrainRole } = require(path.join(__dirname, '..', 'scripts', 'check-brain-role.js'));
    verdict = checkBrainRole({ roleFile: roleFilePath(), role });
} catch {
    verdict = null;
}

const addr = [
    role.peer_name ? 'peer name `' + role.peer_name + '`' : null,
    role.desktop_session_id ? 'desktop session id `' + role.desktop_session_id + '`' : null,
].filter(Boolean).join(', ');

const REPORT_SHAPE =
    'Say what landed, what you verified naming the command and what it printed, '
    + 'what is blocked and on whom, and what you propose next. From outside, a '
    + 'finished session and a dead one look identical, so silence is the one '
    + 'signal it cannot read.\n'
    + 'If you have already reported this work, ignore this and carry on.';

let context;
if (verdict && verdict.state === 'fault') {
    context = 'YOU HAVE COMMITTED WORK THE COORDINATOR HAS NOT BEEN TOLD ABOUT (' + where + '), '
        + 'BUT THE ROLE FILE DOES NOT NAME A LIVE COORDINATOR: '
        + verdict.faults.map((f) => f.code + ' (' + f.detail + ')').join('; ') + '.\n'
        + 'Nobody can be reached at that record, and do not resolve a coordinator by cwd: a '
        + 'worktree outlives the session in it. Report to the operator instead, and say the '
        + 'role file at ' + roleFilePath() + ' is stale (check: scripts/check-brain-role.js --status).\n'
        + REPORT_SHAPE;
} else {
    const checked = verdict ? '' : ' (the record could not be checked for liveness; if the address does not resolve, the role file is stale)';
    context = 'YOU HAVE COMMITTED WORK THE COORDINATOR HAS NOT BEEN TOLD ABOUT (' + where + ').\n'
        + (addr
            ? 'Message it before you go quiet: ' + addr + checked + '.\n'
            : 'The role file at ' + roleFilePath() + ' carries no address (no peer_name, no desktop_session_id), '
              + 'so there is nobody to message; report to the operator and say so.\n')
        + REPORT_SHAPE;
}

// additionalContext is the field that reaches the model. Plain stdout on exit 0
// goes to the debug log and would be invisible here.
console.log(JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: context,
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
