#!/usr/bin/env node
'use strict';
/**
 * fleet-redispatch.js - at a session-limit reset boundary, decide which of the
 * fleet's checkpointed work is genuinely incomplete, and RANK it for a human.
 *
 * WHY THIS EXISTS. `[measured 2026-09-08]` a five-hour session limit stopped
 * part of a 39-session fleet overnight. Ten sessions resumed within the same
 * minute when the window reset - so the reset is a real, observable, fleet-wide
 * event - but every one of them resumed not knowing the tree had moved under
 * it: PRs had merged, branches had been superseded, premises were dead. A
 * coordinator repaired each one by hand. The reset is the moment to decide what
 * to re-dispatch, and nothing used it.
 *
 * WHAT IT DOES NOT DO: it never spawns anything. On this fleet sessions PROPOSE
 * follow-ups and the coordinator dispatches them, because a session cannot see
 * the headcount or what another repo is already doing. The output is a ranked
 * list and an exit code.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR RULES, AND THE ORDER THEY ARE APPLIED IN
 * ---------------------------------------------------------------------------
 *
 * The order is not stylistic. Each rule exists because skipping it cost this
 * fleet time, and the two failure directions are not symmetric: proposing a
 * restart that was not needed wastes a session, while restarting work that is
 * already done or still running LOSES work. So every unreadable signal falls
 * to COULD-NOT-CHECK, never to RESTART.
 *
 *   1. NEVER RESTART A LIVE SESSION'S WORK. Checked first, because two sessions
 *      on one branch in a shared clone is the dominant defect here - six
 *      same-file collisions in one night, four of them from a coordinator
 *      dispatching off a stale picture. An UNKNOWN liveness is not "gone".
 *
 *   2. RUN `verify` BEFORE PROPOSING ANYTHING. A record saying "waiting on CI"
 *      is worthless hours later, and the single most expensive failure here is
 *      restarting work that is already done - twice in one week a session was
 *      dispatched onto already-merged branches, once for twelve commits.
 *      `state` is never trusted on its own; `verify` is re-run, and the branch
 *      is asked whether it LANDED via check-branch-landed.js.
 *
 *   3. PROPOSE, DO NOT SPAWN. See above.
 *
 *   4. A RECORD YOU CANNOT VERIFY IS NOT A ZERO. Absence reported as health is
 *      this fleet's most-repeated defect - nine distinct false-green channels
 *      measured in one night, every one of them looking like a clean result.
 *      COULD-NOT-CHECK is counted, listed and exit-coded separately from
 *      "nothing to do", and every count is printed beside its population.
 *
 * ---------------------------------------------------------------------------
 * THE INTENT RECORD - OWNED ELSEWHERE, CONSUMED HERE
 * ---------------------------------------------------------------------------
 *
 * `~/claude-memory/fleet-intent/<repo>--<branch>.json`, `/` in the branch
 * written as `-`:
 *
 *   { repo, branch, session_id, brief, current_step, next_step,
 *     verify, state: working|checkpointed|complete|blocked, updated_at }
 *
 * Keyed by repo+branch and never by cwd, because a worktree outlives the
 * session in it. This file does not define that contract and must not extend
 * it; an unrecognised `state` is surfaced, never folded into a neighbour.
 *
 * ---------------------------------------------------------------------------
 * THE RESET BOUNDARY IS READ, NOT GUESSED
 * ---------------------------------------------------------------------------
 *
 * A re-dispatcher that fires at the wrong time is worse than none, because it
 * restarts work in flight. The boundary does not have to be guessed: the app
 * records it. A walled turn lands in the session transcript as an assistant row
 * carrying
 *
 *   "error": "rate_limit", "isApiErrorMessage": true, "apiErrorStatus": 429,
 *   "quotaLimits": { "status": "rejected", "resetsAt": <unix seconds>,
 *                    "rateLimitType": "five_hour", ... }
 *
 * `[measured 2026-09-08]` 127 transcripts on this disk carry 47 such rows,
 * spread over 23 worktrees in three separate repos, and every one of them
 * naming the SAME `resetsAt` 1788819000 - 2026-09-07T22:10:00Z. That is the
 * fleet-wide event, written down 47 times by the sessions it stopped.
 * `rateLimitType` separates the five-hour session window from the weekly one;
 * only `five_hour` is a boundary this tool acts on, and on this disk every one
 * of the 47 was `five_hour`.
 *
 * So the SCHEDULE does not carry the precision - the DATA does. Run this
 * hourly: it reads the boundaries recorded since its own last run and no-ops
 * unless one was crossed. A cadence that fires too often costs a no-op; a
 * cadence pinned to a guessed clock fires mid-work. If no boundary can be read
 * the run says so on a COULD-NOT-CHECK line and classifies anyway - it never
 * reports an unreadable boundary as "no reset happened".
 *
 * Usage:
 *   node fleet-redispatch.js                 # gate on the boundary, classify, rank
 *   node fleet-redispatch.js --all           # classify every record, no boundary gate
 *   node fleet-redispatch.js --json
 *   node fleet-redispatch.js --no-run-verify # classify without executing any verify
 *   node fleet-redispatch.js --boundaries    # just report the reset boundaries read
 *   node fleet-redispatch.js --selftest
 *
 * Exit: 0 ran, nothing to restart and nothing unreadable
 *       2 at least one RESTART candidate
 *       3 at least one COULD-NOT-CHECK  (outranks 2 on purpose: a silent
 *         unreadable is the failure this tool exists to stop)
 * Never throws; a crash would be indistinguishable from a verdict.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { sessionStore, codeDir, HOME } = require('./claude-paths.js');

// ---------------------------------------------------------------------------
// PURE LAYER. No I/O below this line until the CLI section, so the suite can
// plant each trap directly instead of needing a live fleet. A suite that
// mocked the transcripts would be asserting things about the mock.
// ---------------------------------------------------------------------------

const VERDICTS = {
    RESTART: 'RESTART',
    SKIP_LIVE: 'SKIP-LIVE',
    SKIP_LANDED: 'SKIP-LANDED',
    SKIP_VERIFIED: 'SKIP-VERIFIED',
    BLOCKED: 'BLOCKED',
    COULD_NOT_CHECK: 'COULD-NOT-CHECK',
};

// The five states the contract defines. A sixth must surface rather than being
// read as its nearest neighbour - the same failure prd.json's `passes` field
// has produced every time someone hand-rolled a filter over it.
const STATES = ['working', 'checkpointed', 'complete', 'blocked'];

/**
 * Which recorded reset boundaries fall in (sinceMs, nowMs]?
 *
 * `events` is an array of { resetsAtMs, rateLimitType, sessionId, cwd } or
 * null. NULL AND [] ARE DIFFERENT ANSWERS and the caller must keep them apart:
 * null means the transcripts could not be read, [] means they were read and
 * held no boundary. Collapsing the two is how an unreadable disk reports as a
 * quiet night.
 *
 * `sinceMs` null means no previous run is recorded. That is not "since the
 * beginning of time" and not "since now" - both are guesses. It returns
 * `ungated`, and the caller classifies without the gate and says why.
 */
