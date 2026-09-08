#!/usr/bin/env node
'use strict';
/**
 * check-branch-landed.js - answer "is there unlanded work on this branch?"
 * without the three probes that made a coordinator dispatch a session onto
 * already-merged work on 2026-09-07.
 *
 * WHY THIS EXISTS. Every hand-rolled version of this question asked git about
 * ANCESTRY and reported the answer as CONTENT. The two diverge permanently
 * after a squash merge, which is the normal merge here:
 *
 *   1. `git cherry` compares PATCH IDS. A squash rewrites N commits into one
 *      with a different patch id, so every original commit still reads `+`.
 *      Already documented; `check-probe-shapes.js` warns on it.
 *   2. `git rev-list --left-right --count main...branch` reports the branch
 *      "ahead" FOREVER, because a squash-merged branch is never an ancestor of
 *      the trunk. `[measured 2026-09-07]` three branches reported +1, +3 and +5
 *      commits ahead. All three were merged, as PRs #168, #163 and #161.
 *   3. `git diff --shortstat main...branch` (THREE dots) counts the branch's
 *      full contribution since the MERGE BASE, whether or not equivalent
 *      content is already on the trunk. The same three branches reported 213,
 *      773 and 1033 insertions of "unlanded" work. The true figure was 0.
 *
 * THE FOURTH TRAP IS NOT A COMMAND, IT IS A READING. `gh pr list --search
 * <branch>` is a loose full-text search. On 2026-09-07 an EMPTY result was read
 * as an affirmative "this branch was never merged". An empty result from an
 * unvalidated probe is a claim about the PROBE, never about the world. This
 * script therefore never treats absence of a PR as evidence of anything; it
 * falls through to content, and says UNKNOWN if content cannot be read.
 *
 * THE PRIMITIVE IT ENCODES, in the order it is trusted:
 *
 *   a. Is the branch tip already an ancestor of the trunk? Then it landed by
 *      fast-forward or merge commit, and nothing else needs asking.
 *   b. Is there a MERGED pull request whose headRefOid EQUALS the branch tip,
 *      and whose merge commit is an ancestor of the trunk? Then the branch
 *      landed as a squash and never continued past its merge.
 *      Looked up BY COMMIT SHA (`repos/{r}/commits/{sha}/pulls`), not by title
 *      search, so trap 4 cannot occur.
 *   c. Otherwise compare FILES. If every path the branch touches has an
 *      identical blob on the trunk, the content is there under other SHAs.
 *   d. Otherwise read the SHAPE of the diff. A branch that would mostly DELETE
 *      from the trunk is BEHIND it, and "landing" it is a revert.
 *
 * WHICH WAY IT FAILS, DELIBERATELY. Two errors are possible and they are not
 * symmetric. Reporting landed work as UNLANDED wastes a session. Reporting
 * unlanded work as LANDED loses the work, and this verdict feeds branch
 * deletion. So an unmeasurable branch is UNKNOWN, never LANDED, and every
 * unrecognised state is named rather than folded into a neighbour.
 *
 * IT PRINTS THE POPULATION. A verdict with no denominator is indistinguishable
 * from a finder that returned nothing, so every run says how many branches it
 * saw and how each was classified.
 *
 * Usage:
 *   node check-branch-landed.js [<branch>...] [--repo <path>] [--trunk <ref>] [--json]
 *   node check-branch-landed.js --selftest
 *
 * With no branch named, every origin branch not equal to the trunk is checked.
 *
 * Exit: 0 every branch classified and none carries unlanded work,
 *       2 at least one branch carries unlanded work,
 *       3 at least one branch could not be classified (UNKNOWN).
 * Never throws; a crash would be indistinguishable from a verdict.
 */

const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// PURE CLASSIFICATION. Takes evidence already gathered, returns a verdict.
// Kept free of I/O so the suite can plant each trap directly rather than
// needing a live forge; a suite that mocked `gh` would be testing the mock.
// ---------------------------------------------------------------------------

const VERDICTS = {
    LANDED_ANCESTOR: 'LANDED-ANCESTOR',
    LANDED_SQUASH: 'LANDED-SQUASH',
    LANDED_CONTENT: 'LANDED-CONTENT',
    BEHIND: 'BEHIND',
    UNLANDED: 'UNLANDED',
    UNKNOWN: 'UNKNOWN',
};

