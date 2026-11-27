#!/usr/bin/env node
'use strict';
/**
 * slider-drift.js - does a slider change size between its slides?
 *
 * A slider whose first slide is a tall photo and whose second is a shorter
 * diagram makes the frame and its controls jump on every change. A static
 * snapshot cannot see that: only one slide is showing. So this check drives
 * the slider through its own controls and measures every slide it reaches.
 *
 * Three parts, split the way the rendered-layout gate splits:
 *
 *   sliderHarvest(o)   runs INSIDE the page after toString(). op 'find' tags
 *                      every slider it recognises and returns its population;
 *                      op 'state' returns one slider's boxes right now.
 *   measureSliders()   the Node driver: clicks the real next control (or the
 *                      dots), waits until the boxes stop moving, and records
 *                      one sample per slide it saw become active.
 *   judgeSliders()     pure: the samples to SLIDER-DRIFT findings, in the
 *                      finding shape layout-checks.js analyse() emits.
 *
 * Recognised, without relying on one library: ARIA
 * (aria-roledescription="carousel"), library roots (swiper, splide, slick,
 * embla, keen) and a generic fallback (a scroll-snap row, a transform track or
 * stacked slides with one showing) that also has a previous, next or dots
 * control. Loop clones are not slides.
 *
 * A page with no slider reports found 0, never silence. A slider with one
 * slide is SKIPPED and counted. One that cannot be driven or never settles is
 * UNMEASURED with its reason, never a pass.
 *
 * A library, not a command. unslop-sweep.js capture() calls measureSliders()
 * after the probe, axe and the screenshot, because clicking changes the page.
 */
const crypto = require('crypto');

const LIMITS = {
    // Sliders driven per page, and clicks per slider.
    maxSliders: 8,
    maxSteps: 12,
    // How long a slider may keep moving after a click before it is UNMEASURED.
    settleMs: 4000,
    // Gap between the two readings that must agree before a state counts as settled.
    frameGapMs: 60,
    clickTimeoutMs: 3000,
};

/* eslint-disable no-var */
/**
 * Runs in the page, serialised by sliderSource(). The suite also calls it in
 * Node on a stub document, so coverage sees it entered.
 * @param {{op: 'find'|'state', id?: number}} o
 */
