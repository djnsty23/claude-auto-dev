#!/usr/bin/env node
'use strict';
// Suite for the rendered-layout gate: layout-probe.js, layout-checks.js and
// rendered-layout-gate.js.
//
// WHAT IT RUNS AGAINST. Twenty snapshots in tooling/fixtures/layout/snapshots,
// captured from a REAL browser at 360, 390, 414, 768 and 1280 across four
// fixture pages. They are not hand-written, on purpose: a snapshot invented here
// would encode this suite's own model of what a browser returns, and every
// assertion over it would pass by construction. The bug that made this rule
// worth following is below - the analyzer's first version had a false positive
// that only real captured hit-stacks could show.
//
// THE FOUR FIXTURES, one control and three planted defects:
//
//   clean.html            four things that LOOK like defects to a rectangle
//                         checker and are none: a carousel under overflow-x
//                         auto, a transparent click-catcher over body text, a
//                         badge overhanging a card, a fixed header. Must report
//                         zero at every width, or the gate is not safe to run.
//   defect-overflow.html  a 900px table in a fluid page. Present at 360-768,
//                         absent at 1280.
//   defect-occlusion.html an opaque fixed bar with no clearance, over a heading.
//   defect-clip.html      a 72px overflow:hidden panel holding four paragraphs,
//                         beside an identical overflow:auto panel that must stay
//                         silent.
//
// Run: node tooling/test-rendered-layout-gate.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECKS = require(path.resolve(ROOT, 'plugins', 'autodev-core', 'scripts', 'layout-checks.js'));
const PROBE = require(path.resolve(ROOT, 'plugins', 'autodev-core', 'scripts', 'layout-probe.js'));
const GATE = path.resolve(ROOT, 'plugins', 'autodev-core', 'scripts', 'rendered-layout-gate.js');
const SNAPS = path.resolve(ROOT, 'tooling', 'fixtures', 'layout', 'snapshots');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail !== undefined ? '\n      -> ' + JSON.stringify(detail) : ''));
}

const WIDTHS = [360, 390, 414, 768, 1280];
const PAGES = ['clean', 'defect-overflow', 'defect-occlusion', 'defect-clip'];
const load = (n) => JSON.parse(fs.readFileSync(path.join(SNAPS, n + '.json'), 'utf8'));
const at = (page, w) => CHECKS.analyse(load(`${page}-${w}`));

// ------------------------------------------------ the fixtures are all there

const files = fs.existsSync(SNAPS) ? fs.readdirSync(SNAPS).filter((f) => f.endsWith('.json')) : [];
check('20 snapshots are committed (4 pages x 5 widths)', files.length === 20, files.length);
for (const p of PAGES) {
    for (const w of WIDTHS) {
        check(`${p}-${w}.json exists`, files.includes(`${p}-${w}.json`));
    }
}

// ------------------------------------------------------- the staleness guard
//
// The browser half of this gate is driven by no suite here, so a harvester edit
// with stale fixtures would otherwise change every downstream number silently.
// Each snapshot carries the hash of the harvester that produced it.

{
    const current = PROBE.probeSha();
    const shas = new Set(files.map((f) => JSON.parse(fs.readFileSync(path.join(SNAPS, f), 'utf8')).probeSha));
    check('every snapshot was captured by ONE harvester version', shas.size === 1, [...shas]);
    check('and it is the harvester in the tree right now - if this fails, re-capture the fixtures ' +
        '(node plugins/autodev-core/scripts/rendered-layout-gate.js --how)',
        shas.has(current), { current, inFixtures: [...shas] });
}

// -------------------------------------------------------- the harvest is real
//
// Shape assertions, because an empty harvest is the failure mode a browserless
// suite cannot otherwise see. A structurally-empty snapshot must never be
// committable unnoticed.