/**
 * `evidence` fields, all optional except `tip`:
 *   tip              branch tip sha (string)
 *   tipIsAncestor    bool|null   is tip an ancestor of the trunk?
 *   mergedPRs        array|null  [{number, headRefOid, mergeCommitOid,
 *                                 mergeCommitIsAncestor}] - null means NOT ASKED
 *                                or the ask FAILED. An empty array means asked
 *                                and answered "none", which is still not
 *                                evidence of not-landed.
 *   files            array|null  [{path, trunkBlob, branchBlob}] - null means
 *                                could not read. trunkBlob null = absent there.
 *   added, deleted   number|null line counts the branch would contribute
 */
function classify(evidence) {
    const e = evidence || {};
    if (!e.tip) return { verdict: VERDICTS.UNKNOWN, reason: 'no branch tip supplied' };

    // (a) plain ancestry. Only ever used to prove LANDED, never to prove the
    // negative - that asymmetry is the whole point of this file.
    if (e.tipIsAncestor === true) {
        return { verdict: VERDICTS.LANDED_ANCESTOR, reason: 'branch tip is an ancestor of the trunk' };
    }

    // (b) merged PR carrying this exact tip. Both halves are required: a merged
    // PR whose merge commit is NOT on the trunk landed somewhere else.
    if (Array.isArray(e.mergedPRs)) {
        for (const pr of e.mergedPRs) {
            if (!pr || pr.headRefOid !== e.tip) continue;
            if (pr.mergeCommitIsAncestor === true) {
                return {
                    verdict: VERDICTS.LANDED_SQUASH,
                    reason: 'merged PR #' + pr.number + ' head == branch tip, and its merge commit '
                          + shortSha(pr.mergeCommitOid) + ' is an ancestor of the trunk',
                    pr: pr.number,
                };
            }
            if (pr.mergeCommitIsAncestor === false) {
                return {
                    verdict: VERDICTS.UNKNOWN,
                    reason: 'merged PR #' + pr.number + ' head == branch tip, but its merge commit '
                          + shortSha(pr.mergeCommitOid) + ' is NOT an ancestor of this trunk - '
                          + 'it landed on a different base',
                };
            }
        }
    }
    // NOTE the absence of an `else` returning UNLANDED. mergedPRs === null means
    // the forge was never asked or the ask failed, and mergedPRs === [] means it
    // answered "none". NEITHER is evidence that the branch is unlanded. Both
    // fall through to content, which is trap 4 made unreachable by construction.

    // (c) content. Every touched path identical on the trunk means the work is
    // up there under other SHAs.
    if (Array.isArray(e.files) && e.files.length) {
        const missing = e.files.filter((f) => !f || f.trunkBlob == null || f.trunkBlob !== f.branchBlob);
        if (!missing.length) {
            return {
                verdict: VERDICTS.LANDED_CONTENT,
                reason: 'no merged PR carries this tip, but all ' + e.files.length
                      + ' touched file(s) are byte-identical on the trunk',
            };
        }
    }

    // (d) shape. Mostly deletions means the trunk moved on without this branch.
    if (typeof e.added === 'number' && typeof e.deleted === 'number' && (e.added + e.deleted) > 0) {
        if (e.deleted > e.added) {
            return {
                verdict: VERDICTS.BEHIND,
                reason: 'would contribute +' + e.added + ' / -' + e.deleted
                      + ' against the trunk - mostly deletions, so it is behind rather than '
                      + 'ahead and landing it is a revert',
            };
        }
        return {
            verdict: VERDICTS.UNLANDED,
            reason: 'would contribute +' + e.added + ' / -' + e.deleted + ' against the trunk',
        };
    }

    return {
        verdict: VERDICTS.UNKNOWN,
        reason: 'no merged PR carries this tip and the diff against the trunk could not be read',
    };
}

function shortSha(s) { return typeof s === 'string' && s.length > 8 ? s.slice(0, 8) : String(s == null ? '?' : s); }

