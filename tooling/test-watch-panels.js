#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/watch-panels.js - the watcher that
// feeds Monitor one line per newly-blocked session.
// Run: node tooling/test-watch-panels.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS ONE NEEDS TESTING AT ALL.
//
// Every failure mode here is silent, and two of them are worse than silent
// because they train the reader to ignore the channel.
//
//   Dedup lost   -> answered panels are re-raised on the next restart. The
//                   file's own comment records this happening: restarting the
//                   monitor to pick up a fix reset an in-memory Set and three
//                   already-answered panels pinged again. A watcher that cries
//                   wolf after every code change gets muted, and then it misses
//                   the real one.
//   Dedup too wide -> a session that raises a SECOND question is swallowed,
//                   because the key collapses to sessionId. Nothing errors; the
//                   overseer simply never hears about the question.
//   Filter wrong -> --self stops excluding the running session, or starts
//                   excluding the wrong one. Both look like a quiet fleet.
//
// So every zero asserted below sits in the same run as a PLANTED POSITIVE - a
// blocked session that must always produce its line. A run that reports the
// planted line and not the case under test is a run whose probe demonstrably
// fires. And the one assertion about persistence is paired with its own control:
// delete the state file, re-run the identical payload, and the line must come
// back. Without that control, "emitted nothing" is indistinguishable from a
// watcher that never scanned.
//
// THE SEAM, AND WHY IT IS THE ONE THAT SHIPS.
//
// watch-panels.js builds its fleet-status path from USERPROFILE:
//
//     path.join(process.env.USERPROFILE, 'claude-auto-dev', 'plugins',
//               'autodev-core', 'scripts', 'fleet-status.js')
//
// That is not a testing seam somebody added - it is how the shipped script finds
// its data source, so pointing USERPROFILE at a fixture home runs the exact
// bytes that ship against a fleet-status of this suite's choosing. Nothing is
// copied and nothing is patched. Dedup state has its own documented env seam,
// AUTODEV_FLEET_DIR, which every scenario points at a private directory so the
// suite never reads or writes this machine's real watcher memory.
//
// Two things follow from that path, and both are recorded rather than fixed:
// see the FINDINGS note at the foot of this file.
//
// WHY THE CHILD IS KILLED RATHER THAN AWAITED.
//
// The subject has no one-shot mode: it calls scan() once and then
// setInterval(scan, 60_000), so the process never exits. Its whole observable
// behaviour for one scan is synchronous and complete before that interval is
// armed. Each run therefore waits for a POSITIVE signal that the scan really
// happened - the stub fleet-status writes its own argv to a log file - then
// settles 250ms and sends SIGTERM. The settle is a fixed margin after a real
// event, not a plateau: concluding "quiet, therefore finished" before the scan
// starts is the trap in rules/verification-traps.md, and waiting on the argv log
// is what makes this immune to it.
//
// The three-consecutive-failure WATCHER-ERROR branch is NOT covered: reaching it
// needs two more scans, and the interval is a hardcoded 60_000. What is covered
// is the half that is reachable and is the actual policy - that a SINGLE failed
// scan says nothing at all.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'watch-panels.js',
);

let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  (' + detail + ')'}`);
}

