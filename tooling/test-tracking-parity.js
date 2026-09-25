#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/tracking-parity.js, driven as a SUBPROCESS.
// Run: node tooling/test-tracking-parity.js
// Exits 1 on any failure, 2 when a child produced no verdict, 0 when all pass.
//
// Three parts, one per surface the script ships:
//
//   static   a fixture source tree under a temp dir. The clean tree exits 0 and
//            prints its population; each planted defect fires ALONE, named by
//            file and reason. Two controls (a skipped primitives directory and a
//            private route) carry untracked buttons that must NOT be flagged.
//   judge    hand-written harvest files, one per verdict class, read by exit code.
//   probe    the printed probe, evaluated in a vm against a hand-rolled fake DOM.
//
// Then the detector-off table: for every planted defect, a copy of the script
// with that one detector disabled by an anchored edit (which must match exactly
// once) is run against the same fixture, and must MISS the defect. A suite that
// goes red on the real script and stays red on the mutant proves nothing about
// the detector; this proves each detector is what catches its defect.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { tally, exitCode } = require('./spawn-budget.js');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'tracking-parity.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tracking-parity-'));

let pass = 0;
let fail = 0;
let infra = 0;
const indeterminate = [];
const offTable = [];

function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

// 0xC0000409, a Windows native fast-fail seen under load in socket-using
// children. This script opens no sockets, so it is not expected here; the guard
// costs nothing and the note makes a retry visible if it ever happens. A crash
// that repeats still reaches the assertion and fails it.
const NATIVE_CRASH = 3221226505;

function runOnce(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60000 });
}

