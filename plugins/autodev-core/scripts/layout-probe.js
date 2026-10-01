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

    // The nearest ancestor (or self) that is an interactive control. Text
    // inside one is that control's ACCESSIBLE NAME, and clipping it away is
    // the ordinary way to build an icon button - so the analyzer has to be
    // able to tell it apart from body copy. Recorded as a fact; the judgement
    // is layout-checks.js's.
    function controlAncestor(el) {
        var cur = el;
        while (cur && cur.nodeType === 1) {
            var tag = cur.tagName;
            var role = cur.getAttribute ? cur.getAttribute('role') : null;
            if (tag === 'BUTTON' || tag === 'A' || tag === 'LABEL' || tag === 'SUMMARY'
                || tag === 'OPTION' || tag === 'LEGEND'
                || role === 'button' || role === 'link' || role === 'menuitem'
                || role === 'tab' || role === 'option') {
                return { sel: selPath(cur), tag: tag.toLowerCase(), role: role || null };
            }
            cur = cur.parentElement;
        }
        return null;
    }

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
        // The nearest fixed or sticky box at or above it. The hit at a point
        // is usually a CHILD of the pinned bar (a stripe, a button), whose own
        // position is static, so its own position alone cannot say it rides
        // with the viewport.
        var pinnedBy = null;
        for (var an = el; an && an.nodeType === 1; an = an.parentElement) {
            var ap = an === el ? cs.position : getComputedStyle(an).position;
            if (ap === 'fixed' || ap === 'sticky') { pinnedBy = ap; break; }
        }
        return {
            pinnedBy: pinnedBy,
            bgAlpha: r4(alphaOf(cs.backgroundColor)),
            hasBgImage: cs.backgroundImage !== 'none',
            hasBackdrop: bf !== 'none',
            opacity: r4(parseFloat(cs.opacity)),
            // Whether the occluder is pinned to the viewport. Content passing
            // UNDER a fixed bar as the reader scrolls is what a fixed bar is
            // for; content under one at rest means no clearance was reserved.
            // The analyzer needs the two apart.
            position: cs.position,
        };
    }

    // An ANCESTOR of the text is above it in the hit stack only through a
    // pseudo-element (a stretched-link or tap-area ::after): its own
    // background paints beneath its descendants and cannot hide them. So the
    // paint that sits over the text is the pseudo-element's, never the box's.
    function pseudoPaintFacts(el) {
        var f = paintFacts(el);
        var a = 0, img = false, bd = false;
        ['::before', '::after'].forEach(function (w) {
            var ps = getComputedStyle(el, w);
            if (!ps || ps.content === 'none' || ps.display === 'none') return;
            a = Math.max(a, alphaOf(ps.backgroundColor));
            if (ps.backgroundImage !== 'none') img = true;
            var pbf = ps.backdropFilter || ps.webkitBackdropFilter || 'none';
            if (pbf !== 'none') bd = true;
        });
        f.bgAlpha = r4(a);
        f.hasBgImage = img;
        f.hasBackdrop = bd;
        return f;
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
    var dropped = 0;
    var elements = [];
    var index = new Map();

    for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (SKIP[el.tagName]) continue;
        considered++;
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        // Count what the cap actually dropped. Comparing `considered` against
        // the cap counts zero-area elements too, and `[measured 2026-09-03]` a
        // real page with 5,250 considered and 605 recorded reported truncation
        // that never happened.
        if (elements.length >= MAX_EL) { dropped++; continue; }
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
    var sampledElementIds = {};
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
            // Counted once per ELEMENT, on the first pass only. textRecords
            // below accumulates one row per element PER SCROLL POSITION, so the
            // two are different units and must not be read as a ratio - a page
            // with 67 text elements reported 69 records, which is above 100%
            // and interpretable as nothing. `sampledElements` is the tally that
            // shares this unit and is the honest denominator's numerator.
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
            sampledElementIds[index.get(te)] = 1;

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
                        var viaPseudo = cand.contains(te);
                        var pf = viaPseudo ? pseudoPaintFacts(cand) : paintFacts(cand);
                        occ = {
                            sel: selPath(cand),
                            viaPseudo: viaPseudo,
                            bgAlpha: pf.bgAlpha,
                            hasBgImage: pf.hasBgImage,
                            hasBackdrop: pf.hasBackdrop,
                            opacity: pf.opacity,
                            position: pf.position,
                            pinnedBy: pf.pinnedBy,
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
                controlAncestor: controlAncestor(te),
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
            droppedForCap: dropped,
            truncatedElements: dropped > 0,
            // Same unit, so this pair IS a coverage fraction.
            textElementsTotal: textTotal,
            textElementsSampled: Object.keys(sampledElementIds).length,
            // A different unit: one row per element per scroll position.
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
 * Runs INSIDE the page, after harvest(). The COMPONENT half: the computed style
 * facts the component rules in layout-checks.js need, and nothing else. It
 * judges nothing either.
 *
 * WHY A SECOND FUNCTION rather than more fields in harvest(). harvest() is
 * hashed into probeSha and twenty committed real-browser snapshots carry that
 * hash; editing it would invalidate every one of them for data the overflow and
 * occlusion checks never read. This function has its own hash, componentSha,
 * and its own fixtures, so each half goes stale only when its own source moves.
 *
 * WHAT IT RECORDS per visible element (short keys, because a real page runs to
 * thousands of rows): the border box, display and flex direction, the VISIBLE
 * width of each border side (a side whose style is none or whose colour is
 * transparent counts 0), corner radii, padding, own background alpha and colour
 * beside the colour BEHIND it (a background equal to what it sits on paints
 * nothing a reader can see), a zero-blur box-shadow spread (the ring idiom), the
 * interactive kind, own text and the union of its glyph boxes, truncation
 * facts, whether it sits in a horizontal rail, its landmark, any
 * data-unslop-ok exemption, and its ::before / ::after boxes where they paint.
 *
 * @param {{componentSha:string, maxComponents:number}} opt
 */
function harvestComponents(opt) {
    var o = opt || {};
    var MAX = o.maxComponents || 3000;
    var doc = document;
    var de = doc.documentElement;
    var vw = de.clientWidth;

    // A focused control draws its focus ring, and a ring inside a bordered
    // wrapper reads as a double border. Nothing should be focused when a
    // resting layout is measured.
    if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement.blur) doc.activeElement.blur();

    function r2(n) { return Math.round(n * 100) / 100; }
    function px(v) { var n = parseFloat(v); return isNaN(n) ? 0 : r2(n); }
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
    function boxOf(r) {
        return { l: r2(r.left), t: r2(r.top), r: r2(r.right), b: r2(r.bottom), w: r2(r.width), h: r2(r.height) };
    }
    function alphaOf(colour) {
        if (!colour) return 0;
        var m = /^rgba?\(([^)]+)\)$/.exec(String(colour).trim());
        if (!m) return 1;
        var parts = m[1].split(/[\s,\/]+/).filter(Boolean);
        return parts.length >= 4 ? parseFloat(parts[3]) : 1;
    }
    function norm(colour) { return String(colour || '').replace(/\s+/g, ''); }
    var SIDES = ['Top', 'Right', 'Bottom', 'Left'];
    function borderWidths(cs) {
        var out = [];
        for (var s = 0; s < 4; s++) {
            var st = cs['border' + SIDES[s] + 'Style'];
            var w = px(cs['border' + SIDES[s] + 'Width']);
            out.push(st === 'none' || st === 'hidden' || alphaOf(cs['border' + SIDES[s] + 'Color']) < 0.05 ? 0 : w);
        }
        return out;
    }
    // The largest zero-offset, zero-blur spread among visible box-shadows: the
    // way utility CSS draws a "ring". Split on commas outside parentheses.
    function ringOf(cs) {
        var bs = cs.boxShadow;
        var best = { w: 0, inset: false };
        if (!bs || bs === 'none') return best;
        var parts = [];
        var depth = 0;
        var cur = '';
        for (var i = 0; i < bs.length; i++) {
            var ch = bs[i];
            if (ch === '(') depth++;
            if (ch === ')') depth--;
            if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
            cur += ch;
        }
        parts.push(cur);
        for (var p = 0; p < parts.length; p++) {
            var part = parts[p];
            var col = /rgba?\([^)]*\)/.exec(part);
            if (col && alphaOf(col[0]) < 0.05) continue;
            var rest = col ? part.replace(col[0], '') : part;
            var lens = rest.trim().split(/\s+/).filter(function (x) { return /px$/.test(x) || x === '0'; }).map(parseFloat);
            if (lens.length >= 4 && lens[0] === 0 && lens[1] === 0 && lens[2] === 0 && lens[3] > best.w) {
                best = { w: r2(lens[3]), inset: /\binset\b/.test(part) };
            }
        }
        return best;
    }
    var ROLES = { button: 1, link: 1, tab: 1, menuitem: 1, checkbox: 1, radio: 1, switch: 1, option: 1 };
    function interactiveKind(el) {
        var tag = el.tagName;
        if (tag === 'A') return el.hasAttribute('href') ? 'a' : null;
        if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return tag.toLowerCase();
        if (tag === 'INPUT') return el.type === 'hidden' ? null : 'input:' + el.type;
        var role = el.getAttribute('role');
        return role && ROLES[role] ? 'role:' + role : null;
    }
    function ownText(el) {
        var t = '';
        for (var c = 0; c < el.childNodes.length; c++) {
            if (el.childNodes[c].nodeType === 3) t += el.childNodes[c].nodeValue;
        }
        return t.replace(/\s+/g, ' ').trim();
    }
    function textBox(el) {
        var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (var c = 0; c < el.childNodes.length; c++) {
            var n = el.childNodes[c];
            if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
            var range = doc.createRange();
            range.selectNodeContents(n);
            var rs = range.getClientRects();
            for (var q = 0; q < rs.length; q++) {
                if (!(rs[q].width > 0 && rs[q].height > 0)) continue;
                l = Math.min(l, rs[q].left); t = Math.min(t, rs[q].top);
                r = Math.max(r, rs[q].right); b = Math.max(b, rs[q].bottom);
            }
        }
        return l === Infinity ? null : { l: r2(l), t: r2(t), r: r2(r), b: r2(b), w: r2(r - l), h: r2(b - t) };
    }
    function behindOf(el) {
        var cur = el.parentElement;
        while (cur) {
            var c = getComputedStyle(cur).backgroundColor;
            if (alphaOf(c) > 0) return norm(c);
            cur = cur.parentElement;
        }
        return 'canvas';
    }
    // Inside a horizontal rail the reader scrolls to the content, so an edge
    // position there is the rail's business, not a gutter.
    function inRail(el) {
        var cur = el.parentElement;
        while (cur && cur !== de) {
            var ox = getComputedStyle(cur).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && cur.scrollWidth > cur.clientWidth + 1) return true;
            cur = cur.parentElement;
        }
        return false;
    }
    var LANDMARK = 'header,nav,footer,aside,main,dialog,[role=banner],[role=navigation],[role=contentinfo],[role=dialog]';
    function landmarkOf(el) {
        var lm = el.closest ? el.closest(LANDMARK) : null;
        return lm ? shortSel(lm) : null;
    }
    // An exemption is a reviewed attribute in the product's source, never a
    // flag on the command line: data-unslop-ok="TRUNCATED-TEXT TAP-TARGET".
    function okOf(el) {
        var holder = el.closest ? el.closest('[data-unslop-ok]') : null;
        return holder ? holder.getAttribute('data-unslop-ok').split(/[\s,]+/).filter(Boolean) : [];
    }
    function pseudoBoxes(el, rect, cs) {
        var out = [];
        var which = ['before', 'after'];
        for (var w = 0; w < 2; w++) {
            var ps = getComputedStyle(el, '::' + which[w]);
            if (!ps || ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
            var pw = px(ps.width);
            var ph = px(ps.height);
            if (!(pw > 0 && ph > 0)) continue;
            var pos = ps.position;
            var box = null;
            if (pos === 'absolute' || pos === 'fixed') {
                // The containing block of an absolute pseudo-element is its
                // host's padding box when the host is positioned, which is the
                // case this records; a fixed one is placed against the viewport.
                var bl = px(cs.borderLeftWidth);
                var bt = px(cs.borderTopWidth);
                var br = px(cs.borderRightWidth);
                var bb = px(cs.borderBottomWidth);
                var ox0 = pos === 'fixed' ? 0 : rect.left + bl;
                var oy0 = pos === 'fixed' ? 0 : rect.top + bt;
                var cbw = pos === 'fixed' ? vw : rect.width - bl - br;
                var cbh = pos === 'fixed' ? de.clientHeight : rect.height - bt - bb;
                var x = ps.left !== 'auto' ? ox0 + px(ps.left) : (ps.right !== 'auto' ? ox0 + cbw - px(ps.right) - pw : ox0);
                var y = ps.top !== 'auto' ? oy0 + px(ps.top) : (ps.bottom !== 'auto' ? oy0 + cbh - px(ps.bottom) - ph : oy0);
                box = { l: r2(x), t: r2(y), r: r2(x + pw), b: r2(y + ph), w: pw, h: ph };
            }
            out.push({
                w: which[w], pos: pos, box: box, wd: pw, ht: ph,
                bg: r2(alphaOf(ps.backgroundColor)), img: ps.backgroundImage !== 'none',
            });
        }
        return out;
    }

    var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1, BR: 1, NOSCRIPT: 1, TEMPLATE: 1, 'NEXTJS-PORTAL': 1 };
    var all = Array.prototype.slice.call(doc.querySelectorAll('*'));
    var recs = [];
    var index = new Map();
    var dropped = 0;
    var hidden = 0;
    for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (SKIP[el.tagName]) continue;
        var rect = el.getBoundingClientRect();
        // Under 2px on either axis is the visually-hidden idiom or a hairline,
        // neither of which a component rule has anything to say about.
        if (rect.width < 2 || rect.height < 2) continue;
        if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) { hidden++; continue; }
        if (recs.length >= MAX) { dropped++; continue; }
        var cs = getComputedStyle(el);
        var txt = ownText(el);
        var ring = ringOf(cs);
        var ol = cs.outlineStyle !== 'none' && alphaOf(cs.outlineColor) >= 0.05 ? px(cs.outlineWidth) : 0;
        var bga = alphaOf(cs.backgroundColor);
        var parentText = el.parentElement ? ownText(el.parentElement) : '';
        var lc = parseInt(cs.webkitLineClamp || cs.lineClamp, 10);
        index.set(el, recs.length);
        recs.push({
            i: recs.length,
            p: null,
            sel: selPath(el),
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className : '').trim().slice(0, 160),
            box: boxOf(rect),
            d: cs.display,
            fd: cs.flexDirection,
            pos: cs.position,
            bw: borderWidths(cs),
            br: [px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius), px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius)],
            pad: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
            bg: r2(bga),
            bgc: bga > 0 ? norm(cs.backgroundColor) : null,
            behind: behindOf(el),
            img: cs.backgroundImage !== 'none',
            ring: ring.w,
            ringInset: ring.inset,
            ol: ol,
            ia: interactiveKind(el),
            dis: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
            txt: txt.slice(0, 60),
            tb: txt ? textBox(el) : null,
            // Display inline inside a run of text: the WCAG target-size
            // exception for a link in a sentence.
            inl: cs.display === 'inline' && !!parentText,
            to: cs.textOverflow === 'ellipsis',
            lc: isNaN(lc) ? 0 : lc,
            ws: cs.whiteSpace,
            ox: cs.overflowX,
            oy: cs.overflowY,
            sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
            rail: inRail(el),
            lm: landmarkOf(el),
            ok: okOf(el),
            ps: pseudoBoxes(el, rect, cs),
        });
    }
    for (var j = 0; j < all.length; j++) {
        var e2 = all[j];
        if (!index.has(e2)) continue;
        var pe = e2.parentElement;
        while (pe && !index.has(pe)) pe = pe.parentElement;
        recs[index.get(e2)].p = pe ? index.get(pe) : null;
    }
    return {
        schema: 'autodev.components/1',
        sha: o.componentSha || null,
        clientWidth: vw,
        considered: all.length,
        recorded: recs.length,
        hiddenSkipped: hidden,
        droppedForCap: dropped,
        truncated: dropped > 0,
        elements: recs,
    };
}