function boundariesCrossed(events, sinceMs, nowMs) {
    if (events === null || events === undefined) {
        return { readable: false, ungated: true, crossed: [], reason: 'no transcript could be read for reset boundaries' };
    }
    const five = events.filter((e) => e && e.rateLimitType === 'five_hour' && Number.isFinite(e.resetsAtMs));
    if (sinceMs === null || sinceMs === undefined) {
        return {
            readable: true, ungated: true, crossed: [],
            reason: 'no previous run is recorded, so there is no window to gate on',
            seen: five.length,
        };
    }
    const crossed = five
        .filter((e) => e.resetsAtMs > sinceMs && e.resetsAtMs <= nowMs)
        .sort((a, b) => a.resetsAtMs - b.resetsAtMs);
    return { readable: true, ungated: false, crossed, seen: five.length };
}

/**
 * Is the session behind this record still running?
 *
 * Two independent sources, because each one alone has been wrong here:
 *
 *   ping   `lastActivityAt` from the desktop session store. The app refreshes
 *          it only while it holds the session and it FREEZES the moment one
 *          stops. `[measured 2026-09-08]` over 47 non-archived records on this
 *          disk the four running sessions read 2-97 s while the next reading
 *          was 1514 s, so a floor well above the ping cadence separates them.
 *          It reads null when the store is unreachable, and a null store once
 *          made three separate scripts each report a confident zero fleet.
 *
 *   wall   the last row of the session's own transcript being the rate_limit
 *          rejection. A session whose last recorded event is the wall is by
 *          definition not running. This is the sharp signal at a reset
 *          boundary, where the ping is hours old by construction and says
 *          nothing about why.
 *
 * The two are combined asymmetrically ON PURPOSE. Either source saying LIVE
 * makes it live; only both being readable and neither saying live makes it
 * gone. Neither readable is null - an unknown session is never treated as
 * gone, because dispatching onto a live session is the expensive direction.
 */
function liveness(evidence, floorMs) {
    const e = evidence || {};
    const pingKnown = Number.isFinite(e.pingAgeMs);
    const transcriptKnown = Number.isFinite(e.transcriptAgeMs);

    if (pingKnown && e.pingAgeMs < floorMs) {
        return { live: true, why: `session-store ping ${Math.round(e.pingAgeMs / 1000)}s old (floor ${Math.round(floorMs / 1000)}s)` };
    }
    if (transcriptKnown && e.transcriptAgeMs < floorMs && e.walled !== true) {
        return { live: true, why: `transcript written ${Math.round(e.transcriptAgeMs / 1000)}s ago and its last row is not a wall` };
    }
    if (e.walled === true) {
        return { live: false, why: 'the last row of its transcript is the rate_limit wall' };
    }
    if (pingKnown) {
        return { live: false, why: `session-store ping ${Math.round(e.pingAgeMs / 60000)}m old` };
    }
    if (transcriptKnown) {
        return { live: false, why: `transcript ${Math.round(e.transcriptAgeMs / 60000)}m old` };
    }
    return { live: null, why: 'neither the session store nor a transcript could be read for this session' };
}

const LANDED = new Set(['LANDED-ANCESTOR', 'LANDED-SQUASH', 'LANDED-CONTENT']);

/**
 * One record + the evidence gathered about it -> one verdict.
 *
 * `evidence` fields, every one optional and every one three-valued where it
 * matters (true / false / null-meaning-unreadable):
 *
 *   live        bool|null   from liveness() above
 *   liveWhy     string
 *   landed      string|null check-branch-landed.js verdict, null = not asked
 *                           or the ask failed. UNKNOWN is never landed.
 *   verify      'absent' | 'unrunnable' | 'timeout' | {code:number}
 *   verifyWhy   string
 */
