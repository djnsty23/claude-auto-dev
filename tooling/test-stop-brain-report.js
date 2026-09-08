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
/* A LIVE coordinator, so the address path is the one under test. The role file
   names this test process as the coordinator: its pid answers, its CLI session
   uuid and peer name sit in a fixture sessions dir, and its desktop record sits
   two directories down a fixture store, which is the shape the real store has.
   Without a live record the hook now speaks the STALE-ROLE text instead, which
   is the scenario after this one. */
const LIVE = (() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbr-live-'));
    const sessions = path.join(root, 'sessions');
    const store = path.join(root, 'store', 'acct', 'bucket');
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(sessions, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: 'brain-1', name: 'brain-peer' }));
    fs.writeFileSync(path.join(sessions, '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'brain-dead', name: 'brain-dead-peer' }));
    /* A SECOND LIVE session that has nothing to do with the role record: a peer
       name freed by an archived coordinator can be taken by one of these. The
       filename must be `<pid>.json` or the registry skips it — a fixture that
       lands as an unreadable file makes a stranger look merely dead, which is
       the wrong half of the negative control. `strangerAlive` below asserts the
       pid really is alive, so this cannot degrade in silence. */
    fs.writeFileSync(path.join(sessions, process.ppid + '.json'), JSON.stringify({ pid: process.ppid, sessionId: 'cli-stranger', name: 'brain-stranger-peer' }));
    fs.writeFileSync(path.join(store, 'local_brain-desk.json'), JSON.stringify({ sessionId: 'local_brain-desk', cliSessionId: 'brain-1', isArchived: false }));
    fs.writeFileSync(path.join(store, 'local_brain-desk-old.json'), JSON.stringify({ sessionId: 'local_brain-desk-old', cliSessionId: 'brain-dead', isArchived: true, title: 'Old brain' }));
    return { env: { AUTODEV_SESSIONS_DIR: sessions, CLAUDE_SESSION_STORE: path.join(root, 'store') }, strangerPid: process.ppid };
})();

{
    const repo = makeRepo();
    const role = writeRole({ session_id: 'brain-1', peer_name: 'brain-peer', desktop_session_id: 'local_brain-desk', home_repos: ['C:/somewhere/coordinator'] });
    const state = stateFilePath();

    run({ input: { session_id: 's3', cwd: repo }, roleFile: role, stateFile: state, env: LIVE.env });   // baseline
    commitIn(repo, 'v2 delivered\n');

    const fired = run({ input: { session_id: 's3', cwd: repo }, roleFile: role, stateFile: state, env: LIVE.env });
    const j = spoke(fired);
    check('a commit since the last report FIRES', !!j,
        j ? 'additionalContext present' : `out=${JSON.stringify(fired.out.slice(0, 80))}`);
    check('  it names the coordinator addresses from the role file',
        !!j && /brain-peer/.test(j.hookSpecificOutput.additionalContext) && /local_brain-desk/.test(j.hookSpecificOutput.additionalContext));
    /* The cwd fallback is GONE. `[measured 2026-09-04]` "or find it by cwd under
       <home_repos[0]>" routed three sessions' idle reports to whichever session
       had since been spawned into a dead Brain's worktree. A directory is a
       place, not a correspondent. */
    check('  it does NOT offer to find the coordinator by cwd',
        !!j && !/by cwd/.test(j.hookSpecificOutput.additionalContext) && !/somewhere\/coordinator/.test(j.hookSpecificOutput.additionalContext),
        j ? j.hookSpecificOutput.additionalContext.split('\n')[1] : '');
    check('  a live record is not called stale',
        !!j && !/DOES NOT NAME A LIVE COORDINATOR/.test(j.hookSpecificOutput.additionalContext) && !/could not be checked/.test(j.hookSpecificOutput.additionalContext));
    /* This assertion used to REQUIRE `brain-1` — the session_id — to appear in
       the address, so the suite enshrined the defect rather than catching it.
       `session_id` is the Claude Code session UUID this hook compares against
       the payload to exempt the coordinator from its own nudge. It is not an
       address in any registry: a peer reported `Session not found` against it
       TWICE and reached the coordinator by matching a worktree path instead.
       A wrong address fails in the RECIPIENT's session, so the sender never
       learns the message went nowhere, which is why two reports were needed
       before anyone looked. */
    check('  it does NOT emit session_id as an address',
        !!j && !/brain-1/.test(j.hookSpecificOutput.additionalContext),
        j ? JSON.stringify(j.hookSpecificOutput.additionalContext.split('\n')[1] || '') : '');
    check('  it carries the Stop event name',
        !!j && j.hookSpecificOutput.hookEventName === 'Stop');
    check('  it does NOT block the turn',
        !!j && j.hookSpecificOutput.additionalContext !== undefined
        && !('decision' in j) && !('block' in j) && fired.status === 0,
        'exit=' + fired.status);
}

