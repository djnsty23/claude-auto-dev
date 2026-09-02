---
name: rule-local-first
description: "Verification happens on this machine, in a browser you drive, before anything is pushed. Covers the local gate, the batched publish cadence, why GitHub Actions is not the gate, and why a restored browser session fakes a pass. Load before verifying, before pushing, and before any visual check."
when_to_use: "Before verifying, pushing, or calling any work done."
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash, mcp__Claude_Browser__*
paths:
  - "**/*.workflow.js"
  - "**/.claude/launch.json"
  - "**/PUBLISH-QUEUE.md"
---

# Local-first verification

Portable copy of `~/.claude/rules/local-first.md`, which is `@`-imported on the Windows
box and therefore invisible to any other machine. Keep the two in sync. Two passages are
host-specific and named as such where they appear: the `ClaudeMemorySync` scheduled task
and the per-repo gate names.

Added 2026-08-21, on Andy's instruction: *"always test locally and run visual checks in
Claude's browser… no more pushes, no more GitHub Actions."*

## The gate is a local run you watched

A change is done when it ran on this machine and you looked at it. Not when a workflow
went green, not when a deploy succeeded, and not when the diff reads correctly.

For anything with a UI, in this order:

1. Run it locally through `preview_start` with a `.claude/launch.json` entry — never a
   dev server backgrounded through Bash, which nothing then owns or stops.
2. Size the viewport first (see below), then drive the real surface: `navigate`,
   `read_page`, click the actual controls rather than calling internal functions.
3. Read `read_console_messages` and `read_network_requests` before claiming anything.
4. Screenshot at 390 and 414, per `agent-quality.md` 10b.
5. Then say it works.

For anything without a UI, the local gate is the project's own checks — typecheck,
build, tests, preflight — run here and read here.

**The gate has one name: `npm run gate`**, or `npm run preflight` in a repo that already
uses that name. One command, chained with `&&`, covering exactly what the repo's CI used to
run. If a repo has no such script, writing it is the first task, not an optional tidy-up —
a gate spread across seven commands is a gate that gets run partially.

**`the music product` does NOT have a `gate` script — `[measured]` 2026-08-22.** This line used to
claim it did, as of 2026-08-21. It is absent from the working branch and from `origin/main`:
`git show origin/main:package.json` lists 40 scripts and `gate` is not one of them. Until it
is written, the gate on that repo is the chain by hand:

```bash
npm run typecheck && npm run test && npm run build
```

`typecheck` is the load-bearing one there, because `build` runs only `tsconfig.app.json` and
`tsconfig.node.json` — it skips `tsconfig.api.json`, so an `api/` change can build clean and
still be broken.

This is rule 20c one layer up: a claim about tooling that was *going to be* added got written
in the past tense, and every session since read it as done. Check `package.json` before
invoking a script name from memory.

Start it with `preview_start`, whose entry lives in that repo's `.claude/launch.json`. Read
the port out of the app's own config rather than assuming a framework default — the music product
serves vite on **8080**, not 5173, and a preview pointed at the wrong port fails in a way
that looks like a broken app.

## Pushing

Commits stay local. An ad-hoc `git push`, PR or merge needs Andy to say so in that turn.
"It is ready to push" is a status line, not a licence.

The batched publish below is the one exception, and only halfway: he set the *trigger*, so
you do not re-ask whether batching is allowed. You still present the manifest and get a yes
before it goes, because these repos deploy on push (Fly, Pages, release gates) and
`agent-quality.md` rule 4 does not bend for a cadence. The win is one confirmation per
batch instead of one per commit.

This does not cancel `agent-quality.md` rule 8. That rule covers the case where he says
push, and it still means do it without re-asking. What changed is the default ending of
a task: a verified local state, not a remote one.

