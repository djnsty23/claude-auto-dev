#!/usr/bin/env node
'use strict';
// Suite for work-cost.js, the per-merged-PR cost report.
//
// Three things matter more than the formatting. First, ONE RESPONSE IS PRICED
// ONCE: a response is written as one row per content block, every row repeats
// its input and cache usage, and only the last carries the final output count.
// Second, ATTRIBUTION follows evidence in a fixed order (gh pr create, then the
// commit branch matched to a merged PR in the same repo, then gh pr merge) and
// never counts one session twice. Third, the POPULATION is printed, so a report
// that attributed nothing reads differently from one that scanned nothing.
//
// Hermetic: CLAUDE_CONFIG_DIR points at a temp dir, and gh is replaced by a
// stub through WORK_COST_GH. The expected dollars are hand-computed from the
// published rates, not read from quota-burn.js, so a pricing change there shows
// here as a failure to look at.
//
// Run: node tooling/test-work-cost.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'work-cost.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'work-cost-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 300) : ''));
}
const near = (a, b, tol = 1e-9) => typeof a === 'number' && Math.abs(a - b) <= tol;

const NOW = Date.now();
const ago = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();
const DAY = 24;

// ------------------------------------------------------------------ fixtures

// A real git repo, so a session's cwd maps to acme/widgets through its origin.
const REPO_DIR = path.join(ROOT, 'widgets');
fs.mkdirSync(REPO_DIR, { recursive: true });
const git = (args) => spawnSync('git', ['-C', REPO_DIR].concat(args), { encoding: 'utf8' });
git(['init', '-q']);
git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
const WORKTREE = path.join(REPO_DIR, '.claude', 'worktrees', 'wt1');

// The gh stub answers `pr list --repo R` from gh-data.json and logs its argv.
const GH_DIR = path.join(ROOT, 'gh');
fs.mkdirSync(GH_DIR, { recursive: true });
const GH_STUB = path.join(GH_DIR, 'gh-stub.js');
fs.writeFileSync(GH_STUB, [
    "const fs = require('fs'); const path = require('path');",
    'const a = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'argv.txt'), JSON.stringify(a) + '\\n');",
    "const repo = a[a.indexOf('--repo') + 1];",
    "const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'gh-data.json'), 'utf8'));",
    "if (!(repo in data)) { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }",
    'process.stdout.write(JSON.stringify(data[repo]));',
].join('\n'), 'utf8');
const pr = (number, head, mergedHoursAgo, title) => ({
    number, headRefName: head, mergedAt: ago(mergedHoursAgo), title: title || 'pr ' + number,
    url: 'https://github.com/acme/x/pull/' + number,
});
function ghData(data) {
    fs.writeFileSync(path.join(GH_DIR, 'gh-data.json'), JSON.stringify(data), 'utf8');
    try { fs.unlinkSync(path.join(GH_DIR, 'argv.txt')); } catch { /* none yet */ }
}
const GH_ALL = {
    'acme/widgets': [
        pr(11, 'feat/a', 5, 'feat: a'), pr(12, 'feat/b', 6, 'feat: b'), pr(13, 'feat/c', 7, 'feat: c'),
        pr(14, 'feat/d', 8, 'feat: d'), pr(15, 'feat/x', 9, 'feat: x'), pr(16, 'feat/y', 9, 'feat: nobody worked on this'),
        pr(9, 'feat/old', 20 * DAY, 'merged before the span'),
    ],
    // Same head branch name in another repo: must not collect widgets' cost.
    'acme/other': [pr(5, 'feat/b', 4, 'other: b')],
};

// One transcript row. `usage` is the message usage block.
const usageRow = (session, cwd, t, id, req, model, usage) => ({
    type: 'assistant', sessionId: session, cwd, timestamp: t, requestId: req,
    message: { id, model, role: 'assistant', usage, content: [{ type: 'text', text: 'x' }] },
});
const bash = (session, cwd, t, toolId, command) => ({
    type: 'assistant', sessionId: session, cwd, timestamp: t,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command } }] },
});
const result = (session, cwd, t, toolId, text) => ({
    type: 'user', sessionId: session, cwd, timestamp: t,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text }] },
});

