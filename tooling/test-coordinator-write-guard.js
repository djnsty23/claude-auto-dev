#!/usr/bin/env node
// Tests for hooks/coordinator-write-guard.js — the coordinator-write ban.
// Run: node tooling/test-coordinator-write-guard.js
// Exits 1 on any failure; 0 if all pass.
//
// TWO THINGS THIS SUITE IS BUILT AROUND, both from the repo's own history.
//
// 1. ZERO BYTES ON BOTH STREAMS, asserted separately. This hook runs on every
//    Bash call in every installed session, and the common case must cost
//    nothing and say nothing. A test that checks only stdout lets a mutant
//    that chatters on stderr survive, and vice versa — so every allow case
//    below asserts exit code, stdout length AND stderr length.
//
// 2. THE MUTATION IS THE ROLE FILE. A gate nobody has watched fire is a
//    hypothesis. The last block in this file takes an input that is verified
//    to block, removes the role file and nothing else, and asserts the block
//    disappears. Both arms run in the same process against the same bytes, so
//    the role file is the only variable.
//
// Everything runs against a fixture role file under a scratch dir, pointed at
// with AUTODEV_BRAIN_ROLE_FILE. The real ~/.claude/brain-role.json is never
// read, written or consulted: an acceptance test that could disarm the live
// rail is worse than no acceptance test.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'coordinator-write-guard.js');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cwg-'));
const ROLE = path.join(fixture, 'brain-role.json');
const ABSENT = path.join(fixture, 'no-such-role.json');

// Fabricated repo roots. They never have to exist on disk — the guard compares
// paths, it does not stat them — which is what keeps this suite from needing a
// real product repo to test the thing that protects product repos.
const HOME_REPO = path.join(fixture, 'harness');
const OTHER_REPO = path.join(fixture, 'product');
const SECOND_HOME = path.join(fixture, 'harness-clone');
// Adjacent, NOT nested. `harness-extra` shares a string prefix with `harness`,
// so a containment check written with startsWith() passes it as "inside" and
// the guard silently stops covering a whole sibling repo.
const PREFIX_TRAP = HOME_REPO + '-extra';

function writeRole(obj) { fs.writeFileSync(ROLE, JSON.stringify(obj)); }

/** Drive the hook as a subprocess. `roleFile` may point at a path that is absent. */
function run({ roleFile = ROLE, payload, raw = null, args = [], env = {} }) {
    const input = raw !== null ? raw : JSON.stringify(payload);
    const r = spawnSync(process.execPath, [HOOK, ...args], {
        input,
        encoding: 'utf8',
        env: { ...process.env, AUTODEV_BRAIN_ROLE_FILE: roleFile, ...env },
        timeout: 20000,
    });
    return {
        exit: r.status,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        timedOut: !!(r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM')),
    };
}

const bash = (command, over = {}) => ({
    tool_name: 'Bash',
    session_id: 'SESSION-A',
    cwd: OTHER_REPO,
    tool_input: { command },
    ...over,
});

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

/** An allow: exit 0 and NOT ONE BYTE on either stream. */
function expectSilentAllow(label, res) {
    const ok = res.exit === 0 && res.stdout.length === 0 && res.stderr.length === 0;
    check(label, ok, `exit ${res.exit}, stdout ${res.stdout.length}B, stderr ${res.stderr.length}B`);
}

/** A block: exit 2, and stderr carrying the reason plus the population line. */
function expectBlock(label, res, extra = /./) {
    const ok = res.exit === 2
        && /^Blocked:/.test(res.stderr)
        && /Scanned \d+ command segment/.test(res.stderr)
        && extra.test(res.stderr);
    check(label, ok, `exit ${res.exit}, stderr ${JSON.stringify(res.stderr.slice(0, 110))}`);
}

// ---------------------------------------------------------------------------
// A. INERT WITHOUT A ROLE FILE. This is the population that matters most: every
//    installed session that never coordinates anything. It must be silent even
//    for a command that would obviously block if the role were held.
// ---------------------------------------------------------------------------
writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });

expectSilentAllow('no role file: a foreign `git commit` is not this hook\'s business',
    run({ roleFile: ABSENT, payload: bash('git commit -m "x"') }));
expectSilentAllow('no role file: a foreign `git push` is not this hook\'s business',
    run({ roleFile: ABSENT, payload: bash('git push origin HEAD') }));

