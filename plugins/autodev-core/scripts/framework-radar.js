#!/usr/bin/env node
/**
 * Framework Radar
 *
 * Deterministic intake for official changes and relevant YouTube videos. It
 * collects and deduplicates evidence; a profile-specific skill owns judgement
 * and controlled experimentation.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA_VERSION = 1;
const USER_AGENT = 'autodev-framework-radar/1.0';
const DEFAULT_CONFIG = path.join(__dirname, 'framework-radar-sources.json');
const RELEVANT_TERMS = [
  'claude', 'codex', 'agent', 'agents', 'workflow', 'skill', 'skills', 'hook',
  'hooks', 'automation', 'automations', 'mcp', 'worktree', 'prompt', 'context',
  'memory', 'plugin', 'plugins', 'review', 'test', 'testing', 'permissions',
];

function values(flag) {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out;
}

function value(flag, fallback) {
  const found = values(flag);
  return found.length ? found[found.length - 1] : fallback;
}

function positiveInt(flag, fallback, max) {
  const raw = value(flag, String(fallback));
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${flag} must be an integer from 1 to ${max}`);
  }
  return parsed;
}

function hash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function clip(input, max = 20000) {
  const text = String(input || '').trim();
  return text.length <= max ? text : text.slice(0, max) + '\n[truncated]';
}

function decodeEntities(input) {
  return String(input || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtml(input) {
  return decodeEntities(input)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function tag(block, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  return match ? decodeEntities(match[1]).trim() : '';
}

function isPrereleaseTitle(title) {
  return /(?:^|[.@/_-])(?:alpha|beta|rc|preview|nightly|canary|dev)(?:[.\d_-]|$)|\d+b\d+(?:\b|$)/i
    .test(String(title));
}

function parseAtom(xml, source, cutoffMs) {
  const entries = String(xml).match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const block of entries) {
    const title = stripHtml(tag(block, 'title'));
    if (source.excludePrereleases && isPrereleaseTitle(title)) continue;
    const id = tag(block, 'id') || title;
    const updated = tag(block, 'updated') || tag(block, 'published');
    const when = Date.parse(updated);
    if (Number.isFinite(when) && when < cutoffMs) continue;
    const linkMatch = /<link\b[^>]*href="([^"]+)"[^>]*>/i.exec(block);
    const url = linkMatch ? decodeEntities(linkMatch[1]) : source.webUrl;
    const content = clip(stripHtml(tag(block, 'content') || tag(block, 'summary')));
    out.push({
      key: `official:${source.id}:${id}`,
      source_id: source.id,
      kind: 'official',
      category: source.category || 'uncategorized',
      product: source.product,
      title,
      url,
      published_at: Number.isFinite(when) ? new Date(when).toISOString() : null,
      content,
      content_hash: hash([title, content, updated].join('\n')),
    });
    if (out.length >= source.maxEntries) break;
  }
  return out;
}

function parseRss(xml, source, cutoffMs) {
  const entries = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const block of entries) {
    const title = stripHtml(tag(block, 'title'));
    const id = tag(block, 'guid') || tag(block, 'link') || title;
    const published = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'date');
    const when = Date.parse(published);
    if (Number.isFinite(when) && when < cutoffMs) continue;
    const url = stripHtml(tag(block, 'link')) || source.webUrl;
    const content = clip(stripHtml(tag(block, 'content:encoded') || tag(block, 'description')));
    out.push({
      key: `official:${source.id}:${id}`,
      source_id: source.id,
      kind: 'official',
      category: source.category || 'uncategorized',
      product: source.product,
      title,
      url,
      published_at: Number.isFinite(when) ? new Date(when).toISOString() : null,
      content,
      content_hash: hash([title, content, published].join('\n')),
    });
    if (out.length >= source.maxEntries) break;
  }
  return out;
}

function parseMarkdownChangelog(markdown, source, cutoffMs) {
  const lines = String(markdown).split(/\r?\n/);
  const sections = [];
  let current = null;
  const headingPattern = source.headingPattern
    ? new RegExp(source.headingPattern, 'i')
    : /^v?\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    const headingText = heading ? stripHtml(heading[1]).trim() : '';
    if (heading && headingPattern.test(headingText)) {
      if (current) sections.push(current);
      current = { version: headingText, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  const unique = sections.filter((section, index) =>
    sections.findIndex((candidate) => candidate.version === section.version) === index);
  return unique.filter((section) => {
    if (!source.headingDates || !cutoffMs) return true;
    const when = Date.parse(`1 ${section.version} UTC`);
    return !Number.isFinite(when) || when >= cutoffMs;
  }).slice(0, source.maxEntries).map((section) => {
    const content = clip(section.lines.join('\n'));
    const parsedDate = source.headingDates ? Date.parse(`1 ${section.version} UTC`) : NaN;
    return {
      key: `official:${source.id}:${section.version}`,
      source_id: source.id,
      kind: 'official',
      category: source.category || 'uncategorized',
      product: source.product,
      title: `${source.product} ${section.version}`,
      url: source.webUrl,
      published_at: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null,
      content,
      content_hash: hash([section.version, content].join('\n')),
    };
  });
}

function commandExists(command) {
  const probe = process.platform === 'win32'
    ? spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
    : spawnSync('which', [command], { encoding: 'utf8' });
  return probe.status === 0;
}

function runner(command, packageName) {
  if (commandExists(command)) return { command, prefix: [] };
  if (commandExists('uvx')) return { command: 'uvx', prefix: ['--from', packageName, command] };
  return null;
}

function run(invocation, args, timeoutMs = 180000) {
  const result = spawnSync(invocation.command, invocation.prefix.concat(args), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

async function fetchText(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, label) {
  const text = await fetchText(url, label);
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON`); }
}

async function expandCaptionPlaylist(body, baseUrl, getText = fetchText, depth = 0) {
  if (!/^\s*#EXTM3U\b/i.test(body)) return body;
  if (depth >= 3) throw new Error('YouTube caption playlist nesting exceeded three levels');
  const segmentUrls = String(body).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => new URL(line, baseUrl).toString());
  if (!segmentUrls.length) throw new Error('YouTube caption playlist contained no segments');
  const segments = [];
  for (const url of segmentUrls) {
    const segment = await getText(url, 'YouTube caption segment');
    segments.push(await expandCaptionPlaylist(segment, url, getText, depth + 1));
  }
  return segments.join('\n');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function parseUploadDate(raw) {
  if (raw.timestamp) return new Date(Number(raw.timestamp) * 1000).toISOString();
  if (raw.release_timestamp) return new Date(Number(raw.release_timestamp) * 1000).toISOString();
  if (/^\d{8}$/.test(String(raw.upload_date || ''))) {
    const d = String(raw.upload_date);
    return new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`).toISOString();
  }
  const candidate = raw.published_at || raw.publishedAt;
  const parsed = Date.parse(candidate || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function captionSources(raw) {
  const result = [];
  for (const [kind, group] of [['manual', raw.subtitles], ['generated', raw.automatic_captions]]) {
    if (!group || typeof group !== 'object') continue;
    const language = ['en', 'en-US', 'en-GB'].find((code) => Array.isArray(group[code]));
    if (!language) continue;
    const tracks = group[language];
    const chosen = tracks.find((track) => track.ext === 'vtt') || tracks.find((track) => track.ext === 'json3') || tracks[0];
    if (chosen && chosen.url) result.push({ kind, language, ext: chosen.ext || 'txt', url: chosen.url });
  }
  return result;
}

function normalizeVideo(raw, searchRank, pinned) {
  const id = raw.id || raw.video_id || (raw.url && /v=([\w-]{11})/.exec(raw.url) || [])[1];
  if (!id) return null;
  return {
    key: `youtube:${id}`,
    source_id: 'youtube',
    kind: 'youtube',
    id,
    title: String(raw.title || ''),
    description: clip(raw.description || '', 5000),
    url: raw.webpage_url || raw.url || `https://www.youtube.com/watch?v=${id}`,
    channel: raw.channel || raw.uploader || raw.channelTitle || null,
    channel_id: raw.channel_id || raw.channelId || null,
    published_at: parseUploadDate(raw),
    duration_seconds: Number(raw.duration || raw.duration_seconds || 0) || null,
    views: Number(raw.view_count || raw.views || 0) || 0,
    likes: Number(raw.like_count || raw.likes || 0) || 0,
    search_rank: searchRank || null,
    pinned: Boolean(pinned),
    _captions: captionSources(raw),
  };
}

function relevance(video, relevantTerms = RELEVANT_TERMS) {
  const haystack = `${video.title} ${video.description}`.toLowerCase();
  return relevantTerms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
}

function scoreVideos(videos, nowMs, discoveryDays, relevantTerms = RELEVANT_TERMS) {
  for (const video of videos) {
    const published = Date.parse(video.published_at || '');
    const ageDays = Number.isFinite(published) ? Math.max(1, (nowMs - published) / 86400000) : discoveryDays;
    const velocity = video.views / ageDays;
    const rel = relevance(video, relevantTerms);
    const freshness = Math.max(0, 1 - ageDays / discoveryDays);
    video.age_days = Math.round(ageDays * 10) / 10;
    video.view_velocity = Math.round(velocity);
    video.relevance_terms = rel;
    video.radar_score = Math.round((rel * 10 + Math.log10(velocity + 1) * 4 +
      Math.log10(video.views + 1) * 2 + freshness * 3 + (video.pinned ? 100 : 0)) * 100) / 100;
  }
  const top = (field) => videos.slice().sort((a, b) => b[field] - a[field]).slice(0, 5).map((v) => v.id);
  return {
    raw_views: top('views'),
    view_velocity: top('view_velocity'),
    relevance: top('relevance_terms'),
    balanced: top('radar_score'),
  };
}

async function officialSources(config, fixtureDir, cutoffMs) {
  const statuses = [];
  const items = [];
  for (const source of config.official || []) {
    try {
      const raw = fixtureDir
        ? fs.readFileSync(path.join(fixtureDir, `${source.id}.txt`), 'utf8')
        : await fetchText(source.url, source.id);
      const parsed = source.kind === 'atom'
        ? parseAtom(raw, source, cutoffMs)
        : source.kind === 'rss'
          ? parseRss(raw, source, cutoffMs)
          : parseMarkdownChangelog(raw, source, cutoffMs);
      items.push(...parsed);
      statuses.push({ id: source.id, category: source.category || 'uncategorized', status: 'ok', count: parsed.length });
    } catch (error) {
      statuses.push({ id: source.id, category: source.category || 'uncategorized', status: 'error', count: 0, error: clip(error.message, 240) });
    }
  }
  return { statuses, items };
}

function parseJsonLines(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* warnings belong on stderr; ignore stray stdout */ }
  }
  return rows;
}

