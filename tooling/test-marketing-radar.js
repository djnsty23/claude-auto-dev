#!/usr/bin/env node
// Hermetic behavioral checks for the marketing profile of framework-radar.js.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'framework-radar.js');
const REGISTRY = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'marketing-radar-sources.json');
const SKILL = path.join(ROOT, 'plugins', 'autodev-core', 'skills', 'marketing-radar', 'SKILL.md');
const PACKAGE = path.join(ROOT, 'package.json');
const subject = require(SCRIPT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-radar-'));
const fixture = path.join(tmp, 'fixture');
const runDir = path.join(tmp, 'run');
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(fixture, { recursive: true });
fs.mkdirSync(runDir, { recursive: true });

let pass = 0, fail = 0;
const check = (label, condition, detail) => {
  if (condition) { pass += 1; console.log('  ok   ' + label); }
  else { fail += 1; console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); }
};
const write = (file, content) => fs.writeFileSync(file, content, 'utf8');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();

async function unit() {
  const source = { id: 'official-blog', category: 'seo', product: 'Official Blog', webUrl: 'https://example.test/blog', maxEntries: 4 };
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><guid>fresh</guid><title>Fresh search change</title><link>https://example.test/fresh</link>
    <pubDate>${new Date(now - 86400000).toUTCString()}</pubDate><description><![CDATA[<p>New structured data behavior.</p>]]></description></item>
    <item><guid>old</guid><title>Old change</title><link>https://example.test/old</link>
    <pubDate>${new Date(now - 90 * 86400000).toUTCString()}</pubDate><description>Old behavior.</description></item>
  </channel></rss>`;
  const parsed = subject.parseRss(rss, source, now - 14 * 86400000);
  check('RSS parser keeps fresh official evidence and applies the cutoff',
    parsed.length === 1 && parsed[0].title === 'Fresh search change');
  check('RSS parser preserves category, URL and body evidence',
    parsed[0].category === 'seo' && parsed[0].url === 'https://example.test/fresh'
      && parsed[0].authority === 'primary' && /structured data behavior/.test(parsed[0].content));

  const dated = subject.parseMarkdownChangelog([
    '## <a name="august2026"></a>August 2026', '', '- New conversion report.', '',
    '## July 2026', '', '- Earlier release.',
  ].join('\n'), Object.assign({}, source, {
    headingPattern: '^(?:July|August)\\s+20\\d{2}$',
    headingDates: true,
  }));
  check('configurable markdown headings parse anchored date-based platform release notes',
    dated.length === 2 && /August 2026/.test(dated[0].title)
      && dated[0].published_at === '2026-08-01T00:00:00.000Z');
  const deduped = subject.parseMarkdownChangelog([
    '## 1.2.3', '', '- Python update.', '', '## 1.2.3', '', '- Java update.',
  ].join('\n'), source);
  check('markdown source versions are deduplicated before manifest review', deduped.length === 1);

  const videos = [
    { id: 'AGENTVIDEO1', title: 'Claude Code workflow agent hooks', description: '', views: 1000, published_at: iso(2) },
    { id: 'MARKETVID01', title: 'Meta ads creative conversion experiment', description: '', views: 1000, published_at: iso(2) },
  ];
  const ranking = subject.scoreVideos(videos, now, 30, ['meta ads', 'creative', 'conversion', 'experiment']);
  check('profile relevance terms rank marketing evidence ahead of unrelated agent evidence',
    ranking.balanced[0] === 'MARKETVID01' && videos[1].relevance_terms === 4);

  const commentFixture = [
    { id: 'real-1', text: 'This fixed the attribution mismatch, but the setup step was unclear.', author_id: 'real-a' },
    { id: 'spam-1', text: 'Contact him on Telegram for crypto recovery', author_id: 'spam-a' },
    { id: 'spam-2', text: 'Subscribe for subscribe and check out my channel', author_id: 'spam-b' },
    { id: 'dup-1', text: 'Amazing guaranteed system that changed my financial life forever', author_id: 'dup-a' },
    { id: 'dup-2', text: 'Amazing guaranteed system that changed my financial life forever', author_id: 'dup-b' },
    { id: 'dup-3', text: 'Amazing guaranteed system that changed my financial life forever', author_id: 'dup-c' },
    { id: 'short-1', text: 'Great video', author_id: 'short-a' },
    { id: 'short-2', text: 'Great video', author_id: 'short-b' },
    { id: 'short-3', text: 'Great video', author_id: 'short-c' },
    { id: 'real-2', text: 'Our leads go directly to a WhatsApp business account, so awareness works in this market.', author_id: 'real-b' },
    { id: 'creator-1', text: 'Here is the worksheet mentioned above.', author_id: 'creator', author_is_uploader: true },
  ].map((row, index) => subject.normalizeComment(row, 'fixture', index));
  const filtered = subject.filterCommentFeedback(commentFixture);
  check('comment filter removes only independently pinned high-confidence patterns',
    filtered.retained.length === 5 && filtered.excluded.length === 6
      && filtered.reasons['off-platform-promotion'] === 1
      && filtered.reasons['engagement-manipulation'] === 1
      && filtered.reasons['multi-author-duplicate'] === 3
      && filtered.reasons['creator-response'] === 1);
  check('short ordinary praise is retained rather than guessed to be a bot',
    filtered.retained.filter((row) => row.text === 'Great video').length === 3);
  check('ordinary discussion of an off-platform channel is not mislabeled as promotion',
    filtered.retained.some((row) => row.id === 'real-2'));

  const apiCalls = [];
  const apiComments = await subject.discoverCommentsWithApi('MARKETVID01', 'test-key', 20, async (url) => {
    apiCalls.push(url);
    return { items: [{ id: `thread-${apiCalls.length}`, snippet: { topLevelComment: {
      id: `comment-${apiCalls.length}`, snippet: { textOriginal: `Comment ${apiCalls.length}`, authorChannelId: { value: `author-${apiCalls.length}` }, likeCount: apiCalls.length },
    } } }] };
  });
  check('YouTube API comment seam samples both relevance and time lanes',
    apiCalls.length === 2 && apiCalls.some((url) => /order=relevance/.test(url))
      && apiCalls.some((url) => /order=time/.test(url)) && apiComments.comments.length === 2);

  const pinnedCalls = [];
  const pinned = await subject.discoverWithApi({ queries: [], perQuery: 2 }, 'test-key', iso(14), 5,
    ['MARKETVID01'], async (url) => {
      pinnedCalls.push(url);
      return { items: [{ id: 'MARKETVID01', snippet: { title: 'Pinned marketing video', publishedAt: iso(1) }, statistics: { viewCount: '10' } }] };
    });
  check('pinned-only API discovery skips search and fetches supplied video details',
    pinnedCalls.length === 1 && /\/youtube\/v3\/videos\?/.test(pinnedCalls[0])
      && !/\/search\?/.test(pinnedCalls[0]) && pinned.length === 1 && pinned[0].pinned === true);

  const ytCalls = [];
  const ytComments = subject.discoverCommentsWithYtDlp('MARKETVID01', 20,
    (_invocation, args) => {
      ytCalls.push(args);
      return { status: 0, stdout: JSON.stringify({ comments: [{ id: `yt-${ytCalls.length}`, text: `YT ${ytCalls.length}`, author_id: `author-${ytCalls.length}` }] }), stderr: '' };
    }, () => ({ command: 'yt-dlp', prefix: [] }));
  check('yt-dlp comment seam bounds top and recent samples without replies',
    ytCalls.length === 2 && ytCalls.every((args) => args.includes('--write-comments'))
      && ytCalls.some((args) => args.some((arg) => /comment_sort=top/.test(arg)))
      && ytCalls.some((args) => args.some((arg) => /comment_sort=new/.test(arg)))
      && ytCalls.every((args) => args.some((arg) => /max_comments=10,10,0,0,1/.test(arg)))
      && ytComments.comments.length === 2);

  const registry = read(REGISTRY);
  const registered = registry.official.concat(registry.research, registry.community);
  const categories = new Set(registered.map((row) => row.category));
  check('marketing registry has its own state, output and relevance profile',
    registry.profile.id === 'marketing-radar'
      && registry.profile.stateDirName === 'autodev-marketing-radar'
      && registry.profile.outputPrefix === 'marketing-radar-input');
  check('registry spans acquisition, measurement, SEO, CRM and email',
    ['paid-social', 'paid-search', 'measurement', 'seo', 'crm-automation', 'email-automation']
      .every((category) => categories.has(category)));
  check('registry includes Meta, Google, TikTok and Microsoft platform evidence',
    ['meta-business-node-releases', 'google-ads-python-releases', 'tiktok-business-api-changelog',
      'microsoft-advertising-release-notes'].every((id) => registry.official.some((row) => row.id === id)));
  check('registry breadth floors are independent of the registry itself',
    registry.official.length >= 35 && registry.research.length >= 3 && registry.community.length >= 10
      && categories.size >= 18 && registry.youtube.queries.length >= 35);
  check('registry enables bounded top and recent audience feedback',
    registry.youtube.comments.enabled === true && registry.youtube.comments.maxVideos === 5
      && registry.youtube.comments.maxPerVideo === 100);

  const skill = fs.readFileSync(SKILL, 'utf8');
  check('skill separates source incentive, evidence and verdict',
    /what the author sells, sponsors or benefits from/.test(skill)
      && /`HOLDS`, `CONDITIONAL`, `DEBUNKED`, `REFUTED` or `UNTESTED`/.test(skill));
  check('skill applies margin, human-sales and demand-type boundaries',
    /contribution margin/.test(skill) && /human sales conversation/.test(skill)
      && /existing-demand capture versus interruption/.test(skill));
  check('skill requires execution and A B C for every selected hypothesis',
    /Every selected hypothesis must be executed in\s+this run/.test(skill)
      && /A: current behavior, B: proposed behavior, C: simpler alternative/.test(skill));
  check('scheduled mode cannot mutate live marketing systems',
    /must not publish content, send messages,\s+change tracking, upload audiences, alter campaigns or budgets, or start spend/.test(skill));
  check('skill rejects repeated significance peeking and Ads Library winner labels',
    /use a fixed final analysis or a\s+valid sequential-testing correction/.test(skill)
      && /Ads Library longevity as a creative\s+candidate signal only/.test(skill));
  check('package exposes the marketing radar profile',
    read(PACKAGE).scripts['marketing:radar'].includes('marketing-radar-sources.json'));
}

function endToEnd() {
  const config = {
    profile: {
      id: 'marketing-fixture', label: 'marketing fixture', outputPrefix: 'marketing-radar-input',
      stateDirName: 'marketing-fixture-state', relevantTerms: ['meta ads', 'creative', 'conversion'],
    },
    official: [
      { id: 'blog-fixture', kind: 'rss', category: 'paid-social', product: 'Fixture Blog', url: 'fixture:', webUrl: 'https://example.test', maxEntries: 2 },
    ],
    youtube: {
      queries: ['marketing fixture'], perQuery: 2, discoveryDays: 30,
      comments: { enabled: true, maxVideos: 1, maxPerVideo: 10 },
    },
  };
  const configFile = path.join(fixture, 'config.json');
  write(configFile, JSON.stringify(config, null, 2));
  write(path.join(fixture, 'blog-fixture.txt'), `<?xml version="1.0"?><rss><channel><item>
    <guid>change-1</guid><title>Meta conversion change</title><link>https://example.test/change</link>
    <pubDate>${new Date(now - 86400000).toUTCString()}</pubDate><description>Measurement update.</description>
  </item></channel></rss>`);
  write(path.join(fixture, 'youtube.json'), JSON.stringify([
    { id: 'MARKETVID01', title: 'Meta ads creative conversion', description: 'testing', channel: 'Fixture', published_at: iso(1), views: 1000 },
    { id: 'AGENTVIDEO1', title: 'Claude Code hooks', description: 'agents', channel: 'Fixture', published_at: iso(1), views: 1000 },
  ]));
  write(path.join(fixture, 'transcript-MARKETVID01.json'), JSON.stringify([
    { text: 'A sponsored presenter claims creative iteration improves conversion.', start: 0, duration: 4 },
  ]));
  write(path.join(fixture, 'comments-MARKETVID01.json'), JSON.stringify([
    { id: 'comment-1', text: 'The attribution example matched my implementation.', author_id: 'viewer-1', lane: 'top' },
    { id: 'comment-2', text: 'Can you show the server-side version?', author_id: 'viewer-2', lane: 'recent' },
    { id: 'comment-3', text: 'Contact me on Telegram for guaranteed profit.', author_id: 'spam-1', lane: 'recent' },
    { id: 'comment-4', text: 'The template is linked above.', author_id: 'creator', author_is_uploader: true, lane: 'top' },
  ]));

  const result = spawnSync(process.execPath, [SCRIPT,
    '--config', configFile, '--fixture-dir', fixture, '--state-dir', stateDir,
    '--days', '14', '--max-videos', '5', '--max-transcripts', '1'], {
    cwd: runDir, encoding: 'utf8', env: Object.assign({}, process.env, { YOUTUBE_API_KEY: '' }),
  });
  const expectedOutput = path.join(runDir, '.claude', 'reports',
    `marketing-radar-input-${new Date().toISOString().slice(0, 10)}.json`);
  check('marketing profile collection exits zero and uses its console label',
    result.status === 0 && /marketing fixture: 2 succeeded/.test(result.stdout || ''), result.stderr || result.stdout);
  check('profile selects its own default manifest filename', fs.existsSync(expectedOutput));
  const manifest = read(expectedOutput);
  check('manifest records the profile and cross-footed population',
    manifest.run.profile === 'marketing-fixture' && manifest.population.official_items_seen === 1
      && manifest.population.youtube_videos_seen === 2 && manifest.population.items_requiring_review === 3
      && manifest.population.comments_fetched === 4 && manifest.population.comments_retained === 2
      && manifest.population.comments_excluded === 2
      && manifest.population.sources_by_authority_configured.primary === 1
      && manifest.population.sources_by_authority_configured['practitioner-audience'] === 1
      && manifest.population.source_categories_seen['paid-social'] === 1);
  const commentVideo = manifest.items.find((item) => item.id === 'MARKETVID01');
  check('manifest points to an anonymized, cross-footed local comment sample',
    commentVideo.comments.status === 'ok' && fs.existsSync(commentVideo.comments.path)
      && commentVideo.comments.distinct_retained_authors === 2
      && commentVideo.comments.exclusion_reasons['off-platform-promotion'] === 1
      && commentVideo.comments.exclusion_reasons['creator-response'] === 1);
  check('profile terms control balanced video ranking in the real CLI',
    manifest.ranking_variants.balanced[0] === 'MARKETVID01');
  const reviewed = spawnSync(process.execPath, [SCRIPT, '--mark-reviewed', expectedOutput], {
    cwd: runDir, encoding: 'utf8', env: Object.assign({}, process.env, { YOUTUBE_API_KEY: '' }),
  });
  check('mark-reviewed follows the manifest state directory without another flag',
    reviewed.status === 0 && fs.existsSync(path.join(stateDir, 'last-reviewed.json')),
    reviewed.stderr || reviewed.stdout);
}

(async () => {
  await unit();
  endToEnd();
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