// ---------------------------------------------------------------------------
// B. THE BAN ITSELF. Role held by THIS session, effective directory outside the
//    declared home repos.
// ---------------------------------------------------------------------------
expectBlock('role held + commit outside home repo blocks',
    run({ payload: bash('git commit -m "x"') }), /git commit/);
expectBlock('role held + push outside home repo blocks',
    run({ payload: bash('git push origin HEAD') }), /git push/);
expectBlock('a --force-with-lease push is still a push',
    run({ payload: bash('git push --force-with-lease origin HEAD') }), /git push/);

// The home repo, and anything under it (worktrees live at .claude/worktrees/…).
expectSilentAllow('committing INSIDE the home repo is ordinary work',
    run({ payload: bash('git commit -m "x"', { cwd: HOME_REPO }) }));
expectSilentAllow('committing inside a worktree of the home repo is ordinary work',
    run({ payload: bash('git commit -m "x"', { cwd: path.join(HOME_REPO, '.claude', 'worktrees', 'w1') }) }));

// A sibling sharing a string prefix is a DIFFERENT repo. This is the case a
// startsWith() containment check gets wrong, and it fails open — silently
// exempting a whole neighbouring tree.
expectBlock('a sibling repo sharing the home repo\'s name prefix is still foreign',
    run({ payload: bash('git commit -m "x"', { cwd: PREFIX_TRAP }) }));

// Several homes: a second clone of the harness is also home.
writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO, SECOND_HOME] });
expectSilentAllow('a second declared home repo is also home',
    run({ payload: bash('git commit -m "x"', { cwd: SECOND_HOME }) }));
expectBlock('with two homes declared, a third directory is still foreign',
    run({ payload: bash('git commit -m "x"') }), /harness-clone/);
// `home_repo` as a bare string, the one-repo spelling.
writeRole({ session_id: 'SESSION-A', home_repo: HOME_REPO });
expectSilentAllow('home_repo as a bare string is accepted',
    run({ payload: bash('git commit -m "x"', { cwd: HOME_REPO }) }));

writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });

// ---------------------------------------------------------------------------
// C. MENTION IS NOT EXECUTION. The whole reason the previous Bash denylist was
//    deleted on 2026-08-17: it could not tell running a command from talking
//    about one, and blocked `grep -rn "DROP TABLE"` for containing the words it
//    was searching FOR. Every case here must pass silently.
// ---------------------------------------------------------------------------
expectSilentAllow('a double-quoted mention of git push is not a push',
    run({ payload: bash('echo "remember to git push before lunch"') }));
expectSilentAllow('a single-quoted mention of git commit is not a commit',
    run({ payload: bash("echo 'the fix landed in a git commit yesterday'") }));
expectSilentAllow('grepping FOR the string is not doing the thing',
    run({ payload: bash('git grep -n "git commit" -- docs/') }));
expectSilentAllow('a heredoc body mentioning git push is argument text',
    run({ payload: bash('cat <<EOF > notes.md\nnext step: git push origin main\nEOF') }));
expectSilentAllow('a quoted heredoc delimiter behaves the same',
    run({ payload: bash("cat <<'EOF' > notes.md\ngit commit -m 'not run'\nEOF") }));
expectSilentAllow('a commit MESSAGE mentioning push does not double-count',
    run({ payload: bash('git commit -m "prepare for git push"', { cwd: HOME_REPO }) }));
expectSilentAllow('a filename containing the word commit is not a commit',
    run({ payload: bash('cat docs/git-commit-policy.md') }));

// Read-only git in a foreign repo is exactly what a coordinator SHOULD be doing:
// surveying. Blocking it would push the role back toward guessing.
for (const cmd of ['git status --porcelain', 'git log --oneline -5', 'git fetch origin',
    'git ls-remote --heads origin', 'git diff --stat', 'git worktree list']) {
    expectSilentAllow(`read-only \`${cmd.split(' ').slice(0, 2).join(' ')}\` in a foreign repo is allowed`,
        run({ payload: bash(cmd) }));
}
// `merge` and `rebase` joined the list on 2026-09-02. S5's measured damage was
// not only the five retargeted PRs — it was also a branch merged into a base a
// briefed session was landing PRs into forty seconds later. A guard that stops
// the commit and allows the merge guards the cheaper half.
expectBlock('`git merge` in a foreign repo blocks',
    run({ payload: bash('git merge --no-ff feature') }), /git merge/);
