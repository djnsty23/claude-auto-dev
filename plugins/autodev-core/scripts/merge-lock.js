#!/usr/bin/env node
/**
 * merge-lock.js - merge one GitHub PR under a per-repo lock, only when the
 * merged tree is the tree the gate proved.
 *
 * WHY. The merge bar is one gate per merge, run on the frozen candidate (in
 * this repo gate:fast under the wrapper, with the full gate on each release):
 * the PR branch rebased onto the base branch's current head. That proof holds
 * only while the base does not move, and two sessions merging into one repo
 * move it under each other. So a merge here is serialised per repo, refuses a
 * candidate that is behind its base, merges with `--match-head-commit`, and
 * reads the merged tree back.
 *
 *   node merge-lock.js merge --repo OWNER/NAME --pr N --head SHA --gate-receipt FILE
 *                            --review-receipt FILE [--escalation-receipt FILE]
 *                            [--wait-timeout-ms N]
 *   node merge-lock.js merge --repo OWNER/NAME --pr N --head SHA --fast-lane-receipt FILE
 *                            --review-receipt FILE [--escalation-receipt FILE]
 *                            [--wait-timeout-ms N]
 *   node merge-lock.js merge ... --review-override "<reason, 10+ characters>"
 *                            in place of --review-receipt
 *   node merge-lock.js status --repo OWNER/NAME
 *   node merge-lock.js --help
 *
 * EVERY merge needs a proof of the tree (a gate or fast-lane receipt) AND a
 * review of it (a review receipt, or a recorded override). A sensitive or
 * risk-class diff also needs an escalation receipt. All three are below.
 *
 * WHAT `merge` DOES, in order:
 *   1. Checks the gate receipt (below), then the review receipt or override.
 *      A missing or failing receipt refuses before any lock is taken.
 *   2. Takes the per-repo lock `<home>/.claude/autodev/locks/merge-<owner>__<name>.lock`
 *      through autodev-core's full-gate-queue.js: an atomic `wx` create, a
 *      first-come ticket queue beside it, and a dead holder's lock moved aside
 *      only on the queue's evidence. The lock's meta line names the holder's
 *      native pid with its creation time and boot, so a reused pid or a lock
 *      from an earlier boot reads correctly, and an answer no probe can give
 *      counts as alive. A lock with no meta line falls back to pid probes,
 *      where BOTH tasklist and ps must fail to find it on Windows, because an
 *      MSYS pid is invisible to tasklist while alive. Line 1 of the lock is
 *      this process's pid, line 2 says repo, PR, head and start time (UTC),
 *      and the last is the queue's meta line. A waiter prints who holds it and
 *      gives up after --wait-timeout-ms.
 *   3. `gh pr view`: refuses unless the PR is OPEN and its head is --head.
 *   4. Reads the base branch head, then `gh api repos/R/compare/<base>...<head>`:
 *      refuses unless behind_by is 0, so the candidate already contains the base.
 *   4b. Classifies GitHub's own file list with fast-lane.js's sensitive
 *      patterns (and the base's autodevFastLane.sensitive). A sensitive path,
 *      a file list that cannot be read, or a base config that cannot be read
 *      all count as sensitive, and then --escalation-receipt is required.
 *   4b2. Without an escalation receipt, or with an override, reads GitHub's own diff for this
 *      compare and runs cheap-review.js's riskClasses on it: a paid call, a
 *      cron, queue or job, a link token or signature, or over 1000 lines. Any
 *      class, or a diff GitHub refuses or that overflows the read, needs --escalation-receipt. A
 *      receipt's risk_classes field is never read, because a receipt is text.
 *   4c. With --review-override, appends one event to the deploy ledger (below).
 *      A ledger that cannot be written refuses the merge.
 *   5. `gh pr merge N --repo R --rebase --match-head-commit <head>`.
 *   6. Reads the PR back until it is MERGED, because gh can fail after GitHub
 *      accepted the merge, and compares the tree of the PR's merge commit with
 *      the tree of --head. A difference exits 1 loudly. The merge stands:
 *      nothing here undoes it. The base branch is read only to report a writer
 *      that moved it after this merge.
 *   7. Releases the lock in a finally block: to the next queued merger, else by
 *      rename to `.released-HHMM`.
 *
 * THE GATE RECEIPT. Neither tooling/gate-lock.js nor full-gate-queue.js writes
 * a machine-readable pass verdict keyed by commit: the lock records only who
 * ran and where, and is renamed on release. So no receipt format is invented
 * here. --gate-receipt is a captured log of the gate on that tree. Its last
 * closing line decides, and nothing after that line may start another run (a
 * `gate-lock:` or `gate-receipt:` line, or a sha). Two closing lines count:
 *   - `gate-lock: verdict PASS (exit 0)`, which this repo's tooling/gate-lock.js
 *     prints. The full --head sha must appear between it and the closing line
 *     before it. gate-lock prints `gate-lock: head <sha>` first and again just
 *     before its verdict, so the plain log is the receipt:
 *       npm run gate > receipt.log 2>&1
 *   - `gate-receipt: exit 0`, the wrapper any repo's gate can produce. The
 *     first sha in its run (everything since the `gate-receipt:` line before
 *     it) must be --head, and every gate-lock verdict inside that run must be
 *     PASS, since a red verdict under exit 0 means the exit came from a pipe.
 *     The gate command must be the last command before the echo, never piped:
 *       bash:  { git rev-parse HEAD; node scripts/gate.mjs; echo "gate-receipt: exit $?"; } > receipt.log 2>&1
 *       pwsh:  & { git rev-parse HEAD; node scripts/gate.mjs; "gate-receipt: exit $LASTEXITCODE" } *> receipt.log
 *     In PowerShell the gate must be a native command, which sets
 *     $LASTEXITCODE. Any other `gate-receipt:` line, an empty exit included,
 *     is red.
 * A receipt is text, so a hand-written one passes. It stops an honest mistake
 * (merging an ungated or red head), not a forgery.
 *
 * THE FAST-LANE RECEIPT, in place of --gate-receipt, is the JSON that
 * `fast-lane.js run` writes after lint, typecheck, test and build on a small
 * candidate. Before the lock it must name --head, say eligible, and record
 * every step at exit 0. With the lock held, after the behind_by check, it
 * must also name the tree GitHub holds for --head, and the classifier runs
 * again on GitHub's own base...head file list, with the autodevFastLane
 * config read from package.json at the base. Either disagreeing refuses: the
 * candidate takes the full gate. The receipt's `profile` picks the rule: a
 * "fast" receipt (or one with no profile, written before profiles) meets the
 * size and sensitive-path rule exactly as before. A "preview" receipt, which
 * records typecheck and build, meets the preview rule: every path in GitHub's
 * diff matches autodevFastLane.previewPaths at the base, none is sensitive,
 * and, when the base sets autodevFastLane.previewTest, a green test step ran
 * that script. A base with no or a malformed previewPaths refuses it.
 *
 * THE REVIEW RECEIPT, --review-receipt FILE, is the JSON that cheap-review.js
 * writes: {schema:1, repo, pr, head, reviewer, model, verdict, reason,
 * findings, acceptance, checked_clean, story, diff_lines, started_at, ms,
 * est_cost}. It is accepted only when schema is 1, repo, pr and head equal the
 * arguments exactly, and verdict is "approve". It is also refused when an
 * acceptance item says met:false or a finding is P0, because an approve that
 * carries either contradicts itself. An `escalate` receipt is accepted only
 * beside a valid --escalation-receipt for the same repo, PR and head, because
 * escalate hands the decision to opus and that receipt is opus's approval. A
 * `request_changes` receipt, an `escalate` receipt alone, a receipt for another
 * head, and a hand-written one that omits a field all refuse before any lock
 * is taken. A receipt is text, so a forged one passes: it stops merging an
 * unreviewed head by mistake, not a forgery.
 *
 * --review-override "<reason>" replaces the review receipt when review cannot
 * run (the reviewer is down, or a person read the diff). It does not clear a
 * sensitive path or a risk class, and a diff over 1000 lines is one. The reason must hold at least 10 characters after whitespace is
 * collapsed. It is written into the lock's meta line, where `status` shows it,
 * and appended to the deploy ledger as one event line, kind "review-override",
 * through deploy-ledger.js's appendEvent: `<config dir>/autodev/deploy-ledger-events.jsonl`,
 * or the file AUTODEV_DEPLOY_EVENTS names. It cannot be combined with
 * --review-receipt.
 *
 * SENSITIVE DIFFS. `--escalation-receipt FILE` is {schema:1, repo, pr, head,
 * reviewer:"code-reviewer", model, verdict:"approve"} where model contains
 * "opus": the code-reviewer agent's printed JSON, saved by its caller. It is
 * required when the diff is sensitive or in a risk class (step 4b2), and
 * checked whenever it is given. A review override does NOT waive it.
 *
 * EXIT. 0 merged and the merged tree matches the proved tree. 1 refused (bad
 * arguments, receipt, PR state, head or base mismatch, GitHub refused the
 * merge) or merged with a different tree. 2 indeterminate: gh could not be run
 * or did not answer, the lock wait timed out or was interrupted, or the PR did
 * not read MERGED within the readback window after gh succeeded or timed out.
 * Exit 2 means look before retrying.
 *
 * NOT CLOSED HERE. GitHub's merge is conditioned on the PR head only. A writer
 * that bypasses this lock (the web UI, a direct push, another machine) can
 * move the base between step 4 and step 5. The readback then reports the tree
 * GitHub produced; only branch protection that requires an up-to-date branch
 * closes that race on the server.
 *
 * gh is spawned with an args array and no shell. AUTODEV_GH_BIN names another
 * binary; a path ending .js, .cjs or .mjs is run with this node, because a .cmd
 * shim is not found without a shell.
 *
 * ENVIRONMENT.
 *   AUTODEV_GH_BIN=PATH                 the gh binary (default gh)
 *   AUTODEV_MERGE_LOCK_POLL_MS=N        a waiter's poll interval (default 3000)
 *   AUTODEV_MERGE_LOCK_READBACK_MS=N    how long to wait for the PR to read MERGED (default 60000)
 *   AUTODEV_DEPLOY_EVENTS=FILE          where a review override is appended (deploy-ledger.js's events file by default)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const queue = require(path.join(__dirname, 'full-gate-queue.js'));
const fastLane = require(path.join(__dirname, 'fast-lane.js'));
const cheapReview = require(path.join(__dirname, 'cheap-review.js'));

const TAG = 'merge-lock:';
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PASS_LINE = 'gate-lock: verdict PASS (exit 0)';
const VERDICT_RE = /gate-lock: verdict [A-Z]+ \(exit \d+\)/g;
// The wrapper's closing line. Any `gate-receipt:` line closes a run, so an
// empty or odd exit (an unset $LASTEXITCODE, a negative crash code) is red.
const EXIT_PASS = 'gate-receipt: exit 0';
const EXIT_RE = /^gate-receipt:[^\r\n]*/gm;
const SHA_ANY_RE = /\b[0-9a-f]{40}\b/i;
const WRAPPER_BASH = '{ git rev-parse HEAD; <gate command>; echo "gate-receipt: exit $?"; } > receipt.log 2>&1';
const WRAPPER_PWSH = '& { git rev-parse HEAD; <gate command>; "gate-receipt: exit $LASTEXITCODE" } *> receipt.log';
const STALE_MS = 600000;
const DEFAULT_TIMEOUT_MS = 1800000;
const MIN_OVERRIDE_CHARS = 10;
const MAX_OVERRIDE_CHARS = 300;