**Carve-out:** the config mirror to `~/claude-memory` (`rules/backup-protocol.md`) is a
backup of this machine, not shipping code, and it is why a reinstall is survivable. The
`ClaudeMemorySync` task that pushed it every 4h was **disabled 2026-08-21**, so the mirror
is a manual, same-session obligation again. That is how it rotted to 49-of-157 files last
time — so mirror when you edit, do not trust a timer that is no longer running.

**Disabling that task did NOT stop the mirror being pushed, and it never could.**
`[measured 2026-08-22]` `~/claude-memory` is still committed and pushed every few minutes,
authored `Dispatch <dispatch@local>` — which is only the repo's local git identity, not an
actor. Resolving the process tree of a live `sync-claude-memory.ps1` gave
`claude.exe -> bash -> powershell`: **other Claude sessions**, obeying
`rules/backup-protocol.md` obligation 1, which says in as many words to commit *and push*
the mirror in the same session as the edit.

So this is two written rules disagreeing, not a stray daemon, and the older one wins because
it is unambiguous. **Treat `~/claude-memory` and `~/claude-auto-dev` as continuously
published** — anything written there reaches GitHub within minutes. To change that, amend
the backup protocol; disabling tasks cannot.

## Publishing — batched, never on a clock

Andy, 2026-08-21: *"what if we commit once per day as a daily publish or when we queue
2-5 items that need prod validation."* Commits stay local and accumulate. A **publish** is
the deliberate push of that batch.

**Publish when the queue reaches 2-5 items, or when the oldest item in it turns 24h —
whichever comes first.** Not on a schedule. A daily push with an empty queue is a push for
its own sake, which is the habit this rule exists to break; the day is a deadline on the
queue, not a cadence for the repo.

An item earns a place in the queue only if local verification **structurally cannot**
answer it. That list is short and enumerable, and it is the whole test:

- live payment flows, and anything keyed to a production Stripe object
- OAuth redirect URIs and webhooks registered against a production domain
- edge, CDN and cache behaviour that does not exist on localhost
- scheduled functions and crons, which have no local trigger
- push notifications, store builds, TestFlight
- anything whose input is real production data

"I would feel better seeing it live" is not on that list. If a local run can answer it, it
is answered locally and never reaches the queue.

The queue lives at **`PUBLISH-QUEUE.md` in the repo root** — one file per repo, each line
naming the change and which item above it needs. It cannot live in chat: a session that did
not have the conversation cannot see it, and the next session is the one that will publish.
Queues are per-repo, so only repos with a non-empty queue publish.

**Root, NOT `.claude/publish-queue.md`** — this rule said `.claude/` until 2026-08-22 and
that path defeats the rule's own reason for existing. `[measured]` `.claude/` is gitignored
in every repo checked (the music product, the fitness product, the wagering product, analytics), and
`rules/file-organization.md` explicitly instructs adding it, because that directory is
ephemeral tooling state. A queue there is never committed, so it is invisible to a session
on another machine — the precise failure the paragraph above warns about, reintroduced by
its own filename. The queue is durable shared state, not tooling scratch; it belongs where
git can carry it.

**Before a publish, run the local gate over the whole batch, not per-commit.** Each commit
was already verified alone; batching moves the risk to the integration between them, and
that is precisely what the disabled CI used to grade. A batch that has not been run as a
batch has not been verified.

## GitHub Actions

Do not add a workflow. Do not diagnose a bug by pushing and reading the run. Do not wait
on one. If a repo already carries workflows, their result is not evidence here and their
absence is not a blocker.

The reasoning is measured, not aesthetic. A CI run answers "did it pass on a machine you
cannot see", and `verification-traps.md` carries four separate ways that answer misleads:
a blocked run and a red test look identical, `startup_failure` renders as an ordinary red
X, `billable.total_ms` is always 0, and a rendered-geometry gate reports different numbers
on a different OS. The local run produces the same signal without any of that.

`ClaudeActionsSpendGuard` stays enabled. It costs nothing and it is the thing that says a
repo has started burning again.

## Browser state — cookies stay ON, the jar gets reset

`[measured]` 2026-08-21 in the in-app Browser pane:

- `navigator.cookieEnabled` is **true**. Cookies write, survive a cross-origin round trip
  (`example.com` → `example.net` → back), and survive a reload. localStorage likewise.
- There is **one profile shared by every tab**. A cookie set in the seed tab was readable
  in a freshly created background tab that had never visited the origin.
- There is **no incognito or isolated-context option** in this toolset.

So the question is not whether to enable cookies. They are on, and you want them on — most
surfaces worth looking at sit behind a login, and a shared jar means signing in once for a
whole session of checks instead of once per navigation.

The risk is the shared jar, and it already has an entry in `verification-traps.md`: *a
success that skips the code path proves nothing*. A restored session and a working sign-in
are identical from outside and opposite in value.

**The rule:** persist the session for feature checks; reset the jar before any check whose
subject is first contact — sign-in, signup, consent, onboarding, paywall, empty state, or
anything gated on whether this user has seen X before.

Reset, then assert it came back empty — the assert is the point, not the clear:

```js
(() => {
  document.cookie.split(';').forEach(c => {
    const k = c.split('=')[0].trim();
    if (k) document.cookie = k + '=; path=/; max-age=0';
  });
  localStorage.clear(); sessionStorage.clear();
  return { cookie: document.cookie, ls: localStorage.length, w: innerWidth };
})()
```

Two things it cannot do: clear an `HttpOnly` cookie — and the session cookie usually is one
— or clear another origin's jar. When the check genuinely needs a cold profile, use
chrome-devtools `new_page {isolatedContext}`. That is the only real isolation available.

Suppress tours, consent banners and onboarding by setting the app's own already-seen flag
in an init script **before** navigating. Dismissing one after the fact is a race, and
`verification-traps.md` has the incident where it hid a working P1 behind a false red.

## The viewport is 0x0 until you resize it

`[measured]` the same day: a foreground tab and a background tab both reported
`innerWidth: 0, innerHeight: 0`. One `resize_window` call fixed it — 375x812, dpr 2.

So every visual check opens with `resize_window`, and every call that measures geometry
prints `innerWidth`/`innerHeight` beside the number it measured. A rect compared against a
zero-height window answers `false` for an element that is plainly there — and a red gets
acted on rather than challenged, which is worse than a false green.

## Two limits on the browser pass — measured 2026-08-22

**`preview_start` reads the launch.json of the SESSION's working directory**, not of the
repo under test. A `.claude/launch.json` sitting inside the repo you are checking is
unreachable from a session rooted anywhere else, and the error you get names a port from
the wrong config, which reads like a port conflict rather than a lookup miss. Either work
from the repo's directory, or add an entry that runs
`npm --prefix <absolute-repo-path> run dev`.

Pick the port explicitly and check it first. Other sessions hold ports — 8080 and 7717 were
both taken, by another chat's dev server and by the fleet board. `preview_start` refuses
rather than picking a free one.

**Screenshots need a displayed pane.** In a non-interactive session
`computer{action:"screenshot"}` times out with *"the Browser pane is not displayed, so the
page is not compositing frames"*, and `tabs_select` does not fix it. Everything else works —
`read_page`, `javascript_tool` geometry, `read_console_messages`, `read_network_requests`.

So the 390/414 screenshot step in `agent-quality.md` 10b **cannot be satisfied here**. Do
the DOM-level pass, which catches overflow, tap targets, console errors and failed requests,
and then say plainly that no screenshot was taken. Never substitute a diff read for it.

**And check what a surface needs before promising to look at it.** A results screen that
only exists after a live API call cannot be reached locally at all; the honest output is
"verified the input surface, did not verify the subject", not a pass.

## This machine's specifics

Kept HERE, not in the `rule-local-first` plugin skill. That skill ships in a
PUBLIC repo, and these facts name private and client repos. Three separate
redactions were needed on 2026-08-22 before the split; the tension is structural,
not carelessness — the guidance is genuinely *about* specific repos, so writing it
accurately and publishing it pull in opposite directions.