expectBlock('`git rebase` in a foreign repo blocks',
    run({ payload: bash('git rebase origin/main') }), /git rebase/);
expectBlock('`git rebase --continue` is still a rebase',
    run({ payload: bash('git rebase --continue') }), /git rebase/);
expectSilentAllow('merging INSIDE the home repo is ordinary work',
    run({ payload: bash('git merge --no-ff feature', { cwd: HOME_REPO }) }));

// ---------------------------------------------------------------------------
// C2. A QUOTED PATH IS AN ARGUMENT, NOT A MENTION.
//
// Group C above proves quoted TEXT is not executed, and every case there is an
// `echo` or a `grep`. Nothing tested a quoted PATH, so the strip that makes
// group C pass was free to delete arguments too, and it did.
//
// [measured 2026-09-04] on the shipped 8.157.0 hook: `git -C "<foreign>" merge`
// exited 0. The quoted path was deleted, `-C` consumed `merge` as its value,
// no subcommand was found, and no-finding is an allow. Quoting a path defeated
// the entire rail. The mirror image blocked a legitimate write: `cd "<home>"`
// collapsed to a bare `cd`, which is $HOME.
//
// Both directions are asserted here, because a fix for either one alone reads
// as correct. The population that hid this was chosen by the property under
// test: every quoting case was a mention, so the mention rule could not fail.
// ---------------------------------------------------------------------------
expectBlock('a DOUBLE-QUOTED -C path into a foreign repo still blocks',
    run({ payload: bash(`git -C "${OTHER_REPO}" merge origin/main`, { cwd: HOME_REPO }) }), /git merge/);
expectBlock('a SINGLE-QUOTED -C path into a foreign repo still blocks',
    run({ payload: bash(`git -C '${OTHER_REPO}' commit -m x`, { cwd: HOME_REPO }) }), /git commit/);
expectBlock('a quoted cd into a foreign repo still blocks',
    run({ payload: bash(`cd "${OTHER_REPO}" && git push origin main`, { cwd: HOME_REPO }) }), /git push/);
expectSilentAllow('a quoted cd into the HOME repo is allowed, not read as bare cd',
    run({ payload: bash(`cd "${HOME_REPO}" && git commit -m x`) }));
expectSilentAllow('a quoted -C into the HOME repo is allowed',
    run({ payload: bash(`git -C "${HOME_REPO}" merge --no-ff feature`) }));

// The exclusions, each asserted so removing one is a visible decision rather
// than a drift. `pull` merges, so a mechanical "block what writes" catches it —
// and a coordinator updating a local clone in order to READ it is the job.
// Blocking that pushes the role back toward guessing at state it could measure.
expectSilentAllow('`git pull` is excluded: updating a clone to read it is the job',
    run({ payload: bash('git pull --ff-only origin main') }));
expectSilentAllow('`git pull` with an explicit merge is still excluded',
    run({ payload: bash('git pull --no-rebase origin main') }));
expectSilentAllow('`gh pr merge` is out of scope: this parses git, not gh',
    run({ payload: bash('gh pr merge 12 --squash') }));
expectSilentAllow('`git cherry-pick` was not added and is not blocked',
    run({ payload: bash('git cherry-pick abc1234') }));

// ---------------------------------------------------------------------------
// D. THE ESCAPES. cwd alone is not where the write lands, and both of these are
//    ordinary idioms rather than exotic ones — `cd x && git commit` especially.
// ---------------------------------------------------------------------------
expectBlock('`git -C <foreign>` from inside the home repo still blocks',
    run({ payload: bash(`git -C ${OTHER_REPO} commit -m "x"`, { cwd: HOME_REPO }) }));
expectBlock('a relative `git -C ../product` from inside the home repo still blocks',
    run({ payload: bash('git -C ../product commit -m "x"', { cwd: HOME_REPO }) }));
expectBlock('`cd <foreign> && git commit` from inside the home repo still blocks',
    run({ payload: bash(`cd ${OTHER_REPO} && git commit -m "x"`, { cwd: HOME_REPO }) }));
expectBlock('`--work-tree=<foreign>` still blocks',
    run({ payload: bash(`git --work-tree=${OTHER_REPO} commit -m "x"`, { cwd: HOME_REPO }) }));

