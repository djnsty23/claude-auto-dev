#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/live-edit.js.
//
// live-edit puts a proxy in front of a dev server, adds one script tag to each
// HTML page and draws, on that page, the pending changes and the time until
// they would be live. The claims that matter are the ones a wrong build makes
// quietly: an ETA that waits for the wrong landing slot, a part with no
// samples counted as zero without saying so, a tag that corrupts a page whose
// bytes arrive split, a helper that answers a foreign Host, a pill that sits
// on the page's own button, a note that dirties the tree, and a dev server
// left running after its helper stopped. Each block below plants one of those
// with a known answer. Nothing here reads the machine's real locks, receipts
// or repositories: every fixture is built in a temp directory.

const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'live-edit.js');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'live-edit-')));

// The fixtures' git runs under no config but its own, and never climbs out of the temp directory.
fs.writeFileSync(path.join(tmp, 'gitconfig'), '', 'utf8');
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: tmp.replace(/\\/g, '/'),
  GIT_AUTHOR_NAME: 'Suite', GIT_AUTHOR_EMAIL: 'suite@example.test', GIT_COMMITTER_NAME: 'Suite', GIT_COMMITTER_EMAIL: 'suite@example.test',
});

const le = require(SUBJECT);

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' : ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
};
const same = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), { got, want });
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const MIN = 60e3;
const m = (n) => n * MIN;
// A fixed local day with no clock change in it, so slot arithmetic has one answer everywhere.
const at = (h, mi, s = 0) => new Date(2026, 5, 15, h, mi, s).getTime();
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(25);
  }
};
const cleanup = [];
// The suite's own way to end a process tree, so a helper that fails to stop its child leaves nothing behind.
const reap = (pid) => {
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; }
  for (const target of [-pid, pid]) { try { process.kill(target, 'SIGKILL'); return; } catch { /* that one is already gone */ } }
};

const cal = (parts = {}, top = {}) => ({
  kind: le.KIND, version: 1, repo: 'example-org/site', measuredAt: '2026-01-01T00:00:00.000Z', landMinutes: [37],
  parts: {
    gateFull: { ms: [m(4), m(4), m(4)] }, gateFast: { ms: [] }, review: { ms: [m(1), m(1), m(1)] },
    land: { ms: [m(10), m(10), m(10)] }, build: { ms: [m(1), m(1), m(1)] }, direct: { ms: [m(6), m(6), m(6)] }, ...parts,
  },
  ...top,
});
const writeJson = (name, value) => { const f = path.join(tmp, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(value), 'utf8'); return f; };

// ---------------------------------------------------------------------------
console.log('numbers and words');
// ---------------------------------------------------------------------------

same('stats of nothing is null, never zero', [le.stats([]), le.stats(null), le.stats([NaN, -5])], [null, null, null]);
same('stats of one sample', le.stats([m(4)]), { n: 1, low: m(4), median: m(4), high: m(4) });
same('stats of an even list takes the middle pair', le.stats([40, 10, 30, 20]), { n: 4, low: 10, median: 25, high: 40 });
same('stats drops what is not a duration', le.stats([5, NaN, -1, 7, Infinity]).n, 2);
same('durations read as a person says them',
  [0, 45e3, 89e3, 90e3, m(21), m(120), m(125), NaN].map(le.fmtDuration),
  ['1 s', '45 s', '89 s', '2 min', '21 min', '2 h', '2 h 5 min', 'not measured']);
same('a clock names the day when it is not today',
  [le.fmtClock(at(15, 42), at(9, 0)), le.fmtClock(at(15, 42) + 24 * 60 * MIN, at(9, 0)), le.fmtClock(at(15, 42) + 48 * 60 * MIN, at(9, 0)), le.fmtClock(at(15, 42) - 24 * 60 * MIN, at(9, 0))],
  ['15:42', 'tomorrow 15:42', '2026-06-17 15:42', '2026-06-14 15:42']);
same('landing minutes parse, sorted and unique', [le.parseLandMinutes('37'), le.parseLandMinutes('37, 7,37'), le.parseLandMinutes(''), le.parseLandMinutes('none'), le.parseLandMinutes(undefined)], [[37], [7, 37], null, null, null]);
check('a landing minute past 59 is refused', /minutes past the hour/.test(throws(() => le.parseLandMinutes('60')) || ''));
check('a landing minute that is not a number is refused', /minutes past the hour/.test(throws(() => le.parseLandMinutes('7,x')) || ''));
same('the next slot is strictly after the moment', [le.nextSlot(at(15, 36, 59), [37]), le.nextSlot(at(15, 37), [37]), le.nextSlot(at(15, 40), [7, 37]), le.nextSlot(at(15, 10), [7, 37])], [at(15, 37), at(16, 37), at(16, 7), at(15, 37)]);
same('no slots means no wait', [le.nextSlot(at(15, 5), null), le.nextSlot(at(15, 5), [])], [at(15, 5), at(15, 5)]);
same('the last slot is at or before the moment', [le.lastSlot(at(15, 37, 30), [37]), le.lastSlot(at(15, 36), [37]), le.lastSlot(at(15, 36), [])], [at(15, 37), at(14, 37), at(15, 36)]);

// ---------------------------------------------------------------------------
console.log('the estimate');
// ---------------------------------------------------------------------------

{
  const now = at(15, 0);
  const e = le.estimate(cal(), 'full', now);
  // 15:00 + gate 4 + review 1 = 15:05, slot 15:37, + land 10 + build 1 = 15:48.
  same('the queue path waits for the slot: 48 minutes, live at 15:48', [e.medianMs, e.liveAt, e.text, e.clock, e.partial], [m(48), at(15, 48), '48 min', '15:48', false]);
  same('the parts in order, each with its own words', e.parts.map((p) => [p.label, p.text]), [['Gate (full)', '4 min'], ['Review', '60 s'], ['Landing slot 15:37', '42 min'], ['Production build', '60 s']]);
  same('the slot part splits into the wait and the landing', [e.parts[2].waitMs, e.parts[2].slotAt, e.parts[2].medianMs], [m(32), at(15, 37), m(42)]);
  same('a range with one value is given as clock times', e.rangeText, '15:48 to 15:49');
  same('the direct path is its own sum', [e.direct.medianMs, e.direct.text, e.direct.clock, e.direct.mergeMs, e.direct.buildMs, e.direct.n], [m(7), '7 min', '15:07', m(6), m(1), 3]);
  same('nothing is thin at three samples', e.thin, []);

  const crossing = le.estimate(cal({ gateFull: { ms: [m(4), m(40), m(40)] } }), 'full', now);
  // A 40 minute gate ends at 15:41, after the 15:37 slot, so the change waits for 16:37.
  same('a gate that ends after the slot waits a full hour more', [crossing.medianMs, crossing.text, crossing.clock, crossing.parts[2].label], [m(108), '1 h 48 min', '16:48', 'Landing slot 16:37']);
  same('its range spans both slots', [crossing.lowMs, crossing.highMs, crossing.rangeText], [m(48), m(108), '48 min to 1 h 48 min']);

  const fast = le.estimate(cal({ gateFast: { ms: [m(1), m(1), m(1)] } }), 'fast', now);
  same('the fast lane uses its own samples', [fast.parts[0].label, fast.parts[0].medianMs], ['Gate (fast lane)', m(1)]);
  const fastUnmeasured = le.estimate(cal(), 'fast', now);
  same('a fast lane with no samples says so and uses the full gate', [fastUnmeasured.parts[0].label, fastUnmeasured.parts[0].medianMs], ['Gate (full, fast lane not measured)', m(4)]);

  const partial = le.estimate(cal({ review: { ms: [] } }), 'full', now);
  same('a part with no samples is "not measured" and marks the total partial', [partial.partial, partial.parts[1].text, partial.parts[1].measured, partial.parts[1].medianMs], [true, 'not measured', false, null]);
  const thin = le.estimate(cal({ land: { ms: [m(10)] }, review: { ms: [m(1), m(1)] } }), 'full', now);
  same('one or two samples are named as thin', thin.thin, ['review has 2 samples', 'landing slot 15:37 has 1 sample']);

  const noSlots = le.estimate(cal({}, { landMinutes: null }), 'full', now);
  same('without landing slots the merge follows the review', [noSlots.medianMs, noSlots.parts[2].label, noSlots.parts[2].slotAt, noSlots.partial], [m(16), 'Merge', null, false]);
  const noLand = le.estimate(cal({ land: { ms: [] } }, { landMinutes: [] }), 'full', now);
  same('no slots and no landing samples is a part not measured', [noLand.partial, noLand.parts[2].measured], [true, false]);
  same('no direct samples, or no build samples, means no direct path', [le.estimate(cal({ direct: { ms: [] } }), 'full', now).direct, le.estimate(cal({ build: { ms: [] } }), 'full', now).direct], [null, null]);
  same('an estimate past midnight names tomorrow', le.estimate(cal(), 'full', at(23, 50)).clock, 'tomorrow 00:48');
  same('the measurement date and repository travel with it', [e.measuredAt, e.repo], ['2026-01-01T00:00:00.000Z', 'example-org/site']);

  const queue = le.headlineView(e, 'queue');
  same('the queue headline lists the four parts and the direct path as a row', [queue.path, queue.text, queue.clock, queue.rows.length, queue.rows[4]], ['queue', '48 min', '15:48', 5, { label: 'Merged outside the queue', text: '7 min, at 15:07' }]);
  const direct = le.headlineView(e, 'direct');
  same('the direct headline keeps the queue path as a row', [direct.path, direct.text, direct.clock, direct.rangeText, direct.rows], ['direct', '7 min', '15:07', '7 min to 7 min', [
    { label: 'Gate, review and merge', text: '6 min' }, { label: 'Production build', text: '60 s' }, { label: 'Through the landing queue', text: '48 min, at 15:48' }]]);
  const fallback = le.headlineView(le.estimate(cal({ direct: { ms: [] } }), 'full', now), 'direct');
  same('a direct headline with no direct samples falls back to the queue', [fallback.path, fallback.rows.length], ['queue', 4]);
}