for (const p of PAGES) {
    const s = load(`${p}-390`);
    check(`${p}: the snapshot carries a viewport block`, !!s.viewport && s.viewport.clientWidth > 0);
    check(`${p}: it records the layout AND visual viewport separately`,
        typeof s.viewport.clientWidth === 'number' && typeof s.viewport.innerWidth === 'number');
    check(`${p}: it stamps the browser`, typeof s.viewport.userAgent === 'string' && s.viewport.userAgent.length > 20);
    check(`${p}: it recorded elements`, Array.isArray(s.elements) && s.elements.length > 0, s.elements && s.elements.length);
    check(`${p}: every element carries a box with a right edge`,
        s.elements.every((e) => e.box && typeof e.box.r === 'number'));
    check(`${p}: it recorded text runs`, Array.isArray(s.text) && s.text.length > 0, s.text && s.text.length);
    check(`${p}: text runs carry real glyph boxes, not element boxes`,
        s.text.every((t) => Array.isArray(t.glyphRects) && t.glyphRects.length > 0));
    check(`${p}: occlusion was sampled behaviourally`,
        s.text.every((t) => Array.isArray(t.samples)) && s.text.some((t) => t.samples.length > 0));
    check(`${p}: the population is reported`, s.population && s.population.recorded > 0);
}

// ------------------------------------------- THE MEASUREMENT THE GATE RESTS ON
//
// window.innerWidth is the VISUAL viewport and follows a mobile browser's
// zoom-to-fit, so on an overflowing page it grows to match scrollWidth and the
// obvious test silently answers false. Asserted against the real captures, so
// the day somebody "simplifies" this the suite names the widths that went
// blind rather than going quietly green.

{
    const naiveCatches = [];
    const realCatches = [];
    for (const w of WIDTHS) {
        const v = load(`defect-overflow-${w}`).viewport;
        if (v.scrollWidth > v.innerWidth) naiveCatches.push(w);
        if (v.scrollWidth > v.clientWidth) realCatches.push(w);
    }
    check('the planted overflow is real at 360, 390, 414 and 768',
        JSON.stringify(realCatches) === JSON.stringify([360, 390, 414, 768]), realCatches);
    check('and scrollWidth > innerWidth sees it at 768 ONLY - it is blind at every phone width',
        JSON.stringify(naiveCatches) === JSON.stringify([768]), naiveCatches);
    // The mechanism, not just the outcome: at the phone widths innerWidth has
    // been dragged out to the content width, which is what makes them equal.
    for (const w of [360, 390, 414]) {
        const v = load(`defect-overflow-${w}`).viewport;
        check(`at ${w}, innerWidth (${v.innerWidth}) tracks scrollWidth (${v.scrollWidth}), not the layout viewport (${v.clientWidth})`,
            v.innerWidth === v.scrollWidth && v.clientWidth === w);
    }
}

// ------------------------------------------------------- item 6: overflow

for (const w of [360, 390, 414, 768]) {
    const r = at('defect-overflow', w);
    check(`overflow @${w}: measured`, r.status === 'MEASURED', r.reason);
    check(`overflow @${w}: the document is reported as scrolling sideways`, r.counts.docScroll === 1, r.counts);
    check(`overflow @${w}: exactly one culprit, not the whole subtree`, r.counts.overflowCulprit === 1, r.counts);
    const culprit = r.findings.find((f) => f.code === CHECKS.CODES.OVERFLOW_CULPRIT);
    check(`overflow @${w}: a culprit finding exists to inspect`, !!culprit, r.findings.map((f) => f.code));
    check(`overflow @${w}: the culprit is the table, not a cell`,
        !!culprit && /table\.rates$/.test(culprit.sel), culprit && culprit.sel);
    check(`overflow @${w}: its descendants were collapsed away`, r.counts.exempt.ancestorAlreadyOverflows > 5,
        r.counts.exempt.ancestorAlreadyOverflows);
    check(`overflow @${w}: it fires no other check`, r.counts.clippedText === 0 && r.counts.occluded === 0, r.counts);
}
{
    const r = at('defect-overflow', 1280);
    check('overflow @1280: silent, the table fits', r.findings.length === 0, r.findings.map((f) => f.code));
}

// ------------------------------------------------------- item 2: occlusion