// --git-dir points the OBJECT STORE somewhere the work tree is not. A write
// touches both, so either being foreign is a foreign write. Closed 2026-09-02;
// it had been a documented limit.
expectBlock('`--git-dir=<foreign>` blocks even with a home work tree',
    run({ payload: bash(`git --git-dir=${path.join(OTHER_REPO, '.git')} commit -m "x"`, { cwd: HOME_REPO }) }));
expectBlock('a space-separated `--git-dir <foreign>` blocks too',
    run({ payload: bash(`git --git-dir ${path.join(OTHER_REPO, '.git')} push`, { cwd: HOME_REPO }) }));
expectBlock('a HOME --git-dir does not launder a FOREIGN work tree',
    run({ payload: bash(`git --git-dir=${path.join(HOME_REPO, '.git')} commit -m "x"`) }));
expectSilentAllow('`--git-dir=<home>` from inside the home repo is ordinary work',
    run({ payload: bash(`git --git-dir=${path.join(HOME_REPO, '.git')} commit -m "x"`, { cwd: HOME_REPO }) }));
// The value must be CONSUMED, not read as the subcommand. Getting this wrong
// makes every --git-dir command allow, which looks exactly like a clean pass.
expectSilentAllow('a --git-dir value is not mistaken for the subcommand',
    run({ payload: bash(`git --git-dir ${path.join(HOME_REPO, '.git')} status`, { cwd: HOME_REPO }) }));
expectBlock('a push buried in a `;` chain still blocks',
    run({ payload: bash('npm test ; git push origin HEAD') }));
expectBlock('a push inside a command substitution still blocks',
    run({ payload: bash('echo $(git push origin HEAD)') }));

// The same mechanisms pointing the other way: a git write that lands INSIDE the
// home repo is fine no matter where the shell is standing.
expectSilentAllow('`git -C <home>` from a foreign cwd is allowed',
    run({ payload: bash(`git -C ${HOME_REPO} commit -m "x"`) }));
expectSilentAllow('`cd <home> && git commit` from a foreign cwd is allowed',
    run({ payload: bash(`cd ${HOME_REPO} && git commit -m "x"`) }));
expectSilentAllow('a -C into the home repo overrides an earlier cd away',
    run({ payload: bash(`cd ${OTHER_REPO} && git -C ${HOME_REPO} push`, { cwd: HOME_REPO }) }));

// A path held together by an escaped space must resolve WHOLE. Splitting on it
// resolves a shorter path, which lands wherever that prefix happens to fall —
// a wrong answer in either direction, arrived at silently.
{
    const spaced = path.join(fixture, 'home with space');
    writeRole({ session_id: 'SESSION-A', home_repos: [spaced] });
    expectSilentAllow('an escaped space keeps a home-repo path intact',
        run({ payload: bash(`git -C ${spaced.split(' ').join('\\ ')} commit -m "x"`) }));
    expectBlock('an escaped space keeps a FOREIGN path intact',
        run({ payload: bash(`git -C ${path.join(fixture, 'other one').split(' ').join('\\ ')} commit`, { cwd: spaced }) }));
    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });
}

// REGRESSION, win32 only and deliberately so. Treating `\` as "skip the next
// character" mangled `C:\Users\me\product` into `C:Usersmeproduct`, which
// path.resolve then read as RELATIVE — so an absolute Windows path resolved
// under the home repo and walked through the guard. The equivalent assertion
// cannot be written portably: on POSIX that same string is a relative path by
// definition, so the mangling changes nothing and the case cannot fail.
if (process.platform === 'win32') {
    expectBlock('an absolute Windows path in -C is not mangled into a relative one',
        run({ payload: bash(`git -C ${OTHER_REPO} commit -m "x"`, { cwd: HOME_REPO }) }));
} else {
    console.log('SKIP  absolute-Windows-path regression — win32 only, and it is NOT covered here');
}

// Two hits in one command: the population line must count both, so a reader can
// tell a whole-command blob from a real per-segment scan.
{
    const res = run({ payload: bash('git commit -m "x" && git push origin HEAD') });
    const ok = res.exit === 2 && /2 outside the home repo/.test(res.stderr)
        && /git commit, git push/.test(res.stderr);
    check('two writes in one chain are both counted in the population line', ok,
        `exit ${res.exit}, stderr ${JSON.stringify(res.stderr.slice(0, 140))}`);
}