function isLanded(v) {
    return v === VERDICTS.LANDED_ANCESTOR || v === VERDICTS.LANDED_SQUASH || v === VERDICTS.LANDED_CONTENT;
}

// ---------------------------------------------------------------------------
// Rendering. Population first, always.
// ---------------------------------------------------------------------------

function summarise(rows) {
    const counts = new Map();
    for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) || 0) + 1);
    return counts;
}

function present(rows) {
    const out = [];
    const counts = summarise(rows);
    out.push('branch-landed: ' + rows.length + ' branch(es) checked');
    for (const v of Object.values(VERDICTS)) {
        const n = counts.get(v) || 0;
        if (n) out.push('  ' + String(n).padStart(4) + '  ' + v);
    }
    if (!rows.length) out.push('  a real zero: the branch list was read and was empty');
    out.push('');
    for (const r of rows) {
        if (isLanded(r.verdict)) continue;
        out.push('  ' + r.verdict + '  ' + r.branch);
        out.push('        ' + r.reason);
    }
    const unknown = rows.filter((r) => r.verdict === VERDICTS.UNKNOWN).length;
    if (unknown) {
        out.push('');
        out.push('  ' + unknown + ' branch(es) could NOT be classified. That is not a pass.');
        out.push('  An unmeasurable branch is never reported as landed, because this verdict');
        out.push('  feeds branch deletion and a wrong LANDED loses the work.');
    }
    return out.join('\n');
}

module.exports = { classify, present, summarise, isLanded, VERDICTS };

// ---------------------------------------------------------------------------
// I/O layer + CLI.
// ---------------------------------------------------------------------------