for (const w of WIDTHS) {
    const r = at('defect-occlusion', w);
    check(`occlusion @${w}: exactly one covered text run`, r.counts.occluded === 1, r.counts);
    const f = r.findings.find((x) => x.code === CHECKS.CODES.TEXT_OCCLUDED);
    check(`occlusion @${w}: an occlusion finding exists to inspect`, !!f, r.findings.map((x) => x.code));
    check(`occlusion @${w}: the heading is the covered run`, !!f && /h1$/.test(f.sel), f && f.sel);
    check(`occlusion @${w}: the bar is named as the occluder`,
        !!f && /promo/.test(f.detail.occluder), f && f.detail.occluder);
    check(`occlusion @${w}: the occluder is opaque`,
        !!f && f.detail.occluderAlpha >= 0.5, f && f.detail.occluderAlpha);
    check(`occlusion @${w}: the paragraphs clear of the bar are NOT reported`,
        r.counts.occluded === 1 && r.population.textRecords > 1, r.population);
    check(`occlusion @${w}: it fires no other check`,
        r.counts.docScroll === 0 && r.counts.overflowCulprit === 0 && r.counts.clippedText === 0, r.counts);
}

// ------------------------------------- item 6, the half an exemption swallows
//
// hidden and auto both stop x-overflow, and treating them alike is how a real
// defect gets exempted. The fixture puts the two side by side with identical
// copy and identical height so the ONLY difference is which one the reader can
// scroll.

for (const w of [360, 390, 414, 768]) {
    const r = at('defect-clip', w);
    check(`clip @${w}: three cut-off runs reported`, r.counts.clippedText === 3, r.counts);
    check(`clip @${w}: every one is inside the hidden panel`,
        r.findings.filter((f) => f.code === CHECKS.CODES.CLIPPED_TEXT)
            .every((f) => /section\.panel$/.test(f.detail.container)),
        r.findings.filter((f) => f.code === CHECKS.CODES.CLIPPED_TEXT).map((f) => f.detail.container));
    check(`clip @${w}: the identical SCROLLING panel is exempted, not reported`,
        r.counts.exempt.scrollableClip === 3, r.counts.exempt);
    check(`clip @${w}: the page does not scroll sideways, so item 6's other half stays silent`,
        r.counts.docScroll === 0 && r.counts.overflowCulprit === 0, r.counts);
    // THE REGRESSION LOCK. The analyzer's first version accepted an ANCESTOR
    // match when asking "is the text at this point", so a glyph box the panel
    // had clipped away still resolved to main.wrap, and whatever was painted
    // lower on the page was reported as covering it. One false TEXT-OCCLUDED
    // per width, on a page with no overlay at all. Found by the fixture, not by
    // reading the code.
    check(`clip @${w}: clipped text is NOT also reported as occluded`, r.counts.occluded === 0, r.counts);
    check(`clip @${w}: the unusable samples are counted rather than silently dropped`,
        r.counts.exempt.inconclusiveSamples > 0, r.counts.exempt);
}
// ------------------------------- an ancestor that CLIPS also stops the scroll
//
// FOUND ON A REAL PAGE, not on a fixture. MDN's overflow article carries a 534px
// demo iframe inside a `div.code-example` with overflow-x hidden and a right
// edge of 374, on a page whose scrollWidth equals its clientWidth. The first
// version of the exemption covered only auto/scroll, so `hidden` fell through
// and the report printed "extends past the layout viewport with nothing to
// absorb it" while something plainly had absorbed it - a finding contradicting
// its own note.
//
// The shape is reproduced locally rather than by committing 200KB of a third
// party's geometry that goes stale on their next redesign: a 500px block inside
// the clipping panel, wider than the viewport at every phone width.

for (const w of [360, 390, 414]) {
    const s = load(`defect-clip-${w}`);
    const cw = s.viewport.clientWidth;
    const wide = s.elements.find((e) => /wide-in-clip/.test(e.sel));
    check(`clip @${w}: the control element exists and is wider than the viewport`,
        !!wide && wide.box.r > cw + 1, wide && { right: wide.box.r, cw });
    check(`clip @${w}: it is absorbed by a CLIPPING ancestor, not a scrolling one`,
        wide && wide.clipAncestor && CHECKS.CLIPS.has(wide.clipAncestor.overflowX),
        wide && wide.clipAncestor);
    check(`clip @${w}: and the page does not scroll sideways because of it`,
        s.viewport.scrollWidth === s.viewport.clientWidth,
        { sw: s.viewport.scrollWidth, cw: s.viewport.clientWidth });
    const r = CHECKS.analyse(s);
    check(`clip @${w}: so it is NOT reported as an overflow culprit`,
        r.counts.overflowCulprit === 0, r.findings.map((f) => `${f.code} ${f.sel}`));
    check(`clip @${w}: it is counted as clip-absorbed, apart from the rail case`,
        r.counts.exempt.clipAbsorbed === 1 && r.counts.exempt.scrollerAbsorbed === 0, r.counts.exempt);
}