// --- a stale role file ---------------------------------------------------------
// `[measured 2026-09-04]` brain-role.json named a session archived the day
// before, for a whole day. The hook must SAY so and hand out no address, rather
// than route the report to a dead session or, worse, to a directory.
{
    const repo = makeRepo();
    const role = writeRole({ session_id: 'brain-dead', peer_name: 'brain-dead-peer', desktop_session_id: 'local_brain-desk-old', home_repos: ['C:/somewhere/coordinator'] });
    const state = stateFilePath();

    run({ input: { session_id: 's4', cwd: repo }, roleFile: role, stateFile: state, env: LIVE.env });
    commitIn(repo, 'v2 delivered\n');
    const fired = run({ input: { session_id: 's4', cwd: repo }, roleFile: role, stateFile: state, env: LIVE.env });
    const j = spoke(fired);
    const ctx = j ? j.hookSpecificOutput.additionalContext : '';
    check('stale role: the hook still speaks (a commit landed)', !!j, fired.out.slice(0, 120));
    check('  and says the record names no live coordinator', /DOES NOT NAME A LIVE COORDINATOR/.test(ctx), ctx.split('\n')[0]);
    check('  naming the dead session id and the archived record', /dead-session \(session_id brain-dead/.test(ctx) && /archived-desktop/.test(ctx), ctx);
    check('  it hands out NO address to message', !/Message it before you go quiet/.test(ctx));
    check('  and never by cwd', !/somewhere\/coordinator/.test(ctx) && /do not resolve a coordinator by cwd/.test(ctx));
    check('  it does NOT block the turn', fired.status === 0 && !('decision' in j));

    // Control: the same role file with a LIVE session_id is not called stale,
    // which is what proves the verdict came from the registries and not from
    // the text being unconditional.
    const liveRole = writeRole({ session_id: 'brain-1', peer_name: 'brain-peer', desktop_session_id: 'local_brain-desk' });
    const repo2 = makeRepo();
    const state2 = stateFilePath();
    run({ input: { session_id: 's5', cwd: repo2 }, roleFile: liveRole, stateFile: state2, env: LIVE.env });
    commitIn(repo2, 'v2 delivered\n');
    const ok = spoke(run({ input: { session_id: 's5', cwd: repo2 }, roleFile: liveRole, stateFile: state2, env: LIVE.env }));
    check('  control: a live record in the same fixture is handed out as an address',
        !!ok && /Message it before you go quiet: peer name `brain-peer`, desktop session id `local_brain-desk`/.test(ok.hookSpecificOutput.additionalContext),
        ok ? ok.hookSpecificOutput.additionalContext.split('\n')[1] : 'silent');
}

// --- a coordinator restart is not a dead coordinator -----------------------
/* THE REGRESSION THIS BLOCK EXISTS FOR. `[measured 2026-09-08]` `peer_name` is
   a session's ephemeral display name and it CHANGES ON EVERY COORDINATOR
   RESTART, so a restart alone raises `dead-peer` while `desktop_session_id`
   still names the same live session. The hook branched on
   `checkBrainRole().state` — a two-value summary — and told the session the
   role file named NO live coordinator and to escalate to the operator, while
   `check-brain-role.js --status`, reading the same file at the same moment,
   said PARTLY STALE AND STILL REACHABLE and named the desktop id. The session
   messaged the coordinator at that desktop id and it worked. Twice.

   The misrouting is the cost, not the noise: the operator is woken for a
   channel that works, and the coordinator loses status it is actively
   coordinating on, on the LAST turn of a session.

   ALL FOUR CORNERS ARE DRIVEN HERE, and cases 3 and 4 are not padding: they
   both passed before the fix, so a suite that covered only those would have
   been green on the defect. Case 1 is the one that was red. */
{
    /** Baseline, one commit, fire. Returns the additionalContext or ''. */
    function fireWith(role) {
        const repo = makeRepo();
        const roleFile = writeRole(role);
        const state = stateFilePath();
        run({ input: { session_id: 'r-' + Math.random().toString(36).slice(2), cwd: repo }, roleFile, stateFile: state, env: LIVE.env });
        commitIn(repo, 'v2 delivered\n');
        const id = Object.keys(JSON.parse(fs.readFileSync(state, 'utf8')))[0];
        const fired = run({ input: { session_id: id, cwd: repo }, roleFile, stateFile: state, env: LIVE.env });
        const j = spoke(fired);
        return { ctx: j ? j.hookSpecificOutput.additionalContext : '', fired, j };
    }

    const OPERATOR = /Report to the operator instead/;

    // CASE 1 — peer_name stale, desktop id live. The regression.
    const c1 = fireWith({ session_id: 'brain-1', peer_name: 'brain-peer-before-the-restart', desktop_session_id: 'local_brain-desk' });
    check('case 1 (peer_name stale, desktop id live): the hook speaks', !!c1.j, c1.fired.out.slice(0, 90));
    check('  it does NOT call the coordinator dead',
        !/DOES NOT NAME A LIVE COORDINATOR/.test(c1.ctx), c1.ctx.split('\n')[0]);
    check('  it does NOT reroute to the operator', !OPERATOR.test(c1.ctx), c1.ctx.split('\n')[1]);
    check('  it names the WORKING address, the desktop session id',
        /Report to the coordinator at desktop session id `local_brain-desk`/.test(c1.ctx), c1.ctx.split('\n')[1]);
    check('  and it does NOT hand back the stale peer name as an address',
        !/peer name `brain-peer-before-the-restart`/.test(c1.ctx), c1.ctx.split('\n')[1]);
    check('  it says WHICH field is stale, so the reader can rewrite it',
        /dead-peer \(peer_name brain-peer-before-the-restart/.test(c1.ctx), c1.ctx.split('\n')[0]);
    check('  and sends the reader to ListAgents for peer_name, not to this message',
        /read `peer_name` from ListAgents/.test(c1.ctx) && /not from this message/.test(c1.ctx));
    check('  it agrees with `check-brain-role.js --status` on the same record',
        /PARTLY STALE AND STILL REACHABLE/.test(c1.ctx), 'one file, one answer');
    check('  zero bytes on stderr, exit 0, and the turn is not blocked',
        c1.fired.err.length === 0 && c1.fired.status === 0 && !('decision' in (c1.j || {})),
        `err=${c1.fired.err.length}B exit=${c1.fired.status}`);

    // CASE 2 — peer_name live, desktop id stale (the record is archived).
    const c2 = fireWith({ session_id: 'brain-1', peer_name: 'brain-peer', desktop_session_id: 'local_brain-desk-old' });
    check('case 2 (peer_name live, desktop id stale): reachable, not dead',
        !!c2.j && !/DOES NOT NAME A LIVE COORDINATOR/.test(c2.ctx), c2.ctx.split('\n')[0]);
    check('  it does NOT reroute to the operator', !OPERATOR.test(c2.ctx), c2.ctx.split('\n')[1]);
    check('  it names the peer name and NOT the archived desktop record',
        /Report to the coordinator at peer name `brain-peer`/.test(c2.ctx)
        && !/at .*local_brain-desk-old/.test(c2.ctx), c2.ctx.split('\n')[1]);
    check('  zero bytes on stderr, exit 0', c2.fired.err.length === 0 && c2.fired.status === 0);

    // CASE 3 — both stale. The original message is CORRECT here and must survive.
    const c3 = fireWith({ session_id: 'brain-dead', peer_name: 'brain-dead-peer', desktop_session_id: 'local_brain-desk-old' });
    check('case 3 (both stale): the coordinator IS unreachable and it says so',
        /DOES NOT NAME A LIVE COORDINATOR/.test(c3.ctx), c3.ctx.split('\n')[0]);
    check('  and only HERE does it reroute to the operator', OPERATOR.test(c3.ctx), c3.ctx.split('\n')[1]);
    check('  it hands out no address at all',
        !/Report to the coordinator at/.test(c3.ctx) && !/Message it before you go quiet/.test(c3.ctx));
    check('  zero bytes on stderr, exit 0', c3.fired.err.length === 0 && c3.fired.status === 0);

    // CASE 4 — both live. No fault at all; both addresses are handed out.
    const c4 = fireWith({ session_id: 'brain-1', peer_name: 'brain-peer', desktop_session_id: 'local_brain-desk' });
    check('case 4 (both live): both addresses are handed out',
        /Message it before you go quiet: peer name `brain-peer`, desktop session id `local_brain-desk`/.test(c4.ctx),
        c4.ctx.split('\n')[1]);
    check('  it does NOT reroute to the operator', !OPERATOR.test(c4.ctx), c4.ctx.split('\n')[1]);
    check('  and does not claim the record is partly stale',
        !/PARTLY STALE/.test(c4.ctx) && !/could not be checked/.test(c4.ctx));
    check('  zero bytes on stderr, exit 0', c4.fired.err.length === 0 && c4.fired.status === 0);

    check('fixture: a second live pid exists for the stranger control',
        (() => { try { process.kill(LIVE.strangerPid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })(),
        'ppid ' + LIVE.strangerPid);
    /* THE NEGATIVE CONTROL THAT KEEPS CASES 1 AND 2 HONEST. "Some address still
       resolves" is NOT the rule: a name freed by an archived session can be
       taken by a STRANGER, and routing a handover there is worse than waking
       the operator. `brain-dead-peer` is a live session in this fixture that
       has nothing to do with the record, so a fix that offered every resolving
       address would fire here and it must not. */
    const stranger = fireWith({ session_id: 'brain-dead', peer_name: 'brain-stranger-peer', desktop_session_id: 'local_brain-desk-old' });
    check('control: a stale name resolving to a STRANGER offers no address',
        !/Report to the coordinator at/.test(stranger.ctx), stranger.ctx.split('\n')[1]);
    check('  it says the address reaches somebody else, and routes to the operator',
        /RESOLVES TO SOMEBODY ELSE/.test(stranger.ctx) && /Message nobody at that record/.test(stranger.ctx)
        && /Report to the operator instead/.test(stranger.ctx), stranger.ctx.split('\n')[0]);
    check('  zero bytes on stderr, exit 0', stranger.fired.err.length === 0 && stranger.fired.status === 0);
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

// --- published work must not read as unreported ----------------------------
// `[reported 2026-09-05]` a session that had pushed everything to the trunk was
// told it was carrying three commits the coordinator had not been told about.
// The count was real and answered "how far is HEAD from THIS BRANCH's tracked
// ref", which a merge to the trunk leaves behind permanently. In a worktree
// fleet that is most sessions, and a nudge that fires on published work trains
// the reader to ignore the nudge.
{
    /** A clone whose branch upstream was left behind by a merge to the trunk. */
    function mergedToTrunk({ landOnTrunk }) {
        const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'sbr-origin-'));
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
        const dir = makeRepo();
        const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
        git('branch', '-M', 'main');
        git('remote', 'add', 'origin', origin);
        git('push', '-q', '-u', 'origin', 'main');
        git('checkout', '-q', '-b', 'feat');
        git('push', '-q', '-u', 'origin', 'feat');      // upstream pinned at v1
        commitIn(dir, 'v2 delivered\n');
        // The whole point: the work reaches the trunk WITHOUT the branch ref
        // being updated, which is what a squash or a merge from the forge does.
        if (landOnTrunk) git('push', '-q', 'origin', 'HEAD:main');
        git('remote', 'set-head', 'origin', 'main');
        git('fetch', '-q', 'origin');
        return dir;
    }

    const role = writeRole({ session_id: 'brain-1', peer_name: 'brain-peer' });

    // The subject. HEAD is 1 ahead of origin/feat AND already on origin/main.
    const onTrunk = mergedToTrunk({ landOnTrunk: true });
    const s1 = stateFilePath();
    run({ input: { session_id: 'p1', cwd: onTrunk }, roleFile: role, stateFile: s1, env: LIVE.env });
    commitIn(onTrunk, 'v3 local\n');
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: onTrunk, stdio: 'pipe' });
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: onTrunk, stdio: 'pipe' });
    const pub = spoke(run({ input: { session_id: 'p1', cwd: onTrunk }, roleFile: role, stateFile: s1, env: LIVE.env }));
    const pubCtx = pub ? pub.hookSpecificOutput.additionalContext : '';
    check('published: the hook still speaks (a commit landed)', !!pub, String(pubCtx).slice(0, 90));
    check('  and says the work is already on the trunk',
        /already on the trunk|on the trunk/.test(pubCtx), pubCtx.split('\n')[0]);
    check('  and does NOT report it as bare commits ahead of upstream',
        !/\d+ ahead of upstream/.test(pubCtx), pubCtx.split('\n')[0]);

    // The control that makes the two above mean something: identical fixture,
    // identical commit, the ONLY difference is that the work never reached the
    // trunk. Without this a hook that always printed the trunk clause passes.
    const offTrunk = mergedToTrunk({ landOnTrunk: false });
    const s2 = stateFilePath();
    run({ input: { session_id: 'p2', cwd: offTrunk }, roleFile: role, stateFile: s2, env: LIVE.env });
    commitIn(offTrunk, 'v3 local\n');
    const unpub = spoke(run({ input: { session_id: 'p2', cwd: offTrunk }, roleFile: role, stateFile: s2, env: LIVE.env }));
    const unpubCtx = unpub ? unpub.hookSpecificOutput.additionalContext : '';
    check('  control: work NOT on the trunk still reports commits ahead of upstream',
        /\d+ ahead of upstream/.test(unpubCtx), unpubCtx.split('\n')[0]);
    check('  control: and does not claim the trunk carries it',
        !/on the trunk/.test(unpubCtx), unpubCtx.split('\n')[0]);

    // A repo with no origin at all must be unchanged: the trunk is UNKNOWN, and
    // unknown must not be reported as either published or unpublished.
    const bare = makeRepo();
    const s3 = stateFilePath();
    run({ input: { session_id: 'p3', cwd: bare }, roleFile: role, stateFile: s3, env: LIVE.env });
    commitIn(bare, 'v2 local\n');
    const noOrigin = spoke(run({ input: { session_id: 'p3', cwd: bare }, roleFile: role, stateFile: s3, env: LIVE.env }));
    const noCtx = noOrigin ? noOrigin.hookSpecificOutput.additionalContext : '';
    check('  no origin: the hook speaks and claims nothing about a trunk',
        !!noOrigin && !/on the trunk/.test(noCtx), noCtx.split('\n')[0]);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
console.log('subject: plugins/autodev-core/hooks/stop-brain-report.js; '
    + (pass + fail) + ' cases over 6 inert paths, the firing path against a LIVE role '
    + 'record (own pid, nested fixture store), a STALE role record with a live control, '
    + 'a 3-step throttle with a cooldown-0 control, a corrupt ledger, and the merged-to-trunk shape with an off-trunk control and a no-origin case. '
    + 'Coordinator reachability is driven at ALL FOUR corners of (peer_name live/stale x desktop id live/stale), '
    + 'plus a live-stranger control that must be offered no address; cases 3 and 4 pass without the fix, case 1 is the regression. Every quiet '
    + 'case asserts zero bytes on BOTH streams; the address line never offers cwd.');
if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exit(1);
}