async function discoverWithApi(config, apiKey, cutoffIso, maxVideos, pinnedIds, getJson = fetchJson) {
  const candidates = new Map();
  for (const query of config.queries) {
    const params = new URLSearchParams({
      part: 'snippet', type: 'video', q: query, maxResults: String(config.perQuery),
      order: 'relevance', publishedAfter: cutoffIso, videoCaption: 'closedCaption', key: apiKey,
    });
    const data = await getJson(`https://www.googleapis.com/youtube/v3/search?${params}`, 'YouTube search');
    let rank = 0;
    for (const item of data.items || []) {
      rank += 1;
      const id = item.id && item.id.videoId;
      if (!id) continue;
      const prior = candidates.get(id);
      if (!prior || rank < prior.rank) candidates.set(id, { id, rank });
    }
  }
  for (const id of pinnedIds) candidates.set(id, { id, rank: 0, pinned: true });
  const selected = Array.from(candidates.values()).slice(0, maxVideos);
  if (!selected.length) return [];
  const params = new URLSearchParams({
    part: 'snippet,statistics,contentDetails,status',
    id: selected.map((row) => row.id).join(','),
    key: apiKey,
  });
  const data = await getJson(`https://www.googleapis.com/youtube/v3/videos?${params}`, 'YouTube details');
  return (data.items || []).map((item) => {
    const meta = selected.find((row) => row.id === item.id) || {};
    return normalizeVideo({
      id: item.id,
      title: item.snippet && item.snippet.title,
      description: item.snippet && item.snippet.description,
      channelTitle: item.snippet && item.snippet.channelTitle,
      channelId: item.snippet && item.snippet.channelId,
      publishedAt: item.snippet && item.snippet.publishedAt,
      views: item.statistics && item.statistics.viewCount,
      likes: item.statistics && item.statistics.likeCount,
    }, meta.rank, meta.pinned);
  }).filter(Boolean);
}

