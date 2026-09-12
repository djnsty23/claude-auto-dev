# agent-browser-cleanup on Windows: where 1.5 s went, and what it killed

`[measured 2026-09-13]` Windows 11 Pro 10.0.26200, Node v24.15.0, 32 logical
cores. Every timing is N=10 after one cold run, median with min and max, wall
clock around a spawn, with HOME, USERPROFILE and LOCALAPPDATA pointed at a fresh
temp directory unless stated.

## The reference number

The brief measured the shipped hook at **1,516 ms** per SessionStart (min 1,477,
max 1,541), against 77 to 295 ms for every other SessionStart hook in both
plugins, and 82 ms for this hook on macOS (docs/evidence-ecc-comparison-2026-09-07.md).

The numbers below come from a **replica**, not from the shipped hook. The shipped
hook kills processes on every run, and on this machine one of them was a live
application's crash reporter (see "What it killed"), so running it eleven more
times was not an acceptable way to measure it. The replica is the hook file with
every kill and delete target renamed to an image or pattern that cannot exist.
Every spawn, shell and argument shape is unchanged, and each substitution was
asserted to hit exactly once. It ran at 1,346 to 1,392 ms across three sessions of
N=10. The 124 to 170 ms gap to the brief's figure is not attributed: the runs were
on a different day under different load, and the replica never performs a kill.

## Where the time went

Standalone, each of the hook's own commands with a non-existent target:

| component | median | min | max | calls per start |
|---|---|---|---|---|
| node startup (baseline) | 49 | 47 | 50 | 1 |
| `wmic ...` through cmd.exe | 27 | 25 | 28 | 1 |
| PowerShell fallback (`Get-CimInstance` + `Where-Object`) | 339 | 326 | 371 | 1 |
| `taskkill /F /IM ...` | 127 | 123 | 134 | 4 |
| PowerShell Run-key scan | 205 | 202 | 212 | 1 |

`wmic` is not installed on this build (`where wmic` finds nothing). It fails in
27 ms and the PowerShell fallback runs on every session start, so the fallback
was never a fallback here.

Inside the hook, phase by phase (replica instrumented around each call in
`cleanup()`):

| phase | median | min | max |
|---|---|---|---|
| `killZombies` (wmic, fallback, two taskkills) | 764 | 725 | 803 |
| `removeWindowsAutostartRegistry` (PowerShell) | 346 | 336 | 360 |
| `restoreSnippingToolHotkey` (two taskkills) | 227 | 211 | 259 |
| `disableAutostartPreferences` | 0 | 0 | 1 |
| whole hook | 1,392 | 1,341 | 1,444 |

The three spawning phases are 1,337 of 1,392 ms, 96% of the hook, and on this
machine all of them found nothing to act on. With the real
LOCALAPPDATA instead of a sandbox the whole hook read 1,428 ms (1,403 to 1,586),
so the Preferences directory scan is not the cost.

## What it killed

- **`taskkill /F /IM "crashpad_handler.exe"`** matched exactly one process on this
  machine, and its parent was a music player's launcher. The Chrome for Testing
  that agent-browser installs under `~/.agent-browser/browsers/chrome-148.0.7778.56`
  contains no `crashpad_handler*` file at all: Chrome runs its crash reporter as
  `chrome.exe --type=crashpad-handler`. So this line could not reach
  agent-browser's own browser, and reached other applications on every start.
- **The command-line LIKE** (`%agent-browser%eval%`) selects any process whose
  command line mentions both words: a shell loop, a grep, an editor. It is not
  scoped to agent-browser processes.
- **`taskkill /F /IM SnippingTool.exe`** discards a capture open in the editor.

## What agent-browser 0.26.0 actually does on Windows

Read from the installed package, without launching it. Launching it risks the
Chrome and Snipping Tool lockup the hook's header documents.

- The npm `.cmd` shim runs `agent-browser-win32-x64.exe` directly, so every CLI
  call is that image, not `node.exe`.
