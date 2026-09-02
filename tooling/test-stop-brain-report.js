#!/usr/bin/env node
// Suite for hooks/stop-brain-report.js.
//
// Drives the hook as a SUBPROCESS with real stdin, a real temp git repo, and a
// real role file, because every one of its decisions reads something outside
// itself. A test that stubbed git would be testing this file's model of git.
//
// The assertions that matter are the SILENT ones. A Stop hook that speaks when
// it should not is worse than one that never speaks: it wakes the coordinator,
// which re-reads its whole context to learn nothing. So each quiet path asserts
// ZERO BYTES on stdout AND stderr, not merely "no additionalContext" — a mutant
// that writes to the wrong stream would otherwise pass.

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'stop-brain-report.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
    if (ok) {
        pass++;
        console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
    } else {
        fail++;
        failures.push(name);
        console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
    }
}

/** A throwaway git repo with one commit. */
function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbr-repo-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'probe@local');
    git('config', 'user.name', 'probe');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'v1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'v1');
    return dir;
}

function commitIn(dir, text) {
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'f.txt'), text);
    git('add', '-A');
    git('commit', '-q', '-m', text.trim());
}

/** Run the hook once. Returns {out, err, status}. */
function run({ input, roleFile, stateFile, env }) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
            AUTODEV_BRAIN_ROLE_FILE: roleFile,
            AUTODEV_BRAIN_REPORT_STATE: stateFile,
        }, env || {}),
    });
    return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

function writeRole(obj) {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbr-role-')), 'brain-role.json');
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
}

function stateFilePath() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbr-state-')), 'state.json');
}

function silentOk(r) {
    return r.out.length === 0 && r.err.length === 0 && r.status === 0;
}

function spoke(r) {
    if (r.status !== 0) return null;
    try {
        const j = JSON.parse(r.out);
        return j && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext ? j : null;
    } catch {
        return null;
    }
}

// --- inert paths ----------------------------------------------------------
// Each of these is a case where there is nothing useful to say. All must be
// byte-silent, because the cost of speaking is a coordinator context re-read.
{
    const repo = makeRepo();
    const state = stateFilePath();

    const noRole = run({
        input: { session_id: 's1', cwd: repo },
        roleFile: path.join(os.tmpdir(), 'sbr-absent-role.json'),
        stateFile: state,
    });
    check('no role file: silent, exit 0', silentOk(noRole),
        `out=${noRole.out.length}B err=${noRole.err.length}B exit=${noRole.status}`);

    const role = writeRole({ session_id: 'brain-1', peer_name: 'brain-peer' });

    const self = run({
        input: { session_id: 'brain-1', cwd: repo },
        roleFile: role,
        stateFile: stateFilePath(),
    });
    check('the coordinator is never told to report to itself', silentOk(self),
        `out=${self.out.length}B`);

    const noSession = run({ input: { cwd: repo }, roleFile: role, stateFile: stateFilePath() });
    check('no session_id: silent', silentOk(noSession), `out=${noSession.out.length}B`);

    const bad = run({ input: 'not json at all', roleFile: role, stateFile: stateFilePath() });
    check('unparseable stdin: silent, exit 0 rather than a crash', silentOk(bad),
        `exit=${bad.status} err=${bad.err.length}B`);

    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sbr-norepo-'));
    const outside = run({
        input: { session_id: 's-outside', cwd: nonRepo },
        roleFile: role,
        stateFile: stateFilePath(),
    });
    check('not a git repo: silent, no delivery evidence exists', silentOk(outside),
        `out=${outside.out.length}B`);
}

