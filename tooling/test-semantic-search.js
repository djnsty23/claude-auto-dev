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


  // Private spans are boundaries, not paired-regex matches. These expected
  // strings are literal independent controls; no expected value calls a redactor.
  const privacyCases = [
    ['unclosed', 'PUBLIC<private>UNCLOSED_SECRET', 'PUBLIC[REDACTED]', ['UNCLOSED_SECRET']],
    ['nested', 'LEFT<private>OUTER_SECRET<private>INNER_SECRET</private>TAIL_SECRET</private>RIGHT', 'LEFT[REDACTED]RIGHT', ['OUTER_SECRET', 'INNER_SECRET', 'TAIL_SECRET']],
    ['nested-unclosed', 'LEFT<private>OUTER_OPEN<private>INNER_OPEN</private>TAIL_OPEN', 'LEFT[REDACTED]', ['OUTER_OPEN', 'INNER_OPEN', 'TAIL_OPEN']],
    ['uppercase', 'LEFT<PRIVATE>UPPER_SECRET</PRIVATE>RIGHT', 'LEFT[REDACTED]RIGHT', ['UPPER_SECRET']],
    ['mixed-case', 'LEFT<PrIvAtE>MIXED_SECRET</pRiVaTe>RIGHT', 'LEFT[REDACTED]RIGHT', ['MIXED_SECRET']],
    ['multiple', 'A<private>FIRST_SECRET</private>B<private>SECOND_SECRET</private>C', 'A[REDACTED]B[REDACTED]C', ['FIRST_SECRET', 'SECOND_SECRET']],
    ['stray-close-control', 'PUBLIC</private>TAIL', 'PUBLIC</private>TAIL', []],
    ['literal-lookalike-control', 'PUBLIC<privateer>TAIL', 'PUBLIC<privateer>TAIL', []],
  ];
  for (const [label, text, expected, secrets] of privacyCases) {
    const privacySid = memDB.startSession(PROJ);
    const privacyId = memDB.saveObservation({
      sessionId: privacySid, projectPath: PROJ, type: 'discovery',
      title: `${label}: ${text}`, concept: text,
      sourceFiles: [text, 'src/public-control.js'],
      rawData: { note: text, nested: { deep: text }, keep: 'PUBLIC_RAW', [text]: 'PUBLIC_KEY_VALUE' },
    });
    const saved = privacyId && memDB.getObservation(privacyId);
    cases.push([`privacy ${label}: saves a real observation`, !!saved]);
    cases.push([`privacy ${label}: protected markers absent and public text preserved`,
      !!saved && saved.title === `${label}: ${expected}` && saved.concept === expected &&
      secrets.every(secret => !JSON.stringify(saved).includes(secret))]);
    let raw = null, files = null;
    try { raw = JSON.parse(saved.raw_data); files = JSON.parse(saved.source_files); } catch { /* fails below */ }
    cases.push([`privacy ${label}: JSON boundaries and public siblings survive`,
      !!raw && !!files && raw.note === expected && raw.nested.deep === expected &&
      raw.keep === 'PUBLIC_RAW' && raw[expected] === 'PUBLIC_KEY_VALUE' &&
      files[0] === expected && files[1] === 'src/public-control.js']);
    memDB.endSession(privacySid, { request: text, investigated: text, learned: text, completed: text, nextSteps: text });
    const { DatabaseSync } = require('node:sqlite');
    const fixtureDB = new DatabaseSync(path.join(TMP_HOME, '.claude', 'auto-dev-memory.db'), { readOnly: true });
    const summary = fixtureDB.prepare('SELECT user_request, investigated, learned, completed, next_steps FROM sessions WHERE id=?').get(privacySid);
    fixtureDB.close();
    cases.push([`privacy ${label}: all session summary fields use the same boundary`,
      !!summary && Object.values(summary).every(value => value === expected)]);
  }

  // JSON string values remain independent: an unclosed private value must not
  // consume another key, corrupt JSON, or make unrelated data disappear.
  const boundaryId = memDB.saveObservation({ sessionId: sid, projectPath: PROJ, type: 'change',
    title: 'serialized-boundary-control', sourceFiles: ['src/<private>PATH_SECRET', 'src/keep.js'],
    rawData: { before: 'visible', hidden: '<private>VALUE_SECRET', after: 'still-visible', quote: 'a "quote" and \\ slash' } });
  const boundary = boundaryId && memDB.getObservation(boundaryId);
  let boundaryRaw = null, boundaryFiles = null;
  try { boundaryRaw = JSON.parse(boundary.raw_data); boundaryFiles = JSON.parse(boundary.source_files); } catch { /* fails below */ }
  cases.push(['privacy: unclosed serialized field keeps valid JSON and unrelated keys',
    !!boundaryRaw && boundaryRaw.hidden === '[REDACTED]' && boundaryRaw.after === 'still-visible' &&
    boundaryRaw.before === 'visible' && boundaryRaw.quote === 'a "quote" and \\ slash']);
  cases.push(['privacy: unclosed source-file entry preserves later public entries',
    !!boundaryFiles && boundaryFiles[0] === 'src/[REDACTED]' && boundaryFiles[1] === 'src/keep.js']);

  // A failed redaction/serialization must reject the write, not fall back to
  // original content or echo a protected error payload. Fault injection is
  // scoped to this process and restored before subsequent semantic tests.
  for (const failure of ['parse', 'serialize']) {
    const beforeCount = memDB.getStats(PROJ).totalObservations;
    const realParse = JSON.parse, realWrite = process.stderr.write;
    let diagnostics = '';
    let rejected;
    process.stderr.write = (chunk) => { diagnostics += String(chunk); return true; };
    try {
      if (failure === 'parse') JSON.parse = () => { throw new Error('<private>PARSE_SECRET</private>'); };
      const rawData = failure === 'serialize'
        ? { toJSON() { throw new Error('<private>SERIALIZE_SECRET</private>'); } }
        : { note: '<private>PARSE_SECRET' };
      rejected = memDB.saveObservation({ sessionId: sid, projectPath: PROJ, type: 'change',
        title: `privacy-error-${failure}`, sourceFiles: ['src/control.js'], rawData });
    } finally {
      JSON.parse = realParse;
      process.stderr.write = realWrite;
    }
    cases.push([`privacy ${failure} error: no partial or original-content write`,
      rejected === null && memDB.getStats(PROJ).totalObservations === beforeCount]);
    cases.push([`privacy ${failure} error: reports failure without protected diagnostics`,
      diagnostics.includes('[Memory] DB error') && !diagnostics.includes('PARSE_SECRET') && !diagnostics.includes('SERIALIZE_SECRET')]);
  }

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
// --- gaps found by check:vacuity -------------------------------------------

