#!/usr/bin/env node
/**
 * fleet-stop-watch.js — ONE fleet-wide watch that emits one line per transition:
 * SESSION STOPPED when a session goes quiet, SESSION RESUMED when it writes again.
 *
 * WHY IT EXISTS. The per-dispatch idle notice (`SendMessage notify_when_idle`)
 * only covers a session you just dispatched. A session nobody just handed work to
 * goes dark in silence, and `[stated 2026-08-28]` the operator noticed a sleeping
 * fleet before the Brain did: *"you should know the instance they stop."* One
 * watch replaces N subscriptions, costs the watched sessions nothing (a stat(),
 * not a message), and cannot loop the way a re-arm-on-notice rule does.
 *
 * Every Brain boot was rewriting this by hand as a scratch script, which is why
 * it is here rather than in a transcript.
 *
 *   node fleet-stop-watch.js                      # poll forever, 60s
 *   node fleet-stop-watch.js --once               # one scan, then exit
 *   node fleet-stop-watch.js --quiet-minutes 5    # how long is "stopped"
 *   node fleet-stop-watch.js --interval 30        # seconds between scans
 *   node fleet-stop-watch.js --self <cliSessionId>
 *
 * Always exits 0. This is a report, never a gate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT READS, AND THE THREE SIGNALS IT REFUSES
 *
 * TRANSCRIPT MTIME, under ~/.claude/projects/<slug>/<cliSessionId>.jsonl.
 *
 *   NOT `lastActivityAt` from the desktop session record. That field is
 *   refreshed only by the app while it holds the session, so a session running
 *   outside that workspace FREEZES it rather than updating it. `[measured
 *   2026-08-28]` two records showed nine days idle while their transcripts had
 *   been written three minutes earlier. A watch on that field reports a working
 *   fleet as dead.
 *
 *   NOT `isRunning`. It is runtime-only and costs one MCP call per session, so
 *   it scales with the fleet and cannot run on a one-minute timer.
 *
 *   NOT `find -newermt '-30 minutes'`. `[measured 2026-08-29]` on this macOS the
 *   `find` on PATH is bfs, which REJECTS that relative form outright — and the
 *   probe that "confirmed" it silently returns zero was itself wrong: piping
 *   `2>&1` into `wc -l` counted ten lines of error text as ten matching files.
 *   `-mmin -30` and an absolute `-newermt` both returned the right 16. The
 *   lesson that survives is why this file uses fs.statSync and shells out to
 *   nothing: a time predicate that varies by find implementation is a portable
 *   way to report an empty fleet.
 *
 * SUBAGENT TRANSCRIPTS COUNT AS ACTIVITY. `<slug>/<cliSessionId>/subagents/`.
 * This is not tidiness, it is the difference between the watch working and the
 * watch lying. `[measured 2026-08-29]` across the 8 sessions on this machine
 * with subagent transcripts, 7 parent-transcript gaps longer than three minutes
 * had subagents writing inside the quiet window — the worst was 17.5 minutes
 * with 320 subagent writes. A parent-mtime-only watch would have announced that
 * session STOPPED while it was mid-fan-out, and an announcement that is wrong
 * about the busiest sessions is how a channel gets muted.
 *
 * WHAT "STOPPED" MEANS, EXACTLY. Quiet — not finished, and not dead. `[measured
 * 2026-08-29]` over 23 transcripts active in a six-hour window, 1.06% of the
 * 15,808 intra-session write gaps exceeded three minutes. Most of those are real
 * rests between turns, which is the thing worth reporting; some are one long
 * tool call. Proving a turn ENDED needs the Stop-hook heartbeat
 * (fleet-heartbeat.js), which this deliberately does not read: it would trade
 * the property that makes this cheap enough to run every minute for a
 * distinction the operator did not ask for. If a STOPPED is followed by a
 * RESUMED four minutes later, that pair is the honest output, not a bug.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY: cliSessionId, NEVER the title
 *
 * The brief for this script said to key on title with a trailing "[branch]"
 * stripped, because a rebasing session flapped GONE/APPEARED on every checkout.
 * The flap was real; the diagnosis was not. `[measured 2026-08-29]` against the
 * 49 records in the live store, ZERO titles carry a trailing "[branch]" — the
 * branch is appended by fleet-status.js's TEXT renderer
 * (`name + '  [' + gitBranch + ']'`), so the scratch version was keying on a
 * rendered display string and the branch it contained changed under it.
 *
 * And titles are not unique. In that same store, two live non-archived sessions
 * in DIFFERENT worktrees carried byte-identical titles — unremarkable, since a
 * title describes the task and one task is often split across worktrees.
 * Title-keying merges them into one watched entity, so one of them can stop and
 * this watch stays quiet — the exact failure it exists to prevent.
 *
 * cliSessionId is the transcript's own filename: unique, and unchanged by any
 * checkout. The title is carried for display only, and re-read from the store so
 * a renamed session is not reported under a stale name.
 *
 * SELF-EXCLUSION IS ARMED FROM THE ENVIRONMENT. A watch that reports the
 * overseer's own session wakes it, and the wake writes a transcript line, which
 * is a self-loop with a one-minute period. This was a known defect of the
 * scratch version, documented in brain/SKILL.md and implemented nowhere.
 * `[measured 2026-08-29]` `CLAUDE_CODE_SESSION_ID` in a live session equals its
 * own transcript's basename exactly, so the exclusion arms itself with no flag
 * and cannot be forgotten. `--self` and AUTODEV_SELF_SESSION override it.
 * Unlike watch-panels.js, this one must NOT fail open: a missed ping there costs
 * one notice, whereas failing open here costs a permanent loop. When no self can
 * be identified at all it says so once, in place of failing silently.
 *
 * NO PERSISTED STATE, and that is a deliberate difference from watch-panels.js.
 * That watcher persists because its events are one-shot facts — a panel it
 * forgets is a panel re-raised after every restart. This watcher's entire state
 * is re-derivable from mtimes at any instant, so a fresh silent baseline on
 * start is correct rather than lossy, and it is what keeps arming quiet over an
 * already-sleeping fleet. Persisting it would instead announce "STOPPED" for
 * everything that was running when the previous process died, which at a Brain
 * boot is a screen of three-day-old news. Do not "fix" this to match its sibling.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const ROOT = path.join(HOME, '.claude', 'projects');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ONCE = has('--once');
// Both are read as numbers and validated, because a typo'd `--quiet-minutes x`
// becoming NaN makes every comparison false, and a watch that classifies
// nothing as quiet is silent in exactly the way a healthy one is.
const num = (flag, dflt, min) => {
    const n = Number(val(flag, dflt));
    return Number.isFinite(n) && n >= min ? n : dflt;
};
const QUIET_MS = num('--quiet-minutes', 3, 0.05) * 60_000;
const INTERVAL_MS = num('--interval', 60, 1) * 1000;

// --self > AUTODEV_SELF_SESSION > the live session's own id. See the header.
const selfIdx = argv.indexOf('--self');
const SELF = (selfIdx !== -1 && argv[selfIdx + 1])
    || process.env.AUTODEV_SELF_SESSION
    || process.env.CLAUDE_CODE_SESSION_ID
    || null;

/** cliSessionId -> { running, quietSince, lastActivity } . In memory on purpose. */
const state = new Map();

