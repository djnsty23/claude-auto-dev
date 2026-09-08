#!/usr/bin/env node
// Tests for the per-session title dedupe in memory-db.js saveObservation.
//
// The 30-second content-hash rule only catches an identical (type, title,
// concept) triple. An Edit repeated on the same file yields the same title with
// a different concept every time, and 1,785 of 6,072 rows were such repeats on
// 2026-09-08 (docs/evidence-memory-recall-2026-09-08.md). The second rule keeps
// one row per (session, title). Every concept below is distinct so the hash
// rule cannot be what fires; the controls establish that the first save of a
// title, a different session's save of the same title, and a different title in
// the same session are all recorded.
//
// HOME is pointed at a temp dir BEFORE memory-db.js is required, because it
// binds the database path at load time.
// Run: node tooling/test-observation-dedupe.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-dedupe-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const memDB = require('../plugins/autodev-memory/scripts/memory-db');

const cases = [];
const check = (label, ok) => cases.push([label, !!ok]);

if (!memDB.isAvailable()) {
  console.log('SKIP  node:sqlite unavailable');
  process.exit(0);
}

const PROJ = path.join(HOME, 'proj');
fs.mkdirSync(PROJ, { recursive: true });
const sesA = memDB.startSession(PROJ);
const sesB = memDB.startSession(PROJ);
check('control: two sessions opened', sesA && sesB && sesA !== sesB);

let n = 0;
const save = (sessionId, title) => memDB.saveObservation({
  sessionId, projectPath: PROJ, type: 'change', title,
  concept: `edit number ${++n}`, sourceFiles: [path.join(PROJ, 'x.js')],
});
const count = () => memDB.getRecent(PROJ, 100).length;

const first = save(sesA, 'Modified x.js');
check('control: the first save of a title returns an id', typeof first === 'string' && first.startsWith('obs_'));
check('control: and the store holds one row', count() === 1);

const repeat = save(sesA, 'Modified x.js');
check('a repeat of the title in the same session returns null', repeat === null);
check('  and adds no row', count() === 1);

const third = save(sesA, 'Modified x.js');
check('a third repeat is still null', third === null);
check('  and the count is still one', count() === 1);

const other = save(sesA, 'Created y.js');
check('control: a different title in the same session is recorded', typeof other === 'string');
check('  and the count is two', count() === 2);

const otherSession = save(sesB, 'Modified x.js');
check('control: the same title in another session is recorded', typeof otherSession === 'string');
check('  and the count is three', count() === 3);

// Type is part of the key. The same title stored deliberately under two
// types is two facts (test-knowledge.js relies on this for its groups), so
// the rule must not collapse them.
const otherType = memDB.saveObservation({
  sessionId: sesA, projectPath: PROJ, type: 'decision', title: 'Modified x.js',
  concept: `edit number ${++n}`, sourceFiles: [],
});
check('control: the same title under a different type in the same session is recorded', typeof otherType === 'string');
check('  and the count is four', count() === 4);

// A null session id is guarded out of the title rule, but it never reaches
// the INSERT either: node:sqlite enforces FOREIGN KEY constraints by default
// and `sessions` has no row called "unknown". Asserted here so nobody reads
// the guard as "a session-less save is recorded" — it is refused one step
// later, by the database, and the circuit breaker turns that into null.
{
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  const noSession = memDB.saveObservation({
    sessionId: null, projectPath: PROJ, type: 'change', title: 'Modified x.js',
    concept: `edit number ${++n}`, sourceFiles: [],
  });
  process.stderr.write = origWrite;
  check('no session id: not stored', noSession === null);
  check('  and the reason is the FOREIGN KEY, not the title rule', /FOREIGN KEY/.test(captured));
  check('  and the count is unchanged', count() === 4);
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  ok ? pass++ : fail++;
}
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
