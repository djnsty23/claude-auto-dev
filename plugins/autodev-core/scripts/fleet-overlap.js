#!/usr/bin/env node
/**
 * overlap.js — find sessions working the same ground.
 *
 * Three signals, deliberately separate because they mean different things:
 *   BRANCH  two sessions on the same git branch — the hardest evidence, they
 *           will physically collide.
 *   REPO    same repo, different branches — may be fine, may be duplicated work.
 *   TOPIC   shared distinctive title tokens — the softest, catches the two
 *           Unreal sessions that share no repo at all.
 *
 * Stopwords matter here: without them every pair "overlaps" on words like
 * session, fix, and the repo name, which is a detector that fires on everything
 * and therefore says nothing.
 */
const { execFileSync } = require('child_process');
const path = require('path');

// fleet-status.js is a SIBLING in this plugin, so resolve it as one.
//
// This used to be path.join(process.env.USERPROFILE, 'claude-auto-dev', ...) -
// a hardcoded absolute path to one clone on one machine. Three things followed,
// none of them announced: the INSTALLED plugin invoked the fleet-status in
// ~/claude-auto-dev rather than the one shipped beside it, so a released
// version did not run its own code; any clone silently read a different
// checkout's parser; and on a machine where USERPROFILE is unset, path.join
// throws a TypeError on load rather than reporting anything.
//
// __dirname is right because this is a same-plugin sibling. CLAUDE.md's warning
// about ${CLAUDE_PLUGIN_ROOT} is about CROSS-plugin paths and does not apply.
const FLEET = path.join(__dirname, 'fleet-status.js');

// Generic filler only. Project names used to be listed here too, which put
// private repo names — including a client's — into a PUBLIC repo, and hardcoded
// this machine's project list into a script meant to run anywhere. They are
// derived from the sessions themselves below instead.
const STOP = new Set(
  ('the a an and or for to of in on with from into session sessions claude code fix fixes ' +
    'update updates check checks run runs new all set setup and2 status work works item items ' +
    'untitled')
    .split(/\s+/),
);

// A crash here used to print a stack trace and NOTHING on stdout - no
// population line, no pair count. A session reading stdout saw an empty result,
// which reads as "no overlaps". That is the false zero this repo's own rules
// warn about, in the script the brain skill tells every session to run at boot.
//
// Fail LOUD and SPECIFIC instead: say the check could not run, and exit
// non-zero. An unrecognised state must never fall through to the reassuring
// reading.
let raw;
try {
  raw = execFileSync(process.execPath, [FLEET, '--days', '2', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  console.log('COULD NOT CHECK overlap - fleet-status did not run');
  console.log('  subject: ' + FLEET);
  console.log('  reason:  ' + (e && e.message ? e.message.split('\n')[0] : e));
  console.log('  This is NOT "no overlapping pairs". Nothing was scanned.');
  process.exit(2);
}

let d;
try {
  d = JSON.parse(raw);
} catch (e) {
  console.log('COULD NOT CHECK overlap - fleet-status emitted no parseable JSON');
  console.log('  subject: ' + FLEET);
  console.log('  got ' + raw.length + ' byte(s): ' + JSON.stringify(raw.slice(0, 120)));
  console.log('  This is NOT "no overlapping pairs". Nothing was scanned.');
  process.exit(2);
}
const all = Array.isArray(d) ? d : d.sessions || d.rows || [];

// Only sessions that are actually alive: not archived, and touched in the last day.
const live = all.filter((r) => !r.isArchived && r.idleMinutes < 60 * 24);

function repoOf(r) {
  const m = String(r.originCwd || r.cwd || '').match(/code[\\/]([^\\/]+)/i);
  return m ? m[1] : '(none)';
}
// A repo's own name is not evidence that two sessions overlap — every session in
// that repo carries it. Derived from the live set rather than listed, so it needs
// no maintenance and names no repo in this file.
const PROJECT_WORDS = new Set(
  live.flatMap((r) => repoOf(r).toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean),
);

function tokens(r) {
  return new Set(
    String(r.title || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOP.has(w) && !PROJECT_WORDS.has(w)),
  );
}

const pairs = [];
for (let i = 0; i < live.length; i++) {
  for (let j = i + 1; j < live.length; j++) {
    const a = live[i];
    const b = live[j];
    const reasons = [];
    let score = 0;

    if (a.gitBranch && b.gitBranch && a.gitBranch === b.gitBranch && a.gitBranch !== 'HEAD') {
      reasons.push(`SAME BRANCH ${a.gitBranch}`);
      score += 100;
    }
    const ra = repoOf(a);
    const rb = repoOf(b);
    if (ra === rb && ra !== '(none)') {
      reasons.push(`same repo ${ra}`);
      score += 5;
    }
    const ta = tokens(a);
    const tb = tokens(b);
    const shared = [...ta].filter((w) => tb.has(w));
    if (shared.length) {
      reasons.push(`topic: ${shared.join(', ')}`);
      score += 20 * shared.length;
    }
    if (score >= 20) pairs.push({ score, a, b, reasons });
  }
}

pairs.sort((x, y) => y.score - x.score);

console.log(`population: ${all.length} scanned, ${live.length} live (unarchived, active <24h)`);
console.log(`${pairs.length} overlapping pair(s) at score >= 20\n`);
for (const p of pairs) {
  console.log(`[${String(p.score).padStart(3)}] ${p.a.title}`);
  console.log(`      ${p.b.title}`);
  console.log(`      ${p.reasons.join(' | ')}`);
  console.log(`      ${p.a.addressableId || p.a.sessionId}  /  ${p.b.addressableId || p.b.sessionId}`);
  console.log(`      states: ${p.a.state}/${p.b.state}\n`);
}

const blocked = live.filter((r) => r.state === 'blocked');
console.log(`awaiting input right now: ${blocked.length}`);
for (const r of blocked) console.log(`  - ${r.title}  [${r.state}, ${r.idleMinutes}m idle]`);
