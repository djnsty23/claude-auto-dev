#!/usr/bin/env node
'use strict';
// Tests for tooling/mistake-recurrence.js, the table that says whether a
// mistake class stopped once a rule or a detector claimed to prevent it.
// Run: node tooling/test-mistake-recurrence.js
// Exits 1 on any failure, 0 when all pass.
//
// THE SEAM. The script reads three things: a lessons dir, a git mirror whose
// history dates each rule, and a code repo whose history dates each detector.
// This suite builds all three in a temp dir, with every commit date set through
// GIT_COMMITTER_DATE, and runs the shipped CLI as a subprocess. Git is made
// hermetic (no global or system config, no hooks, discovery stopped at the
// fixture), so an operator's settings cannot move a date under test.
//
// WHAT IT PINS.
//   - the population print, number by number, because every rate is read
//     against it
//   - the before and after split: the prevention day counts as before, and so
//     do the --grace days after it
//   - dating: the first commit that ADDED the anchor line, not the file's first
//     commit, a [stated] tag that is earlier than git, a detector dated by its
//     file, and an anchor that landed in the root commit marked on-or-before
//   - units: table rows inheriting their heading's date, moved text and
//     preambles excluded, [stated] tags and file-name dates never counted as
//     incidents, future dates dropped, overrides winning
//   - a PLANTED RECURRENCE: a class with no incident after its rule goes into
//     the recurred list once one incident after it is added
//   - exit 2 on every unreadable input, including a catalog pattern carrying a
//     control character, which is what a `\\b` written through a shell heredoc
//     becomes

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(__dirname, 'mistake-recurrence.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok ? '' : '  (' + detail + ')'));
}
function eq(label, actual, expected) {
    check(label, actual === expected, 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
const clip = (s) => JSON.stringify(String(s).slice(0, 1200));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mistake-recurrence-'));
const LESSONS = path.join(fixture, 'lessons');
const LESSONS2 = path.join(fixture, 'lessons-planted');
const EMPTY = path.join(fixture, 'lessons-empty');
const MIRROR = path.join(fixture, 'mirror');
const CODE = path.join(fixture, 'code');
const PRODUCT = path.join(fixture, 'product');
const PLAIN = path.join(fixture, 'plain');
const CATALOG = path.join(fixture, 'catalog.json');
const NOHOOKS = path.join(fixture, 'nohooks');
const NOCONFIG = path.join(fixture, 'no-such-gitconfig');

const GIT_ENV = {
    GIT_CONFIG_GLOBAL: NOCONFIG,
    GIT_CONFIG_SYSTEM: NOCONFIG,
    GIT_CEILING_DIRECTORIES: fixture,
    GIT_TERMINAL_PROMPT: '0',
};
function cleanEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
    return Object.assign(env, GIT_ENV);
}

function git(cwd, args, extraEnv) {
    const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + NOHOOKS, ...args],
    { cwd, encoding: 'utf8', env: Object.assign(cleanEnv(), extraEnv || {}) });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout));
    return r.stdout;
}

