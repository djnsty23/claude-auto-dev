#!/usr/bin/env node
'use strict';

// Tests for scripts/away-state.js — the declared AWAY state, four readings.
// Run: node tooling/test-away-state.js
//
// THE ASSERTION THAT MATTERS MOST is that the four states do not collapse into
// two. Three of them mean "the operator can be asked" and only `active` licenses
// self-resolution, so a bug that folds `malformed` into `active` hands a session
// permission nobody granted, and one that folds `active` into `expired` stops the
// fleet. Both readings look reasonable in isolation; only a test that checks the
// STATE NAME as well as `canAsk` can tell them apart, so every case asserts both.
//
// TWO TIME BASES LIVE IN THIS FILE AND A FIXTURE MUST MATCH THE ONE THAT READS IT.
//
// `readAwayState({ now })` cases inject the clock, so their fixtures carry
// ABSOLUTE instants and are deterministic forever. The cases that spawn the real
// binary cannot inject anything, so they read the WALL CLOCK, and their fixtures
// are built RELATIVE to `Date.now()`.
//
// `[measured 2026-09-02 22:31Z]` this file shipped with one fixture serving both,
// and the absolute `until: 2026-09-02T22:00:00Z` labelled "the FUTURE" expired at
// 22:00:00Z. 22 cases passed and 1 failed, the only one asking the clock, and it
// turned the trunk gate red for the whole fleet about thirty minutes later.
//
// The header this replaces made the failure harder to see rather than easier. It
// said every time-dependent case injects `now`, then enumerated the two
// exceptions it knew about, so it read as an audit that had been done. The audit
// was real and it was incomplete: it looked at `readAwayState` callers and never
// at the `spawnSync` ones, which are the only cases that CANNOT inject. A stated
// exhaustive list is worse than no list when it is short by a category, because
// the next reader checks the list instead of the file.
//
// So the rule, not the inventory: a fixture is pinned to the time base of its
// CONSUMER. If a case can inject `now`, use an absolute instant. If it spawns,
// derive the value from `Date.now()` so it cannot expire.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify, reason, runBudgeted, tally, exitCode } = require('./spawn-budget.js');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'away-state.js');
const { readAwayState } = require(SUBJECT);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'away-'));
const NOW = new Date('2026-09-02T18:00:00Z');

let pass = 0;
let fail = 0;
let infra = 0;
const failures = [];
const indeterminate = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

function write(name, body) {
    const p = path.join(fixture, name);
    fs.writeFileSync(p, body);
    return p;
}

/** Assert BOTH the state name and the licence it grants. */
function expectState(label, file, state, canAsk, extra) {
    const s = readAwayState({ file, now: NOW });
    const ok = s.state === state && s.canAsk === canAsk && (!extra || extra(s));
    check(label, ok, `state=${s.state} canAsk=${s.canAsk}${s.reason ? ` reason="${s.reason.slice(0, 60)}"` : ''}`);
    return s;
}

// --- the four states ------------------------------------------------------

expectState('an until-time in the FUTURE is active, and only it may self-resolve',
    write('active.md', '# AWAY\n\nuntil: 2026-09-02T22:00:00Z\n\nback around ten, self-resolve reversible things\n'),
    'active', false, (s) => s.msRemaining === 4 * 3600 * 1000);

expectState('an until-time in the PAST is expired, and the operator can be asked',
    write('expired.md', '# AWAY\n\nuntil: 2026-09-02T09:00:00Z\n\nmorning window\n'),
    'expired', true, (s) => s.msRemaining < 0);

expectState('no file at all is absent, not malformed',
    path.join(fixture, 'nope.md'), 'absent', true, (s) => s.reason === null);

expectState('a file with no until line is malformed, and says why',
    write('nountil.md', '# AWAY\n\nstepping out\n'),
    'malformed', true, (s) => /no `until:` line/.test(s.reason));

expectState('an unparseable until is malformed, and quotes the value back',
    write('garbage.md', '# AWAY\n\nuntil: banana\n'),
    'malformed', true, (s) => /banana/.test(s.reason));

