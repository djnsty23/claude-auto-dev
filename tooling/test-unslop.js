#!/usr/bin/env node
'use strict';
// Suite for the component rules (layout-checks.js analyseComponents), the
// component harvester (layout-probe.js harvestComponents) and the route sweep
// (unslop-sweep.js).
//
// WHAT IT RUNS AGAINST. Twenty-one snapshots in
// tooling/fixtures/layout/components/snapshots, captured from a REAL browser
// by tooling/capture-component-fixtures.js through the sweep's own capture()
// adapter. None is hand-written: a snapshot invented here would encode this
// suite's model of what a browser returns, and every assertion over it would
// pass by construction.
//
//   header-mess       a signed-in app header assembled from four mismatched
//                     controls: every relevant rule must fire on it
//   header-fixed      the same header from one control size: zero findings
//   components-clean  shapes that look like defects and are not: zero
//                     findings, with every exemption exercised
//   plant-<rule>      the clean page with exactly one defect planted: its
//                     rule fires and no other rule does
//
// The browser half of the sweep is driven with a fake Playwright module, so
// the route loop, redirects, sign-in, axe and pixel-diff bookkeeping run here
// without a browser.
//
// Run: node tooling/test-unslop.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'plugins', 'autodev-core', 'scripts');
const CHECKS = require(path.join(SCRIPTS, 'layout-checks.js'));
const PROBE = require(path.join(SCRIPTS, 'layout-probe.js'));
const SWEEP = require(path.join(SCRIPTS, 'unslop-sweep.js'));
const GATE = path.join(SCRIPTS, 'rendered-layout-gate.js');
const SWEEP_CLI = path.join(SCRIPTS, 'unslop-sweep.js');
const SNAPS = path.join(ROOT, 'tooling', 'fixtures', 'layout', 'components', 'snapshots');
const OLD_SNAPS = path.join(ROOT, 'tooling', 'fixtures', 'layout', 'snapshots');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail !== undefined ? '\n      -> ' + JSON.stringify(detail).slice(0, 600) : ''));
}
const load = (n) => JSON.parse(fs.readFileSync(path.join(SNAPS, n + '.json'), 'utf8'));
const codesOf = (r) => r.findings.map((f) => f.code);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-test-'));

const WIDTHS = [390, 414, 1280];
const CODES = CHECKS.CODES;
// What the header defect must trip. The touch-only two apply below 768.
const HEADER_RULES = [
    CODES.ROW_HEIGHT, CODES.ROW_CENTER, CODES.ROW_BORDER, CODES.ROW_RADIUS, CODES.ROW_PADDING,
    CODES.GLUED_CONTROLS, CODES.DOUBLE_BORDER, CODES.SHORT_BAR,
];
const TOUCH_RULES = [CODES.NO_GUTTER, CODES.TAP_TARGET];

// ------------------------------------------------------------ fixtures are real

const files = fs.existsSync(SNAPS) ? fs.readdirSync(SNAPS).filter((f) => f.endsWith('.json')) : [];
check('21 component snapshots are committed (3 pages x 3 widths + 12 plants)', files.length === 21, files.length);
const shas = new Set();
const probeShas = new Set();
for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(SNAPS, f), 'utf8'));
    shas.add(s.components && s.components.sha);
    probeShas.add(s.probeSha);
    check(`${f}: carries a component harvest`, s.components && Array.isArray(s.components.elements) && s.components.elements.length > 10, s.components && s.components.recorded);
    check(`${f}: was served from loopback, so it records no local path`, /^http:\/\/127\.0\.0\.1:\d+\//.test(s.viewport.url), s.viewport.url);
}
check('every component snapshot was taken by the CURRENT harvestComponents (re-run tooling/capture-component-fixtures.js after editing it)',
    shas.size === 1 && shas.has(PROBE.componentSha()), { inFixtures: [...shas], current: PROBE.componentSha() });
check('and by the current harvest()', probeShas.size === 1 && probeShas.has(PROBE.probeSha()), [...probeShas]);
check('harvest() itself is unchanged, so the 20 overflow fixtures stay valid',
    JSON.parse(fs.readFileSync(path.join(OLD_SNAPS, 'clean-390.json'), 'utf8')).probeSha === PROBE.probeSha());

// The harvester is self-contained: it is stringified into a page.
const src = PROBE.probeSource({ requestedWidth: 390 });
check('probeSource parses as one expression', (() => { try { new Function('return ' + src); return true; } catch { return false; } })());
check('probeSource carries both harvesters and both hashes',
    src.includes('autodev.components/1') && src.includes(PROBE.componentSha()) && src.includes(PROBE.probeSha()));

// ------------------------------------------------------------ the header

