#!/usr/bin/env node
// Hermetic end-to-end and seam tests for framework-radar.js.
// The suite drives the real CLI for collection, durable review state, partial
// source failure and total source failure. Network/tool seams are injected only
// where a live API would make the test measure availability instead of logic.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'framework-radar.js');
const subject = require(SCRIPT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-radar-'));
const fixture = path.join(tmp, 'fixture');
const state = path.join(tmp, 'state');
fs.mkdirSync(fixture, { recursive: true });

let pass = 0, fail = 0;
const check = (label, condition, detail) => {
  if (condition) { pass += 1; console.log('  ok   ' + label); }
  else { fail += 1; console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); }
};
const write = (file, content) => fs.writeFileSync(file, content, 'utf8');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const cli = (args, extraEnv) => spawnSync(process.execPath, [SCRIPT].concat(args), {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { YOUTUBE_API_KEY: '' }, extraEnv || {}),
  maxBuffer: 16 * 1024 * 1024,
});

const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
const config = {
  official: [
    { id: 'claude-fixture', kind: 'markdown-changelog', product: 'Claude Code', url: 'fixture:', webUrl: 'https://example.test/claude', maxEntries: 3 },
    { id: 'codex-fixture', kind: 'atom', product: 'Codex CLI', url: 'fixture:', webUrl: 'https://example.test/codex', maxEntries: 3 },
  ],
  youtube: { queries: ['Claude Code workflow'], perQuery: 3, discoveryDays: 30 },
};
const configFile = path.join(fixture, 'config.json');
write(configFile, JSON.stringify(config, null, 2));
write(path.join(fixture, 'claude-fixture.txt'), [
  '# Changelog', '', '## 2.1.3', '', '- Added background workflow controls', '',
  '## 2.1.2', '', '- Fixed a Windows path issue', '',
].join('\n'));
write(path.join(fixture, 'codex-fixture.txt'), `<?xml version="1.0"?><feed>
  <entry><id>tag:codex:0.9.0</id><title>Codex 0.9.0</title><updated>${iso(2)}</updated>
  <link href="https://example.test/codex/0.9.0"/><content><![CDATA[<p>Added automation review queues.</p>]]></content></entry>
</feed>`);
write(path.join(fixture, 'youtube.json'), JSON.stringify([
  {
    id: 'OLDVIEWS001', title: 'Claude Code workflow overview', description: 'agent workflow',
    channel: 'Older Channel', published_at: iso(10), views: 1000000, duration: 600,
  },
  {
    id: 'FRESHVID001', title: 'Claude Code skills hooks agents workflow automation with Codex',
    description: 'Plugins, MCP, permissions, testing and worktrees', channel: 'Fresh Channel',
    published_at: iso(1), views: 200000, duration: 900,
  },
], null, 2));
write(path.join(fixture, 'transcript-FRESHVID001.json'), JSON.stringify([
  { text: 'CANARY_TRANSCRIPT_FULL_TEXT proposes measuring three workflow variants.', start: 0, duration: 4 },
  { text: 'It should remain outside the public manifest.', start: 4, duration: 3 },
], null, 2));