async function discoverWithYtDlp(config, maxVideos, pinnedIds, execute = run, resolve = runner,
  relevantTerms = RELEVANT_TERMS) {
  const invocation = resolve('yt-dlp', 'yt-dlp');
  if (!invocation) throw new Error('neither yt-dlp nor uvx is available');
  const candidates = new Map();
  const current = new Date();
  const month = current.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const year = current.getUTCFullYear();
  for (const query of config.queries) {
    const count = config.perQuery;
    const encoded = encodeURIComponent(query).replace(/%20/g, '+');
    const lanes = [
      { target: `ytsearch${count}:${query}`, recent: false, temporal: false },
      { target: `https://www.youtube.com/results?search_query=${encoded}&sp=CAI%253D`, recent: true, temporal: false },
      { target: `ytsearch${count}:${query} ${month} ${year}`, recent: true, temporal: true },
    ];
    for (const lane of lanes) {
      const result = execute(invocation, [
        '--flat-playlist', '--dump-json', '--no-warnings', '--playlist-end', String(count),
        lane.target,
      ]);
      const rows = parseJsonLines(result.stdout);
      if (!rows.length && result.status !== 0) throw new Error(`yt-dlp search failed with exit ${result.status}`);
      rows.forEach((row, index) => {
        if (!row.id) return;
        const prior = candidates.get(row.id);
        const rank = index + 1;
        if (!prior || rank < prior.rank) candidates.set(row.id, {
          row,
          rank,
          recentLane: lane.recent || Boolean(prior && prior.recentLane),
          temporalLane: lane.temporal || Boolean(prior && prior.temporalLane),
        });
        else {
          if (lane.recent) prior.recentLane = true;
          if (lane.temporal) prior.temporalLane = true;
        }
      });
    }
  }
  for (const id of pinnedIds) {
    if (!candidates.has(id)) candidates.set(id, { row: { id }, rank: 0, pinned: true });
    else candidates.get(id).pinned = true;
  }
  const prelim = Array.from(candidates.values()).sort((a, b) => {
    const ar = relevance(normalizeVideo(a.row, a.rank, a.pinned) || { title: '', description: '' }, relevantTerms);
    const br = relevance(normalizeVideo(b.row, b.rank, b.pinned) || { title: '', description: '' }, relevantTerms);
    const av = Number(a.row.view_count || 0), bv = Number(b.row.view_count || 0);
    return (b.pinned ? 1000 : 0) + (b.temporalLane ? 50 : 0) + (b.recentLane ? 25 : 0) + br * 10 + Math.log10(bv + 1) -
      ((a.pinned ? 1000 : 0) + (a.temporalLane ? 50 : 0) + (a.recentLane ? 25 : 0) + ar * 10 + Math.log10(av + 1));
  }).slice(0, maxVideos);
  if (!prelim.length) return [];
  const urls = prelim.map((candidate) => `https://www.youtube.com/watch?v=${candidate.row.id}`);
  const details = execute(invocation, ['--dump-json', '--skip-download', '--no-warnings'].concat(urls));
  const rows = parseJsonLines(details.stdout);
  if (!rows.length) throw new Error(`yt-dlp details failed with exit ${details.status}`);
  return rows.map((row) => {
    const meta = prelim.find((candidate) => candidate.row.id === row.id) || {};
    return normalizeVideo(row, meta.rank, meta.pinned);
  }).filter(Boolean);
}

