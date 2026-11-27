#!/usr/bin/env node
'use strict';
// Suite for the slider rule: slider-drift.js (the in-page harvest, the driver
// and the judge), its SLIDER-DRIFT verdict inside layout-checks.js analyse(),
// and the slider population the unslop sweep prints.
//
// WHAT IT RUNS AGAINST. Ten slider records in
// tooling/fixtures/layout/sliders/records, captured from a REAL browser by
// `node tooling/capture-component-fixtures.js --sliders --playwright <dir>`,
// through the sweep's own capture(). Each is joined to a committed component
// snapshot of the same width, so analyse() judges real geometry end to end.
//
//   drift-aria     the incident's shape: slide 1 a tall photo with the
//                  controls over it, slide 2 a shorter diagram with a legend
//                  and the controls below. ARIA carousel.
//   drift-generic  the same defect hand-built: no ARIA, no library, three
//                  stacked figures each carrying its own arrows
//   fixed          the fix: a fixed-ratio frame, controls outside the slides
//   none           no slider, beside three near misses (a snap rail with no
//                  controls, tabs, a pager)
//   single         a carousel with one slide
//
// The expected outcomes below are literals written from the fixture pages,
// not derived from the judge, so weakening the judge cannot weaken them.
//
// The Node driver is run against a scripted fake page, so every branch of
// the click-and-settle loop runs here without a browser. With
// UNSLOP_PLAYWRIGHT=<dir of a playwright package> the live leg re-captures
// every page and requires the same verdicts.
//
// Run: node tooling/test-unslop-sliders.js

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'plugins', 'autodev-core', 'scripts');
const CHECKS = require(path.join(SCRIPTS, 'layout-checks.js'));
const SWEEP = require(path.join(SCRIPTS, 'unslop-sweep.js'));
const SWEEP_CLI = path.join(SCRIPTS, 'unslop-sweep.js');
const SLIDER_FILE = path.join(SCRIPTS, 'slider-drift.js');
const DIR = path.join(ROOT, 'tooling', 'fixtures', 'layout', 'sliders');
const RECORDS = path.join(DIR, 'records');
const SNAPS = path.join(ROOT, 'tooling', 'fixtures', 'layout', 'components', 'snapshots');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail !== undefined ? '\n      -> ' + JSON.stringify(detail).slice(0, 600) : ''));
}
// A section that throws (a missing export on an older tree) fails by its name.
function section(name, fn) {
    try { fn(); } catch (e) { failures.push(`${name}: threw ${String((e && e.message) || e).split(/\r?\n/)[0]}`); }
}

// Loaded defensively: on a tree without the rule, every assertion below
// fails by name instead of the suite dying on a require.
let SLIDERS = null;
try { SLIDERS = require(SLIDER_FILE); } catch (e) { SLIDERS = null; }
check('slider-drift.js loads', !!SLIDERS);

