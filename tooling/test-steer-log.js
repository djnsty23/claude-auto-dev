#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/steer-log.js - the retrospective that
// measures whether cross-session steers arrive before the work they redirect.
// Run: node tooling/test-steer-log.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS ONE, GIVEN IT ALREADY SHIPS A --selftest.
//
// The shipped selftest is a good UNIT suite and it is not this. Every one of its
// assertions calls a detector directly with a hand-written record: detect this
// shape, do not detect that lookalike, classify this tool name. Not one of them
// runs the program. So the arithmetic a reader actually sees - the queue delay,
// the LATE/IN-TIME split, the per-day counts, the population line - is produced
// by report(), and report() is exercised by nothing.
//
// That gap is the exact shape that cost a day on fleet-status.js: 121 green
// assertions against a classifier while the CLI could not report one of its
// states at all, because everything asserted called the pure function and
// nothing exercised the wiring feeding it. So every assertion below drives the
// shipped CLI as a subprocess over a fixture corpus and reads its stdout.
//
// The numbers matter more than usual here. They are cited in a standing argument
// about whether cross-session steering pays for itself, and a report that
// silently drifts - counting an enqueue twin twice, calling an unjoined steer
// on-time, rendering a 60-second delay as "0m" - argues the case with numbers
// nobody can re-derive.
//
// THE SEAM.
//
// steer-log.js already takes `--root`, so the corpus is an argument and no env
// var or copied subject is needed. USERPROFILE/HOME/APPDATA are still redirected
// at a fixture, because the desktop session index it borrows from fleet-status.js
// is read off APPDATA and would otherwise pull this machine's real session
// titles into the output. Nothing below reads a live transcript, so this suite
// cannot pass on a quiet day for the wrong reason.
//
// THE EMPTY CASE IS AN ASSERTION, NOT AN OMISSION.
//
// A corpus-wide zero from a marker-based detector is far more likely to be a
// marker that changed than a world with no steers in it, and the subject is
// written to say so and exit 1. Three fixtures below cover it: a root that does
// not exist, an empty one, and - the one that matters - a root holding real
// transcripts that simply contain no steers. All three must refuse to render as
// a confident zero.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'steer-log.js');

let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  (' + detail + ')'}`);
}

function eq(label, actual, expected) {
    check(label, actual === expected,
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// Fixture corpus
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-log-'));
const ROOT = path.join(fixture, 'projects');
const HOME = path.join(fixture, 'home');
const APPDATA = path.join(fixture, 'appdata');
const EMPTY = path.join(fixture, 'empty-root');
const STEERLESS = path.join(fixture, 'steerless-root');

// Bodies are the join key: the same string is hashed on both sides, so a fixture
// sender and receiver pair only if these match byte for byte.
const BODY_A = 'take option 2, because the migration already exists';
const BODY_B = 'the gate is npm run preflight in that repo, not npm test';
const BODY_C = 'stay on the existing helper, do not add a new one';
const BODY_D = 'Correction to my previous message: the branch was already merged.';
const BODY_E = 'run the gate before you bump the version';
const BODY_F = 'read the open PR list before you start, someone may be on this';

/** Write one .jsonl transcript, optionally aged so --days can exclude it. */
function jl(dir, name, records, ageDays) {
    const d = path.join(ROOT, dir);
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, name);
    fs.writeFileSync(p, records
        .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
        .join('\n') + '\n', 'utf8');
    if (ageDays) {
        const t = new Date(Date.now() - ageDays * 864e5);
        fs.utimesSync(p, t, t);
    }
}

// The delivered shape, verbatim from a real record: the host prefixes the
// wrapper with a sentence, so the tag does not sit at index 0.
const delivered = (o) => ({
    type: 'user',
    message: {
        role: 'user',
        content: 'Another Claude session sent a message:\n<cross-session-message from="'
            + o.from + '" name="' + o.name + '" encoded="1">\n' + o.body
            + '\n</cross-session-message>\n\nThis came from another Claude session.',
    },
    isMeta: true,
    timestamp: o.at,
    sessionId: o.session,
    cwd: o.cwd,
    gitBranch: o.branch,
    origin: { kind: 'peer', from: o.from, hostInjected: true },
    version: '2.1.237',
});

const toolUse = (at, name, extra) => Object.assign({
    type: 'assistant', timestamp: at, sessionId: 'r',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool' + at, name, input: {} }] },
}, extra || {});

const sendCall = (at, id, target, body) => ({
    type: 'assistant', timestamp: at, sessionId: 'snd',
    message: {
        role: 'assistant',
        content: [{
            type: 'tool_use', id, name: 'mcp__ccd_session_mgmt__send_message',
            input: { session_id: target, message: body },
        }],
    },
});

const sendResult = (id, text) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
});

