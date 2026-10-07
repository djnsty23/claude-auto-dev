#!/usr/bin/env node
/**
 * fast-lane.js - decide whether a merge candidate may skip the full gate, and
 * write the receipt merge-lock.js accepts in its place.
 *
 * WHY. The merge bar is one full gate per merge. A small candidate that touches
 * nothing sensitive gets a cheaper bar: the product's lint, typecheck, test and
 * build on the rebased tree, no gate queue and no screenshot sweep. Without a
 * receipt for that bar, a fast-lane merge fell back to a bare `gh pr merge`,
 * outside the per-repo merge lock.
 *
 *   node fast-lane.js classify --repo-dir DIR --head SHA [--base REF] [--json]
 *   node fast-lane.js run      --repo-dir DIR --head SHA --out FILE [--base REF]
 *   node fast-lane.js --help
 *
 * ELIGIBLE means all of:
 *   - the diff base..head (no rename detection, so a rename counts every line)
 *     changes at most `maxLines` lines, added plus deleted (default 100),
 *   - every changed file has a line count (a binary file has none),
 *   - no changed path, old or new, matches a sensitive pattern: auth, login,
 *     sign-in or sign-up, password, session, middleware, payment, billing,
 *     stripe, checkout, subscription, invoice, RLS, policy, a migrations
 *     directory or a .sql file, a .env file,
 *   - package.json is unchanged, since it names the commands the lane runs.
 * The patterns match anywhere in the lower-cased path, so `author` reads as
 * auth: a false ineligible costs one full gate, a false eligible skips one.
 * A diff that cannot be read is INELIGIBLE, never eligible. Every ineligible
 * verdict lists its reasons.
 *
 * A PRODUCT EXTENDS IT in package.json, read at the BASE so a candidate cannot
 * loosen its own bar:
 *   "autodevFastLane": {
 *     "maxLines": 60,                            // lower or raise the threshold
 *     "sensitive": ["^src/lib/tenant", "rbac"],  // more patterns, case-insensitive
 *     "steps": { "typecheck": "type-check", "build": null }
 *   }
 * `sensitive` adds to the defaults and never removes one. `steps` renames the
 * script a step runs, and null declares the product has no such step.
 *
 * `run` refuses unless DIR's HEAD is --head, the tree is clean, and --base
 * (default origin/main) is an ancestor of --head. It classifies, then runs
 * `npm run <script>` for lint, typecheck, test and build in that order, each
 * read from the head's package.json scripts, and stops at the first red. It
 * then writes FILE, JSON:
 *   { kind, version, head, tree, base, classifier, steps: [{ step, script,
 *     command, exit, ms }], exit, finishedAt }
 * A step whose script is missing is red (exit null): name it in `steps` or
 * declare it null. FILE is written for a red run too, so the red is on record,
 * and merge-lock.js refuses it.
 *
 * EXIT. classify: 0 eligible, 1 ineligible. run: 0 eligible and every step
 * exited 0, 1 ineligible or a red step, 2 the run could not be judged (HEAD
 * moved during the steps, git missing). Bad arguments exit 1.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TAG = 'fast-lane:';
const KIND = 'autodev-fast-lane-receipt';
const VERSION = 1;
const SHA_RE = /^[0-9a-f]{40}$/;
const SCRIPT_RE = /^[A-Za-z0-9_:.-]+$/;
const DEFAULT_MAX_LINES = 100;
const STEPS = ['lint', 'typecheck', 'test', 'build'];
const CONFIG_KEY = 'autodevFastLane';

/** The default sensitive patterns, each with the reason an ineligible verdict prints. */
const DEFAULT_SENSITIVE = [
    ['auth', /auth/],
    ['login', /log-?in|log-?out/],
    ['sign-in or sign-up', /sign-?in|sign-?up/],
    ['password', /passw/],
    ['session', /session/],
    ['middleware', /middleware/],
    ['payment', /payment/],
    ['billing', /billing/],
    ['stripe', /stripe/],
    ['checkout', /checkout/],
    ['subscription', /subscription/],
    ['invoice', /invoice/],
    ['RLS', /(^|[^a-z])rls([^a-z]|$)/],
    ['policy', /polic(y|ies)/],
    ['migration', /(^|\/)migrations?\//],
    ['SQL', /\.sql$/],
    ['env file', /(^|\/)\.env/],
];

// ---------------------------------------------------------------------------
// The classifier: a pure function over a list of changed files.
// ---------------------------------------------------------------------------

/**
 * The fast-lane config from a package.json text, read at the base. Throws on
 * a config that is present but malformed, so a typo fails closed.
 */
function parseConfig(pkgText) {
    const out = { maxLines: DEFAULT_MAX_LINES, sensitive: [], steps: {} };
    if (pkgText === null || pkgText === undefined) return out;
    const pkg = JSON.parse(pkgText);
    const c = pkg && pkg[CONFIG_KEY];
    if (c === undefined) return out;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${CONFIG_KEY} must be an object`);
    if (c.maxLines !== undefined) {
        if (!Number.isInteger(c.maxLines) || c.maxLines < 0) throw new Error(`${CONFIG_KEY}.maxLines must be a whole number`);
        out.maxLines = c.maxLines;
    }
    if (c.sensitive !== undefined) {
        if (!Array.isArray(c.sensitive) || c.sensitive.some((p) => typeof p !== 'string' || !p)) {
            throw new Error(`${CONFIG_KEY}.sensitive must be an array of patterns`);
        }
        out.sensitive = c.sensitive.map((p) => [`${CONFIG_KEY}.sensitive ${p}`, new RegExp(p, 'i')]);
    }
    if (c.steps !== undefined) {
        if (!c.steps || typeof c.steps !== 'object' || Array.isArray(c.steps)) throw new Error(`${CONFIG_KEY}.steps must be an object`);
        for (const [k, v] of Object.entries(c.steps)) {
            if (!STEPS.includes(k)) throw new Error(`${CONFIG_KEY}.steps.${k} is not one of ${STEPS.join(', ')}`);
            if (v !== null && !(typeof v === 'string' && SCRIPT_RE.test(v))) throw new Error(`${CONFIG_KEY}.steps.${k} must be a script name or null`);
            out.steps[k] = v;
        }
    }
    return out;
}

/**
 * The verdict for a diff. `files` is [{ path, oldPath?, added, deleted }],
 * where added or deleted is null when the diff gives no line count.
 * Returns { eligible, changedLines, maxLines, files, reasons }.
 */
function classify(files, config = parseConfig(null)) {
    const reasons = [];
    if (!Array.isArray(files)) {
        return { eligible: false, changedLines: null, maxLines: config.maxLines, files: 0, reasons: ['the diff could not be read'] };
    }
    if (!files.length) reasons.push('the diff is empty, so there is nothing to merge');
    const patterns = [...DEFAULT_SENSITIVE, ...config.sensitive];
    let changed = 0;
    for (const f of files) {
        if (!Number.isInteger(f.added) || !Number.isInteger(f.deleted)) {
            reasons.push(`${f.path} has no line count (a binary file or an unreadable entry)`);
        } else {
            changed += f.added + f.deleted;
        }
        for (const p of new Set([f.path, f.oldPath].filter(Boolean))) {
            const lower = p.replace(/\\/g, '/').toLowerCase();
            for (const [why, re] of patterns) {
                if (re.test(lower)) reasons.push(`${p} matches the sensitive pattern ${why}`);
            }
            if (lower === 'package.json' || lower.endsWith('/package.json')) {
                reasons.push(`${p} changes, and package.json names the commands the fast lane runs`);
            }
        }
    }
    if (changed > config.maxLines) reasons.push(`${changed} changed lines, over the ${config.maxLines}-line limit`);
    return { eligible: reasons.length === 0, changedLines: changed, maxLines: config.maxLines, files: files.length, reasons };
}

// ---------------------------------------------------------------------------
// Reading a local repo.
// ---------------------------------------------------------------------------

function git(dir, args) {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { ok: !r.error && r.status === 0, status: r.status, stdout: r.stdout || '', stderr: (r.stderr || '').trim(), error: r.error };
}

/** The changed files base..head from `git diff --numstat -z --no-renames`, or null. */
function readDiff(dir, base, head) {
    const r = git(dir, ['diff', '--numstat', '-z', '--no-renames', `${base}..${head}`]);
    if (!r.ok) return null;
    const files = [];
    for (const rec of r.stdout.split('\0')) {
        if (!rec) continue;
        const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
        if (!m) return null;
        files.push({ path: m[3], added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
    }
    return files;
}

/** package.json text at a commit, null when the commit has none. Throws when git cannot say. */
function pkgAt(dir, rev) {
    const ls = git(dir, ['ls-tree', '--name-only', rev, '--', 'package.json']);
    if (!ls.ok) throw new Error(`cannot list ${rev} (${ls.stderr || ls.status})`);
    if (!ls.stdout.trim()) return null;
    const r = git(dir, ['show', `${rev}:package.json`]);
    if (!r.ok) throw new Error(`cannot read package.json at ${rev} (${r.stderr || r.status})`);
    return r.stdout;
}

function resolve(dir, rev) {
    const r = git(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    const sha = r.stdout.trim().toLowerCase();
    return r.ok && SHA_RE.test(sha) ? sha : null;
}

/** The full local verdict: { eligible, ..., base, baseSha, config } or a closed one. */
function classifyRepo(dir, head, baseRef = 'origin/main') {
    const closed = (why) => ({ eligible: false, changedLines: null, maxLines: DEFAULT_MAX_LINES, files: 0, reasons: [why], base: baseRef, baseSha: null });
    const baseSha = resolve(dir, baseRef);
    if (!baseSha) return closed(`cannot resolve ${baseRef} in ${dir}`);
    if (!resolve(dir, head)) return closed(`cannot resolve ${head} in ${dir}`);
    if (!git(dir, ['merge-base', '--is-ancestor', baseSha, head]).ok) {
        return { ...closed(`${baseRef} at ${baseSha} is not an ancestor of ${head}: rebase onto it first`), baseSha };
    }
    let config;
    try { config = parseConfig(pkgAt(dir, baseSha)); } catch (e) {
        return { ...closed(`the ${CONFIG_KEY} config at ${baseRef} is unreadable: ${e.message}`), baseSha };
    }
    const v = classify(readDiff(dir, baseSha, head), config);
    return { ...v, base: baseRef, baseSha, config };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** The script each step runs, from the base config and the head's scripts. */
function planSteps(config, scripts) {
    return STEPS.map((step) => {
        if (Object.prototype.hasOwnProperty.call(config.steps, step)) {
            const named = config.steps[step];
            if (named === null) return { step, script: null, declaredAbsent: true };
            return { step, script: named, missing: !Object.prototype.hasOwnProperty.call(scripts, named) };
        }
        return { step, script: step, missing: !Object.prototype.hasOwnProperty.call(scripts, step) };
    });
}

function npmRun(dir, script) {
    // npm is a .cmd on Windows, found only through a shell, and node deprecates
    // an args array beside shell: true. The script name is checked against
    // SCRIPT_RE first, so the command line carries no metacharacters.
    if (!SCRIPT_RE.test(script)) return { exit: null, ms: 0, error: `unsafe script name ${script}` };
    const started = Date.now();
    const opts = { cwd: dir, stdio: 'inherit', windowsHide: true };
    const r = process.platform === 'win32'
        ? spawnSync(`npm run ${script}`, { ...opts, shell: true })
        : spawnSync('npm', ['run', script], opts);
    return { exit: r.error ? null : r.status, ms: Date.now() - started, error: r.error ? (r.error.code || r.error.message) : null };
}

/** Classifies, runs the steps and writes the receipt. Returns its exit code. */
function run({ dir, head, baseRef, out, log = console.log, err = console.error, runStep = npmRun }) {
    const at = resolve(dir, 'HEAD');
    if (at !== head) { err(`${TAG} REFUSED: ${dir} is at ${at || 'no commit'}, not --head ${head}`); return 1; }
    const dirty = git(dir, ['status', '--porcelain']);
    if (!dirty.ok) { err(`${TAG} INDETERMINATE: git status failed in ${dir}`); return 2; }
    if (dirty.stdout.trim()) { err(`${TAG} REFUSED: ${dir} has uncommitted changes, so a receipt would not describe ${head}`); return 1; }
    const tree = git(dir, ['rev-parse', `${head}^{tree}`]).stdout.trim().toLowerCase();
    const verdict = classifyRepo(dir, head, baseRef);
    const { config, ...classifier } = verdict;
    const receipt = { kind: KIND, version: VERSION, head, tree, base: { ref: baseRef, sha: verdict.baseSha }, classifier, steps: [], exit: 1, finishedAt: null };
    const write = () => {
        receipt.finishedAt = new Date().toISOString();
        fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
    };
    if (!verdict.eligible) {
        write();
        err(`${TAG} INELIGIBLE for the fast lane, run the full gate:`);
        for (const r of verdict.reasons) err(`${TAG}   ${r}`);
        return 1;
    }
    let scripts;
    try { scripts = (JSON.parse(pkgAt(dir, head) || '{}').scripts) || {}; } catch (e) {
        write();
        err(`${TAG} REFUSED: package.json at ${head} is unreadable (${e.message})`);
        return 1;
    }
    log(`${TAG} eligible: ${verdict.changedLines} changed lines in ${verdict.files} file(s), limit ${verdict.maxLines}`);
    let red = false;
    for (const s of planSteps(config, scripts)) {
        if (s.declaredAbsent) {
            receipt.steps.push({ step: s.step, script: null, command: null, exit: 0, ms: 0, declaredAbsent: true });
            log(`${TAG} ${s.step}: declared absent in the base config`);
            continue;
        }
        if (s.missing) {
            receipt.steps.push({ step: s.step, script: s.script, command: null, exit: null, ms: 0 });
            err(`${TAG} ${s.step}: package.json has no "${s.script}" script. Name it in ${CONFIG_KEY}.steps or declare it null`);
            red = true;
            break;
        }
        const command = `npm run ${s.script}`;
        log(`${TAG} ${s.step}: ${command}`);
        const r = runStep(dir, s.script);
        receipt.steps.push({ step: s.step, script: s.script, command, exit: r.exit, ms: r.ms });
        if (r.exit !== 0) {
            err(`${TAG} ${s.step} exited ${r.exit === null ? `without a status (${r.error})` : r.exit}`);
            red = true;
            break;
        }
    }
    if (resolve(dir, 'HEAD') !== head) {
        receipt.exit = 2;
        write();
        err(`${TAG} INDETERMINATE: HEAD moved off ${head} while the steps ran`);
        return 2;
    }
    receipt.exit = red ? 1 : 0;
    write();
    log(`${TAG} ${red ? 'RED' : 'GREEN'}: receipt written to ${out}`);
    return receipt.exit;
}

// ---------------------------------------------------------------------------
// The receipt check merge-lock.js runs before it takes the lock.
// ---------------------------------------------------------------------------

/** { receipt } when the file proves `head` green and eligible, else { problem }. */
function receiptProblem(file, head) {
    if (!file) return { problem: 'no --fast-lane-receipt given' };
    let r;
    try { r = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
        return { problem: `cannot read --fast-lane-receipt ${file} as JSON (${e.code || e.message})` };
    }
    if (!r || r.kind !== KIND || r.version !== VERSION) return { problem: `${file} is not a fast-lane receipt version ${VERSION}` };
    if (String(r.head).toLowerCase() !== head) return { problem: `${file} proves ${r.head}, not head ${head}` };
    if (!SHA_RE.test(String(r.tree))) return { problem: `${file} names no tree sha` };
    if (!r.classifier || r.classifier.eligible !== true) {
        const why = r.classifier && Array.isArray(r.classifier.reasons) ? r.classifier.reasons.join('; ') : 'no verdict';
        return { problem: `${file}: the classifier said ineligible (${why})` };
    }
    const steps = Array.isArray(r.steps) ? r.steps : [];
    for (const step of STEPS) {
        const s = steps.find((x) => x && x.step === step);
        if (!s) return { problem: `${file} has no ${step} step` };
        if (s.exit !== 0) return { problem: `${file}: ${step} exited ${s.exit}` };
    }
    if (r.exit !== 0) return { problem: `${file}: the run exited ${r.exit}` };
    return { receipt: r };
}

/**
 * The classifier over a GitHub compare answer's `files`, so merge-lock judges
 * the exact diff it merges. GitHub omits `patch` for a binary file and caps
 * the list at 300 files, and both fail closed.
 */
function filesFromCompare(cmp) {
    if (!cmp || !Array.isArray(cmp.files)) return null;
    if (cmp.files.length >= 300) return null;
    return cmp.files.map((f) => {
        const lines = Number.isInteger(f.additions) && Number.isInteger(f.deletions);
        const binary = typeof f.patch !== 'string' && f.status !== 'renamed' && f.changes === 0;
        return {
            path: String(f.filename),
            oldPath: f.previous_filename ? String(f.previous_filename) : undefined,
            added: lines && !binary ? f.additions : null,
            deleted: lines && !binary ? f.deletions : null,
        };
    });
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const out = { cmd: null, dir: null, head: null, base: 'origin/main', out: null, json: false, help: false, bad: null };
    const takes = { '--repo-dir': 'dir', '--head': 'head', '--base': 'base', '--out': 'out' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { out.help = true; continue; }
        if (a === '--json') { out.json = true; continue; }
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
    console.log('usage: node fast-lane.js classify --repo-dir DIR --head SHA [--base REF] [--json]');
    console.log('       node fast-lane.js run      --repo-dir DIR --head SHA --out FILE [--base REF]');
    console.log('');
    console.log(`A candidate is eligible when base..head changes at most ${DEFAULT_MAX_LINES} lines (package.json`);
    console.log(`"${CONFIG_KEY}.maxLines" at the base changes it), every file has a line count, package.json is`);
    console.log('unchanged and no path matches a sensitive pattern (auth, session, payment, billing, stripe,');
    console.log('checkout, RLS, migrations, SQL and more). An unreadable diff is ineligible. run then executes');
    console.log('npm run lint, typecheck, test and build on the clean head and writes the receipt that');
    console.log('merge-lock.js merge --fast-lane-receipt FILE accepts. --base defaults to origin/main.');
    console.log('Exit: classify 0 eligible, 1 ineligible. run 0 green, 1 ineligible or red, 2 indeterminate.');
}

function main() {
    const a = parseArgs(process.argv.slice(2));
    if (a.help) { help(); return; }
    const fail = (msg) => { console.error(`${TAG} REFUSED: ${msg}`); process.exitCode = 1; };
    if (a.bad) return fail(`${a.bad}; see --help`);
    if (!['classify', 'run'].includes(a.cmd)) return fail(`${a.cmd ? `unknown command ${a.cmd}` : 'no command given'}; see --help`);
    if (!a.dir || !fs.existsSync(a.dir)) return fail('--repo-dir must name a git checkout');
    const head = String(a.head || '').toLowerCase();
    if (!SHA_RE.test(head)) return fail('--head must be the full 40-character commit sha');
    const dir = path.resolve(a.dir);
    if (a.cmd === 'classify') {
        const { config, ...v } = classifyRepo(dir, head, a.base);
        if (a.json) console.log(JSON.stringify(v, null, 2));
        else if (v.eligible) console.log(`${TAG} ELIGIBLE: ${v.changedLines} changed lines in ${v.files} file(s), limit ${v.maxLines}`);
        else {
            console.log(`${TAG} INELIGIBLE:`);
            for (const r of v.reasons) console.log(`${TAG}   ${r}`);
        }
        process.exitCode = v.eligible ? 0 : 1;
        return;
    }
    if (!a.out) return fail('run needs --out FILE');
    process.exitCode = run({ dir, head, baseRef: a.base, out: path.resolve(a.out) });
}

module.exports = {
    classify, parseConfig, readDiff, classifyRepo, planSteps, run, receiptProblem, filesFromCompare, parseArgs,
    DEFAULT_MAX_LINES, KIND, STEPS,
};

if (require.main === module) main();
