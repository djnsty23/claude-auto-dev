#!/usr/bin/env node
// The pinned-version table in setup-project is the one file here whose decay is
// invisible from inside the repo: it is internally consistent and externally
// wrong. Every other check reads the tree; this one reads the registry.
//
// Exit 1 on a MAJOR drift (a greenfield scaffold would inherit a stale major).
// Minor drift warns. A network failure is reported and exits 0 — a gate that
// fails an offline build teaches people to skip it.
//
// Prints the population it scanned, so "no drift" is distinguishable from
// "parsed nothing and said nothing".

const fs = require('fs');
const path = require('path');

// Overridable so the suite can point this at a fixture with a known-stale pin
// and watch it fail. A gate that has only ever been seen to pass is not a gate.
const TABLE = process.env.CLAUDE_VERSION_TABLE || path.join(
  __dirname, '..', 'plugins', 'autodev-core', 'skills',
  'setup-project', 'references', 'version-defaults.md',
);

// Rows look like: | next | ^16.3 | Stable… |
// Three shapes in the first column have to survive this: a parenthetical
// ("stripe (Node)"), a trailing role word ("shadcn CLI"), and two packages
// sharing a row ("react / react-dom"). The scoped-package slash in
// "@ai-sdk/react" must NOT split, which is why the split is @-guarded.
function parseTable(md) {
  const out = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m) continue;
    const col = m[1].replace(/\(.*?\)/g, '').replace(/\s+CLI\b/i, '').trim();
    const ver = m[2].trim();
    if (!col || col === 'Package' || /^-+$/.test(col)) continue;
    const num = /(\d+)(?:\.(\d+))?/.exec(ver);
    if (!num) continue;
    const names = col.startsWith('@') ? [col] : col.split('/').map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      out.push({ name, pinned: ver, major: Number(num[1]), minor: num[2] === undefined ? null : Number(num[2]) });
    }
  }
  return out;
}

// CLAUDE_VERSION_REGISTRY points at a JSON map of {name: version} and replaces
// the network entirely. The suite uses it: a drift check whose tests hit the
// real registry fails on a flaky connection and on nothing else, and under
// test-all's parallelism twenty suites' worth of concurrent fetches took the
// process down with a Windows abort rather than a verdict.
const FIXTURE = process.env.CLAUDE_VERSION_REGISTRY;
const fixtureVersions = FIXTURE ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : null;

async function latest(name) {
  if (fixtureVersions) {
    const v = fixtureVersions[name];
    if (!v) throw new Error('not in fixture registry');
    return v;
  }
  const res = await fetch('https://registry.npmjs.org/' + name.replace('/', '%2F') + '/latest');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).version;
}

(async () => {
  if (!fs.existsSync(TABLE)) {
    console.error('check:versions — cannot find ' + TABLE);
    process.exit(1);
  }
  const rows = parseTable(fs.readFileSync(TABLE, 'utf8'));
  if (rows.length < 5) {
    console.error(`check:versions — parsed only ${rows.length} rows from the table; the format changed and this check went blind`);
    process.exit(1);
  }

  const results = await Promise.all(rows.map(async (r) => {
    try { return { ...r, latest: await latest(r.name) }; }
    catch (err) { return { ...r, error: err.message }; }
  }));

  const failed = results.filter((r) => r.error);
  if (failed.length === results.length) {
    console.log(`check:versions — all ${results.length} lookups failed (${failed[0].error}); offline? not treating that as drift`);
    process.exit(0);
  }

  const majors = [], minors = [];
  for (const r of results) {
    if (r.error) continue;
    const [lMaj, lMin] = r.latest.split('.').map(Number);
    if (lMaj > r.major) majors.push(`${r.name}: pinned ${r.pinned}, latest ${r.latest}`);
    else if (r.minor !== null && lMaj === r.major && lMin > r.minor) minors.push(`${r.name}: pinned ${r.pinned}, latest ${r.latest}`);
  }

  console.log(`check:versions — ${results.length} packages in the table, ${results.length - failed.length} resolved, ${failed.length} unreachable`);
  if (failed.length) for (const f of failed) console.log(`  ? ${f.name}: ${f.error}`);
  for (const m of minors) console.log(`  minor  ${m}`);
  for (const m of majors) console.log(`  MAJOR  ${m}`);

  if (majors.length) {
    console.error(`\n${majors.length} package(s) a major behind. Re-verify by scaffolding on the new pins`);
    console.error('and running typecheck + build before editing the table — a bump nobody built is a guess.');
    process.exit(1);
  }
  console.log(minors.length ? '\nNo major drift. Minor bumps above are safe to take at leisure.' : '\nTable is current.');
})();
