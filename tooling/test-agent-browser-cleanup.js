#!/usr/bin/env node
// Tests for autodev-core's SessionStart hook: hooks/agent-browser-cleanup.js.
//
// 231 lines, wired at SessionStart, and it had no tests. Found by
// tooling/find-untested-hooks.js.
//
// Most of it shells out to taskkill/wmic/PowerShell and is Windows-only, which
// is not reachable from here. But one part is neither: disableAutostartPreferences
// WRITES to JSON files under the user's Temp and home directories. That is the
// piece worth pinning down, because its failure mode is not "the hook did not
// help" — it is "the hook rewrote a file it should never have touched".
//
// So the assertions below are mostly about RESTRAINT and about not corrupting
// anything: which directories it will consider, what it leaves alone, and what
// happens to a malformed file it cannot parse.
//
// EXTENDED 2026-09-08. The paragraph above was right about the Windows branches
// and wrong by omission about the POSIX one, which is neither Windows-only nor
// unreachable from here: it runs on this machine, at the start of every session,
// and it killed processes. It had no assertions at all. See the POSIX zombie
// reaping section below.
//
// Run: node tooling/test-agent-browser-cleanup.js

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'agent-browser-cleanup.js');
const mod = require(HOOK);
const { AGENT_BROWSER_BINARY, parseProcessTable, classifyProcesses, reapPosixOrphans } = mod;

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abc-test-')));
const cases = [];
const check = (label, ok) => cases.push([label, ok]);