const PAGES = ['drift-aria', 'drift-generic', 'fixed', 'none', 'single', 'unsafe'];
const WIDTHS = [390, 1280];
// What each page must read, per width. Written from the pages, not the judge.
const EXPECT = {
    'drift-aria': { found: 1, measured: 1, skipped: 0, unmeasured: 0, drift: 1, minHeightSpread: 50, controlsMoved: ['prevY', 'nextY', 'dotsY'] },
    'drift-generic': { found: 1, measured: 1, skipped: 0, unmeasured: 0, drift: 1, minHeightSpread: 100, controlsMoved: ['prevY', 'nextY'] },
    fixed: { found: 1, measured: 1, skipped: 0, unmeasured: 0, drift: 0, covered: 3 },
    none: { found: 0, measured: 0, skipped: 0, unmeasured: 0, drift: 0 },
    single: { found: 1, measured: 0, skipped: 1, unmeasured: 0, drift: 0 },
    // A POST form wizard and stacked figures whose controls are links away:
    // neither may be pressed, so neither is a slider.
    unsafe: { found: 0, measured: 0, skipped: 0, unmeasured: 0, drift: 0 },
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const snapAt = (w) => JSON.parse(fs.readFileSync(path.join(SNAPS, `components-clean-${w}.json`), 'utf8'));
const recordOf = (page, w) => JSON.parse(fs.readFileSync(path.join(RECORDS, `${page}-${w}.json`), 'utf8'));
function judged(sliders, w, opt) {
    const s = clone(snapAt(w));
    s.sliders = sliders;
    return CHECKS.analyse(s, opt);
}
const firstLineOf = (e) => String((e && e.message) || e).split(/\r?\n/)[0];
const driftOf = (r) => (r.findings || []).filter((f) => f.code === 'SLIDER-DRIFT');

// ------------------------------------------------------------ fixtures are real

const files = fs.existsSync(RECORDS) ? fs.readdirSync(RECORDS).filter((f) => f.endsWith('.json')) : [];
check('12 slider records are committed (6 pages x 390, 1280)', files.length === 12, files);
for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(RECORDS, f), 'utf8'));
    check(`${f}: was taken by the CURRENT sliderHarvest (re-run capture-component-fixtures.js --sliders after editing it)`,
        !!SLIDERS && r.sliders && r.sliders.sha === SLIDERS.sliderSha(), { inFixture: r.sliders && r.sliders.sha });
    check(`${f}: the harvest ran (status MEASURED)`, r.sliders && r.sliders.status === 'MEASURED', r.sliders && r.sliders.reason);
}

// ------------------------------------------------------------ the four cases

for (const page of PAGES) {
    for (const w of WIDTHS) {
        const e = EXPECT[page];
        const r = judged(recordOf(page, w).sliders, w);
        const c = r.counts && r.counts.sliders;
        check(`${page} @${w}: analyse() measured the page`, r.status === 'MEASURED', r.reason);
        check(`${page} @${w}: slider population is found ${e.found}, measured ${e.measured}, skipped ${e.skipped}, unmeasured ${e.unmeasured}`,
            !!c && c.found === e.found && c.measured === e.measured && c.skipped === e.skipped && c.unmeasured === e.unmeasured, c);
        check(`${page} @${w}: ${e.drift} SLIDER-DRIFT finding(s)`, driftOf(r).length === e.drift && !!c && c.drift === e.drift, driftOf(r).map((f) => f.note));
        if (e.drift) {
            const f = driftOf(r)[0];
            const d = f && f.detail && f.detail.drift;
            check(`${page} @${w}: PLANT flagged, the frame height changes by more than ${e.minHeightSpread}px`, !!d && !!d.height && d.height.spreadPx > e.minHeightSpread, d && d.height);
            check(`${page} @${w}: and the controls move with it (${e.controlsMoved.join(', ')})`, !!d && e.controlsMoved.every((k) => d[k] && d[k].spreadPx > 1), d && Object.keys(d));
            check(`${page} @${w}: the finding names both slides and the threshold`, !!f && /slide 1/.test(f.note) && /slide 2/.test(f.note) && /> 1px/.test(f.threshold), f && [f.note, f.threshold]);
            check(`${page} @${w}: the finding carries the width and a selector`, !!f && f.width === w && typeof f.sel === 'string' && f.sel.length > 0, f && [f.width, f.sel]);
        }
        if (e.covered) {
            const s = recordOf(page, w).sliders.sliders[0];
            check(`${page} @${w}: every slide was reached through the real control (${e.covered} of ${e.covered})`, s && s.covered === e.covered && s.samples.length === e.covered, s && [s.covered, s.reason]);
            check(`${page} @${w}: GREEN, nothing moved at all (largest spread 0px)`, !!c && c.maxPassingSpreadPx === 0, c);
        }
    }
}
check('none: no slider prints "sliders found 0", never silence', !!SWEEP.sliderLine && /sliders found 0, measured 0/.test(SWEEP.sliderLine(judged(recordOf('none', 390).sliders, 390).counts.sliders)));
check('single: the one-slide carousel is skipped with its reason', recordOf('single', 390).sliders.sliders[0].status === 'SKIPPED' && /1 slide/.test(recordOf('single', 390).sliders.sliders[0].reason));