let indexCache = null;
let indexLoadedAt = 0;
const INDEX_TTL_MS = 300_000;   // titles change when a session is renamed

/**
 * Titles, from the ONE loader that already exists. fleet-status.js resolves the
 * desktop store through claude-paths.js and carries the measurements behind that
 * resolution; a second copy here is how the store path went wrong three times.
 * A missing sibling degrades to "no titles", never to a crash — this is a
 * reporter, and it can report a cliSessionId perfectly well without one.
 */
function titleIndex(force) {
    const now = Date.now();
    if (!force && indexCache && now - indexLoadedAt < INDEX_TTL_MS) return indexCache;
    try {
        const { loadSessionIndex } = require(path.join(__dirname, 'fleet-status.js'));
        indexCache = loadSessionIndex();
    } catch {
        indexCache = indexCache || new Map();
    }
    indexLoadedAt = now;
    return indexCache;
}

/**
 * Newest mtime anywhere under a session's subagent tree, or 0.
 *
 * Bounded depth because subagents nest, and an unbounded walk under a directory
 * this script does not own is how a one-minute timer becomes a disk scan.
 */
function newestUnder(dir, depth) {
    let newest = 0;
    if (depth > 4) return newest;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return newest; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            const n = newestUnder(p, depth + 1);
            if (n > newest) newest = n;
            continue;
        }
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        try {
            const m = fs.statSync(p).mtimeMs;
            if (m > newest) newest = m;
        } catch { /* a file that vanished mid-scan is not an activity signal */ }
    }
    return newest;
}

/**
 * Every session on this machine, with the newest write anywhere that belongs to
 * it. No age window: a hard cutoff would make a session that resumes after the
 * window look like a brand-new one (silently baselined, so its next stop is the
 * first thing ever reported about it), and statting the whole tree is cheap —
 * `[measured 2026-08-29]` 236 files in 33 project directories on this machine.
 */
function collect() {
    const out = [];
    for (const dir of fs.readdirSync(ROOT)) {
        const d = path.join(ROOT, dir);
        let st;
        try { st = fs.statSync(d); } catch { continue; }
        if (!st.isDirectory()) continue;

        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
            const id = e.name.slice(0, -'.jsonl'.length);
            let mtime;
            try { mtime = fs.statSync(path.join(d, e.name)).mtimeMs; } catch { continue; }
            // An unreadable time is SKIPPED EXPLICITLY, never carried forward.
            // Every comparison below is `>=`, and `NaN >= x` is false, so a
            // non-finite mtime would classify as "not quiet" — an unrecognised
            // state falling through to the confident reading. A session whose
            // clock cannot be read is neither running nor stopped, so it is
            // dropped from the scan and its state left untouched.
            if (!Number.isFinite(mtime)) continue;
            // Its subagents, if it has any. See the 17.5-minute measurement.
            const sub = newestUnder(path.join(d, id), 0);
            out.push({ id, slug: dir, activity: Math.max(mtime, Number.isFinite(sub) ? sub : 0) });
        }
    }
    return out;
}

