#!/usr/bin/env node
'use strict';
// A shipped skill must not tell a session to `git push` without naming the
// authorisation that push needs.
//
// Why this exists, rather than the one-line fix that preceded it:
// `[measured 2026-08-30]` brain/SKILL.md told a Brain to push a dying session's
// branch to origin and called branch pushes "reversible and safe", while
// rule-local-first/SKILL.md -- always-on, same plugin -- held that an ad-hoc push
// needs the operator to say so in that turn. A Brain followed the former and
// published a peer session's branch. The peer had to escalate it.
//
// The trap that let it survive review: the queue-it-with-the-Brain rule in the
// same file scopes queued pushes to *product repos*, so a tooling repo reads as
// unguarded. Two correct-looking sentences, opposite answers, 48 lines apart.
// A reviewer of either passage alone sees nothing wrong.
//
// TWO THINGS THIS GATE LEARNED ON ITS FIRST RUN, both kept because they are the
// reason it is shaped the way it is:
//
//   1. It must not flag a MENTION. fleet/SKILL.md says a remote figure "rides a
//      periodic git push". That is descriptive prose and flagging it was a false
//      positive on run one.
//   2. It must catch an instruction written as PROSE, not only as a command.
//      The sentence that caused the incident was "push the / branch (or a rescue
//      ref) to origin" -- no command line anywhere, and WRAPPED ACROSS TWO LINES,
//      so a line-oriented matcher sees only "push the". A command-only or
//      line-only pattern would have missed the one defect this exists for.
//
// Hence: match a command line OR an imperative phrase, and match the phrase
// against a whitespace-normalised window rather than a single line.
const fs = require('fs');
const path = require('path');

// CLAUDE_PUSH_AUTH_ROOT replaces the scanned tree with a fixture, so the suite
// can exercise the FAILING branch without mutating a real skill. Same shape as
// CLAUDE_VERSION_REGISTRY in check-version-drift.js, and for the same reason:
// running a gate only against the real tree exercises the passing branch, which
// looks identical to a gate that parsed nothing.
const ROOT = process.env.CLAUDE_PUSH_AUTH_ROOT
  ? path.resolve(process.env.CLAUDE_PUSH_AUTH_ROOT)
  : path.resolve(__dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');

// Lines around a push instruction that a reader executing it would take in.
const WINDOW = 10;

// A command line: `git push ...`, optionally behind a list bullet or a prompt.
const PUSH_CMD = /^\s*(?:[-*>]\s*)?(?:\$\s*)?git\s+push\b/;

// An imperative: "push the branch", "push a rescue ref", "push unpushed work",
// "push it to origin". Tested against a normalised window so wrapping cannot
// hide it. Deliberately does NOT match a bare "git push" inside a sentence.
const PUSH_IMPERATIVE =
  /\bpush(?:es|ing)?\s+(?:the\s+|a\s+|its\s+|their\s+|your\s+|each\s+|every\s+|unpushed\s+)*(?:branch|ref|rescue|commits?|work|it|them)\b|\bpush\b[^.]{0,40}\bto\s+origin\b/i;

// Words that name an authorisation. Deliberately broad: a false PASS is a missed
// finding, but a false FAIL blocks the gate on prose that already says the right
// thing, and the second failure mode is the one that gets a gate switched off.
const GATE =
  /(operator|says so|say so|authoris|authoriz|permission|\bask\b|asks\b|licence|license|approval|approve|his yes|in that turn|queue it|not yours to decide|do not push|never push|not part of the rescue)/i;

// Skills where a push instruction is correct and must not be flagged. Each entry
// carries its reason, because an unexplained allowlist entry is how a real
// finding gets quietly filed as known.
const EXEMPT = new Map([
  ['rule-local-first', 'this skill IS the authorisation rule'],
  ['memory-backup', 'sanctioned mirror exception, see backup-protocol'],
]);

const norm = (s) => s.replace(/\s+/g, ' ');

function skillFiles() {
  const out = [];
  if (!fs.existsSync(PLUGINS)) return out;
  for (const plugin of fs.readdirSync(PLUGINS)) {
    const skillsDir = path.join(PLUGINS, plugin, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const skill of fs.readdirSync(skillsDir)) {
      const f = path.join(skillsDir, skill, 'SKILL.md');
      if (fs.existsSync(f)) out.push({ plugin, skill, file: f });
    }
  }
  return out;
}

// Pure, so the selftest feeds it synthetic and historical content instead of
// mutating a real file. A sweep that rewrites its own subject cannot run beside
// anything else.
function scan(skillName, content) {
  if (EXEMPT.has(skillName)) return { instructions: 0, findings: [] };
  const lines = content.split(/\r?\n/);
  const findings = [];
  let instructions = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/push/i.test(lines[i])) continue;
    const near = norm(lines.slice(Math.max(0, i - 1), i + 2).join(' '));
    const isInstruction = PUSH_CMD.test(lines[i]) || PUSH_IMPERATIVE.test(near);
    if (!isInstruction) continue;
    instructions++;
    const window = lines
      .slice(Math.max(0, i - WINDOW), Math.min(lines.length, i + WINDOW + 1))
      .join('\n');
    if (GATE.test(window)) continue;
    findings.push({ line: i + 1, text: lines[i].trim().slice(0, 100) });
  }
  return { instructions, findings };
}