async function unitSeams() {
  const parsedMarkdown = subject.parseMarkdownChangelog(fs.readFileSync(path.join(fixture, 'claude-fixture.txt'), 'utf8'), config.official[0]);
  check('markdown parser finds both version sections', parsedMarkdown.length === 2);
  check('markdown parser hashes the section body', /^[a-f0-9]{64}$/.test(parsedMarkdown[0].content_hash));

  const parsedAtom = subject.parseAtom(fs.readFileSync(path.join(fixture, 'codex-fixture.txt'), 'utf8'), config.official[1], now - 14 * 86400000);
  check('atom parser finds a fresh release', parsedAtom.length === 1 && /automation review queues/.test(parsedAtom[0].content));
  check('atom parser respects the cutoff', subject.parseAtom(fs.readFileSync(path.join(fixture, 'codex-fixture.txt'), 'utf8'), config.official[1], now + 86400000).length === 0);
  const prereleaseAtom = fs.readFileSync(path.join(fixture, 'codex-fixture.txt'), 'utf8').replace(
    '<entry>', `<entry><id>tag:codex:0.10.0-alpha.1</id><title>0.10.0-alpha.1</title><updated>${iso(1)}</updated><content>noise</content></entry><entry>`);
  const stableOnly = subject.parseAtom(prereleaseAtom, Object.assign({}, config.official[1], { excludePrereleases: true }), now - 14 * 86400000);
  check('atom parser can exclude prerelease churn without hiding stable releases', stableOnly.length === 1 && stableOnly[0].title === 'Codex 0.9.0');

  check('transcript classifier distinguishes manual captions', subject.transcriptKind('(MANUALLY CREATED)\n - en (English)\n(GENERATED)\nNone') === 'manual');
  check('transcript classifier distinguishes generated captions', subject.transcriptKind('(MANUALLY CREATED)\nNone\n(GENERATED)\n - en (English)\n(TRANSLATION LANGUAGES)') === 'generated');
  check('json-lines parser ignores a stray warning', subject.parseJsonLines('{"id":"one"}\nwarning\n{"id":"two"}').length === 2);

  const dataText = await subject.fetchText('data:text/plain,known-positive', 'data fixture');
  const dataJson = await subject.fetchJson('data:application/json,%7B%22ok%22%3Atrue%7D', 'json fixture');
  check('fetch seam reads text through the real fetch helper', dataText === 'known-positive');
  check('fetch seam parses JSON through the real fetch helper', dataJson.ok === true);

  const captionCalls = [];
  const expandedCaption = await subject.expandCaptionPlaylist(
    '#EXTM3U\n#EXTINF:10,\ncaption-part.vtt\n#EXT-X-ENDLIST',
    'https://youtube.test/captions/playlist.m3u8',
    async (url) => {
      captionCalls.push(url);
      return 'WEBVTT\n\n00:00.000 --> 00:02.000\nknown caption words';
    });
  check('caption playlist seam resolves relative segment URLs', captionCalls[0] === 'https://youtube.test/captions/caption-part.vtt');
  check('caption playlist seam returns caption text instead of signed playlist data', /known caption words/.test(expandedCaption) && !expandedCaption.includes('#EXTM3U'));

  const apiCalls = [];
  const apiVideos = await subject.discoverWithApi(
    { queries: ['Claude Code'], perQuery: 2 }, 'SECRET_CANARY', iso(14), 10, [],
    async (url, label) => {
      apiCalls.push({ url, label });
      if (label === 'YouTube search') return { items: [{ id: { videoId: 'APIVIDEO001' } }] };
      return { items: [{ id: 'APIVIDEO001', snippet: { title: 'Claude Code API result', description: 'agent workflow', channelTitle: 'Channel', channelId: 'c', publishedAt: iso(1) }, statistics: { viewCount: '1234', likeCount: '12' } }] };
    });
  check('YouTube API seam performs search and detail calls', apiCalls.length === 2);
  check('YouTube API seam normalizes statistics', apiVideos.length === 1 && apiVideos[0].views === 1234);

  let ytCalls = 0;
  const ytVideos = await subject.discoverWithYtDlp(
    { queries: ['Claude Code'], perQuery: 2 }, 5, [],
    (_invocation, args) => {
      ytCalls += 1;
      if (args.includes('--flat-playlist')) return { status: 0, stdout: JSON.stringify({ id: 'YTDLPVID001', title: 'Claude Code', description: 'workflow', view_count: 55 }) + '\n', stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'YTDLPVID001', title: 'Claude Code details', description: 'agent workflow', view_count: 55, timestamp: Math.floor((now - 86400000) / 1000), webpage_url: 'https://youtube.test/watch?v=YTDLPVID001' }) + '\n', stderr: '' };
    },
    () => ({ command: 'fixture', prefix: [] }));
  check('yt-dlp seam executes relevance, upload-date, temporal and detail paths', ytCalls === 4);
  check('yt-dlp seam normalizes detailed metadata', ytVideos.length === 1 && ytVideos[0].published_at);

  const ran = subject.run({ command: process.execPath, prefix: [] }, ['-e', 'process.stdout.write("runner-ok")']);
  check('command runner executes the real child process', ran.status === 0 && ran.stdout === 'runner-ok');
  check('runner resolves an installed command directly', subject.runner('node', 'unused') !== null);
}

