---
name: rule-workflow-spine
description: "The order the other skills run in. Four steps: isolate, build, prove, ship. Each carries the condition that ends it. Load before starting any feature, fix or task, and whenever you are about to pick a skill and cannot tell which one comes first."
when_to_use: "At the start of any unit of work, before the first edit. Also when a session has many candidate skills and no ordering to choose between them."
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash
---

# The spine

A skill library has two failure modes and only one of them is discussed. The
discussed one is a missing skill. The other is **fifty skills and no order**,
where the model picks by description similarity and the pick is a lottery. This
file is the order. It adds no capability; it decides what fires when.

Four steps. Each ends on a condition you can check, not on a feeling that the
step is finished.

## 1. Isolate: before the first edit

Load `isolate`. Work happens in a git worktree branched from the remote default
branch, never in a tree another session is using.

**Ends when** `git branch --show-current` prints something other than the
default branch, and `git status --porcelain` in the new tree is clean.

Skip only when the repo has one working copy and one session in it. A repo
running parallel agents has no exemption: two agents in one tree produce a
collision whose symptom is a lost edit, and a lost edit is not reported by
anything.

## 2. Build: the work itself

No skill owns this step. The repo's own conventions do, plus whichever rule
skills the paths you touch pull in.

**Ends when** the change compiles and the thing you set out to change behaves
differently. Not when it is correct. That is step 3's job, and merging the two
is how a build declares itself proven.

## 3. Prove: evidence, not assertion

Load `prove`. The before state is captured **while the defect still reproduces**,
which is the only moment it is free, and the after state once the change works.

**Ends when** two artifacts exist on disk, they differ, and the difference is
the change you claim to have made.

The trap this prevents: a fix verified only after the fact cannot distinguish
"I fixed it" from "it was never broken the way I described". `rule-diagnosis`
carries the cost of that confusion; this step is what makes it observable.

## 4. Ship: gate, then hand over

Load `commit`, then `ship` if the change deploys. Run the repo's whole gate on a
clean tree, after committing.

**Ends when** the gate is green on the commit you are shipping, and the evidence
from step 3 is in the commit body or the pull request description where a human
reads it, not only in the session that produced it.

A gate run before the last edit graded a tree that no longer exists.

### 4b. An independent read, when the change is worth one

The gate is for the machine and the evidence is for the reviewer. Neither is a
second opinion on whether the change is right.

Load `review` for ordinary work. Load `adversarial-loop` instead when a wrong
fix is expensive: gates, harnesses, security paths, anything that grades other
code. The difference is not thoroughness, it is order. `adversarial-loop` has
the adversary write FAILING tests before any fix, because a reviewer reading a
finished diff cannot see the worst class of defect, a suite that passes without
asserting anything.

**Ends when** every finding has been answered: fixed, or refuted with the reason
written down. Not when a count is low and not when a score is high.

**Never terminate on a score.** A number that a loop optimises toward stops
measuring the thing it was named after, and a reviewer's confidence rating is a
claim about a diff rather than about the code's behaviour. "Loop until it says
5 of 5" trains the loop to satisfy the grader, which is the same failure
`rule-gate-integrity` documents for gates that cannot fail.

Skip it, and say you did, when the change is small, reversible, and covered by a
gate you have mutation-tested. Most changes are. The step exists so that the
ones that are not get a read, rather than every change getting a ritual.

## What the spine is not

**It is not a ceremony for a one-line change.** A typo fix in a repo with one
checkout runs step 2 and step 4. The threshold for steps 1 and 3 is whether
anyone else could be in the tree, and whether the change has a before state
worth showing.

**It is not a substitute for the rules.** `rule-verification` says what counts as
done per task type; `rule-gate-integrity` says whether the gate can fail at all;
`rule-local-first` says where verification happens. The spine only says which
one comes first.

**A step skipped is a step to name.** Saying "no before state, the change is
additive" is a finished step 3. Saying nothing is a skipped one, and from the
outside those look identical.
