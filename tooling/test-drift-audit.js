#!/usr/bin/env node
// Tests for drift-audit.js — the prd.json half.
//
// Built on REAL git repos in a temp dir, not fixtures, because both signals
// under test are defined in terms of git history: "how long since THIS story's
// entry changed" and "is a branch carrying a prd.json nobody merged". A mock
// would let either pass while being wrong about the thing it exists to measure.
//
// COVERAGE, measured rather than assumed (npm run check:vacuity, 2026-08-16):
//
//   87 mutants · 30 caught · 57 SURVIVED
//
// All 57 were read. They are not 57 subtle gaps — they decompose along the line
// this header already draws:
//
//   37  in lines 28-177, which is auditPlugins(), auditSchedules() and
//       auditSettings() — THREE ENTIRE AUDITS WITH NO SUITE AT ALL. Not a
//       per-assertion problem; the same class as a wired hook nobody tests.
//       Every mutant there survives because nothing ever calls that code.
//   20  in the prd half, which IS tested. These are the genuine per-assertion
//       gaps and the only ones worth mutation-reading one by one.
//
// So the honest number for THIS suite is 20, and the other 37 were a request for
// a suite that did not exist. It does now: tooling/test-drift-audit-config.js
// covers auditPlugins, auditSchedules and auditSettings.
//
// MEASURED TOGETHER — the tool takes one suite at a time, so the combined figure
// is the INTERSECTION of the two survivor sets, not either number alone:
//
//   survives the prd suite      52
//   survives the config suite   36
//   survives BOTH                7   <- the real remaining gap
//
// 80 of 87 mutants are now caught by one suite or the other. Reading either 52
// or 36 as "the" number would overstate the debt several times over.
//
// The arc, for anyone deciding whether this is worth doing again:
// 57 -> 27 once the config half had a suite at all -> 12 once the four clusters
// inside it were read and closed (published-but-not-installed, the
// missing-manifest check, the exit-code contract, --json) -> 7 once the
// fileAge/commitsSince threshold was pinned with one fixture per corner.
//
// The 7 that remain were read: an env fallback whose two branches hold the same
// value in any test environment, three guards masked by the catch around them,
// the branch-name filter, and `if (skipped)`.
//
// Run: node tooling/test-drift-audit.js

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUDIT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'drift-audit.js');

// No dashes in the prefix: drift-audit reverses a path into a project slug by
// swapping '-' for '/', so a dash anywhere in the temp path breaks discovery.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftaudit')));
const CONFIG = path.join(TMP, 'claudeconfig');
fs.mkdirSync(path.join(CONFIG, 'projects'), { recursive: true });

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

