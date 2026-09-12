#!/usr/bin/env node
// flow-evidence.js — validate the record a runtime flow check leaves behind, and
// refuse one that carries no assertion.
//
// WHY THIS EXISTS. `[measured 2026-08-16]` docs/failure-evidence.md: across
// three production repos, 112 first-pass defects were incomplete flows or dead
// paths against 20 runtime crashes. Typecheck, build and a clean console catch
// the 20. The `auto` skill already screenshots public UI, and a screenshot is
// exactly the artefact that cannot tell "the handler nested where it never runs"
// from "the handler ran": both produce one green picture. So a story that
// claims a user-visible outcome has to leave a record with an ASSERTION ABOUT
// STATE — a row appeared, a number matches across the two surfaces that show
// it, the network call happened with the right shape — and an OBSERVED value
// the assertion can be checked against. This script is the thing that refuses
// the record when either is missing, so a story cannot be marked done on a
// screenshot alone.
//
// It validates; it does not drive the browser. The driving is the `auto`
// skill's job (see "Runtime flow check" in skills/auto/SKILL.md), through the
// in-app browser tools, and the record it writes lands beside `prove`'s
// captures in `.claude/evidence/<slug>/flow.json`.
//
// THE VERDICT IS COMPUTED HERE, NOT READ FROM THE RECORD. A `passed: true`
// field would be a claim; `expected` against `observed` is a check. A record
// whose author wrote the wrong `observed` still fails, which is the point.
//
// Usage:
//   node flow-evidence.js <record.json>      validate; exit 0 PASS, 1 FAIL, 2 REFUSED
//   node flow-evidence.js <record.json> --at <sha>
//                                            verify against <sha> instead of HEAD
//   node flow-evidence.js --template         print a skeleton record to fill in
//
// Exit codes are three, not two, because "the assertion failed" and "there was
// no assertion" are different findings: the first is a defect in the product,
// the second a defect in the verification. Collapsing them is how a missing
// check reads as a failing one and gets "fixed" by deleting it.
//
// A RECORD IS BOUND TO THE REVISION IT WAS MEASURED ON. `[measured 2026-09-09]`
// the Codex audit of this script showed a record dated 2000-01-01 with
// expected 1 / observed 1 passing with exit 0: nothing tied it to any commit,
// build or deployment, so one flow.json could be reused across arbitrary
// revisions and PASS meant only "internally consistent". So `commit` is
// required — the 40-char sha `git rev-parse HEAD` printed when the flow was
// driven, the tree the dev server was serving — and a record is REFUSED unless
// that commit is equal to, or an ancestor of, the commit being verified (`--at`,
// default HEAD). Ancestry rather than equality, because the record is committed
// WITH the change, so its commit is the parent of the commit that carries it;
// ancestry rather than an age bound, because an old proof stays valid while
// the code it proved is still in the history being verified. A refusal, not a
// warning: a warning on a reused record is a PASS with a footnote.
//
// Paths in `screenshots` resolve from the REPOSITORY ROOT (the nearest `.git`
// above the record, else the cwd), never from the record's own directory.
// `[measured 2026-09-09]` the template emitted `.claude/evidence/S00-000/after.png`
// while the reader resolved it against the record's directory, so a record
// saved where the skill says to save it looked for
// `.claude/evidence/S00-000/.claude/evidence/S00-000/after.png` and was refused
// at exactly the verification step.
//
// Pure Node, no dependencies. Reads the record, stats the screenshot paths and
// asks git one ancestry question; writes nothing.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// The subjects an assertion may be about. Each names a thing that has a value
// the check can read back: a DOM count or text, the URL, a request that was or
// was not issued, a console line, a storage key, a row, an API response body.
// "visual" is deliberately absent — a picture is evidence for a human, not an
// observed value, and `screenshots` is where it belongs.
const STATE_SUBJECTS = ['dom', 'text', 'url', 'network', 'console', 'storage', 'db', 'api'];

// Claims that name no outcome. "The page looked fine" is the sentence this
// script exists to refuse; the pattern is kept narrow so that a real claim
// containing the word "right" ("the right-hand total matches") still passes.
const VACUOUS_CLAIM = /^\s*(?:the\s+)?(?:(?:it|page|ui|screen|everything|all)\s+)?(?:look(?:s|ed)?|seem(?:s|ed)?|render(?:s|ed)?|work(?:s|ed)?|is|was)?\s*(?:fine|ok|okay|good|correct|right|as expected|normal)\s*[.!]?\s*$/i;

const FUTURE_SLACK_MS = 5 * 60 * 1000;

const SHA40 = /^[0-9a-f]{40}$/;

// The nearest directory at or above `dir` that holds a `.git` (a directory in
// a normal clone, a file in a worktree), or null when there is none.
function repoRootFor(dir) {
    let d = path.resolve(dir);
    for (;;) {
        if (fs.existsSync(path.join(d, '.git'))) return d;
        const up = path.dirname(d);
        if (up === d) return null;
        d = up;
    }
}

function git(root, args) {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), error: r.error };
}

