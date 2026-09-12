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

// ---- the pipe delivers every byte ------------------------------------------
//
// node's process.stdout is ASYNCHRONOUS when it is a pipe on darwin and
// synchronous when it is a pipe on linux/win32, and process.exit() does not
// drain a pending async write. A run that prints past the 64KiB OS pipe buffer
// and then exits hands its caller exactly 65536 bytes under a status that says
// nothing failed — the shape rendered-layout-gate.js shipped with until
// 2026-09-07. --json here carries one entry per scheduled job, so it grows with
// the repo's cron surface.
//
// TWO ASSERTIONS, and the first is what stops the second passing by
// construction: the output must EXCEED one pipe buffer, and the piped byte count
// must equal the same run redirected to a FILE, where the write is synchronous
// on every platform.
{
    const PIPE_BUF = 64 * 1024;
    const bigRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-pipe-'));
    const crons = [];
    for (let i = 0; i < 200; i++) {
        crons.push({
            path: '/api/cron/a-realistically-long-scheduled-job-name-' + String(i).padStart(4, '0'),
            schedule: '0 3 * * *',
        });
    }
    // vercel.json alone: no handler file exists, so every job resolves to
    // UNRESOLVED without reading anything else. The fixture is one file write,
    // which is what makes 200 jobs affordable inside npm test.
    fs.writeFileSync(path.join(bigRepo, 'vercel.json'), JSON.stringify({ crons }));

    const viaFileBytes = (args) => {
        const out = path.join(bigRepo, 'via-file.out');
        const fd = fs.openSync(out, 'w');
        spawnSync(process.execPath, [SCRIPT].concat(args), { stdio: ['ignore', fd, 'ignore'] });
        fs.closeSync(fd);
        return fs.statSync(out).size;
    };
    const piped = spawnSync(process.execPath, [SCRIPT, bigRepo, '--json'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const pipeBytes = Buffer.byteLength(piped.stdout || '', 'utf8');
    const fileBytes = viaFileBytes([bigRepo, '--json']);

    check('--json over many scheduled jobs exceeds one pipe buffer, so the next check is not vacuous',
        fileBytes > PIPE_BUF, JSON.stringify({ bytes: fileBytes, buffer: PIPE_BUF }));
    check('--json through a PIPE delivers every byte it writes to a FILE',
        pipeBytes === fileBytes, JSON.stringify({ pipe: pipeBytes, file: fileBytes }));
    check('the piped JSON still parses at that size',
        (() => { try { return JSON.parse(piped.stdout).jobs.length === 200; } catch { return false; } })(),
        'tail ' + JSON.stringify((piped.stdout || '').slice(-40)));

    // The human report shares the exit path, so it shares the defect. BE CLEAR
    // WHAT THIS LINE CATCHES: it is a stream of small console.log calls, which
    // drain opportunistically while the parent reads, so it strands far less at
    // the exit than the single JSON write — measurably so on the sibling suites,
    // where the equivalent line stays green under the mutation even above the
    // buffer. It states the equality; it is not cover for this defect.
    const reportPipe = spawnSync(process.execPath, [SCRIPT, bigRepo],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    check('the human report through a PIPE also delivers every byte',
        Buffer.byteLength(reportPipe.stdout || '', 'utf8') === viaFileBytes([bigRepo]),
        Buffer.byteLength(reportPipe.stdout || '', 'utf8'));

    try { fs.rmSync(bigRepo, { recursive: true, force: true }); } catch { /* tmp */ }
}

try { fs.rmSync(empty, { recursive: true, force: true }); } catch { /* tmp */ }

console.log(failures ? '\nFAILED: ' + failures : '\nall passed');
process.exit(failures ? 1 : 0);