function classify(record, evidence) {
    const e = evidence || {};
    const r = record || {};

    if (r.__unreadable) {
        return { verdict: VERDICTS.COULD_NOT_CHECK, reason: r.__unreadable };
    }
    if (!r.repo || !r.branch) {
        return { verdict: VERDICTS.COULD_NOT_CHECK, reason: 'record names no repo or no branch, so nothing can be checked about it' };
    }

    // RULE 1. Live work is never a candidate, and unknown is never gone.
    if (e.live === true) {
        return { verdict: VERDICTS.SKIP_LIVE, reason: `a session is still running on this branch: ${e.liveWhy || 'live'}` };
    }
    if (e.live === null || e.live === undefined) {
        return { verdict: VERDICTS.COULD_NOT_CHECK, reason: `cannot tell whether a session is still running: ${e.liveWhy || 'liveness unreadable'}. An unknown session is not treated as gone.` };
    }

    // RULE 2, first half. Already-landed work is the expensive restart.
    if (e.landed && LANDED.has(e.landed)) {
        return { verdict: VERDICTS.SKIP_LANDED, reason: `the branch already landed (${e.landed})` };
    }

    // RULE 2, second half. `state` alone never decides anything.
    const v = e.verify;
    if (v === 'absent') {
        return { verdict: VERDICTS.COULD_NOT_CHECK, reason: 'the record carries no verify command, so its state cannot be re-checked' };
    }
    if (v === 'unrunnable') {
        return { verdict: VERDICTS.COULD_NOT_CHECK, reason: `verify could not be run: ${e.verifyWhy || 'unrunnable'}` };
    }
    if (v === 'timeout') {
        // A killed child is not a verdict. Three suites in this repo each read
        // one as a failure before it was named; a timeout here would silently
        // become a restart proposal.
        return { verdict: VERDICTS.COULD_NOT_CHECK, reason: `verify was killed by the timeout, which is not a pass and not a failure: ${e.verifyWhy || ''}`.trim() };
    }
    if (!v || !Number.isFinite(v.code)) {
        return { verdict: VERDICTS.COULD_NOT_CHECK, reason: 'verify produced no exit status' };
    }
    if (v.code === 0) {
        const claimed = r.state && r.state !== 'complete' ? ` The record still said "${r.state}".` : '';
        return { verdict: VERDICTS.SKIP_VERIFIED, reason: `verify passed (exit 0), so the work is done regardless of what the record says.${claimed}` };
    }

    // Verify failed. Work remains - but some of it no agent can advance.
    if (r.state === 'blocked') {
        return { verdict: VERDICTS.BLOCKED, reason: `verify failed (exit ${v.code}) and the record says blocked - remaining work that waits on a person, not on a session` };
    }
    const lie = r.state === 'complete' ? ' The record claimed complete; it is not.' : '';
    const unknownState = r.state && !STATES.includes(r.state)
        ? ` Unrecognised state "${r.state}" - it is reported, not folded into a neighbour.` : '';
    return {
        verdict: VERDICTS.RESTART,
        reason: `verify failed (exit ${v.code}), so work remains.${lie}${unknownState}`,
    };
}

/**
 * Rank the restart candidates. Not a score - a stated order, so a coordinator
 * can disagree with a specific clause rather than with a number.
 *
 *   1. a record with a `next_step` resumes cheaply; one without needs the
 *      session rebuilt from the brief.
 *   2. `checkpointed` outranks `working`: a checkpoint is a deliberate stopping
 *      point, while `working` is where a session died mid-step and its
 *      `current_step` may be half-applied.
 *   3. newer `updated_at` first - an older premise has had longer to die.
 */
function rank(rows) {
    const key = (row) => {
        const r = row.record || {};
        const t = Date.parse(r.updated_at || '');
        return [
            r.next_step ? 0 : 1,
            r.state === 'checkpointed' ? 0 : 1,
            Number.isFinite(t) ? -t : 0,
        ];
    };
    return rows.slice().sort((a, b) => {
        const ka = key(a), kb = key(b);
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
        return String(a.file || '').localeCompare(String(b.file || ''));
    });
}

function rankReason(row) {
    const r = (row && row.record) || {};
    const bits = [];
    bits.push(r.next_step ? 'has a next_step' : 'NO next_step - rebuild from the brief');
    bits.push(r.state === 'checkpointed' ? 'checkpointed at a chosen stopping point' : `state "${r.state || 'unset'}"`);
    const t = Date.parse(r.updated_at || '');
    bits.push(Number.isFinite(t) ? `updated ${r.updated_at}` : 'no readable updated_at');
    return bits.join('; ');
}

/**
 * Counts, with an `unrecognised` bucket so a verdict added later surfaces
 * instead of being silently absorbed by whichever count it most resembles.
 */
function summarise(rows) {
    const known = new Set(Object.values(VERDICTS));
    const out = { total: rows.length, unrecognised: [] };
    for (const k of known) out[k] = 0;
    for (const row of rows) {
        if (known.has(row.verdict)) out[row.verdict]++;
        else out.unrecognised.push(row.verdict);
    }
    return out;
}

// `slugOf` is exported so the suite can BUILD a transcript directory the
// subject will actually find. The suite additionally pins the rule against
// literal strings, so using it here is a convenience rather than the assertion.
const slugOf = (cwd) => String(cwd).replace(/[/.:\\]/g, '-');