- The README: "The browser persists via a background daemon". The daemon is
  detached by design, so a LIVE daemon between two CLI calls has a dead parent,
  exactly like a zombie.
- It records sessions in sidecars: `~/.agent-browser/default.pid`, `.port`,
  `.engine`, `.stream`, `.version`, and the same for named sessions. `doctor`
  "auto-cleans stale daemon files". Two stale `.pid` files are present here,
  naming pids that are not running.
- The binary contains `user-data-dir=` and `agent-browser-chrome-`, the Temp
  profile naming the hook's Preferences pass already relies on.

Inferred, not observed: that `<session>.pid` holds the daemon's pid, and that
Chrome's child processes carry `--user-data-dir`. No agent-browser process tree
was run on this machine.

## The new Windows branch

Gate first. `tasklist /FI "IMAGENAME eq agent-browser-*"` plus a check for
`agent-browser-chrome-*` directories in Temp. PowerShell starts only if either is
present. Then one PowerShell read of the whole process table (pid, parent,
creation time; image, executable, command line and owner SID for candidates),
the sidecar registry, a pure classifier, a second read, and a kill by pid of
anything whose verdict and creation time are unchanged. Snipping Tool is reset by
pid, for this user, only after at least one kill. The Run key moved from
PowerShell to `reg.exe`.

Known positives for each reader, before any number was trusted:

| reader | known positive | result |
|---|---|---|
| `tasklist` wildcard filter | `IMAGENAME eq crashpad*` | found `crashpad_handler.exe` |
| `tasklist` for agent-browser | none running | `INFO: No tasks`, exit 0 |
| PowerShell table, widened to `*crashpad*` | crashpad arguments in running apps | 446 rows, 11 candidates, owner SID on all, every verdict `not-agent-browser` |
| `reg query` parse | value `OneDrive` exists | 9 values parsed, `/OneDrive/` selects it, `/agent-browser/` selects none |
| table read stderr | first PowerShell run on the machine | 1,033 ms and a CLIXML progress record on stderr, before `stdio` discarded it; then 0 bytes over 4 runs |

Warm, the table read is 361 to 384 ms over 450 to 461 rows.

## After

The same harness, the old replica and the new hook **interleaved** (A B A B) so
load drift lands on both:

| gate | old replica | new hook |
|---|---|---|
| closed (no binary, no profile dir): every normal start | 1,346 (1,293 to 1,372) | **210 (202 to 237)** |
| forced open by an empty profile dir, nothing to reap | 1,309 (1,254 to 1,511) | 637 (603 to 667) |

When something is reaped, a second table read is added (about 370 ms), on a start
that is cleaning up after a real zombie.

## The suite, and whether it can fail

`tooling/test-agent-browser-cleanup.js` drives the Windows decision over fixtures
on every platform (readers take an injectable runner, the classifier is pure) and
over real processes on Windows: four node decoys, two of them orphaned through a
launcher that exits, one of those registered in a sidecar directory, and a real
PowerShell read and TerminateProcess. The binary rule is injected as a per-run tag
so no real process can be selected, and the killer applies the OS kill to decoy
pids only.

Each defect below was injected into the hook and the suite run:

| mutant | red |
|---|---|
| M1 sidecar registry ignored | 11 |
| M2 creation times compared as Numbers | 2 |
| M3 owner SID ignored | 5 |
| M4 binary matched by command-line mention | 5 |
| M5 Snipping Tool reset without a kill | 0, then 1 after the case below was added |
| M6 live parent ignored | 11 |
| M7 second read skipped | 1 |
| M8 reader stderr forwarded | 2 |
| M9 gate ignored | 1 |
| M10 live daemon ignored for a stray browser | 1 |

M5 survived first. The only case for it had no candidates, and an empty candidate
list returns before the reset is reached. The added case has every candidate
qualify and every kill refused.