// The one an hour wide. Date.parse reads a bare instant as LOCAL time, so the
// same file means different things on two machines — and that ambiguity is the
// width of a short away window. Refusing beats picking one.
expectState('an until with NO TIMEZONE is malformed rather than guessed',
    write('notz.md', '# AWAY\n\nuntil: 2026-09-02T22:00:00\n'),
    'malformed', true, (s) => /no timezone/.test(s.reason));

expectState('an explicit offset is accepted, not only Z',
    write('offset.md', '# AWAY\n\nuntil: 2026-09-02T22:00:00+03:00\n'),
    'active', false);

// --- the boundary ---------------------------------------------------------
// Exactly-now must not be active. An away window that has just closed is over,
// and `>` rather than `>=` is the difference between asking and self-resolving
// on the one call that lands on the second.
expectState('an until-time equal to NOW is expired, not active',
    write('boundary.md', '# AWAY\n\nuntil: 2026-09-02T18:00:00Z\n'),
    'expired', true, (s) => s.msRemaining === 0);
expectState('one second later is active',
    write('boundary2.md', '# AWAY\n\nuntil: 2026-09-02T18:00:01Z\n'),
    'active', false);

// --- shape of the file ----------------------------------------------------
// The operator's words are carried verbatim and must not have to be escaped or
// fenced to be safe. A file whose prose happens to contain the word "until" is
// the obvious way a lenient parser goes wrong.
{
    const s = expectState('prose mentioning "until" does not become the until-time',
        write('prose.md', '# AWAY\n\nuntil: 2026-09-02T22:00:00Z\n\n'
            + 'do not wait until I am back; self-resolve anything reversible\n'),
        'active', false);
    const ok = s.until === '2026-09-02T22:00:00Z'
        && /do not wait until I am back/.test(s.words)
        && !/^until:/m.test(s.words);
    check('  the words are carried verbatim, and the until line is not among them', ok,
        `until=${s.until} words=${JSON.stringify(s.words.slice(0, 50))}`);
}
expectState('a leading list dash on the until line is tolerated',
    write('dash.md', '# AWAY\n\n- until: 2026-09-02T22:00:00Z\n'), 'active', false);
expectState('case and spacing on the key are tolerated',
    write('loose.md', '# AWAY\n\nUNTIL :   2026-09-02T22:00:00Z\n'), 'active', false);

// A directory where a file should be: readable-failure, not absent. "I could
// not read it" and "it is not there" are different facts and only one is normal.
{
    const d = path.join(fixture, 'adir.md');
    fs.mkdirSync(d);
    expectState('a path that is a DIRECTORY is malformed, not absent', d,
        'malformed', true, (s) => /could not read/.test(s.reason));
}

// --- it must never throw --------------------------------------------------
// A reader that throws takes down whichever hook required it. Every unhappy
// path has a defined reading, so there is no input that should escape as an
// exception — including the ones a caller gets wrong.
for (const [label, arg] of [
    ['undefined opts', undefined],
    ['an empty object', {}],
    ['a null file', { file: null }],
    ['a numeric file', { file: 42 }],
    ['a bogus now', { file: path.join(fixture, 'active.md'), now: 'not a date' }],
]) {
    let threw = null;
    let out = null;
    try { out = readAwayState(arg); } catch (e) { threw = e; }
    check(`readAwayState does not throw on ${label}`, !threw && out && typeof out.state === 'string',
        threw ? `threw ${threw.message}` : `state=${out && out.state}`);
}

// --- the CLI --------------------------------------------------------------
// check-entrypoints probes every plugins/*/scripts/*.js with --help, stdin
// closed, under a 10s budget. And a state nobody can print is one nobody can
// debug, so --status has to name the file it read: "no away window" and
// "looked at the wrong path" are otherwise identical output.
//
// A child that produced no verdict is INFRASTRUCTURE, not a finding about
// away-state.js. Measured 2026-09-08 by forcing a subject spawn to come back
// `status=null signal=SIGTERM ETIMEDOUT`: this suite printed
// `FAIL  --help returns 0 with usage, inside the entrypoint budget (exit null, 0ms)`
// and exited 1, which is a claim about the subject the run had no evidence for.
//
// Three of these four spawns carried NO budget before this change. An unbudgeted
// spawn cannot produce that false red -- but it can hang the whole gate forever,
// so they are bounded here too: a bounded indeterminate beats an unbounded wait.
function cli(args, over = {}) {
    const r = runBudgeted(process.execPath, [SUBJECT].concat(args), Object.assign({
        input: '', encoding: 'utf8', timeout: 15000,
        // Contention is clamped at 20, so cap the widened retry rather than let
        // one stuck child hold `npm test` for five minutes.
        maxTimeout: 120000,
    }, over));
    if (classify(r) === 'infrastructure') {
        infra++;
        const what = 'the subject run ' + JSON.stringify(args);
        indeterminate.push(what + ' (' + reason(r) + ')');
        console.error('infrastructure: ' + what + ' produced no verdict (' + reason(r)
            + '; ' + r.attempts + ' attempt(s), budget ' + r.budgetMs + 'ms)');
    }
    return r;
}