let n = 0;
function config(files, ledgers) {
    const cfg = path.join(ROOT, 'cfg-' + (n++));
    for (const [rel, rows] of Object.entries(files)) {
        const f = path.join(cfg, 'projects', rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n', 'utf8');
    }
    for (const [name, body] of Object.entries(ledgers || {})) {
        fs.mkdirSync(path.join(cfg, 'autodev'), { recursive: true });
        fs.writeFileSync(path.join(cfg, 'autodev', name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    }
    return cfg;
}

function run(cfg, argv, extraEnv) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(argv), {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg, WORK_COST_GH: GH_STUB }, extraEnv || {}),
    });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* null */ }
    return { r, j };
}

// ------------------------------------------------------ the main population
//
// Prices, Opus 5 at $5 in and $25 out per MTok, cache read 0.1x, 5m write 1.25x:
//   S1 m1: 100k in + 1M cache read + 200k cache write + 40k out = 0.5+0.5+1.25+1.0 = $3.25
//   S1 subagent m7: 20k out on Opus 5                                             = $0.50
//   S2 m2: 100k out on Sonnet 5 at $10                                           = $1.00
//   S3 m3: 400k out on Haiku 4.5 at $5                                           = $2.00
//   S4 m4: 80k out on Opus 5, split between merged #14 and unmerged feat/wip     = $2.00
//   S5 m5: 40k out on Opus 5, no link                                            = $1.00
//   S6 m6: 10k out on Opus 5, linked only to unmerged feat/never                 = $0.25
//   S7 m9: 20k out on Opus 5, its rows written on feat/x, merged as #15          = $0.50
//   total $10.50, merged 3.75 + 1 + 2 + 1 + 0.5 = $8.25, not merged $1.25, unattributed $1.00

const M1 = { input_tokens: 100000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 200000 };
const H = 2; // rows two hours ago
const on = (branch, row) => Object.assign({}, row, { gitBranch: branch });