function buildFixture() {
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(APPDATA, { recursive: true });
    fs.mkdirSync(EMPTY, { recursive: true });

    // -- proj-a: two steers in ONE file, so a per-file count and a per-event
    //    count cannot be the same number. Carries the enqueue twin the host
    //    writes beside every delivery, and one unparseable line.
    //    A: sent 10:00, delivered 10:14 -> 14m, with a Bash in the gap -> LATE.
    //    B: sent 10:30, delivered 10:31 -> exactly 60000ms, the minute boundary
    //       the queue column rounds on, and nothing in the gap -> IN-TIME.
    jl('proj-a', 'recv-a.jsonl', [
        {
            type: 'queue-operation', operation: 'enqueue',
            timestamp: '2026-08-21T10:13:59.000Z', sessionId: 'recv-1',
            content: '<cross-session-message from="local_a">\n' + BODY_A + '\n</cross-session-message>',
        },
        toolUse('2026-08-21T10:05:00.000Z', 'Bash'),
        delivered({
            from: 'local_a', name: 'overseer', body: BODY_A,
            at: '2026-08-21T10:14:00.000Z', session: 'recv-1',
            cwd: 'C:/code/orchard', branch: 'feature/prune',
        }),
        toolUse('2026-08-21T10:20:00.000Z', 'Write'),
        delivered({
            from: 'local_a', name: 'overseer', body: BODY_B,
            at: '2026-08-21T10:31:00.000Z', session: 'recv-1',
            cwd: 'C:/code/orchard', branch: 'feature/prune',
        }),
        '{ this line is not json but it does mention cross-session-message',
    ]);
    jl('proj-a', 'send-a.jsonl', [
        sendCall('2026-08-21T10:00:00.000Z', 'tu1', 'local_recv1', BODY_A),
        sendResult('tu1', 'Message queued for session local_recv1 ("orchard"); it will be processed after the in-flight turn finishes'),
        sendCall('2026-08-21T10:30:00.000Z', 'tu2', 'local_recv1', BODY_B),
        sendResult('tu2', 'Message sent to session local_recv1 ("orchard").'),
    ]);

    // -- proj-b: the IN-TIME case, and the two exclusions that decide it.
    //    Between send and delivery sit a Grep, an MCP read verb, and a Bash that
    //    belongs to a SUBAGENT (isSidechain). Count any of them and this steer
    //    reads LATE - a verdict that would send a reader to fix a steer that was
    //    on time.
    jl('proj-b', 'recv-b.jsonl', [
        toolUse('2026-08-21T11:00:10.000Z', 'Grep'),
        toolUse('2026-08-21T11:00:15.000Z', 'Bash', { isSidechain: true }),
        toolUse('2026-08-21T11:00:20.000Z', 'mcp__ccd_session_mgmt__list_sessions'),
        delivered({
            from: 'local_b', name: 'peer', body: BODY_C,
            at: '2026-08-21T11:00:30.000Z', session: 'recv-2',
            cwd: 'C:/code/quarry', branch: 'main',
        }),
        toolUse('2026-08-21T11:05:00.000Z', 'Edit'),
    ]);
    jl('proj-b', 'send-b.jsonl', [
        // No tool_result: the host's verdict is then unknown, and unknown must
        // not fall through to "the receiver was free".
        sendCall('2026-08-21T11:00:00.000Z', 'tu3', 'local_recv2', BODY_C),
    ]);

    // -- proj-c: a steer whose sender is not on this disk, in a file old enough
    //    for --days to drop. Also carries an assistant echoing the tag and a
    //    tool_result quoting it: three marker-bearing records, one steer.
    jl('proj-c', 'recv-c.jsonl', [
        {
            type: 'assistant', timestamp: '2026-08-22T08:59:00.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: '<cross-session-message from="local_echo">\nquoting it back\n</cross-session-message>' }] },
        },
        {
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tr1', content: '<cross-session-message from="local_tr">\nin a tool result\n</cross-session-message>' }] },
        },
        delivered({
            from: 'local_c', name: 'ghost', body: BODY_D,
            at: '2026-08-22T09:00:00.000Z', session: 'recv-3',
            cwd: 'C:/code/ledger', branch: 'wip/x',
        }),
    ], 30);

    // -- nested three directories deep, which the walker has silently dropped
    //    before. An unrecognised tool in the gap must read as work, not as calm.
    const NEST = path.join('proj-c', 'uuid-1', 'subagents', 'workflows', 'wf_9');
    jl(NEST, 'recv-nested.jsonl', [
        toolUse('2026-08-22T12:05:00.000Z', 'SomeToolInventedNextMonth'),
        delivered({
            from: 'local_d', name: 'nested', body: BODY_E,
            at: '2026-08-22T12:10:00.000Z', session: 'recv-4',
            cwd: 'C:/code/anvil', branch: 'wip/y',
        }),
    ]);
    jl(NEST, 'send-nested.jsonl', [
        sendCall('2026-08-22T12:00:00.000Z', 'tu5', 'local_recv4', BODY_E),
    ]);

    // -- proj-d: walked LAST, delivered FIRST. The report orders by time, and a
    //    "first steer on disk" that reported file order would name the wrong one.
    jl('proj-d', 'recv-early.jsonl', [
        delivered({
            from: 'local_f', name: 'early bird', body: BODY_F,
            at: '2026-08-20T08:00:00.000Z', session: 'recv-6',
            cwd: 'C:/code/willow', branch: 'main',
        }),
    ]);
    jl('proj-d', 'ordinary.jsonl', [
        { type: 'user', message: { role: 'user', content: 'just an ordinary turn' } },
    ]);

    // -- a second root: real transcripts, no steers anywhere in them.
    fs.mkdirSync(path.join(STEERLESS, 'proj-x'), { recursive: true });
    fs.writeFileSync(path.join(STEERLESS, 'proj-x', 'a.jsonl'),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'nothing to see' } }) + '\n', 'utf8');
    fs.writeFileSync(path.join(STEERLESS, 'proj-x', 'b.jsonl'),
        JSON.stringify(toolUse('2026-08-21T10:00:00.000Z', 'Bash')) + '\n', 'utf8');
}