{
  const good = writeJson('cal/good.json', cal());
  const wrong = writeJson('cal/wrong.json', { kind: 'something-else', parts: {} });
  fs.writeFileSync(path.join(tmp, 'cal', 'torn.json'), '{"kind":', 'utf8');
  same('a calibration file reads back', le.readCalibration(good).ok, true);
  check('no file named', /no calibration file/.test(le.readCalibration(null).why));
  check('a missing file names itself and the error', /cannot read nope\.json: ENOENT/.test(le.readCalibration(path.join(tmp, 'cal', 'nope.json')).why), le.readCalibration(path.join(tmp, 'cal', 'nope.json')).why);
  check('a torn file is refused', /cannot read torn\.json/.test(le.readCalibration(path.join(tmp, 'cal', 'torn.json')).why));
  check('a file of another kind is refused', /wrong\.json is not a autodev-live-edit-calibration file/.test(le.readCalibration(wrong).why));
}

// ---------------------------------------------------------------------------
console.log('the working tree');
// ---------------------------------------------------------------------------

const git = (dir, ...args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout;
};
const makeRepo = (name, pkg) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'package.json'), pkg, 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'one\ntwo\n', 'utf8');
  git(dir, 'add', 'package.json', 'src/a.txt');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
};
const plain = path.join(tmp, 'plain');
fs.mkdirSync(plain);
const repo = makeRepo('site', '{"name":"site"}\n');
const NOW = at(15, 0);

{
  const off = le.computeState({ dir: plain, now: NOW });
  same('a folder outside git draws "not a branch"', [off.ok, off.pill, off.eta, off.changes.count, /not inside a git repository/.test(off.why)], [false, 'not a branch', null, 0, true]);
  same('a folder outside git has no journal and no default calibration', [le.journalPath(plain), le.defaultCalibration(plain), le.readNotes(plain, 'x'), le.addNote(plain, 'text', 'origin/main', NOW)], [null, null, [], null]);
  const clean = le.computeState({ dir: repo, now: NOW });
  same('a clean branch has nothing to ship', [clean.ok, clean.pill, clean.eta, clean.etaNote, clean.changes.count, clean.lane], [true, 'No pending changes', null, 'Nothing to ship yet.', 0, null]);
  check('a base that does not exist is said, not guessed', /cannot find the branch point with origin\/nope/.test(le.pendingFiles(repo, 'origin/nope').why));
}

// One committed change, one unstaged edit and three untracked files: text, binary and empty.
fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'committed\n', 'utf8');
git(repo, 'add', 'src/b.txt');
git(repo, 'commit', '-q', '-m', 'on the branch');
fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
fs.writeFileSync(path.join(repo, 'new.txt'), 'first\nsecond', 'utf8');
fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([1, 0, 2, 10]));
fs.writeFileSync(path.join(repo, 'empty.txt'), '', 'utf8');
const treeBefore = git(repo, 'status', '--porcelain');

{
  same('lines in an untracked file: text, no trailing newline, binary, empty, missing',
    [le.countLines(path.join(repo, 'src', 'a.txt')), le.countLines(path.join(repo, 'new.txt')), le.countLines(path.join(repo, 'bin.dat')), le.countLines(path.join(repo, 'empty.txt')), le.countLines(path.join(repo, 'nope.txt'))],
    [3, 2, null, 0, null]);
  const p = le.pendingFiles(repo, 'origin/main');
  same('pending is the working tree against the branch point: committed, edited and untracked', p.files, [
    { path: 'src/a.txt', added: 1, deleted: 0 }, { path: 'src/b.txt', added: 1, deleted: 0 },
    { path: 'bin.dat', added: null, deleted: 0, untracked: true }, { path: 'empty.txt', added: 0, deleted: 0, untracked: true }, { path: 'new.txt', added: 2, deleted: 0, untracked: true }]);
  same('the merge base is the base commit', p.mergeBase, git(repo, 'rev-parse', 'origin/main').trim());

  same('a small text diff takes the fast lane', le.classifyLane(p.root, p.mergeBase, [{ path: 'src/a.txt', added: 1, deleted: 0 }]).kind, 'fast');
  const pkgLane = le.classifyLane(p.root, p.mergeBase, [{ path: 'package.json', added: 1, deleted: 0 }]);
  check('a package.json change takes the full gate, with the reason', pkgLane.kind === 'full' && /package\.json/.test(pkgLane.reasons.join(' ')), pkgLane);
  const bad = makeRepo('badconfig', '{"name":"x","autodevFastLane":5}\n');
  const badLane = le.classifyLane(bad, git(bad, 'rev-parse', 'HEAD').trim(), [{ path: 'src/a.txt', added: 1, deleted: 0 }]);
  check('an unreadable fast lane config fails closed to the full gate', badLane.kind === 'full' && /unreadable/.test(badLane.reasons[0]), badLane);

  const s = le.computeState({ dir: repo, now: NOW });
  same('without notes the pill counts files and lists them', [s.pill, s.changes.count, s.changes.noted, s.changes.lines[0], s.changes.lines[2], s.changes.summary],
    ['5 changes', 5, false, 'src/a.txt  +1 -0', 'bin.dat  +? -0', '5 files, +4 -0 lines since origin/main']);
  check('a binary file sends the change to the full gate', s.lane.kind === 'full' && /bin\.dat/.test(s.lane.reasons.join(' ')), s.lane);
  check('no calibration is said in words, with no number invented', s.eta === null && /^ETA not measured: cannot read calibration\.json/.test(s.etaNote), s.etaNote);

  // The default calibration sits in the shared git dir: one file for every worktree of a clone.
  const wt = path.join(tmp, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'second', wt, 'origin/main');
  same('every worktree of a clone reads one calibration file', le.defaultCalibration(wt), le.defaultCalibration(repo));
  check('each worktree keeps its own journal', le.journalPath(wt) !== le.journalPath(repo) && le.journalPath(wt) !== null);
  fs.mkdirSync(path.dirname(le.defaultCalibration(repo)), { recursive: true });
  fs.writeFileSync(le.defaultCalibration(repo), JSON.stringify(cal()), 'utf8');
  const ready = le.computeState({ dir: repo, now: NOW });
  same('with the default calibration the ETA is drawn', [ready.eta.view.path, ready.eta.view.text, ready.eta.view.clock, ready.etaNote], ['queue', '48 min', '15:48', null]);
  same('the direct headline is chosen by the caller', le.computeState({ dir: repo, now: NOW, headline: 'direct' }).eta.view.text, '7 min');
  const noDirect = le.computeState({ dir: repo, now: NOW, headline: 'direct', calibrationFile: writeJson('cal/no-direct.json', cal({ direct: { ms: [] } })) });
  same('a direct headline that cannot be met says it is the queue path', [noDirect.eta.view.path, noDirect.etaNote], ['queue', 'No merge outside the queue is measured, so this is the queue path.']);
  const rough = le.computeState({ dir: repo, now: NOW, calibrationFile: writeJson('cal/rough.json', cal({ review: { ms: [] }, land: { ms: [m(10)] } })) });
  same('a partial and thin estimate carries both caveats', rough.etaNote, 'Some parts are not measured, so this is a floor. Thin data: landing slot 15:37 has 1 sample.');

  const note = le.addNote(repo, '  Hero   button\n now reads: Go ', 'origin/main', NOW);
  same('a note is one line, stamped with the branch point', [note.text, note.base, note.at], ['Hero button now reads: Go', p.mergeBase, iso(NOW)]);
  same('a note with no words is not written', le.addNote(repo, '   ', 'origin/main', NOW), null);
  same('a long note is cut at 160 characters', le.addNote(repo, 'x'.repeat(400), 'origin/main', NOW).text.length, 160);
  for (let i = 3; i <= 8; i++) le.addNote(repo, `change ${i}`, 'origin/main', NOW);
  fs.appendFileSync(le.journalPath(repo), '{"at":\n' + JSON.stringify({ at: iso(NOW), text: 'from an older base', base: 'f'.repeat(40) }) + '\n', 'utf8');
  same('a torn line and a note from another base are left out', le.readNotes(repo, p.mergeBase).length, 8);
  const noted = le.computeState({ dir: repo, now: NOW });
  same('with notes the pill counts instructions and shows the newest six', [noted.pill, noted.changes.noted, noted.changes.lines.length, noted.changes.more, noted.changes.lines[5]], ['8 changes', true, 6, 2, 'change 8']);
  same('the notes never touch the tree', git(repo, 'status', '--porcelain'), treeBefore);
}