{
    // A genuine responsive difference, not noise: at 1280 the first paragraph
    // fits on one line inside the 72px panel and is not cut off.
    const r = at('defect-clip', 1280);
    check('clip @1280: two runs, because the first paragraph now fits', r.counts.clippedText === 2, r.counts);
}

// ------------------- a viewport-pinned bar covers what you scroll beneath it
//
// FOUND BY THE CLEAN CONTROL, once it grew tall enough to scroll. Its own fixed
// header covers the h1 at scrollY 64 and 127, and nothing is wrong with that
// page - that is what a fixed header does. Text under one AT REST is the defect,
// because it means the layout reserved no clearance, and that is exactly where
// defect-occlusion.html's finding sits.
//
// Without this the check fires on every site with a sticky header, at every
// scroll step, and the real finding drowns in the noise.

{
    const s = load('clean-360');
    check('the clean control is tall enough to scroll, so the case is exercised',
        s.population.scrollPositions.length > 1, s.population.scrollPositions);
    const bar = s.elements.find((e) => /header\.bar/.test(e.sel));
    check('its header is viewport-pinned', bar && CHECKS.PINNED.has(bar.position), bar && bar.position);
    // The known positive: the bar really is over the heading once scrolled, and
    // really is opaque. Without this the exemption could be passing because
    // nothing was ever covered.
    const scrolled = s.text.filter((t) => (t.scrollY || 0) > 0
        && (t.samples || []).some((x) => x.occluder && /header\.bar/.test(x.occluder.sel) && x.occluder.bgAlpha >= 0.5));
    check('and it really does cover text once scrolled', scrolled.length > 0, scrolled.length);
    check('so the clean control still reports nothing', CHECKS.analyse(s).counts.occluded === 0);
}
{
    // The other side: the planted defect sits at rest, and must still fire.
    const r = at('defect-occlusion', 390);
    check('the planted occlusion is at scrollY 0, where clearance should have been',
        r.findings.every((f) => (f.scrollY || 0) === 0), r.findings.map((f) => f.scrollY));
    check('and it is still reported', r.counts.occluded === 1, r.counts);
}

// ------------------------------- text inside a control is a name, not body copy
//
// FOUND ON A REAL PAGE. Wikipedia at 390 produced 25 CLIPPED-TEXT findings and
// 23 were "Search" / "Watch" / "Edit" labels inside 44x44 icon buttons - present
// for a screen reader, hidden on purpose, and structurally identical to a
// paragraph cut off by a panel.
//
// Neither of the obvious discriminators works. Container SIZE cannot: 44x44 is a
// real tap target, not the 1px visually-hidden idiom. Clipped FRACTION cannot
// either: a hidden label and a paragraph entirely inside a clipping panel are
// both 100%, and two of the three planted runs in defect-clip.html are exactly
// 100%. What the text IS decides it.

// The clean control now carries the shape itself: two 44x44 icon buttons whose
// labels are clipped away. Without the exemption the clean page reports them,
// which is what makes the exemption testable rather than merely present. Before
// this fixture existed a mutant removing the exemption SURVIVED the suite - the
// branch was untested by construction, which is the shape of a gate that cannot
// fail.
for (const w of WIDTHS) {
    const s = load(`clean-${w}`);
    const labels = s.text.filter((t) => t.controlAncestor);
    check(`clean @${w}: the icon-button labels are present and inside a control`,
        labels.length >= 2, labels.length);
    check(`clean @${w}: each is clipped away by its own 44x44 button`,
        labels.filter((t) => {
            const ca = s.elements[t.i].clipAncestor;
            return ca && CHECKS.CLIPS.has(ca.overflowX)
                && t.glyphRects.some((g) => g.r > ca.box.r + 1 || g.b > ca.box.b + 1);
        }).length >= 2,
        labels.map((t) => t.text));
    const r = CHECKS.analyse(s);
    check(`clean @${w}: and they are exempted, not reported`,
        r.counts.exempt.controlLabel >= 2 && r.counts.clippedText === 0, r.counts);
}

