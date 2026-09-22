#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/check-branch-landed.js.
//
// WHY THIS SUITE EXISTS. On 2026-09-07 a coordinator dispatched a session to
// rebase and land three branches that were ALL already merged, as PRs #168,
// #163 and #161. Nothing was lost because the session re-checked, but the same
// wrong measurement had already fired once before: `claude/sad-kirch-355c74`
// carries a commit titled "74 of 75 branches are already landed, and ancestry
// cannot say so". A finding on an unmerged branch is not a finding the fleet
// has, so the check belongs in a tool with a suite, which is this file.
//
// Every case below plants one of the FOUR probes that produced a wrong answer
// that day, so a regression reproduces the original failure rather than merely
// changing a number:
//
//   1. `git cherry`                       - compares patch ids
//   2. `git rev-list --left-right --count` - ancestry, reports "ahead" forever
//   3. `git diff --shortstat A...B`        - counts content already landed
//   4. an EMPTY `gh pr list --search`      - absence of evidence read as evidence
//
// Trap 4 is the one that is not a command but a READING, and it is the one the
// coordinator actually made. It gets the most cases here.
//
// The classification is tested as a PURE FUNCTION against planted evidence
// rather than against a live forge. A suite that mocked `gh` would be asserting
// things about the mock, and a suite that hit the real GitHub would go green or
// red according to someone else's merge queue.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-branch-landed.js');
const { classify, present, isLanded, VERDICTS } = require(SUBJECT);

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail === undefined ? '' : '  (' + detail + ')')); }
}
const v = (evidence) => classify(evidence).verdict;

// ---- trap 4: absence of evidence is not evidence ---------------------------
//
// THE FAILURE THIS REPRODUCES. `gh pr list --state merged --search <branch>`
// returned nothing, and that empty result was read as an affirmative "this
// branch was never merged". The search is a loose full-text match; its silence
// says something about the query, not about the world.
//
// Both shapes must fall through to content rather than concluding anything:
// null (never asked, or the ask failed) and [] (asked, answered "none").
const identical = [{ path: 'a.js', trunkBlob: 'bbb', branchBlob: 'bbb' }];
check('an EMPTY merged-PR list never concludes UNLANDED',
    v({ tip: 'aaa', mergedPRs: [], files: identical }) === VERDICTS.LANDED_CONTENT);
check('a NULL merged-PR list never concludes UNLANDED',
    v({ tip: 'aaa', mergedPRs: null, files: identical }) === VERDICTS.LANDED_CONTENT);
check('an empty merged-PR list with NO content evidence is UNKNOWN, not UNLANDED',
    v({ tip: 'aaa', mergedPRs: [] }) === VERDICTS.UNKNOWN);
check('  and UNKNOWN is not counted as landed',
    isLanded(VERDICTS.UNKNOWN) === false);

// ---- the primitive: a merged PR whose head IS the tip -----------------------
//
// Both halves are load-bearing. A merged PR proves nothing on its own if its
// merge commit is not on THIS trunk - it landed somewhere else.
const landedPR = { number: 168, headRefOid: 'aaa', mergeCommitOid: '7f4df8d1', mergeCommitIsAncestor: true };
check('a merged PR whose head == tip, merged into this trunk, is LANDED',
    v({ tip: 'aaa', mergedPRs: [landedPR] }) === VERDICTS.LANDED_SQUASH);