// ---------------------------------------------------------------------------
// E. WHOSE ROLE IS IT. A role file naming another session must not block this
//    one; three coordinators claiming the role at once has happened.
// ---------------------------------------------------------------------------
expectSilentAllow('a role file naming ANOTHER session does not block this one',
    run({ payload: bash('git commit -m "x"', { session_id: 'SESSION-B' }) }));

writeRole({ home_repos: [HOME_REPO] });   // no session_id: a machine-wide claim
expectBlock('a role file with no session_id is a machine-wide claim and applies',
    run({ payload: bash('git commit -m "x"', { session_id: 'ANYONE' }) }));

// The gap that must be LOUD rather than silent: the role names a session and
// the payload carries none, so the holder cannot be confirmed. Allowing quietly
// would turn absent coverage into reported coverage.
writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });
{
    const payload = bash('git commit -m "x"');
    delete payload.session_id;
    const res = run({ payload });
    const ok = res.exit === 0 && res.stdout.length === 0 && /UNCHECKED/.test(res.stderr);
    check('an unconfirmable holder allows, but SAYS the write went unchecked', ok,
        `exit ${res.exit}, stderr ${JSON.stringify(res.stderr.slice(0, 110))}`);
}
// …and stays quiet when the command was never going to block anyway. A warning
// that fires on every call gets muted, which is how a detector stops working.
{
    const payload = bash('git status');
    delete payload.session_id;
    expectSilentAllow('an unconfirmable holder is silent when nothing would block',
        run({ payload }));
}

