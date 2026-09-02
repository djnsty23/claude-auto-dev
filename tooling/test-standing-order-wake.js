#!/usr/bin/env node
'use strict';
// Suite for standing-order-wake.js, and the executable form of C4:
// "Standing conditional orders execute without re-prompt -- a planted order
// ('when X is green, do Y') with X flipping during the window. Y happens within
// one wake interval, once, with the order's origin logged."
//
// Three wakes, one flip, and the count of firings is the whole test. A wake
// that re-fires an executed order is the failure this exists to catch, and it
// is invisible to any single-wake test: wake 2 alone looks identical whether or
// not the once-only transition works.
//
// Run: node tooling/test-standing-order-wake.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { wake, setStatus } = require('./standing-order-wake.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-suite-'));
let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 400) : ''));
  }
};

// The condition is a real file on disk, so "X flips" is a real state change
// rather than a stubbed boolean. The check command is evaluated by the wake the
// same way a live one would be.
const FLAG = path.join(TMP, 'x-is-green');
const HOLDER = path.join(TMP, 'STANDING-ORDERS.md');

// The check lives in a FILE, not in a `node -e` string.
//
// `[measured 2026-09-02]` the first version of this fixture inlined the path
// with JSON.stringify inside a double-quoted `node -e "..."`, which nests
// double quotes inside double quotes. The command failed to parse, exited
// non-zero, and the wake correctly reported the order as pending. Every
// assertion about firing then failed against a subject that was working.
//
// The trap is that a broken check and an unmet condition are the same
// observation. Wake 1 asserts the order does NOT fire, so it passed throughout
// and gave no warning. Hence the control below: the check must be shown to
// return 0 once the flag exists, before any assertion depends on it.
const CHECK_JS = path.join(TMP, 'check.js');
fs.writeFileSync(
  CHECK_JS,
  `process.exit(require('fs').existsSync(${JSON.stringify(FLAG)}) ? 0 : 1);\n`,
  'utf8'
);
const CHECK_CMD = `node ${JSON.stringify(CHECK_JS)}`;

const ORDER = [
  '# Standing orders',
  '',
  '## SO-1: publish the audit branch',
  '',
  '- **Verbatim:** "when the gate is green you can push it yourself"',
  '- **Date:** 2026-09-02',
  '- **Condition:** the gate is green on the audit branch',
  `- **Check:** ${CHECK_CMD}`,
  '- **Holding session:** a-session-slug',
  '- **Status:** armed',
  '',
].join('\n');

fs.writeFileSync(HOLDER, ORDER, 'utf8');

const runCheck = () => spawnSync(CHECK_CMD, { shell: true, encoding: 'utf8' }).status;
ok('control: the check command runs and reports X not green', runCheck() === 1, String(runCheck()));

// ---- wake 1: the condition has not flipped yet ----
{
  const r = wake(HOLDER, { commit: true, now: '2026-09-02T10:00:00Z' });
  ok('wake 1 sees the order armed', r.armed === 1, JSON.stringify(r.armed));
  ok('wake 1 does not fire', r.fired.length === 0, JSON.stringify(r.fired.map((o) => o.title)));
  ok('wake 1 reports it pending', r.pending.length === 1, JSON.stringify(r.pending.length));
  ok('wake 1 leaves the holder armed', /\*\*Status:\*\* armed/.test(fs.readFileSync(HOLDER, 'utf8')));
}

// ---- X flips green during the window ----
fs.writeFileSync(FLAG, 'green\n', 'utf8');

// The planted positive must be shown to be positive. Without this, a check
// command that can never return 0 makes every no-fire assertion below pass for
// the wrong reason.
ok('control: the check command now reports X green', runCheck() === 0, String(runCheck()));

