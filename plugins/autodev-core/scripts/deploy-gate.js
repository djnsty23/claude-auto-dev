#!/usr/bin/env node
'use strict';
/**
 * deploy-gate.js - after a merge, wait for the production deployment of one
 * commit, run the product's own smoke command against the live URL, record
 * PASS, FAIL or TIMEOUT, and on FAIL open a DRAFT revert PR for a person.
 *
 *   node deploy-gate.js --repo-dir DIR --sha SHA [--prod-url URL] [--timeout-ms N]
 *        [--smoke-timeout-ms N] [--base BRANCH] [--repo OWNER/NAME] [--dry-run]
 *
 * WHY. A merged change that deploys and then breaks the live site is found
 * today by whoever visits next. A green gate says the TREE was good; it says
 * nothing about the deployed artifact. This is the missing last check, and it
 * is deliberately small: it decides nothing a person would not, it only makes
 * the failure loud and the undo one click away.
 *
 * THE PRODUCT OWNS THE CHECK. `package.json` in --repo-dir carries
 *   "autodevDeployGate": { "smoke": "node scripts/smoke.js {url}", "url": "https://..." }
 * `smoke` is split into argv (quotes group words, no shell, no escapes) and
 * `{url}` is replaced token by token with the production URL, so the URL can
 * never become a second command. Exit 0 from smoke is PASS. Anything else (a
 * non-zero exit, a timeout, a command that cannot start) is FAIL.
 * NO SMOKE COMMAND IS EXIT 2, NEVER PASS: a gate with nothing to run has
 * checked nothing, and "deployed, nothing broke" is not something this script
 * can say without a check. `url` is optional when --prod-url is given.
 *
 * WAITING FOR THE DEPLOYMENT. The deployment JSON comes from
 * AUTODEV_DEPLOY_INSPECT_CMD (default \`vercel inspect {url} --json\`, run
 * without a shell; on Windows name a node script or an .exe, because a .cmd
 * shim cannot be spawned without one). It is polled every 15 s, never faster,
 * for --timeout-ms (default 15 minutes). A poll counts as the deployment of
 * SHA only when ALL of these hold:
 *   - the JSON carries a commit sha (meta.githubCommitSha, meta.gitlabCommitSha,
 *     meta.bitbucketCommitSha, meta.commitSha or gitSource.sha) that equals SHA
 *     or abbreviates it (at least 7 characters),
 *   - readyState (or status) is READY,
 *   - check-deploy-target.js, run on the JSON with --intent production, exits 0.
 * check-deploy-target.js is run as it ships and is not reimplemented here, so
 * what "production" means stays in one place. A JSON with no sha, a sha that is
 * not SHA, a deployment still building, or a target check that exits 1 or 2 is
 * "not yet", and keeps polling until the timeout. Nothing indeterminate is ever
 * PASS. readyState ERROR or CANCELED for SHA is FAIL at once.
 * \`[inferred]\` The field names follow Vercel's deployment object; they were not
 * checked against a live response, which needs the network and an account. The
 * suite feeds the shapes above through a stub.
 *
 * ON FAIL, and only then:
 *   1. one FAIL event in the deploy ledger (deploy-ledger.js appendEvent);
 *   2. a temporary git worktree off origin/<base> with a new local branch
 *      revert/<first 8 of SHA>, \`git revert --no-edit SHA\` in it (\`-m 1\` for a
 *      merge commit);
 *   3. \`git push origin refs/heads/revert/<x>:refs/heads/revert/<x>\`: THE ONLY
 *      PUSH THIS SCRIPT EVER MAKES. A guard refuses any other push, any force
 *      flag, and any branch that is the base. The base branch is read, never
 *      written, and nothing is merged or promoted;
 *   4. \`gh pr create --draft\` against the base branch;
 *   5. the worktree is removed (the local branch stays);
 *   6. ONE notification through notify-policy.js (kind deploy-failed) naming the
 *      draft PR, or why none could be made.
 * A revert that conflicts, a failed push or a failed \`gh\` are reported in that
 * notification and in a second ledger line; the script still exits 1.
 * PASS records one deploy-done notification. TIMEOUT records one
 * blocked-on-owner notification and creates nothing: the script does not know
 * the deploy is broken, only that it never saw it arrive.
 *
 * --dry-run prints the plan, with every command and the exact branch and
 * refspec, and runs, writes, pushes and sends nothing. It still exits 2 when
 * the smoke command is missing, because a plan without a check is not a plan.
 *
 * EXIT. 0 PASS. 1 FAIL. 2 indeterminate: bad arguments, no smoke command, no
 * URL, or a PASS that could not be written to the ledger (an unrecorded PASS is
 * not reported as one). 3 TIMEOUT.
 *
 * ENVIRONMENT. AUTODEV_GIT_BIN and AUTODEV_GH_BIN name another git or gh (a
 * .js file runs under this node), as merge-lock.js does for gh.
 * AUTODEV_DEPLOY_INSPECT_CMD, AUTODEV_DEPLOY_EVENTS (the ledger file),
 * AUTODEV_NOTIFY_DIR and AUTODEV_DIGEST_DIR (notify-policy.js).
 * Test seam: AUTODEV_DEPLOY_GATE_POLL_MS replaces the 15 s poll interval.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const deployLedger = require('./deploy-ledger.js');
const notifyPolicy = require('./notify-policy.js');

const MIN_POLL_MS = 15000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SMOKE_TIMEOUT_MS = 120 * 1000;
const DEFAULT_INSPECT = 'vercel inspect {url} --json';
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_FIELDS = [['meta', 'githubCommitSha'], ['meta', 'gitlabCommitSha'], ['meta', 'bitbucketCommitSha'], ['meta', 'commitSha'], ['gitSource', 'sha']];

class Usage extends Error {}
const usage = (message) => new Usage(message);

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
    const a = { repoDir: null, sha: null, timeoutMs: DEFAULT_TIMEOUT_MS, smokeTimeoutMs: DEFAULT_SMOKE_TIMEOUT_MS, prodUrl: null, base: null, repo: null, dryRun: false, help: false };
    const value = (i, flag) => {
        if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw usage(`${flag} needs a value`);
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--repo-dir') a.repoDir = value(i++, v);
        else if (v === '--sha') a.sha = value(i++, v);
        else if (v === '--prod-url') a.prodUrl = value(i++, v);
        else if (v === '--base') a.base = value(i++, v);
        else if (v === '--repo') a.repo = value(i++, v);
        else if (v === '--timeout-ms') a.timeoutMs = Number(value(i++, v));
        else if (v === '--smoke-timeout-ms') a.smokeTimeoutMs = Number(value(i++, v));
        else if (v === '--dry-run') a.dryRun = true;
        else if (v === '--help' || v === '-h') a.help = true;
        else throw usage(`unrecognised argument: ${v}`);
    }
    if (a.help) return a;
    if (!a.repoDir) throw usage('--repo-dir is required');
    if (!a.sha || !SHA_RE.test(a.sha)) throw usage('--sha is required and must be 7 to 40 hex characters');
    for (const [flag, n] of [['--timeout-ms', a.timeoutMs], ['--smoke-timeout-ms', a.smokeTimeoutMs]]) {
        if (!Number.isInteger(n) || n <= 0) throw usage(`${flag} must be a positive integer`);
    }
    if (a.base !== null && (!BRANCH_RE.test(a.base) || a.base.startsWith('revert/'))) throw usage('--base is not a usable branch name');
    if (a.repo !== null && !REPO_RE.test(a.repo)) throw usage('--repo must be OWNER/NAME');
    a.sha = a.sha.toLowerCase();
    return a;
}

/** Split a command line into argv: whitespace separates, quotes group, no escapes, no shell. */
function splitArgv(line) {
    const out = [];
    let cur = '';
    let quote = null;
    let started = false;
    for (const ch of String(line)) {
        if (quote) {
            if (ch === quote) quote = null; else cur += ch;
        } else if (ch === '"' || ch === "'") { quote = ch; started = true; }
        else if (/\s/.test(ch)) {
            if (started || cur) { out.push(cur); cur = ''; started = false; }
        } else cur += ch;
    }
    if (quote) throw usage(`an unterminated ${quote} in the command: ${line}`);
    if (started || cur) out.push(cur);
    return out;
}

