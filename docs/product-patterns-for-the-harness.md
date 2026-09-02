# Product patterns worth stealing for the harness

Source: a 2026-09-02 transcript of a "35 digital product ideas" video. It is a
lead magnet for a paid masterclass, and most of it is product advice with no
bearing on this repo. This file keeps only the parts whose LOGIC transfers to
agent tooling, and it says plainly which are already implemented, which are
proposals, and which were rejected.

Nothing here is adopted by being written down. A proposal becomes real when it
has a gate or a rule, not when it has a paragraph.

## Already adopted, recorded so nobody re-proposes them

| pattern from the source | where it already lives |
|---|---|
| Bundle separate things into one purchase | `npm run gate` chains the checks. A gate spread across seven commands is one that gets run partially, which is exactly the 2026-08-30 incident where nine green `npm test` runs never ran `check:suites`. |
| Specificity beats generality | `rule-gate-integrity` §2: print the population, not a bare verdict. A count with no denominator is the generic product nobody can act on. |
| Prove it works before asking for trust | `rule-gate-integrity` §3 and §7: a canary must fire for the RIGHT reason, and precision is triaged on the real corpus before wiring. |
| Cold start: the first wall blocks everything downstream | Documented as a trap: a fresh worktree boots blank until its gitignored env files are copied in, and every check then fails for a reason unrelated to the change. |

## Adopted 2026-09-02

**Sample the input before building the reader.** The source's strongest item is
pre-selling: test whether the thing has a buyer before spending months on it.
The instrument equivalent is testing whether the data has the shape before
building the reader. Landed as `rule-gate-integrity` §9, grounded in a measured
case: 4 real `QUEUE.md` files, 1,488 lines, zero checkboxes, against a control
proving the grep finds a planted one.

## Proposals, NOT adopted, with the objection that would have to be answered

**P1. Skills should hand the runnable command, not the explanation.** The
source's "sell the tool, not the lesson" observes that buyers want the finished
script rather than a lesson on writing one. The harness analogue: a skill that
explains a technique costs a reader the translation step, where one that hands
`node tooling/x.js --flag` does not.

*Objection:* `writing-for-agents` already covers information hierarchy and
completion criteria, and `rule-report-shell` covers command form. This may be
fully covered under different words. Before adding anything, measure it: count
skills whose guidance is prose-only against those carrying a runnable
invocation, and check whether the prose-only ones are prose for a reason.
A rule added on top of adequate coverage is noise that dilutes the rest.

**P2. Ask whether the audience is obsessed rather than large.** The source
argues a small obsessed niche beats a large indifferent one because obsession
is what makes people stay. The analogue for gates: a check firing rarely on
something people care about beats one firing constantly on something they do
not, because the second gets muted and then misses the real thing. That muting
dynamic is already recorded in `rule-gate-integrity` §7 and in the secret-scanner
precision incident.

*Objection:* it may add nothing beyond "a detector at zero precision is worse
than none", which is already written. Kept here because the framing is sharper
than the existing wording, not because the content is new.

**P3. A one-line falsifiable test before any multi-day instrument.** Generalises
§9 past gates to any harness work: before building, name the single command that
would prove the premise false, and run it. Related to `check-assignment.js`,
which already tests a brief's premise with `--expect`, and to
`check-queue-freshness.js`.

*Objection:* possibly just `check-assignment` with a wider remit. Worth checking
whether that script could take the job rather than writing a new rule beside it.

## Rejected, and why, so the reasoning is not re-litigated

- **Verticalise the tool per audience.** Attractive and wrong here. This repo
  ships ONE plugin set to whoever installs it; per-audience forks multiply the
  surface that `check:suites` has to keep honest, and the version number is a
  plugin-cache key that two trees must never share.
- **Bundle to raise perceived value.** Bundling is right for a GATE because
  partial runs are the failure. It is wrong for SKILLS, where the cost is
  context: a skill loads its whole body, and stapling four together bills every
  reader for three they did not need.
- **Every revenue figure in the source.** Unsourced and survivor-selected. No
  number from that transcript should enter this repo as evidence for anything.

## The observation that actually applies here

The source's own premise is that building got cheap, and it then spends one
sentence on distribution. The same asymmetry exists in this repo and points the
other way from where effort usually goes: writing a check is now hours, and the
expensive parts are deciding whether it should exist, proving it can fail, and
keeping it from being muted. `find-orphan-checks.js` exists because checks
nobody runs had already accumulated.

So the harness question is not "what else could we gate" but "which existing
gate is inert, and which finding is nobody reading". §9 is one answer to the
first. The second is unmeasured.
