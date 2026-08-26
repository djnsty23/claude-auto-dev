#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/check-scheduled-verdicts.js
// Run: node tooling/test-scheduled-verdicts.js
// Exits 1 on any failure; 0 if all pass.
//
// The script ships a --selftest covering discovery and classification against
// temp fixtures, and this suite drives it as a subprocess rather than repeating
// those cases. What is added here is what a selftest structurally cannot check:
// that the REPORT wording does not convert an unexamined case into a reassuring
// one, and that the exit code reflects the findings rather than merely printing
// them.
//
// The wording assertions look pedantic and are not. The first version of a
// sibling check in this repo printed "references no plugin source - nothing to
// stub" for suites it had never examined, and a second reader repeated that as
// "expected, not a finding" without opening the file. A skip worded as a
// category closes the question; a skip worded as a deficiency opens it.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-scheduled-verdicts.js',
);
const { inspectHandler, classify } = require(SCRIPT);

let failures = 0;
function check(name, cond) {
    if (cond) { console.log('  ok   ' + name); return; }
    console.log('  FAIL ' + name);
    failures += 1;
}

console.log('check-scheduled-verdicts');

// --- the script's own selftest must pass as a subprocess ---
const st = spawnSync('node', [SCRIPT, '--selftest'], { encoding: 'utf8' });
check('--selftest exits 0', st.status === 0);
check('--selftest reports a mutation case', /mutation/i.test(st.stdout || ''));
check('--selftest reports a regression case', /regression/i.test(st.stdout || ''));

// --- a repo with no scheduled jobs at all must exit 0 and say so ---
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-empty-'));
const emptyRun = spawnSync('node', [SCRIPT, empty], { encoding: 'utf8' });
check('a repo with no scheduled jobs exits 0', emptyRun.status === 0);
check('an empty scan still prints its population',
    /population: 0 scheduled job/.test(emptyRun.stdout || ''));

// --- the report must not let an unexamined case read as a pass ---
const out = emptyRun.stdout || '';
check('report names UNVERIFIED as not passing', /UNVERIFIED is counted as NOT passing/.test(out));
check('report explains why a reassuring skip is refused',
    /converts absent coverage into reported coverage/.test(out));
check('report separates UNRESOLVED from a real zero',
    /nothing about it was checked/.test(out));

// --- the payload-in-a-named-const shape, which the first version missed ---
const indirect = inspectHandler([
    'export default async function handler() {',
    '  const newValue = {',
    '    enabled: nextEnabled,',
    '    version: tag,',
    '    severity: nextSeverity,',
    '  };',
    '  const unrelated = 1;',
    '  const alsoUnrelated = 2;',
    '  await db.from("app_settings").upsert({ key: K, value: newValue });',
    '}',
].join('\n'));
check('a payload built into a named const is seen', indirect.writes.length === 1);
check('the gating field is named, not just counted',
    indirect.writes[0] && /enabled|severity/.test(indirect.writes[0].field));

// --- a payload assembled ABOVE the write, inline ---
const above = inspectHandler([
    'const row = { severity: "outage" };',
    'await db.from("t").upsert(row);',
].join('\n'));
check('a write reached by looking backward is seen', above.writes.length === 1);

// --- FALSE POSITIVE GUARDS. These matter more than the finders: a check at 33%',
//     precision gets muted, and then it misses the real one.
const commentOnly = inspectHandler([
    '// when severity is outage we set enabled: false',
    'await db.from("metrics").insert({ count: 1 });',
].join('\n'));
check('a comment naming gating fields is not a write', commentOnly.writes.length === 0);

const noGate = inspectHandler([
    'await db.from("metrics").insert({ count: 1, recorded_at: now });',
].join('\n'));
check('a write with no gating field is not a finding', noGate.writes.length === 0);

const timestampOnly = inspectHandler([
    'await db.from("t").upsert({ enabled: true, created_at: now });',
].join('\n'));
check('a bare timestamp is not counted as an age bound', timestampOnly.bounds.length === 0);

// --- classification boundaries ---
check('a write with no bound classifies UNBOUNDED',
    classify({ handler: 'x', handlerHint: 'x', writes: [{ field: 'enabled' }], bounds: [] }) === 'UNBOUNDED');
check('a write with a bound classifies UNVERIFIED, never PASS',
    classify({ handler: 'x', handlerHint: 'x', writes: [{ field: 'enabled' }], bounds: [{ kind: 'age constant' }] }) === 'UNVERIFIED');
check('no gating write classifies NO-VERDICT',
    classify({ handler: 'x', handlerHint: 'x', writes: [], bounds: [] }) === 'NO-VERDICT');
check('an unresolvable handler classifies UNRESOLVED, not skipped',
    classify({ handler: null, handlerHint: 'api/cron/gone', writes: [], bounds: [] }) === 'UNRESOLVED');

try { fs.rmSync(empty, { recursive: true, force: true }); } catch { /* tmp */ }

console.log(failures ? '\nFAILED: ' + failures : '\nall passed');
process.exit(failures ? 1 : 0);