// ------------------------------------------------------------ n/a, never zero

section('n/a, never zero', () => {
    const old = CHECKS.analyse(snapAt(390));
    check('a snapshot with no slider leg reads sliders n/a (null), not 0', old.counts && old.counts.sliders === null, old.counts && old.counts.sliders);
    check('and the sweep prints it as not run', !!SWEEP.sliderLine && SWEEP.sliderLine(null) === 'sliders not run');
    const un = judged({ status: 'UNMEASURED', reason: 'the slider harvest returned nothing', sliders: [] }, 390);
    check('an UNMEASURED harvest reads UNMEASURED with its reason, drift null', un.counts.sliders && un.counts.sliders.status === 'UNMEASURED' && un.counts.sliders.drift === null && driftOf(un).length === 0, un.counts.sliders);
    check('and prints the reason', !!SWEEP.sliderLine && /UNMEASURED \(the slider harvest returned nothing\)/.test(SWEEP.sliderLine(un.counts.sliders)));
});

// ------------------------------------------------------------ threshold and exemptions

section('threshold and exemptions', () => {
    const r = judged(recordOf('drift-aria', 390).sliders, 390, { sliderDriftTolPx: 200 });
    check('the threshold is a knob: drift-aria at sliderDriftTolPx 200 has no finding', driftOf(r).length === 0 && r.counts.sliders.measured === 1, r.counts.sliders);
    check('the default threshold is 1px', CHECKS.DEFAULTS.sliderDriftTolPx === 1);
    // Boundary, by hand: exactly 1px is noise, just over it is drift.
    const rec = (h2, ok) => ({ status: 'MEASURED', found: 1, sliders: [{ sel: 'div.s', lm: null, lib: 'aria', how: 'x', slides: 2, covered: 2, ok: ok || [], status: 'MEASURED', samples: [
        { active: 0, box: { x: 0, y: 10, w: 300, h: 200 }, prev: null, next: { x: 10, y: 20, w: 44, h: 44 }, dots: null },
        { active: 1, box: { x: 0, y: 10, w: 300, h: h2 }, prev: null, next: { x: 10, y: 20, w: 44, h: 44 }, dots: null },
    ] }] });
    check('boundary: a 1px spread passes', driftOf(judged(rec(201), 390)).length === 0);
    check('boundary: a 1.5px spread fires', driftOf(judged(rec(201.5), 390)).length === 1);
    const marked = judged(rec(260, ['SLIDER-DRIFT']), 390);
    check('data-unslop-ok="SLIDER-DRIFT" exempts the slider and is counted', driftOf(marked).length === 0 && marked.counts.sliders.markedOk === 1, marked.counts.sliders);
    const partial = rec(260);
    partial.sliders[0].samples[1].next = null;
    check('a control missing on one slide is compared only where shown, the height still fires', driftOf(judged(partial, 390)).length === 1 && !driftOf(judged(partial, 390))[0].detail.drift.nextY);
    check('spreadOf needs two samples', !!SLIDERS && SLIDERS.spreadOf([{ active: 0, box: { h: 1 } }], (x) => x.box.h) === null);
});

// ------------------------------------------------------------ the driver, on a scripted page

/**
 * A fake page. `sliders` is what op 'find' returns; `states[id]` is the list
 * of states the slider walks through, advanced by a click on next or a dot.
 * `stuck` keeps the state on click; `jitter` never settles.
 * Like the page, a control carries its tag only once op 'state' has run for
 * its slider, so a click before that finds nothing and fails.
 * `navigates` sends the page elsewhere on a click of that slider's next;
 * `stateThrows` makes every state read of that slider throw.
 */
