#!/usr/bin/env node
// Suite for workflow-liveness.js.
//
// Hermetic on purpose. The script's real job needs `gh` and the network, and a
// suite that reached for either would be measuring GitHub's availability rather
// than this code. So everything here drives the script as a subprocess through
// paths that touch neither: --selftest, the usage path, and a stubbed `gh`.
//
// The cases that matter are the ones the live run can never demonstrate:
//
//  - an UNREADABLE cron must not report healthy. That is the whole reason this
//    gate exists, since the outage it was written for hid behind a state nobody
//    had enumerated.
//  - the usage path must exit NON-zero. A gate invoked wrongly that exits 0 is
//    indistinguishable from a gate that ran and found nothing.
//  - a missing `gh` must say COULD NOT CHECK rather than passing.

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

const run = (args, extraPath) => spawnSync('node', [SCRIPT].concat(args), {
  encoding: 'utf8',
  env: extraPath ? Object.assign({}, process.env, { PATH: extraPath }) : process.env,
});

// ---------------------------------------------------------------------------
// 1. the selftest, which carries the cron-parsing table
// ---------------------------------------------------------------------------
const st = run(['--selftest']);
check('selftest exits 0', st.status === 0, 'exit ' + st.status + ' :: ' + (st.stdout || '').slice(-200));
check('selftest reports the case count it ran', /\d+ cases, 0 failed/.test(st.stdout || ''),
  JSON.stringify((st.stdout || '').slice(-120)));
check('selftest covers a sub-hourly cron', /"\*\/15 \* \* \* \*"/.test(st.stdout || ''));
check('selftest covers a weekly cron', /"0 5 \* \* 1"/.test(st.stdout || ''));

// An unreadable cron must resolve to null, never to a number. A number here
// would be a fabricated interval, and a fabricated interval silently converts a
// dead workflow into a live-looking one.
check('an unreadable cron yields null, not a guessed interval',
  /"0 0 1 \* \*"\s+got null/.test(st.stdout || ''),
  'monthly cron must be UNKNOWN');
check('a five-field check rejects a four-field cron',
  /"\* \* \* \*"\s+got null/.test(st.stdout || ''));

// The extractor needs its own positive, or every unparsed file would read as
// "not scheduled" and drop silently out of scope.
check('the cron extractor has a known-positive of its own',
  /schedulesFromYaml\s+got \["\*\/15 \* \* \* \*","0 5 \* \* 1"\]/.test(st.stdout || ''),
  JSON.stringify((st.stdout || '').slice(-300)));

// ---------------------------------------------------------------------------
// 2. the usage path must not look like success
// ---------------------------------------------------------------------------
const usage = run([]);
check('no --repo exits non-zero', usage.status !== 0, 'exit ' + usage.status);
check('no --repo prints usage', /usage: node workflow-liveness\.js/.test(usage.stdout || ''));
check('no --repo never claims anything was scanned',
  !/population:/.test(usage.stdout || ''));

// ---------------------------------------------------------------------------
// 3. a missing gh is COULD NOT CHECK, never a pass
// ---------------------------------------------------------------------------
// An empty PATH makes `gh` unresolvable without touching the real one. node is
// invoked by absolute path via process.execPath, so it still starts.
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfl-nogh-'));
const noGh = spawnSync(process.execPath, [SCRIPT, '--repo', 'owner/name'], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { PATH: emptyDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
});
check('a missing gh exits non-zero', noGh.status !== 0, 'exit ' + noGh.status);
check('a missing gh says COULD NOT CHECK', /COULD NOT CHECK - gh is unavailable/.test(noGh.stdout || ''),
  JSON.stringify((noGh.stdout || '').slice(0, 200)));
check('a missing gh refuses to read as a pass', /That is not a pass/.test(noGh.stdout || ''));
check('a missing gh never prints a verdict line',
  !/overdue or never-run/.test(noGh.stdout || ''));

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