{
    const t0 = Date.now();
    const r = cli(['--help']);
    const ms = Date.now() - t0;
    // THE TIMING HALF IS ONLY MEASURABLE ON A SINGLE-ATTEMPT RUN. `ms` spans
    // every attempt plus the contention probe between them, so on a retried run
    // it is guaranteed to exceed the budget that provoked the retry and would
    // fail this assertion for the one reason it must not: the machine was busy.
    // A retry means the timing question could not be measured, not that the
    // answer was no.
    if (r.attempts > 1) {
        infra++;
        indeterminate.push('--help timing (the run retried, so the wall clock spans a killed attempt)');
        console.error('infrastructure: --help timing not measurable (' + r.attempts
            + ' attempt(s), ' + ms + 'ms spans a killed attempt)');
    } else {
        check('--help returns 0 with usage, inside the entrypoint budget',
            r.status === 0 && (r.stdout || '').length > 0 && ms < 10000, `exit ${r.status}, ${ms}ms`);
    }
}
{
    // WALL-CLOCK FIXTURE, RELATIVE ON PURPOSE. This case spawns the real binary,
    // which reads the actual clock, so an absolute `until` here is a timer rather
    // than a fixture.
    //
    // `[measured 2026-09-02 22:31Z]` it fired. `active.md` was planted with
    // `until: 2026-09-02T22:00:00Z` and labelled "the FUTURE", which it was when
    // written and stopped being at 22:00:00Z. Every `expectState` case survived,
    // because those inject `now`; only this one broke, because only this one asks
    // the clock. One fixture, two consumers, one time base pinned.
    //
    // 22c-i inverted. That rule says a planted NEGATIVE must be impossible by
    // construction rather than merely absent from a list. Here a planted POSITIVE
    // decayed into a negative by construction of time: an "active" window built
    // from an absolute instant is guaranteed to expire, and only the date is in
    // question. The cure is the same one, derive the planted value FROM the thing
    // under test, so `Date.now() + 4h` cannot expire no matter when it runs.
    const soon = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
    const f = write('cli-active.md', `# AWAY\n\nuntil: ${soon}\n\nrelative, so it cannot expire\n`);
    const r = cli(['--status', '--file', f]);
    const ok = r.status === 0 && r.stdout.includes(f) && /SELF-RESOLVE/.test(r.stdout);
    check('--status names the file it read, and says which licence the state grants', ok,
        `exit ${r.status}, stdout ${JSON.stringify((r.stdout || '').split('\n')[0].slice(0, 70))}`);
}
{
    const r = cli(['--json', '--file', path.join(fixture, 'nope.md')]);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
    check('--json emits parseable JSON carrying the state', r.status === 0 && parsed && parsed.state === 'absent',
        `exit ${r.status}, state=${parsed && parsed.state}`);
}
// The env override, because the hook that will consume this needs it to be
// testable without touching the operator's real away file.
{
    const r = cli(['--json'], {
        // Relative for the same reason as the case above. A past instant only
        // gets more past, so `expired.md` is safe by luck rather than by design,
        // and copying a construction that is safe by luck is how the active one
        // got written. Both wall-clock fixtures are now relative.
        env: {
            ...process.env,
            AUTODEV_AWAY_FILE: write('cli-expired.md',
                `# AWAY\n\nuntil: ${new Date(Date.now() - 3600 * 1000).toISOString()}\n\nclosed an hour ago\n`),
        },
    });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
    check('AUTODEV_AWAY_FILE redirects the default path', parsed && parsed.state === 'expired',
        `state=${parsed && parsed.state}`);
}

