#!/usr/bin/env node
'use strict';
/**
 * layout-probe.js - the BROWSER half of the rendered-layout gate.
 *
 * It harvests a snapshot of a rendered page and judges nothing. Every verdict
 * lives in layout-checks.js, which never touches a DOM. The split exists so the
 * judging half is testable in `npm test` without a browser, and so this half can
 * be pasted into whatever browser surface the calling session actually has -
 * the in-app pane's javascript_tool, chrome-devtools evaluate_script, or
 * Playwright's page.evaluate. The plugin ships the measurement; the host
 * supplies the browser.
 *
 *   node layout-probe.js --print          # the pasteable expression
 *   node layout-probe.js --print --width 360 --scroll-steps 3
 *   node layout-probe.js --sha            # hash of the harvester source
 *
 * THE MEASUREMENT THIS FILE EXISTS BECAUSE OF. `[measured 2026-09-03]` On a page
 * emulated at 360px CSS width carrying a 900px child, a real browser reports:
 *
 *     window.innerWidth ................ 900
 *     documentElement.clientWidth ...... 360
 *     documentElement.scrollWidth ...... 900
 *
 * So `scrollWidth > innerWidth` is `900 > 900`, FALSE, on a page that is
 * unmistakably overflowing sideways. innerWidth is the VISUAL viewport and moves
 * with the browser's zoom-to-fit; clientWidth is the LAYOUT viewport and does
 * not. Reproduced independently at 375px on an unrelated live page with a
 * hand-planted 900px child: innerWidth 375 -> 901, clientWidth 375 -> 375.
 *
 * At desktop widths the two are equal, so a gate authored and tested at 1280
 * ships that false green and never sees it. Every width comparison here uses
 * clientWidth, and the snapshot records both so a reader can see the divergence.
 *
 * The common rule "assert innerWidth in the same call that measures geometry"
 * catches a 0x0 pane and is worthless against this: innerWidth was 901 and
 * confidently wrong. The sufficient assertion is
 * `documentElement.clientWidth === the width you asked for`, which
 * layout-checks.js refuses to analyse without.
 *
 * WHAT IS GATED AND WHAT IS NOT, stated because a silent gap is worse than a
 * loud one. layout-checks.js is covered by tooling/test-rendered-layout-gate.js
 * against snapshots captured from a real browser. THIS file's runtime behaviour
 * is not: no suite here drives a browser, so a harvester that returned
 * structurally-empty output would not turn a suite red on its own. Two things
 * narrow that. The suite asserts the SHAPE of every committed snapshot, so an
 * empty harvest cannot be committed unnoticed. And every snapshot carries
 * `probeSha`, the hash of the harvester source that produced it; the suite fails
 * when this file changes and the fixtures were not re-captured, which converts a
 * silent harvester drift into a loud "re-capture the fixtures".
 */

const crypto = require('crypto');

/**
 * Runs INSIDE the page. Self-contained on purpose: it is stringified and
 * evaluated in a browser, so it may close over nothing from this module.
 *
 * @param {{requestedWidth:number, scrollSteps:number, maxElements:number,
 *          maxTextElements:number, label:string, probeSha:string}} opt
 */
