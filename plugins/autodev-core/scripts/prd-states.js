'use strict';
/**
 * The `passes` field has FIVE states, not four, and one of them was undocumented.
 *
 * `[measured 2026-08-28]` a session found `auto` sweeping blocked stories back
 * into its work queue. The cause was wider than the report: `auto/SKILL.md`
 * instructs sessions to write `passes: "needs-setup"` for work blocked on an API
 * key, a vendor, or a console nobody has opened — and NOTHING ELSE IN THE PLUGIN
 * KNEW THAT STATE EXISTED. Five readers each guessed differently:
 *
 *   auto's work selector      selected it        -> re-attempted forever
 *   auto's status line        counted it neither -> invisible in the sprint count
 *   auto's archive keep-list  omitted it         -> DROPPED on archive
 *   stop-auto-check.js        counted it pending -> blocked the turn forever
 *   session-start / drift-audit / memory-session-end   same as above
 *
 * The worst of those is the Stop hook: it blocks the end of a turn while pending
 * work remains, so a story waiting on the OPERATOR made the session unable to
 * finish. `deferred` was given its own state for exactly this reason in an
 * earlier incident; `needs-setup` repeated it.
 *
 * THE DISTINCTION THAT MATTERS. "Remaining work" is not one question, it is two:
 *
 *   Can an agent pick this up right now?   -> null, false          (yes)
 *   Is a human still on the hook for it?   -> null, false, needs-setup
 *
 * `deferred` answers no to both. `needs-setup` answers NO to the first and YES to
 * the second, and every bug above came from a reader that only had one predicate.
 *
 * autodev-memory cannot require this file — `${CLAUDE_PLUGIN_ROOT}` resolves per
 * plugin, so a cross-plugin path cannot work and each plugin ships what it needs.
 * Its copy is marked as a deliberate duplicate rather than left to drift silently.
 */

const DONE = true;
const PENDING = null;
const FAILED = false;
const DEFERRED = 'deferred';
const NEEDS_SETUP = 'needs-setup';

/** Every value `passes` may legitimately hold. */
const VALID = [DONE, PENDING, FAILED, DEFERRED, NEEDS_SETUP];

/**
 * Work an AGENT can pick up now.
 *
 * Excludes needs-setup: an agent cannot conjure an API key, and re-attempting is
 * how a blocked story burns a turn every run. Excludes deferred: a decision not
 * to do it. This is the predicate `auto` and the Stop hook want.
 */
function isActionable(story) {
    if (!story) return false;
    const p = story.passes;
    // undefined counts as pending: a story authored without the key is work
    // nobody started, not a story that does not exist to the tooling.
    return p === PENDING || p === undefined || p === FAILED;
}

/**
 * Work a HUMAN is still on the hook for.
 *
 * Includes needs-setup, because someone must supply the key before it can move.
 * A status line that omits it tells the operator a sprint is finished when it is
 * waiting on him. This is the predicate reports and dashboards want.
 */
function isOutstanding(story) {
    if (!story) return false;
    const p = story.passes;
    return p === PENDING || p === undefined || p === FAILED || p === NEEDS_SETUP;
}

/** A decision NOT to do the work. Never remaining, never outstanding. */
function isDeferred(story) {
    return !!story && story.passes === DEFERRED;
}

function isDone(story) {
    return !!story && story.passes === DONE;
}

/** Blocked on a person or an external system, not on engineering time. */
function needsSetup(story) {
    return !!story && story.passes === NEEDS_SETUP;
}

/**
 * Safe to remove when archiving.
 *
 * ONLY completed work. needs-setup was missing from the keep-list, so archiving
 * deleted stories that were waiting on the operator — losing the record of what
 * he still owed. An unrecognised value is KEPT, not dropped: this runs against
 * files written by future versions of the schema, and deleting something you do
 * not understand is the one irreversible outcome here.
 */
function isArchivable(story) {
    return isDone(story);
}

/** Counts for a status line, covering every state so nothing goes missing. */
function summarise(stories) {
    const all = Array.isArray(stories) ? stories : Object.values(stories || {});
    const counts = {
        done: 0, pending: 0, failed: 0, deferred: 0, needsSetup: 0, unrecognised: 0,
    };
    for (const s of all) {
        const p = s && s.passes;
        if (p === DONE) counts.done++;
        else if (p === PENDING || p === undefined) counts.pending++;
        else if (p === FAILED) counts.failed++;
        else if (p === DEFERRED) counts.deferred++;
        else if (p === NEEDS_SETUP) counts.needsSetup++;
        // An unknown value is COUNTED and named, never folded into a neighbour.
        // Silently bucketing it is how needs-setup stayed invisible for so long.
        else counts.unrecognised++;
    }
    counts.total = all.length;
    counts.actionable = all.filter(isActionable).length;
    counts.outstanding = all.filter(isOutstanding).length;
    return counts;
}

module.exports = {
    DONE, PENDING, FAILED, DEFERRED, NEEDS_SETUP, VALID,
    isActionable, isOutstanding, isDeferred, isDone, needsSetup, isArchivable,
    summarise,
};