/**
 * Hash of the harvester source. Committed snapshots carry it and the suite
 * compares, so editing this file with stale fixtures is loud rather than silent.
 */
function probeSha() {
    return crypto.createHash('sha256').update(harvest.toString()).digest('hex').slice(0, 12);
}

/** The same guard for the component half, with its own fixtures. */
function componentSha() {
    return crypto.createHash('sha256').update(harvestComponents.toString()).digest('hex').slice(0, 12);
}

/**
 * The pasteable expression. Self-contained: it closes over nothing. It runs
 * harvest(), then harvestComponents() into `components`. A component harvest
 * that throws leaves the overflow and occlusion snapshot intact and records the
 * error, so the component rules report UNMEASURED rather than a clean zero.
 */
function probeSource(options) {
    const opt = Object.assign(
        { scrollSteps: 3, maxElements: 4000, maxTextElements: 400, maxComponents: 3000 },
        options || {}
    );
    opt.probeSha = probeSha();
    opt.componentSha = componentSha();
    return '(function (o) { var s = (' + harvest.toString() + ')(o); ' +
        'try { s.components = (' + harvestComponents.toString() + ')(o); } ' +
        'catch (e) { s.components = { schema: "autodev.components/1", error: String(e && e.message || e) }; } ' +
        'return s; })(' + JSON.stringify(opt) + ')';
}

module.exports = { harvest, harvestComponents, probeSource, probeSha, componentSha };

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
    if (argv.includes('--component-sha')) {
        console.log(componentSha());
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
        console.log('  --component-sha       hash of the component harvester source');
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