{
    const s = load('defect-clip-390');
    check('the planted runs are body copy, with no control ancestor',
        s.text.every((t) => !t.controlAncestor),
        s.text.filter((t) => t.controlAncestor).map((t) => t.sel));
    // So the exemption is INERT on the fixtures. That matters: an exemption that
    // fires here could be masking a planted defect, and this says it is not.
    const r = CHECKS.analyse(s);
    check('so the control-label exemption is inert on the planted defects',
        r.counts.exempt.controlLabel === 0 && r.counts.clippedText === 3, r.counts);
}

// ---------------------------------------- a check with no input reports no input
//
// FOUND ON A REAL PAGE TOO. A bot-challenge interstitial harvested 3 elements
// and 0 text runs, and reported a confident zero for both text-based codes - a
// zero from a check that had nothing to look at, which is a claim about the
// probe rather than about the page.

{
    const empty = load('clean-390');
    empty.text = [];
    const r = CHECKS.analyse(empty);
    check('with no text sampled, the run is still MEASURED', r.status === 'MEASURED', r.reason);
    check('but the text-based counts are null, not zero',
        r.counts.clippedText === null && r.counts.occluded === null, r.counts);
    check('and the element-based counts still answer',
        typeof r.counts.docScroll === 'number' && typeof r.counts.overflowCulprit === 'number', r.counts);
    check('coverage is stated rather than implied', r.counts.textCovered === false, r.counts);
    // The control: with text present they are numbers, so null means "not
    // covered" rather than "always null".
    const full = CHECKS.analyse(load('clean-390'));
    check('control: with text present the same counts are numbers',
        full.counts.clippedText === 0 && full.counts.occluded === 0 && full.counts.textCovered === true,
        full.counts);
}

// ------------------------------------------------- the false-positive control
//
// The number that decides whether this is safe to run at all.

for (const w of WIDTHS) {
    const r = at('clean', w);
    check(`clean @${w}: measured`, r.status === 'MEASURED', r.reason);
    check(`clean @${w}: ZERO findings`, r.findings.length === 0,
        r.findings.map((f) => `${f.code} ${f.sel}`));
}

// ...and the exemptions are load-bearing rather than dead code. Every one of
// these is an element a naive check WOULD report on the page that has nothing
// wrong with it.
{
    const s = load('clean-390');
    const cw = s.viewport.clientWidth;
    const overflowing = s.elements.filter((e) => e.box.r > cw + 1);
    check('clean: the control really does contain elements past the viewport edge',
        overflowing.length >= 5, overflowing.length);
    check('clean: and every one of them sits under a scroller that absorbs it',
        overflowing.every((e) => e.clipAncestor && CHECKS.SCROLLS.has(e.clipAncestor.overflowX)),
        overflowing.map((e) => e.sel));
    const r = CHECKS.analyse(s);
    check('clean: so the exemption suppressed them all', r.counts.exempt.scrollerAbsorbed === overflowing.length,
        { exempt: r.counts.exempt.scrollerAbsorbed, overflowing: overflowing.length });
    check('clean: the transparent click-catcher was seen and correctly not counted',
        r.counts.exempt.transparentOccluder > 0, r.counts.exempt);
}

// -------------------------------------------------------------- the refusals
//
// Three states, not two. A gate that cannot answer must say so: a guess is
// indistinguishable from a measurement once it reaches a report.

