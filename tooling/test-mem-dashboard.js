#!/usr/bin/env node
// Tests for the markdown memory dashboard in
// plugins/autodev-memory/scripts/memory-db.js. DB-backed; skips cleanly on Node builds without
// node:sqlite. HOME is redirected to a fresh temp dir BEFORE requiring
// memory-db so the DB is isolated from the developer's real store.
// Run: node tooling/test-mem-dashboard.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const cases = [];

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dashtest-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const memDB = require('../plugins/autodev-memory/scripts/memory-db');

if (!memDB.isAvailable()) {
  console.log('[skip] node:sqlite unavailable — skipping dashboard tests');
} else {
  const PROJ = path.join(TMP_HOME, 'proj');
  const sid = memDB.startSession(PROJ);

  // Seed observations across types and areas.
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'decision',
    title: 'chose JWT for sessions', concept: 'stateless tokens',
    sourceFiles: ['src/auth/jwt.js'], tokenCost: 100
  });
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'bugfix',
    title: 'fixed token refresh race', concept: 'double refresh',
    sourceFiles: ['src/auth/refresh.js'], tokenCost: 50
  });
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'feature',
    title: 'added invoice export', concept: 'csv export',
    sourceFiles: ['src/billing/export.js'], tokenCost: 75
  });
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'discovery',
    title: 'rate limiter is per-node', concept: 'per instance',
    sourceFiles: ['src/auth/limiter.js'], tokenCost: 25
  });
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'refactor',
    title: 'extracted db helper', concept: 'shared query builder',
    sourceFiles: ['lib/db/query.js'], tokenCost: 40
  });
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'change',
    title: 'bumped config format', concept: 'toml migration',
    sourceFiles: ['src/config/settings.js'], tokenCost: 10
  });
  memDB.endSession(sid, {
    request: 'ship auth', completed: 'auth done',
    learned: 'jwt is stateless', nextSteps: 'wire refresh rotation'
  });

  const data = memDB.dashboard(PROJ);
  const md = memDB.renderDashboard(data);

  // --- Structured data sanity ---
  cases.push(['dashboard: returns a structured object', !!data]);
  cases.push(['dashboard: totalObservations counts the 6 seeds',
    !!data && data.stats.totalObservations === 6]);
  cases.push(['dashboard: totalSessions is 1',
    !!data && data.stats.totalSessions === 1]);
  cases.push(['dashboard: totalTokens sums seeded token_cost (300)',
    !!data && data.stats.totalTokens === 300]);

  // --- Overview section rendered ---
  cases.push(['render: has Overview heading', md.includes('## Overview')]);
  cases.push(['render: shows observation count 6', md.includes('Observations: 6')]);
  cases.push(['render: shows session count 1', md.includes('Sessions: 1')]);
  cases.push(['render: shows token total 300', md.includes('Tokens: 300')]);

  // --- Per-type breakdown: each seeded type + its count appears ---
  cases.push(['render: has by-type section', md.includes('## Observations by type')]);
  for (const t of ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']) {
    cases.push([`render: type "${t}" appears in breakdown`, md.includes(t)]);
  }
  // Each type has exactly one seed → each bar line ends with " 1".
  const decisionLine = md.split('\n').find((l) => l.startsWith('decision'));
  cases.push(['render: decision bar line ends with count 1',
    !!decisionLine && /\b1$/.test(decisionLine.trim())]);

  // --- Top areas: seeded area names present, derived via 1-2 segment logic ---
  cases.push(['render: has Top areas section', md.includes('## Top areas')]);
  cases.push(['render: area src/auth present', md.includes('src/auth')]);
  cases.push(['render: area src/billing present', md.includes('src/billing')]);
  cases.push(['render: area lib/db present', md.includes('lib/db')]);
  // src/auth has 3 observations (jwt, refresh, limiter) → count 3.
  const authArea = (data.topAreas || []).find((a) => a.area === 'src/auth');
  cases.push(['dashboard: src/auth area counts 3 observations',
    !!authArea && authArea.count === 3]);
  cases.push(['render: src/auth row shows count 3', md.includes('`src/auth` — 3')]);

  // --- Recent activity includes a seeded title ---
  cases.push(['render: has Recent activity section', md.includes('## Recent activity')]);
  cases.push(['render: recent activity includes a seeded title',
    md.includes('chose JWT for sessions')]);

  // --- Recent sessions surfaces next_steps snippet ---
  cases.push(['render: has Recent sessions section', md.includes('## Recent sessions')]);
  cases.push(['render: session shows next_steps snippet',
    md.includes('wire refresh rotation')]);

  // --- Empty store → friendly message, no throw ---
  const EMPTY = path.join(TMP_HOME, 'empty-proj');
  let emptyMd = '';
  let threw = false;
  try {
    emptyMd = memDB.renderDashboard(memDB.dashboard(EMPTY));
  } catch {
    threw = true;
  }
  cases.push(['empty: dashboard render does not throw', !threw]);
  cases.push(['empty: friendly "No memory recorded yet" message',
    emptyMd.includes('No memory recorded yet')]);
  cases.push(['empty: message names the project', emptyMd.includes('empty-proj')]);

  // --- Null (DB unavailable) → renderer still returns empty message, no throw ---
  let nullThrew = false;
  let nullMd = '';
  try {
    nullMd = memDB.renderDashboard(null);
  } catch {
    nullThrew = true;
  }
  cases.push(['null: renderDashboard(null) does not throw', !nullThrew]);
  cases.push(['null: renderDashboard(null) says no memory recorded',
    nullMd.includes('No memory recorded yet')]);

  // --- ABSOLUTE source_files: areas must anchor to the project ---
  // The capture pipeline stores ABSOLUTE paths (Claude Code passes an absolute
  // file_path, saveObservation stores it verbatim). dashboard() must anchor each
  // file to the project before deriving the area, else /tmp/.../absproj/src/auth/x.js
  // folds to a filesystem-root bucket (e.g. "tmp/<random>") and every area
  // collapses into one useless bucket. This case FAILS under the pre-fix code.
  const ABS_PROJ = path.join(TMP_HOME, 'absproj');
  const absSid = memDB.startSession(ABS_PROJ);
  memDB.saveObservation({
    sessionId: absSid, projectPath: ABS_PROJ, type: 'decision',
    title: 'chose bcrypt', concept: 'password hashing',
    sourceFiles: [path.join(ABS_PROJ, 'src', 'auth', 'login.js')], tokenCost: 10
  });
  memDB.saveObservation({
    sessionId: absSid, projectPath: ABS_PROJ, type: 'bugfix',
    title: 'fixed N+1 query', concept: 'eager load',
    sourceFiles: [path.join(ABS_PROJ, 'src', 'db', 'query.js')], tokenCost: 10
  });
  memDB.endSession(absSid, { request: 'abs test', completed: 'done' });

  const absData = memDB.dashboard(ABS_PROJ);
  const absMd = memDB.renderDashboard(absData);
  const absAreas = (absData.topAreas || []).map((a) => a.area);
  cases.push(['abs: area src/auth derived from absolute path',
    absAreas.includes('src/auth')]);
  cases.push(['abs: area src/db derived from absolute path',
    absAreas.includes('src/db')]);
  cases.push(['abs: NO filesystem-root bucket (only project-relative areas)',
    absAreas.length > 0 && absAreas.every((a) => a === 'src/auth' || a === 'src/db')]);
  cases.push(['abs: rendered md shows src/auth, not a home/tmp bucket',
    absMd.includes('`src/auth`') && !/`(home|tmp)\b/.test(absMd) && !absMd.includes('home/user')]);

  // --- Same-second ordering: newest-first via (timestamp DESC, rowid DESC) ---
  // Seed several observations in the same project; getRecent must return the
  // most-recently-inserted first even when timestamps tie to the same second.
  // Pre-fix (ORDER BY timestamp DESC only) breaks same-second ties by rowid
  // ASC → oldest-first, so this FAILS pre-fix when the inserts share a second.
  const ORD_PROJ = path.join(TMP_HOME, 'ordproj');
  const ordSid = memDB.startSession(ORD_PROJ);
  const ordTitles = ['ord first', 'ord second', 'ord third', 'ord fourth'];
  for (const t of ordTitles) {
    memDB.saveObservation({
      sessionId: ordSid, projectPath: ORD_PROJ, type: 'change',
      title: t, concept: t, sourceFiles: [], tokenCost: 1
    });
  }
  const ordRecent = memDB.getRecent(ORD_PROJ, 10);
  cases.push(['ordering: getRecent returns all 4 seeds', ordRecent.length === 4]);
  cases.push(['ordering: most-recently-inserted appears first',
    ordRecent.length === 4 && ordRecent[0].title === 'ord fourth']);
  cases.push(['ordering: oldest-inserted appears last',
    ordRecent.length === 4 && ordRecent[ordRecent.length - 1].title === 'ord first']);

  // --- Sessions but zero observations: friendly, sessions-aware empty message ---
  const SESS_PROJ = path.join(TMP_HOME, 'sessonly');
  const soSid = memDB.startSession(SESS_PROJ);
  memDB.endSession(soSid, { request: 'started but nothing captured', completed: '' });
  let soMd = '';
  let soThrew = false;
  try {
    soMd = memDB.renderDashboard(memDB.dashboard(SESS_PROJ));
  } catch {
    soThrew = true;
  }
  cases.push(['sessions-only: render does not throw', !soThrew]);
  cases.push(['sessions-only: message acknowledges observations, not "No memory"',
    soMd.includes('No observations recorded yet')]);
  cases.push(['sessions-only: message mentions the session count',
    soMd.includes('(1 session)')]);
}

// --- Report ---
let pass = 0, fail = 0;
cases.forEach(([label, ok]) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  ok ? pass++ : fail++;
});
console.log(`\n${pass} passed, ${fail} failed`);

// Cleanup
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