function fakePage(spec) {
    const at = {};
    const log = [];
    const tagged = new Set();
    let url = 'http://127.0.0.1:1/page.html';
    let reads = 0;
    const page = {
        log,
        url: () => url,
        evaluate: async (src) => {
            if (spec.throws) throw new Error('Execution context was destroyed\nmore');
            if (spec.empty) return undefined;
            const o = JSON.parse(src.slice(src.lastIndexOf(')(') + 2, -1));
            if (o.op === 'find') return { sliders: spec.sliders };
            if (spec.stateThrows === o.id) throw new Error('Execution context was destroyed\nmore');
            tagged.add(o.id);
            const list = spec.states[o.id];
            const st = clone(list[Math.min(at[o.id] || 0, list.length - 1)]);
            if (spec.jitter) st.box.h += reads++;
            return st;
        },
        waitForTimeout: async () => {},
        mouse: { move: async () => { if (spec.noMouse) throw new Error('no pointer'); log.push('move'); } },
        locator: (sel) => ({ first: () => ({ click: async () => {
            log.push('click ' + sel);
            if (spec.clickFails) throw new Error('element is not visible\nretrying');
            const m = /="(\d+):(\w+)(?::(\d+))?"/.exec(sel);
            const id = Number(m[1]);
            if (!tagged.has(id)) throw new Error('locator.click: Timeout exceeded, no element carries this tag');
            if (spec.navigates === id && m[2] === 'next') { url = 'http://127.0.0.1:1/other.html'; return; }
            if (spec.hashNav === id) url = url.split('#')[0] + '#slide-' + ((at[id] || 0) + 1);
            if (m[2] === 'pause') return;
            if (spec.stuck) return;
            if (m[2] === 'dot') at[id] = Number(m[3]);
            else at[id] = (at[id] || 0) + 1;
        } }) }),
    };
    return page;
}
const st = (active, h, extra) => Object.assign({ active, activeHow: 'class', slides: 3, box: { x: 0, y: 0, w: 300, h }, prev: { x: 0, y: h - 50, w: 44, h: 44 }, next: { x: 250, y: h - 50, w: 44, h: 44 }, dots: null, dotCount: 0, animating: false }, extra || {});
const slider = (id, extra) => Object.assign({ id, sel: 'div.s' + id, lm: null, lib: 'generic', how: 'stacked', slides: 3, visible: true, controls: { prev: true, next: true, dots: 0 }, pause: false, ok: [] }, extra || {});