const MAIN = {
    // S1: gh pr create, three rows of one response, and a commit on the same PR's branch.
    'proj/S1.jsonl': [
        bash('S1', WORKTREE, ago(H), 'tu1', 'gh pr create --title "feat: a" --body-file b.md'),
        result('S1', WORKTREE, ago(H), 'tu1', 'https://github.com/acme/widgets/pull/11\n'),
        bash('S1', WORKTREE, ago(H), 'tu1b', 'git commit -F msg.txt'),
        result('S1', WORKTREE, ago(H), 'tu1b', '[feat/a 1a2b3c4] feat: a\n 1 file changed'),
        usageRow('S1', WORKTREE, ago(H), 'm1', 'r1', 'claude-opus-5', { ...M1, output_tokens: 1 }),
        usageRow('S1', WORKTREE, ago(H), 'm1', 'r1', 'claude-opus-5', { ...M1, output_tokens: 1 }),
        on('feat/a', usageRow('S1', WORKTREE, ago(H), 'm1', 'r1', 'claude-opus-5', { ...M1, output_tokens: 40000 })),
    ],
    // A subagent transcript: its rows carry the parent's session id.
    'proj/S1/subagents/agent-1.jsonl': [
        usageRow('S1', WORKTREE, ago(H), 'm7', 'r7', 'claude-opus-5', { output_tokens: 20000 }),
    ],
    // S2: a commit on feat/b links it to #12, and a commit on main links nothing.
    'proj/S2.jsonl': [
        bash('S2', REPO_DIR, ago(H), 'tu2', 'git add a.js && git commit -F msg.txt'),
        result('S2', REPO_DIR, ago(H), 'tu2', '[feat/b 5d6e7f8] feat: b\n 1 file changed'),
        bash('S2', REPO_DIR, ago(H), 'tu2b', 'git commit -m chore'),
        result('S2', REPO_DIR, ago(H), 'tu2b', [{ type: 'text', text: '[main 9f8e7d6] chore' }]),
        on('main', usageRow('S2', REPO_DIR, ago(H), 'm2', 'r2', 'claude-sonnet-5', { output_tokens: 100000 })),
    ],
    // S3: only a gh pr merge.
    'proj/S3.jsonl': [
        bash('S3', REPO_DIR, ago(H), 'tu3', 'cd x && GH_PAGER= gh pr merge 13 --repo acme/widgets --squash --match-head-commit abc123'),
        usageRow('S3', REPO_DIR, ago(H), 'm3', 'r3', 'claude-haiku-4-5', { output_tokens: 400000 }),
    ],
    // S4: two branches, one merged (#14), one not.
    'proj/S4.jsonl': [
        bash('S4', REPO_DIR, ago(H), 'tu4', 'git commit -F m1.txt'),
        result('S4', REPO_DIR, ago(H), 'tu4', '[feat/d 0a0b0c0] d'),
        bash('S4', REPO_DIR, ago(H), 'tu4b', 'git commit -F m2.txt'),
        result('S4', REPO_DIR, ago(H), 'tu4b', '[feat/wip (root-commit) 1b1c1d1] wip'),
        usageRow('S4', REPO_DIR, ago(H), 'm4', 'r4', 'claude-opus-5', { output_tokens: 80000 }),
    ],
    // S5: no link. Its row from ten days ago would be $100 if the span leaked,
    // and a brief whose prose says "gh pr merge 42" is not a merge.
    'proj/S5.jsonl': [
        bash('S5', REPO_DIR, ago(H), 'tu5', 'printf "%s" "when green, gh pr merge 42 and pass --repo to gh"'),
        usageRow('S5', REPO_DIR, ago(10 * DAY), 'm5old', 'r5old', 'claude-opus-5', { output_tokens: 4000000 }),
        on('claude/wt-never-a-pr', usageRow('S5', REPO_DIR, ago(H), 'm5', 'r5', 'claude-opus-5', { output_tokens: 40000 })),
        'this line is not JSON and is skipped "usage"',
    ],
    // S6: linked only to a branch that never merged. It also ran a template
    // merge with a placeholder repo, which must not become a repo to ask gh about.
    'proj/S6.jsonl': [
        bash('S6', REPO_DIR, ago(H), 'tu6t', 'gh pr merge 42 -R <owner>/<name> --squash'),
        bash('S6', REPO_DIR, ago(H), 'tu6', 'git commit -F m.txt'),
        result('S6', REPO_DIR, ago(H), 'tu6', '[feat/never 2c2d2e2] never'),
        usageRow('S6', REPO_DIR, ago(H), 'm6', 'r6', 'claude-opus-5', { output_tokens: 10000 }),
    ],
    // A transcript untouched for ten days: skipped by mtime, never read.
    // S7: no command at all, but every row was written on feat/x, merged as #15.
    'proj/S7.jsonl': [
        on('feat/x', usageRow('S7', REPO_DIR, ago(H), 'm9', 'r9', 'claude-opus-5', { output_tokens: 20000 })),
    ],
    'proj/OLD.jsonl': [
        usageRow('OLD', REPO_DIR, ago(10 * DAY), 'm8', 'r8', 'claude-opus-5', { output_tokens: 4000000 }),
    ],
};

const LEDGERS = {
    'headless-workers.json': {
        version: 1,
        records: [
            { code: 'A', startedAt: ago(30), result: 'failed' },
            { code: 'A', startedAt: ago(20), result: 'done' },
            { code: 'B', startedAt: ago(10), result: 'done' },
            { code: 'C', startedAt: ago(10), result: 'stopped' },
            { code: 'D', startedAt: ago(20 * DAY), result: 'done' },
        ],
    },
    'unattended-workers.json': {
        version: 1,
        records: [
            { taskId: 'T1', startedAt: ago(10), runStatus: 'succeeded' },
            { taskId: 'T2', startedAt: ago(10), runStatus: 'failed' },
            { taskId: 'T3', composedAt: ago(10), state: 'retired' },
        ],
    },
};