// ---- wake 2: it fires, once ----
{
  const r = wake(HOLDER, { commit: true, now: '2026-09-02T11:00:00Z' });
  ok('wake 2 fires exactly once', r.fired.length === 1, JSON.stringify(r.fired.map((o) => o.title)));
  const after = fs.readFileSync(HOLDER, 'utf8');
  ok('wake 2 writes executed with a timestamp', /\*\*Status:\*\* executed 2026-09-02T11:00:00Z/.test(after), after);
  ok('and armed is gone from the holder', !/\*\*Status:\*\* armed/.test(after), after);

  // C4's "with the order's origin logged": the fired order must still carry
  // who gave it, when, and in whose words.
  const o = r.fired[0];
  ok('the fired order carries its verbatim words', /when the gate is green/.test(o.fields.verbatim), o.fields.verbatim);
  ok('the fired order carries its date', o.fields.date === '2026-09-02', o.fields.date);
  ok('the fired order carries its holding session', o.fields['holding session'] === 'a-session-slug', o.fields['holding session']);
}

// ---- wake 3: the condition is STILL true, and it must not re-fire ----
{
  ok('the flip is still true', fs.existsSync(FLAG));
  const r = wake(HOLDER, { commit: true, now: '2026-09-02T12:00:00Z' });
  ok('wake 3 sees nothing armed', r.armed === 0, JSON.stringify(r.armed));
  ok('wake 3 does not re-fire', r.fired.length === 0, JSON.stringify(r.fired.map((o) => o.title)));
  const after = fs.readFileSync(HOLDER, 'utf8');
  ok(
    'and the original execution timestamp is untouched',
    /executed 2026-09-02T11:00:00Z/.test(after),
    after
  );
}

// ---- a prose condition is never guessed at ----
{
  const proseHolder = path.join(TMP, 'prose.md');
  fs.writeFileSync(proseHolder, ORDER.split('\n').filter((l) => !l.includes('**Check:**')).join('\n'), 'utf8');
  const r = wake(proseHolder, { commit: true });
  ok('a prose-only condition does not fire', r.fired.length === 0, JSON.stringify(r.fired.length));
  ok('and is reported as needing judgement', r.judgement.length === 1, JSON.stringify(r.judgement.length));
  ok(
    'and the holder is left armed for a person to decide',
    /\*\*Status:\*\* armed/.test(fs.readFileSync(proseHolder, 'utf8'))
  );
}

// ---- without --commit, a wake reports and writes nothing ----
{
  const dry = path.join(TMP, 'dry.md');
  fs.writeFileSync(dry, ORDER, 'utf8');
  const before = fs.readFileSync(dry, 'utf8');
  const r = wake(dry, { commit: false, now: '2026-09-02T13:00:00Z' });
  ok('a dry wake still reports the firing', r.fired.length === 1, JSON.stringify(r.fired.length));
  ok('but leaves the holder untouched', fs.readFileSync(dry, 'utf8') === before);
}

// ---- the rewrite must not eat the document around it ----
{
  const doc = [
    '# Standing orders',
    '',
    '## The form',
    '',
    '```markdown',
    '## SO-EXAMPLE: not a real order',
    '- **Status:** armed',
    '```',
    '',
    ORDER.split('\n').slice(2).join('\n'),
  ].join('\n');
  const out = setStatus(doc, 'SO-1', 'executed 2026-09-02T14:00:00Z');
  ok('the fenced example keeps its Status', /## SO-EXAMPLE: not a real order\n- \*\*Status:\*\* armed/.test(out), out);
  ok('the real order is rewritten', /\*\*Status:\*\* executed 2026-09-02T14:00:00Z/.test(out), out);
  ok('the fence itself survives', (out.match(/```/g) || []).length === 2, out);
}

// ---- an absent holder is not a firing ----
{
  const r = wake(path.join(TMP, 'nope.md'), { commit: true });
  ok('an absent holder fires nothing', r.fired.length === 0 && r.missing === true, JSON.stringify(r));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log((fail ? 'FAIL' : 'PASS') + ` standing-order-wake: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
