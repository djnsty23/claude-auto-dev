#!/usr/bin/env node
// Tests for scripts/semantic-search.js (pure ranker) and the memory-db semantic
// search + raw_data privacy hardening. Pure-ranker tests always run; DB tests
// skip cleanly on Node builds without node:sqlite.
// Run: node scripts/test-semantic-search.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const cases = [];

// --- Pure ranker tests (no DB, no HOME) ---
const { tokenize, stem, expandQuery, rank } = require('../plugins/autodev-memory/scripts/semantic-search');

// stem: inflections collapse to a shared root
cases.push(['stem: deployed/deploying/deploys share root', (() => {
  const a = stem('deployed'), b = stem('deploying'), c = stem('deploys');
  return a === b && b === c && a === 'deploy';
})()]);

// expandQuery: bridges a dev-domain synonym (auth ↔ authentication)
cases.push(['expandQuery: "auth" bridges to "authentication"',
  expandQuery(tokenize('auth')).includes('authentication')]);

// rank: paraphrased query surfaces the conceptually-relevant doc first
{
  const docs = [
    { id: 'd1', text: 'the weather is sunny and warm today' },
    { id: 'd2', text: 'we refactored the database connection pooling logic' },
    { id: 'd3', text: 'friday lunch menu options for the team' }
  ];
  const ranked = rank('db connection pooling', docs, 3);
  cases.push(['rank: paraphrased query returns relevant doc first',
    ranked.length > 0 && ranked[0].id === 'd2']);
  cases.push(['rank: relevant doc has positive score',
    ranked[0] && ranked[0].score > 0]);
  cases.push(['rank: irrelevant doc excluded (score>0 filter)',
    !ranked.some(r => r.id === 'd1')]);
}

// rank: empty query / empty docs → []
cases.push(['rank: empty query → []', rank('', [{ id: 'x', text: 'hello world' }], 5).length === 0]);
cases.push(['rank: empty docs → []', rank('hello', [], 5).length === 0]);

// --- Privacy + smart-search tests (require DB) ---
// Set HOME to a fresh temp dir BEFORE requiring memory-db so the DB is isolated.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'semtest-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const memDB = require('../plugins/autodev-memory/scripts/memory-db');

if (!memDB.isAvailable()) {
  console.log('[skip] node:sqlite unavailable — skipping DB-backed privacy + smart-search tests');
} else {
  const PROJ = path.join(TMP_HOME, 'proj');
  const sid = memDB.startSession(PROJ);
  cases.push(['db: startSession returns id', typeof sid === 'string' && sid.length > 0]);

  // Observation with <private> content in EVERY user-controlled field:
  // title, concept, source_files (list entries), and nested rawData.
  // The sentinel LEAKME must appear in NONE of the persisted columns.
  const LEAK = 'LEAKME';
  const priv = `<private>${LEAK}</private>`;
  const oid = memDB.saveObservation({
    sessionId: sid,
    projectPath: PROJ,
    type: 'decision',
    title: `chose approach ${priv} here`,
    concept: `reasoning includes ${priv} details`,
    sourceFiles: [`src/${priv}.js`, 'a.js', `notes-${priv}.md`],
    rawData: { note: priv, nested: { deep: priv }, keep: 'visible' }
  });
  cases.push(['db: saveObservation returns id', typeof oid === 'string' && oid.length > 0]);

  const row = memDB.getObservation(oid);
  cases.push(['privacy: row read back', !!row]);
  // The sentinel must appear in NO persisted user-controlled field.
  const fields = row ? [row.title, row.concept, row.raw_data, row.source_files] : [];
  cases.push(['privacy: sentinel LEAKME appears in NO field (title/concept/raw_data/source_files)',
    !!row && fields.every(f => !(f || '').includes(LEAK))]);
  // Belt-and-suspenders: stringify the ENTIRE read-back row and confirm the
  // sentinel is absent from every column, not just the four we name above.
  cases.push(['privacy: sentinel absent from entire read-back row',
    !!row && !JSON.stringify(row).includes(LEAK)]);
  cases.push(['privacy: [REDACTED] present in title', row && row.title.includes('[REDACTED]')]);
  cases.push(['privacy: [REDACTED] present in concept', row && (row.concept || '').includes('[REDACTED]')]);
  cases.push(['privacy: [REDACTED] present in raw_data', row && (row.raw_data || '').includes('[REDACTED]')]);
  cases.push(['privacy: [REDACTED] present in source_files', row && (row.source_files || '').includes('[REDACTED]')]);
  cases.push(['privacy: non-private raw_data preserved', row && (row.raw_data || '').includes('visible')]);
  cases.push(['privacy: non-private source_files preserved', row && (row.source_files || '').includes('a.js')]);

  // Paraphrase observation: concept talks about "authentication", query is "login".
  // Neither FTS MATCH nor LIKE '%login%' hits it — only the synonym-aware ranker does.
  const paraId = memDB.saveObservation({
    sessionId: sid,
    projectPath: PROJ,
    type: 'feature',
    title: 'user access module',
    concept: 'handles authentication and credential verification'
  });
  cases.push(['db: paraphrase observation saved', typeof paraId === 'string']);

  const ftsHits = memDB.searchIndex('login', PROJ);
  cases.push(['smart: exact FTS misses the paraphrase (no "login" token)',
    !ftsHits.some(r => r.id === paraId)]);

  const smartHits = memDB.searchSmart('login', PROJ);
  cases.push(['smart: searchSmart finds paraphrase via semantic fallback',
    smartHits.some(r => r.id === paraId)]);

  const semHits = memDB.searchSemantic('login', PROJ);
  cases.push(['semantic: searchSemantic finds paraphrase directly',
    semHits.some(r => r.id === paraId)]);
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
