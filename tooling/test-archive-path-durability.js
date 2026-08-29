#!/usr/bin/env node
/**
 * test-archive-path-durability — does the archive survive a commit?
 *
 * Separate suite from test-archive-prd.js on purpose. That one covers the SPLIT
 * (which stories go where, and that none fall between the buckets). This one
 * covers DURABILITY (whether the file it writes still exists tomorrow). They are
 * different failure modes and the second one is why the first was not enough:
 * `[measured 2026-08-29]` a project's split was provably lossless — 159 + 5 ===
 * 164, zero overlap — and the archive was gone anyway, because it was written to
 * a gitignored path and `git add -A` skipped it without a word.
 *
 * THESE FIXTURES ARE REAL GIT REPOS, not strings. The thing under test is git's
 * own ignore resolution — negations, `**` crossings, precedence — and asserting
 * on a hand-rolled matcher would grade a copy of the subject rather than the
 * subject (see skills/rule-gate-integrity). Each case runs `git init`, writes a
 * real .gitignore, and asks the real `git check-ignore`.
 *
 * The load-bearing fixture is REAL-WORLD-VERBATIM: the .gitignore that actually
 * lost the archive, negations included. It had `!.claude/skills/` twice and
 * twelve tracked files under `.claude/` — an exception list with a hole, not an
 * unknown — so a fixture without the negations would prove much less than it
 * looks like it proves.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const {
    OK, IGNORED, NO_REPO, RECOMMENDED_DIR, checkArchivePath, recoveryHint,
} = require(path.join(ROOT, 'plugins/autodev-core/scripts/check-archive-path.js'));

let failures = 0;
let assertionsRun = 0;
function check(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}
/** Counting wrapper — feeds the non-vacuity guard at the bottom. */
function expect(actual, wanted, msg) {
    assertionsRun++;
    assert.strictEqual(actual, wanted, msg);
}

const tmpdirs = [];
function repo(gitignore) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-path-'));
    tmpdirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    if (gitignore !== null) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
    return dir;
}
function plainDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-norepo-'));
    tmpdirs.push(dir);
    return dir;
}

// The .gitignore that actually lost 159 stories, reproduced with its negations.
const REAL_WORLD_IGNORE = [
    'docs/**/.claude/',
    '.claude/*',
    '!.claude/skills/',
    '# .claude/launch.json is force-added (git add -f)',
    'node_modules/',
    '**/.claude/',
    '!.claude/skills/',
].join('\n');

// ── the failure that happened ────────────────────────────────────────────────

check('THE REGRESSION: the real .gitignore is caught, archive AND backup', () => {
    const dir = repo(REAL_WORLD_IGNORE);
    const archive = checkArchivePath('.claude/archives/prd-archive-2026-08.json', dir);
    expect(archive.status, IGNORED, 'the exact path that lost 159 stories reads as safe');
    expect(archive.durable, false, 'an ignored archive must never be reported durable');
    // The backup taken beside it died the same way and is just as important:
    // it is what the old recovery instruction told you to restore from.
    const backup = checkArchivePath('.claude/archives/prd-backup-20260828.json', dir);
    expect(backup.status, IGNORED, 'the backup path is not checked by the same rule');
});

check('the `!.claude/skills/` negation is INERT — and that is why this is a trap', () => {
    // I asserted the opposite first and git corrected me, which is the argument
    // for shelling out rather than reimplementing the matcher.
    //
    // git cannot re-include a file whose PARENT DIRECTORY is excluded, and
    // `**/.claude/` excludes the directory. So the negation reads like an
    // exception and grants nothing. The .gitignore that lost the archive says so
    // in a comment about launch.json — "a file-negation can't re-cross the
    // **/.claude/ exclusion above" — and then carries `!.claude/skills/` twice
    // anyway. Anyone reading that file would conclude .claude/ has a working
    // exception mechanism. It does not.
    const dir = repo(REAL_WORLD_IGNORE);
    expect(checkArchivePath('.claude/skills/core/SKILL.md', dir).status, IGNORED,
        'if this ever passes, git changed its re-inclusion rule and the advice '
        + 'in this module about negations being unreliable needs revisiting');
});

check('a TRACKED path is durable even under a matching ignore rule', () => {
    // The real exception mechanism is the index, not the negation: `git add -f`
    // is how those twelve files under .claude/ actually survive. git
    // check-ignore reports an indexed path as not-ignored, so the module gets
    // this right for free — but only by accident unless it is pinned. Without
    // this case the module could start over-reporting on tracked files and
    // nothing would notice; an over-reporting gate is one that gets disabled.
    const dir = repo(REAL_WORLD_IGNORE);
    const f = path.join(dir, '.claude', 'skills', 'core', 'SKILL.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    expect(checkArchivePath('.claude/skills/core/SKILL.md', dir).status, IGNORED,
        'precondition: untracked, it is ignored');
    execFileSync('git', ['add', '-f', '.claude/skills/core/SKILL.md'], { cwd: dir, stdio: 'ignore' });
    expect(checkArchivePath('.claude/skills/core/SKILL.md', dir).status, OK,
        'a path in the index is durable and must not be refused');
});

