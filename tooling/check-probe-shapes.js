#!/usr/bin/env node
'use strict';
/**
 * Warn about shell commands whose SHAPE makes their answer untrustworthy.
 *
 * This exists because reading the rules did not work. On 2026-09-04 one session
 * hit four separately-documented probe traps inside two hours -- while auditing
 * documentation about those traps, and minutes after citing two of them. Prose
 * that a reader agrees with and then violates is not a control.
 *
 * ADVISORY, NEVER BLOCKING, and that is a decision rather than caution. A gate
 * whose false positives are demonstrated must not gate: gating costs a wrong red
 * and then the check gets muted, and this fleet has already muted one detector
 * that ran at one-in-six precision. Every rule below is a heuristic over shell
 * text, so every one of them can be wrong. Exit is always 0.
 *
 *   node check-probe-shapes.js "grep -c foo x || echo none"   one command
 *   node check-probe-shapes.js --selftest                      prove it can fire
 */

const RULES = [
    {
        id: 'exit-code-encodes-absence',
        // grep exits 1 on NO MATCH, which is an ANSWER, not a failure. In an && chain
        // that renders the whole step red; behind || it runs a fallback you wrote
        // yourself, which then prints a confident sentence about the world.
        // [measured 2026-09-04] `git check-ignore -q X 2>&1 | head -2 || echo "NOT IGNORED"`
        // -- the || bound to `head`, so the test could not fail in either direction.
        // NOTE the two separate tests rather than one regex with `[^|&;]*` between
        // them. That was the first version, and this selftest failed it on its own
        // motivating command -- because `[^|&;]*` stops at the first pipe, so a `||`
        // sitting AFTER a pipe was invisible. The rule is about a pipe hiding what
        // follows it, and the pattern had exactly that bug. Left as a comment
        // because a gate's first run catching its own author is the point of one.
        test: (c) => /\b(grep|rg|git\s+check-ignore|git\s+diff\s+--quiet|cmp|test)\b/.test(c)
                  && /(\|\||&&)/.test(c),
        say: 'A search/predicate feeds || or &&. Those commands exit NON-ZERO to mean "found nothing", which is an ANSWER. The branch you wrote will report it as a fault, or run a fallback that states something you never measured. Capture the output and branch on the VALUE, or append `|| true` and read stdout.',
    },
    {
        id: 'exit-code-through-a-pipe',
        // $? after a pipe is the LAST stage's status. A failing command before a
        // pipe reads as success. Documented in this repo's own CLAUDE.md and
        // committed twice anyway.
        test: (c) => /\|\s*(head|tail|less|cat|wc)\b/.test(c) && /(\$\?|&&|\|\|)/.test(c),
        say: 'An exit code is being read after a pipe. `$?` is the PIPE\'s status -- the last stage\'s -- so a failing earlier command reads as green. Redirect to a file and read the file, or set `set -o pipefail`.',
    },
    {
        id: 'degenerate-pattern',
        // [measured 2026-09-04] `grep -c $'\0' file` reported 293 "NUL bytes".
        // Bash cannot put NUL in a string, so the pattern was EMPTY and matched
        // every line. The real count was 1. An empty pattern always "finds"
        // something, which is the worst possible failure for a search.
        test: (c) => /\b(grep|rg)\b[^|;&]*(\$'\\0'|(["'])\3)/.test(c),
        say: 'This search pattern is empty or is $\'\\0\', which bash renders as the empty string. An empty pattern matches EVERY line, so the count you get back is the line count wearing a finding\'s clothes. Use a byte-level reader for NUL (python: b.count(b"\\x00")).',
    },
    {
        id: 'cherry-as-landed-check',
        // git cherry compares PATCH IDs. A squash merge rewrites N commits into
        // one with a new patch id, so every original still reads `+`. It also
        // cannot distinguish MISSING from SUPERSEDED: work whose replacement
        // solves the same problem differently reports identically to work that
        // never landed. [measured 2026-09-04] 13 branches called unlanded; 2 were.
        test: (c) => /\bgit\s+cherry\b/.test(c),
        say: 'git cherry compares PATCH IDs, so it cannot answer "did this land". A squash rewrites the id and every original commit still reads `+`; and a `+` cannot distinguish MISSING from SUPERSEDED. Compare the merged PR\'s headRefOid against the branch tip, then read the FILES.',
    },
    {
        id: 'left-right-as-landed-check',
        // `rev-list --left-right --count A...B` is the ahead-count's two-sided
        // sibling, and its AHEAD half fails the same way for the same reason: a
        // squash-merged branch is never an ancestor of the trunk, so it reports
        // its original commits ahead FOREVER. The BEHIND half is trustworthy.
        // [measured 2026-09-07] three branches read +1, +3 and +5 ahead and a
        // session was dispatched to land them. All three were already merged, as
        // PRs #168, #163 and #161.
        test: (c) => /\bgit\s+rev-list\b/.test(c) && /--left-right/.test(c),
        say: 'rev-list --left-right reports a squash-merged branch AHEAD forever, because such a branch is never an ancestor of the trunk. The BEHIND half is a real staleness signal; the AHEAD half is not a quantity of pending work. To ask whether a branch landed, find a merged PR whose headRefOid equals the branch tip BY SHA, then read the FILES.',
    },
    {
        id: 'three-dot-diff-as-unlanded-count',
        // `git diff A...B` measures from the MERGE BASE, so it reports the
        // branch's entire contribution since it forked, landed or not. Quoted as
        // a size of unlanded work it is wrong by exactly the amount already
        // merged. [measured 2026-09-07] 213, 773 and 1033 insertions of
        // "unlanded" work on three branches whose true figure was 0.
        test: (c) => /\bgit\s+diff\b/.test(c) && /\S\.\.\.\S/.test(c),
        say: 'git diff with THREE dots measures from the merge base, so it counts everything the branch added since it forked -- including whatever has already landed upstream. As a size of unlanded work it is wrong by exactly the amount already merged. Use two dots to compare against the trunk as it is now, and settle landing with the merged PR head rather than any line count.',
    },
    {
        id: 'empty-pr-search-as-proof',
        // Not a malformed command -- a malformed READING. An empty result from a
        // loose full-text search is a claim about the QUERY. [measured
        // 2026-09-07] `gh pr list --state merged --search <branch>` returned
        // nothing for a branch that had merged as PR #163, because the search
        // matches titles and bodies rather than the head ref.
        test: (c) => /\bgh\s+pr\s+list\b/.test(c) && /--search/.test(c),
        say: 'gh pr list --search is a loose full-text match over titles and bodies, so an EMPTY result is a claim about the query, not evidence that no PR merged this branch. Look the PR up BY COMMIT SHA instead: gh api repos/<owner>/<repo>/commits/<sha>/pulls.',
    },
    {
        id: 'ahead-count-as-lost-work',
        // An ahead-count is an ANCESTRY claim. After any rebase, squash or filter
        // the same diffs sit upstream under new SHAs and every one is counted.
        // [measured 2026-08-24] a worktree reported 2518; 10 were genuinely stranded.
        test: (c) => /git\s+rev-list\s+[^|;&]*--count/.test(c) || /--left-right\s+--count/.test(c),
        say: 'An ahead/behind count is an ANCESTRY claim, not a content one. After a rebase or squash the same work sits upstream under new SHAs and is still counted here. Before calling any of it stranded, ask git about CONTENT and then read the file.',
    },
    {
        id: 'rev-path-on-a-dot-path',
        // MSYS path conversion mangles `rev:path` when the path starts with a
        // bare dot -- .github, .gitignore, .claude. Four of five reads are fine,
        // so the habit is never punished until the question is about CI.
        test: (c) => /git\s+(show|cat-file)[^|;&]*:\s*\./.test(c) && !/MSYS_NO_PATHCONV/.test(c),
        say: 'A `rev:path` read whose path starts with a dot. Git Bash rewrites the colon and slashes, and it fails as an ordinary negative -- so a present file reads as MISSING. Prefix MSYS_NO_PATHCONV=1, or use `git ls-tree --name-only <ref> <path>`, which takes them as separate arguments.',
    },
];

function scan(cmd) {
    return RULES.filter((r) => { try { return r.test(cmd); } catch { return false; } });
}

function selftest() {
    // A planted positive must be IMPOSSIBLE BY CONSTRUCTION, not merely absent
    // from a list. Each case below is a real command from the 2026-09-04 session,
    // so it cannot drift into a false alarm as the patterns improve.
    const positives = [
        ['exit-code-encodes-absence', `git check-ignore -v rescue/ 2>&1 | head -2 || echo "NOT IGNORED"`],
        ['exit-code-through-a-pipe', `npm run check:suites | tail -3; echo $?`],
        ['degenerate-pattern', `grep -c $'\\0' file.js`],
        ['cherry-as-landed-check', `git cherry -v origin/main HEAD`],
        ['left-right-as-landed-check', `git rev-list --left-right --count origin/main...origin/feat/x`],
        ['three-dot-diff-as-unlanded-count', `git diff --shortstat origin/main...origin/feat/x`],
        ['empty-pr-search-as-proof', `gh pr list --state merged --search feat/x --json number`],
        ['ahead-count-as-lost-work', `git rev-list --count origin/main..HEAD`],
        ['rev-path-on-a-dot-path', `git show origin/main:.github/workflows/ci.yml`],
    ];
    // Negatives: ordinary commands that must NOT fire. A rule that flags
    // everything passes every known-positive test and is useless.
    const negatives = [
        `git status --porcelain`,
        `npm run gate`,
        `grep -n "buyPack" src/pages/Pricing.tsx`,
        `MSYS_NO_PATHCONV=1 git show "origin/main:.github/workflows/ci.yml"`,
        `git rev-list --count HEAD | cat`,   // counting, but not compared to anything
        `gh pr view 656 --json files`,
        `git diff --numstat origin/main origin/feat/x`,   // two dots: the correct form
        `gh api repos/o/r/commits/abc123/pulls`,          // the SHA lookup itself
    ];

    let pass = 0, fail = 0;
    for (const [id, cmd] of positives) {
        const hit = scan(cmd).some((r) => r.id === id);
        if (hit) { pass++; console.log(`PASS  ${id} fires on its own real command`); }
        else { fail++; console.log(`FAIL  ${id} did NOT fire on: ${cmd}`); }
    }
    for (const cmd of negatives) {
        const hits = scan(cmd);
        // the rev-list negative is expected to fire; it is listed to show the
        // known false-positive rather than to be suppressed.
        const expected = /rev-list\s+--count/.test(cmd) ? 1 : 0;
        if (hits.length === expected) { pass++; console.log(`PASS  clean: ${cmd.slice(0, 46)}`); }
        else { fail++; console.log(`FAIL  ${hits.length} hit(s), expected ${expected}: ${cmd}`); }
    }
    console.log(`\npopulation: ${positives.length} planted positives, ${negatives.length} negatives, ${RULES.length} rules`);
    console.log(`${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
if (args[0] === '--selftest') process.exit(selftest());

const cmd = args.join(' ');
if (!cmd) { console.log('usage: check-probe-shapes.js "<shell command>" | --selftest'); process.exit(0); }

const hits = scan(cmd);
if (!hits.length) process.exit(0);

console.error(`\nPROBE SHAPE WARNING (advisory -- ${RULES.length} rules, ${hits.length} matched)`);
for (const h of hits) console.error(`\n  [${h.id}]\n  ${h.say}`);
console.error('\nThe command still runs. This is a prompt to check what the number MEANS.\n');
process.exit(0);