/** A refusal or an indeterminate stop, carried to main as one exit code. */
class Stop extends Error {
    constructor(exit, message) { super(message); this.exit = exit; }
}
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
const refuse = (msg) => new Stop(1, msg);
const unsure = (msg) => new Stop(2, msg);

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------

/** GitHub names are case-insensitive, so `Owner/Name` and `owner/name` share one lock. */
function lockPathFor(repo, home = os.homedir()) {
    const [owner, name] = repo.toLowerCase().split('/');
    return path.join(home, '.claude', 'autodev', 'locks', `merge-${owner}__${name}.lock`);
}

// ---------------------------------------------------------------------------
// The gate receipt.
// ---------------------------------------------------------------------------

/** Text of a receipt file. PowerShell's `>` writes UTF-16LE with a BOM. */
function readText(file) {
    const buf = fs.readFileSync(file);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
    return buf.toString('utf8');
}

/**
 * null when the receipt proves `head`, else why not. `full` also requires the
 * run that proves `head` to hold gate-lock's closing pair, `gate-lock: head
 * <head>` directly followed by its PASS verdict, which only the full gate
 * prints: a wrapped `gate:fast` run merges an autodev PR but cannot publish a
 * release (publish-release.js passes full).
 */
function receiptProblem(file, head, { full = false } = {}) {
    // Anchored, because a bare PASS could be lent by an earlier run in the log.
    const fullProblem = (run) => (new RegExp(`(?:^|\\n)gate-lock: head ${head}\\r?\\n${PASS_LINE.replace(/[()]/g, '\\$&')}`, 'i').test(run)
        ? null
        : `--gate-receipt ${file}: the run that proves ${head} has no "gate-lock: head ${head}" line directly before "${PASS_LINE}", `
            + 'so it is not the full gate. A gate:fast receipt merges a PR, and a release needs `npm run gate > gate.log 2>&1` on its candidate');
    if (!file) return `no --gate-receipt given. Capture the gate on this tree: ${WRAPPER_BASH}`;
    let text;
    try { text = readText(file); } catch (e) { return `cannot read --gate-receipt ${file} (${e.code || e.message})`; }
    const lower = text.toLowerCase();
    if (!lower.includes(head)) return `--gate-receipt ${file} does not name head ${head}`;
    const verdicts = [...text.matchAll(VERDICT_RE)].map((m) => ({ kind: 'verdict', index: m.index, raw: m[0], line: m[0] }));
    const exits = [...text.matchAll(EXIT_RE)].map((m) => ({ kind: 'exit', index: m.index, raw: m[0], line: m[0].trim() }));
    const marks = [...verdicts, ...exits].sort((a, b) => a.index - b.index);
    if (!marks.length) {
        return `--gate-receipt ${file} has no "gate-lock: verdict" line and no "gate-receipt:" line, so the gate did not finish in it`;
    }
    const last = marks[marks.length - 1];
    // A log can hold several runs. The last verdict or exit line counts only
    // for the run it ended, and no run may start after it.
    const tail = text.slice(last.index + last.raw.length);
    if (/gate-lock:|gate-receipt:/.test(tail) || SHA_ANY_RE.test(tail)) {
        return `--gate-receipt ${file} goes on after its last verdict: another run started there and did not finish`;
    }
    if (last.kind === 'verdict') {
        if (last.line !== PASS_LINE) return `--gate-receipt ${file} ends with "${last.line}", not "${PASS_LINE}"`;
        // The head must appear after the verdict or exit line before it.
        const prev = marks[marks.length - 2];
        const from = prev ? prev.index + prev.raw.length : 0;
        if (!lower.slice(from, last.index).includes(head)) {
            return `--gate-receipt ${file} names ${head} only outside the run that printed the last PASS, so that PASS proves another head`;
        }
        return full ? fullProblem(text.slice(from, last.index + last.raw.length)) : null;
    }
    // The wrapper format: the run is everything since the exit line before it.
    // A harness gate inside it prints its own verdict first, so that run
    // reaches back past the verdict to the head the wrapper wrote.
    if (last.line !== EXIT_PASS) return `--gate-receipt ${file} ends with "${last.line}", not "${EXIT_PASS}"`;
    const prevExit = exits.filter((m) => m.index < last.index).pop();
    const run = text.slice(prevExit ? prevExit.index + prevExit.raw.length : 0, last.index);
    const first = run.match(SHA_ANY_RE);
    if (!first || first[0].toLowerCase() !== head) {
        return `--gate-receipt ${file}: the run that printed the last "${EXIT_PASS}" starts with ${first ? first[0] : 'no sha'}, `
            + `not ${head}, so that exit proves another head. The wrapper writes the head first: ${WRAPPER_BASH}`;
    }
    const red = [...run.matchAll(VERDICT_RE)].find((m) => m[0] !== PASS_LINE);
    if (red) {
        return `--gate-receipt ${file}: the run that printed "${EXIT_PASS}" also printed "${red[0]}", `
            + 'so the exit is not the gate\'s. A pipe after the gate command reports the pipe\'s status';
    }
    return full ? fullProblem(run) : null;
}