for (const w of WIDTHS) {
    const r = CHECKS.analyse(load(`header-mess-${w}`));
    const got = new Set(codesOf(r));
    for (const code of HEADER_RULES) check(`header-mess @${w}: ${code} fires`, got.has(code), [...got]);
    for (const code of TOUCH_RULES) {
        if (w < 768) check(`header-mess @${w}: ${code} fires`, got.has(code), [...got]);
        else check(`header-mess @${w}: ${code} is n/a at a desktop width, not 0`, r.counts.components[CHECKS.COUNT_KEY[code]] === null, r.counts.components);
    }
    const glued = r.findings.find((f) => f.code === CODES.GLUED_CONTROLS);
    check(`header-mess @${w}: the glued pair is the counter and the upgrade button`,
        glued && /p\.counter/.test(glued.sel) && /a\.pro/.test(glued.sel), glued && glued.sel);
    const dbl = r.findings.find((f) => f.code === CODES.DOUBLE_BORDER);
    check(`header-mess @${w}: the double border is the avatar inside its ring`,
        dbl && /span\.avatar/.test(dbl.sel) && dbl.detail.kind === 'nested', dbl && dbl.sel);
    const row = r.findings.find((f) => f.code === CODES.ROW_HEIGHT);
    check(`header-mess @${w}: the row finding names all four controls with their measured heights`,
        row && row.detail.items.length === 4 && row.detail.items.every((i) => typeof i.h === 'number'), row && row.detail);
    check(`header-mess @${w}: every finding carries its threshold`, r.findings.every((f) => typeof f.threshold === 'string' && f.threshold.length > 4));

    const fixed = CHECKS.analyse(load(`header-fixed-${w}`));
    check(`header-fixed @${w}: zero findings`, fixed.status === 'MEASURED' && fixed.findings.length === 0, codesOf(fixed));
    check(`header-fixed @${w}: and it judged the same row`, fixed.componentPopulation.rowLines >= 1 && fixed.componentPopulation.rowItems >= 4, fixed.componentPopulation);
}

// ------------------------------------------------------------ the clean control

const EXEMPTIONS = ['consistentGroup', 'selectedSegment', 'pillRadius', 'narrowAccent', 'barTrack', 'rail', 'fullBleed', 'inlineLink', 'wrappedByTarget'];
for (const w of WIDTHS) {
    const r = CHECKS.analyse(load(`components-clean-${w}`));
    check(`components-clean @${w}: zero findings`, r.status === 'MEASURED' && r.findings.length === 0, r.findings.map((f) => `${f.code} ${f.sel}`));
}
{
    const r = CHECKS.analyse(load('components-clean-390'));
    // An exemption that never fires on the control is not shown to be needed.
    for (const k of EXEMPTIONS) check(`components-clean @390: the ${k} exemption is exercised`, r.counts.components.exempt[k] > 0, r.counts.components.exempt);
    // The inline-run case is really there: three nowrap phrases of one
    // paragraph, inline, stacked on different lines, spaced unevenly. Without
    // this the "inline is not a rhythm" guard could pass on an empty case.
    const nw = load('components-clean-390').components.elements.filter((e) => /span\.nw/.test(e.sel));
    const gaps = nw.slice(1).map((e, k) => e.box.t - nw[k].box.b);
    check('components-clean @390: its inline phrases wrap onto separate lines, unevenly spaced',
        nw.length === 3 && nw.every((e) => e.d === 'inline') && gaps.every((g) => g >= -1) && Math.max(...gaps) - Math.min(...gaps) > CHECKS.DEFAULTS.rhythmTolPx,
        nw.map((e) => [e.d, e.box.t, e.box.b]));
    const pop = r.componentPopulation;
    check('components-clean @390: every rule had something to judge',
        pop.rowLines > 0 && pop.framedPairs > 0 && pop.barCandidates > 0 && pop.gutterCandidates > 0 &&
        pop.tapCandidates > 0 && pop.truncCandidates > 0 && pop.rhythmRuns > 0, pop);
}

// ------------------------------------------------------------ one plant per rule

for (const code of CHECKS.COMPONENT_CODES) {
    const name = `plant-${code.toLowerCase()}-390`;
    const r = CHECKS.analyse(load(name));
    const got = new Set(codesOf(r));
    check(`${name}: RED, ${code} fires`, got.has(code), [...got]);
    check(`${name}: and no other rule fires`, [...got].every((c) => c === code), [...got]);
    const clean = CHECKS.analyse(load('components-clean-390'));
    check(`${name}: GREEN, the unplanted page reports 0 ${code}`, clean.counts.components[CHECKS.COUNT_KEY[code]] === 0);
}

// ------------------------------------------------------------ knobs and exemptions

{
    const s = load('header-mess-390');
    const loose = CHECKS.analyse(s, { rowHeightTolPx: 20 });
    check('a threshold override travels: rowHeightTolPx 20 silences ROW-HEIGHT', !codesOf(loose).includes(CODES.ROW_HEIGHT) && codesOf(loose).includes(CODES.ROW_CENTER));
    check('and the threshold is echoed in the result', loose.thresholds.rowHeightTolPx === 20);
    const t = CHECKS.analyse(s, { tapMinPx: 30 });
    check('tapMinPx 30 passes the 36px menu button and the 40px upgrade link', !codesOf(t).includes(CODES.TAP_TARGET), codesOf(t));
    const g = CHECKS.analyse(s, { gutterMinPx: 4 });
    check('gutterMinPx 4 passes controls sitting exactly 4px from the edge', !codesOf(g).includes(CODES.NO_GUTTER), codesOf(g));

    // data-unslop-ok on the element is the one exemption, and it is counted.
    const marked = JSON.parse(JSON.stringify(s));
    const counter = marked.components.elements.find((e) => /p\.counter$/.test(e.sel));
    counter.ok = ['GLUED-CONTROLS'];
    const m = CHECKS.analyse(marked);
    check('data-unslop-ok="GLUED-CONTROLS" on the counter suppresses that finding', !codesOf(m).includes(CODES.GLUED_CONTROLS), codesOf(m));
    check('and is counted as markedOk, never silent', m.counts.components.exempt.markedOk === 1, m.counts.components.exempt);
    check('and suppresses nothing else', codesOf(m).includes(CODES.ROW_HEIGHT) && codesOf(m).includes(CODES.DOUBLE_BORDER));

    // A self double border: border and outer ring on one element.
    const self = JSON.parse(JSON.stringify(load('components-clean-390')));
    const search = self.components.elements.find((e) => /form\.search$/.test(e.sel));
    search.ring = 2; search.ringInset = false;
    const sr = CHECKS.analyse(self);
    const sd = sr.findings.find((f) => f.code === CODES.DOUBLE_BORDER);
    check('a border plus an outer ring on one element is a self double border', sd && sd.detail.kind === 'self', codesOf(sr));
    search.ringInset = true;
    check('an INSET ring inside a border is not', !codesOf(CHECKS.analyse(self)).includes(CODES.DOUBLE_BORDER));
}

