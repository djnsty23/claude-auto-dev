# Human-only work as a first-class state

`[measured 2026-09-08]` against `origin/main` of three product repos after `git fetch`,
anonymised as Project A (a live consumer app, 214 stories), Project B (a fitness app, 30
stories) and Project C (a client's benchmarking product, 122 stories): trunks at 35ff35a1
(2026-09-07), 61f6d84b (2026-09-07) and a222b73f (2026-09-05). Every `prd.json` revision on
each trunk was parsed (219, 259 and 118 revisions; 0 unparseable) and every story that was
ever `null`, `false` or keyless for more than 30 days was classified by hand. Ages come from
the last commit that changed the story's own JSON, never from file mtime.

Re-verify before acting. The classification is a statement about those three commits.

## The premise, re-measured

The brief's numbers were read from the local checkouts, and two of the three are side
branches: Project B's checkout sits on a feature branch **353 commits behind** its trunk, and
Project C's on a docs branch **387 commits behind**. Against the trunk the picture changes in
every cell that matters:

| claim | local checkout | `origin/main` |
|---|---|---|
| `needs-setup` ever written to prd.json (A / B / C) | 0 / 0 / 0 | 0 / **1** / 0 (Project B, 80ecf535, 2026-09-06) |
| `deferred` written | 37 / 0 / 11 | 45 / 7 / 23 |
| Project C pending | 15, idle since 2026-08-16 | **10**, last prd.json commit 2026-09-05 |
| S1-060 rotate credentials | `null` since spring | `true`, closed 2026-08-27 |
| S1-024 DNS hand-off | `null` since spring | `true`, closed superseded 2026-08-21 |
| S1-021 pipeline variables | `null` since spring | `null`, 122 days pending, edited 21 days ago |

The direction of the change is the point: the trunk has *more* deferrals, one real
`needs-setup`, and two of the three named stories already closed. The class the brief
describes still exists, and is smaller than the brief said.

The frame lesson, so it is not repeated: a `git log -S` on a checkout answers a question
about that branch. `drift-audit.js` already reads the default branch for this reason;
the brief's probe did not.

## Step 1: the class, classified

**Population: 36 stories** across three repos were pending for more than 30 days at some
point in their history. Classes: (i) blocked on a human, (ii) agent-doable and not picked
up, (iii) obsolete.

| | (i) human | (ii) agent | (iii) obsolete | total |
|---|---|---|---|---|
| still pending today | **6** | 6 | 0 | 12 |
| since closed or deferred | 7 | 13 | 4 | 24 |
| total | 13 | 19 | 4 | 36 |

**The live population for this change is six stories, all in one client repo.** That is
small, and it is said here before anything built on it: (b) and (c) below rest on these six
plus Project B's one correctly-marked story; (a) rests on a different measurement, one spec
run, described under change (a). The historical seven show the same shape closing without the
state ever being written.

`age` is days since the last commit that changed the story's JSON; `span` is days the story
sat pending, from first commit to the first commit that moved `passes` off pending, or to
today.

### Project C, 16 of 122 stories (10 actionable, 18 deferred, 94 done)

| id | passes | span | age | class | why |
|---|---|---|---|---|---|
| S1-021 | null | 122 | 21 | **(i)** | CI repository variables. A named person owns the pipeline, the operator supplies the bundle; the reconciliation note says one look at the settings page closes or refutes it. |
| S3-013 | null | 80 | 21 | **(i)** | Credits system. AC5 is gated on two people's decisions; the reconciliation note says narrowing or closing it "is his call". |
| S4-004 | null | 56 | 56 | **(i)** | Public overview page. AC5: three decisions by a stakeholder plus a partner API update. Phase 0 is agent-doable and should be split out. |
| S4-005 | null | 56 | 56 | **(i)** | Title says "BLOCKED on" the partner: a third party's API gaps 1-3. |
| S4-006 | null | 56 | 56 | **(i)** | AC2: "entry point + route shape confirmed with" the operator. A decision of taste. |
| S4-007 | null | 56 | 56 | **(i)** | AC1-2: intent clarified and design agreed with two people; the raw ask reads as cloaking. |
| S3-009 | null | 84 | 2 | (ii) | QA on known companies; edited 2026-09-05, active. |
| S3-010 | null | 84 | 11 | (ii) | Endpoint build. "After Phase 1 is stable" but `blockedBy` is empty. |
| S3-011 | null | 84 | 84 | (ii) | `blockedBy: [S3-010]`, correctly chained. |
| S4-008 | null | 56 | 56 | (ii) | The LLM is already wired; logically depends on S4-004 but `blockedBy` is empty. |
| S1-060 | true | 108 | 11 | (i) hist. | Console rotation "only [the operator] can do"; closed 2026-08-27 when someone else rotated after a real leak. |
| S1-024 | true | 105 | 17 | (i) hist. | Registrar and DNS; closed superseded 2026-08-21. |
| S1-023 | true | 42 | 11 | (i) hist. | Coordinate manifests with a named person; closed by reconciliation. |
| S2-014 | deferred | 76 | 12 | (i) then (iii) | "Blocked on a human yes/no: did the review happen?"; deferred 2026-08-26. |
| S1-059 | deferred | 107 | 11 | (iii) | Superseded; the work landed in another file. |
| S2-013 | true | 70 | 17 | (ii) hist. | Investigation, done. |

Every one of the six live (i) stories carries `blockedBy: []` and `passes: null`. By the
CLAUDE.md table each is work an agent cannot advance, and each has been offered to every
`auto` run for two to four months.

### Project A, 18 of 214 stories (8 actionable, 11 deferred, 195 done)

| id | passes | span | age | class | why |
|---|---|---|---|---|---|
| S16-045 | null | 128 | 128 | (ii) | Support tab. A feature nobody picked up; nothing human blocks it. |
| S16-AUD-126 | null | 36 | 1 | (ii) | Active, edited 2026-09-06. |
| S16-053 | true | 70 | 57 | **(i)** hist. | Title says "manual UI step, no API": link two analytics products in a console. |
| S16-054 | true | 70 | 57 | **(i)** hist. | Consent banner: pick and pay for a consent-management vendor, then wire the tag manager. |
| S16-048 | deferred | 70 | 57 | (iii) | Pricing decided, tier deferred. |
| S16-056 | deferred | 70 | 57 | (iii) | Bundled with a later launch by decision. |
| 12 others | true | 59-126 | 57 | (ii) hist. | S16-039, -034, -032, -040, -049, -050, -055, S16-AUD-025, -039, -041, -043, S16-SB-045: all closed in one reconciliation sweep on 2026-07-12. |

### Project B, 2 of 30 stories (1 actionable, 1 needs-setup, 1 deferred, 27 done)

| id | passes | span | age | class | why |
|---|---|---|---|---|---|
| S4-028 | deferred | 58 | 5 | (iii) | A post-v2 plan. |
| S4-AUD-51 | true | 34 | 4 | **(i)** hist. | Split on 2026-09-03: engineering closed true, the device walk became S4-NAT-4, which is `needs-setup` on the trunk. **The one correct use of the state on this machine**, and it was written by hand. |

### The measurement that is not in the histories

A greenfield run on 2026-09-07 (a fresh product directory beside these repos, its own log)
ran `spec`, whose SPEC.md said "Supabase holds the members ... Vercel serves the page", and
produced seven stories, none about either service. `check-spec-output.js` passed it. `auto`
hit the missing project on story one, hand-edited `passes: "needs-setup"` into S1-001 with a
`blockedReason` pointing at "HANDBACK #1" in its log file, and by the time this was written
had marked six of the seven stories the same way. That is (b) happening by hand, today, and
the handback living outside the story. It is also the whole case for (a): the spec knew.

## Step 2: three changes, each against doing nothing and one variant

Wall times are the median of five runs on this machine. Bytes are `wc -c` of SKILL.md
before and after.

### (a) `spec` emits the setup manifest, and the checker demands it

| variant | verdict on the 2026-09-07 spec | precision | cost |
|---|---|---|---|
| A0 nothing | passes; `auto` discovers the missing project at story 1 | n/a | 0 |
| A1 lexicon hard-fail: any service named in SPEC.md needs a setup story | fails, naming Supabase, Vercel **and Slack** | 2 of 3 on the spec; **35 of 49** on 8 README/CLAUDE.md files | +313/-83 lines |
| **A2 shipped**: `## External services` is the verdict; the lexicon only fails a spec with NO section | fails: "no External services section and names Supabase, Vercel, Slack" | a false lexicon hit is a note, never a failure | spec skill +3,420 B; checker +313/-83 lines; suite 21 to 53 cases; 0.07 s with or without `--spec` |

A1's 14 false hits, read one by one: "no Google OAuth", "Slack-style preview", "refs purged
from active docs", "SendGrid considered later", an OpenAI-compatible endpoint that is Gemini.
A gate wrong one time in three is learned around, so the spec's own list carries the verdict
and the lexicon guards the one failure a list cannot: the list being absent. The real
SPEC.md and prd.json from that run are committed under `tooling/fixtures/spec/oncall/` and
the suite asserts the old verdict (pass, without `--spec`) beside the new one.

What the checker now also enforces: `type: "setup"` and `passes: "needs-setup"` imply each
other; a setup story's `blockedReason` carries a URL; `blockedBy` resolves to a story in the
file. `blockedBy` was not invented: `auto`'s selector has read it since the sprint system
existed and `[measured 2026-09-08]` Project C carries it on all 122 stories. It simply had no shared reader, so
`prd-states.js` gained `blockers()` and `isReady()` and `summarise()` a `ready` count.

### (b) `auto` marks on handback, through one script

| variant | what happened / would happen | cost |
|---|---|---|
| B0 nothing | 1 write in four months across three trunks; six live stories misfiled as pending | 0 |
| B2 prose only ("set passes to needs-setup by hand") | the one hand edit observed put the handback in a log file; hand edits are how `archive-prd` deleted the state and how a nested file counted zero | 0 script bytes, no refusals, no idempotence |
| **B1 shipped**: `prd-mark-needs-setup.js` mark / `--clear` / `--list`, called from `auto`'s new Handback section and from `wizard` | marks; refuses unknown id, `true`, `deferred`, empty reason; byte-identical on a repeat; `summarise()` on the result counts it outstanding and not actionable | 0.07 s; 58 cases; auto +3,816 B; wizard +818 B; core schema +685 B |

The handback goes in `blockedReason`, not `notes`. In a spec-generated backlog `notes` is the
acceptance criterion `auto` reads to decide whether the story is finished; overwriting it
turns "what done looks like" into "what we are waiting for". `blockedReason` is the name
`auto`'s retry step already used and the one the greenfield session reached for unprompted.
`--clear` returns the story to `null`, not `true`: the agent verifies the person's work
against `notes` before closing, and dependents become ready only then.

### (c) `status` and the Stop hook say who it is waiting on

| variant | behaviour | cost |
|---|---|---|
| C0 nothing | `status` prints "Needs-setup: N" inside a five-count line; the Stop hook computed `blockedOnOperator` and never printed it (a dead variable) | 0 |
| C2 a `systemMessage` on every approve, like the nudge | fires every turn; the hook's own rule is that a check speaking every turn is ignored | rejected |
| **C1 shipped**: `status` prints "Blocked on you: N (ids)" as its own line; the Stop hook names the ids in the sprint-complete reason and on stderr | the turn still ends; the reason tells the model to report what each waits for rather than retry | status +914 B; hook +13/-1 lines, 0.07 s before and after; 3 new cases plus a termination pin |

The termination property is now pinned: a backlog whose only remaining story is
`needs-setup` reaches `approve` within a few stops, with the auto flag cleared. The suite
asserted "Sprint complete" for that case and did not drive it to approve; the deferred case
did. `stop-brain-report.js` reports commits, not sprint state (0 hits for prd, sprint or
needs-setup), so it was not widened.

**One constraint, stated rather than worked around.** The inline `!` commands in `status`
and `auto` are literal classifiers, not `summarise()`. `${CLAUDE_PLUGIN_ROOT}` is documented
as substituted in skill body text and exported to hook and MCP processes; whether it reaches
a `!` command is not documented, and a command that fails at skill load prints its failure
into every invocation. They stay literal and are gated by `test-skill-prd-commands.js`, whose
six-state canary has independent provenance and drove the new "Blocked on you" line.

## Step 3: backfill, once

**Project C (a client repo, read-only here): a proposal.** Six stories, each with the
command and the reason it would carry. Apply on a branch after confirming each with the
person it names; S4-004 should be split first so its Phase 0 slice stays actionable.

```bash
node prd-mark-needs-setup.js S1-021 "Needs the 17 CI repository variables set by the pipeline owner from the operator's env bundle: repository settings > repository variables (DEPLOY.md 5.2). Done when a pipeline run reads each one; the reconciliation note says one look at that page closes or refutes this."
node prd-mark-needs-setup.js S3-013 "Needs two decisions from the credits workstream owner: hub-vs-standalone wiring and the spend amounts (framework section 9). Four of five criteria are built; done when those two are written into the story and the earn-loop is unblocked or dropped."
node prd-mark-needs-setup.js S4-004 "Needs the stakeholder's three overview-page decisions and the partner's API update (docs/proposals, the overview proposal). Split Phase 0 out first: it ships on current data and needs nobody."
node prd-mark-needs-setup.js S4-005 "Needs the partner to close API gaps 1-3 (lift cap, per-ad array, dimension tags) per the endpoint-gaps proposal. Done when the endpoint returns tagged per-ad arrays."
node prd-mark-needs-setup.js S4-006 "Needs the operator to confirm the entry point and route shape for the versus page (AC2). Done when the story's notes name the route."
node prd-mark-needs-setup.js S4-007 "Needs the operator and the SEO owner to agree a non-cloaking design (AC1-2); the literal ask is a penalty risk. Done when the agreed design is in the story."
```

Also worth doing there, not proposed as needs-setup: S3-010 should carry `blockedBy:
["S3-009"]` and S4-008 `blockedBy: ["S4-004"]`, which their own descriptions say and their
`blockedBy` arrays do not.

**Project D (a QR product with no users) and autodev: nothing to apply.** Neither repo has
a `prd.json` on any ref (`git log --all -- prd.json` is empty in Project D; autodev's two
historical touches are not on `main`). The brief allowed direct commits there; there is
nothing to commit.

**Projects A and B: not touched**, per the brief. For the record, Project A has zero live
(i) stories and Project B's one is already marked.

## Measurable target, as stated in the brief

"needs-setup count in a prd.json goes from 0 to the true number": for Project C the true
number is 6 and this document is the proposal that gets it there; for the greenfield run it
is whatever `spec` emits under External services, which the checker now refuses to let be
zero when the prose names a service. "`status` reports blocked on you: N as its own line":
shipped, and the inline command's output is asserted to change when a needs-setup story is
added.

## Seen in passing, not fixed

The greenfield log records that `check-spec-output.js` did not read the two stories the spec
held back under a `backlog` key. `storiesOf()` reads `stories` and `sprints[].stories` only.
Whether `backlog` is a shape worth supporting is a decision, not a bug; it is noted here so
it is not rediscovered.