function harvest(opt) {
    var o = opt || {};
    var REQ = typeof o.requestedWidth === 'number' ? o.requestedWidth : null;
    var STEPS = Math.max(1, o.scrollSteps || 1);
    var MAX_EL = o.maxElements || 4000;
    var MAX_TEXT = o.maxTextElements || 400;
    var doc = document;
    var de = doc.documentElement;

    // ---------------------------------------------------------------- helpers

    function shortSel(el) {
        if (!el || el.nodeType !== 1) return '?';
        var t = el.tagName.toLowerCase();
        if (el.id) return t + '#' + el.id;
        var raw = typeof el.className === 'string' ? el.className : '';
        var cls = raw.trim().split(/\s+/).filter(Boolean).slice(0, 2);
        return t + (cls.length ? '.' + cls.join('.') : '');
    }

    function selPath(el) {
        var parts = [];
        var cur = el;
        for (var i = 0; i < 3 && cur && cur.nodeType === 1; i++) {
            parts.unshift(shortSel(cur));
            cur = cur.parentElement;
        }
        return parts.join(' > ');
    }

    function r4(n) { return Math.round(n * 100) / 100; }

    function boxOf(r) {
        return {
            l: r4(r.left), t: r4(r.top), r: r4(r.right),
            b: r4(r.bottom), w: r4(r.width), h: r4(r.height),
        };
    }

    // Alpha of a computed colour. A computed colour is always rgb(...) or
    // rgba(...); the keyword `transparent` serialises as rgba(0, 0, 0, 0).
    function alphaOf(colour) {
        if (!colour) return 0;
        var m = /^rgba?\(([^)]+)\)$/.exec(String(colour).trim());
        if (!m) return 1;
        var parts = m[1].split(',');
        return parts.length >= 4 ? parseFloat(parts[3]) : 1;
    }

    // Does this element put pixels on the screen where it sits? A fully
    // transparent click-catcher hit-tests exactly like an opaque bar and covers
    // nothing, so paint has to be asked separately from hit testing. These are
    // facts; layout-checks.js decides what counts as opaque enough.
    function paintFacts(el) {
        var cs = getComputedStyle(el);
        var bf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
        return {
            bgAlpha: r4(alphaOf(cs.backgroundColor)),
            hasBgImage: cs.backgroundImage !== 'none',
            hasBackdrop: bf !== 'none',
            opacity: r4(parseFloat(cs.opacity)),
        };
    }

    // A modal owns the screen, so every word under it reads as occluded. Left
    // unflagged, one open dialog turns into a page of findings about a page
    // nobody is looking at.
    function modalKind(el, vw, vh) {
        var cur = el;
        while (cur && cur.nodeType === 1) {
            var role = cur.getAttribute ? cur.getAttribute('role') : null;
            if (role === 'dialog' || role === 'alertdialog') return 'role';
            if (cur.getAttribute && cur.getAttribute('aria-modal') === 'true') return 'aria-modal';
            if (cur.tagName === 'DIALOG' && cur.hasAttribute('open')) return 'dialog-open';
            cur = cur.parentElement;
        }
        var r = el.getBoundingClientRect();
        var area = vw * vh;
        if (area > 0 && (r.width * r.height) / area >= 0.8) return 'full-viewport';
        return null;
    }

    // -------------------------------------------------------- viewport block
    // Both widths, always. The divergence between them IS the finding on
    // mobile, and a snapshot recording only one of them could not show it.

    var metaEl = doc.querySelector('meta[name="viewport"]');
    var vp = {
        label: o.label || null,
        url: location.href,
        requestedWidth: REQ,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        clientWidth: de.clientWidth,
        clientHeight: de.clientHeight,
        scrollWidth: de.scrollWidth,
        scrollHeight: de.scrollHeight,
        bodyScrollWidth: doc.body ? doc.body.scrollWidth : null,
        devicePixelRatio: window.devicePixelRatio,
        // Without this meta the layout viewport is pinned near 980px and every
        // reading under 768 is fiction. layout-checks.js refuses on it.
        hasViewportMeta: !!metaEl,
        viewportMeta: metaEl ? metaEl.content : null,
        // Stamped so a suite going red later can tell "the analyzer regressed"
        // from "the browser moved". A rendered-geometry gate has already
        // reported different numbers on a different OS once.
        userAgent: navigator.userAgent,
        capturedAt: new Date().toISOString(),
    };

    // ------------------------------------------------------------- elements

    var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1, BR: 1 };
    var all = Array.prototype.slice.call(doc.querySelectorAll('*'));
    var considered = 0;
    var elements = [];
    var index = new Map();

    for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (SKIP[el.tagName]) continue;
        considered++;
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (elements.length >= MAX_EL) continue;
        var cs2 = getComputedStyle(el);

        // Nearest ancestor that does not let x-overflow through, and HOW it
        // stops it. auto/scroll absorb by scrolling, which is a legitimate
        // rail. hidden/clip absorb by cutting the content off, which is often
        // the defect rather than the fix - so the two are recorded apart and
        // the analyzer reports them apart.
        var clipAnc = null;
        var p = el.parentElement;
        while (p && p.nodeType === 1) {
            var pox = getComputedStyle(p).overflowX;
            if (pox && pox !== 'visible') {
                // The index is available: querySelectorAll walks in document
                // order, so an ancestor is always recorded before its children.
                clipAnc = {
                    i: index.has(p) ? index.get(p) : null,
                    sel: selPath(p),
                    overflowX: pox,
                    box: boxOf(p.getBoundingClientRect()),
                };
                break;
            }
            p = p.parentElement;
        }

        index.set(el, elements.length);
        elements.push({
            i: elements.length,
            sel: selPath(el),
            tag: el.tagName.toLowerCase(),
            box: boxOf(rect),
            position: cs2.position,
            overflowX: cs2.overflowX,
            overflowY: cs2.overflowY,
            display: cs2.display,
            zIndex: cs2.zIndex,
            clipAncestor: clipAnc,
            parent: null,
        });
    }
    for (var j = 0; j < all.length; j++) {
        var e2 = all[j];
        if (!index.has(e2)) continue;
        var pe = e2.parentElement;
        while (pe && !index.has(pe)) pe = pe.parentElement;
        elements[index.get(e2)].parent = pe ? index.get(pe) : null;
    }

    // -------------------------------------------------- text and occlusion
    // Sampled on the REAL glyph rects from a Range, never on the element box.
    // An element box is routinely far wider than the text inside it, and a bar
    // covering the empty half of a box covers no words - sampling the box
    // manufactures occlusion findings out of whitespace.

    var textTotal = 0;
    var textRecords = [];
    var scrollPositions = [];
    var modalSeen = null;
    var sampledKeys = {};

    var maxScroll = Math.max(0, de.scrollHeight - de.clientHeight);
    for (var s = 0; s < STEPS; s++) {
        var target = STEPS === 1 ? 0 : Math.round((maxScroll * s) / (STEPS - 1));
        window.scrollTo(0, target);
        var scrollY = Math.round(window.scrollY);
        if (scrollPositions.indexOf(scrollY) >= 0 && s > 0) continue;
        scrollPositions.push(scrollY);
        var vw = de.clientWidth;
        var vh = de.clientHeight;

        for (var k = 0; k < all.length; k++) {
            var te = all[k];
            if (!index.has(te)) continue;

            // A text-bearing leaf: it has a direct non-empty text child. An
            // ancestor whose text lives in descendants is not the thing being
            // covered, and counting it would double-report every wrapper.
            var own = '';
            for (var c = 0; c < te.childNodes.length; c++) {
                var n = te.childNodes[c];
                if (n.nodeType === 3) own += n.nodeValue;
            }
            if (!own.trim()) continue;
            if (s === 0) textTotal++;

            var glyphRects = [];
            for (var c2 = 0; c2 < te.childNodes.length; c2++) {
                var tn = te.childNodes[c2];
                if (tn.nodeType !== 3 || !tn.nodeValue.trim()) continue;
                var range = doc.createRange();
                range.selectNodeContents(tn);
                var rs = range.getClientRects();
                for (var q = 0; q < rs.length; q++) {
                    if (rs[q].width > 0 && rs[q].height > 0) glyphRects.push(rs[q]);
                }
            }
            if (!glyphRects.length) continue;

            // Only what is on screen right now can be hit-tested. Everything
            // else is counted and reported as unsampled, never as clean.
            var visible = [];
            for (var v = 0; v < glyphRects.length; v++) {
                var g = glyphRects[v];
                if (g.bottom > 0 && g.top < vh && g.right > 0 && g.left < vw) visible.push(g);
            }
            if (!visible.length) continue;

            var key = index.get(te) + '@' + scrollY;
            if (sampledKeys[key]) continue;
            if (textRecords.length >= MAX_TEXT) continue;
            sampledKeys[key] = 1;

            var samples = [];
            for (var g2 = 0; g2 < visible.length && samples.length < 12; g2++) {
                var gr = visible[g2];
                var ys = Math.min(Math.max(gr.top + gr.height / 2, 1), vh - 1);
                var xcands = [gr.left + gr.width * 0.15, gr.left + gr.width * 0.5, gr.left + gr.width * 0.85];
                for (var x2 = 0; x2 < xcands.length; x2++) {
                    var px = Math.min(Math.max(xcands[x2], 1), vw - 1);
                    // The full hit stack, not just the top element. The topmost
                    // hit may be a transparent catcher with an opaque bar
                    // beneath it; only walking the stack tells them apart.
                    var stack = doc.elementsFromPoint(px, ys) || [];
                    // SELF OR DESCENDANT ONLY. An ancestor being in the stack
                    // says the point is inside the ancestor, not that the text
                    // is painted there - and a glyph box that a clipping
                    // container cut away is in neither the stack nor the
                    // picture. `[measured 2026-09-03]` accepting an ancestor
                    // match re-reported every clipped paragraph as occluded by
                    // whatever sits lower on the page, one false positive per
                    // width on the clipping fixture. Recorded apart so the
                    // analyzer can call the sample inconclusive rather than
                    // guessing either way.
                    var selfAt = -1;
                    var ancestorAt = -1;
                    for (var st = 0; st < stack.length; st++) {
                        var sc = stack[st];
                        if (sc === te || te.contains(sc)) { selfAt = st; break; }
                        if (ancestorAt < 0 && sc.contains(te)) ancestorAt = st;
                    }
                    // Recorded even when the text was not hit here. What is
                    // painted at a point is a FACT; whether it occludes this
                    // particular run is a judgement, and judgement belongs in
                    // layout-checks.js. Dropping it here would also make the
                    // analyzer's own guard untestable - no mutation of the
                    // analyzer can resurrect a signal the probe never emitted.
                    var above = selfAt < 0 ? stack.slice(0) : stack.slice(0, selfAt);
                    var occ = null;
                    if (above.length) {
                        var cand = above[0];
                        var pf = paintFacts(cand);
                        occ = {
                            sel: selPath(cand),
                            bgAlpha: pf.bgAlpha,
                            hasBgImage: pf.hasBgImage,
                            hasBackdrop: pf.hasBackdrop,
                            opacity: pf.opacity,
                            modal: modalKind(cand, vw, vh),
                        };
                        if (occ.modal && !modalSeen) modalSeen = occ.modal;
                    }
                    samples.push({
                        x: r4(px), y: r4(ys),
                        // The text itself was hit here, so what sits above it
                        // is a real answer. False means the sample proves
                        // nothing either way.
                        selfHit: selfAt >= 0,
                        ancestorOnly: selfAt < 0 && ancestorAt >= 0,
                        stackDepth: stack.length,
                        above: above.length,
                        occluder: occ,
                    });
                }
            }

            textRecords.push({
                i: index.get(te),
                sel: selPath(te),
                scrollY: scrollY,
                text: own.trim().slice(0, 80),
                glyphRects: visible.slice(0, 6).map(boxOf),
                glyphRectCount: glyphRects.length,
                samples: samples,
            });
        }
    }
    window.scrollTo(0, 0);

    return {
        schema: 'autodev.layout-snapshot/1',
        probeSha: o.probeSha || null,
        viewport: vp,
        population: {
            domElements: all.length,
            considered: considered,
            recorded: elements.length,
            truncatedElements: considered > MAX_EL,
            textElementsTotal: textTotal,
            textRecords: textRecords.length,
            truncatedText: textRecords.length >= MAX_TEXT,
            scrollPositions: scrollPositions,
        },
        modalSeen: modalSeen,
        elements: elements,
        text: textRecords,
    };
}

