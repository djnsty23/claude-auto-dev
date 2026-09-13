#!/usr/bin/env node
'use strict';
// usage-checkpoint.js — Stop hook. Makes a live session's work resumable BEFORE
// a usage limit kills it, because after the limit the session cannot run and
// nothing it would do for itself is available. The threshold moment is the
// whole opportunity.
//
// WHY, MEASURED. `[measured 2026-09-08]` a session-limit stop killed part of a
// 39-session fleet overnight. The hand rescue the next morning recovered 25
// bundles, 5 working diffs and 3 worktrees' untracked files across 17 worktrees
// carrying at-risk work; one worktree held 5 modified and 6 untracked files
// 9.3 HOURS old. `git bundle` does not carry uncommitted work, so a bundle-only
// rescue loses the working tree — that has now cost this fleet twice. And a
// session that dies does not know it died: it leaves no "I was doing X, next is
// Y", so reconstructing intent was manual, across 39 sessions, by hand.
//
// WHAT IT DOES when it fires: stages every at-risk path (tracked-modified and
// untracked-not-ignored), commits, pushes the branch, writes the fleet-intent
// record with state "checkpointed", and says so in the transcript.
//
// ── HOW THE USAGE IS READ, AND WHAT IS NOT READABLE ────────────────────────
//
// The percentage and reset time the app shows are NOT readable from inside a
// session. `[measured 2026-09-08]` no transcript row under ~/.claude/projects
// carries a rate-limit, quota, reset or overage key; no environment variable
// exposes one; and every appearance of the figure in this fleet's history is an
// operator relaying a SCREENSHOT ("Approaching weekly usage limit — Resets Wed,
// Sep 2, 2:00 AM"). A threshold on an unreadable number is a hook that never
// fires, which is worse than none because it looks installed.
//
// What IS readable is CONSUMPTION: scripts/quota-burn.js computes the
// list-price-equivalent dollars spent in the current weekly window from the same
// transcripts. It is spawned, never reimplemented — a second implementation that
// disagreed with the first would be worse than none (quota-tripwire.js says the
// same, for the same reason). The missing half is the CEILING, which
// quota-tripwire derives from operator-supplied `--calibrate` points and which
// no stranger's machine has. So the usage fraction is available only when the
// operator supplies a ceiling, and it is wired here as ONE explicit seam,
// $AUTODEV_CHECKPOINT_CEILING, rather than read out of another tool's state
// file — where a runtime-derived value is stored as null and reading it would
// silently mean "no ceiling" while that tool prints a number.
//
// ── WHY THE FALLBACK IS NOT A COMPROMISE ───────────────────────────────────
//
// `[measured 2026-09-08, this repo, this machine]` a full checkpoint costs
// 5.44s wall clock — add 0.085s, commit 0.243s, push 5.112s — and ZERO model
// tokens, because git runs as a subprocess. Its only budget cost is the ~150
// tokens of transcript this hook emits when it speaks. Priced with
// quota-burn.js's own table that is ~$0.008 amortised over a long session,
// against a MEASURED $0.237 per assistant turn in the live window
// ($3,103.84 over 13,076 usage rows) and a calibrated weekly ceiling of $4,608.
//
// So a checkpoint costs ~3% of ONE turn and ~0.0002% of a WEEK. At that price
// the scarce thing is not budget, it is knowing when to fire — and gating a
// free action behind a number that is not readable is the wrong trade. The
// default trigger is therefore EXPOSURE, not budget: fire when at-risk work has
// existed for longer than the age threshold. That would have saved all 17
// worktrees above, including the 9.3-hour files, regardless of where the week's
// quota stood. The usage fraction, when a ceiling IS configured, is an
// ESCALATION on top: past it, checkpoint immediately.
//
// Every firing names WHICH signal fired it, so the operator is never left
// guessing whether a real usage reading or a proxy triggered a checkpoint.
//
// ── SAFETY: THIS SHIPS INSTALLED ───────────────────────────────────────────
//
// A hook that throws kills a stranger's turn and they cannot patch it until
// they reinstall, so the whole body is wrapped and EVERY path exits 0. It emits
// `systemMessage` and `additionalContext` and no `decision`, so it cannot fight
// stop-auto-check's approve/block. Silence is ZERO BYTES on stdout AND stderr.
//
// It NEVER checkpoints a default branch (main/master, or the remote's HEAD) and
// never a detached HEAD: a checkpoint commit on the trunk is not a rescue, and
// those are the refs that deploy on push. It stages ENUMERATED paths rather
// than `git add -A`, because two sessions sharing one checkout share an index
// and `-A` sweeps the other one's in-flight work into this commit.
//
// Config, all optional:
//   AUTODEV_CHECKPOINT=off            disable entirely
//   AUTODEV_CHECKPOINT_PUSH=off       commit locally, never push
//   AUTODEV_CHECKPOINT_AGE_MINUTES    exposure threshold, default 45
//   AUTODEV_CHECKPOINT_MIN_INTERVAL   minutes between checkpoints, default 20
//   AUTODEV_CHECKPOINT_CEILING        weekly ceiling in list-price-equivalent $
//   AUTODEV_CHECKPOINT_FRACTION       escalate past this fraction, default 0.85
//   AUTODEV_CHECKPOINT_PROBE_MINUTES  minutes between quota probes, default 10
//   AUTODEV_CHECKPOINT_EMAIL/_NAME    git identity for the checkpoint commit
//   AUTODEV_CHECKPOINT_STATE          ledger path
//   AUTODEV_FLEET_INTENT_DIR          intent-record directory
//   AUTODEV_QUOTA_BURN                path to quota-burn.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AGE_MINUTES_DEFAULT = 45;
const MIN_INTERVAL_DEFAULT = 20;
const FRACTION_DEFAULT = 0.85;
const PROBE_MINUTES_DEFAULT = 10;
const LEDGER_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const GIT_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 60_000;
const QUOTA_TIMEOUT_MS = 15_000;
// Above this many at-risk paths the tree is almost certainly a build directory
// rather than work, and committing it would be a 5000-file wip commit. It still
// SPEAKS rather than vanishing: silence here would be indistinguishable from a
// hook with nothing to save, which is the one thing this must never look like.
const MAX_FILES = 5000;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage-checkpoint.js — Stop hook.\n'
        + 'Commits, pushes and records a session\'s work while it is still alive, so a\n'
        + 'usage-limit stop cannot take the working tree with it.\n'
        + 'Trigger:  at-risk work older than $AUTODEV_CHECKPOINT_AGE_MINUTES (default '
        + AGE_MINUTES_DEFAULT + '),\n'
        + '          escalated by $AUTODEV_CHECKPOINT_CEILING x $AUTODEV_CHECKPOINT_FRACTION\n'
        + '          when a ceiling is configured. The app\'s usage % is not readable\n'
        + '          from inside a session; see the header for what was measured.\n'
        + 'Refuses:  a default branch, a detached HEAD, a non-repo, a clean tree.\n'
        + 'Record:   ~/claude-memory/fleet-intent/<repo>--<branch>.json, state checkpointed.\n'
        + 'Disable:  AUTODEV_CHECKPOINT=off. Local only: AUTODEV_CHECKPOINT_PUSH=off.\n'
        + 'Never blocks a turn; every path exits 0; silence is zero bytes.');
    process.exit(0);
}

