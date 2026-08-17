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
 * never blocks session start. macOS/Linux only kill zombies (the autostart
 * vector is Windows-specific).
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWin = process.platform === 'win32';

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
            // windowsHide is a no-op on POSIX, where this branch runs. Set anyway
            // so the validate spawn check stays green without needing a waiver:
            // that check is line-scoped and cannot see which branch it is in.
            execSync('pkill -f "agent-browser-(linux|darwin)"', {
                stdio: 'ignore',
                windowsHide: true,
            });
        }
    } catch {
        // Expected when no zombies — taskkill/pkill/wmic exit non-zero on no match.
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
    removeWindowsAutostartRegistry,
    disableAutostartPreferences,
    restoreSnippingToolHotkey,
};