async function e2e() {
  const firstOutput = path.join(tmp, 'first.json');
  const baseArgs = ['--config', configFile, '--fixture-dir', fixture, '--state-dir', state,
    '--days', '14', '--max-videos', '10', '--max-transcripts', '1'];
  const first = cli(baseArgs.concat(['--output', firstOutput]));
  check('fixture collection exits 0', first.status === 0, first.stderr || first.stdout);
  check('fixture collection prints its population', /3 official item\(s\), 2 YouTube video\(s\), 1\/1 transcript/.test(first.stdout || ''), first.stdout);
  const manifest = read(firstOutput);
  check('manifest reports every configured source', manifest.population.sources_configured === 3 && manifest.population.sources_succeeded === 3);
  check('first run requires review of the full population', manifest.population.items_requiring_review === 5);
  check('raw views and balanced ranking can disagree', manifest.ranking_variants.raw_views[0] === 'OLDVIEWS001' && manifest.ranking_variants.balanced[0] === 'FRESHVID001');
  check('manifest records a transcript path', manifest.items.some((item) => item.id === 'FRESHVID001' && item.transcript.status === 'ok'));
  check('manifest does not copy raw transcript text', !fs.readFileSync(firstOutput, 'utf8').includes('CANARY_TRANSCRIPT_FULL_TEXT'));
  const transcriptPath = manifest.items.find((item) => item.id === 'FRESHVID001').transcript.path;
  check('raw transcript lives under the durable state directory', path.resolve(transcriptPath).startsWith(path.resolve(state)) && fs.readFileSync(transcriptPath, 'utf8').includes('CANARY_TRANSCRIPT_FULL_TEXT'));

  const secondOutput = path.join(tmp, 'second.json');
  const second = cli(baseArgs.concat(['--output', secondOutput]));
  check('unreviewed evidence remains pending on the next collection', second.status === 0 && read(secondOutput).population.items_requiring_review === 5);

  const marked = cli(['--mark-reviewed', secondOutput, '--state-dir', state]);
  check('mark-reviewed records exactly the changed population', marked.status === 0 && /marked 5 changed item/.test(marked.stdout || ''), marked.stderr || marked.stdout);
  check('mark-reviewed writes a heartbeat', fs.existsSync(path.join(state, 'last-reviewed.json')));

  const thirdOutput = path.join(tmp, 'third.json');
  const third = cli(baseArgs.concat(['--output', thirdOutput]));
  check('unchanged reviewed evidence does not return as new', third.status === 0 && read(thirdOutput).population.items_requiring_review === 0);

  write(path.join(fixture, 'claude-fixture.txt'), fs.readFileSync(path.join(fixture, 'claude-fixture.txt'), 'utf8').replace('background workflow controls', 'background workflow controls and notifications'));
  const changedOutput = path.join(tmp, 'changed.json');
  const changed = cli(baseArgs.concat(['--output', changedOutput]));
  check('one changed source section reopens exactly one item', changed.status === 0 && read(changedOutput).population.items_requiring_review === 1);

  const partialConfig = JSON.parse(JSON.stringify(config));
  partialConfig.official.push({ id: 'missing-fixture', kind: 'atom', product: 'Missing', url: 'fixture:', webUrl: 'https://example.test/missing', maxEntries: 2 });
  const partialConfigFile = path.join(fixture, 'partial-config.json');
  write(partialConfigFile, JSON.stringify(partialConfig));
  const partialOutput = path.join(tmp, 'partial.json');
  const partial = cli(['--config', partialConfigFile, '--fixture-dir', fixture, '--state-dir', path.join(tmp, 'partial-state'), '--output', partialOutput]);
  check('one failed source preserves usable partial evidence', partial.status === 0 && read(partialOutput).population.sources_failed === 1);
  check('partial collection names the source it could not check', /COULD NOT CHECK missing-fixture/.test(partial.stdout || ''));
  check('partial collection never claims completeness', read(partialOutput).run.complete === false);

  const emptyFixture = path.join(tmp, 'empty-fixture');
  fs.mkdirSync(emptyFixture, { recursive: true });
  const emptyConfig = { official: [{ id: 'absent', kind: 'atom', product: 'Absent', url: 'fixture:', webUrl: 'https://example.test', maxEntries: 2 }], youtube: { queries: ['none'], perQuery: 1, discoveryDays: 14 } };
  const emptyConfigFile = path.join(emptyFixture, 'config.json');
  write(emptyConfigFile, JSON.stringify(emptyConfig));
  write(path.join(emptyFixture, 'youtube.json'), '[]');
  const emptyOutput = path.join(tmp, 'empty.json');
  const empty = cli(['--config', emptyConfigFile, '--fixture-dir', emptyFixture, '--state-dir', path.join(tmp, 'empty-state'), '--output', emptyOutput]);
  check('an all-source failure exits non-zero', empty.status !== 0, empty.stdout || empty.stderr);
  check('an all-source failure reports zero successful sources', read(emptyOutput).population.sources_succeeded === 0);
  check('an empty population is never described as clean', !/clean|up to date/i.test((empty.stdout || '') + (empty.stderr || '')));

  const invalidManifest = path.join(tmp, 'invalid.json');
  write(invalidManifest, JSON.stringify({ schema_version: 999, items: [] }));
  const invalid = cli(['--mark-reviewed', invalidManifest, '--state-dir', state]);
  check('mark-reviewed rejects an unsupported manifest', invalid.status !== 0 && /refusing to mark/.test(invalid.stderr || ''));

  const help = cli(['--help']);
  check('help exits 0 and documents review marking', help.status === 0 && /--mark-reviewed/.test(help.stdout || ''));
}

(async () => {
  await unitSeams();
  await e2e();
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