/** Nothing to say. Zero bytes on both streams. */
function silent() {
    process.exit(0);
}

/**
 * The only thing that ever writes to stdout. No `decision` field, ever: a Stop
 * hook that returned one would fight stop-auto-check's approve/block, and the
 * thing this has to say is never worth holding a turn for.
 *
 * process.exitCode rather than process.exit(): on darwin a write to a PIPE is
 * asynchronous and process.exit() does not drain it, so exiting here would
 * truncate on the one platform this fleet runs on.
 */
function say(forOperator, forModel) {
    process.stdout.write(JSON.stringify({
        systemMessage: forOperator,
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: forModel },
    }) + '\n');
    process.exitCode = 0;
    return true;
}

function isOff(raw) {
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

function positiveNumber(raw, fallback) {
    const n = Number(String(raw == null ? '' : raw).trim());
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readPayload() {
    try {
        if (process.stdin.isTTY) return null;
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return null;
    }
}

function readJson(p) {
    try {
        const v = JSON.parse(fs.readFileSync(p, 'utf8'));
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

function ledgerPath() {
    return process.env.AUTODEV_CHECKPOINT_STATE
        || path.join(os.homedir(), '.claude', 'checkpoint-state.json');
}

function intentDir() {
    return process.env.AUTODEV_FLEET_INTENT_DIR
        || path.join(os.homedir(), 'claude-memory', 'fleet-intent');
}

/**
 * Run git. Returns { ok, out, err }. Never throws: a git that is missing,
 * slow, or angry must cost a silent turn and nothing else.
 */
function git(args, cwd, timeout, stdin) {
    try {
        const r = spawnSync('git', args, {
            cwd,
            encoding: 'utf8',
            windowsHide: true,
            timeout: timeout || GIT_TIMEOUT_MS,
            input: stdin === undefined ? undefined : stdin,
            maxBuffer: 32 * 1024 * 1024,
        });
        if (r.error || r.status === null) return { ok: false, out: '', err: String((r.error && r.error.message) || 'git did not finish') };
        return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || '') };
    } catch (e) {
        return { ok: false, out: '', err: String((e && e.message) || e) };
    }
}

/**
 * Repo identity for the record's KEY. `repo` is the basename of the directory
 * holding the shared .git, not of the worktree: a worktree at
 * <repo>/.claude/worktrees/foo must key as <repo>, and keying by cwd is the
 * failure the contract exists to prevent — a worktree outlives the session in
 * it, so an answer keyed by directory is served to whoever next occupies it.
 */
function repoInfo(cwd) {
    // One rev-parse, not three. This runs at the end of EVERY turn of every
    // session, so its quiet path is a tax on every turn in the fleet.
    // `[measured 2026-09-08]` interleaved A/B, 40 rounds, medians: three
    // separate rev-parse calls 103.2ms, one combined call 34.0ms — 69ms saved
    // per turn. Interleaved rather than run back-to-back because this machine
    // runs dozens of sessions and sequential medians here are load, not signal.
    // The three answers come back as three lines, in the order asked for.
    const r = git(['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'], cwd);
    if (!r.ok) return null;
    const lines = r.out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) return null;
    const [toplevel, commonDir, branch] = lines;
    if (!toplevel || !branch) return null;
    if (branch === 'HEAD') return null; // detached: there is no branch to push to

    // Resolved against the worktree, because --git-common-dir answers ".git" in
    // a plain checkout and an absolute path in a worktree.
    const repoRoot = path.dirname(path.resolve(toplevel, commonDir));
    return { toplevel, repo: path.basename(repoRoot), branch };
}

/**
 * True when this branch must never receive a checkpoint commit. The remote's
 * own HEAD is asked first, because "main" is a convention and not a fact; the
 * hardcoded pair is the fallback for a repo with no remote HEAD ref.
 */
function isProtectedBranch(branch, toplevel) {
    if (branch === 'main' || branch === 'master') return true;
    const r = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], toplevel);
    if (!r.ok) return false;
    const name = r.out.trim().replace(/^refs\/remotes\/origin\//, '');
    return Boolean(name) && name === branch;
}

