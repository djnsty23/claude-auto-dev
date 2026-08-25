#!/usr/bin/env node
// Suite for workflow-liveness.js.
//
// Hermetic on purpose. The script's real job needs `gh`, PowerShell and the
// network, and a suite reaching for any of those would be measuring platform
// availability rather than this code. So everything here drives the script as a
// subprocess through paths that touch none of them: --selftest, the usage path,
// an emptied PATH so `gh` cannot resolve, and --log against temp files whose
// mtime is set deliberately.
//
// The --log cases are the valuable half. They exercise the real judge() path end
// to end rather than calling it as a pure function, and they can pin the exact
// boundary between current and overdue, which no live run can do on demand.
//
// Cases that matter because a live run can never demonstrate them:
//
//  - an UNREADABLE cron or spec must not report healthy. That is the whole
//    reason this gate exists: the outage it was written for hid behind a state
//    nobody had enumerated.
//  - a MISSING subject must be FATAL, while an UNKNOWN one must not be. Those
//    are different failures and collapsing them either mutes the gate or makes
//    it permanently red.
//  - the usage path must exit NON-zero. A gate invoked wrongly that exits 0 is
//    indistinguishable from one that ran and found nothing.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'workflow-liveness.js');
let pass = 0, fail = 0;

const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); }
};

const run = (args, env) => spawnSync(process.execPath, [SCRIPT].concat(args), {
  encoding: 'utf8',
  env: env || process.env,
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfl-'));

/** Write a file whose mtime is `minutesAgo` in the past, so age is exact. */
const aged = (name, minutesAgo) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, 'x', 'utf8');
  const when = new Date(Date.now() - minutesAgo * 60000);
  fs.utimesSync(p, when, when);
  return p;
};

// ---------------------------------------------------------------------------
// 1. the selftest, which carries the cron, spec and judge tables
// ---------------------------------------------------------------------------
const st = run(['--selftest']);
check('selftest exits 0', st.status === 0, 'exit ' + st.status + ' :: ' + (st.stdout || '').slice(-200));
check('selftest reports the case count it ran', /\d+ cases, 0 failed/.test(st.stdout || ''));
check('selftest covers a sub-hourly cron', /"\*\/15 \* \* \* \*"/.test(st.stdout || ''));
check('selftest covers a weekly cron', /"0 5 \* \* 1"/.test(st.stdout || ''));

// A guessed interval would silently turn a dead subject into a live-looking one.
check('an unreadable cron yields null, not a guessed interval',
  /"0 0 1 \* \*"\s+got null/.test(st.stdout || ''));
check('a five-field check rejects a four-field cron',
  /"\* \* \* \*"\s+got null/.test(st.stdout || ''));
check('the cron extractor has a known-positive of its own',
  /schedulesFromYaml\s+got \["\*\/15 \* \* \* \*","0 5 \* \* 1"\]/.test(st.stdout || ''));

// A malformed spec must be refused rather than defaulted.
check('a spec missing its interval is refused', /parseSpec "mon=C:\/x\/y\.log"\s+got null/.test(st.stdout || ''));
check('a zero interval is refused', /parseSpec "mon=C:\/x\/y\.log=0"\s+got null/.test(st.stdout || ''));
check('a non-numeric interval is refused', /parseSpec "mon=C:\/x\/y\.log=abc"\s+got null/.test(st.stdout || ''));
check('an empty label is refused', /parseSpec "=C:\/x\/y\.log=15"\s+got null/.test(st.stdout || ''));
check('selftest pins the judge boundary', /judge age=29 every=15\s+got ok/.test(st.stdout || '') &&
  /judge age=31 every=15\s+got OVERDUE/.test(st.stdout || ''));

// ---------------------------------------------------------------------------
// 2. --log, the portable mode, driven through the real code path
// ---------------------------------------------------------------------------
const fresh = run(['--log', 'fresh=' + aged('fresh.log', 5) + '=15']);
check('a log written inside its interval is current', /\bok\s+fresh/.test(fresh.stdout || ''),
  JSON.stringify((fresh.stdout || '').slice(0, 300)));
check('a current log exits 0', fresh.status === 0, 'exit ' + fresh.status);

// Just inside and just outside 2x the interval. Two inputs that must NOT produce
// identical output, which is the cheap tell for a probe that measured neither.
const inside = run(['--log', 'inside=' + aged('inside.log', 29) + '=15']);
const outside = run(['--log', 'outside=' + aged('outside.log', 31) + '=15']);
check('29m against a 15m interval is still current', /\bok\s+inside/.test(inside.stdout || ''));
check('31m against a 15m interval is OVERDUE', /OVERDUE\s+outside/.test(outside.stdout || ''));
check('the boundary changes the exit code too', inside.status === 0 && outside.status === 1,
  'inside ' + inside.status + ' outside ' + outside.status);

