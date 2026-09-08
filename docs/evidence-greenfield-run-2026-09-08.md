# One measured greenfield run: idea → spec → setup-project → auto → ship

`[measured 2026-09-08]` on one macOS machine (Darwin 27.0.0, Node 24.19.0,
Claude Code desktop, autodev plugins 8.164.0 installed from commit `25d91dd`,
this repo at `b8eae1f`). One Brain session, one turn, no human in the loop.
The companion file `evidence-greenfield-run-2026-09-08-log.txt` is the run log the
protocol required, one timestamped line per transition (UTC); every number
below cites a line of it as `L<n>` or the command that produced it. The Vercel
team slug is redacted to `<vercel-team>` in the copy here; nothing else is.

## Why this run

`[measured 2026-09-07]` zero of the four products on this machine entered
through `spec` and `setup-project`. Their `prd.json` arrived after 918, 1,078
and 27 human-led commits, and the one greenfield repo started after the harness
existed has no `prd.json` at all. So "can the Brain take an idea to
production-grade software by itself" had no measurement behind its first stage.
This run is that measurement. The product is throwaway; the evidence is the
deliverable.

## Method

- The idea, verbatim and reworded zero times: *"A page where a small team logs
  who is on call this week and gets a Slack-style message preview when it
  changes; Supabase for the table, Vercel for the page."*
- Product directory `~/Code/greenfield-run-2026-09-08`, created empty. No
  existing product repo was touched.
- Each stage was entered through the harness's own skill via the Skill tool
  (`/spec`, `/setup-project`, `/auto`, `/ship`), so the inline `!` commands
  and the skill text were the installed ones, not this worktree's.
- At every point that needed something only a person can supply: no retry, no
  invented value, no secret in chat. The `wizard` skill was loaded, a numbered
  handback written into the log, and a `needs-setup` story written into
  `prd.json`. Work that did not depend on it continued.
- Pre-flight on this machine (L2, L3): `vercel whoami` = logged in;
  `supabase` CLI not installed; `docker` not installed; `pnpm` not installed and
  `/usr/local/bin` not writable, so pnpm ran through `corepack pnpm` and a
  one-line wrapper script on `PATH` (L10, L16).
- Fixes-per-feature per `docs/failure-evidence.md`: a `fix` commit touching a
  file a `feat` commit changed in the previous three days is a first-pass
  failure. Computed by `plugins/autodev-core/scripts/mine-fixes.js` on the
  product repo (L79) and checked by hand against `git log --name-only`.

## Stage table

| stage | log lines | start → end (UTC) | wall time | what came out |
|---|---|---|---|---|
| pre-flight | L1–L3 | 21:13:24 → 21:13:36 | 12 s | CLI state above |
| 1 `/spec` | L4–L8 | 21:13:36 → 21:15:32 | 1 min 56 s | SPEC.md, `0001_init.sql`, `prd.json`, gate exit 0 |
| 2 `/setup-project` | L9–L22 | 21:15:32 → 21:22:07 | 6 min 35 s | Next 16.3 scaffold, first commit `7caad7f` |
| 3 `/auto` | L23–L52 | 21:22:35 → 21:32:06 | 9 min 31 s | 7 commits, 1 story passed, 6 `needs-setup` |
| 4 `/ship` | L53–L78 | 21:32:07 → 21:36:34 | 4 min 27 s | 1 preview deployment, 1 accidental production deployment |
| 5 measure | L79–L80 | 21:36:34 → 21:36:47 | 13 s | fixes-per-feature |
| **total** | L1–L80 | 21:13:24 → 21:36:47 | **23 min 23 s** | 981 lines of product source, 10 unit tests |

Product commits: 11 (`git log --oneline` in the product repo), of which 4
`feat`, 3 `fix`, 3 `chore`, 1 non-conventional (`create-next-app`'s own).

## Stage 1: `/spec`

- **Asked: 0 questions** (L5). The skill's four ask-triggers (multi-user,
  money, real-time, data visibility) were all answerable from the sentence:
  "a small team" is multi-user with one team; no money; the preview renders
  on the change response, so request/response; every member sees the rota.
