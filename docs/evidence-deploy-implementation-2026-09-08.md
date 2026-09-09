# Form B, implemented: the deploy ledger becomes the authorisation

Dated 2026-09-08. This is the **implementation** record. The baseline — how
deploys happen today, the sample of 20 production deployments, the incidents, and
the three sentences measured side by side — is a different session's work and
lives in `docs/evidence-deploy-authorisation-2026-09-08.md`, merged on
2026-09-08 via #201. That file is deliberately not touched here: two sessions
were briefed to write it, and the one that measured it owns it. This file closes
the "still open" that entry names — the ledger row format and the check over it.

## The choice, and its provenance

`[stated 2026-09-08]` the operator chose Form B. The sentence, as recorded on
the now-merged #201, which owns it:

> A session may promote to production when the repo's named gate exits 0 on the
> exact commit being deployed, that commit is on the default branch, the deploy
> ledger records the commit, the gate's output and the post-deploy verification,
> and the rollback command for this deploy is written into the ledger before the
> promotion. A deploy that touches anything on the ineligible list is escalated
> whatever the gate says.

**Ineligible regardless:** migrations that drop or rename a column, change a
grant, an RLS policy or a `SECURITY DEFINER` function; billing, checkout, webhook
and entitlement code; auth; anything the Brain's never-list covers; anything
touching live rows.

**Provenance is #201's to state, and its account is the one to read**, now merged
in `docs/decisions.md` and in full in
`docs/DECISIONS-2026-09-08-deploy-authorisation.md`: the panel was self-resolved
by the away hook and logged as BLOCKED, a coordinator then relayed the answer
from another session and that was refused as a relay, and only the operator's
direct answer with the away state absent is authority. An earlier draft of this
file called the relay a second first-hand record and treated the two as
independent corroboration. That was wrong on the point #201 spent three tries
establishing, and it is corrected here rather than left to compete.

What this session has first-hand is the operator's own words in it — *"Form B,
[stated 2026-09-08]: pre-authorised on a green gate with the ledger"* — which is
the same third channel, not a fourth.

The sentence names no repo, port or target, so it ships in the public repo whole
and nothing goes to the machine-local rules directory.

## What enforces each clause

| clause | enforced by | exit when unmet |
|---|---|---|
| the named gate exits 0 | `gate`, `gate exit`, `gate tail` fields, filled by whoever ran it | 1 |
| on the **exact** commit | `commit` derived at `--write`, re-checked against HEAD at `--verify` | 1, named STALE with both shas |
| on the default branch | `merge-base --is-ancestor` against `origin/HEAD`, then conventional names | 1, naming the branch |
| ledger records commit, gate output, verification | the seven-field promotion record | 1, each missing field named |
| rollback written **before** promotion | `rollback` field, required by the same `--verify` that gates the promote | 1, also when it still holds a `<placeholder>` |
| ineligible list escalates regardless | project-marked globs + six SQL rules, checked **before** any field | 3 |

`--verify` exits 0 with zero bytes on both streams, because it runs as
`--verify && <promote>` and text on the pass path is skimmed rather than read.
Exit 2 is blind — no ledger, no deploy ref, no resolvable default branch, or a
project that has not marked its deploy-sensitive paths — and blind is never a
pass.

## The gate's output is recorded, not queried

Nothing here asks a forge whether CI was green. That is a decision, not an
omission. `[measured 2026-09-08]` one commit carried nine check-run entries
across three rounds — one complete green round plus in-progress duplicates from
re-runs — and a count of "conclusion != success" returned 1, which reads as a
failure and was an unfinished re-run. The count conflates failed, still running
and superseded. Any future CI reader in this script must group by job name and
require at least one `status=completed, conclusion=success` per required
platform, and must never read the run rollup, which reports success while a job
is still `in_progress`. That note is in the script's header where the next person
to reach for `gh api` will read it.

## The SQL rules, measured

Six rules, one per clause of the operator's list, over added lines in `*.sql`
with comments stripped. Run against a product repo's migrations, using the real
expressions required from the script rather than a paraphrase:

```
[corpus] 33 migration file(s), 4427 line(s), 195 ineligible line(s)
  grant: 98
  rls: 37
  security-definer: 35
  live-rows: 25
[corpus] narrow schema-drop rule alone: 0 hit(s)
[control] planted 6, detected 6
```

Nearly every migration in that repo is now ineligible. That is the intended
reading of the list rather than a defect in the rules — migrations are the class
the operator named first — and it means a window containing any migration
escalates, while a project marking `supabase/migrations/**` deploy-sensitive is
belt-and-braces rather than the load-bearing part.

### The reversal worth recording