function run(args, script = SCRIPT) {
  let r = runOnce(script, args);
  if (r.status === NATIVE_CRASH) {
    console.log(`note: a child died with 0xC0000409 (native crash, no verdict); retrying it once: ${args.join(' ')}`);
    r = runOnce(script, args);
  }
  if (r.error || r.signal || r.status === null) {
    infra++;
    indeterminate.push(`${args.join(' ')}: ${r.error ? r.error.code : r.signal}`);
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function json(r) {
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// ------------------------------------------------------------------ fixture

const CONFIG = {
  roots: ['app/**/page.tsx'],
  layout: 'app/layout.tsx',
  private: ['app/admin/**'],
  aliases: { '@/': '' },
  skip: ['components/ui'],
};

const CLEAN = {
  'tracking.json': JSON.stringify(CONFIG, null, 2),
  'app/layout.tsx': [
    "import Header from '@/components/header';",
    'export default function RootLayout({ children }: { children: React.ReactNode }) {',
    '  return (',
    '    <html lang="en">',
    '      <body>',
    '        <Header />',
    '        {children}',
    '      </body>',
    '    </html>',
    '  );',
    '}',
  ].join('\n'),
  'app/page.tsx': [
    "import { useState } from 'react';",
    "import Hero from './hero';",
    "import { Button } from '@/components/ui/button';",
    '// a comment that mentions <button> must not count as a tag',
    'export default function Page() {',
    '  const [open, setOpen] = useState<boolean>(false);',
    '  const cta = open ? "close_panel" : "open_panel";',
    '  const small = 1 < 2;',
    '  return (',
    '    <main>',
    '      <Hero />',
    '      <p>Don\'t miss it, <a href="/docs" data-cta="docs_inline">read the docs</a></p>',
    '      <Button data-cta="hero_primary" onClick={() => setOpen(!open)}>Go</Button>',
    '      <div onClick={() => setOpen(true)} data-cta={cta}>panel</div>',
    '      <Dialog.Trigger data-cta="open_dialog">Open</Dialog.Trigger>',
    '      <form data-form="newsletter" onSubmit={(e) => e.preventDefault()}>',
    '        <input name="email" />',
    '        <button type="submit" data-cta="newsletter_submit">Join</button>',
    '        <button type="reset" data-cta="none">Clear</button>',
    '      </form>',
    '    </main>',
    '  );',
    '}',
  ].join('\n'),
  'app/hero.tsx': [
    "import Link from 'next/link';",
    'export default function Hero() {',
    '  return (',
    '    <section>',
    '      <Link href="/pricing" data-cta="hero_pricing" className={`x ${"y"}`}>Pricing</Link>',
    '    </section>',
    '  );',
    '}',
  ].join('\n'),
  'app/admin/page.tsx': [
    '// PRIVATE ROUTE CONTROL: untracked on purpose, must not be flagged.',
    'export default function Admin() {',
    '  return <button onClick={() => {}}>Delete everything</button>;',
    '}',
  ].join('\n'),
  'components/header.tsx': [
    "import Link from 'next/link';",
    "import Deep from '@/components/deep';",
    'export default function Header() {',
    '  return (',
    '    <nav>',
    '      <Link href="/" data-cta="nav_home">Home</Link>',
    '      <Deep />',
    '    </nav>',
    '  );',
    '}',
  ].join('\n'),
  // Reached ONLY through the alias import in header.tsx, itself reached only
  // through the alias import in the layout.
  'components/deep.tsx': [
    'export default function Deep() {',
    '  return <span><a href="/about" data-cta="nav_about">About</a></span>;',
    '}',
  ].join('\n'),
  // SKIPPED-DIRECTORY CONTROL: a primitive that spreads its props, untracked.
  'components/ui/button.tsx': [
    'export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {',
    '  return <button {...props} />;',
    '}',
  ].join('\n'),
};

// Each planted defect replaces ONE line in ONE file, and names the file, the
// tag and the reason fragment it must be reported with.
const DEFECTS = [
  {
    id: 'D1', name: 'button with no attribute', file: 'app/page.tsx',
    from: '<button type="submit" data-cta="newsletter_submit">Join</button>',
    to: '<button type="submit">Join</button>',
    tag: 'button', reason: 'missing data-cta',
  },
  {
    id: 'D2', name: 'onClick div with no attribute', file: 'app/page.tsx',
    from: '<div onClick={() => setOpen(true)} data-cta={cta}>panel</div>',
    to: '<div onClick={() => setOpen(true)}>panel</div>',
    tag: 'div', reason: 'missing data-cta',
  },
  {
    id: 'D3', name: '*Trigger component with no attribute', file: 'app/page.tsx',
    from: '<Dialog.Trigger data-cta="open_dialog">Open</Dialog.Trigger>',
    to: '<Dialog.Trigger>Open</Dialog.Trigger>',
    tag: 'Dialog.Trigger', reason: 'missing data-cta',
  },
  {
    id: 'D4', name: 'non-snake literal', file: 'app/hero.tsx',
    from: 'data-cta="hero_pricing"',
    to: 'data-cta="heroPricing"',
    tag: 'Link', reason: 'not snake_case',
  },
  {
    id: 'D5', name: 'form with no form attribute', file: 'app/page.tsx',
    from: '<form data-form="newsletter" onSubmit={(e) => e.preventDefault()}>',
    to: '<form onSubmit={(e) => e.preventDefault()}>',
    tag: 'form', reason: 'missing data-form',
  },
  {
    id: 'D6', name: 'untracked button reached only through an alias import', file: 'components/deep.tsx',
    from: '<a href="/about" data-cta="nav_about">About</a>',
    to: '<a href="/about" data-cta="nav_about">About</a><button onClick={() => {}}>More</button>',
    tag: 'button', reason: 'missing data-cta',
  },
];

function writeTree(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

function planted(defect) {
  const files = { ...CLEAN };
  const src = files[defect.file];
  if (src.split(defect.from).length !== 2) throw new Error(`fixture anchor for ${defect.id} does not match exactly once`);
  files[defect.file] = src.replace(defect.from, defect.to);
  return files;
}

function staticRun(dir, script = SCRIPT, extra = []) {
  return run(['static', dir, '--config', path.join(dir, 'tracking.json'), ...extra], script);
}

// ------------------------------------------------------------------ static

const cleanDir = writeTree(path.join(TMP, 'clean'), CLEAN);
{
  const r = staticRun(cleanDir);
  check('static: clean tree exits 0', r.code === 0, `exit ${r.code}; ${r.stdout.slice(-300)} ${r.stderr.slice(-300)}`);
  const pop = /population: (\d+) roots?, (\d+) files? reached, (\d+) tags? read, (\d+) clickables? checked/.exec(r.stdout);
  check('static: clean tree prints its population line', !!pop, r.stdout.slice(0, 300));
  // Hand-counted from the fixture above, not derived from the script:
  // roots = app/page.tsx + app/layout.tsx (admin is private).
  // files = page, layout, hero, header, deep (ui/button is skipped).
  // clickables = docs_inline a, Button, onClick div, Dialog.Trigger, 2 form buttons,
  //              hero Link, nav Link, deep a = 9.
  if (pop) {
    check('static: population counts 2 roots', pop[1] === '2', `got ${pop[1]}`);
    check('static: population counts 5 files reached', pop[2] === '5', `got ${pop[2]}`);
    check('static: population counts 9 clickables', pop[4] === '9', `got ${pop[4]}`);
    check('static: tags read is more than clickables', Number(pop[3]) > Number(pop[4]), `tags ${pop[3]}`);
  }
  const j = json(staticRun(cleanDir, SCRIPT, ['--json']));
  check('static --json: clean tree has zero violations and one form', !!j && j.violations.length === 0 && j.population.forms === 1,
    JSON.stringify(j && j.population));
  check('static --json: private root and skipped file are counted, not silent',
    !!j && j.population.privateExcluded === 1 && j.population.skipped === 1, JSON.stringify(j && j.population));
}

// Each defect fires ALONE: exactly one violation, on the planted file, tag and reason.
for (const d of DEFECTS) {
  const dir = writeTree(path.join(TMP, `static-${d.id}`), planted(d));
  const r = staticRun(dir, SCRIPT, ['--json']);
  const j = json(r);
  const v = j && j.violations;
  const ok = r.code === 1 && Array.isArray(v) && v.length === 1
    && v[0].file === d.file && v[0].tag === d.tag && v[0].reason.includes(d.reason);
  check(`static ${d.id}: ${d.name} fires alone`, ok, `exit ${r.code}; ${JSON.stringify(v)}`);
  const t = staticRun(dir);
  check(`static ${d.id}: text report names file:line and reason`,
    t.code === 1 && new RegExp(`${d.file.replace(/[.]/g, '\\.')}:\\d+`).test(t.stdout) && t.stdout.includes(d.reason),
    t.stdout.slice(-300));
}

// Controls, asserted positively: the untracked buttons in the skipped directory
// and the private route exist in the fixture, and are NOT reported. That they
// exist is checked on the fixture text, a different mechanism from the script.
check('static control: the fixture really plants an untracked primitive and private button',
  /<button \{\.\.\.props\} \/>/.test(CLEAN['components/ui/button.tsx'])
  && /<button onClick=\{\(\) => \{\}\}>/.test(CLEAN['app/admin/page.tsx']));
{
  const j = json(staticRun(cleanDir, SCRIPT, ['--json']));
  const files = j ? j.violations.map((v) => v.file) : ['<no json>'];
  check('static control: skipped primitive and private route are not flagged',
    !!j && !files.includes('components/ui/button.tsx') && !files.includes('app/admin/page.tsx'), files.join(','));
}
{
  // With the skip and private entries removed, the same two controls DO fire:
  // they are reached and read, so their silence above is the configuration.
  const cfg = { ...CONFIG, skip: [], private: [] };
  const dir = writeTree(path.join(TMP, 'controls-live'), { ...CLEAN, 'tracking.json': JSON.stringify(cfg) });
  const j = json(staticRun(dir, SCRIPT, ['--json']));
  const files = j ? j.violations.map((v) => v.file).sort() : [];
  check('static control: unskipped, both controls are flagged',
    files.join(',') === 'app/admin/page.tsx,components/ui/button.tsx', files.join(','));
}
{
  // Nothing to scan is INDETERMINATE, never a pass.
  const dir = writeTree(path.join(TMP, 'empty'), { 'tracking.json': JSON.stringify({ ...CONFIG, layout: null }), 'README.md': 'x' });
  const r = staticRun(dir);
  check('static: zero roots exits 2 and says nothing was checked', r.code === 2 && /0 roots/.test(r.stdout + r.stderr),
    `exit ${r.code}; ${r.stdout}${r.stderr}`);
  const noLayout = writeTree(path.join(TMP, 'no-layout'), {
    'tracking.json': JSON.stringify(CONFIG), 'app/page.tsx': 'export default () => <main />;',
  });
  const nl = staticRun(noLayout);
  check('static: a configured layout that does not exist exits 2', nl.code === 2 && /layout/.test(nl.stdout),
    `exit ${nl.code}; ${nl.stdout}`);
  const bad = run(['static', dir, '--config', path.join(dir, 'missing.json')]);
  check('static: a missing config exits 2', bad.code === 2, `exit ${bad.code}`);
}

// ------------------------------------------------------------------ judge

function harvest(elements, url = 'https://example.com/') {
  return JSON.stringify({ url, attribute: 'data-cta', elements });
}
const ev = (name, params = {}) => ({ name, params });
const H = {
  ok: harvest([
    { selector: 'a[data-cta="nav_home"]', value: 'nav_home', events: [ev('cta_click', { cta: 'nav_home' })] },
    { selector: 'button[data-cta="hero_primary"]', value: 'hero_primary', events: [ev('generate_lead')] },
  ]),
  untracked: harvest([
    { selector: 'a[data-cta="nav_home"]', value: 'nav_home', events: [ev('cta_click')] },
    { selector: 'button[data-cta="hero_primary"]', value: 'hero_primary', events: [] },
  ]),
  double: harvest([
    { selector: 'a[data-cta="nav_home"]', value: 'nav_home', events: [ev('cta_click')] },
    { selector: 'button[data-cta="hero_primary"]', value: 'hero_primary', events: [ev('cta_click'), ev('cta_click')] },
  ]),
  // The candidate is all-ok on its own: only the comparison can find the loss.
  candidateLost: harvest([
    { selector: 'a[data-cta="nav_home"]', value: 'nav_home', events: [ev('cta_click')] },
    { selector: 'button[data-cta="hero_primary"]', value: 'hero_primary', events: [ev('cta_click')] },
  ]),
  empty: harvest([]),
};
const hp = {};
for (const [k, body] of Object.entries(H)) {
  hp[k] = path.join(TMP, `harvest-${k}.json`);
  fs.writeFileSync(hp[k], body);
}
hp.garbage = path.join(TMP, 'harvest-garbage.json');
fs.writeFileSync(hp.garbage, '{"url": "https://example.com/", "elements": [');
hp.missing = path.join(TMP, 'harvest-does-not-exist.json');

{
  const r = run(['judge', hp.ok]);
  check('judge: all ok exits 0', r.code === 0, `exit ${r.code}; ${r.stdout}`);
  check('judge: prints its population', /2 elements? judged/.test(r.stdout), r.stdout.slice(0, 200));
}
{
  const r = run(['judge', hp.untracked, '--json']);
  const j = json(r);
  check('judge: one untracked exits 1', r.code === 1, `exit ${r.code}`);
  check('judge --json: the untracked element is classified untracked',
    !!j && j.elements.filter((e) => e.class === 'untracked').map((e) => e.value).join() === 'hero_primary', r.stdout.slice(0, 300));
}
{
  const r = run(['judge', hp.double, '--json']);
  const j = json(r);
  check('judge: one double-fire exits 1', r.code === 1, `exit ${r.code}`);
  check('judge --json: the double element is classified double',
    !!j && j.elements.filter((e) => e.class === 'double').map((e) => e.value).join() === 'hero_primary', r.stdout.slice(0, 300));
}
{
  const alone = run(['judge', hp.candidateLost]);
  check('judge: the candidate alone is all ok (control for lost-event)', alone.code === 0, `exit ${alone.code}`);
  const r = run(['judge', '--baseline', hp.ok, '--candidate', hp.candidateLost, '--json']);
  const j = json(r);
  check('judge: a lost event between baseline and candidate exits 1', r.code === 1, `exit ${r.code}; ${r.stdout.slice(0, 300)}`);
  check('judge --json: the lost event is named', !!j && JSON.stringify(j.lostEvents) === '["generate_lead"]',
    JSON.stringify(j && j.lostEvents));
  const t = run(['judge', '--baseline', hp.ok, '--candidate', hp.candidateLost]);
  check('judge: text report prints lost-event with its name', /lost-event\s+generate_lead/.test(t.stdout), t.stdout.slice(-300));
}
for (const k of ['empty', 'missing', 'garbage']) {
  const r = run(['judge', hp[k]]);
  check(`judge: a ${k} harvest exits 2 (INDETERMINATE)`, r.code === 2, `exit ${r.code}; ${r.stdout}${r.stderr}`);
  check(`judge: a ${k} harvest never prints a PASS verdict`, !/^PASS/m.test(r.stdout), r.stdout);
}
{
  const r = run(['judge', '--baseline', hp.ok, '--candidate', hp.missing]);
  check('judge: a missing candidate beside a good baseline exits 2', r.code === 2, `exit ${r.code}`);
  const none = run(['judge']);
  check('judge: no harvest at all exits 2', none.code === 2, `exit ${none.code}`);
}

// ------------------------------------------------------------------ help

for (const args of [['--help'], ['static', '--help'], ['judge', '--help']]) {
  const r = run(args);
  check(`help: ${args.join(' ')} exits 0 with usage`, r.code === 0 && /usage|Usage/.test(r.stdout), `exit ${r.code}`);
}

// ------------------------------------------------------------------ probe

function probeSource(script = SCRIPT) {
  const r = run(['judge', '--print-probe', '--settle-ms', '1'], script);
  return { code: r.code, src: r.stdout };
}

// A hand-rolled page: elements carry attributes and click handlers, the window
// holds capture listeners and a dataLayer. Clicking dispatches capture-phase
// listeners on the window first, then the element's own handlers, which is the
// order a real click follows.
function fakePage() {
  const listeners = [];
  const log = { preventDefault: 0, handlerSawPrevented: 0, noneClicked: 0, windowOpen: 0 };
  const win = {};
  win.dataLayer = [];
  const originalPush = win.dataLayer.push;
  win.gtag = function gtag() { win.dataLayer.push(arguments); };
  win.open = () => { log.windowOpen++; };
  win.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture: !!(capture === true || (capture && capture.capture)) });
  win.removeEventListener = (type, fn) => {
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) listeners.splice(i, 1);
  };
  function el(tag, attrs, handlers) {
    const node = {
      tagName: tag.toUpperCase(), id: '', attrs, parentElement: null,
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      click() {
        const e = {
          type: 'click', target: node, defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; log.preventDefault++; },
          stopPropagation() {},
        };
        for (const l of listeners.filter((x) => x.type === 'click' && x.capture)) l.fn(e);
        for (const h of handlers) h(e);
      },
    };
    return node;
  }
  const push = (o) => win.dataLayer.push(o);
  const elements = [
    el('a', { 'data-cta': 'nav_home', href: '/' }, [(e) => { if (e.defaultPrevented) log.handlerSawPrevented++; push({ event: 'cta_click', cta: 'nav_home', user_id: 'U-SECRET-1' }); }]),
    el('button', { 'data-cta': 'hero_primary' }, [() => push({ event: 'cta_click' }), () => push({ event: 'cta_click' })]),
    el('button', { 'data-cta': 'via_gtag' }, [() => win.gtag('event', 'sign_up', { method: 'email' })]),
    el('button', { 'data-cta': 'none' }, [() => { log.noneClicked++; }]),
    el('a', { 'data-cta': 'gtm_only', href: '/x' }, [() => push({ event: 'gtm.linkClick' })]),
  ];
  win.document = {
    querySelectorAll(sel) {
      const m = /^\[([\w-]+)\]$/.exec(sel);
      if (!m) throw new Error(`fake DOM only supports [attr] selectors, got ${sel}`);
      return elements.filter((x) => m[1] in x.attrs);
    },
  };
  win.location = { href: 'https://example.com/' };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.window = win;
  return { win, log, listeners, originalPush };
}