/**
 * Hash of the harvester source. Committed snapshots carry it and the suite
 * compares, so editing this file with stale fixtures is loud rather than silent.
 */
function probeSha() {
    return crypto.createHash('sha256').update(harvest.toString()).digest('hex').slice(0, 12);
}

/** The pasteable expression. Self-contained: it closes over nothing. */
function probeSource(options) {
    const opt = Object.assign(
        { scrollSteps: 3, maxElements: 4000, maxTextElements: 400 },
        options || {}
    );
    opt.probeSha = probeSha();
    return '(' + harvest.toString() + ')(' + JSON.stringify(opt) + ')';
}

module.exports = { harvest, probeSource, probeSha };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const val = (f, d) => {
        const i = argv.indexOf(f);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
    };
    if (argv.includes('--sha')) {
        console.log(probeSha());
        process.exit(0);
    }
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('layout-probe.js - browser-side harvester for the rendered-layout gate.');
        console.log('');
        console.log('  --print               emit the pasteable expression (the default)');
        console.log('  --width <n>           the width you asked the browser for');
        console.log('  --scroll-steps <n>    scroll passes for occlusion sampling (default 3)');
        console.log('  --max-elements <n>    cap on recorded elements (default 4000)');
        console.log('  --max-text <n>        cap on sampled text records (default 400)');
        console.log('  --label <s>           free text carried into the snapshot');
        console.log('  --sha                 hash of the harvester source');
        console.log('');
        console.log('Paste the printed expression into a browser evaluation tool, save the JSON');
        console.log('it returns, then feed the saved files to rendered-layout-gate.js.');
        process.exit(0);
    }
    console.log(probeSource({
        requestedWidth: Number(val('--width', 0)) || null,
        scrollSteps: Number(val('--scroll-steps', 3)) || 3,
        maxElements: Number(val('--max-elements', 4000)) || 4000,
        maxTextElements: Number(val('--max-text', 400)) || 400,
        label: val('--label', null),
    }));
}
