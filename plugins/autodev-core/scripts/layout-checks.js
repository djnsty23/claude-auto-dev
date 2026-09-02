#!/usr/bin/env node
'use strict';
/**
 * layout-checks.js - the JUDGING half of the rendered-layout gate.
 *
 * Pure: it takes a snapshot object from layout-probe.js and returns findings.
 * It never touches a DOM, so tooling/test-rendered-layout-gate.js exercises it
 * in `npm test` with no browser, against snapshots captured from a real one.
 *
 * TWO ITEMS from the rendered-page half of the frontend-design-deslop slop
 * checklist (samber/cc-skills, MIT). Two done properly rather than six done
 * vaguely:
 *
 *   item 6  nothing overflows its container, and nothing forces an unintended
 *           horizontal scrollbar
 *   item 2  no text occluded by an overlapping element
 *
 * ------------------------------------------------------------------ REFUSING
 *
 * A third state, and the most important thing here. `analyse` returns
 * UNMEASURED - never a pass and never a fail - when the snapshot cannot support
 * a verdict. A gate that refuses is worth more than one that guesses, because a
 * guess is indistinguishable from a measurement once it is in a report.
 *
 * It refuses on:
 *
 *   ZERO-VIEWPORT     clientWidth or clientHeight is 0. Every rect comparison
 *                     against a zero-size viewport answers false for elements
 *                     that are plainly there.
 *   WIDTH-MISMATCH    the browser did not give you the width you asked for.
 *                     Resize tools report success and silently do nothing; the
 *                     result reads as a clean page at 360 that was measured at
 *                     1280.
 *   NO-VIEWPORT-META  asked for under 768 on a page with no viewport meta. The
 *                     layout viewport is then pinned near 980 and every mobile
 *                     reading is fiction. `[measured 2026-09-03]` hit on this
 *                     gate's own first fixture before the tag was added.
 *   NO-ELEMENTS       the harvest is structurally empty. A probe that returned
 *                     nothing must not read as a page with nothing wrong.
 *
 * -------------------------------------------------------- WHY clientWidth
 *
 * Every width comparison uses documentElement.clientWidth, the LAYOUT viewport.
 * `[measured 2026-09-03]` against the committed fixtures, a page carrying a
 * 900px table inside a fluid layout:
 *
 *     width   clientWidth  innerWidth  scrollWidth   sw>innerWidth   sw>clientWidth
 *      360        360         917         917          FALSE            true
 *      390        390         916         916          FALSE            true
 *      414        414         916         916          FALSE            true
 *      768        768         768         916          true             true
 *     1280       1280        1280        1280          false            false
 *
 * The obvious test misses the defect at every phone width and catches it only
 * at tablet, because a mobile browser zooms out to fit overflowing content and
 * innerWidth follows the zoom. tooling/test-rendered-layout-gate.js asserts
 * that table, so the day someone "simplifies" this to innerWidth the suite says
 * exactly which widths went blind.
 *
 * -------------------------------------------------- WHAT ABSORBS AN OVERFLOW
 *
 * Two ancestors stop a page scrolling sideways and they are not the same thing.
 * `overflow-x: auto|scroll` keeps the content REACHABLE - that is a rail, and
 * flagging one is how a gate cries wolf on every carousel ever built.
 * `overflow: hidden|clip` stops the scroll by CUTTING THE CONTENT OFF, which is
 * often the defect rather than the fix.
 *
 * Both are exempt from OVERFLOW-CULPRIT, because that code is about the page
 * scrolling and neither one scrolls it. They are counted apart, and where a clip
 * hides WORDS, CLIPPED-TEXT reports it - which is the code that can say
 * something useful about it.
 *
 * ------------------------------------------------------------ THRESHOLDS
 *
 * Every number below is a knob and none is derived from anything. They are a
 * first pass, so they travel in the output beside each finding: a reader who
 * disagrees can see the number they are disagreeing with instead of arguing
 * about the verdict.
 */