function transcriptKind(listOutput) {
  const manualBlock = /\(MANUALLY CREATED\)([\s\S]*?)(?:\n\s*\(GENERATED\)|$)/i.exec(listOutput);
  const manual = manualBlock && /\n\s*-\s+en(?:\s|\()/i.test(manualBlock[1]);
  const generatedBlock = /\(GENERATED\)([\s\S]*?)(?:\n\s*\(TRANSLATION|$)/i.exec(listOutput);
  const generated = generatedBlock && /\n\s*-\s+en(?:\s|\()/i.test(generatedBlock[1]);
  return manual ? 'manual' : generated ? 'generated' : 'unknown';
}

async function extractTranscript(video, fixtureDir, stateDir) {
  const transcriptDir = path.join(stateDir, 'transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });
  if (fixtureDir) {
    const fixture = path.join(fixtureDir, `transcript-${video.id}.json`);
    if (!fs.existsSync(fixture)) return { status: 'unavailable', error: 'fixture transcript absent' };
    const segments = readJson(fixture, []);
    const text = segments.map((segment) => segment.text || '').join(' ').trim();
    const destination = path.join(transcriptDir, `${video.id}.json`);
    writeAtomic(destination, JSON.stringify({ video_id: video.id, language: 'en', kind: 'fixture', segments }, null, 2));
    return { status: 'ok', provider: 'fixture', kind: 'fixture', language: 'en', chars: text.length, content_hash: hash(text), path: destination };
  }

  const invocation = runner('youtube_transcript_api', 'youtube-transcript-api');
  if (invocation) {
    const listed = run(invocation, [video.id, '--list-transcripts']);
    const fetched = run(invocation, [video.id, '--languages', 'en', '--format', 'json']);
    if (fetched.status === 0) {
      try {
        const segments = JSON.parse(fetched.stdout);
        const text = segments.map((segment) => segment.text || '').join(' ').trim();
        if (text) {
          const destination = path.join(transcriptDir, `${video.id}.json`);
          const kind = transcriptKind(listed.stdout);
          writeAtomic(destination, JSON.stringify({ video_id: video.id, language: 'en', kind, segments }, null, 2));
          return { status: 'ok', provider: 'youtube-transcript-api', kind, language: 'en', chars: text.length, content_hash: hash(text), path: destination };
        }
      } catch { /* try caption URL fallback */ }
    }
  }

  const source = (video._captions || [])[0];
  if (source) {
    try {
      const fetched = await fetchText(source.url, 'YouTube caption');
      const body = await expandCaptionPlaylist(fetched, source.url);
      if (body.trim()) {
        const destination = path.join(transcriptDir, `${video.id}.${source.ext}`);
        writeAtomic(destination, body);
        return { status: 'ok', provider: 'yt-dlp-caption-url', kind: source.kind, language: source.language, chars: body.length, content_hash: hash(body), path: destination };
      }
    } catch { /* report one stable error below */ }
  }
  return { status: 'unavailable', error: 'no English transcript could be retrieved' };
}

async function youtubeSource(config, fixtureDir, options, cutoffMs, stateDir) {
  try {
    let videos;
    let provider;
    if (fixtureDir) {
      const rows = readJson(path.join(fixtureDir, 'youtube.json'), []);
      videos = rows.map((row, index) => normalizeVideo(row, index + 1, Boolean(row.pinned))).filter(Boolean);
      provider = 'fixture';
    } else if (process.env.YOUTUBE_API_KEY) {
      videos = await discoverWithApi(config, process.env.YOUTUBE_API_KEY,
        new Date(cutoffMs).toISOString(), options.maxVideos, options.pinnedIds);
      provider = 'youtube-data-api';
    } else {
      videos = await discoverWithYtDlp(config, options.maxVideos, options.pinnedIds, run, runner,
        options.relevantTerms);
      provider = 'yt-dlp-search';
    }
    const discoveryDays = Number(config.discoveryDays || options.days);
    videos = videos.filter((video) => video.pinned || !video.published_at || Date.parse(video.published_at) >= cutoffMs);
    if (!videos.length) throw new Error('discovery returned zero videos in the requested window');
    const ranking = scoreVideos(videos, Date.now(), discoveryDays, options.relevantTerms);
    const selected = videos.slice().sort((a, b) => b.radar_score - a.radar_score).slice(0, options.maxTranscripts);
    const transcripts = new Map();
    for (const video of selected) transcripts.set(video.id, await extractTranscript(video, fixtureDir, stateDir));
    for (const video of videos) {
      video.transcript = transcripts.get(video.id) || { status: 'not-selected' };
      const stable = [video.title, video.description, video.channel, video.published_at,
        video.transcript.content_hash || 'no-transcript'].join('\n');
      video.content_hash = hash(stable);
      delete video._captions;
    }
    return {
      status: { id: 'youtube', status: 'ok', count: videos.length, provider },
      videos,
      ranking,
      transcripts_attempted: selected.length,
      transcripts_succeeded: selected.filter((video) => transcripts.get(video.id).status === 'ok').length,
    };
  } catch (error) {
    return {
      status: { id: 'youtube', status: 'error', count: 0, error: clip(error.message, 240) },
      videos: [], ranking: { raw_views: [], view_velocity: [], relevance: [], balanced: [] },
      transcripts_attempted: 0, transcripts_succeeded: 0,
    };
  }
}

function reviewState(state, item) {
  const prior = state.reviewed && state.reviewed[item.key];
  return !prior || prior.content_hash !== item.content_hash;
}

function profile(config) {
  const raw = config.profile || {};
  return {
    id: raw.id || 'framework-radar',
    label: raw.label || 'framework radar',
    outputPrefix: raw.outputPrefix || 'framework-radar-input',
    stateDirName: raw.stateDirName || 'autodev-framework-radar',
    relevantTerms: Array.isArray(raw.relevantTerms) && raw.relevantTerms.length
      ? raw.relevantTerms.map((term) => String(term).toLowerCase())
      : RELEVANT_TERMS,
  };
}

function defaultStateDir(selectedProfile) {
  return process.env.AUTODEV_RADAR_HOME ||
    path.join(os.homedir(), '.codex', selectedProfile.stateDirName);
}

function manifestOutputPath(selectedProfile) {
  const date = new Date().toISOString().slice(0, 10);
  return path.resolve(process.cwd(), '.claude', 'reports', `${selectedProfile.outputPrefix}-${date}.json`);
}

function loadConfig(file) {
  const config = readJson(file, null);
  if (!config || !Array.isArray(config.official) || !config.youtube || !Array.isArray(config.youtube.queries)) {
    throw new Error('config must define official[] and youtube.queries[]');
  }
  for (const source of config.official) {
    if (!source.id || !source.kind || !source.product || !source.maxEntries) throw new Error('each official source needs id, kind, product and maxEntries');
  }
  return config;
}

async function collect() {
  const configFile = path.resolve(value('--config', DEFAULT_CONFIG));
  const config = loadConfig(configFile);
  const selectedProfile = profile(config);
  const options = {
    days: positiveInt('--days', 14, 365),
    maxVideos: positiveInt('--max-videos', 20, 50),
    maxTranscripts: positiveInt('--max-transcripts', 5, 10),
    pinnedIds: values('--video').map((input) => (/[?&]v=([\w-]{11})/.exec(input) || /^([\w-]{11})$/.exec(input) || [])[1]).filter(Boolean),
    relevantTerms: selectedProfile.relevantTerms,
  };
  const fixtureDirRaw = value('--fixture-dir', null);
  const fixtureDir = fixtureDirRaw ? path.resolve(fixtureDirRaw) : null;
  const stateDir = path.resolve(value('--state-dir', defaultStateDir(selectedProfile)));
  const output = path.resolve(value('--output', manifestOutputPath(selectedProfile)));
  const cutoffMs = Date.now() - options.days * 86400000;
  const stateFile = path.join(stateDir, 'state.json');
  const state = readJson(stateFile, { schema_version: SCHEMA_VERSION, reviewed: {}, pending_runs: {} });

  const official = await officialSources(config, fixtureDir, cutoffMs);
  const youtube = await youtubeSource(config.youtube, fixtureDir, options, cutoffMs, stateDir);
  const items = official.items.concat(youtube.videos);
  for (const item of items) item.requires_review = reviewState(state, item);

  const statuses = official.statuses.concat(youtube.status);
  const ok = statuses.filter((row) => row.status === 'ok').length;
  const partial = statuses.filter((row) => row.status === 'partial').length;
  const failed = statuses.filter((row) => row.status === 'error').length;
  const officialCategories = {};
  for (const item of official.items) {
    officialCategories[item.category] = (officialCategories[item.category] || 0) + 1;
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    run: {
      id: runId,
      profile: selectedProfile.id,
      created_at: new Date().toISOString(),
      days: options.days,
      repository: process.cwd(),
      state_dir: stateDir,
      complete: failed === 0,
    },
    population: {
      sources_configured: statuses.length,
      sources_succeeded: ok,
      sources_partial: partial,
      sources_failed: failed,
      official_items_seen: official.items.length,
      official_categories_seen: officialCategories,
      youtube_videos_seen: youtube.videos.length,
      transcripts_attempted: youtube.transcripts_attempted,
      transcripts_succeeded: youtube.transcripts_succeeded,
      items_requiring_review: items.filter((item) => item.requires_review).length,
    },
    sources: statuses,
    ranking_variants: youtube.ranking,
    items,
  };
  writeAtomic(output, JSON.stringify(manifest, null, 2));
  fs.mkdirSync(stateDir, { recursive: true });
  state.last_collect_at = manifest.run.created_at;
  state.pending_runs = state.pending_runs || {};
  state.pending_runs[runId] = { manifest: output, created_at: manifest.run.created_at };
  writeAtomic(stateFile, JSON.stringify(state, null, 2));

  console.log(`${selectedProfile.label}: ${ok} succeeded, ${partial} partial, ${failed} failed of ${statuses.length} source(s)`);
  console.log(`population: ${official.items.length} official item(s), ${youtube.videos.length} YouTube video(s), ` +
    `${youtube.transcripts_succeeded}/${youtube.transcripts_attempted} transcript(s), ` +
    `${manifest.population.items_requiring_review} item(s) requiring review`);
  for (const status of statuses.filter((row) => row.status !== 'ok')) {
    console.log(`COULD NOT CHECK ${status.id}: ${status.error || status.status}`);
  }
  console.log(`manifest: ${output}`);
  process.exitCode = ok + partial > 0 ? 0 : 1;
}

function markReviewed(manifestFile) {
  const manifest = readJson(path.resolve(manifestFile), null);
  if (!manifest || manifest.schema_version !== SCHEMA_VERSION || !manifest.run || !Array.isArray(manifest.items)) {
    throw new Error('refusing to mark an invalid or unsupported manifest');
  }
  const fallbackStateDir = manifest.run.state_dir || defaultStateDir({ stateDirName: 'autodev-framework-radar' });
  const stateDir = path.resolve(value('--state-dir', fallbackStateDir));
  const stateFile = path.join(stateDir, 'state.json');
  const state = readJson(stateFile, { schema_version: SCHEMA_VERSION, reviewed: {}, pending_runs: {} });
  state.reviewed = state.reviewed || {};
  let marked = 0;
  for (const item of manifest.items) {
    if (!item.key || !item.content_hash) throw new Error('manifest item lacks key or content_hash');
    if (item.requires_review) marked += 1;
    state.reviewed[item.key] = {
      content_hash: item.content_hash,
      reviewed_at: new Date().toISOString(),
      run_id: manifest.run.id,
    };
  }
  if (state.pending_runs) delete state.pending_runs[manifest.run.id];
  state.last_reviewed_at = new Date().toISOString();
  state.last_reviewed_run = manifest.run.id;
  writeAtomic(stateFile, JSON.stringify(state, null, 2));
  const heartbeat = path.join(stateDir, 'last-reviewed.json');
  writeAtomic(heartbeat, JSON.stringify({
    run_id: manifest.run.id,
    reviewed_at: state.last_reviewed_at,
    items_in_manifest: manifest.items.length,
    items_marked: marked,
    source_failures: manifest.population.sources_failed,
  }, null, 2));
  console.log(`marked ${marked} changed item(s) reviewed from a population of ${manifest.items.length}`);
  console.log(`heartbeat: ${heartbeat}`);
}

function help() {
  console.log(`usage: node framework-radar.js [options]\n\n` +
    `  --days N              overlap window, default 14\n` +
    `  --max-videos N        detailed YouTube candidates, default 20\n` +
    `  --max-transcripts N   transcript attempts, default 5\n` +
    `  --video ID|URL        force one video into the candidate set; repeatable\n` +
    `  --output PATH         manifest path; defaults under .claude/reports\n` +
    `  --state-dir PATH      durable local state; defaults under ~/.codex\n` +
    `  --config PATH         source registry\n` +
    `  --mark-reviewed PATH  mark a completed manifest only after analysis\n` +
    `  --help                show this text\n\n` +
    `YouTube discovery uses YOUTUBE_API_KEY when set, otherwise yt-dlp/uvx.`);
}

async function main() {
  try {
    if (process.argv.includes('--help')) return help();
    const mark = value('--mark-reviewed', null);
    if (mark) return markReviewed(mark);
    await collect();
  } catch (error) {
    console.error(`framework radar failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  discoverWithApi,
  discoverWithYtDlp,
  expandCaptionPlaylist,
  fetchJson,
  fetchText,
  isPrereleaseTitle,
  normalizeVideo,
  parseAtom,
  parseRss,
  parseJsonLines,
  parseMarkdownChangelog,
  run,
  runner,
  scoreVideos,
  transcriptKind,
};