const absent = run(['--log', 'gone=' + path.join(tmp, 'no-such-file.log') + '=15']);
check('a log that never existed is NEVER RAN, not current',
  /NEVER RAN\s+gone/.test(absent.stdout || ''));
check('NEVER RAN is fatal', absent.status === 1, 'exit ' + absent.status);
check('NEVER RAN is never reported as a real zero',
  !/\bok\s+gone/.test(absent.stdout || ''));

// ---------------------------------------------------------------------------
// 3. UNKNOWN must be loud but NOT fatal, or a monthly cron mutes the gate
// ---------------------------------------------------------------------------
const bogus = run(['--log', 'badspec-with-no-interval']);
check('a malformed spec reports UNKNOWN', /UNKNOWN\s+badspec/.test(bogus.stdout || ''),
  JSON.stringify((bogus.stdout || '').slice(0, 300)));
check('UNKNOWN is not fatal', bogus.status === 0, 'exit ' + bogus.status);
check('UNKNOWN is stated as not-passing in the output',
  /An unjudgeable row is NOT a passing row/.test(bogus.stdout || ''));
check('an unjudgeable row is counted separately from current',
  /0 current/.test(bogus.stdout || ''), JSON.stringify((bogus.stdout || '').slice(-200)));

// ---------------------------------------------------------------------------
// 3b. MISSING must be FATAL, and it is a different failure from UNKNOWN
// ---------------------------------------------------------------------------
// This is the one case that cannot be hermetic: MISSING only arises from the
// task path, which needs PowerShell. It needs no network and no real task, so it
// runs wherever PowerShell exists, and where it does not the skip is announced as
// a DEFICIENCY. A skip worded as a category ("not applicable") is how absent
// coverage gets read as coverage.
if (process.platform === 'win32') {
  const gone = run(['--task', 'NoSuchTaskShouldExist_wfl_selftest=60']);
  check('a named task that does not exist is MISSING', /MISSING\s+NoSuchTask/.test(gone.stdout || ''),
    JSON.stringify((gone.stdout || '').slice(0, 300)));
  check('MISSING is fatal', gone.status === 1, 'exit ' + gone.status);
  check('MISSING is counted in its own right', /\(1 missing\)/.test(gone.stdout || ''));
  check('MISSING is never folded into current', /0 current/.test(gone.stdout || ''));
  // The diagnostic must not swallow the row it belongs to.
  const row = (gone.stdout || '').split(/\r?\n/).filter((l) => /MISSING/.test(l))[0] || '';
  check('the MISSING diagnostic stays on one readable row', row.length > 0 && row.length < 200,
    'row length ' + row.length);
} else {
  console.log('  NOT CHECKED  MISSING verdict is unverified on ' + process.platform +
    ' - it needs PowerShell. This is a coverage gap, not a pass.');
}

// ---------------------------------------------------------------------------
// 4. the population line, which is what makes a clean report readable
// ---------------------------------------------------------------------------
check('every run prints the population it scanned', /population: .*subject\(s\) seen/.test(fresh.stdout || ''));
check('the population names what was asked for, not just what was found',
  /1 log\(s\)/.test(fresh.stdout || ''));
check('the tolerance is stated rather than implied', /tolerance: overdue past 2x/.test(fresh.stdout || ''));

// ---------------------------------------------------------------------------
// 5. the usage path must not look like success
// ---------------------------------------------------------------------------
const usage = run([]);
check('no subject exits non-zero', usage.status !== 0, 'exit ' + usage.status);
check('no subject prints usage', /usage: node workflow-liveness\.js/.test(usage.stdout || ''));
check('usage documents all three subject kinds',
  /--repo/.test(usage.stdout || '') && /--log/.test(usage.stdout || '') && /--task/.test(usage.stdout || ''));
check('no subject never claims anything was scanned', !/population:/.test(usage.stdout || ''));

// ---------------------------------------------------------------------------
// 6. a missing gh is COULD NOT CHECK, never a pass
// ---------------------------------------------------------------------------
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfl-nogh-'));
const noGh = run(['--repo', 'owner/name'],
  Object.assign({}, process.env, { PATH: emptyDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }));
check('a missing gh exits non-zero', noGh.status !== 0, 'exit ' + noGh.status);
check('a missing gh says gh is unavailable', /gh is unavailable/.test(noGh.stdout || ''),
  JSON.stringify((noGh.stdout || '').slice(0, 200)));
check('a missing gh counts the repos as UNCHECKABLE', /1 UNCHECKABLE/.test(noGh.stdout || ''));
check('a missing gh never reports a current subject', !/\d+ current/.test(noGh.stdout || '') ||
  /0 current/.test(noGh.stdout || ''));

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