/**
 * Every path with work that a `git bundle` would NOT carry: tracked and
 * modified, or untracked and not ignored. `--untracked-files=all` lists files
 * inside untracked directories individually and still honours .gitignore,
 * which only `--ignored` would override.
 *
 * Parsed from -z output rather than from lines: a path with a newline in it is
 * legal, and the line-oriented form quotes and escapes instead, which is a
 * second format to get wrong.
 */
function atRiskPaths(toplevel) {
    const r = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], toplevel);
    if (!r.ok) return null;
    const fields = r.out.split('\0');
    const paths = [];
    for (let i = 0; i < fields.length; i++) {
        const entry = fields[i];
        if (!entry || entry.length < 4) continue;
        const x = entry[0];
        const y = entry[1];
        const p = entry.slice(3);
        if (p) paths.push(p);
        // A rename or copy carries its source in the NEXT field. Both are taken:
        // the destination is the new content and the source is a deletion, and
        // committing one without the other leaves the tree half-saved.
        if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
            i++;
            if (fields[i]) paths.push(fields[i]);
        }
    }
    return paths;
}

/** Stage exactly these paths. NUL-delimited via stdin so ARG_MAX and odd filenames are non-issues. */
function stage(toplevel, paths) {
    return git(['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
        toplevel, GIT_TIMEOUT_MS, paths.join('\0'));
}

/** Age in ms of the oldest at-risk file, by mtime. Unstattable paths are skipped. */
function oldestAgeMs(toplevel, paths, now) {
    let oldest = null;
    for (const p of paths) {
        let st;
        try {
            st = fs.lstatSync(path.join(toplevel, p));
        } catch {
            continue; // a deletion has no file to stat; the commit still carries it
        }
        if (oldest === null || st.mtimeMs < oldest) oldest = st.mtimeMs;
    }
    return oldest === null ? null : Math.max(0, now - oldest);
}

/**
 * List-price-equivalent spend in the current weekly window, from the shipped
 * sibling. Spawned, never reimplemented. Returns null on any failure — a
 * consumption figure this hook could not read must not become a zero, because
 * a zero reads as "plenty of headroom" and that is the one wrong answer.
 */
function windowCost() {
    const source = process.env.AUTODEV_QUOTA_BURN
        || path.join(__dirname, '..', 'scripts', 'quota-burn.js');
    try {
        if (!fs.existsSync(source)) return null;
        const r = spawnSync(process.execPath, [source, '--json', '--days', '0'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: QUOTA_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
        });
        if (r.error || r.status !== 0) return null;
        const parsed = JSON.parse(String(r.stdout || ''));
        const cost = Number(parsed && parsed.windowCost);
        return Number.isFinite(cost) && cost >= 0 ? cost : null;
    } catch {
        return null;
    }
}

function writeLedger(all, id, entry) {
    try {
        const cutoff = Date.now() - LEDGER_MAX_AGE_MS;
        for (const key of Object.keys(all)) {
            const e = all[key];
            if (!e || typeof e !== 'object' || !(Number(e.at) > cutoff)) delete all[key];
        }
        all[id] = entry;
        const p = ledgerPath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(all, null, 2) + '\n');
    } catch {
        /* a ledger we cannot write costs a repeated checkpoint, never a broken turn */
    }
}