async function runProbe(src) {
  const page = fakePage();
  const ctx = vm.createContext(page.win);
  let result = null;
  let error = null;
  try { result = await vm.runInContext(src, ctx, { timeout: 5000 }); } catch (e) { error = e; }
  return { ...page, result, error };
}

async function probeTests() {
  const { code, src } = probeSource();
  check('probe: --print-probe exits 0 and prints a function', code === 0 && /function/.test(src), `exit ${code}`);
  const p = await runProbe(src);
  check('probe: runs in a page without throwing', !p.error && !!p.result, p.error && p.error.message);
  if (!p.result) return;
  const by = Object.fromEntries((p.result.elements || []).map((e) => [e.value, e]));
  check('probe: returns the url', p.result.url === 'https://example.com/', p.result.url);
  check('probe: records ONE event for a normal element', by.nav_home && by.nav_home.events.length === 1
    && by.nav_home.events[0].name === 'cta_click', JSON.stringify(by.nav_home));
  check('probe: records TWO events for a double-wired element', by.hero_primary && by.hero_primary.events.length === 2,
    JSON.stringify(by.hero_primary));
  check('probe: a gtag call is ONE event, not also its dataLayer push', by.via_gtag && by.via_gtag.events.length === 1
    && by.via_gtag.events[0].name === 'sign_up', JSON.stringify(by.via_gtag));
  check('probe: GTM-internal gtm.* pushes are not counted as events', by.gtm_only && by.gtm_only.events.length === 0,
    JSON.stringify(by.gtm_only));
  const clicked = p.result.elements.length;
  check('probe: calls preventDefault on every click', clicked === 4 && p.log.preventDefault === clicked,
    `clicked ${clicked}, preventDefault ${p.log.preventDefault}`);
  check('probe: preventDefault lands BEFORE the element handler (capture phase)', p.log.handlerSawPrevented === 1,
    `handler saw prevented ${p.log.handlerSawPrevented}`);
  check('probe: skips data-cta="none" elements', p.log.noneClicked === 0 && !by.none, `none clicked ${p.log.noneClicked}`);
  check('probe: never records a user-id value', !JSON.stringify(p.result).includes('U-SECRET-1')
    && JSON.stringify(by.nav_home.events[0].params).includes('[redacted]'), JSON.stringify(by.nav_home && by.nav_home.events));
  check('probe: restores dataLayer.push and removes its listeners',
    p.win.dataLayer.push === p.originalPush && p.listeners.length === 0, `listeners left ${p.listeners.length}`);

  // End to end: what the probe harvested, judged. The double-wired element and the
  // gtm-only element must be the two findings.
  const f = path.join(TMP, 'harvest-from-probe.json');
  fs.writeFileSync(f, JSON.stringify(p.result));
  const r = run(['judge', f, '--json']);
  const j = json(r);
  const classes = j ? Object.fromEntries(j.elements.map((e) => [e.value, e.class])) : {};
  check('probe -> judge: double and untracked are found, the rest ok',
    r.code === 1 && classes.hero_primary === 'double' && classes.gtm_only === 'untracked'
    && classes.nav_home === 'ok' && classes.via_gtag === 'ok', `exit ${r.code}; ${JSON.stringify(classes)}`);
}