// ------------------------------------------------------------ refusing to guess

{
    const old = JSON.parse(fs.readFileSync(path.join(OLD_SNAPS, 'clean-390.json'), 'utf8'));
    const r = CHECKS.analyse(old);
    check('a snapshot with no component harvest reports components as null (n/a), not zero', r.status === 'MEASURED' && r.counts.components === null);
    const broken = load('header-mess-390');
    broken.components = { schema: 'autodev.components/1', error: 'boom' };
    check('a component harvest that threw is null too, and the overflow half still measures',
        CHECKS.analyse(broken).counts.components === null && CHECKS.analyse(broken).status === 'MEASURED');
    check('analyseComponents alone returns null on no input', CHECKS.analyseComponents({ viewport: { clientWidth: 390 } }, CHECKS.DEFAULTS) === null);
}

// ------------------------------------------------------------ before / after

const card = (entries) => SWEEP.scorecardOf(entries.map(([route, name, w, extra]) => Object.assign({
    route, state: 'signed-out', width: w, result: CHECKS.analyse(load(name)), shot: `shots/${route}-${w}.png`,
}, extra || {})), { sweepId: 't' });

{
    const mess = card(WIDTHS.map((w) => ['/', `header-mess-${w}`, w]));
    const fixed = card(WIDTHS.map((w) => ['/', `header-fixed-${w}`, w]));
    const fwd = SWEEP.compareScorecards(mess, fixed);
    check('scorecard: the mess scores worse than the fix', fwd.targetBefore > fwd.targetAfter && fwd.targetAfter === 0, fwd);
    check('compare mess -> fixed: the fix COUNTS', fwd.verdict === 'COUNTS' && fwd.counts === true, fwd.verdict);
    const back = SWEEP.compareScorecards(fixed, mess);
    check('planting the mess back flips it: NO-DROP, and every rule that rose is named', back.verdict === 'NO-DROP' && back.rises.length === 3, back);
    check('the rises name the header rules', back.rises.every((x) => /GLUED-CONTROLS \+1/.test(x)), back.rises);

    // A fix that improves its route while another route gets worse does not count.
    const before = card([['/', 'header-mess-390', 390], ['/other', 'components-clean-390', 390]]);
    const after = card([['/', 'header-fixed-390', 390], ['/other', 'plant-rhythm-390', 390]]);
    const cross = SWEEP.compareScorecards(before, after, { routes: ['/'] });
    check('a fix whose target dropped while another route rose is REGRESSED-ELSEWHERE', cross.verdict === 'REGRESSED-ELSEWHERE' && !cross.counts, cross.verdict);
    check('and the rise is named on the other route', cross.rises.length === 1 && /\/other .*RHYTHM \+1/.test(cross.rises[0]), cross.rises);
    const codesOnly = SWEEP.compareScorecards(before, card([['/', 'plant-glued-controls-390', 390], ['/other', 'components-clean-390', 390]]), { codes: ['GLUED-CONTROLS'] });
    check('a target narrowed to one rule counts only that rule', codesOnly.targetBefore === 1 && codesOnly.targetAfter === 1 && codesOnly.verdict === 'NO-DROP', codesOnly);
    const ax = SWEEP.compareScorecards(
        card([['/', 'header-mess-390', 390, { axe: 2 }]]),
        card([['/', 'header-fixed-390', 390, { axe: 5 }]]));
    check('an axe count that rose stops a fix counting', ax.verdict === 'REGRESSED-ELSEWHERE' && /axe \+3/.test(ax.rises[0]), ax);
    const un = SWEEP.compareScorecards(mess, { routes: [] });
    check('a capture missing on one side is listed as unmeasured, not compared', un.unmeasured.length === 3 && un.rows.length === 0, un.unmeasured);
    const sc = SWEEP.scoreOf(CHECKS.analyse(load('header-mess-390')), { axe: 4, pixelDiffPct: 1.5 });
    check('a score row carries rule hits by id, axe, the overflow family and the pixel diff',
        sc.rules['GLUED-CONTROLS'] === 1 && sc.axe === 4 && sc.ooc === 0 && sc.pixelDiffPct === 1.5 && sc.ruleHits === 12, sc);
    check('an unmeasured capture scores null hits, never 0', SWEEP.scoreOf({ status: 'UNMEASURED', reason: 'x', findings: [] }).ruleHits === null);
    check('the compare table prints the verdict', /verdict: COUNTS/.test(SWEEP.printCompare(fwd)) && /NO-DROP/.test(SWEEP.printCompare(back)));
}

// ------------------------------------------------------------ blind pairs

