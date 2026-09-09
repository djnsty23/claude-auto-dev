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
    fs.writeFileSync(path.join(store, 'local_brain-desk.json'), JSON.stringify({ sessionId: 'local_brain-desk', cliSessionId: 'brain-1', isArchived: false }));
    fs.writeFileSync(path.join(store, 'local_brain-desk-old.json'), JSON.stringify({ sessionId: 'local_brain-desk-old', cliSessionId: 'brain-dead', isArchived: true, title: 'Old brain' }));
    return { sessions, env: { AUTODEV_SESSIONS_DIR: sessions, CLAUDE_SESSION_STORE: path.join(root, 'store') } };
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
        !!ok && /Message it before you go quiet: desktop session id `local_brain-desk`, peer name `brain-peer`/.test(ok.hookSpecificOutput.additionalContext),
        ok ? ok.hookSpecificOutput.additionalContext.split('\n')[1] : 'silent');
}

// --- a PARTLY stale role file: the case that was wrong five times ------------
/* `[measured 2026-09-08]` `peer_name` takes a fresh suffix on every restart --
   one coordinator's went -c1 -> -d2 -> -ab -> -31 -> -a7 in a day -- while
   `desktop_session_id` did not move. This hook read `state === 'fault'` and told
   five sessions "nobody can be reached ... report to the operator instead",
   while check-brain-role's own text on the SAME call said "PARTLY STALE AND
   STILL REACHABLE. Use desktop session id ...". Every one of those sessions
   reached the coordinator at that address anyway; a less suspicious one would
   have woken a person for nothing, which is the failure this hook exists to
   prevent.

   All three states are driven here from FIXTURES rather than argued about: a
   wholly live record (above), this one, and a wholly dead one (above). */
{
    const repo = makeRepo();
    // Live session_id and a live desktop record; only the peer suffix decayed.
    const role = writeRole({ session_id: 'brain-1', peer_name: 'brain-peer-a7', desktop_session_id: 'local_brain-desk', home_repos: ['C:/somewhere/coordinator'] });
    const state = stateFilePath();

    run({ input: { session_id: 's6', cwd: repo }, roleFile: role, stateFile: state, env: LIVE.env });
    commitIn(repo, 'v2 delivered\n');
    const fired = run({ input: { session_id: 's6', cwd: repo }, roleFile: role, stateFile: state, env: LIVE.env });
    const j = spoke(fired);
    const ctx = j ? j.hookSpecificOutput.additionalContext : '';

    check('partly stale role: the hook speaks', !!j, fired.out.slice(0, 120));
    check('  it hands out the address that RESOLVES',
        /Message it before you go quiet: desktop session id `local_brain-desk`/.test(ctx), ctx.split('\n')[1]);
    check('  it does NOT send the session to the operator',
        !/operator/.test(ctx), ctx);
    check('  it does NOT claim the record names no live coordinator',
        !/DOES NOT NAME A LIVE COORDINATOR/.test(ctx) && !/Nobody can be reached/.test(ctx), ctx.split('\n')[0]);
    check('  it names the stale FIELD, and as a field rather than an address',
        /PART OF THE ROLE FILE IS STALE/.test(ctx) && /`peer_name` \(not the name of any live session\)/.test(ctx)
        && /a field to re-stamp, not an address/.test(ctx), ctx.split('\n')[2]);
    check('  it does not offer the decayed peer name as an address',
        !/Message it before you go quiet[^\n]*brain-peer-a7/.test(ctx), ctx.split('\n')[1]);
    check('  it still does NOT emit session_id as an address',
        !/brain-1/.test(ctx), ctx);
    check('  and never by cwd', !/by cwd/.test(ctx) && !/somewhere\/coordinator/.test(ctx));
    check('  it does NOT block the turn', fired.status === 0 && !!j && !('decision' in j), 'exit=' + fired.status);

    /* THE CONTROL THAT KEEPS THE ABOVE FROM BEING UNCONDITIONAL: the same
       decayed peer name with a desktop record that is ALSO gone. Nothing
       reaches, so the escalation is correct and must still happen. Without this
       pair, a hook that never escalates passes the block above. */
    const repo2 = makeRepo();
    const state2 = stateFilePath();
    const gone = writeRole({ session_id: 'brain-dead', peer_name: 'brain-peer-a7', desktop_session_id: 'local_brain-desk-old' });
    run({ input: { session_id: 's7', cwd: repo2 }, roleFile: gone, stateFile: state2, env: LIVE.env });
    commitIn(repo2, 'v2 delivered\n');
    const dead = spoke(run({ input: { session_id: 's7', cwd: repo2 }, roleFile: gone, stateFile: state2, env: LIVE.env }));
    const deadCtx = dead ? dead.hookSpecificOutput.additionalContext : '';
    check('  control: when NOTHING resolves, the operator is still the answer',
        /DOES NOT NAME A LIVE COORDINATOR/.test(deadCtx) && /Report to the operator instead/.test(deadCtx)
        && !/PART OF THE ROLE FILE IS STALE/.test(deadCtx), deadCtx.split('\n')[1]);

    /* ABSENT COVERAGE MUST NOT READ AS COVERAGE, in either direction. The same
       partly-stale record with no readable desktop store: the desktop id may
       well be alive and nothing read it, so this must NOT reach the degraded
       branch (a green from a check that never ran), and must NOT claim nobody
       can be reached either. */
    const repo3 = makeRepo();
    const state3 = stateFilePath();
    run({ input: { session_id: 's8', cwd: repo3 }, roleFile: role, stateFile: state3, env: Object.assign({}, LIVE.env, { CLAUDE_SESSION_STORE: path.join(os.tmpdir(), 'sbr-no-such-store') }) });
    commitIn(repo3, 'v2 delivered\n');
    const unchecked = spoke(run({ input: { session_id: 's8', cwd: repo3 }, roleFile: role, stateFile: state3, env: Object.assign({}, LIVE.env, { CLAUDE_SESSION_STORE: path.join(os.tmpdir(), 'sbr-no-such-store') }) }));
    const unCtx = unchecked ? unchecked.hookSpecificOutput.additionalContext : '';
    check('  an UNCHECKED address does not reach the degraded branch',
        !!unchecked && !/PART OF THE ROLE FILE IS STALE/.test(unCtx)
        && !/Message it before you go quiet/.test(unCtx), unCtx.split('\n')[1]);
    check('  and it is not called dead either: it says what went unchecked',
        /`desktop_session_id` \(no readable desktop store/.test(unCtx)
        && /could not be checked/.test(unCtx) && !/Nobody can be reached/.test(unCtx), unCtx.split('\n')[1]);

    /* THE OTHER UNREADABLE REGISTRY, WHICH IS NOT THE SAME CASE. The pair above
       loses the desktop STORE, so `unchecked` holds `desktop_session_id` -- a
       real address, and "try it before concluding there is nobody there" is
       sound advice about it. Lose the SESSIONS DIR instead and the same list
       filled with `session_id`, which is not an address in any registry, under
       the same sentence.

       `[measured 2026-09-09]` it did exactly that from 2026-09-08 until today:
       on a machine with no readable `~/.claude/sessions` -- a desktop-only
       install, or one where the CLI has not written it yet -- a session was told
       to try the CLI uuid, which is the 2026-09-04 defect that produced
       `Session not found` twice. The store case above passed throughout,
       because it happens to put an address in that list. One branch, two
       registries, and only one of them was driven. */
    const repo4 = makeRepo();
    const state4 = stateFilePath();
    const noSessions = Object.assign({}, LIVE.env, { AUTODEV_SESSIONS_DIR: path.join(os.tmpdir(), 'sbr-no-such-sessions-dir') });
    run({ input: { session_id: 's9', cwd: repo4 }, roleFile: role, stateFile: state4, env: noSessions });
    commitIn(repo4, 'v2 delivered\n');
    const noSess = spoke(run({ input: { session_id: 's9', cwd: repo4 }, roleFile: role, stateFile: state4, env: noSessions }));
    const nsCtx = noSess ? noSess.hookSpecificOutput.additionalContext : '';
    check('  an unreadable SESSIONS dir never names `session_id` as an address to try',
        !!noSess && !/`session_id`/.test(nsCtx) && !/brain-1/.test(nsCtx), nsCtx.split('\n')[1]);
    /* The control, so the case above cannot pass by the hook going quiet or by
       the branch never being entered: it must still reach the unchecked wording
       and still name the field that IS an address. */
    check('    control: it still reaches the unchecked branch and names `peer_name`',
        /`peer_name` \(no readable sessions directory/.test(nsCtx)
        && /could not be checked/.test(nsCtx) && !/Nobody can be reached/.test(nsCtx), nsCtx.split('\n')[1]);
}

// --- an address that resolves to a STRANGER ---------------------------------
/* A COLLISION IS NOT A STALE FIELD. `session_id` dead, `peer_name` resolving to
   a LIVE session that is somebody else: a name freed by an archived session can
   be taken by another. "Nobody can be reached" is true here and insufficient —
   it does not say that trying anyway lands on a stranger. The branch and this
   fixture are ported from `fix/coordinator-reachable-by-either-address` @
   62a42be0, which had both where this file had neither.

   The stranger is a SECOND live pid, so it cannot coincide with the record by
   construction. The parent process is alive for as long as this suite runs; if
   it is not, that is asserted rather than passing a case that never ran. */
{
    const strangerPid = process.ppid;
    check('fixture: a second live pid exists for the stranger case', (() => {
        try { process.kill(strangerPid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
    })(), 'ppid ' + strangerPid);
    fs.writeFileSync(path.join(LIVE.sessions, strangerPid + '.json'),
        JSON.stringify({ pid: strangerPid, sessionId: 'brain-stranger', name: 'brain-stranger-peer' }));

    const repo = makeRepo();
    const state = stateFilePath();
    const role = writeRole({ session_id: 'brain-dead', peer_name: 'brain-stranger-peer', desktop_session_id: 'local_brain-desk-old' });
    run({ input: { session_id: 's9', cwd: repo }, roleFile: role, stateFile: state, env: LIVE.env });
    commitIn(repo, 'v2 delivered\n');
    const j = spoke(run({ input: { session_id: 's9', cwd: repo }, roleFile: role, stateFile: state, env: LIVE.env }));
    const ctx = j ? j.hookSpecificOutput.additionalContext : '';

    check('a name resolving to a STRANGER: the hook speaks', !!j, ctx.slice(0, 90));
    check('  it says the address reaches somebody else, not merely that nobody answers',
        /RESOLVES TO SOMEBODY ELSE/.test(ctx) && /Message NOBODY at that record/.test(ctx), ctx.split('\n')[0]);
    check('  it does NOT offer the stranger name as an address',
        !/Message it before you go quiet/.test(ctx) && !/PART OF THE ROLE FILE IS STALE/.test(ctx), ctx.split('\n')[1]);
    check('  and a person is the right answer here, so it says so',
        /Report to the operator/.test(ctx), ctx.split('\n')[1]);
    check('  zero bytes on stderr, exit 0, turn not blocked', (() => {
        const again = run({ input: { session_id: 's9b', cwd: repo }, roleFile: role, stateFile: state, env: LIVE.env });
        return again.err.length === 0 && again.status === 0;
    })());
}

// --- the hook and `--status` must not disagree about the same record ---------
/* THE DEFECT WAS A DISAGREEMENT, so the regression test is an agreement test.
   `[measured 2026-09-08]` `check-brain-role.js --status` said "PARTLY STALE AND
   STILL REACHABLE. Use desktop session id ..." while the hook, reading the same
   record through the same function in the same minute, said the record named no
   live coordinator and to escalate. Every assertion above checks ONE of the two
   surfaces; only this one checks that they still answer the same question the
   same way, which is the property that actually broke.

   Idea ported from `fix/coordinator-reachable-by-either-address` @ 62a42be0 —
   the best assertion on either branch, and neither had it in this form. */
{
    const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-brain-role.js');
    /* THE FIRST RUN OF THIS BLOCK FAILED, ON THE ASSERTION RATHER THAN THE
       SUBJECT, and the distinction is worth keeping: `--status` prints its
       advice block ONLY for a record with a fault, so on a healthy one it names
       no address while the hook correctly hands out both. Comparing the two
       texts as equal sets compares a diagnostic's silence with a router's
       output, and would have failed a hook that was right.

       The property that actually holds on every record is: THE ADDRESSES THE
       HOOK OFFERS ARE THE ADDRESSES `--status` SHOWS AS LIVE. So read them from
       whichever form that run produced -- the "Use X or Y" advice when a field
       is stale, the "-> live" resolution lines when nothing is. `session_id` is
       excluded from both sides by construction, which asserts the
       never-print-session_id property from a second direction. */
    const fromStatus = (roleFile) => {
        const r = spawnSync(process.execPath, [SUBJECT, '--status', '--role', roleFile], {
            encoding: 'utf8', env: Object.assign({}, process.env, LIVE.env),
        });
        const out = r.stdout || '';
        const advice = (out.split('\n').find((l) => /PARTLY STALE AND STILL REACHABLE\. Use /.test(l)) || '');
        const offers = advice
            ? (advice.match(/`([^`]+)`/g) || [])
            : out.split('\n')
                .filter((l) => /^ {2}(peer_name|desktop_session_id) \S+ -> live/.test(l))
                .map((l) => '`' + l.trim().split(' ')[1] + '`');
        return {
            offers: offers.sort().join(','),
            sendsToPerson: /Nobody can be reached|Message nobody at this record/.test(out),
        };
    };
    const fromHook = (roleFile) => {
        const repo = makeRepo();
        const st = stateFilePath();
        run({ input: { session_id: 'agree-' + path.basename(path.dirname(roleFile)), cwd: repo }, roleFile, stateFile: st, env: LIVE.env });
        commitIn(repo, 'v2 delivered\n');
        const j = spoke(run({ input: { session_id: 'agree-' + path.basename(path.dirname(roleFile)), cwd: repo }, roleFile, stateFile: st, env: LIVE.env }));
        const ctx = j ? j.hookSpecificOutput.additionalContext : '';
        const line = (ctx.split('\n').find((l) => /^Message it before you go quiet/.test(l)) || '');
        return {
            offers: (line.match(/`([^`]+)`/g) || []).sort().join(','),
            sendsToPerson: /Report to the operator|Message NOBODY/.test(ctx),
            ctx,
        };
    };

    const records = [
        ['both live', { session_id: 'brain-1', peer_name: 'brain-peer', desktop_session_id: 'local_brain-desk' }],
        ['peer decayed, desktop live', { session_id: 'brain-1', peer_name: 'brain-peer-a7', desktop_session_id: 'local_brain-desk' }],
        ['peer live, desktop archived', { session_id: 'brain-1', peer_name: 'brain-peer', desktop_session_id: 'local_brain-desk-old' }],
        ['nothing resolves', { session_id: 'brain-dead', peer_name: 'brain-peer-a7', desktop_session_id: 'local_brain-desk-old' }],
    ];
    for (const [label, rec] of records) {
        const roleFile = writeRole(rec);
        const s = fromStatus(roleFile);
        const h = fromHook(roleFile);
        check('hook and --status agree on "' + label + '": same addresses offered',
            s.offers === h.offers, '--status=[' + s.offers + '] hook=[' + h.offers + ']');
        check('  and agree on whether a person is the answer',
            s.sendsToPerson === h.sendsToPerson,
            '--status=' + s.sendsToPerson + ' hook=' + h.sendsToPerson);
    }
    /* The pair that makes the four above discriminating: the four records must
       not all reduce to the same answer, or an agreement test passes on a hook
       and a script that both say one thing always. */
    const answers = records.map(([, rec]) => {
        const f = writeRole(rec);
        const s = fromStatus(f);
        return s.offers + '|' + s.sendsToPerson;
    });
    check('control: the four records do not all reduce to one answer',
        new Set(answers).size >= 3, new Set(answers).size + ' distinct of ' + answers.length);
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
    + (pass + fail) + ' cases over 6 inert paths, all FOUR role-record outcomes driven '
    + 'from fixtures (a wholly live record; a PARTLY stale one whose peer name decayed '
    + 'while its desktop id resolves; a wholly dead one; and a name resolving to a '
    + 'STRANGER, which is a different instruction from either), each beside the control '
    + 'that flips it, plus BOTH unreadable-registry cases -- no desktop store, and no '
    + 'sessions directory -- each proving an UNCHECKED address reaches neither the '
    + 'degraded branch nor the dead one, and the sessions one proving `session_id` is '
    + 'never named among the addresses to try, four records cross-checked for AGREEMENT '
    + 'between the hook and `--status` with a control proving they do not all reduce to '
    + 'one answer, a 3-step throttle with a cooldown-0 control, a corrupt ledger, and '
    + 'the merged-to-trunk shape with an off-trunk control and a no-origin case. Every '
    + 'quiet case asserts zero bytes on BOTH streams; the address line never offers cwd '
    + 'and never carries session_id.');
if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exit(1);
}