const CFG = config(MAIN, LEDGERS);
const oldFile = path.join(CFG, 'projects', 'proj', 'OLD.jsonl');
const tenDays = (NOW - 10 * DAY * 3600 * 1000) / 1000;
fs.utimesSync(oldFile, tenDays, tenDays);

ghData(GH_ALL);
const { r: jr, j } = run(CFG, ['--json', '--repo', 'acme/other']);
const argvLog = (() => { try { return fs.readFileSync(path.join(GH_DIR, 'argv.txt'), 'utf8'); } catch { return ''; } })();
const prOf = (num, repo = 'acme/widgets') => (j?.prs || []).find((p) => p.repo === repo && p.number === num);

// ------------------------------------------------------------ the contract

check('--json exits 0 when measured', jr.status === 0, jr.stderr);
check('--json prints one parseable object with ok:true', j?.ok === true, jr.stdout.slice(0, 200));
check('says the basis is not a bill', /NOT a subscription bill/.test(j?.basis || ''), j?.basis);
check('the window says its days and start', j?.window?.days === 7 && !!Date.parse(j?.window?.since || ''),
    JSON.stringify(j?.window));

// -------------------------------------------------------- one response, one price

check('a response written as three rows is priced once, from its last row',
    near(prOf(11)?.cost, 3.75), prOf(11)?.cost);
check('repeated rows of one response are counted as repeated',
    j?.population?.repeatedRows === 2, JSON.stringify(j?.population));
check('usage rows in the span are all counted before the dedupe',
    j?.population?.usageRows === 10, j?.population?.usageRows);
check('responses priced is the distinct message id and request id pairs',
    j?.population?.responses === 8, j?.population?.responses);
check('a row from before the span is not priced', near(j?.cost?.unattributed, 1), j?.cost?.unattributed);
check('a transcript untouched since before the span is skipped, not read',
    j?.population?.transcriptsSkipped === 1 && j?.population?.transcriptsRead === 8, JSON.stringify(j?.population));
check('no row priced at the fallback rate when every model is known',
    j?.population?.fallbackPriced === 0, j?.population?.fallbackPriced);

// ------------------------------------------------------------- token classes

{
    const t = prOf(11)?.tokens || {};
    check('input tokens are the last row\'s, not three rows\' sum', t.input === 100000, JSON.stringify(t));
    check('output tokens are the last row\'s final count plus the subagent\'s', t.output === 60000, JSON.stringify(t));
    check('cache write tokens are one response\'s', t.cacheWrite === 200000, JSON.stringify(t));
    check('cache read tokens are one response\'s', t.cacheRead === 1000000, JSON.stringify(t));
}

// ---------------------------------------------------------------- attribution

check('gh pr create links a session to the PR its result names',
    prOf(11)?.sessions === 1 && prOf(11)?.via?.create === 1, JSON.stringify(prOf(11)));
check('a create link and a commit on the same PR\'s branch count the session once',
    prOf(11)?.via?.branch === 0, JSON.stringify(prOf(11)?.via));
check('a subagent transcript bills the parent session', near(prOf(11)?.cost, 3.25 + 0.5), prOf(11)?.cost);
check('a commit branch links a session to the PR merged from that branch',
    near(prOf(12)?.cost, 1) && prOf(12)?.via?.branch === 1, JSON.stringify(prOf(12)));
check('a commit on main links nothing, so the feat/b session is not split', near(prOf(12)?.cost, 1), prOf(12)?.cost);
check('the same branch name in another repo does not collect the session',
    near(prOf(5, 'acme/other')?.cost, 0) && prOf(5, 'acme/other')?.sessions === 0, JSON.stringify(prOf(5, 'acme/other')));
check('gh pr merge links a session with no stronger evidence',
    near(prOf(13)?.cost, 2) && prOf(13)?.via?.merge === 1, JSON.stringify(prOf(13)));
check('a session on two branches splits its cost equally', near(prOf(14)?.cost, 1), prOf(14)?.cost);
check('the share for work not merged in the span is kept and reported',
    near(j?.cost?.notMerged, 1 + 0.25), j?.cost?.notMerged);
check('the branch a session ran on links it to the PR merged from that branch',
    near(prOf(15)?.cost, 0.5) && prOf(15)?.via?.checkout === 1, JSON.stringify(prOf(15)));