function eq(label, actual, expected) {
    check(label, actual === expected,
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function deq(label, actual, expected) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    check(label, a === b, `got ${a}, expected ${b}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixture machine
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-panels-'));

const HOME = path.join(fixture, 'home');
// The exact tree the subject reaches for off USERPROFILE. Written out in full
// rather than derived, so a change to that path in the subject shows up here as
// a failed scan rather than as a silently different fixture.
// The subject resolves fleet-status.js as a SIBLING via __dirname, so control it
// by running a COPY of the subject beside the stub rather than by bending the
// environment. This suite previously pointed USERPROFILE at a fixture tree
// containing claude-auto-dev/plugins/autodev-core/scripts/, which worked only
// because the subject hardcoded that path - so the suite reached its scenario
// THROUGH the defect, and fixing the defect turned it red. See BUG-CLASSES 27.
const STUB_SCRIPTS = path.join(fixture, 'subject');
const PAYLOAD = path.join(fixture, 'payload.json');
const ARGVLOG = path.join(fixture, 'argv.json');

fs.mkdirSync(STUB_SCRIPTS, { recursive: true });
fs.copyFileSync(SUBJECT, path.join(STUB_SCRIPTS, 'watch-panels.js'));
const PLANTED = path.join(STUB_SCRIPTS, 'watch-panels.js');

// The stub records WHICH question the watcher asked before it does anything
// else, so the argv log exists even on the failure path - which is what lets a
// silent run be distinguished from a run that never happened.
fs.writeFileSync(path.join(STUB_SCRIPTS, 'fleet-status.js'), [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    'fs.writeFileSync(process.env.WP_ARGV_LOG, JSON.stringify(process.argv.slice(2)));',
    "const mode = process.env.WP_MODE || 'ok';",
    "if (mode === 'fail') { process.stderr.write('fleet-status exploded\\n'); process.exit(7); }",
    "if (mode === 'garbage') { process.stdout.write('{not json'); process.exit(0); }",
    // A SUCCEEDING scan that also warns. fleet-status.js really does this — it
    // writes 'no transcript root at ...' to stderr and exits 0 — so this is the
    // shipped combination, not a contrived one.
    "if (mode === 'noisy') { process.stderr.write('fleet-status: could not read the session store\\n'); }",
    "process.stdout.write(fs.readFileSync(process.env.WP_PAYLOAD, 'utf8'));",
    '',
].join('\n'));

let dirSeq = 0;
/** A private dedup-state directory, so no scenario inherits another's memory. */
function freshFleetDir() {
    const d = path.join(fixture, 'fleet-' + (++dirSeq));
    fs.mkdirSync(d, { recursive: true });
    return d;
}

const stateFile = (dir) => path.join(dir, 'watch-panels-seen.json');
const readState = (dir) => JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));

// ---------------------------------------------------------------------------
// Session rows, in the shape fleet-status.js --json emits
// ---------------------------------------------------------------------------

/** One blocked row carrying one question. */
function blocked(o) {
    const row = {
        sessionId: o.sessionId,
        addressableId: o.addressableId === undefined ? null : o.addressableId,
        state: o.state === undefined ? 'blocked' : o.state,
    };
    if (o.title !== undefined) row.title = o.title;
    if (o.lastTs !== undefined) row.lastTs = o.lastTs;
    if (o.pending !== undefined) row.pending = o.pending;
    else if (o.askedAt !== undefined) {
        row.pending = { askedAt: o.askedAt, questions: o.questions || [] };
    }
    return row;
}

/** The planted positive: one line, always, in whatever scan it appears in. */
const BEACON = () => blocked({
    sessionId: 'sess-beacon', addressableId: 'local_beacon', title: 'Beacon Lighthouse',
    askedAt: '2026-08-24T09:00:00.000Z',
    questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }],
});
const BEACON_LINE = 'PANEL Beacon Lighthouse :: Ship it? [Yes] :: local_beacon';

// ---------------------------------------------------------------------------
// Runner. Nothing here requires the subject in-process.
// ---------------------------------------------------------------------------

/**
 * Run the shipped watcher over one payload and return everything it emitted.
 *
 * @param {object} o.payload     what the stub fleet-status prints
 * @param {string} o.fleetDir    dedup state directory
 * @param {string[]} o.args      argv for the watcher
 * @param {object} o.env         extra environment
 */
async function run(o) {
    fs.writeFileSync(PAYLOAD, JSON.stringify(o.payload, null, 2));
    try { fs.unlinkSync(ARGVLOG); } catch { /* first run */ }

    const child = spawn(process.execPath, [PLANTED, ...(o.args || [])], {
        env: {
            ...process.env,
            USERPROFILE: HOME,
            HOME,
            AUTODEV_FLEET_DIR: o.fleetDir,
            AUTODEV_SELF_SESSION: '',
            WP_ARGV_LOG: ARGVLOG,
            WP_PAYLOAD: PAYLOAD,
            WP_MODE: o.mode || 'ok',
            ...(o.env || {}),
        },
    });

    let out = '', err = '', closed = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const closePromise = new Promise((res) => child.on('close', () => { closed = true; res(); }));

    // Wait for proof the scan ran, not for the absence of noise.
    const deadline = Date.now() + 20000;
    while (!closed && !fs.existsSync(ARGVLOG) && Date.now() < deadline) await sleep(20);
    const scanned = fs.existsSync(ARGVLOG);
    if (!closed) { await sleep(250); child.kill(); }
    await closePromise;

    return {
        stdout: out,
        stderr: err,
        scanned,
        argv: scanned ? fs.readFileSync(ARGVLOG, 'utf8') : null,
        lines: out.split('\n').filter(Boolean),
    };
}

// ---------------------------------------------------------------------------

(async () => {
    try {
        // -------------------------------------------------------------------
        // A new panel: one line, and exactly what it says.
        //
        // Asserted whole rather than by substring. The line IS the product -
        // "a session stopped" without the question is a ping worth nothing, and
        // the file's own comment records shipping that bug once already.
        // -------------------------------------------------------------------
        const d1 = freshFleetDir();
        {
            const r = await run({
                fleetDir: d1,
                payload: {
                    sessions: [blocked({
                        sessionId: 'sess-orchard', addressableId: 'local_orchard',
                        title: 'Orchard Harvest', askedAt: '2026-08-24T10:00:00.000Z',
                        questions: [{
                            question: 'Which path?',
                            options: [{ label: 'Prune' }, { label: 'Graft' }],
                        }],
                    })],
                },
            });
            check('the watcher actually scanned', r.scanned, 'no argv log; stderr=' + JSON.stringify(r.stderr));
            eq('a newly blocked session emits exactly one line', r.lines.length, 1);
            eq('...carrying title, question, options and addressable id',
                r.lines[0],
                'PANEL Orchard Harvest :: Which path? [Prune | Graft] :: local_orchard');
            eq('a clean scan writes nothing to stderr', r.stderr, '');
            eq('it asks fleet-status for one day of pending sessions as json',
                r.argv, '["--pending","--days","1","--json"]');
            deq('...and remembers that panel by session and ask time',
                readState(d1), ['sess-orchard|2026-08-24T10:00:00.000Z']);
        }

        // -------------------------------------------------------------------
        // THE CHILD'S STDERR MUST NOT BECOME THE WATCHER'S.
        //
        // execFileSync INHERITS stderr unless stdio says otherwise — measured
        // directly: with the default, a child's stderr lands on the parent's;
        // with ['ignore','pipe','pipe'] it is captured. So without an explicit
        // stdio the watcher speaks whenever fleet-status warns, even though the
        // watcher itself has nothing to report.
        //
        // That matters more here than a stray line suggests. This watcher's
        // whole contract is that a quiet scan is SILENT, so anything reading it
        // as a signal — a Monitor, a notifier, a human — is being told a session
        // needs attention by a subprocess's logging. fleet-status warns on a
        // path it genuinely cannot read, which is a condition that persists, so
        // it would speak on every scan forever.
        //
        // The planted positive shares the run: the beacon's line must still come
        // through on stdout, so this cannot pass by the watcher having gone deaf.
        // -------------------------------------------------------------------
        {
            const r = await run({
                fleetDir: freshFleetDir(),
                mode: 'noisy',
                payload: { sessions: [BEACON()] },
            });
            eq('a warning from fleet-status does not leak onto the watcher stderr',
                r.stderr, '');
            eq('...while the scan itself still reports its panel', r.lines[0], BEACON_LINE);
            eq('...and emits nothing else', r.lines.length, 1);
        }

        // -------------------------------------------------------------------
        // Restart. A new process starts with an empty in-memory Set, so this is
        // the whole persistence contract: the same panel must not ping twice.
        // -------------------------------------------------------------------
        {
            const r = await run({
                fleetDir: d1,
                payload: {
                    sessions: [blocked({
                        sessionId: 'sess-orchard', addressableId: 'local_orchard',
                        title: 'Orchard Harvest', askedAt: '2026-08-24T10:00:00.000Z',
                        questions: [{ question: 'Which path?', options: [{ label: 'Prune' }] }],
                    })],
                },
            });
            eq('restarting the watcher does not re-raise an already-reported panel',
                r.stdout, '');
            eq('...and it did scan, so the silence is a decision', r.argv,
                '["--pending","--days","1","--json"]');
            deq('...leaving the remembered key untouched',
                readState(d1), ['sess-orchard|2026-08-24T10:00:00.000Z']);
        }

        // The control for the assertion above. Without it, "emitted nothing" is
        // equally consistent with a watcher that cannot report anything at all.
        {
            fs.unlinkSync(stateFile(d1));
            const r = await run({
                fleetDir: d1,
                payload: {
                    sessions: [blocked({
                        sessionId: 'sess-orchard', addressableId: 'local_orchard',
                        title: 'Orchard Harvest', askedAt: '2026-08-24T10:00:00.000Z',
                        questions: [{ question: 'Which path?', options: [{ label: 'Prune' }] }],
                    })],
                },
            });
            eq('with the memory deleted the identical panel is reported again',
                r.lines[0],
                'PANEL Orchard Harvest :: Which path? [Prune] :: local_orchard');
        }

        // -------------------------------------------------------------------
        // The other half of dedup, and the one a sessionId-only key would break:
        // a session that asks a SECOND question deserves a second ping.
        // -------------------------------------------------------------------
        {
            const d = freshFleetDir();
            const first = await run({
                fleetDir: d,
                payload: {
                    sessions: [blocked({
                        sessionId: 'sess-twice', addressableId: 'local_twice', title: 'Twice Asked',
                        askedAt: '2026-08-24T11:00:00.000Z',
                        questions: [{ question: 'First?', options: [{ label: 'A' }] }],
                    })],
                },
            });
            eq('the first question is reported',
                first.lines[0], 'PANEL Twice Asked :: First? [A] :: local_twice');

            const second = await run({
                fleetDir: d,
                payload: {
                    sessions: [blocked({
                        sessionId: 'sess-twice', addressableId: 'local_twice', title: 'Twice Asked',
                        askedAt: '2026-08-24T11:30:00.000Z',
                        questions: [{ question: 'Second?', options: [{ label: 'B' }] }],
                    })],
                },
            });
            eq('a second panel from the same session is a second ping',
                second.lines[0], 'PANEL Twice Asked :: Second? [B] :: local_twice');
            deq('...and both ask times are remembered', readState(d),
                ['sess-twice|2026-08-24T11:00:00.000Z', 'sess-twice|2026-08-24T11:30:00.000Z']);
        }

        // -------------------------------------------------------------------
        // --self. Three ways in, and the control that says the exclusion is a
        // filter rather than a dropped row.
        // -------------------------------------------------------------------
        const selfPayload = () => ({
            sessions: [
                blocked({
                    sessionId: 'sess-me', addressableId: 'local_me', title: 'The Overseer',
                    askedAt: 'T-me', questions: [{ question: 'Mine?', options: [{ label: 'Y' }] }],
                }),
                blocked({
                    sessionId: 'sess-them', addressableId: 'local_them', title: 'Someone Else',
                    askedAt: 'T-them', questions: [{ question: 'Theirs?', options: [{ label: 'N' }] }],
                }),
            ],
        });
        {
            const r = await run({ fleetDir: freshFleetDir(), payload: selfPayload() });
            eq('with no self given, both blocked sessions are reported', r.lines.length, 2);
            eq('...including the one later excluded',
                r.lines[0], 'PANEL The Overseer :: Mine? [Y] :: local_me');
        }
        {
            const r = await run({
                fleetDir: freshFleetDir(), payload: selfPayload(), args: ['--self', 'sess-me'],
            });
            eq('--self matching the transcript id excludes exactly one session', r.lines.length, 1);
            eq('...leaving the other one reported',
                r.lines[0], 'PANEL Someone Else :: Theirs? [N] :: local_them');
        }
        {
            const r = await run({
                fleetDir: freshFleetDir(), payload: selfPayload(), args: ['--self', 'local_me'],
            });
            eq('--self matching the addressable id excludes the same session', r.lines.length, 1);
            eq('...leaving the other one reported',
                r.lines[0], 'PANEL Someone Else :: Theirs? [N] :: local_them');
        }
        {
            const r = await run({
                fleetDir: freshFleetDir(), payload: selfPayload(),
                env: { AUTODEV_SELF_SESSION: 'local_me' },
            });
            eq('AUTODEV_SELF_SESSION excludes it without a flag', r.lines.length, 1);
            eq('...leaving the other one reported',
                r.lines[0], 'PANEL Someone Else :: Theirs? [N] :: local_them');
        }
        {
            const d = freshFleetDir();
            const r = await run({
                fleetDir: d, payload: selfPayload(), args: ['--self', 'sess-me'],
            });
            deq('an excluded session is not remembered either, so dropping --self later still pings it',
                readState(d), ['sess-them|T-them']);
        }

        // -------------------------------------------------------------------
        // The state filter. Every row below carries a pending panel, so a guard
        // written against `pending` rather than `state` would report all five.
        // -------------------------------------------------------------------
        {
            const q = [{ question: 'Anyone?', options: [{ label: 'Z' }] }];
            const r = await run({
                fleetDir: freshFleetDir(),
                payload: {
                    sessions: [
                        BEACON(),
                        blocked({ sessionId: 's-w', addressableId: 'local_w', title: 'Working One', state: 'working', askedAt: 'T1', questions: q }),
                        blocked({ sessionId: 's-x', addressableId: 'local_x', title: 'Waiting One', state: 'waiting', askedAt: 'T2', questions: q }),
                        blocked({ sessionId: 's-y', addressableId: 'local_y', title: 'Stalled One', state: 'stalled', askedAt: 'T3', questions: q }),
                        blocked({ sessionId: 's-z', addressableId: 'local_z', title: 'Cold One', state: 'cold', askedAt: 'T4', questions: q }),
                    ],
                },
            });
            eq('only rows whose state is blocked are pinged', r.lines.length, 1);
            eq('...and it is the planted one', r.lines[0], BEACON_LINE);
            check('a pending panel on a non-blocked row is not enough',
                !r.stdout.includes('Working One') && !r.stdout.includes('Stalled One'),
                JSON.stringify(r.stdout));
        }

        // -------------------------------------------------------------------
        // Failure must not look like a quiet fleet - but one transient miss must
        // not shout either. Both halves are asserted, and the argv log proves the
        // scan was attempted rather than skipped.
        // -------------------------------------------------------------------
        {
            const d = freshFleetDir();
            const r = await run({
                fleetDir: d, payload: { sessions: [BEACON()] }, mode: 'fail',
            });
            eq('a single failed scan says nothing on stdout', r.stdout, '');
            // execFileSync inherits stderr, so the cause reaches the operator
            // even while the Monitor channel stays quiet. Pinned because the
            // alternative - piping stderr and dropping it - would leave a
            // permanently broken fleet-status with no visible cause at all.
            eq('...while the underlying cause is passed through on stderr',
                r.stderr, 'fleet-status exploded\n');
            eq('...having genuinely run fleet-status', r.argv,
                '["--pending","--days","1","--json"]');
            check('...and written no dedup state', !fs.existsSync(stateFile(d)),
                'state file exists after a failed scan');

            const after = await run({ fleetDir: d, payload: { sessions: [BEACON()] } });
            eq('so the panel it could not see is still reported once the probe recovers',
                after.lines[0], BEACON_LINE);
        }
        {
            const r = await run({
                fleetDir: freshFleetDir(), payload: { sessions: [BEACON()] }, mode: 'garbage',
            });
            eq('unparseable output is announced, not swallowed',
                r.stdout, 'WATCHER-ERROR fleet-status returned unparseable JSON\n');
            eq('...on stdout, where the monitor reads it', r.stderr, '');
        }

        // -------------------------------------------------------------------
        // Payload shapes fleet-status has emitted. A dropped branch reports an
        // empty fleet rather than an error, which is the muted-watcher failure.
        // -------------------------------------------------------------------
        {
            const bare = await run({ fleetDir: freshFleetDir(), payload: [BEACON()] });
            eq('a bare array of rows is accepted', bare.lines[0], BEACON_LINE);

            const wrapped = await run({ fleetDir: freshFleetDir(), payload: { sessions: [BEACON()] } });
            eq('a { sessions } envelope is accepted', wrapped.lines[0], BEACON_LINE);

            const rows = await run({ fleetDir: freshFleetDir(), payload: { rows: [BEACON()] } });
            eq('a { rows } envelope is accepted', rows.lines[0], BEACON_LINE);

            const none = await run({ fleetDir: freshFleetDir(), payload: { population: { dirs: 0 } } });
            eq('an envelope with no recognised session key is quiet rather than an error',
                none.stdout, '');
            eq('...and is not reported as a broken probe', none.stderr, '');
        }

        // -------------------------------------------------------------------
        // Every fallback in the line builder, in one scan, with the state file
        // pinning the dedup key each row produced.
        // -------------------------------------------------------------------
        {
            const d = freshFleetDir();
            const r = await run({
                fleetDir: d,
                payload: {
                    sessions: [
                        // Options arrive as objects, as bare strings, and as
                        // neither. Whatever has no label is dropped, not printed.
                        blocked({
                            sessionId: 'f1', addressableId: 'local_f1', title: 'Alpha', askedAt: 'T1',
                            questions: [{
                                question: 'Which path?',
                                options: [{ label: 'A' }, 'B', { label: '' }, { nope: 1 }, 'C'],
                            }],
                        }),
                        // No title, and no desktop record to address it by.
                        blocked({
                            sessionId: 'f2', askedAt: 'T2',
                            questions: [{ question: 'Pick one', options: [] }],
                        }),
                        // questions is present but not an array.
                        blocked({
                            sessionId: 'f3', addressableId: 'local_f3', title: 'Gamma',
                            pending: { askedAt: 'T3', questions: 'nope' },
                        }),
                        // questions is an empty array.
                        blocked({
                            sessionId: 'f4', addressableId: 'local_f4', title: 'Delta', askedAt: 'T4',
                            questions: [],
                        }),
                        // Several questions in one panel; header stands in for a
                        // missing question, and '?' for a missing everything.
                        blocked({
                            sessionId: 'f5', addressableId: 'local_f5', title: 'Epsilon', askedAt: 'T5',
                            questions: [
                                { question: 'One', options: [{ label: 'x' }] },
                                { header: 'Path' },
                                {},
                            ],
                        }),
                        // A question wrapped across lines must arrive on one.
                        blocked({
                            sessionId: 'f6', addressableId: 'local_f6', title: 'Zeta', askedAt: 'T6',
                            questions: [{ question: 'line one\n\tline  two' }],
                        }),
                        // Blocked with no panel captured: the key falls back to
                        // the last timestamp, which is all that separates one
                        // such row from the next.
                        blocked({ sessionId: 'f7', addressableId: 'local_f7', title: 'Eta', lastTs: 'T7' }),
                        // Nothing to key on at all.
                        blocked({ sessionId: 'f8', addressableId: 'local_f8', title: 'Theta' }),
                    ],
                },
            });

            eq('every blocked row produces a line', r.lines.length, 8);
            eq('string and object options are both rendered, unlabelled ones dropped',
                r.lines[0], 'PANEL Alpha :: Which path? [A | B | C] :: local_f1');
            eq('a session with no title and no desktop record is still addressable by transcript id',
                r.lines[1], 'PANEL (untitled) :: Pick one :: f2');
            eq('a non-array questions field reads as no questions',
                r.lines[2], 'PANEL Gamma :: (no questions parsed) :: local_f3');
            eq('an empty questions array reads the same way',
                r.lines[3], 'PANEL Delta :: (no questions parsed) :: local_f4');
            eq('multiple questions are joined, falling back to header then to ?',
                r.lines[4], 'PANEL Epsilon :: One [x] ++ Path ++ ? :: local_f5');
            eq('a wrapped question is collapsed onto one line',
                r.lines[5], 'PANEL Zeta :: line one line two :: local_f6');
            eq('a blocked row with no captured panel still pings',
                r.lines[6], 'PANEL Eta :: (no questions parsed) :: local_f7');
            eq('...and so does one with nothing to key on',
                r.lines[7], 'PANEL Theta :: (no questions parsed) :: local_f8');
            deq('the dedup key is ask time, then last activity, then nothing',
                readState(d),
                ['f1|T1', 'f2|T2', 'f3|T3', 'f4|T4', 'f5|T5', 'f6|T6', 'f7|T7', 'f8|']);
        }

        // -------------------------------------------------------------------
        // A Monitor line is read in a notification, so the body is capped. The
        // cap is on the body alone - the id must survive it or the ping names a
        // session nobody can reach.
        // -------------------------------------------------------------------
        {
            const long = 'x'.repeat(800);
            const r = await run({
                fleetDir: freshFleetDir(),
                payload: {
                    sessions: [blocked({
                        sessionId: 'sess-long', addressableId: 'local_long', title: 'Truncate Me',
                        askedAt: 'T-long', questions: [{ question: long }],
                    })],
                },
            });
            eq('an 800-character question is cut to 600',
                r.lines[0], 'PANEL Truncate Me :: ' + 'x'.repeat(600) + ' :: local_long');
        }

        // -------------------------------------------------------------------
        // The memory is bounded at 500 keys. That bound is not free - it means a
        // panel older than the last 500 CAN ping twice - so it is pinned by value
        // rather than left to be discovered by a duplicate ping one day.
        // -------------------------------------------------------------------
        {
            const d = freshFleetDir();
            const old = [];
            for (let i = 0; i < 600; i++) old.push('k' + i);
            fs.writeFileSync(stateFile(d), JSON.stringify(old));

            const r = await run({
                fleetDir: d,
                payload: {
                    sessions: [blocked({
                        sessionId: 'sess-new', addressableId: 'local_new', title: 'Newcomer',
                        askedAt: 'T-new', questions: [{ question: 'Room?', options: [{ label: 'Q' }] }],
                    })],
                },
            });
            eq('a new panel is reported despite a full memory',
                r.lines[0], 'PANEL Newcomer :: Room? [Q] :: local_new');

            const kept = readState(d);
            eq('the memory is capped at 500 keys', kept.length, 500);
            eq('...evicting the oldest', kept[0], 'k101');
            eq('...and keeping the newest', kept[kept.length - 1], 'sess-new|T-new');
            check('...so a key older than the cap is forgotten and would ping again',
                !kept.includes('k0'), 'k0 survived the cap');
        }

    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    console.error(e && e.stack || e);
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch { /* already gone */ }
    process.exit(1);
});

// FINDINGS - observed while writing this suite, deliberately NOT fixed here.
//
// 1. Line 18 reads `path.join(process.env.USERPROFILE, ...)` with no fallback,
//    while line 48 uses `process.env.USERPROFILE || process.env.HOME`. On any
//    machine without USERPROFILE, path.join throws at module load and the
//    watcher dies before its first scan. This suite always sets USERPROFILE, so
//    it neither exercises nor hides the gap - it is recorded, not covered.
//
// 2. That same path points at a fixed <USERPROFILE>/claude-auto-dev clone rather
//    than at the plugin the watcher shipped inside. fleet-overlap.js carried the
//    identical line and had it removed as a production defect: an installed
//    plugin invoking a different clone's parser. Same shape, still present here.
//
// 3. `if (consecutiveErrors === 3)` is strict equality, so the WATCHER-ERROR
//    line is emitted on the third failed scan and never again - a fleet-status
//    broken for six hours announces itself once, at minute three, then goes
//    quiet for the rest of the day. That is the exact failure the header comment
//    says the branch exists to prevent. Not covered here because reaching a
//    third scan costs two minutes against a hardcoded 60_000 interval; recorded
//    rather than tested, and not fixed.