{
    const base = () => load('clean-390');

    const zero = base(); zero.viewport.clientWidth = 0; zero.viewport.clientHeight = 0;
    check('refuses a 0x0 viewport', CHECKS.analyse(zero).reason === CHECKS.REFUSALS.ZERO_VIEWPORT);

    // The one the standard advice misses. innerWidth is fine and non-zero here;
    // the LAYOUT viewport is not the width that was asked for, so the reading
    // describes a different page than its label claims.
    const mismatch = base(); mismatch.viewport.requestedWidth = 360;
    const mr = CHECKS.analyse(mismatch);
    check('refuses when the resize did not take, even with a healthy innerWidth',
        mr.reason === CHECKS.REFUSALS.WIDTH_MISMATCH, { reason: mr.reason, iw: mismatch.viewport.innerWidth });

    const nometa = base(); nometa.viewport.hasViewportMeta = false;
    check('refuses a mobile width on a page with no viewport meta',
        CHECKS.analyse(nometa).reason === CHECKS.REFUSALS.NO_VIEWPORT_META);
    const nometaDesktop = load('clean-1280'); nometaDesktop.viewport.hasViewportMeta = false;
    check('but allows it at 1280, where the meta changes nothing',
        CHECKS.analyse(nometaDesktop).status === 'MEASURED');

    const empty = base(); empty.elements = [];
    check('refuses an empty harvest rather than calling it a clean page',
        CHECKS.analyse(empty).reason === CHECKS.REFUSALS.NO_ELEMENTS);

    check('refuses a non-snapshot', CHECKS.analyse(null).reason === CHECKS.REFUSALS.NO_SNAPSHOT);
    check('refuses garbage', CHECKS.analyse({ hello: 'world' }).reason === CHECKS.REFUSALS.NO_SNAPSHOT);

    for (const bad of [zero, mismatch, nometa, empty]) {
        const r = CHECKS.analyse(bad);
        check('a refusal reports no findings either way', r.status === 'UNMEASURED' && r.findings.length === 0);
        check('and says why in words', typeof r.detail === 'string' && r.detail.length > 20, r.detail);
    }
}

// -------------------------------------------------------------- thresholds
//
// Every threshold travels with the finding it produced, so a reader who
// disagrees can see the number rather than argue about the verdict.

{
    const r = at('defect-occlusion', 390);
    check('every finding carries the threshold that produced it',
        r.findings.every((f) => typeof f.threshold === 'string' && f.threshold.length > 0));
    check('and the run reports the whole threshold set', r.thresholds && r.thresholds.occlusionMinFraction === 0.25);

    // They are knobs and behave like knobs.
    const strict = CHECKS.analyse(load('defect-occlusion-390'), { occlusionMinFraction: 0.99 });
    check('raising the occlusion threshold suppresses the finding', strict.counts.occluded === 0, strict.counts);
    // The clip knob has to be tested at a real boundary. Two of the three runs
    // in the hidden panel are cut off ENTIRELY, fraction 1.0, so no threshold
    // at or below 1 can suppress them and asserting 0 here would only be
    // asserting that 1 >= 0.99 is false. The partial run sits at 0.67, which is
    // the only place the knob can be observed moving.
    const partial = CHECKS.analyse(load('defect-clip-390'))
        .findings.filter((f) => f.code === CHECKS.CODES.CLIPPED_TEXT)
        .map((f) => f.detail.fraction).sort((a, b) => a - b);
    check('the three cut-off runs are one partial and two total', partial.length === 3 && partial[1] === 1 && partial[2] === 1
        && partial[0] > 0.25 && partial[0] < 1, partial);
    const tighter = CHECKS.analyse(load('defect-clip-390'), { clipMinFraction: 0.9 });
    check('raising the clip threshold past the partial run drops exactly that one',
        tighter.counts.clippedText === 2, tighter.counts);
    const impossible = CHECKS.analyse(load('defect-clip-390'), { clipMinFraction: 1.01 });
    check('and a threshold above 1 suppresses every one', impossible.counts.clippedText === 0, impossible.counts);
    // An opaque bar must stay a finding right up to full opacity, or the
    // threshold is set somewhere that cannot catch the canonical case.
    const alpha = CHECKS.analyse(load('defect-occlusion-390'), { occluderMinAlpha: 1 });
    check('an alpha threshold of 1 still catches a fully opaque bar', alpha.counts.occluded === 1, alpha.counts);
}

// ------------------------------------------------------------- the summary

{
    const results = WIDTHS.map((w) => at('defect-overflow', w));
    const s = CHECKS.summarise(results);
    check('summarise counts every width', s.widths === 5 && s.measured === 5 && s.refused === 0, s);
    check('summarise reports the population it scanned', s.elementsScanned > 0 && s.textSampled > 0, s);
    // The responsive answer, which is the whole reason nothing is collapsed to
    // a single verdict.
    check('summarise names the widths a code fired at',
        JSON.stringify(s.widthsByCode[CHECKS.CODES.DOC_SCROLL]) === JSON.stringify([360, 390, 414, 768]),
        s.widthsByCode);
    check('and leaves the width it did not fire at out',
        !s.widthsByCode[CHECKS.CODES.DOC_SCROLL].includes(1280));
}