- **Inferred**: magic-link sign-in with the first sign-in creating the member
  row; one person per week; week keyed by its Monday; the announcement text
  built once and stored with the change so it survives reload; missing Supabase
  configuration as a first-class state. Eight assumptions, six non-goals (L6).
- **Produced** (L6): `SPEC.md` (59 lines), `supabase/migrations/0001_init.sql`
  (3 tables `members`, `oncall_weeks`, `oncall_changes`, RLS on all three, a
  `security definer` `is_member()` function, append-only change log), `prd.json`
  with 7 stories in sprint 1 and 2 held back under a `backlog` key.
- **Gate** (L7): `check-spec-output.js prd.json supabase/migrations/0001_init.sql`
  → exit 0, *"7 stories in prd.json, 3 tables in 0001_init.sql (3 with RLS);
  all stories are specific, checkable and pending"*.
- **Finding**: the two held-back stories were never read by the gate. It
  counts `stories` and `sprints[]` only, so a `backlog` written the way the
  skill suggests ("leave the rest unsprinted") is unvalidated (L7).

## Stage 2: `/setup-project`, create mode

Six findings in six and a half minutes, every one of them in the harness's own
templates rather than in the product:

| # | line | what happened | verbatim |
|---|---|---|---|
| 1 | L11 | `pnpm create next-app .` refused the directory `spec` had just written into | *"The directory contains files that could conflict: SPEC.md greenfield-run.log log.sh prd.json supabase/"* |
| 2 | L13 | three pin sources disagree | SKILL.md step 9: *"Biome 2.4 (strict), TS 5.8"*; `tooling-config.md`: *"prefer TS 5.8. TS 6 … too fresh"*; `version-defaults.md` (2026-08-17): typescript `^7.0`, biome `^2.5`, pnpm `11.x` |
| 3 | L16 | `shadcn init` shells out to a bare `pnpm` | *"Command failed with ENOENT … spawn pnpm ENOENT"* |
| 4 | L18 | `tsc --noEmit` fails on the untouched scaffold | *"src/app/layout.tsx(20,50): error TS2304: Cannot find name 'LayoutProps'"* — Next 16 emits it from `next typegen`, which no skill step runs |
| 5 | L19 | the `biome.json` template does not load on Biome 2.5 | *"Found an unknown key `ignore`"* — `files.ignore` was removed in Biome 2 |
| 6 | L21 | nothing in the skill provisions Supabase or Vercel | it writes `.env.example` and stops; the first human handback surfaces in `auto`, one stage later |

Finding 1 is structural: the skill sequence `spec → setup-project` that the
spec skill's own first paragraph describes cannot run in one directory. The
workaround was a scaffold into a scratchpad directory and a copy back (L12).
Findings 4 and 5 mean the skill's step 4 ("must pass clean") cannot pass on
the skill's own output without edits the skill does not describe. After the
two fixes: typecheck exit 0, lint exit 0, build exit 0 (L20).

## Stage 3: `/auto`

**The Stop hook never saw the product.** The session's cwd is this worktree,
and both the skill's inline state block and `stop-auto-check.js` read
`prd.json` from cwd: the skill printed *"No prd.json"* against a `prd.json` that
existed (L24). `.claude/auto-active` was written in the product directory, where
the hook cannot see it (L23, L50). A Brain that drives a product from another
directory, which is how every fleet session here works, gets no auto loop at
all from the hook.

**Handback #1 at 21:24:52** (L26–L36), 11 min 28 s into the run: S1-001 needs a
Supabase project. Seven numbered steps, dashboard URLs, "done looks like", ~6
minutes of the operator's time, and the resume plan. It blocked the
*acceptance* of S1-001 through S1-006 for the remaining 11 min 55 s of the run
and is still open. Under the skill's own selector, only S1-007 was executable
after it (L38): the other five are `blockedBy` S1-001. The code for all seven
stories was written anyway (L39), because writing it needs no account;
verifying it does.

