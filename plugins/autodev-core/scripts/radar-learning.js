#!/usr/bin/env node
/**
 * Radar Learning Layer
 *
 * Turns reviewed radar manifests and executed experiment verdicts into a
 * durable outcome ledger, claim clusters, source scorecards and human-readable
 * findings. Collection remains read-only; source candidates are proposals.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const DAY_MS = 86400000;
const VERDICTS = new Set(['adopt-b', 'adopt-c', 'no-winner', 'reject']);
const LIFECYCLE = new Set(['candidate', 'shadow', 'canary', 'default', 'retired']);
const TRANSITIONS = {
  candidate: new Set(['shadow', 'retired']),
  shadow: new Set(['candidate', 'canary', 'retired']),
  canary: new Set(['shadow', 'default', 'retired']),
  default: new Set(['shadow', 'retired']),
  stale: new Set(['shadow', 'retired']),
  retired: new Set([]),
};
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in',
  'is', 'it', 'new', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
  'adds', 'added', 'announces', 'announcement', 'arrives', 'launches', 'releases',
  'released', 'update', 'updated', 'version',
]);

function values(flag, argv = process.argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}

function value(flag, fallback, argv = process.argv) {
  const found = values(flag, argv);
  return found.length ? found[found.length - 1] : fallback;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data, 'utf8');
  fs.renameSync(temporary, file);
}

function cleanText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function claimTokens(item) {
  const title = cleanText(item.title);
  const text = (title || cleanText(item.content || item.description))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9._-]+/g, ' ');
  return new Set(text.split(/\s+/).filter((token) =>
    token.length > 1 && !STOPWORDS.has(token)).slice(0, 80));
}

function similarity(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(utm_|ref$|source$|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return cleanText(raw); }
}

function clusterClaims(items, threshold = 0.52) {
  const clusters = [];
  for (const item of items) {
    const tokens = claimTokens(item);
    const normalizedUrl = canonicalUrl(item.url);
    let best = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const sameProduct = item.product && cluster.products.has(item.product);
      const score = similarity(tokens, cluster.tokens);
      const matches = (sameProduct && score >= threshold) || score >= 0.62;
      if (matches && score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }
    if (!best) {
      best = {
        id: `claim-${String(clusters.length + 1).padStart(3, '0')}`,
        title: cleanText(item.title) || item.key,
        items: [], tokens: new Set(tokens), urls: new Set(), products: new Set(),
      };
      clusters.push(best);
    }
    best.items.push(item);
    for (const token of tokens) best.tokens.add(token);
    if (normalizedUrl) best.urls.add(normalizedUrl);
    if (item.product) best.products.add(item.product);
  }
  return clusters.map((cluster) => {
    const sourceIds = new Set(cluster.items.map(sourceIdentity));
    const authorities = new Set(cluster.items.map((item) => item.authority || item.kind || 'unknown'));
    return {
      id: cluster.id,
      title: cluster.title,
      item_keys: cluster.items.map((item) => item.key),
      item_count: cluster.items.length,
      independent_sources: sourceIds.size,
      source_ids: Array.from(sourceIds).sort(),
      authorities: Array.from(authorities).sort(),
      urls: Array.from(cluster.urls).sort(),
    };
  });
}

function sourceIdentity(item) {
  if (item.source_id !== 'youtube') return item.source_id || 'unknown';
  return `youtube:${cleanText(item.channel_id || item.channel || 'unknown').toLowerCase()}`;
}

function scoreSource(stats) {
  const tested = Number(stats.tested || 0);
  const wins = Number(stats.wins || 0);
  const posterior = (wins + 2) / (tested + 4);
  const confidence = tested / (tested + 5);
  return {
    tested,
    wins,
    rejected: Number(stats.rejected || 0),
    no_winner: Number(stats.no_winner || 0),
    posterior_win_rate: Number(posterior.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    utility_score: Number((50 + (posterior - 0.5) * confidence * 100).toFixed(2)),
  };
}

function rankSources(sourceStats) {
  return Object.entries(sourceStats || {}).map(([sourceId, stats]) =>
    Object.assign({ source_id: sourceId }, scoreSource(stats)))
    .sort((a, b) => b.utility_score - a.utility_score || b.tested - a.tested ||
      a.source_id.localeCompare(b.source_id));
}

function validateVerdictFile(input, manifest) {
  if (!input || input.schema_version !== SCHEMA_VERSION || !Array.isArray(input.hypotheses)) {
    throw new Error('verdict file must use schema_version 1 and hypotheses[]');
  }
  if (input.run_id !== manifest.run.id) throw new Error('verdict run_id does not match manifest');
  const itemKeys = new Set(manifest.items.map((item) => item.key));
  const ids = new Set();
  for (const hypothesis of input.hypotheses) {
    if (!hypothesis.id || ids.has(hypothesis.id)) throw new Error('hypothesis ids must be present and unique');
    ids.add(hypothesis.id);
    if (!VERDICTS.has(hypothesis.verdict)) throw new Error(`unsupported verdict for ${hypothesis.id}`);
    if (!hypothesis.claim || !Array.isArray(hypothesis.source_keys) || !hypothesis.source_keys.length) {
      throw new Error(`${hypothesis.id} needs a claim and non-empty source_keys`);
    }
    if (hypothesis.source_keys.some((key) => !itemKeys.has(key))) {
      throw new Error(`${hypothesis.id} cites a source_key outside the manifest`);
    }
    for (const variant of ['a', 'b', 'c']) {
      if (!hypothesis.variants || !hypothesis.variants[variant] ||
          typeof hypothesis.variants[variant].measurement !== 'string') {
        throw new Error(`${hypothesis.id} needs measured A, B and C variants`);
      }
    }
    if (!Array.isArray(hypothesis.evidence) || !hypothesis.evidence.length) {
      throw new Error(`${hypothesis.id} needs at least one evidence location`);
    }
  }
  return input;
}

function createLedger() {
  return { schema_version: SCHEMA_VERSION, experiments: {}, sources: {}, lifecycle: {} };
}

function ingestVerdicts(ledger, manifest, verdictInput, nowIso) {
  const next = JSON.parse(JSON.stringify(ledger || createLedger()));
  next.experiments = next.experiments || {};
  next.sources = next.sources || {};
  next.lifecycle = next.lifecycle || {};
  const itemsByKey = new Map(manifest.items.map((item) => [item.key, item]));
  let added = 0;
  for (const hypothesis of verdictInput.hypotheses) {
    const experimentId = `${manifest.run.id}:${hypothesis.id}`;
    if (next.experiments[experimentId]) continue;
    const sourceIds = Array.from(new Set(hypothesis.source_keys.map((key) => sourceIdentity(itemsByKey.get(key)))));
    next.experiments[experimentId] = Object.assign({}, hypothesis, {
      experiment_id: experimentId,
      profile: manifest.run.profile || 'framework-radar',
      source_ids: sourceIds,
      tested_at: hypothesis.tested_at || nowIso,
    });
    const won = hypothesis.verdict === 'adopt-b' || hypothesis.verdict === 'adopt-c';
    for (const sourceId of sourceIds) {
      const stats = next.sources[sourceId] || { tested: 0, wins: 0, rejected: 0, no_winner: 0 };
      stats.tested += 1;
      if (won) stats.wins += 1;
      if (hypothesis.verdict === 'reject') stats.rejected += 1;
      if (hypothesis.verdict === 'no-winner') stats.no_winner += 1;
      next.sources[sourceId] = stats;
    }
    if (won) {
      const adopted = hypothesis.verdict === 'adopt-b' ? 'b' : 'c';
      next.lifecycle[experimentId] = {
        experiment_id: experimentId,
        claim: hypothesis.claim,
        adopted_variant: adopted,
        status: 'candidate',
        changed_at: nowIso,
        history: [{ from: null, to: 'candidate', at: nowIso, evidence: hypothesis.evidence }],
      };
    }
    added += 1;
  }
  next.updated_at = nowIso;
  return { ledger: next, added };
}

function effectiveLifecycle(entry, nowMs = Date.now()) {
  if (entry.status === 'default' && entry.revalidate_by && Date.parse(entry.revalidate_by) < nowMs) return 'stale';
  return entry.status;
}

function transitionLifecycle(ledger, experimentId, to, evidence, options = {}) {
  if (!LIFECYCLE.has(to)) throw new Error(`unsupported lifecycle status: ${to}`);
  const entry = ledger.lifecycle && ledger.lifecycle[experimentId];
  if (!entry) throw new Error(`unknown lifecycle experiment: ${experimentId}`);
  const nowIso = options.nowIso || new Date().toISOString();
  const from = effectiveLifecycle(entry, Date.parse(nowIso));
  if (!TRANSITIONS[from] || !TRANSITIONS[from].has(to)) throw new Error(`illegal lifecycle transition: ${from} -> ${to}`);
  if (!cleanText(evidence)) throw new Error('lifecycle transition needs evidence');
  if (to === 'default' && !options.revalidateBy) throw new Error('default status needs --revalidate-by');
  entry.status = to;
  entry.changed_at = nowIso;
  if (to === 'default') entry.revalidate_by = new Date(options.revalidateBy).toISOString();
  if (to !== 'default') delete entry.revalidate_by;
  entry.history = entry.history || [];
  entry.history.push({ from, to, at: nowIso, evidence: [cleanText(evidence)] });
  ledger.updated_at = nowIso;
  return entry;
}

function extractUrls(text) {
  return Array.from(new Set((String(text || '').match(/https:\/\/[^\s<>()\]"']+/g) || [])
    .map((url) => url.replace(/[.,;:!?]+$/, ''))));
}

function collectSourceCandidates(manifest) {
  const known = new Set(manifest.items.map((item) => {
    try { return new URL(item.url).hostname.toLowerCase(); } catch { return ''; }
  }).filter(Boolean));
  const candidates = new Map();
  for (const item of manifest.items) {
    const text = `${item.content || ''}\n${item.description || ''}`;
    for (const url of extractUrls(text)) {
      let host;
      try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
      if (known.has(host) || /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) continue;
      const candidate = candidates.get(host) || { host, urls: new Set(), mentioned_by: new Set() };
      candidate.urls.add(canonicalUrl(url));
      candidate.mentioned_by.add(item.key);
      candidates.set(host, candidate);
    }
  }
  return Array.from(candidates.values()).map((candidate) => ({
    host: candidate.host,
    urls: Array.from(candidate.urls).sort(),
    mentions: candidate.mentioned_by.size,
    mentioned_by: Array.from(candidate.mentioned_by).sort(),
    status: 'proposed',
    requirement: 'validate provenance, feed stability and utility across three runs before registry addition',
  })).sort((a, b) => b.mentions - a.mentions || a.host.localeCompare(b.host));
}

function escapeHtml(input) {
  return String(input == null ? '' : input).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function markdownEscape(input) {
  return cleanText(input).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function reportData(manifest, ledger, nowIso) {
  const selectedProfile = manifest.run.profile || 'framework-radar';
  const population = Object.assign({}, manifest.population, {
    source_items_seen: Number.isFinite(manifest.population.source_items_seen)
      ? manifest.population.source_items_seen
      : Number(manifest.population.official_items_seen || 0),
  });
  const clusters = clusterClaims(manifest.items);
  const lifecycle = Object.values(ledger.lifecycle || {}).map((entry) =>
    Object.assign({}, entry, { effective_status: effectiveLifecycle(entry, Date.parse(nowIso)) }));
  const experiments = Object.values(ledger.experiments || {})
    .filter((entry) => entry.profile === selectedProfile)
    .sort((a, b) => String(b.tested_at).localeCompare(String(a.tested_at)));
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: nowIso,
    profile: selectedProfile,
    run: manifest.run,
    population,
    claims: clusters,
    source_scorecard: rankSources(ledger.sources),
    experiments,
    lifecycle,
    source_candidates: collectSourceCandidates(manifest),
    caveats: [
      'Repeated coverage is clustered as one underlying claim; independent source count is shown separately.',
      'Source utility is a shrunk historical outcome score, not a truth score or popularity score.',
      'Candidate sources are proposals only and are never added automatically.',
      'Transcript and comment text remain outside this artifact.',
    ],
  };
}

function renderMarkdown(data) {
  const lines = [
    `# ${data.profile} findings`, '',
    `Generated: ${data.generated_at}`, '',
    `Run: \`${data.run.id}\``, '',
    '## Summary', '',
    `- ${data.claims.length} underlying claim cluster(s) from ${data.population.source_items_seen} source item(s) and ${data.population.youtube_videos_seen} video(s).`,
    `- ${data.experiments.length} recorded experiment(s), ${data.lifecycle.filter((entry) => entry.effective_status === 'stale').length} stale default(s).`,
    `- ${data.source_scorecard.length} source(s) with measured outcomes, ${data.source_candidates.length} proposed source candidate(s).`, '',
    '## Claim clusters', '',
    '| Claim | Items | Independent sources | Authorities |', '|---|---:|---:|---|',
  ];
  for (const claim of data.claims) lines.push(`| ${markdownEscape(claim.title)} | ${claim.item_count} | ${claim.independent_sources} | ${claim.authorities.join(', ')} |`);
  lines.push('', '## Source outcome scorecard', '', '| Source | Tests | Wins | Posterior win rate | Utility |', '|---|---:|---:|---:|---:|');
  if (!data.source_scorecard.length) lines.push('| No measured outcomes yet | 0 | 0 | n/a | 50.00 |');
  for (const source of data.source_scorecard) lines.push(`| ${markdownEscape(source.source_id)} | ${source.tested} | ${source.wins} | ${(source.posterior_win_rate * 100).toFixed(1)}% | ${source.utility_score.toFixed(2)} |`);
  lines.push('', '## Experiment verdicts', '');
  if (!data.experiments.length) lines.push('No executed verdicts have been recorded for this profile yet.', '');
  for (const experiment of data.experiments) {
    lines.push(`### ${markdownEscape(experiment.claim)}`, '', `Verdict: **${experiment.verdict}**`, '',
      `- A: ${markdownEscape(experiment.variants.a.measurement)}`,
      `- B: ${markdownEscape(experiment.variants.b.measurement)}`,
      `- C: ${markdownEscape(experiment.variants.c.measurement)}`,
      `- Evidence: ${experiment.evidence.map(markdownEscape).join(', ')}`, '');
  }
  lines.push('## Adoption lifecycle', '', '| Improvement | Status | Revalidate by |', '|---|---|---|');
  if (!data.lifecycle.length) lines.push('| No adopted variants yet | n/a | n/a |');
  for (const entry of data.lifecycle) lines.push(`| ${markdownEscape(entry.claim)} | ${entry.effective_status} | ${entry.revalidate_by || 'n/a'} |`);
  lines.push('', '## Proposed source discoveries', '');
  if (!data.source_candidates.length) lines.push('No new cited source hosts were discovered in this run.', '');
  for (const candidate of data.source_candidates) lines.push(`- ${candidate.host}: ${candidate.mentions} independent mention(s), proposal only.`);
  lines.push('', '## Evidence boundaries', '');
  for (const caveat of data.caveats) lines.push(`- ${caveat}`);
  return lines.join('\n') + '\n';
}

function renderHtml(data) {
  const cards = data.claims.slice(0, 24).map((claim) => `
    <article class="card" data-open="false"><div class="card-head">
      <div class="chips"><span class="chip info">${claim.independent_sources} source${claim.independent_sources === 1 ? '' : 's'}</span><span class="chip mute">${claim.item_count} item${claim.item_count === 1 ? '' : 's'}</span></div>
      <h3>${escapeHtml(claim.title)}</h3><p class="summary">${escapeHtml(claim.authorities.join(', '))}</p></div>
      <div class="reveal"><div class="reveal-inner"><ul class="detail">
        <li>Evidence keys: ${escapeHtml(claim.item_keys.join(', '))}</li>
        <li>Independent identities: ${escapeHtml(claim.source_ids.join(', '))}</li>
        <li>Repeated coverage is not counted as independent proof.</li>
      </ul></div></div><button class="more" type="button" aria-expanded="false"><span class="caret"></span><span class="lbl-more">Evidence</span><span class="lbl-less">Less</span></button></article>`).join('');
  const rows = data.source_scorecard.length ? data.source_scorecard.map((source) => `<tr><td>${escapeHtml(source.source_id)}</td><td>${source.tested}</td><td>${source.wins}</td><td>${(source.posterior_win_rate * 100).toFixed(1)}%</td><td class="verdict v-safe">${source.utility_score.toFixed(2)}</td></tr>`).join('') : '<tr><td>No measured outcomes yet</td><td>0</td><td>0</td><td>n/a</td><td>50.00</td></tr>';
  const experimentCards = data.experiments.length ? data.experiments.map((experiment) => `<article class="card ${experiment.verdict === 'reject' ? 'is-warn' : ''}" data-open="false"><div class="card-head"><div class="chips"><span class="chip ${experiment.verdict.startsWith('adopt') ? 'safe' : 'warn'}">${escapeHtml(experiment.verdict)}</span></div><h3>${escapeHtml(experiment.claim)}</h3><p class="summary">Tested ${escapeHtml(experiment.tested_at)}</p></div><div class="reveal"><div class="reveal-inner"><ul class="detail"><li>A: ${escapeHtml(experiment.variants.a.measurement)}</li><li>B: ${escapeHtml(experiment.variants.b.measurement)}</li><li>C: ${escapeHtml(experiment.variants.c.measurement)}</li><li>Evidence: ${escapeHtml(experiment.evidence.join(', '))}</li></ul></div></div><button class="more" type="button" aria-expanded="false"><span class="caret"></span><span class="lbl-more">Measurements</span><span class="lbl-less">Less</span></button></article>`).join('') : '<p class="pullout">No executed verdicts have been recorded for this profile yet.</p>';
  const stale = data.lifecycle.filter((entry) => entry.effective_status === 'stale').length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%233ddc84'/%3E%3Cpath d='M9 16h14M16 9v14' stroke='%230d0f0e' stroke-width='3'/%3E%3C/svg%3E"><title>${escapeHtml(data.profile)} findings</title><style>
:root{--ground:#0d0f0e;--surface:#161a18;--raise:#1b201d;--well:#121614;--line:#252b28;--line-soft:#1e2421;--ink:#e9ede9;--ink-dim:#96a19b;--ink-faint:#69736e;--accent:#3ddc84;--warn:#f0b429;--safe:#3ddc84;--info:#7aa2f7;--scroll-track:#141816;--scroll-thumb:#333c37;--scroll-thumb-hi:#465149;--r:11px;--ease:cubic-bezier(.22,.61,.36,1)}
@media(prefers-color-scheme:light){:root{--ground:#fbfcfb;--surface:#fff;--raise:#f4f6f4;--well:#f2f5f3;--line:#e0e5e1;--line-soft:#ecefec;--ink:#121614;--ink-dim:#5a635e;--ink-faint:#858d88;--accent:#12894c;--warn:#a86a05;--safe:#12894c;--info:#3554a5;--scroll-track:#eceeec;--scroll-thumb:#c3c9c5;--scroll-thumb-hi:#a8b0aa}}
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--scroll-thumb) var(--scroll-track)}::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:var(--scroll-track)}::-webkit-scrollbar-thumb{background:var(--scroll-thumb);border-radius:999px;border:2px solid var(--scroll-track)}
body{margin:0;background:var(--ground);color:var(--ink);font:400 16px/1.62 system-ui,sans-serif;padding:0 24px 100px}.page{max-width:1040px;margin:auto}.masthead{padding:56px 0 38px;border-bottom:1px solid var(--line)}.meta,.eyebrow{font:600 11px/1 ui-monospace,monospace;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-faint)}h1{font-size:clamp(30px,4.5vw,49px);line-height:1.07;max-width:20ch;margin:18px 0}.standfirst{color:var(--ink-dim);max-width:68ch}.page>section{margin-top:68px}.eyebrow{display:flex;gap:14px;align-items:center;margin-bottom:22px}.eyebrow:after{content:"";height:1px;background:var(--line);flex:1}.count{color:var(--accent)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(272px,1fr));gap:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);display:flex;flex-direction:column;cursor:pointer}.card:hover{background:var(--raise)}.card-head{padding:20px 22px;display:flex;flex-direction:column;gap:11px}.chips{display:flex;gap:7px;flex-wrap:wrap}.chip{font:600 10px/1 ui-monospace,monospace;text-transform:uppercase;padding:5px 9px;border:1px solid var(--line);border-radius:999px;color:var(--ink-dim)}.chip.safe{color:var(--safe)}.chip.warn{color:var(--warn)}.chip.info{color:var(--info)}.card h3{margin:0;font-size:16.5px}.summary{margin:0;color:var(--ink-dim);font-size:14.5px}.reveal{max-height:0;overflow:hidden;transition:max-height .42s var(--ease)}.detail{margin:0;padding:0 22px 20px;list-style:none}.detail li{margin-top:10px;color:var(--ink-dim);font-size:14px}.more{margin:0 22px 18px;align-self:flex-start;border:0;background:none;color:var(--accent);font-weight:700;cursor:pointer}.lbl-less{display:none}.card[data-open=true] .lbl-more{display:none}.card[data-open=true] .lbl-less{display:inline}
.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:var(--r)}table{border-collapse:collapse;width:100%;min-width:640px}th,td{text-align:left;padding:13px 18px;border-bottom:1px solid var(--line-soft)}th{background:var(--raise);font:600 10px/1 ui-monospace,monospace;text-transform:uppercase;color:var(--ink-faint)}td{color:var(--ink-dim)}td:first-child{color:var(--ink)}.verdict{font:600 12px ui-monospace,monospace}.v-safe{color:var(--safe)}.pullout{border-left:2px solid var(--accent);padding-left:21px;color:var(--ink-dim)}.sources{margin-top:68px;padding-top:22px;border-top:1px solid var(--line);color:var(--ink-faint);font-size:12.5px}@media(max-width:640px){body{padding:0 17px 76px}.masthead{padding-top:36px}.page>section{margin-top:52px}}
</style></head><body><div class="page"><header class="masthead"><div class="meta">${escapeHtml(data.profile)} &middot; ${escapeHtml(data.generated_at)}</div><h1>What the radar found, tested, and learned</h1><p class="standfirst">${data.claims.length} underlying claims from ${data.population.source_items_seen} source items and ${data.population.youtube_videos_seen} videos. ${data.experiments.length} recorded experiments. ${stale} stale defaults.</p></header>
<section><div class="eyebrow">Underlying claims <span class="count">${data.claims.length}</span></div><div class="grid">${cards || '<p class="pullout">No claims were collected.</p>'}</div></section>
<section><div class="eyebrow">Source outcome scorecard <span class="count">${data.source_scorecard.length}</span></div><div class="tablewrap"><table><thead><tr><th>Source</th><th>Tests</th><th>Wins</th><th>Posterior win rate</th><th>Utility</th></tr></thead><tbody>${rows}</tbody></table></div></section>
<section><div class="eyebrow">Executed experiments <span class="count">${data.experiments.length}</span></div><div class="grid">${experimentCards}</div></section>
<section><p class="pullout"><strong>Boundaries:</strong> ${escapeHtml(data.caveats.join(' '))}</p></section><footer class="sources">Run ${escapeHtml(data.run.id)}. Raw transcripts and comments are deliberately excluded. Open the adjacent JSON artifact for machine-readable counts and evidence keys.</footer></div><script>
function toggle(card){var reveal=card.querySelector('.reveal'),inner=card.querySelector('.reveal-inner'),btn=card.querySelector('.more'),open=card.getAttribute('data-open')==='true';if(open){reveal.style.maxHeight=inner.scrollHeight+'px';void reveal.offsetHeight;reveal.style.maxHeight='0px'}else{reveal.style.maxHeight=inner.scrollHeight+'px'}card.setAttribute('data-open',open?'false':'true');if(btn)btn.setAttribute('aria-expanded',open?'false':'true')}
document.querySelectorAll('.card').forEach(function(card){card.addEventListener('click',function(event){if(event.target.closest('a'))return;var selection=window.getSelection();if(selection&&selection.toString())return;toggle(card)})});addEventListener('resize',function(){document.querySelectorAll('.card[data-open=true]').forEach(function(card){card.querySelector('.reveal').style.maxHeight=card.querySelector('.reveal-inner').scrollHeight+'px'})});
</script></body></html>`;
}

function writeArtifacts(outputDir, data) {
  const prefix = `${data.profile}-findings-latest`;
  const files = {
    json: path.join(outputDir, `${prefix}.json`),
    markdown: path.join(outputDir, `${prefix}.md`),
    html: path.join(outputDir, `${prefix}.html`),
  };
  writeAtomic(files.json, JSON.stringify(data, null, 2));
  writeAtomic(files.markdown, renderMarkdown(data));
  writeAtomic(files.html, renderHtml(data));
  return files;
}

function loadManifest(file) {
  const manifest = readJson(file, null);
  if (!manifest || manifest.schema_version !== 1 || !manifest.run || !Array.isArray(manifest.items)) {
    throw new Error('manifest must be a framework-radar schema_version 1 file');
  }
  return manifest;
}

function help() {
  console.log('usage: node radar-learning.js --manifest PATH [--verdicts PATH] [--output-dir PATH]\n' +
    '       node radar-learning.js --state-dir PATH --transition EXPERIMENT --to STATUS --evidence TEXT [--revalidate-by ISO]\n\n' +
    'Outputs latest findings as JSON, Markdown and self-contained HTML under .claude/reports by default.');
}

function main(argv = process.argv) {
  if (argv.includes('--help')) return help();
  const stateOverride = value('--state-dir', null, argv);
  const transitionId = value('--transition', null, argv);
  if (transitionId) {
    if (!stateOverride) throw new Error('--transition requires --state-dir');
    const ledgerFile = path.join(path.resolve(stateOverride), 'learning-ledger.json');
    const ledger = readJson(ledgerFile, null);
    if (!ledger) throw new Error('learning ledger not found');
    const entry = transitionLifecycle(ledger, transitionId, value('--to', '', argv), value('--evidence', '', argv), {
      revalidateBy: value('--revalidate-by', null, argv),
    });
    writeAtomic(ledgerFile, JSON.stringify(ledger, null, 2));
    console.log(`transitioned ${transitionId} to ${entry.status}`);
    return;
  }
  const manifestFile = value('--manifest', null, argv);
  if (!manifestFile) throw new Error('--manifest is required');
  const manifest = loadManifest(path.resolve(manifestFile));
  const stateDir = path.resolve(stateOverride || manifest.run.state_dir);
  const ledgerFile = path.join(stateDir, 'learning-ledger.json');
  let ledger = readJson(ledgerFile, createLedger());
  const verdictFile = value('--verdicts', null, argv);
  let added = 0;
  const nowIso = new Date().toISOString();
  if (verdictFile) {
    const verdictInput = validateVerdictFile(readJson(path.resolve(verdictFile), null), manifest);
    const result = ingestVerdicts(ledger, manifest, verdictInput, nowIso);
    ledger = result.ledger;
    added = result.added;
    writeAtomic(ledgerFile, JSON.stringify(ledger, null, 2));
  }
  const outputDir = path.resolve(value('--output-dir', path.join(process.cwd(), '.claude', 'reports'), argv));
  const files = writeArtifacts(outputDir, reportData(manifest, ledger, nowIso));
  console.log(`learning: ${added} new verdict(s), ${Object.keys(ledger.experiments || {}).length} total experiment(s)`);
  console.log(`findings markdown: ${files.markdown}`);
  console.log(`findings html: ${files.html}`);
  console.log(`findings json: ${files.json}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`radar learning failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = {
  claimTokens,
  clusterClaims,
  collectSourceCandidates,
  createLedger,
  effectiveLifecycle,
  ingestVerdicts,
  rankSources,
  renderHtml,
  renderMarkdown,
  reportData,
  scoreSource,
  transitionLifecycle,
  validateVerdictFile,
  writeArtifacts,
};
