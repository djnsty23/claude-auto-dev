#!/usr/bin/env node
// Suite for check-push-authorisation.js.
//
// The case that matters is the one the gate cannot demonstrate against the real
// tree: that it FAILS when a shipped skill tells a session to push without
// naming the authorisation. The real tree is clean by construction now, so
// running there only ever exercises the passing branch -- indistinguishable from
// a gate that parsed nothing and had nothing to say.
//
// Hermetic on purpose: CLAUDE_PUSH_AUTH_ROOT points the gate at a fixture tree,
// so nothing here mutates a real SKILL.md.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, 'check-push-authorisation.js');
let pass = 0;
let fail = 0;

const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
};

function fixture(skillName, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pushauth-'));
  const dir = path.join(root, 'plugins', 'testplug', 'skills', skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  return root;
}

function runGate(root, args) {
  return spawnSync(process.execPath, [GATE].concat(args || []), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PUSH_AUTH_ROOT: root }),
  });
}

// 1. The failing branch, as a command.
{
  const root = fixture('shipit', ['## Ship it', '', '```bash', 'git push origin HEAD', '```'].join('\n'));
  const r = runGate(root);
  ok('fails on an ungated push command', r.status === 1, 'exit ' + r.status);
  ok('names the offending file and line', /shipit\/SKILL\.md:\d+/.test(r.stdout || ''), r.stdout);
}

// 2. The failing branch, as PROSE that wraps mid-phrase. This is the shape that
//    caused the real incident, and a line-oriented matcher cannot see it.
{
  const root = fixture(
    'rescue',
    [
      'Rescue step.',
      '',
      'for every worktree carrying unpushed commits or a detached HEAD, push the',
      'branch (or a rescue ref) to origin. Branch pushes are reversible and safe;',
      "losing a dead session's only copy is not.",
    ].join('\n')
  );
  const r = runGate(root);
  ok('fails on a wrapped prose push instruction', r.status === 1, 'exit ' + r.status);
}

// 3. The passing branch: same instruction, authorisation named nearby.
{
  const root = fixture(
    'shipit',
    [
      '## Ship it',
      '',
      'Only once the operator has said so in that turn:',
      '',
      '```bash',
      'git push origin HEAD',
      '```',
    ].join('\n')
  );
  const r = runGate(root);
  ok('passes when the authorisation is named', r.status === 0, 'exit ' + r.status);
}

// 4. A descriptive MENTION is not an instruction. This was a real false positive
//    on the gate's first run against fleet/SKILL.md, and it must stay fixed.
{
  const root = fixture(
    'fleet',
    [
      '**Every remote figure must be shown with its age.** It rides a periodic git push,',
      'so a number can be stale without looking stale.',
    ].join('\n')
  );
  const r = runGate(root);
  ok('does not flag a descriptive mention', r.status === 0, (r.stdout || '').trim());
}

// 5. Population is printed, not just a verdict.
{
  const root = fixture('shipit', 'nothing about pushing here.\n');
  const r = runGate(root);
  ok('prints the population it scanned', /SKILL\.md scanned/.test(r.stdout || ''), r.stdout);
}

// 6. The gate's own selftest, against the REAL tree, with no override.
{
  const r = spawnSync(process.execPath, [GATE, '--selftest'], { encoding: 'utf8' });
  ok('selftest passes on the real tree', r.status === 0, (r.stdout || '') + (r.stderr || ''));
}

console.log((fail ? 'FAIL' : 'PASS') + ` push-authorisation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
