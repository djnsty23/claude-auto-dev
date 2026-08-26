# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `~/Downloads/code/autodev` |
| branch | `feat/advisory-clean` |
| upstream | _none tracked_ |
| HEAD committed | 2026-08-26T17:54:58+03:00 |

**Re-read before acting on any of this.** A resume file is a snapshot, and
the two facts most likely to have moved are the two below: someone may have
pushed, and someone may have merged.

## Unpushed commits

**COULD NOT READ.** No upstream is tracked for this branch, or git could not be reached, so "ahead of origin" has no answer here.

This is not "none". Nothing was measured, so treat it as unknown.

## Uncommitted changes

- `M RESUME.md`
- `?? .claude/`

## Open PRs

None. A real zero: the command ran and returned nothing.

## Worktrees

Another session may hold one of these. Run `git status` in a tree before
touching it: a dirty tree you did not dirty means someone is in there.

```
~/claude-auto-dev                                 86bbe22 [main]
~/claude-auto-dev/.claude/worktrees/fix-injection 106467f [fix/shell-injection-in-shipped-scripts]
~/claude-auto-dev/.claude/worktrees/rec-quality   cde1997 [rescue/recommendation-quality]
~/claude-auto-dev/.claude/worktrees/rel-8123      377366b [release/8.123.0]
~/Downloads/code/autodev                          4561193 [feat/advisory-clean]
```

## What a reader should do first

1. `git fetch`, then re-check the sections above. They decay fastest.
2. Run `npm run test` before believing anything is green. That name was read from `package.json` here, not assumed.
3. Read `CHANGELOG.md`, `README.md` - present in this directory, checked rather than assumed.
4. Read recent commit bodies. Many projects put the reasoning there rather than in a separate design note.

_These steps were derived from what is actually in `~/Downloads/code/autodev`._

---

## Session addendum, 2026-08-26 — measured, not recalled

`session-exit.js` reads THIS repo only, and reported `unpushed UNKNOWN`. The
real numbers, measured immediately before writing this:

| repo | branch | state |
|---|---|---|
| autodev | `feat/advisory-clean` | 2 behind `origin/main`, 0 ahead. Dirty: `RESUME.md`, untracked `.claude/`. |
| spotivibly | `fix/campaign-copy-audience` (worktree `.claude/worktrees/campaign-copy`) | **1 unpushed commit**, tree clean. |

Most of this session's work was in **spotivibly**, which the script cannot see.

### Landed on spotivibly `origin/main` (at `48512199`)

- `1086762c` campaign path no longer tells first-time visitors they get a
  discount "back". `describeCoupon`/`resolvePromoOffer` take a required
  `PromoAudience`. Required, not defaulted, so absence cannot collapse onto the
  winback phrasing.
- `a78c738a` the manifest test no longer rewrites the file the drift-monitor
  test reads. Generator takes `EDGE_MANIFEST_PATH`; the test uses a temp copy.
  Was failing ~1 run in 4 with a real slug and a real remediation.
- `48512199` e2e teardown: `signedInUser` fixture snapshots the QA user's
  playlist ids, deletes only the newly-appeared ones **by explicit id**, pages
  to avoid PostgREST's silent 1000-row truncation, and aborts entirely if the
  snapshot errors.

### Deployed to production and verified

`active-campaign` v2 and `stripe-webhook` v105, both ACTIVE, updated
2026-08-26T16:10:36Z, read from the Management API rather than the CLI's own
output. Live endpoint: 200 + `{"campaign":null}` unauthenticated, 405 on POST.

### UNPUSHED — decide whether to push

`de273545` fix(e2e): mock track ids were not base62. `TRACK_URI_RE` is
`/^spotify:track:[a-zA-Z0-9]+$/`, ids were `mock-track-1`, so
`validateAndCleanTracks` dropped every row and every mocked generation failed.
Took `playlist-creation` from 2 failed / 2 passed to **1 failed / 3 passed**.
Held local because the push authorisation in that turn named the commits that
existed then.

### Open, with what is already known

1. **`should generate playlist with custom track count` still fails.** Times out
   on `[data-tour="results-area"]`. Differs from the now-passing sibling only in
   setting the track-count slider; `[data-tour="track-count"]` DOES exist
   (`ClassicInputForm.tsx:1394`) so that block runs. `inferArtist` returns null
   for both prompts, so prompt wording is ruled out. Not diagnosed further.
2. **The six specs still cannot join `npm run gate`** until 1 is fixed.
   `check:live-tests` cannot see them at all: its filter is
   `/\.test\.(ts|tsx|mjs)$/` and they are `.spec.ts`. The owning session knows
   and is holding that change until the specs' fate is decided.
3. **The teardown's non-empty delete path is still unexercised.** Safety proven
   twice (46 pre-existing playlists, 46 survived, 0 destroyed), but the specs
   that save also self-delete, so the backstop has never had anything to remove.
4. **Six Stripe promotion codes not created.** Runbook with every field value:
   https://claude.ai/code/artifact/3561a192-6b43-4ffe-b42d-1f0cd23e41b8
   First window is `AUTUMN50`, 2026-10-09. Two decisions are Andy's: whether to
   set `expires_at` (both branches fail silently) and the redemption cap.
5. **Backlog not started:** Preferred Sources eligibility; growceanu Ads trigger
   (conversion `18099206078` catches 7 of 22 CTAs); a FOMO variant; fitmito's
   two unowned defects; six client rosters awaiting commit-or-delete.

### Closed this session, do not re-raise

- autodev PRs #34 and #36: both closed, content confirmed on main. #34's swap
  landed inside `tool-failure-advisory.js`, which is invoked from
  `telemetry.js:91` and covered by `tooling/test-telemetry-hook.js:164`.
- The k8s port: `workflow-liveness.js`, on main since v8.119.0, wired as
  `check:liveness`, 40 tests passing. It was re-offered by the queue checker
  because that checker cannot see delivery.
