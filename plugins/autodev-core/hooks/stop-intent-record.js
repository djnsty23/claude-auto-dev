#!/usr/bin/env node
'use strict';
// hooks_profile=minimal (plugin userConfig, reaching hooks as CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE)
// skips this hook: it advises, it never guards — every path here emits either a nudge or
// nothing, and the OBSERVED block it refreshes has no reader, so turning it off loses no
// state. tooling/test-hooks-profile.js holds the list.
if (/^minimal$/i.test(process.env.CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE || process.env.CLAUDE_PLUGIN_OPTION_hooks_profile || '')) process.exit(0);

/**
 * stop-intent-record.js — Stop hook. Keeps the intent record honest.
 *
 * THE PROBLEM, `[measured 2026-09-08]`. A usage limit killed part of a
 * 39-session fleet overnight. The commits survived; the intentions did not, and
 * a coordinator spent the night reconstructing "what was this doing, what comes
 * next" from transcripts and PR titles. `scripts/fleet-intent.js` gives that
 * answer a place to live. This hook exists because a place to live is not the
 * same as something living in it: A RECORD NOBODY UPDATES IS WORSE THAN NONE,
 * because it will be read as current.
 *
 * WHAT IT WILL NOT DO, and this is the point of the file. It never writes a
 * CLAIM, and it never moves `updated_at`. It cannot: a Stop payload carries a
 * `session_id` and a `cwd`, and a tree carries a head, a branch and a distance
 * from the trunk. None of that is an intention. The obvious design — have the
 * hook stamp the record every turn so it "stays maintained" — manufactures
 * exactly the artefact the fleet lost a night to: a nine-hour-old plan wearing a
 * one-minute-old date. Whoever read it next would skip work already done, and
 * skipping emits no output, no failure and no diff.
 *
 * So it does two things. It refreshes the OBSERVED block, which is facts and
 * carries its own separate timestamp; and when the record is missing or the tree
 * has walked away from it, it says so, once per cooldown, to the one party that
 * can fix it — the session whose intention it is.
 *
 * INERT UNLESS THE DIRECTORY EXISTS. This ships installed in other people's
 * sessions. Somebody with no fleet and no `~/claude-memory/fleet-intent` must
 * never see a word from it, so the directory's existence IS the opt-in: the
 * first `fleet-intent.js --set` creates it and arms this hook, and until then
 * every path here emits zero bytes.
 *
 * IT NEVER BLOCKS. A Stop hook can refuse to end a turn. Nothing this reports is
 * worth holding a turn for, and a defect here would strand every installed
 * session until they reinstall. Every path exits 0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const COOLDOWN_MIN_DEFAULT = 45;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('stop-intent-record.js — Stop hook.\n'
        + 'Refreshes the observed facts on this repo+branch\'s fleet-intent record, and\n'
        + 'asks for a claim when the record is missing or the tree has moved past it.\n'
        + 'Never writes a claim; never moves updated_at; never blocks a turn.\n'
        + 'Inert unless $AUTODEV_FLEET_INTENT_DIR (else ~/claude-memory/fleet-intent) exists.\n'
        + 'Throttle: $AUTODEV_INTENT_COOLDOWN_MIN, default ' + COOLDOWN_MIN_DEFAULT + ' minutes.\n'
        + 'State:    $AUTODEV_INTENT_NUDGE_STATE, else ~/.claude/intent-nudge-state.json.');
    process.exit(0);
}

/** Nothing to say. Zero bytes on BOTH streams, not merely no context. */
function silent() {
    process.exit(0);
}

function statePath() {
    return process.env.AUTODEV_INTENT_NUDGE_STATE
        || path.join(os.homedir(), '.claude', 'intent-nudge-state.json');
}

let intent = null;
try {
    intent = require(path.join(__dirname, '..', 'scripts', 'fleet-intent.js'));
} catch {
    silent();                                      // a broken install must be quiet, not loud
}

// The opt-in gate, checked before anything else costs a subprocess.
let dir;
try {
    dir = intent.recordDir();
    if (!fs.statSync(dir).isDirectory()) silent();
} catch {
    silent();
}

let input = null;
try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
    silent();
}
if (!input || typeof input !== 'object') silent();

const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();

let repo = null;
let branch = null;
try {
    repo = intent.repoName(cwd);
    branch = intent.branchOf(cwd);
} catch {
    silent();
}
if (!repo || !branch) silent();                    // no repo, or a detached HEAD with nothing to key on

// A session sitting on the trunk is not carrying a branch of work, and the
// trunk's record would be written and rewritten by everyone.
if (branch === 'main' || branch === 'master') silent();

let observed = null;
try {
    observed = intent.observe(cwd);
} catch {
    silent();
}

const existing = (() => {
    try { return intent.readRecord(repo, branch); } catch { return { record: null, collision: false }; }
})();

/* THE FACTS ARE REFRESHED; THE CLAIM IS NOT TOUCHED.
   Only when a record already exists — creating one here would produce a record
   whose every claim field is null and whose observation is a minute old, which
   reads to a scanner as "a session is on this and has nothing to say" rather
   than as "nobody wrote anything down". Absence must look like absence. */
