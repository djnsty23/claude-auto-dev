'use strict';
// Suite for plugins/autodev-core/scripts/fleet-snapshot.js.
//
// The subject has two halves. gather() runs git, gh and three sibling scripts
// against a live fleet, and is exercised by the fleet itself. render() turns
// one dataset into one page, and THAT is what this suite grades, on a fixed
// dataset, because a board is only worth publishing if what it prints is what
// the data says.
//
// The dataset is chosen so every branch renders: a repo with mergeable and
// not-ready PRs, a repo with none; a five-state prd and a repo with no prd; a
// title carrying a raw tag, because a raw tag inside the page is the
// truncation trap and the board must escape it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-snapshot.js');
const { render, esc } = require(SUBJECT);
const SRC = fs.readFileSync(SUBJECT, 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}
const count = (hay, needle) => hay.split(needle).length - 1;

const DATA = {
    measuredAt: '2026-09-05T12:01:08.725Z',
    clientReposExcluded: 5,
    away: '2026-09-06T20:00:00Z',
    repos: [
        {
            name: 'alpha', trunk: 'origin/main', tip: 'abc1234 fix: the thing', tipAge: '2 hours ago',
            prs: [
                { number: 41, title: 'Ready one', draft: false, head: 'x', verdict: 'READY', population: {}, reasons: [] },
                { number: 42, title: 'Draft <script>alert(1)</script> title', draft: true, head: 'y', verdict: 'NOT_READY', population: {}, reasons: ['it is a DRAFT, so a guarded gate reports SKIPPED'] },
                { number: 43, title: 'Unknown', draft: false, head: 'z', verdict: 'CANNOT_TELL', population: {}, reasons: ['gh could not answer'] },
            ],
            prd: { done: 10, pending: 3, failed: 1, deferred: 2, needsSetup: 1, total: 17, next: [{ id: 'S1-002', title: 'Tilemap' }, { id: 'S1-003', title: 'Farmer' }] },
            stale: { olderThanAgeDays: 2, openStateAndDated: 5, present: 4 },
            branchesAhead: 7, transcripts: [{ worktree: 'wt-a', ageMin: 12 }, { worktree: 'wt-b', ageMin: 300 }], transcriptsScanned: 9,
        },
        {
            name: 'beta', trunk: 'origin/p0/foundation', tip: 'def5678 feat: map', tipAge: '3 days ago',
            prs: [], prd: null, stale: null, branchesAhead: 0, transcripts: [], transcriptsScanned: 2,
        },
    ],
};

const html = render(DATA);

// ---- shape: what was authored is what is on the page --------------------------
check('one section per repo in the dataset', count(html, '<section class="repo">') === DATA.repos.length, String(count(html, '<section class="repo">')));
check('the page has a product name for a title', /<title>Fleet Board<\/title>/.test(html));
check('the masthead carries the measurement time, to the minute, marked UTC', /measured <b>2026-09-05 12:01 UTC<\/b>/.test(html));
check('the masthead says how many client repos were excluded', /5 client repos excluded/.test(html));
check('the masthead shows the away window when one is set', /away window until <b>2026-09-06T20:00:00Z<\/b>/.test(html));

// ---- the four tiles say what the data says ---------------------------------
const tile = (k) => (html.match(new RegExp('<div class="v">(\\d+)</div><div class="k">' + k + '</div>')) || [])[1];
check('mergeable-now counts only READY verdicts', tile('mergeable now') === '1', tile('mergeable now'));
check('open PRs is the sum across repos', tile('open pull requests') === '3', tile('open pull requests'));
check('stories pending is the sum of prd.pending', tile('stories pending') === '3', tile('stories pending'));
check('the transcripts tile is labelled as what it counts, not as sessions', tile('transcripts written, 24 h') === '2', tile('transcripts written, 24 h'));
check('there is no tile claiming to count sessions', !/class="k">sessions/.test(html), 'a transcript count labelled as sessions is a wrong population');