// ---------------------------------------------------------------------------
// The review receipt, the review override and the escalation receipt.
// ---------------------------------------------------------------------------

/** { receipt } for a JSON object file, else { problem }. readText handles a BOM and UTF-16LE. */
function readJsonReceipt(file, flag) {
    let text;
    try { text = readText(file); } catch (e) { return { problem: `cannot read ${flag} ${file} (${e.code || e.message})` }; }
    let j;
    try { j = JSON.parse(text); } catch (e) { return { problem: `${flag} ${file} is not JSON (${e.message})` }; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { problem: `${flag} ${file} is not a JSON object` };
    return { receipt: j };
}

/** null when schema, repo, pr and head name the target exactly, else why not. */
function targetProblem(r, flag, file, { repo, pr, head }) {
    if (r.schema !== 1) return `${flag} ${file}: schema is ${JSON.stringify(r.schema)}, not 1`;
    if (r.repo !== repo) return `${flag} ${file} is for repo ${JSON.stringify(r.repo)}, not ${repo}`;
    // cheap-review.js writes the PR number; a digit string is the same number.
    if (!['number', 'string'].includes(typeof r.pr) || String(r.pr) !== String(pr)) {
        return `${flag} ${file} is for PR ${JSON.stringify(r.pr)}, not ${pr}`;
    }
    if (typeof r.head !== 'string' || r.head.toLowerCase() !== head) {
        return `${flag} ${file} reviewed head ${JSON.stringify(r.head)}, not ${head}. Review the PR's current head again`;
    }
    return null;
}

/**
 * null when the file is an approving review of exactly repo#pr at head, else
 * why not. Beyond the verdict it refuses an approve that carries an unmet
 * acceptance item or a P0 finding, which cheap-review.js turns into
 * "escalate", so such a receipt was edited or written by hand. An "escalate"
 * receipt passes only when escalationFile holds a valid opus approval of the
 * same target. Absent, it refuses.
 */
function reviewReceiptProblem(file, target, escalationFile = null) {
    const flag = '--review-receipt';
    if (!file) return `no --review-receipt given. Run cheap-review.js review --out FILE and pass that file, or pass --review-override "<reason>"`;
    const got = readJsonReceipt(file, flag);
    if (got.problem) return got.problem;
    const r = got.receipt;
    const wrong = targetProblem(r, flag, file, target);
    if (wrong) return wrong;
    if (r.verdict === 'escalate' && escalationFile) {
        // The findings that caused the escalation are what opus judged, so they are not re-read here.
        const opus = escalationReceiptProblem(escalationFile, target);
        return opus ? `${flag} ${file}: verdict is "escalate", not "approve", and the escalation does not settle it: ${opus}` : null;
    }
    if (r.verdict !== 'approve') {
        const why = typeof r.reason === 'string' && r.reason ? `: ${r.reason.slice(0, 160)}` : '';
        const next = r.verdict === 'escalate' ? '. Dispatch the code-reviewer agent on opus and pass the JSON it prints as --escalation-receipt' : '';
        return `${flag} ${file}: verdict is ${JSON.stringify(r.verdict)}, not "approve"${why}${next}`;
    }
    if (Array.isArray(r.acceptance) && r.acceptance.some((a) => !a || a.met !== true)) {
        return `${flag} ${file}: verdict is approve but an acceptance item is not met`;
    }
    if (Array.isArray(r.findings) && r.findings.some((f) => f && f.severity === 'P0')) {
        return `${flag} ${file}: verdict is approve but a finding is P0`;
    }
    return null;
}

/**
 * null when the file is the code-reviewer agent's approval of exactly repo#pr
 * at head by a model whose name contains "opus", else why not.
 */
function escalationReceiptProblem(file, target) {
    const flag = '--escalation-receipt';
    if (!file) return 'no --escalation-receipt given. Dispatch the code-reviewer agent on opus and save the JSON it prints';
    const got = readJsonReceipt(file, flag);
    if (got.problem) return got.problem;
    const r = got.receipt;
    const wrong = targetProblem(r, flag, file, target);
    if (wrong) return wrong;
    if (r.reviewer !== 'code-reviewer') return `${flag} ${file}: reviewer is ${JSON.stringify(r.reviewer)}, not "code-reviewer"`;
    if (r.verdict !== 'approve') return `${flag} ${file}: verdict is ${JSON.stringify(r.verdict)}, not "approve"`;
    if (typeof r.model !== 'string' || !/opus/i.test(r.model)) {
        return `${flag} ${file}: model is ${JSON.stringify(r.model)}, which does not contain "opus". Escalation is judged by opus`;
    }
    return null;
}

/** { reason } with whitespace collapsed, or { problem }, for --review-override. */
function normalizeOverride(raw) {
    const reason = String(raw === null || raw === undefined ? '' : raw).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
    if (reason.length < MIN_OVERRIDE_CHARS) {
        return { problem: `--review-override needs a reason of at least ${MIN_OVERRIDE_CHARS} characters saying why review could not run (got ${reason.length})` };
    }
    if (reason.length > MAX_OVERRIDE_CHARS) {
        return { problem: `--review-override reason is ${reason.length} characters; keep it under ${MAX_OVERRIDE_CHARS}` };
    }
    return { reason };
}

const SENSITIVE_REASON_RE = / matches the sensitive pattern /;

/**
 * Why this diff is sensitive, as a list; empty when it is not. Reuses
 * fast-lane.js's classifier with the size limit and the preview rule taken
 * out, so only its sensitive-path reasons remain, on GitHub's own file list
 * and the base's autodevFastLane.sensitive. What cannot be read counts as
 * sensitive: a failed read must not lower the bar.
 */
function sensitiveReasons(cmp, pkgText) {
    let config;
    try { config = fastLane.parseConfig(pkgText); } catch (e) {
        return [`the autodevFastLane config at the base is unreadable (${e.message})`];
    }
    const files = fastLane.filesFromCompare(cmp);
    if (!files) return ['GitHub gave no usable changed-file list (missing, or 300 files or more)'];
    const v = fastLane.classify(files, { ...config, maxLines: Number.MAX_SAFE_INTEGER, previewPaths: null, previewTest: null });
    return v.reasons.filter((r) => SENSITIVE_REASON_RE.test(r));
}

/**
 * The risk classes of the diff GitHub will merge, derived here and never read
 * from a receipt. A diff GitHub refuses as too large, one that overflows the
 * read, or an answer that is not a diff counts as a class: a failed read must
 * not lower the bar. Any other gh failure is an outage, so it is indeterminate
 * and names the cause. An empty diff is clean only when GitHub lists no files.
 */
function riskClassesOnGitHub(repo, baseSha, head, cmp, env) {
    const r = runGh(['api', `repos/${repo}/compare/${baseSha}...${head}`, '-H', 'Accept: application/vnd.github.v3.diff'], env);
    if (!r.ok) {
        if (r.error === 'ENOBUFS' || /HTTP 406/.test(r.stderr)) return [{ class: 'diff-unreadable', file: r.error || 'GitHub refused the diff as too large' }];
        throw unsure(`reading the diff of ${baseSha.slice(0, 12)}...${head.slice(0, 12)}: ${r.error || r.stderr.split('\n')[0] || `gh exited ${r.status}`}`);
    }
    if (!r.stdout.trim() && Array.isArray(cmp.files) && cmp.files.length === 0) return [];
    if (!/^diff --git /m.test(r.stdout)) return [{ class: 'diff-unreadable', file: 'GitHub answered with no diff' }];
    return cheapReview.riskClasses(r.stdout);
}

/**
 * Appends one event through deploy-ledger.js, which takes the ledger lock and
 * stamps schema and time. Returns the file; throws when it cannot write, so an
 * unrecorded override never merges.
 */
function appendDeployEvent(event, env = process.env) {
    const r = require(path.join(__dirname, 'deploy-ledger.js')).appendEvent(event, { env });
    if (!r.ok) throw Object.assign(new Error(r.why), { code: r.why });
    return r.file;
}

// ---------------------------------------------------------------------------
// gh.
// ---------------------------------------------------------------------------

function ghCommand(env) {
    const bin = env.AUTODEV_GH_BIN || 'gh';
    return /\.(c|m)?js$/i.test(bin) ? { file: process.execPath, pre: [bin] } : { file: bin, pre: [] };
}

/** Runs gh; { ok, status, stdout, stderr, error }. Never throws. */
function runGh(args, env = process.env) {
    const { file, pre } = ghCommand(env);
    const r = spawnSync(file, [...pre, ...args], {
        encoding: 'utf8', windowsHide: true, timeout: 120000, env, maxBuffer: 32 * 1024 * 1024,
    });
    return {
        ok: !r.error && r.status === 0,
        status: r.status,
        stdout: r.stdout || '',
        stderr: (r.stderr || '').trim(),
        error: r.error ? (r.error.code || r.error.message) : null,
    };
}

/** gh output as JSON, or an indeterminate stop naming what failed. */
function ghJson(args, what, env) {
    const r = runGh(args, env);
    if (!r.ok) {
        const why = r.error ? `could not run gh (${r.error})` : `gh exited ${r.status}: ${r.stderr.split(/\r?\n/)[0] || '(no stderr)'}`;
        throw unsure(`${what}: ${why}`);
    }
    try { return JSON.parse(r.stdout); } catch {
        throw unsure(`${what}: gh did not return JSON`);
    }
}

/** { sha, tree } of a branch's head. */
function branchHead(repo, branch, env) {
    const j = ghJson(['api', `repos/${repo}/branches/${branch}`], `reading ${repo} branch ${branch}`, env);
    const sha = j && j.commit && j.commit.sha;
    const tree = j && j.commit && j.commit.commit && j.commit.commit.tree && j.commit.commit.tree.sha;
    if (!SHA_RE.test(String(sha)) || !SHA_RE.test(String(tree))) throw unsure(`reading ${repo} branch ${branch}: no commit sha and tree in the answer`);
    return { sha, tree };
}

/** { state, oid }: the PR's state and, once merged, its merge commit. */
function prMergeState(repo, pr, env) {
    const j = ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,mergeCommit'], `reading ${repo}#${pr} after the merge`, env);
    const oid = j && j.mergeCommit && String(j.mergeCommit.oid || '').toLowerCase();
    if (j && j.state === 'MERGED' && !SHA_RE.test(oid)) return { state: 'MERGED without a merge commit yet', oid: null };
    return { state: String(j && j.state), oid: oid || null };
}

function commitTree(repo, sha, env) {
    const j = ghJson(['api', `repos/${repo}/commits/${sha}`], `reading ${repo} commit ${sha}`, env);
    const tree = j && j.commit && j.commit.tree && j.commit.tree.sha;
    if (!SHA_RE.test(String(tree))) throw unsure(`reading ${repo} commit ${sha}: no tree in the answer`);
    return tree;
}

// ---------------------------------------------------------------------------
// The lock.
// ---------------------------------------------------------------------------

function holderLine(h) {
    if (!h) return '(no lock)';
    return `${h.pid === null ? 'an unreadable pid' : `pid ${h.pid}`}: ${h.what}`;
}

/**
 * Waits for the repo's lock, first come first served. Resolves true once held,
 * false on timeout or a stop signal. Every poll refreshes this process's ticket.
 */
/**
 * Leaves the queue, and releases the lock if a holder handed it over in the
 * moment between this process's last poll and its leaving. Without this a
 * timed-out or stopped waiter would leave a lock naming itself.
 */
function leave(lockPath, log, q = queue) {
    q.leaveQueues([lockPath], process.pid);
    try {
        q.resetProbes();
        const r = q.releaseLock({ lockPath, pid: process.pid, staleMs: STALE_MS, log });
        if (r.released) log(`${TAG} the lock was handed over while leaving; released it`);
    } catch { /* a lock naming a dead pid is reclaimed by the next waiter */ }
}

async function acquire({ lockPath, what, timeoutMs, pollMs, log, isStopped, q = queue }) {
    const pid = process.pid;
    const body = `${pid}\n${what}\n`;
    const started = Date.now();
    let lastKey = null;
    let errors = 0;
    for (;;) {
        if (isStopped()) { leave(lockPath, log, q); return false; }
        let r;
        try {
            q.resetProbes();
            r = q.takeTurn({ lockPath, pid, what, body, staleMs: STALE_MS, log });
            errors = 0;
        } catch (e) {
            // Windows refuses a read while another process renames the file.
            errors++;
            log(`${TAG} lock poll failed (${e.code || e.message}), attempt ${errors} of 10`);
            if (errors >= 10) { leave(lockPath, log, q); throw unsure(`could not poll ${lockPath}`); }
            await sleep(pollMs);
            continue;
        }
        if (r.acquired) return true;
        const key = `${r.position}/${r.of}/${r.holder ? r.holder.text : ''}`;
        if (key !== lastKey) {
            log(`${TAG} waiting for ${path.basename(lockPath)}: place ${r.position} of ${r.of}. Held by ${holderLine(r.holder)}`);
            lastKey = key;
        }
        if (Date.now() - started >= timeoutMs) { leave(lockPath, log, q); return false; }
        await sleep(pollMs);
    }
}

/**
 * The stop-signal handler for one run. A waiter leaves its ticket and exits 2.
 * A holder only records the signal: the merge in flight finishes and the
 * finally block releases the lock, because a lock dropped mid-merge would let
 * the next merger read a base that is about to move.
 */
function signalHandler({ lockPath, state, exit = (code) => process.exit(code), err = (line) => console.error(line) }) {
    return (sig) => {
        state.stopped = sig;
        if (state.held) return;
        try { leave(lockPath, err); } catch { /* the heartbeat expires it */ }
        err(`${TAG} INDETERMINATE: stopped by ${sig} while waiting; lock NOT taken`);
        exit(2);
    };
}

function release(lockPath, log) {
    try {
        queue.leaveQueues([lockPath], process.pid);
        queue.resetProbes();
        const r = queue.releaseLock({ lockPath, pid: process.pid, staleMs: STALE_MS, log });
        if (r.released && r.to) log(`${TAG} lock handed to queued pid ${r.to.pid}`);
        else if (r.released) log(`${TAG} lock released to ${path.basename(r.aside)}`);
        else log(`${TAG} lock not released: ${r.why}`);
    } catch (e) {
        log(`${TAG} could not release ${lockPath} (${e.code || e.message}); move it aside by hand if pid ${process.pid} is gone`);
    }
}

// ---------------------------------------------------------------------------
// The merge, run while the lock is held.
// ---------------------------------------------------------------------------

/** package.json text at a commit through the contents API, null when there is none. */
function pkgAtRemote(repo, sha, env) {
    const r = runGh(['api', `repos/${repo}/contents/package.json?ref=${sha}`], env);
    if (!r.ok && /HTTP 404|Not Found/i.test(r.stderr)) return null;
    if (!r.ok) throw unsure(`reading package.json at ${sha}: ${r.error ? `could not run gh (${r.error})` : `gh exited ${r.status}`}`);
    try {
        const j = JSON.parse(r.stdout);
        if (j.encoding !== 'base64' || typeof j.content !== 'string') throw new Error('no base64 content');
        return Buffer.from(j.content, 'base64').toString('utf8');
    } catch (e) {
        throw unsure(`reading package.json at ${sha}: ${e.message}`);
    }
}

/**
 * The fast lane, judged on what GitHub will merge: the receipt's tree is the
 * head's tree, and the classifier says eligible for GitHub's own diff.
 */
function checkFastLane({ repo, baseRef, base, head, cmp, provedTree, receipt, pkgText, log }) {
    if (String(receipt.tree).toLowerCase() !== provedTree) {
        throw refuse(`the fast-lane receipt proves tree ${receipt.tree}, but ${head} has tree ${provedTree} on GitHub`);
    }
    let config;
    try { config = fastLane.parseConfig(pkgText); } catch (e) {
        throw refuse(`the autodevFastLane config at ${baseRef} ${base.sha} is unreadable (${e.message}); run the full gate`);
    }
    const { verdict: v, problem } = fastLane.profileProblem(receipt, fastLane.filesFromCompare(cmp), config);
    if (problem) {
        throw refuse(`${baseRef}...${head} on GitHub's diff, with the config at ${baseRef} ${base.sha.slice(0, 12)}: ${problem}. Run the full gate`);
    }
    if (receipt.profile === 'preview') {
        log(`${TAG} preview profile: ${v.changedLines} changed lines in ${v.files} file(s) against ${baseRef}, every path inside autodevFastLane.previewPaths; `
            + `steps green on tree ${provedTree.slice(0, 12)}`);
        return;
    }
    log(`${TAG} fast lane: ${v.changedLines} changed lines in ${v.files} file(s) against ${baseRef}, limit ${v.maxLines}; `
        + `steps green on tree ${provedTree.slice(0, 12)}`);
}

async function mergeHeld({ repo, pr, head, env, log, readbackMs, pollMs, fastReceipt = null, override = null, escalation = false }) {
    const view = ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,baseRefName,state'],
        `reading ${repo}#${pr}`, env);
    if (view.state !== 'OPEN') throw refuse(`${repo}#${pr} is ${view.state}, not OPEN`);
    if (String(view.headRefOid).toLowerCase() !== head) {
        throw refuse(`${repo}#${pr} head is ${view.headRefOid}, not the proved head ${head}. Gate the PR's current head, or push the proved one`);
    }
    const baseRef = view.baseRefName;
    if (!baseRef || typeof baseRef !== 'string') throw unsure(`${repo}#${pr} has no base branch in the answer`);

    const base = branchHead(repo, baseRef, env);
    const cmp = ghJson(['api', `repos/${repo}/compare/${base.sha}...${head}`], `comparing ${baseRef} with ${head}`, env);
    if (typeof cmp.behind_by !== 'number') throw unsure(`comparing ${baseRef} with ${head}: no behind_by in the answer`);
    if (cmp.behind_by !== 0) {
        throw refuse(`${head} is ${cmp.behind_by} commit(s) behind ${baseRef} at ${base.sha}. Rebase onto origin/${baseRef} and gate that tree again`);
    }
    const provedTree = commitTree(repo, head, env);
    // package.json at the base is read once: the fast lane and the sensitive
    // classifier both take their config from it.
    const pkgText = pkgAtRemote(repo, base.sha, env);
    if (fastReceipt) checkFastLane({ repo, baseRef, base, head, cmp, provedTree, receipt: fastReceipt, pkgText, log });
    const sensitive = sensitiveReasons(cmp, pkgText);
    if (sensitive.length && !escalation) {
        throw refuse(`${repo}#${pr} is a sensitive diff (${sensitive.slice(0, 4).join('; ')}${sensitive.length > 4 ? `; and ${sensitive.length - 4} more` : ''}), `
            + 'and needs --escalation-receipt FILE: dispatch the code-reviewer agent on opus and save the JSON it prints. A review override does not waive it');
    }
    if (sensitive.length) log(`${TAG} sensitive diff (${sensitive.length} reason(s)); the escalation receipt is on file`);
    const risks = !escalation || override ? riskClassesOnGitHub(repo, base.sha, head, cmp, env) : [];
    if (risks.length && !escalation) {
        const named = risks.slice(0, 4).map((x) => (x.file ? `${x.class} (${x.file})` : x.class)).join('; ');
        throw refuse(`${repo}#${pr} is in a risk class (${named}${risks.length > 4 ? `; and ${risks.length - 4} more` : ''}), `
            + 'and needs --escalation-receipt FILE: dispatch the code-reviewer agent on opus and save the JSON it prints. A review override does not waive it');
    }
    if (override) {
        let file;
        try {
            file = appendDeployEvent({ kind: 'review-override', repo, pr, head, reason: override, sensitive: sensitive.length > 0, risk_classes: [...new Set(risks.map((x) => x.class))] }, env);
        } catch (e) {
            throw refuse(`could not record the review override in the deploy ledger (${e.code || e.message}); an unrecorded override does not merge`);
        }
        log(`${TAG} REVIEW OVERRIDE recorded in ${file}: ${override}`);
    }
    log(`${TAG} ${repo}#${pr}: head ${head} contains ${baseRef} at ${base.sha.slice(0, 7)}; merging`);

    const m = runGh(['pr', 'merge', String(pr), '--repo', repo, '--rebase', '--match-head-commit', head], env);

    // Judge THIS PR, never the branch: another writer can move the base at any
    // moment, and gh can fail after GitHub accepted the request (a timeout, a
    // dropped connection). So the PR's own state says whether the merge landed,
    // and its merge commit's tree is compared. gh failing to run or timing out
    // gets the whole readback window; a gh that answered with an error gets a
    // short grace, then counts as GitHub's refusal.
    const waitMs = m.ok || m.error ? readbackMs : Math.min(readbackMs, 3 * pollMs);
    const deadline = Date.now() + waitMs;
    let after = prMergeState(repo, pr, env);
    while (after.state !== 'MERGED' && Date.now() < deadline) {
        await sleep(Math.min(pollMs, 2000));
        after = prMergeState(repo, pr, env);
    }
    if (after.state !== 'MERGED') {
        const secs = `${Math.round(waitMs / 1000)} s`;
        if (m.error) throw unsure(`gh pr merge did not complete (${m.error}) and ${repo}#${pr} is ${after.state} after ${secs}; read it before retrying`);
        if (!m.ok) throw refuse(`GitHub refused the merge (gh exited ${m.status}): ${m.stderr.split(/\r?\n/)[0] || '(no stderr)'}; ${repo}#${pr} is ${after.state}`);
        throw unsure(`gh pr merge exited 0 but ${repo}#${pr} is ${after.state} after ${secs}; read it before retrying`);
    }
    if (!m.ok) log(`${TAG} gh pr merge ${m.error ? `failed (${m.error})` : `exited ${m.status}`}, but ${repo}#${pr} is MERGED; judging its merge commit`);
    const mergedTree = commitTree(repo, after.oid, env);
    if (mergedTree !== provedTree) {
        throw refuse(`MERGED TREE DIFFERS FROM THE PROVED TREE. ${repo}#${pr} merged as ${after.oid} with tree ${mergedTree}; `
            + `the gated head ${head} has tree ${provedTree}. The merge stands and nothing undoes it: `
            + `gate ${baseRef} at ${after.oid} now`);
    }
    const now = branchHead(repo, baseRef, env);
    const since = now.sha === after.oid ? '' : `; ${baseRef} has since moved to ${now.sha}, past this merge`;
    log(`${TAG} merged ${repo}#${pr} as ${after.oid}: tree ${mergedTree.slice(0, 12)} matches the proved tree${since}`);
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const out = {
        cmd: null, repo: null, pr: null, head: null, receipt: null, fastLane: null, timeoutMs: null,
        reviewReceipt: null, reviewOverride: null, escalation: null, help: false, bad: null,
    };
    const takes = {
        '--repo': 'repo', '--pr': 'pr', '--head': 'head', '--gate-receipt': 'receipt',
        '--fast-lane-receipt': 'fastLane', '--wait-timeout-ms': 'timeoutMs',
        '--review-receipt': 'reviewReceipt', '--review-override': 'reviewOverride', '--escalation-receipt': 'escalation',
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { out.help = true; continue; }
        if (takes[a]) {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) { out.bad = `${a} needs a value`; break; }
            out[takes[a]] = v;
            i++;
            continue;
        }
        if (!out.cmd && !a.startsWith('-')) { out.cmd = a; continue; }
        out.bad = `unknown argument ${a}`;
        break;
    }
    return out;
}

