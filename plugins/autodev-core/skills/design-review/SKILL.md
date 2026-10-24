---
name: design-review
description: "Review the screens a user works through from rendered evidence: real content, every modal and state, narrow and wide viewports, and whether the task gets done. Use when a page or flow looks off, when asked to rate or bug-hunt screens, and before saying a UI change is done."
when_to_use: "Invoked when the user says \"design review\", \"review the UI\", \"rate the pages\", \"bug hunt\", \"tested on mobile\", \"check it on mobile\", \"the layout could be better\" or \"looks off\", when a UI fix has been claimed and the screen has not been looked at since the last edit, and before closing any visual or interaction defect."
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
user-invocable: true
argument-hint: "[workflow or existing review.json]"
---

# Design review loop

Define, measure, diagnose, improve, verify and retain. Start with one workflow.
Use `design` for product-specific craft, `unslop` for rendered layout collection,
`a11y` for accessibility, `audit` for confirmed implementation issues and `prove`
for before/after evidence. This skill adds a review contract and evidence ledger,
not another browser runner, global aesthetic, score or deployment authority.

## Define

Record the audience, primary task, product's actual brand rules, approved
references and authority for changes. Read its tokens and existing components.
Do not adopt another product's identity. References without explicit approval
remain unapproved. Set calibration to `unavailable` or `pending` until actual
examples and owner judgments exist. A model's preference is not calibration.

Read `${CLAUDE_SKILL_DIR}/references/criteria.json`: 27 criteria across
measurable defects, subjective judgment and real task usability. Each declares
applicability, evidence expectations, default severity and completion condition.
Increase this set only for an actual escaped defect that the existing criteria
cannot represent, with a reproducible control where feasible. `generic-tells`
was added that way: agent-built sites kept shipping the same template look and
nothing graded it before publish.

Read `${CLAUDE_SKILL_DIR}/references/record-format.md` to create a definition.
Declare cases BEFORE capture: route, viewport, role, realistic data and state.
Include long content, missing values, loading, failure/retry, narrow screens,
wide screens (1440 and 1920, where sibling sections must share edges), every
modal with its primary action tapped at phone width, and the useful outcome. Define acceptance checks from requirements, not observations.
Generate the ledger using the shipped CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/design-review.js" init definition.json > review.json
```

Every criterion × case is expected even if someone deletes template rows. An
untested or unsupported check is `unknown`. Non-applicability needs a specific
rationale. Do not use it to conceal missing tooling or work. Default severity is
a triage starting point. Record the actual user impact when ordering fixes.

## Measure

Use the current host's browser driver or `unslop-sweep.js` on an owned local
candidate. Reuse its captures and findings. Retain exact route/viewport/user/data
state and browser/build identity. View screenshots, operate controls and inspect
resulting state. Do not treat a screenshot as a successful interaction.

Fill structured evidence records with expected and observed values. Keep raw
captures and hash references beside the review. For objective checks, attach a
measurement artifact. For usability, an interaction artifact. Existing
`flow-evidence.js` checks can supply interaction evidence, but the scoped ledger
record must still bind its assertions to this case and exact candidate identity.
If adapting a collector's output, preserve its unmeasured fields as unknown.

For subjective criteria record screenshot, reviewer, concern/acceptable judgment,
rationale, impact and a plausible alternative interpretation. Separate observed
choices from inferred intent. Even unanimous positive model reviews remain
advisory. One restrained palette or one card is not a defect by itself. Template
tells are measured, not argued: see the next section.

### Generic template tells

`generic-tells` is measured by the pinned `impeccable detect` (deterministic, no
model) through the shipped probe. Give it the case route URL or the built source
directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/impeccable-probe.js" <url-or-dir> --case <caseId> --revision <revision> --out generic-tells.json
```

Exit 0 is clean, 1 is findings and 2 is indeterminate: npx absent, impeccable
failed, output unparseable, or a local target with no scannable file. An
indeterminate scan writes no artifact, so the row stays `unknown`. Declare the
acceptance exactly as the probe writes it:
`"generic-tells": [{"name":"impeccable slop findings","operator":"lte","expected":0}]`.
It flags purple gradients, overused fonts, nested cards, cream palettes and
buzzword copy among others. A zero does not clear what it missed on a page, such
as bounce easing: record that as its own measurement. A finding the owner keeps
on purpose is a recorded brand rule in the definition, not a silent pass.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/design-review.js" check review.json
```

Exit 0 means complete recorded scoped checks, not excellent design or business
success. Exit 1 means a verified failure. Exit 2 means incomplete evidence.
Hashes and contract binding catch accidental stale or modified inputs. They
cannot authenticate a dishonest collector or prove an assertion is well chosen.

## Diagnose and improve

Group findings by shared component or layout cause. Record the observation,
reproduction, competing hypotheses, affected routes/states and evidence supporting
the cause in `diagnoses`. Fix the highest task impact first in small `batches`.
Preserve product-specific identity and supported states. For comparison cards,
measure equivalent categories and actions across siblings. Use shared tracks
where appropriate instead of hiding wrapped text behind guessed fixed heights.

Compare the present implementation and a plausible alternative on the same data.
Do not recommend a redesign from taste alone. Subjective experiments stay within
the authorized scope and require owner calibration before becoming a house rule.

## Verify and retain

Capture after evidence using the same cases and acceptance checks, with a new
exact revision/build identity. Rerun affected interactions and neighboring flows.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/design-review.js" compare before/review.json after/review.json
```

Changed contracts/cases, lost coverage or unknowns prevent `improved`. The report
still lists resolved failures. New verified failures or newly raised subjective
concerns are regressions to investigate. A lower total issue count cannot hide
a failure on another case. `improved` does not mean every existing issue is fixed.
Read `remainingFailures`. There is no aggregate aesthetic score.

Keep useful checks in the project's actual test path and record their command,
scope and evidence in `retainedChecks`. Keep sanitized portable proof tracked.
Private screenshots and raw reports stay local under the project's retention
policy. Do not delete the baseline while it supports an active conclusion.

Record `outcomes` with population, period and provenance: owner-caught misses,
manual rework minutes, task attempts/completions and review effort/cost. Unknown
is null. Do not infer zero misses from silence or revenue impact from better UI.
Use `${CLAUDE_SKILL_DIR}/references/validation-plan.md` for the next validation stage.
