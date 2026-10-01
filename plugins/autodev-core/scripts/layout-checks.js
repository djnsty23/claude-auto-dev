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

    // ---- component rules, judged from snapshot.components (harvestComponents)
    // A row of controls whose heights, centres, border widths, radii or
    // horizontal padding spread wider than these reads as assembled from parts.
    rowHeightTolPx: 2,
    rowCenterTolPx: 2,
    rowBorderTolPx: 0.5,
    rowRadiusTolPx: 2,
    rowPaddingTolPx: 4,
    // A row container taller than this is a layout region, not a toolbar.
    rowMaxHeightPx: 120,
    // The size band of a control. A boxed element outside it is a card or a
    // badge, not a button.
    controlMinPx: 12,
    controlMaxHeightPx: 64,
    controlMaxWidthPx: 480,
    // Two visibly different controls closer than this read as one broken one.
    gluedGapPx: 2,
    // A framed box this close inside another frame draws two lines.
    doubleBorderPx: 2,
    // A decorative bar: painted, textless, at most this tall, at least this wide.
    barMaxHeightPx: 8,
    barMinWidthPx: 24,
    // A bar covering at least this share of its container's width was meant to
    // span it. A narrower one is an accent and is counted, not reported.
    barMinSpanFraction: 0.5,
    barEdgeTolPx: 2,
    // A container this short around a bar is a track (a progress bar), and a
    // fill that does not span its track is the point of a track.
    barTrackMaxPx: 16,
    // Text or a control closer than this to the viewport edge on a touch width.
    gutterMinPx: 12,
    // The widest viewport the touch-only rules (gutter, tap size) apply at.
    touchMaxWidth: 767,
    // The smallest tap target on a touch width, both axes.
    tapMinPx: 44,
    // Content wider (or taller, under a line clamp) than its box by more than
    // this, in a box that ellipsises or clips, is truncated.
    truncMinPx: 1,
    // Repeated siblings whose spacing spreads wider than this break rhythm.
    rhythmTolPx: 8,
    rhythmMinRepeats: 3,
};

// An ancestor that lets the reader scroll to the content ABSORBS the overflow
// and is a legitimate rail. One that cuts the content off does not.
const SCROLLS = new Set(['auto', 'scroll', 'overlay']);
const CLIPS = new Set(['hidden', 'clip']);
// Occluders painted against the viewport rather than the document.
const PINNED = new Set(['fixed', 'sticky']);

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
    ROW_HEIGHT: 'ROW-HEIGHT',
    ROW_CENTER: 'ROW-CENTER',
    ROW_BORDER: 'ROW-BORDER',
    ROW_RADIUS: 'ROW-RADIUS',
    ROW_PADDING: 'ROW-PADDING',
    GLUED_CONTROLS: 'GLUED-CONTROLS',
    DOUBLE_BORDER: 'DOUBLE-BORDER',
    SHORT_BAR: 'SHORT-BAR',
    NO_GUTTER: 'NO-GUTTER',
    TAP_TARGET: 'TAP-TARGET',
    TRUNCATED_TEXT: 'TRUNCATED-TEXT',
    RHYTHM: 'RHYTHM',
};