/** `{url}` replaced inside each token; the URL never splits a token. */
const withUrl = (argv, url) => argv.map((t) => t.split('{url}').join(url));

function validUrl(text) {
    let u;
    try { u = new URL(text); } catch { return null; }
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
}

function readConfig(repoDir) {
    const file = path.join(repoDir, 'package.json');
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        return { ok: false, why: `cannot read ${file} (${e.code || 'not JSON'}), so there is no smoke command` };
    }
    const g = pkg && pkg.autodevDeployGate;
    if (!g || typeof g !== 'object' || Array.isArray(g)) return { ok: false, why: `${file} has no "autodevDeployGate" object` };
    if (typeof g.smoke !== 'string' || !g.smoke.trim()) return { ok: false, why: `${file} "autodevDeployGate.smoke" is missing or empty` };
    return { ok: true, smoke: g.smoke.trim(), url: typeof g.url === 'string' ? g.url.trim() : null, base: typeof g.base === 'string' ? g.base.trim() : null };
}

// ------------------------------------------------------------ child processes

function binCommand(bin) {
    return /\.(c|m)?js$/i.test(bin) ? { file: process.execPath, pre: [bin] } : { file: bin, pre: [] };
}

/** Run a file with an args array, no shell. Never throws. */
function run(file, args, { cwd, env = process.env, timeoutMs = 120000 } = {}) {
    const r = spawnSync(file, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 });
    return {
        ok: !r.error && r.status === 0, status: r.status, signal: r.signal || null,
        stdout: r.stdout || '', stderr: (r.stderr || '').trim(),
        error: r.error ? (r.error.code || r.error.message) : null,
        timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'),
    };
}