// --- the first sighting must not fire -------------------------------------
// Firing here would notify once per session the moment a coordinator starts.
{
    const repo = makeRepo();
    const role = writeRole({ session_id: 'brain-1', peer_name: 'brain-peer' });
    const state = stateFilePath();

    const first = run({ input: { session_id: 's2', cwd: repo }, roleFile: role, stateFile: state });
    check('first sighting records a baseline and stays quiet', silentOk(first),
        `out=${first.out.length}B`);

    const recorded = JSON.parse(fs.readFileSync(state, 'utf8'));
    check('  and the baseline was actually written', !!(recorded.s2 && recorded.s2.sha),
        'sha=' + (recorded.s2 && String(recorded.s2.sha).slice(0, 8)));

    const again = run({ input: { session_id: 's2', cwd: repo }, roleFile: role, stateFile: state });
    check('no commit since last look: still quiet', silentOk(again), `out=${again.out.length}B`);
}

// --- the case it exists for ------------------------------------------------
{
    const repo = makeRepo();
    const role = writeRole({ session_id: 'brain-1', peer_name: 'brain-peer' });
    const state = stateFilePath();

    run({ input: { session_id: 's3', cwd: repo }, roleFile: role, stateFile: state });   // baseline
    commitIn(repo, 'v2 delivered\n');

    const fired = run({ input: { session_id: 's3', cwd: repo }, roleFile: role, stateFile: state });
    const j = spoke(fired);
    check('a commit since the last report FIRES', !!j,
        j ? 'additionalContext present' : `out=${JSON.stringify(fired.out.slice(0, 80))}`);
    check('  it names the coordinator addresses from the role file',
        !!j && /brain-peer/.test(j.hookSpecificOutput.additionalContext)
        && /brain-1/.test(j.hookSpecificOutput.additionalContext));
    check('  it carries the Stop event name',
        !!j && j.hookSpecificOutput.hookEventName === 'Stop');
    check('  it does NOT block the turn',
        !!j && j.hookSpecificOutput.additionalContext !== undefined
        && !('decision' in j) && !('block' in j) && fired.status === 0,
        'exit=' + fired.status);
}

// --- the throttle ----------------------------------------------------------
// Without this, a session committing every turn wakes the coordinator every turn.
{
    const repo = makeRepo();
    const role = writeRole({ session_id: 'brain-1', peer_name: 'brain-peer' });
    const state = stateFilePath();

    run({ input: { session_id: 's4', cwd: repo }, roleFile: role, stateFile: state });
    commitIn(repo, 'v2\n');
    const one = run({ input: { session_id: 's4', cwd: repo }, roleFile: role, stateFile: state });
    check('throttle: the first notice fires', !!spoke(one));

    commitIn(repo, 'v3\n');
    const two = run({ input: { session_id: 's4', cwd: repo }, roleFile: role, stateFile: state });
    check('throttle: a second commit inside the window is SUPPRESSED', silentOk(two),
        `out=${two.out.length}B`);

    commitIn(repo, 'v4\n');
    const three = run({
        input: { session_id: 's4', cwd: repo },
        roleFile: role,
        stateFile: state,
        env: { AUTODEV_BRAIN_REPORT_COOLDOWN_MIN: '0' },
    });
    check('throttle: cooldown 0 lets the next commit through', !!spoke(three),
        'proves the suppression above is the COOLDOWN and not a dead code path');
}

// --- a broken state file must not break a turn -----------------------------
{
    const repo = makeRepo();
    const role = writeRole({ session_id: 'brain-1' });
    const state = stateFilePath();
    fs.writeFileSync(state, '{ this is not json');
    const r = run({ input: { session_id: 's5', cwd: repo }, roleFile: role, stateFile: state });
    check('corrupt state ledger: treated as a first sighting, never a crash',
        silentOk(r), `exit=${r.status} err=${r.err.length}B`);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
console.log('subject: plugins/autodev-core/hooks/stop-brain-report.js; '
    + '13 cases over 6 inert paths, the firing path, a 3-step throttle with a '
    + 'cooldown-0 control, and a corrupt ledger. Every quiet case asserts zero '
    + 'bytes on BOTH streams.');
if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exit(1);
}