// The component codes, and the subset that applies only on a touch width. A
// mobile-only code at a desktop width counts null, never 0: it was not asked.
const COMPONENT_CODES = [
    CODES.ROW_HEIGHT, CODES.ROW_CENTER, CODES.ROW_BORDER, CODES.ROW_RADIUS, CODES.ROW_PADDING,
    CODES.GLUED_CONTROLS, CODES.DOUBLE_BORDER, CODES.SHORT_BAR, CODES.NO_GUTTER,
    CODES.TAP_TARGET, CODES.TRUNCATED_TEXT, CODES.RHYTHM,
];
const TOUCH_ONLY = new Set([CODES.NO_GUTTER, CODES.TAP_TARGET]);
// counts.components key per code.
const COUNT_KEY = {
    'ROW-HEIGHT': 'rowHeight', 'ROW-CENTER': 'rowCenter', 'ROW-BORDER': 'rowBorder',
    'ROW-RADIUS': 'rowRadius', 'ROW-PADDING': 'rowPadding', 'GLUED-CONTROLS': 'glued',
    'DOUBLE-BORDER': 'doubleBorder', 'SHORT-BAR': 'shortBar', 'NO-GUTTER': 'noGutter',
    'TAP-TARGET': 'tapTarget', 'TRUNCATED-TEXT': 'truncated', 'RHYTHM': 'rhythm',
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
        controlLabel: 0,
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
        // Text inside a control is that control's ACCESSIBLE NAME, and clipping
        // it away is how an icon button is built. `[measured 2026-09-03]` on
        // Wikipedia at 390 this branch is the difference between 23 findings
        // and 0: every one was a "Search" / "Watch" / "Edit" label inside a
        // 44x44 button, present for a screen reader and hidden on purpose.
        //
        // Container SIZE cannot make this call - 44x44 is a real tap target,
        // not the 1px visually-hidden idiom - and neither can the clipped
        // FRACTION, because a fully hidden label and a paragraph entirely
        // inside a clipping panel are both 100%. What the text IS decides it.
        if (t.controlAncestor) { exempt.controlLabel++; continue; }
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
            if (!(o.bgAlpha >= T.occluderMinAlpha || o.hasBgImage || o.hasBackdrop)) return false;
            // A viewport-pinned bar covers whatever the reader scrolls beneath
            // it, which is the entire point of one. Only at rest does text under
            // it mean the layout reserved no clearance.
            //
            // `[measured 2026-09-03]` this is not hypothetical: the clean
            // control's own fixed header covers its h1 at scrollY 64 and 127
            // and nothing is wrong with the page. Without this branch the check
            // fires on every site with a sticky header, at every scroll step,
            // and the planted defect - which sits at scrollY 0 - drowns in it.
            //
            // `[measured 2026-10-01]` on a real product the hit was a CHILD of
            // the sticky header (its colour stripe, its language button),
            // static itself, and the exemption missed every one: 10 of the top
            // 10 ranked findings were text scrolled under that header.
            // pinnedBy is the nearest fixed or sticky box at or above the hit.
            if ((PINNED.has(o.position) || PINNED.has(o.pinnedBy)) && (t.scrollY || 0) > 0) return false;
            return true;
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

    // `[measured 2026-09-03]` a bot-challenge interstitial harvested 3 elements
    // and 0 text runs, and reported MEASURED with 0 occlusion findings - a
    // confident zero from a check that had nothing to look at. Both text-based
    // codes report null rather than 0 when nothing was sampled, so the row
    // reads "n/a" and cannot be mistaken for a clean page.
    // --- the component rules. null when the snapshot carries no component
    // harvest (every snapshot taken before harvestComponents existed), so an
    // old fixture reads n/a for them rather than a confident zero.
    const comp = analyseComponents(snapshot, T);
    if (comp) findings.push(...comp.findings);

    const sawText = texts.length > 0;
    const counts = {
        total: findings.length,
        docScroll: findings.filter((f) => f.code === CODES.DOC_SCROLL).length,
        overflowCulprit: findings.filter((f) => f.code === CODES.OVERFLOW_CULPRIT).length,
        clippedText: sawText ? findings.filter((f) => f.code === CODES.CLIPPED_TEXT).length : null,
        occluded: sawText ? findings.filter((f) => f.code === CODES.TEXT_OCCLUDED).length : null,
        textCovered: sawText,
        exempt,
        components: comp ? comp.counts : null,
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
        componentPopulation: comp ? comp.population : null,
        componentSha: snapshot.components ? snapshot.components.sha || null : null,
        modalSeen: modal,
        thresholds: T,
        findings,
        counts,
    };
}

// ======================================================= COMPONENT RULES
//
// Judged from snapshot.components, which harvestComponents() in
// layout-probe.js fills. Every rule below is a measurement against a named
// threshold in DEFAULTS. None is a taste call: taste is the vision pass in
// unslop-sweep.js, which is advisory and never fails anything.
//
// THE VOCABULARY the rules share:
//   painted   draws its own background a reader can see: an image, or a
//             colour of alpha >= 0.1 that differs from the colour behind it
//   frame     the widest visible border side, ring (zero-blur box-shadow
//             spread) or outline
//   boxed     framed or painted: a shape the eye reads as one object
//   control   boxed and inside the control size band
//
// THE ONE EXEMPTION is data-unslop-ok="CODE ..." on the element or an
// ancestor, in the product's source. It is reviewed like any other line of
// code and every use is counted (exempt.markedOk), so it cannot hide a defect
// quietly. There is no command-line way to silence a rule on one element.

