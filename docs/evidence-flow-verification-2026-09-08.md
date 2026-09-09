# Runtime flow verification: what it can reach, what it costs, and whether it sees the class

Measured 2026-09-08. This is the before/after that `docs/failure-evidence.md`
does not have: that document says the common first-pass failure is code that
runs and is wrong, and that a screenshot cannot see it. This one asks whether
driving the primary user flow in a real browser and asserting on state, per
story, would have caught those failures, what the check costs, and how to tell
in 30 days whether it moved the number.

> The repos stay anonymised as in the earlier document. **Project A** is the
> consumer health/fitness PWA, **Project C** the consumer media app. **Project D**
> is a fourth repo, a consumer QR tool with no users yet, used here for the cost
> measurement because it can carry a throwaway branch. Project B, the B2B
> platform, was not re-measured: it is a client repo and this session did not
> touch it.

## 1. The baseline, re-measured on today's history

`plugins/autodev-core/scripts/mine-fixes.js` counts conventional `fix:` commits
against `feat:`/`refactor:` commits and flags a fix as rework when it lands on a
file a feature touched inside the rework window. Per the earlier document, the
ratio, the window and the hot-file list are the trustworthy outputs; the class
ranking is a floor that needs reading.

**The tool had no date window.** Asked for the last 60 days, it offered only
`--window-days`, which is the rework window, a different question. The 60-day
figures below were first produced by a scratch reimplementation of the same
counting with a `git log --since` filter, then the flag was added to the tool
itself (`--since=<git date>`, covered by `tooling/test-mine-fixes.js`) and the
figures re-derived from it. Every fix, rework and ratio figure agreed; the
commit and feature totals moved by a few (Project A 4,481 to 4,465 commits,
Project C 1,010 to 1,008) because `60.days` is measured from the clock and
hours passed between the two runs. The table carries the tool's figures.

```bash
node plugins/autodev-core/scripts/mine-fixes.js <repo> --json --since=60.days --window-days=3
node plugins/autodev-core/scripts/mine-fixes.js <repo> --json --since=60.days --window-days=1
```

| Repo | Window | Engineering commits | feat+refactor | fix | Fixes per feature | Rework, 3-day | Rework, 24-hour |
|---|---|---|---|---|---|---|---|
| Project A | last 60 days | 4,465 | 670 | 903 | **1.35** | 93% | 89% |
| Project A | all history | 5,890 | 980 | 1,042 | 1.06 | 94% | 89% |
| Project C | last 60 days | 1,008 | 170 | 490 | **2.88** | 38% | 27% |
| Project C | all history | 3,637 | 761 | 1,607 | 2.11 | 54% | 38% |
| Project D | last 60 days (all of it) | 204 | 54 | 31 | **0.57** | 71% | 61% |

Two things to read off that. Both older repos are worse over the last 60 days
than over their whole history (A 0.94 on 2026-08-16, 1.06 all-time today, 1.35
recent; C 2.00, 2.11, 2.88). And Project A's 24-hour rework share is 89%, still
the shape the earlier document called "the first pass being wrong and being
corrected immediately".

**The pairing is noisier than the ratio.** `mine-fixes` attributes a fix to the
first feature in the window sharing a file. In Project C that file is often a
generated manifest or an e2e spec touched by everything, so the "introducing
feature" it names is frequently unrelated to the fix. The rework *count* still
stands (the fix did land on a file a feature had just touched); the *pairing* is
not evidence of causation and was not used below.

## 2. Thirty fix commits, read, and the ceiling they set

Population: the 30 most recent rework fixes in Project C's last 60 days (fix on
a file a feature touched within 3 days), newest first, no selection beyond that.
Subjects and bodies read in full. The question for each: **would driving the
primary user flow in a real browser after the feature commit, with an assertion
about state, have caught it?**

