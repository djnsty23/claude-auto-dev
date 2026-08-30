#!/usr/bin/env node
// A SECOND-OPINION REVIEWER, NOT A GATE.
//
// Prints findings and ALWAYS exits 0. The exit code stays with the deterministic
// steps, and that division is the design: a gate must be reproducible and defend
// an exit code, and a model is not reproducible. What a model IS good at is the
// defect class a gate structurally cannot see - an invariant nobody encoded, a
// verdict printed without being computed, a value added to one of two places
// that had to agree.
//
// Authenticates against the ChatGPT subscription via the Codex CLI's own login,
// so there is no API key and nothing billed per run.
//
// ---------------------------------------------------------------------------
// EVERY CONSTRAINT BELOW WAS MEASURED BY RUNNING THE TOOL, AND THE FIRST VERSION
// OF THIS FILE GOT THE MOST IMPORTANT ONE BACKWARDS.
//
// `codex exec review` accepts NO custom prompt, in EITHER mode:
//
//     codex exec review --base main "..."   -> error: the argument '--base <BRANCH>'
//                                              cannot be used with '[PROMPT]'
//     codex exec review --uncommitted "..." -> error: the argument '--uncommitted'
//                                              cannot be used with '[PROMPT]'
//
// and its own help prints `Usage: codex exec review --base <BRANCH> [PROMPT]`,
// advertising the combination it rejects. v1 of this file read that usage string
// instead of testing it, passed a prompt on the --base path, and therefore exited
// 2 and skip()ed on EVERY committed diff. A reviewer that never reviewed, whose
// skip message read like a considered exemption. It was caught by pointing this
// very script at itself.
//
// So: custom review priorities cannot be passed here. They belong in AGENTS.md,
// which Codex reads on its own.
//
// `--sandbox` is likewise an option of `codex exec`, not of the `review`
// subcommand; passing it exits 2. Sandboxing appears to be on by default (the
// subcommand offers --dangerously-bypass-approvals-and-sandbox to turn it off),
// but that is INFERRED from the bypass flag existing, not verified here.

const { spawnSync } = require('node:child_process');

const BASE = process.argv[2] || 'origin/main';
const TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS || 540000);
const WIN = process.platform === 'win32';

// A skip is a DEFICIENCY, never a reassuring category. check-suites-can-fail
// printed "nothing to stub" for three suites it had never checked and a second
// reader repeated that as an all-clear.
//
// This function used to end with "The deterministic steps still ran and still own
// the exit code." Codex flagged it and was right: run standalone via
// `npm run check:review`, nothing else has run, so that sentence asserted a gate
// result nothing had computed - the exact defect this script exists to hunt,
// inside the hunter. It now states only what it can know.
function skip(reason, remedy) {
  console.log('REVIEW NOT RUN - this diff is UNREVIEWED by the second opinion.');
  console.log('  reason: ' + reason);
  if (remedy) console.log('  remedy: ' + remedy);
  console.log('  This step never sets the exit code either way; it says nothing');
  console.log('  about whether the deterministic gate ran or passed.');
  process.exit(0);
}

// git is never spawned through a shell: `origin/main^{commit}` is a valid rev,
// but cmd.exe treats ^ as its escape character, so with shell:true the caret is
// eaten and the ref silently fails to resolve. v1 reported "base ref does not
// resolve locally" for a ref that resolves fine.
function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

// --- population FIRST, prerequisites second --------------------------------
// Order matters: on a clean branch with codex absent, checking codex first
// reports an UNREVIEWED deficiency and an install remedy for a diff that does
// not exist. Establish that there is something to review before demanding a
// reviewer.

if (git(['rev-parse', '--verify', '--quiet', BASE]).status !== 0) {
  skip('base ref ' + BASE + ' does not resolve locally', 'git fetch origin');
}

// The exit status is consulted, not just the text. `git diff A...HEAD` on
// unrelated histories exits non-zero with EMPTY stdout, which read as "no
// changes" and exited 0 - a failed probe rendering as a clean result.
const diff = git(['diff', '--name-only', BASE + '...HEAD']);
if (diff.status !== 0) {
  skip('git could not compute a diff against ' + BASE + ' (exit ' + diff.status + ')',
       'check that ' + BASE + ' shares history with HEAD');
}
const files = (diff.stdout || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
const dirty = (git(['status', '--porcelain']).stdout || '')
  .split('\n').filter(function (s) { return s.trim(); }).length;

if (files.length === 0 && dirty === 0) {
  console.log('REVIEW SKIPPED - no changes against ' + BASE + ' and a clean tree.');
  console.log('  Nothing to review is a valid result, not a pass.');
  process.exit(0);
}

// A ref reaches cmd.exe as a concatenated string because codex needs shell:true
// on Windows (what is on PATH is a .cmd shim). git permits & | < > ^ in ref
// names, and cmd.exe treats them as separators - so `--base origin/topic&whoami`
// would execute the suffix. Refuse anything outside a conservative ref charset
// rather than trying to escape it.
if (!/^[A-Za-z0-9._\/-]+$/.test(BASE)) {
  skip('base ref ' + JSON.stringify(BASE) + ' contains characters that are unsafe to pass through a shell',
       'pass a plain ref name, e.g. origin/main');
}

// Codex's own login state, not a guessed file path. ~/.codex/auth.json is absent
// when CODEX_HOME is set or the credential store is the OS keyring, and checking
// for the file reports "not signed in" for a perfectly authenticated user.
const login = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', shell: WIN, timeout: 30000 });
if (login.error || login.status !== 0) {
  skip('codex is unavailable or not signed in (`codex login status` exit ' +
       (login.error ? login.error.code : login.status) + ')',
       'npm i -g @openai/codex, then `codex login`');
}

console.log('--- second-opinion review (ADVISORY, never fails the build) ---');
console.log('  base            ' + BASE);
console.log('  files in diff   ' + files.length);
console.log('  uncommitted     ' + dirty + ' path(s)');
const useBase = files.length > 0;
console.log('  mode            ' + (useBase ? '--base ' + BASE + ' (committed changes)'
                                            : '--uncommitted (working tree)'));
console.log('  instructions    codex defaults + AGENTS.md (the CLI accepts no prompt here)');
console.log('');

const run = spawnSync(
  'codex',
  useBase ? ['exec', 'review', '--base', BASE] : ['exec', 'review', '--uncommitted'],
  { encoding: 'utf8', shell: WIN, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
);

if (run.error && run.error.code === 'ETIMEDOUT') {
  skip('codex exceeded ' + Math.round(TIMEOUT_MS / 1000) + 's and was killed',
       'raise REVIEW_TIMEOUT_MS, or review this diff by hand');
}
if (run.status !== 0) {
  // A non-zero codex is a broken REVIEWER, not a failed review. Reporting it as a
  // finding would be the "environmental label closes a question" error - the
  // label explains the failure and says nothing about the subject.
  const tail = (run.stderr || '').trim().split('\n').slice(-2).join(' ');
  skip('codex exited ' + run.status, tail || 'see stderr');
}

console.log((run.stdout || '').trim() || '(codex produced no output)');
console.log('');
console.log('--- end review. ADVISORY ONLY: this step did not affect the exit code. ---');
process.exit(0);