### Per story

| story | start | end | verification actually run | first pass | state |
|---|---|---|---|---|---|
| S1-001 sign in | L26 21:24:52 | L44 21:31:42 | typecheck, lint, build; fake env in the browser: `/` → 307 `/login`, form with label, error path renders `role=alert`, 0 console errors, 390/414 no overflow | no: 2 gate misses, fix `37f7e15` | `needs-setup`, realness 20 |
| S1-002 see this week | L45 | L45 | typecheck, lint, build, 6 week-logic unit tests | n/a | `needs-setup`, 20 |
| S1-003 set / change | L46 | L46 | as above; `Already on call` guarded client and server | n/a | `needs-setup`, 20 |
| S1-004 Slack preview | L47 | L47 | 4 message unit tests (text, taking-over clause omitted on first set, bolding) | n/a | `needs-setup`, 20 |
| S1-005 week stepping | L48 | L48 | typecheck, lint, build, `addWeeks`/`weeksBetween` tests | n/a | `needs-setup`, 20 |
| S1-006 change list | L49 | L49 | typecheck, lint, build only | n/a | `needs-setup`, 20 |
| S1-007 setup notice | L38 21:24:53 | L43 21:30:28 | browser at 390 and 414 with `innerWidth` asserted, `/` and `/login` HTTP 200, 0 console errors; then the deployed build | no: 1 gate miss, fix `d33f2e6` | **passed**, realness 60 |

"n/a" for first pass means the acceptance criterion names database rows that
could not be observed, so pass or fail was never decided. Typecheck passed
first time on 981 lines (L39 → the run at 21:27); the 10 unit tests passed
first time; lint's 21 first-run errors were all formatting and import order,
auto-fixed.

Two states, both wired for the first time: the `auto-active` flag and
`needs-setup`. **`needs-setup` was written into a product `prd.json` 6 times
in stage 3 and 8 times by the end of the run** (L50, L78). Before this run the
count across every product on this machine was 0.

One more red the harness caused: Biome reformats `prd.json` after every
harness-style write (expanded arrays), so lint went red on a file the code did
not touch. Excluded in `229f6ba` (L52).

## Stage 4: `/ship`, preview only

Step 1 gates in 8 s (L55): typecheck 0, build 0, vitest 10/10, `pnpm audit
--prod` *"No known vulnerabilities found"*, 0 dirty paths. Step 2 checklist
found HTTP security headers absent; added in `dce60b1` (L56).

**Finding, the important one (L57).** The skill's "Preview first" command is
`npx vercel --yes`. On a project's first deployment Vercel returned
`target: "production"` with the hint *"This is the project's first
deployment, so it was assigned to production. Future deployments will be
preview deployments unless you use --prod."* The run's preview-only rule was
broken by the harness's own command, on a throwaway project with no users and
no money, in 32 s. A second `vercel --yes` produced a real preview
(`target: null`, READY in 22 s, L58).

**Handback #2 at 21:34:48** (L59–L66): the preview URL 302s to
`vercel.com/sso-api` on every route (Deployment Protection, on by default); the
in-app browser landed on *"Log in to Vercel"*. Worked around in 1 min 46 s with
the skill's own hint, `vercel curl`, which uses the CLI login: `/` 200 with the
setup notice, `/login` 200, and all four security headers present (L67). The
browser pass ran against the production alias, which is the same build and is
open (L67, L68): desktop card centred, font Geist, 0 service workers, 390 and
414 asserted, 0 console errors, every network request 200.

One invalid capture: a desktop screenshot showed the card crammed at the top
left while the same call read `window.innerWidth === 0` (L68). The rule
"assert the viewport you think you measured" is what made it a non-finding
rather than a false defect.

