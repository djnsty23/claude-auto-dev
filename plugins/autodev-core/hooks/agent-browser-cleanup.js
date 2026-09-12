#!/usr/bin/env node
/**
 * agent-browser cleanup.
 *
 * DELETED IN 8.79.0 AND RESTORED IN 8.80.0 — do not delete it again on the
 * grounds that the agent-browser skills are gone. They are, and that was right:
 * the session drives pages through mcp__Claude_Browser__* and chrome-devtools
 * now, so no skill launches this CLI any more.
 *
 * But the BINARY is still installed at ~/AppData/Roaming/npm/agent-browser, and
 * it still has a live consumer that has nothing to do with this plugin:
 * kb-factory's `crawl_js.py` drives it to render JS-heavy documentation sites,
 * which is how the meta-ads and reddit-ads knowledge bases are refreshed. Both
 * of those skills correctly still name it.
 *
 * So 8.79.0 removed the guidance and left the cause: a KB refresh can still
 * spawn the zombie Chromium and still steal the Win+Shift+S hotkey, with
 * nothing left to clean up after it. Removing a tool's docs is not the same as
 * removing the tool — enumerate a thing's consumers before deleting its safety
 * net, not after.
 *
 * Registered as a SessionStart hook in hooks/hooks.json (it was previously
 * orphaned — the header claimed session-start.js invoked it, but nothing did),
 * and exposed for manual mid-session use:
 *
 *   node "${CLAUDE_PLUGIN_ROOT}/hooks/agent-browser-cleanup.js"
 *
 * Handles two Windows-specific failure modes that BOTH originate from the
 * same root cause: the bundled Chromium binary persisting after a session.
 *
 * 1. Zombie bundled Chromium after `close --all`.
 *    `agent-browser close --all` reports "Closed session" but does NOT kill
 *    `agent-browser-win32-x64.exe` on Windows. The orphan holds DXGI/GPU
 *    resources, which has been observed to:
 *      - Render the user's real Chrome as a black window
 *      - Break the global Win+Shift+S (Snipping Tool) hotkey
 *      - Persist indefinitely until reboot or manual taskkill
 *    A real ~30 min Chrome / Snipping Tool / DWM lockup occurred 2026-04-28
 *    during a Project C testing session because of exactly this.
 *
 * 2. Bundled Chromium auto-registers itself for Windows startup.
 *    First launch silently writes an HKCU\...\Run entry so Chromium spawns
 *    at every Windows boot (banner: "Chromium now launches when Windows
 *    starts..."). Combined with #1, the orphan persists across reboots.
 *    We delete the registry entry AND patch each Chromium profile's
 *    Preferences to set `auto_launch_chrome_on_startup: false` and
 *    `background_mode.enabled: false`, so the next launch doesn't
 *    re-register.
 *
 * Best-effort and silent on the happy path. The module always exits 0 —
 * never blocks session start. Both platforms reap zombies BY PID after
 * proving each one is abandoned, never by name or command-line pattern,
 * which cannot tell a dead browser of yours from a live browser of somebody
 * else's. macOS/Linux stop there (the autostart vector is Windows-specific).
 * See the POSIX and Windows reaping sections below; that distinction is the
 * whole of it.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------- POSIX reaping
//
// This branch used to be one line:
//
//     execSync('pkill -f "agent-browser-(linux|darwin)"')
//
// and its catch block read "Expected when no zombies". That comment is the
// whole defect in miniature: the author reasoned carefully about what happens
// when NOTHING matches, and never once about what happens when something
// matches THAT IS NOT THEIRS.
//
// `pkill -f` selects by command-line regex. A command line carries no
// ownership: it cannot say which session started the process, and on a machine
// running more than one Claude session every session's agent-browser is
// spelled identically. So the pattern matched a stranger's LIVE browser
// exactly as well as it matched the caller's dead one, and killed both. This
// file ships inside other people's Claude Code installs, so the blast radius
// was other people's live work, and the symptom on their side — a browser that
// vanished mid-task — reads as a flake rather than as someone else's cleanup.
//
// WHAT THIS HOOK CANNOT KNOW, stated plainly because the fix depends on it.
// The obvious repair is "track the pids you spawned and kill only those". This
// hook spawns none. Nothing under plugins/ launches agent-browser at all: the
// live consumer is kb-factory's crawl_js.py, in another repo, in another
// process tree, usually in an earlier session that has already exited. The
// hook is a janitor for processes it never created and has no registry of.
// Ownership is therefore NOT DISCOVERABLE here, and any filter that claims to
// recover it is a scoping story, not a scope.
//
// ABANDONMENT, unlike ownership, leaves a trace. A browser that is still being
// driven has a living launcher; a browser left behind by a session that exited
// has been reparented to pid 1. That is not a proxy for ownership — it is a
// weaker claim, and it is the strongest one available. So the filter below
// asks for POSITIVE EVIDENCE OF ABANDONMENT and spares everything else:
//
//   1. the process belongs to this uid          (never another user's)
//   2. its command line matches the binary      (necessary, NOT sufficient —
//                                                this was the only old test)
//   3. its parent is gone, ppid === 1           (the launcher that would still
//                                                be driving it has exited)
//
// and then kills BY PID, one justified decision per process, with no pattern
// ever handed to a killer.
//
// THE RESIDUAL, so nobody has to rediscover it. If agent-browser is ever run
// as a deliberately detached daemon, a LIVE one is also parented to pid 1 and
// rule 3 stops discriminating. Unverifiable from here — the binary is not
// installed on the machine this was written on, and guessing its process model
// is how the original defect was written. The direction of the remaining error
// is the part that is chosen rather than assumed: reaping too little leaves a
// zombie until the user reboots or runs this file by hand, which is visible,
// documented and recoverable; reaping too much destroys a stranger's live work
// invisibly, in an installed hook they cannot patch. Those costs are not
// close, so every ambiguous case is spared.

const AGENT_BROWSER_BINARY = /agent-browser-(linux|darwin)/;

// `ps` cannot kill anything, so reading the table is the safe half. -ww defeats
// the width truncation that would otherwise cut a long command line short and
// turn a match into a miss. windowsHide is a no-op on POSIX, where this runs;
// it is set because validate's spawn scan is line-scoped and cannot see which
// platform branch a call sits in.
function readProcessTable() {
    return execFileSync('ps', ['-e', '-ww', '-o', 'pid=,ppid=,uid=,command='], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
    });
}

// One process, re-read immediately before the kill. Throws if the pid is gone.
function readOneProcess(pid) {
    return execFileSync('ps', ['-p', String(pid), '-ww', '-o', 'pid=,ppid=,uid=,command='], {
        encoding: 'utf8',
        windowsHide: true,
    });
}

// Pure. `ps -o pid=,ppid=,uid=,command=` gives three integers then the rest of
// the line verbatim, so the command may contain any amount of whitespace and
// must not be re-joined from tokens.
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/;

function parseProcessTable(text) {
    const rows = [];
    for (const line of String(text).split('\n')) {
        const m = PS_ROW.exec(line);
        if (!m) continue;
        rows.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            uid: Number(m[3]),
            command: m[4],
        });
    }
    return rows;
}

// Pure, and the only place the decision is made. Returns one verdict per row so
// a spared process can say WHY it was spared — a filter that returns bare pids
// cannot be tested for the difference between "spared deliberately" and "never
// looked at".
function classifyProcesses(rows, { pattern = AGENT_BROWSER_BINARY, uid, self = process.pid } = {}) {
    const verdicts = [];
    for (const row of rows) {
        let reason = null;
        if (row.pid === self || row.pid === 1) reason = 'self-or-init';
        else if (uid !== undefined && row.uid !== uid) reason = 'another-user';
        else if (!pattern.test(row.command)) reason = 'not-agent-browser';
        else if (row.ppid !== 1) reason = 'live-parent';
        verdicts.push({ ...row, reap: reason === null, reason: reason || 'orphaned' });
    }
    return verdicts;
}

// Enumerate, classify, re-verify, kill by pid. Every dependency is injectable so
// the decision can be driven over fixtures AND over real processes without ever
// handing a pattern to a killer. Returns a summary; callers on the hook path
// ignore it, because a hook with nothing to say must emit zero bytes.
function reapPosixOrphans(deps = {}) {
    const {
        readTable = readProcessTable,
        readOne = readOneProcess,
        kill = (pid, signal) => process.kill(pid, signal),
        uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
        pattern = AGENT_BROWSER_BINARY,
        self = process.pid,
        // SIGTERM, matching what `pkill -f` sent. Deliberately unchanged: this
        // commit narrows WHICH processes are signalled, not how hard.
        signal = 'SIGTERM',
    } = deps;

    const summary = { scanned: 0, matched: 0, killed: [], spared: [] };
    let rows;
    try {
        rows = parseProcessTable(readTable());
    } catch {
        // No process table, no evidence, no kills. Failing to read `ps` is a
        // reason to do nothing, never a reason to fall back to a pattern.
        return summary;
    }

    summary.scanned = rows.length;
    for (const v of classifyProcesses(rows, { pattern, uid, self })) {
        if (v.reason !== 'not-agent-browser' && v.reason !== 'another-user') summary.matched++;
        if (!v.reap) {
            if (v.reason !== 'not-agent-browser') summary.spared.push({ pid: v.pid, reason: v.reason });
            continue;
        }
        // A pid resolved a moment ago can be recycled onto an unrelated process
        // before the signal lands. Re-reading the single pid and re-running the
        // same filter costs one `ps` on a population that is normally empty, and
        // is the difference between killing a pid and killing the process the
        // decision was actually about.
        let still;
        try {
            still = classifyProcesses(parseProcessTable(readOne(v.pid)), { pattern, uid, self });
        } catch {
            summary.spared.push({ pid: v.pid, reason: 'vanished' });
            continue;
        }
        if (still.length !== 1 || !still[0].reap) {
            summary.spared.push({ pid: v.pid, reason: 'changed-under-us' });
            continue;
        }
        try {
            kill(v.pid, signal);
            summary.killed.push(v.pid);
        } catch {
            // Already exited, or not ours to signal. Either way the desired
            // state holds and there is nothing to report.
            summary.spared.push({ pid: v.pid, reason: 'kill-refused' });
        }
    }
    return summary;
}

// -------------------------------------------------------------- Windows reaping
//
// This branch used to be four name-scoped kills and a registry scan, run
// unconditionally on every SessionStart:
//
//     wmic process where "CommandLine like '%agent-browser%eval%'" delete
//       (PowerShell Get-CimInstance | Stop-Process when wmic is absent)
//     taskkill /F /T /IM "agent-browser-win32-x64.exe"
//     taskkill /F /IM "crashpad_handler.exe"
//     taskkill /F /IM "SnippingTool.exe" / "ScreenClippingHost.exe"
//
// It had the POSIX defect in four forms, and two of them were worse than
// `pkill -f`. A command-line LIKE kills any process that MENTIONS the words:
// a shell loop, a grep, an editor with the file open, not only agent-browser.
// And crashpad_handler.exe is not agent-browser's at all. `[measured
// 2026-09-13]` the Chrome for Testing that agent-browser installs under
// ~/.agent-browser/browsers ships no crashpad_handler.exe (Chrome runs its crash
// reporter as chrome.exe --type=crashpad-handler), and the one crashpad_handler
// running on the machine this was measured on belonged to a music player. So
// that line only ever killed OTHER apps' crash reporters, at every session start.
// The Snipping Tool kill discarded any unsaved capture open in its editor.
//
// It was also the most expensive SessionStart hook in either plugin: 1,382 ms
// median over a non-destructive replica (N=10 after one cold run), of which the
// PowerShell fallback was 339 ms (wmic is not installed on current Windows 11,
// so it fails in 27 ms and the fallback ran every time), four taskkill spawns
// ~127 ms each, and the registry PowerShell 205 ms. Full numbers in
// docs/evidence-agent-browser-cleanup-windows-2026-09-13.md.
//
// WHAT IS ATTRIBUTABLE ON WINDOWS, which differs from POSIX in two ways.
//
// There is no reparenting. A process whose launcher exited keeps the dead
// launcher's pid as its ParentProcessId, and that pid can be recycled onto an
// unrelated process. So "parent gone" is read as: no process holds that pid, OR
// the process holding it was CREATED AFTER the child. A parent cannot be younger
// than its child, so a younger holder is a recycled pid, not the parent.
//
// And agent-browser's daemon is DETACHED BY DESIGN. Its README: "The browser
// persists via a background daemon". A live daemon between two CLI calls has a
// dead parent exactly like a zombie does, which is the residual the POSIX section names
// as unverifiable. It is verifiable here, because the binary is installed on the
// machine this was written on: the daemon records itself in a sidecar,
// ~/.agent-browser/<session>.pid, which `agent-browser doctor` cleans when stale.
// `close --all` removes the session and, per the incident in the header, can
// leave the process running. So a daemon the registry still names is live by
// design, and one it no longer names is the zombie this hook exists for.
//
// The filter, per process:
//
//   1. its image IS the agent-browser binary     (by image name, never by a
//      or its command line names an agent-browser  mention in a command line)
//      profile (--user-data-dir=...agent-browser-chrome-<id>, read out of the
//      shipping binary), or its executable lives under .agent-browser\browsers
//   2. it belongs to this user's SID             (unknown owner is spared)
//   3. walking up through agent-browser processes, no ancestor is a daemon the
//      sidecar registry names, and the chain ends at a dead or recycled parent
//   4. a browser with no binary above it is reaped only when no live registered
//      daemon exists for this user: a live daemon's browser whose launch
//      topology this file has not observed must not be read as abandoned
//
// then re-read once, re-classify, and kill BY PID only processes whose verdict
// and creation time are unchanged. No name, image or command-line pattern is
// ever handed to a killer.
//
// COST ON THE ORDINARY PATH. Enumerating command lines needs PowerShell (~340 ms,
// there is no cheaper built-in reader since wmic was removed). So a gate runs
// first: `tasklist` filtered to agent-browser-* images (~90 ms, no command lines
// needed) plus a directory check for agent-browser-chrome-* profiles in Temp. If
// neither is present there is nothing attributable to find and PowerShell never
// starts. The old code could not reap a browser whose binary had already exited
// either, because `taskkill /T` walks down from a LIVE process, so the gate removes no
// case the old code handled.
//
// THE SNIPPING TOOL RESET is kept and scoped. The three incidents in
// restoreSnippingToolHotkey's comment all had agent-browser zombies present at
// cleanup time, and all needed the reset AFTER the zombies were killed. So it
// now runs exactly then: when this sweep killed at least one attributable
// process, against this user's Snipping Tool pids from the same verified table.
// Run the file with --reset-hotkey to force it by hand.
//
// RESIDUALS, so nobody has to rediscover them.
//   - A live CLI loop is spared, because a live parent is indistinguishable from
//     a working crawl. The 2026-04-29 `until` loop that leaked an orphan per
//     iteration came from the agent-browser skills, which are gone; its leaked
//     orphans are still reaped at the next session start, the loop is not.
//   - Whether Chrome's child processes carry --user-data-dir on every launch is
//     inferred, not observed. Chrome children exit when their browser process
//     dies, so reaping the browser root is sufficient where a child is missed.

const WIN_BINARY_IMAGE = /^agent-browser-win32-[a-z0-9]+\.exe$/i;
const WIN_PROFILE_ARG = /--user-data-dir=(?:"[^"]*|[^\s"]*)[\\/]agent-browser-chrome-/i;
const WIN_BUNDLED_BROWSER = /[\\/]\.agent-browser[\\/]browsers[\\/]/i;
const WIN_PROFILE_NAME = /agent-browser-chrome-[A-Za-z0-9._-]+/gi;
const HOTKEY_IMAGES = new Set(['snippingtool.exe', 'screenclippinghost.exe']);
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const isAgentBrowserBinary = (row) => WIN_BINARY_IMAGE.test(row.name || '');
const isAgentBrowserBrowser = (row) =>
    WIN_PROFILE_ARG.test(row.command || '') || WIN_BUNDLED_BROWSER.test(row.exe || '');

const tempRootFor = () =>
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Temp');

// The gate. `tasklist` reads image names only, which is enough to say whether an
// agent-browser binary is running. A throw means "could not tell", which opens
// the gate: the cost of a wrong open is one PowerShell run, never a kill.
// Every reader pipes stdout and DISCARDS stderr. execFileSync's default stdio
// forwards a child's stderr to this hook's own, and `[measured 2026-09-13]`
// PowerShell's first run on a machine writes a CLIXML progress record there
// ("Preparing modules for first use"), which would break the zero-byte contract
// on exactly the session start nobody is watching.
const READ_STDIO = ['ignore', 'pipe', 'ignore'];

function listBinaryImages({ run = execFileSync } = {}) {
    return run('tasklist', ['/FI', 'IMAGENAME eq agent-browser-*', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        stdio: READ_STDIO,
        windowsHide: true,
    });
}

function candidatesPossible({ listImages = listBinaryImages, tempRoot = tempRootFor() } = {}) {
    try {
        if (fs.readdirSync(tempRoot).some((n) => n.startsWith('agent-browser-chrome-'))) return true;
    } catch {
        // No Temp directory is not evidence of anything; fall through to images.
    }
    try {
        return /^"agent-browser-win32-[a-z0-9]+\.exe"/im.test(String(listImages()));
    } catch {
        return true;
    }
}

// One PowerShell run, one table. Every process gets pid, parent and creation
// time, because the parent test needs the whole table. Only candidates get a
// command line and an owner SID, because GetOwnerSid is a method call per
// process and the candidate population is normally empty. The pre-filter here is
// deliberately BROADER than the classifier: it decides what is read, never what
// is killed. `alsoLike` widens it for the real-process suite and nothing else.
function windowsTableScript(alsoLike = '') {
    const also = String(alsoLike).replace(/'/g, "''");
    return [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$ProgressPreference = 'SilentlyContinue'",
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
        '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        `$also = '${also}'`,
        '$out = New-Object System.Collections.Generic.List[string]',
        '$out.Add("ME`t$me")',
        '$props = @("Handle","ProcessId","ParentProcessId","CreationDate","Name","ExecutablePath","CommandLine")',
        'foreach ($p in Get-CimInstance Win32_Process -Property $props) {',
        "  $c = ''; if ($p.CreationDate) { $c = $p.CreationDate.ToFileTimeUtc() }",
        "  $name = [string]$p.Name; $exe = [string]$p.ExecutablePath; $cmd = [string]$p.CommandLine",
        "  $cand = ($name -like 'agent-browser-*') -or ($cmd -like '*agent-browser-chrome-*') -or",
        "    ($exe -like '*\\.agent-browser\\*') -or ($name -eq 'SnippingTool.exe') -or",
        "    ($name -eq 'ScreenClippingHost.exe') -or ($also -ne '' -and $cmd -like $also)",
        '  if ($cand) {',
        "    $sid = ''",
        "    $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid",
        '    if ($o -and $o.ReturnValue -eq 0) { $sid = [string]$o.Sid }',
        '    $f = @($name, $exe, $cmd) | ForEach-Object { $_ -replace "[`t`r`n]", " " }',
        '    $out.Add("C`t$($p.ProcessId)`t$($p.ParentProcessId)`t$c`t$sid`t$($f[0])`t$($f[1])`t$($f[2])")',
        '  } else {',
        '    $out.Add("P`t$($p.ProcessId)`t$($p.ParentProcessId)`t$c")',
        '  }',
        '}',
        '[Console]::Out.Write(($out -join "`n"))',
    ].join('\n');
}

function readWindowsProcessTable({ run = execFileSync, alsoLike = '' } = {}) {
    const encoded = Buffer.from(windowsTableScript(alsoLike), 'utf16le').toString('base64');
    return run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        stdio: READ_STDIO,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
    });
}

// Pure. Creation time stays a decimal STRING: a FILETIME is ~1.3e17, past the
// 2^53 where a Number stops distinguishing adjacent values, and the parent test
// compares two of them.
function parseWindowsProcessTable(text) {
    let sid;
    const rows = [];
    for (const line of String(text).split(/\r?\n/)) {
        const f = line.split('\t');
        if (f[0] === 'ME') {
            sid = f[1] || undefined;
            continue;
        }
        if ((f[0] !== 'P' && f[0] !== 'C') || !/^\d+$/.test(f[1] || '') || !/^\d+$/.test(f[2] || '')) continue;
        const row = {
            pid: Number(f[1]),
            ppid: Number(f[2]),
            created: /^\d+$/.test(f[3] || '') ? f[3] : null,
            sid: null,
            name: '',
            exe: '',
            command: '',
        };
        if (f[0] === 'C') {
            row.sid = f[4] || null;
            row.name = f[5] || '';
            row.exe = f[6] || '';
            row.command = f.slice(7).join('\t');
        }
        rows.push(row);
    }
    return { sid, rows };
}

// The daemon registry. A missing directory is an empty registry; any other read
// failure THROWS, because an unreadable registry would make every live daemon
// look unregistered, and the reaper treats a throw as "do nothing".
function readDaemonPids({
    dirs = [process.env.AGENT_BROWSER_SOCKET_DIR, path.join(os.homedir(), '.agent-browser')],
} = {}) {
    const pids = new Set();
    for (const dir of dirs.filter(Boolean)) {
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch (e) {
            if (e && e.code === 'ENOENT') continue;
            throw e;
        }
        for (const name of names) {
            if (!name.endsWith('.pid')) continue;
            const text = fs.readFileSync(path.join(dir, name), 'utf8').trim();
            if (/^\d+$/.test(text)) pids.add(Number(text));
        }
    }
    return pids;
}

// Pure, and the only place the Windows decision is made. One verdict per row,
// with a reason, for the same reason classifyProcesses returns one: a spared
// process must be able to say whether it was spared deliberately.
function classifyWindowsProcesses(rows, opts = {}) {
    const {
        sid,
        self = process.pid,
        registered = new Set(),
        isBinary = isAgentBrowserBinary,
        isBrowser = isAgentBrowserBrowser,
    } = opts;
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const kindOf = (r) => (isBinary(r) ? 'binary' : isBrowser(r) ? 'browser' : null);
    const mine = (r) => !!sid && r.sid === sid;
    const bigOrNull = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null);

    // The parent a row actually has: null when its launcher is gone. A holder of
    // the ppid created after the child is a recycled pid. An unknown creation
    // time on either side cannot prove recycling, so the holder is kept.
    const parentOf = (r) => {
        const p = byPid.get(r.ppid);
        if (!p || p.pid === r.pid) return null;
        const pc = bigOrNull(p.created);
        const cc = bigOrNull(r.created);
        return pc !== null && cc !== null && pc > cc ? null : p;
    };

    const liveDaemon = rows.some((r) => mine(r) && kindOf(r) === 'binary' && registered.has(r.pid));

    const decide = (row) => {
        if (row.pid === self || row.pid === 0 || row.pid === 4) return { reason: 'self-or-system' };
        const kind = kindOf(row);
        if (!kind) return { reason: 'not-agent-browser' };
        if (!sid || !row.sid) return { reason: 'owner-unknown' };
        if (row.sid !== sid) return { reason: 'another-user' };
        const seen = new Set();
        let cur = row;
        for (let depth = 0; ; depth++) {
            if (seen.has(cur.pid)) return { reason: 'ambiguous' };
            seen.add(cur.pid);
            const curKind = kindOf(cur);
            if (curKind === 'binary' && registered.has(cur.pid)) return { reason: 'registered-daemon' };
            const p = parentOf(cur);
            if (!p) {
                if (curKind === 'browser' && liveDaemon) return { reason: 'daemon-alive' };
                return { reason: cur === row ? 'orphaned' : 'orphaned-tree', depth };
            }
            if (!kindOf(p) || !mine(p)) return { reason: 'live-parent' };
            cur = p;
        }
    };

    return rows.map((row) => {
        const { reason, depth = 0 } = decide(row);
        const reap = reason === 'orphaned' || reason === 'orphaned-tree';
        return { ...row, kind: kindOf(row), reap, reason, depth };
    });
}

// Pure. This user's Snipping Tool processes, by pid, out of a table already read.
function selectHotkeyTargets(rows, sid) {
    if (!sid) return [];
    return rows
        .filter((r) => r.sid === sid && HOTKEY_IMAGES.has(String(r.name).toLowerCase()))
        .map((r) => r.pid);
}

// Gate, enumerate, classify, re-verify, kill by pid. Every dependency is
// injectable, as in reapPosixOrphans, so the decision can be driven over
// fixtures on every platform and over real processes on Windows.
function reapWindowsOrphans(deps = {}) {
    const {
        gate = candidatesPossible,
        readTable = readWindowsProcessTable,
        readRegistered = readDaemonPids,
        // process.kill on Windows is TerminateProcess whatever the signal, which
        // is what taskkill /F did. This narrows WHICH processes, not how hard.
        kill = (pid) => process.kill(pid),
        self = process.pid,
        isBinary = isAgentBrowserBinary,
        isBrowser = isAgentBrowserBrowser,
    } = deps;

    const summary = { gated: false, scanned: 0, matched: 0, killed: [], spared: [], hotkeyReset: [], liveProfiles: [] };

    let open;
    try {
        open = gate();
    } catch {
        open = true;
    }
    if (!open) {
        summary.gated = true;
        return summary;
    }

    let table;
    let registered;
    try {
        table = parseWindowsProcessTable(readTable());
        registered = readRegistered();
    } catch {
        // No table or no registry, no evidence, no kills.
        return summary;
    }

    const opts = { sid: table.sid, self, registered, isBinary, isBrowser };
    summary.scanned = table.rows.length;
    const verdicts = classifyWindowsProcesses(table.rows, opts);
    const reap = [];
    for (const v of verdicts) {
        if (!v.kind) continue;
        if (v.reason !== 'another-user') summary.matched++;
        if (v.reap) reap.push(v);
        else {
            if (v.reason !== 'self-or-system') summary.spared.push({ pid: v.pid, reason: v.reason });
            if (v.kind === 'browser') summary.liveProfiles.push(...(v.command.match(WIN_PROFILE_NAME) || []));
        }
    }
    if (!reap.length) return summary;

    // Creation time is the identity a pid lacks. A second read costs one more
    // PowerShell run, and only on a machine that has something to reap.
    let again;
    try {
        again = parseWindowsProcessTable(readTable());
    } catch {
        for (const v of reap) summary.spared.push({ pid: v.pid, reason: 'vanished' });
        return summary;
    }
    const now = new Map(classifyWindowsProcesses(again.rows, { ...opts, sid: again.sid }).map((v) => [v.pid, v]));

    // Launchers before what they launched, so nothing left alive can respawn.
    // depth counts the agent-browser ancestors above a process: a root is 0.
    reap.sort((a, b) => a.depth - b.depth);
    for (const v of reap) {
        const w = now.get(v.pid);
        if (!w) {
            summary.spared.push({ pid: v.pid, reason: 'vanished' });
            continue;
        }
        if (!w.reap || w.created !== v.created) {
            summary.spared.push({ pid: v.pid, reason: 'changed-under-us' });
            continue;
        }
        try {
            kill(v.pid);
            summary.killed.push(v.pid);
        } catch {
            summary.spared.push({ pid: v.pid, reason: 'kill-refused' });
        }
    }

    if (summary.killed.length) {
        for (const pid of selectHotkeyTargets(again.rows, again.sid)) {
            try {
                kill(pid);
                summary.hotkeyReset.push(pid);
            } catch {
                // Not running any more: the reset already holds.
            }
        }
    }
    return summary;
}

function killZombies() {
    try {
        // Enumerate, filter, kill by pid, on both platforms. The two reaping
        // sections above say why no pattern is ever handed to a killer.
        return isWin ? reapWindowsOrphans() : reapPosixOrphans();
    } catch {
        // Both reapers fail open inside themselves; this is the backstop that
        // keeps a defect in either from blocking session start.
        return null;
    }
}

function restoreSnippingToolHotkey(deps = {}) {
    // Windows-only. Kill this user's SnippingTool.exe + ScreenClippingHost.exe
    // so the global Win+Shift+S hotkey starts working again. Windows respawns
    // SnippingTool on the next hotkey press, so this is a free reset, except
    // for a capture still open in its editor, which it discards.
    //
    // Why this is needed:
    //   Even after the bundled Chromium is killed, the running SnippingTool
    //   can be left in a state where Win+Shift+S no longer reaches it.
    //   Process cleanup is necessary but NOT sufficient for hotkey state.
    //   Observed three times in Project C testing sessions: 2026-04-28
    //   needed a reboot; 2026-04-29 morning needed a manual taskkill
    //   mid-session; 2026-04-29 afternoon repeated despite the agent-browser
    //   cleanup running at session start, confirming the zombie kill alone is
    //   insufficient.
    //
    // Why it no longer runs on every Windows session start:
    //   All three incidents had zombies present, and needed the reset after
    //   they were killed. reapWindowsOrphans does exactly that, from its own
    //   verified table. Everywhere else it discarded unsaved captures for
    //   nothing. This entry point is the manual form: --reset-hotkey.
    const { readTable = readWindowsProcessTable, kill = (pid) => process.kill(pid) } = deps;
    const reset = [];
    if (!isWin && !deps.readTable) return reset;
    let table;
    try {
        table = parseWindowsProcessTable(readTable());
    } catch {
        return reset;
    }
    for (const pid of selectHotkeyTargets(table.rows, table.sid)) {
        try {
            kill(pid);
            reset.push(pid);
        } catch {
            // Process may not be running — that's the desired state, no-op.
        }
    }
    return reset;
}

// Pure. `reg query` prints one value per line as four spaces, name, four spaces,
// type, four spaces, data. A name holding four spaces of its own splits early,
// which yields a name that does not exist, so the delete fails and nothing is
// removed: the error falls on the side of leaving a value alone.
function selectRunValues(text, pattern = /agent-browser/i) {
    const names = [];
    for (const line of String(text).split(/\r?\n/)) {
        const m = /^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/.exec(line);
        if (m && /^REG_(EXPAND_)?SZ$/.test(m[2]) && pattern.test(m[3])) names.push(m[1]);
    }
    return names;
}

function removeWindowsAutostartRegistry({ run = execFileSync } = {}) {
    // Removes HKCU\...\Run values whose data points at agent-browser. We don't
    // know the value name in advance (Chromium picks one), so we filter by value
    // content. HKCU is this user's own hive, so the owner filter is the key.
    //
    // reg.exe, not PowerShell: `[measured 2026-09-13]` 22 ms against 205 ms for
    // the Get-ItemProperty scan this replaced, on a check that runs every start.
    const removed = [];
    let text;
    try {
        text = run('reg', ['query', RUN_KEY], { encoding: 'utf8', stdio: READ_STDIO, windowsHide: true });
    } catch {
        return removed;
    }
    for (const name of selectRunValues(text)) {
        try {
            run('reg', ['delete', RUN_KEY, '/v', name, '/f'], { stdio: 'ignore', windowsHide: true });
            removed.push(name);
        } catch {
            // Best-effort.
        }
    }
    return removed;
}

function disableAutostartPreferences({ skip = [] } = {}) {
    // Patch every known Chromium profile dir so Chromium itself stops trying
    // to re-register at startup on next launch.
    //
    // A profile a SPARED live browser is using is skipped. This comment used to
    // call the pass safe because killZombies() had just run and left no live
    // writer to race, which stopped being true when the reaper started sparing
    // live browsers.
    //
    // Profile dirs observed in the wild on Windows + agent-browser 0.26.0:
    //   %LOCALAPPDATA%\Temp\agent-browser-chrome-<uuid>\Default\Preferences
    //   %USERPROFILE%\.agent-browser\<id>\Default\Preferences
    const candidates = [];
    const tempRoot = tempRootFor();
    const dotRoot = path.join(os.homedir(), '.agent-browser');
    const inUse = new Set(skip.map((s) => String(s).toLowerCase()));

    for (const root of [tempRoot, dotRoot]) {
        if (!fs.existsSync(root)) continue;
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const looksLikeAbProfile =
                root === tempRoot ? entry.name.startsWith('agent-browser-chrome-') : true;
            if (!looksLikeAbProfile) continue;
            if (inUse.has(entry.name.toLowerCase())) continue;
            candidates.push(path.join(root, entry.name, 'Default', 'Preferences'));
        }
    }

    for (const prefsPath of candidates) {
        if (!fs.existsSync(prefsPath)) continue;
        try {
            const raw = fs.readFileSync(prefsPath, 'utf8');
            const prefs = JSON.parse(raw);
            let dirty = false;
            prefs.browser = prefs.browser || {};
            if (prefs.browser.auto_launch_chrome_on_startup !== false) {
                prefs.browser.auto_launch_chrome_on_startup = false;
                dirty = true;
            }
            prefs.background_mode = prefs.background_mode || {};
            if (prefs.background_mode.enabled !== false) {
                prefs.background_mode.enabled = false;
                dirty = true;
            }
            if (dirty) fs.writeFileSync(prefsPath, JSON.stringify(prefs));
        } catch {
            // Skip malformed/locked profile files silently.
        }
    }
}

function cleanup() {
    // The Snipping Tool reset is no longer a step here: reapWindowsOrphans
    // performs it when, and only when, it killed something.
    const summary = killZombies();
    if (isWin) {
        removeWindowsAutostartRegistry();
        disableAutostartPreferences({ skip: (summary && summary.liveProfiles) || [] });
    }
}

if (require.main === module) {
    cleanup();
    if (isWin && process.argv.includes('--reset-hotkey')) restoreSnippingToolHotkey();
    process.exit(0);
}

module.exports = {
    cleanup,
    killZombies,
    // POSIX reaping, exported so the decision can be tested apart from the
    // killing. classifyProcesses is the whole filter and is pure.
    AGENT_BROWSER_BINARY,
    parseProcessTable,
    classifyProcesses,
    reapPosixOrphans,
    // Windows reaping, exported for the same reason. classifyWindowsProcesses
    // is the whole filter and is pure; the readers take an injectable runner.
    WIN_BINARY_IMAGE,
    candidatesPossible,
    listBinaryImages,
    readWindowsProcessTable,
    parseWindowsProcessTable,
    readDaemonPids,
    classifyWindowsProcesses,
    selectHotkeyTargets,
    reapWindowsOrphans,
    selectRunValues,
    removeWindowsAutostartRegistry,
    disableAutostartPreferences,
    restoreSnippingToolHotkey,
};