const r2 = (n) => Math.round(n * 100) / 100;
const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

function frameOf(e) {
    return Math.max(e.bw[0], e.bw[1], e.bw[2], e.bw[3], e.ring || 0, e.ol || 0);
}
function framedSides(e) {
    return e.bw.filter((w) => w > 0).length;
}
function paintedOf(e) {
    return !!e.img || (e.bg >= 0.1 && e.bgc !== e.behind);
}
function boxedOf(e) {
    return frameOf(e) > 0 || paintedOf(e);
}
function isControl(e, T) {
    return boxedOf(e) &&
        e.box.h >= T.controlMinPx && e.box.h <= T.controlMaxHeightPx &&
        e.box.w >= T.controlMinPx && e.box.w <= T.controlMaxWidthPx;
}
function isPill(e) {
    return Math.min(...e.br) >= e.box.h / 2 - 1;
}
function isRowContainer(e) {
    const flexRow = (e.d === 'flex' || e.d === 'inline-flex') && (e.fd === 'row' || e.fd === 'row-reverse');
    return flexRow || e.d === 'grid' || e.d === 'inline-grid';
}

/**
 * @param {object} snapshot  carries `components` from harvestComponents()
 * @param {object} T         thresholds (DEFAULTS merged with overrides)
 * @returns {null | {findings, counts, population}}  null when unmeasured
 */