/**
 * Seconds below a minute, on purpose. Rounding to minutes printed "quiet 0m" for
 * every transition under a lowered --quiet-minutes, which reads as a bug in the
 * watch rather than as a short interval the reader chose.
 */
function human(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.round(ms / 60_000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

let consecutiveErrors = 0;
let announcedNoSelf = false;

function scan() {
    // Said once, and only when it is true. A watch whose self-exclusion is
    // disarmed will report the reader's own session and wake it every minute;
    // that must never be indistinguishable from a healthy quiet watch.
    if (!SELF && !announcedNoSelf) {
        announcedNoSelf = true;
        console.log('WATCHER-NOTE self-exclusion disarmed (no --self, AUTODEV_SELF_SESSION or CLAUDE_CODE_SESSION_ID); this watch may report the session reading it');
    }

    let sessions;
    try {
        sessions = collect();
        consecutiveErrors = 0;
    } catch (err) {
        consecutiveErrors++;
        // An empty result from a failed probe is a claim about the probe, not
        // about the fleet. Announce on a BOUNDED CADENCE rather than once: a
        // detector that shouts at failure 3 and never again looks healthy and
        // quiet while it scans nothing, which is the muted-watcher failure this
        // branch exists to prevent. Same cadence watch-panels.js settled on.
        if (consecutiveErrors === 3 || (consecutiveErrors > 3 && consecutiveErrors % 30 === 0)) {
            console.log('WATCHER-ERROR ' + consecutiveErrors + ' consecutive scans failed: ' + String(err && err.message).slice(0, 160));
        }
        return;
    }

    const now = Date.now();
    const seen = new Set();
    const unknown = sessions.some((s) => !state.has(s.id));
    const index = titleIndex(unknown);

    for (const s of sessions) {
        if (SELF && s.id === SELF) continue;
        seen.add(s.id);

        const quiet = (now - s.activity) >= QUIET_MS;
        const prev = state.get(s.id);

        if (!prev) {
            // FIRST SIGHT IS ALWAYS SILENT. Arming over an already-sleeping
            // fleet must emit nothing, and a session that appears mid-run is
            // not news either — its first TRANSITION is.
            state.set(s.id, { running: !quiet, quietSince: quiet ? s.activity : 0, lastActivity: s.activity });
            continue;
        }

        const rec = index.get(s.id);
        const name = (rec && rec.title) || s.slug.split('-').filter(Boolean).slice(-3).join('-') || s.id;
        const addr = (rec && rec.addressableId) || s.id;

        if (prev.running && quiet) {
            console.log('SESSION STOPPED  ' + name + '  quiet ' + human(now - s.activity) + '  :: ' + addr);
            state.set(s.id, { running: false, quietSince: s.activity, lastActivity: s.activity });
            continue;
        }
        if (!prev.running && !quiet) {
            const was = prev.quietSince ? human(s.activity - prev.quietSince) : 'unknown';
            console.log('SESSION RESUMED  ' + name + '  after ' + was + ' quiet  :: ' + addr);
            state.set(s.id, { running: true, quietSince: 0, lastActivity: s.activity });
            continue;
        }
        prev.lastActivity = s.activity;
    }

    // A transcript that disappeared (archived, deleted) is dropped WITHOUT a
    // line. GONE/APPEARED is what flapped in the scratch version and it is not
    // what was asked for: the only two events here are STOPPED and RESUMED.
    for (const id of [...state.keys()]) if (!seen.has(id)) state.delete(id);
}

function main() {
    // `[measured 2026-09-02]` --help fell through to the watch and never
    // returned (exit 143 under an 8s timeout). The usage block in the header
    // was the only documentation and nothing printed it.
    if (has('--help') || has('-h')) {
        console.log([
            'fleet-stop-watch.js - one line per transition: SESSION STOPPED / SESSION RESUMED',
            '',
            '  node fleet-stop-watch.js                      # poll forever, 60s',
            '  node fleet-stop-watch.js --once               # one scan, then exit',
            '  node fleet-stop-watch.js --quiet-minutes 5    # how long is "stopped" (default 3)',
            '  node fleet-stop-watch.js --interval 30        # seconds between scans (default 60)',
            '  node fleet-stop-watch.js --self <cliSessionId> # never report this session',
            '',
            'Reads transcript mtimes under ~/.claude/projects. Always exits 0; a report, not a gate.',
        ].join('\n'));
        return;
    }
    if (!fs.existsSync(ROOT)) {
        // Not silence. A watch pointed at a directory that is not there reports
        // a permanently quiet fleet, which is the confident-zero failure
        // claude-paths.js exists to stop.
        console.log('WATCHER-ERROR no transcript root at ' + ROOT);
        return;
    }
    scan();
    if (!ONCE) setInterval(scan, INTERVAL_MS);
}

if (require.main === module) main();
module.exports = { collect, newestUnder, human };