{
    const before = { a: 'b1.png', b: 'b2.png', c: 'b3.png', d: 'b4.png' };
    const after = { a: 'a1.png', b: 'a2.png', c: 'a3.png', d: 'a4.png' };
    const p1 = SWEEP.makePairs(before, after, 42);
    const p2 = SWEEP.makePairs(before, after, 42);
    check('pairs: the same seed gives the same order', JSON.stringify(p1) === JSON.stringify(p2));
    check('pairs: the manifest the judge reads never says which side is after', p1.manifest.every((m) => !('after' in m) && !('capture' in m)));
    const sides = new Set(Object.values(SWEEP.makePairs(Object.fromEntries([...Array(20)].map((_, i) => ['k' + i, 'b'])), Object.fromEntries([...Array(20)].map((_, i) => ['k' + i, 'a'])), 3).key).map((k) => k.after));
    check('pairs: the after image lands on both sides across a set', sides.size === 2, [...sides]);
    const perfect = Object.fromEntries(Object.entries(p1.key).map(([id, k]) => [id, k.after]));
    check('pair-score: a judge that always picks after scores 1', SWEEP.scorePairs(p1.key, perfect).winRate === 1);
    const inverted = Object.fromEntries(Object.entries(p1.key).map(([id, k]) => [id, k.after === 'a' ? 'b' : 'a']));
    check('pair-score: one that always picks before scores 0', SWEEP.scorePairs(p1.key, inverted).winRate === 0);
    check('pairs: every capture is shown twice, once with the after image on each side', p1.manifest.length === 8 && Object.keys(before).every((c) => { const s = Object.values(p1.key).filter((k) => k.capture === c).map((k) => k.after).sort().join(''); return s === 'ab'; }), p1.key);
    const byCap = (c) => Object.entries(p1.key).filter(([, k]) => k.capture === c);
    const tieA = Object.fromEntries(byCap('a').map(([id]) => [id, 'tie']));
    const halfB = { [byCap('b')[0][0]]: byCap('b')[0][1].after };
    const partial = SWEEP.scorePairs(p1.key, { ...tieA, ...halfB });
    check('pair-score: ties and unanswered captures are counted apart', partial.ties === 1 && partial.missing === 3 && partial.judged === 1 && partial.winRate === 0, partial);
    const allA = SWEEP.scorePairs(p1.key, Object.fromEntries(Object.keys(p1.key).map((id) => [id, 'a'])));
    check('pair-score: a judge that always answers "a" wins nothing and is caught as inconsistent', allA.wins === 0 && allA.losses === 0 && allA.inconsistent === 4 && allA.winRate === 0 && allA.positionBias.a === 8 && allA.positionBias.b === 0, allA);
    const swapped = SWEEP.scorePairs(p1.key, Object.fromEntries(Object.entries(p1.key).map(([id, k]) => [id, (k.capture === 'a' && k.after === 'a') ? 'b' : k.after])));
    check('pair-score: one swapped label makes that capture inconsistent, not a win', swapped.wins === 3 && swapped.inconsistent === 1 && swapped.winRate === 0.75, swapped);
}

// ------------------------------------------------------------ routes

{
    const app = path.join(tmp, 'prod', 'src', 'app');
    const mk = (rel) => { fs.mkdirSync(path.join(app, rel), { recursive: true }); fs.writeFileSync(path.join(app, rel, 'page.tsx'), 'export default 1'); };
    mk('.');
    mk('(marketing)/pricing');
    mk('(en)/blog/[category]/[slug]');
    mk('ro/(ro)/preturi');
    mk('app/codes/[id]');
    mk('docs/[[...rest]]');
    mk('[locale]/about');
    mk('@modal/login');
    mk('_components/thing');
    mk('feed/(.)photo/[id]');
    fs.mkdirSync(path.join(app, 'api', 'x'), { recursive: true });
    fs.writeFileSync(path.join(app, 'api', 'x', 'route.ts'), '');
    const routes = SWEEP.discoverAppRoutes(SWEEP.findAppDir(path.join(tmp, 'prod')), { locales: ['en', 'ro'] });
    const want = ['/', '/app/codes/[id]', '/blog/[category]/[slug]', '/docs', '/docs/[[...rest]]', '/en/about', '/pricing', '/ro/about', '/ro/preturi'];
    check('app router: groups vanish, slots, private and intercepting folders are skipped, locales expand', JSON.stringify(routes) === JSON.stringify(want), routes);
    const sm = SWEEP.parseSitemap('<urlset><url><loc>https://example.com/blog/news/hello</loc></url><url><loc>https://example.com/app/codes/7</loc></url></urlset>');
    const idx = SWEEP.parseSitemap('<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>');
    check('sitemap: a urlset gives urls and an index gives child sitemaps', sm.urls.length === 2 && idx.sitemaps.length === 1 && idx.urls.length === 0);
    const plan = SWEEP.planRoutes(routes, sm.urls.map((u) => new URL(u).pathname), { samples: 1 });
    check('plan: dynamic routes are sampled from the sitemap', plan.routes.some((r) => r.path === '/blog/news/hello') && plan.routes.some((r) => r.path === '/app/codes/7'));
    check('plan: a dynamic route with no sample is reported, not silently dropped', plan.unsampled.includes('/docs/[[...rest]]'), plan.unsampled);
    check('plan: --max-routes caps and says so', SWEEP.planRoutes(routes, [], { maxRoutes: 2 }).capped === true);
    check('route list: comments and blanks skipped, full URLs reduced to paths',
        JSON.stringify(SWEEP.readRouteList('# x\n/a\n\nhttps://example.com/b/c\n')) === JSON.stringify(['/a', '/b/c']));
    check('only local hosts', SWEEP.isLocalBase('http://localhost:3000') && SWEEP.isLocalBase('http://[::1]:3000') && SWEEP.isLocalBase('http://shop.localhost') &&
        !SWEEP.isLocalBase('https://example.com') && !SWEEP.isLocalBase('http://localhost.example.com') && !SWEEP.isLocalBase('not a url'));

    // Login sources: names only. The value must not appear anywhere in the output.
    fs.writeFileSync(path.join(tmp, 'prod', '.env.example'), 'QA_FREE_EMAIL=planted-value-one\nQA_FREE_PASSWORD=planted-value-two\nOTHER=x\n');
    fs.mkdirSync(path.join(tmp, 'prod', 'supabase'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'prod', 'supabase', 'seed.sql'), "insert into users values ('a@b.co', crypt('password', ...));");
    const ls = SWEEP.findLoginSources(path.join(tmp, 'prod'));
    check('login sources: the email/password pair is found by name', ls.pairs.length === 1 && ls.pairs[0].emailEnv === 'QA_FREE_EMAIL' && ls.pairs[0].passwordEnv === 'QA_FREE_PASSWORD', ls);
    check('login sources: the seed file is listed by path', ls.seedFiles.includes('supabase/seed.sql'), ls.seedFiles);
    check('login sources: no value is captured', !JSON.stringify(ls).includes('planted-value'));
    const cli = spawnSync(process.execPath, [SWEEP_CLI, 'routes', '--root', path.join(tmp, 'prod'), '--locales', 'en,ro'], { encoding: 'utf8' });
    check('routes CLI: lists routes and login variable names', cli.status === 0 && /\/pricing/.test(cli.stdout) && /QA_FREE_EMAIL\+QA_FREE_PASSWORD/.test(cli.stdout), cli.stdout + cli.stderr);
    check('routes CLI: never prints a value', !/planted-value/.test(cli.stdout + cli.stderr));
}

