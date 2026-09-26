#!/usr/bin/env node
/**
 * check-entrypoints.js - every shipped script must RETURN when asked for help.
 *
 * WHY. `[measured 2026-09-02]` three scripts in this plugin entered their watch
 * loop on `--help` and never returned: watch-panels.js, fleet-stop-watch.js,
 * quota-tripwire.js. An auditor following the repo's own convention (probe
 * `--help` first) blocked on each one, and a coordinator that wraps nothing in
 * a timeout hangs its turn. F8 of the 2026-08-30 codex audit fixed the same
 * class in fleet-board.js and gated that one file. This gates the population.
 *
 * WHAT IT PROVES. For every script in the population, `node <script> --help`
 * with stdin closed exits within the budget. The exit CODE is reported and not
 * judged: a script that prints usage and exits 2 has answered. Only a script
 * that is still running when the budget ends is a finding.
 *
 * WHAT IT REFUSES TO RISK. Some scripts here mutate the tree when run without
 * a flag they recognise (check-suites-can-fail.js rewrites sources; the vacuity
 * sweep plants mutants). A script that ignores --help and does its default
 * action, killed at the budget, would leave the working tree mutated. So every
 * probe runs against a SCRATCH COPY of the repo under a scratch HOME and a
 * scratch TMPDIR, never the source tree, and the selftest proves that isolation
 * with a script that writes a marker beside itself: the marker must land in the
 * copy and nowhere else.
 *
 * THE COPY IS A GIT REPOSITORY, with one commit of the whole tree. It used to
 * leave .git out and stop there, so a script whose default action starts with a
 * git call died in ~100 ms on "not a git repository" and was counted RETURNED:
 * the probe never reached the question it exists to ask. `[measured 2026-09-25,
 * origin/main 6b70888, 158 probed, win32]` three variants on the same population:
 *
 *   variant                                  red on the 2 real hangs   wall
 *   .git left out (the old copy)             0                         17.7-21.4 s
 *   same, plus "not a git repository" in a   1 (misses the one whose   same
 *     non-zero row read as UNMEASURED           git call drops stderr)
 *   copy committed as a git repository       2                         26.8-27.3 s
 *
 * The two it found were check-suites-can-fail.js (ran its sweep on --help) and
 * mutate-sessions-gate.js (ran its mutation sweep on --help); both had sat at
 * "exit 1" in the non-zero note. Matching git's message was rejected: it
 * catches only a script that lets git's stderr through, and it would label a
 * script that ignores --help as indeterminate, which a re-run never clears.
 * The wall figures are with both hangs fixed, two runs each. About 3 s of the
 * difference builds the repository. The other ~5.5 s that day was
 * check-no-private-names.js and check-no-home-paths.js, which ignored --help
 * and reached their read-only scan of the tree instead of stopping at the
 * missing .git. Both now answer --help before any work. About 1.7 s of their
 * share did not go away: it is the cold read of a freshly written copy, which
 * the next script to read the whole tree now pays instead.
 *
 * The commit is built with plumbing (write-tree, commit-tree, update-ref), which
 * runs no hooks and needs no user config, under the scratch HOME and with every
 * GIT_* variable dropped: an inherited GIT_DIR or GIT_INDEX_FILE (a git hook
 * sets them) would point `git add` at the REAL repository. TMPDIR/TMP/TEMP
 * point into the scratch directory, because a probe killed at the budget
 * strands whatever it made under tmpdir, and a worktree it registered is
 * recorded only in the scratch .git, which is deleted, so nothing would ever
 * clean the directory. Measured the same day: the killed check-suites probe
 * left check-suites-wt-*, sweep-suite-* and a suite's own tmpdir, all inside
 * the scratch directory and removed with it. On win32 no child of a killed
 * probe outlived it; POSIX was not measured.
 *
 * POPULATION. plugins/<name>/scripts/*.js, plugins/<name>/hooks/*.js, and
 * tooling/*.js excluding tooling/test-*.js (suites run on invocation and do not
 * take --help) and any *.workflow.js (the Workflow tool runs those, node cannot;
 * see WORKFLOW_SCRIPT). Printed on every run, so a quiet result is
 * distinguishable from an empty scan.
 *
 *   node tooling/check-entrypoints.js                # probe the repo, exit 1 on any hang
 *   node tooling/check-entrypoints.js --budget-ms 5000
 *   node tooling/check-entrypoints.js --root <dir>   # probe another tree of the same shape
 *   node tooling/check-entrypoints.js --json
 *   node tooling/check-entrypoints.js --selftest
 *
 * THREE OUTCOMES, NOT TWO. `[measured 2026-09-11]` this file read
 * `r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'` and called everything
 * else RETURNED. Five spawnSync shapes on node 24 / macOS say that is wrong in
 * both directions:
 *
 *   ran, exited N          error null       signal null     -> RETURNED   ok
 *   our timeout killed it  ETIMEDOUT        SIGTERM         -> HUNG       ok
 *   spawn failed           ENOENT/EACCES    null            -> RETURNED   WRONG
 *   printed past maxBuffer ENOBUFS          SIGTERM         -> HUNG       WRONG
 *
 * A script that never started was counted into "N returned" and then reappeared
 * in the non-zero note as `exit null` — a second confident sentence about a run
 * that did not happen. A script killed for printing 9 MiB of usage text failed
 * the gate as a HANG, sending a reader to look for a loop that is not there.
 * Both are one filter over several distinct states with one confident label,
 * which is the failure `tooling/suite-verdict-summary.js` was written for and
 * `tooling/spawn-budget.js` had already solved here — its `classify()` says in
 * as many words that "a self-SIGTERM with no timeout is infrastructure". This
 * file held a private second opinion of that, and got it wrong.
 *
 * So a probe now yields RETURNED, HUNG or UNMEASURED, the reason is CARRIED on
 * the row rather than sniffed back out of prose, and UNMEASURED is never added
 * to either of the other two. `timedOut()` is imported from spawn-budget.js so
 * there is ONE definition of "our timeout fired" in this repo.
 *
 * Exit: 0 clean, 1 at least one script hung, 2 the probe could not measure
 * something (an empty population, a scratch copy git could not commit, or any
 * UNMEASURED row). 2 wins over 1 when both are present — the same precedence
 * check-suites-can-fail.js uses — and both counts print either way, so a
 * refusal never hides a finding.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { timedOut } = require('./spawn-budget.js');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const BUDGET_MS = Math.max(500, Number(val('--budget-ms', 10000)) || 10000);

/**
 * A Workflow tool script, which node cannot run. The Workflow runtime executes
 * its body as a function, supplies `args`, `agent`, `pipeline` and `log`, and
 * takes its top-level `return` as the result. Under node, `export const meta`
 * makes the file an ES module, where that `return` is a SyntaxError: `node
 * heal-sweep.workflow.js --help` exits 1 before its first line runs, so no
 * --help branch could ever execute and the probe measured the parser.
 */