// Resolve `ref` to a full sha in `root`, or null. Refs are passed as argv, not
// through a shell, and a leading `-` is refused so a value cannot become a git
// option.
function resolveCommit(root, ref) {
    if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-')) return null;
    const r = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.status === 0 && SHA40.test(r.stdout) ? r.stdout : null;
}

// true when `ancestor` is `descendant` or reachable from it, false when both
// exist and it is not, null when git could not answer (unknown commit, no repo).
function isAncestor(root, ancestor, descendant) {
    const r = git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    return null;
}

function template(cwd = process.cwd()) {
    const root = repoRootFor(cwd);
    return {
        story: 'S00-000',
        commit: root ? resolveCommit(root, 'HEAD') : null,
        flow: [
            'navigate /generate',
            'form_input #url = https://example.com',
            'computer left_click "Generate"',
        ],
        assertion: {
            subject: 'dom',
            claim: 'exactly one QR image is rendered with a data: URL source',
            expected: 1,
        },
        observed: null,
        observedBefore: null,
        screenshots: ['.claude/evidence/S00-000/after.png'],
        consoleErrors: 0,
        consoleErrorsBaseline: 0,
        timestamp: new Date().toISOString(),
    };
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (typeof a !== 'object') return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Returns { refusals: string[], failures: string[] }. A refusal is a defect in
// the record; a failure is a defect in the product the record observed.
//
// opts.root    the repository root screenshot paths resolve from and git is
//              asked in (default: nearest .git above the cwd, else the cwd)
// opts.at      the full sha the record is verified against; the record's
//              `commit` must be it or an ancestor of it
// opts.atError why no `at` could be resolved — reported as a refusal, because
//              a record whose revision cannot be checked is not a PASS
function validate(rec, opts = {}) {
    const root = opts.root || repoRootFor(process.cwd()) || process.cwd();
    const now = opts.now || Date.now();
    const refusals = [];
    const failures = [];

    if (!isPlainObject(rec)) return { refusals: ['record: not a JSON object'], failures };

    if (typeof rec.story !== 'string' || !rec.story.trim()) refusals.push('story: missing or empty');

    if (typeof rec.commit !== 'string' || !SHA40.test(rec.commit)) {
        refusals.push('commit: must be the 40-character sha the dev server was serving (`git rev-parse HEAD` when the flow was driven)');
    } else if (opts.atError) {
        refusals.push(`commit: cannot be verified — ${opts.atError}`);
    } else if (opts.at) {
        const reachable = isAncestor(root, rec.commit, opts.at);
        if (reachable === null) {
            refusals.push(`commit: ${rec.commit} is not a commit in ${root}`);
        } else if (!reachable) {
            refusals.push(`commit: ${rec.commit} is not reachable from ${opts.at} — the record was measured on another revision`);
        }
    }

    if (!Array.isArray(rec.flow) || rec.flow.length === 0) {
        refusals.push('flow: must be a non-empty array of steps');
    } else if (rec.flow.some((s) => typeof s !== 'string' || !s.trim())) {
        refusals.push('flow: every step must be a non-empty string');
    }

    const a = rec.assertion;
    if (!isPlainObject(a)) {
        refusals.push('assertion: missing — a screenshot alone does not close a story');
    } else {
        if (!STATE_SUBJECTS.includes(a.subject)) {
            refusals.push(`assertion.subject: "${a.subject}" is not a state subject (one of ${STATE_SUBJECTS.join(', ')})`);
        }
        if (typeof a.claim !== 'string' || !a.claim.trim()) {
            refusals.push('assertion.claim: missing or empty');
        } else if (VACUOUS_CLAIM.test(a.claim)) {
            refusals.push(`assertion.claim: "${a.claim.trim()}" names no outcome`);
        }
        if (!('expected' in a) || a.expected === null || a.expected === undefined) {
            refusals.push('assertion.expected: missing — an assertion without an expected value cannot fail');
        }
    }

    if (!('observed' in rec) || rec.observed === null || rec.observed === undefined) {
        refusals.push('observed: missing — nothing was read back from the page');
    }

    if (!Array.isArray(rec.screenshots)) {
        refusals.push('screenshots: must be an array (empty is allowed)');
    } else {
        for (const p of rec.screenshots) {
            if (typeof p !== 'string' || !p.trim()) { refusals.push('screenshots: every entry must be a path'); break; }
            const resolved = path.resolve(root, p);
            if (!fs.existsSync(resolved)) refusals.push(`screenshots: ${p} does not exist (resolved from the repository root as ${resolved})`);
        }
    }

    if (!Number.isInteger(rec.consoleErrors) || rec.consoleErrors < 0) {
        refusals.push('consoleErrors: must be a non-negative integer (the count from read_console_messages)');
    }
    if ('consoleErrorsBaseline' in rec && rec.consoleErrorsBaseline !== null
        && (!Number.isInteger(rec.consoleErrorsBaseline) || rec.consoleErrorsBaseline < 0)) {
        refusals.push('consoleErrorsBaseline: must be a non-negative integer (the count on the same page before the flow)');
    }

    if (typeof rec.timestamp !== 'string' || Number.isNaN(Date.parse(rec.timestamp))) {
        refusals.push('timestamp: must be an ISO-8601 string');
    } else if (Date.parse(rec.timestamp) > now + FUTURE_SLACK_MS) {
        refusals.push('timestamp: is in the future');
    }

    if (refusals.length) return { refusals, failures };

    // Structure is sound; now the verdict.
    if (!deepEqual(a.expected, rec.observed)) {
        failures.push(`assertion: expected ${JSON.stringify(a.expected)}, observed ${JSON.stringify(rec.observed)}`);
    }
    // `[measured 2026-09-08]` two dev servers driven from the in-app browser
    // pane carried console errors before any flow ran: a Next dev tree logged a
    // CSP complaint about React's eval and a blocked analytics script, a Vite
    // tree logged blocked script fetches. A rule that fails on ANY error fails
    // every record in those repos, and a check that always fails is one that
    // gets skipped. So the strict rule stays the default, and a record may carry
    // the count measured on the same page BEFORE the flow; the flow then fails
    // only on errors it added. The baseline is in the record, so a reviewer
    // sees "2 before, 2 after" rather than a silent allowance.
    const baseline = Number.isInteger(rec.consoleErrorsBaseline) ? rec.consoleErrorsBaseline : 0;
    if (rec.consoleErrors > baseline) {
        failures.push(baseline
            ? `console: ${rec.consoleErrors} error(s) during the flow against a baseline of ${baseline}`
            : `console: ${rec.consoleErrors} error(s) during the flow`);
    }
    // prove: "Two byte-identical captures mean the probe was blind, not that the
    // change was subtle." Same rule for a read-back value: a fix whose before
    // and after observe the same thing has not observed the fix.
    if ('observedBefore' in rec && rec.observedBefore !== null && rec.observedBefore !== undefined
        && deepEqual(rec.observedBefore, rec.observed)) {
        failures.push('observedBefore equals observed: the probe did not see the change');
    }
    return { refusals, failures };
}

// `--at <sha>` or `--at=<sha>`; returns { at, rest } with the flag and its
// value removed so the record path is whatever is left.
function parseArgs(argv) {
    const rest = [];
    let at;
    let atGiven = false;
    for (let i = 0; i < argv.length; i++) {
        const x = argv[i];
        if (x === '--at') { atGiven = true; at = argv[++i]; }
        else if (x.startsWith('--at=')) { atGiven = true; at = x.slice(5); }
        else rest.push(x);
    }
    return { at, atGiven, rest };
}

function main(argv) {
    const { at, atGiven, rest } = parseArgs(argv);
    if (rest.includes('--template')) {
        process.stdout.write(JSON.stringify(template(), null, 2) + '\n');
        return 0;
    }
    const file = rest.find((x) => !x.startsWith('--'));
    if (!file) {
        process.stdout.write('usage: flow-evidence.js <record.json> [--at <sha>] | --template\n');
        return 2;
    }
    let rec;
    try {
        rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        process.stdout.write(`flow-evidence: REFUSED ${file} — ${e.code === 'ENOENT' ? 'no such file' : 'not valid JSON'}\n`);
        return 2;
    }
    // The repository the record belongs to is the one it sits in; a record
    // outside any repository is checked against the cwd's.
    const root = repoRootFor(path.dirname(path.resolve(file))) || repoRootFor(process.cwd()) || process.cwd();
    let atSha = null;
    let atError = null;
    if (atGiven) {
        atSha = resolveCommit(root, at);
        if (!atSha) atError = `--at ${JSON.stringify(at === undefined ? '' : at)} is not a commit in ${root}`;
    } else {
        atSha = resolveCommit(root, 'HEAD');
        if (!atSha) atError = `${root} is not a git repository, so there is no HEAD to verify against (pass --at <sha> from inside one)`;
    }
    const { refusals, failures } = validate(rec, { root, at: atSha, atError });
    const story = isPlainObject(rec) && typeof rec.story === 'string' ? rec.story : '(no story)';
    if (refusals.length) {
        for (const r of refusals) process.stdout.write(`  ${r}\n`);
        process.stdout.write(`flow-evidence: REFUSED ${story} — ${refusals.length} defect(s) in the record\n`);
        return 2;
    }
    if (failures.length) {
        for (const f of failures) process.stdout.write(`  ${f}\n`);
        process.stdout.write(`flow-evidence: FAIL ${story} — ${failures.length} finding(s)\n`);
        return 1;
    }
    process.stdout.write(`flow-evidence: PASS ${story} — ${rec.assertion.subject}: ${rec.assertion.claim}\n`);
    return 0;
}

if (require.main === module) {
    // exitCode, not exit(): on darwin a piped stdout is asynchronous and
    // process.exit() truncates it (CLAUDE.md).
    process.exitCode = main(process.argv.slice(2));
}

module.exports = { validate, template, repoRootFor, STATE_SUBJECTS, SHA40 };