function help() {
    console.log('usage: node merge-lock.js merge --repo OWNER/NAME --pr N --head SHA --gate-receipt FILE --review-receipt FILE');
    console.log('                                  [--escalation-receipt FILE] [--wait-timeout-ms N]');
    console.log('       node merge-lock.js merge --repo OWNER/NAME --pr N --head SHA --fast-lane-receipt FILE --review-receipt FILE');
    console.log('                                  [--escalation-receipt FILE] [--wait-timeout-ms N]');
    console.log('       node merge-lock.js merge ... --review-override "<reason>"   (in place of --review-receipt)');
    console.log('       node merge-lock.js status --repo OWNER/NAME');
    console.log('');
    console.log('Merges one PR under a per-repo lock (<home>/.claude/autodev/locks/merge-<owner>__<name>.lock),');
    console.log('first come first served. Refuses unless the PR head is --head, --head is not behind its base,');
    console.log('and the last run in the receipt names --head and ends with "gate-lock: verdict PASS (exit 0)"');
    console.log('or "gate-receipt: exit 0". Merges with gh pr merge --rebase --match-head-commit, then reads the');
    console.log('merged tree back.');
    console.log('');
    console.log('A receipt from any repo\'s gate (the gate command last, never piped):');
    console.log(`  bash: ${WRAPPER_BASH}`);
    console.log(`  pwsh: ${WRAPPER_PWSH}`);
    console.log('A small candidate can pass --fast-lane-receipt instead, the JSON that fast-lane.js run writes. It');
    console.log('must name --head and its tree on GitHub, record lint, typecheck, test and build at exit 0, and');
    console.log('GitHub\'s own diff must classify eligible too. A receipt with profile "preview" records typecheck');
    console.log('and build (and test, when the base sets autodevFastLane.previewTest) and needs every path of');
    console.log('GitHub\'s diff inside autodevFastLane.previewPaths, read from package.json at the base, with no');
    console.log('sensitive path. No previewPaths at the base refuses it.');
    console.log('');
    console.log('Every merge also needs a review: --review-receipt FILE, the JSON cheap-review.js writes, with schema 1,');
    console.log('this repo, PR and head exactly, and verdict "approve", or verdict "escalate" beside a valid');
    console.log('--escalation-receipt for the same repo, PR and head. --review-override "<reason>" (10+ characters)');
    console.log('replaces it when review cannot run; the reason goes into the lock meta line and one line appended to');
    console.log('the deploy ledger events file, and it cannot be combined with --review-receipt.');
    console.log('A sensitive diff (fast-lane.js sensitive patterns on GitHub\'s file list, or a list or config that');
    console.log('cannot be read) also needs --escalation-receipt FILE: {schema:1, repo, pr, head, reviewer:"code-reviewer",');
    console.log('model containing "opus", verdict:"approve"}, which the code-reviewer agent prints. An override does not');
    console.log('waive it. The same holds for a diff in a risk class, which merge-lock derives from GitHub\'s own diff with');
    console.log('cheap-review.js (paid call, job, link token, over 1000 lines, or a diff it cannot read). It never reads a receipt\'s risk_classes.');
    console.log('Exit 0 merged with the proved tree, 1 refused or a different tree, 2 indeterminate.');
    console.log('env: AUTODEV_GH_BIN (default gh), AUTODEV_MERGE_LOCK_POLL_MS, AUTODEV_MERGE_LOCK_READBACK_MS, AUTODEV_DEPLOY_EVENTS');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { help(); return; }
    const log = (line) => console.log(line);
    const env = process.env;
    const fail = (exit, msg) => { console.error(`${TAG} ${exit === 2 ? 'INDETERMINATE' : 'REFUSED'}: ${msg}`); process.exitCode = exit; };

    if (args.bad) return fail(1, `${args.bad}; see --help`);
    if (!['merge', 'status'].includes(args.cmd)) return fail(1, `${args.cmd ? `unknown command ${args.cmd}` : 'no command given'}; see --help`);
    if (!REPO_RE.test(String(args.repo))) return fail(1, '--repo must be OWNER/NAME');
    const lockPath = lockPathFor(args.repo);

    if (args.cmd === 'status') {
        const s = queue.readStatus(lockPath, STALE_MS);
        log(`${TAG} ${lockPath}: ${s.holder ? holderLine(s.holder) : 'free'}; ${s.queue.length} queued`);
        for (const t of s.queue) log(`${TAG}   queued pid ${t.pid} since ${t.arrived}: ${t.what}`);
        return;
    }

    const pr = Number(args.pr);
    if (!Number.isInteger(pr) || pr <= 0) return fail(1, '--pr must be a PR number');
    const head = String(args.head || '').toLowerCase();
    if (!SHA_RE.test(head)) return fail(1, '--head must be the full 40-character commit sha');
    const timeoutMs = args.timeoutMs === null ? DEFAULT_TIMEOUT_MS : Number(args.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return fail(1, '--wait-timeout-ms must be a number of milliseconds');
    if (args.receipt && args.fastLane) return fail(1, 'pass --gate-receipt or --fast-lane-receipt, not both');
    if (args.reviewReceipt && args.reviewOverride !== null) return fail(1, 'pass --review-receipt or --review-override, not both');
    let fastReceipt = null;
    if (args.fastLane) {
        const f = fastLane.receiptProblem(args.fastLane, head);
        if (f.problem) return fail(1, f.problem);
        fastReceipt = f.receipt;
    } else {
        const why = receiptProblem(args.receipt, head);
        if (why) return fail(1, why);
    }
    const target = { repo: args.repo, pr, head };
    let override = null;
    if (args.reviewOverride !== null) {
        const o = normalizeOverride(args.reviewOverride);
        if (o.problem) return fail(1, o.problem);
        override = o.reason;
    } else {
        const why = reviewReceiptProblem(args.reviewReceipt, target, args.escalation);
        if (why) return fail(1, why);
    }
    if (args.escalation !== null) {
        const why = escalationReceiptProblem(args.escalation, target);
        if (why) return fail(1, why);
    }

    const pollMs = Math.max(50, Number(env.AUTODEV_MERGE_LOCK_POLL_MS) || 3000);
    const readbackMs = Math.max(0, Number(env.AUTODEV_MERGE_LOCK_READBACK_MS) || 60000);
    const state = { stopped: null, held: false };
    const onSignal = signalHandler({ lockPath, state });
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => onSignal(s));

    const what = `merge-lock.js merge ${args.repo}#${pr} head ${head}, started ${new Date().toISOString().slice(0, 19)}Z`
        + (override ? `, REVIEW OVERRIDE "${override}"` : '');
    try {
        const got = await acquire({ lockPath, what, timeoutMs, pollMs, log, isStopped: () => Boolean(state.stopped) });
        if (!got) return fail(2, `lock ${path.basename(lockPath)} not taken within ${timeoutMs} ms; nothing was merged`);
        state.held = true;
        log(`${TAG} lock taken: ${lockPath} (pid ${process.pid})`);
        await mergeHeld({ repo: args.repo, pr, head, env, log, readbackMs, pollMs, fastReceipt, override, escalation: args.escalation !== null });
    } catch (e) {
        if (e instanceof Stop) return fail(e.exit, e.message);
        return fail(2, `internal error (${e && e.message}); read ${args.repo}#${pr} before retrying`);
    } finally {
        if (state.held) release(lockPath, log);
    }
}

module.exports = {
    lockPathFor, receiptProblem, reviewReceiptProblem, escalationReceiptProblem, normalizeOverride, sensitiveReasons,
    appendDeployEvent, readText, parseArgs, ghCommand, signalHandler, acquire, PASS_LINE, EXIT_PASS,
};

if (require.main === module) {
    main().catch((e) => {
        console.error(`${TAG} INDETERMINATE: ${e && e.stack ? e.stack : e}`);
        process.exitCode = 2;
    });
}