check('THE FIX: the recommended destination is durable under that same file', () => {
    const dir = repo(REAL_WORLD_IGNORE);
    const r = checkArchivePath(`${RECOMMENDED_DIR}/prd-archive-2026-08.json`, dir);
    expect(r.status, OK, 'the recommended path is ignored by the real-world .gitignore');
    expect(r.durable, true, 'the fix must actually be durable, not merely different');
});

// ── the control: proves the check can say yes ────────────────────────────────

check('CONTROL: a clean repo ignores nothing, so every path is durable', () => {
    const dir = repo('');
    expect(checkArchivePath('.claude/archives/a.json', dir).durable, true,
        'with an empty .gitignore even the old path is durable — if this fails the '
        + 'module reports IGNORED unconditionally and every other pass here is vacuous');
    expect(checkArchivePath(`${RECOMMENDED_DIR}/a.json`, dir).durable, true);
});

check('CONTROL: no .gitignore at all behaves the same', () => {
    const dir = repo(null);
    expect(checkArchivePath(`${RECOMMENDED_DIR}/a.json`, dir).durable, true);
});

// ── the states that must not collapse into each other ────────────────────────

check('no git repo is its own outcome, not a silent pass and not a refusal', () => {
    const r = checkArchivePath(`${RECOMMENDED_DIR}/a.json`, plainDir());
    expect(r.status, NO_REPO, 'a non-repo must be distinguishable from a tracked path');
    expect(r.durable, false, 'nothing outside version control is durable');
    assertionsRun++;
    assert.match(r.remedy, /machine-local and unbacked/,
        'the non-repo case must tell the operator to SAY it is unbacked');
});

check('a directory-level ignore catches files under it', () => {
    const dir = repo('archives/\n');
    expect(checkArchivePath('archives/prd-archive.json', dir).status, IGNORED,
        'an ignored DIRECTORY must make files beneath it non-durable');
});

check('every non-durable result carries a remedy, every durable one does not', () => {
    const ignored = checkArchivePath('.claude/archives/a.json', repo(REAL_WORLD_IGNORE));
    const fine = checkArchivePath(`${RECOMMENDED_DIR}/a.json`, repo(''));
    assertionsRun += 2;
    assert.ok(ignored.remedy && ignored.remedy.length > 20,
        'a refusal with no remedy is a dead end for whoever hits it');
    assert.strictEqual(fine.remedy, null, 'a passing check must not emit advice');
});

// ── the recovery instruction ─────────────────────────────────────────────────

check('recoveryHint names the parent commit, not the file that cannot exist', () => {
    const hint = recoveryHint('135b733a0');
    assertionsRun++;
    assert.strictEqual(hint, 'git show 135b733a0^:prd.json');
    assertionsRun++;
    assert.ok(!/\.claude\/archives/.test(hint),
        'the old instruction pointed at the file the bug deletes — it must not come back');
});

// ── the doc must keep saying it ──────────────────────────────────────────────

check('SKILL.md refuses the ignored path and names the real recovery', () => {
    const md = fs.readFileSync(
        path.join(ROOT, 'plugins/autodev-core/skills/archive-prd/SKILL.md'), 'utf8');
    assertionsRun += 4;
    assert.ok(md.includes('check-archive-path.js'),
        'the skill no longer runs the durability check before writing');
    assert.ok(/prd-archives\//.test(md),
        'the skill no longer names the tracked destination');
    assert.ok(!/restore from `?\.claude\/archives\/`?/i.test(md),
        'the recovery instruction pointing at the lost file is back');
    assert.ok(/\^:prd\.json/.test(md),
        'the skill no longer documents the parent-commit recovery that actually works');
});

check('the skill writes archives nowhere but the tracked destination', () => {
    const md = fs.readFileSync(
        path.join(ROOT, 'plugins/autodev-core/skills/archive-prd/SKILL.md'), 'utf8');
    // Prose mentions the old path when explaining the incident; what must not
    // survive is an INSTRUCTION to write there.
    const writesToClaude = /(Write to|cp prd\.json|mkdir -p)\s*:?\s*\.claude\/archives/i.test(md);
    assertionsRun++;
    assert.ok(!writesToClaude, 'a write instruction still targets .claude/archives/');
});

// ── the guard that makes a green run mean something ──────────────────────────

// A suite whose fixtures silently stopped being built would print all-ok while
// asserting nothing. `[measured 2026-08-29]` this is the shape that let a census
// count zero and read as clean.
const MIN_ASSERTIONS = 18;
if (assertionsRun < MIN_ASSERTIONS) {
    console.error(`\nGUARD FAILED: only ${assertionsRun} assertions ran, expected >= ${MIN_ASSERTIONS}.`);
    console.error('A pass with too few assertions is a vacuous pass, so this counts as a failure.');
    failures++;
}

for (const d of tmpdirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log(`\nall archive-path durability checks passed (${assertionsRun} assertions)`);