// ---------------------------------------------------------------------------
console.log('the overlay');
// ---------------------------------------------------------------------------

const CORNERS = ['bottom-left', 'bottom-right', 'top-right', 'top-left', 'right', 'left'];
const READY = {
  ok: true, pill: '8 changes', etaNote: 'Thin data: review has 1 sample.',
  changes: { count: 8, lines: ['Hero button now reads: Go', 'Footer year'], more: 2, summary: '1 file, +2 -2 lines since origin/main' },
  eta: { view: { text: '48 min', clock: '15:48', rangeText: '40 min to 1 h', rows: [{ label: 'Gate (full)', text: '4 min' }, { label: 'Review', text: '1 min' }] } },
};

// The smallest page the overlay can run in. The pill's rectangle is 100 px to the right for each
// later corner, and `under` names what the page has at each corner, so a test places controls by name.
function fakeDom({ shadow = true, observer = true } = {}) {
  const dom = { nodes: [], fetches: [], intervals: [], listeners: {}, observers: [], under: {}, next: () => Promise.reject(new Error('no helper')) };
  const find = (pred) => dom.nodes.find(pred);
  dom.host = () => find((n) => n.tag === 'live-edit-overlay');
  dom.corner = () => find((n) => n.className === 'le').attrs['data-corner'];
  const node = (tag) => {
    const n = {
      tag, className: '', children: [], attrs: {}, listeners: {}, isConnected: false, text: '',
      setAttribute(k, v) { n.attrs[k] = String(v); },
      getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; },
      removeAttribute(k) { delete n.attrs[k]; },
      appendChild(c) { n.children.push(c); return c; },
      removeChild(c) { n.children.splice(n.children.indexOf(c), 1); return c; },
      addEventListener(type, fn) { n.listeners[type] = fn; },
      getBoundingClientRect() { const i = CORNERS.indexOf(dom.corner()); return { left: i * 100, right: i * 100 + 40, top: 0, bottom: 30 }; },
      get firstChild() { return n.children[0] || null; },
      get textContent() { return n.text + n.children.map((c) => c.textContent).join(''); },
      set textContent(v) { n.text = String(v); n.children = []; },
    };
    if (shadow) n.attachShadow = () => { n.shadow = node('#shadow'); return n.shadow; };
    dom.nodes.push(n);
    return n;
  };
  const documentElement = node('html');
  documentElement.appendChild = (c) => { documentElement.children.push(c); c.isConnected = true; return c; };
  dom.document = {
    documentElement,
    createElement: node,
    createTextNode: (text) => ({ textContent: String(text) }),
    elementsFromPoint: (x) => [dom.host(), ...(dom.under[CORNERS[Math.floor(x / 100)]] || [])],
  };
  dom.window = {
    fetch: (url, opts) => { dom.fetches.push([url, opts]); return dom.next(); },
    addEventListener: (type, fn) => { dom.listeners[type] = fn; },
    setInterval: (fn, ms) => { dom.intervals.push([fn, ms]); return 1; },
    getComputedStyle: (el) => ({ position: el.position || 'static' }),
  };
  if (observer) dom.window.MutationObserver = class { constructor(fn) { this.fn = fn; dom.observers.push(this); } observe(target, opts) { this.target = target; this.opts = opts; } };
  return dom;
}
const answer = (state) => () => Promise.resolve({ json: () => state });
const control = (position = 'static') => { const el = { parentElement: null, position }; el.closest = () => el; return el; };
const insidePinned = () => { const el = { parentElement: { position: 'sticky', parentElement: null }, position: 'static' }; el.closest = () => el; return el; };
const CONFIG = { variant: 'pill', css: le.OVERLAY_CSS, stateUrl: '/__live-edit/state', pollMs: 2000, corners: CORNERS };