const WORKFLOW_SCRIPT = /\.workflow\.js$/;

/** Relative paths of every entry point in `root`, sorted. */
function population(root) {
    const out = [];
    const entry = (f) => f.endsWith('.js') && !WORKFLOW_SCRIPT.test(f);
    const pluginsDir = path.join(root, 'plugins');
    if (fs.existsSync(pluginsDir)) {
        for (const plugin of fs.readdirSync(pluginsDir)) {
            for (const sub of ['scripts', 'hooks']) {
                const dir = path.join(pluginsDir, plugin, sub);
                if (!fs.existsSync(dir)) continue;
                for (const f of fs.readdirSync(dir)) {
                    if (entry(f)) out.push(path.join('plugins', plugin, sub, f));
                }
            }
        }
    }
    const tooling = path.join(root, 'tooling');
    if (fs.existsSync(tooling)) {
        for (const f of fs.readdirSync(tooling)) {
            if (entry(f) && !/^test-/.test(f)) out.push(path.join('tooling', f));
        }
    }
    return out.sort();
}

/**
 * `env` without a single GIT_* variable. An inherited GIT_DIR, GIT_WORK_TREE or
 * GIT_INDEX_FILE points every git call at the repository that set it, whatever
 * the cwd, and a git hook is exactly where those are set. Case-insensitive
 * because win32 environment names are.
 */
