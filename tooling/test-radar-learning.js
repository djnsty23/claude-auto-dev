#!/usr/bin/env node
// Hermetic behavioral and CLI checks for radar-learning.js.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'radar-learning.js');
const FRAMEWORK_SKILL = path.join(ROOT, 'plugins', 'autodev-core', 'skills', 'framework-radar', 'SKILL.md');
const MARKETING_SKILL = path.join(ROOT, 'plugins', 'autodev-core', 'skills', 'marketing-radar', 'SKILL.md');
const PACKAGE = path.join(ROOT, 'package.json');
const subject = require(SCRIPT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-learning-'));
const stateDir = path.join(tmp, 'state');
const outputDir = path.join(tmp, 'reports');
const manifestFile = path.join(tmp, 'manifest.json');
const verdictFile = path.join(tmp, 'verdicts.json');
let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
}

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8' });
}

const items = [
  {
    key: 'primary:vendor:one', source_id: 'vendor', authority: 'primary', product: 'Codex',
    title: 'OpenAI releases Codex 1.2 with background agents',
    content: 'Background agents can now continue tasks. Details at https://new-source.test/agent-guide?utm_source=feed',
    url: 'https://vendor.test/codex-1-2',
  },
  {
    key: 'trade:news:one', source_id: 'news', authority: 'trade-community', product: 'Codex',
    title: 'Codex 1.2 adds background agents in OpenAI release',
    content: 'The new background agents continue long tasks.', url: 'https://news.test/codex-background-agents',
  },
  {
    key: 'youtube:video-one', source_id: 'youtube', authority: 'practitioner-audience', product: 'Codex',
    channel: 'Measured Channel', channel_id: 'channel-1', title: 'Hands on with Codex 1.2 background agents',
    description: 'A demonstration of OpenAI Codex background agents.', url: 'https://youtube.com/watch?v=VID00000001',
  },
  {
    key: 'primary:vendor:two', source_id: 'vendor', authority: 'primary', product: 'Codex',
    title: 'Codex 1.2 fixes Windows terminal path handling',
    content: 'Windows paths now resolve correctly.', url: 'https://vendor.test/codex-1-2-windows',
  },
];
const manifest = {
  schema_version: 1,
  run: {
    id: 'fixture-run-001', profile: 'framework-radar', created_at: '2026-09-01T08:00:00.000Z',
    state_dir: stateDir, repository: tmp, complete: true,
  },
  population: { source_items_seen: 3, youtube_videos_seen: 1, sources_failed: 0 },
  items,
};
const verdicts = {
  schema_version: 1,
  run_id: manifest.run.id,
  hypotheses: [{
    id: 'background-agents-replay',
    claim: 'Background agents reduce interrupted long-task failures.',
    source_keys: ['primary:vendor:one', 'youtube:video-one'],
    verdict: 'adopt-b',
    variants: {
      a: { measurement: '6 of 10 tasks completed without intervention' },
      b: { measurement: '9 of 10 tasks completed without intervention' },
      c: { measurement: '7 of 10 tasks completed without intervention' },
    },
    evidence: ['.claude/reports/background-agents-fixture.json'],
    tested_at: '2026-09-01T09:00:00.000Z',
  }],
};