check('a create link and rows on the same PR\'s branch count the session once',
    prOf(11)?.via?.checkout === 0 && prOf(11)?.sessions === 1, JSON.stringify(prOf(11)?.via));
check('a merged PR nobody worked on reads zero', near(prOf(16)?.cost, 0) && prOf(16)?.sessions === 0,
    JSON.stringify(prOf(16)));
check('a PR merged before the span is not listed', !prOf(9), JSON.stringify(prOf(9)));
check('"gh pr merge 42" inside a brief\'s prose is not a merge',
    j?.population?.unattributed === 1 && near(j?.cost?.unattributed, 1), JSON.stringify(j?.cost));
check('a placeholder repo in a merge command adds no repo to ask gh about',
    j?.population?.repos === 2 && (j?.population?.reposUnreadable || []).length === 0,
    JSON.stringify(j?.population));
check('PRs sort by cost, highest first',
    (j?.prs || []).slice(0, 2).map((p) => p.number).join(',') === '11,13', (j?.prs || []).map((p) => p.number).join(','));

// ----------------------------------------------------------------- population

{
    const p = j?.population || {};
    check('sessions with usage are counted', p.sessions === 7, p.sessions);
    check('sessions linked to a merged PR are counted', p.linkedToMerged === 5, p.linkedToMerged);
    check('each linked session is counted once, by its strongest evidence',
        p.via?.create === 1 && p.via?.branch === 2 && p.via?.checkout === 1 && p.via?.merge === 1, JSON.stringify(p.via));
    check('a session linked only to unmerged work is counted apart', p.onlyNotMerged === 1, p.onlyNotMerged);
    check('an unattributed session is counted', p.unattributed === 1, p.unattributed);
    check('merged PRs in the span are counted across repos', p.mergedPrs === 7, p.mergedPrs);
    check('merged PRs with an attributed session are counted', p.prsWithSessions === 5, p.prsWithSessions);
    check('the dollars add up: merged + not merged + unattributed = total',
        near(j?.cost?.merged + j?.cost?.notMerged + j?.cost?.unattributed, j?.cost?.cost, 1e-6)
        && near(j?.cost?.cost, 10.5), JSON.stringify(j?.cost));
}

// --------------------------------------------------------------------- gh call

check('gh is asked for merged PRs only', /"--state","merged"/.test(argvLog), argvLog.slice(0, 200));
check('gh is asked from the start of the span',
    argvLog.includes('merged:>=' + new Date(NOW - 7 * DAY * 3600 * 1000).toISOString().slice(0, 10)), argvLog.slice(0, 300));
check('the session cwd inside a worktree maps to the main repo\'s origin',
    /"--repo","acme\/widgets"/.test(argvLog), argvLog.slice(0, 200));
check('--repo adds a repo no session named', /"--repo","acme\/other"/.test(argvLog), argvLog.slice(0, 300));

// ------------------------------------------------------------ passes per story

{
    const h = j?.passes?.headless || {};
    check('headless: a story is active when a run started in the span', h.stories === 3, JSON.stringify(h));
    check('headless: the median counts runs to the first done', h.median === 1.5 && h.max === 2, JSON.stringify(h));
    check('headless: a story with no done run is counted as never done', h.notDone === 1 && h.done === 2, JSON.stringify(h));
    const u = j?.passes?.unattended || {};
    check('unattended: tasks are keyed by taskId, composedAt when never started',
        u.stories === 3 && u.done === 1 && u.notDone === 2 && u.median === 1, JSON.stringify(u));
}

// ---------------------------------------------------------------- human output