function withoutGitVars(env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) if (!/^GIT_/i.test(k)) out[k] = v;
    return out;
}

/**
 * Copy `root` to a scratch directory and commit the copy as a new git
 * repository. .git, .claude and node_modules are left out of the copy: the
 * first two are state the probes must not touch, the third is absent in this
 * repo and would only add time elsewhere. The repository is created fresh, so a
 * script whose default action is a git call reaches it, against history that
 * holds one commit and nothing else. See the header for the measurement.
 *
 * Throws when git cannot build it. The caller reports that as COULD NOT RUN:
 * falling back to a copy without .git would hand every git-dependent script
 * back its early "not a git repository" exit, and read it as an answer.
 */
function scratchCopy(root) {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'check-entrypoints-'));
    const copyRoot = path.join(dest, 'repo');
    // HOME exists before the commit, so git builds it with no user config either.
    const home = path.join(dest, 'home');
    const tmp = path.join(dest, 'tmp');
    try {
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(tmp, { recursive: true });
        fs.cpSync(root, copyRoot, {
            recursive: true,
            filter: (src) => {
                const base = path.basename(src);
                return !(base === '.git' || base === '.claude' || base === 'node_modules');
            },
        });
        const env = {
            ...withoutGitVars(process.env),
            HOME: home, USERPROFILE: home,
            GIT_AUTHOR_NAME: 'check-entrypoints', GIT_AUTHOR_EMAIL: 'check-entrypoints@invalid',
            GIT_COMMITTER_NAME: 'check-entrypoints', GIT_COMMITTER_EMAIL: 'check-entrypoints@invalid',
        };
        const git = (args) => {
            const r = spawnSync('git', args, { cwd: copyRoot, env, encoding: 'utf8', windowsHide: true });
            if (r.error || r.status !== 0) {
                const why = r.error ? r.error.code || r.error.message : `exit ${r.status}: ${(r.stderr || '').trim()}`;
                throw new Error(`git ${args[0]} in the scratch copy failed (${why})`);
            }
            return r.stdout.trim();
        };
        git(['init', '-q']);
        git(['add', '-A']);
        const tree = git(['write-tree']);
        const commit = git(['commit-tree', tree, '--no-gpg-sign', '-m', 'check-entrypoints scratch copy']);
        git(['update-ref', 'HEAD', commit]);
    } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        throw e;
    }
    return { dest, copyRoot, home, tmp };
}

/**
 * Paths a probe changed in the copy, from `git status --porcelain`. Measured
 * empty across the whole population on 2026-09-25. It matters because a script
 * that refuses a dirty tree (check-suites-can-fail.js does) exits early for
 * every probe after the one that dirtied it, which is the early exit the git
 * repository was added to remove. Null when git could not answer.
 */
function changedInCopy(copyRoot) {
    const r = spawnSync('git', ['status', '--porcelain'], {
        cwd: copyRoot, env: withoutGitVars(process.env), encoding: 'utf8', windowsHide: true,
    });
    if (r.error || r.status !== 0) return null;
    return r.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean);
}

/**
 * Classify one spawnSync result as RETURNED, HUNG or UNMEASURED.
 *
 * Exported and pure so every shape above can be asserted directly, the way
 * spawn-budget.js asserts its own classifier. A synthetic-only proof would be a
 * test of this function's opinion of itself, so the selftest ALSO plants a live
 * script that overflows the buffer and checks the real spawnSync result lands
 * on the same label.
 *
 * Order matters: ENOBUFS arrives WITH signal SIGTERM, so asking "was it our
 * timeout" first is what keeps it out of HUNG.
 */