// The function reads LOCALAPPDATA and os.homedir() at CALL time, so a fixture
// can be pointed at without reloading the module.
let n = 0;
function sandbox() {
    const home = path.join(TMP, 'home' + ++n);
    const localAppData = path.join(home, 'AppData', 'Local');
    fs.mkdirSync(path.join(localAppData, 'Temp'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agent-browser'), { recursive: true });
    return { home, tempRoot: path.join(localAppData, 'Temp'), dotRoot: path.join(home, '.agent-browser'), localAppData };
}

function profile(root, dirName, prefs) {
    const p = path.join(root, dirName, 'Default');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, 'Preferences');
    fs.writeFileSync(file, typeof prefs === 'string' ? prefs : JSON.stringify(prefs));
    return file;
}

function withSandbox(sb, fn) {
    const prevHome = process.env.HOME, prevLad = process.env.LOCALAPPDATA, prevUp = process.env.USERPROFILE;
    process.env.HOME = sb.home;
    process.env.USERPROFILE = sb.home;
    process.env.LOCALAPPDATA = sb.localAppData;
    try { fn(); } finally {
        process.env.HOME = prevHome;
        process.env.LOCALAPPDATA = prevLad;
        process.env.USERPROFILE = prevUp;
    }
}

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ------------------------------------------------------------- what it patches

{
    const sb = sandbox();
    const file = profile(sb.tempRoot, 'agent-browser-chrome-abc123', {
        browser: { auto_launch_chrome_on_startup: true, other_setting: 'keep me' },
        background_mode: { enabled: true },
        unrelated: { deeply: { nested: 1 } },
    });
    withSandbox(sb, () => mod.disableAutostartPreferences());
    const after = read(file);

    check('disables autostart in an agent-browser profile',
        after.browser.auto_launch_chrome_on_startup === false);
    check('disables background mode', after.background_mode.enabled === false);
    // It rewrites the whole file, so everything it did not come for must survive.
    check('  preserves unrelated keys in the same object', after.browser.other_setting === 'keep me');
    check('  preserves unrelated top-level keys', after.unrelated.deeply.nested === 1);
}

// The .agent-browser root has no name filter — every directory under it counts.
{
    const sb = sandbox();
    const file = profile(sb.dotRoot, 'session-xyz', { browser: {}, background_mode: {} });
    withSandbox(sb, () => mod.disableAutostartPreferences());
    check('patches profiles under ~/.agent-browser regardless of name',
        read(file).browser.auto_launch_chrome_on_startup === false);
}

// -------------------------------------------------------------- what it spares

// The Temp directory is shared with everything else on the machine. Only
// directories named agent-browser-chrome-* are ours, and the prefix check is the
// only thing standing between this hook and every other app's Preferences file.
{
    const sb = sandbox();
    const mine = profile(sb.tempRoot, 'agent-browser-chrome-x', { browser: {}, background_mode: {} });
    const theirs = profile(sb.tempRoot, 'some-other-app', { browser: { auto_launch_chrome_on_startup: true } });
    const before = fs.readFileSync(theirs, 'utf8');

    withSandbox(sb, () => mod.disableAutostartPreferences());

    check('patches our own Temp profile', read(mine).browser.auto_launch_chrome_on_startup === false);
    check("  and does NOT touch another app's Temp profile",
        fs.readFileSync(theirs, 'utf8') === before);
}

// A file it cannot parse must be left exactly as it was, not truncated or
// half-written. This is a user's browser profile.
{
    const sb = sandbox();
    const broken = profile(sb.tempRoot, 'agent-browser-chrome-broken', '{ not valid json');
    const before = fs.readFileSync(broken, 'utf8');
    let threw = false;
    withSandbox(sb, () => { try { mod.disableAutostartPreferences(); } catch { threw = true; } });

    check('a malformed Preferences file does not throw', !threw);
    check('  and is left byte-for-byte unchanged', fs.readFileSync(broken, 'utf8') === before);
}

// Already-correct preferences must not be rewritten. The `dirty` flag exists so
// a SessionStart hook does not touch the mtime of every profile on every start.
{
    const sb = sandbox();
    const file = profile(sb.tempRoot, 'agent-browser-chrome-clean', {
        browser: { auto_launch_chrome_on_startup: false },
        background_mode: { enabled: false },
    });
    const before = fs.statSync(file).mtimeMs;
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(file, oldTime, oldTime);
    const stamped = fs.statSync(file).mtimeMs;

    withSandbox(sb, () => mod.disableAutostartPreferences());
    check('an already-correct profile is not rewritten',
        fs.statSync(file).mtimeMs === stamped && stamped !== before);
}

// Missing roots are the normal case on a machine that has never run
// agent-browser. It must not create them, and must not throw.
{
    const home = path.join(TMP, 'empty-home');
    fs.mkdirSync(home, { recursive: true });
    const sb = { home, localAppData: path.join(home, 'AppData', 'Local') };
    let threw = false;
    withSandbox(sb, () => { try { mod.disableAutostartPreferences(); } catch { threw = true; } });
    check('missing profile roots: does not throw', !threw);
    check('  and does not create them', !fs.existsSync(path.join(home, '.agent-browser')));
}

// LOCALAPPDATA is a Windows variable and is simply absent elsewhere, so the
// `|| path.join(os.homedir(), 'AppData', 'Local')` fallback is the path actually
// taken on any machine that does not set it. Every case above sets the variable,
// so the fallback was never exercised.
{
    const home = path.join(TMP, 'fallback-home');
    const tempRoot = path.join(home, 'AppData', 'Local', 'Temp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const file = profile(tempRoot, 'agent-browser-chrome-fb', { browser: {}, background_mode: {} });

    const prevHome = process.env.HOME, prevLad = process.env.LOCALAPPDATA, prevUp = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.LOCALAPPDATA;
    try { mod.disableAutostartPreferences(); } finally {
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevUp;
        if (prevLad === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = prevLad;
    }

    check('with LOCALAPPDATA unset, falls back to ~/AppData/Local',
        read(file).browser.auto_launch_chrome_on_startup === false);
}

// =========================================================== POSIX zombie reaping
//
// WHY THIS SECTION EXISTS. Until 2026-09-08 the POSIX branch of killZombies was
//
//     execSync('pkill -f "agent-browser-(linux|darwin)"')
//
// and this file — its own suite, 16 assertions — contained the strings `pkill`,
// `darwin`, `peer` and `multi-session` exactly zero times. The branch that kills
// processes on the platform this repo is developed on was the one part of the
// hook nothing drove. That is not a coincidence about this file; it is the
// general shape. The covered part was the part that writes JSON, because writing
// JSON is easy to assert about. The uncovered part was the part that kills
// things, because killing things is not.
//
// So the assertions below are built around the one distinction the old code
// could not make and the new code exists to make: a process that matches the
// name is not thereby YOURS. They come in three layers on purpose, because each
// layer can pass while the layer under it is a fiction:
//
//   1. classifyProcesses over fixtures     — the decision, in isolation
//   2. reapPosixOrphans over injected deps — the decision wired to a killer
//   3. REAL PROCESSES, REAL ps, REAL kill  — the same thing with nothing faked
//
// Layer 3 is the one that matters. Layers 1 and 2 grade a parser against a
// fixture the same person wrote, which is exactly the trap rule-gate-integrity
// names; only layer 3 can fail because the world disagrees.

const ROWS = (spec) => spec.map(([pid, ppid, uid, command]) => ({ pid, ppid, uid, command }));
const verdictFor = (verdicts, pid) => verdicts.find((v) => v.pid === pid);

// ------------------------------------------------------- layer 1: the decision

// THE TRIPLE, as fixtures. Three processes, one table, one uid: a genuine
// abandoned zombie, a peer's live browser, and — the case the old pattern could
// not survive — a peer's live browser whose command line MATCHES THE PATTERN
// EXACTLY. Cases (a) and (b) both passed under `pkill -f` too. Only (c) failed,
// which is why a suite that checked (a) and (b) would have reported this hook
// healthy on the day it was reaping other people's browsers.
{
    const uid = 501;
    const rows = ROWS([
        [4001, 1, uid, '/opt/ab/agent-browser-darwin-arm64 --headless'],            // (a) orphan
        [4002, 3900, uid, '/usr/local/bin/node /peer/session/run.js'],              // (b) live, no match
        [4003, 3901, uid, '/opt/ab/agent-browser-darwin-arm64 --remote-debugging'], // (c) live AND matching
    ]);
    const v = classifyProcesses(rows, { uid, self: 9999 });

    check('(a) an orphaned agent-browser is reaped', verdictFor(v, 4001).reap === true);
    check('    and the reason recorded is abandonment', verdictFor(v, 4001).reason === 'orphaned');
    check("(b) a peer's unrelated live process is spared", verdictFor(v, 4002).reap === false);
    check('    for not being an agent-browser at all', verdictFor(v, 4002).reason === 'not-agent-browser');
    // The whole defect, in one assertion.
    check("(c) a peer's LIVE browser that MATCHES THE PATTERN is spared", verdictFor(v, 4003).reap === false);
    check('    and is spared for having a living parent, not for its name',
        verdictFor(v, 4003).reason === 'live-parent');
    check('    exactly one of the three is reaped', v.filter((x) => x.reap).length === 1);
}

// A pattern match is necessary and NOT sufficient. Stated as its own assertion
// because the old code treated the two as the same thing.
{
    const uid = 501;
    const matching = ROWS([[5001, 77, uid, '/opt/ab/agent-browser-linux-x64']]);
    check('matching the binary name is not on its own grounds to kill',
        classifyProcesses(matching, { uid, self: 1 })[0].reap === false);
}

// Another user's orphan is never touched, even though it matches and is
// abandoned. The kill would fail with EPERM anyway; refusing to try is the
// point, because "the OS stopped me" is not a scoping decision.
{
    const rows = ROWS([[6001, 1, 502, '/opt/ab/agent-browser-darwin-arm64']]);
    const v = classifyProcesses(rows, { uid: 501, self: 1 });
    check("another user's orphaned browser is spared", v[0].reap === false);
    check('    for belonging to another user', v[0].reason === 'another-user');
}

// pid 1 and the sweeper itself can never be candidates, whatever they are called.
{
    const rows = ROWS([
        [1, 0, 501, '/sbin/launchd agent-browser-darwin'],
        [7007, 1, 501, '/usr/local/bin/node agent-browser-darwin-cleanup.js'],
    ]);
    const v = classifyProcesses(rows, { uid: 501, self: 7007 });
    check('pid 1 is never a candidate', verdictFor(v, 1).reap === false);
    check('the sweeper never selects itself', verdictFor(v, 7007).reap === false);
}

// --------------------------------------------------------- the parser it feeds
//
// `ps -o pid=,ppid=,uid=,command=` emits three integers then the rest of the line
// VERBATIM. A command line full of spaces (every Chromium one is) must survive
// intact, or the pattern test is run against a mangled string.
{
    const text = [
        '  4001     1   501 /opt/ab/agent-browser-darwin-arm64 --type=gpu-process --field-trial=a b c',
        '',
        ' header junk that is not a row',
        '  4002  3900   501 /usr/local/bin/node run.js',
    ].join('\n');
    const rows = parseProcessTable(text);
    check('parses well-formed ps rows and drops the rest', rows.length === 2);
    check('  keeps a command line containing spaces intact',
        rows[0].command === '/opt/ab/agent-browser-darwin-arm64 --type=gpu-process --field-trial=a b c');
    check('  reads pid, ppid and uid as numbers',
        rows[0].pid === 4001 && rows[0].ppid === 1 && rows[0].uid === 501);
}

// ---------------------------------------------- layer 2: the decision, wired up

// Every pid handed to the killer must be one the filter selected. This is the
// structural claim that replaced `pkill`: the killer receives pids, never a
// pattern, so there is no path by which it can expand its own selection.
{
    const uid = 501;
    const table = [
        '  4001     1   501 /opt/ab/agent-browser-darwin-arm64',
        '  4003  3901   501 /opt/ab/agent-browser-darwin-arm64 --remote-debugging',
    ].join('\n');
    const killed = [];
    const summary = reapPosixOrphans({
        readTable: () => table,
        readOne: (pid) => table.split('\n').filter((l) => l.trim().startsWith(String(pid))).join('\n'),
        kill: (pid, signal) => killed.push([pid, signal]),
        uid,
        self: 9999,
    });
    check('wired up: the orphan is signalled', killed.length === 1 && killed[0][0] === 4001);
    check('  with SIGTERM, the signal pkill -f sent — unchanged on purpose',
        killed[0][1] === 'SIGTERM');
    check('  and the live matching peer is never signalled',
        !killed.some(([pid]) => pid === 4003));
    check('  the summary agrees with what was signalled',
        summary.killed.length === 1 && summary.killed[0] === 4001);
    check('  and records the peer as spared with a reason',
        summary.spared.some((s) => s.pid === 4003 && s.reason === 'live-parent'));
}

// A pid resolved a moment ago can be recycled onto something else, or can stop
// being an orphan, before the signal lands. The re-read must re-run the SAME
// filter, not merely check the pid still exists.
{
    const uid = 501;
    const killed = [];
    reapPosixOrphans({
        readTable: () => '  4001     1   501 /opt/ab/agent-browser-darwin-arm64',
        // Between the sweep and the kill, 4001 is now a live child of 3900.
        readOne: () => '  4001  3900   501 /opt/ab/agent-browser-darwin-arm64',
        kill: (pid) => killed.push(pid),
        uid,
        self: 9999,
    });
    check('a pid that stopped qualifying between read and kill is not signalled',
        killed.length === 0);
}
{
    const uid = 501;
    const killed = [];
    // Recycled onto an unrelated process under the same pid.
    reapPosixOrphans({
        readTable: () => '  4001     1   501 /opt/ab/agent-browser-darwin-arm64',
        readOne: () => '  4001     1   501 /usr/bin/something-else-entirely',
        kill: (pid) => killed.push(pid),
        uid,
        self: 9999,
    });
    check('a recycled pid is not signalled on the strength of the stale read',
        killed.length === 0);
}

// FAIL OPEN. This ships installed; a throw here kills a stranger's turn at
// SessionStart and they cannot patch it until they reinstall.
{
    let threw = false;
    let out;
    try {
        out = reapPosixOrphans({
            readTable: () => { throw new Error('ps: command not found'); },
            kill: () => { throw new Error('should never be reached'); },
            uid: 501,
        });
    } catch { threw = true; }
    check('an unreadable process table does not throw', !threw);
    check('  and kills nothing — no evidence is a reason to do nothing',
        !!out && out.killed.length === 0);
}
{
    let threw = false;
    try {
        reapPosixOrphans({
            readTable: () => '  4001     1   501 /opt/ab/agent-browser-darwin-arm64',
            readOne: () => '  4001     1   501 /opt/ab/agent-browser-darwin-arm64',
            kill: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; },
            uid: 501,
            self: 9999,
        });
    } catch { threw = true; }
    check('a kill that is refused by the OS does not throw', !threw);
}

// -------------------------------------------- the shipped default, over fixtures
//
// Layer 3 below substitutes ONE thing — the pattern — for reasons recorded
// there. This assertion is what joins the two halves: with nothing injected but
// a table and a killer, the DEFAULT pattern is the production one, so layer 1's
// decisions are the decisions the shipped hook makes.
{
    const killed = [];
    const table = '  4001     1   501 /opt/ab/agent-browser-darwin-arm64 --headless';
    reapPosixOrphans({
        readTable: () => table,
        readOne: () => table,
        kill: (pid) => killed.push(pid),
        uid: 501,
        self: 9999,
        // pattern deliberately omitted
    });
    check('with no pattern given, the default is the production binary pattern',
        killed.length === 1 && killed[0] === 4001);
    check('  and that default is the exported one', AGENT_BROWSER_BINARY.test('agent-browser-darwin-arm64'));
}

// ------------------------------------------ layer 3: real processes, no fixtures
//
// Everything above grades a parser against a table this file wrote. This block
// grades the shipped function against the operating system: real forks, real
// reparenting by the kernel, the real `ps` binary, the real uid, and a real
// SIGTERM delivered by process.kill. It is the only part that can fail because
// the world disagrees rather than because the fixture does.
//
// ONE THING IS INJECTED: the pattern, which is made unique to this process. The
// reason is not convenience, it is a measurement taken while writing this file.
// Decoys named to match the PRODUCTION pattern died on their own, before any
// assertion ran, in 1 of 3 consecutive trials — and so did the shell that
// spawned them, whose own command line contained the pattern because the
// heredoc that wrote the decoy did. On this machine there are dozens of
// worktrees and other Claude sessions start constantly; every one of them runs
// the SessionStart hook this file is testing, and until this commit that hook
// ran `pkill -f "agent-browser-(linux|darwin)"`. A stranger's cleanup reached
// into this test run and killed its fixtures.
//
// That is the defect, observed in the wild, on the machine the fix was written
// on, while the fix was being written. It is also the reason the decoys below
// must NOT be named after the production pattern: a suite whose fixtures any
// peer session can reap is a suite that goes red for reasons its owner cannot
// see — the exact misattribution this whole change is about. The assertion
// immediately above pins the production pattern separately, so nothing is lost
// by keeping these decoys out of its reach.
if (process.platform !== 'win32') {
    // Unique per run, so no peer's sweep — old or new — can match it, and two
    // copies of this suite running concurrently cannot reap each other.
    const tag = 'abdecoy-' + process.pid + '-';
    const pattern = new RegExp(tag);

    const decoyDir = path.join(TMP, 'decoys');
    fs.mkdirSync(decoyDir, { recursive: true });
    const decoy = path.join(decoyDir, tag + 'browser.js');
    fs.writeFileSync(decoy, 'setInterval(() => {}, 1000);\n');

    // `process.kill(pid, 0)` is the obvious liveness test and it is WRONG here.
    // A dead child whose parent has not waited on it stays in the process table
    // as a zombie, and signal 0 succeeds against a zombie. Two of the three
    // decoys are children of this suite, which is synchronous start to finish
    // and never reaps anything — so a peer that the sweep had just killed would
    // report as alive. Measured, not theorised: with the ownership test deleted
    // from the hook, assertion (c) below reported PASS on a peer that the same
    // run's own summary said it had signalled. Ask `ps` for the process STATE
    // and treat 'Z' as dead; an empty state means the pid is gone entirely.
    const alive = (pid) => {
        const r = spawnSync('ps', ['-p', String(pid), '-o', 'state='], { encoding: 'utf8' });
        const state = (r.stdout || '').trim();
        return state !== '' && !state.startsWith('Z');
    };
    const waitFor = (fn, ms = 5000) => {
        const end = Date.now() + ms;
        for (;;) {
            if (fn()) return true;
            if (Date.now() >= end) return false;
            // Synchronous sleep: this suite is synchronous throughout, and a
            // real fork takes single-digit milliseconds to appear in `ps`.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    };

    // (c) A LIVE decoy that MATCHES THE PATTERN, parented to this suite. Under
    // the old code — one pattern, no ownership test — this process died. It
    // stands in for a peer's browser: same name, different session, in use.
    const live = spawn(process.execPath, [decoy, '--live-peer'], { stdio: 'ignore' });

    // (b) A LIVE decoy that does not match, to show the filter is not simply
    // sparing everything that is running.
    const inert = path.join(decoyDir, 'inert-control.js');
    fs.copyFileSync(decoy, inert);
    const unrelated = spawn(process.execPath, [inert, '--live-unrelated'], { stdio: 'ignore' });

    // (a) A genuine abandoned zombie: a grandchild whose parent exits, so the
    // kernel reparents it to pid 1 — the state a browser is left in when the
    // session that launched it goes away.
    // detached + unref, or the launcher cannot exit: an un-unref'd child handle
    // keeps its parent's event loop alive, so spawnSync would block for as long
    // as the grandchild lives — which is the whole point of the grandchild. That
    // cost one hung run before it was understood, and the hang looked exactly
    // like a slow machine under fleet load.
    const launcher = spawnSync(process.execPath, ['-e', `
        const { spawn } = require('child_process');
        const g = spawn(process.argv[1], [${JSON.stringify(decoy)}, '--orphan'], {
            stdio: 'ignore',
            detached: true,
        });
        g.unref();
        process.stdout.write(String(g.pid));
    `, process.execPath], { encoding: 'utf8', timeout: 20000 });
    const orphanPid = Number((launcher.stdout || '').trim());

    const reparented = waitFor(() => {
        if (!orphanPid || !alive(orphanPid)) return false;
        const r = spawnSync('ps', ['-p', String(orphanPid), '-o', 'ppid='], { encoding: 'utf8' });
        return Number((r.stdout || '').trim()) === 1;
    });

    check('fixture: a live decoy matching the pattern is running',
        !!live.pid && alive(live.pid));
    check('fixture: a live decoy NOT matching the pattern is running',
        !!unrelated.pid && alive(unrelated.pid));
    check('fixture: an orphan exists and the kernel reparented it to pid 1', reparented);

    // Anti-vacuity. If the decoys ever stop being visible to `ps` under this
    // pattern, every assertion below passes for the wrong reason: nothing is
    // selected, so nothing is killed, so the live ones "survive". Pin it.
    const psAll = spawnSync('ps', ['-e', '-ww', '-o', 'pid=,ppid=,uid=,command='], { encoding: 'utf8' }).stdout || '';
    const seen = parseProcessTable(psAll).filter((r) => pattern.test(r.command)).map((r) => r.pid);
    check('both the orphan and the live peer are visible to ps under one pattern',
        seen.includes(live.pid) && seen.includes(orphanPid));
    check('  which is what a single pattern kill would have swept',
        seen.length >= 2);

    // The shipped function. Real ps, real kill, real uid, real self.
    let sweepThrew = false;
    let summary;
    try { summary = reapPosixOrphans({ pattern }); } catch { sweepThrew = true; }

    check('the real sweep does not throw', !sweepThrew);
    check('(a) REAL: the genuine zombie is reaped — the hook still does its job',
        waitFor(() => !alive(orphanPid)));

    // Signal delivery is asynchronous: a process signalled a millisecond ago is
    // still alive a millisecond later. Checking liveness immediately after the
    // sweep is therefore a check that passes whether or not the peer was
    // signalled. Measured: with the ownership test deleted from the hook, the
    // unsettled form of the (c) assertion below still reported PASS while the
    // peer was mid-death. Wait for the zombie to actually go — which is the
    // same event loop turn the peer's signal would have landed in — and only
    // then ask whether the peer is alive.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);

    check('(b) REAL: an unrelated live process survives', alive(unrelated.pid));
    check('(c) REAL: a live peer MATCHING THE PATTERN survives', alive(live.pid));
    check('  and the sweep spared it for having a living parent, not by luck',
        !!summary && summary.spared.some((s) => s.pid === live.pid && s.reason === 'live-parent'));
    check('  exactly one process was signalled',
        !!summary && summary.killed.length === 1 && summary.killed[0] === orphanPid);
    check('  the population it scanned is reported, not just its verdict',
        !!summary && summary.scanned > 1);

    try { live.kill('SIGKILL'); } catch {}
    try { unrelated.kill('SIGKILL'); } catch {}
    try { if (orphanPid) process.kill(orphanPid, 'SIGKILL'); } catch {}
}

// ------------------------------------------------------- no pattern kill, ever
//
// A tripwire, not a behaviour test. The three layers above prove what the code
// DOES; this proves the shape it must keep, because the defect was reintroduced
// trivially — one line — and its return would make every assertion above pass
// while a peer's browser died, as long as the pattern kill ran alongside them.
{
    const src = fs.readFileSync(HOOK, 'utf8');
    const executable = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    check('the POSIX branch hands no pattern to a killer',
        !/\b(pkill|killall)\b/.test(executable));
    check('  and the source still discusses why, so the ban is not folklore',
        /pkill/.test(src) && src.length > executable.length);
}

// ------------------------------------------------- deliberately not covered
//
// The remaining survivors on this file are all `isWin` platform gates plus the
// `require.main === module` entrypoint guard. On a non-Windows machine the
// Windows branches are unreachable, and forcing them on would have this hook
// shell out to taskkill and PowerShell from a test run. pre-tool-filter.js
// solved the same problem with an injectable platform, but that file only
// consults denylists; this one KILLS PROCESSES, and an env var that makes a
// macOS session take the Windows path is a worse thing to own than the gap.
// Recorded rather than forced.

// ------------------------------------------------------------------ entrypoint

// SessionStart must never be blocked, and the hook must stay silent on the happy
// path — it runs at the start of every session.
{
    const sb = sandbox();
    const r = spawnSync(process.execPath, [HOOK], {
        encoding: 'utf8',
        env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, LOCALAPPDATA: sb.localAppData },
    });
    check('run as a hook: exits 0', r.status === 0);
    check('  and says nothing on stdout', (r.stdout || '') === '');
    // Zero bytes means BOTH streams. Checking one of the two is how a hook that
    // narrates itself on every session start gets shipped.
    check('  and says nothing on stderr either', (r.stderr || '') === '');
}

// The Windows-only paths must be inert elsewhere, or a macOS session start would
// shell out to taskkill on every launch.
if (process.platform !== 'win32') {
    let threw = false;
    try { mod.restoreSnippingToolHotkey(); } catch { threw = true; }
    check('restoreSnippingToolHotkey is a no-op off Windows', !threw);
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