// The pipe delivers every byte.
//
// node's process.stdout is ASYNCHRONOUS when it is a pipe on darwin and
// synchronous when it is a pipe on linux/win32, and process.exit() does not
// drain a pending async write. A run that prints past the 64KiB OS pipe buffer
// and then exits hands its caller exactly 65536 bytes under exit status 0 — the
// shape rendered-layout-gate.js shipped with until 2026-09-07.
//
// This file's `words` field is the operator's own prose, uncapped, so --json is
// as large as AWAY.md is. That is why the defect is reachable here at all: the
// verdict object is a few hundred bytes and the prose beside it is not.
//
// TWO ASSERTIONS, and the first is what stops the second passing by
// construction: the output must EXCEED one pipe buffer, and the piped byte count
// must equal the same run redirected to a FILE, where the write is synchronous
// on every platform.
{
    const PIPE_BUF = 64 * 1024;
    const soon = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
    const long = [];
    for (let i = 0; i < 1200; i++) {
        long.push('line ' + i + ' of a long away note, the kind someone writes when they '
            + 'are handing over a week of context before going offline.');
    }
    const bigFile = write('cli-big.md', `# AWAY\n\nuntil: ${soon}\n\n${long.join('\n')}\n`);

    // Spawned through runBudgeted, not raw spawnSync: #183 replaced every
    // unbudgeted child in tooling/ because a timeout under concurrent load was
    // being recorded as a verdict. Both legs share one budget, so the pipe and
    // the file are never compared across different amounts of patience.
    const budgetedSpawn = (argv, opts) => runBudgeted(process.execPath, argv,
        Object.assign({ timeout: 60000, maxTimeout: 180000 }, opts));

    const viaFileBytes = (extra) => {
        const out = path.join(fixture, 'via-file.out');
        const fd = fs.openSync(out, 'w');
        budgetedSpawn( [SUBJECT, '--file', bigFile].concat(extra),
            { stdio: ['ignore', fd, 'ignore'] });
        fs.closeSync(fd);
        return fs.statSync(out).size;
    };

    const pipeRun = budgetedSpawn( [SUBJECT, '--json', '--file', bigFile],
        { input: '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const pipeBytes = Buffer.byteLength(pipeRun.stdout, 'utf8');
    const fileBytes = viaFileBytes(['--json']);

    check('--json over a long away note exceeds one pipe buffer, so the next check is not vacuous',
        fileBytes > PIPE_BUF, JSON.stringify({ bytes: fileBytes, buffer: PIPE_BUF }));
    check('  and through a PIPE it delivers every byte it writes to a FILE',
        pipeBytes === fileBytes, JSON.stringify({ pipe: pipeBytes, file: fileBytes }));
    let bigParsed = null;
    try { bigParsed = JSON.parse(pipeRun.stdout); } catch { /* reported */ }
    check('  and the piped JSON still parses at that size, under exit 0',
        bigParsed !== null && bigParsed.state === 'active' && pipeRun.status === 0,
        `exit ${pipeRun.status}, tail ${JSON.stringify(pipeRun.stdout.slice(-40))}`);

    // --status caps the operator's words at one line of 100 chars, so it cannot
    // be driven over the buffer from a fixture at all. It shares the exit path,
    // so it gets the equality on its own; THIS ONE LINE CANNOT CATCH THE
    // REGRESSION, and is here to state the equality rather than to prove it.
    const statusPipe = budgetedSpawn( [SUBJECT, '--status', '--file', bigFile],
        { input: '', encoding: 'utf8' });
    check('  --status also delivers every byte, though it stays under the buffer',
        Buffer.byteLength(statusPipe.stdout, 'utf8') === viaFileBytes(['--status']),
        Buffer.byteLength(statusPipe.stdout, 'utf8'));
}

fs.rmSync(fixture, { recursive: true, force: true });

console.log(`\n${tally(pass, fail, infra)}`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), SUBJECT)}; `
    + `4 states exercised (active, expired, absent, malformed) over ${pass + fail} cases, `
    + 'every one asserting the state NAME and the licence it grants, never just one.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
process.exit(exitCode(fail, infra));