// ------------------------------------------------------------------ detector off

// Each mutation disables ONE detector with an anchored edit that must match the
// script EXACTLY once, so a refactor that moves the anchor turns this red rather
// than silently mutating nothing.
function mutant(id, anchor, replacement) {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const n = src.split(anchor).length - 1;
  if (n !== 1) return { error: `anchor matched ${n} times: ${anchor}` };
  const p = path.join(TMP, `mutant-${id}`, 'tracking-parity.js');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, src.replace(anchor, replacement));
  return { path: p };
}

function recordOff(id, name, on, off, anchorError) {
  const ok = !anchorError && on && !off;
  offTable.push({ id, name, on: on ? 'caught' : 'MISSED', off: anchorError ? `anchor error` : (off ? 'still caught' : 'missed') });
  check(`detector-off ${id}: ${name} is caught ON and missed OFF`, ok,
    anchorError || `on ${on ? 'caught' : 'missed'}, off ${off ? 'caught' : 'missed'}`);
}

const STATIC_OFF = {
  D1: ["const CLICKABLE_TAGS = new Set(['button', 'a', 'Link', 'Button']);", "const CLICKABLE_TAGS = new Set(['a', 'Link', 'Button']);"],
  D2: ["if (el.attrs.has('onClick')) return true;", "if (false) return true;"],
  D3: ['const CLICKABLE_SUFFIX = /(?:Trigger|Close|Button)$/;', 'const CLICKABLE_SUFFIX = /(?:Close|Button)$/;'],
  D4: ['if (!SNAKE.test(v.value) && v.value !== NONE)', 'if (false)'],
  D5: ["if (el.name === 'form')", "if (el.name === 'form-detector-off')"],
  D6: ['if (spec.startsWith(prefix))', 'if (false)'],
};