{
    ghData(GH_ALL);
    const { r } = run(CFG, ['--repo', 'acme/other', '--top', '2']);
    const lines = r.stdout.trim().split('\n');
    check('the summary exits 0', r.status === 0, r.stderr);
    check('every summary line carries a count', lines.length > 5 && lines.every((l) => /\d/.test(l)),
        lines.filter((l) => !/\d/.test(l)).join(' | '));
    check('the summary names the list-price basis', /NOT a bill/.test(lines[0] || ''), lines[0]);
    check('the summary prints the population line for sessions',
        lines.some((l) => /^sessions: 7 with usage, 5 linked to a merged PR.*1 by the branch it ran on/.test(l)), lines.join('\n'));
    check('--top limits the PR list', lines.some((l) => l === 'top 2 merged PR(s) by cost:')
        && !lines.some((l) => /^ {2}3\. /.test(l)), lines.join('\n'));
    check('a PR line carries cost and all four token classes',
        lines.some((l) => /^ {2}1\. acme\/widgets#11 {2}\$4 {2}1 session\(s\) {2}in 100k {2}out 60k {2}cache write 200k {2}cache read 1\.0M/.test(l)),
        lines.find((l) => /#11/.test(l)));
    check('the headless line prints the median', lines.some((l) => /^headless ledger: 3 code\(s\).*median 1\.5/.test(l)),
        lines.join('\n'));
}

{
    // No ledger files: a count of zero, not an error.
    ghData(GH_ALL);
    const { r } = run(config({ 'proj/S2.jsonl': MAIN['proj/S2.jsonl'] }), []);
    check('missing ledgers read as zero records and exit 0',
        r.status === 0 && /headless ledger: 0 records/.test(r.stdout) && /unattended ledger: 0 records/.test(r.stdout),
        r.stdout + r.stderr);
}

{
    // An unknown model is priced at the fallback rate and counted as such.
    ghData(GH_ALL);
    const cfg = config({ 'proj/U.jsonl': [usageRow('U', REPO_DIR, ago(H), 'mu', 'ru', 'claude-future-9', { output_tokens: 10 })] });
    const { j: ju } = run(cfg, ['--json']);
    check('an unknown model is counted as fallback-priced', ju?.population?.fallbackPriced === 1, JSON.stringify(ju?.population));
}

{
    // One repo readable, one not: measured, and the unreadable one is named.
    ghData({ 'acme/widgets': GH_ALL['acme/widgets'] });
    const { r } = run(CFG, ['--repo', 'acme/missing']);
    check('one unreadable repo of two still measures', r.status === 0, r.stderr);
    check('an unreadable repo is named with a count', /unreadable repo 1 of 1: acme\/missing: exit 1: HTTP 404/.test(r.stdout),
        r.stdout);
}

// ------------------------------------------------------- could not measure

{
    const cfg = path.join(ROOT, 'no-projects');
    fs.mkdirSync(cfg, { recursive: true });
    const { r, j: je } = run(cfg, ['--json']);
    check('no transcript directory exits 2', r.status === 2, r.status);
    check('no transcript directory says why in --json', je?.ok === false && /no transcript directory/.test(je?.reason || ''),
        r.stdout);
}

{
    ghData({});
    const { r } = run(CFG, []);
    check('no merged-PR list from any repo exits 2', r.status === 2, r.status + ' ' + r.stdout.slice(0, 120));
    check('no merged-PR list names the failure', /COULD NOT MEASURE: no merged-PR list from any of 1 repo/.test(r.stderr), r.stderr);
}

{
    ghData(GH_ALL);
    const cfg = config({ 'proj/S2.jsonl': MAIN['proj/S2.jsonl'] }, { 'headless-workers.json': '{not json' });
    const { r, j: je } = run(cfg, ['--json']);
    check('a ledger that does not parse exits 2', r.status === 2, r.status);
    check('a ledger that does not parse is named', /headless ledger does not parse/.test(je?.reason || ''), r.stdout);
}

{
    const { r } = run(CFG, ['--days', '0']);
    check('--days 0 exits 2', r.status === 2, r.status);
}

{
    const { r } = run(CFG, ['--help']);
    check('--help exits 0 and names the exit codes', r.status === 0 && /Exit 0 measured, 2 when/.test(r.stdout), r.stdout);
}

// -------------------------------------------------------------------- report

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`work-cost: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exitCode = 1;
} else {
    console.log(`work-cost: ${passed}/${total} passed, one response priced once, attribution by evidence, population and passes per story`);
}