function sliderHarvest(o) {
    var ROOT = 'data-unslop-slider';
    var SCOPE = 'data-unslop-slider-scope';
    var CTL = 'data-unslop-ctl';
    var CLONE = /(^|\s)(swiper-slide-duplicate|slick-cloned|splide__slide--clone)(\s|$)/;
    var LIBS = [
        ['swiper', '.swiper, .swiper-container', '.swiper-slide'],
        ['splide', '.splide', '.splide__slide'],
        ['slick', '.slick-slider', '.slick-slide'],
        ['embla', '.embla', '.embla__slide'],
        ['keen', '.keen-slider', '.keen-slider__slide'],
        ['webflow', '.w-slider', '.w-slide'],
    ];
    // English and Romanian labels ("anterioară", "următoare"), plus arrow glyphs.
    var PREV = /(^|[^a-z])(prev|previous|back|anterio\S*|precedent\S*|[iî]napoi)([^a-z]|$)|[‹«←❮⟨]/i;
    var NEXT = /(^|[^a-z])(next|forward|urm[aă]to\S*|[iî]nainte)([^a-z]|$)|[›»→❯⟩]/i;
    var PAUSE = /(^|[^a-z])(pause|stop)([^a-z]|$)/i;
    var DOT_LABEL = /slide\s*\d|go to|\d+\s*(of|\/)\s*\d+/i;
    var DOT_GROUP = '[role="tablist"], .swiper-pagination, .slick-dots, .splide__pagination, .embla__dots, .w-slider-nav, [class*="dots"], [class*="pagination"], [class*="indicators"], [class*="bullets"]';
    var CLICKABLE = 'button, [role="button"], [role="tab"], a[href], .swiper-pagination-bullet, input[type="radio"]';

    function r2(n) { return Math.round(n * 100) / 100; }
    function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        var cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
        return Number(cs.opacity) > 0;
    }
    function box(el) {
        var r = el.getBoundingClientRect();
        return { x: r2(r.left + scrollX), y: r2(r.top + scrollY), w: r2(r.width), h: r2(r.height) };
    }
    function union(els) {
        var l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity;
        els.forEach(function (el) {
            var r = el.getBoundingClientRect();
            l = Math.min(l, r.left); t = Math.min(t, r.top); rr = Math.max(rr, r.right); b = Math.max(b, r.bottom);
        });
        return { x: r2(l + scrollX), y: r2(t + scrollY), w: r2(rr - l), h: r2(b - t) };
    }
    function cls(el) { return typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''); }
    function words(el) {
        var t = (el.textContent || '').trim();
        return [el.getAttribute('aria-label') || '', el.getAttribute('title') || '', t.length <= 24 ? t : '', cls(el)].join(' ');
    }
    function selOf(el) {
        var parts = [];
        for (var e = el, i = 0; e && e.nodeType === 1 && i < 4; e = e.parentElement, i++) {
            var s = e.tagName.toLowerCase();
            if (e.id) { parts.unshift(s + '#' + e.id); break; }
            var c = cls(e).trim().split(/\s+/).filter(Boolean).slice(0, 2);
            if (c.length) s += '.' + c.join('.');
            parts.unshift(s);
        }
        return parts.join(' > ');
    }
    function slidesOf(root, sel) {
        var list = sel ? Array.prototype.slice.call(root.querySelectorAll(sel)) : [];
        return list.filter(function (s) { return !CLONE.test(cls(s)); });
    }
    function clickables(scope) {
        return Array.prototype.slice.call(scope.querySelectorAll(CLICKABLE));
    }
    function controlsIn(scope, slides) {
        var inSlide = function (el) { return slides.some(function (s) { return s.contains(el) && s !== el; }); };
        var all = clickables(scope);
        var prev = all.filter(function (el) { return PREV.test(words(el)); });
        var next = all.filter(function (el) { return NEXT.test(words(el)) && prev.indexOf(el) < 0; });
        var pause = all.filter(function (el) { return PAUSE.test(words(el)); });
        var dots = [];
        var groups = Array.prototype.slice.call(scope.querySelectorAll(DOT_GROUP));
        // The showing group first: a slide that carries its own dots hides
        // the other slides' groups.
        groups.sort(function (a, b) { return (visible(b) ? 1 : 0) - (visible(a) ? 1 : 0); });
        for (var g = 0; g < groups.length && !dots.length; g++) {
            var items = clickables(groups[g]);
            if (!items.length) items = Array.prototype.slice.call(groups[g].children);
            items = items.filter(function (el) { return prev.indexOf(el) < 0 && next.indexOf(el) < 0 && pause.indexOf(el) < 0; });
            if (items.length >= 2) dots = items;
        }
        if (!dots.length) {
            var labelled = all.filter(function (el) { return DOT_LABEL.test(el.getAttribute('aria-label') || '') && prev.indexOf(el) < 0 && next.indexOf(el) < 0; });
            if (labelled.length >= 2) dots = labelled;
        }
        // A control inside a slide belongs to that slide's state: the
        // per-slide arrows of a hand-built slider. Only the visible one counts.
        return {
            prev: prev.filter(visible), next: next.filter(visible), pause: pause.filter(visible),
            dots: dots, prevAny: prev.length > 0, nextAny: next.length > 0, inSlide: prev.concat(next).some(inSlide),
        };
    }
    function hasControl(c) { return c.prevAny || c.nextAny || c.dots.length >= 2; }

    // ------------------------------------------------------------ find
    function genericSlides(el) {
        var kids = Array.prototype.slice.call(el.children).filter(function (k) { return k.tagName !== 'SCRIPT' && k.tagName !== 'STYLE'; });
        if (kids.length < 2) {
            // A transform track: one child that holds the slides.
            if (kids.length === 1 && kids[0].children.length >= 2) {
                var cs = getComputedStyle(el);
                var w = el.getBoundingClientRect().width;
                var track = Array.prototype.slice.call(kids[0].children);
                if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && w > 0 &&
                    track.every(function (s) { return s.getBoundingClientRect().width >= 0.6 * w; })) return { how: 'transform-track', slides: track };
            }
            return null;
        }
        var st = getComputedStyle(el);
        if (st.scrollSnapType && st.scrollSnapType !== 'none' && /auto|scroll|hidden/.test(st.overflowX)) return { how: 'scroll-snap', slides: kids };
        // Stacked slides: same tag, exactly one showing.
        var same = kids.filter(function (k) { return k.tagName === kids[0].tagName; });
        if (same.length >= 2 && same.length === kids.filter(function (k) { return !/^(BUTTON|NAV|UL|OL)$/.test(k.tagName); }).length) {
            var shown = same.filter(visible);
            if (shown.length === 1) return { how: 'stacked', slides: same, needsArrows: true };
        }
        return null;
    }
    function find() {
        Array.prototype.slice.call(document.querySelectorAll('[' + ROOT + '],[' + SCOPE + '],[' + CTL + ']')).forEach(function (el) {
            el.removeAttribute(ROOT); el.removeAttribute(SCOPE); el.removeAttribute(CTL);
        });
        var cands = [];
        var add = function (root, lib, how, slides, needsArrows) {
            if (cands.some(function (c) { return c.root === root || c.root.contains(root) || root.contains(c.root); })) return;
            cands.push({ root: root, lib: lib, how: how, slides: slides, needsArrows: !!needsArrows });
        };
        Array.prototype.slice.call(document.querySelectorAll('[aria-roledescription]')).forEach(function (el) {
            if ((el.getAttribute('aria-roledescription') || '').toLowerCase() !== 'carousel') return;
            var slides = Array.prototype.slice.call(el.querySelectorAll('[aria-roledescription]')).filter(function (s) {
                return (s.getAttribute('aria-roledescription') || '').toLowerCase() === 'slide' && !CLONE.test(cls(s));
            });
            if (!slides.length) slides = slidesOf(el, '[role="tabpanel"], [role="group"]');
            add(el, 'aria', 'aria-roledescription', slides, false);
        });
        LIBS.forEach(function (L) {
            Array.prototype.slice.call(document.querySelectorAll(L[1])).forEach(function (el) { add(el, L[0], 'library-class', slidesOf(el, L[2]), false); });
        });
        var all = document.body ? document.body.querySelectorAll('*') : [];
        for (var i = 0; i < all.length && i < 20000; i++) {
            var g = genericSlides(all[i]);
            if (g) cands.push({ root: all[i], lib: 'generic', how: g.how, slides: g.slides, needsArrows: !!g.needsArrows, generic: true });
        }
        var out = [];
        var taken = [];
        cands.forEach(function (c) {
            if (c.generic && taken.some(function (t) { return t === c.root || t.contains(c.root) || c.root.contains(t); })) return;
            // Controls: the root, else a wrapper around it (two levels for a
            // known slider, one for a generic one) that holds no other slider
            // and is not a page region: a page's pager is not a slider's control.
            var scope = c.root;
            var ctl = controlsIn(scope, c.slides);
            for (var up = 0; up < (c.generic ? 1 : 2) && !hasControl(ctl) && scope.parentElement; up++) {
                var p = scope.parentElement;
                if (/^(BODY|HTML|MAIN|ARTICLE|HEADER|FOOTER|NAV|ASIDE|FORM)$/.test(p.tagName)) break;
                if (cands.some(function (o) { return o !== c && p.contains(o.root); })) break;
                scope = p;
                ctl = controlsIn(scope, c.slides);
            }
            if (c.generic && (!hasControl(ctl) || (c.needsArrows && !ctl.prevAny && !ctl.nextAny))) return;
            if (c.generic && !visible(c.root)) return;
            taken.push(c.root);
            var id = out.length;
            c.root.setAttribute(ROOT, String(id));
            scope.setAttribute(SCOPE, String(id));
            var okEl = c.root.closest('[data-unslop-ok]');
            var lm = c.root.closest('header, nav, footer, main, aside');
            out.push({
                id: id, sel: selOf(c.root), lm: lm ? lm.tagName.toLowerCase() : null, lib: c.lib, how: c.how,
                slides: c.slides.length, visible: visible(c.root),
                controls: { prev: ctl.prevAny, next: ctl.nextAny, dots: ctl.dots.length, inSlide: ctl.inSlide },
                pause: ctl.pause.length > 0,
                ok: okEl ? (okEl.getAttribute('data-unslop-ok') || '').split(/\s+/).filter(Boolean) : [],
            });
        });
        return { sliders: out };
    }

    // ------------------------------------------------------------ state
    function slidesFor(root) {
        for (var i = 0; i < LIBS.length; i++) {
            if (root.matches(LIBS[i][1])) return slidesOf(root, LIBS[i][2]);
        }
        if ((root.getAttribute('aria-roledescription') || '').toLowerCase() === 'carousel') {
            var s = Array.prototype.slice.call(root.querySelectorAll('[aria-roledescription]')).filter(function (x) {
                return (x.getAttribute('aria-roledescription') || '').toLowerCase() === 'slide' && !CLONE.test(cls(x));
            });
            return s.length ? s : slidesOf(root, '[role="tabpanel"], [role="group"]');
        }
        var g = genericSlides(root);
        return g ? g.slides : [];
    }
    function activeOf(root, slides) {
        var cur = slides.filter(function (s) { return s.getAttribute('aria-current') && s.getAttribute('aria-current') !== 'false'; });
        if (cur.length === 1) return { i: slides.indexOf(cur[0]), how: 'aria-current' };
        var named = slides.filter(function (s) { return /(^|[\s_-])(is-)?(current|active|selected)([\s_-]|$)/.test(cls(s)); });
        var strong = named.filter(function (s) { return /current|selected/.test(cls(s)); });
        if (strong.length === 1) return { i: slides.indexOf(strong[0]), how: 'class' };
        if (named.length === 1) return { i: slides.indexOf(named[0]), how: 'class' };
        var shown = slides.filter(function (s) { return visible(s) && s.getAttribute('aria-hidden') !== 'true'; });
        if (shown.length === 1) return { i: slides.indexOf(shown[0]), how: 'only-visible' };
        var rb = root.getBoundingClientRect();
        var cx = rb.left + rb.width / 2;
        var best = -1, bestD = Infinity;
        slides.forEach(function (s, k) {
            var r = s.getBoundingClientRect();
            if (r.width <= 0) return;
            var d = Math.abs(r.left + r.width / 2 - cx);
            if (d < bestD) { bestD = d; best = k; }
        });
        return { i: best, how: 'nearest-centre' };
    }
    function state(id) {
        var root = document.querySelector('[' + ROOT + '="' + id + '"]');
        var scope = document.querySelector('[' + SCOPE + '="' + id + '"]') || root;
        if (!root) return { gone: true };
        Array.prototype.slice.call(scope.querySelectorAll('[' + CTL + ']')).forEach(function (el) { el.removeAttribute(CTL); });
        var slides = slidesFor(root);
        var ctl = controlsIn(scope, slides);
        if (ctl.prev[0]) ctl.prev[0].setAttribute(CTL, id + ':prev');
        if (ctl.next[0]) ctl.next[0].setAttribute(CTL, id + ':next');
        if (ctl.pause[0]) ctl.pause[0].setAttribute(CTL, id + ':pause');
        ctl.dots.forEach(function (d, k) { d.setAttribute(CTL, id + ':dot:' + k); });
        var shownDots = ctl.dots.filter(visible);
        var running = false;
        try {
            running = scope.getAnimations({ subtree: true }).some(function (a) { return a.playState === 'running' && !(a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming().iterations === Infinity); });
        } catch (e) { running = false; }
        var act = activeOf(root, slides);
        return {
            active: act.i, activeHow: act.how, slides: slides.length,
            box: box(root),
            prev: ctl.prev[0] ? box(ctl.prev[0]) : null,
            next: ctl.next[0] ? box(ctl.next[0]) : null,
            dots: shownDots.length ? union(shownDots) : null,
            dotCount: ctl.dots.length,
            animating: running,
        };
    }

    return o.op === 'find' ? find() : state(o.id);
}
/* eslint-enable no-var */