module.exports = {
    VERDICTS, STATES, LANDED, slugOf,
    boundariesCrossed, liveness, classify, rank, rankReason, summarise,
};

// ---------------------------------------------------------------------------
// I/O + CLI.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const JSON_OUT = has('json');
const RUN_VERIFY = !has('no-run-verify');
const ALL = has('all');
const INTENT_DIR = opt('intent-dir', path.join(HOME, 'claude-memory', 'fleet-intent'));
const STAMP = opt('stamp-file', path.join(HOME, '.claude', 'fleet-redispatch-last-run'));
const LIVE_FLOOR_MS = parseInt(opt('live-minutes', '30'), 10) * 60000;
const LOOKBACK_DAYS = parseInt(opt('lookback-days', '7'), 10);
const VERIFY_TIMEOUT_MS = parseInt(opt('verify-timeout-seconds', '300'), 10) * 1000;
const NOW = Date.now();

const USAGE = [
    'fleet-redispatch.js - at a session-limit reset boundary, rank the fleet work',
    'that is genuinely incomplete. It PROPOSES; it never spawns anything.',
    '',
    '  --intent-dir <path>        default ~/claude-memory/fleet-intent',
    '  --stamp-file <path>        default ~/.claude/fleet-redispatch-last-run',
    '  --all                      classify every record, ignoring the boundary gate',
    '  --boundaries               report the reset boundaries read, and stop',
    '  --no-run-verify            classify without executing any record\'s verify',
    '  --stamp                    advance the last-run stamp after this run',
    '  --json                     machine-readable',
    '  --live-minutes N           liveness floor, default 30',
    '  --lookback-days N          transcript file-scan window, default 7',
    '  --verify-timeout-seconds N default 300',
    '  --selftest',
    '',
    'Exit: 0 nothing to restart and nothing unreadable · 2 restart candidates',
    '      3 something COULD NOT BE CHECKED (outranks 2 - a silent unreadable is',
    '        the failure this tool exists to stop)',
].join('\n');

if (require.main === module) {
    if (has('help') || has('h')) { console.log(USAGE); process.exitCode = 0; }
    else if (has('selftest')) selftest();
    else main();
}

function claudeProjects() {
    const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
    return path.join(cfg, 'projects');
}

// The transcript directory slug (defined with the exports above) is the cwd
// with '/', '.', ':' and '\' each replaced by '-'. The colon and backslash are
// not decoration: a Windows path contains neither a forward slash nor a dot, so
// a narrower pattern returns it unchanged and every lookup silently misses.

/**
 * Every recorded reset boundary, read from the transcripts.
 *
 * The file scan is narrowed by mtime, and that narrowing is safe by
 * construction rather than by luck: a wall row is written at the moment of the
 * wall, so a file holding one from the last N days cannot have an mtime older
 * than it. Returns null - not [] - when the projects directory cannot be read.
 */
function readBoundaries() {
    const root = claudeProjects();
    let dirs;
    try { dirs = fs.readdirSync(root); } catch { return null; }
    const floor = NOW - LOOKBACK_DAYS * 86400000;
    const events = [];
    let filesRead = 0, filesSkipped = 0, unreadable = 0;
    for (const d of dirs) {
        let names;
        try { names = fs.readdirSync(path.join(root, d)); } catch { unreadable++; continue; }
        for (const n of names) {
            if (!n.endsWith('.jsonl')) continue;
            const f = path.join(root, d, n);
            let st;
            try { st = fs.statSync(f); } catch { unreadable++; continue; }
            if (st.mtimeMs < floor) { filesSkipped++; continue; }
            let text;
            try { text = fs.readFileSync(f, 'utf8'); } catch { unreadable++; continue; }
            filesRead++;
            for (const line of text.split('\n')) {
                // Cheap substring gate before the parse: these files run to
                // tens of megabytes and almost no line carries the key.
                if (line.indexOf('"resetsAt"') === -1) continue;
                let row;
                try { row = JSON.parse(line); } catch { continue; }
                const q = row && row.quotaLimits;
                if (!q || !Number.isFinite(q.resetsAt)) continue;
                events.push({
                    resetsAtMs: q.resetsAt * 1000,
                    rateLimitType: q.rateLimitType || null,
                    status: q.status || null,
                    sessionId: row.sessionId || null,
                    cwd: row.cwd || null,
                    branch: row.gitBranch || null,
                    at: row.timestamp || null,
                });
            }
        }
    }
    events.__scan = { filesRead, filesSkipped, unreadable, lookbackDays: LOOKBACK_DAYS };
    return events;
}

/** The desktop session store, indexed by repo-relative branch. */
function readSessionStore() {
    const root = sessionStore();
    if (!root) return null;
    const out = [];
    const walk = (d, depth) => {
        if (depth > 4) return;
        let names;
        try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const ent of names) {
            const q = path.join(d, ent.name);
            if (ent.isDirectory()) walk(q, depth + 1);
            else if (ent.name.endsWith('.json')) {
                try { out.push(JSON.parse(fs.readFileSync(q, 'utf8'))); } catch { /* one bad record is not a bad store */ }
            }
        }
    };
    walk(root, 0);
    return out;
}

