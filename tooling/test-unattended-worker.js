#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/unattended-worker.js.
//
// WHY THIS SUITE EXISTS. The subject writes the first thing an unattended
// session reads, and that session opens in a checkout other sessions share. Its
// two expensive failures are silent from the coordinator's side:
//
//   a STEP 0 that does not actually leave the shared checkout - the worker then
//     edits the main tree, and nothing reports it
//   a delete while the run is going - the task deletion archives the session,
//     and its result drops out of the default session list
//
// So the central case EXECUTES the composed STEP 0 in a real shell against a
// real repo with a real origin, and asserts where the shell ended up. A suite
// that only matched the prompt text would pass a STEP 0 with a quoting bug.
//
// Every refusal is paired with the positive control on the same fixture: the
// same brief with the collision removed must be accepted. A refusal that fires
// for every input passes a refusal-only suite.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'unattended-worker.js');
const { composePrompt, decideSettle, parseArgs } = require(SUBJECT);

let pass = 0, fail = 0, unchecked = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail === undefined ? '' : '  (' + detail + ')')); }
}
function couldNotCheck(label, why) { unchecked++; console.log('COULD NOT CHECK  ' + label + '  (' + why + ')'); }

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-worker-')));
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: '0' };

function cli(args) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* help text or a crash */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const code = (r) => r.json && r.json.error ? r.json.error.code : null;
function g(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A repo with a bare origin holding main, fetched so origin/main resolves.
const origin = path.join(scratch, 'origin.git');
const repo = path.join(scratch, 'repo');
g(scratch, 'init', '--bare', origin);
g(scratch, 'init', repo);
fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
g(repo, 'add', 'README.md');
g(repo, 'commit', '-m', 'init');
g(repo, 'branch', '-M', 'main');
g(repo, 'remote', 'add', 'origin', origin);
g(repo, 'push', '-q', 'origin', 'main');
g(repo, 'fetch', '-q', 'origin');
const ledger = path.join(scratch, 'ledger.json');
const briefFile = path.join(scratch, 'brief.md');
fs.writeFileSync(briefFile, 'MISSION. Add a guide.\nACCEPTANCE. The guide renders.\n');
const base = ['--repo', repo, '--brief-file', briefFile, '--return', 'coordinator-a1', '--ledger', ledger];

try {
    // =======================================================================
    // 1. --help returns and writes nothing.
    // =======================================================================
    const help = cli(['--help']);
    check('--help exits 0 with usage', help.status === 0 && help.stdout.startsWith('Usage:'), help.stdout.slice(0, 80));
    check('--help creates no default ledger under HOME', !fs.existsSync(path.join(home, '.claude')));
    const dflt = cli(['status']);
    const expectedDefault = path.join(home, '.claude', 'autodev', 'unattended-workers.json');
    check('without --ledger, status reads the ledger under HOME', dflt.json && dflt.json.ok && dflt.json.value.ledger.toLowerCase() === expectedDefault.toLowerCase(), dflt.stdout.slice(0, 200));
    check('an absent default ledger reads as zero records, and status writes nothing', dflt.json && dflt.json.value.recordsRead === 0 && !fs.existsSync(expectedDefault));

    // =======================================================================
    // 2. The composed prompt: STEP 0 first, the brief after, the return last.
    // =======================================================================
    const ok = cli(['brief', '--slug', 'logo-guide', ...base]);
    check('brief accepts a free slug', ok.status === 0 && ok.json && ok.json.ok, ok.stdout.slice(0, 200));
    const prompt = ok.json && ok.json.ok ? ok.json.value.createScheduledTask.prompt : '';
    const iStep0 = prompt.indexOf('STEP 0'), iAdd = prompt.indexOf('worktree add'), iBody = prompt.indexOf('MISSION. Add a guide.'), iReturn = prompt.indexOf('WHEN DONE OR BLOCKED');
    check('prompt opens with STEP 0', iStep0 === 0, iStep0);
    check('worktree add precedes the brief body, which precedes the return line', iAdd > 0 && iAdd < iBody && iBody < iReturn, [iAdd, iBody, iReturn].join(','));
    check('prompt names the return address', prompt.includes('for coordinator-a1'), 'coordinator-a1');
    // An unattended run has no SendMessage, so a prompt that told it to send
    // one left a STEP 0 failure and every final report with nowhere to go.
    const reportHome = path.join(home, '.claude', 'autodev', 'reports', 'worker-logo-guide', 'REPORT.md').replace(/\\/g, '/');
    check('STEP 0 failure writes to the report file, not SendMessage',
        /If STEP 0 fails[^\n]*write the failing command and its output to ([^,]+), then stop/.test(prompt)
        && prompt.toLowerCase().includes(`output to ${reportHome.toLowerCase()}, then stop`), prompt.slice(0, 1200));
    check('prompt never tells the run to use SendMessage', !/with SendMessage|send one report/i.test(prompt), (prompt.match(/.*SendMessage.*/g) || []).join(' | '));
    check('the done line names the report file and the RESULT line shape',
        prompt.toLowerCase().includes(`write one report to ${reportHome.toLowerCase()}`) && prompt.includes('RESULT logo-guide done|stopped|failed: <one line>'));
    check('brief records the report path', ok.json && ok.json.value.record.report
        && ok.json.value.record.report.replace(/\\/g, '/').toLowerCase() === reportHome.toLowerCase(), ok.json && ok.json.value.record.report);
    check('prompt contains no backslash (a shell reads it as an escape)', !prompt.includes('\\'));
    check('prompt tells the worker every later command starts with cd into the worktree', /Every later shell command starts with `cd "[^"]+" && `/.test(prompt), prompt.slice(0, 400));
    // [measured 2026-09-22] briefs that named no location put 12 worktrees and
    // 37 scratch files in the directory holding the checkouts.
    const scratchHome = path.join(home, '.claude', 'autodev', 'reports', 'worker-logo-guide').replace(/\\/g, '/');
    check('prompt pins any further worktree under <repo>/.claude/worktrees/', prompt.includes(repo.replace(/\\/g, '/') + '/.claude/worktrees/<name>, never beside the repo'), prompt.slice(0, 900));
    check('prompt names the scratch home under HOME/.claude/autodev/reports/<task id>', prompt.toLowerCase().includes(scratchHome.toLowerCase()), scratchHome);
    check('create_scheduled_task arguments carry no schedule', ok.json && !('cronExpression' in ok.json.value.createScheduledTask) && !('fireAt' in ok.json.value.createScheduledTask));
    check('task id defaults to worker-<slug>', ok.json && ok.json.value.createScheduledTask.taskId === 'worker-logo-guide');
    check('brief records the task as composed', ok.json && ok.json.value.record.state === 'composed');
    check('brief did not create the worktree itself', !fs.existsSync(path.join(repo, '.claude', 'worktrees', 'logo-guide')));

    // =======================================================================
    // 3. STEP 0 EXECUTED: the shell must end inside the new worktree, on the
    //    new branch, with the shared checkout's HEAD untouched.
    // =======================================================================
    const fence = prompt.match(/```bash\n([\s\S]*?)```/);
    const bash = findBash();
    if (!fence) check('prompt carries a bash fence for STEP 0', false);
    else if (!bash) couldNotCheck('STEP 0 executes in a real shell', 'no bash found on this host');
    else {
        const script = fence[1] + 'echo "TOP=$(git rev-parse --show-toplevel)"\necho "BRANCH=$(git rev-parse --abbrev-ref HEAD)"\n';
        const r = spawnSync(bash, ['-c', script], { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
        const top = (r.stdout.match(/TOP=(.*)/) || [])[1] || '';
        const expected = path.join(repo, '.claude', 'worktrees', 'logo-guide').replace(/\\/g, '/');
        check('STEP 0 exits 0', r.status === 0, r.stderr.trim().slice(0, 300));
        check('STEP 0 ends inside the new worktree', top.toLowerCase() === expected.toLowerCase(), top + ' vs ' + expected);
        check('STEP 0 ends on claude/<slug>', /BRANCH=claude\/logo-guide/.test(r.stdout), r.stdout);
        check('the shared checkout stays on main', g(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main');

        // Negative control for the assertion line: in a directory that is not
        // the worktree, the last STEP 0 line must fail rather than pass quietly.
        const assertLine = fence[1].split('\n').find((l) => l.startsWith('test '));
        const neg = spawnSync(bash, ['-c', assertLine], { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
        check('STEP 0 assertion fails outside the worktree', neg.status !== 0 && /STEP 0 FAILED/.test(neg.stdout), neg.status + ' ' + neg.stdout);

        // The shell's cwd does not survive between a worker's Bash calls: the
        // host resets it to the checkout the session opened in. [measured
        // 2026-09-16] "Shell cwd was reset" four times in one unattended run,
        // so the single `cd` in STEP 0 covers one call and nothing after it.
        // The prompt must carry a prefix the worker puts in front of EVERY
        // command. Run that prefix from the shared checkout, which is where a
        // reset lands, and assert it ends inside the worktree. The control runs
        // the same probe unguarded and must read the shared checkout, otherwise
        // the guarded run proves nothing about a reset.
        const guard = (prompt.match(/starts with `(cd "[^"]+" && )`/) || [])[1];
        check('prompt carries a per-command cd guard', !!guard, prompt.slice(0, 400));
        if (guard) {
            const probe = 'echo "TOP=$(git rev-parse --show-toplevel)"';
            const topOf = (res) => ((res.stdout.match(/TOP=(.*)/) || [])[1] || '').trim().toLowerCase();
            const shared = repo.replace(/\\/g, '/').toLowerCase();
            const reset = spawnSync(bash, ['-c', probe], { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
            check('control: after a cwd reset an unguarded command reads the shared checkout', topOf(reset) === shared, topOf(reset) + ' vs ' + shared);
            const guarded = spawnSync(bash, ['-c', guard + probe], { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
            check('the guard puts a reset shell back inside the worktree', guarded.status === 0 && topOf(guarded) === expected.toLowerCase(), guarded.status + ' ' + topOf(guarded) + ' vs ' + expected.toLowerCase());
        }
    }

    // =======================================================================
    // 4. Collisions, each with its positive control.
    // =======================================================================
    // The worktree and branch from section 3 now exist (when bash ran).
    if (fs.existsSync(path.join(repo, '.claude', 'worktrees', 'logo-guide'))) {
        const again = cli(['brief', '--slug', 'logo-guide', '--task-id', 'other-id', ...base]);
        check('an existing worktree path is refused', code(again) === 'worktree-exists', again.stdout);
    }
    const ledgerCollision = cli(['brief', '--slug', 'logo-guide', ...base]);
    check('an active task id or path claim is refused', ['task-id-in-use', 'worktree-exists'].includes(code(ledgerCollision)), ledgerCollision.stdout);

    // An active ledger record alone, with no worktree or branch, still claims the slug.
    const onlyLedger = cli(['brief', '--slug', 'ledger-only', '--task-id', 'first', ...base]);
    check('control: ledger-only slug is accepted first', onlyLedger.status === 0, onlyLedger.stdout);
    const onlyLedger2 = cli(['brief', '--slug', 'ledger-only', '--task-id', 'second', ...base]);
    check('an active ledger record claims its slug', code(onlyLedger2) === 'ledger-collision', onlyLedger2.stdout);

    g(repo, 'branch', 'claude/local-taken');
    check('a local branch collision is refused', code(cli(['brief', '--slug', 'local-taken', ...base])) === 'branch-exists');
    g(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/claude/remote-taken');
    check('an origin branch collision is refused', code(cli(['brief', '--slug', 'remote-taken', ...base])) === 'remote-branch-exists');
    check('control: a free slug on the same fixture is accepted', cli(['brief', '--slug', 'free-one', ...base]).status === 0);

    // Unreadable origin must read as a claim, never as "free".
    const lonely = path.join(scratch, 'lonely');
    g(scratch, 'clone', '-q', origin, lonely);
    g(lonely, 'remote', 'set-url', 'origin', path.join(scratch, 'no-such-origin.git'));
    const unread = cli(['brief', '--slug', 'nobody-home', '--repo', lonely, '--brief-file', briefFile, '--return', 'c', '--ledger', ledger]);
    check('an unreachable origin is refused as origin-unreadable', code(unread) === 'origin-unreadable', unread.stdout);

    // =======================================================================
    // 5. Input refusals.
    // =======================================================================
    check('a non-repo directory is refused', code(cli(['brief', '--slug', 'x-y', '--repo', home, '--brief-file', briefFile, '--return', 'c', '--ledger', ledger])) === 'not-a-repo');
    check('a subdirectory of a repo is refused', code(cli(['brief', '--slug', 'x-y', '--repo', path.join(repo, '.git'), '--brief-file', briefFile, '--return', 'c', '--ledger', ledger])) === 'not-a-repo');
    check('a bad slug is refused', code(cli(['brief', '--slug', 'Bad Slug', ...base])) === 'bad-slug');
    check('an unresolved base is refused', code(cli(['brief', '--slug', 'x-y', '--base', 'origin/nope', ...base])) === 'base-unresolved');
    const empty = path.join(scratch, 'empty.md'); fs.writeFileSync(empty, '  \n');
    check('an empty brief is refused', code(cli(['brief', '--slug', 'x-y', '--repo', repo, '--brief-file', empty, '--return', 'c', '--ledger', ledger])) === 'brief-empty');
    check('a missing --return is refused', code(cli(['brief', '--slug', 'x-y', '--repo', repo, '--brief-file', briefFile, '--ledger', ledger])) === 'usage');
    check('an unknown flag is refused', code(cli(['brief', '--nope', 'x'])) === 'usage');

    // =======================================================================
    // 6. Lifecycle: record, settle, deleted, status.
    // =======================================================================
    const sid = 'local_00000000-0000-4000-8000-000000000001';
    check('record refuses a non-local session id', code(cli(['record', '--task-id', 'worker-free-one', '--session', '6a336c6d', '--ledger', ledger])) === 'bad-session');
    check('settle before record is not delete-safe', (cli(['settle', '--task-id', 'worker-free-one', '--run-status', 'succeeded', '--report-read', '--ledger', ledger]).json || { value: {} }).value.decision.deleteSafe === false);
    check('record accepts the returned session id', cli(['record', '--task-id', 'worker-free-one', '--session', sid, '--ledger', ledger]).status === 0);
    check('record twice is refused', code(cli(['record', '--task-id', 'worker-free-one', '--session', sid, '--ledger', ledger])) === 'bad-state');
    check('deleted before settle is refused', code(cli(['deleted', '--task-id', 'worker-free-one', '--ledger', ledger])) === 'bad-state');
    const running = cli(['settle', '--task-id', 'worker-free-one', '--run-status', 'running', '--report-read', '--ledger', ledger]);
    check('a running run is not delete-safe, even with the report read', running.json && running.json.value.decision.deleteSafe === false, running.stdout);
    const unreadRun = cli(['settle', '--task-id', 'worker-free-one', '--run-status', 'succeeded', '--ledger', ledger]);
    check('an ended run whose result was not read is not delete-safe', unreadRun.json && unreadRun.json.value.decision.deleteSafe === false && unreadRun.json.value.decision.reason.includes(sid), unreadRun.stdout);
    const settled = cli(['settle', '--task-id', 'worker-free-one', '--run-status', 'failed', '--report-read', '--ledger', ledger]);
    check('an ended run with its result read is delete-safe', settled.json && settled.json.value.decision.deleteSafe === true && settled.json.value.record.state === 'settled', settled.stdout);
    check('deleted after settle records deleted', (cli(['deleted', '--task-id', 'worker-free-one', '--ledger', ledger]).json || { value: { record: {} } }).value.record.state === 'deleted');
    check('a deleted record frees its task id', cli(['brief', '--slug', 'free-two', '--task-id', 'worker-free-one', ...base]).status === 0);
    const st = cli(['status', '--ledger', ledger]);
    const onDisk = JSON.parse(fs.readFileSync(ledger, 'utf8')).records.length;
    check('status reports how many records it read', st.json && st.json.value.recordsRead === onDisk && onDisk > 0, st.json && st.json.value.recordsRead + ' vs ' + onDisk);
    check('status on an unknown task id is refused', code(cli(['status', '--task-id', 'nope', '--ledger', ledger])) === 'unknown-task');
    fs.writeFileSync(path.join(scratch, 'bad.json'), '{');
    check('an unparseable ledger is refused, not treated as empty', code(cli(['status', '--ledger', path.join(scratch, 'bad.json')])) === 'ledger-unreadable');

    // =======================================================================
    // 6b. A record that never ran. `deleted` needs `settled`, and `settle`
    //     refuses `composed`, so a task that was composed and then never
    //     created, or created and never run, had no way out: its slug and task
    //     id stayed claimed for ever. [measured 2026-09-16] a real ledger
    //     record sat `composed` after the coordinator decided not to run it,
    //     and `deleted` exited 1 on it. `retire` is the exit, and only for a
    //     record with no run behind it: a started record has a session to settle.
    // =======================================================================
    const never = cli(['brief', '--slug', 'never-ran', ...base]);
    check('control: a never-run record is composed', never.json && never.json.ok && never.json.value.record.state === 'composed', never.stdout.slice(0, 200));
    check('deleted still refuses a composed record', code(cli(['deleted', '--task-id', 'worker-never-ran', '--ledger', ledger])) === 'bad-state');
    check('settle still refuses a composed record', (cli(['settle', '--task-id', 'worker-never-ran', '--run-status', 'failed', '--report-read', '--ledger', ledger]).json || { value: {} }).value.decision.deleteSafe === false);
    const retired = cli(['retire', '--task-id', 'worker-never-ran', '--reason', 'task never created', '--ledger', ledger]);
    check('retire moves a composed record to retired', retired.json && retired.json.ok && retired.json.value.record.state === 'retired', retired.stdout.slice(0, 200));
    check('retire records the reason and the time', retired.json && retired.json.ok && retired.json.value.record.reason === 'task never created' && typeof retired.json.value.record.retiredAt === 'string');
    check('retire twice is refused', code(cli(['retire', '--task-id', 'worker-never-ran', '--ledger', ledger])) === 'bad-state');
    const settleRetired = cli(['settle', '--task-id', 'worker-never-ran', '--run-status', 'succeeded', '--report-read', '--ledger', ledger]);
    check('settle refuses a retired record', settleRetired.json && settleRetired.json.ok && settleRetired.json.value.decision.deleteSafe === false && settleRetired.json.value.record.state === 'retired', settleRetired.stdout.slice(0, 200));
    const stRetired = cli(['status', '--ledger', ledger]);
    check('status counts retired records', stRetired.json && stRetired.json.value.counts.retired === 1, stRetired.json && JSON.stringify(stRetired.json.value.counts));
    const slugFreed = cli(['brief', '--slug', 'never-ran', '--task-id', 'worker-never-ran-b', ...base]);
    check('a retired record frees its slug', slugFreed.status === 0, slugFreed.stdout.slice(0, 200));
    check('a retired record frees its task id', cli(['brief', '--slug', 'never-ran-again', '--task-id', 'worker-never-ran', ...base]).status === 0);
    check('record accepts the re-briefed task', cli(['record', '--task-id', 'worker-never-ran-b', '--session', sid, '--ledger', ledger]).status === 0);
    check('retire refuses a started record, which has a session to settle', code(cli(['retire', '--task-id', 'worker-never-ran-b', '--ledger', ledger])) === 'bad-state');
    check('retire on an unknown task id is refused', code(cli(['retire', '--task-id', 'nope', '--ledger', ledger])) === 'unknown-task');
    check('retire without a task id is refused', code(cli(['retire', '--ledger', ledger])) === 'usage');
    check('retire defaults the reason when none is given', (cli(['retire', '--task-id', 'worker-never-ran', '--ledger', ledger]).json || { value: { record: {} } }).value.record.reason === 'never ran');

    // =======================================================================
    // 7. Pure layer.
    // =======================================================================
    const p = composePrompt({ repo: 'C:\\r', worktree: 'C:\\r\\.claude\\worktrees\\s', branch: 'claude/s', base: 'origin/main', taskId: 't', returnTo: 'x', body: 'BODY' });
    check('composePrompt converts Windows separators', p.includes('"C:/r/.claude/worktrees/s"') && !p.includes('\\'));
    check('composePrompt puts the worktree path in the per-command guard', p.includes('`cd "C:/r/.claude/worktrees/s" && `'));
    check('decideSettle rejects an unknown run status', (() => { try { decideSettle({ state: 'started' }, 'done', true); return false; } catch (e) { return e.publicCode === 'usage'; } })());
    check('decideSettle refuses a deleted record', decideSettle({ state: 'deleted' }, 'succeeded', true).deleteSafe === false);
    check('parseArgs refuses a repeated flag', (() => { try { parseArgs(['--slug', 'a', '--slug', 'b']); return false; } catch (e) { return e.publicCode === 'usage'; } })());
} finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a locked file on Windows; the OS temp cleaner owns it */ }
}

function findBash() {
    if (process.platform !== 'win32') return 'bash';
    // `bash` on PATH can be WSL's, which cannot see Windows paths the same way.
    // Git for Windows ships its own next to git itself.
    try {
        const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
        const candidate = path.join(exec, '..', '..', '..', 'bin', 'bash.exe');
        return fs.existsSync(candidate) ? candidate : null;
    } catch { return null; }
}

console.log(`\n${pass} passed, ${fail} failed, ${unchecked} could not check`);
process.exitCode = fail ? 1 : 0;