function staticCaught(defect, script) {
  const dir = path.join(TMP, `static-${defect.id}`);
  const j = json(staticRun(dir, script, ['--json']));
  return !!j && j.violations.some((v) => v.file === defect.file && v.tag === defect.tag && v.reason.includes(defect.reason));
}

function detectorOffStatic() {
  for (const d of DEFECTS) {
    const [a, b] = STATIC_OFF[d.id];
    const m = mutant(d.id, a, b);
    recordOff(d.id, d.name, staticCaught(d, SCRIPT), m.path ? staticCaught(d, m.path) : true, m.error);
  }
}

function detectorOffJudge() {
  const cases = [
    ['J1', 'one untracked element', "if (events.length === 0) return 'untracked';", "if (events.length === 0) return 'ok';",
      (s) => run(['judge', hp.untracked], s).code === 1],
    ['J2', 'one double-fire', "if (repeated) return 'double';", 'if (false) return \'double\';',
      (s) => run(['judge', hp.double], s).code === 1],
    ['J3', 'lost event between baseline and candidate', 'const lost = [...baseNames].filter((n) => !candNames.has(n)).sort();',
      'const lost = [];', (s) => run(['judge', '--baseline', hp.ok, '--candidate', hp.candidateLost], s).code === 1],
    ['J4', 'empty harvest is INDETERMINATE', 'if (!h.elements.length) return refuse(', 'if (false) return refuse(',
      (s) => run(['judge', hp.empty], s).code === 2],
  ];
  for (const [id, name, a, b, caught] of cases) {
    const m = mutant(id, a, b);
    recordOff(id, name, caught(SCRIPT), m.path ? caught(m.path) : true, m.error);
  }
}