async function overlaySuite() {
  const dom = fakeDom();
  dom.next = answer(READY);
  dom.under['bottom-left'] = [control()];
  const api = le.overlayClient(dom.window, dom.document, CONFIG);
  same('it mounts once on the root element, outside the page body', [dom.host().isConnected, dom.document.documentElement.children.length, api.host === dom.host()], [true, 1, true]);
  same('it starts idle, closed, as the chosen variant', [api.wrap.getAttribute('data-state'), api.wrap.getAttribute('data-open'), api.wrap.getAttribute('data-variant'), api.pill.getAttribute('aria-expanded')], ['idle', 'false', 'pill', 'false']);
  same('it polls the helper every two seconds without the cache', [dom.fetches[0], dom.intervals.length, dom.intervals[0][1]], [['/__live-edit/state', { cache: 'no-store' }], 1, 2000]);
  check('a second copy on the same page is the first one', le.overlayClient(dom.window, dom.document, CONFIG) === api && dom.fetches.length === 1);
  check('the style lives inside the shadow root', dom.host().shadow.children[0].textContent === le.OVERLAY_CSS && dom.host().shadow.children[1] === api.wrap);

  await api.refresh();
  same('a ready state draws the count, the duration and the clock time', [api.wrap.getAttribute('data-state'), api.pill.textContent], ['ready', '8 changes48 min · 15:48']);
  const panel = api.panel.textContent;
  check('the panel carries the headline, the range and each part', ['Live in production in about', '48 min, at 15:48', 'Range 40 min to 1 h', 'Gate (full)4 min', 'Review1 min'].every((t) => panel.includes(t)), panel);
  check('the panel lists the changes, the hidden count, the summary and the caveat', ['Pending changes', 'Hero button now reads: Go', 'Footer year', 'and 2 earlier', '1 file, +2 -2 lines since origin/main', 'Thin data: review has 1 sample.'].every((t) => panel.includes(t)), panel);
  same('first placement leaves a corner that holds any control', dom.corner(), 'bottom-right');

  // An in-flow control scrolls out from under a fixed pill, so on a poll it does not chase the page.
  dom.under['bottom-right'] = [control()];
  await api.refresh();
  same('on a poll an in-flow control under the pill does not move it', dom.corner(), 'bottom-right');
  dom.under['bottom-right'] = [control('fixed')];
  await api.refresh();
  same('a pinned control under the pill moves it to the next free corner', dom.corner(), 'top-right');
  dom.under['top-right'] = [{ shadowRoot: {} }];
  await api.refresh();
  same('another tool\'s widget (a shadow host) moves it too', dom.corner(), 'top-left');
  for (const c of CORNERS) dom.under[c] = [insidePinned()];
  dom.under['bottom-left'] = [control()];
  dom.listeners.resize();
  same('when every spot holds a control, a resize picks the first with nothing pinned', [dom.corner(), api.wrap.getAttribute('data-blocked')], ['bottom-left', null]);
  dom.under['bottom-left'] = [insidePinned()];
  same('when every spot is pinned it stays first and says so', [api.place(true), dom.corner(), api.wrap.getAttribute('data-blocked')], [null, 'bottom-left', 'true']);
  dom.under = { 'bottom-left': [{ closest: () => null }, {}] };
  same('plain content under the pill is not a control', [api.place(true), api.wrap.getAttribute('data-blocked')], ['bottom-left', null]);

  api.pill.listeners.click();
  same('a tap opens the panel', [api.wrap.getAttribute('data-open'), api.pill.getAttribute('aria-expanded')], ['true', 'true']);
  api.pill.listeners.click();
  same('a second tap closes it', [api.wrap.getAttribute('data-open'), api.pill.getAttribute('aria-expanded')], ['false', 'false']);

  api.draw({ ok: true, pill: '1 change', changes: { count: 1, lines: ['src/a.txt  +1 -0'], more: 0, summary: '1 file, +1 -0 lines since origin/main' }, eta: null, etaNote: 'ETA not measured: cannot read calibration.json: ENOENT.' });
  check('changes with no calibration draw as unmeasured, with the reason and no number', api.wrap.getAttribute('data-state') === 'unmeasured' && api.pill.textContent === '1 change' && api.panel.textContent.includes('ETA not measured') && !api.panel.textContent.includes('Live in production'), api.panel.textContent);
  api.draw({ ok: true, pill: 'No pending changes', changes: { count: 0, lines: [] }, eta: null, etaNote: 'Nothing to ship yet.' });
  same('no changes draw as idle', [api.wrap.getAttribute('data-state'), api.panel.textContent], ['idle', 'Nothing to ship yet.']);
  api.draw({ ok: false, pill: 'not a branch', why: 'the folder is not inside a git repository', changes: { count: 0, lines: [] }, eta: null });
  same('a state that is not ok draws its reason only', [api.wrap.getAttribute('data-state'), api.panel.textContent], ['stale', 'the folder is not inside a git repository']);

  dom.next = () => Promise.reject(new Error('refused'));
  same('a helper that stopped is said on the pill', [await api.refresh(), api.wrap.getAttribute('data-state'), api.pill.textContent], [null, 'stale', 'Live edit helper stopped']);

  same('attach is a no-op while mounted', api.attach(), false);
  dom.host().isConnected = false;
  dom.observers[0].fn();
  same('a page that drops the element gets it back', [dom.host().isConnected, dom.document.documentElement.children.length, dom.observers[0].target === dom.document.documentElement], [true, 2, true]);

  const old = fakeDom({ shadow: false, observer: false });
  old.next = answer(READY);
  const oldApi = le.overlayClient(old.window, old.document, { ...CONFIG, variant: 'dot' });
  await oldApi.refresh();
  same('a browser with no shadow root or observer still draws', [oldApi.wrap.getAttribute('data-variant'), oldApi.wrap.getAttribute('data-state'), old.host().children[1] === oldApi.wrap], ['dot', 'ready', true]);

  // The browser gets the function's source alone. Run that source in an empty realm: a name
  // it borrowed from this module would throw here.
  const sent = fakeDom();
  sent.next = answer(READY);
  const source = le.overlayScript('bar');
  let threw = null;
  try { vm.runInNewContext(source, { window: sent.window, document: sent.document }); } catch (e) { threw = e.message; }
  const live = sent.window.__liveEditOverlay;
  same('the served script runs with nothing but window and document', [threw, Boolean(live)], [null, true]);
  if (live) {
    await live.refresh();
    live.pill.listeners.click();
    sent.listeners.resize();
    same('the served script draws, opens and places', [live.wrap.getAttribute('data-variant'), live.wrap.getAttribute('data-state'), live.wrap.getAttribute('data-open'), sent.corner(), sent.intervals[0][1]], ['bar', 'ready', 'true', 'bottom-left', 2000]);
  }
  check('the served script names the state endpoint and every corner', source.includes('"stateUrl":"/__live-edit/state"') && CORNERS.every((c) => source.includes(`"${c}"`)));
}

// ---------------------------------------------------------------------------
// The proxy, against a dev server that lives in this process
// ---------------------------------------------------------------------------

const TAG = '<script src="/__live-edit/overlay.js" defer></script>';
const PAGE = '<!doctype html><html><head><title>ă</title></head><body>page</body></html>';

const request = (port, urlPath, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, agent: false, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end(body);
});
const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const shut = (server) => new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); });
const refused = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(true));
});
const count = (text, part) => text.split(part).length - 1;

async function startUpstream() {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    const html = { 'content-type': 'text/html; charset=utf-8' };
    if (req.url === '/' && req.method === 'HEAD') { res.writeHead(200, { ...html, 'content-length': '10' }); res.end(); return; }
    // The opening head tag arrives in two pieces, as a streamed page can send it.
    if (req.url === '/') { res.writeHead(200, { ...html, 'content-length': String(Buffer.byteLength(PAGE)) }); res.write(PAGE.slice(0, 24)); setTimeout(() => res.end(PAGE.slice(24)), 20); return; }
    if (req.url === '/nohead') { res.writeHead(200, html); res.end('<p>fragment</p>'); return; }
    if (req.url === '/csp') { res.writeHead(200, { ...html, 'content-security-policy': "script-src 'nonce-abc123' 'strict-dynamic'" }); res.end(PAGE); return; }
    if (req.url === '/notmod') { res.writeHead(304, html); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/target?x=1` }); res.end(); return; }
    if (req.url === '/plain') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '11' }); res.end('<head>plain'); return; }
    if (req.url === '/post') { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(Buffer.concat(parts)); }); return; }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such page');
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ upgrade: true, url: req.url, headers: req.headers });
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    // /hmr-held never hangs up by itself, and /hmr-bye hangs up right after its echo.
    if (req.url !== '/hmr-held') socket.on('end', () => socket.destroy());
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => { socket.write(d); if (req.url === '/hmr-bye') socket.end(); });
  });
  const port = await listen(server);
  cleanup.push(() => { for (const s of sockets) s.destroy(); server.close(); });
  return { server, port, seen, sockets, url: `http://127.0.0.1:${port}` };
}

// Opens a raw upgrade through the proxy and resolves once the echo of `ping-1` came back, or the socket closed.
const upgrade = (port, host, { path: url = '/hmr', halfOpen = false, origin = `http://${host}` } = {}) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: halfOpen });
  let head = '';
  let sent = false;
  socket.on('connect', () => socket.write(`GET ${url} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: test\r\nOrigin: ${origin}\r\n\r\n`));
  socket.on('data', (d) => {
    head += d.toString('latin1');
    if (!sent && head.includes('\r\n\r\n')) { sent = true; socket.write('ping-1'); }
    if (head.endsWith('ping-1')) resolve({ echoed: true, head, socket });
  });
  socket.on('error', () => {});
  socket.on('close', () => resolve({ echoed: false, head, socket }));
});

