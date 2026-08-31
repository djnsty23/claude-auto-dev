#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/quota-tripwire.js - the poll loop that
// fires ONCE when the weekly quota is 30-50 minutes from 100%.
// Run: node tooling/test-quota-tripwire.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS SCRIPT NEEDS A SUITE AT ALL.
//
// Silence is its normal output. It is quiet when there is headroom, prints one
// line when the threshold is crossed, and prints a DIAGNOSTIC line when it
// cannot compute. So the three states a reader cares about are:
//
//   measured, plenty of room  ->  zero bytes
//   measured, about to wall   ->  one PREP HANDOVER line
//   could not measure at all  ->  one DIAGNOSTIC line
//
// A regression that kills the alert reads exactly like the first state. Nothing
// is red, nothing throws, and the first symptom is hitting the quota wall
// mid-work. The third state is the one this suite guards hardest: "no alert
// because fine" and "no alert because broken" must never produce the same
// stdout. Several assertions below are literally `stdout === ''` against a
// neighbour asserting `stdout` carries `code=<something>`.
//
// WHY A FIXTURE MACHINE, AND NOT THIS ONE.
//
// Three inputs decide everything the script does, and all three are redirected:
//
//   USERPROFILE / HOME   ->  a temp home, so the DEFAULT state file and the
//                            DEFAULT quota-burn.js path both land in the fixture
//   --state <path>       ->  one state file per scenario, so scenarios cannot
//                            contaminate each other through persisted state
//   --source <path>      ->  a stub standing in for ~/.claude/scripts/quota-burn.js
//
// QUOTA_BURN_JS is deleted from the child environment except in the one test
// that asserts the override is honoured. Nothing here reads this machine's real
// transcripts, real quota state, or real clock-dependent quota position, so the
// suite cannot pass on a quiet day for the wrong reason.
//
// HOW THE REAL ENTRY POINT IS DRIVEN, and why that is the whole point.
//
// The script ships a `--selftest` that calls evaluate() in-process with
// synthetic objects. That proves the policy and NOTHING about the wiring that
// feeds it: main() -> pollOnce() -> takeReading() -> readSource()/spawn ->
// evaluate() -> saveState() -> console.log(). A suite that only re-ran the
// policy would pass while the CLI could not alert at all. So every assertion
// here is on a CHILD PROCESS's stdout, stderr, exit status, or the state file it
// wrote, and two independent paths feed the readings:
//
//   --fixture-cost/--fixture-now/--fixture-window  exact times, exact arithmetic
//   --source <stub>                                the real spawn + JSON contract
//
// The second path is what makes an upstream field rename (windowCost,
// windowStart) or an argv change (--json --days 0) go red. The stub refuses any
// argv but `--json --days 0` and records what it was given to a sidecar file.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'quota-tripwire.js'
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

function has(label, haystack, needle) {
    check(label, String(haystack).includes(needle),
        `${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 400))}`);
}

function hasnt(label, haystack, needle) {
    check(label, !String(haystack).includes(needle),
        `${JSON.stringify(needle)} unexpectedly present in ${JSON.stringify(String(haystack).slice(0, 400))}`);
}

function matches(label, haystack, re) {
    check(label, re.test(String(haystack)),
        `${re} did not match ${JSON.stringify(String(haystack).slice(0, 400))}`);
}

// ---------------------------------------------------------------------------
// Fixture machine
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-tripwire-'));
const FIXHOME = path.join(fixture, 'home');

const MIN = 60000;
// A fixed instant, so every projected timestamp in an expected string is a
// constant rather than something recomputed from the clock.
const BASE = Date.UTC(2026, 7, 21, 12, 0, 0);
const WSTART_ISO = '2026-08-19T01:59:00.000Z';
const WSTART = Date.parse(WSTART_ISO);

// The measured non-linear pair the script's ceiling maths is built around:
// 83% = $9,559 and 86% = $10,069. Delta slope $170/pt -> ceiling $12,449.
// The ABSOLUTE ratio would say $11,708, and several assertions below exist
// only to prove the script does not use it.
const CAL_A = { t: BASE - 40 * MIN, cost: 9559, pct: 83 };
const CAL_B = { t: BASE, cost: 10069, pct: 86 };
const CEILING = '$12,449';
const ABSOLUTE_RATIO = '$11,708';

// Does this machine's Intl carry the Europe/Bucharest offset? Node ships tz
// data, so this is true in practice - but a formatted-time assertion that can
// only run where the data exists must say so rather than fail elsewhere.
function tzAvailable() {
    try {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Bucharest', hour12: false, hour: '2-digit', minute: '2-digit',
        }).format(new Date(BASE)) === '15:00';
    } catch (e) { return false; }
}
const TZOK = tzAvailable();

function env(extra) {
    const e = Object.assign({}, process.env, { USERPROFILE: FIXHOME, HOME: FIXHOME });
    delete e.QUOTA_BURN_JS;
    return Object.assign(e, extra || {});
}

function run(args, extra, timeout) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(args), {
        encoding: 'utf8', env: env(extra), timeout: timeout || 15000,
    });
    return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let stateSeq = 0;
function statePath(name) {
    stateSeq++;
    return path.join(fixture, 'state-' + stateSeq + '-' + name + '.json');
}

function freshState(over) {
    return Object.assign({
        version: 1, windowStart: null, samples: [], calibration: [],
        ceiling: null, armed: true, firedAt: null, lastDiag: null,
    }, over || {});
}

