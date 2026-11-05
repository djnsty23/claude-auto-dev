#!/usr/bin/env node
// known-flakes.js - name the recurring gate flakes we already know, so a red
// gate is triaged against them before anyone calls it real or reruns blindly.
//
// WHY. Both local models, and tired sessions, called recurring load flakes
// real: a check-builder B12 animation read under load, a TypeError that a
// rerun of the same tree passed, a 1 s crash of the site check. [measured
// 2026-11-05, offload eval: 27B 4/6 and 4B 3/6 on flake or real]. The fix is
// a list, not a bigger model: matching a known signature is code.
//
// A MATCH NEVER CHANGES A VERDICT. A red stays red. A match prints what the
// failure is known to be and the rerun that settles it: rerun that suite alone
// on the same tree, and a second red is real. Turning a match into a pass would
// let one loose regex hide every real failure that happens to print it.
//
// THE LIST is machine state, never this repo's: product names and their test
// output live there. <claude dir>/autodev/known-flakes.json, or
// $AUTODEV_KNOWN_FLAKES. Shape:
//   { "flakes": [ { "id", "repo", "suite", "signature", "cause", "rerun",
//                   "added", "evidence" } ] }
// repo is the origin remote's repository name ("*" for any). suite is a plain
// string the log must contain. signature is a regular expression the log must
// match. Both must hit for a match. added is YYYY-MM-DD; evidence says how the
// entry was proved a flake (a rerun that passed, a PR body).
//
// This repo's merge gate (gate-fast.js) runs gateNotes() over each failed
// step's output, and the brain skill runs `match` on a red product gate.
// Anything wrong with the list (absent, unreadable, a bad entry) is reported
// and matches nothing: a broken list can only fail to annotate, never pass a
// gate or fail one.
//
// EXIT: match and list exit 0; check exits 1 on an invalid entry; 2 means
//       called wrongly or the list could not be read.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REQUIRED = ['id', 'repo', 'suite', 'signature', 'cause', 'rerun', 'added', 'evidence'];
const STALE_DAYS = 90;

const USAGE = [
  'usage: node known-flakes.js match [--repo NAME] <log-file|->',
  '       node known-flakes.js list  [--repo NAME]',
  '       node known-flakes.js check',
  '',
  'match prints each known flake the log matches, with the rerun that settles it.',
  'A match never changes a verdict: rerun that suite alone, and a second red is real.',
  '--repo defaults to the origin remote of the current directory.',
  `List: $AUTODEV_KNOWN_FLAKES or <claude dir>/autodev/known-flakes.json.`,
].join('\n');

function listPath(env) {
  return env.AUTODEV_KNOWN_FLAKES || path.join(os.homedir(), '.claude', 'autodev', 'known-flakes.json');
}

/** Validate one entry. Returns the reasons it is invalid (empty when valid). */
function problems(e, seen) {
  const out = [];
  if (!e || typeof e !== 'object') return ['not an object'];
  for (const k of REQUIRED) if (typeof e[k] !== 'string' || !e[k].trim()) out.push(`missing ${k}`);
  if (typeof e.signature === 'string') {
    try { new RegExp(e.signature); } catch (err) { out.push(`signature does not compile: ${err.message}`); }
    if (/^(\.\*|\.\+)?$/.test(e.signature.trim())) out.push('signature matches everything');
  }
  if (typeof e.added === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(e.added)) out.push('added is not YYYY-MM-DD');
  if (typeof e.id === 'string') { if (seen.has(e.id)) out.push('duplicate id'); seen.add(e.id); }
  return out;
}

/**
 * Read and validate the list. Never throws.
 * => { file, missing, error, entries (valid only), invalid: [{ id, problems }] }
 */
function loadList(env = process.env) {
  const file = listPath(env);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { file, missing: e.code === 'ENOENT', error: e.code === 'ENOENT' ? null : e.message, entries: [], invalid: [] };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { file, missing: false, error: `not JSON: ${e.message}`, entries: [], invalid: [] }; }
  const flakes = parsed && Array.isArray(parsed.flakes) ? parsed.flakes : null;
  if (!flakes) return { file, missing: false, error: 'no "flakes" array', entries: [], invalid: [] };
  const seen = new Set();
  const entries = [];
  const invalid = [];
  for (const e of flakes) {
    const p = problems(e, seen);
    if (p.length) invalid.push({ id: e && e.id || '(no id)', problems: p });
    else entries.push(e);
  }
  return { file, missing: false, error: null, entries, invalid };
}

