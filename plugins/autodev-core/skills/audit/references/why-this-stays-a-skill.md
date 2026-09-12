# Why `audit` stays an SOP-in-a-skill rather than a Workflow script

`[measured 2026-08-25]` Historical decision and reported outcome counts follow.
They are retained as evidence of that decision, not a current causal comparison
or permission to skip verification. Revisit using new observations, not
architecture preference.

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
not worth having. For **Project B only**, the recorded rates were 2/165 (1.21%) and 9/48
(18.75%), a ratio of about 15.5. The 288 audit stories combine both projects and
are not the denominator for that comparison. The table leaves two Project A
audit stories, one Project A hand-written story, twelve Project B audit stories
and thirty-nine Project B hand-written stories unclassified; do not infer their
states.

Completion/defer status was written by the workflow being assessed. It does
not independently establish that findings were real or fixes worked; low
deferral can also reflect unquestioned acceptance or a different selection policy.

## What that does and does not establish

It does NOT prove the mechanism is optimal, and two limits are worth stating:

- `deferred` catches a finding somebody rejected. It cannot catch one that was
  silently "fixed" without anybody noticing it was never real, which would land
  in the `true` column and look like success.
- Project A's 11 `false` (9%) are failures, and some of those may be findings
  that turned out not to be actionable rather than fixes that broke.

The bounded observation is that many stories were recorded as done. There is
no independent behavioral sample or alternate implementation measurement here
to establish defect accuracy, successful production outcomes or a causal benefit.

## The decision

The decision then was to retain the skill, not to rewrite it solely because a
graph looked more rigorous. The data above did not measure a replacement’s
cost or benefit. Retain the simplest mechanism that meets the current execution
contract, and fix demonstrated failure modes without requiring a wholesale port.

## What WOULD justify revisiting

Narrow and specific, so this is falsifiable rather than a permanent veto:

1. **The deferred rate on audit stories rising above the hand-written rate.**
   That would warrant inspecting a sample and the reasons for deferral; a
   changed rate alone proves neither noise nor that a verifier node fixes it.
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

**Human triage is a verification step only when it actually occurs.** Brain’s
unattended path cannot assume an absent operator catches missing steps. Before
findings drive changes or completion, require the reproduction, control,
acceptance evidence and actual gate checks named by the current audit and
verification skills; do not grade the result solely from `passes` or a score.

The failure mode to avoid is choosing on aesthetics. A graph looks more rigorous
than prose, and looking rigorous is not the same as producing better findings.
Grade the output before rewriting the mechanism.