check('  and the reason names the PR number',
    /#168/.test(classify({ tip: 'aaa', mergedPRs: [landedPR] }).reason));
check('a merged PR whose merge commit is NOT on this trunk is UNKNOWN, never LANDED',
    v({ tip: 'aaa', mergedPRs: [{ ...landedPR, mergeCommitIsAncestor: false }] }) === VERDICTS.UNKNOWN);
check('a merged PR whose head is NOT the tip does not land the branch',
    v({ tip: 'aaa', mergedPRs: [{ ...landedPR, headRefOid: 'zzz' }], added: 40, deleted: 0 }) === VERDICTS.UNLANDED);

// ---- traps 1-3: ancestry and three-dot counts cannot prove UNLANDED ---------
//
// The three real branches from 2026-09-07. Each reported "ahead" by rev-list
// and a four-figure insertion count by a three-dot shortstat; each was merged.
// The evidence that settles it is the PR head, and these cases assert that the
// large ancestry numbers do NOT override it.
for (const [branch, prNum, ahead, insertions] of [
    ['fix/doc-staleness-structural', 168, 1, 213],
    ['feat/the-harness-i-needed', 163, 3, 773],
    ['fix/read-the-repo-not-the-inbox', 161, 5, 1033],
]) {
    check('"' + branch + '" is LANDED despite reading +' + ahead + ' / ' + insertions + ' insertions',
        v({
            tip: 'tip-' + prNum,
            mergedPRs: [{ number: prNum, headRefOid: 'tip-' + prNum, mergeCommitOid: 'm', mergeCommitIsAncestor: true }],
            added: insertions, deleted: 2,
        }) === VERDICTS.LANDED_SQUASH);
}

// ---- shape: mostly deletions is BEHIND, and BEHIND is not UNLANDED ----------
//
// Real numbers from the same sweep. Landing any of these would revert the trunk;
// reporting them as UNLANDED is what sends a session to do exactly that.
check('+676 / -14725 is BEHIND, not UNLANDED',
    v({ tip: 'aaa', added: 676, deleted: 14725 }) === VERDICTS.BEHIND);
check('  and the reason says landing it is a revert',
    /revert/.test(classify({ tip: 'aaa', added: 676, deleted: 14725 }).reason));
check('+550 / -34535 is BEHIND',
    v({ tip: 'aaa', added: 550, deleted: 34535 }) === VERDICTS.BEHIND);
check('a genuinely additive branch IS reported UNLANDED',
    v({ tip: 'aaa', added: 900, deleted: 12 }) === VERDICTS.UNLANDED);
check('  control: BEHIND and UNLANDED are distinguishable at all',
    v({ tip: 'aaa', added: 900, deleted: 12 }) !== v({ tip: 'aaa', added: 12, deleted: 900 }));

// ---- conflict risk: named in the reason, never folded into a verdict ---------
//
// A path the branch touched that the trunk ALSO changed since the fork will need
// reconciling at merge. Neither side reverts the other, so it must not tip an
// additive branch into BEHIND, and it must be visible to whoever lands it.
const both = [{ path: 'a.js', baseBlob: 'b0', trunkBlob: 'b1', branchBlob: 'b2' }];
const bothReason = classify({ tip: 'aaa', files: both, added: 5, deleted: 0 }).reason;
check('a path the trunk ALSO changed leaves an additive branch UNLANDED',
    v({ tip: 'aaa', files: both, added: 5, deleted: 0 }) === VERDICTS.UNLANDED);
check('  and the reason names it as a conflict risk', /conflict risk.*\ba\.js\b/.test(bothReason), bothReason);
check('  and a BEHIND reason names it too',
    /conflict risk.*\ba\.js\b/.test(classify({ tip: 'aaa', files: both, added: 1, deleted: 9 }).reason));
check('a path the trunk left at its merge-base blob is not a conflict',
    !/conflict/.test(classify({ tip: 'aaa', added: 5, deleted: 0,
        files: [{ path: 'a.js', baseBlob: 'b0', trunkBlob: 'b0', branchBlob: 'b2' }] }).reason));
check('a path both sides changed to the SAME blob is not a conflict',
    !/conflict/.test(classify({ tip: 'aaa', added: 5, deleted: 0, files: [
        { path: 'a.js', baseBlob: 'b0', trunkBlob: 'b2', branchBlob: 'b2' },
        { path: 'n.js', baseBlob: null, trunkBlob: null, branchBlob: 'c' }] }).reason));
check('evidence with no baseBlob names no conflict rather than guessing',
    !/conflict/.test(classify({ tip: 'aaa', added: 5, deleted: 0,
        files: [{ path: 'a.js', trunkBlob: 'b1', branchBlob: 'b2' }] }).reason));
{
    const many = Array.from({ length: 7 }, (_, i) => ({ path: 'p' + i, baseBlob: 'o', trunkBlob: 't' + i, branchBlob: 'b' + i }));
    const r = classify({ tip: 'aaa', files: many, added: 5, deleted: 0 }).reason;
    check('seven conflict paths print five and count the rest', /7 path\(s\)/.test(r) && /\(\+2 more\)/.test(r) && !/\bp5\b/.test(r), r);
}

// ---- content: one differing file is enough to refuse LANDED-CONTENT ---------
check('a file absent from the trunk blocks LANDED-CONTENT',
    v({ tip: 'aaa', mergedPRs: [], added: 5, deleted: 0,
        files: [{ path: 'a', trunkBlob: 'b', branchBlob: 'b' }, { path: 'new', trunkBlob: null, branchBlob: 'c' }] })
        !== VERDICTS.LANDED_CONTENT);
check('a file whose blob DIFFERS blocks LANDED-CONTENT',
    v({ tip: 'aaa', mergedPRs: [], added: 5, deleted: 0,
        files: [{ path: 'a', trunkBlob: 'b1', branchBlob: 'b2' }] }) !== VERDICTS.LANDED_CONTENT);

// ---- ancestry, used only in the direction it can prove ---------------------
check('a tip that IS an ancestor of the trunk is LANDED',
    v({ tip: 'aaa', tipIsAncestor: true }) === VERDICTS.LANDED_ANCESTOR);
check('a tip that is NOT an ancestor is not thereby UNLANDED',
    v({ tip: 'aaa', tipIsAncestor: false, files: identical }) === VERDICTS.LANDED_CONTENT);

// ---- degenerate input ------------------------------------------------------
check('no tip is UNKNOWN rather than a verdict', v({}) === VERDICTS.UNKNOWN);
check('undefined evidence does not throw', v(undefined) === VERDICTS.UNKNOWN);

// ---- the report prints its population --------------------------------------
//
// A verdict with no denominator is indistinguishable from a finder that
// returned nothing. Both halves asserted: a real zero must say so, and a
// populated run must print the count.
const rows = [
    { branch: 'x', verdict: VERDICTS.LANDED_SQUASH, reason: 'r' },
    { branch: 'y', verdict: VERDICTS.BEHIND, reason: 'mostly deletions' },
];
const out = present(rows);
check('the report prints how many branches it checked', /2 branch\(es\) checked/.test(out));
check('  and breaks them down by verdict', /LANDED-SQUASH/.test(out) && /BEHIND/.test(out));
check('  and a landed branch is not listed as a finding', !/^\s+LANDED-SQUASH\s+x$/m.test(out));
check('an empty run says the zero is real, not a blind spot',
    /a real zero/.test(present([])));
check('an UNKNOWN run says it is not a pass',
    /not a pass/.test(present([{ branch: 'z', verdict: VERDICTS.UNKNOWN, reason: 'r' }])));

// ---- the CLI contract ------------------------------------------------------
//
// Driven as a subprocess. Exit codes are the part other tools consume, so a
// change to them must break something here.
function run(args) {
    return spawnSync(process.execPath, [SUBJECT].concat(args), { encoding: 'utf8', stdio: 'pipe' });
}
const self = run(['--selftest']);
check('--selftest exits 0', self.status === 0, self.status);
check('  and reports how many assertions it ran', /selftest assertion\(s\) passed/.test(self.stdout));

// A subject that cannot classify must not exit 0. Pointed at a ref that does
// not exist, in a real repo, the answer is UNKNOWN and the exit is 3.
const bogus = run(['refs/heads/definitely-not-a-branch-here', '--repo', path.join(__dirname, '..'), '--trunk', 'HEAD']);
check('an unresolvable branch exits 3 (could not tell), not 0', bogus.status === 3, bogus.status);
check('  and says so rather than printing an all-clear', /UNKNOWN/.test(bogus.stdout), bogus.stdout.slice(0, 200));

// ---- the pipe delivers every byte -------------------------------------------
//
// node's process.stdout is ASYNCHRONOUS when it is a pipe on POSIX (Linux and
// macOS alike; only win32 is synchronous), and process.exit() does not
// drain a pending async write. A run that prints past the 64KiB OS pipe buffer
// and then exits therefore hands its caller exactly 65536 bytes under exit
// status 0 — the shape rendered-layout-gate.js shipped with until 2026-09-07.
// This tool is the one a session runs over EVERY unmerged head before deleting
// branches, so a truncated answer here is a branch nobody can account for.
//
// TWO ASSERTIONS, and the first is what stops the second passing by
// construction: the output must EXCEED one pipe buffer, and the piped byte count
// must equal the same run redirected to a FILE, where the write is synchronous
// on every platform.
//
// THE FIXTURE IS SHAPED FOR SPAWN COUNT. Every branch costs two git
// invocations, so the rows are made wide as well as numerous: 280 refs with
// 80-character names, all pointing at trunk's own tip so gatherEvidence
// short-circuits on ancestry after two calls instead of running the content
// comparison.
//
// 80 RATHER THAN 200, AND THE CEILING IS NOT THE ONE THIS COMMENT FIRST NAMED.
// It said 200 was near the limit because a ref approaching 255 bytes fails on
// darwin. The real ceiling is Windows: the loose ref is written as
// <tmp>/.git/refs/remotes/origin/<name>.lock, and at 200 characters that whole
// path passed MAX_PATH and `git update-ref --stdin` died with "Filename too
// long" — a CI-only crash, green on both POSIX legs. A row here carries no
// filesystem path (branch, tip, verdict, reason, pr), so the byte count is
// portable and only the ref FILE path was ever at risk.
{
    const PIPE_BUF = 64 * 1024;
    const bigRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cbl-pipe-'));
    const g = (a, opts) => execFileSync('git', a, Object.assign({ cwd: bigRepo, encoding: 'utf8', stdio: 'pipe' }, opts || {}));
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(bigRepo, 'seed.txt'), 'seed\n');
    g(['add', '.']);
    g(['commit', '-qm', 'seed']);
    const tip = g(['rev-parse', 'HEAD']).trim();
    let refs = 'create refs/remotes/origin/main ' + tip + '\n';
    for (let i = 0; i < 280; i++) {
        refs += 'create refs/remotes/origin/feature-' + 'y'.repeat(80) + '-' + String(i).padStart(4, '0')
            + ' ' + tip + '\n';
    }
    g(['update-ref', '--stdin'], { input: refs });

    const viaFileBytes = (args) => {
        const out = path.join(bigRepo, 'via-file.out');
        const fd = fs.openSync(out, 'w');
        spawnSync(process.execPath, [SUBJECT].concat(args), { stdio: ['ignore', fd, 'ignore'] });
        fs.closeSync(fd);
        return fs.statSync(out).size;
    };
    const jsonArgs = ['--repo', bigRepo, '--json'];
    const jsonPipe = spawnSync(process.execPath, [SUBJECT].concat(jsonArgs),
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const jsonPipeBytes = Buffer.byteLength(jsonPipe.stdout || '', 'utf8');
    const jsonFileBytes = viaFileBytes(jsonArgs);

    check('--json over many branches exceeds one pipe buffer, so the next check is not vacuous',
        jsonFileBytes > PIPE_BUF, JSON.stringify({ bytes: jsonFileBytes, buffer: PIPE_BUF }));
    check('  and through a PIPE it delivers every byte it writes to a FILE',
        jsonPipeBytes === jsonFileBytes, JSON.stringify({ pipe: jsonPipeBytes, file: jsonFileBytes }));
    check('  and the piped JSON still parses at that size, under exit 0',
        (() => { try { return JSON.parse(jsonPipe.stdout).rows.length === 280 && jsonPipe.status === 0; } catch { return false; } })(),
        'exit ' + jsonPipe.status + ', tail ' + JSON.stringify((jsonPipe.stdout || '').slice(-40)));

    // NO SECOND PAIR FOR THE HUMAN TABLE, deliberately. present() lists only the
    // rows that are NOT landed and counts the rest, so on this fixture — where
    // every ref is an ancestor of trunk — it renders 63 bytes however many
    // branches there are, and a byte-count equality on 63 bytes asserts nothing.
    // Driving it wide would mean 200 UNLANDED branches, which is the full
    // content-comparison path: several more git invocations each, on a fixture
    // that already costs this suite five seconds a run. The drain being asserted
    // is a property of the RUNNER, which both forms exit through, so the --json
    // pair above covers the table as well.
    fs.rmSync(bigRepo, { recursive: true, force: true });
}

// ---- a MOVING TRUNK is not a revert: score the branch's OWN contribution ----
//
// THE FAILURE THIS REPRODUCES. `[measured 2026-09-22]` step (d) read the SHAPE
// of `git diff --numstat <trunk> <tip>`, two dots. Once the trunk moves on after
// the fork, that diff is dominated by the trunk's own newer work, which the
// branch lacks and which therefore reads as DELETIONS from the branch's side.
// 13 of 13 open PRs in two product repos read BEHIND ("landing it is a revert"),
// while a blob comparison of each PR's own files found none of them on the
// trunk and 12 of 13 merging clean. A merge is three-way, so the trunk's newer
// work survives it. BEHIND feeds branch deletion and PR closing, so that false
// verdict can close unlanded work as a revert.
//
// DRIVEN THROUGH THE CLI AGAINST A REAL REPO, because the defect lived in
// gatherEvidence and not in classify(): the pure function scores whatever
// numbers it is handed, and every planted case above was already right.
//
// Five branches fork from one seed, then the trunk moves on by more lines than
// any of them adds. Two are the subject, two are controls that must NOT move,
// and the last guards the probe itself:
//   additive  one small new file                       -> UNLANDED (was BEHIND)
//   overlap   edits a.txt, which the trunk rewrites     -> UNLANDED, a.txt named
//   revert    its OWN commit deletes b.txt from trunk   -> BEHIND, before and after
//   landed    its one file is byte-identical on trunk   -> LANDED-CONTENT, (c)'s path set
//   bracket   adds o/[token]/page.tsx, absent on trunk  -> UNLANDED, and NO conflict named
//
// THE BRACKET BRANCH IS A PROBE-SHAPE TRAP, found on the first real run of this
// fix. `git rev-parse <ref>:<path>` on a path ABSENT at that ref exits 128 for a
// plain path, but exits 0 and ECHOES the argument when the path holds a glob
// character, because git then reads it as a pathspec. The echo was taken as a
// blob, so every new Next.js route file read as changed on the trunk: 7 of 10
// real branches named the same five `[id]` and `[token]` files as conflicts.
{
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cbl-moving-'));
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
    const put = (p, text) => fs.writeFileSync(path.join(repo, p), text);
    const lines = (tag, n) => Array.from({ length: n }, (_, i) => tag + ' ' + i).join('\n') + '\n';
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 'T');
    g('config', 'core.autocrlf', 'false');
    put('a.txt', lines('a', 20));
    put('b.txt', lines('b', 20));
    g('add', 'a.txt', 'b.txt');
    g('commit', '-qm', 'seed');
    const seed = g('rev-parse', 'HEAD');

    g('checkout', '-qb', 'additive', seed);
    put('feature.txt', lines('f', 3));
    g('add', 'feature.txt');
    g('commit', '-qm', 'additive');

    g('checkout', '-qb', 'overlap', seed);
    put('a.txt', lines('a', 20).replace('a 3\n', 'a three\n'));
    put('x.txt', lines('x', 2));
    g('add', 'a.txt', 'x.txt');
    g('commit', '-qm', 'overlap');

    g('checkout', '-qb', 'revert', seed);
    g('rm', '-q', 'b.txt');
    put('y.txt', 'one line\n');
    g('add', 'y.txt');
    g('commit', '-qm', 'revert');

    g('checkout', '-qb', 'landed', seed);
    put('z.txt', lines('z', 5));
    g('add', 'z.txt');
    g('commit', '-qm', 'landed');

    // The trunk moves on: two new files and a rewrite, 105 lines against the 3
    // the additive branch adds, and z.txt arrives under a different commit.
    g('checkout', '-qb', 'bracket', seed);
    fs.mkdirSync(path.join(repo, 'o', '[token]'), { recursive: true });
    put('o/[token]/page.tsx', lines('p', 2));
    g('add', 'o/[token]/page.tsx');
    g('commit', '-qm', 'bracket');

    g('checkout', '-q', 'main');
    put('c.txt', lines('c', 40));
    put('d.txt', lines('d', 40));
    put('a.txt', lines('A', 25));
    put('z.txt', lines('z', 5));
    g('add', 'a.txt', 'c.txt', 'd.txt', 'z.txt');
    g('commit', '-qm', 'the trunk moves on');

    const res = run(['additive', 'overlap', 'revert', 'landed', 'bracket', '--repo', repo, '--trunk', 'main', '--json']);
    let byBranch = {};
    try { for (const r of JSON.parse(res.stdout).rows) byBranch[r.branch] = r; } catch { byBranch = {}; }
    const row = (b) => byBranch[b] || { verdict: 'MISSING', reason: String(res.stdout).slice(0, 200) };
    const show = (b) => row(b).verdict + ': ' + row(b).reason;

    check('the moving-trunk fixture classified all five branches',
        Object.keys(byBranch).length === 5, 'exit ' + res.status + ', ' + String(res.stderr).slice(0, 200));
    check('an additive branch behind a moving trunk is UNLANDED, not BEHIND',
        row('additive').verdict === VERDICTS.UNLANDED, show('additive'));
    check('  and its reason counts only its own +3 / -0',
        /\+3 \/ -0\b/.test(row('additive').reason), show('additive'));
    check('  and the run exits 2, because unlanded work is present',
        res.status === 2, res.status);
    check('a branch editing a path the trunk also rewrote is UNLANDED, not BEHIND',
        row('overlap').verdict === VERDICTS.UNLANDED, show('overlap'));
    check('  and the reason names that path as a conflict risk',
        /conflict/.test(row('overlap').reason) && /\ba\.txt\b/.test(row('overlap').reason), show('overlap'));
    check('  control: a branch whose paths the trunk never touched names no conflict',
        !/conflict/.test(row('additive').reason), show('additive'));
    check('a branch whose OWN commits delete trunk content still reads BEHIND',
        row('revert').verdict === VERDICTS.BEHIND, show('revert'));
    check('a branch whose one file is byte-identical on the moved trunk is LANDED-CONTENT',
        row('landed').verdict === VERDICTS.LANDED_CONTENT, show('landed'));
    check('a new file whose path holds [brackets] is UNLANDED',
        row('bracket').verdict === VERDICTS.UNLANDED, show('bracket'));
    check('  and names no conflict: an absent path is not a changed one',
        !/conflict/.test(row('bracket').reason), show('bracket'));
    fs.rmSync(repo, { recursive: true, force: true });
}

// ---- summary ---------------------------------------------------------------
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