if (existing.record && !existing.collision) {
    try {
        intent.writeRecord({ repo, branch, session_id: sessionId, claim: null, observed });
    } catch {
        /* an unwritable record costs a stale observation, never a broken turn */
    }
}

// ── is there anything worth saying? ──────────────────────────────────────────

const assessment = (() => {
    try { return intent.assess(existing.record, observed); } catch { return null; }
})();

// Delivery evidence, exactly as stop-brain-report.js reads it: work that exists
// only in this worktree is the work whose loss cannot be recovered from a forge.
const carrying = observed && (observed.on_trunk === false || (observed.ahead !== null && observed.ahead > 0));

let reason = null;
if (existing.collision) {
    reason = 'collision';
} else if (!existing.record) {
    if (carrying) reason = 'missing';
} else if (assessment && assessment.moved === true) {
    reason = 'moved';
} else if (assessment && assessment.missing.includes('verify')
    && (existing.record.state === 'working' || existing.record.state === 'checkpointed')) {
    reason = 'unverifiable';
}
if (!reason) silent();

// ── throttle, keyed on the RECORD, not on the session ────────────────────────
/* The record outlives the session, and two sessions can occupy one branch in
   sequence. Keying the cooldown on `session_id` would let each new session
   re-fire immediately for a record that has not changed, which is the shape
   that trains a reader to ignore the nudge. */
const key = intent.keyFor(repo, branch);
const now = Date.now();
const cooldownMin = Number(process.env.AUTODEV_INTENT_COOLDOWN_MIN);
const cooldownMs = (Number.isFinite(cooldownMin) && cooldownMin >= 0
    ? cooldownMin
    : COOLDOWN_MIN_DEFAULT) * 60 * 1000;

let state = {};
try { state = JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch { state = {}; }
const prior = state[key] && typeof state[key] === 'object' ? state[key] : null;

/* THE SAME REASON IS THROTTLED; A NEW ONE IS NOT. A record that went from
   "missing" to "the tree has moved" has changed in a way the reader must hear
   about, and holding that for the rest of the window would be silence at the
   moment the record started lying. */
if (prior && prior.reason === reason && Number(prior.at) && now - Number(prior.at) < cooldownMs) silent();

try {
    state[key] = { reason, at: now };
    const cutoff = now - 30 * 24 * 3600 * 1000;
    for (const k of Object.keys(state)) {
        if (state[k] && Number(state[k].at) && Number(state[k].at) < cutoff) delete state[k];
    }
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n');
} catch {
    /* a ledger we cannot write costs a duplicate nudge, never a broken turn */
}

const CMD = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/fleet-intent.js --set';
const SHAPE = '  --brief "what you were sent to do" --current "what you are doing now"\n'
    + '  --next "what the NEXT session does first" --verify "<a command whose output shows whether this is done>"\n'
    + 'A record with no --verify is a memory, and it rots. One with a command can be re-checked at any age.';

let context;
if (reason === 'collision') {
    context = 'YOUR FLEET-INTENT RECORD CANNOT BE READ: a record at this key names a different '
        + 'branch, so two branch names collided into one filename. Nothing is being served for '
        + branch + '. Say so when you report, and do not trust a --read for this branch.';
} else if (reason === 'missing') {
    const where = observed.on_trunk === false
        ? 'this branch is not on the trunk'
        : observed.ahead + ' commit(s) ahead of upstream';
    context = 'YOU ARE CARRYING WORK NOBODY HAS WRITTEN DOWN THE INTENTION FOR (' + where + ', HEAD '
        + String(observed.head).slice(0, 8) + '), and there is no fleet-intent record for '
        + repo + ' ' + branch + '.\n'
        + 'If this session stops — a usage limit, a crash, a restart — the commits survive and the '
        + 'plan does not. Write it in one call:\n' + CMD + '\n' + SHAPE;
} else if (reason === 'moved') {
    const age = assessment.age_min === null ? 'an unknown time ago'
        : assessment.age_min < 90 ? assessment.age_min + ' minutes ago' : Math.round(assessment.age_min / 60) + ' hours ago';
    context = 'YOUR FLEET-INTENT RECORD IS ABOUT A TREE THAT HAS MOVED. The claim was made ' + age
        + ' against ' + String(existing.record.claim_head).slice(0, 8) + '; HEAD is now '
        + String(observed.head).slice(0, 8) + '.\n'
        + 'Its `next_step` reads "' + String(existing.record.next_step || '(not stated)') + '", which may already be done. '
        + 'Refresh it, or set --state complete:\n' + CMD + ' --current "..." --next "..."';
} else {
    context = 'YOUR FLEET-INTENT RECORD FOR ' + repo + ' ' + branch + ' HAS NO `verify` COMMAND, so no '
        + 'later reader can tell whether its next_step is still outstanding — only believe it or ignore it.\n'
        + CMD + ' --verify "<a command whose output shows whether this is done>"';
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
