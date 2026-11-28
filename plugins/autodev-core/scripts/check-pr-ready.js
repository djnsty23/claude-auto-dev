#!/usr/bin/env node
'use strict';
/**
 * check-pr-ready.js - answer "is this pull request actually safe to merge?"
 * without the four traps that made a coordinator get it wrong three times in
 * one day.
 *
 * WHY THIS EXISTS. The obvious probe is a jq expression over
 * `gh pr view --json statusCheckRollup`, and every hand-rolled version of it
 * failed differently:
 *
 *   1. `.conclusion // "NONE"` looks like it defaults a missing value. jq's `//`
 *      falls through on null and false, NOT on an empty string, and an
 *      in-progress check reports conclusion as "". So a filter written to catch
 *      unfinished checks matched nothing and the run was declared TERMINAL while
 *      every check was still running.
 *   2. The inverse: `select(.conclusion != "SUCCESS")` counts those same empty
 *      strings as failures, so four PENDING checks were reported as four
 *      FAILING ones.
 *   3. A SKIPPED check is not a passing check. A draft PR whose gate carries
 *      `draft == false` reports SKIPPED, and the rollup then looks untroubled
 *      while carrying no evidence at all. `[measured 2026-09-05]` a draft sat
 *      MERGEABLE/CLEAN with its main gate never run. The one exception is an
 *      app in OPT_IN_SKIP_APPS whose check GitHub reports as not required:
 *      that skip means nobody asked for the run, so it is set aside and
 *      counted apart. It is never evidence either way.
 *   4. Rollups carry an entry with a null name, null status and null conclusion
 *      on every PR in every repo checked. It is an artifact, not a check, and
 *      counting it as unknown makes every PR permanently unmergeable.
 *
 * THE RULE IT ENCODES: an unrecognised state is the DANGEROUS case. Anything
 * this cannot classify counts as not-ready, and says so by name, rather than
 * falling through to success.
 *
 * TEST-EDITS (advisory). A worker told to turn a red suite green can edit the
 * test instead of the code. For a PR that changes at least one non-test file,
 * this lists every assertion line a test file loses or rewrites (with the OLD
 * text), every test file deleted outright, and every skip/only/todo added. A
 * test-only PR is the legitimate way to change a test and is not flagged. It
 * never changes the verdict or the exit code; --json carries it as testEdits,
 * null when `gh pr diff` could not be read.
 *
 * IT PRINTS THE POPULATION. A verdict with no denominator is indistinguishable
 * from a finder that returned nothing, so every run says how many checks it saw
 * and how each was classified.
 *
 * Usage:
 *   node check-pr-ready.js <pr-number> [--repo <path|owner/repo>] [--json]
 *   node check-pr-ready.js --selftest
 *
 * Exit: 0 ready, 2 not ready, 3 could not tell (gh failed, no such PR).
 * Never throws; a crash would be indistinguishable from a verdict.
 */

const { execFileSync } = require('child_process');

const TERMINAL_GOOD = new Set(['SUCCESS', 'NEUTRAL']);
const TERMINAL_BAD = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE']);
const NOT_EVIDENCE = new Set(['SKIPPED']);
// Legacy commit statuses (Vercel, most bots) carry `state`, not `status`, and
// report PENDING while running. `[measured 2026-09-05]` that read as
// UNRECOGNISED on a real PR: the fail-safe direction, but wrong in kind, since
// pending is a state this script knows and waits on. EXPECTED is GitHub's
// "required check not yet reported".
const STILL_RUNNING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

// Apps whose SKIPPED check means "nobody asked for this run", not "a gate was
// skipped". A skip is ignored only when GitHub names the check run's app here
// AND reports the check as not required by the base branch's protection. Any
// other app, a required check, or an answer GitHub did not give keeps the skip
// counted, so an app missing from this list fails closed.
const OPT_IN_SKIP_APPS = Object.freeze({
    // Blacksmith posts a check on every PR and runs it only on dispatch or a
    // label, so every PR that did not ask for it carries a SKIPPED entry.
    'blacksmith-sh': 'runs only when requested, and reports SKIPPED on every other PR',
});

// `--repo` takes a checkout path or an owner/name slug. A slug has no local
// checkout, so it goes to gh as -R and the trunk's workflow files cannot be read.
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/;