async function driverTests() {
    if (!SLIDERS) { check('driver: slider-drift.js is present', false); return; }
    const fast = { settleMs: 30, frameGapMs: 0 };
    let p = fakePage({ sliders: [slider(0, { pause: true })], states: { 0: [st(0, 300), st(1, 200), st(2, 200)] } });
    let r = await SLIDERS.measureSliders(p, fast);
    const s0 = r.sliders[0];
    check('driver: walks every slide through next and records one sample each', r.status === 'MEASURED' && r.found === 1 && s0.status === 'MEASURED' && s0.covered === 3 && s0.samples.map((x) => x.active).join() === '0,1,2', s0);
    check('driver: presses the pause control first, and moves the pointer off after each press', p.log[0] === 'click [data-unslop-ctl="0:pause"]' && p.log.includes('move') && s0.paused === true, p.log);
    check('driver: the measured samples judge as drift', driftOf(judged(r, 390)).length === 1);

    p = fakePage({ sliders: [slider(0)], states: { 0: [st(0, 300, { next: null, dotCount: 3 }), st(1, 300, { next: null, dotCount: 3 }), st(2, 300, { next: null, dotCount: 3 })] } });
    r = await SLIDERS.measureSliders(p, fast);
    check('driver: with no next control it presses the dots of slides not yet seen', r.sliders[0].covered === 3 && p.log.filter((l) => /:dot:/.test(l)).length === 2, p.log);

    p = fakePage({ sliders: [slider(0)], states: { 0: [st(0, 300)] }, stuck: true });
    r = await SLIDERS.measureSliders(p, fast);
    check('driver: a control that changes nothing leaves the slider UNMEASURED with its reason', r.sliders[0].status === 'UNMEASURED' && /did not change the active slide/.test(r.sliders[0].reason), r.sliders[0]);

    p = fakePage({ sliders: [slider(0)], states: { 0: [st(0, 300)] }, jitter: true });
    r = await SLIDERS.measureSliders(p, fast);
    check('driver: a slider that never holds still is UNMEASURED, never a pass', r.sliders[0].status === 'UNMEASURED' && /did not hold still/.test(r.sliders[0].reason), r.sliders[0]);

    p = fakePage({ sliders: [slider(0)], states: { 0: [st(0, 300), st(1, 300)] }, clickFails: true, noMouse: true });
    r = await SLIDERS.measureSliders(p, fast);
    check('driver: a press that fails is UNMEASURED and names the control', r.sliders[0].status === 'UNMEASURED' && /pressing next failed: element is not visible$/.test(r.sliders[0].reason), r.sliders[0].reason);

    p = fakePage({ sliders: [slider(0, { slides: 1 }), slider(1, { visible: false }), slider(2)], states: { 2: [st(-1, 300)] } });
    r = await SLIDERS.measureSliders(p, fast);
    check('driver: one slide SKIPPED, hidden UNMEASURED, no active slide UNMEASURED', r.found === 3 && r.sliders.map((s) => s.status).join() === 'SKIPPED,UNMEASURED,UNMEASURED' && /no active slide/.test(r.sliders[2].reason), r.sliders.map((s) => [s.status, s.reason]));

    p = fakePage({ sliders: [slider(0)], states: { 0: [st(0, 300, { next: null, dotCount: 0 })] } });
    r = await SLIDERS.measureSliders(p, fast);
    check('driver: no next and no dots left is UNMEASURED with that reason', r.sliders[0].status === 'UNMEASURED' && /no visible next control or dot/.test(r.sliders[0].reason), r.sliders[0].reason);

    p = fakePage({ sliders: [slider(0)], states: { 0: [st(0, 300), st(1, 300, { slides: 3 })] } });
    r = await SLIDERS.measureSliders(p, Object.assign({ maxSteps: 1 }, fast));
    check('driver: a partial walk is MEASURED and says how far it got', r.sliders[0].status === 'MEASURED' && /reached 2 of 3 slides/.test(r.sliders[0].reason), r.sliders[0]);

    r = await SLIDERS.measureSliders(fakePage({ sliders: [slider(0), slider(1, { slides: 1 })], states: { 0: [st(0, 1), st(1, 1), st(2, 1)] } }), Object.assign({ maxSliders: 1 }, fast));
    check('driver: sliders over the cap are UNMEASURED, not dropped', r.found === 2 && r.sliders[1].status === 'UNMEASURED' && /cap/.test(r.sliders[1].reason));

    r = await SLIDERS.measureSliders(fakePage({ throws: true }));
    check('driver: a harvest that throws is UNMEASURED with the first line of the error', r.status === 'UNMEASURED' && r.reason === 'slider harvest failed: Execution context was destroyed' && r.found === null, r);
    r = await SLIDERS.measureSliders(fakePage({ empty: true }));
    check('driver: a harvest that returns nothing is UNMEASURED, not found 0', r.status === 'UNMEASURED' && r.found === null, r);
    // Never leave the page or write to the app.
    p = fakePage({ sliders: [slider(0), slider(1)], states: { 0: [st(0, 300), st(1, 300)], 1: [st(0, 300), st(1, 300)] }, navigates: 0 });
    r = await SLIDERS.measureSliders(p, fast);
    check('driver: a control that leaves the page makes that slider UNMEASURED with no samples', r.sliders[0].status === 'UNMEASURED' && r.sliders[0].reason === 'a control navigated away from the page' && r.sliders[0].samples.length === 0, r.sliders[0]);
    check('driver: and every later slider UNMEASURED without a press', r.sliders[1].status === 'UNMEASURED' && /navigated away during the slider leg/.test(r.sliders[1].reason) && !p.log.some((l) => /"1:/.test(l)), [r.sliders[1], p.log]);
    p = fakePage({ sliders: [slider(0)], states: { 0: [st(0, 300), st(1, 300), st(2, 300)] }, hashNav: 0 });
    r = await SLIDERS.measureSliders(p, fast);
    check('driver: a hash change stays on the page and is measured', r.sliders[0].status === 'MEASURED' && r.sliders[0].covered === 3 && /#slide-/.test(p.url()), [r.sliders[0], p.url()]);
    check('pageOf: drops the hash only', SLIDERS.pageOf('http://a/b?c=1#d') === 'http://a/b?c=1' && SLIDERS.pageOf('http://a/b') === 'http://a/b');
    p = fakePage({ sliders: [slider(0), slider(1)], states: { 0: [st(0, 300)], 1: [st(0, 300), st(1, 300), st(2, 300)] }, stateThrows: 0 });
    r = await SLIDERS.measureSliders(p, fast).catch((e) => ({ threw: firstLineOf(e), sliders: [] }));
    check('driver: a slider whose walk throws is UNMEASURED and the next one is still measured', r.status === 'MEASURED' && r.sliders[0].status === 'UNMEASURED' && r.sliders[0].reason === 'slider walk failed: Execution context was destroyed' && r.sliders[1].status === 'MEASURED', r.threw || r.sliders.map((s) => [s.status, s.reason]));

    // The write guard, on a page double that records route() and replays requests through it.
    const routes = [];
    const gp = { route: async (pat, h) => { routes.push(h); }, unroute: async (pat, h) => { routes.splice(routes.indexOf(h), 1); } };
    const g = await SLIDERS.guardWrites(gp);
    const sent = [];
    for (const method of ['GET', 'POST', 'HEAD', 'PUT', 'OPTIONS', 'DELETE']) {
        await routes[0]({ request: () => ({ method: () => method }), fallback: async () => sent.push(method + ' passed'), abort: async () => sent.push(method + ' aborted') });
    }
    const blocked = await g.stop();
    check('guardWrites: reads pass, POST PUT DELETE are aborted and counted, the route is removed',
        sent.join() === 'GET passed,POST aborted,HEAD passed,PUT aborted,OPTIONS passed,DELETE aborted' && blocked === 3 && routes.length === 0, { sent, blocked, routes: routes.length });
    check('guardWrites: a page without route() counts nothing (n/a, not 0)', (await (await SLIDERS.guardWrites({})).stop()) === null);
    r = await SLIDERS.measureSliders(fakePage({ sliders: [], states: {} }), fast);
    check('driver: a page without route() records blockedWrites n/a', r.blockedWrites === null && r.found === 0, r);

    check('sameState: a moved control is a different state', !SLIDERS.sameState(st(0, 300), st(0, 300, { next: { x: 251, y: 250, w: 44, h: 44 } })) && SLIDERS.sameState(st(0, 300), st(0, 300)));
    check('sliderSource: serialises an operation the page can run', /^\(function sliderHarvest\(o\)/.test(SLIDERS.sliderSource({ op: 'find' })) && /\)\(\{"op":"find"\}\)$/.test(SLIDERS.sliderSource({ op: 'find' })));
    const cli = spawnSync(process.execPath, [SLIDER_FILE], { encoding: 'utf8' });
    check('slider-drift.js run bare prints what it is and exits 0', cli.status === 0 && /SLIDER-DRIFT/.test(cli.stdout), cli.stderr);
}

// ------------------------------------------------------------ the sweep prints the population

async function sweepTests() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-sliders-'));
    const fake = path.join(tmp, 'fake-playwright.js');
    // The probe returns the committed clean snapshot; the slider leg finds none.
    fs.writeFileSync(fake, `
const fs = require('fs');
const snaps = ${JSON.stringify(SNAPS)};
module.exports = { chromium: { launch: async () => ({
  newContext: async (opt) => ({ addInitScript: async () => {}, addCookies: async () => {}, close: async () => {}, newPage: async () => {
    let url = 'about:blank';
    return {
      goto: async (u) => { url = u; return { status: () => 200 }; },
      waitForLoadState: async () => {}, waitForTimeout: async () => {}, url: () => url, close: async () => {},
      evaluate: async (src) => {
        if (src.startsWith('(function (o)')) return JSON.parse(fs.readFileSync(snaps + '/components-clean-' + opt.viewport.width + '.json', 'utf8'));
        if (src.startsWith('(function sliderHarvest')) return { sliders: [] };
        return undefined;
      },
      screenshot: async (o) => { fs.writeFileSync(o.path, Buffer.from('png')); return Buffer.from('png'); },
    };
  } }),
  close: async () => {},
}) } };
`);
    const list = path.join(tmp, 'routes.txt');
    fs.writeFileSync(list, '/\n');
    const out = path.join(tmp, 'sweep');
    const res = await SWEEP.sweep({ base: 'http://localhost:3999', out, 'routes-file': list, playwright: fake, 'no-axe': true, quiet: true, widths: '390,1280' });
    const c = res.captures.map((x) => x.result.counts && x.result.counts.sliders);
    check('sweep: every capture carries a slider population', c.length === 2 && c.every((x) => x && x.status === 'MEASURED' && x.found === 0), c);
    const rep = spawnSync(process.execPath, [SWEEP_CLI, 'report', out], { encoding: 'utf8' });
    check('sweep report: a page with no slider prints 0 sliders at each width and exits 0',
        rep.status === 0 && /390: 0 \/ 0 \/ 0 \/ 0 \/ 0 over 1 of 1 captures/.test(rep.stdout) && /1280: 0 \/ 0 \/ 0 \/ 0 \/ 0 over 1 of 1 captures/.test(rep.stdout), rep.stdout.slice(-900) + rep.stderr.slice(0, 300));
    check('sweep report: SLIDER-DRIFT has its own row, judged on both captures', /SLIDER-DRIFT\s+0\s+0\s+2/.test(rep.stdout), rep.stdout.slice(0, 1500));
    const res2 = await SWEEP.sweep({ base: 'http://localhost:3999', out: path.join(tmp, 'sweep2'), 'routes-file': list, playwright: fake, 'no-axe': true, 'no-sliders': true, quiet: true, widths: '390' });
    check('sweep --no-sliders: the slider leg reads n/a, not 0', res2.captures[0].result.counts.sliders === null, res2.captures[0].result.counts.sliders);
    check('RULE_WEIGHT ranks SLIDER-DRIFT', SWEEP.RULE_WEIGHT['SLIDER-DRIFT'] === 3);

    // capture(): the URL is read before the slider leg, and a leg that throws
    // costs only the slider record, never the capture.
    const capPage = (urlThrowsAfter) => {
        let url = 'about:blank';
        let urlReads = 0;
        let tagged = false;
        return {
            goto: async (u) => { url = u; return { status: () => 200 }; },
            waitForLoadState: async () => {}, waitForTimeout: async () => {},
            url: () => { if (urlThrowsAfter && ++urlReads > urlThrowsAfter) throw new Error('Target page, context or browser has been closed\nmore'); return url; },
            evaluate: async (src) => {
                if (src.startsWith('(function sliderHarvest')) {
                    if (/"op":"find"/.test(src)) return { sliders: [slider(0)] };
                    tagged = true;
                    return st(0, 300);
                }
                return JSON.parse(fs.readFileSync(path.join(SNAPS, 'components-clean-390.json'), 'utf8'));
            },
            mouse: { move: async () => {} },
            locator: () => ({ first: () => ({ click: async () => { if (!tagged) throw new Error('untagged'); url = 'http://localhost:3999/login'; } }) }),
        };
    };
    const cap = await SWEEP.capture(capPage(0), 'http://localhost:3999/', 390, {});
    check('capture: a slider control that navigates is not recorded as a redirect', cap.finalUrl === 'http://localhost:3999/' && cap.snapshot.sliders.sliders[0].reason === 'a control navigated away from the page', [cap.finalUrl, cap.snapshot.sliders.sliders[0]]);
    const cap2 = await SWEEP.capture(capPage(1), 'http://localhost:3999/', 390, {}).catch((e) => ({ threw: firstLineOf(e) }));
    check('capture: a slider leg that throws keeps the capture and reads UNMEASURED with the reason',
        !!cap2.snapshot && cap2.finalUrl === 'http://localhost:3999/' && cap2.snapshot.sliders.status === 'UNMEASURED' && cap2.snapshot.sliders.reason === 'slider leg failed: Target page, context or browser has been closed', cap2.threw || (cap2.snapshot && cap2.snapshot.sliders));
    fs.rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------ live leg (optional)

async function liveTests() {
    const dir = process.env.UNSLOP_PLAYWRIGHT;
    if (!dir) { console.log('live leg: not run (set UNSLOP_PLAYWRIGHT=<dir of a playwright package> to re-capture every page in a headless browser)'); return; }
    const pw = require(path.resolve(dir));
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(req.method + ' ' + req.url);
        const file = path.join(DIR, path.basename(new URL(req.url, 'http://x').pathname));
        if (!file.endsWith('.html') || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(file));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    let browser = null;
    try {
        browser = await pw.chromium.launch({ headless: true });
        for (const page of PAGES) {
            for (const w of WIDTHS) {
                const ctx = await browser.newContext(SWEEP.contextOptions(w));
                const pg = await ctx.newPage();
                const before = requests.length;
                const cap = await SWEEP.capture(pg, `http://127.0.0.1:${port}/${page}.html`, w, {});
                const sent = requests.slice(before);
                check(`live ${page} @${w}: the sweep sent no write and left no page`,
                    !sent.some((q) => !/^GET /.test(q) || /submitted|elsewhere/.test(q)) && pg.url() === `http://127.0.0.1:${port}/${page}.html`, { sent, url: pg.url() });
                const r = CHECKS.analyse(cap.snapshot);
                const c = r.counts && r.counts.sliders;
                const e = EXPECT[page];
                console.log(`live ${page} @${w}: ${SWEEP.sliderLine(c)}`);
                check(`live ${page} @${w}: found ${e.found}, measured ${e.measured}, skipped ${e.skipped}, drift ${e.drift}`,
                    !!c && c.found === e.found && c.measured === e.measured && c.skipped === e.skipped && c.drift === e.drift && driftOf(r).length === e.drift, c);
                await ctx.close();
            }
        }
    } finally {
        if (browser) await browser.close();
        server.close();
    }
}

(async () => {
    try {
        await driverTests();
        await sweepTests();
        await liveTests();
    } catch (e) {
        failures.push('suite threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
    }
    if (failures.length) {
        console.log(`FAIL  ${failures.length} of ${failures.length + passed} assertions`);
        for (const f of failures) console.log('  x ' + f);
        process.exitCode = 1;
    } else {
        console.log(`PASS  ${passed} assertions over ${files.length} real-browser slider records (2 plants, a fixed control, no slider, one slide, unsafe look-alikes), a scripted driver and a fake-browser sweep.`);
    }
})();