const DEFAULTS = {
    // Sub-pixel layout noise. Fractional rects are normal; 1px is not a defect.
    overflowTolerancePx: 1,
    // Share of sampled points on a run of text that must be covered before it
    // counts as occluded. A clipped corner is not a hidden sentence.
    occlusionMinFraction: 0.25,
    // How opaque a covering element must be to count as hiding what is under
    // it. A fully transparent click-catcher hit-tests exactly like a solid bar.
    occluderMinAlpha: 0.5,
    // Share of a text run's glyph boxes that must fall outside a clipping
    // container before the text counts as cut off.
    clipMinFraction: 0.25,
};

// An ancestor that lets the reader scroll to the content ABSORBS the overflow
// and is a legitimate rail. One that cuts the content off does not.
const SCROLLS = new Set(['auto', 'scroll', 'overlay']);
const CLIPS = new Set(['hidden', 'clip']);

const REFUSALS = {
    NO_SNAPSHOT: 'NO-SNAPSHOT',
    ZERO_VIEWPORT: 'ZERO-VIEWPORT',
    WIDTH_MISMATCH: 'WIDTH-MISMATCH',
    NO_VIEWPORT_META: 'NO-VIEWPORT-META',
    NO_ELEMENTS: 'NO-ELEMENTS',
};

const CODES = {
    DOC_SCROLL: 'DOC-SCROLL',
    OVERFLOW_CULPRIT: 'OVERFLOW-CULPRIT',
    CLIPPED_TEXT: 'CLIPPED-TEXT',
    TEXT_OCCLUDED: 'TEXT-OCCLUDED',
};

function unmeasured(reason, detail, snapshot) {
    return {
        status: 'UNMEASURED',
        reason,
        detail,
        width: snapshot && snapshot.viewport ? snapshot.viewport.requestedWidth : null,
        label: snapshot && snapshot.viewport ? snapshot.viewport.label : null,
        url: snapshot && snapshot.viewport ? snapshot.viewport.url : null,
        viewport: snapshot ? snapshot.viewport || null : null,
        population: snapshot ? snapshot.population || null : null,
        findings: [],
        counts: null,
    };
}

/** The nearest recorded ancestor of `el`, or null. */
function parentOf(elements, el) {
    return el.parent == null ? null : elements[el.parent] || null;
}

/**
 * Does this element overflow the layout viewport on the right? Left overflow is
 * deliberately not reported: right-to-left layouts and off-canvas drawers park
 * things at negative x on purpose, and the document-scroll finding already
 * catches the case where it matters.
 */
function overflowsViewport(el, clientWidth, tol) {
    return el.box.r > clientWidth + tol;
}

/**
 * @param {object} snapshot  output of layout-probe.js harvest()
 * @param {object} [options] threshold overrides; see DEFAULTS
 */