/**
 * The shared fleet-intent record. KEYED BY repo+branch, never by cwd.
 *
 * An existing record's brief/current_step/next_step/verify are PRESERVED: the
 * session that wrote them knew what it was doing and this hook does not. All
 * this adds is the state flip and the timestamp. When no record exists the
 * placeholders say so in as many words rather than inventing an intent —
 * a fabricated brief is worse than an absent one, because it reads as evidence.
 */
function writeIntentRecord(info, sessionId, sha) {
    const dir = intentDir();
    const file = path.join(dir, info.repo + '--' + info.branch.replace(/\//g, '-') + '.json');
    const prior = readJson(file) || {};
    const keep = (k, fallback) => (typeof prior[k] === 'string' && prior[k].trim() ? prior[k] : fallback);
    const shortSha = sha ? sha.slice(0, 8) : 'uncommitted';

    const record = {
        repo: info.repo,
        branch: info.branch,
        session_id: sessionId,
        brief: keep('brief', '(no intent record was written while this session ran; '
            + 'this one was created by the usage-checkpoint hook, which knows what was '
            + 'saved but not what it was for)'),
        current_step: keep('current_step', 'unknown — the tree was checkpointed at ' + shortSha
            + ' on ' + info.branch),
        next_step: keep('next_step', 'read the checkpoint commit and decide from it: '
            + 'git -C ' + info.toplevel + ' show --stat ' + shortSha),
        verify: keep('verify', 'git -C ' + info.toplevel + ' log --oneline -3 ' + info.branch),
        // "checkpointed" is a claim about a COMMIT existing, and it must not be
        // made when none does: chip 3 re-dispatches off this field, and a record
        // saying the work is saved when it is still only in a working tree sends
        // the next session to a branch that does not have it. A checkpoint that
        // could not commit is work no agent can advance until a human fixes the
        // git problem, which is what "blocked" means.
        state: sha ? 'checkpointed' : 'blocked',
        updated_at: new Date().toISOString(),
    };
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
        return { file, ok: true };
    } catch (e) {
        return { file, ok: false, err: String((e && e.message) || e) };
    }
}

function main() {
    if (isOff(process.env.AUTODEV_CHECKPOINT)) silent();

    const payload = readPayload();
    if (!payload || typeof payload !== 'object') silent();

    const sessionId = typeof payload.session_id === 'string' && payload.session_id
        ? payload.session_id : null;
    if (!sessionId) silent();

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

    const info = repoInfo(cwd);
    if (!info) silent();
    if (isProtectedBranch(info.branch, info.toplevel)) silent();

    const paths = atRiskPaths(info.toplevel);
    if (!paths || paths.length === 0) silent();
    if (paths.length > MAX_FILES) {
        say(paths.length + ' at-risk path(s) on ' + info.branch + ' — too many to checkpoint '
            + '(cap ' + MAX_FILES + '). This is usually a build or dependency directory that '
            + 'belongs in .gitignore.',
            'USAGE CHECKPOINT DID NOT RUN: ' + paths.length + ' uncommitted paths on '
            + info.branch + ' exceeds the ' + MAX_FILES + '-path cap, so nothing was saved '
            + 'and this work is still at risk. Almost always a build or dependency directory '
            + 'that is missing from .gitignore — check `git status --short | head`, fix the '
            + 'ignore rules, and commit the real work yourself.');
        return;
    }

    const now = Date.now();
    const ledger = readJson(ledgerPath()) || {};
    const prior = (ledger[sessionId] && typeof ledger[sessionId] === 'object') ? ledger[sessionId] : {};

    const minIntervalMs = positiveNumber(process.env.AUTODEV_CHECKPOINT_MIN_INTERVAL,
        MIN_INTERVAL_DEFAULT) * 60_000;
    if (Number.isFinite(Number(prior.lastCheckpointAt))
        && now - Number(prior.lastCheckpointAt) < minIntervalMs) silent();

    // ---- which signal fires, and it always says which ----------------------
    let reason = null;
    const next = { at: now, lastCheckpointAt: prior.lastCheckpointAt };

    const ceiling = positiveNumber(process.env.AUTODEV_CHECKPOINT_CEILING, null);
    if (ceiling) {
        const fraction = positiveNumber(process.env.AUTODEV_CHECKPOINT_FRACTION, FRACTION_DEFAULT);
        const probeMs = positiveNumber(process.env.AUTODEV_CHECKPOINT_PROBE_MINUTES,
            PROBE_MINUTES_DEFAULT) * 60_000;
        // The probe reads every transcript in the window (~1s here), so it is
        // throttled separately from the checkpoint: an unthrottled probe would
        // add that second to the end of every turn of every session.
        let cost = Number.isFinite(Number(prior.cost)) ? Number(prior.cost) : null;
        if (!Number.isFinite(Number(prior.costAt)) || now - Number(prior.costAt) >= probeMs) {
            const fresh = windowCost();
            if (fresh !== null) {
                cost = fresh;
                next.costAt = now;
            }
        } else {
            next.costAt = Number(prior.costAt);
        }
        if (cost !== null) {
            next.cost = cost;
            if (cost / ceiling >= fraction) {
                reason = {
                    kind: 'usage',
                    text: 'window consumption $' + cost.toFixed(0) + ' is '
                        + Math.round((cost / ceiling) * 100) + '% of the configured $'
                        + ceiling.toFixed(0) + ' ceiling',
                };
            }
        }
    }

    if (!reason) {
        const ageMs = oldestAgeMs(info.toplevel, paths, now);
        const ageThresholdMs = positiveNumber(process.env.AUTODEV_CHECKPOINT_AGE_MINUTES,
            AGE_MINUTES_DEFAULT) * 60_000;
        if (ageMs !== null && ageMs >= ageThresholdMs) {
            reason = {
                kind: 'exposure',
                text: 'uncommitted work has been at risk for '
                    + Math.round(ageMs / 60_000) + ' minutes'
                    + (ceiling ? '' : ' (no $AUTODEV_CHECKPOINT_CEILING is set, so the'
                        + ' usage fraction could not be read — see the hook header)'),
            };
        }
    }

    if (!reason) {
        writeLedger(ledger, sessionId, next);
        silent();
    }

    // ---- checkpoint --------------------------------------------------------
    // Enumerated paths, never `git add -A`: two sessions sharing one checkout
    // share an index, and -A sweeps the other one's in-flight work into this
    // commit. `git add` is fatal on a pathspec matching nothing, so a file that
    // vanishes between the status read and the add takes the whole checkpoint
    // with it — hence one retry against a freshly read list.
    let staged = paths;
    let add = stage(info.toplevel, staged);
    if (!add.ok) {
        const again = atRiskPaths(info.toplevel);
        if (again && again.length > 0 && again.length <= MAX_FILES) {
            staged = again;
            add = stage(info.toplevel, staged);
        }
    }

    let sha = null;
    let commitErr = add.ok ? null : (add.err.trim() || 'git add failed');
    if (add.ok) {
        const msg = 'wip(checkpoint): ' + staged.length + ' path(s) on ' + info.branch + '\n\n'
            + 'Written by autodev-core\'s usage-checkpoint Stop hook while the session was\n'
            + 'still alive. A git bundle does not carry uncommitted work and a working tree\n'
            + 'is not resumable by anything else, so the tree is committed and pushed before\n'
            + 'a usage limit can take it.\n\n'
            + 'signal: ' + reason.kind + ' — ' + reason.text + '\n'
            + 'session: ' + sessionId + '\n\n'
            + 'This is NOT reviewed work. To continue from it:\n'
            + '  git reset --soft HEAD~1\n';
        let msgFile = null;
        try {
            msgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-ckpt-')), 'msg');
            fs.writeFileSync(msgFile, msg);
        } catch (e) {
            commitErr = String((e && e.message) || e);
        }
        if (msgFile) {
            // -F, never -m: the shell eats backticks as command substitution, and a
            // message this hook cannot re-issue is one it cannot amend either.
            const idArgs = [];
            if (process.env.AUTODEV_CHECKPOINT_EMAIL) idArgs.push('-c', 'user.email=' + process.env.AUTODEV_CHECKPOINT_EMAIL);
            if (process.env.AUTODEV_CHECKPOINT_NAME) idArgs.push('-c', 'user.name=' + process.env.AUTODEV_CHECKPOINT_NAME);
            const commit = git(idArgs.concat(['commit', '-F', msgFile]), info.toplevel);
            if (commit.ok) {
                const rev = git(['rev-parse', 'HEAD'], info.toplevel);
                if (rev.ok) sha = rev.out.trim();
            } else {
                commitErr = (commit.err.trim() || commit.out.trim() || 'git commit failed').split('\n')[0];
            }
        }
    }

    let pushed = false;
    let pushErr = null;
    if (sha && !isOff(process.env.AUTODEV_CHECKPOINT_PUSH)) {
        const hasOrigin = git(['remote', 'get-url', 'origin'], info.toplevel).ok;
        if (!hasOrigin) {
            pushErr = 'no origin remote';
        } else {
            // --no-verify: a pre-push hook here runs a gate that takes tens of
            // minutes, and a Stop hook must not hold a turn for that. A checkpoint
            // is a rescue ref, not a merge; the gate still guards the merge.
            const push = git(['push', '--no-verify', 'origin',
                'HEAD:refs/heads/' + info.branch], info.toplevel, PUSH_TIMEOUT_MS);
            pushed = push.ok;
            if (!push.ok) pushErr = (push.err.trim() || 'git push failed').split('\n').slice(-1)[0];
        }
    }

    const record = writeIntentRecord(info, sessionId, sha);

    next.lastCheckpointAt = now;
    writeLedger(ledger, sessionId, next);

    // ---- say so -------------------------------------------------------------
    const where = pushed ? 'pushed to origin/' + info.branch
        : (sha ? 'COMMITTED LOCALLY ONLY — NOT PUSHED (' + (pushErr || 'push disabled') + ')'
            : 'NOT COMMITTED (' + (commitErr || 'unknown') + ')');
    const short = sha ? sha.slice(0, 8) : 'none';

    const forOperator = 'Checkpoint: ' + staged.length + ' path(s) on ' + info.branch + ' — '
        + where + (sha ? ' at ' + short : '') + '. Signal: ' + reason.text + '.';
    // The lead sentence must not say "committed" on a run where nothing was
    // committed. The suite caught exactly that: a model reading "your worktree
    // was committed ... THE COMMIT DID NOT HAPPEN" has to decide which half to
    // believe, and the whole point of this line is that it does not have to.
    const forModel = (sha
        ? 'USAGE CHECKPOINT FIRED. Your worktree was committed'
            + (pushed ? ' and pushed to origin/' + info.branch : '') + ' as ' + short
        : 'USAGE CHECKPOINT FAILED. Your worktree could NOT be committed')
        + ' — ' + staged.length + ' path(s). Signal: ' + reason.kind + ' — ' + reason.text + '. '
        + 'The intent record is ' + record.file + (record.ok ? '' : ' (COULD NOT BE WRITTEN: ' + record.err + ')')
        + ' with state "checkpointed". '
        + (sha ? 'The checkpoint commit is a wip commit, not reviewed work: continue on top of '
            + 'it, or `git reset --soft HEAD~1` to put the tree back first. ' : '')
        + (sha && !pushed ? 'THE PUSH DID NOT HAPPEN (' + (pushErr || 'disabled') + '), so this '
            + 'work still lives on one machine — say so to whoever is coordinating. ' : '')
        + (sha ? '' : 'THE COMMIT DID NOT HAPPEN (' + (commitErr || 'unknown') + '), so the tree '
            + 'is still at risk — save it yourself before doing anything else. ')
        + 'Also update the record\'s brief/current_step/next_step/verify if they say the hook '
        + 'wrote them, so the next session inherits intent and not just a diff.';

    say(forOperator, forModel);
}

try {
    main();
} catch {
    // It ships installed and a defect here persists until the user reinstalls,
    // so there is no error path that is worth a stranger's turn.
    process.exit(0);
}
