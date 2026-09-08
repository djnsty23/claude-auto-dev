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
 * never blocks session start. macOS/Linux only reap zombies (the autostart
 * vector is Windows-specific), and reap them BY PID after proving each one
 * is abandoned — never by command-line pattern, which cannot tell a dead
 * browser of yours from a live browser of somebody else's. See the POSIX
 * reaping section below; that distinction is the whole of it.
 */

const { execSync, execFileSync } = require('node:child_process');
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
function parseProcessTable(text) {
    const rows = [];
    for (const line of String(text).split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
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

function killZombies() {
    try {
        if (isWin) {
            // Sweep stuck `agent-browser` CLI invocations FIRST, before tree-
            // killing the binary. Each `agent-browser eval --stdin` (or any
            // CLI subcommand) spawns a Node process that spawns the binary;
            // if the Node process is hung (e.g. inside a polling loop), it
            // keeps re-spawning the binary as old ones get killed. The 2026-
            // 04-29 afternoon recurrence was caused by a background `until`
            // loop calling `agent-browser eval --stdin` for hours after a
            // browser test "finished" — each iteration leaked an orphan, and
            // the accumulation broke Win+Shift+S. Killing the Node CLI
            // processes first stops the leak at the source.
            try {
                execSync(
                    'wmic process where "CommandLine like \'%agent-browser%eval%\'" delete',
                    { stdio: 'ignore', windowsHide: true },
                );
            } catch {
                // wmic is deprecated on Win11 23H2+ — fall back to PS.
                const ps =
                    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'agent-browser.*eval' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
                const encoded = Buffer.from(ps, 'utf16le').toString('base64');
                try {
                    execSync(
                        `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
                        { stdio: 'ignore', windowsHide: true },
                    );
                } catch {
                    // best-effort
                }
            }
            // /T is critical: agent-browser spawns renderer / GPU / network /
            // crashpad child processes. Killing only the parent leaves the
            // children alive — they hold the global Win+Shift+S hotkey and
            // can re-spawn the parent. 2026-04-29 incident: a `taskkill /F
            // /IM` (no /T) silently left 11 child processes running, which
            // re-broke Snipping Tool minutes after a manual restore. The
            // /T flag walks the tree and kills all descendants too.
            execSync('taskkill /F /T /IM "agent-browser-win32-x64.exe"', {
                stdio: 'ignore',
                windowsHide: true,
            });
            // Also sweep crashpad_handler children orphaned by Chromium —
            // they don't always show up under the parent's tree.
            execSync('taskkill /F /IM "crashpad_handler.exe"', {
                stdio: 'ignore',
                windowsHide: true,
            });
        } else {
            // Enumerate, filter, kill by pid. The POSIX reaping section above
            // says why no pattern is ever handed to a killer here.
            reapPosixOrphans();
        }
    } catch {
        // Windows only, now. taskkill/wmic exit non-zero on no match, which is
        // the ordinary case. The POSIX branch no longer reaches here: it fails
        // open inside itself, per-pid, so one unreadable process cannot abort
        // the sweep and nothing it does can block session start.
    }
}

function restoreSnippingToolHotkey() {
    // Windows-only. Kill SnippingTool.exe + ScreenClippingHost.exe so the
    // global Win+Shift+S hotkey starts working again. Windows automatically
    // respawns SnippingTool on the next hotkey press, so this is a free reset.
    //
    // Why this is needed:
    //   Even after killZombies() removes the bundled Chromium binary, the
    //   running SnippingTool can be left in a state where Win+Shift+S no
    //   longer reaches it. Process cleanup is necessary but NOT sufficient
    //   for hotkey state. Observed three times in Project C testing
    //   sessions: 2026-04-28 needed a reboot; 2026-04-29 morning needed a
    //   manual taskkill mid-session; 2026-04-29 afternoon repeated despite
    //   the agent-browser cleanup running at session start, confirming the
    //   zombie kill alone is insufficient.
    //
    // Why "always run on Windows" is safe:
    //   SessionStart only fires when the user opens a Claude session — they
    //   are typing in Claude, not in the middle of taking a screenshot. The
    //   tradeoff (vanishingly rare false-kill mid-screenshot) is much smaller
    //   than the cost of a broken hotkey persisting across sessions.
    if (!isWin) return;
    for (const procName of ['SnippingTool.exe', 'ScreenClippingHost.exe']) {
        try {
            execSync(`taskkill /F /IM "${procName}"`, {
                stdio: 'ignore',
                windowsHide: true,
            });
        } catch {
            // Process may not be running — that's the desired state, no-op.
        }
    }
}

function removeWindowsAutostartRegistry() {
    // Removes HKCU\...\Run values whose Command points at agent-browser.
    // We don't know the value name in advance (Chromium picks one), so we
    // filter by value content. EncodedCommand sidesteps cmd.exe quoting.
    const ps = [
        "$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
        '$props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue',
        'if ($props) {',
        '  $props.PSObject.Properties |',
        "    Where-Object { $_.Value -is [string] -and $_.Value -match 'agent-browser' } |",
        '    ForEach-Object { Remove-ItemProperty -Path $key -Name $_.Name -ErrorAction SilentlyContinue }',
        '}',
    ].join('\n');
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    try {
        execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
            stdio: 'ignore',
            windowsHide: true,
        });
    } catch {
        // Best-effort.
    }
}

function disableAutostartPreferences() {
    // Patch every known Chromium profile dir so Chromium itself stops trying
    // to re-register at startup on next launch. Safe because killZombies()
    // just ran — no live writer to race.
    //
    // Profile dirs observed in the wild on Windows + agent-browser 0.26.0:
    //   %LOCALAPPDATA%\Temp\agent-browser-chrome-<uuid>\Default\Preferences
    //   %USERPROFILE%\.agent-browser\<id>\Default\Preferences
    const candidates = [];
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const tempRoot = path.join(localAppData, 'Temp');
    const dotRoot = path.join(os.homedir(), '.agent-browser');

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
    killZombies();
    if (isWin) {
        removeWindowsAutostartRegistry();
        disableAutostartPreferences();
        restoreSnippingToolHotkey();
    }
}

if (require.main === module) {
    cleanup();
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
    removeWindowsAutostartRegistry,
    disableAutostartPreferences,
    restoreSnippingToolHotkey,
};