function runGit(args, env, opts = {}) {
    const { file, pre } = binCommand(env.AUTODEV_GIT_BIN || 'git');
    return run(file, [...pre, ...args], { env, ...opts });
}
function runGh(args, env, opts = {}) {
    const { file, pre } = binCommand(env.AUTODEV_GH_BIN || 'gh');
    return run(file, [...pre, ...args], { env, ...opts });
}

/** A command argv run as-is (`node` means this node). */
function runArgv(argv, opts) {
    const [file, ...rest] = argv;
    return run(file === 'node' ? process.execPath : file, rest, opts);
}

// ------------------------------------------------------------ the deployment

/** The deployment object inside a JSON: the doc itself, or doc.deployment. */
function holderOf(doc) {
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
        if (doc.deployment && typeof doc.deployment === 'object' && !Array.isArray(doc.deployment)) return doc.deployment;
        return doc;
    }
    return null;
}

function shaOf(holder) {
    for (const [a, b] of SHA_FIELDS) {
        const v = holder && holder[a] && holder[a][b];
        if (typeof v === 'string' && SHA_RE.test(v)) return v.toLowerCase();
    }
    return null;
}

const sameCommit = (a, b) => a.startsWith(b) || b.startsWith(a);

/**
 * Judge one deployment JSON against the wanted sha, before the target check.
 * { state: 'candidate' | 'pending' | 'failed', reason }.
 * 'candidate' still has to pass check-deploy-target.js.
 */
function judgeDeployment(doc, sha) {
    const h = holderOf(doc);
    if (!h) return { state: 'pending', reason: 'the deployment JSON is not an object' };
    const got = shaOf(h);
    if (!got) return { state: 'pending', reason: 'the deployment JSON carries no commit sha, so it cannot be tied to the commit' };
    if (!sameCommit(got, sha)) return { state: 'pending', reason: `production still serves ${got.slice(0, 8)}, not ${sha.slice(0, 8)}` };
    const ready = String(h.readyState || h.status || '').toUpperCase();
    if (ready === 'READY') return { state: 'candidate', reason: null };
    if (ready === 'ERROR' || ready === 'CANCELED') return { state: 'failed', reason: `the deployment of ${sha.slice(0, 8)} ended ${ready}` };
    return { state: 'pending', reason: `the deployment of ${sha.slice(0, 8)} is ${ready || '(no state)'}` };
}