// ---------------------------------------------------------------------------
// E2. A CLAIM NAMING A DEAD SESSION. `[measured 2026-09-04]` the role file named
//     a session archived the day before, then a fresh claim wrote the desktop
//     uuid into session_id. Both times `claimed !== mine` held for the live
//     Brain, this guard exited quietly on every git write, and the Brain worked
//     for hours believing its rail was armed. The line must fire at the moment
//     it matters and nowhere else: a blocked verb, from inside the home repo,
//     while the record names no live session. Liveness is real: this process's
//     own pid is the live session and 999999 the dead one.
// ---------------------------------------------------------------------------
{
    const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'cwg-sessions-'));
    fs.writeFileSync(path.join(sessions, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: 'SESSION-A', name: 'peer-a' }));
    fs.writeFileSync(path.join(sessions, '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'SESSION-DEAD', name: 'peer-dead' }));
    const env = { AUTODEV_SESSIONS_DIR: sessions };
    const fromHome = (cmd) => bash(cmd, { session_id: 'SESSION-B', cwd: HOME_REPO });

    // Control first: somebody else's LIVE claim stays byte-silent, same
    // command, same cwd, same fixture. Without it every warning below could be
    // an unconditional line.
    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });
    expectSilentAllow('control: another session\'s LIVE claim is silent from inside the home repo',
        run({ payload: fromHome('git commit -m "x"'), env }));

    writeRole({ session_id: 'SESSION-DEAD', home_repos: [HOME_REPO] });
    {
        const res = run({ payload: fromHome('git commit -m "x"'), env });
        const ok = res.exit === 0 && res.stdout.length === 0
            && /names session SESSION-DEAD as the coordinator/.test(res.stderr)
            && /no live session has that id/.test(res.stderr)
            && /armed for NOBODY/.test(res.stderr)
            && /Allowing `git commit`/.test(res.stderr)
            && /check-brain-role\.js --status/.test(res.stderr);
        check('a claim naming a DEAD session allows, and SAYS the rail is armed for nobody', ok,
            `exit ${res.exit}, stderr ${JSON.stringify(res.stderr.slice(0, 160))}`);
    }
    expectSilentAllow('the dead claim is silent for a worker in a product repo (nothing to believe there)',
        run({ payload: bash('git commit -m "x"', { session_id: 'SESSION-B' }), env }));
    expectSilentAllow('the dead claim is silent when the command was never going to block',
        run({ payload: fromHome('git status && git log -1'), env }));
    expectSilentAllow('the dead claim is silent when the sessions dir cannot be read (fails open)',
        run({ payload: fromHome('git commit -m "x"'), env: { AUTODEV_SESSIONS_DIR: path.join(sessions, 'no-such-dir') } }));
    // The desktop store is deliberately not consulted on this path: a record
    // whose sessions-dir half is live must not be called dead by an unreachable
    // store, or every git write pays a 600-record walk to learn nothing.
    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO], desktop_session_id: 'local_nothing-here' });
    expectSilentAllow('a live claim with an unknown desktop id is still silent here',
        run({ payload: fromHome('git commit -m "x"'), env }));

    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });
    fs.rmSync(sessions, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F. FAIL OPEN, AND SAY SO WHEN IT MATTERS. This ships installed: a throw would
//    kill a stranger's turn and survive until they reinstall.
// ---------------------------------------------------------------------------
expectSilentAllow('unparseable hook input fails OPEN and silently',
    run({ raw: 'this is not json', payload: null }));
expectSilentAllow('empty stdin fails OPEN and silently',
    run({ raw: '', payload: null }));
expectSilentAllow('a non-Bash tool is passed through untouched',
    run({ payload: { tool_name: 'Write', session_id: 'SESSION-A', cwd: OTHER_REPO, tool_input: { file_path: '/x' } } }));
expectSilentAllow('a Bash call with no command is passed through untouched',
    run({ payload: { tool_name: 'Bash', session_id: 'SESSION-A', cwd: OTHER_REPO, tool_input: {} } }));

{
    fs.writeFileSync(ROLE, '{ this is not json');
    const res = run({ payload: bash('git commit -m "x"') });
    const ok = res.exit === 0 && res.stdout.length === 0 && /NOT guarded/.test(res.stderr);
    check('a role file that does not parse allows, and says it is NOT guarding', ok,
        `exit ${res.exit}, stderr ${JSON.stringify(res.stderr.slice(0, 110))}`);
}
{
    writeRole({ session_id: 'SESSION-A' });   // no home repos declared at all
    const res = run({ payload: bash('git commit -m "x"') });
    const ok = res.exit === 0 && res.stdout.length === 0 && /no home_repo/.test(res.stderr);
    check('a role file declaring no home repo allows rather than blocking everything', ok,
        `exit ${res.exit}, stderr ${JSON.stringify(res.stderr.slice(0, 110))}`);
}

// --help must RETURN, and quickly. check-entrypoints.js probes every
// plugins/*/hooks/*.js this way with stdin closed and a 10s budget; a hook that
// blocks on stdin there is reported as a hang.
{
    const t0 = Date.now();
    const res = run({ payload: null, raw: '', args: ['--help'] });
    const ms = Date.now() - t0;
    const ok = res.exit === 0 && res.stdout.length > 0 && !res.timedOut && ms < 10000;
    check('--help returns 0 with usage on stdout, well inside the entrypoint budget', ok,
        `exit ${res.exit}, ${ms}ms, stdout ${res.stdout.length}B`);
}

// A pathological command must not hang the turn. The old denylist's ReDoS
// lesson, applied to this hook's own scanning.
{
    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });
    const t0 = Date.now();
    const res = run({ payload: bash('echo ' + '"a b c" && '.repeat(4000) + 'true') });
    const ms = Date.now() - t0;
    const ok = res.exit === 0 && !res.timedOut && ms < 5000;
    check('a 4,000-segment command does not hang the hook', ok, `exit ${res.exit}, ${ms}ms`);
}

