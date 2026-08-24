#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/mine-fixes.js - the script that ranks
// which failure classes a project actually ships, so a team gates the problem
// it has instead of inheriting somebody else's checklist.
// Run: node tooling/test-mine-fixes.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS ONE NEEDS TESTING AT ALL.
//
// Its output is a RANKING, and a ranking is the shape of answer that is never
// obviously wrong. A parse that loses a field, a window that silently reverts
// to its default, a class regex that stops matching - none of those error, and
// all of them produce a plausible bar chart naming the wrong class first. The
// cost is not a crash, it is a quarter spent building a gate for a failure mode
// this project does not have while the real one stays unguarded.
//
// THE SEAM, AND WHY IT IS THE REAL ONE.
//
// mine-fixes.js has no exports. Its only input is `git log` run with `cwd` set
// to the repo path it was given on argv, so the seam is A REAL GIT REPOSITORY
// with commits this suite authored. Every assertion below runs the shipped CLI
// as a subprocess over that fixture and reads its stdout, stderr or exit
// status. Nothing here calls a helper directly, because there is no helper to
// call, and nothing here reads THIS machine's git history - so the suite cannot
// pass on a quiet day for the wrong reason, and cannot go red because somebody
// landed a commit while it was running.
//
// The fixture repo is hermetic: GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM are
// pointed at files that do not exist, so an operator's `log.showSignature` or
// `log.date` cannot reframe the records under test. Every commit's %ct is set
// explicitly through GIT_COMMITTER_DATE, because the rework window is measured
// in seconds between commits and inferring it from "when the fixture happened
// to be built" would make the whole suite a clock test.
//
// THE PLANTED MALFORMED RECORDS, AND WHAT THEY DEMONSTRATE.
//
// The parser frames records with `--format=%x00%H%x01%ct%x01%s`, then does
// `lines[0].split('\x01')` and destructures three fields. Git preserves a
// literal 0x01 byte inside a commit subject - measured, not assumed - so a
// subject containing one splits into FOUR parts and everything past the first
// 0x01 is discarded. The record is not dropped: it is still counted as a fix,
// still counted as rework, and silently contributes to no class at all.
//
// Two such commits are planted, and their hidden halves both carry
// `cache / key scoping` evidence. With them read correctly that class would
// score 4 against `ordering / async race`'s 3 and would rank FIRST. As shipped
// it scores 2 and ranks second. So `cache / key scoping` being 2 rather than 4
// is this suite's pin on the misparse, and the edit that turns it red is the
// obvious repair: a separator git cannot lose, or a split with a field limit.
// The behaviour is pinned rather than endorsed - see the report at the bottom.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'mine-fixes.js');

let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  (' + detail + ')'}`);
}

function eq(label, actual, expected) {
    check(label, actual === expected,
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const clip = (s) => JSON.stringify(String(s).slice(0, 900));

// ---------------------------------------------------------------------------
// Fixture machine
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-fixes-'));

const REPO = path.join(fixture, 'orchard');       // the graded history
const BARREN = path.join(fixture, 'barren');      // commits, but no `fix:` ones
const PLAIN = path.join(fixture, 'plain');        // not a repository at all
const NOHOOKS = path.join(fixture, 'nohooks');    // empty: disables any hook
const NOCONFIG = path.join(fixture, 'no-such-gitconfig');

// GIT_CEILING_DIRECTORIES stops discovery walking out of the fixture, so the
// "not a repository" case cannot accidentally find a real repo above tmpdir.
const GIT_ENV = {
    GIT_CONFIG_GLOBAL: NOCONFIG,
    GIT_CONFIG_SYSTEM: NOCONFIG,
    GIT_CEILING_DIRECTORIES: fixture,
    GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, args, extraEnv) {
    const r = spawnSync('git', [
        '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false',
        '-c', `core.hooksPath=${NOHOOKS}`,
        ...args,
    ], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...extraEnv } });
    if (r.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
    }
    return r.stdout || '';
}

// A fixed epoch, never `Date.now()`. mine-fixes compares commit timestamps only
// against each other, so a frozen base keeps the whole suite clock-independent.
const BASE = 1750000000;
const HOUR = 3600;
const DAY = 86400;