The portable half lives in the skill. Everything below is the half that cannot.

**Which repo has which gate script** `[measured 2026-08-22]`
- `the fitness product` — `preflight`
- `the music product` — **no `gate` script**, despite this rule claiming one on 2026-08-21.
  Absent from the working branch and from `origin/main`; `git show
  origin/main:package.json` lists 40 scripts and `gate` is not among them. Until it
  is written, its gate is `npm run typecheck && npm run test && npm run build`.

**Ports** — `the music product` serves vite on **8080**, not the 5173 default. A preview
pointed at 5173 fails in a way that looks like a broken app.

**`.claude/` is gitignored** in every one of the four repos checked — `the music product`,
`the fitness product`, `the wagering product`, `analytics` — which is why `publish-queue.md` belongs at
the repo ROOT. A queue inside `.claude/` is never committed, so it is invisible to
a session on another machine: the exact failure the publishing section warns about,
reintroduced by its own filename.

**The config mirror** to `~/claude-memory` is the reinstall survival kit and is
exempt from the no-push rule. The `ClaudeMemorySync` task that pushed it every 4h
was **disabled 2026-08-21**, so mirroring is a manual, same-session obligation
again — that is how it rotted to 49-of-157 files last time. Do not trust a timer
that is no longer running.

**`ClaudeActionsSpendGuard` stays enabled.** It costs nothing and it is the thing
that says a repo has started burning Actions minutes again.

## A tap-target sweep built on getBoundingClientRect reports false positives

`[measured]` 2026-08-22, the music product. A rect-based sweep flagged four controls on `/generate`
as under the 44px minimum. All four were fine. The project defines a `.tap-target::after`
utility that expands the hit area to 44x44 under `@media (pointer: coarse)`, and **84
controls carry it** — `getBoundingClientRect()` returns the element's own box and cannot see
a pseudo-element, so every one of them reads as undersized.

This is the pseudo-element blindness already known for `::before`/`::after` *text*, applied
to hit areas. Acting on it would have changed working code, which is worse than the nothing
a false green produces.

Measure the effective target, and prove it behaviourally:

```js
matchMedia('(pointer: coarse)').matches   // assert FIRST — expansion is absent on a mouse
const after = getComputedStyle(el, '::after');
const r = el.getBoundingClientRect();
const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2 - 20);
const ok = after.minWidth === '44px' && after.minHeight === '44px' && (hit === el || el.contains(hit));
```

20px above centre sits outside a 36px box and inside a 44px one, so `elementFromPoint`
returning the control is proof rather than inference.

Then print the population, not a verdict: *"25 undersized visual boxes, 10 covered by
tap-target, 15 not, 13 of those footer links"* cannot be misread the way a bare count can.
And before prescribing a fix, read what the existing utility says it costs — this one
documents that expanded regions overlap in clusters tighter than 8px, which makes it the
wrong tool for a dense footer.

## Do not switch branches in a clone another session is using

`[measured]` 2026-08-22. I checked out five branches in the music product's main clone over one
session. It was not idle: uncommitted work on `clientIp.ts`, `rateLimiter.ts` and a test
vector file appeared in that tree while I worked, from another session. Uncommitted changes
travel across a checkout, so nothing was lost — but the branch moved under someone else's
feet, repeatedly, with no signal to them.

That repo carries **18 worktrees under `.claude/worktrees/`** precisely so parallel sessions
do not share one tree, and two of the dev servers running during this session were serving
from them. The convention was there and I did not use it.

**So: before checking out anything in a shared clone, run `git status`.** A dirty tree you
did not dirty means someone is in there. Create a worktree instead
(`git worktree add .claude/worktrees/<topic> <branch>`), or do the work in a branch you
never leave. Verification that needs several branches — a batch integration, a PR
comparison — should always be a worktree.

Corollary: a dev server's working directory tells you which tree it serves. Check it before
assuming the app on a port reflects your checkout, and before blaming a port conflict on
yourself.