// ---------------------------------------------------------------------------
// F2. A HOME-NAMING PREFIX IS NOT A DIRECTORY CALLED THAT.
//
//     `[measured 2026-09-05]` against the live hook, with controls: the
//     absolute and relative spellings of `git commit` into a product repo both
//     blocked, and BOTH `~` spellings of the same command were ALLOWED.
//     `path.resolve` has no notion of `~`, so `~/product` resolved against a
//     cwd inside the home repo lands at `<home-repo>/~/product`, and the
//     containment check then reports it as inside. The coordinator rail had a
//     hole exactly the width of the character people actually type.
//
//     Same family as the backslash defect in section D, and worse in one
//     respect: that one failed in both directions, so it announced itself the
//     first time a legitimate home-repo write was blocked. This one only ever
//     fails OPEN, and a rail that only fails open is indistinguishable from a
//     rail that is working.
//
//     `os.homedir()` reads USERPROFILE on win32 and HOME elsewhere, so the
//     child's environment is what makes `~` point into the fixture. Both are
//     set: asserting only the platform's own variable would pass here and
//     leave the suite blind on the other platform.
// ---------------------------------------------------------------------------
{
    // `~` resolves to the fixture root, so `~/product` IS OTHER_REPO and
    // `~/harness` IS HOME_REPO. Nothing has to exist on disk.
    const asHome = { HOME: fixture, USERPROFILE: fixture };
    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });

    // The regression. cwd is INSIDE the home repo, which is what makes the
    // unexpanded form resolve to somewhere the guard considers safe.
    const inHome = { cwd: HOME_REPO };

    expectBlock('`cd ~/product && git commit` blocks',
        run({ payload: bash('cd ~/product && git commit -m "x"', inHome), env: asHome }),
        /git commit/);
    expectBlock('`git -C ~/product commit` blocks',
        run({ payload: bash('git -C ~/product commit -m "x"', inHome), env: asHome }),
        /git commit/);
    expectBlock('`git --work-tree=~/product push` blocks',
        run({ payload: bash('git --work-tree=~/product push origin HEAD', inHome), env: asHome }),
        /git push/);
    expectBlock('`$HOME/product` blocks',
        run({ payload: bash('cd $HOME/product && git merge topic', inHome), env: asHome }),
        /git merge/);
    // The braced form is the one that got away, and not through the expansion
    // at all: `commandSegments` splits on `{` and `}` for shell brace groups,
    // so `${HOME}/product` became three segments and the command parsed to
    // nothing. Four spellings blocked and this one allowed, which is why the
    // suite carries every spelling rather than one representative.
    expectBlock('`${HOME}/product` blocks (the braces must not shred the segment)',
        run({ payload: bash('git -C ${HOME}/product rebase main', inHome), env: asHome }),
        /git rebase/);
    expectBlock('`cd ${HOME}/product` blocks',
        run({ payload: bash('cd ${HOME}/product && git commit -m "x"', inHome), env: asHome }),
        /git commit/);

    // …and the brace GROUP the splitter was built for still ends a command,
    // because `;` closes it. Without this, a fix for the line above could
    // quietly stop segmenting `{ … }` and nothing would say so.
    expectBlock('a brace group is still segmented: `{ git commit; }` blocks',
        run({ payload: bash('{ git -C ~/product commit -m "x"; }', inHome), env: asHome }),
        /git commit/);
    expectBlock('`%USERPROFILE%\\product` blocks',
        run({ payload: bash('git -C %USERPROFILE%\\product commit -m "x"', inHome), env: asHome }),
        /git commit/);

    // THE OTHER DIRECTION, and it is why this is an expansion rather than a
    // ban on the character. A coordinator's own home repo reached through `~`
    // must still be allowed — this is the exact shape of the memory-mirror
    // commit that surfaced the bug, and a fix that blocked it would trade a
    // silent hole for a loud one.
    expectSilentAllow('`cd ~/harness && git commit` is still allowed',
        run({ payload: bash('cd ~/harness && git commit -m "x"', inHome), env: asHome }));
    expectSilentAllow('a bare `~` that IS the home repo is allowed',
        run({
            payload: bash('git commit -m "x"', { cwd: OTHER_REPO }),
            env: asHome,
            roleFile: (writeRole({ session_id: 'SESSION-A', home_repos: [fixture] }), ROLE),
        }));
    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });

    // OVER-EXPANSION, which is how a fix like this creates the bug it removed.
    // `~foo` is another user's home and is not ours to rewrite; `$HOMEBREW` is
    // simply a different variable. Both must keep resolving against cwd, so
    // from inside the home repo they stay inside it and the hook stays silent.
    // Without the lookahead anchors these become paths nobody typed.
    expectSilentAllow('`~foo` is another user\'s home, not ours to expand',
        run({ payload: bash('cd ~foo/product && git commit -m "x"', inHome), env: asHome }));
    expectSilentAllow('`$HOMEBREW` is not `$HOME`',
        run({ payload: bash('cd $HOMEBREW/product && git commit -m "x"', inHome), env: asHome }));
}