| # | fix | subject, shortened | catch? | why |
|---|---|---|---|---|
| 1 | 57a9c1e4 | recovery mail promised a free regeneration | no | copy inside an email; no browser flow renders it |
| 2 | 88e993aa | phantom API call counted on exhausted retries | no | server-side telemetry count |
| 3 | d57dd057 | four open defects, incl. a progress bar frozen at 25% for anonymous visitors and six raw anchors forcing full reloads | **yes** | drive the generator anonymous, assert the progress value moves; assert an internal link does not reload the document |
| 4 | d37ab9d7 | artist lookup fan-out; a 429 read as "no such artist" | only with data | needs the upstream API to be rate-limiting during the run |
| 5 | c1252e4d | body gradient cleared the page background below the fold | no | the viewport render is correct; only a full-page capture shows it, and that is a picture, not a state |
| 6 | f7eb2a5a | monitor names stale functions from the closure map | no | operator tooling |
| 7 | 41fafb6c | second provider's 429 cooldown never wired | only with data | needs a rate-limited account |
| 8 | 140a54f1 | a short prompt containing "by" hard-failed as a strict song list | only with data | the flow's prompt must contain " by " plus strict wording |
| 9 | 5c2dc3fe | refund copy promised more than the Terms | no | policy text |
| 10 | 6eaf9671 | 21 cron handlers failed silently | no | cron |
| 11 | 05fa726b | a fourth writer of model-written prose | no | cron output |
| 12 | 64c31b70 | guard all three prose writers | no | same |
| 13 | 41b188ef | 10 of 26 admin routes overflow at 375px | no | admin routes are not the primary flow (a `scrollWidth` assertion would catch it there) |
| 14 | c4c4dfe8 | admin overflow, account menu could not scroll | no | admin |
| 15 | de8a93b5 | white on solid tokens, 2.30:1 | no | contrast measurement |
| 16 | 8132d0bc | green text with 2% contrast headroom | no | contrast |
| 17 | 8a690f43 | raw colours tokenised, plus a gate | no | token hygiene |
| 18 | 2d89aafd | e2e specs suppressed overlays with dead keys | no | test infrastructure |
| 19 | fee8c41c | a tracking pixel never loaded because the tag manager's tag was paused | **yes** | after marketing consent, assert the pixel request fired |
| 20 | 46cfff25 | share card overlapped its own text | no | image endpoint, off the flow |
| 21 | 1613dd26 | brand marks on the track-link row | no | design |
| 22 | d4b168ba | two YouTube players on the page at once | **yes** | with the console playing, tap a wall card; assert one iframe on the page |
| 23 | bd1012e0 | Pro price contrast | no | contrast |
| 24 | 33b4f1c6 | dimmed green tokens | no | contrast |
| 25 | ce8b5d19 | drop-zone overlay contrast | no | contrast |
| 26 | a8cb7a7a | bare text-primary used as text | no | contrast |
| 27 | 596b4b28 | seven icon-only sites | no | contrast |
| 28 | c499dd14 | 17 text-primary sites the gate cannot reach | no | contrast |
| 29 | 5476ed8b | an "undefined means yes" audit default | no | admin column with no reader |
| 30 | 67af0113 | analytics reported nothing after a route prop was added | **yes** | after navigation, assert the pageview beacon was queued |

| verdict | count | share |
|---|---|---|
| yes, the primary flow with a state assertion | **4** | 13% |
| only with specific data (a rate-limited account, a particular prompt) | 3 | 10% |
| no | 23 | 77% |

**The ceiling is small, and it is said here before anything below.** Four of
thirty. Nine of the thirty are one accessibility-contrast campaign that happened
to fall in the window; excluding that campaign the share is 4 of 21, 19%. On
the 184 rework fixes in Project C's last 60 days that is roughly 24 to 42 fixes
the check could have prevented, and only if it was run on the right flow with
the right assertion. It is not a gate on the 30; it is cheap insurance on the
4, and the sections below establish whether it is cheap and whether it actually
sees those 4.

What the 23 have in common is worth stating, because it is where the earlier
document's "112 incomplete flows" live: copy, contrast, cron output, admin-only
routes and server-side counts. A flow check drives one flow, as one user, in one
state. Most first-pass failures in this window were somewhere else.

## 3. The check, defined so it can fail

A story gets a runtime flow check when an acceptance criterion names something
the user sees or gets. The check drives that flow with the in-app browser tools,
reads the outcome back as a value, and writes a record that
`plugins/autodev-core/scripts/flow-evidence.js` validates. The validator
computes the verdict from `expected` against `observed`; a `passed` flag would
be a claim. Three exits: 0 PASS, 1 FAIL (the product), 2 REFUSED (the record has
no assertion, a `visual` subject, a "looked fine" claim, no observed value, or
a `commit` that is missing, malformed, or not reachable from the commit being
verified). `tooling/test-flow-evidence.js` drives it as a subprocess, 62
checks, against a throwaway repository with a base commit, its child at HEAD
and a commit on another branch.