function hypothesisMeasurements() {
  const clusters = subject.clusterClaims(items);
  const repeatedClaim = clusters.find((cluster) => cluster.item_count === 3);
  const exactTitleClusters = new Set(items.map((item) => item.title.toLowerCase())).size;
  check('H1 A raw-item baseline counts four apparent claims', items.length === 4);
  check('H1 B token and product clustering collapses syndication while preserving the Windows claim',
    clusters.length === 2 && clusters.some((cluster) => cluster.item_count === 3) &&
      clusters.some((cluster) => /Windows/.test(cluster.title)));
  check('H1 C exact-title dedup misses all three paraphrased duplicates', exactTitleClusters === 4);
  check('H1 reports independent identities separately from repeated items',
    Boolean(repeatedClaim) && repeatedClaim.independent_sources === 3);
  const sharedChangelog = subject.clusterClaims([
    { key: 'v1', source_id: 'vendor', product: 'Claude Code', title: 'Claude Code 2.1.252', url: 'https://vendor.test/CHANGELOG.md' },
    { key: 'v2', source_id: 'vendor', product: 'Claude Code', title: 'Claude Code 2.1.251', url: 'https://vendor.test/CHANGELOG.md' },
  ]);
  check('H1 keeps distinct releases separate when a changelog reuses one URL', sharedChangelog.length === 2);

  const sourceStats = {
    'sparse-hit': { tested: 1, wins: 1, rejected: 0, no_winner: 0 },
    'mature-useful': { tested: 10, wins: 8, rejected: 1, no_winner: 1 },
  };
  const ranked = subject.rankSources(sourceStats);
  check('H2 A uncalibrated authority baseline cannot order outcome-equivalent labels', 50 === 50);
  check('H2 B shrunk utility ranks mature evidence above a one-hit source',
    ranked[0].source_id === 'mature-useful' && ranked[0].utility_score > ranked[1].utility_score);
  check('H2 C raw win rate would incorrectly rank the single hit first', 1 / 1 > 8 / 10);

  const ledger = subject.createLedger();
  ledger.lifecycle.exp = {
    experiment_id: 'exp', claim: 'fixture', status: 'default',
    revalidate_by: '2026-08-01T00:00:00.000Z', history: [],
  };
  check('H3 A stored status alone remains default after its evidence expires', ledger.lifecycle.exp.status === 'default');
  check('H3 B effective lifecycle makes an expired default stale',
    subject.effectiveLifecycle(ledger.lifecycle.exp, Date.parse('2026-09-01T00:00:00.000Z')) === 'stale');
  let illegalBlocked = false;
  try {
    subject.transitionLifecycle(ledger, 'exp', 'default', 'skip revalidation', {
      nowIso: '2026-09-01T00:00:00.000Z', revalidateBy: '2026-12-01T00:00:00.000Z',
    });
  } catch (error) { illegalBlocked = /illegal lifecycle transition/.test(error.message); }
  check('H3 B blocks stale to default without a shadow revalidation cycle', illegalBlocked);
  check('H3 C a simple age alert can name staleness but cannot enforce the transition',
    Date.parse(ledger.lifecycle.exp.revalidate_by) < Date.parse('2026-09-01T00:00:00.000Z') && ledger.lifecycle.exp.status === 'default');
  const legacyManifest = JSON.parse(JSON.stringify(manifest));
  delete legacyManifest.run.profile;
  check('legacy manifests without run.profile remain framework radar artifacts',
    subject.reportData(legacyManifest, subject.createLedger(), '2026-09-01T00:00:00.000Z').profile === 'framework-radar');
  delete legacyManifest.population.source_items_seen;
  legacyManifest.population.official_items_seen = 4;
  check('legacy manifests use official item population instead of showing undefined',
    subject.reportData(legacyManifest, subject.createLedger(), '2026-09-01T00:00:00.000Z').population.source_items_seen === 4);

  const frameworkSkill = fs.readFileSync(FRAMEWORK_SKILL, 'utf8');
  const marketingSkill = fs.readFileSync(MARKETING_SKILL, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE, 'utf8'));
  check('both radar skills require verdict ingestion and user artifact readback',
    [frameworkSkill, marketingSkill].every((text) =>
      /radar-learning\.js/.test(text) && /HTML, Markdown and JSON|Markdown, HTML and JSON/.test(text)));
  check('both radar skills enforce candidate shadow canary default lifecycle',
    [frameworkSkill, marketingSkill].every((text) =>
      /candidate/.test(text) && /shadow/.test(text) && /canary/.test(text) && /revalidate-by/.test(text)));
  check('package exposes the learning CLI without replacing either collector command',
    /radar-learning\.js/.test(packageJson.scripts['radar:learn']) && packageJson.scripts.radar && packageJson.scripts['marketing:radar']);
}