// ------------------------------------------------------------ the sweep, with a fake browser

const FAKE = path.join(tmp, 'fake-playwright.js');
fs.writeFileSync(FAKE, `
const fs = require('fs');
const snaps = ${JSON.stringify(SNAPS)};
const load = (n) => JSON.parse(fs.readFileSync(snaps + '/' + n + '.json', 'utf8'));
const log = [];
function page(ctx) {
  let url = 'about:blank';
  const p = {
    goto: async (u) => {
      const path = new URL(u).pathname;
      url = path.startsWith('/app') && !ctx.signedIn ? new URL('/login?next=' + path, u).href : u;
      log.push('goto ' + url);
      return { status: () => 200 };
    },
    waitForLoadState: async () => { throw new Error('never idle'); },
    waitForTimeout: async () => {},
    url: () => url,
    evaluate: async (fn, arg) => {
      if (typeof fn === 'function') return 1.25;
      if (fn.startsWith('(function (o)')) {
        const o = JSON.parse(fn.slice(fn.lastIndexOf(')(') + 2, -1));
        const w = o.requestedWidth;
        const path = new URL(url).pathname;
        const name = path === '/' ? 'header-mess' : path.startsWith('/login') ? 'components-clean' : 'header-fixed';
        log.push('probe ' + path + ' ' + w);
        return load(name + '-' + w);
      }
      if (fn.startsWith('axe.run')) return [{ id: 'color-contrast', n: 2 }, { id: 'label', n: 1 }];
      return undefined;
    },
    screenshot: async (o) => { log.push('shot ' + o.clip.height); fs.writeFileSync(o.path, Buffer.from('png')); return Buffer.from('png'); },
    setContent: async () => {},
    close: async () => {},
    locator: () => ({ first: () => ({ fill: async () => { log.push('fill'); }, press: async () => { ctx.signedIn = true; } }) }),
    waitForURL: async () => { if (!ctx.signedIn) throw new Error('no'); },
  };
  return p;
}
module.exports = {
  log,
  chromium: { launch: async () => ({
    newContext: async (opt) => { log.push('ctx ' + opt.viewport.width + ' ' + opt.isMobile); const ctx = { signedIn: false }; return { addInitScript: async () => { log.push('init'); }, addCookies: async (c) => { log.push('cookies ' + c.map((x) => x.name + '=' + x.value + '@' + x.url).join(';')); }, newPage: async () => page(ctx), close: async () => {} }; },
    close: async () => {},
  }) },
};
`);
const AXE = path.join(tmp, 'axe.js');
fs.writeFileSync(AXE, '/* stands in for axe-core */');
const STORAGE = path.join(tmp, 'storage.json');
fs.writeFileSync(STORAGE, JSON.stringify({ consent: 'declined' }));