function run(args) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: HOME, HOME, APPDATA },
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const clip = (out) => JSON.stringify(out.slice(0, 900));
const line = (out, re) => { const m = out.match(re); return m ? m[1] : null; };
const numOf = (out, re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
const has = (out, s) => out.includes(s);

// ---------------------------------------------------------------------------

try {
    buildFixture();

    const text = run(['--root', ROOT]);
    const jsonRun = run(['--root', ROOT, '--json']);
    let J = null;
    try { J = JSON.parse(jsonRun.stdout); } catch { /* asserted below */ }

    const byBody = (frag) => (J ? J.steers.find((s) => s.firstLine.indexOf(frag) === 0) : null) || {};
    // The tool names counted in a steer's send->delivery gap, flattened so an
    // assertion pins the VALUE and a missing window fails rather than throwing.
    const gapNames = (frag) => {
        const w = byBody(frag).workInWindow;
        return w && Array.isArray(w.names) ? w.names.join(',') : 'NO-WINDOW';
    };

    // -----------------------------------------------------------------------
    // The population line. A findings list with no denominator cannot be judged,
    // and every number here moves under a different defect: the twin, the
    // nesting, the per-file/per-event distinction, the unparseable line.
    // -----------------------------------------------------------------------
    eq('a corpus with steers in it exits 0', text.status, 0);
    eq('...and writes nothing to stderr', text.stderr, '');
    check('--json parsed', !!J, clip(jsonRun.stdout));
    if (!J) throw new Error('--json did not parse; the assertions below depend on it');

    eq('every transcript is counted, including three directories down',
        J.population.transcripts, 9);
    eq('...five of them carry at least one steer', J.population.withSteers, 5);
    eq('...but six steers were delivered, because one file carries two',
        J.population.steersDelivered, 6);
    eq('...from four send calls in three files', J.population.sendCalls, 4);
    eq('...in three files', J.population.withSends, 3);
    eq('a line that fails to parse is counted, not swallowed', J.population.badLines, 1);
    eq('...and nothing was unreadable', J.population.unreadable, 0);
    eq('...so the unreadable list is empty rather than absent', J.unreadableFiles.length, 0);
    check('the text report prints the same denominator',
        has(text.stdout, '  transcripts scanned          9  (0.0 MB)')
        && has(text.stdout, '  files with >=1 steer         5')
        && has(text.stdout, '  steers DELIVERED             6')
        && has(text.stdout, '  send_message calls found     4')
        && has(text.stdout, '  lines that failed to parse   1'),
        clip(text.stdout));

    // -----------------------------------------------------------------------
    // The lookalikes, counted end to end rather than through the detector.
    // Each of these records really occurs on disk and each would inflate the
    // headline number that the steering argument is made from.
    // -----------------------------------------------------------------------
    eq('the enqueue twin beside a delivery is not a second steer',
        J.steers.filter((s) => s.firstLine === BODY_A).length, 1);
    eq('an assistant quoting the tag and a tool_result carrying it are not steers',
        J.steers.filter((s) => s.recipientSession === 'recv-3').length, 1);

    // -----------------------------------------------------------------------
    // Ordering, and the first-steer control. proj-d is walked last and holds the
    // earliest delivery, so file order and time order disagree on purpose.
    // -----------------------------------------------------------------------
    eq('the earliest delivery leads the list, not the first file walked',
        (J.steers[0] || {}).deliveredAt, '2026-08-20T08:00:00.000Z');
    eq('...and the last is the latest',
        (J.steers[J.steers.length - 1] || {}).deliveredAt, '2026-08-22T12:10:00.000Z');
    check('the known-positive control reports itself before any count is read',
        has(text.stdout, '  detector fires on fixture    YES'), clip(text.stdout));
    check('...and the first real steer is named with its sender and recipient',
        has(text.stdout, '  first real steer on disk     2026-08-20T08:00:00.000Z')
        && has(text.stdout, '    from local_f ("early bird")')
        && has(text.stdout, '    to   willow  [recv-6]'),
        clip(text.stdout));

    // -----------------------------------------------------------------------
    // ARITHMETIC 1 - the queue delay, delivered minus sent, and how it renders.
    // The minute boundary is exact on purpose: 60000ms must read as 1m, and an
    // off-by-one comparison would print 60s.
    // -----------------------------------------------------------------------
    eq('a 14-minute queue delay is measured in milliseconds',
        byBody(BODY_A).queueMs, 840000);
    eq('...and rendered in minutes', line(text.stdout, /2026-08-21 10:14:00\s+LATE\s+(\S+)\s/), '14m');
    eq('exactly one minute in the queue is measured as 60000',
        byBody(BODY_B).queueMs, 60000);
    eq('...and rendered as 1m, not 60s',
        line(text.stdout, /2026-08-21 10:31:00\s+IN-TIME\s+(\S+)\s/), '1m');
    eq('a half-minute delay stays in seconds',
        line(text.stdout, /2026-08-21 11:00:30\s+IN-TIME\s+(\S+)\s/), '30s');
    eq('...from a measured 30000ms', byBody(BODY_C).queueMs, 30000);
    check('the whole row is one line: time, verdict, queue, recipient',
        has(text.stdout, '  2026-08-21 10:14:00  LATE         14m      orchard'),
        clip(text.stdout));

    // -----------------------------------------------------------------------
    // ARITHMETIC 2 - the LATE / IN-TIME split, which is the metric the standing
    // decision is argued from.
    // -----------------------------------------------------------------------
    eq('a Bash between send and delivery makes the steer LATE',
        byBody(BODY_A).latency, 'LATE');
    eq('...and the reason names how many actions ran',
        byBody(BODY_A).latencyReason, '1 substantive action(s) ran between send and delivery');
    eq('...and which', gapNames(BODY_A), 'Bash');

    eq('a gap containing only a read, an MCP read verb and a SUBAGENT bash is IN-TIME',
        byBody(BODY_C).latency, 'IN-TIME');
    eq('...having seen two tool calls in that gap, not three',
        (byBody(BODY_C).workInWindow || {}).tools, 2);
    eq('...none of them substantive', (byBody(BODY_C).workInWindow || {}).substantive, 0);

    eq('an unrecognised tool in the gap falls to the dangerous reading',
        byBody(BODY_E).latency, 'LATE');
    eq('...naming the tool it could not classify',
        gapNames(BODY_E), 'SomeToolInventedNextMonth');

    eq('work AFTER delivery never makes a steer late',
        byBody(BODY_B).latency, 'IN-TIME');
    eq('...its gap held nothing at all', (byBody(BODY_B).workInWindow || {}).tools, 0);

    check('the split is reported with the measured denominator beside it',
        has(text.stdout, '2  ARRIVAL LATENCY — MEASURED for 4 of 6')
        && has(text.stdout, '   LATE (work ran between send and delivery)   2')
        && has(text.stdout, '   IN-TIME                                     2')
        && has(text.stdout, '   not measured (no send call on this disk)    2'),
        clip(text.stdout));
    eq('...and the json carries the same two numbers',
        [J.population.latencyMeasured, J.population.latencyNotMeasured].join('/'), '4/2');
    check('the tools counted as substantive are printed, so the class is auditable',
        has(text.stdout, '   tools counted as substantive in windows:    Bash(1) SomeToolInventedNextMonth(1)'),
        clip(text.stdout));
    eq('...and listed in the json with their counts',
        JSON.stringify(J.substantiveToolsCounted),
        '[["Bash",1],["SomeToolInventedNextMonth",1]]');

    // -----------------------------------------------------------------------
    // An unjoinable steer must say NOT MEASURED. Reading it as on-time is the
    // failure that would make the whole metric flattering.
    // -----------------------------------------------------------------------
    eq('a steer with no sender on disk is not measured', byBody(BODY_D).latency, 'not-measured');
    eq('...with the reason naming the origin', byBody(BODY_D).latencyReason,
        'no send call for this steer is on this disk (peer)');
    eq('...and no send time invented for it', byBody(BODY_D).sentAt, null);
    eq('...nor a queue delay', byBody(BODY_D).queueMs, null);
    eq('...and its join method says so', byBody(BODY_D).join, 'none');
    check('...rendered with a dash where the delay would be',
        has(text.stdout, '  2026-08-22 09:00:00  not-measured -        ledger'),
        clip(text.stdout));

    // -----------------------------------------------------------------------
    // The host's own verdict. Absent must stay null: an unrecognised wording
    // falling through to "arrived promptly" is the same failure one layer down.
    // -----------------------------------------------------------------------
    eq('a queued send is recorded as the host reporting the receiver busy',
        byBody(BODY_A).hostQueued, true);
    eq('a sent send is recorded as not queued', byBody(BODY_B).hostQueued, false);
    eq('a send with no result at all stays unknown', byBody(BODY_C).hostQueued, null);
    check('...and only the queued one is counted in the report',
        has(text.stdout, '   host itself reported the receiver busy      1'),
        clip(text.stdout));

    // -----------------------------------------------------------------------
    // ARITHMETIC 3 - the per-day histogram, and the correction count that is
    // explicitly a lower bound.
    // -----------------------------------------------------------------------
    eq('the per-day counts add up to the delivered total',
        JSON.stringify(J.byDay),
        '[{"date":"2026-08-20","steers":1},{"date":"2026-08-21","steers":3},{"date":"2026-08-22","steers":2}]');
    check('...and are printed under the steers-sent heading',
        has(text.stdout, '   6 delivered, 4 send calls found on disk')
        && has(text.stdout, '     2026-08-21  3'),
        clip(text.stdout));
    eq('a steer whose own text retracts an earlier one is counted', J.selfFlaggedCorrections, 1);
    check('...and labelled a lower bound rather than an accuracy rate',
        has(text.stdout, '   self-flagged corrections in steer text: 1  (literal string search, a LOWER BOUND on wrong steers - not an accuracy rate)'),
        clip(text.stdout));

    // -----------------------------------------------------------------------
    // Adoption stays unmeasured. This is a deliberate refusal, and a later
    // session inventing a proxy for it is exactly what should go red here.
    // -----------------------------------------------------------------------
    check('adoption is reported as not measured, with the denominator it declined',
        has(text.stdout, '3  ADOPTION — NOT MEASURED (0 of 6)'), clip(text.stdout));
    eq('...and the json reports zero adoption measurements', J.population.adoptionMeasured, 0);
    eq('...on every steer, as a sentinel rather than a number',
        J.steers.map((s) => s.adoption).join(','),
        'not-measured,not-measured,not-measured,not-measured,not-measured,not-measured');

    // -----------------------------------------------------------------------
    // --evidence prints the grading packet: the steer, then what the receiver
    // actually did next, marked substantive or not.
    // -----------------------------------------------------------------------
    {
        const r = run(['--root', ROOT, '--evidence']);
        eq('--evidence exits 0', r.status, 0);
        check('it prints the receiver\'s next action with its time and class',
            has(r.stdout, '      next: 10:20:00  Write  [substantive]'), clip(r.stdout));
        check('...and says plainly when there was none',
            has(r.stdout, '      next actions: none within 2h'), clip(r.stdout));
        check('...under a banner that repeats what the tool does not do',
            has(r.stdout, '      --- EVIDENCE FOR MANUAL GRADING (this tool does not grade adoption) ---'),
            clip(r.stdout));
        check('the default run does NOT dump bodies',
            !has(text.stdout, 'EVIDENCE FOR MANUAL GRADING'), clip(text.stdout));
        eq('...and the default json omits the body field', J.steers[0].body, undefined);
    }

    // -----------------------------------------------------------------------
    // --days narrows by FILE MTIME, which is not the same question as the
    // timestamp inside. The 30-day-old file drops; the steer delivered on
    // 2026-08-20 in a fresh file stays.
    // -----------------------------------------------------------------------
    {
        const r = run(['--root', ROOT, '--days', '7', '--json']);
        const j = JSON.parse(r.stdout);
        eq('a transcript older than the window is not scanned', j.population.transcripts, 8);
        eq('...so its steer is gone', j.population.steersDelivered, 5);
        eq('...and the correction it carried with it', j.selfFlaggedCorrections, 0);
        eq('a steer delivered before the window but written recently survives',
            j.steers[0].deliveredAt, '2026-08-20T08:00:00.000Z');
        eq('...leaving one unjoined steer, not two', j.population.latencyNotMeasured, 1);
        check('the header states the window it applied',
            has(run(['--root', ROOT, '--days', '7']).stdout, '  (last 7d)'), 'no window line');
    }

    // -----------------------------------------------------------------------
    // THE EMPTY CASE. Three flavours, none of which may render as a clean zero.
    // -----------------------------------------------------------------------
    {
        const r = run(['--root', STEERLESS]);
        eq('a corpus with transcripts but no steers exits 1', r.status, 1);
        check('...and says how many transcripts it read before finding none',
            has(r.stdout, '  ZERO steers found across 2 transcripts.'), clip(r.stdout));
        check('...names the reading it refuses',
            has(r.stdout, 'Treat this as UNVERIFIED, not as 0.'), clip(r.stdout));
        check('...having first shown its control fires',
            has(r.stdout, '  detector fires on fixture    YES'), clip(r.stdout));
        check('...and prints no latency or adoption sections built on the zero',
            !has(r.stdout, 'ARRIVAL LATENCY') && !has(r.stdout, 'ADOPTION'), clip(r.stdout));
    }
    {
        const r = run(['--root', EMPTY]);
        eq('an empty root exits 1 too', r.status, 1);
        check('...reporting zero transcripts rather than zero steers',
            has(r.stdout, '  transcripts scanned          0  (0.0 MB)')
            && has(r.stdout, '  ZERO steers found across 0 transcripts.'),
            clip(r.stdout));
    }
    {
        const r = run(['--root', path.join(fixture, 'no-such-root')]);
        eq('a root that does not exist exits 1 rather than throwing', r.status, 1);
        eq('...and writes nothing to stderr', r.stderr, '');
        check('...still naming the root it looked in',
            has(r.stdout, path.join(fixture, 'no-such-root')), clip(r.stdout));
    }
    {
        const r = run(['--root', EMPTY, '--json']);
        eq('--json over an empty corpus exits 1 as well', r.status, 1);
        const j = JSON.parse(r.stdout);
        eq('...with an empty steer list', j.steers.length, 0);
        eq('...and the control still reported true beside it', j.population.controlFires, true);
        eq('...and no latency measured', j.population.latencyMeasured, 0);
    }

    // -----------------------------------------------------------------------
    // The shipped --selftest is a wired entry point nothing else drives. Its
    // being green is part of what this report claims about itself.
    // -----------------------------------------------------------------------
    {
        const r = run(['--selftest']);
        eq('--selftest exits 0', r.status, 0);
        check('...and reports itself green with nothing failing',
            has(r.stdout, 'SELFTEST GREEN') && /\n {2}\d+ passed, 0 failed\n/.test(r.stdout),
            clip(r.stdout.slice(-400)));
        eq('...over more than a handful of assertions',
            numOf(r.stdout, /\n {2}(\d+) assertions\n/) >= 20, true);
    }

} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
