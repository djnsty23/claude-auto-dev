#!/usr/bin/env node
// Tests for tooling/test-skill-prd-commands.js — the gate that executes the
// node -e commands embedded in SKILL.md files.
// Run: node tooling/test-skill-prd-commands-selftest.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY A GATE NEEDS ITS OWN SUITE. That gate reports on the real tree, so its
// green says "no command in this repo is blind today". It says nothing about
// whether the gate would still go red if one were. The defects asserted here
// must NOT exist in the real tree, so they are built in a synthetic plugins/
// tree and the gate is driven against it via SKILL_PRD_ROOT.
//
// THE DEFECT THIS SUITE WAS WRITTEN FOR. The gate has three outcomes, and its
// NOT RUNNABLE branch — a command that will not run on a valid fixture — was
// applied to BOTH kinds of command. The two kinds are not alike:
//
//   agent-run     a fenced `node -e ...` the agent is TOLD to run. Frequently
//                 illustrative: archive-prd's carries an ellipsis. Excusing it
//                 is correct, and case 2 below pins that it stays excused.
//   auto-executed an inline !`node -e ...`, run at skill LOAD on the user's
//                 machine, output injected into their context. It cannot be
//                 illustrative by construction. One that exits non-zero on a
//                 VALID prd.json is broken in every case, and excusing it is a
//                 gate reporting green over a live defect.
//
// Case 1 failed before that distinction was drawn (the gate exited 0 on a
// throwing auto-executed command) and passes after. Cases 2 and 4 exist so the
// fix cannot degenerate into failing everything, which would pass case 1 while
// making the gate useless.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.resolve(__dirname, 'test-skill-prd-commands.js');

// Reads prd.json and names every story, so adding a story in ANY state changes
// the output. This is what a correct command looks like.
const HEALTHY =
  'node -e "const p=require(process.cwd()+\'/prd.json\');' +
  'console.log(Object.entries(p.stories).map(([k,v])=>k+\':\'+String(v.passes)).join(\',\'))"';

// Counts only passes===true, so a story in any other state changes nothing.
// This is the blindness the gate was built to catch.
const BLIND =
  'node -e "const p=require(process.cwd()+\'/prd.json\');' +
  'console.log(\'done:\'+Object.values(p.stories).filter(s=>s.passes===true).length)"';

// Reads prd.json and then throws — broken, not illustrative.
const THROWS =
  'node -e "const p=require(process.cwd()+\'/prd.json\');throw new Error(\'boom\')"';

/** Build a throwaway tree: <root>/plugins/<plugin>/skills/<skill>/SKILL.md */
function makeTree(body) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillprd-selftest-'));
  const dir = path.join(root, 'plugins', 'fixture-plugin', 'skills', 'fixture-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return root;
}

function runGate(root) {
  const r = spawnSync('node', [GATE], {
    encoding: 'utf8',
    env: { ...process.env, SKILL_PRD_ROOT: root },
  });
  return { exitCode: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** An inline !`...` is auto-executed; a fenced line is agent-run. */
const auto = (cmd) => `# Fixture\n\n!\`${cmd}\`\n`;
const fenced = (cmd) => '# Fixture\n\n```\n' + cmd + '\n```\n';

const cases = [
  // [label, SKILL.md body, expectedExit, expectedSubstring]

  // ---- the defect this suite was written for ----
  ['auto-executed command that throws FAILS', auto(THROWS), 1, 'auto-executed'],

  // ---- the other half of the decision, so the fix cannot be "fail everything" ----
  //
  // Paired with a healthy command ON PURPOSE. Asserting the excusal on a tree
  // containing ONLY the excused command would have demanded a PASS over zero
  // checked commands, which is the very thing the last case forbids.
  ['agent-run command that throws is still excused',
    auto(HEALTHY) + fenced(THROWS), 0, 'NOT RUNNABLE'],
  ['healthy auto-executed command passes', auto(HEALTHY), 0, 'PASS'],

  // ---- behaviour that already worked and must keep working ----
  ['auto-executed command blind to a state FAILS', auto(BLIND), 1, 'IDENTICAL'],
  ['a tree with no commands is a broken extractor, not a clean sweep',
    '# Fixture\n\nNo commands here.\n', 1, '0 prd.json commands discovered'],

  // ---- a verdict over zero evidence is not a pass (rule-gate-integrity §2) ----
  // Before the post-exclusion floor this printed "PASS: all 0 runnable ...".
  ['every command excused is not a pass either', fenced(THROWS), 1, '0 runnable'],
];

let failed = 0;
for (const [label, body, expectedExit, expectedSubstring] of cases) {
  const root = makeTree(body);
  const { exitCode, out } = runGate(root);
  fs.rmSync(root, { recursive: true, force: true });

  const okExit = exitCode === expectedExit;
  const okText = out.includes(expectedSubstring);
  if (okExit && okText) {
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.error(`FAIL  ${label}`);
    if (!okExit) console.error(`        expected exit ${expectedExit}, got ${exitCode}`);
    if (!okText) console.error(`        expected output to contain ${JSON.stringify(expectedSubstring)}`);
    console.error(out.split('\n').map((l) => '        | ' + l).join('\n'));
  }
}

if (failed) {
  console.error(`\n${failed} of ${cases.length} case(s) failed.`);
  process.exit(1);
}
console.log(`\n${cases.length}/${cases.length} cases passed.`);
process.exit(0);