/**
 * On macOS `/var` and `/private/var` are the same directory, so `git worktree
 * list` and the cwd the app recorded can name one directory with two different
 * strings - and a slug built from the wrong spelling misses every transcript.
 * `[measured 2026-09-08]` this suite's first end-to-end run hit exactly that:
 * the worktree resolved to `/private/var/...`, the transcript directory was
 * keyed `-var-...`, and the tool reported the session's liveness as unreadable.
 * Both spellings are tried rather than one being declared canonical.
 */
function realish(p) {
    try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * The OS's own canonical spelling. This is NOT the same resolver as `realish`:
 * `fs.realpathSync` is Node's JS implementation and resolves symlinks only,
 * while `.native` goes through the platform call and additionally expands a
 * Windows 8.3 short name to its long form. `[measured 2026-09-11]` on the
 * Windows CI runner `os.tmpdir()` is the SHORT spelling and `git worktree
 * list` reports the LONG one, and only the native resolver reconciles them.
 * Returns null rather than the input when it cannot answer, so a caller can
 * tell a canonical spelling from a guess.
 */
function realNative(p) {
    try {
        const r = fs.realpathSync.native(p);
        // The Win32 extended-length prefix names the same file; libuv usually
        // strips it, and comparing one spelling with it against one without is
        // exactly the bug this function exists to close.
        return typeof r === 'string' && r.startsWith('\\\\?\\') ? r.slice(4) : r;
    } catch { return null; }
}

/**
 * Every spelling one directory can have here. Both resolvers only go ONE way -
 * given `/private/var/x` neither returns `/var/x`, and given a long Windows
 * path neither returns the 8.3 short form - so a transcript directory keyed on
 * the other spelling stays unreachable. The `/private` prefix is therefore
 * added and removed explicitly, and both resolvers are consulted rather than
 * one being declared canonical.
 *
 * This enumerates what CAN be derived, which is not the same as everything the
 * app might have written. `newestTranscript` below does not rely on it alone
 * for that reason.
 */
function pathSpellings(p) {
    const out = [];
    for (const c of [p, realish(p), realNative(p)]) {
        if (!c) continue;
        out.push(c);
        if (c.startsWith('/private/')) out.push(c.slice('/private'.length));
        else if (c.startsWith('/')) out.push('/private' + c);
    }
    return [...new Set(out)];
}

/**
 * Do two strings name one directory? Every derivable spelling of each is
 * compared, so a symlinked parent on macOS and an 8.3 short name on Windows
 * both reconcile. The comparison is case-insensitive on win32 only, where the
 * filesystem is.
 */
function samePath(a, b) {
    if (!a || !b) return false;
    const norm = (q) => {
        const r = path.resolve(q);
        return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const seen = new Set(pathSpellings(a).map(norm));
    return pathSpellings(b).map(norm).some((q) => seen.has(q));
}

/** Every .jsonl in one transcript directory, with its mtime. */
function transcriptsIn(dir) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
    const out = [];
    for (const n of names) {
        try { out.push({ file: path.join(dir, n), mtimeMs: fs.statSync(path.join(dir, n)).mtimeMs }); } catch { /* skip */ }
    }
    return out;
}

/**
 * The cwd a transcript says it was written under. Every row carries it, so the
 * first readable one answers; only the head of the file is read because these
 * run to tens of megabytes.
 */
function recordedCwd(file) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(64 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        for (const line of buf.toString('utf8', 0, n).split('\n')) {
            if (!line || line.indexOf('"cwd"') === -1) continue;
            // A truncated final line is expected - the read is a fixed window.
            try { const row = JSON.parse(line); if (row && row.cwd) return row.cwd; } catch { continue; }
        }
    } catch { /* unreadable */ } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    return null;
}

/**
 * The newest transcript for `cwd`, or null.
 *
 * THE TRAP THIS CLOSES. A transcript directory's NAME is the slug of whichever
 * spelling of the cwd the app happened to record, which makes it a lossy index
 * keyed on a choice this tool did not make. Both realpath resolvers collapse
 * spellings in ONE direction only, so when the caller holds a different one -
 * `/var` against `/private/var`, an 8.3 short name against its long form, a
 * symlinked parent against its target - no amount of deriving gets back to the
 * name on disk, and the lookup returns nothing. Nothing distinguishes that from
 * a session with no transcript, so liveness reads `null`, and because liveness
 * is decided before the verify, the verify never runs either: one missed lookup
 * turns into COULD-NOT-CHECK for every record.
 *
 * `[measured 2026-09-11]` that is the whole of PR #218's Windows-only failure.
 * The fixture builds its paths from `os.tmpdir()`, which is the short spelling;
 * `git worktree list` reports the long one; 11 assertions went red, including
 * every positive control, all of them downstream of this one lookup. The same
 * shape reproduces on macOS through a symlinked parent, which is how it is
 * tested on every platform rather than only on the one that showed it.
 *
 * So the slug is a FAST PATH and the cwd RECORDED INSIDE the transcript is the
 * authority. The fallback narrows candidates by the slug of the basename - a
 * cheap filter that decides nothing - and then compares the recorded cwd.
 */
function newestTranscript(cwd) {
    if (!cwd) return null;
    let newest = null;
    const take = (t) => { if (t && (!newest || t.mtimeMs > newest.mtimeMs)) newest = t; };
    const root = claudeProjects();

    for (const cand of pathSpellings(cwd)) {
        for (const t of transcriptsIn(path.join(root, slugOf(cand)))) take(t);
    }
    if (newest) return newest;

    const tail = slugOf(path.basename(cwd));
    let dirs;
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
    for (const ent of dirs) {
        if (!ent.isDirectory() || !tail || !ent.name.endsWith(tail)) continue;
        const found = transcriptsIn(path.join(root, ent.name));
        if (!found.length) continue;
        found.sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (samePath(recordedCwd(found[0].file), cwd)) take(found[0]);
    }
    return newest;
}

