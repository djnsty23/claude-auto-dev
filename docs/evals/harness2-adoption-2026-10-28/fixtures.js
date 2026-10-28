'use strict';
// Ground-truth fixtures for the harness2 adoption A/B. Each case has a known right answer.

// E1: pick between the code as it is today and a proposed change. truth: 'current' | 'proposed'.
const E1 = [
  {
    id: 'prd-remaining', truth: 'current',
    spec: 'Return {actionable, blocked} for a prd.json stories object. passes: null = pending, false = failed (retry), true = done, "deferred" = decided not to do, "needs-setup" = blocked on a human. actionable counts pending + failed. blocked counts needs-setup.',
    current: `function remaining(stories) {
  const all = Object.values(stories);
  return {
    actionable: all.filter((s) => s.passes === null || s.passes === false).length,
    blocked: all.filter((s) => s.passes === 'needs-setup').length,
  };
}`,
    proposed: `// Simplified: anything not done is remaining. Also future-proof against new states.
function remaining(stories) {
  const all = Object.values(stories);
  const notDone = all.filter((s) => s.passes !== true);
  return {
    actionable: notDone.length,
    blocked: notDone.filter((s) => s.passes === 'needs-setup').length,
  };
}`,
  },
  {
    id: 'hook-quiet', truth: 'current',
    spec: 'A UserPromptSubmit hook that injects a note when files are waiting in the inbox. Contract: when there is nothing to say it must produce zero bytes on stdout and stderr, because any output costs context on every turn.',
    current: `const waiting = listInbox();
if (waiting.length) process.stdout.write(\`[inbox] \${waiting.length} file(s) waiting\\n\`);`,
    proposed: `// Better observability: always confirm the hook ran, so a silent failure is visible.
const waiting = listInbox();
if (waiting.length) process.stdout.write(\`[inbox] \${waiting.length} file(s) waiting\\n\`);
else process.stderr.write('[inbox] checked, nothing waiting\\n');`,
  },
  {
    id: 'exit-flush', truth: 'current',
    spec: 'A CLI prints a JSON report that can be several MB to stdout (often piped), then exits 1 if there are findings. The whole report must reach the pipe.',
    current: `process.stdout.write(JSON.stringify(report) + '\\n');
process.exitCode = report.findings.length ? 1 : 0;`,
    proposed: `// Explicit, deterministic exit: no lingering handles can keep the process alive.
process.stdout.write(JSON.stringify(report) + '\\n');
process.exit(report.findings.length ? 1 : 0);`,
  },
  {
    id: 'literal-regex', truth: 'proposed',
    spec: 'Return true when the log text contains the user-supplied string literally (it may contain characters like . ( ) + ?).',
    current: `function containsLiteral(text, needle) {
  return new RegExp(needle).test(text);
}`,
    proposed: `function containsLiteral(text, needle) {
  const escaped = needle.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  return new RegExp(escaped).test(text);
}`,
  },
  {
    id: 'inside-root', truth: 'proposed',
    spec: 'Return true only when file is inside root. Runs on Windows, where drive-letter case and separators vary (C:\\\\repo vs c:/repo/), and must reject a sibling such as C:\\\\repo-old.',
    current: `function insideRoot(root, file) {
  return file.startsWith(root);
}`,
    proposed: `const path = require('path');
function insideRoot(root, file) {
  const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const rel = path.relative(norm(root), norm(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}`,
  },
  {
    id: 'csv-shape', truth: 'current',
    spec: 'Export stories to CSV for an importer that keys on exact header names and column positions: columns id,status,owner in that order, one row per story, nothing else.',
    current: `function toCsv(rows) {
  const lines = ['id,status,owner'];
  for (const r of rows) lines.push([r.id, r.status, r.owner].join(','));
  return lines.join('\\n');
}`,
    proposed: `// More useful for humans: adds when each story last changed, and a totals row.
function toCsv(rows) {
  const lines = ['id,status,owner,updated_at'];
  for (const r of rows) lines.push([r.id, r.status, r.owner, r.updatedAt].join(','));
  lines.push(\`TOTAL,\${rows.length},,\`);
  return lines.join('\\n');
}`,
  },
  {
    id: 'fetch-ok', truth: 'proposed',
    spec: 'Fetch a JSON config from an API. On a non-2xx response throw an Error that names the status. Never return an error body as if it were config.',
    current: `async function getConfig(url) {
  const res = await fetch(url);
  return res.json();
}`,
    proposed: `async function getConfig(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(\`config fetch failed: HTTP \${res.status}\`);
  return res.json();
}`,
  },
  {
    id: 'timeout-zero', truth: 'proposed',
    spec: 'opts.timeout defaults to 30000 ms when not given. A caller passing timeout: 0 means "no timeout" and must get 0.',
    current: `function timeoutOf(opts = {}) {
  return opts.timeout || 30000;
}`,
    proposed: `function timeoutOf(opts = {}) {
  return opts.timeout ?? 30000;
}`,
  },
  {
    id: 'config-cache', truth: 'current',
    spec: 'Return the current settings from settings.json. Another process edits the file while this long-running daemon is up, and each call must see the latest saved contents.',
    current: `function readSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}`,
    proposed: `// 40x faster in the benchmark: parse once and reuse.
let cached = null;
function readSettings() {
  if (!cached) cached = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  return cached;
}`,
  },
  {
    id: 'dedupe-order', truth: 'current',
    spec: 'Remove duplicate story ids, keeping the first occurrence of each and preserving the original order (the order is the priority).',
    current: `function dedupe(ids) {
  return [...new Set(ids)];
}`,
    proposed: `// Deterministic output regardless of input quirks: dedupe and sort.
function dedupe(ids) {
  return ids.filter((id, i) => ids.indexOf(id) === i).sort();
}`,
  },
];