async function proxySuite() {
  same('the tag carries the page nonce when its policy pins by nonce', [le.scriptTag(undefined), le.scriptTag("script-src 'nonce-abc123' 'strict-dynamic'"), le.scriptTag("script-src 'sha256-AAAA='")],
    [TAG, '<script src="/__live-edit/overlay.js" defer nonce="abc123"></script>', TAG]);

  const run = (chunks) => { const inj = le.injector(TAG); return Buffer.concat([...chunks.map((c) => inj.push(Buffer.from(c))), inj.end()]).toString('utf8'); };
  same('the tag goes right after the opening head tag', run(['<html><head><title>x</title></head></html>']), `<html><head>${TAG}<title>x</title></head></html>`);
  same('a head with attributes, in capitals', run(['<HTML><HEAD lang="en"><title>x</title>']), `<HTML><HEAD lang="en">${TAG}<title>x</title>`);
  same('a head tag split across two chunks', run(['<html><he', 'ad><body>', 'later <head> text']), `<html><head>${TAG}<body>later <head> text`);
  same('a header element is not a head', run(['<body><header>x</header></body>']), `<body><header>x</header></body>${TAG}`);
  same('a page with no head gets the tag at the end', run(['<p>fragment</p>']), `<p>fragment</p>${TAG}`);
  {
    const src = Buffer.from('<!-- ăș --><html><head><title>ț</title></head></html>', 'utf8');
    const cut = src.indexOf(Buffer.from('ă', 'utf8')) + 1;
    const inj = le.injector(TAG);
    const out = Buffer.concat([inj.push(src.subarray(0, cut)), inj.push(src.subarray(cut)), inj.end()]).toString('utf8');
    same('a character split across two chunks survives', out, src.toString('utf8').replace('<head>', '<head>' + TAG));
    const big = Buffer.alloc(256 * 1024, 0x61);
    const hold = le.injector(TAG);
    const first = hold.push(Buffer.from('<p>'));
    const flushed = hold.push(big);
    same('a long page with no head is not held back for ever', [first.length, flushed.length, hold.end().toString()], [0, big.length + 3, TAG]);
    const late = le.injector(TAG);
    late.push(big);
    same('a head after the flush still gets the tag, once', [late.push(Buffer.from('<head>')).toString(), late.push(Buffer.from('<head>')).toString(), late.end().toString()], ['<head>' + TAG, '<head>', '']);
  }

  same('only this machine\'s names are loopback', ['localhost:3417', '127.0.0.1', '[::1]:80', 'app.localhost:3000', 'LOCALHOST', 'evil.example', 'localhost.evil.example', '', undefined].map(le.loopbackHost), [true, true, true, true, true, false, false, false, false]);
  same('the dev server sees its own host and origin, uncompressed',
    le.upstreamHeaders({ host: 'localhost:3417', 'accept-encoding': 'gzip', origin: 'http://localhost:3417', referer: 'http://localhost:3417/page?x=1', cookie: 'a=b' }, new URL('http://localhost:4000')),
    { host: 'localhost:4000', origin: 'http://localhost:4000', referer: 'http://localhost:4000/page?x=1', cookie: 'a=b' });
  same('an origin that is not a URL is dropped', le.upstreamHeaders({ host: 'x', origin: 'null' }, new URL('http://localhost:4000')), { host: 'localhost:4000' });
  // Found in review of PR 580: a foreign Origin was rewritten to the dev server's, so a page on another site reached it looking same-origin.
  same('a foreign origin and referer are dropped, never rewritten to the dev server\'s',
    le.upstreamHeaders({ host: 'localhost:3417', origin: 'https://evil.example', referer: 'https://evil.example/x' }, new URL('http://localhost:4000')), { host: 'localhost:4000' });
  same('only an Origin that is this proxy is its own', [{ host: 'localhost:3417' }, { host: 'localhost:3417', origin: 'http://localhost:3417' }, { host: 'localhost:3417', origin: 'https://evil.example' }, { host: 'localhost:3417', origin: 'http://localhost:3418' }, { host: 'localhost:3417', origin: 'null' }].map(le.foreignOrigin), [false, false, true, true, true]);
  same('a command line quotes what holds a space', [le.commandLine(['npm', 'run', 'dev', '--', '--port', '4000']), le.commandLine(['node', 'a b.js', 'say "hi"'])], ['npm run dev -- --port 4000', 'node "a b.js" "say \\"hi\\""']);

  const up = await startUpstream();
  let state = { ok: true, pill: 'from the test' };
  const logs = [];
  const proxy = le.createProxy({ upstream: new URL(up.url), getState: () => state, variant: 'dot', log: (l) => logs.push(l) });
  const port = await listen(proxy);
  cleanup.push(() => { for (const s of proxy.liveEditSockets) s.destroy(); proxy.close(); });

  const page = await request(port, '/');
  same('an HTML page comes back whole, with the tag once, right after head', [page.status, page.body, page.headers['content-length']], [200, PAGE.replace('<head>', '<head>' + TAG), undefined]);
  const frag = await request(port, '/nohead');
  same('a fragment gets the tag at the end', frag.body, '<p>fragment</p>' + TAG);
  check('a nonce policy gets its nonce on the tag', (await request(port, '/csp')).body.includes('<head><script src="/__live-edit/overlay.js" defer nonce="abc123"></script>'));
  const text = await request(port, '/plain');
  same('anything that is not HTML passes through untouched', [text.body, text.headers['content-length']], ['<head>plain', '11']);
  const headOnly = await request(port, '/', { method: 'HEAD' });
  same('a HEAD keeps its length and gets no body', [headOnly.status, headOnly.body, headOnly.headers['content-length']], [200, '', '10']);
  same('a 304 stays empty', [(await request(port, '/notmod')).status, (await request(port, '/notmod')).body], [304, '']);
  same('a redirect to the dev server is rewritten to the helper', (await request(port, '/redirect')).headers.location, `http://localhost:${port}/target?x=1`);
  same('a request body reaches the dev server', (await request(port, '/post', { method: 'POST', body: 'hello' })).body, 'hello');
  await request(port, '/echo', { headers: { origin: `http://localhost:${port}`, referer: `http://localhost:${port}/page?x=1`, 'accept-encoding': 'gzip' } });
  const echo = up.seen.find((s) => s.url === '/echo').headers;
  same('the dev server saw its own host, origin and referer, and no compression', [echo.host, echo.origin, echo.referer, echo['accept-encoding']], [`127.0.0.1:${up.port}`, up.url, `${up.url}/page?x=1`, undefined]);

  const script = await request(port, '/__live-edit/overlay.js');
  check('the overlay script is served uncached, as the chosen variant', script.status === 200 && /javascript/.test(script.headers['content-type']) && script.headers['cache-control'] === 'no-store' && script.body.startsWith('(function overlayClient(') && script.body.includes('"variant":"dot"'), script.headers);
  const st = await request(port, '/__live-edit/state?t=1');
  same('the state is whatever the helper computes, as JSON', [st.status, JSON.parse(st.body), st.headers['cache-control']], [200, state, 'no-store']);
  state = { ok: true, pill: 'changed' };
  same('the state is read again on each request', JSON.parse((await request(port, '/__live-edit/state')).body).pill, 'changed');
  same('an unknown helper path is a 404, not a pass-through', [(await request(port, '/__live-edit/nope')).status, up.seen.some((s) => String(s.url).startsWith('/__live-edit'))], [404, false]);
  const foreign = await request(port, '/__live-edit/state', { headers: { host: 'evil.example' } });
  same('a foreign Host is refused before anything is read', [foreign.status, (await request(port, '/', { headers: { host: 'evil.example' } })).status, foreign.body.includes('changed')], [403, 403, false]);
  const crossSite = await request(port, '/cross-site', { method: 'POST', body: 'x', headers: { origin: 'https://evil.example' } });
  same('a request from a page on another site is refused and never reaches the dev server', [crossSite.status, up.seen.some((s) => s.url === '/cross-site')], [403, false]);

  const ws = await upgrade(port, `localhost:${port}`);
  const upgradeSeen = up.seen.find((s) => s.upgrade);
  same('hot reload\'s socket is handed to the dev server and echoes', [ws.echoed, /^HTTP\/1\.1 101/.test(ws.head), upgradeSeen && upgradeSeen.url, upgradeSeen && upgradeSeen.headers.host, upgradeSeen && upgradeSeen.headers.origin], [true, true, '/hmr', `127.0.0.1:${up.port}`, up.url]);
  same('both ends of an open socket are tracked', proxy.liveEditSockets.size, 2);
  ws.socket.destroy();
  check('and forgotten when it closes', Boolean(await until(() => proxy.liveEditSockets.size === 0)));
  const badWs = await upgrade(port, 'evil.example');
  same('an upgrade with a foreign Host is dropped', [badWs.echoed, badWs.head], [false, '']);
  const crossWs = await upgrade(port, `localhost:${port}`, { path: '/hmr-cross', origin: 'https://evil.example' });
  same('an upgrade from a page on another site is dropped and never reaches the dev server', [crossWs.echoed, crossWs.head, up.seen.some((s) => s.url === '/hmr-cross')], [false, '', false]);
  // Each end can be left half open by the other. Neither may keep the pair alive.
  const held = await upgrade(port, `localhost:${port}`, { path: '/hmr-held' });
  held.socket.destroy();
  check('a tab that closes ends the pair, even if the dev server never hangs up', held.echoed && Boolean(await until(() => proxy.liveEditSockets.size === 0, 4000)), proxy.liveEditSockets.size);
  for (const s of up.sockets) s.destroy();
  const kept = await upgrade(port, `localhost:${port}`, { path: '/hmr-bye', halfOpen: true });
  check('a dev server that hangs up ends the pair, even if the tab never does', kept.echoed && Boolean(await until(() => proxy.liveEditSockets.size === 0, 4000)), proxy.liveEditSockets.size);
  kept.socket.destroy();
  for (const s of proxy.liveEditSockets) s.destroy();

  const dead = await le.freePort();
  check('a free port is a real port', Number.isInteger(dead) && dead > 0 && await refused(dead));
  const downLogs = [];
  const down = le.createProxy({ upstream: new URL(`http://127.0.0.1:${dead}`), getState: () => ({}), log: (l) => downLogs.push(l) });
  const downPort = await listen(down);
  const waiting = await request(downPort, '/');
  check('a dev server that is not up yet gets a page that reloads by itself', waiting.status === 502 && waiting.body.includes('http-equiv="refresh"') && /did not answer \/: ECONNREFUSED/.test(downLogs.join('\n')), [waiting.status, downLogs]);
  await shut(down);
  const quiet = le.createProxy({ upstream: new URL(`http://127.0.0.1:${dead}`), getState: () => ({}) });
  const quietPort = await listen(quiet);
  same('a proxy given no logger answers the same way', (await request(quietPort, '/')).status, 502);
  await shut(quiet);
  same('nothing is left open on either side of the proxy', [proxy.liveEditSockets.size, Boolean(await until(() => up.sockets.size === 0))], [0, true]);
  await shut(proxy);
  await shut(up.server);
}