async function sweepTests() {
    const listFile = path.join(tmp, 'routes.txt');
    fs.writeFileSync(listFile, '/\n/pricing\n/app/codes\n/app/settings\n');
    const out1 = path.join(tmp, 'sweep1');
    const fake = require(FAKE);
    const r1 = await SWEEP.sweep({ base: 'http://localhost:3999', out: out1, 'routes-file': listFile, playwright: FAKE, axe: AXE, 'init-storage': STORAGE, cookies: 'consent=v1.0.0', quiet: true, widths: '390,1280' });
    check('sweep: every route at every width was captured', r1.captures.length === 8, r1.captures.map((c) => c.label));
    check('sweep: a touch width gets a mobile context, a desktop one does not', fake.log.includes('ctx 390 true') && fake.log.includes('ctx 1280 false'));
    check('sweep: the stored consent choice is set before every page', fake.log.filter((l) => l === 'init').length === 2);
    check('sweep: a consent cookie is set for the base host in every context', fake.log.filter((l) => l === 'cookies consent=v1.0.0@http://localhost:3999').length === 2, fake.log.filter((l) => l.startsWith('cookies')));
    const redirected = r1.captures.filter((c) => c.redirectedTo);
    check('sweep: a protected route that redirects to login is recorded as redirected', redirected.length === 4 && redirected.every((c) => c.redirectedTo === '/login'), redirected.map((c) => c.redirectedTo));
    const dup = r1.captures.filter((c) => c.result.status === 'REDIRECT');
    check('sweep: a second route redirecting to the same page is not measured twice', dup.length === 2 && dup.every((c) => c.sameAs === '/app/codes'), dup.map((c) => c.sameAs));
    check('sweep: axe counts every violating node', r1.captures.find((c) => c.route === '/').axe === 3);
    check('sweep: snapshots are saved compressed', fs.existsSync(path.join(out1, 'snapshots', 'root-signed-out-390.json.gz')));
    check('sweep: screenshots are saved', fs.existsSync(path.join(out1, 'shots', 'root-signed-out-390.png')));
    const sc1 = JSON.parse(fs.readFileSync(path.join(out1, 'scorecard.json'), 'utf8'));
    check('sweep: the scorecard holds rule hits by id, axe and the overflow family per width',
        sc1.routes.find((r) => r.route === '/').widths['390'].rules['GLUED-CONTROLS'] === 1 && sc1.routes.find((r) => r.route === '/').widths['390'].axe === 3);
    check('sweep: no baseline, so no pixel diff (null, not 0)', sc1.routes[0].widths['390'].pixelDiffPct === null);
    check('sweep: signed in was not requested and says so', r1.meta.login.requested === false);

    // Signed in, with a baseline: the pixel diff is measured against it.
    process.env.UNSLOP_TEST_EMAIL = 'qa@example.test';
    process.env.UNSLOP_TEST_PASSWORD = 'not-a-real-password';
    const out2 = path.join(tmp, 'sweep2');
    const r2 = await SWEEP.sweep({ base: 'http://localhost:3999', out: out2, 'routes-file': listFile, playwright: FAKE, 'no-axe': true, baseline: out1, quiet: true, widths: '390', 'email-env': 'UNSLOP_TEST_EMAIL', 'password-env': 'UNSLOP_TEST_PASSWORD' });
    const signedIn = r2.captures.filter((c) => c.state === 'signed-in');
    check('sweep: the signed-in leg re-measures the protected routes and the home page', signedIn.map((c) => c.route).sort().join(',') === '/,/app/codes,/app/settings', signedIn.map((c) => c.route));
    check('sweep: signed in, the protected route is no longer a redirect', signedIn.every((c) => !c.redirectedTo && c.result.status === 'MEASURED'));
    check('sweep: the pixel diff against the baseline is recorded', r2.captures.find((c) => c.route === '/' && c.state === 'signed-out').pixelDiffPct === 1.25);
    check('sweep: axe off reads null, not 0', r2.captures[0].axe === null);
    const findings2 = fs.readFileSync(path.join(out2, 'findings.json'), 'utf8');
    check('sweep: the login values are written nowhere', !findings2.includes('not-a-real-password') && !findings2.includes('qa@example.test'));
    check('sweep: the login is reported by presence', r2.meta.login.emailPresent === true && r2.meta.login.passwordPresent === true);

    // A requested login whose variables are absent leaves the leg UNMEASURED.
    delete process.env.UNSLOP_TEST_PASSWORD;
    const r3 = await SWEEP.sweep({ base: 'http://localhost:3999', out: path.join(tmp, 'sweep3'), 'routes-file': listFile, playwright: FAKE, 'no-axe': true, quiet: true, widths: '390', 'email-env': 'UNSLOP_TEST_EMAIL', 'password-env': 'UNSLOP_TEST_PASSWORD' });
    const un = r3.captures.filter((c) => c.state === 'signed-in');
    check('sweep: missing login variables make the signed-in leg UNMEASURED with the reason', un.length > 0 && un.every((c) => c.result.status === 'UNMEASURED' && /absent/.test(c.result.reason)), un.map((c) => c.result.reason));
    delete process.env.UNSLOP_TEST_EMAIL;

    let refused = null;
    try { await SWEEP.sweep({ base: 'https://example.com', playwright: FAKE }); } catch (e) { refused = e; }
    check('sweep: a non-local base is refused with exit 2 before a browser starts', refused && refused.exitCode === 2 && /local/.test(refused.message));

    // Report, stories, compare, pairs, vision, through the CLI.
    const run = (args) => spawnSync(process.execPath, [SWEEP_CLI].concat(args), { encoding: 'utf8', cwd: tmp });
    const rep = run(['report', out1]);
    check('report: ranks findings and prints the per-rule population', rep.status === 0 && /GLUED-CONTROLS/.test(rep.stdout) && /judged/.test(rep.stdout) && /top \d+ of \d+/.test(rep.stdout), rep.stdout + rep.stderr);
    const rows = SWEEP.rankFindings(r1.captures);
    check('rank: a defect on one selector across widths is one row', rows.filter((r) => r.code === 'GLUED-CONTROLS').length === 1);
    check('rank: rows carry their routes and widths', rows[0].routes.length >= 1 && rows[0].widths.length >= 1);

    const prdPath = path.join(tmp, 'prd.json');
    fs.writeFileSync(prdPath, JSON.stringify({ project: 'x', sprint: 4, stories: { 'S4-001': { id: 'S4-001', title: 'old', passes: true, notes: '' } } }));
    const dry = run(['stories', out1, '--prd', prdPath]);
    check('stories: a dry run writes nothing', dry.status === 0 && /dry run/.test(dry.stdout) && Object.keys(JSON.parse(fs.readFileSync(prdPath, 'utf8')).stories).length === 1, dry.stdout + dry.stderr);
    const wr = run(['stories', out1, '--prd', prdPath, '--write']);
    const prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
    const added = Object.values(prd.stories).filter((s) => s.id !== 'S4-001');
    check('stories: the shared header defects become ONE story for the header component', added.filter((s) => /header/.test(s.title)).length === 1, added.map((s) => s.title));
    check('stories: ids continue the sprint and stories are pending fixes', added.every((s) => /^S4-\d{3}$/.test(s.id) && s.passes === null && s.type === 'fix'), added.map((s) => s.id));
    check('stories: each carries its measured evidence and acceptance', added.every((s) => /threshold/.test(s.notes) && /compare/.test(s.acceptance)));
    const again = run(['stories', out1, '--prd', prdPath, '--write']);
    check('stories: re-running adds nothing while the stories are open', /0 new/.test(again.stdout) && Object.keys(JSON.parse(fs.readFileSync(prdPath, 'utf8')).stories).length === Object.keys(prd.stories).length, again.stdout);
    fs.writeFileSync(path.join(tmp, 'broken.json'), '{ not json');
    check('stories: an unreadable prd.json is refused, never overwritten', run(['stories', out1, '--prd', path.join(tmp, 'broken.json'), '--write']).status === 2 && fs.readFileSync(path.join(tmp, 'broken.json'), 'utf8') === '{ not json');

    check('compare CLI: exit 1 when nothing dropped', run(['compare', out1, out1]).status === 1);
    const pairsDir = path.join(tmp, 'pairs');
    const pr = run(['pairs', out1, out2, '--pairs', pairsDir, '--seed', '5']);
    const manifest = JSON.parse(fs.readFileSync(path.join(pairsDir, 'pairs.json'), 'utf8'));
    check('pairs CLI: writes the judge manifest without the key', pr.status === 0 && manifest.pairs.length > 0 && !JSON.stringify(manifest).includes('"after"'), pr.stdout + pr.stderr);
    const key = JSON.parse(fs.readFileSync(path.join(pairsDir, '.key.json'), 'utf8'));
    fs.writeFileSync(path.join(tmp, 'verdicts.json'), JSON.stringify(Object.fromEntries(Object.entries(key).map(([id, k]) => [id, k.after]))));
    const ps = run(['pair-score', pairsDir, '--verdicts', path.join(tmp, 'verdicts.json')]);
    check('pair-score CLI: reports the win rate', /win rate 1/.test(ps.stdout), ps.stdout + ps.stderr);

    const vp = run(['vision-pack', out1, '--max', '3']);
    const pack = JSON.parse(fs.readFileSync(path.join(out1, 'vision-pack.json'), 'utf8'));
    check('vision-pack: packs at most --max screenshots, worst first, with the rubric', vp.status === 0 && pack.shots.length === 3 && pack.shots[0].route === '/' && pack.rubric.includes('unfinished') && pack.instructions.length > 200, vp.stderr);
    const vision = [
        { route: '/', width: 390, rubric: 'control-consistency', confidence: 0.9, observation: 'counter and upgrade button differ in height', sel: 'a.pro' },
        { route: '/', width: 390, rubric: 'copy', confidence: 0.6, observation: 'the empty state does not say what a code is' },
        { route: '/', width: 390, rubric: 'nonsense', confidence: 2, observation: 'x' },
    ];
    fs.writeFileSync(path.join(tmp, 'vision.json'), JSON.stringify(vision));
    const vm = run(['vision-merge', out1, '--vision', path.join(tmp, 'vision.json')]);
    const merged = JSON.parse(fs.readFileSync(path.join(out1, 'vision.json'), 'utf8'));
    check('vision-merge: a vision finding the rules already measured is dropped as a duplicate', merged.duplicates.length === 1 && merged.duplicates[0].rule === 'GLUED-CONTROLS', merged.duplicates);
    check('vision-merge: a new one is kept as ADVISORY with its confidence', merged.advisory.length === 1 && merged.advisory[0].confidence === 0.6 && /ADVISORY/.test(vm.stdout));
    check('vision-merge: a malformed one is rejected with the reasons', merged.rejected.length === 1 && merged.rejected[0].why.length >= 2);
    const rep2 = run(['report', out1]);
    check('report: the advisory section prints apart from the measured findings', /ADVISORY \(vision pass, never gates\)/.test(rep2.stdout));
    const strict = run(['report', out1, '--json']);
    check('report --json: the ranked rows', strict.status === 0 && Array.isArray(JSON.parse(strict.stdout)));
}