function seed(name, over) {
    const p = statePath(name);
    fs.writeFileSync(p, JSON.stringify(freshState(over), null, 2), 'utf8');
    return p;
}

function readState(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// Total accessors. A mutant that stops the script writing a sample must make
// this suite print FAIL, never throw - a crash aborts every assertion after it
// and reports as one opaque red instead of naming what broke.
function field(p, k) { const st = readState(p); return st ? st[k] : '(no state file)'; }
function samples(p) { const st = readState(p); return st && Array.isArray(st.samples) ? st.samples : []; }
function sampleCost(p, i) { const s = samples(p)[i]; return s ? s.cost : '(no such sample)'; }
function calibration(p) { const st = readState(p); return st && Array.isArray(st.calibration) ? st.calibration : []; }

// One fixture-driven poll: exact cost, exact window id, exact wall clock.
function poll(sp, cost, nowMs, extra) {
    return run(['--once', '--state', sp,
        '--fixture-cost', String(cost),
        '--fixture-window', String(WSTART),
        '--fixture-now', String(nowMs)].concat(extra || []));
}

// ---- stubs standing in for quota-burn.js -----------------------------------

let stubSeq = 0;
function writeStub(body) {
    stubSeq++;
    const p = path.join(fixture, 'burn-' + stubSeq + '.js');
    fs.writeFileSync(p, body, 'utf8');
    return p;
}

// The contract stub. Refuses any argv but the documented one, and records what
// it was handed, so a change to how quota-burn.js is invoked is observable two
// separate ways: the recorded argv, and the reading failing outright.
const ARGV_LOG = path.join(fixture, 'burn-argv.txt');
function okStub(payload, logPath) {
    return writeStub([
        "'use strict';",
        'const fs = require("fs");',
        'const got = process.argv.slice(2).join(" ");',
        logPath ? 'fs.writeFileSync(' + JSON.stringify(logPath) + ', got, "utf8");' : '',
        'if (got !== "--json --days 0") { console.error("unexpected argv: " + got); process.exit(9); }',
        'process.stdout.write(' + JSON.stringify(JSON.stringify(payload)) + ');',
        '',
    ].filter(Boolean).join('\n'));
}

// Error stubs deliberately carry NO argv guard, so a failure they produce is
// attributable to the payload under test rather than to the invocation.
function rawStub(body) { return writeStub("'use strict';\n" + body + '\n'); }

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------

try {
    fs.mkdirSync(FIXHOME, { recursive: true });

    // =======================================================================
    // 1. CANNOT COMPUTE IS LOUD. This is the section the script exists for.
    //    Each case must produce a DIFFERENT stdout from the silent case, and
    //    must carry a machine-readable code plus the sentence that stops a
    //    reader treating quiet as headroom.
    // =======================================================================
    {
        const sp = seed('no-cal');                     // no calibration at all
        const r = poll(sp, 12000, BASE);
        eq('a report, never a gate: no ceiling still exits 0', r.status, 0);
        has('no calibration yields a DIAGNOSTIC, not silence', r.stdout, 'QUOTA TRIPWIRE DIAGNOSTIC');
        has('...carrying the no-ceiling code', r.stdout, 'code=no-ceiling');
        has('...naming how to fix it', r.stdout, 'run --calibrate <percent> twice');
        has('...and refusing to let quiet read as headroom',
            r.stdout, 'silence from this tripwire is NOT evidence of headroom');
        eq('...on stdout only, so a Monitor turns it into a notification', r.stderr, '');
        eq('a diagnostic is one line', r.stdout.trim().split('\n').length, 1);
    }
    {
        const sp = seed('one-cal', { calibration: [CAL_A] });
        const r = poll(sp, 12000, BASE);
        has('ONE calibration point is still no ceiling', r.stdout, 'code=no-ceiling');
        has('...and says how many it has', r.stdout, 'only 1 calibration point(s)');
    }
    {
        const sp = seed('degenerate', {
            calibration: [{ t: BASE - 10 * MIN, cost: 9559, pct: 86 }, { t: BASE, cost: 10069, pct: 86 }],
        });
        const r = poll(sp, 12000, BASE);
        has('two calibration points at the SAME percent cannot yield a slope',
            r.stdout, 'code=calibration-degenerate');
        has('...and prints both deltas', r.stdout, 'dPct=0.00');
    }
    {
        const sp = seed('first-poll', { calibration: [CAL_A, CAL_B] });
        const r = poll(sp, 12000, BASE);
        has('a ceiling but one cost sample cannot yield a rate',
            r.stdout, 'code=insufficient-samples');
        has('...and says a single reading is not a rate',
            r.stdout, 'a single reading cannot yield a rate');
        eq('...still exit 0', r.status, 0);
    }

    // =======================================================================
    // 2. SILENCE, and that it is distinguishable from every diagnostic above.
    // =======================================================================
    {
        const sp = seed('silent', { calibration: [CAL_A, CAL_B] });
        const first = poll(sp, 12000, BASE);
        has('poll 1 of a quiet window is a diagnostic', first.stdout, 'code=insufficient-samples');
        const r = poll(sp, 12010, BASE + 10 * MIN);   // $1/min, 2439 left => ~2439 min
        eq('measured and far from the ceiling emits ZERO bytes on stdout', r.stdout, '');
        eq('...and zero bytes on stderr', r.stderr, '');
        eq('...and exits 0', r.status, 0);
        eq('...while still recording the sample it measured', samples(sp).length, 2);
        eq('...and staying armed', field(sp, 'armed'), true);
    }

    // =======================================================================
    // 3. THE ALERT: fires on crossing, exactly once, and re-arms only when the
    //    burn has fallen well clear AND the cooldown has run out.
    // =======================================================================
    {
        const sp = seed('alert', { calibration: [CAL_A, CAL_B] });
        poll(sp, 12000, BASE);
        const a = poll(sp, 12100, BASE + 10 * MIN);   // $10/min, $349 left => 34.9 min

        has('crossing the threshold prints the handover line', a.stdout, 'QUOTA TRIPWIRE  PREP HANDOVER');
        eq('...as exactly one line', a.stdout.trim().split('\n').length, 1);
        eq('...on stderr nothing', a.stderr, '');
        eq('...exit 0, because the Monitor must keep polling', a.status, 0);
        has('the line leads with minutes remaining', a.stdout, '34 min to 100%');
        has('...then consumption against the derived ceiling',
            a.stdout, 'window $12,100 of ' + CEILING + ' ceiling (97.2%)');
        hasnt('...which is NOT the absolute-ratio ceiling', a.stdout, ABSOLUTE_RATIO);
        has('...then the burn rate and the span it was measured over',
            a.stdout, 'burn $10.0/min over 10 min (2 samples)');
        check('...then the projected exhaustion time in Bucharest',
            TZOK ? a.stdout.includes('exhausts ~2026-08-21 15:44 ')
                 : /exhausts ~\d{4}-\d\d-\d\d/.test(a.stdout),
            JSON.stringify(a.stdout.slice(0, 400)));
        has('...then the measure, so nobody has to guess what the dollars are',
            a.stdout, 'measure: list-price-equivalent window cost from quota-burn.js');
        has('...and where the ceiling came from',
            a.stdout, 'ceiling from delta calibration 3.0pt -> $170.0/pt, anchored at 86% = $10,069');

        eq('firing disarms', field(sp, 'armed'), false);
        eq('...and records when', field(sp, 'firedAt'), BASE + 10 * MIN);

        const b = poll(sp, 12200, BASE + 20 * MIN);   // still inside the band
        eq('a second crossing poll does NOT repeat the alert', b.stdout, '');
        eq('...silently', b.stderr, '');
        eq('...and stays disarmed', field(sp, 'armed'), false);
    }
    {
        const sp = seed('rearm', { calibration: [CAL_A, CAL_B] });
        poll(sp, 12000, BASE);
        const a = poll(sp, 12100, BASE + 10 * MIN);
        has('precondition: it fired', a.stdout, 'PREP HANDOVER');
        // 40 min later burn has collapsed: ~166 min out, and 40 min > 30 cooldown.
        const lull = poll(sp, 12104, BASE + 50 * MIN);
        eq('a well-clear, cooled-down poll is silent', lull.stdout, '');
        eq('...but re-arms', field(sp, 'armed'), true);
        eq('...and forgets the fire time', field(sp, 'firedAt'), null);
        const again = poll(sp, 12300, BASE + 60 * MIN);
        has('so a fresh crossing fires again', again.stdout, 'PREP HANDOVER');
        has('...with the numbers of THIS crossing, not the last one',
            again.stdout, '29 min to 100%');
        has('...over the widened sample span', again.stdout, '(4 samples)');
    }
    {
        // The cooldown alone must be able to block a re-arm. Both branches run
        // from an identical post-fire state, differing only in --cooldown-minutes,
        // so nothing but the cooldown can explain the difference.
        const sp = seed('cooldown', { calibration: [CAL_A, CAL_B] });
        poll(sp, 12000, BASE);
        poll(sp, 12100, BASE + 10 * MIN);
        const copy = statePath('cooldown-copy');
        fs.copyFileSync(sp, copy);

        const held = poll(sp, 12101, BASE + 35 * MIN);      // 120 min out: well clear
        eq('clear but only 25 min after firing stays silent', held.stdout, '');
        eq('...and stays disarmed - the cooldown is doing the work',
            field(sp, 'armed'), false);

        const cooled = poll(copy, 12101, BASE + 35 * MIN, ['--cooldown-minutes', '0']);
        eq('the identical poll with no cooldown re-arms', field(copy, 'armed'), true);
        eq('...and is equally silent either way', cooled.stdout, '');
    }
    {
        const sp = seed('past-ceiling', { calibration: [CAL_A, CAL_B] });
        poll(sp, 12500, BASE);
        const r = poll(sp, 12600, BASE + 10 * MIN);
        has('already past the ceiling fires at zero minutes', r.stdout, '0 min to 100%');
        has('...as an alert, not a diagnostic', r.stdout, 'PREP HANDOVER');
    }
    {
        const sp = seed('falling', { calibration: [CAL_A, CAL_B] });
        poll(sp, 12440, BASE);
        const r = poll(sp, 12430, BASE + 10 * MIN);   // $9 from the ceiling, but burning backwards
        eq('a falling cost projects to never, so no alert even $19 from the wall', r.stdout, '');
        eq('...and stays armed for a real crossing', field(sp, 'armed'), true);
    }
    {
        const sp = seed('flat', { calibration: [CAL_A, CAL_B] });
        poll(sp, 12400, BASE);
        const r = poll(sp, 12400, BASE + 10 * MIN);
        eq('zero burn is silent rather than an alert at $49 remaining', r.stdout, '');
    }

    // =======================================================================
    // 4. The options that decide WHEN it fires are actually read.
    // =======================================================================
    {
        const lo = seed('thresh-lo', { calibration: [CAL_A, CAL_B] });
        poll(lo, 12000, BASE);
        const under = poll(lo, 12100, BASE + 10 * MIN, ['--threshold-minutes', '20']);
        eq('34.9 min out is silent at a 20 min threshold', under.stdout, '');

        const hi = seed('thresh-hi', { calibration: [CAL_A, CAL_B] });
        poll(hi, 12000, BASE);
        const over = poll(hi, 12100, BASE + 10 * MIN, ['--threshold-minutes', '40']);
        has('the identical burn fires at a 40 min threshold', over.stdout, 'PREP HANDOVER');
    }
    {
        // Non-uniform burn: slow for 30 min, then a burst. The lookback window
        // is the only thing that decides whether the burst is visible.
        const wide = seed('lookback-wide', { calibration: [CAL_A, CAL_B] });
        poll(wide, 12000, BASE);
        poll(wide, 12030, BASE + 30 * MIN);
        const narrow = statePath('lookback-narrow');
        fs.copyFileSync(wide, narrow);

        const w = poll(wide, 12130, BASE + 40 * MIN);
        eq('a 60 min lookback averages the burst away and stays silent', w.stdout, '');
        const n = poll(narrow, 12130, BASE + 40 * MIN, ['--lookback-minutes', '15']);
        has('a 15 min lookback sees the burst and fires', n.stdout, 'PREP HANDOVER');
        has('...on the burst rate, not the average', n.stdout, 'over 10 min');
    }
    {
        const sp = seed('span', { calibration: [CAL_A, CAL_B] });
        poll(sp, 12000, BASE);
        const r = poll(sp, 12100, BASE + 10 * MIN, ['--min-span-minutes', '999']);
        has('samples spanning less than --min-span-minutes cannot yield a rate',
            r.stdout, 'code=span-too-short');
        has('...and it says the span it had', r.stdout, 'span 10.0 min, need 999');
    }
    {
        // Sample retention is max(lookback * 3, 180) minutes. Same seeded old
        // sample, two lookbacks, opposite outcomes.
        const old = { t: BASE - 200 * MIN, cost: 11000 };
        const a = seed('prune-default', { calibration: [CAL_A, CAL_B], samples: [old] });
        poll(a, 12000, BASE);
        eq('a 200 min old sample is pruned at the default 180 min horizon',
            samples(a).length, 1);
        const b = seed('prune-wide', { calibration: [CAL_A, CAL_B], samples: [old] });
        poll(b, 12000, BASE, ['--lookback-minutes', '120']);
        eq('...and kept when the lookback widens the horizon to 360 min',
            samples(b).length, 2);
    }

    // =======================================================================
    // 5. Window rollover. A new weekly window invalidates every sample, re-arms,
    //    and clears the diagnostic dedupe so a still-broken setup speaks again.
    // =======================================================================
    {
        const sp = seed('rollover', { calibration: [CAL_A, CAL_B] });
        poll(sp, 12000, BASE);
        poll(sp, 12100, BASE + 10 * MIN);
        eq('precondition: disarmed by the alert', field(sp, 'armed'), false);

        const r = run(['--once', '--state', sp,
            '--fixture-cost', '5',
            '--fixture-window', String(WSTART + 7 * 24 * 60 * MIN),
            '--fixture-now', String(BASE + 20 * MIN)]);
        has('a new window drops the old samples, so there is no rate yet',
            r.stdout, 'code=insufficient-samples');
        eq('...leaving exactly the one new sample', samples(sp).length, 1);
        eq('...re-armed', field(sp, 'armed'), true);
        eq('...with no fire on record', field(sp, 'firedAt'), null);
        eq('...and the new window recorded', field(sp, 'windowStart'), WSTART + 7 * 24 * 60 * MIN);
    }
    {
        // A rollover must also clear lastDiag, or a broken setup goes quiet
        // across the very boundary where someone is most likely to look.
        const sp = seed('rollover-diag', { calibration: [CAL_A] });
        const d1 = poll(sp, 100, BASE);
        has('precondition: no-ceiling printed once', d1.stdout, 'code=no-ceiling');
        const d2 = poll(sp, 101, BASE + 5 * MIN);
        eq('the same code five minutes later is suppressed', d2.stdout, '');
        const d3 = run(['--once', '--state', sp, '--fixture-cost', '102',
            '--fixture-window', String(WSTART + 7 * 24 * 60 * MIN),
            '--fixture-now', String(BASE + 10 * MIN)]);
        has('but a window rollover makes it speak again', d3.stdout, 'code=no-ceiling');
    }

    // =======================================================================
    // 6. Diagnostic dedupe: quiet, but keyed on the CODE and time-bounded.
    // =======================================================================
    {
        const sp = seed('dedupe', { calibration: [CAL_A] });
        const a = poll(sp, 100, BASE);
        has('first occurrence prints', a.stdout, 'code=no-ceiling');
        const b = poll(sp, 101, BASE + 59 * MIN);
        eq('a repeat inside the 60 min repeat window is suppressed', b.stdout, '');
        const c = poll(sp, 102, BASE + 61 * MIN);
        has('a repeat past it prints again', c.stdout, 'code=no-ceiling');
        const d = poll(sp, 103, BASE + 65 * MIN, ['--diag-repeat-minutes', '0']);
        has('--diag-repeat-minutes 0 disables suppression entirely', d.stdout, 'code=no-ceiling');
    }
    {
        // A DIFFERENT blocker must not inherit the previous one's suppression.
        const sp = seed('dedupe-code', { calibration: [CAL_A] });
        const a = poll(sp, 100, BASE);
        has('precondition: no-ceiling printed', a.stdout, 'code=no-ceiling');
        const st = readState(sp) || freshState();      // fixture surgery, not an assertion
        st.calibration.push(CAL_B);                    // ceiling now derivable
        fs.writeFileSync(sp, JSON.stringify(st), 'utf8');
        const b = poll(sp, 101, BASE + 5 * MIN, ['--min-span-minutes', '999']);
        has('a new code prints immediately despite the recent diagnostic',
            b.stdout, 'code=span-too-short');
        hasnt('...and is not the old code', b.stdout, 'no-ceiling');
    }

    // =======================================================================
    // 7. The source contract. Everything numeric comes from quota-burn.js, and
    //    every way that can fail is a distinct code rather than a silent zero.
    // =======================================================================
    {
        const stub = okStub({ windowCost: 12100, windowStart: WSTART_ISO, population: { files: 7 } }, ARGV_LOG);
        const sp = seed('src-ok', { calibration: [CAL_A, CAL_B] });
        const r = run(['--once', '--state', sp, '--source', stub]);
        eq('a healthy source exits 0', r.status, 0);
        eq('the invocation is exactly the documented one',
            fs.existsSync(ARGV_LOG) ? fs.readFileSync(ARGV_LOG, 'utf8') : '(no argv recorded)',
            '--json --days 0');
        eq('windowCost is read straight into the sample', sampleCost(sp, 0), 12100);
        eq('windowStart is parsed into the window id', field(sp, 'windowStart'), WSTART);
    }
    {
        // The full alert path driven by a real spawn of the source, with only
        // the prior sample seeded. A rename of windowCost upstream turns this
        // from an alert into a source-unparseable diagnostic.
        const stub = okStub({ windowCost: 12100, windowStart: WSTART_ISO });
        const now = Date.now();
        const sp = seed('src-alert', {
            calibration: [CAL_A, CAL_B], windowStart: WSTART,
            samples: [{ t: now - 30 * MIN, cost: 11800 }],
        });
        const a = run(['--once', '--state', sp, '--source', stub]);
        has('a reading from the real source can fire the alert', a.stdout, 'PREP HANDOVER');
        has('...against the calibrated ceiling',
            a.stdout, 'window $12,100 of ' + CEILING + ' ceiling (97.2%)');
        matches('...with a projection from the spawned reading', a.stdout, /\b3[45] min to 100%/);
        const b = run(['--once', '--state', sp, '--source', stub]);
        eq('and the second reading of the same cost does not repeat it', b.stdout, '');
    }
    {
        const missing = path.join(fixture, 'no-such-burn.js');
        const sp = seed('src-missing', { calibration: [CAL_A, CAL_B] });
        const r = run(['--once', '--state', sp, '--source', missing]);
        eq('a missing source still exits 0 so the loop survives', r.status, 0);
        has('...and reports source-missing', r.stdout, 'code=source-missing');
        has('...naming the path it looked at', r.stdout, missing);
        has('...and repeating that silence is not headroom',
            r.stdout, 'silence from this tripwire is NOT evidence of headroom');
    }
    {
        const stub = rawStub('console.error("boom"); process.exit(3);');
        const sp = seed('src-fail', { calibration: [CAL_A, CAL_B] });
        const r = run(['--once', '--state', sp, '--source', stub]);
        has('a source that exits nonzero is source-failed', r.stdout, 'code=source-failed');
        has('...carrying the exit status', r.stdout, 'exit 3');
        has('...and its stderr', r.stdout, 'boom');
    }
    {
        const stub = rawStub('console.log("not json at all");');
        const sp = seed('src-junk', { calibration: [CAL_A, CAL_B] });
        const r = run(['--once', '--state', sp, '--source', stub]);
        has('a source printing non-JSON is source-unparseable', r.stdout, 'code=source-unparseable');
        has('...and quotes what it got', r.stdout, 'stdout is not JSON: not json at all');
    }
    {
        const stub = rawStub('process.exit(0);');
        const sp = seed('src-empty', { calibration: [CAL_A, CAL_B] });
        const r = run(['--once', '--state', sp, '--source', stub]);
        has('a source printing nothing is unparseable, not a zero cost',
            r.stdout, 'no stdout from quota-burn.js');
        eq('...and no cost sample is invented', samples(sp).length, 0);
    }
    {
        const stub = rawStub('console.log(JSON.stringify({ windowStart: ' + JSON.stringify(WSTART_ISO) + ' }));');
        const sp = seed('src-nocost', { calibration: [CAL_A, CAL_B] });
        const r = run(['--once', '--state', sp, '--source', stub]);
        has('JSON without windowCost is a diagnostic', r.stdout, 'windowCost missing or not a number');
    }
    {
        const stub = rawStub('console.log(JSON.stringify({ windowCost: "12100", windowStart: ' + JSON.stringify(WSTART_ISO) + ' }));');
        const sp = seed('src-strcost', { calibration: [CAL_A, CAL_B] });
        const r = run(['--once', '--state', sp, '--source', stub]);
        has('a windowCost that is a string is rejected, not coerced',
            r.stdout, 'windowCost missing or not a number');
    }
    {
        const stub = rawStub('console.log(JSON.stringify({ windowCost: 12100, windowStart: "not-a-date" }));');
        const sp = seed('src-badwin', { calibration: [CAL_A, CAL_B] });
        const r = run(['--once', '--state', sp, '--source', stub]);
        has('an unparseable windowStart is a diagnostic', r.stdout, 'windowStart missing or unparseable');
    }
    {
        const stub = okStub({ windowCost: 4242, windowStart: WSTART_ISO });
        const sp = seed('src-env', { calibration: [CAL_A, CAL_B] });
        run(['--once', '--state', sp], { QUOTA_BURN_JS: stub });
        eq('QUOTA_BURN_JS overrides the default source location',
            sampleCost(sp, 0), 4242);
    }
    {
        // THE DEFAULT SOURCE IS NOW THE SHIPPED SIBLING.
        //
        // This used to assert the default was <home>/.claude/scripts/quota-burn.js.
        // [measured 2026-08-28] that file existed on no machine and in no repo, so
        // --status read `FAILED code=source-missing` and the tripwire could never
        // fire — while silence is this tripwire's success signal. The source now
        // ships beside the subject, and the sibling wins when it exists.
        //
        // The assertion is inverted rather than deleted: the old behaviour was a
        // real bug, and a suite that still demanded it would re-introduce it.
        const sp = seed('src-default');
        const r = run(['--once', '--state', sp]);
        hasnt('the default no longer points at the non-existent home path',
            r.stdout, path.join(FIXHOME, '.claude', 'scripts', 'quota-burn.js'));
        hasnt('...and therefore no longer reports source-missing by default',
            r.stdout, 'code=source-missing');
    }
    {
        // The legacy path is still honoured for anyone who already has one there:
        // remove the sibling and the old location must be found again. Without
        // this, "prefer the sibling" could have been implemented as "ignore the
        // home path entirely", and the fallback would be untested.
        const sp = seed('src-legacy');
        const shipped = path.join(path.dirname(SUBJECT), 'quota-burn.js');
        // Unique per run: a fixed stash name could silently replace a
        // preserved original left by an earlier failed run on POSIX.
        const stash = shipped + '.suite-stashed-' + process.pid + '-' + Date.now();
        let moved = false;
        try { fs.renameSync(shipped, stash); moved = true; } catch { /* not present */ }
        try {
            const r = run(['--once', '--state', sp]);
            has('with the sibling absent it falls back to the home path',
                r.stdout, path.join(FIXHOME, '.claude', 'scripts', 'quota-burn.js'));
            has('...and reports the miss rather than assuming zero', r.stdout, 'code=source-missing');
        } finally {
            // link() refuses EEXIST, so a file recreated at the shipped path
            // while it was stashed survives instead of being replaced.
            if (moved) {
                try { fs.linkSync(stash, shipped); fs.unlinkSync(stash); }
                catch (e) {
                    console.error('NOT RESTORED: ' + shipped + ' was recreated while stashed ('
                        + (e.code || e.message) + '); the original is kept at ' + stash);
                    process.exitCode = 2;
                }
            }
        }
    }

    // =======================================================================
    // 8. State: the default location, and what happens when it cannot be written.
    // =======================================================================
    {
        const dflt = path.join(FIXHOME, '.claude', 'quota-tripwire-state.json');
        eq('precondition: the default state file does not exist yet', fs.existsSync(dflt), false);
        run(['--once', '--fixture-cost', '1', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE)]);
        eq('the default state file is created under the home directory',
            fs.existsSync(dflt), true);
        eq('...and holds the reading', sampleCost(dflt, 0), 1);
    }
    {
        // A state file that cannot be written means fire-once cannot be
        // guaranteed. That is louder than firing repeatedly.
        const blocker = path.join(fixture, 'not-a-dir.txt');
        fs.writeFileSync(blocker, 'x', 'utf8');
        const r = run(['--once', '--state', path.join(blocker, 'state.json'),
            '--fixture-cost', '1', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE)]);
        has('an unwritable state path is its own diagnostic', r.stdout, 'code=state-unwritable');
        has('...saying exactly what is lost', r.stdout, 'fire-once cannot be guaranteed');
        hasnt('...and it replaces the ordinary diagnostic rather than doubling up',
            r.stdout, 'code=no-ceiling');
        eq('...still exit 0', r.status, 0);
    }

    // =======================================================================
    // 9. --calibrate: the only way a ceiling exists, and the delta-slope maths
    //    that keeps it from being the absolute ratio.
    // =======================================================================
    {
        const sp = statePath('cal-bad');
        const r = run(['--calibrate', '--state', sp]);
        eq('--calibrate with no percentage exits 2', r.status, 2);
        has('...telling you what it wants', r.stderr, 'needs the percentage the app is showing');
        eq('...and prints nothing to stdout', r.stdout, '');
        eq('...and writes no state', fs.existsSync(sp), false);
    }
    {
        eq('--calibrate 0 is rejected', run(['--calibrate', '0', '--state', statePath('c0')]).status, 2);
        eq('--calibrate 101 is rejected', run(['--calibrate', '101', '--state', statePath('c101')]).status, 2);
    }
    {
        const sp = statePath('cal');
        const a = run(['--calibrate', '83', '--state', sp,
            '--fixture-cost', '9559', '--fixture-now', String(BASE - 40 * MIN)]);
        eq('a valid calibration exits 0', a.status, 0);
        has('...echoing the pair it recorded', a.stdout, 'calibrated: 83% = $9,559 at ');
        has('...and saying a ceiling is not possible yet', a.stdout, 'no ceiling yet:');
        eq('...with one point on disk', calibration(sp).length, 1);

        const b = run(['--calibrate', '86', '--state', sp,
            '--fixture-cost', '10069', '--fixture-now', String(BASE)]);
        has('the second point produces a ceiling', b.stdout, 'ceiling now ' + CEILING);
        has('...from the DELTA slope', b.stdout, 'delta calibration 3.0pt -> $170.0/pt');
        has('...anchored at the newer point', b.stdout, 'anchored at 86% = $10,069');
        hasnt('...and never the absolute ratio', b.stdout, ABSOLUTE_RATIO);

        // With a ceiling on disk, an ordinary poll stops saying no-ceiling.
        const p1 = poll(sp, 12000, BASE + MIN);
        has('a calibrated state moves the blocker on to the rate',
            p1.stdout, 'code=insufficient-samples');
        const p2 = poll(sp, 12100, BASE + 11 * MIN);
        has('...and then fires against the calibrated ceiling',
            p2.stdout, 'of ' + CEILING + ' ceiling');

        const c = run(['--calibrate', '86', '--state', sp,
            '--fixture-cost', '10200', '--fixture-now', String(BASE + 20 * MIN)]);
        has('a repeat percentage leaves the ceiling underivable',
            c.stdout, 'no ceiling yet: last two calibration points do not both increase');
    }
    {
        const sp = seed('cal-cap', {
            calibration: Array.from({ length: 20 }, (_, i) => ({ t: BASE + i * MIN, cost: 100 + i, pct: i + 1 })),
        });
        run(['--calibrate', '30', '--state', sp,
            '--fixture-cost', '999', '--fixture-now', String(BASE + 30 * MIN)]);
        const cal = calibration(sp);
        eq('the calibration log is capped at 20 points', cal.length, 20);
        eq('...dropping the oldest', cal[0] && cal[0].pct, 2);
        eq('...and keeping the newest', cal.length ? cal[cal.length - 1].pct : null, 30);
    }
    {
        const sp = statePath('cal-src');
        const r = run(['--calibrate', '90', '--state', sp,
            '--source', path.join(fixture, 'nope.js')]);
        eq('calibrating against a broken source exits 1', r.status, 1);
        has('...with the diagnostic on stderr', r.stderr, 'code=source-missing');
        eq('...and nothing on stdout', r.stdout, '');
        eq('...and no half-written calibration', fs.existsSync(sp), false);
    }

    // =======================================================================
    // 10. --status: the human readout. It must never be silent about a broken
    //     source either, and it must not mutate state.
    // =======================================================================
    {
        const sp = seed('status', {
            calibration: [CAL_A, CAL_B], windowStart: WSTART,
            samples: [{ t: BASE - 30 * MIN, cost: 11800 }],
        });
        const r = run(['--status', '--state', sp, '--source', path.join(fixture, 'irrelevant.js'),
            '--fixture-cost', '12100', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE)]);
        eq('--status exits 0', r.status, 0);
        has('it names the state file', r.stdout, 'state file : ' + sp);
        has('it names the source', r.stdout, 'source     : ' + path.join(fixture, 'irrelevant.js'));
        has('it states the measure', r.stdout,
            'measure    : list-price-equivalent window cost from quota-burn.js (--json --days 0)');
        has('it prints the thresholds in force', r.stdout,
            'threshold  : 50 min   interval 5 min   lookback 60 min');
        has('it prints the reading', r.stdout, 'reading    : $12,100  window opened ');
        check('...with the window opening time in Bucharest',
            TZOK ? r.stdout.includes('window opened 2026-08-19 04:59 ')
                 : /window opened \d{4}-\d\d-\d\d/.test(r.stdout),
            JSON.stringify(r.stdout.slice(0, 400)));
        has('it counts what it has', r.stdout, 'samples    : 1   calibration points: 2');
        has('it says whether it is armed', r.stdout, 'armed      : true');
        has('it prints the ceiling and its basis', r.stdout, 'ceiling    : ' + CEILING + '  (delta calibration');
        has('it prints the rate over its span', r.stdout, 'rate       : $10.0/min over 30.0 min (2 samples)');
        has('it prints the projection', r.stdout, 'projection : 34 min -> ');
        check('...as a wall-clock time, not a duration',
            TZOK ? r.stdout.includes('projection : 34 min -> 2026-08-21 15:34 ')
                 : /projection : 34 min -> \d{4}-/.test(r.stdout),
            JSON.stringify(r.stdout.slice(0, 600)));
        eq('--status does not record a sample', samples(sp).length, 1);
    }
    {
        const sp = seed('status-flat', {
            calibration: [CAL_A, CAL_B], windowStart: WSTART,
            samples: [{ t: BASE - 30 * MIN, cost: 12100 }],
        });
        const r = run(['--status', '--state', sp,
            '--fixture-cost', '12100', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE)]);
        has('a flat window projects to no exhaustion at all',
            r.stdout, 'projection : not burning at present');
    }
    {
        const sp = statePath('status-fresh');
        const r = run(['--status', '--state', sp,
            '--fixture-cost', '12100', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE)]);
        has('with no calibration the ceiling line says NONE', r.stdout, 'ceiling    : NONE - ');
        hasnt('...and it stops there rather than printing a rate', r.stdout, 'rate       :');
        eq('...and creates no state file', fs.existsSync(sp), false);
    }
    {
        const sp = seed('status-onesample', { calibration: [CAL_A, CAL_B] });
        const r = run(['--status', '--state', sp,
            '--fixture-cost', '12100', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE)]);
        has('one sample means no rate', r.stdout, 'rate       : NONE - have 1 sample(s)');
        hasnt('...and no projection', r.stdout, 'projection :');
    }
    {
        const sp = seed('status-broken', { calibration: [CAL_A, CAL_B] });
        const r = run(['--status', '--state', sp, '--source', path.join(fixture, 'gone.js')]);
        eq('--status with a broken source still exits 0', r.status, 0);
        has('...and says the reading failed, with the code', r.stdout, 'reading    : FAILED  code=source-missing');
        hasnt('...rather than printing a ceiling it cannot stand behind', r.stdout, 'ceiling    :');
    }

    // =======================================================================
    // 11. --reset: clears samples and re-arms, KEEPS calibration and any
    //     explicit ceiling. Losing calibration would silently disable the
    //     tripwire until someone calibrated twice again.
    // =======================================================================
    {
        const sp = seed('reset', {
            calibration: [CAL_A, CAL_B], windowStart: WSTART, armed: false,
            firedAt: BASE, samples: [{ t: BASE, cost: 1 }, { t: BASE + MIN, cost: 2 }],
            lastDiag: { code: 'no-ceiling', t: BASE },
        });
        const r = run(['--reset', '--state', sp]);
        eq('--reset exits 0', r.status, 0);
        has('...and says what it kept', r.stdout, 'reset: samples cleared, re-armed, calibration kept (2 points)');
        eq('samples are cleared', samples(sp).length, 0);
        eq('it is re-armed', field(sp, 'armed'), true);
        eq('the fire record is cleared', field(sp, 'firedAt'), null);
        eq('the diagnostic dedupe is cleared', field(sp, 'lastDiag'), null);
        eq('calibration survives', calibration(sp).length, 2);

        poll(sp, 12000, BASE + 100 * MIN);
        const again = poll(sp, 12100, BASE + 110 * MIN);
        has('so a crossing after a reset fires again', again.stdout, 'PREP HANDOVER');
    }
    {
        const sp = seed('reset-ceiling', { ceiling: 20000, armed: false });
        run(['--reset', '--state', sp]);
        eq('an explicit ceiling survives a reset', field(sp, 'ceiling'), 20000);
    }

    // =======================================================================
    // 12. --ceiling: an explicit override, persisted, replacing calibration.
    // =======================================================================
    {
        const sp = statePath('explicit');
        const a = run(['--once', '--state', sp, '--ceiling', '20000',
            '--fixture-cost', '19800', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE)]);
        has('an explicit ceiling removes the no-ceiling blocker',
            a.stdout, 'code=insufficient-samples');
        hasnt('...entirely', a.stdout, 'no-ceiling');
        eq('...and is written to state so later runs inherit it', field(sp, 'ceiling'), 20000);

        const b = run(['--once', '--state', sp,
            '--fixture-cost', '19900', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE + 10 * MIN)]);
        has('a later run with no flag still has the ceiling and fires',
            b.stdout, 'of $20,000 ceiling');
        has('...naming the explicit basis rather than a calibration',
            b.stdout, 'ceiling from explicit ceiling $20,000');
        has('...with the projection it implies', b.stdout, '10 min to 100%');

        const c = run(['--status', '--state', sp,
            '--fixture-cost', '19900', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE + 10 * MIN)]);
        has('--status reports the explicit basis too',
            c.stdout, 'ceiling    : $20,000  (explicit ceiling $20,000)');
    }

    // =======================================================================
    // 13. --once is what makes it exit. Without it, this is a poll loop that a
    //     Monitor holds open; an early exit would silently end the watch.
    // =======================================================================
    {
        const sp = statePath('loop');
        const r = run(['--state', sp, '--interval-minutes', '5',
            '--fixture-cost', '1', '--fixture-window', String(WSTART),
            '--fixture-now', String(BASE)], null, 2500);
        check('without --once the process keeps polling rather than exiting',
            r.status !== 0, `exited cleanly with status ${r.status}, signal ${r.signal}`);
    }

    // =======================================================================
    // 14. The script's own selftest is wired into this gate, so a regression in
    //     the policy it covers is a red suite here rather than a check nobody
    //     remembers to run.
    // =======================================================================
    {
        const r = run(['--selftest']);
        eq('--selftest exits 0', r.status, 0);
        const m = /population: (\d+) assertions run, (\d+) passed, (\d+) failed/.exec(r.stdout);
        check('--selftest prints the population it ran', !!m, JSON.stringify(r.stdout.slice(-300)));
        eq('...with nothing failing', m && m[3], '0');
        eq('...and every assertion accounted for', m && m[1], m && m[2]);
        check('...over a non-trivial number of cases', !!m && Number(m[1]) >= 17,
            m ? 'only ' + m[1] : 'no population line');
    }

} finally {
    try {
        fs.rmSync(fixture, { recursive: true, force: true });
    } catch (e) {
        sleep(300);
        try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (e2) { /* temp dir */ }
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
// Precedence 2 -> 1 -> 0: an infrastructure problem outranks assertion
// failures, because a run that could not maintain its own sandbox is
// indeterminate, not red (Sol round-19).
process.exit(process.exitCode === 2 ? 2 : (fail > 0 ? 1 : 0));