function commit(offsetSeconds, subject, files) {
    for (const f of files) {
        const p = path.join(REPO, f);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, `${subject}\n`);
    }
    git(REPO, ['add', '--', ...files]);
    // -F, never -m: one planted subject carries a literal 0x01 byte, and the
    // shell would not survive it. This is also the repo's own commit rule.
    const msg = path.join(fixture, 'msg.txt');
    fs.writeFileSync(msg, subject);
    const stamp = `@${BASE + offsetSeconds} +0000`;
    git(REPO, ['commit', '-q', '--no-verify', '-F', msg],
        { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
}

// The 0x01 the format string uses as its field separator. A subject carrying
// one is not exotic: anything pasted out of a log or a terminal capture can.
const SEP = '\x01';

function buildRepo() {
    fs.mkdirSync(REPO, { recursive: true });
    fs.mkdirSync(NOHOOKS, { recursive: true });
    git(REPO, ['init', '-q', '-b', 'main', '.']);

    // --- ordering / async race: three fixes, each on code a feature just
    //     shipped. This is the class that must rank first.
    commit(0 * HOUR, 'feat(session): add the boot panel', ['src/panel.js']);
    commit(1 * HOUR, 'fix(panel): await the sequence before the first paint', ['src/panel.js']);
    commit(2 * HOUR, 'feat(queue): add a background worker', ['src/queue.js']);
    commit(3 * HOUR, 'fix(queue): the worker started too early and lost a job', ['src/queue.js']);
    commit(4 * HOUR, 'fix(queue): guard the race between drain and enqueue', ['src/queue.js']);

    // --- cache / key scoping: one inside a one-day window, one outside it.
    commit(5 * HOUR, 'feat(prefs): per-tenant preferences', ['src/prefs.js']);
    commit(6 * HOUR, 'fix(prefs): drop the stale cache key when the tenant switches', ['src/prefs.js']);

    // --- one fix that matches TWO classes. The classifier has no `break`, so
    //     it counts in both, and a reader summing the bars gets more than the
    //     rework count. That is a property, and it is pinned below.
    commit(7 * HOUR, 'refactor(report): split the report renderer', ['src/report.js']);
    commit(8 * HOUR, 'fix(report): the header and the footer disagree on the same value', ['src/report.js']);

    // --- a fix on code NO feature touched. It would classify as copy / i18n
    //     drift if classification ran over all fixes; it must not appear.
    commit(9 * HOUR, 'fix(legacy): correct a typo in the onboarding copy', ['src/legacy.js']);

    // --- filtered before anything else sees it: an application-data commit.
    commit(10 * HOUR, 'stats: nightly rollup', ['data/stats.json']);

    // --- counted as an engineering commit, but neither feature nor fix.
    commit(11 * HOUR, 'wip poking at things', ['src/misc.js']);

    // --- the two malformed records. Everything after SEP is discarded, so the
    //     `cache` evidence in each never reaches the ranking.
    commit(2 * HOUR + 2 * DAY + HOUR,
        `fix(ghost): tidy${SEP} the stale cache key for the tenant`, ['src/queue.js']);

    // --- a cache fix 2.04 days after its feature: inside the 3-day default,
    //     outside a 1-day window. This is what makes --window-days observable.
    commit(5 * HOUR + 2 * DAY + HOUR,
        'fix(prefs): keyed by account, not by device', ['src/prefs.js']);

    commit(5 * HOUR + 2 * DAY + 2 * HOUR,
        `fix(ghost): tidy${SEP} a stale cache key per tenant`, ['src/prefs.js']);

    // --- a merge whose own subject is a `fix:` that would score on ordering.
    //     --no-merges must drop it, so the fix count stays 9 rather than 10.
    const stamp = `@${BASE + 5 * HOUR + 3 * DAY} +0000`;
    git(REPO, ['checkout', '-q', '-b', 'side']);
    fs.writeFileSync(path.join(REPO, 'src', 'side.js'), 'side\n');
    git(REPO, ['add', '--', 'src/side.js']);
    const sideMsg = path.join(fixture, 'side.txt');
    fs.writeFileSync(sideMsg, 'chore(side): note the drain loop');
    git(REPO, ['commit', '-q', '--no-verify', '-F', sideMsg],
        { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
    git(REPO, ['checkout', '-q', 'main']);
    const mergeMsg = path.join(fixture, 'merge.txt');
    fs.writeFileSync(mergeMsg, 'fix(merge): resolve the race in the drain loop');
    git(REPO, ['merge', '-q', '--no-ff', '--no-verify', '-F', mergeMsg, 'side'],
        { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
}

function buildBarren() {
    fs.mkdirSync(BARREN, { recursive: true });
    git(BARREN, ['init', '-q', '-b', 'main', '.']);
    const stamp = `@${BASE} +0000`;
    for (const [name, subject] of [
        ['a.js', 'feat(a): add a thing'],
        ['b.js', 'chore(b): tidy the thing'],
    ]) {
        fs.writeFileSync(path.join(BARREN, name), name);
        git(BARREN, ['add', '--', name]);
        const m = path.join(fixture, 'barren-msg.txt');
        fs.writeFileSync(m, subject);
        git(BARREN, ['commit', '-q', '--no-verify', '-F', m],
            { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
    }
}

// ---------------------------------------------------------------------------
// Subprocess helpers. Nothing here requires the subject in-process.
// ---------------------------------------------------------------------------

function run(args) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV },
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runJson(args) {
    const r = run([...args, '--json']);
    let parsed = null, err = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { err = e.message; }
    return { ...r, json: parsed, parseError: err };
}

const classCount = (j, name) => {
    const hit = (j.classes || []).find((c) => c.name === name);
    return hit ? hit.count : null;
};

// ---------------------------------------------------------------------------

try {
    buildRepo();
    buildBarren();
    fs.mkdirSync(PLAIN, { recursive: true });

    // -----------------------------------------------------------------------
    // The parse. Every number below is a count of records the script framed out
    // of raw `git log` output, so a mis-framed record moves at least one.
    // -----------------------------------------------------------------------
    let ranked;
    {
        const r = runJson([REPO]);
        eq('--json over a real repository exits 0', r.status, 0);
        eq('...emitting parseable JSON', r.parseError, null);
        const j = r.json || {};

        eq('the repo it reports is the one it was handed', j.repo, path.resolve(REPO));

        // 16 non-merge commits exist; `stats: nightly rollup` is filtered as
        // application data before anything counts it.
        eq('an application-data commit is excluded from the population', j.commits, 15);

        eq('feat and refactor both count as features', j.feats, 4);

        // 10 `fix:` subjects exist across the history. The merge commit is one
        // of them, and --no-merges is the only thing keeping it out.
        eq('a merge commit is not a fix, however its subject reads', j.fixes, 9);

        eq('fixes per feature is the measured ratio, not a rounding of it',
            j.fixesPerFeature, 2.25);

        eq('rework counts fixes landing on code a feature just touched',
            j.reworkCount, 8);
        eq('...as a percentage of all fixes, not of all commits', j.reworkPct, 89);

        // -------------------------------------------------------------------
        // The ranking. This is the output somebody acts on.
        // -------------------------------------------------------------------
        ranked = (j.classes || []).map((c) => `${c.name}=${c.count}`).join(', ');
        eq('the ranking is ordered by evidence, strongest class first', ranked,
            'ordering / async race=3, cache / key scoping=2, '
            + 'duplicated derivation=1, cross-surface consistency=1');

        eq('the top class carries three rework commits',
            classCount(j, 'ordering / async race'), 3);

        // THE MISPARSE PIN. Two rework records carry `stale cache key` /
        // `tenant` evidence behind a 0x01 in their subject. Read correctly this
        // is 4 and outranks ordering; as shipped the evidence is discarded.
        eq('a subject split by the format separator loses its class evidence',
            classCount(j, 'cache / key scoping'), 2);

        // ...and the malformed records are not dropped, which is what makes the
        // loss invisible: the population says 8, the ranking saw 6.
        check('...while the malformed records still count as rework',
            j.reworkCount === 8
            && !JSON.stringify(j.classes).includes('fix(ghost)'),
            `reworkCount ${j.reworkCount}, classes ${clip(JSON.stringify(j.classes))}`);

        // One fix matches two class regexes and the loop has no `break`.
        eq('a fix matching two classes is counted in both',
            classCount(j, 'duplicated derivation'), 1);
        eq('...and in the second one as well',
            classCount(j, 'cross-surface consistency'), 1);

        check('a fix on code no feature touched is never classified',
            classCount(j, 'copy / i18n drift') === null,
            `classes: ${ranked}`);

        // -------------------------------------------------------------------
        // Hot files: the same rework, counted per path instead of per class.
        // -------------------------------------------------------------------
        const hot = (j.hotFiles || []).map((h) => `${h.file}=${h.count}`).join(', ');
        eq('hot files rank the paths rework keeps landing on', hot,
            'src/queue.js=3, src/prefs.js=3, src/panel.js=1, src/report.js=1');
    }

    // -----------------------------------------------------------------------
    // The human report. It is the default entry point, and its numbers are
    // rendered separately from the JSON ones - so a divergence is reachable.
    // -----------------------------------------------------------------------
    {
        const r = run([REPO]);
        eq('the default report exits 0', r.status, 0);
        eq('a clean run writes nothing to stderr', r.stderr, '');

        check('it heads the report with the repo and its engineering commits',
            r.stdout.includes('orchard — 15 engineering commits'), clip(r.stdout));
        check('it states the fix-to-feature ratio the JSON reported',
            r.stdout.includes('9 fixes : 4 features  =  2.25 fixes per feature'),
            clip(r.stdout));
        check('it states the rework count, its percentage and the window used',
            r.stdout.includes('8 of them (89%) landed on code a feature touched in the previous 3 days.'),
            clip(r.stdout));

        // The bar length encodes the count against the leader, so an off-by-one
        // in either number changes the drawn width.
        const bar = (count, max) => '█'.repeat(Math.max(1, Math.round(count / max * 28)));
        check('the top class is drawn at full width',
            r.stdout.includes(`   3  ${'ordering / async race'.padEnd(28)} ${bar(3, 3)}`),
            clip(r.stdout));
        check('...and the second class at two thirds of it',
            r.stdout.includes(`   2  ${'cache / key scoping'.padEnd(28)} ${bar(2, 3)}`),
            clip(r.stdout));

        check('classes are printed strongest first',
            r.stdout.indexOf('ordering / async race') >= 0
            && r.stdout.indexOf('ordering / async race') < r.stdout.indexOf('cache / key scoping'),
            `ordering at ${r.stdout.indexOf('ordering / async race')}, `
            + `cache at ${r.stdout.indexOf('cache / key scoping')}`);

        // Examples are the evidence a reader checks the ranking against.
        check('each class is evidenced by the subjects that scored it',
            r.stdout.includes('  [ordering / async race]')
            && r.stdout.includes('    · fix(panel): await the sequence before the first paint')
            && r.stdout.includes('    · fix(queue): guard the race between drain and enqueue'),
            clip(r.stdout));
        check('a misparsed subject is never offered as evidence',
            !r.stdout.includes('fix(ghost)'), clip(r.stdout));

        check('hot files are listed with their rework counts',
            r.stdout.includes('     3  src/queue.js') && r.stdout.includes('     1  src/report.js'),
            clip(r.stdout));

        check('a fix that is not rework is absent from the whole report',
            !r.stdout.includes('onboarding copy'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // --window-days. The window is the definition of "rework", it is invisible
    // in the JSON, and a flag silently reverting to its default is the exact
    // failure that makes two runs disagree for no stated reason.
    // -----------------------------------------------------------------------
    {
        const wide = runJson([REPO, '--window-days=3']).json || {};
        const tight = runJson([REPO, '--window-days=1']).json || {};

        eq('the default window is three days', wide.reworkCount, 8);
        eq('a one-day window rejects the three fixes that landed 2.04 days later',
            tight.reworkCount, 5);
        eq('...which moves the reported percentage too', tight.reworkPct, 56);
        eq('...and drops a class from two records to one',
            classCount(tight, 'cache / key scoping'), 1);
        eq('...while the class that was never near the boundary is unmoved',
            classCount(tight, 'ordering / async race'), 3);
        eq('narrowing the window does not change how many fixes exist',
            tight.fixes, 9);

        const r = run([REPO, '--window-days=1']);
        check('the human report names the window it actually used',
            r.stdout.includes('5 of them (56%) landed on code a feature touched in the previous 1 days.'),
            clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // A repo with commits but no conventional fixes. The honest answer is "this
    // analysis does not apply", and the wrong one is a chart of zeroes.
    // -----------------------------------------------------------------------
    {
        const r = run([BARREN]);
        eq('a repo with no `fix:` commits exits 0', r.status, 0);
        check('...and says why the analysis cannot run',
            r.stdout.includes('No conventional `fix:` commits found'), clip(r.stdout));
        check('...rather than drawing an empty ranking',
            !r.stdout.includes('What this project actually gets wrong'), clip(r.stdout));

        const j = runJson([BARREN]);
        eq('...the JSON carries the same refusal', (j.json || {}).error,
            'No conventional `fix:` commits found — this analysis needs conventional commit subjects.');
        eq('...beside the population it did scan', (j.json || {}).commits, 2);
        check('...and no classes key a caller could read as an empty result',
            (j.json || {}).classes === undefined, clip(j.stdout));
    }

    // -----------------------------------------------------------------------
    // Not a repository. This one must fail loudly: a silent 0 here is the same
    // shape of lie as an empty ranking.
    // -----------------------------------------------------------------------
    {
        const r = run([PLAIN]);
        eq('a directory that is not a repository exits 1', r.status, 1);
        check('...naming the resolved path it tried',
            r.stderr.includes(`Not a git repository, or git failed: ${path.resolve(PLAIN)}`),
            clip(r.stderr));
        eq('...and printing no report at all', r.stdout, '');
    }

} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