// ---- escaping: a raw tag in data must never become markup --------------------
check('a title carrying a raw tag is entity-escaped', html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') !== -1);
check('and the raw tag does not appear anywhere in the output', html.indexOf('<script>alert(1)') === -1, 'the raw-tag truncation trap');
check('esc() escapes all four HTML metacharacters', esc('&<>"') === '&amp;&lt;&gt;&quot;');

// ---- per-panel content -------------------------------------------------------
check('each PR shows its verdict as a chip', count(html, 'class="chip good">ready') === 1 && count(html, 'class="chip crit">not ready') === 1 && count(html, 'class="chip warn">cannot tell') === 1);
check('a draft PR is marked draft', /class="chip muted">draft/.test(html));
check('the first reason rides under the PR', /it is a DRAFT, so a guarded gate reports SKIPPED/.test(html));
check('a repo with no PRs says so rather than rendering an empty list', /no open pull requests/.test(html));
check('the story bar names all five states when all are non-zero', ['done', 'pending', 'failed', 'deferred', 'needs setup'].every((k) => new RegExp('<b class="mono">\\d+</b> ' + k).test(html)));
check('the story bar is labelled for assistive tech with the same totals', /aria-label="17 stories: 10 done, 3 pending, 1 failed, 2 deferred, 1 needs setup"/.test(html));
check('the next actionable stories are listed by id', /S1-002/.test(html) && /S1-003/.test(html));
check('a repo with no prd says so', /no prd.json at the trunk/.test(html));
check('document staleness is printed with its population', /<span class="mono">2<\/span> of <span class="mono">5<\/span> dated open-state claims older than 7 d, in <span class="mono">4<\/span> boot docs/.test(html));
check('a repo not scanned for staleness says so', /not scanned/.test(html));
check('each panel ends with what was scanned', count(html, 'transcripts scanned') === DATA.repos.length);
check('branches ahead of the trunk is printed when known', /7 branches ahead of the trunk/.test(html));
check('transcript ages are humanised', /12 min ago/.test(html) && /5 h ago/.test(html));
check('a repo with no recent transcripts says so', /none written in 24 h/.test(html));

// ---- themes: tokens defined on bare :root before any media block ---------------
const rootIdx = html.indexOf(':root{--paper');
const mediaIdx = html.indexOf('@media (prefers-color-scheme:dark)');
const stampedIdx = html.indexOf(':root[data-theme="dark"]');
check('the light palette is defined on bare :root', rootIdx !== -1);
check('bare :root comes before the dark media block', rootIdx !== -1 && mediaIdx !== -1 && rootIdx < mediaIdx);
check('the dark media block is guarded against an explicit light choice', /:root:not\(\[data-theme="light"\]\)/.test(html));
check('an explicit dark stamp is also handled', stampedIdx !== -1);
check('body paints its own background from a token', /body\{[^}]*background:var\(--paper\)/.test(html));
check('the page loads no script and no library', !/<script/.test(html));

// ---- the public-repo rule: no machine-specific path in the subject -------------
check('the subject carries no home-directory path', !/C:\/Users\/|\/Users\/[a-z]+\//.test(SRC), 'this repo is public');
check('the subject resolves siblings by __dirname, not a fixed clone path', /const SCRIPTS = __dirname;/.test(SRC));

// ---- the CLI --data path writes a file from a dump ----------------------------
let tmp = null;
try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-snapshot-'));
    const dataFile = path.join(tmp, 'd.json'); const outFile = path.join(tmp, 'b.html');
    fs.writeFileSync(dataFile, JSON.stringify(DATA), 'utf8');
    execFileSync('node', [SUBJECT, '--data', dataFile, '--out', outFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const written = fs.readFileSync(outFile, 'utf8');
    check('--data --out renders a dump to a file without touching git or gh', written === html, 'output differs from render(DATA)');
} catch (e) { check('the CLI --data path runs', false, String(e.message).slice(0, 120)); }
finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