function run(quiet) {
  const files = skillFiles();
  let instructions = 0;
  let exempt = 0;
  const findings = [];

  for (const { plugin, skill, file } of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (EXEMPT.has(skill)) {
      if (/push/i.test(content)) exempt++;
      continue;
    }
    const r = scan(skill, content);
    instructions += r.instructions;
    for (const item of r.findings) findings.push({ plugin, skill, ...item });
  }

  // Print the population, not just a verdict. A bare verdict is
  // indistinguishable from a finder that returned nothing.
  if (!quiet) {
    console.log(
      `[push-auth] ${files.length} shipped SKILL.md scanned, ${instructions} push instruction(s), ` +
        `${exempt} exempt skill(s), ${findings.length} ungated`
    );
    for (const [name, why] of EXEMPT) console.log(`[push-auth]   exempt: ${name} (${why})`);
  }

  if (findings.length) {
    for (const f of findings) {
      console.log(`[push-auth] FAIL ${f.plugin}/${f.skill}/SKILL.md:${f.line}: ${f.text}`);
    }
    console.log(
      `[push-auth] A shipped skill tells a session to push without naming the authorisation. ` +
        `State it within ${WINDOW} lines of the instruction.`
    );
    return 1;
  }
  if (!quiet) console.log('[push-auth] PASS');
  return 0;
}

// The gate must prove it can fire, and prove it can fire on the REAL defect,
// before its green means anything.
function selftest() {
  let bad = 0;
  const check = (label, got, want, ok) => {
    console.log(`[selftest] ${label} -> ${got} (want ${want})`);
    if (!ok) {
      bad++;
      console.log('[selftest] FAIL ' + label);
    }
  };

  // The historical positive. This is the literal pre-fix wording from
  // brain/SKILL.md, line breaks included, so the control cannot drift away from
  // the defect it stands for.
  const HISTORICAL = [
    'on it: for every worktree carrying unpushed commits or a detached HEAD, push the',
    'branch (or a rescue ref) to origin. Branch pushes are reversible and safe;',
    "losing a dead session's only copy is not.",
  ].join('\n');
  const h = scan('brain', HISTORICAL);
  check('historical brain wording (wraps mid-phrase)', h.findings.length, '>=1', h.findings.length >= 1);

  const UNGATED_CMD = ['## Ship it', '', '```bash', 'git push origin HEAD', '```'].join('\n');
  const a = scan('synthetic', UNGATED_CMD);
  check('planted ungated command', a.findings.length, '>=1', a.findings.length >= 1);

  const GATED_CMD = [
    '## Ship it',
    '',
    'Only once the operator has said so in that turn:',
    '',
    '```bash',
    'git push origin HEAD',
    '```',
  ].join('\n');
  const b = scan('synthetic', GATED_CMD);
  check('planted gated command', b.findings.length, '0', b.findings.length === 0);

  // The known false positive from run one. Descriptive prose is not an
  // instruction and must stay clean, or the gate gets tuned off.
  const DESCRIPTIVE = [
    '**Every remote figure must be shown with its age.** It rides a periodic git push,',
    'so a number can be stale without looking stale.',
  ].join('\n');
  const c = scan('fleet', DESCRIPTIVE);
  check('descriptive mention, not an instruction', c.findings.length, '0', c.findings.length === 0);

  // The exemption must be an exemption, not a hole.
  const d = scan('rule-local-first', UNGATED_CMD);
  check('ungated command inside an exempt skill', d.findings.length, '0', d.findings.length === 0);

  const real = run(false);
  if (real !== 0) {
    bad++;
    console.log('[selftest] FAIL the real tree has an ungated push instruction');
  }

  console.log(bad ? `[selftest] ${bad} failure(s)` : '[selftest] PASS');
  return bad ? 1 : 0;
}

process.exit(process.argv.includes('--selftest') ? selftest() : run(false));