`[measured 2026-09-09]` the Codex overnight audit drove the CLI at `838d025`
and found two P2 defects, both fixed in this PR. First, nothing bound a record
to a revision: a record dated `2000-01-01` with expected 1 / observed 1 passed
with exit 0, so one `flow.json` could be reused across arbitrary commits and
deployments and PASS meant only "internally consistent". The record now
carries a required `commit` (the 40-character sha `git rev-parse HEAD` printed
when the flow was driven), and the validator refuses, exit 2 and not a warning,
unless that commit equals or is an ancestor of `--at <sha>`, default HEAD of the
repository the record sits in. Ancestry rather than equality because the record
is committed with the change, so its commit is the parent of the commit that
carries it; ancestry rather than an age bound because an old proof stays valid
while the code it proved is still in the history. Second, the template emitted
the repository-relative screenshot path `.claude/evidence/S00-000/after.png`
while the reader resolved paths against the record's own directory, so a
record saved where the skill says to save it looked for
`.claude/evidence/S00-000/.claude/evidence/S00-000/after.png` and was refused at
exactly the verification step. Screenshot paths now resolve from the
repository root (the nearest `.git` above the record, else the cwd), and the
refusal names the resolved path. Field names did not change; `commit` was
added.

Two rules came out of running it rather than designing it:

- **A console-error rule that fails on any error fails every record in a repo
  whose dev page carries errors before the flow starts.** Project D's Next dev
  tree logs a CSP complaint about React's `eval` and a blocked analytics script
  on every load; Project C's Vite tree logs blocked script fetches. The record
  may carry `consoleErrorsBaseline`, the count on the same page before the flow,
  and fails only on errors the flow added. The baseline is in the record, so a
  reviewer sees "2 before, 2 after".
- **While the Browser pane is hidden, `computer` clicks and key presses do not
  reach the page.** A keydown listener installed on the page saw nothing after
  `computer key Escape`; `document.visibilityState` was `hidden`; a dispatched
  `KeyboardEvent` reached the handler and the field cleared. `navigate`, `find`,
  `form_input` and `javascript_tool` work either way. A check that reads the
  outcome after an input it cannot prove arrived reports a false red about the
  product. The skill now says so.

The Stop hook was not changed. A block on a missing flow record would hold every
turn in a repo with no dev server, no browser tools, or criteria that name
nothing user-visible.

## 4. What it costs

**One flow check on Project D's primary flow** (open the generator, enter an
address, read back that one QR image rendered with the right alt text):

| step | wall time |
|---|---|
| drive and read back: `navigate`, `find`, `form_input`, `javascript_tool`, `read_console_messages`, two browser batches | 37.8 s |
| write the record and validate it | 0.08 s |

**Five stories on a throwaway branch of Project D**, each a small change to the
generator with a user-visible outcome, implemented and then flow-checked.
Stamps were written by shell before and after each arm.

| story | implement + typecheck | flow check | flow check as share |
|---|---|---|---|
| C1 encoded destination shown under the code | 13 s | 34 s | 72% |
| C2 Clear button empties the field | 2 s | 49 s | 97% |
| C3 character count under the field | 2 s | 79 s | 98% |
| C4 sample-link chip fills the field | 2 s | 29 s | 94% |
| C5 Escape clears the field | 2 s | 61 s | 97% |
| **total** | 21 s | **252 s** | 92% |

Read the percentages as a floor on the check and a ceiling on the story, not as
the overhead of a real sprint. The implementation arm counts only tool time,
edit plus typecheck, for changes of five to fifteen lines that were planned
before the stamp; the flow arm counts wall time across two to four browser
calls including the agent's turns between them. A real story takes minutes to
an hour, against which 50 s (29 to 79 s) of flow check is a few percent. The
absolute number is the measurement: **about 50 s and three to five tool calls
per story**, plus a dev server that is already required by the existing visual
check. The two full `auto` sprints the brief asked for were not run: with N=5
the comparison would be dominated by story-implementation variance, and the
check is purely additive, so its cost is its own wall time.