// -------------------------------------------------------- the browser payload

{
    const src = PROBE.probeSource({ requestedWidth: 360 });
    let compiles = true;
    try { new Function('return ' + src); } catch { compiles = false; }
    check('the probe compiles as a browser expression', compiles);
    const body = PROBE.harvest.toString();
    // It is stringified and evaluated in a page, so it may close over nothing
    // from this module and may not reach for a Node global.
    check('the probe requires nothing', !/\brequire\s*\(/.test(body));
    check('the probe touches no Node global', !/\bprocess\.|\b__dirname\b|\bmodule\./.test(body));
    check('the probe reads the LAYOUT viewport', /clientWidth/.test(body));
    check('the probe measures text with a Range, not element boxes', /createRange|getClientRects/.test(body));
    check('the probe hit-tests rather than comparing rectangles', /elementsFromPoint/.test(body));
    check('probeSha is stable across calls', PROBE.probeSha() === PROBE.probeSha());
}

// --------------------------------------------------------------- the CLI
//
// Advisory means advisory: findings do not turn a build red unless asked.

function run(args) {
    return spawnSync(process.execPath, [GATE].concat(args), { encoding: 'utf8', stdio: 'pipe' });
}
{
    const withFindings = run([path.join(SNAPS, 'defect-overflow-390.json')]);
    check('the CLI exits 0 on findings - it is advisory', withFindings.status === 0, withFindings.status);
    check('and prints the finding', /OVERFLOW-CULPRIT/.test(withFindings.stdout), withFindings.stdout.slice(0, 200));
    check('and prints the population it scanned, not just a verdict',
        /widths measured/.test(withFindings.stdout) && /element boxes/.test(withFindings.stdout));

    const strict = run([path.join(SNAPS, 'defect-overflow-390.json'), '--strict']);
    check('--strict exits 1 on findings', strict.status === 1, strict.status);

    const cleanRun = run([path.join(SNAPS, 'clean-390.json'), '--strict']);
    check('--strict exits 0 on the clean control', cleanRun.status === 0, cleanRun.stdout);

    const self = run(['--selftest']);
    check('the selftest passes', self.status === 0 && /SELFTEST PASSED/.test(self.stdout), self.stdout);

    const help = run(['--help']);
    check('--help returns rather than hanging', help.status === 0);
    const howTo = run(['--how']);
    check('--how explains the capture', howTo.status === 0 && /clientWidth/.test(howTo.stdout));

    const none = run([]);
    check('no input exits 2, distinct from a clean run', none.status === 2, none.status);

    const printed = run(['--print-probe', '--width', '414']);
    check('--print-probe emits a pasteable expression', printed.status === 0 && /414/.test(printed.stdout));

    // 33 rows naming one cause buries the DOC-SCROLL line that matters. Measured
    // on nodejs.org's fs docs: 33 OVERFLOW-CULPRIT findings across 4 selectors.
    const grouped = run([path.join(SNAPS, 'defect-overflow-390.json')]);
    check('a single finding is NOT annotated with a count', !/\sx1$/m.test(grouped.stdout));

    const json = run(['--dir', SNAPS, '--json']);
    let parsed = null;
    try { parsed = JSON.parse(json.stdout); } catch { /* left null */ }
    check('--json parses', !!parsed);
    check('--json groups the snapshots by page, not into one muddled table',
        parsed && parsed.pages.length === 4, parsed && parsed.pages.length);
}

// --------------------------------------------------------------------------

if (failures.length) {
    console.error(`\nFAIL  ${failures.length} of ${passed + failures.length}`);
    for (const f of failures) console.error('    - ' + f);
    process.exit(1);
}
console.log(`PASS  ${passed} assertions over ${files.length} real-browser snapshots ` +
    `(${PAGES.length} pages x ${WIDTHS.length} widths: ${WIDTHS.join(', ')}).`);
