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

// ---- the pipe delivers every byte -----------------------------------------
//
// node's process.stdout is ASYNCHRONOUS when it is a pipe on darwin and
// synchronous when it is a pipe on linux/win32, and process.exit() does not
// drain a pending async write. A run that prints and then exits hands its
// caller a TRUNCATED document under a status that says nothing failed -- the
// shape rendered-layout-gate.js shipped with until 2026-09-07.
//
// THIS DOES NOT INFLATE THE FIXTURE PAST 64 KiB, and the difference matters in
// both directions. Sizing a fixture past the buffer is not portable: it needs
// long paths, long ref names or hundreds of rows, and `[measured 2026-09-08]`
// this suite's fixture wrote ref names long enough that `git
// update-ref` failed with "cannot lock ref" on windows-latest. It is also not NECESSARY -- the buffer does not have to be
// filled by this script's output, only to be full when the write happens.
// tooling/pipe-drain.js fills it with zeroes first, so a few-hundred-byte
// report is dropped exactly as completely as a 94 KB one.
//
// It carries its own control -- a fixture that prints then exits must arrive
// truncated to zero before any verdict counts -- and reports `skipped` on
// linux and win32, where a pipe is synchronous and the defect cannot occur.
{
    // A branch that does not exist: the subject still emits a full JSON
    // document for it, which is all this check needs.
    const drained = require('./pipe-drain').run({
        argv: [SUBJECT, 'refs/heads/definitely-not-a-branch-here',
            '--repo', path.join(__dirname, '..'), '--trunk', 'HEAD', '--json'],
    });
    check('--json arrives whole through a stalled pipe', drained.ok, drained.detail);
}

// ---- summary ---------------------------------------------------------------
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