async function detectorOffProbe() {
  const cases = [
    ['P1', 'probe calls preventDefault', 'e.preventDefault();', 'void e;',
      (p) => !!p.result && p.log.preventDefault === 4],
    ['P2', 'probe records the second push of a double-wired element', 'current.events.push(entry);',
      'if (!current.events.some((x) => x.name === entry.name)) current.events.push(entry);',
      (p) => !!p.result && p.result.elements.find((e) => e.value === 'hero_primary').events.length === 2],
  ];
  for (const [id, name, a, b, caught] of cases) {
    const m = mutant(id, a, b);
    const on = caught(await runProbe(probeSource(SCRIPT).src));
    const off = m.path ? caught(await runProbe(probeSource(m.path).src)) : true;
    recordOff(id, name, on, off, m.error);
  }
}

// ------------------------------------------------------------------ main

(async () => {
  try {
    await probeTests();
    detectorOffStatic();
    detectorOffJudge();
    await detectorOffProbe();
  } catch (e) {
    fail++;
    console.log(`FAIL  suite threw: ${e && e.stack}`);
  }
  console.log('\ndetector-off table (defect | detector off | detector on):');
  for (const r of offTable) console.log(`  ${r.id}  ${r.name} | ${r.off} | ${r.on}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${tally(pass, fail, infra)}`);
  if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
  process.exitCode = exitCode(fail, infra);
})();