function git(repo, args, atEpoch) {
    const env = { ...process.env };
    if (atEpoch) {
        const iso = new Date(atEpoch * 1000).toISOString();
        env.GIT_AUTHOR_DATE = iso;
        env.GIT_COMMITTER_DATE = iso;
    }
    return execSync('git ' + args, { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

// A git repo with no entry under CONFIG/projects — for cases that register
// themselves some other way, or test that discovery does not find them.
function makeRepoUnregistered(name) {
    const repo = path.join(TMP, name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init -q -b main');
    git(repo, 'config user.email t@t.t');
    git(repo, 'config user.name Test');
    return repo;
}

function makeRepo(name) {
    const repo = makeRepoUnregistered(name);
    // Register it for discovery, exactly as drift-audit reverses the slug.
    //
    // Both separators and the drive letter have to go. On Windows `repo` is
    // `C:\…\clean`, so a forward-slash-only replace left the slug as a full
    // absolute path and mkdir tried to create `…/projects/C:\Users\…` — an
    // absolute path nested inside another, which is why this suite crashed on
    // every Windows run rather than failing an assertion.
    //
    // Dropping the drive letter keeps the round-trip working, because
    // drift-audit.js:388 rebuilds the path as '/' + slug and Windows resolves a
    // drive-less rooted path against the current drive. That is also the
    // limit of it: a real Windows slug is `C--Users-…`, which that line turns
    // into `/C//Users/…` and never finds. Project discovery does not work on
    // Windows in production, and the slug scheme is lossy on both platforms —
    // any directory containing a dash reverses wrong.
    const slug = repo.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '-');
    fs.mkdirSync(path.join(CONFIG, 'projects', slug), { recursive: true });
    return repo;
}

const writePrd = (repo, stories) =>
    fs.writeFileSync(path.join(repo, 'prd.json'), JSON.stringify({ stories }, null, 2) + '\n');

function commitPrd(repo, stories, daysAgo, msg) {
    writePrd(repo, stories);
    const at = now - daysAgo * DAY;
    git(repo, 'add prd.json', at);
    git(repo, `commit -q -m "${msg}"`, at);
}

// Filler commits so `commits since` has something to count. Filenames carry a
// global counter — reusing f0.txt across two filler() calls writes identical
// content, and `git commit` then fails with "nothing to commit" rather than
// producing the empty commit the test wanted.
let fillerSeq = 0;
function filler(repo, n, daysAgo) {
    for (let i = 0; i < n; i++) {
        const at = now - daysAgo * DAY + i;
        const f = `f${fillerSeq++}.txt`;
        fs.writeFileSync(path.join(repo, f), String(fillerSeq));
        git(repo, `add ${f}`, at);
        git(repo, `commit -q -m "chore: filler ${f}"`, at);
    }
}

const story = (passes, detail = 'x') => ({ title: 't', passes, detail });

function run() {
    const r = spawnSync(process.execPath, [AUDIT, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    });
    try { return JSON.parse(r.stdout).findings.filter((f) => f.area === 'prd'); }
    catch { return null; }
}
// Findings name their repo two ways: "<repo>: …" for most, "<repo>/prd.json …"
// for the parse failure. Match both, or the parse test silently sees an empty
// list and "no findings" reads as "no warning was produced".
const forRepo = (findings, name) => (findings || [])
    .filter((f) => f.detail.startsWith(name + ':') || f.detail.startsWith(name + '/'));

// ─────────────────────────────────────────────── 1. clean repo stays silent
{
    const repo = makeRepo('clean');
    commitPrd(repo, { 'S-1': story(true), 'S-2': story('deferred') }, 200, 'chore: prd');
    filler(repo, 20, 1);
    check('all stories done/deferred → no prd findings at all', forRepo(run(), 'clean').length === 0);
}

// ─────────────────────────────────── 2. a fresh pending story is not flagged
{
    const repo = makeRepo('fresh');
    commitPrd(repo, { 'S-1': story(true) }, 60, 'chore: prd');
    commitPrd(repo, { 'S-1': story(true), 'S-2': story(null) }, 1, 'chore: add story');
    filler(repo, 20, 0);
    const f = forRepo(run(), 'fresh');
    check('pending story edited 1d ago → no staleness warn', !f.some((x) => /untouched >30d/.test(x.detail)));
}

// ─────────────────────────── 3. an old pending story IS flagged, per story
{
    const repo = makeRepo('stale');
    // S-1 last edited 90d ago and still pending; S-2 edited yesterday.
    commitPrd(repo, { 'S-1': story(null, 'original') }, 90, 'chore: prd');
    commitPrd(repo, { 'S-1': story(null, 'original'), 'S-2': story(null) }, 1, 'chore: add');
    filler(repo, 20, 0);
    const f = forRepo(run(), 'stale');
    const warn = f.find((x) => /untouched >30d/.test(x.detail));
    check('old pending story → staleness warn', !!warn);
    check('counts only the OLD story, not every pending one', !!warn && /\b1 of 2 pending/.test(warn.detail));
    check('reports a median', !!warn && /median \d+d/.test(warn.detail));
}

// ── 4. THE FILE IS FRESH, THE BACKLOG IS NOT — the case that motivated this
{
    const repo = makeRepo('freshfilestalebacklog');
    commitPrd(repo, { 'S-1': story(null), 'S-2': story(null) }, 120, 'chore: prd');
    // Today: close an unrelated story. The FILE is now 0 days old, while both
    // pending stories have been untouched for four months. The whole-file age
    // reports "current" about a backlog nobody has looked at.
    commitPrd(repo, { 'S-1': story(null), 'S-2': story(null), 'S-3': story(true) }, 0, 'chore: close S-3');
    filler(repo, 20, 0);
    const f = forRepo(run(), 'freshfilestalebacklog');
    const warn = f.find((x) => /untouched >30d/.test(x.detail));
    check('file touched today but backlog 120d old → still warns', !!warn);
    check('  and names both stale stories', !!warn && /\b2 of 2 pending/.test(warn.detail));
}

// ─────────────── 5. an unmerged branch carrying prd.json changes is surfaced
{
    const repo = makeRepo('branchcarrier');
    commitPrd(repo, { 'S-1': story(null) }, 90, 'chore: prd');
    filler(repo, 20, 1);
    // A branch that reconciles S-1 but is never merged.
    git(repo, 'checkout -q -b reconciled');
    commitPrd(repo, { 'S-1': story(true, 'done on the branch') }, 0, 'chore: reconcile');
    git(repo, 'checkout -q main');
    // drift-audit reads refs/remotes; simulate an origin without a network.
    git(repo, 'update-ref refs/remotes/origin/reconciled refs/heads/reconciled');
    git(repo, 'update-ref refs/remotes/origin/main refs/heads/main');

    const f = forRepo(run(), 'branchcarrier');
    const warn = f.find((x) => /already be reconciled there/.test(x.detail));
    check('unmerged branch with prd changes → warn', !!warn);
    check('  names the branch', !!warn && /origin\/reconciled/.test(warn.detail));
    // Diffed against the DEFAULT branch, not HEAD — see the featurecheckout case.
    check('  fix line is a runnable diff against the default branch',
        !!warn && /git diff origin\/main\.\.\.origin\/reconciled -- prd\.json/.test(warn.fix));
    check('  names which base it compared against', !!warn && /ahead of origin\/main/.test(warn.detail));
    check('  does NOT flag origin/main (it IS the base)',
        !f.some((x) => /already be reconciled/.test(x.detail) && /: origin\/main /.test(x.detail)));
}

// ────────── 6. a branch ahead but NOT touching prd.json is not a carrier
{
    const repo = makeRepo('branchnoprd');
    commitPrd(repo, { 'S-1': story(null) }, 90, 'chore: prd');
    filler(repo, 20, 1);
    git(repo, 'checkout -q -b feature');
    filler(repo, 3, 0);
    git(repo, 'checkout -q main');
    git(repo, 'update-ref refs/remotes/origin/feature refs/heads/feature');
    const f = forRepo(run(), 'branchnoprd');
    check('branch ahead but no prd.json change → not reported',
        !f.some((x) => /already be reconciled there/.test(x.detail)));
}

// ── 6b. sitting on a FEATURE BRANCH must not make the default branch a carrier
//
// The first version compared every branch against HEAD, so the moment the
// checkout was on a feature branch, origin/main reported as "a branch carrying
// prd.json changes you do not have" — which is just what being on a branch
// means. Found by merging a real carrier and watching the finding fail to clear,
// because the checkout was on a docs branch at the time.
{
    const repo = makeRepo('featurecheckout');
    commitPrd(repo, { 'S-1': story(null) }, 90, 'chore: prd');
    filler(repo, 20, 2);
    // The default branch moves ahead with a reconciliation of its own.
    commitPrd(repo, { 'S-1': story(null), 'S-9': story(true) }, 1, 'chore: close S-9');
    git(repo, 'update-ref refs/remotes/origin/main refs/heads/main');
    git(repo, 'symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
    // Now work from a branch that predates that commit.
    git(repo, 'checkout -q -b sidework HEAD~1');

    const f = forRepo(run(), 'featurecheckout');
    check('on a feature branch → the DEFAULT branch is not reported as a carrier',
        !f.some((x) => /already be reconciled/.test(x.detail) && /origin\/main/.test(x.detail)));
    check('  fix line diffs against the default branch, not HEAD',
        f.every((x) => !/git diff HEAD\.\.\./.test(x.fix || '')));
}

// ───────────── 7. a MERGED branch is not a carrier (it is not ahead of HEAD)
{
    const repo = makeRepo('branchmerged');
    commitPrd(repo, { 'S-1': story(null) }, 90, 'chore: prd');
    filler(repo, 20, 2);
    git(repo, 'checkout -q -b done');
    commitPrd(repo, { 'S-1': story(true) }, 1, 'chore: reconcile');
    git(repo, 'checkout -q main');
    git(repo, 'merge -q --no-ff -m "merge" done');
    git(repo, 'update-ref refs/remotes/origin/done refs/heads/done');
    const f = forRepo(run(), 'branchmerged');
    check('merged branch → not reported as a carrier',
        !f.some((x) => /already be reconciled there/.test(x.detail)));
}

// ─────────────────────────── 8. unparseable prd.json is reported, not skipped
{
    const repo = makeRepo('broken');
    fs.writeFileSync(path.join(repo, 'prd.json'), '{ not json');
    git(repo, 'add prd.json');
    git(repo, 'commit -q -m "chore: prd"');
    const f = forRepo(run(), 'broken');
    check('unparseable prd.json → warn', f.some((x) => /does not parse/.test(x.detail)));
}

// ───────────────── 9. no prd.json at all → the repo is simply not audited
{
    const repo = makeRepo('noprd');
    filler(repo, 3, 0);
    check('repo without prd.json → no findings', forRepo(run(), 'noprd').length === 0);
}

// ───────────────────────── 10. the run is read-only and must not mutate a repo
{
    const repo = path.join(TMP, 'stale');
    const before = git(repo, 'status --porcelain') + git(repo, 'rev-parse HEAD');
    run();
    const after = git(repo, 'status --porcelain') + git(repo, 'rev-parse HEAD');
    check('audit does not modify the repo it inspects', before === after);
}

// ------------------------- discovery: transcript cwd beats slug reversal -----
//
// The slug is the project path with every separator replaced by '-', so it is
// not reversible: a directory containing a dash reverses into extra path
// segments, and a Windows slug ('C--Users-x') reverses into '/C//Users/x'.
// Discovery silently found nothing in both cases — existsSync returns false and
// the catch around the loop hides it.
//
// This repo's directory name carries a dash and its slug directory is
// deliberately registered under a name that CANNOT be reversed back to it, so
// the only way to discover it is by reading the cwd out of the transcript. The
// negative half matters as much: if reversal could have found it anyway, this
// case would pass without the new code path existing.
{
    const repo = makeRepoUnregistered('my-dashed-repo');
    const when = now - 30 * DAY;
    fs.writeFileSync(path.join(repo, 'prd.json'), JSON.stringify({ stories: { 'S1-001': story(null) } }));
    git(repo, 'add -A', when);
    git(repo, 'commit -qm prd', when);
    for (let i = 0; i < 15; i++) {
        fs.writeFileSync(path.join(repo, `f${i}.txt`), String(i));
        git(repo, 'add -A', when + 60 * (i + 1));
        git(repo, `commit -qm c${i}`, when + 60 * (i + 1));
    }

    // A slug that reverses to nothing real, plus a transcript holding the truth.
    const slugDir = path.join(CONFIG, 'projects', 'C--totally-unreversible-slug');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'session.jsonl'),
        JSON.stringify({ type: 'user', cwd: repo, message: { role: 'user', content: 'hi' } }) + '\n');

    const reversed = '/' + 'C--totally-unreversible-slug'.replace(/^-/, '').replace(/-/g, '/');
    check('the control: slug reversal alone could NOT find this repo',
        !fs.existsSync(path.join(reversed, '.git')));
    check('repo discovered via the transcript cwd',
        forRepo(run(), 'my-dashed-repo').length > 0);
}

// ------------------------- the file-age vs commit-activity threshold ---------
//
// `if (fileAge >= 3 && commitsSince >= 10)` — all three mutations on it survived
// both suites. It is the signal that says a prd.json can be recent and still
// hold a stale backlog, and nothing pinned either half of the AND.
//
// Four repos, one per corner, because a single case cannot distinguish
// `&&` from `||` or from a forced true/false.
{
    const mk = (name, prdAgeDays, extraCommits) => {
        const repo = makeRepo(name);
        const when = now - prdAgeDays * DAY;
        // A PENDING story is required: auditPrd returns early when nothing is
        // pending (see the first case in this file), so an all-done fixture never
        // reaches the file-age check at all. The first version of these cases used
        // story(true) and reported nothing for that reason — and the three negative
        // assertions passed anyway, which is exactly how a vacuous negative looks.
        fs.writeFileSync(path.join(repo, 'prd.json'),
            JSON.stringify({ stories: { 'S1-001': story(null) } }));
        git(repo, 'add -A', when);
        git(repo, 'commit -qm prd', when);
        for (let i = 0; i < extraCommits; i++) {
            fs.writeFileSync(path.join(repo, `f${i}.txt`), String(i));
            git(repo, 'add -A', when + 60 * (i + 1));
            git(repo, `commit -qm c${i}`, when + 60 * (i + 1));
        }
        return name;
    };

    const both  = mk('agedbusy',  30, 15);  // old AND busy      -> report
    const oldQ  = mk('agedquiet', 30, 2);   // old but quiet     -> silent
    const newB  = mk('freshbusy',  0, 15);  // busy but fresh    -> silent
    const newQ  = mk('freshquiet', 0, 2);   // neither           -> silent

    const f = run();
    const said = (name) => forRepo(f, name).some((x) => /prd\.json last changed/.test(x.detail));

    check('old prd.json WITH commit activity is reported', said(both));
    check('  and names both numbers', forRepo(f, both)
        .some((x) => /last changed \d+d ago with \d+ commit/.test(x.detail)));
    check('old but quiet is NOT reported (the commit half of the AND)', !said(oldQ));
    check('busy but fresh is NOT reported (the age half of the AND)', !said(newB));
    check('neither is NOT reported', !said(newQ));
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
