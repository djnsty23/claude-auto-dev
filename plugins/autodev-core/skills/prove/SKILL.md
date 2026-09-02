---
name: prove
description: "Capture the BEFORE state while the defect still reproduces, then the AFTER state once the change works, and put both where a human reviewer sees them. Use at the start of any fix, before the first edit, and again once it works. Also when a reviewer would have to take your word for a change."
when_to_use: "Invoked when the user says \"prove\", and automatically as step 3 of the spine: once before editing a defect, once after the change works."
allowed-tools: Bash, Read, Write, Grep, Glob, mcp__Claude_Browser__*
model: opus
user-invocable: true
argument-hint: "[before <slug> | after <slug>]"
---

# Prove

Two captures of the same observable, taken at the two moments that make them
comparable. Everything else here is detail.

**The before capture happens while the defect still reproduces.** That is the
only moment it costs nothing, and it is gone the instant you start editing. A
session that fixes first and captures second cannot tell "I fixed it" from
"it was never broken in the way I described", because both produce one green
screenshot.

## Where it goes

`.claude/evidence/<slug>/` holds `before.png`, `after.png` for visual work;
`before.txt`, `after.txt` for numbers or output.

**Not `.claude/screenshots/`.** That directory is gitignored and documented as
cleaned each run, so a before state stored there is destroyed by the run that
produces the after state. `.claude/` is deliberately not ignored wholesale, so
`.claude/evidence/` is tracked and survives.

**Tracked means commit it WITH the change, not beside it.** Left uncommitted the
evidence dirties the tree, and any gate that refuses a dirty tree then refuses
to run at all, which is a self-inflicted block right at the step that needs the
gate green. Same commit as the code is also where a reviewer wants it.

## Step 1: before, and it is a probe

```bash
mkdir -p .claude/evidence/<slug>
```

Reproduce the defect, then capture. Which observable depends on the change:

| Change has | Capture |
|---|---|
| A visible surface | Screenshot at the viewport the bug appears at. Assert `innerWidth`/`innerHeight` in the same call, or the rect you measured is against a zero-height window |
| A number that moves | The number, with the command that produced it and the population it counted |
| Output that changes shape | The output pair, byte for byte |
| No before state (purely additive) | Write `before.txt` saying so, in one line |

**If the defect does not reproduce, stop.** An empty before capture is not a
minor inconvenience, it is the finding: you are about to fix something you have
not observed. Load `rule-diagnosis` rather than editing.

## Step 2: after, once the change works

Same observable, same viewport, same command, same population. A pair taken two
different ways compares two different things and proves nothing.

Then check the pair actually differs:

```bash
ls -l .claude/evidence/<slug>/
cmp -s .claude/evidence/<slug>/before.png .claude/evidence/<slug>/after.png && echo "IDENTICAL: the capture did not observe the change"
```

Two byte-identical captures mean the probe was blind, not that the change was
subtle. Find what you failed to observe before reporting anything.

## Step 3: put it where a reviewer reads it

The evidence is worthless in the session that produced it. It has to reach the
person deciding whether to merge.

- **Commit body** is the default, and the only one that works with commits that
  stay local. Name the paths and state what changed between them in one line.
- **Pull request body**, when one is opened. A relative path does not reliably
  render there; after the branch is pushed, reference the raw URL:
  `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/.claude/evidence/<slug>/after.png`

Write the delta in words beside the images. A reviewer scanning two screenshots
should not have to find the difference themselves, and a difference you cannot
state in a sentence is one you have not checked.

## What this does not do

It does not replace the gate. Evidence is for the human; the gate is for the
machine, and `rule-gate-integrity` covers whether that gate can fail at all. A
change with a beautiful before/after pair and a red gate is not shippable.