// ------------------------------------------------------------ prd merge, pure

{
    const stories = SWEEP.groupStories(SWEEP.rankFindings([
        { route: '/a', state: 'signed-out', width: 390, result: CHECKS.analyse(load('header-mess-390')) },
        { route: '/b', state: 'signed-out', width: 390, result: CHECKS.analyse(load('header-mess-390')) },
    ]), { sweepId: 's', sha: 'abc' });
    const header = stories.filter((s) => /^unslop:header/.test(s.dedupeKey));
    check('stories: one header defect seen on two routes is one story naming both', header.length === 1 && header[0].routes.length === 2, stories.map((s) => s.dedupeKey));
    const sprints = { sprints: [{ stories: { 'S2-001': { id: 'S2-001', notes: header[0].dedupeKey + ' | old', passes: true } } }, { stories: {} }] };
    const m1 = SWEEP.mergeIntoPrd(sprints, header, {});
    check('merge: a sprints[] backlog gets the story in its newest sprint', Object.keys(m1.prd.sprints[1].stories).length === 1 && m1.added[0] === 'S2-002', m1.added);
    check('merge: a defect that came back after a DONE story is added again', m1.added.length === 1);
    const m2 = SWEEP.mergeIntoPrd(m1.prd, header, {});
    check('merge: while it is open it is not added twice', m2.added.length === 0 && m2.skipped.length === 1);
    check('merge: the input is not mutated', Object.keys(sprints.sprints[1].stories).length === 0);
    check('merge: no backlog starts a flat one at S1', SWEEP.mergeIntoPrd(null, header, {}).added[0] === 'S1-001');
    check('component: anything in a header landmark is the header', SWEEP.componentOf({ lm: 'header', sel: 'div.x' }) === 'header' && SWEEP.componentOf({ lm: null, sel: 'main > p' }) === 'main > p');
    check('brief: names the skill, the local base and the compare step', /unslop/.test(SWEEP.briefText('/r', 'http://localhost:3000', {})) && /compare/.test(SWEEP.briefText('/r', 'http://localhost:3000', {})));
}

