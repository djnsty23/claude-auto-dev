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
//
// DERIVATION READS tooling/ TOO, since 2026-09-03. Before that it scanned
// plugins/ and templates/ only, so a suite testing tooling/ derived nothing
// however plainly it named its subject, was reported as having no subject, and
// was hand-registered below. That happened six times, and the comment sitting
// here predicted each occurrence before it arrived. Predictions that keep coming
// true are an argument for fixing derivation, not for maintaining the list they
// keep extending.
//
// Two rules carry it, and neither GUESSES — which matters, because the comment
// this replaces argued that the honest fix was a list rather than "a smarter
// deriver that guesses", and it was right about guessing:
//
//   · tooling/ joins plugins/ and templates/ wherever a path is written out in
//     full: as a literal, as path.join/resolve segments, or as a require.
//   · a suite's OWN directory resolves its own-directory references. A suite
//     lives in tooling/, so `path.resolve(__dirname, 'check-foo.js')` and
//     `require('./check-foo.js')` ARE tooling/check-foo.js. That is a fact about
//     where the file sits, not a similarity heuristic.
//
// Rule 4's unique-basename search deliberately did NOT widen. It is the one rule
// that guesses, and the measurement is under it.
//
// `[measured 2026-09-03, over 100 suites, after merging origin/main]` the
// widening took the derive-nothing count from 19 to 3 and retired 16 of the 18
// entries below, each because derivation returns that entry's exact path. The 3
// that still derive nothing are the ones derivation cannot reach by
// construction: test-all.js (checked as the runner, never by its own subjects),
// test-skill-prd-commands.js (subject is markdown — see NOT_JAVASCRIPT), and
// test-framework-radar-guidance.js (below).
//
// The baseline reads 19 rather than the 18 this comment carried before the
// merge, and the correction is the point rather than a tidy-up: origin/main
// added two more tooling suites while this branch sat open, so the population
// moved under a number written into prose. Both figures were measured and only
// one was current. Re-measure over the tree in front of you rather than quoting
// this line, which is stale the moment another tooling suite lands.
const SUBJECT_OVERRIDES = {
    // What remains is the honest residue: a suite whose subject is NOT
    // JavaScript, which no amount of path derivation can reach. This list no
    // longer grows with every new suite over tooling/ — those derive their own
    // subject now — so an addition here should be rare and should say why.

    // The subject is a shell hook, and derivation only ever yields `.js`.
    // Pinned deliberately rather than left to derivation, which for this suite
    // DOES find something: it requires tooling/check-no-private-names.js, the
    // helper the hook shells out to. Stubbing that helper turns the suite red
    // and would earn an 'ok' row without the hook under test being touched once
    // — a verdict about the wrong file, which is exactly what the paragraph at
    // the top says a map of guesses produces.
    'test-githooks.js': ['tooling/githooks/commit-msg'],

    // This policy regression suite constructs its two skill paths from a common
    // directory, so neither subject appears as a derivable path literal — and
    // SKILL.md is not `.js` either, so no widening reaches it.
    'test-framework-radar-guidance.js': [
        'plugins/autodev-core/skills/rule-agent-concurrency/SKILL.md',
        'plugins/autodev-core/skills/fleet/SKILL.md',
    ],

    // The subject is a hooks module (Claude Code function hooks): ES modules
    // with an .mjs extension, which derivation cannot yield. Left to
    // derivation this suite DOES find something — prd-states.js, the CommonJS
    // original its parity check reads — and stubbing that alone would earn an
    // 'ok' row without the module under test being touched once. The CJS stub
    // installed into an .mjs file throws at import, which the suite reports as
    // a verdict (exit 1), so each of the four files is checked in turn.
    'test-hooks-module.js': [
        'plugins/autodev-core/hooks/fn/autodev-fn.mjs',
        'plugins/autodev-core/hooks/fn/redact.mjs',
        'plugins/autodev-core/hooks/fn/bash-rules.mjs',
        'plugins/autodev-core/hooks/fn/sprint-status.mjs',
        'plugins/autodev-core/scripts/prd-states.js',
    ],
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

    // The suite's OWN directory, relative to the repo, as a posix path. Rules 2b
    // and 3b resolve against it, so they state a fact about where this file sits
    // rather than matching on resemblance. Read from the path rather than
    // hardcoded, so a suite that ever moves resolves correctly.
    const suiteDir = path.relative(SWEEP_ROOT, path.dirname(suiteFile)).split(path.sep).join('/');

    // 1. A slash-separated path literal inside the repo: 'plugins/…/foo.js'
    //    The alternation is written out rather than assembled from a variable: a
    //    RegExp built through a template literal loses `\w` and `\.` to escape
    //    collapsing, and the result is a silent false-empty rather than an error.
    //    That cost a wrong reading while measuring this very change.
    for (const m of src.matchAll(/['"`]((?:\.\.\/)*(?:plugins|templates|tooling)\/[\w./-]+\.js)['"`]/g)) {
        found.add(m[1].replace(/^(\.\.\/)+/, ''));
    }
    // 2. path.join / path.resolve segment lists: 'plugins', 'autodev-core', 'hooks', 'x.js'
    for (const m of src.matchAll(/path\.(?:join|resolve)\(([^)]*)\)/g)) {
        const call = m[1];
        const parts = [...call.matchAll(/['"`]([\w.-]+)['"`]/g)].map((x) => x[1]);
        if (!parts.length || !parts[parts.length - 1].endsWith('.js')) continue;
        for (const top of ['plugins', 'tooling']) {
            const i = parts.indexOf(top);
            if (i >= 0) found.add(parts.slice(i).join('/'));
        }
        // 2b. __dirname-anchored with no '..' climb. The suite lives in
        //     suiteDir, so path.resolve(__dirname, 'check-foo.js') IS
        //     suiteDir/check-foo.js. A '..' among the segments means the call
        //     leaves that directory and this reading does not hold, so it is
        //     skipped and rules 1-3 handle it.
        if (/\b__dirname\b/.test(call) && !/['"`]\.\.['"`]/.test(call)) {
            found.add(suiteDir + '/' + parts.join('/'));
        }
    }
    // 3. A bare require of a repo-relative module, with or without .js
    for (const m of src.matchAll(/require\(['"`]((?:\.\.\/)+[\w./-]+)['"`]\)/g)) {
        const p = m[1].replace(/^(\.\.\/)+/, '');
        if (/^(plugins|templates|tooling)\//.test(p)) found.add(p.endsWith('.js') ? p : p + '.js');
    }
    // 3b. A './' require resolves against the suite's own directory, the same
    //     fact as 2b. test-standing-order-wake.js names its subject exactly this
    //     way — `require('./standing-order-wake.js')` — and derived nothing.
    for (const m of src.matchAll(/require\(['"`]\.\/([\w./-]+)['"`]\)/g)) {
        const p = m[1];
        found.add(suiteDir + '/' + (p.endsWith('.js') ? p : p + '.js'));
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
    //    NOT widened to tooling/ when rules 1-3 were, on 2026-09-03. This is the
    //    one rule that guesses — it infers a subject from a name that resembles
    //    a file — and `[measured 2026-09-03]` widening its pool covered exactly
    //    ONE extra suite, test-all.js, which is checked as the runner and never
    //    consults its own subjects, while adding three more fuzzy matches
    //    elsewhere. Zero gain for more guessing, so it stays scoped to plugins/.
    for (const m of src.matchAll(/['"`]([\w.-]+\.js)['"`]/g)) {
        const hits = allPluginFiles().filter((p) => path.basename(p) === m[1]);
        if (hits.length === 1) found.add(hits[0]);
    }

    return [...found].filter((p) => fs.existsSync(path.join(SWEEP_ROOT, p)));
}

let _pluginFiles = null;
function allPluginFiles() {
    if (_pluginFiles) return _pluginFiles;
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(SWEEP_ROOT, dir), { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const rel = dir + '/' + e.name;
            if (e.isDirectory()) walk(rel);
            else if (e.name.endsWith('.js')) out.push(rel);
        }
    };
    for (const top of ['plugins']) {
        if (fs.existsSync(path.join(SWEEP_ROOT, top))) walk(top);
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
    const orig = full + '.orig-' + crypto.randomBytes(6).toString('hex');
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
        // Rollback must not replace the recreating writer's file either
        // (round-10: renameSync here overwrote it). link() refuses EEXIST;
        // if the recreated file is still there, it survives and the original
        // stays preserved on disk under its .orig name.
        try {
            fs.linkSync(orig, full);
            fs.unlinkSync(orig);
        } catch (e2) {
            conflict(`the original could not return over the recreated ${rel} (${e2.code || e2.message})`
                + ` — original preserved at ${path.basename(orig)}`);
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
        // Claim whatever is live by rename FIRST — one atomic syscall, so
        // there is no read-then-unlink-by-pathname window (round-10: a
        // writer replacing the stub between those two operations lost its
        // file undetected). Classification happens on the claimed inode,
        // which nothing else is writing to.
        const cap = rec.full + '.swept-' + crypto.randomBytes(6).toString('hex');
        let claimed = false;
        try { fs.renameSync(rec.full, cap); claimed = true; }
        catch { conflict(`${rel} was deleted by something else while stubbed`); }
        if (claimed) {
            const got = fs.readFileSync(cap);
            if (got.equals(rec.expect)) fs.unlinkSync(cap);
            else conflict(`${rel} held foreign content at restore — captured to ${path.basename(cap)}, nothing lost`);
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
    if (r.status === 2) {
        // Exit 2 is this repo's refusal/indeterminate convention (dirty-tree
        // guards, lock refusals, restoration failures). A child that REFUSED
        // is not a child that FAILED, and scoring it as a red canary would
        // verify nothing (Sol's round-10 blocker).
        conflict(`${what} exited 2 — a refusal or indeterminate result, not a verdict`);
        return false;
    }
    return true;
}

// git() runs in the SOURCE tree (the dirty check, worktree management);
// gitW() runs in the private sweep worktree (every scan below).
const git = (args) => execSync('git ' + args, { cwd: ROOT, encoding: 'utf8' });
const gitW = (args) => execSync('git ' + args, { cwd: SWEEP_ROOT, encoding: 'utf8' });

// Refuse to run on a dirty tree, and the REASON changed when the private
// worktree landed. It used to be "this script overwrites your files", which was
// true while the sweep mutated the shared tree in place and has been false since
// 7d70fab (2026-08-31): mutation happens in a detached worktree under tmpdir and
// your files are never touched.
//
// The refusal stays, because the remaining reason is just as good and nobody had
// written it down: the sweep checks out HEAD, so it grades COMMITTED code. Run it
// dirty and every verdict is about a tree you do not have, while the output names
// files you are in the middle of editing. A green there says nothing about the
// change in front of you.
//
// `[reported 2026-09-05]` a peer session found both this message and CLAUDE.md
// still describing the retired mechanism, five days after it was retired. The
// wording below is what a reader acts on, so it is part of the tool rather than
// a comment: it told people to stash to protect work that was never at risk.
const dirty = git('status --porcelain').trim();
if (dirty) {
    console.error('\nRefusing to run: the working tree has uncommitted changes.\n');
    console.error('This sweep mutates a private worktree, not yours, so your edits are safe.');
    console.error('It grades HEAD, so running it dirty would report on committed code while');
    console.error('naming files you are still changing. Commit first, then run it.\n');
    console.error(dirty.split('\n').slice(0, 10).join('\n'));
    process.exit(2);
}

// THE PRIVATE MUTATION WORKTREE (Sol's round-11 conclusion, adopted whole).
// Rounds 6 through 10 built locks, nonces, announce files and capture-and-
// swap restores to make in-place mutation safe against uncoordinated
// writers, and every round's review found the next window, because the races
// are INHERENT to mutating a tree someone else can touch. So this sweep no
// longer touches the shared tree at all: it checks out HEAD into a private
// detached worktree under tmpdir, mutates THERE, and removes it afterwards.
// No editor, no test run, no rival sweep can reach that tree, which retires
// the whole exclusion protocol — the lock, the nonce, the per-pid announce
// files, and the EPERM liveness logic — rather than hardening it again. The
// engine below (rename-aside originals, O_EXCL/link placement, conflicts)
// is kept: it is cheap, and inside a private tree every conflict it reports
// is a real bug in this script rather than a bystander.
const os = require('os');

// argv-based git for everything that carries a PATH — JSON.stringify is JSON
// quoting, not shell escaping, and a tmpdir containing shell metacharacters
// would have broken or injected through the string form (Sol's round-12
// blocker). Throws on non-zero exit with stderr attached.
const gitArgv = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) {
        throw new Error('git ' + args.join(' ') + ' failed: ' + ((r.stderr || '').trim() || r.status));
    }
    return r.stdout;
};

// The worktree is built from ONE captured SHA, not the symbolic HEAD — in a
// shared clone HEAD can move between resolution and checkout, and every
// verdict below must be about a tree we can name exactly.
const HEAD_SHA = gitArgv(['rev-parse', 'HEAD'], ROOT).trim();

// The SOURCE tree's ref position, captured so the end of the run can prove it
// did not move.
//
// `[measured 2026-09-02]` This sweep was blamed for detaching a worktree's HEAD
// mid-gate, on nothing but reflog adjacency. A controlled re-run refuted it: a
// full 92-suite sweep in a scratch worktree left the branch attached, the
// reflog unchanged at 2 entries, and a planted file under the gitignored
// `.claude/reports/` still present. The sweep is not the cause.
//
// What IS true, and is the reason this capture exists: nothing here could have
// told you either way. `git status` cannot see a moved ref. A detached HEAD is
// not a dirty tree, and neither is a branch switch, so an external mutation of
// the source tree during a 15-minute sweep is completely silent. Whoever did
// move it, the run should say so rather than print a summary that reads as an
// all-clear.
//
// `rev-parse --abbrev-ref` rather than `symbolic-ref`: it returns the literal
// string "HEAD" when detached and exits 0, where `symbolic-ref` exits 1 and
// gitArgv would throw during capture.
const SOURCE_BRANCH_BEFORE = gitArgv(['rev-parse', '--abbrev-ref', 'HEAD'], ROOT).trim();

// Reclaim worktrees stranded by a crashed or killed sweep. OWNERSHIP IS
// WHAT GIT SAYS, nothing else (Sol's round-14 blocker: a .git-pointer check
// is spoofable and check/use racy, and any recursive delete after git
// refuses a path is the destroy-someone's-checkout branch wearing a new
// name). The only directories this run may touch are ones REGISTERED as
// worktrees of THIS repository in `git worktree list --porcelain`, the only
// deletion is `git worktree remove --force`, and a path git refuses is left
// exactly as it is, reported, and retried by a later run — its registration
// survives because prune only drops records whose directory is gone.
const crypto = require('crypto');

// Canonical path identity for the registration comparison: realpath when the
// path still exists, case-folded on win32. Without it a case-variant or
// symlinked spelling of a registered worktree never matches and the stale
// tree stays unreclaimed forever (Sol's round-15 blocker).
const canonPath = (p) => {
    const r = path.resolve(p);
    let real;
    try { real = fs.realpathSync(r); } catch { real = r; }
    return process.platform === 'win32' ? real.toLowerCase() : real;
};
{
    // -z output: NUL-separated attribute records, so a path containing a
    // newline — legal on POSIX — cannot shear the parse (same blocker).
    const registered = new Set(gitArgv(['worktree', 'list', '--porcelain', '-z'], ROOT)
        .split('\0')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => canonPath(l.slice('worktree '.length))));
    for (const d of fs.readdirSync(os.tmpdir())) {
        const m = d.match(/^check-suites-wt-(\d+)-/);
        if (!m) continue;
        const full = path.join(os.tmpdir(), d);
        if (!registered.has(canonPath(full))) continue;   // not provably ours — untouched
        let alive = false;
        try { process.kill(parseInt(m[1], 10), 0); alive = true; }
        catch (e) { alive = e.code === 'EPERM'; }
        if (alive) continue;
        try { gitArgv(['worktree', 'remove', '--force', full], ROOT); }
        catch (e) {
            console.error('  [left] stale sweep worktree ' + full
                + ' — git refused to remove it (' + e.message + '); not deleted');
        }
    }
    try { gitArgv(['worktree', 'prune'], ROOT); } catch { /* best effort */ }
}

const SWEEP_ROOT = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-suites-wt-' + process.pid + '-'));
    fs.rmdirSync(dir);   // hand git a unique, nonexistent path
    try {
        gitArgv(['worktree', 'add', '--detach', dir, HEAD_SHA], ROOT);
    } catch (e) {
        console.error('\nCould not create the private mutation worktree: ' + e.message);
        process.exit(2);
    }
    return dir;
})();
const SWEEP_TOOLING = path.join(SWEEP_ROOT, 'tooling');
process.on('exit', () => {
    // git is the ONLY remover here too. If it refuses, the worktree stays
    // REGISTERED, which is precisely what lets the next run's reclamation
    // find and retry it — an rmSync fallback would both risk a wrong delete
    // and orphan the directory from the only ownership record it has.
    try { gitArgv(['worktree', 'remove', '--force', SWEEP_ROOT], ROOT); }
    catch { /* left registered; the next run's reclamation retries it */ }
});

// Anything that escapes past the conflict handling above must still land as
// INDETERMINATE — never as an ordinary crash whose exit status hides what
// happened (Sol's round-9 blocker). The mutated tree is the private
// worktree, so a crash strands nothing in the user's tree; the handler
// still names what was mid-flight for the record.
process.on('uncaughtException', (e) => {
    console.error('\nUNCAUGHT: ' + (e && e.stack || e));
    for (const [rel] of installedNow) {
        console.error('  stub was in place in the private worktree: ' + rel);
    }
    console.error('\nINDETERMINATE — the sweep died mid-run. The user tree was never touched;');
    console.error('the private worktree is removed on exit.\n');
    process.exit(2);
});

const suites = fs.readdirSync(SWEEP_TOOLING)
    .filter((f) => /^test-.*\.js$/.test(f))
    .sort();

// 15 minutes, not 5. A timeout KILLS the child, and a killed suite that
// mutates files for its own canaries (test-hook-execution-evidence.js
// prepends to a target suite and restores on exit) never runs its restore —
// the sweep then correctly reports its own kill as a conflict and goes
// INDETERMINATE, which is exactly what happened when the heaviest suite
// blew a 300s budget on a loaded machine. The generous budget is the fix;
// the conflict detection stays as the backstop for a genuine hang. Suites
// run FROM and IN the private worktree — nothing they touch is shared.
const runSuite = (suite) => spawnSync(process.execPath, [path.join(SWEEP_TOOLING, suite)], {
    cwd: SWEEP_ROOT, encoding: 'utf8', timeout: 900000,
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
    const victim = suites.find((s) => s !== suite && deriveSubjects(path.join(SWEEP_TOOLING, s)).length);
    if (!victim) return { suite, status: 'NO-SUBJECT', note: 'no child suite to fail' };

    const full = path.join(SWEEP_TOOLING, victim);
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
    const file = path.join(SWEEP_ROOT, 'VERSION');
    if (!fs.existsSync(file)) return { suite, status: 'NO-SUBJECT', note: 'no VERSION file' };

    const run = () => spawnSync(process.execPath, [path.join(SWEEP_TOOLING, 'validate.js')], {
        cwd: SWEEP_ROOT, encoding: 'utf8', timeout: 900000,
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
        const canaryExists = fs.existsSync(path.join(SWEEP_TOOLING, exempt.canary));
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

    const subjects = SUBJECT_OVERRIDES[suite] || deriveSubjects(path.join(SWEEP_TOOLING, suite));
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
            note: 'subject not derived — this suite is NOT verified. Name its subject where '
                + 'derivation can read it (a full path literal, a __dirname-anchored '
                + 'path.join/resolve, or a relative require), or add it to SUBJECT_OVERRIDES '
                + 'if the subject is not JavaScript.',
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
    const untrackedBefore = new Set(gitW('status --porcelain').split('\n')
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
        for (const line of gitW('status --porcelain').split('\n')) {
            if (!line.startsWith('?? ')) continue;
            const p = line.slice(3).trim();
            if (untrackedBefore.has(p)) continue;
            if (!path.basename(p).startsWith('zz-')) {
                console.error(`  [left alone] new untracked ${p} — not a zz- disposable fixture, so not this sweep's to delete`);
                continue;
            }
            console.error(`  [removed] orphaned fixture ${p} (appeared during ${suite}, absent from the pre-run snapshot)`);
            try { fs.rmSync(path.join(SWEEP_ROOT, p), { recursive: true, force: true }); } catch { /* the tree check below still backstops */ }
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
        const full = path.join(SWEEP_ROOT, rel);
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
        // NAME them. Derivation returns several subjects for some suites, and a
        // bare count cannot separate "red because its subject broke" from "red
        // because a helper it imports broke" — the second is a weaker claim
        // wearing the same row. A count cannot carry which one; an identity
        // list can, and this file's own history is of counts that agreed with
        // themselves.
        ? { suite, status: 'ok', note: `goes red when ${killed.length}/${subjects.length} subject(s) are stubbed: ${killed.join(', ')}` }
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

// THE SOURCE TREE'S REFS, which `git status` is structurally unable to report.
// A moved branch or a detached HEAD leaves a perfectly clean status, so without
// this the run ends with a summary that reads as an all-clear over a tree whose
// HEAD is somewhere else entirely.
try {
    const branchAfter = gitArgv(['rev-parse', '--abbrev-ref', 'HEAD'], ROOT).trim();
    const shaAfter = gitArgv(['rev-parse', 'HEAD'], ROOT).trim();
    if (branchAfter !== SOURCE_BRANCH_BEFORE) {
        conflict(
            `the SOURCE tree's HEAD moved during this run: was on ${SOURCE_BRANCH_BEFORE}, now on ` +
            `${branchAfter}${branchAfter === 'HEAD' ? ' (DETACHED)' : ''}. This sweep never writes to ` +
            `the source tree, so something else did. Recover with ` +
            `\`git merge-base --is-ancestor <branch> HEAD\` and, only if that passes, \`git checkout -B <branch>\``
        );
    } else if (shaAfter !== HEAD_SHA) {
        conflict(
            `the SOURCE tree's HEAD advanced during this run: ${HEAD_SHA.slice(0, 8)} -> ` +
            `${shaAfter.slice(0, 8)} on ${branchAfter}. The verdicts above describe ` +
            `${HEAD_SHA.slice(0, 8)}, not the tree you are standing in.`
        );
    }
} catch (e) {
    conflict('could not re-read the source tree HEAD after the sweep: ' + e.message);
}

const after = gitW('status --porcelain').trim();
if (after) {
    console.error('\nSWEEP WORKTREE NOT CLEAN after the sweep:\n' + after);
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
            // "tree restored clean" was measured with gitW, in the PRIVATE sweep
            // worktree that is deleted moments later. It reads as reassurance
            // about the tree you are standing in and was never about it. Say
            // which tree, and say that the source tree's refs were checked too,
            // since that is the part a reader actually wants and the part
            // `git status` cannot answer.
            (conflicts.length ? '' : ' · sweep worktree clean, source tree refs unmoved') + '\n');

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
