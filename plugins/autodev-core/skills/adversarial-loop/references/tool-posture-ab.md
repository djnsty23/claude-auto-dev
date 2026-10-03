# The tool-posture A/B behind the adversary rules

This file holds the measured comparison that traced an apparent vendor gap between two reviewers to the tools each one was granted.

`[measured 2026-08-31]` The routing table in SKILL.md was first written crediting the
*vendor* for those eight findings. A controlled test the next day does not
support that reading, and the correction is the more useful half.

Same prompt, same unreviewed 214-line authorization gate, neither model having
seen it. The cross-vendor adversary returned 11 findings; an in-house subagent
on the builder's own model returned 10; about 8 were the same defects. The
in-house one additionally caught a **live** false pass the other missed, and
prefixed every finding with "Measured" — it had actually executed the predicate
and run the target's selftest against an empty root. The cross-vendor reviewer
reasoned statically and asserted.

The confound was the operator's: the subagent was given Bash and Read; the
cross-vendor reviewer was given a read-only sandbox. One could verify
empirically and did. **That is tool posture, not vendor judgment**, and it
plausibly explains the entire apparent gap.

So the likely source of the original eight findings is this skill's PROTOCOL
rather than the second vendor: an adversary required to write tests that FAIL
on the defect produces empirical evidence by construction.