function classifyProbe(r) {
    if (timedOut(r)) return { status: 'HUNG', reason: 'ETIMEDOUT' };
    if (r.error) return { status: 'UNMEASURED', reason: String(r.error.code || r.error.message) };
    // No error and no numeric status means something outside this process ended
    // the child. The probe learned nothing about whether the script returns.
    if (typeof r.status !== 'number') {
        return { status: 'UNMEASURED', reason: r.signal ? 'signal ' + r.signal : 'no exit status' };
    }
    return { status: 'RETURNED', reason: null };
}

/** Probe one script. Returns { rel, status: RETURNED|HUNG|UNMEASURED, reason, code, signal, ms, tail }. */
function probe(copyRoot, rel, env, budgetMs) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [path.join(copyRoot, rel), '--help'], {
        cwd: copyRoot,
        env,
        input: '',            // stdin closed: a hook that waits for JSON must not wait forever
        encoding: 'utf8',
        timeout: budgetMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
    });
    const ms = Date.now() - started;
    const { status, reason } = classifyProbe(r);
    // A killed child still carries everything it printed, and the last lines
    // name what was in flight. Kept for every status, UNMEASURED included.
    const text = ((r.stdout || '') + (r.stderr || '')).trim();
    return {
        rel,
        status,
        reason,
        code: r.status,
        signal: r.signal,
        ms,
        tail: text.split('\n').slice(-2).join(' | ').slice(0, 160),
    };
}

