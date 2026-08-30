#!/usr/bin/env node
// check-suites-can-fail.js — does each test suite actually fail when the thing
// it tests is broken?
//
// This repo keeps writing the rule "a gate nobody has watched fire is a
// hypothesis" and then hand-canarying one change at a time. This runs the check
// for every suite at once, so a suite that quietly stops testing anything gets
// caught the day it happens rather than the day someone happens to try.
//
// It is not subtle. For each suite it finds the source file(s) that suite
// exercises, replaces each with a STUB that still parses and still exports the
// right shape but does nothing, and asserts the suite goes red. A suite that
// stays green against a stub is testing nothing.
//
// This is the coarsest possible mutation: if a suite survives it, no finer
// mutation will find anything either. It is deliberately not full mutation
// testing — that is slow, noisy, and the failure this repo has actually hit
// twice was total (a signature mismatch that made every suite spawn a bare
// `node`, and a binary-file guard written as `includes(' ')`).
//
// Every file is restored from git afterwards and the tree is verified clean.
//
// Usage: node tooling/check-suites-can-fail.js [--verbose]

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

// DERIVED, not declared. The first version of this file hand-listed which source
// each suite tests, and got it wrong for three of twelve — twice producing a
// STALE row pointing at a file that does not exist, and once accusing a suite of
// being vacuous when the accusation was really "you mapped me to a file I never
// touch". A map of guesses is exactly the failure this script exists to find,
// one level up.
//
// So: read what the suite actually references. Every suite in this repo names
// its subject as a path literal — `hooks/stop-auto-check.js`,
// `'..','plugins','autodev-memory','hooks','memory-capture.js'`, or a require of
// a relative path. Collect all three shapes and resolve them against the repo.
const SUBJECT_OVERRIDES = {
    // Only for a suite whose subject genuinely cannot be read off its source.
    //
    // Derivation looks for plugin sources, because that is what every suite
    // tested until now. These two test TOOLING instead — a shell hook and the
    // validator — so they derived nothing and were reported NO-SUBJECT, which
    // means this script was silently not checking them at all. That is the
    // "silent skip" failure this whole file exists to prevent, reappearing in it.
    'test-githooks.js': ['tooling/githooks/commit-msg'],
    'test-validate.js': ['tooling/validate.js'],

    // Third time, 2026-08-30, and it arrived exactly as the comment above
    // predicts: a new suite testing tooling/ derived nothing and was counted
    // NOT verified. It was not caught locally because `npm test` does not run
    // this script; CI runs it as a separate step. So the suite that gates
    // pushes was itself the unchecked one.
    'test-push-authorisation.js': ['tooling/check-push-authorisation.js'],

    // Fourth time, 2026-08-30, four at once: the codex-audit acceptance suites
    // all test tooling/ checkers, so all derived nothing. The pattern is now
    // structural - every acceptance test for a TOOLING gate lands here - and
    // the honest fix remains this list plus the UNCHECKED failure below, not a
    // smarter deriver that guesses.
    'test-vacuity-exit.js': ['tooling/find-vacuous-assertions.js'],
    'test-function-json-exit.js': ['tooling/find-untested-functions.js'],
    'test-runtime-authority.js': ['tooling/check-runtime.js'],
    'test-hook-execution-evidence.js': ['tooling/find-untested-hooks.js'],

    // Same failure, found again 2026-08-21 — and found by reading this comment
    // rather than the output, because NO-SUBJECT's note ("references no plugin
    // source — nothing to stub") reads like a category of suite that has nothing
    // to check. It is not. It is the silent-skip signature, and three more
    // tooling suites were sitting behind it, unverified, while the summary line
    // said "0 cannot fail".
    //
    // If you add a suite over anything in tooling/, it lands here or it is not
    // checked at all. deriveSubjects() only scans plugins/ and templates/.
    'test-runner-guard.js': ['tooling/test-all.js'],
    'test-superseded.js': ['tooling/check-superseded.js'],
    'test-version-drift.js': ['tooling/check-version-drift.js'],

    // Found by the same reading, 2026-08-29. Both name their subject on one
    // clear line — `const SUBJECT = path.resolve(__dirname, 'find-record-drift.js')`
    // and `const GATE = path.resolve(__dirname, 'test-skill-prd-commands.js')` —
    // and both were waved through as NO-SUBJECT for the documented reason:
    // deriveSubjects() scans plugins/ and templates/ only, so a suite over
    // tooling/ is invisible to it however plainly it is written.
    'test-record-drift.js': ['tooling/find-record-drift.js'],
    'test-skill-prd-commands-selftest.js': ['tooling/test-skill-prd-commands.js'],
    // Added with the suite itself, because this file said so: a suite over
    // anything in tooling/ lands here or it is not verified at all. It refused
    // the suite on its first run and named the remedy, which is the behaviour
    // the comment above was written to produce.
    'test-no-private-names.js': ['tooling/check-no-private-names.js'],
};

