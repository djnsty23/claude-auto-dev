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

/**
 * THE STORY CONTAINER, which is a second per-reader guess exactly like `passes`.
 *
 * prd.json has TWO shapes. Flat, `{ stories: {...} }`, and nested per sprint,
 * `{ sprints: [ { id, stories: {...} } ] }` — the nested one is documented
 * verbatim in auto/SKILL.md and sprint/SKILL.md already reads `p.sprints || []`,
 * so autodev's own tooling can produce a file its own hooks could not read.
 *
 * `[measured 2026-08-29]` five readers reached for `prd.stories` alone. The
 * costly one is the Stop hook: against a nested file it counted ZERO stories,
 * printed "Sprint complete" over a full sprint, and one turn later APPROVED the
 * stop and deleted .claude/auto-active. Auto mode terminated with every story
 * still pending, no error raised and no story named. Same stories in both runs;
 * only the container differed.
 *
 * That is the same defect as `passes`, one level up: a shape every reader
 * re-decided privately, so a reader could be wrong on its own without
 * disagreeing with anything. It is settled here once, and the semantics are
 * taken from check-spec-output.js, which already had it right — deliberately
 * NOT re-derived, because a sixth opinion is what this function exists to stop.
 *
 * EVERY SPRINT, NOT THE NEWEST — and this is a DECISION, taken against the
 * grain of the two readers that already existed.
 *
 * check-spec-output.js and core/SKILL.md both take the last sprint only
 * (`sprints[sprints.length - 1]`, `p.sprints.at(-1)`). Inheriting that here
 * would have shipped the original defect inside its own fix: on a two-sprint
 * file, every story still pending in sprint 1 becomes invisible, so the Stop
 * hook counts zero outstanding and approves the stop exactly as it did on the
 * nested shape. Same silent approval, narrower trigger, and much harder to find
 * the second time.
 *
 * Last-sprint-only is defensible for check-spec-output, whose question is "is
 * the spec I just generated well-formed" — a fresh spec has one sprint. It is
 * wrong for all four readers fixed here, whose question is "is there work left",
 * and a story does not stop being work because a later sprint was opened. When
 * the two readings disagree, the one that can silently drop pending work loses.
 *
 * ON A KEY COLLISION the later sprint wins, because a story carried forward is
 * the same story and its later state is the current one. Ids embed their sprint
 * (`S{sprint}-{nnn}`), so this should not arise; it is defined rather than left
 * to `Object.assign` ordering so that if it ever does, the result is a rule
 * somebody chose instead of an accident.
 *
 * ROOT `stories` IS IGNORED once any sprint carries a `stories` object, so a
 * legacy file that grew a `sprints` array cannot count its backlog twice. The
 * fall-through to root fires only when no sprint declares stories at all, which
 * is the purely flat file every project on this machine currently has.
 *
 * Accepts anything, including null and a parse result of the wrong type, and
 * always returns an object, so no caller needs its own `|| {}`. A reader that
 * receives {} must report it as "no stories found", never as "the sprint is
 * complete" — those two readings diverge on exactly this value, only one of
 * them is safe, and picking the wrong one is the whole defect above.
 */
function storiesOf(prd) {
    if (!prd || typeof prd !== 'object') return {};

    const sprints = Array.isArray(prd.sprints) ? prd.sprints : [];
    const merged = {};
    let sawNested = false;
    // Oldest first, so a later sprint's copy of a repeated id overwrites the
    // earlier one rather than the other way round.
    for (const sprint of sprints) {
        const stories = sprint && sprint.stories;
        if (!stories || typeof stories !== 'object') continue;
        sawNested = true;
        for (const [id, story] of Object.entries(stories)) merged[id] = story;
    }
    if (sawNested) return merged;

    return (prd.stories && typeof prd.stories === 'object') ? prd.stories : {};
}

module.exports = {
    DONE, PENDING, FAILED, DEFERRED, NEEDS_SETUP, VALID,
    isActionable, isOutstanding, isDeferred, isDone, needsSetup, isArchivable,
    summarise, storiesOf,
};