/** Run check-deploy-target.js on the JSON: { ok, line }. Exit 0 only is ok. */
function targetCheck(doc, env) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-gate-json-'));
    try {
        const file = path.join(dir, 'deployment.json');
        fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
        const r = run(process.execPath, [path.join(__dirname, 'check-deploy-target.js'), '--deployment', file, '--intent', 'production'], { env, timeoutMs: 30000 });
        const line = (r.stdout.split(/\r?\n/).find((l) => l.trim()) || r.stderr || r.error || '').trim();
        return { ok: r.status === 0, status: r.status, line };
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pollMs(env) {
    const n = Number(env.AUTODEV_DEPLOY_GATE_POLL_MS);
    return env.AUTODEV_DEPLOY_GATE_POLL_MS && Number.isFinite(n) && n >= 1 ? n : MIN_POLL_MS;
}

/** { state: 'ready' | 'failed' | 'timeout', reason, polls }. */
async function waitForDeployment({ inspectArgv, url, sha, timeoutMs, env }) {
    const started = Date.now();
    const interval = pollMs(env);
    let last = 'no poll has answered';
    let polls = 0;
    for (;;) {
        polls++;
        const probe = runArgv(withUrl(inspectArgv, url), { env, timeoutMs: 60000 });
        let verdict;
        if (!probe.ok) {
            verdict = { state: 'pending', reason: `the inspect command ${probe.error ? `could not run (${probe.error})` : `exited ${probe.status}`}${probe.stderr ? `: ${probe.stderr.split(/\r?\n/)[0].slice(0, 160)}` : ''}` };
        } else {
            let doc = null;
            try { doc = JSON.parse(probe.stdout); } catch { /* judged below */ }
            verdict = doc === null ? { state: 'pending', reason: 'the inspect command printed no JSON' } : judgeDeployment(doc, sha);
            if (verdict.state === 'candidate') {
                const t = targetCheck(doc, env);
                verdict = t.ok ? { state: 'ready', reason: null } : { state: 'pending', reason: `check-deploy-target.js exited ${t.status}: ${t.line}` };
            }
        }
        if (verdict.state === 'ready' || verdict.state === 'failed') return { ...verdict, polls };
        last = verdict.reason;
        const left = started + timeoutMs - Date.now();
        if (left <= 0) return { state: 'timeout', reason: last, polls };
        await sleep(Math.min(interval, left));
    }
}

// ------------------------------------------------------------------ the revert

function assertPushSafe(args, branch, base) {
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    const tail = args.slice(args.indexOf('push'));
    const ok = branch.startsWith('revert/') && branch !== base
        && tail.length === 3 && tail[0] === 'push' && tail[1] === 'origin' && tail[2] === refspec;
    if (!ok) throw new Error(`refusing a push other than ${refspec}: ${args.join(' ')}`);
}

function assertGhSafe(args) {
    if (!(args[0] === 'pr' && args[1] === 'create' && args.includes('--draft'))) throw new Error(`refusing a gh call other than a DRAFT pr create: ${args.join(' ')}`);
}

/**
 * Build the draft revert PR. { ok, branch, prUrl, step, why }. Touches only
 * revert/<x>; the base branch is read as a start point and named as the PR base.
 */
function makeRevert({ repoDir, sha, base: baseWanted, repo, reason, env }) {
    const branch = `revert/${sha.slice(0, 8)}`;
    const fail = (step, why) => ({ ok: false, branch, prUrl: null, step, why });
    const git = (args, opts) => runGit(['-C', repoDir, ...args], env, opts);
    const full = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    if (!full.ok || !SHA_RE.test(full.stdout.trim())) return fail('resolve', `the commit ${sha} is not in ${path.basename(repoDir)}`);
    const resolved = full.stdout.trim().toLowerCase();

    let base = baseWanted;
    if (!base) {
        const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
        const name = head.ok ? head.stdout.trim().replace(/^origin\//, '') : '';
        base = BRANCH_RE.test(name) && !name.startsWith('revert/') ? name : 'main';
    }
    const fetched = git(['fetch', '--quiet', 'origin', base], { timeoutMs: 120000 });
    if (!fetched.ok) return fail('fetch', `git fetch origin ${base} failed: ${fetched.stderr.split(/\r?\n/)[0] || fetched.error}`);

    const parents = git(['rev-list', '--parents', '-n', '1', resolved]);
    const isMerge = parents.ok && parents.stdout.trim().split(/\s+/).length > 2;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-gate-'));
    const wt = path.join(tmp, 'wt');
    let added = false;
    try {
        const add = git(['worktree', 'add', '-b', branch, wt, `origin/${base}`]);
        if (!add.ok) return fail('worktree', `git worktree add failed: ${add.stderr.split(/\r?\n/)[0] || add.error}`);
        added = true;
        const rev = runGit(['-C', wt, 'revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), resolved], env);
        if (!rev.ok) {
            runGit(['-C', wt, 'revert', '--abort'], env);
            return fail('revert', `git revert ${resolved.slice(0, 8)} did not apply cleanly: ${(rev.stderr || rev.stdout).split(/\r?\n/)[0] || rev.error}`);
        }
        const count = runGit(['-C', wt, 'rev-list', '--count', `origin/${base}..HEAD`], env);
        if (!count.ok || !(Number(count.stdout.trim()) >= 1)) return fail('revert', 'git revert made no commit');

        const pushArgs = ['-C', wt, 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`];
        assertPushSafe(pushArgs, branch, base);
        const push = runGit(pushArgs, env, { timeoutMs: 120000 });
        if (!push.ok) return fail('push', `git push of ${branch} failed: ${push.stderr.split(/\r?\n/)[0] || push.error}`);

        const bodyFile = path.join(tmp, 'body.md');
        fs.writeFileSync(bodyFile, [
            `Reverts ${resolved}.`,
            '',
            `The post-deploy smoke check failed on the production deployment of this commit: ${reason}`,
            '',
            'This pull request was opened as a DRAFT by deploy-gate.js. Nothing was merged, promoted or pushed to the base branch. Read the failure, then either merge this revert or fix forward and close it.',
            '',
        ].join('\n'), 'utf8');
        const ghArgs = ['pr', 'create', '--draft', '--base', base, '--head', branch,
            '--title', `Revert ${resolved.slice(0, 8)}: post-deploy smoke check failed`, '--body-file', bodyFile, ...(repo ? ['--repo', repo] : [])];
        assertGhSafe(ghArgs);
        const pr = runGh(ghArgs, env, { cwd: wt, timeoutMs: 120000 });
        if (!pr.ok) return fail('pr', `gh pr create failed (the branch ${branch} is pushed): ${pr.stderr.split(/\r?\n/)[0] || pr.error}`);
        const urls = pr.stdout.match(/https?:\/\/\S+/g);
        return { ok: true, branch, prUrl: urls ? urls[urls.length - 1] : null, step: null, why: null };
    } finally {
        if (added) runGit(['-C', repoDir, 'worktree', 'remove', '--force', wt], env);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
}

// ------------------------------------------------------------------- the gate

const plural = (n) => `${Math.round(n / 1000)} s`;

function planLines({ a, url, smokeArgv, inspectArgv, short, base }) {
    return [
        'deploy-gate: DRY RUN. Nothing was run, written, pushed or sent.',
        `  commit          ${a.sha}`,
        `  production url  ${url}`,
        `  wait            up to ${plural(a.timeoutMs)}, polling every ${plural(Math.max(pollMs(process.env), 1000))} (${inspectArgv.join(' ')})`,
        '                  ready = commit matches, readyState READY, and check-deploy-target.js --intent production exits 0',
        `  smoke           ${withUrl(smokeArgv, url).join(' ')}   (timeout ${plural(a.smokeTimeoutMs)})`,
        '  on PASS         one ledger event, one deploy-done notification',
        '  on TIMEOUT      one ledger event, one blocked-on-owner notification, exit 3, nothing created',
        '  on FAIL         one ledger event; a temp worktree off origin/' + (base || '<default branch>') + ';',
        `                  git revert --no-edit ${a.sha.slice(0, 8)} on a new branch revert/${short}`,
        `                  git push origin refs/heads/revert/${short}:refs/heads/revert/${short}   (the only push)`,
        `                  gh pr create --draft --head revert/${short}${a.repo ? ' --repo ' + a.repo : ''}`,
        '                  one deploy-failed notification. The base branch is never pushed, merged or promoted.',
    ];
}

/** Run the whole gate. Returns { code, lines }. Every side effect is in here, once. */
async function gate(argv, env = process.env) {
    const lines = [];
    const say = (s) => lines.push(s);
    let a;
    try { a = parseArgs(argv); } catch (e) {
        if (!(e instanceof Usage)) throw e;
        say(`deploy-gate: ${e.message}`);
        say('usage: node deploy-gate.js --repo-dir DIR --sha SHA [--prod-url URL] [--timeout-ms N] [--dry-run]   (--help for more)');
        return { code: 2, lines };
    }
    if (a.help) {
        say(USAGE);
        return { code: 0, lines };
    }
    const repoDir = path.resolve(a.repoDir);
    let isDir = false;
    try { isDir = fs.statSync(repoDir).isDirectory(); } catch { /* reported below */ }
    if (!isDir) { say(`deploy-gate: --repo-dir ${a.repoDir} is not a directory. Nothing was checked.`); return { code: 2, lines }; }

    const cfg = readConfig(repoDir);
    if (!cfg.ok) {
        say(`deploy-gate: INDETERMINATE. ${cfg.why}.`);
        say('  Nothing was checked, so this is NOT a pass. Add "autodevDeployGate": { "smoke": "<command with {url}>" } to package.json.');
        return { code: 2, lines };
    }
    const url = validUrl(a.prodUrl || cfg.url || '');
    if (!url) {
        say(`deploy-gate: INDETERMINATE. No usable production URL: pass --prod-url or set "autodevDeployGate.url" (http or https). Nothing was checked.`);
        return { code: 2, lines };
    }
    let smokeArgv;
    let inspectArgv;
    try {
        smokeArgv = splitArgv(cfg.smoke);
        inspectArgv = splitArgv(env.AUTODEV_DEPLOY_INSPECT_CMD || DEFAULT_INSPECT);
    } catch (e) {
        if (!(e instanceof Usage)) throw e;
        say(`deploy-gate: INDETERMINATE. ${e.message}. Nothing was checked.`);
        return { code: 2, lines };
    }
    if (!smokeArgv.length || !inspectArgv.length) {
        say('deploy-gate: INDETERMINATE. The smoke or inspect command is empty. Nothing was checked.');
        return { code: 2, lines };
    }
    const base = a.base || (cfg.base && BRANCH_RE.test(cfg.base) && !cfg.base.startsWith('revert/') ? cfg.base : null);
    const short = a.sha.slice(0, 8);

    if (a.dryRun) {
        for (const l of planLines({ a, url, smokeArgv, inspectArgv, short, base })) say(l);
        return { code: 0, lines };
    }

    const started = Date.now();
    const wait = await waitForDeployment({ inspectArgv, url, sha: a.sha, timeoutMs: a.timeoutMs, env });
    let result;
    let reason;
    if (wait.state === 'timeout') { result = 'TIMEOUT'; reason = `the deployment of ${short} was not seen within ${plural(a.timeoutMs)} (${wait.polls} poll(s)); last: ${wait.reason}`; }
    else if (wait.state === 'failed') { result = 'FAIL'; reason = wait.reason; }
    else {
        const smoke = runArgv(withUrl(smokeArgv, url), { cwd: repoDir, env, timeoutMs: a.smokeTimeoutMs });
        const out = (smoke.stdout + (smoke.stderr ? '\n' + smoke.stderr : '')).trim();
        if (out) say('smoke output (last 1000 characters):\n' + out.slice(-1000));
        if (smoke.ok) { result = 'PASS'; reason = 'the smoke command exited 0'; }
        else {
            result = 'FAIL';
            reason = smoke.timedOut ? `the smoke command did not finish within ${plural(a.smokeTimeoutMs)}`
                : smoke.error ? `the smoke command could not start (${smoke.error})`
                    : `the smoke command exited ${smoke.status === null ? `on signal ${smoke.signal}` : smoke.status}`;
        }
    }

    const event = { kind: 'deploy-gate', result, sha: a.sha, url, reason, ms: Date.now() - started, polls: wait.polls };
    const logged = deployLedger.appendEvent(event, { env });
    if (!logged.ok && result === 'PASS') {
        say(`deploy-gate: INDETERMINATE. The smoke check passed but PASS could not be written to the deploy ledger (${logged.why}). An unrecorded PASS is not reported as one.`);
        return { code: 2, lines };
    }

    let revert = null;
    if (result === 'FAIL') {
        try { revert = makeRevert({ repoDir, sha: a.sha, base, repo: a.repo, reason, env }); } catch (e) {
            revert = { ok: false, branch: `revert/${short}`, prUrl: null, step: 'internal', why: e.message };
        }
        deployLedger.appendEvent({ kind: 'deploy-gate-revert', sha: a.sha, ok: revert.ok, branch: revert.branch, step: revert.step, prUrl: revert.prUrl, why: revert.why }, { env });
    }

    // THE ONE NOTIFICATION. Exactly one call, here, whatever happened above.
    const note = result === 'PASS' ? { kind: 'deploy-done', summary: `smoke passed on ${url}` }
        : result === 'TIMEOUT' ? { kind: 'blocked-on-owner', summary: `deploy of ${short} never arrived: ${wait.reason}` }
            : { kind: 'deploy-failed', summary: `${reason}. ${revert && revert.ok ? `Draft revert PR: ${revert.prUrl || revert.branch}` : `No revert PR was made (${revert ? revert.step + ': ' + revert.why : 'n/a'})`}` };
    const sent = notifyPolicy.emit({ ...note, repo: a.repo, sha: a.sha, url: revert && revert.prUrl ? revert.prUrl : url }, env);

    say(`deploy-gate: ${result} ${short} ${url}`);
    say(`  ${reason}`);
    if (revert) say(revert.ok ? `  draft revert PR: ${revert.prUrl || '(gh printed no URL)'} on branch ${revert.branch}` : `  revert NOT made at ${revert.step}: ${revert.why}`);
    if (!logged.ok) say(`  WARNING: the ${result} could not be written to the deploy ledger (${logged.why}).`);
    say(sent.ok ? `  owner notification: ${sent.route} ${sent.kind}` : `  WARNING: the owner notification was NOT recorded (${sent.why}).`);
    return { code: result === 'PASS' ? 0 : result === 'FAIL' ? 1 : 3, lines };
}

const USAGE = [
    'deploy-gate.js - wait for the production deployment of a commit, smoke-check it, draft a revert on failure',
    '',
    '  node deploy-gate.js --repo-dir DIR --sha SHA [--prod-url URL] [--timeout-ms N] [--smoke-timeout-ms N]',
    '                      [--base BRANCH] [--repo OWNER/NAME] [--dry-run]',
    '',
    '  smoke command: package.json "autodevDeployGate": { "smoke": "cmd {url}", "url": "https://..." }',
    '  Exit 0 PASS, 1 FAIL (draft revert PR), 2 indeterminate (no smoke command, bad input), 3 TIMEOUT.',
    '  Never pushes the base branch, never merges, never promotes. --dry-run prints the plan only.',
].join('\n');

module.exports = { parseArgs, splitArgv, withUrl, readConfig, judgeDeployment, shaOf, holderOf, makeRevert, assertPushSafe, assertGhSafe, gate };

if (require.main === module) {
    gate(process.argv.slice(2)).then((r) => {
        if (r.lines.length) process.stdout.write(r.lines.join('\n') + '\n');
        // process.exitCode, never process.exit(): a pending stdout write is not truncated.
        process.exitCode = r.code;
    }).catch((e) => {
        process.stderr.write(`deploy-gate: INDETERMINATE. It threw: ${e && e.message}\n`);
        process.exitCode = 2;
    });
}
