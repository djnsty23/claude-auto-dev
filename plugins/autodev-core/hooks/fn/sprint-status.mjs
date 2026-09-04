// sprint-status.mjs — the pinned status line's text. Pure.
//
// `storiesOf` and `summarise` are an ES-module copy of
// ../../scripts/prd-states.js, which a hooks module cannot import: the hooks
// worker links ES modules only, and that file is CommonJS. This copy is a
// DELIBERATE duplicate, held to the original by tooling/test-hooks-module.js,
// which runs both over the same fixtures and fails on any difference. Change
// the original, run the suite, then change this; never only this.

const DONE = true;
const PENDING = null;
const FAILED = false;
const DEFERRED = 'deferred';
const NEEDS_SETUP = 'needs-setup';

function isActionable(story) {
    if (!story) return false;
    const p = story.passes;
    return p === PENDING || p === undefined || p === FAILED;
}

function isOutstanding(story) {
    if (!story) return false;
    const p = story.passes;
    return p === PENDING || p === undefined || p === FAILED || p === NEEDS_SETUP;
}

export function storiesOf(prd) {
    if (!prd || typeof prd !== 'object') return {};
    const sprints = Array.isArray(prd.sprints) ? prd.sprints : [];
    const merged = {};
    let sawNested = false;
    for (const sprint of sprints) {
        const stories = sprint && sprint.stories;
        if (!stories || typeof stories !== 'object') continue;
        sawNested = true;
        for (const [id, story] of Object.entries(stories)) merged[id] = story;
    }
    if (sawNested) return merged;
    return (prd.stories && typeof prd.stories === 'object') ? prd.stories : {};
}

export function summarise(stories) {
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
        else counts.unrecognised++;
    }
    counts.total = all.length;
    counts.actionable = all.filter(isActionable).length;
    counts.outstanding = all.filter(isOutstanding).length;
    return counts;
}

/**
 * One line, under the prompt, that costs no context tokens. Every non-zero
 * bucket is named so a state cannot go missing the way needs-setup once did;
 * `unrecognised` is named loudest because it means the schema moved.
 *
 * @param {{ counts?: object|null, prdText?: string|null, tally: { redacted: number, denied: number, rewritten: number } }} input
 */
export function formatStatus({ counts, prdText, tally }) {
    const fn = `fn: redacted ${tally.redacted} · denied ${tally.denied} · rewrote ${tally.rewritten}`;
    if (prdText) return `${fn} │ ${prdText}`;
    if (!counts) return `${fn} │ no prd.json`;
    if (counts.total === 0) return `${fn} │ prd: no stories found`;
    const parts = [];
    if (counts.pending) parts.push(`${counts.pending} pending`);
    if (counts.failed) parts.push(`${counts.failed} failed`);
    if (counts.needsSetup) parts.push(`${counts.needsSetup} needs-setup`);
    if (counts.deferred) parts.push(`${counts.deferred} deferred`);
    if (counts.unrecognised) parts.push(`${counts.unrecognised} UNRECOGNISED`);
    parts.push(`${counts.done}/${counts.total} done`);
    return `${fn} │ prd: ${parts.join(' · ')}`;
}