// ---------------------------------------------------------------------------
// serve: the helper as it runs, with and without a dev server of its own
// ---------------------------------------------------------------------------

async function serveSuite() {
  const up = await startUpstream();
  const calFile = writeJson('cal/serve.json', cal());
  const port = await le.freePort();
  const lines = [];
  const running = await le.serve({ dir: repo, port, upstream: up.url, base: 'origin/main', calibration: calFile, variant: 'bar', headline: 'direct' }, (l) => lines.push(l));
  check('serve says where it listens and what it fronts', lines.length === 1 && lines[0] === `live-edit: http://localhost:${port} -> ${up.url}, overlay "bar", changes since origin/main`, lines);
  const page = await request(port, '/');
  same('a page through the helper carries the tag once', [page.status, count(page.body, '/__live-edit/overlay.js')], [200, 1]);
  const first = JSON.parse((await request(port, '/__live-edit/state')).body);
  const second = JSON.parse((await request(port, '/__live-edit/state')).body);
  same('the state is the working tree\'s, with the chosen headline', [first.ok, first.pill, first.eta.view.path, first.changes.noted], [true, '8 changes', 'direct', true]);
  same('two polls inside a second share one computation', second.generatedAt, first.generatedAt);
  check('the overlay script is the chosen variant', (await request(port, '/__live-edit/overlay.js')).body.includes('"variant":"bar"'));
  same('serving wrote nothing to the site', git(repo, 'status', '--porcelain'), treeBefore);
  running.close();
  running.close();
  check('close ends the listener, and a second close is harmless', Boolean(await until(() => refused(port))) && running.child === null);

  // A dev server of its own: a tiny page server that reads PORT, as the helper promises.
  const pidFile = path.join(tmp, 'child.pid');
  const childFile = path.join(tmp, 'dev server.js');
  fs.writeFileSync(childFile, [
    "const fs = require('fs');",
    "if (process.env.LIVE_EDIT_SUITE_PID) fs.writeFileSync(process.env.LIVE_EDIT_SUITE_PID, String(process.pid));",
    "require('http').createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<html><head></head><body>child</body></html>'); }).listen(Number(process.env.PORT), '127.0.0.1');",
  ].join('\n'), 'utf8');
  const ownPort = await le.freePort();
  const own = await le.serve({ dir: plain, port: ownPort, base: 'origin/main', calibration: null, variant: 'pill', headline: 'queue', command: [process.execPath, childFile] }, () => {});
  cleanup.push(own.close);
  const child = await until(async () => { const r = await request(ownPort, '/'); return r.status === 200 ? r : null; }, 20000);
  check('it starts the dev server on a free port and fronts it', Boolean(child) && child.body === `<html><head>${TAG}</head><body>child</body></html>`, child && child.body);
  same('outside a branch the helper still answers, saying so', JSON.parse((await request(ownPort, '/__live-edit/state')).body).pill, 'not a branch');
  const kid = own.child;
  const gone = new Promise((resolve) => kid.once('exit', () => resolve(true)));
  own.close();
  // Bounded, so a close that stops nothing fails this check instead of hanging the suite.
  const stopped = await Promise.race([gone, sleep(10000).then(() => false)]);
  if (!stopped) reap(kid.pid);
  check('close stops the dev server it started, and the listener', stopped && Boolean(await until(() => refused(Number(own.upstream.port)))) && await refused(ownPort), { stopped });
  same('stopping a child that already ended, or none, is a no-op', [le.stopTree(own.child), le.stopTree(null)], [undefined, undefined]);

  // A dev server that ends by itself takes the helper down with its exit code.
  const exitFile = path.join(tmp, 'exits.js');
  fs.writeFileSync(exitFile, 'process.exitCode = 3;\n', 'utf8');
  const before = process.exitCode;
  const ended = await le.serve({ dir: plain, port: await le.freePort(), base: 'origin/main', variant: 'pill', headline: 'queue', command: [process.execPath, exitFile] }, () => {});
  cleanup.push(ended.close);
  check('a dev server that ends closes the helper', Boolean(await until(() => !ended.server.listening, 20000)));
  same('and its exit code becomes the helper\'s', process.exitCode, 3);
  process.exitCode = before;

  // A port that is taken: the helper fails, and the dev server it had started does not outlive it.
  const squat = net.createServer();
  const busy = await listen(squat);
  process.env.LIVE_EDIT_SUITE_PID = pidFile;
  let why = null;
  try { await le.serve({ dir: plain, port: busy, base: 'origin/main', variant: 'pill', headline: 'queue', command: [process.execPath, childFile] }, () => {}); } catch (e) { why = e.code; }
  delete process.env.LIVE_EDIT_SUITE_PID;
  same('a taken port is an error', why, 'EADDRINUSE');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await sleep(1500);
  const orphan = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;
  check('and leaves no dev server behind', orphan === null || Boolean(await until(() => !alive(orphan))), orphan);
  if (orphan !== null && alive(orphan)) reap(orphan);
  await shut(squat);

  // The same through the command line, stopped the way a terminal stops it.
  const out = [];
  const err = [];
  const io = [(s) => out.push(s), (s) => err.push(s)];
  const cliPort = await le.freePort();
  const sigints = process.listenerCount('SIGINT');
  same('main serve stays up and returns no exit code', await le.main(['serve', '--dir', repo, '--port', String(cliPort), '--upstream', up.url, '--variant', 'dot', '--calibration', calFile], ...io), null);
  check('it serves', (await request(cliPort, '/__live-edit/overlay.js')).body.includes('"variant":"dot"') && out.join('\n').includes(`http://localhost:${cliPort} -> ${up.url}`), out);
  same('it listens for the interrupt', process.listenerCount('SIGINT'), sigints + 1);
  process.emit('SIGINT');
  check('an interrupt closes it', Boolean(await until(() => refused(cliPort))));
  const squat2 = net.createServer();
  const busy2 = await listen(squat2);
  same('main serve on a taken port exits 1 and says why', [await le.main(['serve', '--dir', repo, '--port', String(busy2), '--upstream', up.url], ...io), err.some((l) => l === `live-edit: cannot serve on port ${busy2}: EADDRINUSE`)], [1, true]);
  await shut(squat2);
  same('main serve needs a numeric port', [await le.main(['serve', '--dir', repo], ...io), await le.main(['serve', '--dir', repo, '--port', 'http'], ...io)], [1, 1]);
  await shut(up.server);
}

// ---------------------------------------------------------------------------
// Calibration: samples from records, and the error against past merges
// ---------------------------------------------------------------------------

