# Worktree disk: shared installs and reaping merged worktrees

Every task gets its own worktree, and before this each one carried a full
`node_modules` and stayed on disk after its branch merged. On one machine
`[measured 2026-10-05]` about 250 linked worktrees existed, about 70 of them with
an install of 0.3 to 1.5 GB, and deleting only the installs of 46 idle ones freed
about 27 GB. Two scripts in `autodev-core` close both ends:

| Script | When | What it does |
|---|---|---|
| `scripts/shared-install.js link <worktree>` | right after `git worktree add` | gives the worktree the main checkout's `node_modules` as hardlinks when the lockfiles match |
| `scripts/worktree-reap.js --repo <main> --apply` | once a day | removes linked worktrees whose work landed, once clean and idle |

## Shared install

### Measured options

A Next.js 16 app with Vitest, Vite and Playwright, `node_modules` of 30,848 files
and 530 MB, on Windows 11 NTFS `[measured 2026-10-05]`:

| Option | Setup time | Disk unique to the worktree | Next.js 16 build | Notes |
|---|---|---|---|---|
| Junction to main's `node_modules` | about 0 s | 0 | **fails** | Turbopack refuses a `node_modules` link that points outside the project root. Vite writes `.vite` caches into main through it. |
| Hardlink tree (`shared-install.js link`) | 10.7, 22.1, 22.6 s | 0.6 MB (4 MB by free-space delta) | passes | Vitest, Vite and Playwright also pass from the linked worktree |
| `npm ci --prefer-offline`, warm cache | 22.3, 24.0 s (92.9 s under load) | 614 MB | passes | |
| `npm ci`, cold cache | 39.7 s | 614 MB (777 MB by free-space delta) | passes | a daily cache clean makes the first install of each day cold |

"Disk unique to the worktree" counts the allocation of files with one link, so
other sessions writing to the same drive cannot move it. Two free-space deltas
in the same series read 14,381 MB and -12,329 MB because other sessions wrote
and freed space mid-run, which is why that column is not the headline.

The hardlink tree won: it is the only option that is both fast and correct for
Next.js 16, and it costs the worktree almost nothing.

### What `link` does

- Each tracked `package-lock.json` is an install root. Nested `node_modules`
  named by its keys (npm workspaces) are linked with their root.
- It links only when the worktree's lockfile is byte-equal to the main
  checkout's, the main checkout's hidden lockfile (`node_modules/.package-lock.json`)
  agrees with its lockfile, git ignores `node_modules`, and the worktree has no
  `node_modules` yet. Otherwise it creates nothing, exits 1 and prints the
  `npm ci` that directory needs.
- Directories are created fresh in the worktree and every file is a hardlink to
  main's, the layout pnpm uses for its store. Files npm rewrites in place (the
  top-level `node_modules` files and the `.bin` shims) are copied. Cache
  directories (`.cache`, `.vite`, `.vite-temp`, `.vitest`) are left out, so each
  tree writes its own.
- Symlinks and junctions are recreated, pointing into the worktree when they
  pointed into main.
- NTFS caps a file at 1023 links. A file at the cap is copied instead. A link
  across volumes rolls the whole root back and asks for an install.
- A marker, `node_modules/.autodev-shared.json`, records the state (`linking`
  while it runs, `shared` after), the lockfile hash and the counts. An
  interrupted link is redone on the next run. A lockfile changed after linking
  makes the next `link` remove the links and ask for an install.

### The guard

A hardlink rewritten in place changes the main checkout's copy too, and an
install can do exactly that (an install script, `patch-package`, `prisma
generate`). So a tree must be unshared before anything installs into it.

`hooks/shared-install-guard.js` is a PreToolUse hook on Bash. When the command
puts an install verb in command position (npm, pnpm, yarn or bun install and its
relatives, `patch-package`, `prisma generate|migrate|db`, also behind `npx` or
`bunx`) and a marker sits in the target directory or above it, it denies the
command and names the fix:

```bash
node "<plugin>/scripts/shared-install.js" unshare "<worktree>"
```