// tokenize drops stopwords AND one-character tokens. `t.length > 1 && !STOP`
// mutated to `||` keeps both, and every downstream score is then dominated by
// "the", "and" and stray letters — the ranking still returns something, so it
// looks like it works.
cases.push(['tokenize drops stopwords', !tokenize('the auth and the token').includes('the')]);
cases.push(['tokenize drops one-character tokens', !tokenize('a b auth').some((t) => t.length < 2)]);
cases.push(['  but keeps the real words', tokenize('the auth and the token').includes('auth')]);

// expandQuery dedups by STEM, not by surface form. `if (!seen.has(s))` forced
// true emits a term once per source token, which silently weights whichever
// concept the user happened to phrase twice.
cases.push(['expandQuery does not repeat a stem', (() => {
  const out = expandQuery(['deploying', 'deployed', 'deploys']);
  return new Set(out).size === out.length;
})()]);

// rank's input guards. Each mutated to `&&` lets a bad call through into the
// scoring loop instead of returning [].
cases.push(['rank returns [] for an empty query', rank('', [{ id: 1, text: 'auth' }]).length === 0]);
cases.push(['rank returns [] for no docs', rank('auth', []).length === 0]);
cases.push(['rank returns [] when docs is not an array', rank('auth', null).length === 0]);

// Document frequency must START at zero for an unseen term. `(df.get(t) || 0)`
// mutated to `&&` yields undefined + 1 = NaN, which poisons every idf and makes
// every score NaN — and NaN > 0 is false, so rank silently returns NOTHING
// rather than failing loudly.
cases.push(['rank still scores when a term is unique to one doc', (() => {
  const out = rank('kubernetes', [
    { id: 'a', text: 'kubernetes rollout strategy' },
    { id: 'b', text: 'billing invoice totals' },
  ]);
  return out.length > 0 && out[0].id === 'a' && Number.isFinite(out[0].score) && out[0].score > 0;
})()]);

cases.forEach(([label, ok]) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  ok ? pass++ : fail++;
});
console.log(`\n${pass} passed, ${fail} failed`);

// Cleanup
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