function commitAt(repo, iso, files, subject) {
    for (const [rel, text] of Object.entries(files)) {
        const p = path.join(repo, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, text);
    }
    git(repo, ['add', '--', ...Object.keys(files)]);
    const msg = path.join(fixture, 'msg.txt');
    fs.writeFileSync(msg, subject);
    git(repo, ['commit', '-q', '--no-verify', '-F', msg], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

function initRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main', '.']);
}

// The lessons file. Every unit's expected fate is in the comment beside it.
const ALPHA = [
    '# Alpha lessons',
    '',
    'Preamble written 2026-02-02, excluded as a preamble.',
    '',
    '## Moved from the old file (2026-02-03)',             // excluded: moved rule text
    '',
    'This one says too early but it is moved text.',
    '',
    '## The probe ran too early (2026-03-01)',              // early 03-01
    '',
    'Body.',
    '',
    '## Checked the page too early again, 2026-03-02',       // early 03-02, the prevention day
    '',
    '## Another too early read 2026-03-03',                 // early 03-03, inside a one-day grace
    '',
    '## Too early a fourth time 2026-03-10',                // early 03-10, after
    '',
    'A tag [stated 2026-01-05] is not an incident, nor is report-2026-03-11.md.',
    '',
    '## Same day too early duplicate 2026-03-10',           // early 03-10 again: one incident-day
    '',
    '## Undated too early thing',                          // undated
    '',
    '## Future too early 2027-01-01',                      // undated: after --now
    '',
    '## Override me 2026-03-04',                           // overridden to no class
    '',
    'The lead says too early, and the catalog overrides it.',
    '',
    '5. **Stayed quiet** about the failure on 2026-01-20.', // quiet 01-20, a numbered rule entry
    '',
    '## Table incidents 2026-03-05',                       // dated, unclassified
    '',
    '| **Tabled row one** | no date of its own |',         // tabled 03-05, inherited
    '| **Tabled row two** | 2026-03-20 |',                 // tabled 03-20
    '',
    '## A plain heading 2026-03-08',                       // none-yet 03-08, by its lead
    '',
    'The lead says unprevented, so the lead classifies it.',
    '',
    '## Ancient thing 2026-03-09',                         // ancient 03-09
    '',
].join('\n');

const CATALOG_JSON = {
    excludeFiles: ['index.md'],
    classes: [
        { id: 'early', match: ['too early'], mineFixes: ['ordering / async race'],
            anchors: [{ kind: 'rule', repo: 'mirror', path: 'rules/a.md', re: 'wait for ready' }] },
        { id: 'quiet', match: ['quiet'], anchors: [{ kind: 'rule', repo: 'mirror', path: 'rules/b.md', re: 'speak up' }] },
        { id: 'tabled', match: ['tabled'], anchors: [{ kind: 'detector', repo: 'code', path: 'tools/det.js' }] },
        { id: 'none-yet', match: ['unprevented'], anchors: [] },
        { id: 'ancient', match: ['ancient'],
            anchors: [{ kind: 'rule', repo: 'mirror', path: ['rules/root.md', 'rules/elsewhere.md'], re: 'ancient rule' }] },
    ],
    overrides: { 'alpha.md#Override me': [], 'alpha.md#No such title': ['quiet'] },
};

function build() {
    fs.mkdirSync(NOHOOKS, { recursive: true });
    fs.mkdirSync(PLAIN, { recursive: true });
    fs.mkdirSync(EMPTY, { recursive: true });
    fs.mkdirSync(LESSONS, { recursive: true });
    fs.writeFileSync(path.join(LESSONS, 'alpha.md'), ALPHA);
    // Excluded by the catalog. Counted, it would add an early incident on 05-05.
    fs.writeFileSync(path.join(LESSONS, 'index.md'), '# Index\n\n## Too early index 2026-05-05\n');
    fs.writeFileSync(CATALOG, JSON.stringify(CATALOG_JSON, null, 2));

    // The planted copy: the same lessons plus one quiet incident AFTER its rule.
    fs.mkdirSync(LESSONS2, { recursive: true });
    fs.writeFileSync(path.join(LESSONS2, 'alpha.md'), ALPHA);
    fs.writeFileSync(path.join(LESSONS2, 'beta.md'), '# Beta\n\n## Quiet again 2026-04-01\n\nSkipped a check and said nothing.\n');

    initRepo(MIRROR);
    commitAt(MIRROR, '2026-01-15T09:00:00+00:00', { 'README.md': 'mirror\n', 'rules/root.md': '- The ancient rule.\n' }, 'root');
    // rules/a.md exists from 02-20, but its anchor line lands on 03-02. Dating by
    // the file's first commit would put early's prevention 10 days too soon.
    commitAt(MIRROR, '2026-02-20T09:00:00+00:00', { 'rules/a.md': '# Rules A\n' }, 'add a');
    commitAt(MIRROR, '2026-03-02T10:00:00+00:00', { 'rules/a.md': '- Wait for ready before reading.\n' }, 'rule');
    // Committed 03-15, but the line says it was stated 02-01: the earlier wins.
    commitAt(MIRROR, '2026-03-15T09:00:00+00:00', { 'rules/b.md': '- Speak up when a check is skipped [stated 2026-02-01].\n' }, 'rule b');

    initRepo(CODE);
    commitAt(CODE, '2026-01-01T09:00:00+00:00', { 'README.md': 'code\n' }, 'root');
    commitAt(CODE, '2026-03-06T09:00:00+00:00', { 'tools/det.js': '// detector\n' }, 'detector');

    // A product repo with two rework fixes of the ordering class, one on each
    // side of early's prevention.
    initRepo(PRODUCT);
    commitAt(PRODUCT, '2026-02-10T09:00:00+00:00', { 'src/boot.js': 'a\n' }, 'feat(boot): add boot');
    commitAt(PRODUCT, '2026-02-11T09:00:00+00:00', { 'src/boot.js': 'b\n' }, 'fix(boot): race on boot');
    commitAt(PRODUCT, '2026-03-19T09:00:00+00:00', { 'src/read.js': 'a\n' }, 'feat(read): add reader');
    commitAt(PRODUCT, '2026-03-20T09:00:00+00:00', { 'src/read.js': 'b\n' }, 'fix(read): await the ready state before reading');
}

function run(args) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], { cwd: fixture, encoding: 'utf8', env: cleanEnv() });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const BASE = ['--lessons', LESSONS, '--mirror', MIRROR, '--code-repo', CODE, '--catalog', CATALOG, '--now', '2026-06-01'];
function runJson(extra) {
    const r = run([...BASE, ...(extra || []), '--json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* reported by the caller */ }
    return Object.assign(r, { json: j });
}
const rowOf = (j, id) => ((j && j.rows) || []).find((r) => r.id === id) || {};
const tableLine = (out, id) => (out.split('\n').find((l) => l.startsWith('  ' + id + ' ')) || '').replace(/\s+/g, ' ').trim();

try {
    build();

    // ---- the population ------------------------------------------------
    {
        const r = run(BASE);
        eq('a full run exits 0', r.status, 0);
        eq('...with nothing on stderr', r.stderr, '');
        const o = r.stdout;
        check('prints the population first', o.startsWith('POPULATION (as of 2026-06-01)'), clip(o));
        check('names the file the catalog excluded', o.includes('lessons files: 1 read of 2 (excluded by the catalog: index.md)'), clip(o));
        check('counts units and both exclusions', o.includes('units: 16, of which 1 file preambles and 1 moved-rule-text units are excluded'), clip(o));
        check('splits the rest into dated and undated', o.includes('remaining units: 12 dated, 2 undated'), clip(o));
        check('dated units: classified, unclassified, overridden', o.includes('dated units: 10 classified, 1 unclassified, 1 overridden to no class'), clip(o));
        check('dedupes two units on one day into one incident-day', o.includes('incident-days (class x day): 9 from 10 classified unit-date pairs'), clip(o));
        check('counts classes with incidents and with a prevention date', o.includes('classes: 5, 5 with an incident, 4 with a prevention date (1 dated to the first mirror commit'), clip(o));
        check('names an override that matched no unit', o.includes('overrides that matched no unit: alpha.md#no such title'), clip(o));
        check('the table header states the grace', o.includes('the prevention day and the 1 day after it count as before'), clip(o));
    }

    // ---- the split and the dating -------------------------------------------
    {
        const r = runJson();
        eq('--json exits 0', r.status, 0);
        check('...and parses', r.json !== null, clip(r.stdout));
        const j = r.json || {};
        const early = rowOf(j, 'early');
        eq('the anchor is dated by the commit that ADDED its line, not the file', early.prevention && early.prevention.day, '2026-03-02');
        eq('the prevention day and the grace day count as before', early.lessons && early.lessons.before, 3);
        eq('...and the one later day counts as after', early.lessons && early.lessons.after, 1);
        check('...giving a rate of 1/3', early.lessons && Math.abs(early.lessons.rate - 1 / 3) < 1e-9, JSON.stringify(early.lessons));
        eq('the anchor shows where its line sits today', early.prevention && early.prevention.where, 'rules/a.md:2');
        eq('an incident dated only in an excluded file is not counted', (early.lessonDays || []).includes('2026-05-05'), false);
        eq('a [stated] tag and a file-name date are not incidents', JSON.stringify(early.lessonDays), JSON.stringify(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-10']));

        const quiet = rowOf(j, 'quiet');
        eq('a [stated] tag earlier than git dates the prevention', quiet.prevention && quiet.prevention.day, '2026-02-01');
        eq('...and says where the date came from', quiet.prevention && quiet.prevention.source, 'stated');
        eq('a numbered rule entry is a unit with its own date', JSON.stringify(quiet.lessonDays), JSON.stringify(['2026-01-20']));
        eq('a class with no incident after its rule has not recurred', quiet.recurred, false);

        const tabled = rowOf(j, 'tabled');
        eq('a table row with no date inherits its heading\'s', JSON.stringify(tabled.lessonDays), JSON.stringify(['2026-03-05', '2026-03-20']));
        eq('a detector with no pattern is dated by its file\'s first commit', tabled.prevention && tabled.prevention.day, '2026-03-06');
        eq('...its kind is detector', tabled.preventionKinds, 'detector');
        eq('...and its first detector day is recorded', tabled.firstDetectorDay, '2026-03-06');

        const ancient = rowOf(j, 'ancient');
        eq('an anchor from the root commit is marked on-or-before', ancient.prevention && ancient.prevention.predatesHistory, true);
        eq('...a rate with nothing before is inf in JSON', ancient.lessons && ancient.lessons.rate, 'inf');
        check('an anchor path that is not on disk says so', (ancient.anchors || []).some((a) => /rules\/elsewhere\.md \(not on disk\)/.test(a.where)), JSON.stringify(ancient.anchors));

        const none = rowOf(j, 'none-yet');
        eq('a class with no anchor has no prevention', none.prevention, null);
        eq('...its kind is none', none.preventionKinds, 'none');
        eq('...and a class classified only by its lead still counts', none.lessons && none.lessons.total, 1);

        eq('the recurred list, most after first, then fewest before', JSON.stringify(j.recurring), JSON.stringify(['ancient', 'tabled', 'early']));
        eq('the population carries the grace', j.population && j.population.grace, 1);
    }

    // ---- --grace 0 is the strict split --------------------------------------
    {
        const r = runJson(['--grace', '0']);
        const early = rowOf(r.json, 'early');
        eq('--grace 0: the day after the prevention counts as after', early.lessons && early.lessons.after, 2);
        eq('...and only the prevention day itself as before', early.lessons && early.lessons.before, 2);
        const t = run([...BASE, '--grace', '0']);
        check('...and the header says so', t.stdout.includes('TABLE (lessons incident-days, the prevention day counts as before)'), clip(t.stdout));
    }

    // ---- the planted recurrence ---------------------------------------------
    {
        const before = run(BASE);
        const after = run(['--lessons', LESSONS2, ...BASE.slice(2)]);
        eq('baseline: quiet is not in the recurred list', /^\s+quiet:/m.test(before.stdout), false);
        check('baseline: 3 of 4 prevented classes recurred', before.stdout.includes('RECURRED AFTER PREVENTION: 3 of 4 prevented classes'), clip(before.stdout));
        eq('planted: one quiet incident after its rule, exit 0', after.status, 0);
        check('planted: quiet is now in the recurred list with its day',
            /^\s+quiet: 1 after, 1 before, prevention rule since 2026-02-01, after-days 2026-04-01$/m.test(after.stdout), clip(after.stdout));
        check('planted: 4 of 4 prevented classes recurred', after.stdout.includes('RECURRED AFTER PREVENTION: 4 of 4 prevented classes'), clip(after.stdout));
        eq('planted: the table row moves from 1/0 to 1/1', tableLine(after.stdout, 'quiet'), 'quiet 1 1 1.00 rule 2026-02-01 rules/b.md:1');
    }

    // ---- fix commits through mine-fixes -------------------------------------
    {
        const r = runJson(['--repo', PRODUCT]);
        eq('--repo exits 0', r.status, 0);
        const early = rowOf(r.json, 'early');
        eq('a mapped rework fix before the prevention counts as before', early.fixes && early.fixes.before, 1);
        eq('...and one after it as after', early.fixes && early.fixes.after, 1);
        eq('...from two records', early.fixes && early.fixes.records, 2);
        const fr = ((r.json && r.json.population && r.json.population.fixRepos) || [])[0] || {};
        eq('the population names the repo and its rework count', fr.repo + ' ' + fr.reworkRecords, 'product 2');
        eq('lessons counts are unchanged by fix commits', early.lessons && early.lessons.after, 1);
    }

    // ---- --units ------------------------------------------------------------
    {
        const r = run([...BASE, '--units']);
        check('--units lists an excluded unit with its reason', /alpha\s+\[moved rule text\]/.test(r.stdout), clip(r.stdout));
        check('--units says how a unit was classified', /alpha\s+none-yet \(lead\)/.test(r.stdout), clip(r.stdout));
    }

    // ---- exit 2: every unreadable input -------------------------------------
    const exit2 = (label, args, needle) => {
        const r = run(args);
        eq(label + ': exit 2', r.status, 2);
        check(label + ': says what could not be read', r.stderr.includes(needle), clip(r.stderr));
        eq(label + ': prints no table', r.stdout.includes('TABLE'), false);
    };
    const withOut = (flag, value) => {
        const a = BASE.slice();
        const i = a.indexOf(flag);
        a[i + 1] = value;
        return a;
    };
    exit2('a missing lessons dir', withOut('--lessons', path.join(fixture, 'nope')), 'COULD NOT READ: lessons dir');
    exit2('a lessons dir with no .md', withOut('--lessons', EMPTY), 'holds no .md file');
    exit2('a mirror that is not a git repo', withOut('--mirror', PLAIN), 'is not a git repository');
    exit2('a code repo that is not a git repo', withOut('--code-repo', PLAIN), 'code repo');
    {
        const bad = path.join(fixture, 'bad.json');
        fs.writeFileSync(bad, '{ not json');
        exit2('a catalog that does not parse', withOut('--catalog', bad), 'could not be read');
    }
    {
        // What a heredoc does to `"\\bword"`: the JSON arrives as `"\bword"`,
        // which parses to a BACKSPACE, and the regex then matches nothing.
        const mangled = path.join(fixture, 'mangled.json');
        const text = JSON.stringify(CATALOG_JSON).replace('"too early"', '"\\btoo early"');
        fs.writeFileSync(mangled, text);
        exit2('a catalog pattern holding a control character', withOut('--catalog', mangled), 'control character');
    }
    exit2('a --repo mine-fixes cannot read', [...BASE, '--repo', PLAIN], 'mine-fixes could not read');
    {
        const r = run([...BASE, '--bogus']);
        eq('an unknown argument exits 2', r.status, 2);
        check('...naming it', r.stderr.includes('unknown argument: --bogus'), clip(r.stderr));
        eq('a flag with no value exits 2', run([...BASE, '--now']).status, 2);
        eq('a --grace that is not a number exits 2', run([...BASE, '--grace', 'x']).status, 2);
        eq('a --now that is not a date exits 2', run([...BASE.slice(0, -1), 'yesterday']).status, 2);
    }

    // ---- --help ---------------------------------------------------------------
    {
        const r = run(['--help']);
        eq('--help exits 0', r.status, 0);
        check('...printing the usage', r.stdout.startsWith('usage: node tooling/mistake-recurrence.js'), clip(r.stdout));
        eq('...and reading nothing', r.stderr, '');
    }
} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail > 0 ? 1 : 0;