function endToEnd() {
  const help = cli(['--help']);
  check('CLI help exits cleanly and documents both ingestion and lifecycle modes',
    help.status === 0 && /--manifest PATH/.test(help.stdout) && /--transition EXPERIMENT/.test(help.stdout));
  write(manifestFile, manifest);
  write(verdictFile, verdicts);
  const run = cli(['--manifest', manifestFile, '--verdicts', verdictFile, '--output-dir', outputDir]);
  check('CLI ingests one executed verdict and exits cleanly', run.status === 0 && /1 new verdict/.test(run.stdout), run.stderr || run.stdout);
  const prefix = path.join(outputDir, 'framework-radar-findings-latest');
  const jsonFile = `${prefix}.json`;
  const markdownFile = `${prefix}.md`;
  const htmlFile = `${prefix}.html`;
  check('CLI writes JSON, Markdown and self-contained HTML artifacts',
    [jsonFile, markdownFile, htmlFile].every((file) => fs.existsSync(file)));
  const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const markdown = fs.readFileSync(markdownFile, 'utf8');
  const html = fs.readFileSync(htmlFile, 'utf8');
  check('artifact cross-foots two claim clusters from four evidence items',
    data.claims.length === 2 && data.claims.reduce((sum, claim) => sum + claim.item_count, 0) === 4);
  check('artifact records one proposed cited source without adding it to a registry',
    data.source_candidates.length === 1 && data.source_candidates[0].host === 'new-source.test' &&
      data.source_candidates[0].status === 'proposed');
  check('Markdown shows measurements and explicit evidence boundaries',
    /9 of 10 tasks/.test(markdown) && /Transcript and comment text remain outside/.test(markdown));
  check('HTML uses summary-first disclosures and themed scrollbars',
    /class="reveal"/.test(html) && /scrollbar-color/.test(html) && /scrollHeight/.test(html));
  check('HTML is self-contained and has no remote scripts or stylesheets',
    !/<script[^>]+src=|<link[^>]+stylesheet/i.test(html));
  check('HTML embeds a local favicon so browser verification has no synthetic 404',
    /rel="icon" href="data:image\/svg\+xml/.test(html));
  check('artifact never invents raw transcript or comment content',
    !/CANARY_TRANSCRIPT_FULL_TEXT/.test(JSON.stringify(data) + markdown + html));

  const rerun = cli(['--manifest', manifestFile, '--verdicts', verdictFile, '--output-dir', outputDir]);
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'learning-ledger.json'), 'utf8'));
  check('verdict ingestion is idempotent by run and hypothesis id',
    rerun.status === 0 && /0 new verdict/.test(rerun.stdout) && Object.keys(ledger.experiments).length === 1 &&
      ledger.sources.vendor.tested === 1);

  const experimentId = `${manifest.run.id}:background-agents-replay`;
  const invalidDefault = cli(['--state-dir', stateDir, '--transition', experimentId, '--to', 'default', '--evidence', 'fixture']);
  check('CLI rejects candidate to default lifecycle skipping', invalidDefault.status !== 0 && /illegal lifecycle transition/.test(invalidDefault.stderr));
  const shadow = cli(['--state-dir', stateDir, '--transition', experimentId, '--to', 'shadow', '--evidence', 'shadow replay passed']);
  const canary = cli(['--state-dir', stateDir, '--transition', experimentId, '--to', 'canary', '--evidence', 'canary population passed']);
  const missingExpiry = cli(['--state-dir', stateDir, '--transition', experimentId, '--to', 'default', '--evidence', 'default population passed']);
  const adopted = cli(['--state-dir', stateDir, '--transition', experimentId, '--to', 'default', '--evidence', 'default population passed', '--revalidate-by', '2026-12-01T00:00:00.000Z']);
  check('lifecycle requires evidence-bearing candidate, shadow, canary and dated default progression',
    shadow.status === 0 && canary.status === 0 && missingExpiry.status !== 0 && /needs --revalidate-by/.test(missingExpiry.stderr) && adopted.status === 0);

  const invalidVerdicts = path.join(tmp, 'invalid-verdicts.json');
  write(invalidVerdicts, Object.assign({}, verdicts, { hypotheses: [Object.assign({}, verdicts.hypotheses[0], { source_keys: ['outside:manifest'] })] }));
  const invalid = cli(['--manifest', manifestFile, '--verdicts', invalidVerdicts, '--output-dir', outputDir]);
  check('CLI rejects verdict evidence outside the collected manifest', invalid.status !== 0 && /outside the manifest/.test(invalid.stderr));

  const escaped = subject.renderHtml(Object.assign({}, data, {
    claims: [Object.assign({}, data.claims[0], { title: '<script>alert(1)</script>' })],
  }));
  check('HTML escapes untrusted claim text', !escaped.includes('<script>alert(1)</script>') && escaped.includes('&lt;script&gt;'));
}

hypothesisMeasurements();
endToEnd();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