/**
 * Is the last substantive row of this transcript the rate_limit wall?
 *
 * Only the tail is read; these files are large and the question is about the
 * end of one. Rows the app writes after a wall without the session running -
 * a summary, a hook record - would make a walled session look resumed, so the
 * scan looks at the last assistant/user rows rather than the very last line.
 */
function endsInWall(file) {
    let text;
    try {
        const st = fs.statSync(file);
        const size = 512 * 1024;
        const fd = fs.openSync(file, 'r');
        const start = Math.max(0, st.size - size);
        const buf = Buffer.alloc(Math.min(size, st.size));
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        text = buf.toString('utf8');
    } catch { return null; }
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        let row;
        try { row = JSON.parse(lines[i]); } catch { continue; }
        if (row.type !== 'assistant' && row.type !== 'user') continue;
        return row.error === 'rate_limit' && row.isApiErrorMessage === true;
    }
    return null;
}

/** The worktree checked out on `branch` inside `repoRoot`, or null. */
function worktreeFor(repoRoot, branch) {
    let out;
    try {
        out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
            cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch { return null; }
    let cur = null;
    for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) cur = line.slice(9).trim();
        else if (line.startsWith('branch ') && cur) {
            const b = line.slice(7).trim().replace(/^refs\/heads\//, '');
            if (b === branch) return cur;
        }
    }
    return null;
}

function readRecords(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (err) {
        return { dirReadable: false, why: err && err.code === 'ENOENT'
            ? `${dir} does not exist`
            : `${dir} could not be read (${(err && err.code) || 'unknown'})`, records: [] };
    }
    const records = [];
    for (const n of names.filter((n) => n.endsWith('.json')).sort()) {
        const f = path.join(dir, n);
        try {
            const o = JSON.parse(fs.readFileSync(f, 'utf8'));
            records.push({ file: n, record: o });
        } catch (err) {
            records.push({ file: n, record: { __unreadable: `${n} did not parse as JSON (${(err && err.message || '').split('\n')[0]})` } });
        }
    }
    return { dirReadable: true, records };
}

function landedVerdict(repoRoot, branch) {
    const script = path.join(__dirname, 'check-branch-landed.js');
    if (!fs.existsSync(script) || !repoRoot) return null;
    const res = spawnSync(process.execPath, [script, '--repo', repoRoot, '--json', branch], {
        encoding: 'utf8', timeout: 120000,
    });
    // A killed child, a crash, or unparseable output are all "not asked", never
    // "not landed" - the verdict feeds a decision to skip work, so its absence
    // must not read as permission to restart.
    if (res.error || res.signal || typeof res.stdout !== 'string') return null;
    try {
        const o = JSON.parse(res.stdout);
        const row = (o.rows || []).find((x) => x.branch === branch);
        return row ? row.verdict : null;
    } catch { return null; }
}