Deploy ledger (L69): `--write` exits 2 with no marker, which is correct
behaviour on a repo with no tags; with `--since d1ff8fe` it derived 46 files,
13 user-facing, 5 routes, 2 wide-effect, 8 without a route. Ten rows ticked
after being driven; `--verify` correctly refuses on the four rows never
rendered anywhere reachable (`rota`, `change-list`, `slack-preview`, `badge`).

**Handback #3** (L71–L76): production promotion, by standing rule. Logged as
the final `needs-setup` story and the run stopped there.

## Handbacks

| # | line | needed | blocked | how long it blocked |
|---|---|---|---|---|
| 1 | L27 | a Supabase project: create, apply the migration, set redirect URL, two env vars on Vercel | acceptance of 6 of 7 stories; the whole primary flow | from 21:24:52 to the end, 11 min 55 s, still open |
| 2 | L60 | a Deployment Protection toggle or bypass secret | browser verification of the preview URL | 1 min 46 s until `vercel curl` substituted; still open for a clean browser |
| 3 | L71 | the operator's decision to promote | production | terminal by design |

`needs-setup` count at the end: **8** (S1-001 to S1-006, S1-008, S1-009; L78).

## Fixes per feature

`mine-fixes.js` on the product repo (L79): *"3 fixes : 4 features = 0.75
fixes per feature. 2 of them (67%) landed on code a feature touched in the
previous 3 days."* Checked by hand:

| fix | file | the feat that touched it | first-pass failure? |
|---|---|---|---|
| `d33f2e6` font self-reference | `src/app/globals.css` | `7caad7f` scaffold | yes |
| `37f7e15` 44 px input, readable error | `src/app/login/*` | `d40cdfc` auth | yes |
| `dce60b1` security headers | `next.config.ts` | only the non-conventional `create-next-app` commit | no, by the definition |

Ratio: **0.75 raw, 0.5 by the three-day definition.** The three production
repos in `failure-evidence.md` sit at 0.94, 1.71 and 2.00. This is a 23-minute
run with one browser pass, so the comparison is directional only.

## What the browser found that the gates called green

All three code fixes came from looking, not from a gate. Typecheck, lint,
build and the unit tests were green before each.

| # | line | defect | which gate should have caught it |
|---|---|---|---|
| 1 | L42 | every page in the browser serif: `shadcn init` rewrote `--font-sans: var(--font-sans)`, a self-reference, at the scaffold commit | a computed-style read on the first screenshot of any UI story; the "Font declared but not loaded" row in `auto`'s hardening table is prose |
| 2 | L44 | the email input is 32 px tall; the generation constraints say every touch target is 44 px | a `getBoundingClientRect().height >= 44` assertion in the a11y pass |
| 3 | L44 | the sign-in failure shows the transport error verbatim, *"fetch failed"* | none exists; found by submitting the form |
| 4 | L55 | no HTTP security headers | the ship checklist found it, one stage late; the scaffold template could ship them |
| 5 | L57 | a "preview" deploy that was production | reading `target` from the deploy JSON and refusing to continue |

## Could not check

- The primary user flow: sign in, set this week's person, reload, read the
  preview, sign in as a second member. No Supabase project (L70).
- `0001_init.sql` was never executed against any Postgres. The RLS policies,
  the `security definer` function and the Monday `check` constraint are
  unverified SQL.
- The magic-link email, the `/auth/callback` exchange with a real code, and
  the members-row creation on first sign-in.
- The preview URL from a browser that is not logged in to Vercel (handback #2).
- The Stop hook's block/approve behaviour and the eight-block cap: the turn
  never ended and the hook reads the wrong directory anyway (L50).
- Dark mode. The pages use theme tokens but no `.dark` render was taken.
- The two held-back stories, which the spec gate never read (L7).
- Whether Vercel's build used pnpm 12 or a fallback: the build succeeded
  twice and the log was not inspected for the package manager line.

## Where the 23 minutes went

The product took under ten minutes of the run (L39: all code written by
21:27:21, seven minutes after the scaffold commit). Setup-project template
repair took longer than the product's first draft. The rest was verification,
handback writing and one accidental production deployment.