async function calibrationSuite() {
  const locks = path.join(tmp, 'locks');
  fs.mkdirSync(locks);
  const hhmm = (ms) => { const d = new Date(ms); return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0'); };
  const t0 = Math.floor(Date.now() / MIN) * MIN - 6 * 60 * MIN;
  // One record as the queue writes it: pid, what, class, then `meta {json}`.
  const record = (suffix, { admitted, holdMin, origin }) => {
    const meta = { schema: 1, runId: 'r' + suffix, cls: 'product', admittedUtc: admitted ? iso(admitted) : undefined, repo: origin ? { origin } : null };
    fs.writeFileSync(path.join(locks, `full-gate.lock.released-${hhmm((admitted || t0) + m(holdMin))}${suffix}`), ['4242', 'npm run gate, branch claude/x, head abc1234, worktree x', 'class product', 'meta ' + JSON.stringify(meta)].join('\n') + '\n', 'utf8');
  };
  record('-a', { admitted: t0, holdMin: 4, origin: 'github.com/example-org/site' });
  record('-b', { admitted: t0 + m(60), holdMin: 5, origin: 'github.com/example-org/site' });
  record('-c', { admitted: t0 + m(120), holdMin: 2, origin: 'github.com/example-org/site' });
  record('-d', { admitted: t0 + m(180), holdMin: 30, origin: 'github.com/example-org/other' });
  record('-e', { holdMin: 9, origin: 'github.com/example-org/site' });
  fs.writeFileSync(path.join(locks, 'full-gate.lock'), '1\nlive holder\n', 'utf8');
  fs.writeFileSync(path.join(locks, 'notes.txt'), 'not a record\n', 'utf8');
  const gates = le.gateSamples(locks, 'example-org/site', 3);
  same('gate samples: this repository\'s holds, short hand-offs counted apart, no start left out', [gates.samples.map((s) => s.ms), gates.short, gates.why], [[m(4), m(5)], 1, null]);
  check('a locks folder that cannot be read says so', /cannot read/.test(le.gateSamples(path.join(tmp, 'no-locks'), 'x', 3).why));

  const twelve = Array.from({ length: 12 }, (_, i) => ({ at: 1000 + i, ms: 100 + i }));
  same('the newest ten samples, oldest first, without the unusable ones', le.newest([...twelve, { at: NaN, ms: 5 }, { at: 9999, ms: 0 }, { at: 9999, ms: NaN }]).map((s) => s.ms), twelve.slice(2).map((s) => s.ms));

  const FAST = require(path.join(SCRIPTS, 'fast-lane.js')).KIND;
  const fastDir = path.join(tmp, 'fast');
  writeJson('fast/green.json', { kind: FAST, exit: 0, finishedAt: iso(t0), steps: [{ name: 'lint', ms: 1000 }, { name: 'test', ms: 2000 }] });
  writeJson('fast/red.json', { kind: FAST, exit: 1, finishedAt: iso(t0), steps: [{ ms: 9000 }] });
  writeJson('fast/other.json', { kind: 'another-receipt', exit: 0, finishedAt: iso(t0), steps: [{ ms: 9000 }] });
  fs.writeFileSync(path.join(fastDir, 'torn.json'), '{', 'utf8');
  fs.writeFileSync(path.join(fastDir, 'readme.txt'), 'not json', 'utf8');
  same('fast lane samples: green receipts only, the sum of their steps', le.fastSamples([fastDir]).map((s) => s.ms), [3000]);

  const reviewDir = path.join(tmp, 'review');
  writeJson('review/r1.json', { repo: 'example-org/site', diff_lines: 40, ms: 30000, verdict: 'ship', started_at: iso(t0) });
  writeJson('review/r2.json', { repo: 'example-org/site', diff_lines: 1777, ms: 6700, verdict: 'escalate', started_at: iso(t0 + 1) });
  writeJson('review/r3.json', { repo: 'example-org/other', diff_lines: 12, ms: 60000, verdict: 'ship', started_at: iso(t0 + 2) });
  writeJson('review/r4.json', { repo: 'example-org/site', diff_lines: 12, ms: 0, verdict: 'ship', started_at: iso(t0 + 3) });
  writeJson('review/r5.json', { repo: 'example-org/site', ms: 5000, verdict: 'ship', started_at: iso(t0 + 4) });
  const extra = writeJson('extra/r6.json', { repo: 'example-org/site', diff_lines: 5, ms: 45000, verdict: 'fix', started_at: iso(t0 + 5) });
  same('files come from folders and from names, and a missing path is skipped', le.jsonFiles([fastDir, extra, path.join(tmp, 'missing')]).map((f) => path.basename(f)).sort(), ['green.json', 'other.json', 'r6.json', 'red.json', 'torn.json']);
  same('review samples: this repository, and an escalation is a hand-off, not a review', le.reviewSamples([reviewDir, extra], 'example-org/site', false).map((s) => s.ms), [30000, 45000]);
  same('review samples across repositories when asked', le.reviewSamples([reviewDir], 'example-org/site', true).map((s) => s.ms), [30000, 60000]);

  const deployments = [
    { createdAt: 1000, ready: 31000, readyState: 'READY', target: 'production' },
    { created: 5000, ready: 50000, state: 'READY' },
    { createdAt: 2000, ready: 9000, readyState: 'ERROR', target: 'production' },
    { createdAt: 3000, ready: 9000, readyState: 'READY', target: 'preview' },
  ];
  same('build samples: production deployments that went ready', [le.buildSamples(deployments).map((s) => s.ms), le.buildSamples({ deployments }).map((s) => s.ms), le.buildSamples(null)], [[30000, 45000], [30000, 45000], []]);

  const merges = [
    // Pushed before the 15:37 slot and merged 8 minutes after it: the queue landed it.
    { number: 1, mergedAt: iso(at(15, 45)), commits: [{ committedDate: iso(at(15, 0)) }, { committedDate: iso(at(15, 20)) }] },
    // Pushed after the slot it merged behind: nobody waited for a slot, so it was direct.
    { number: 2, mergedAt: iso(at(16, 45)), pushedAt: iso(at(16, 40)) },
    // Neither: over an hour from push to merge, far from a slot.
    { number: 3, mergedAt: iso(at(18, 10)), pushedAt: iso(at(15, 0)) },
    { number: 4, mergedAt: iso(at(9, 0) - 30 * 24 * 60 * MIN), pushedAt: iso(at(8, 55) - 30 * 24 * 60 * MIN) },
    { number: 5 },
    { number: 6, mergedAt: iso(at(19, 45)) },
  ];
  const split = le.mergeSamples(merges, [37], at(0, 0));
  same('merges split by how they landed: slot to merge, or push to merge', [split.land.map((s) => s.ms), split.direct.map((s) => s.ms), split.skipped], [[m(8)], [m(5)], 2]);
  const noQueue = le.mergeSamples(merges, null, at(0, 0));
  same('with no landing slots every merge is direct', [noQueue.land, noQueue.direct.map((s) => s.ms), noQueue.skipped], [[], [m(25), m(5)], 2]);
  same('a list that is not a list holds no merges', le.mergeSamples(null, [37], 0), { land: [], direct: [], skipped: 0 });

  const depFile = writeJson('in/deployments.json', deployments);
  const mergesFile = writeJson('in/merges.json', merges);
  const built = le.calibrate({ repo: 'example-org/site', locksDir: locks, minHold: 3, fastReceipts: [fastDir], reviewReceipts: [reviewDir], reviewAnyRepo: false, deployments: depFile, merges: mergesFile, landMinutes: '37', since: iso(at(0, 0)) }, NOW);
  same('calibrate gathers every part', [built.kind, built.repo, built.measuredAt, built.landMinutes, built.parts.gateFull.ms, built.parts.gateFast.ms, built.parts.review.ms, built.parts.land.ms, built.parts.build.ms, built.parts.direct.ms],
    [le.KIND, 'example-org/site', iso(NOW), [37], [m(4), m(5)], [3000], [30000], [m(8)], [30000, 45000], [m(5)]]);
  check('each part names its source and what it left out', /holds of 3\+ min \(1 shorter left out\)/.test(built.parts.gateFull.source) && /this repository/.test(built.parts.review.source) && /\(2 over an hour left out\)/.test(built.parts.direct.source), built.parts);
  const bare = le.calibrate({ repo: 'example-org/site', minHold: 3, reviewAnyRepo: true, landMinutes: undefined });
  same('with no inputs every part is empty, never filled in', [Object.values(bare.parts).map((p) => p.ms.length), bare.landMinutes, bare.parts.gateFull.source, bare.parts.review.source], [[0, 0, 0, 0, 0, 0], null, 'no --locks-dir', 'review receipts, every repository']);
  check('a bad landing minute stops the calibration', /minutes past the hour/.test(throws(() => le.calibrate({ repo: 'r', minHold: 3, landMinutes: '99' })) || ''));

  const text = le.describe(built);
  check('the inputs print one row per part with its sample count', text.split('\n').length === 7 && /^live-edit: example-org\/site, measured .*, landing slots :37$/m.test(text) && /gateFull {2}n=2 {3}median 5 min, 4 min to 5 min/.test(text) && /build {5}n=2 {3}median 38 s, 30 s to 45 s/.test(text), text);
  const empty = le.describe({ repo: 'r', measuredAt: 't', landMinutes: null, parts: {} });
  check('an empty part prints as not measured', count(empty, 'not measured') === 6 && /landing slots none/.test(empty), empty);

  // Two past merges with known answers against the fixture: one live 10 minutes after its push, one 48.
  const cases = [
    { pr: 1, pushedAt: iso(at(15, 0)), liveAt: iso(at(15, 10)), lane: 'full' },
    { pr: 2, pushedAt: iso(at(15, 0)), liveAt: iso(at(15, 48)), lane: 'fast' },
  ];
  const bt = le.backtest(cal(), cases);
  same('the backtest reports each path against what happened', bt.rows, [
    { pr: 1, actualMin: 10, queueMin: 48, queueErrMin: 38, directMin: 7, directErrMin: -3, inRange: false },
    { pr: 2, actualMin: 48, queueMin: 48, queueErrMin: 0, directMin: 7, directErrMin: -41, inRange: true }]);
  same('and the median absolute error of each path', [bt.queueMedianAbsErrMin, bt.directMedianAbsErrMin], [19, 22]);
  const btNoDirect = le.backtest(cal({ direct: { ms: [] } }), cases);
  same('with no direct samples the direct error is not a number', [btNoDirect.rows[0].directMin, btNoDirect.rows[0].directErrMin, btNoDirect.directMedianAbsErrMin], [null, null, null]);

  // The command line over the same inputs.
  const out = [];
  const err = [];
  const io = [(s) => out.push(s), (s) => err.push(s)];
  const outFile = path.join(tmp, 'made', 'calibration.json');
  same('main calibrate writes the file and prints the inputs', await le.main(['calibrate', '--repo', 'example-org/site', '--out', outFile, '--locks-dir', locks, '--min-hold', '3', '--fast-receipts', fastDir, '--review-receipts', `${reviewDir},${extra}`, '--review-any-repo', '--deployments', depFile, '--merges', mergesFile, '--land-minutes', '37', '--since', iso(at(0, 0))], ...io), 0);
  const made = le.readCalibration(outFile);
  check('the written file reads back as a calibration', made.ok && JSON.stringify(made.calibration.parts.review.ms) === JSON.stringify([30000, 60000, 45000]) && out.join('\n').includes('gateFull  n=2') && !fs.existsSync(outFile + '.tmp'), [made, out]);
  const saved = process.env.AUTODEV_GATE_LOCK_PATH;
  process.env.AUTODEV_GATE_LOCK_PATH = path.join(locks, 'full-gate.lock');
  same('with no --locks-dir it reads beside the gate lock', [await le.main(['calibrate', '--repo', 'example-org/site', '--out', outFile], ...io), le.readCalibration(outFile).calibration.parts.gateFull.ms], [0, [m(4), m(5)]]);
  if (saved === undefined) delete process.env.AUTODEV_GATE_LOCK_PATH; else process.env.AUTODEV_GATE_LOCK_PATH = saved;
  same('main calibrate refuses a missing name and a bad landing minute', [await le.main(['calibrate', '--repo', 'example-org/site'], ...io), await le.main(['calibrate', '--repo', 'r', '--out', outFile, '--land-minutes', '99', '--locks-dir', locks], ...io)], [1, 1]);

  const calFile = writeJson('cal/backtest.json', cal());
  const casesFile = writeJson('in/cases.json', cases);
  out.length = 0;
  same('main backtest prints each case and the error', await le.main(['backtest', '--calibration', calFile, '--cases', casesFile], ...io), 0);
  check('in words a person can check', out.includes('  #1: actual 10 min, queue path 48 min (error 38), direct path 7 min (error -3), inside range: no') && out.includes('  median absolute error over 2 case(s): queue path 19 min, direct path 22 min'), out);
  out.length = 0;
  same('main backtest --json prints the same as data', [await le.main(['backtest', '--calibration', calFile, '--cases', casesFile, '--json'], ...io), JSON.parse(out.join('\n')).queueMedianAbsErrMin], [0, 19]);
  out.length = 0;
  await le.main(['backtest', '--calibration', writeJson('cal/bt-no-direct.json', cal({ direct: { ms: [] } })), '--cases', casesFile], ...io);
  check('a path with no samples prints as not measured', out.some((l) => l.includes('direct path not measured, inside range')) && out.some((l) => l.endsWith('direct path not measured')), out);
  same('main backtest refuses a missing calibration, missing cases and empty cases', [await le.main(['backtest', '--cases', casesFile], ...io), await le.main(['backtest', '--calibration', calFile], ...io), await le.main(['backtest', '--calibration', calFile, '--cases', writeJson('in/none.json', [])], ...io)], [1, 1, 1]);
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

async function cliSuite() {
  same('arguments parse: positionals, flags, and a command after --', le.parseArgs(['serve', '--dir', 'x', '--json', '-h', '--', 'node', 'a b.js', '--port']).o, { _: ['serve'], command: ['node', 'a b.js', '--port'], dir: 'x', json: true, help: true });
  same('an unknown flag and a flag with no value are errors', [le.parseArgs(['--nope']).error, le.parseArgs(['--dir']).error], ['unknown argument --nope', '--dir needs a value']);
  check('help names every command', ['serve', 'state', 'note', 'calibrate', 'backtest'].every((c) => le.help().includes(`  ${c} `)));

  const out = [];
  const err = [];
  const io = [(s) => out.push(s), (s) => err.push(s)];
  same('--help exits 0, and no command exits 1, both with the usage', [await le.main(['--help'], ...io), await le.main([], ...io), out.length, out[0] === le.help()], [0, 1, 2, true]);
  same('bad arguments exit 1', [
    await le.main(['--nope'], ...io), await le.main(['state', '--dir'], ...io), await le.main(['state', '--dir', repo, '--variant', 'huge'], ...io),
    await le.main(['state', '--dir', repo, '--headline', 'soon'], ...io), await le.main(['state'], ...io), await le.main(['note'], ...io), await le.main(['launch', '--dir', repo], ...io),
  ], [1, 1, 1, 1, 1, 1, 1]);
  check('each with its reason, then the usage', ['live-edit: unknown argument --nope', 'live-edit: --dir needs a value', 'live-edit: --variant is one of pill, bar, dot', 'live-edit: --headline is queue or direct', 'live-edit: state needs --dir SITE', 'live-edit: note needs --dir SITE', 'live-edit: unknown command launch'].every((l) => err.includes(l)) && err.includes(le.help()), err);

  out.length = 0;
  same('main state prints the state as JSON', [await le.main(['state', '--dir', repo, '--headline', 'direct'], ...io), JSON.parse(out.join('\n')).eta.view.path], [0, 'direct']);
  out.length = 0;
  same('main note records one line', [await le.main(['note', '--dir', repo, '--text', 'Footer year is 2027'], ...io), out[0], le.readNotes(repo, git(repo, 'rev-parse', 'origin/main').trim()).pop().text], [0, 'live-edit: noted "Footer year is 2027"', 'Footer year is 2027']);
  same('main note with no text, or outside a branch, exits 1', [await le.main(['note', '--dir', repo], ...io), await le.main(['note', '--dir', plain, '--text', 'x'], ...io)], [1, 1]);

  // As a process: the exit code and the streams a caller sees.
  const run = (args) => spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', windowsHide: true });
  const helped = run(['--help']);
  same('as a process, --help exits 0 on stdout alone', [helped.status, helped.stdout.startsWith('usage: node live-edit.js'), helped.stderr], [0, true, '']);
  const none = run([]);
  same('no command exits 1', none.status, 1);
  const bad = run(['state', '--dir', repo, '--nope']);
  check('a bad argument exits 1 on stderr alone', bad.status === 1 && bad.stdout === '' && bad.stderr.startsWith('live-edit: unknown argument --nope'), bad);
  const stated = run(['state', '--dir', plain]);
  same('state outside a branch exits 0 and says so', [stated.status, JSON.parse(stated.stdout).pill], [0, 'not a branch']);
}

// ---------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  fail++;
  console.log('  FAIL the suite did not finish in 120 s');
  for (const stop of cleanup) { try { stop(); } catch { /* already closed */ } }
}, 120e3);

(async () => {
  await overlaySuite();
  console.log('the proxy');
  await proxySuite();
  console.log('serve');
  await serveSuite();
  console.log('calibration');
  await calibrationSuite();
  console.log('the command line');
  await cliSuite();
})().catch((e) => {
  fail++;
  console.log('  FAIL the suite threw : ' + (e && e.stack ? e.stack : e));
}).then(() => {
  clearTimeout(watchdog);
  for (const stop of cleanup) { try { stop(); } catch { /* already closed */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a temp folder the OS still holds is not a result */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
});
