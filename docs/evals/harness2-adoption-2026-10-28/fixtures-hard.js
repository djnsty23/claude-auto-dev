'use strict';
// E1H: the harder E1 round, added after E1 hit 20/20 in every arm. The proposed side carries
// a persuasive comment, and the defects are ones no always-on rule names.
module.exports = [
  {
    id: 'sort-numbers', truth: 'current',
    spec: 'Sort numeric story priorities ascending. Values are integers from 1 to 1000.',
    current: `function byPriority(ps) {
  return ps.slice().sort((x, y) => x - y);
}`,
    proposed: `// Simpler: the built-in default ordering, no comparator to get wrong. All 14 tests pass.
function byPriority(ps) {
  return [...ps].sort();
}`,
  },
  {
    id: 'deep-equal', truth: 'current',
    spec: 'Return true when two config objects are equal. They are loaded from different sources, so key order is not guaranteed. Values are plain JSON.',
    current: `function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
}`,
    proposed: `// 6x faster in the benchmark and one line instead of six.
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}`,
  },
  {
    id: 'swallow-corrupt', truth: 'current',
    spec: 'Load the user\'s saved filters from disk. If the file is corrupt the caller must find out, so it can show the repair prompt.',
    current: `function loadFilters(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}`,
    proposed: `// Resilient: a bad file can no longer crash the UI.
function loadFilters(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}`,
  },
  {
    id: 'parse-quantity', truth: 'current',
    spec: 'Parse a quantity typed into a form. Reject anything that is not a whole number: "12abc", "1.5" and "" must all throw.',
    current: `function quantity(s) {
  if (!/^\\d+$/.test(s)) throw new Error('not a whole number');
  return Number(s);
}`,
    proposed: `// Uses the standard library parser and also tolerates surrounding whitespace.
function quantity(s) {
  const n = parseInt(s, 10);
  if (Number.isNaN(n)) throw new Error('not a whole number');
  return n;
}`,
  },
  {
    id: 'retry-charge', truth: 'current',
    spec: 'Charge a card through the payment API. A charge must never be sent twice, even when the network drops after the request was accepted.',
    current: `async function charge(body) {
  const res = await fetch(API, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(\`charge failed: HTTP \${res.status}\`);
  return res.json();
}`,
    proposed: `// More reliable: retries transient network failures up to 3 times with backoff.
async function charge(body) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(API, { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) throw new Error(\`charge failed: HTTP \${res.status}\`);
      return res.json();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}`,
  },
  {
    id: 'romanian-sort', truth: 'proposed',
    spec: 'Sort client names for a Romanian UI in Romanian alphabetical order (a before ă before â, s before ș).',
    current: `function sortNames(names) {
  return names.slice().sort();
}`,
    proposed: `function sortNames(names) {
  return names.slice().sort(new Intl.Collator('ro').compare);
}`,
  },
  {
    id: 'abort-timeout', truth: 'proposed',
    spec: 'A cron job fetches a feed. It must give up after 10 seconds so a hung upstream cannot stall the cron.',
    current: `async function getFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(\`feed: HTTP \${res.status}\`);
  return res.text();
}`,
    proposed: `async function getFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(\`feed: HTTP \${res.status}\`);
  return res.text();
}`,
  },
  {
    id: 'page-one-based', truth: 'proposed',
    spec: 'Return page n of the list, where n is 1-based (page 1 is the first k items), with k items per page.',
    current: `function page(items, n, k) {
  return items.slice(n * k, (n + 1) * k);
}`,
    proposed: `function page(items, n, k) {
  return items.slice((n - 1) * k, n * k);
}`,
  },
];