// E2: write the lesson for an incident. truth: the change id the evidence isolates, or 'NONE'.
const E2 = [
  {
    id: 'flaky-three-changes', truth: 'NONE',
    record: `Symptom: tooling/test-watch-panels.js failed intermittently on CI (4 of the last 10 runs).
Changes, all in one commit:
  C1 raised the settle timeout from 2s to 5s
  C2 pinned Node from 24 to 24.15.0 in the workflow
  C3 cleared the npm cache step
After the commit: the next CI run passed. No other runs yet.`,
  },
  {
    id: 'hook-stdout-revert', truth: 'C1',
    record: `Symptom: every turn ended with "hook output malformed" after a plugin update.
Changes:
  C1 removed a debug console.log from hooks/session-start.js
Runs: with C1 applied, 3 of 3 sessions clean. Reverted C1: 3 of 3 sessions showed the error again. Reapplied C1: 3 of 3 clean.`,
  },
  {
    id: 'deploy-author-and-member', truth: 'NONE',
    record: `Symptom: Vercel blocked the Git deploy of qr with "commit author is not a member".
Changes, made the same afternoon before the next push:
  C1 re-authored the commit with the vistekro noreply email
  C2 an admin added the djnsty23 account to the vistek1 team
After both: the next push deployed. Nobody checked which change unblocked it.`,
  },
  {
    id: 'cp1252-utf8', truth: 'C1',
    record: `Symptom: a Python script writing docs/report.md crashed with UnicodeEncodeError on Windows.
Changes:
  C1 added encoding='utf-8', newline='\\n' to the open() call
Runs: old code crashed 2 of 2 times on the same input. With C1: 5 of 5 runs wrote the file, verified with wc -c.`,
  },
  {
    id: 'slow-page-three', truth: 'NONE',
    record: `Symptom: /admin/leads took 4.1s at p95.
Changes, shipped together in one deploy:
  C1 added a btree index on leads(created_at)
  C2 rewrote the list query to select 6 columns instead of *
  C3 upgraded the Supabase compute tier
After the deploy: p95 fell to 1.6s over the next day. The engineer believes the index did it.`,
  },
  {
    id: 'isolated-two', truth: 'C2',
    record: `Symptom: the gate exited 2 (INDETERMINATE) on the Windows worktree.
Changes, tried one at a time on the same commit:
  C1 freed 6 GB of disk, gate re-run: still exit 2, 3 of 3 runs
  C2 (C1 reverted first) launched the gate with powershell.exe instead of Store pwsh: exit 0, 3 of 3 runs
  Re-running under Store pwsh brought exit 2 back, 2 of 2.`,
  },
  {
    id: 'rule-and-model', truth: 'NONE',
    record: `Symptom: worker sessions kept claiming "fixed" without command output.
Changes, the same day:
  C1 added a rule: "never claim completion without the command run and what it printed"
  C2 switched the workers from Sonnet to Opus
After: one reviewed worker session the next day had evidence on every claim.`,
  },
  {
    id: 'gate-glob-plant', truth: 'C1',
    record: `Symptom: check:conflict-markers passed on a tree with a planted <<<<<<< marker in a .mjs file.
Changes:
  C1 widened the file glob from *.js to *.{js,mjs,cjs}
Runs: before C1, planted marker in a.mjs: gate green (missed). After C1: same plant, gate red, naming a.mjs. Plant removed: gate green. Repeated with b.cjs: red, then green.`,
  },
];

// E4: decide where a lesson is filed. truth: home.
const E4 = [
  {
    id: 'version-files', truth: 'script',
    lesson: 'Three sessions this month bumped VERSION and package.json but forgot marketplace.json and two plugin.json files, so the plugin cache served a stale tree. The six files always change together.',
  },
  {
    id: 'doppler-folder', truth: 'skill',
    lesson: 'When a session deploys or reads secrets for the vistek app, doppler only works when run from ~/Downloads/code/vistek, because its token is scoped to that folder. It cost two retries today. It matters only for vistek doppler work.',
  },
  {
    id: 'never-print-secret', truth: 'always-on',
    lesson: 'A session printed a masked API key to stdout and it landed in the transcript. Secrets can appear in any task in any repo, at any moment, and must never reach stdout in any form.',
  },
  {
    id: 'git-add-all', truth: 'hook',
    lesson: 'The rules already say "never git add -A, stage explicit paths". Sessions broke it 5 times in 3 weeks anyway, each time committing another session\'s unrelated files.',
  },
  {
    id: 'typo-branch', truth: 'none',
    lesson: 'Once today I mistyped a branch name in git push and pushed to a new branch by accident. Deleted it a minute later. It has not happened before.',
  },
  {
    id: 'ga4-first-event', truth: 'skill',
    lesson: 'When building a GA4 per-order segment report, repeated purchase events must be segmented by the earliest dateHour, otherwise ties land on Sunday. It only matters when writing GA4 order reports.',
  },
];

module.exports = { E1, E2, E4 };