/**
 * Suites whose subject is NOT JavaScript, and so cannot be stubbed by anything
 * this script does.
 *
 * This is the one honest category between "verified" and "silently skipped", and
 * it is deliberately hard to enter. An entry must NAME the suite that canaries
 * it instead, that suite must exist, and it must itself be checked — so an
 * exemption can only be claimed by pointing at coverage that is real and is
 * being verified here. A bare "cannot check this one" is not accepted, because
 * that is an excuse list, and #84 landed the same day on precisely the
 * principle that a gate must not carry a category meaning "waved through".
 *
 * test-skill-prd-commands.js executes the inline `node -e` commands embedded in
 * SKILL.md files. Its subject is markdown. Stubbing it with JavaScript would
 * corrupt the file and turn the suite red for the wrong reason, which is a
 * canary firing on the wrong stimulus — worse than no canary, because it reads
 * as coverage. What actually proves it can fail is its selftest, which feeds it
 * a SKILL.md whose command is known-broken and asserts the gate goes red.
 */
const NOT_JAVASCRIPT = {
    'test-skill-prd-commands.js': {
        subject: 'the inline node -e commands inside plugins/*/skills/*/SKILL.md',
        canary: 'test-skill-prd-commands-selftest.js',
    },
};

function deriveSubjects(suiteFile) {
    const src = fs.readFileSync(suiteFile, 'utf8');
    const found = new Set();

    // 1. A slash-separated path literal inside the repo: 'plugins/…/foo.js'
    for (const m of src.matchAll(/['"`]((?:\.\.\/)*(?:plugins|templates)\/[\w./-]+\.js)['"`]/g)) {
        found.add(m[1].replace(/^(\.\.\/)+/, ''));
    }
    // 2. path.join / path.resolve segment lists: 'plugins', 'autodev-core', 'hooks', 'x.js'
    for (const m of src.matchAll(/path\.(?:join|resolve)\(([^)]*)\)/g)) {
        const parts = [...m[1].matchAll(/['"`]([\w.-]+)['"`]/g)].map((x) => x[1]);
        const i = parts.indexOf('plugins');
        if (i >= 0 && parts[parts.length - 1].endsWith('.js')) {
            found.add(parts.slice(i).join('/'));
        }
    }
    // 3. A bare require of a repo-relative module, with or without .js
    for (const m of src.matchAll(/require\(['"`]((?:\.\.\/)+[\w./-]+)['"`]\)/g)) {
        const p = m[1].replace(/^(\.\.\/)+/, '');
        if (/^(plugins|templates)\//.test(p)) found.add(p.endsWith('.js') ? p : p + '.js');
    }

    // 4. A bare BASENAME, for suites that build the path in two steps:
    //      const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
    //      const HOOK        = path.join(PLUGIN_ROOT, 'hooks', 'stop-auto-check.js');
    //    Rules 1-3 see neither half. Four of twelve suites are written this way,
    //    and without this they derive nothing and get waved through as
    //    NO-SUBJECT — the silent-skip failure this whole script is about.
    //
    //    Safe because it demands a UNIQUE match: a basename resolving to two
    //    files under plugins/ is ambiguous and ignored rather than guessed.
    //
    //    The character class allows DOTS, and that is not cosmetic. It was
    //    `[\w-]+\.js`, which cannot match a basename carrying a second dot, so
    //    every `*.workflow.js`, `*.config.js` and `*.test.js` in the tree was
    //    invisible to this rule. `[measured 2026-08-29]` that is exactly how
    //    test-workflow-isolation.js came back NO-SUBJECT while naming
    //    `heal-sweep.workflow.js` on one line — reported as a suite with nothing
    //    to check, which is the silent-skip signature this rule exists to close,
    //    reappearing inside the rule itself.
    for (const m of src.matchAll(/['"`]([\w.-]+\.js)['"`]/g)) {
        const hits = allPluginFiles().filter((p) => path.basename(p) === m[1]);
        if (hits.length === 1) found.add(hits[0]);
    }

    return [...found].filter((p) => fs.existsSync(path.join(ROOT, p)));
}

let _pluginFiles = null;
function allPluginFiles() {
    if (_pluginFiles) return _pluginFiles;
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const rel = dir + '/' + e.name;
            if (e.isDirectory()) walk(rel);
            else if (e.name.endsWith('.js')) out.push(rel);
        }
    };
    for (const top of ['plugins']) {
        if (fs.existsSync(path.join(ROOT, top))) walk(top);
    }
    return (_pluginFiles = out);
}

// A stub that parses, does nothing, and exports nothing.
//
// NO process.exit() — the first version had one, and it made this checker lie.
// A suite that `require()`s its subject runs the stub IN ITS OWN PROCESS, so
// `process.exit(0)` killed the test runner before a single assertion ran and the
// suite "passed". Two suites were reported VACUOUS on that basis and neither
// was. A checker whose failure mode is a false accusation is worse than none;
// this one caught itself on its first run.
//
// Spawned subjects still exit 0 here — a script with no code does — so dropping
// the call costs nothing and removes the trap.
const STUB = `#!/usr/bin/env node
// STUB installed by check-suites-can-fail.js — restored immediately.
module.exports = {};
`;

// Every mid-sweep collision this run detects, in one place, because a detected
// conflict must poison the VERDICT, not just print a line (Sol's round-7
// blocker: a sweep that says "left alone, carrying on" measured later suites
// against a tree it knows was modified, then exited 0 under a "tree restored
// clean" banner). Any entry here makes the whole run INDETERMINATE, exit 2.
const conflicts = [];
const conflict = (msg) => { conflicts.push(msg); console.error('  [CONFLICT] ' + msg); };

// The mutation engine. Rounds 6-8 tried to make read-copy-write restores
// safe and each round found the next window, because copying bytes back is
// the wrong primitive. This engine NEVER rewrites an original:
//
//   install: the original is renamed aside — one atomic syscall that also
//            preserves its mode bits (Sol's round-9 blocker: a recreated
//            commit-msg lost its 100755) — and the stub is created with
//            O_EXCL, which refuses rather than replaces a recreated path.
//            The original's bytes are never read, copied, or rewritten.
//   remove:  our stub is unlinked only if the live file still IS our stub
//            (anything else is captured aside under a unique name, never
//            destroyed — Sol's round-9 blocker: a reused capture name could
//            overwrite an earlier capture on POSIX); the original returns
//            via link(), which fails EEXIST rather than replacing a file a
//            writer recreated in the gap. Same inode, same mode, nothing
//            copied.
//
// Every unexpected state is a conflict, and a crash leaves the original ON
// DISK beside the stub as `<file>.orig-<pid>-<n>` — recoverable by rename,
// with nothing to reconstruct. Exceptions are conflicts too: a throw here
// must never exit as an ordinary failure with a mutant still in place.
let seq = 0;
const installedNow = new Map();   // rel -> { full, orig, expect }
function installOwn(rel, full, content) {
    const orig = full + '.orig-' + process.pid + '-' + (++seq);
    try {
        fs.renameSync(full, orig);
    } catch (e) {
        conflict(`could not set ${rel} aside to stub it (${e.code || e.message})`);
        return false;
    }
    try {
        fs.writeFileSync(full, content, { flag: 'wx' });
    } catch (e) {
        conflict(`${rel} was recreated while being stubbed (${e.code || e.message})`);
        try { fs.renameSync(orig, full); } catch (e2) {
            conflict(`and returning its original threw ${e2.code || e2.message} — original is at ${path.basename(orig)}`);
        }
        return false;
    }
    installedNow.set(rel, { full, orig, expect: Buffer.from(content) });
    return true;
}
function removeOwn(rel) {
    const rec = installedNow.get(rel);
    if (!rec) return;
    installedNow.delete(rel);
    try {
        let live = null;
        try { live = fs.readFileSync(rec.full); } catch { /* absent */ }
        if (live && live.equals(rec.expect)) {
            fs.unlinkSync(rec.full);
        } else if (live) {
            const cap = rec.full + '.swept-' + process.pid + '-' + (++seq);
            fs.renameSync(rec.full, cap);
            conflict(`${rel} held foreign content at restore — captured to ${path.basename(cap)}, nothing lost`);
        } else {
            conflict(`${rel} was deleted by something else while stubbed`);
        }
        try {
            fs.linkSync(rec.orig, rec.full);   // refuses (EEXIST) rather than replaces
            fs.unlinkSync(rec.orig);
        } catch (e) {
            conflict(`${rel} was recreated before its original could return (${e.code || e.message})`
                + ` — original preserved at ${path.basename(rec.orig)}`);
        }
    } catch (e) {
        conflict(`restore of ${rel} threw ${e.code || e.message} — original is at ${path.basename(rec.orig)}`);
    }
}

// A child run only counts — as a red OR a green — if it actually ran to
// completion. A timeout, signal, or spawn failure is not a verdict about the
// suite (Sol's round-9 blocker: a killed child satisfied `status !== 0` and
// was scored as a successful canary), it is a failure OF THIS SWEEP, so it
// poisons the run instead of feeding either branch.
function completed(r, what) {
    if (r.error) { conflict(`${what} did not run (${r.error.code || r.error.message})`); return false; }
    if (r.signal) { conflict(`${what} was killed by ${r.signal} before completing`); return false; }
    return true;
}

const git = (args) => execSync('git ' + args, { cwd: ROOT, encoding: 'utf8' });

// Refuse to run on a dirty tree: this script writes stubs over real files and
// restores them with `git checkout --`, which would destroy uncommitted work.
const dirty = git('status --porcelain').trim();
if (dirty) {
    console.error('\nRefusing to run: the working tree has uncommitted changes.\n');
    console.error('This script overwrites source files with stubs and restores them from git,');
    console.error('which would discard your edits. Commit or stash first.\n');
    console.error(dirty.split('\n').slice(0, 10).join('\n'));
    process.exit(2);
}

// ONE SWEEP PER TREE, ENFORCED (Sol's round-6 blocker). The zz- cleanup below
// diffs the untracked set per suite, so two concurrent sweeps in one tree
// would each see the other's fresh fixture as their own orphan and delete it
// mid-use — until now "a mutation sweep needs the repo to itself" was prose,
// not a mechanism. The lock lives in tmpdir, keyed on the resolved ROOT, so
// distinct worktrees still sweep independently and the end-of-run clean-tree
// assertion never sees the lock file itself. A dead holder is detected by pid
// liveness and replaced: this repo had an orphaned sweep outlive its session
// the same day this was written, and a lock that survives its owner would
// otherwise block every future run.
const os = require('os');
const crypto = require('crypto');
const LOCK = path.join(os.tmpdir(), 'check-suites-'
    + crypto.createHash('sha1').update(fs.realpathSync(ROOT)).digest('hex').slice(0, 12) + '.lock');
// The lock's second line is a per-run NONCE. It is what children prove
// themselves with: AUTODEV_SWEEP_CHILD must carry this exact value, read
// back from the LIVE lock, to be honoured (Sol's round-8 blocker: a bare
// boolean env var was an unauthenticated bypass of both exclusion guards —
// any process that happened to inherit or set it walked straight through).
const NONCE = crypto.randomBytes(8).toString('hex');

(function acquireLock() {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            fs.writeFileSync(LOCK, process.pid + '\n' + NONCE, { flag: 'wx' });
            process.on('exit', () => {
                // Unlink only a lock that is still OURS. If a takeover stole
                // it (a bug, but a survivable one), deleting the thief's lock
                // here would let a third sweep in (Sol's round-8 blocker).
                try {
                    const cur = fs.readFileSync(LOCK, 'utf8');
                    if (parseInt(cur, 10) === process.pid) fs.unlinkSync(LOCK);
                } catch { /* already gone */ }
            });
            return;
        } catch {
            let raw = null;
            try { raw = fs.readFileSync(LOCK, 'utf8'); } catch { continue; /* vanished — retry wx */ }
            const holder = parseInt(raw, 10);
            let alive = false;
            if (Number.isFinite(holder)) {
                try { process.kill(holder, 0); alive = true; } catch { alive = false; }
            }
            if (alive) {
                console.error('\nRefusing to run: another sweep (pid ' + holder + ') holds this tree.');
                console.error('A mutation sweep needs the repo to itself; wait for it or kill it, then re-run.\n');
                process.exit(2);
            }
            // NO automatic takeover. Rounds 7 and 8 each closed one takeover
            // race and each review found the next (delete a rival's fresh
            // lock; steal a live lock; a third contender arriving during the
            // put-back), because automatic reclamation of a shared exclusion
            // token is where the races LIVE. The convenience was never worth
            // it: a stale lock means a sweep CRASHED here, which a human
            // should see anyway. So a dead holder is reported with the exact
            // recovery command, and the operator — who can actually verify
            // nothing is running — deletes the file.
            console.error('\nRefusing to run: a STALE sweep lock is present (holder pid '
                + holder + ' is not running).');
            console.error('A previous sweep died without cleaning up. After confirming no sweep');
            console.error('is running in this tree, delete this file and re-run:');
            console.error('\n  ' + LOCK + '\n');
            process.exit(2);
        }
    }
    console.error('\nCould not acquire the sweep lock at ' + LOCK + ' — refusing to run.\n');
    process.exit(2);
})();

// Anything that escapes past the conflict handling above must still land as
// INDETERMINATE with the tree's state named — never as an ordinary crash
// whose exit status hides that mutants may be in place (Sol's round-9
// blocker). Originals set aside by the engine survive on disk as
// `.orig-<pid>-<n>` files, so the report names what recovery needs.
process.on('uncaughtException', (e) => {
    console.error('\nUNCAUGHT: ' + (e && e.stack || e));
    for (const [rel, rec] of installedNow) {
        console.error('  stub possibly still in place: ' + rel + ' (original at ' + path.basename(rec.orig) + ')');
    }
    console.error('\nINDETERMINATE — the sweep died mid-run; the tree may hold mutants.');
    console.error('Recover with: git status, then rename each .orig-* file back over its subject.\n');
    process.exit(2);
});

// The sweep lock excludes other SWEEPS. A plain `npm test` run in this tree is
// just as fatal to the untracked-diff cleanup — test-validate's child creates
// zz-spawn-fixture.js, which a concurrent sweep would see as its own suite's
// orphan and delete mid-use (Sol's round-7 blocker). test-all.js announces
// itself with a per-pid lock in the same tmpdir namespace; a live one here
// means a test run is in flight, and this sweep refuses rather than measuring
// a tree someone else is exercising. Dead pids are stale crash leftovers and
// are cleaned. test-all children spawned BY this sweep are exempt via
// AUTODEV_SWEEP_CHILD, so checkRunner below still works.
{
    const prefix = path.basename(LOCK).replace(/\.lock$/, '');
    for (const f of fs.readdirSync(os.tmpdir())) {
        if (!f.startsWith(prefix + '.test-') || !f.endsWith('.lock')) continue;
        const p = path.join(os.tmpdir(), f);
        let holder = NaN;
        try { holder = parseInt(fs.readFileSync(p, 'utf8'), 10); } catch { /* unreadable */ }
        let alive = false;
        if (Number.isFinite(holder)) {
            try { process.kill(holder, 0); alive = true; } catch { alive = false; }
        }
        if (alive) {
            console.error('\nRefusing to run: a test run (pid ' + holder + ') is in flight in this tree.');
            console.error('Its suites create zz- fixtures this sweep\'s cleanup would misattribute.');
            console.error('Wait for it to finish, then re-run.\n');
            process.exit(2);
        }
        try { fs.unlinkSync(p); } catch { /* raced */ }
    }
}

const suites = fs.readdirSync(__dirname)
    .filter((f) => /^test-.*\.js$/.test(f))
    .sort();

// AUTODEV_SWEEP_CHILD carries this run's lock nonce to every process the
// sweep spawns (and their children), so a test-all.js run BY the sweep
// neither refuses under the sweep lock nor announces a test lock of its
// own. It is honoured only when it matches the nonce in the LIVE lock —
// a stale or fabricated value proves nothing and is ignored.
// 15 minutes, not 5. A timeout KILLS the child, and a killed suite that
// mutates files for its own canaries (test-hook-execution-evidence.js
// prepends to a target suite and restores on exit) never runs its restore —
// the sweep then correctly reports its own kill as a mid-sweep conflict and
// goes INDETERMINATE, which is exactly what happened when the heaviest
// suite blew a 300s budget on a loaded machine. The generous budget is the
// fix; the conflict detection stays as the backstop for a genuine hang.
const runSuite = (suite) => spawnSync(process.execPath, [path.join(__dirname, suite)], {
    cwd: ROOT, encoding: 'utf8', timeout: 900000,
    env: { ...process.env, AUTODEV_SWEEP_CHILD: NONCE },
});

const rows = [];

// The runner is checked differently, and it matters more than any single suite.
//
// test-all.js has no subject to stub — it runs the others. It is also the file
// that HAS failed this way: it was declared `run(label, file, args)` and called
// as `run(label, [...])`, so `args` was undefined and every suite spawned a bare
// `node`. Twelve suites reported PASS having executed nothing, and CI was green
// on an empty test run.
//
// So: make one child suite fail, and assert the runner notices.
function checkRunner(suite) {
    const victim = suites.find((s) => s !== suite && deriveSubjects(path.join(__dirname, s)).length);
    if (!victim) return { suite, status: 'NO-SUBJECT', note: 'no child suite to fail' };

    const full = path.join(__dirname, victim);
    const CANARY = '#!/usr/bin/env node\nconsole.log("canary");\nprocess.exit(1);\n';
    if (!installOwn('tooling/' + victim, full, CANARY)) {
        return { suite, status: 'UNCHECKED', note: 'could not install the runner canary — see conflicts' };
    }
    try {
        const r = runSuite(suite);
        if (!completed(r, suite + ' (runner canary run)')) {
            return { suite, status: 'UNCHECKED', note: 'canary run did not complete — indeterminate, not a verdict' };
        }
        return r.status !== 0
            ? { suite, status: 'ok', note: `reports failure when ${victim} fails` }
            : { suite, status: 'VACUOUS', note: `stays GREEN while ${victim} exits 1 — it is not running them` };
    } finally {
        removeOwn('tooling/' + victim);
    }
}

// validate.js is a gate too, and it is not a test-*.js file so the loop below
// never sees it. It guards plugin structure, version sync, hook wiring and the
// private-names denylist — the checks that stop a broken marketplace shipping —
// and until now nothing proved it could fail.
//
// Its subject is the repo itself, so the mutation is a repo mutation: break the
// version sync, which every plugin manifest depends on, and assert it goes red.
function checkValidator() {
    const suite = 'validate.js';
    const file = path.join(ROOT, 'VERSION');
    if (!fs.existsSync(file)) return { suite, status: 'NO-SUBJECT', note: 'no VERSION file' };

    const run = () => spawnSync(process.execPath, [path.join(__dirname, 'validate.js')], {
        cwd: ROOT, encoding: 'utf8', timeout: 900000,
        env: { ...process.env, AUTODEV_SWEEP_CHILD: NONCE },
    });
    const base = run();
    if (!completed(base, 'validate (baseline)')) return { suite, status: 'UNCHECKED', note: 'baseline did not complete — indeterminate' };
    if (base.status !== 0) return { suite, status: 'RED', note: 'already failing' };

    const CANARY = '0.0.0-canary\n';
    if (!installOwn('VERSION', file, CANARY)) {
        return { suite, status: 'UNCHECKED', note: 'could not install the VERSION canary — see conflicts' };
    }
    try {
        const r = run();
        if (!completed(r, 'validate (VERSION canary run)')) {
            return { suite, status: 'UNCHECKED', note: 'canary run did not complete — indeterminate, not a verdict' };
        }
        return r.status !== 0
            ? { suite, status: 'ok', note: 'goes red on a version-sync break' }
            : { suite, status: 'VACUOUS', note: 'stays GREEN with VERSION desynced from every manifest' };
    } finally {
        removeOwn('VERSION');
    }
}

rows.push(checkValidator());

for (const suite of suites) {
    if (suite === 'test-all.js') { rows.push(checkRunner(suite)); continue; }

    // A non-JavaScript subject, and the claim is CHECKED rather than believed.
    // The named canary must exist and must be a suite this run is checking; if
    // it is not, the exemption is refused and the row falls through to UNCHECKED
    // exactly as if it had never been declared. That is what stops this becoming
    // the excuse list the comment on NOT_JAVASCRIPT warns about — a declaration
    // pointing at nothing is worth nothing, and says so out loud.
    const exempt = NOT_JAVASCRIPT[suite];
    if (exempt) {
        const canaryExists = fs.existsSync(path.join(__dirname, exempt.canary));
        const canaryChecked = suites.includes(exempt.canary);
        if (canaryExists && canaryChecked) {
            rows.push({
                suite,
                status: 'NOT-JS',
                note: 'subject is ' + exempt.subject + ' — canaried by ' + exempt.canary,
            });
        } else {
            rows.push({
                suite,
                status: 'UNCHECKED',
                note: 'declared NOT_JAVASCRIPT but its canary ' + exempt.canary
                    + (canaryExists ? ' is not among the suites run' : ' does not exist')
                    + ' — the exemption is REFUSED, so this suite is NOT verified.',
            });
        }
        continue;
    }

    const subjects = SUBJECT_OVERRIDES[suite] || deriveSubjects(path.join(__dirname, suite));
    if (!subjects.length) {
        // Worded as a deficiency, and counted as a failure, because the previous
        // wording — "references no plugin source — nothing to stub" — read as a
        // considered exemption. Two readers in one day took it that way and
        // reported "0 cannot fail" over three unchecked suites. A gate that skips
        // silently and labels the skip reassuringly converts ABSENT coverage into
        // REPORTED coverage, which is strictly worse than having no opinion.
        rows.push({
            suite,
            status: 'UNCHECKED',
            note: 'subject not derived — this suite is NOT verified. Add it to SUBJECT_OVERRIDES.',
        });
        continue;
    }

    // Any run of the suite from here on - baseline OR stubbed - can be killed
    // on timeout, and no in-process finally survives a kill. Measured twice on
    // 2026-08-30: a killed test-validate BASELINE run (not a stubbed one)
    // orphaned zz-spawn-fixture.js in the real hooks/ dir, and the end-of-run
    // restore cannot remove untracked files, so the whole sweep exited 2 with
    // no verdict. Snapshot the untracked set once per suite and remove only
    // what is NEW; the finally fires on every continue below.
    const untrackedBefore = new Set(git('status --porcelain').split('\n')
        .filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim()));
    // OWNERSHIP IS EXPLICIT, never inferred (Sol's round-4 and round-5
    // blockers, in sequence). Round 4 deleted any new untracked path; round 5
    // showed zone-scoping still deletes a CONCURRENT session's new files,
    // because plugins/ and tooling/ are exactly where sessions work. So the
    // contract is a naming convention: a suite's disposable fixture has a
    // `zz-` basename prefix (test-validate's zz-spawn-fixture.js already
    // does), and ONLY new untracked zz-files are removed. Anything else new
    // is reported and left - if it is a real orphan, the end-of-run tree
    // check names it and a human decides.
    const cleanNewUntracked = () => {
        for (const line of git('status --porcelain').split('\n')) {
            if (!line.startsWith('?? ')) continue;
            const p = line.slice(3).trim();
            if (untrackedBefore.has(p)) continue;
            if (!path.basename(p).startsWith('zz-')) {
                console.error(`  [left alone] new untracked ${p} — not a zz- disposable fixture, so not this sweep's to delete`);
                continue;
            }
            console.error(`  [removed] orphaned fixture ${p} (appeared during ${suite}, absent from the pre-run snapshot)`);
            try { fs.rmSync(path.join(ROOT, p), { recursive: true, force: true }); } catch { /* the tree check below still backstops */ }
        }
    };
    try {

    // Baseline: it must be green before the mutation means anything — and it
    // must have actually RUN. A timed-out or signalled baseline is not a red.
    const base = runSuite(suite);
    if (!completed(base, suite + ' (baseline)')) {
        rows.push({ suite, status: 'UNCHECKED', note: 'baseline did not complete — indeterminate, not a verdict' });
        continue;
    }
    if (base.status !== 0) {
        rows.push({ suite, status: 'RED', note: 'already failing — fix it before trusting this result' });
        continue;
    }

    // VACUOUS only if stubbing EVERY derived subject leaves it green.
    //
    // Not "any subject survived". A suite legitimately references files it does
    // not exercise — test-knowledge-injection names observation-classifier.js in
    // a comment explaining that it DELIBERATELY does not copy it, so stubbing
    // that file cannot and should not turn the suite red. Demanding every
    // subject kill the suite would report that as vacuous, which is the same
    // false-accusation failure the stub's process.exit() produced.
    //
    // The property under test is "this suite can fail", and one killed subject
    // proves it.
    const killed = [];
    let incomplete = false;
    for (const rel of subjects) {
        const full = path.join(ROOT, rel);
        if (!installOwn(rel, full, STUB)) { incomplete = true; continue; }
        try {
            const r = runSuite(suite);
            if (!completed(r, suite + ' (with ' + rel + ' stubbed)')) incomplete = true;
            else if (r.status !== 0) killed.push(rel);
        } finally {
            removeOwn(rel);
        }
    }

    // VACUOUS is an accusation, and it needs every stub run to have actually
    // completed — a run that was killed proves nothing about the suite.
    rows.push(killed.length
        ? { suite, status: 'ok', note: `goes red when ${killed.length}/${subjects.length} subject(s) are stubbed` }
        : (incomplete
            ? { suite, status: 'UNCHECKED', note: 'stub run(s) did not complete — indeterminate, not a verdict' }
            : { suite, status: 'VACUOUS', note: `stays GREEN with all ${subjects.length} subject(s) stubbed out` }));

    } finally { cleanNewUntracked(); }
}

// The restore is the dangerous part; prove it worked rather than assuming.
// Every original this run set aside was returned by the engine's finallys;
// anything still recorded here means a code path above skipped its
// removeOwn, so try once more — the .orig file is the original, on disk,
// and returning it is a rename, never a copy and never a checkout (rounds
// 4 through 8 each found a way for checkout-based recovery to replace a
// file some other writer had just recreated; this recovery cannot, because
// removeOwn places files with link(), which refuses over an existing path).
for (const rel of [...installedNow.keys()]) {
    conflict(rel + ' was still stubbed at end of run — a code path skipped its restore');
    removeOwn(rel);
}

const after = git('status --porcelain').trim();
if (after) {
    console.error('\nTREE NOT CLEAN after the sweep:\n' + after);
    // Nothing here is this sweep's to fix: its own artifacts were returned
    // above (or reported as conflicts with the original's location named),
    // so remaining dirt is either a mid-sweep foreign change or a preserved
    // capture — both already make the run indeterminate.
    for (const l of after.split('\n')) {
        conflict('tree not clean after the sweep: ' + l.trim());
    }
}

console.log('\nCan each suite fail?\n');
let bad = 0;
for (const r of rows) {
    // Anything that is not 'ok' means this script did not establish that the
    // suite can fail. There is no third category: a skip is an absence of
    // evidence, and printing it beside the passes is how it gets read as one.
    // NOT-JS is the ONE status that is neither a pass nor a deficiency, and the
    // rule above still holds for it: this script did not establish that the
    // suite can fail, so it is NOT counted among the verified. It is counted and
    // named on its own, because the coverage does exist and is proven by a
    // canary this same run checks — see NOT_JAVASCRIPT, where the exemption is
    // refused outright unless that canary is present and among the suites run.
    // Marked '~' rather than '✓' so it can never be skimmed as a pass.
    const mark = r.status === 'ok' ? '✓' : (r.status === 'NOT-JS' ? '~' : '✗');
    if (r.status !== 'ok' && r.status !== 'NOT-JS') bad++;
    console.log(`  ${mark} ${r.suite.padEnd(30)} ${r.status.padEnd(9)} ${VERBOSE || r.status !== 'ok' ? r.note : ''}`);
}
const unchecked = rows.filter((r) => r.status === 'UNCHECKED' || r.status === 'NO-SUBJECT').length;
const notJs = rows.filter((r) => r.status === 'NOT-JS').length;
const verified = rows.length - bad - notJs;
console.log(`\n${rows.length} suite(s) · ${verified} verified able to fail · ${bad} NOT verified` +
            (unchecked ? ` (${unchecked} with no derivable subject)` : '') +
            (notJs ? ` · ${notJs} canaried elsewhere, not stubbable here` : '') +
            (conflicts.length ? '' : ' · tree restored clean') + '\n');

// A detected mid-sweep conflict poisons every verdict above: suites that ran
// after the tree changed were measured against a tree this script knows it
// did not control. Indeterminate (2) outranks findings (1), because a finding
// from a contaminated run is not a finding.
if (conflicts.length) {
    console.log('INDETERMINATE — ' + conflicts.length + ' mid-sweep conflict(s) detected:');
    for (const c of conflicts) console.log('  · ' + c);
    console.log('The verdicts above were measured on a tree that changed under this sweep.');
    console.log('Re-run when the tree is quiet.\n');
    process.exit(2);
}
process.exit(bad ? 1 : 0);