function runVerify(record, cwd) {
    if (!record.verify || !String(record.verify).trim()) return { verify: 'absent' };
    if (!RUN_VERIFY) return { verify: 'unrunnable', verifyWhy: '--no-run-verify was passed, so nothing was executed' };
    if (!cwd) return { verify: 'unrunnable', verifyWhy: `no worktree is checked out on ${record.branch}, so its verify has nowhere to run` };
    const res = spawnSync(record.verify, {
        cwd, shell: true, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error && res.error.code === 'ETIMEDOUT') {
        return { verify: 'timeout', verifyWhy: `killed after ${VERIFY_TIMEOUT_MS / 1000}s` };
    }
    if (res.signal) return { verify: 'timeout', verifyWhy: `killed by ${res.signal}` };
    if (res.error) return { verify: 'unrunnable', verifyWhy: String(res.error.message).split('\n')[0] };
    if (!Number.isFinite(res.status)) return { verify: 'unrunnable', verifyWhy: 'the command produced no exit status' };
    const tail = String(res.stderr || res.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
    return { verify: { code: res.status }, verifyWhy: tail.slice(0, 160) };
}

function readStamp() {
    try {
        const t = Date.parse(fs.readFileSync(STAMP, 'utf8').trim());
        return Number.isFinite(t) ? t : null;
    } catch { return null; }
}

function writeStamp() {
    try {
        fs.mkdirSync(path.dirname(STAMP), { recursive: true });
        fs.writeFileSync(STAMP, new Date(NOW).toISOString() + '\n');
        return true;
    } catch { return false; }
}

function main() {
    const notes = [];   // COULD-NOT-CHECK lines that are about the RUN, not a record.

    // ---- the boundary -----------------------------------------------------
    const events = readBoundaries();
    const scan = (events && events.__scan) || null;
    const since = readStamp();
    const gate = boundariesCrossed(events, since, NOW);
    if (!gate.readable) notes.push(`the reset boundary could not be read: ${gate.reason}`);

    if (has('boundaries')) {
        reportBoundaries(gate, events, scan, since);
        return;
    }

    const gated = !ALL && gate.readable && !gate.ungated;
    if (gated && gate.crossed.length === 0) {
        const line = `NO RESET BOUNDARY crossed since ${new Date(since).toISOString()} (${gate.seen} five-hour boundaries recorded in the last ${LOOKBACK_DAYS} days; ${scan ? scan.filesRead : '?'} transcripts read). Nothing re-dispatched.`;
        if (JSON_OUT) process.stdout.write(JSON.stringify({ boundary: gate, acted: false, note: line }, null, 2) + '\n');
        else console.log(line);
        if (has('stamp')) writeStamp();
        process.exitCode = 0;
        return;
    }

    // ---- the records ------------------------------------------------------
    const read = readRecords(INTENT_DIR);
    if (!read.dirReadable) {
        // An absent directory is emphatically NOT "zero records": it means no
        // session has written one. Reporting it as a clean zero is the exact
        // shape this tool exists to refuse.
        const line = [
            `COULD NOT CHECK: ${read.why}.`,
            'That is not zero records to re-dispatch - it means no intent record has been written yet',
            '(the checkpoint writer has not landed, or no session has checkpointed).',
        ].join(' ');
        if (JSON_OUT) process.stdout.write(JSON.stringify({ boundary: gate, records: null, couldNotCheck: [line] }, null, 2) + '\n');
        else { reportBoundaries(gate, events, scan, since); console.log('\n' + line); }
        process.exitCode = 3;
        return;
    }

    const store = readSessionStore();
    if (store === null) notes.push('the desktop session store could not be located, so liveness rests on transcripts alone');
    const code = codeDir();
    if (!code) notes.push('no checkout directory could be resolved, so no verify could be run and no branch could be asked whether it landed');

    const rows = [];
    for (const { file, record } of read.records) {
        if (record.__unreadable) {
            rows.push({ file, record, ...classify(record, {}) });
            continue;
        }
        const repoRoot = code ? path.join(code, record.repo) : null;
        const repoOk = repoRoot && fs.existsSync(repoRoot);
        const wt = repoOk ? worktreeFor(repoRoot, record.branch) : null;

        // liveness evidence
        const storeRow = store && store.find((s) => s && !s.isArchived && s.branch === record.branch
            && (!wt || !s.cwd || samePath(s.cwd, wt)));
        const tr = newestTranscript(wt || (storeRow && storeRow.cwd));
        const ev = {
            pingAgeMs: storeRow && Number.isFinite(storeRow.lastActivityAt) ? NOW - storeRow.lastActivityAt : null,
            transcriptAgeMs: tr ? NOW - tr.mtimeMs : null,
            walled: tr ? endsInWall(tr.file) : null,
        };
        const live = liveness(ev, LIVE_FLOOR_MS);

        let evidence = { live: live.live, liveWhy: live.why };
        if (live.live === false) {
            evidence.landed = repoOk ? landedVerdict(repoRoot, record.branch) : null;
            if (!evidence.landed || !LANDED.has(evidence.landed)) {
                Object.assign(evidence, repoOk
                    ? runVerify(record, wt)
                    : { verify: 'unrunnable', verifyWhy: `no checkout for repo "${record.repo}" under ${code || '(unresolved)'}` });
            }
        }
        rows.push({ file, record, evidence, ...classify(record, evidence) });
    }

    report(rows, gate, events, scan, since, read, notes);
    if (has('stamp')) writeStamp();

    const sum = summarise(rows);
    const unreadable = sum[VERDICTS.COULD_NOT_CHECK] + (notes.length ? 1 : 0) + sum.unrecognised.length;
    if (unreadable > 0) process.exitCode = 3;
    else if (sum[VERDICTS.RESTART] > 0) process.exitCode = 2;
    else process.exitCode = 0;
}

function reportBoundaries(gate, events, scan, since) {
    if (JSON_OUT) { process.stdout.write(JSON.stringify({ gate, scan, since: since ? new Date(since).toISOString() : null }, null, 2) + '\n'); return; }
    console.log('RESET BOUNDARIES');
    if (!gate.readable) { console.log(`  COULD NOT CHECK: ${gate.reason}`); return; }
    const five = (events || []).filter((e) => e.rateLimitType === 'five_hour');
    const other = (events || []).length - five.length;
    console.log(`  scanned ${scan ? scan.filesRead : '?'} transcripts modified in the last ${scan ? scan.lookbackDays : LOOKBACK_DAYS} days (${scan ? scan.filesSkipped : '?'} older ones skipped, ${scan ? scan.unreadable : '?'} unreadable)`);
    console.log(`  ${five.length} five-hour wall rows, ${other} rows of another rate-limit type`);
    console.log(`  last run: ${since ? new Date(since).toISOString() : 'NOT RECORDED - this run is ungated'}`);
    const uniq = [...new Set(five.map((e) => e.resetsAtMs))].sort((a, b) => b - a).slice(0, 5);
    for (const t of uniq) {
        const n = five.filter((e) => e.resetsAtMs === t).length;
        const sessions = new Set(five.filter((e) => e.resetsAtMs === t).map((e) => e.cwd)).size;
        const when = t <= NOW ? 'passed' : 'upcoming';
        console.log(`    resets ${new Date(t).toISOString()}  ${when}  (${n} rows across ${sessions} worktrees)`);
    }
    if (gate.ungated) console.log(`  UNGATED: ${gate.reason}`);
    else console.log(`  boundaries crossed since the last run: ${gate.crossed.length}`);
}

function report(rows, gate, events, scan, since, read, notes) {
    const sum = summarise(rows);
    const restarts = rank(rows.filter((r) => r.verdict === VERDICTS.RESTART));

    if (JSON_OUT) {
        process.stdout.write(JSON.stringify({
            boundary: gate,
            population: { records: sum.total, intentDir: INTENT_DIR },
            summary: sum,
            runNotes: notes,
            ranked: restarts.map((r, i) => ({ order: i + 1, file: r.file, repo: r.record.repo, branch: r.record.branch, reason: r.reason, rankReason: rankReason(r), record: r.record })),
            rows: rows.map((r) => ({ file: r.file, verdict: r.verdict, reason: r.reason, repo: r.record.repo || null, branch: r.record.branch || null })),
        }, null, 2) + '\n');
        return;
    }

    reportBoundaries(gate, events, scan, since);
    console.log('');
    console.log(`POPULATION: ${sum.total} intent record${sum.total === 1 ? '' : 's'} in ${INTENT_DIR}.`);
    console.log(`  ${sum[VERDICTS.RESTART]} of ${sum.total} to restart · ${sum[VERDICTS.SKIP_LIVE]} live · ${sum[VERDICTS.SKIP_LANDED]} already landed · ${sum[VERDICTS.SKIP_VERIFIED]} verified done · ${sum[VERDICTS.BLOCKED]} blocked on a human · ${sum[VERDICTS.COULD_NOT_CHECK]} COULD NOT CHECK`);
    if (sum.unrecognised.length) console.log(`  ⚠ ${sum.unrecognised.length} unrecognised verdict(s): ${[...new Set(sum.unrecognised)].join(', ')}`);

    if (restarts.length) {
        console.log('\nPROPOSED, IN ORDER. Nothing here has been started; the coordinator dispatches.');
        restarts.forEach((r, i) => {
            const rec = r.record;
            console.log(`\n  ${i + 1}. ${rec.repo} @ ${rec.branch}`);
            console.log(`     why now : ${r.reason}`);
            console.log(`     rank    : ${rankReason(r)}`);
            if (rec.brief) console.log(`     brief   : ${String(rec.brief).split('\n')[0].slice(0, 160)}`);
            if (rec.next_step) console.log(`     next    : ${String(rec.next_step).split('\n')[0].slice(0, 160)}`);
            if (rec.verify) console.log(`     verify  : ${String(rec.verify).slice(0, 160)}`);
        });
    } else {
        console.log('\nNothing to restart. That is a measured zero over the population above, not an empty scan.');
    }

    const skipped = rows.filter((r) => r.verdict !== VERDICTS.RESTART && r.verdict !== VERDICTS.COULD_NOT_CHECK);
    if (skipped.length) {
        console.log('\nNOT RESTARTED');
        for (const r of skipped) console.log(`  ${r.verdict.padEnd(14)} ${r.record.repo} @ ${r.record.branch} - ${r.reason}`);
    }

    const cnc = rows.filter((r) => r.verdict === VERDICTS.COULD_NOT_CHECK);
    if (cnc.length || notes.length) {
        console.log('\nCOULD NOT CHECK - counted separately from "nothing to do"');
        for (const r of cnc) console.log(`  ${r.record.repo ? `${r.record.repo} @ ${r.record.branch}` : r.file} - ${r.reason}`);
        for (const n of notes) console.log(`  (run) ${n}`);
    }
}

// ---------------------------------------------------------------------------
// Selftest. Drives the pure layer only - it plants evidence rather than a
// fleet, so it is the same assertion on every machine.
// ---------------------------------------------------------------------------
function selftest() {
    let pass = 0, fail = 0;
    const t = (label, ok) => { if (ok) { pass++; console.log('PASS  ' + label); } else { fail++; console.log('FAIL  ' + label); } };
    const rec = { repo: 'r', branch: 'b', state: 'checkpointed', verify: 'x' };

    t('a live session is never a restart candidate',
        classify(rec, { live: true }).verdict === VERDICTS.SKIP_LIVE);
    t('unknown liveness is COULD-NOT-CHECK, never RESTART',
        classify(rec, { live: null, verify: { code: 1 } }).verdict === VERDICTS.COULD_NOT_CHECK);
    t('a landed branch is skipped even when the record says working',
        classify({ ...rec, state: 'working' }, { live: false, landed: 'LANDED-SQUASH' }).verdict === VERDICTS.SKIP_LANDED);
    t('an UNKNOWN landed verdict is not landed',
        classify(rec, { live: false, landed: 'UNKNOWN', verify: { code: 1 } }).verdict === VERDICTS.RESTART);
    t('verify passing beats a record that says working',
        classify({ ...rec, state: 'working' }, { live: false, verify: { code: 0 } }).verdict === VERDICTS.SKIP_VERIFIED);
    t('a verify timeout is not a failure',
        classify(rec, { live: false, verify: 'timeout' }).verdict === VERDICTS.COULD_NOT_CHECK);
    t('a missing verify cannot be re-checked',
        classify(rec, { live: false, verify: 'absent' }).verdict === VERDICTS.COULD_NOT_CHECK);
    t('blocked work is remaining but not restartable',
        classify({ ...rec, state: 'blocked' }, { live: false, verify: { code: 1 } }).verdict === VERDICTS.BLOCKED);
    t('unreadable transcripts are not "no boundary"',
        boundariesCrossed(null, 0, 1).readable === false);
    t('no stamp means ungated, not "since forever"',
        boundariesCrossed([], null, 1).ungated === true);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
}