C5 is the row to read twice. Its first run failed the assertion, and the failure
was the probe, not the product (section 3). The 61 s includes finding that out.

## 5. The replay: does the check see the class?

For three of the four "yes" commits, a worktree at the parent of the fix (the
defect present) and, as the control, the fix commit itself, served by the same
dev server, driven with the same steps. A check that goes red on the parent and
green on the fix has seen the defect; one that reads the same on both is blind.

| fix | flow driven | assertion | parent of the fix | the fix |
|---|---|---|---|---|
| 67af0113 analytics reported nothing | open the generator route | a `pageview` for that route is in the analytics queue | **0 pageviews queued** | 2 queued, route and path both set |
| d4b168ba two players at once | with the console holding a queue, tap a wall card's preview | exactly one YouTube iframe on the page, none inside the wall | **2 iframes, 1 inside the wall** | 1 iframe, 0 inside the wall |
| d57dd057 raw anchors forced full reloads | on Terms, set a window marker, click "contact page" | the marker survives the navigation | **marker gone, document navigation** | marker present |

**3 of 3.** Each parent fails the assertion the later fix describes, and each
fix passes it.

Bounds on that result, stated rather than left to the reader:

- The console-playing precondition for d4b168ba has no anonymous entry point
  short of a generation, which writes to production. The player's persisted
  queue was seeded through localStorage in the shape the app itself writes, so
  this row is "caught, with data", the same category as rows 4, 7 and 8 above.
- d57dd057 carried four defects; the one replayed is the raw-anchor one, because
  the progress-bar one needs a real generation. The row says what was replayed.
- In development the analytics script runs in debug mode and sends nothing, so
  the observable is the queue the script drains, not a network request. In
  production the same assertion is on `read_network_requests`.
- Three replays, on one repo, chosen from the four "yes" rows. This says the
  check as defined sees the class it was defined for. It says nothing about the
  23 "no" rows, which section 2 already conceded.

## 6. How to measure the effect in 30 days

The number this exists to move is fixes per feature, and specifically the
24-hour rework share, in repos where stories carry `flow` records. On
2026-10-08:

```bash
# 1. The ratio and the rework share, before and after, per repo.
node plugins/autodev-core/scripts/mine-fixes.js <repo> --json --since=90.days --window-days=1   # includes the 60 before
node plugins/autodev-core/scripts/mine-fixes.js <repo> --json --since=30.days --window-days=1   # the 30 after
# Compare fixesPerFeature and reworkPct between the two. The 90-day figure is
# dominated by the before period; the 60-day figures in section 1 are the before.

# 2. Adoption: how many stories closed with a flow record, and how many records pass.
ls <repo>/.claude/evidence/*/flow.json | wc -l
for f in <repo>/.claude/evidence/*/flow.json; do node plugins/autodev-core/scripts/flow-evidence.js "$f"; done | sort | uniq -c

# 3. The ceiling, re-read: classify the 30 most recent rework fixes as in section 2.
git -C <repo> log --since=30.days --no-merges --format='%h %s' --grep='^fix' -E | head -30
# For each: would the primary flow with a state assertion have caught it? Count the yes rows.

# 4. The direct test: fixes that landed within 24 h on files a flow-checked story touched.
git -C <repo> log --since=30.days --no-merges --format='%h %ct %s' --grep='^fix' -E -- <files named in the flow-checked stories>
```

What would count as the check working: the 24-hour rework share falls in repos
where adoption is high, and the "yes" share in step 3 falls because those
defects are now caught before the commit. What would count as it not working:
adoption is high and the "yes" rows in step 3 are still there. What would mean
nothing: adoption is low, in which case the number cannot move and the finding
is about the wiring, not the check.

## What this changed in the framework

- `plugins/autodev-core/scripts/flow-evidence.js` and its suite: a record with
  no assertion is refused.
- `skills/auto/SKILL.md`: the Feature (UI), Edge Function / API and Bug fix rows
  gain the flow check; a "Runtime flow check" section carries the steps, the
  ceiling, the hidden-pane rule and the reason the Stop hook is untouched.
- `skills/auto/references/verify-tags.md`: the `flow` tag.
- `scripts/mine-fixes.js`: `--since=<git date>`, so the question this document
  starts with can be asked of the tool.
- `rule-verification`: one dated sentence, because the replay supports it.