function analyse(snapshot, options) {
    const T = Object.assign({}, DEFAULTS, options || {});

    if (!snapshot || typeof snapshot !== 'object' || !snapshot.viewport) {
        return unmeasured(REFUSALS.NO_SNAPSHOT, 'not a layout snapshot', snapshot);
    }
    const vp = snapshot.viewport;
    const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
    const texts = Array.isArray(snapshot.text) ? snapshot.text : [];

    // ------------------------------------------------------------- refusals
    // Ordered most-fundamental first, so the reason names the real problem
    // rather than a symptom of it.

    if (!vp.clientWidth || !vp.clientHeight) {
        return unmeasured(
            REFUSALS.ZERO_VIEWPORT,
            `clientWidth=${vp.clientWidth} clientHeight=${vp.clientHeight}; every rect comparison against this answers false`,
            snapshot
        );
    }
    if (vp.requestedWidth != null && vp.clientWidth !== vp.requestedWidth) {
        return unmeasured(
            REFUSALS.WIDTH_MISMATCH,
            `asked for ${vp.requestedWidth}, the layout viewport is ${vp.clientWidth} (innerWidth ${vp.innerWidth}); the resize did not take`,
            snapshot
        );
    }
    if (vp.requestedWidth != null && vp.requestedWidth < 768 && !vp.hasViewportMeta) {
        return unmeasured(
            REFUSALS.NO_VIEWPORT_META,
            `no <meta name="viewport">, so the layout viewport is pinned near 980px and a reading at ${vp.requestedWidth} is fiction`,
            snapshot
        );
    }
    if (!elements.length) {
        return unmeasured(
            REFUSALS.NO_ELEMENTS,
            'the harvest recorded no elements; an empty probe must not read as a clean page',
            snapshot
        );
    }

    // ------------------------------------------------------------- findings

    const findings = [];
    const exempt = {
        scrollerAbsorbed: 0,
        clipAbsorbed: 0,
        ancestorAlreadyOverflows: 0,
        rootElement: 0,
        transparentOccluder: 0,
        modalSuppressed: 0,
        scrollableClip: 0,
        inconclusiveSamples: 0,
    };

    // --- item 6, first half: does the document scroll sideways at all?
    const overshoot = vp.scrollWidth - vp.clientWidth;
    if (overshoot > T.overflowTolerancePx) {
        findings.push({
            check: 'overflow',
            code: CODES.DOC_SCROLL,
            width: vp.requestedWidth,
            sel: 'document',
            detail: {
                scrollWidth: vp.scrollWidth,
                clientWidth: vp.clientWidth,
                innerWidth: vp.innerWidth,
                overshootPx: Math.round(overshoot * 100) / 100,
                // Printed because it is the whole reason this compares against
                // clientWidth. When these disagree, the obvious test is blind.
                naiveTestWouldMiss: !(vp.scrollWidth > vp.innerWidth),
            },
            note: `the page scrolls ${Math.round(overshoot)}px sideways`,
            threshold: `overshoot > ${T.overflowTolerancePx}px`,
        });
    }

    // --- item 6, second half: which element is responsible?
    //
    // Reported OUTERMOST-first. A 900px table makes its tbody, every row and
    // every cell overflow too; on the committed fixture that is 17 elements for
    // one defect. The element whose nearest overflowing-free ancestor contains
    // it is the one the fix goes on.
    const rootTags = new Set(['html', 'body']);
    for (const el of elements) {
        if (!overflowsViewport(el, vp.clientWidth, T.overflowTolerancePx)) continue;

        // html and body stretch to their content on some pages. Reporting them
        // is useless - DOC-SCROLL already says the page scrolls - but they must
        // not suppress their children either, so they are skipped rather than
        // treated as an overflowing ancestor.
        if (rootTags.has(el.tag)) { exempt.rootElement++; continue; }

        // position:fixed is painted against the viewport and contributes
        // nothing to document scroll width.
        if (el.position === 'fixed') continue;

        const ca = el.clipAncestor;
        if (ca && SCROLLS.has(ca.overflowX)) {
            // A rail. The reader can reach the content by scrolling the rail,
            // which is the entire point of a rail. `[measured 2026-09-03]` the
            // clean control has five cards in exactly this position: five false
            // positives without this branch, zero with it.
            exempt.scrollerAbsorbed++;
            continue;
        }
        if (ca && CLIPS.has(ca.overflowX)) {
            // A clipping ancestor absorbs the overflow too - by cutting the
            // content off rather than by letting the reader scroll to it - so
            // the DOCUMENT does not scroll and this is not the defect this code
            // names. Where the clipping hides words, CLIPPED-TEXT reports it,
            // which is the right code for it.
            //
            // `[measured 2026-09-03]` found on a real third-party page, not on
            // a fixture: an MDN demo iframe 534px wide inside a
            // `div.code-example` with overflow-x hidden and a right edge of
            // 374, on a page whose scrollWidth equals its clientWidth. Without
            // this branch the finding printed "extends past the layout viewport
            // with nothing to absorb it" while something plainly had absorbed
            // it - a report contradicting its own note.
            //
            // Counted separately from the rail case, because these two are only
            // alike in stopping the scroll: a rail keeps the content reachable
            // and a clip does not.
            exempt.clipAbsorbed++;
            continue;
        }

        let anc = parentOf(elements, el);
        let suppressed = false;
        while (anc) {
            if (!rootTags.has(anc.tag) && overflowsViewport(anc, vp.clientWidth, T.overflowTolerancePx)) {
                suppressed = true;
                break;
            }
            anc = parentOf(elements, anc);
        }
        if (suppressed) { exempt.ancestorAlreadyOverflows++; continue; }

        findings.push({
            check: 'overflow',
            code: CODES.OVERFLOW_CULPRIT,
            width: vp.requestedWidth,
            sel: el.sel,
            detail: {
                right: el.box.r,
                clientWidth: vp.clientWidth,
                overshootPx: Math.round((el.box.r - vp.clientWidth) * 100) / 100,
                width: el.box.w,
                position: el.position,
                clipAncestor: ca ? { sel: ca.sel, overflowX: ca.overflowX } : null,
            },
            note: `extends ${Math.round(el.box.r - vp.clientWidth)}px past the layout viewport with nothing to absorb it`,
            threshold: `right edge > clientWidth + ${T.overflowTolerancePx}px`,
        });
    }

    // --- item 6, third half: content cut off by a clipping container.
    //
    // The page need not scroll for this. An ancestor with overflow auto/scroll
    // absorbs by letting the reader scroll to the words; one with hidden/clip
    // absorbs by painting them nowhere. Treating those as the same thing is how
    // an ancestor-absorbs-it exemption swallows a real defect.
    //
    // Per axis, because `overflow-x: hidden; overflow-y: auto` is an ordinary
    // vertical scroller and text running past its bottom is reachable.
    for (const t of texts) {
        const el = elements[t.i];
        if (!el || !el.clipAncestor) continue;
        const ca = el.clipAncestor;
        const ancEl = ca.i != null ? elements[ca.i] : null;
        const clipsX = CLIPS.has(ca.overflowX);
        const clipsY = ancEl ? CLIPS.has(ancEl.overflowY) : false;
        if (!clipsX && !clipsY) { exempt.scrollableClip++; continue; }

        const rects = t.glyphRects || [];
        if (!rects.length) continue;
        const outside = rects.filter((g) =>
            (clipsY && g.b > ca.box.b + T.overflowTolerancePx) ||
            (clipsX && g.r > ca.box.r + T.overflowTolerancePx)
        );
        const fraction = outside.length / rects.length;
        if (fraction < T.clipMinFraction) continue;

        findings.push({
            check: 'overflow',
            code: CODES.CLIPPED_TEXT,
            width: vp.requestedWidth,
            scrollY: t.scrollY,
            sel: t.sel,
            detail: {
                clippedGlyphBoxes: outside.length,
                glyphBoxes: rects.length,
                fraction: Math.round(fraction * 100) / 100,
                container: ca.sel,
                containerOverflow: `x:${ca.overflowX} y:${ancEl ? ancEl.overflowY : '?'}`,
                containerBottom: ca.box.b,
                axis: clipsY && clipsX ? 'both' : clipsY ? 'y' : 'x',
                text: t.text,
            },
            note: `${outside.length} of ${rects.length} glyph boxes fall outside a container that clips rather than scrolls`,
            threshold: `clipped fraction >= ${T.clipMinFraction}`,
        });
    }

    // --- item 2: text under an opaque overlapping element.
    //
    // Sampled behaviourally through the browser's own hit stack, never inferred
    // from rectangles. Two things a rect comparison cannot know: whether the
    // covering element actually paints, and whether it is above or below in
    // paint order.
    const modal = snapshot.modalSeen || null;
    for (const t of texts) {
        // A sample where the text itself was not hit proves nothing either way:
        // the point may be inside an ancestor while the glyphs there were cut
        // away by a clipping container, in which case the words are not painted
        // and "is something covering them" is not a question. Dropped from
        // numerator AND denominator, and counted, so a run that is mostly
        // inconclusive cannot pass by having a small clean remainder.
        const usable = (t.samples || []).filter((s) => s.selfHit !== false);
        exempt.inconclusiveSamples += (t.samples || []).length - usable.length;
        const samples = usable;
        if (!samples.length) continue;

        const covered = samples.filter((s) => {
            const o = s.occluder;
            if (!o) return false;
            // Opacity 0 hit-tests and paints nothing.
            if (o.opacity === 0) return false;
            return o.bgAlpha >= T.occluderMinAlpha || o.hasBgImage || o.hasBackdrop;
        });
        if (!covered.length) {
            // Distinguish "nothing over it" from "something over it that does
            // not paint" - the transparent click-catcher case.
            if (samples.some((s) => s.occluder)) exempt.transparentOccluder++;
            continue;
        }
        const fraction = covered.length / samples.length;
        if (fraction < T.occlusionMinFraction) continue;

        // A modal owns the screen. Every word beneath it reads as covered, and
        // reporting all of them buries whatever else the run found.
        const byModal = covered.filter((s) => s.occluder.modal);
        if (modal && byModal.length === covered.length) { exempt.modalSuppressed++; continue; }

        const top = covered[0].occluder;
        findings.push({
            check: 'occlusion',
            code: CODES.TEXT_OCCLUDED,
            width: vp.requestedWidth,
            scrollY: t.scrollY,
            sel: t.sel,
            detail: {
                occluder: top.sel,
                occluderAlpha: top.bgAlpha,
                occluderHasBgImage: top.hasBgImage,
                occluderHasBackdrop: top.hasBackdrop,
                coveredSamples: covered.length,
                samples: samples.length,
                inconclusiveSamples: (t.samples || []).length - samples.length,
                fraction: Math.round(fraction * 100) / 100,
                text: t.text,
            },
            note: `${covered.length} of ${samples.length} sampled points on this text are under ${top.sel}`,
            threshold: `covered fraction >= ${T.occlusionMinFraction} and occluder alpha >= ${T.occluderMinAlpha}`,
        });
    }

    const counts = {
        total: findings.length,
        docScroll: findings.filter((f) => f.code === CODES.DOC_SCROLL).length,
        overflowCulprit: findings.filter((f) => f.code === CODES.OVERFLOW_CULPRIT).length,
        clippedText: findings.filter((f) => f.code === CODES.CLIPPED_TEXT).length,
        occluded: findings.filter((f) => f.code === CODES.TEXT_OCCLUDED).length,
        exempt,
    };

    return {
        status: 'MEASURED',
        reason: null,
        detail: null,
        width: vp.requestedWidth,
        label: vp.label,
        url: vp.url,
        probeSha: snapshot.probeSha || null,
        viewport: vp,
        population: snapshot.population || null,
        modalSeen: modal,
        thresholds: T,
        findings,
        counts,
    };
}