After that the same install runs as a private one. The hook is inert without a
marker, fails open and prints nothing when it has nothing to say.

It cannot see an install inside `npm run <script>`, or in a directory it cannot
resolve from the command text. Those are the residual risks.

### Where it is wired

- `unattended-worker.js` STEP 0 runs `link` after `git worktree add`.
- `headless-worker.js` PLACEMENT note names it for any worktree a worker adds.
- The `isolate`, `heal`, `unslop`, `marketing-radar` and `framework-radar`
  skills, and the `heal-sweep` workflow brief, run it after their `git worktree add`.

A Desktop chip's worktree is created by the app, out of the harness's reach. A
chip brief, or any brief written by hand, carries this one line after its
`git worktree add` (a session's shell has no `CLAUDE_PLUGIN_ROOT`, so it finds
the newest installed copy):

```bash
node "$(printf '%s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/autodev-core/*/scripts/shared-install.js | sort -V | tail -1)" link .
```

## Reaping merged worktrees

`worktree-reap.js` lists every linked worktree of each `--repo` with the evidence
that its work landed or the reasons it is kept. A dry run is the default, and
`--apply` removes. It removes a worktree only when all of these hold:

1. It is linked, unlocked and on a branch.
2. Its work landed in origin's default branch: a pull request for its branch is
   merged or closed at exactly this HEAD, or HEAD came in by a merge commit, by a
   fast-forward (the branch reflog shows commits after its creation), or by a
   rebase (`git cherry` finds an equivalent for every commit). An open pull
   request keeps it, and so do pull requests that cannot be read.
3. Nothing is unpushed, unless the change is already in the base.
4. No transcript of any profile and no git admin file was written for it within
   `--idle-hours` (24 by default).
5. No gate lock, ticket or lease names it, and no process has its path on the
   command line.
6. It is clean, and every ignored file is regenerable or byte-identical to the
   main checkout's (a copied `.env.local`).

Each candidate is judged again inside its lease mutex just before
`git worktree remove`, which runs without `--force`. The branch stays. Git
leaves a junction behind without following it, and the reaper unlinks that
remainder, also without following it.

Anything it cannot answer keeps the worktree: a failed fetch, an unreadable
status, a gate record that does not say which worktree it is for. A repo whose
origin is not on GitHub has no readable pull requests, so its worktrees are kept.

### Why the trigger is the daily task

| Trigger | Sees a merge that happened later | Cost | Verdict |
|---|---|---|---|
| The settle step of a session | no: a PR usually merges after its session settles | a turn of tokens per session | not enough alone |
| `session-sweep.js` | only for sessions the app still lists | run by hand | not enough alone |
| A daily scheduled task | yes, whenever it merged | no session, no tokens | **chosen** |

The machine's daily disk task runs the reaper with `--apply` over the same repo
list it already cleans, before it touches idle installs. The isolate skill shows
the dry run for anyone who wants it on demand.

### First dry run on a real machine

Over 35 repositories on one machine, 274 linked worktrees `[measured 2026-10-05]`,
in 5 min 18 s with fetch:

| Outcome | Worktrees |
|---|---|
| Landed, by one of the four kinds of evidence | 93 |
| Not landed: commits not in the base | 61 |
| Not landed: detached HEAD | 54 |
| Not landed: at the commit the branch was created on, or on the base with no reflog | 47 |
| Not landed: an open pull request | 12 |
| Not landed: no readable default branch or pull requests | 6 |
| The worktree running the command | 1 |

None was eligible on that run. 70 landed ones were kept because a peer's gate
held a lane lock with no meta line, so the lock could not say which worktree it
was for. That lock came from an older installed plugin version: current writers
always record the meta line. Such a lock blocks reaping only while its gate
runs, and the reaper fails closed on it rather than guess.

The same machine with no gate running (an empty lock directory, no fetch) had 16
eligible: 12 by a merged or closed pull request at HEAD and 4 rebased in. The 78
other landed ones were kept, counted by the first reason given: uncommitted or
untracked changes (22), ignored files that exist only there (30), activity
within the idle window (24) and a process using the path (2).
