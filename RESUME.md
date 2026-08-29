# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `~/Code/autodev` |
| branch | `main` |
| upstream | `origin/main` |
| HEAD committed | 2026-08-29T08:02:54+03:00 |

**Re-read before acting on any of this.** A resume file is a snapshot, and
the two facts most likely to have moved are the two below: someone may have
pushed, and someone may have merged.

## Unpushed commits

None. A real zero: the command ran and returned nothing.

## Uncommitted changes

None. A real zero: the command ran and returned nothing.

## Open PRs

None. A real zero: the command ran and returned nothing.

## Worktrees

Another session may hold one of these. Run `git status` in a tree before
touching it: a dirty tree you did not dirty means someone is in there.

```
~/Code/autodev                                                1500983 [main]
~/Code/autodev/.claude/worktrees/autodev-update-3b29cd        7be5d55 (detached HEAD)
~/Code/autodev/.claude/worktrees/brain-tree-inert             5646d5d [release/8.140.0]
~/Code/autodev/.claude/worktrees/layout-spec-a-design-d06780  9bf2f20 (detached HEAD)
```

## What a reader should do first

1. `git fetch`, then re-check the sections above. They decay fastest.
2. Run `npm run test` before believing anything is green. That name was read from `package.json` here, not assumed.
3. Read `CHANGELOG.md`, `README.md` - present in this directory, checked rather than assumed.
4. Read recent commit bodies. Many projects put the reasoning there rather than in a separate design note.

_These steps were derived from what is actually in `~/Code/autodev`._

---

## Stand-down handoff — session `layout-spec-a-design`, 2026-08-29

Written on a stand-down (device/account switch), from commands run at the time.
Every claim below names the command that produced it. Nothing here is recalled.

### Where the work is

| PR | branch | state | subject |
|---|---|---|---|
| [#85](https://github.com/djnsty23/claude-auto-dev/pull/85) | `fix/prd-container-shape` | **MERGED** (in v8.141.0) | `storiesOf()` across six prd.json readers |
| [#87](https://github.com/djnsty23/claude-auto-dev/pull/87) | `fix/watch-panels-stderr-leak` | **MERGED** (`e456bce`) | watch-panels inherited fleet-status's stderr |
| [#90](https://github.com/djnsty23/claude-auto-dev/pull/90) | `fix/mutation-coverage-gaps` | **OPEN, green** | three suites unverified for three different reasons |
| [#91](https://github.com/djnsty23/claude-auto-dev/pull/91) | `feat/queue-freshness` | **OPEN, green** | read a queue's premises against the trunk, in bulk |

`#90` and `#91` are independent — `#91` is based directly on `origin/main`, not
stacked on `#90`. Neither touches `VERSION`.

### What is verified, and by which command

- `npm test` → **72/72, exit 0**, on `feat/queue-freshness` after rebasing onto
  current main. Read the exit status directly; **do not pipe this into
  `head`/`tail`**, because a pipeline's status is the last command's and that
  turned a failing run green earlier in this session.
- `npm run check:suites` → **exit 0**, `71 suite(s) · 70 verified able to fail ·
  0 NOT verified · 1 canaried elsewhere`. It was 67/71 with 4 unverified before
  `#90`. It **refuses on a dirty tree**, so it cannot run while any worktree
  sharing this checkout has uncommitted edits.
- Tree cleanliness after the mutation run was confirmed with
  `git status --porcelain` **independently**, not read off the script's own
  "tree restored clean" line.
- `#91`'s suite: 47 assertions, **nine mutants, all killed**.

### The finding most worth carrying forward

`check:suites` went from **2 unverified to 4 in a single day**, and the newly
unverified one was the gate whose entire purpose was to strengthen coverage.

More important than the number: all four printed the **same** remediation —
"Add it to `SUBJECT_OVERRIDES`" — and it was right for two, incomplete for one,
and would have **manufactured fake coverage** on the fourth by pointing a
JavaScript stubber at a `SKILL.md`. A remediation message that produces a canary
firing on the wrong stimulus is worse than none, because it still reads as
coverage. `#90` gives that case its own category, and entry requires naming a
canary that exists and is itself checked — otherwise the exemption is refused.

### What I would do next

1. **Merge `#90`, then `#91`** if Andy agrees with them. Verify each by running
   `npm test` in a worktree: `gh pr checks` reports **nothing** on autodev heads,
   which is *unmeasured*, not green.
2. **`#91` follow-up, agreed but not built:** have it delegate each item to
   `check-assignment.js` as a subprocess instead of evaluating the grep inline.
   The split is decided — the new script owns the queue format and the
   `UNCHECKABLE` verdict; the single-item tool keeps the exit-code semantics.
3. **`brain-panels.js --extend`, designed but NOT built.** Widening a window
   today means `--on` then `--off`, which restores panels fleet-wide before
   denying them again — a hole in the middle of the window that exists to stop
   sessions blocking. `--off` is right to refuse a second run, so the fix is a
   verb that moves `expiresAt` and opens no settings file at all. Design notes,
   including the three refusals it needs (refuse to shorten, refuse on zero live
   denies, leave expired denies alone), are in this session's scratchpad and are
   summarised in the message log; they are not in the repo.
4. **Root cause still open:** `brain-panels.js` writes a private repo path into a
   public tree. `.gitignore` now stops it being staged, which stops publication
   but not the write. The tool should not compose that record at all.

### Two mistakes I made, so nobody repeats them

- I ran `git checkout main; git reset --hard origin/main` with `;` rather than
  `&&`. The checkout failed (main is checked out in another worktree) and the
  reset still fired, landing on my own PR branch. It cost nothing only because
  both PRs were already merged. **`;` is not `&&`** — it is in `CLAUDE.md` and I
  walked into it anyway.
- I reported a mutant as SURVIVED when it had never been applied: the `node -e`
  carrying it was eaten by nested shell quoting. Re-applied from a scratch file
  it killed nine assertions. A mutation harness whose failure mode is a false
  SURVIVED invents coverage gaps.
