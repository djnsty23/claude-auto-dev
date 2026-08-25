# Why `audit` stays an SOP-in-a-skill rather than a Workflow script

`[measured 2026-08-25]` This was evaluated properly and the answer was the
opposite of the expected one. Recording it so the question is not re-opened on
intuition.

## The question

`audit` has the clearest DAG of any skill here: a deterministic size gate, a
fan-out of up to six dimension agents, then aggregate, report and persist. That
is a graph, and it could be rewritten as a Workflow script with a schema contract
per node. The case for doing so looked strong:

- the size gate is **prose**, so nothing enforces the agent count
- there is **no verifier node**, and a model is poor at checking its own work
- per-dimension output is free-form, so aggregation is the model re-reading prose

## What the outcome data says

The skill version has a real track record, so it can be graded on results rather
than on how tidy its mechanism looks. Across two mature product repos, reading
`passes` out of each one's `prd.json`:

| | audit-generated | hand-generated |
|---|---|---|
| Project A | 123 stories, 110 done (89%), 11 failed, 0 deferred | 41 stories, 40 done |
| Project B | 165 stories, 151 done (92%), 2 deferred (1.2%) | 48 stories, 9 deferred (18.8%) |

`deferred` is the load-bearing column. It means somebody looked at the story and
decided not to do it, so it is the closest available proxy for a finding that was
not worth having. **Audit findings are deferred 15x less often than hand-written
work** (1.2% against 18.8%), on a population of 288 audit stories.

A missing verifier node should show up as noise that people decline to act on.
It does not. The findings get done.

## What that does and does not establish

It does NOT prove the mechanism is optimal, and two limits are worth stating:

- `deferred` catches a finding somebody rejected. It cannot catch one that was
  silently "fixed" without anybody noticing it was never real, which would land
  in the `true` column and look like success.
- Project A's 11 `false` (9%) are failures, and some of those may be findings
  that turned out not to be actionable rather than fixes that broke.

So the honest claim is bounded: on the evidence available, the output is
actionable at a high rate, and the theoretical weaknesses above are not showing
up as measurable harm.

## The decision

**Do not port `audit`.** Rewriting a mechanism that produces an 89-92%
completion rate, to fix defects the outcome data does not show, is optimising
something that is not broken. The cost is real, since a Workflow run spawns
agents at up to six per wave, and the measured benefit is zero.

## What WOULD justify revisiting

Narrow and specific, so this is falsifiable rather than a permanent veto:

1. **The deferred rate on audit stories rising above the hand-written rate.**
   That would mean findings have started being noise, which is exactly what a
   verifier node fixes. Re-measure from `prd.json` rather than from impression.
2. **A dimension whose output is consumed by code**, not by a person. A schema
   contract earns its place the moment something downstream has to parse the
   finding, because free-form prose stops being adequate there.
3. **Evidence that the size gate is being ignored in a way that costs money.**
   This was NOT established here. The obvious probe counts string mentions in a
   transcript rather than actual tool calls, so a session that merely READ this
   skill file scores as though it had launched agents. A clean test needs the
   structured tool-call records, not a grep.

## The generalisable half

The two mechanisms are not ranked. They answer different questions.

**Code-as-graph earns its place where the EDGES must be enforced**: where a
skipped step is silent, where a downstream consumer parses the output, or where
the fan-out width has a cost somebody is paying.

**SOP-in-a-skill is adequate where a person reads the output and would notice a
missing step.** `audit` is that case. Its product is a list a human triages, and
a human triaging is itself the verifier the graph appears to lack.

The failure mode to avoid is choosing on aesthetics. A graph looks more rigorous
than prose, and looking rigorous is not the same as producing better findings.
Grade the output before rewriting the mechanism.