function run(root, opts = {}) {
    const budgetMs = opts.budgetMs || BUDGET_MS;
    const pop = population(root);
    if (pop.length === 0) return { ok: false, reason: 'no population', results: [], root };
    let dest, copyRoot, home, tmp;
    try {
        ({ dest, copyRoot, home, tmp } = scratchCopy(root));
    } catch (e) {
        return { ok: false, reason: 'could not build the scratch repository: ' + e.message, results: [], root };
    }
    const env = {
        ...withoutGitVars(process.env),
        HOME: home,
        USERPROFILE: home,
        // A probe killed at the budget strands what it made under tmpdir. Here
        // that is inside dest, and removed with it.
        TMPDIR: tmp, TMP: tmp, TEMP: tmp,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        AUTODEV_FLEET_DIR: path.join(home, 'fleet'),
        AUTODEV_FLEET_PUBLISH_DIR: path.join(home, 'published'),
        CLAUDE_PLUGIN_ROOT: path.join(copyRoot, 'plugins', 'autodev-core'),
        AUTODEV_PANEL_CHECK: 'off',
    };
    const results = [];
    let changed = null;
    try {
        for (const rel of pop) results.push(probe(copyRoot, rel, env, budgetMs));
        changed = changedInCopy(copyRoot);
    } finally {
        if (!opts.keepScratch) fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    return { ok: true, results, changed, root, copyRoot: opts.keepScratch ? copyRoot : null, dest: opts.keepScratch ? dest : null, budgetMs };
}

function report(out, json) {
    if (!out.ok) {
        console.log(`[entrypoints] COULD NOT RUN: ${out.reason} under ${out.root}`);
        return 2;
    }
    const hung = out.results.filter((r) => r.status === 'HUNG');
    const unmeasured = out.results.filter((r) => r.status === 'UNMEASURED');
    // Counted positively. `length - hung.length` DEFINED returned as "not hung",
    // which is how a script that never started became one that returned fine.
    const returned = out.results.filter((r) => r.status === 'RETURNED').length;
    if (json) {
        console.log(JSON.stringify({
            population: out.results.length, returned,
            hung: hung.map((h) => h.rel),
            unmeasured: unmeasured.map((u) => ({ script: u.rel, reason: u.reason })),
            changedInCopy: out.changed,
            budgetMs: out.budgetMs,
        }, null, 2));
        return verdict(hung, unmeasured);
    }
    console.log(`[entrypoints] ${out.results.length} script(s) probed with --help under a ${out.budgetMs}ms budget, `
        + `${returned} returned, ${hung.length} hung, ${unmeasured.length} unmeasured`);
    for (const h of hung) console.log(`  HUNG      ${h.rel}  (${h.ms}ms, killed at the budget)${h.tail ? '  last: ' + h.tail : ''}`);
    if (unmeasured.length) {
        // Never phrased as a finding about the script. The measured cost of the
        // opposite wording was a reader sent to hunt a hang that did not exist.
        console.log(`  note: ${unmeasured.length} probe(s) produced NO verdict — the check could not measure these,`);
        console.log('        which is indeterminate and re-runnable, NOT a finding about the script:');
        for (const u of unmeasured) console.log(`    ${u.reason}  ${u.rel}  (${u.ms}ms)${u.tail ? '  last: ' + u.tail : ''}`);
    }
    const nonzero = out.results.filter((r) => r.status === 'RETURNED' && r.code !== 0);
    if (nonzero.length) {
        console.log(`  note: ${nonzero.length} returned non-zero on --help; reported, not judged:`);
        for (const n of nonzero) console.log(`    exit ${n.code}  ${n.rel}`);
    }
    if (out.changed === null) {
        console.log('  note: git could not read the scratch copy afterwards, so whether a probe changed it is unknown');
    } else if (out.changed && out.changed.length) {
        // Not a verdict: which probe wrote is not recorded (a status after every
        // probe measured ~40 ms each, ~6 s a run). It says the probes after that
        // write saw a dirty tree, and a script that refuses one exited early.
        console.log(`  note: the probes left ${out.changed.length} changed path(s) in the scratch copy; every script probed`);
        console.log('        after the first write saw a dirty tree:');
        for (const c of out.changed.slice(0, 10)) console.log(`    ${c}`);
    }
    return verdict(hung, unmeasured);
}

/**
 * An indeterminate result outranks a finding, so a run that could not measure
 * everything never reports a clean 1 ("we looked, one script hangs") over an
 * incomplete population. Same precedence as check-suites-can-fail.js, whose
 * sweep exits 2 with a RED row present. Both counts print either way.
 */
function verdict(hung, unmeasured) {
    if (unmeasured.length) return 2;
    return hung.length ? 1 : 0;
}

// ---------------------------------------------------------------- selftest --

function selftest() {
    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok, detail });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-entrypoints-selftest-'));
    try {
        const root = path.join(tmp, 'root');
        const scripts = path.join(root, 'plugins', 'demo', 'scripts');
        const hooks = path.join(root, 'plugins', 'demo', 'hooks');
        const tooling = path.join(root, 'tooling');
        for (const d of [scripts, hooks, tooling]) fs.mkdirSync(d, { recursive: true });

        // Planted hang: the exact shape of the three real defects, an armed timer.
        fs.writeFileSync(path.join(scripts, 'hang.js'), "setInterval(() => {}, 1000);\n");
        // Control: returns at once.
        fs.writeFileSync(path.join(scripts, 'ok.js'), "console.log('usage: ok'); process.exit(0);\n");
        // A hook that reads stdin to EOF must return when stdin is closed.
        fs.writeFileSync(path.join(hooks, 'stdin-hook.js'),
            "let s=''; process.stdin.on('data', d => s += d).on('end', () => process.exit(0));\n");
        // Non-zero on --help is an answer, not a hang.
        fs.writeFileSync(path.join(tooling, 'usage-exit2.js'), "console.error('usage'); process.exit(2);\n");
        // A suite must be excluded from the population.
        fs.writeFileSync(path.join(tooling, 'test-excluded.js'), "setInterval(() => {}, 1000);\n");
        // The isolation control: writes a marker beside ITSELF. Must land in the copy.
        fs.writeFileSync(path.join(scripts, 'marker.js'),
            "require('fs').writeFileSync(require('path').join(__dirname, 'MARKER.txt'), 'x'); process.exit(0);\n");
        // LIVE known-positive for the ENOBUFS split. This script is talkative,
        // not hung: it returns the instant the write lands. Under the old
        // two-label filter its SIGTERM made it HUNG and failed the gate.
        // Planted rather than only synthesised, because a classifier graded
        // solely on results this file wrote is grading a copy of itself.
        //
        // NO process.exit() HERE, and that is load-bearing, not style. The first
        // version of this fixture ended `write(...); process.exit(0)` and
        // DELIVERED 65,536 BYTES — the exit truncated the pipe at exactly the
        // boundary CLAUDE.md records — so it stayed under the buffer, came back
        // RETURNED, and the assertion failed against a fixture that could not
        // express the condition it exists to produce. Letting the loop drain
        // delivers 8,454,144 and the ENOBUFS kill.
        fs.writeFileSync(path.join(scripts, 'loud.js'),
            "process.stdout.write('x'.repeat(9 * 1024 * 1024));\n");
        // The shape of the two real defects the git repository exposed
        // (check-suites-can-fail.js, mutate-sessions-gate.js): ignores --help,
        // makes a git call first, then does work that outlasts the budget. In a
        // copy with no .git it threw on that call in ~100 ms and read RETURNED.
        // Its stderr is discarded, as mutate-sessions-gate.js discarded it, so no
        // "not a git repository" text is there to match on either way.
        fs.writeFileSync(path.join(tooling, 'git-first.js'),
            "require('child_process').execSync('git rev-parse --verify HEAD', { stdio: ['ignore', 'pipe', 'ignore'] });\n"
            + "setInterval(() => {}, 1000);\n");
        // Makes a directory under os.tmpdir() and returns. It must land in the
        // scratch tmp, where a probe killed at the budget can strand nothing.
        const STRANDED = 'check-entrypoints-selftest-stranded-';
        fs.writeFileSync(path.join(scripts, 'tmp-writer.js'),
            `require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), ${JSON.stringify(STRANDED)}));\n`);
        const strandedInRealTmp = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith(STRANDED));
        const strandedBefore = strandedInRealTmp().length;

        const pop = population(root);
        check('population excludes tooling/test-*.js', !pop.some((p) => /test-excluded/.test(p)) && pop.length === 8, pop.join(','));

        // Decoys: a git hook runs with GIT_DIR and GIT_INDEX_FILE set, and git
        // obeys them from any cwd. If they reached the git calls that build the
        // copy, `git init` would create the decoy repository and `git add` would
        // write the decoy index. Set for this run only.
        const decoyDir = path.join(tmp, 'decoy.git');
        const decoyIndex = path.join(tmp, 'decoy-index');
        const savedGit = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
        let out;
        try {
            process.env.GIT_DIR = decoyDir;
            process.env.GIT_INDEX_FILE = decoyIndex;
            out = run(root, { budgetMs: 1500, keepScratch: true });
        } finally {
            for (const [k, v] of Object.entries(savedGit)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
        check('the run built its scratch repository with GIT_DIR and GIT_INDEX_FILE set',
            out.ok === true, JSON.stringify({ ok: out.ok, reason: out.reason }));
        check('  and neither variable reached git: no decoy repository, no decoy index',
            !fs.existsSync(decoyDir) && !fs.existsSync(decoyIndex), JSON.stringify({ dir: fs.existsSync(decoyDir), index: fs.existsSync(decoyIndex) }));
        const by = Object.fromEntries((out.results || []).map((r) => [path.basename(r.rel), r]));
        check('a script whose default action starts with a git call is probed past it, and HUNG',
            by['git-first.js'] && by['git-first.js'].status === 'HUNG', JSON.stringify(by['git-first.js']));
        check('a probe making a dir under os.tmpdir() makes it in the scratch tmp',
            out.dest && fs.readdirSync(path.join(out.dest, 'tmp')).some((d) => d.startsWith(STRANDED)), out.dest);
        check('  and never in the real tmpdir', strandedInRealTmp().length === strandedBefore, os.tmpdir());
        check('planted setInterval is classified HUNG', by['hang.js'] && by['hang.js'].status === 'HUNG', JSON.stringify(by['hang.js']));
        check('control script is classified RETURNED', by['ok.js'] && by['ok.js'].status === 'RETURNED' && by['ok.js'].code === 0, JSON.stringify(by['ok.js']));
        check('stdin-reading hook returns with stdin closed', by['stdin-hook.js'] && by['stdin-hook.js'].status === 'RETURNED', JSON.stringify(by['stdin-hook.js']));
        check('exit 2 on --help is RETURNED, not HUNG', by['usage-exit2.js'] && by['usage-exit2.js'].status === 'RETURNED' && by['usage-exit2.js'].code === 2, JSON.stringify(by['usage-exit2.js']));

        // The measured defect, live. A script killed for printing past the probe
        // buffer carries signal SIGTERM and NO timeout, and the old filter read
        // only the signal.
        check('a script killed for overflowing the buffer is UNMEASURED, not HUNG',
            by['loud.js'] && by['loud.js'].status === 'UNMEASURED', JSON.stringify(by['loud.js'] && { s: by['loud.js'].status, r: by['loud.js'].reason, sig: by['loud.js'].signal }));
        check('  and the row carries ENOBUFS as its reason rather than leaving it to be guessed',
            by['loud.js'] && by['loud.js'].reason === 'ENOBUFS', by['loud.js'] && String(by['loud.js'].reason));
        check('  and it arrives with the SIGTERM the old filter read as a hang',
            by['loud.js'] && by['loud.js'].signal === 'SIGTERM', by['loud.js'] && String(by['loud.js'].signal));

        // Every shape of the table in the header, asserted directly. The live
        // row above proves these synthetic results are the ones node produces.
        const shapes = [
            ['a clean exit is RETURNED', { status: 0, signal: null }, 'RETURNED', null],
            ['a non-zero exit is still RETURNED', { status: 2, signal: null }, 'RETURNED', null],
            ['our timeout is HUNG', { error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGTERM' }, 'HUNG', 'ETIMEDOUT'],
            ['a spawn that never started is UNMEASURED, NOT returned', { error: { code: 'ENOENT' }, status: null, signal: null }, 'UNMEASURED', 'ENOENT'],
            ['an unrunnable file is UNMEASURED, NOT returned', { error: { code: 'EACCES' }, status: null, signal: null }, 'UNMEASURED', 'EACCES'],
            ['a buffer overflow is UNMEASURED, NOT hung', { error: { code: 'ENOBUFS' }, status: null, signal: 'SIGTERM' }, 'UNMEASURED', 'ENOBUFS'],
            ['a kill from outside this process is UNMEASURED', { status: null, signal: 'SIGKILL' }, 'UNMEASURED', 'signal SIGKILL'],
        ];
        for (const [label, result, want, reason] of shapes) {
            const got = classifyProbe(result);
            check(label, got.status === want && got.reason === reason, JSON.stringify(got));
        }
        // A run that could not build its copy has no copyRoot; the checks below
        // then fail by name instead of the selftest dying on a path.join.
        const markerInCopy = !!out.copyRoot && fs.existsSync(path.join(out.copyRoot, 'plugins', 'demo', 'scripts', 'MARKER.txt'));
        const markerInSource = fs.existsSync(path.join(scripts, 'MARKER.txt'));
        check('a probe that writes beside itself writes into the scratch copy', markerInCopy, out.copyRoot);
        check('and never into the source tree', !markerInSource, scripts);
        // The marker is also the known positive for the changed-path note: the
        // copy was committed clean, so git must see it as the one new path.
        check('the marker shows as a path the probes changed in the copy',
            Array.isArray(out.changed) && out.changed.some((c) => /MARKER\.txt$/.test(c)), JSON.stringify(out.changed));
        {
            const lines = [];
            const origLog = console.log;
            console.log = (...a) => lines.push(a.join(' '));
            try { report(out, false); } finally { console.log = origLog; }
            check('  and the report names it, saying later probes saw a dirty tree',
                /changed path\(s\) in the scratch copy/.test(lines.join('\n')) && /MARKER\.txt/.test(lines.join('\n')), lines.join('\n'));
        }
        if (out.dest) fs.rmSync(out.dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

        // Verdict: one hang makes the run exit 1; removing it makes it exit 0.
        // loud.js comes out FIRST — it is UNMEASURED by design and an UNMEASURED
        // row outranks a hang, so leaving it in would make both of these read 2
        // and neither would be testing the hang transition any more. git-first.js
        // is the other hang, so it goes with hang.js.
        const quiet = { write: () => {} };
        const origLog = console.log; console.log = () => {};
        let code1, code0;
        try {
            fs.rmSync(path.join(scripts, 'loud.js'));
            code1 = report(run(root, { budgetMs: 1500 }), false);
            fs.rmSync(path.join(scripts, 'hang.js'));
            fs.rmSync(path.join(tooling, 'git-first.js'));
            code0 = report(run(root, { budgetMs: 1500 }), false);
        } finally { console.log = origLog; void quiet; }
        check('verdict is exit 1 with a hang in the population', code1 === 1, String(code1));
        check('verdict is exit 0 once the hang is removed', code0 === 0, String(code0));

        // An UNMEASURED row is never a pass, is never counted into `returned`,
        // and outranks a hang so an incomplete run cannot report a clean finding.
        console.log = () => {};
        let codeU, codeBoth, humanU;
        const rows = (extra) => ({ ok: true, budgetMs: 1500, root, results: [
            { rel: 'a.js', status: 'RETURNED', reason: null, code: 0, ms: 5, tail: '' },
            { rel: 'b.js', status: 'UNMEASURED', reason: 'ENOBUFS', code: null, signal: 'SIGTERM', ms: 7, tail: 'usage' },
            ...extra,
        ] });
        try {
            codeU = report(rows([]), false);
            codeBoth = report(rows([{ rel: 'c.js', status: 'HUNG', reason: 'ETIMEDOUT', code: null, ms: 1500, tail: '' }]), false);
            const lines = [];
            console.log = (...a) => lines.push(a.join(' '));
            report(rows([]), false);
            humanU = lines.join('\n');
        } finally { console.log = origLog; }
        check('an UNMEASURED row is exit 2, never a pass', codeU === 2, String(codeU));
        check('  and outranks a hang, so an incomplete run never reports a clean 1', codeBoth === 2, String(codeBoth));
        check('  and is counted apart from returned, not folded into it', /1 returned, 0 hung, 1 unmeasured/.test(humanU), humanU.split('\n')[0]);
        check('  and is never worded as a finding about the script',
            /NOT a finding about the script/.test(humanU) && !/HUNG      b\.js/.test(humanU), humanU);
        check('  and names the carried reason so a reader knows what to do', /ENOBUFS  b\.js/.test(humanU), humanU);
        let jsonU = '';
        try {
            console.log = (...a) => { jsonU += a.join(' '); };
            report(rows([]), true);
        } finally { console.log = origLog; }
        check('  and --json reports it as its own field, with the reason',
            (() => { try { const j = JSON.parse(jsonU); return j.returned === 1 && j.hung.length === 0
                && j.unmeasured.length === 1 && j.unmeasured[0].reason === 'ENOBUFS'; } catch (e) { return false; } })(), jsonU.slice(0, 200));
        console.log = () => {};
        let code2;
        try { code2 = report({ ok: false, reason: 'no population', root: tmp }, false); } finally { console.log = origLog; }
        check('empty population is exit 2, never a pass', code2 === 2, String(code2));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    const failed = results.filter((r) => !r.ok);
    for (const r of results) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '\n        ' + r.detail));
    console.log(`population: ${results.length} assertions run, ${results.length - failed.length} passed, ${failed.length} failed`);
    process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
    if (has('--help') || has('-h')) {
        console.log('usage: node tooling/check-entrypoints.js [--budget-ms N] [--root DIR] [--json] [--selftest]');
        process.exit(0);
    }
    if (has('--selftest')) selftest();
    else process.exit(report(run(path.resolve(val('--root', DEFAULT_ROOT))), has('--json')));
}

module.exports = { population, run, probe, classifyProbe, report };