/** @returns {{cwd:string, slug:string|null}|{error:string}} */
function resolveRepo(value, fs = require('fs')) {
    if (value === undefined) return { cwd: process.cwd(), slug: null };
    try { if (fs.statSync(value).isDirectory()) return { cwd: value, slug: null }; } catch (e) { /* not a path */ }
    if (SLUG.test(value)) return { cwd: process.cwd(), slug: value };
    return { error: '--repo takes an existing directory (a checkout) or an owner/name slug, and ' + JSON.stringify(value) + ' is neither' };
}

function gh(args, cwd) {
    try {
        return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        return null;
    }
}

/** An empty string is not a value. jq's `//` disagrees, which is trap 1 and 2. */
function present(v) {
    return v !== null && v !== undefined && String(v).trim() !== '';
}

// A test file: *.test.*, *.spec.*, anything under __tests__/, test/ or tests/,
// and this repo's own tooling/test-*.js suites.
const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[^/]+$|(^|\/)tooling\/test-[^/]+\.js$/;
// An assertion. check( and ok( are this repo's own: check( alone carried 6748
// lines across 173 suites on 2026-10-02, against 141 lines of assert.
const ASSERTION = /\bassert\b|\bexpect\w*\(|\.should\b|\bt\.(is|not|true|false|truthy|falsy|deepEqual|notDeepEqual|equal|notEqual|ok|throws|regex)\(|\.to(Be|Equal|StrictEqual|Match|Throw|Have|Contain)\w*\(|\bcheck\(|\bok\(|\beq\(/;
// A test switched off, or the rest of a file switched off by an .only.
const SKIP_ADDED = /\.(skip|only|todo)\s*\(|\b(xit|xdescribe|xtest)\s*\(|\bskip\s*:\s*true\b/;

/** One entry per file in a unified diff: its paths, whether it was deleted, and its -/+ lines with line numbers. */
function parseDiff(text) {
    const files = [];
    let cur = null, oldLine = 0, newLine = 0;
    for (const line of String(text).split(/\r?\n/)) {
        const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (head) { cur = { oldPath: head[1], path: head[2], deleted: false, removed: [], added: [] }; files.push(cur); continue; }
        if (!cur) continue;
        if (line.startsWith('deleted file mode')) { cur.deleted = true; continue; }
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
        if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
        if (line.startsWith('-')) { cur.removed.push({ line: oldLine++, text: line.slice(1) }); continue; }
        if (line.startsWith('+')) { cur.added.push({ line: newLine++, text: line.slice(1) }); continue; }
        if (line.startsWith(' ')) { oldLine++; newLine++; }
    }
    return files;
}

/**
 * The test edits a diff carries. A removed or rewritten assertion shows as a
 * `-` line, so its OLD text is what gets listed. An added assertion never is.
 * @returns {{testEdits:Array, population:object}}
 */
function findTestEdits(diffText) {
    const files = parseDiff(diffText);
    const tests = files.filter((f) => TEST_FILE.test(f.path) || TEST_FILE.test(f.oldPath));
    const code = files.length - tests.length;
    const found = [];
    let assertionLinesRemoved = 0;
    for (const f of tests) {
        const removed = f.removed.filter((l) => ASSERTION.test(l.text));
        assertionLinesRemoved += removed.length;
        if (f.deleted) { found.push({ file: f.oldPath, line: null, kind: 'file-deleted', text: removed.length + ' assertion line(s) in the deleted file' }); continue; }
        for (const l of removed) found.push({ file: f.path, line: l.line, kind: 'assertion-removed', text: l.text });
        for (const l of f.added) if (SKIP_ADDED.test(l.text)) found.push({ file: f.path, line: l.line, kind: 'skip-added', text: l.text });
    }
    const testOnly = code === 0;
    return {
        testEdits: testOnly ? [] : found,
        population: { filesInDiff: files.length, testFilesTouched: tests.length, codeFilesTouched: code, assertionLinesRemoved, flaggable: found.length, testOnly },
    };
}

const CHECK_APPS_QUERY = 'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){'
    + 'commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename '
    + '... on CheckRun{name conclusion isRequired(pullRequestNumber:$n) checkSuite{app{slug}}}}}}}}}}}}';

/**
 * Which app posted each check run on the PR's head, and whether the base
 * branch requires it. The rollup gh pr view returns carries neither, and a
 * check NAME says nothing about who posted it.
 * @returns {{runs:Array<{name:string, app:string|null, required:boolean|null}>}|{error:string}}
 */
function checkRunApps(repoSlug, prNumber, headOid, cwd) {
    const [owner, name] = String(repoSlug || '').split('/');
    if (!owner || !name) return { error: 'the repository slug is unknown' };
    // -f sends a raw string. -F would turn a repo named 2026 or true into a
    // number or boolean, and the String! variables would then fail to bind.
    const raw = gh(['api', 'graphql', '-f', 'query=' + CHECK_APPS_QUERY, '-f', 'owner=' + owner, '-f', 'name=' + name,
        '-F', 'n=' + prNumber], cwd);
    if (raw === null) return { error: 'gh api graphql gave no answer' };
    let commit;
    try { commit = JSON.parse(raw).data.repository.pullRequest.commits.nodes[0].commit; } catch (e) {
        return { error: 'gh api graphql returned an unexpected shape' };
    }
    if (!commit || !present(commit.oid) || commit.oid !== headOid) return { error: 'the head commit moved between the two reads' };
    const contexts = commit.statusCheckRollup && commit.statusCheckRollup.contexts;
    if (!contexts || !Array.isArray(contexts.nodes)) return { error: 'the head commit carries no check list' };
    if (!contexts.pageInfo || contexts.pageInfo.hasNextPage !== false) return { error: 'the check list runs past one page' };
    const runs = contexts.nodes.filter((c) => c && c.__typename === 'CheckRun').map((c) => ({
        name: c.name,
        conclusion: present(c.conclusion) ? String(c.conclusion).toUpperCase() : null,
        app: c.checkSuite && c.checkSuite.app && present(c.checkSuite.app.slug) ? c.checkSuite.app.slug : null,
        required: typeof c.isRequired === 'boolean' ? c.isRequired : null,
    }));
    return { runs };
}

/**
 * A skipped check is ignorable only when EVERY check run of that name on the
 * head comes from an allowlisted app, GitHub says none of them is required, and
 * at least one of them is the skip. Names are not identities, so one run of
 * the name that fails any of these keeps the skip counted.
 * @returns {string|null} the app slug when ignorable, else null
 */
function optInApp(label, runs) {
    const same = runs.filter((r) => r.name === label);
    if (!same.some((r) => r.conclusion === 'SKIPPED')) return null;
    if (!same.every((r) => r.app !== null && Object.prototype.hasOwnProperty.call(OPT_IN_SKIP_APPS, r.app) && r.required === false)) return null;
    const apps = new Set(same.map((r) => r.app));
    return apps.size === 1 ? [...apps][0] : null;
}

/**
 * @returns {{verdict:'READY'|'NOT_READY'|'CANNOT_TELL', reasons:string[],
 *            population:object, checks:Array}}
 */
function checkPrReady(prNumber, cwd, slug = null) {
    const repoArgs = slug ? ['-R', slug] : [];
    const raw = gh(['pr', 'view', String(prNumber), ...repoArgs, '--json',
        'number,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,url,headRefOid,headRefName,files'], cwd);
    if (raw === null) {
        return { verdict: 'CANNOT_TELL', reasons: ['gh could not answer for PR ' + prNumber + ' in ' + (slug || cwd || process.cwd())], population: {}, checks: [] };
    }
    let pr;
    try { pr = JSON.parse(raw); } catch (e) {
        return { verdict: 'CANNOT_TELL', reasons: ['gh returned unparseable JSON'], population: {}, checks: [] };
    }

    const reasons = [];
    const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];

    let good = 0, bad = 0, pending = 0, skipped = 0, artifact = 0, unknown = 0;
    const checks = [];

    for (const c of rollup) {
        const name = present(c.name) ? c.name : (present(c.context) ? c.context : null);
        const status = present(c.status) ? String(c.status).toUpperCase() : null;
        const concl = present(c.conclusion) ? String(c.conclusion).toUpperCase()
            : (present(c.state) ? String(c.state).toUpperCase() : null);

        // Trap 4: an entry with no name AND no status AND no conclusion is a
        // rollup artifact, seen on every PR in every repo. Counting it as
        // unknown makes everything permanently unmergeable.
        if (name === null && status === null && concl === null) { artifact++; continue; }

        const label = name || '(unnamed)';
        if (status !== null && status !== 'COMPLETED') { pending++; checks.push([label, status + '/pending']); continue; }
        if (concl === null) { pending++; checks.push([label, 'no conclusion yet']); continue; }
        if (STILL_RUNNING.has(concl)) { pending++; checks.push([label, concl + '/pending']); continue; }
        if (NOT_EVIDENCE.has(concl)) { skipped++; checks.push([label, 'SKIPPED']); continue; }
        if (TERMINAL_GOOD.has(concl)) { good++; checks.push([label, concl]); continue; }
        if (TERMINAL_BAD.has(concl)) { bad++; checks.push([label, concl]); continue; }
        unknown++; checks.push([label, 'UNRECOGNISED:' + concl]);
    }

    // An opt-in app's skip is the app not being asked, so it is set aside. It
    // is not evidence either way, which is why it leaves the emptiness test.
    let optIn = 0, optInLookup = null;
    if (skipped > 0) {
        const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(String(pr.url || ''));
        optInLookup = checkRunApps(slug || (m && m[1]), prNumber, pr.headRefOid, cwd);
        if (optInLookup.runs) {
            for (const row of checks) {
                if (row[1] !== 'SKIPPED') continue;
                const app = optInApp(row[0], optInLookup.runs);
                if (app) { row[1] = 'SKIPPED/opt-in ' + app + ', ignored'; optIn++; skipped--; }
            }
        }
    }

    const population = {
        rollupEntries: rollup.length, passing: good, failing: bad,
        pending, skipped, optInSkipped: optIn, rollupArtifacts: artifact, unrecognised: unknown,
    };

    if (pr.state !== 'OPEN') reasons.push('state is ' + pr.state + ', not OPEN');
    // Trap 3: a draft's checks are not evidence, whatever the rollup shows.
    if (pr.isDraft) reasons.push('it is a DRAFT, so a guarded gate reports SKIPPED and the rollup is not evidence');
    if (bad > 0) reasons.push(bad + ' check(s) FAILED');
    if (pending > 0) reasons.push(pending + ' check(s) have not completed');
    if (unknown > 0) reasons.push(unknown + ' check(s) reported a state this script does not recognise, counted as not-ready');
    if (present(pr.mergeable) && pr.mergeable !== 'MERGEABLE') reasons.push('mergeable is ' + pr.mergeable);
    if (present(pr.mergeStateStatus) && !['CLEAN', 'UNSTABLE'].includes(pr.mergeStateStatus)) {
        reasons.push('mergeStateStatus is ' + pr.mergeStateStatus);
    }
    // UNSTABLE with everything terminal and green means only the artifact row is
    // unresolved, which is why it is allowed above but noted here.
    if (pr.mergeStateStatus === 'UNSTABLE' && bad === 0 && pending === 0) {
        reasons.push('mergeStateStatus is UNSTABLE with no failing or pending check; usually the rollup artifact');
    }
    // A passing lint job says nothing about a skipped test job. This response
    // contains no authoritative required-job set, so it cannot establish that
    // a skip was optional. Even a same-name success can belong to another
    // workflow; treating names as identities would make that a false pass too.
    if (skipped > 0) {
        const names = checks.filter(([, state]) => state === 'SKIPPED').map(([name]) => name);
        reasons.push(skipped + ' check(s) were SKIPPED: ' + names.join(', ')
            + '; their required/optional status is not established, so other successful checks cannot certify readiness'
            + (optInLookup && optInLookup.error ? ' (the opt-in app lookup failed: ' + optInLookup.error + ')' : ''));
    }
    // An empty rollup looks identical to a clean one and is not. But it has two
    // causes with opposite meanings: every PR-firing workflow path-filtered the
    // change out (fine, nothing could ever go red), or a gate was due and never
    // started (the outage shape). Ask the workflow files at the trunk which.
    let pathFilter = null;
    // Artifacts are not checks. A rollup containing only artifacts has exactly
    // the same missing evidence as an empty array and needs the same analysis.
    if (checks.length - optIn === 0) {
        const files = Array.isArray(pr.files) ? pr.files.map((f) => f.path).filter(Boolean) : [];
        // A slug names no checkout, so the trunk's workflows cannot be read here.
        if (files.length && cwd && !slug) {
            try {
                const { explainEmptyRollup } = require(require('path').join(__dirname, 'pr-path-filters.js'));
                pathFilter = explainEmptyRollup(cwd, 'origin/' + (pr.baseRefName || 'main'), files, pr.baseRefName);
            } catch (e) { pathFilter = null; }
        }
        // A workflow git could not read is not one that excluded the files: it
        // might have been due. Only every workflow answering "would not" is benign.
        const unreadable = pathFilter ? pathFilter.workflows.filter((w) => w.wouldRun === null) : [];
        if (pathFilter && !pathFilter.anyDue && pathFilter.population > 0 && unreadable.length === 0) {
            reasons.push('the rollup is EMPTY and that is the path filter working: ' + files.length + ' changed file(s) excluded by all '
                + pathFilter.population + ' workflow(s) at the trunk, so nothing could have run or gone red');
        } else if (pathFilter && pathFilter.anyDue) {
            const due = pathFilter.workflows.filter((w) => w.wouldRun).map((w) => w.name + ' (' + w.why + ')').join(', ');
            reasons.push('the rollup is EMPTY but a run was DUE and none exists: ' + due);
        } else if (pathFilter && (pathFilter.failure || unreadable.length)) {
            reasons.push('the rollup is EMPTY and git could not read the trunk\'s workflows to tell whether a run was due: '
                + (pathFilter.failure || unreadable.map((w) => w.name + ' (' + w.why + ')').join(', ')));
        } else {
            reasons.push('the rollup is EMPTY, which looks identical to a clean one and is not'
                + (files.length ? '' : '; could not read the changed files to tell whether a gate was due')
                + (files.length && slug ? '; --repo was a slug, so there is no checkout to read the trunk workflows from' : ''));
        }
    }

    // Two reasons are notes, not blocks: the UNSTABLE-with-nothing-pending
    // artifact, and an empty rollup the path filters fully account for.
    const blocking = reasons.filter((r) => !r.startsWith('mergeStateStatus is UNSTABLE with no')
        && !r.startsWith('the rollup is EMPTY and that is the path filter working'));
    // Advisory: read after the verdict is fixed, and nothing below feeds it.
    const diff = gh(['pr', 'diff', String(prNumber), ...repoArgs], cwd);
    const edits = diff === null ? { testEdits: null, population: null } : findTestEdits(diff);
    return { verdict: blocking.length === 0 ? 'READY' : 'NOT_READY', reasons, population, checks, pr,
        testEdits: edits.testEdits, testEditsPopulation: edits.population };
}

function render(r) {
    const out = [];
    out.push('  verdict: ' + r.verdict);
    if (r.pr) out.push('  #' + r.pr.number + ' ' + r.pr.state + ' draft=' + r.pr.isDraft
        + ' ' + r.pr.mergeable + '/' + r.pr.mergeStateStatus
        + '  ' + r.pr.headRefName + ' -> ' + r.pr.baseRefName);
    const p = r.population;
    out.push('  population: ' + (p.rollupEntries || 0) + ' rollup entries = '
        + (p.passing || 0) + ' passing, ' + (p.failing || 0) + ' failing, '
        + (p.pending || 0) + ' pending, ' + (p.skipped || 0) + ' skipped, ' + (p.optInSkipped || 0) + ' opt-in skipped, '
        + (p.rollupArtifacts || 0) + ' artifact, ' + (p.unrecognised || 0) + ' unrecognised');
    for (const [n, s] of r.checks) out.push('    ' + n + ': ' + s);
    if (r.reasons.length) { out.push('  why not ready:'); for (const x of r.reasons) out.push('    - ' + x); }
    out.push(...renderTestEdits(r));
    return out.join('\n');
}

function renderTestEdits(r) {
    if (r.verdict === 'CANNOT_TELL') return [];
    if (!Array.isArray(r.testEdits)) return ['  TEST-EDITS could not tell: gh pr diff gave no answer, so test edits were not checked'];
    const p = r.testEditsPopulation;
    const out = ['  TEST-EDITS ' + r.testEdits.length + ' (advisory, never changes the verdict)',
        '    read ' + p.filesInDiff + ' file(s) in the diff: ' + p.testFilesTouched + ' test file(s) touched, '
        + p.codeFilesTouched + ' other, ' + p.assertionLinesRemoved + ' assertion line(s) removed or rewritten'
        + (p.testOnly ? '; a test-only PR, so nothing is flagged' : '')];
    for (const e of r.testEdits) out.push('    ' + e.file + (e.line === null ? '' : ':' + e.line) + '  ' + e.kind + '  ' + e.text.trim());
    return out;
}

function selftest() {
    let pass = 0, fail = 0;
    const t = (label, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label + (detail ? '  (' + detail + ')' : '')); } };

    // present() is the whole of traps 1 and 2, so it gets its own cases.
    t('present: empty string is NOT a value', present('') === false);
    t('present: null is not a value', present(null) === false);
    t('present: undefined is not a value', present(undefined) === false);
    t('present: "SUCCESS" is a value', present('SUCCESS') === true);
    t('present: 0 IS a value, unlike jq //', present(0) === true);

    t('SKIPPED is not counted as evidence', NOT_EVIDENCE.has('SKIPPED'));
    t('SUCCESS is terminal-good', TERMINAL_GOOD.has('SUCCESS'));
    t('STARTUP_FAILURE is terminal-bad, not unknown', TERMINAL_BAD.has('STARTUP_FAILURE'));
    t('an invented conclusion is in NEITHER set, so it counts as unrecognised',
        !TERMINAL_GOOD.has('DEFINITELY_NOT_A_REAL_CONCLUSION') && !TERMINAL_BAD.has('DEFINITELY_NOT_A_REAL_CONCLUSION'));

    console.log('\nselftest: ' + pass + ' passed, ' + fail + ' failed');
    return fail === 0;
}

module.exports = { checkPrReady, present, render, parseDiff, findTestEdits, resolveRepo, optInApp, OPT_IN_SKIP_APPS };

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) return selftest() ? 0 : 1;
    if (argv.includes('--help') || argv.length === 0) {
        console.log('check-pr-ready.js <pr-number> [--repo <path|owner/repo>] [--json]\n'
            + '--repo is a checkout directory, or an owner/name slug passed to gh (default: the current directory).\n'
            + 'Answers whether a PR is safe to merge, treating an unrecognised state as NOT ready.\n'
            + 'TEST-EDITS lists assertion lines a code-changing PR removes from its tests (advisory).\n'
            + 'Exit 0 ready, 2 not ready, 3 could not tell.');
        return 0;
    }
    const num = argv.find((a) => /^\d+$/.test(a));
    const ri = argv.indexOf('--repo');
    const repo = resolveRepo(ri !== -1 ? (argv[ri + 1] === undefined ? '' : argv[ri + 1]) : undefined);
    if (repo.error) { console.error(repo.error); return 2; }
    if (!num) { console.error('need a PR number'); return 3; }
    const r = checkPrReady(num, repo.cwd, repo.slug);
    if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else console.log(render(r));
    return r.verdict === 'READY' ? 0 : r.verdict === 'NOT_READY' ? 2 : 3;
}

// process.exit() TRUNCATES output, and only on some platforms.
//
// node's process.stdout is ASYNCHRONOUS when it is a PIPE on POSIX (Linux and
// macOS alike) and synchronous when it is a pipe on win32; it is synchronous
// for a FILE everywhere. process.exit() terminates without draining a
// pending async write, so a run that prints more than the 64KiB OS pipe buffer
// and then exits delivers exactly 65536 bytes — under exit status 0, because
// the write never failed. A silent wrong answer, not a visible failure. The
// three things that hide it: a file redirect is synchronous so the output looks
// whole, the status is 0 so CI stays green (a Linux pipe is asynchronous too,
// so CI is exposed and cannot see it), and nothing compares byte counts.
//
// Setting process.exitCode instead lets the event loop drain the stream and
// exit on its own with the same status. Nothing here holds the loop open.
// See rendered-layout-gate.js for the case that cost this, and CLAUDE.md under
// conventions that have actually cost something.
if (require.main === module) process.exitCode = main();