/**
 * Roll several per-width results into one report body. Deliberately NOT a
 * single verdict: a defect present at 360 and absent at 390 is a defect, and
 * collapsing the widths is how it disappears.
 */
function summarise(results) {
    const measured = results.filter((r) => r.status === 'MEASURED');
    const refused = results.filter((r) => r.status !== 'MEASURED');
    const byWidth = results.map((r) => ({
        width: r.width,
        label: r.label,
        status: r.status,
        reason: r.reason,
        elements: r.population ? r.population.recorded : null,
        textSampled: r.population ? r.population.textRecords : null,
        textTotal: r.population ? r.population.textElementsTotal : null,
        findings: r.findings.length,
        counts: r.counts,
    }));
    return {
        widths: results.length,
        measured: measured.length,
        refused: refused.length,
        totalFindings: measured.reduce((n, r) => n + r.findings.length, 0),
        elementsScanned: measured.reduce((n, r) => n + (r.population ? r.population.recorded : 0), 0),
        textSampled: measured.reduce((n, r) => n + (r.population ? r.population.textRecords : 0), 0),
        byWidth,
        // A code seen at some widths and not others is the responsive finding.
        widthsByCode: Object.values(CODES).reduce((acc, code) => {
            acc[code] = measured
                .filter((r) => r.findings.some((f) => f.code === code))
                .map((r) => r.width);
            return acc;
        }, {}),
    };
}

module.exports = { analyse, summarise, DEFAULTS, CODES, REFUSALS, SCROLLS, CLIPS };

if (require.main === module) {
    console.log('layout-checks.js - the judging half of the rendered-layout gate.');
    console.log('');
    console.log('A library, not a command. It exports analyse(snapshot, options) and');
    console.log('summarise(results). Run the gate instead:');
    console.log('');
    console.log('  node rendered-layout-gate.js <snapshot.json> [...]');
    console.log('  node rendered-layout-gate.js --how       # capture instructions');
    console.log('');
    console.log(`Codes:    ${Object.values(CODES).join(', ')}`);
    console.log(`Refusals: ${Object.values(REFUSALS).join(', ')}`);
    console.log(`Defaults: ${JSON.stringify(DEFAULTS)}`);
}