function analyseComponents(snapshot, T) {
    const comp = snapshot.components;
    const vp = snapshot.viewport;
    if (!comp || comp.error || !Array.isArray(comp.elements) || !comp.elements.length) return null;
    const els = comp.elements;
    const cw = vp.clientWidth;
    const width = vp.requestedWidth;
    const touch = cw <= T.touchMaxWidth;

    const kids = new Map();
    for (const e of els) {
        if (e.p == null) continue;
        if (!kids.has(e.p)) kids.set(e.p, []);
        kids.get(e.p).push(e);
    }
    const childrenOf = (e) => kids.get(e.i) || [];
    const parentOf_ = (e) => (e.p == null ? null : els[e.p] || null);
    const subtreeHasText = (e, depth) => {
        if (e.txt) return true;
        if (depth <= 0) return false;
        return childrenOf(e).some((c) => subtreeHasText(c, depth - 1));
    };
    const onScreen = (b) => b.r > 0 && b.l < cw;

    const findings = [];
    const exempt = {
        markedOk: 0, consistentGroup: 0, selectedSegment: 0, pillRadius: 0, narrowAccent: 0, barTrack: 0,
        rail: 0, fullBleed: 0, inlineLink: 0, wrappedByTarget: 0, disabled: 0,
    };
    const population = {
        recorded: comp.recorded, considered: comp.considered, droppedForCap: comp.droppedForCap,
        truncated: !!comp.truncated, rowContainers: 0, rowLines: 0, rowItems: 0, framedPairs: 0,
        barCandidates: 0, gutterCandidates: touch ? 0 : null, tapCandidates: touch ? 0 : null,
        truncCandidates: 0, rhythmRuns: 0,
    };

    const push = (code, sel, detail, note, threshold, okOn) => {
        if (okOn.some((e) => e && (e.ok || []).includes(code))) { exempt.markedOk++; return; }
        findings.push({ check: 'component', code, width, sel, lm: (okOn[0] && okOn[0].lm) || null, detail, note, threshold });
    };

    // ------------------------------------------------------- rows of controls
    //
    // A row root is a flex row or grid container no taller than rowMaxHeightPx.
    // Its items are the CONTROLS reached by descending through unboxed
    // wrappers, so a header that nests a two-control group in a plain div still
    // compares all four controls on one line. A wrapper that is itself a row
    // container is absorbed and not judged again as its own row.
    const absorbed = new Set();
    for (const root of els) {
        if (!isRowContainer(root) || root.box.h > T.rowMaxHeightPx || absorbed.has(root.i)) continue;
        if (!onScreen(root.box)) continue;
        const items = [];
        const collect = (node, depth) => {
            for (const c of childrenOf(node)) {
                if (isControl(c, T)) { items.push(c); continue; }
                if (boxedOf(c) || depth <= 0) continue;
                if (isRowContainer(c)) absorbed.add(c.i);
                collect(c, depth - 1);
            }
        };
        collect(root, 4);
        population.rowContainers++;
        const visible = items.filter((c) => onScreen(c.box));
        // Lines: items overlapping vertically by at least half the shorter one.
        const lines = [];
        for (const it of visible.sort((a, b) => a.box.t - b.box.t)) {
            const line = lines.find((ln) => ln.some((o) => {
                const ov = Math.min(o.box.b, it.box.b) - Math.max(o.box.t, it.box.t);
                return ov >= 0.5 * Math.min(o.box.h, it.box.h);
            }));
            if (line) line.push(it); else lines.push([it]);
        }
        for (const line of lines) {
            if (line.length < 2) continue;
            line.sort((a, b) => a.box.l - b.box.l);
            population.rowLines++;
            population.rowItems += line.length;
            const okOn = [root, ...line];
            const view = line.map((c) => ({
                sel: c.sel, h: c.box.h, cy: r2(c.box.t + c.box.h / 2), frame: frameOf(c),
                radius: Math.max(...c.br), padX: r2(c.pad[3]), painted: paintedOf(c),
            }));

            const hs = line.map((c) => c.box.h);
            if (spread(hs) > T.rowHeightTolPx) {
                push(CODES.ROW_HEIGHT, root.sel, { items: view, spreadPx: r2(spread(hs)) },
                    `${line.length} controls in one row span heights ${Math.min(...hs)} to ${Math.max(...hs)}px`,
                    `height spread > ${T.rowHeightTolPx}px`, okOn);
            }
            const cys = line.map((c) => c.box.t + c.box.h / 2);
            if (spread(cys) > T.rowCenterTolPx) {
                push(CODES.ROW_CENTER, root.sel, { items: view, spreadPx: r2(spread(cys)) },
                    `vertical centres in one row differ by ${r2(spread(cys))}px`,
                    `centre spread > ${T.rowCenterTolPx}px`, okOn);
            }
            // Border weight among the FRAMED items only. A solid primary
            // button beside an outlined secondary is a hierarchy, not a defect;
            // a 1px outline beside a 2px ring is.
            const framed = line.filter((c) => frameOf(c) > 0);
            const fw = framed.map(frameOf);
            if (framed.length >= 2 && spread(fw) > T.rowBorderTolPx) {
                push(CODES.ROW_BORDER, root.sel, { items: view, spreadPx: r2(spread(fw)) },
                    `framed controls in one row use border weights ${[...new Set(fw)].join(', ')}px`,
                    `frame-width spread > ${T.rowBorderTolPx}px`, okOn);
            }
            // Radius among the non-pill items. A pill or a circle is a shape
            // choice that scales with height, so it is not compared by px.
            const square = line.filter((c) => !isPill(c));
            exempt.pillRadius += line.length - square.length;
            const rs = square.map((c) => Math.max(...c.br));
            if (square.length >= 2 && spread(rs) > T.rowRadiusTolPx) {
                push(CODES.ROW_RADIUS, root.sel, { items: view, spreadPx: r2(spread(rs)) },
                    `non-pill controls in one row use corner radii ${[...new Set(rs)].join(', ')}px`,
                    `radius spread > ${T.rowRadiusTolPx}px`, okOn);
            }
            // Horizontal padding among controls that carry words. An icon
            // button has no text inset to compare, and a square control (an
            // avatar's initial, a one-glyph button) centres its content by
            // size, not by padding.
            const worded = line.filter((c) => subtreeHasText(c, 3) && Math.abs(c.box.w - c.box.h) > 2);
            const ps = worded.map((c) => c.pad[3]);
            if (worded.length >= 2 && spread(ps) > T.rowPaddingTolPx) {
                push(CODES.ROW_PADDING, root.sel, { items: view, spreadPx: r2(spread(ps)) },
                    `text controls in one row inset their labels by ${[...new Set(ps)].join(', ')}px`,
                    `left-padding spread > ${T.rowPaddingTolPx}px`, okOn);
            }

            // Glued: two adjacent controls with no gap that are NOT one
            // consistent group. A segmented button group is the same height,
            // frame and fill throughout and is exempt; a bordered counter
            // fused to a solid button is not. A segmented group with one
            // segment selected differs in fill only, and its segments are
            // square where they join; two rounded controls that collide are
            // not joined, so they still fire.
            for (let k = 0; k + 1 < line.length; k++) {
                const a = line[k];
                const b = line[k + 1];
                const gap = b.box.l - a.box.r;
                if (!(gap > -1 && gap < T.gluedGapPx)) continue;
                const sameShape = Math.abs(a.box.h - b.box.h) <= 1 && frameOf(a) === frameOf(b);
                const consistent = sameShape && paintedOf(a) === paintedOf(b) && (!paintedOf(a) || a.bgc === b.bgc);
                if (consistent) { exempt.consistentGroup++; continue; }
                const joined = frameOf(a) > 0 && a.br[1] <= 1 && a.br[2] <= 1 && b.br[0] <= 1 && b.br[3] <= 1;
                if (sameShape && joined) { exempt.selectedSegment++; continue; }
                push(CODES.GLUED_CONTROLS, a.sel + ' + ' + b.sel, {
                    gapPx: r2(gap), a: view[k], b: view[k + 1],
                }, `two different controls touch (${r2(gap)}px apart): ${a.box.h}px ${paintedOf(a) ? 'filled' : 'outlined'} beside ${b.box.h}px ${paintedOf(b) ? 'filled' : 'outlined'}`,
                `gap < ${T.gluedGapPx}px between controls that differ in height, frame or fill`, [a, b]);
            }
        }
    }

    // --------------------------------------------------------- double borders
    //
    // A framed box sitting within doubleBorderPx of the inside of another
    // frame on all four sides draws two lines where the design meant one. The
    // same element carrying both a border and an outer ring is the same defect
    // on one node.
    for (const e of els) {
        if (!onScreen(e.box)) continue;
        const sides = framedSides(e);
        const hasRing = (e.ring || 0) > 0;
        if (sides >= 3 && hasRing && !e.ringInset) {
            population.framedPairs++;
            push(CODES.DOUBLE_BORDER, e.sel, { kind: 'self', border: Math.max(...e.bw), ring: e.ring },
                `one element draws a ${Math.max(...e.bw)}px border and a ${e.ring}px ring around it`,
                'border and outer ring on the same element', [e]);
            continue;
        }
        if (sides < 3 && !hasRing) continue;
        let a = parentOf_(e);
        while (a && !(framedSides(a) >= 3 || (a.ring || 0) > 0)) a = parentOf_(a);
        if (!a) continue;
        population.framedPairs++;
        const ext = hasRing && !e.ringInset ? e.ring : 0;
        const inset = (a.ring || 0) > 0 && a.ringInset ? a.ring : 0;
        const c = { t: e.box.t - ext, r: e.box.r + ext, b: e.box.b + ext, l: e.box.l - ext };
        const p = {
            t: a.box.t + a.bw[0] + inset, r: a.box.r - a.bw[1] - inset,
            b: a.box.b - a.bw[2] - inset, l: a.box.l + a.bw[3] + inset,
        };
        const gaps = [c.t - p.t, p.r - c.r, p.b - c.b, c.l - p.l].map(r2);
        if (gaps.every((g) => g >= -1 && g <= T.doubleBorderPx)) {
            push(CODES.DOUBLE_BORDER, e.sel, { kind: 'nested', outer: a.sel, gapsPx: gaps, inner: frameOf(e), outerFrame: frameOf(a) },
                `a ${frameOf(e)}px frame sits ${Math.max(...gaps)}px inside ${a.sel}'s ${frameOf(a)}px frame`,
                `all four gaps between frames <= ${T.doubleBorderPx}px`, [e, a]);
        }
    }

    // ------------------------------------------------------ short decorative bars
    //
    // A thin painted stripe at the top or bottom edge of its container that
    // covers most of the width but stops short of an edge. A centred accent
    // under a heading covers less than barMinSpanFraction and is counted, not
    // reported. A fill inside a short track is a progress bar.
    const containerOf = (e) => {
        let a = parentOf_(e);
        while (a && !(boxedOf(a) || /^(header|nav|footer|section|aside|main|body|article)$/.test(a.tag))) a = parentOf_(a);
        return a;
    };
    const bars = [];
    for (const e of els) {
        if (paintedOf(e) && !subtreeHasText(e, 2) && e.box.h <= T.barMaxHeightPx && e.box.w >= T.barMinWidthPx) {
            bars.push({ box: e.box, host: e, cont: containerOf(e), sel: e.sel });
        }
        for (const ps of e.ps || []) {
            if (!ps.box || !(ps.bg >= 0.1 || ps.img)) continue;
            if (ps.box.h > T.barMaxHeightPx || ps.box.w < T.barMinWidthPx) continue;
            bars.push({ box: ps.box, host: e, cont: e, sel: e.sel + '::' + ps.w });
        }
    }
    for (const bar of bars) {
        const cont = bar.cont;
        if (!cont || !onScreen(bar.box)) continue;
        population.barCandidates++;
        if (cont.box.h <= T.barTrackMaxPx) { exempt.barTrack++; continue; }
        const atEdge = Math.abs(bar.box.t - cont.box.t) <= T.barEdgeTolPx || Math.abs(cont.box.b - bar.box.b) <= T.barEdgeTolPx;
        if (!atEdge) continue;
        const spans = bar.box.l <= cont.box.l + T.barEdgeTolPx && bar.box.r >= cont.box.r - T.barEdgeTolPx;
        if (spans) continue;
        const frac = bar.box.w / cont.box.w;
        if (frac < T.barMinSpanFraction) { exempt.narrowAccent++; continue; }
        push(CODES.SHORT_BAR, bar.sel, {
            container: cont.sel, barLeft: bar.box.l, barRight: bar.box.r,
            containerLeft: cont.box.l, containerRight: cont.box.r, spanFraction: r2(frac),
        }, `a ${bar.box.h}px stripe covers ${Math.round(frac * 100)}% of ${cont.sel} and stops ${r2(bar.box.l - cont.box.l)}px from the left, ${r2(cont.box.r - bar.box.r)}px from the right`,
        `edge stripe covering >= ${T.barMinSpanFraction} of its container without spanning it (tolerance ${T.barEdgeTolPx}px)`, [bar.host, cont]);
    }

    // --------------------------------------------------------- touch-width rules
    if (touch) {
        // Missing side gutter: controls first, then text not inside a control
        // already reported, so one cramped button is one finding.
        const reported = new Set();
        const inReported = (e) => {
            for (let a = parentOf_(e); a; a = parentOf_(a)) if (reported.has(a.i)) return true;
            return false;
        };
        const gutterOf = (b) => r2(Math.min(b.l, cw - b.r));
        const candidates = [
            ...els.filter((e) => isControl(e, T)),
            ...els.filter((e) => e.tb && !isControl(e, T)),
        ];
        for (const e of candidates) {
            const b = isControl(e, T) ? e.box : e.tb;
            if (!onScreen(b)) continue;
            population.gutterCandidates++;
            if (e.rail) { exempt.rail++; continue; }
            if (e.box.w >= cw - 1) { exempt.fullBleed++; continue; }
            const g = gutterOf(b);
            if (g >= T.gutterMinPx) continue;
            if (inReported(e)) continue;
            reported.add(e.i);
            push(CODES.NO_GUTTER, e.sel, { left: b.l, right: r2(cw - b.r), clientWidth: cw, text: e.txt || null },
                `${isControl(e, T) ? 'a control' : 'text'} sits ${g}px from the ${b.l <= cw - b.r ? 'left' : 'right'} edge of a ${cw}px screen`,
                `distance to the viewport edge < ${T.gutterMinPx}px at width <= ${T.touchMaxWidth}`, [e]);
        }

        // Tap targets: the box unioned with any positioned pseudo-element
        // (the hit-area expansion idiom), and passed when a larger interactive
        // ancestor or label wraps it. A link inside a sentence is the WCAG
        // inline exception.
        for (const e of els) {
            if (!e.ia || !onScreen(e.box)) continue;
            population.tapCandidates++;
            if (e.dis) { exempt.disabled++; continue; }
            if (e.inl) { exempt.inlineLink++; continue; }
            let t = Object.assign({}, e.box);
            for (const ps of e.ps || []) {
                if (!ps.box) continue;
                t = { l: Math.min(t.l, ps.box.l), t: Math.min(t.t, ps.box.t), r: Math.max(t.r, ps.box.r), b: Math.max(t.b, ps.box.b) };
            }
            const w = r2(t.r - t.l);
            const h = r2(t.b - t.t);
            if (w >= T.tapMinPx && h >= T.tapMinPx) continue;
            let wrapped = false;
            for (let a = parentOf_(e); a; a = parentOf_(a)) {
                if ((a.ia || a.tag === 'label') && a.box.w >= T.tapMinPx && a.box.h >= T.tapMinPx) { wrapped = true; break; }
            }
            if (wrapped) { exempt.wrappedByTarget++; continue; }
            push(CODES.TAP_TARGET, e.sel, { w, h, kind: e.ia, text: e.txt || null },
                `a ${e.ia} target measures ${w}x${h}px`,
                `tap target < ${T.tapMinPx}x${T.tapMinPx}px at width <= ${T.touchMaxWidth}`, [e]);
        }
    }

    // ------------------------------------------------------------ truncation
    for (const e of els) {
        if (!onScreen(e.box)) continue;
        const ell = e.to && e.sw > e.cw + T.truncMinPx;
        const clamp = e.lc > 0 && e.sh > e.ch + T.truncMinPx;
        const cut = (e.ox === 'hidden' || e.ox === 'clip') && /nowrap|pre/.test(e.ws || '') && e.sw > e.cw + T.truncMinPx && subtreeHasText(e, 2);
        if (e.to || e.lc > 0 || cut) population.truncCandidates++;
        if (!(ell || clamp || cut)) continue;
        const how = ell ? 'ellipsis' : clamp ? `line-clamp ${e.lc}` : 'clipped nowrap';
        push(CODES.TRUNCATED_TEXT, e.sel, {
            how, scrollWidth: e.sw, clientWidth: e.cw, scrollHeight: e.sh, clientHeight: e.ch, text: e.txt || null,
        }, `text is cut by ${how}: content ${clamp ? e.sh + 'px tall in ' + e.ch : e.sw + 'px wide in ' + e.cw}px`,
        `content exceeds its box by > ${T.truncMinPx}px in a box that truncates`, [e]);
    }

    // --------------------------------------------------------- vertical rhythm
    //
    // A run of rhythmMinRepeats or more consecutive siblings with the same tag
    // and class list, stacked one under another, is a repeated section. The
    // space between consecutive ones (the gap, plus their facing padding when
    // they are unpainted, because then the padding is visible whitespace)
    // should not spread wider than rhythmTolPx.
    for (const [, sibs] of kids) {
        let run = [];
        const flush = () => {
            if (run.length >= T.rhythmMinRepeats) {
                population.rhythmRuns++;
                const spaces = [];
                for (let k = 0; k + 1 < run.length; k++) {
                    const a = run[k];
                    const b = run[k + 1];
                    const both = paintedOf(a) && paintedOf(b);
                    spaces.push(r2(b.box.t - a.box.b + (both ? 0 : a.pad[2] + b.pad[0])));
                }
                if (spread(spaces) > T.rhythmTolPx) {
                    push(CODES.RHYTHM, run[0].sel, { repeats: run.length, spacingsPx: spaces, spreadPx: r2(spread(spaces)) },
                        `${run.length} repeated ${run[0].tag} blocks are spaced ${spaces.join(', ')}px apart`,
                        `spacing spread > ${T.rhythmTolPx}px across >= ${T.rhythmMinRepeats} repeats`, run);
                }
            }
            run = [];
        };
        for (const e of sibs) {
            const prev = run[run.length - 1];
            const same = prev && prev.tag === e.tag && prev.cls === e.cls && e.box.t >= prev.box.b - 1;
            if (!same) flush();
            run.push(e);
        }
        flush();
    }

    const counts = { total: findings.length, exempt };
    for (const code of COMPONENT_CODES) {
        counts[COUNT_KEY[code]] = TOUCH_ONLY.has(code) && !touch ? null : findings.filter((f) => f.code === code).length;
    }
    return { findings, counts, population };
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
        textSampled: r.population ? r.population.textElementsSampled : null,
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
        // Element-unit on both sides, so this pair is a real fraction.
        textSampled: measured.reduce((n, r) => n + (r.population ? (r.population.textElementsSampled || 0) : 0), 0),
        textTotal: measured.reduce((n, r) => n + (r.population ? (r.population.textElementsTotal || 0) : 0), 0),
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

module.exports = {
    analyse, analyseComponents, summarise, DEFAULTS, CODES, COMPONENT_CODES, TOUCH_ONLY, COUNT_KEY,
    REFUSALS, SCROLLS, CLIPS, PINNED,
};

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
