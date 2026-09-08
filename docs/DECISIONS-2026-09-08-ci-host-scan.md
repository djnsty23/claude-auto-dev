# DECISIONS — 2026-09-08 — the hooks-module scan runs somewhere

Scoped filename per the precedent in this directory. Calls made inside the operator's
away window (AWAY.md: "at the beach", until 16:33Z, scope qr and autodev). Session
worktree `zealous-joliot-36d86b`, base `origin/main` 99bb597.

## D0. The reported failure was already fixed, and the brief measured the wrong commit

The brief: `validate.js` FAILs at "pristine HEAD" with *the modules entry was not read*.
Bisected in two detached worktrees before touching anything:

| commit | `validate.js` here (claude 2.1.233) |
|---|---|
| b8eae1f (the brief's HEAD) | exit 1, the FAIL line quoted in the brief |
| 317d83e (#184, the next commit, merged 10:01) | exit 0, WARN "NOT scanned" |
| 99bb597 (current `origin/main`) | exit 0, same WARN |

The main checkout was already at 99bb597; only the brief's detached worktree was stale.
CI's green was never about the same measurement: `ci.yml` installs no `claude`, so the
scan is `skipped` there. Three environments, three answers, and none of them had scanned
the module.

## D1. Branch 2: take the recommended option, which was "install claude in CI"

The panel offered it as the recommendation and the away hook held the panel. Reversible:
one step in `ci.yml`, deletable in one commit, no VERSION bump, no release. Not covered
by a standing rule either way. Taken, after measuring rather than before.

## D2. Measured before editing: four CLIs, two plugins, flag on and off

Each version installed from npm into the session scratchpad (3 s each), never into
`/usr/local`, and run against this tree:

| host | autodev-core | our check's verdict |
|---|---|---|
| 2.1.233 (installed here) | manifest line + verdict, nothing else | WARN, skipped (#184) |
| 2.1.246 | `Validating hooks:` then `"session.start" is not an event` | was FAIL |
| 2.1.258 | identical words to 2.1.246 | was FAIL |
| 2.1.259 | `hooks: session.start, prompt.submit, tool.call{tool=Bash}, …` + `calls:` | PASS |
| 2.1.263 (npm latest) | identical to 2.1.259 | PASS, 20 PASS 0 FAIL 0 WARN |

The flag made no difference to any row. autodev-memory (shell hooks, no `modules`)
printed no `hooks:` on any version, which is the fact D9 of the earlier record said was
unmeasured: a host does NOT print `hooks:` for shell hooks, so the "other plugin" control
that record declined would indeed have made the FAIL branch permanently dead. Declining it
was right.

2.1.263 with an EMPTY `HOME` and `CLAUDE_CONFIG_DIR` (the CI runner's shape) scans and
passes identically, exit 0, and writes only a `.claude.json` into the config dir. So CI
needs no credentials for this.

## D3. The window has a real false FAIL, in the other branch from the one D9 named

D9 speculated a host that scans components and prints no `hooks:`. Measured: the window
hosts print `Validating hooks:` and REJECT the module, because the module is written
against 2.1.259's event vocabulary and theirs is older. `scanHooksModule` read that
`Validation failed` as a broken module. A developer on 2.1.246–2.1.258 would have had
every push blocked by a red about a file that is correct for the shipping host.

Fixed as a fifth outcome, `rejected-by-older-host`: a rejection from a host whose parsed
version sits below `HOOKS_MODULE_HOST_FLOOR = '2.1.259'` is a WARN naming the host, the
floor, and the host's own words. This is deliberately NOT the version threshold D1 of the
earlier record rejected. That one used version to PREDICT whether a host prints a scan and
so to decide whether to spawn. This one never decides anything from the version alone:
the rejection is read from output, and the version only says whose rejection it is. The
controls in the suite pin the boundary: the identical rejection from 2.1.259 FAILs, from
9.9.9 FAILs, and from an unparseable version FAILs, because a rejection is a positive
finding and not knowing who spoke is no reason to disbelieve what was said.

Verified against the REAL hosts, not only the stub: `validate.js` with 2.1.258 first on
PATH now prints the WARN and exits 0; with 2.1.263, PASS; with the local 2.1.233, the
#184 WARN unchanged.

## D4. Pinned 2.1.263 in CI, all three legs

Pinned because the vocabulary has already moved once between adjacent versions, and a
floating `latest` would turn the next move into a red on main with no commit to bisect.
All three legs rather than ubuntu-only: the install is 3 s, and the mac and windows legs
are the ones that exercise the shell spawn and the `.cmd` shim that D8 and D10 of the
earlier record were about — a scan that ran only on Linux would say nothing about either.
The suite is unaffected: its stub goes first on PATH, and its no-CLI case strips every
directory holding a `claude`, so a global install is exactly the situation it was written
for.

Risk accepted: this is the first time any CI has scanned the module. If windows-latest
finds a shim problem the check's comments did not anticipate, the PR goes red, not main,
and that is what the PR is for.

## D5. What was NOT done

No global install or upgrade of `claude` on this machine — a system change, and the
operator's to make; the scratch installs are under the session scratchpad and vanish
with it. No change to #184's output-shape control. No merge: the Brain holds merge
authority this window. Nothing pushed to anyone else's branch.