An earlier draft of this script, written before the ineligible list was known,
measured the same corpus and found 41 DROP statements of which 12 were `DROP
POLICY` always followed by a `CREATE POLICY` in the same file. It concluded a
policy drop is a recreate pattern rather than a risk, and **pinned `DROP POLICY`
as an ELIGIBLE case in its own selftest and suite.** The operator's list says the
opposite.

The measurement was right about the syntax and wrong about the question. *"Does
this file put the policy back"* is not *"is the policy it puts back the same
policy"*, and a recreate is exactly where an RLS mistake hides; the incident
behind that clause is a real RLS leak. Both assertions are now reversed, and the
suite's case says in as many words that it is deliberately the reverse of what
the first suite asserted — otherwise the next reader finds a flipped assertion
and assumes a mistake.

## The guard was watched blocking something

`rule-gate-integrity`'s standing demand, and the coordinator's: a guard nobody
has seen refuse is decoration. `vercel rollback` has been recorded zero times in
any repo and the ledger has zero uses, so there is no existing usage to
pattern-match against. Every refusal below is asserted by exit code **and** by
the line naming the reason, because 1, 2 and 3 are three different instructions
and "non-zero" cannot tell an unmarked project from a red gate:

- unmarked project → 2, naming the heading to add and the `none` escape
- ledger absent → 2
- commit moved after `--write` → 1, STALE, both shas
- commit not on the default branch → 1, naming the branch, **with the control**
  that returning to the default branch stops the report
- every field empty → 1, all seven named
- each single defect alone → 1 on its own field: a missing `after.*` in the
  evidence directory, `gate exit: 1`, a `<placeholder>` rollback, an
  authorisation with no `[stated date]`
- each of the six SQL clauses → 3, naming the rule id, file and statement
- a deploy-sensitive path → 3, naming the glob and the file it came from
- a window that is genuinely fine → 0, zero bytes

The eligible controls matter as much as the refusals: additive DDL (`CREATE
INDEX`, `ADD COLUMN`) and the comment containing the word "truncated" must pass,
or "ineligible" would prove only that the rules fire on everything.

## Two defects the suite found before this shipped

1. `--write` preserved the previous ledger's `commit` along with the other filled
   fields, so a regenerate after HEAD moved produced a ledger stale by its own
   hand. The commit is derived and is now never kept.
2. `--write` preserved filled fields by name regardless of window, so after a
   promotion was filed the next window inherited the previous gate tail, evidence
   and authorisation, and `--verify` passed a window nobody had gated. The header
   now carries the window's base commit and a regenerate for a different base
   starts blank and says so.

A third was found by the suite's own zero-bytes assertion while the default-branch
check was being added: `execFileSync` sends a child's stderr to the parent's by
default, and probing `origin/main` in a repo with no remote is a legitimate miss,
so two `fatal: Needed a single revision` lines leaked onto a run required to print
nothing. `git()` now pipes stderr.

## Files changed

| file | change |
|---|---|
| `plugins/autodev-core/scripts/deploy-ledger.js` | promotion record; four exit codes; default-branch containment; six SQL rules; marking read from CLAUDE.md following `@` imports one level; `--record`; `--audit`; `--help` |
| `tooling/test-deploy-ledger.js` | rewritten, subprocess-driven, 54 assertions |
| `plugins/autodev-core/skills/ship/SKILL.md` | Step 4 carries the sentence; promotion commands become `--verify && <promote>` then `--record`, via `${CLAUDE_PLUGIN_ROOT}`; Step 5b rewritten; Step 6 points at the recorded rollback |
| `plugins/autodev-core/skills/auto/SKILL.md` | Auto-Deploy rows gated the same way; exit 3 marks a story `needs-setup` |
| `plugins/autodev-core/skills/brain/SKILL.md` | standing rule, the ineligible list, and that neither half may arrive by relay |
| `docs/decisions.md` | entry, newest first |

**Suite counts.** `--selftest` 61 cases, 61 passed. `tooling/test-deploy-ledger.js`
54 assertions, 54 passed. Gate counts are in the PR body, from the run on the
committed tree.

## Not done

- **No canary, no autonomous rollback, no timed production check.** Those are
  Form C, and Form B was chosen.
- **No production deploy, promotion or rollback ran** from this session on any
  repo. Product repos were read only; the corpus above was measured read-only.
- **No VERSION bump.** Nothing here reaches an installed plugin until a release,
  and that release must re-read `VERSION` immediately before `node
  tooling/bump.js` — two trees sharing a version number is how a build missing
  one session's change was reported as current.
- **No product repo was marked.** Each needs its own `## Deploy-sensitive paths`
  section before `--verify` returns anything but exit 2 there. That first
  refusal is the intended first contact with this rule.