function git(args, cwd) {
    try { return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
    catch (err) { return { ok: false, reason: (err && err.message ? String(err.message).split('\n')[0] : 'git failed') }; }
}

function gh(args) {
    try { return { ok: true, out: execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
    catch (err) { return { ok: false, reason: (err && err.message ? String(err.message).split('\n')[0] : 'gh failed') }; }
}

function gatherEvidence(branch, trunk, cwd, slug) {
    const tipR = git(['rev-parse', branch], cwd);
    if (!tipR.ok) return { tip: null };
    const tip = tipR.out;

    const anc = git(['merge-base', '--is-ancestor', tip, trunk], cwd);
    const ev = { tip, tipIsAncestor: anc.ok };
    if (ev.tipIsAncestor) return ev;

    // BY SHA, not by title search. This is the line that makes trap 4 impossible.
    ev.mergedPRs = null;
    if (slug) {
        const r = gh(['api', 'repos/' + slug + '/commits/' + tip + '/pulls',
                      '-H', 'Accept: application/vnd.github.groot-preview+json',
                      '--jq', '.[] | select(.merged_at != null) | "\\(.number) \\(.head.sha) \\(.merge_commit_sha)"']);
        if (r.ok) {
            ev.mergedPRs = r.out ? r.out.split(/\r?\n/).filter(Boolean).map((line) => {
                const [number, headRefOid, mergeCommitOid] = line.split(/\s+/);
                const a = git(['merge-base', '--is-ancestor', mergeCommitOid, trunk], cwd);
                return { number: Number(number), headRefOid, mergeCommitOid, mergeCommitIsAncestor: a.ok };
            }) : [];
        }
    }

    const base = git(['merge-base', trunk, branch], cwd);
    if (base.ok) {
        const names = git(['diff', '--name-only', base.out, branch], cwd);
        if (names.ok && names.out) {
            ev.files = names.out.split(/\r?\n/).filter(Boolean).map((p) => ({
                path: p,
                trunkBlob: git(['rev-parse', trunk + ':' + p], cwd).out || null,
                branchBlob: git(['rev-parse', branch + ':' + p], cwd).out || null,
            }));
        }
    }

    const num = git(['diff', '--numstat', trunk, branch], cwd);
    if (num.ok) {
        let added = 0, deleted = 0;
        for (const line of num.out.split(/\r?\n/)) {
            const m = line.match(/^(\d+)\t(\d+)\t/);
            if (m) { added += Number(m[1]); deleted += Number(m[2]); }
        }
        ev.added = added; ev.deleted = deleted;
    }
    return ev;
}

function selftest() {
    const t = require('assert');
    let n = 0;
    const ck = (label, cond) => { n++; if (!cond) { console.error('SELFTEST FAIL  ' + label); process.exit(1); } };

    // The three ancestry traps must NOT produce a LANDED verdict on their own,
    // and must NOT produce UNLANDED either where content says otherwise.
    ck('an empty merged-PR list is not evidence of unlanded',
        classify({ tip: 'a', mergedPRs: [], files: [{ path: 'x', trunkBlob: 'b', branchBlob: 'b' }] }).verdict === VERDICTS.LANDED_CONTENT);
    ck('a null merged-PR list is not evidence of unlanded',
        classify({ tip: 'a', mergedPRs: null, files: [{ path: 'x', trunkBlob: 'b', branchBlob: 'b' }] }).verdict === VERDICTS.LANDED_CONTENT);
    ck('a merged PR whose head is the tip lands it',
        classify({ tip: 'a', mergedPRs: [{ number: 1, headRefOid: 'a', mergeCommitOid: 'm', mergeCommitIsAncestor: true }] }).verdict === VERDICTS.LANDED_SQUASH);
    ck('a merged PR on another base does not land it',
        classify({ tip: 'a', mergedPRs: [{ number: 1, headRefOid: 'a', mergeCommitOid: 'm', mergeCommitIsAncestor: false }] }).verdict === VERDICTS.UNKNOWN);
    ck('a merged PR whose head is NOT the tip is ignored',
        classify({ tip: 'a', mergedPRs: [{ number: 1, headRefOid: 'zz', mergeCommitIsAncestor: true }], added: 5, deleted: 0 }).verdict === VERDICTS.UNLANDED);
    ck('mostly deletions is BEHIND, not UNLANDED',
        classify({ tip: 'a', added: 676, deleted: 14725 }).verdict === VERDICTS.BEHIND);
    ck('unmeasurable is UNKNOWN, never landed',
        classify({ tip: 'a' }).verdict === VERDICTS.UNKNOWN);
    ck('ancestry proves landed',
        classify({ tip: 'a', tipIsAncestor: true }).verdict === VERDICTS.LANDED_ANCESTOR);
    console.log(n + ' selftest assertion(s) passed');
    return 0;
}

function main(argv) {
    if (argv.includes('--selftest')) return selftest();
    const json = argv.includes('--json');
    const at = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
    const cwd = at('--repo', process.cwd());
    const trunk = at('--trunk', 'origin/main');

    let branches = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--repo' && argv[i - 1] !== '--trunk');
    branches = branches.slice(2);
    if (!branches.length) {
        const r = git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], cwd);
        if (!r.ok) { console.error('could not list branches: ' + r.reason); return 3; }
        branches = r.out.split(/\r?\n/).filter((b) => b && b !== trunk && !b.endsWith('/HEAD') && b !== 'origin');
    }

    let slug = null;
    const rem = git(['remote', 'get-url', 'origin'], cwd);
    if (rem.ok) { const m = rem.out.match(/github\.com[:/]+([^/]+\/[^/.]+)/); if (m) slug = m[1]; }

    const rows = branches.map((b) => {
        const ev = gatherEvidence(b, trunk, cwd, slug);
        const v = classify(ev);
        // The TIP is reported even for a landed branch, and that is deliberate:
        // this output is the record that makes a branch deletion reversible
        // (`git push origin <sha>:refs/heads/<name>`), and a SHA that exists only
        // in the deleting session's scrollback is not a record of anything.
        return { branch: b, tip: ev.tip, verdict: v.verdict, reason: v.reason, pr: v.pr };
    });

    if (json) console.log(JSON.stringify({ trunk, slug, rows }, null, 2));
    else console.log(present(rows));

    if (rows.some((r) => r.verdict === VERDICTS.UNKNOWN)) return 3;
    if (rows.some((r) => r.verdict === VERDICTS.UNLANDED)) return 2;
    return 0;
}

if (require.main === module) {
    let code = 3;
    try { code = main(process.argv); }
    catch (err) { console.error('check-branch-landed: ' + (err && err.message)); code = 3; }
    process.exitCode = code;
}
