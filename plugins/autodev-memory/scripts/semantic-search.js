#!/usr/bin/env node
// semantic-search.js — pure-JS lexical-semantic ranker (zero deps, offline, deterministic)
//
// This is NOT neural embeddings. It is a TF-IDF token-similarity ranker with a
// conservative stemmer and a small dev-domain synonym expansion. It complements
// SQLite FTS5 exact search by giving fuzzy/conceptual recall when exact matches
// are sparse. No DB, no HOME, no network — safe to require from anywhere.

// Small English stopword set — enough to strip noise without dropping signal.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'this', 'that', 'from',
  'have', 'has', 'had', 'not', 'but', 'you', 'your', 'our', 'their', 'its',
  'they', 'them', 'then', 'than', 'into', 'onto', 'out', 'off', 'over', 'under',
  'why', 'how', 'what', 'when', 'where', 'who', 'which', 'did', 'does', 'done',
  'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must', 'shall',
  'a', 'an', 'as', 'at', 'be', 'by', 'do', 'if', 'in', 'is', 'it', 'of', 'on',
  'or', 'so', 'to', 'up', 'we', 'us', 'me', 'my', 'he', 'she', 'his', 'her'
]);

// Bidirectional dev-domain synonym map. Kept small and deliberate.
const SYNONYM_GROUPS = [
  ['auth', 'authentication', 'login'],
  ['db', 'database'],
  ['config', 'configuration'],
  ['deploy', 'deployment'],
  ['fix', 'bugfix'],
  ['ui', 'interface'],
  ['deps', 'dependencies']
];

// Build a lookup: token → set of all synonyms (including itself).
const SYNONYMS = (() => {
  const map = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      const set = map.get(word) || new Set();
      for (const other of group) set.add(other);
      map.set(word, set);
    }
  }
  return map;
})();

// tokenize: lowercase, alnum runs, drop stopwords and 1-char tokens.
function tokenize(text) {
  if (!text) return [];
  const matches = String(text).toLowerCase().match(/[a-z0-9]+/g);
  if (!matches) return [];
  return matches.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// stem: conservative suffix stripper with length guards. Not full Porter.
function stem(word) {
  if (!word || typeof word !== 'string') return word;
  let w = word;
  // Order matters: longest / most specific suffixes first.
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('edly')) return w.slice(0, -4);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ly')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

// expandQuery: expand tokens with synonyms (both directions), then stem all.
// Returns a de-duplicated, stemmed token list.
function expandQuery(tokens) {
  if (!Array.isArray(tokens)) return [];
  const expanded = new Set();
  for (const tok of tokens) {
    expanded.add(tok);
    const syns = SYNONYMS.get(tok);
    if (syns) for (const s of syns) expanded.add(s);
  }
  const out = [];
  const seen = new Set();
  for (const tok of expanded) {
    const s = stem(tok);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// Turn a list of stemmed tokens into a term-frequency map.
function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

// rank: TF-IDF cosine similarity between expanded/stemmed query and each doc.
// docs = [{ id, text, ...passthrough }]. Returns top `limit` with score > 0.
function rank(query, docs, limit = 20) {
  if (!query || !Array.isArray(docs) || docs.length === 0) return [];

  const queryTokens = expandQuery(tokenize(query));
  if (queryTokens.length === 0) return [];

  // Stem each doc's tokens once.
  const docTokenLists = docs.map((d) => tokenize(d && d.text).map(stem));

  // Document frequency across the passed docs.
  const df = new Map();
  for (const tokens of docTokenLists) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length;
  const idf = (term) => Math.log((N + 1) / ((df.get(term) || 0) + 1)) + 1;

  // Build the query TF-IDF vector.
  const qtf = termFreq(queryTokens);
  const qVec = new Map();
  let qNorm = 0;
  for (const [term, freq] of qtf) {
    const w = freq * idf(term);
    qVec.set(term, w);
    qNorm += w * w;
  }
  qNorm = Math.sqrt(qNorm);
  if (qNorm === 0) return [];

  const scored = [];
  for (let i = 0; i < docs.length; i++) {
    const dtf = termFreq(docTokenLists[i]);
    let dot = 0;
    let dNorm = 0;
    for (const [term, freq] of dtf) {
      const w = freq * idf(term);
      dNorm += w * w;
      if (qVec.has(term)) dot += w * qVec.get(term);
    }
    dNorm = Math.sqrt(dNorm);
    const score = dNorm === 0 ? 0 : dot / (qNorm * dNorm);
    if (score > 0) scored.push({ ...docs[i], score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit));
}

module.exports = { tokenize, stem, expandQuery, rank };