// ------------------------------------------------------------ the capture adapter

async function adapterTests() {
    const calls = [];
    const page = {
        goto: async (u) => { calls.push(['goto', u]); return null; },
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        url: () => 'http://localhost:1/x',
        evaluate: async (s) => { calls.push(['eval', String(s).slice(0, 20)]); return { viewport: { scrollHeight: 90000 } }; },
        screenshot: async (o) => { calls.push(['shot', o.clip.height, o.fullPage]); return Buffer.from(''); },
    };
    const r = await SWEEP.capture(page, 'http://localhost:1/x', 390, { shotPath: path.join(tmp, 'x.png'), axeSource: 'var axe' });
    check('capture: the probe is evaluated with the requested width', calls.some((c) => c[0] === 'eval' && c[1].startsWith('(function (o)')));
    check('capture: a screenshot is capped at 6000px tall', calls.some((c) => c[0] === 'shot' && c[1] === 6000 && c[2] === true), calls);
    check('capture: an axe run that returns nothing usable reads null, not 0', r.axe === null);
    check('capture: no response reads a null status', r.status === null);
}

// ------------------------------------------------------------ the CLI

{
    const help = spawnSync(process.execPath, [SWEEP_CLI, '--help'], { encoding: 'utf8' });
    check('--help exits 0 and names every subcommand', help.status === 0 && ['routes', 'sweep', 'stories', 'compare', 'pairs', 'vision-merge', 'brief'].every((c) => help.stdout.includes(c)));
    const self = spawnSync(process.execPath, [SWEEP_CLI, '--selftest'], { encoding: 'utf8' });
    check('--selftest passes', self.status === 0 && /selftest passed/.test(self.stdout), self.stdout);
    const bare = spawnSync(process.execPath, [SWEEP_CLI], { encoding: 'utf8' });
    check('no subcommand exits 2', bare.status === 2);
    const ref = spawnSync(process.execPath, [SWEEP_CLI, 'sweep', '--base', 'https://example.com'], { encoding: 'utf8' });
    check('sweep against a non-local base exits 2 and says why', ref.status === 2 && /refused/.test(ref.stderr), ref.stderr);
    const br = spawnSync(process.execPath, [SWEEP_CLI, 'brief', '--repo', '.', '--base', 'https://example.com'], { encoding: 'utf8' });
    check('brief against a non-local base exits 2', br.status === 2);
    const ok = spawnSync(process.execPath, [SWEEP_CLI, 'brief', '--repo', '.', '--base', 'http://localhost:3000', '--return', 'brain'], { encoding: 'utf8' });
    check('brief prints a dispatchable brief', ok.status === 0 && /Return to: brain/.test(ok.stdout));
    const nofind = spawnSync(process.execPath, [SWEEP_CLI, 'report', tmp], { encoding: 'utf8' });
    check('report on a directory with no sweep exits 2', nofind.status === 2);
    const probeHelp = spawnSync(process.execPath, [path.join(SCRIPTS, 'layout-probe.js'), '--component-sha'], { encoding: 'utf8' });
    check('layout-probe --component-sha prints the hash', probeHelp.stdout.trim() === PROBE.componentSha());
    const gate = spawnSync(process.execPath, [GATE, path.join(SNAPS, 'header-mess-390.json')], { encoding: 'utf8' });
    check('rendered-layout-gate reports the component rules on a component snapshot', gate.status === 0 && /GLUED-CONTROLS/.test(gate.stdout) && /component rules/.test(gate.stdout), gate.stdout.slice(0, 1500));
    const gateOld = spawnSync(process.execPath, [GATE, path.join(OLD_SNAPS, 'clean-390.json')], { encoding: 'utf8' });
    check('and says n/a for them on a snapshot without a component harvest', /component rules: n\/a/.test(gateOld.stdout), gateOld.stdout.slice(0, 1500));
    const strictGate = spawnSync(process.execPath, [GATE, '--strict', path.join(SNAPS, 'header-mess-390.json')], { encoding: 'utf8' });
    check('rendered-layout-gate --strict fails on a component finding', strictGate.status === 1);
}

(async () => {
    try {
        await sweepTests();
        await adapterTests();
    } catch (e) {
        failures.push('threw: ' + (e && e.stack ? e.stack : e));
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    if (failures.length) {
        console.error(`FAIL  ${failures.length} of ${passed + failures.length} assertions`);
        for (const f of failures) console.error('  - ' + f);
        process.exitCode = 1;
        return;
    }
    console.log(`PASS  ${passed} assertions over ${files.length} real-browser component snapshots (header mess/fixed, a clean control, ${CHECKS.COMPONENT_CODES.length} plants) and a fake-browser sweep.`);
})();
