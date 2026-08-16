#!/usr/bin/env node
// Tests for the knowledge-agent brief (roadmap §3.2) in scripts/memory-db.js.
// All cases are DB-backed and skip cleanly on Node builds without node:sqlite.
// HOME is redirected to a fresh temp dir BEFORE requiring memory-db so the DB
// is isolated from the developer's real ~/.claude/auto-dev-memory.db.
// Run: node scripts/test-knowledge.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const cases = [];

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'knowtest-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const memDB = require('../plugins/autodev-memory/scripts/memory-db');

if (!memDB.isAvailable()) {
  console.log('[skip] node:sqlite unavailable — skipping knowledge-brief tests');
} else {
  const PROJ = path.join(TMP_HOME, 'proj');
  const sid = memDB.startSession(PROJ);

  // --- Area under test: src/auth (three observations, three types) ---
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'decision',
    title: 'chose JWT for sessions',
    concept: 'stateless tokens avoid server-side session store',
    sourceFiles: ['src/auth/jwt.js']
  });
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'bugfix',
    title: 'fixed token refresh race',
    concept: 'two refreshes could both mint tokens',
    sourceFiles: ['src/auth/refresh.js']
  });
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'discovery',
    title: 'rate limiter is per-node not global',
    concept: 'each instance keeps its own counter',
    sourceFiles: ['src/auth/limiter.js']
  });

  // --- A DIFFERENT area (billing) that must NOT leak into the auth brief ---
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'decision',
    title: 'use stripe webhooks for reconciliation',
    concept: 'webhooks are the source of truth for payment state',
    sourceFiles: ['src/billing/webhook.js']
  });

  const brief = memDB.knowledge(PROJ, 'src/auth');

  // 1) Renders grouped observations for a matching area
  cases.push(['knowledge: returns a result object for matching area', !!brief]);
  cases.push(['knowledge: total counts exactly the 3 auth observations',
    !!brief && brief.total === 3]);
  cases.push(['knowledge: decision grouped under decisions',
    !!brief && brief.groups.decisions.some(r => r.title === 'chose JWT for sessions')]);
  cases.push(['knowledge: bugfix grouped under bugfixes',
    !!brief && brief.groups.bugfixes.some(r => r.title === 'fixed token refresh race')]);
  cases.push(['knowledge: discovery grouped under gotchas',
    !!brief && brief.groups.gotchas.some(r => r.title === 'rate limiter is per-node not global')]);

  // 2) Path filtering restricts to the area — billing must not appear anywhere
  const allTitles = brief
    ? [...brief.groups.decisions, ...brief.groups.bugfixes, ...brief.groups.gotchas, ...brief.groups.changes]
        .map(r => r.title)
    : [];
  cases.push(['knowledge: observation in a different area (billing) is excluded',
    !allTitles.includes('use stripe webhooks for reconciliation')]);

  // Rendered Markdown surfaces the grouping and the matched content, not billing
  const md = memDB.renderKnowledgeBrief(brief, 'src/auth');
  cases.push(['render: brief has a Decisions section', md.includes('## Decisions')]);
  cases.push(['render: brief has a Bug fixes section', md.includes('## Bug fixes')]);
  cases.push(['render: brief has a Gotchas & discoveries section', md.includes('## Gotchas & discoveries')]);
  cases.push(['render: brief includes the JWT decision title', md.includes('chose JWT for sessions')]);
  cases.push(['render: brief excludes the billing decision title',
    !md.includes('use stripe webhooks for reconciliation')]);

  // 3) An area with no observations degrades gracefully (no crash, clear message)
  const empty = memDB.knowledge(PROJ, 'src/does-not-exist');
  cases.push(['knowledge: empty area returns total 0', !!empty && empty.total === 0]);
  const emptyMd = memDB.renderKnowledgeBrief(empty, 'src/does-not-exist');
  cases.push(['render: empty area says "no accumulated knowledge yet"',
    emptyMd.toLowerCase().includes('no accumulated knowledge yet')]);

  // --- Regression: path matching is segment/boundary aware ---
  // `src/authentication/…` must NOT be pulled in by area "src/auth" (old raw
  // substring `.includes()` leaked it). Use a fresh project for isolation.
  const PROJ2 = path.join(TMP_HOME, 'proj-boundary');
  const sid2 = memDB.startSession(PROJ2);
  memDB.saveObservation({
    sessionId: sid2, projectPath: PROJ2, type: 'decision',
    title: 'auth login flow decision',
    concept: 'short-lived access tokens',
    sourceFiles: ['src/auth/login.js']
  });
  memDB.saveObservation({
    sessionId: sid2, projectPath: PROJ2, type: 'decision',
    title: 'authentication service decision',
    concept: 'central identity provider',
    sourceFiles: ['src/authentication/service.js']
  });
  const bnd = memDB.knowledge(PROJ2, 'src/auth');
  const bndTitles = bnd
    ? [...bnd.groups.decisions, ...bnd.groups.bugfixes, ...bnd.groups.gotchas, ...bnd.groups.changes]
        .map(r => r.title)
    : [];
  cases.push(['boundary: "src/auth" includes src/auth/login.js observation',
    bndTitles.includes('auth login flow decision')]);
  cases.push(['boundary: "src/auth" excludes src/authentication/service.js observation',
    !bndTitles.includes('authentication service decision')]);

  // --- Regression: free-text matching is whole-word aware ("auth" != "author") ---
  const PROJ3 = path.join(TMP_HOME, 'proj-word');
  const sid3 = memDB.startSession(PROJ3);
  memDB.saveObservation({
    sessionId: sid3, projectPath: PROJ3, type: 'discovery',
    title: 'author bio rendering quirk',
    concept: 'the author byline truncates on mobile',
    sourceFiles: ['src/profile/bio.js']
  });
  const word = memDB.knowledge(PROJ3, 'auth');
  const wordTitles = word
    ? [...word.groups.decisions, ...word.groups.bugfixes, ...word.groups.gotchas, ...word.groups.changes]
        .map(r => r.title)
    : [];
  cases.push(['word: "auth" does NOT match the word "author" in title/concept',
    !!word && !wordTitles.includes('author bio rendering quirk')]);

  // --- Regression: dedup key includes type (cross-type collision must survive) ---
  const PROJ4 = path.join(TMP_HOME, 'proj-dedup');
  const sid4 = memDB.startSession(PROJ4);
  memDB.saveObservation({
    sessionId: sid4, projectPath: PROJ4, type: 'decision',
    title: 'update config',
    concept: 'switch config format to TOML',
    sourceFiles: ['src/config/settings.js']
  });
  memDB.saveObservation({
    sessionId: sid4, projectPath: PROJ4, type: 'bugfix',
    title: 'update config',
    concept: 'config was not reloaded after save',
    sourceFiles: ['src/config/settings.js']
  });
  const dd = memDB.knowledge(PROJ4, 'src/config');
  cases.push(['dedup: same title, different types both survive (total === 2)',
    !!dd && dd.total === 2]);
  cases.push(['dedup: the decision "update config" is in the decisions group',
    !!dd && dd.groups.decisions.some(r => r.title === 'update config')]);
  cases.push(['dedup: the bugfix "update config" is in the bugfixes group',
    !!dd && dd.groups.bugfixes.some(r => r.title === 'update config')]);
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