function forRepo(entries, repo) {
  return entries.filter((e) => e.repo === '*' || !repo || e.repo.toLowerCase() === String(repo).toLowerCase());
}

/** Known flakes whose suite and signature both appear in the log text. */
function matchLog(text, entries, repo) {
  const log = String(text || '');
  return forRepo(entries, repo).filter((e) => log.includes(e.suite) && new RegExp(e.signature, 'm').test(log));
}

function ageDays(added, now) {
  return Math.floor((now - Date.parse(`${added}T00:00:00Z`)) / 864e5);
}

/** The lines a gate prints under a failed suite. Empty when nothing matched. */
function annotate(text, list, repo, now = Date.now()) {
  return matchLog(text, list.entries, repo).map((e) => {
    const age = ageDays(e.added, now);
    return `known flake ${e.id}: ${e.cause}. Rerun alone on the same tree: ${e.rerun}. A second red is real.` +
      (age > STALE_DAYS ? ` (entry is ${age} days old: re-measure it)` : '');
  });
}

/**
 * What a gate prints under one failed suite: [] when the list is absent, empty,
 * unreadable or matches nothing. Never throws, so it cannot change a gate's
 * exit status by failing.
 */
function gateNotes(text, opts = {}) {
  try {
    if (!text) return [];
    const list = loadList(opts.env || process.env);
    if (!list.entries.length) return [];
    return annotate(text, list, opts.repo || repoName(opts.cwd || process.cwd()));
  } catch {
    return [];
  }
}

function repoName(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return url.replace(/\.git$/, '').split(/[/:]/).pop() || null;
  } catch {
    return null;
  }
}

function describe(list) {
  if (list.error) return `known-flake list ${list.file} unreadable: ${list.error}`;
  if (list.missing) return `no known-flake list at ${list.file}`;
  return `${list.entries.length} valid entr${list.entries.length === 1 ? 'y' : 'ies'} in ${list.file}` +
    (list.invalid.length ? `, ${list.invalid.length} invalid and ignored (run check)` : '');
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  const cmd = argv[0];
  const ri = argv.indexOf('--repo');
  const repo = ri >= 0 ? argv[ri + 1] : repoName(process.cwd());
  const rest = argv.slice(1).filter((a, i, all) => a !== '--repo' && all[i - 1] !== '--repo');
  const list = loadList(process.env);

  if (cmd === 'check') {
    console.log(describe(list));
    for (const b of list.invalid) console.log(`  invalid ${b.id}: ${b.problems.join(', ')}`);
    if (list.error) return 2;
    return list.invalid.length ? 1 : 0;
  }
  if (cmd === 'list') {
    if (list.error) { console.error(describe(list)); return 2; }
    const rows = forRepo(list.entries, repo);
    console.log(`${describe(list)}; ${rows.length} for repo ${repo || '(any)'}`);
    for (const e of rows) console.log(`  ${e.id}  [${e.repo}] ${e.suite}: ${e.cause} (added ${e.added})`);
    return 0;
  }
  if (cmd === 'match') {
    if (!rest[0]) { console.error('match needs a log file or -'); return 2; }
    if (list.error) { console.error(describe(list)); return 2; }
    let text;
    try { text = fs.readFileSync(rest[0] === '-' ? 0 : rest[0], 'utf8'); } catch (e) { console.error(`cannot read ${rest[0]}: ${e.message}`); return 2; }
    const lines = annotate(text, list, repo);
    const scoped = forRepo(list.entries, repo).length;
    if (!lines.length) console.log(`no known flake matched (${scoped} entr${scoped === 1 ? 'y' : 'ies'} for repo ${repo || '(any)'}; ${describe(list)}). Treat the red as real until a rerun says otherwise.`);
    for (const l of lines) console.log(l);
    return 0;
  }
  console.error(`unknown command "${cmd}"\n${USAGE}`);
  return 2;
}

if (require.main === module) process.exitCode = main();

module.exports = { loadList, matchLog, annotate, gateNotes, problems, repoName, describe, listPath };