// ---------------------------------------------------------------------------
// F3. THE SAME EXPANSION ON THE CONFIG SIDE, WHICH F2 NEVER REACHED.
//
//     F2 fixed the paths parsed out of the COMMAND, the half an attacker or a
//     careless caller controls. `role.home_repos` went to `isInside` raw, so
//     the TRUSTED half could not be written portably at all.
//
//     It fails CLOSED rather than open, which is why it outlived F2: declaring
//     `~/harness` made `path.resolve` produce `<cwd>/~/harness`, that matched no
//     real directory, `homes.some(isInside)` went false for the coordinator's
//     own repo, and every directory counted as foreign. The guard then blocked
//     the writes it exists to permit, and said only that the write was outside
//     the home repo -- which is what it also says when the write really is
//     elsewhere. Two causes, one message.
//
//     Why it matters for more than tidiness: an absolute path carries a
//     username and a drive letter. A role file written on one machine is wrong
//     on the next, and a restored backup carries the wrongness with it. The
//     expansion is what lets the record be device- and account-agnostic.
// ---------------------------------------------------------------------------
{
    const asHome = { HOME: fixture, USERPROFILE: fixture };

    // `~/harness` IS HOME_REPO, by the same fixture arithmetic F2 uses.
    for (const spelling of ['~/harness', '$HOME/harness', '%USERPROFILE%/harness']) {
        writeRole({ session_id: 'SESSION-A', home_repos: [spelling] });
        expectSilentAllow(`home_repos declared as \`${spelling}\` still permits its own repo`,
            run({ payload: bash('git commit -m "x"', { cwd: HOME_REPO }), env: asHome }));
        expectBlock(`home_repos declared as \`${spelling}\` still blocks a foreign repo`,
            run({ payload: bash('git commit -m "x"', { cwd: OTHER_REPO }), env: asHome }),
            /git commit/);
    }

    // PROOF OF ELIGIBILITY. Without this the pair above is satisfied by any
    // change that makes the guard permissive, and an assertion that something
    // is allowed cannot tell "the expansion worked" from "nothing is guarded".
    // `~foo` is another user's home and must stay literal, so it names no real
    // directory, nothing matches, and the guard blocks its own repo. That the
    // SAME cwd blocks here and passes above is what pins the behaviour to the
    // expansion rather than to the fixture.
    writeRole({ session_id: 'SESSION-A', home_repos: ['~foo/harness'] });
    expectBlock('an unexpandable `~foo/harness` home_repo matches nothing, so its own repo is foreign',
        run({ payload: bash('git commit -m "x"', { cwd: HOME_REPO }), env: asHome }),
        /git commit/);

    // And a mixed list: one portable entry beside one absolute entry, which is
    // what a role file mid-migration actually looks like.
    writeRole({ session_id: 'SESSION-A', home_repos: ['~/harness', OTHER_REPO] });
    expectSilentAllow('a mixed portable/absolute list expands only the portable entry',
        run({ payload: bash('git commit -m "x"', { cwd: HOME_REPO }), env: asHome }));
    expectSilentAllow('  and the absolute entry in that same list still matches',
        run({ payload: bash('git commit -m "x"', { cwd: OTHER_REPO }), env: asHome }));

    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });
}

// ---------------------------------------------------------------------------
// G. THE MUTATION TEST. One input, two arms, and the ONLY difference is whether
//    the role file exists on disk. A gate nobody has watched fire is a
//    hypothesis; this is the watching.
// ---------------------------------------------------------------------------
{
    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });
    const payload = bash('git commit -m "x"');

    const armed = run({ payload });
    fs.rmSync(ROLE);
    const disarmed = run({ payload });
    writeRole({ session_id: 'SESSION-A', home_repos: [HOME_REPO] });

    const ok = armed.exit === 2
        && disarmed.exit === 0 && disarmed.stdout.length === 0 && disarmed.stderr.length === 0;
    check('MUTATION: removing the role file, and nothing else, stops the block', ok,
        `armed exit ${armed.exit}, disarmed exit ${disarmed.exit} `
        + `(${disarmed.stdout.length}B out, ${disarmed.stderr.length}B err)`);
}

fs.rmSync(fixture, { recursive: true, force: true });

// The population, not a bare verdict: what was driven, and how. Without it a
// green run is indistinguishable from a suite that asserted nothing.
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), HOOK)}, `
    + `driven as a subprocess ${pass + fail} times over `
    + `${['inert-without-role', 'the ban', 'mention-is-not-execution', 'cwd escapes',
        'role ownership', 'dead claim', 'fail-open', 'home-prefix expansion', 'mutation'].length} case groups; `
    + `every allow asserted zero bytes on BOTH stdout and stderr.`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail > 0 ? 1 : 0);
