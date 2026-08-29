#!/usr/bin/env node
/**
 * test-archive-prd — the archive procedure's only regression protection.
 *
 * The skill's bucketing lives in PROSE an agent follows, so no executable gate
 * can watch the skill itself (test-skill-prd-commands reports its inline
 * command NOT RUNNABLE). What CAN be tested: (1) the helper the prose routes
 * through, isArchivable(), against every state including the three the old
 * two-bucket split deleted; (2) a reference implementation of the documented
 * procedure, proving the split invariant holds and that the prose's steps are
 * implementable as written; (3) that the SKILL.md text still routes through the
 * helper and still orders the proof before the write — the two load-bearing
 * sentences, pinned so a doc edit that reverts them fails here.
 *
 * Fixtures are SYNTHETIC on purpose. The one real project audited for this fix
 * had zero deferred and zero keyless stories on the day of the audit, so
 * building fixtures from a real file would pass while covering neither — the
 * vacuous-pass shape.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { isArchivable, isDone } = require(
  path.join(ROOT, 'plugins/autodev-core/scripts/prd-states.js'));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// Every state, incl. the three the old two-bucket split deleted. Keys are ids:
// real projects store stories as an id-keyed OBJECT, not an array.
const STORIES = {
  'S-done':     { title: 'done',         passes: true },
  'S-pending':  { title: 'pending',      passes: null },
  'S-failed':   { title: 'failed',       passes: false },
  'S-deferred': { title: 'deferred',     passes: 'deferred' },
  'S-setup':    { title: 'needs-setup',  passes: 'needs-setup' },
  'S-keyless':  { title: 'no passes key' },
  'S-alien':    { title: 'unrecognised', passes: 'sideways' },
  'S-qa-done':  { title: 'passed QA',    passes: true, type: 'qa' },
};

/**
 * Reference implementation of the documented procedure — the split and its
 * invariant exactly as the SKILL.md orders them (prove BEFORE write). QA
 * stories stay regardless of passes, per the skill.
 */
function splitForArchive(stories) {
  const archive = {}, keep = {};
  for (const [id, s] of Object.entries(stories)) {
    if (s.type === 'qa') keep[id] = s;
    else if (isArchivable(s)) archive[id] = s;
    else keep[id] = s;
  }
  const before = Object.keys(stories).length;
  const a = Object.keys(archive), k = Object.keys(keep);
  if (a.length + k.length !== before)
    throw new Error(`invariant: ${a.length}+${k.length} !== ${before}`);
  const both = a.filter(id => keep[id]);
  if (both.length) throw new Error(`ids in both sets: ${both}`);
  const neither = Object.keys(stories).filter(id => !archive[id] && !keep[id]);
  if (neither.length) throw new Error(`ids in NEITHER set (the data-loss class): ${neither}`);
  return { archive, keep };
}

check('isArchivable: exactly passes===true, nothing else', () => {
  assert.strictEqual(isArchivable(STORIES['S-done']), true);
  for (const id of ['S-pending', 'S-failed', 'S-deferred', 'S-setup', 'S-keyless', 'S-alien'])
    assert.strictEqual(isArchivable(STORIES[id]), false, `${id} must NOT be archivable`);
});

check('every story lands in exactly one bucket — none deleted', () => {
  const { archive, keep } = splitForArchive(STORIES);
  assert.deepStrictEqual(Object.keys(archive).sort(), ['S-done']);
  assert.deepStrictEqual(Object.keys(keep).sort(),
    ['S-alien', 'S-deferred', 'S-failed', 'S-keyless', 'S-pending', 'S-qa-done', 'S-setup']);
});

check('the three states the old split deleted are all KEPT', () => {
  const { keep } = splitForArchive(STORIES);
  for (const id of ['S-deferred', 'S-setup', 'S-keyless'])
    assert.ok(keep[id], `${id} fell through both buckets — the data-loss regression`);
});

check('mutation: the OLD two-bucket split fails this suite\'s invariant', () => {
  // Reconstruct the destructive version verbatim; the invariant must catch it.
  const oldSplit = (stories) => {
    const active = {}, completed = {};
    for (const [id, s] of Object.entries(stories)) {
      if (s.passes === false || s.passes === null || s.type === 'qa') active[id] = s;
      else if (s.passes === true && s.type !== 'qa') completed[id] = s;
      // deferred / needs-setup / keyless / alien: NEITHER — the bug.
    }
    return { active, completed };
  };
  const { active, completed } = oldSplit(STORIES);
  const lost = Object.keys(STORIES).filter(id => !active[id] && !completed[id]);
  assert.deepStrictEqual(lost.sort(), ['S-alien', 'S-deferred', 'S-keyless', 'S-setup'],
    'the old split should lose exactly these — if it loses none, this canary is dead');
});

check('re-archive: totalCompleted accumulates, never overwrites', () => {
  // The documented step: "ADD to totalCompleted — never overwrite it."
  const prd = { stories: STORIES, archived: { totalCompleted: 159, files: ['prd-archive-2026-08.json'] } };
  const { archive } = splitForArchive(prd.stories);
  const updated = {
    totalCompleted: prd.archived.totalCompleted + Object.keys(archive).length,
    files: prd.archived.files.concat('prd-archive-2026-09.json'),
  };
  assert.strictEqual(updated.totalCompleted, 160);
  assert.strictEqual(updated.files.length, 2);
});

check('SKILL.md still routes through the helper, proof still precedes the write', () => {
  const md = fs.readFileSync(
    path.join(ROOT, 'plugins/autodev-core/skills/archive-prd/SKILL.md'), 'utf8');
  assert.ok(md.includes('isArchivable()'), 'skill no longer names isArchivable()');
  assert.ok(!/ACTIVE: passes=false OR passes=null/.test(md),
    'the destructive two-bucket prose is back');
  const prove = md.indexOf('PROVE THE SPLIT');
  const write = md.indexOf('CREATE ARCHIVE');
  assert.ok(prove > -1 && write > -1 && prove < write,
    'the proof step no longer precedes the archive write in the procedure');
});

check('isDone and isArchivable agree (archive-blindness is structurally impossible)', () => {
  for (const s of Object.values(STORIES))
    assert.strictEqual(isArchivable(s), isDone(s));
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall archive-prd checks passed');
