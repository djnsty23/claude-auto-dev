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
// Every case whose ASSERTION depends on time injects `now`, so none of them can
// go red on their own one day. Two cases deliberately do not — the "does not
// throw" pair that exercises a bogus `now` and a null `file`, which fall back to
// the real clock and the real default path on purpose. Their assertion is only
// "it returned a state and did not throw", so what that state happens to be
// cannot flip them. Said explicitly because "time is injected" would have been
// the tidier sentence and the false one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'away-state.js');
const { readAwayState } = require(SUBJECT);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'away-'));
const NOW = new Date('2026-09-02T18:00:00Z');

let pass = 0;
let fail = 0;
const failures = [];
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
{
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [SUBJECT, '--help'], { input: '', encoding: 'utf8', timeout: 15000 });
    const ms = Date.now() - t0;
    check('--help returns 0 with usage, inside the entrypoint budget',
        r.status === 0 && (r.stdout || '').length > 0 && ms < 10000, `exit ${r.status}, ${ms}ms`);
}
{
    // The cases above inject NOW, so they are deterministic. This one spawns
    // the real CLI, which reads the real clock, so an ABSOLUTE until-time in
    // the fixture rots the instant it passes. It did: the shared active.md is
    // fixed at 2026-09-02T22:00:00Z, so from 2026-09-03 this assertion read
    // EXPIRED and could never match the active licence it checks for. One
    // assertion in a 23-case suite depended on the wall clock, and it was the
    // only one not given an injected now.
    //
    // Derive the planted value FROM the thing under test instead, per 22c-i:
    // a value that is only accidentally in the future decays into a false
    // alarm, and this one did.
    const f = write(
        'active-cli.md',
        '# AWAY\n\nuntil: ' +
            new Date(Date.now() + 4 * 3600 * 1000).toISOString() +
            '\n\nback around ten, self-resolve reversible things\n',
    );
    const r = spawnSync(process.execPath, [SUBJECT, '--status', '--file', f], { input: '', encoding: 'utf8' });
    const ok = r.status === 0 && r.stdout.includes(f) && /SELF-RESOLVE/.test(r.stdout);
    check('--status names the file it read, and says which licence the state grants', ok,
        `exit ${r.status}, stdout ${JSON.stringify((r.stdout || '').split('\n')[0].slice(0, 70))}`);
}
{
    const r = spawnSync(process.execPath, [SUBJECT, '--json', '--file', path.join(fixture, 'nope.md')],
        { input: '', encoding: 'utf8' });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
    check('--json emits parseable JSON carrying the state', r.status === 0 && parsed && parsed.state === 'absent',
        `exit ${r.status}, state=${parsed && parsed.state}`);
}
// The env override, because the hook that will consume this needs it to be
// testable without touching the operator's real away file.
{
    const r = spawnSync(process.execPath, [SUBJECT, '--json'], {
        input: '',
        encoding: 'utf8',
        env: { ...process.env, AUTODEV_AWAY_FILE: path.join(fixture, 'expired.md') },
    });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
    check('AUTODEV_AWAY_FILE redirects the default path', parsed && parsed.state === 'expired',
        `state=${parsed && parsed.state}`);
}

fs.rmSync(fixture, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), SUBJECT)}; `
    + `4 states exercised (active, expired, absent, malformed) over ${pass + fail} cases, `
    + 'every one asserting the state NAME and the licence it grants, never just one.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail > 0 ? 1 : 0);