/** The in-page source for one operation, ready for page.evaluate(). */
function sliderSource(options) {
    return '(' + sliderHarvest.toString() + ')(' + JSON.stringify(options || {}) + ')';
}

/** Which harvester a record came from; a committed fixture pins it. */
function sliderSha() {
    return crypto.createHash('sha256').update(sliderHarvest.toString()).digest('hex').slice(0, 12);
}

const sameBox = (a, b) => (a == null && b == null) || (a != null && b != null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** Two readings of one slider agree: same active slide, same boxes. */
function sameState(a, b) {
    return !!a && !!b && a.active === b.active && sameBox(a.box, b.box) && sameBox(a.prev, b.prev) && sameBox(a.next, b.next) && sameBox(a.dots, b.dots);
}

/**
 * Read one slider until two readings a frame gap apart agree and nothing in
 * it is animating. Returns that state, or null when it never settled.
 */
async function settledState(page, id, o) {
    const until = Date.now() + o.settleMs;
    let prev = await page.evaluate(sliderSource({ op: 'state', id }));
    do {
        await page.waitForTimeout(o.frameGapMs);
        const cur = await page.evaluate(sliderSource({ op: 'state', id }));
        if (!cur || cur.gone) return null;
        if (!cur.animating && sameState(prev, cur)) return cur;
        prev = cur;
    } while (Date.now() < until);
    return null;
}

const sampleOf = (st) => ({ active: st.active, activeHow: st.activeHow, box: st.box, prev: st.prev, next: st.next, dots: st.dots });

/**
 * Drive every slider on an open page through its own controls. The page
 * should already be loaded and settled; the context should carry
 * reducedMotion 'reduce' (contextOptions does). Autoplay cannot mislabel a
 * sample: each one is keyed by the slide the page reports active, a
 * pause control is pressed when there is one, and a state counts only once it
 * holds still.
 * @returns {{status, reason, sha, found, sliders: object[]}}
 */
async function measureSliders(page, options) {
    const o = Object.assign({}, LIMITS, options || {});
    let found;
    try {
        found = await page.evaluate(sliderSource({ op: 'find' }));
    } catch (e) {
        return { status: 'UNMEASURED', reason: 'slider harvest failed: ' + String((e && e.message) || e).split('\n')[0], sha: sliderSha(), found: null, sliders: [] };
    }
    if (!found || !Array.isArray(found.sliders)) {
        return { status: 'UNMEASURED', reason: 'the slider harvest returned nothing', sha: sliderSha(), found: null, sliders: [] };
    }
    const out = { status: 'MEASURED', reason: null, sha: sliderSha(), found: found.sliders.length, sliders: [] };
    for (const s of found.sliders) {
        const rec = { id: s.id, sel: s.sel, lm: s.lm, lib: s.lib, how: s.how, slides: s.slides, controls: s.controls, ok: s.ok || [], status: null, reason: null, samples: [] };
        out.sliders.push(rec);
        if (out.sliders.length > o.maxSliders) { rec.status = 'UNMEASURED'; rec.reason = `over the ${o.maxSliders}-slider cap`; continue; }
        if (s.slides < 2) { rec.status = 'SKIPPED'; rec.reason = `${s.slides} slide${s.slides === 1 ? '' : 's'}, nothing to compare`; continue; }
        if (!s.visible) { rec.status = 'UNMEASURED'; rec.reason = 'not visible at this width'; continue; }
        if (s.pause) {
            try { await page.locator(`[data-unslop-ctl="${s.id}:pause"]`).first().click({ timeout: o.clickTimeoutMs }); rec.paused = true; } catch { rec.paused = false; }
        }
        let st = await settledState(page, s.id, o);
        if (!st) { rec.status = 'UNMEASURED'; rec.reason = `did not hold still within ${o.settleMs}ms`; continue; }
        if (st.active < 0) { rec.status = 'UNMEASURED'; rec.reason = 'no active slide could be identified'; continue; }
        const seen = new Set([st.active]);
        rec.samples.push(sampleOf(st));
        let stuck = 0;
        for (let step = 0; step < o.maxSteps && seen.size < st.slides; step++) {
            let target = null;
            if (st.next) target = `${s.id}:next`;
            else if (st.dotCount >= 2) {
                let k = 0;
                while (k < st.dotCount && seen.has(k)) k++;
                if (k < st.dotCount) target = `${s.id}:dot:${k}`;
            }
            if (!target) { rec.reason = 'no visible next control or dot left to press'; break; }
            try {
                await page.locator(`[data-unslop-ctl="${target}"]`).first().click({ timeout: o.clickTimeoutMs });
            } catch (e) {
                rec.reason = `pressing ${target.split(':').slice(1).join(' ')} failed: ` + String((e && e.message) || e).split('\n')[0];
                break;
            }
            // Off the control, so a hover style is not read as drift.
            try { await page.mouse.move(0, 0); } catch { /* no pointer on this page */ }
            const next = await settledState(page, s.id, o);
            if (!next) { rec.reason = `did not hold still within ${o.settleMs}ms after a press`; break; }
            if (next.active === st.active) { if (++stuck >= 2) { rec.reason = 'the control did not change the active slide'; break; } } else stuck = 0;
            st = next;
            if (!seen.has(st.active)) { seen.add(st.active); rec.samples.push(sampleOf(st)); }
        }
        rec.covered = seen.size;
        rec.status = seen.size >= 2 ? 'MEASURED' : 'UNMEASURED';
        if (rec.status === 'MEASURED' && seen.size < s.slides && !rec.reason) rec.reason = `reached ${seen.size} of ${s.slides} slides`;
        if (rec.status === 'UNMEASURED' && !rec.reason) rec.reason = 'only one slide was reached';
    }
    return out;
}

/** Spread of one number over the samples, with the slides at each end. */
function spreadOf(samples, pick) {
    const vals = samples.map((s) => ({ slide: s.active + 1, v: pick(s) })).filter((x) => x.v != null);
    if (vals.length < 2) return null;
    let lo = vals[0];
    let hi = vals[0];
    for (const x of vals) { if (x.v < lo.v) lo = x; if (x.v > hi.v) hi = x; }
    return { spreadPx: Math.round((hi.v - lo.v) * 100) / 100, low: { slide: lo.slide, px: lo.v }, high: { slide: hi.slide, px: hi.v } };
}

/**
 * The samples of one capture to findings. Pure.
 * @param {object} rec      measureSliders() output (snapshot.sliders)
 * @param {object} T        thresholds; reads sliderDriftTolPx
 * @param {number} width    the capture width, carried on each finding
 * @returns {{findings: object[], counts: object}}
 */
function judgeSliders(rec, T, width) {
    const tol = T.sliderDriftTolPx;
    const findings = [];
    if (!rec || rec.status !== 'MEASURED') {
        return { findings, counts: { status: 'UNMEASURED', reason: rec ? rec.reason : 'no slider record', found: null, measured: null, skipped: null, unmeasured: null, drift: null, markedOk: 0 } };
    }
    const counts = { status: 'MEASURED', reason: null, found: rec.found, measured: 0, skipped: 0, unmeasured: 0, drift: 0, markedOk: 0, maxPassingSpreadPx: 0 };
    for (const s of rec.sliders) {
        if (s.status === 'SKIPPED') { counts.skipped++; continue; }
        if (s.status !== 'MEASURED') { counts.unmeasured++; continue; }
        counts.measured++;
        const parts = {
            height: spreadOf(s.samples, (x) => x.box && x.box.h),
            width: spreadOf(s.samples, (x) => x.box && x.box.w),
            prevX: spreadOf(s.samples, (x) => x.prev && x.prev.x),
            prevY: spreadOf(s.samples, (x) => x.prev && x.prev.y),
            nextX: spreadOf(s.samples, (x) => x.next && x.next.x),
            nextY: spreadOf(s.samples, (x) => x.next && x.next.y),
            dotsX: spreadOf(s.samples, (x) => x.dots && x.dots.x + x.dots.w / 2),
            dotsY: spreadOf(s.samples, (x) => x.dots && x.dots.y),
        };
        const over = Object.entries(parts).filter(([, p]) => p && p.spreadPx > tol);
        const worst = Math.max(0, ...Object.values(parts).filter(Boolean).map((p) => p.spreadPx));
        if (!over.length) { counts.maxPassingSpreadPx = Math.max(counts.maxPassingSpreadPx, worst); continue; }
        if ((s.ok || []).includes('SLIDER-DRIFT')) { counts.markedOk++; continue; }
        counts.drift++;
        const say = over.map(([k, p]) => `${k} ${p.low.px} on slide ${p.low.slide}, ${p.high.px} on slide ${p.high.slide} (${p.spreadPx}px)`);
        findings.push({
            check: 'slider', code: 'SLIDER-DRIFT', width, sel: s.sel, lm: s.lm || null,
            detail: { lib: s.lib, how: s.how, slides: s.slides, covered: s.covered, worstPx: worst, drift: Object.fromEntries(over) },
            note: `slider changes size or moves its controls between slides: ${say.join('; ')}`,
            threshold: `spread > ${tol}px in the frame's height or width, or any control's position`,
        });
    }
    return { findings, counts };
}

module.exports = { LIMITS, sliderHarvest, sliderSource, sliderSha, sameState, settledState, measureSliders, spreadOf, judgeSliders };

if (require.main === module) {
    console.log('slider-drift.js - a library. unslop-sweep.js sweep runs it at every width.');
    console.log('It flags SLIDER-DRIFT when a slider\'s height, width or control positions differ between slides.');
    console.log(`limits: ${JSON.stringify(LIMITS)}`);
}
