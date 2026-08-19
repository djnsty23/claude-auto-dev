---
name: show-your-work
description: "Keep a reviewable decision trail for work nobody is watching: an unattended or scheduled run, a multi-phase build, a fleet of agents, or anything a human will review after stepping away. Use when starting such work, or when asked to show your work."
when_to_use: "At the START of long or unattended work, not at the end. A trail reconstructed afterwards is a summary, and a summary is exactly what a reviewer cannot check."
allowed-tools: Read, Grep, Glob, Bash
---

# One row per decision

`check:patterns` mines failures after the fact. This captures the choices as they
happen. Both exist for work nobody watched, and they answer different questions:
what went wrong, and why you did it that way.

Adapted from the show-your-work skill in Lauren Tan's Pstack (MIT).

## The format

An append-only TSV at `.claude/reports/decisions-YYYY-MM-DD.tsv`. Tab-separated
because a decision containing a comma is normal and a decision containing a tab
is not.

```
ts	phase	decision	why	evidence	result
```

- **ts** — ISO timestamp.
- **phase** — the stage of work, so rows group.
- **decision** — what you chose, in one line.
- **why** — the reason, in one line.
- **evidence** — the command, file:line, or measurement that supports it. A row
  whose evidence column says "seemed right" is the row a reviewer will delete.
- **result** — what happened. Fill it in when you know; `pending` until then.

**One row is one decision.** If it does not fit one line, the decision is not
crisp yet, and writing it down is how you find that out.

## Rules that keep it worth reading

- **Append only.** A wrong call gets a NEW row that supersedes it, never an
  edit. The superseded row is the most useful row in the file — it shows the
  reviewer where the reasoning turned, which a clean file hides.
- **Prefer evidence a reviewer can re-run.** A committed script beats a
  hand-typed one-off, because the reviewer can run it and get your number.
- **Log the decisions, not the keystrokes.** A row per tool call is a
  transcript, and there is already a transcript. Log where you chose between
  options, where you rejected one, and where you were surprised.
- **Log the rejections.** "Did not add a dedicated hook: 64ms per spawn times
  5,923 Bash calls a day costs more than the class" is worth more than any row
  recording something you did.

## Local by default

The file lives under `.claude/reports/` and stays there. Commit it only when a
reviewer needs the trail to trust the result — a risky migration, an
unsupervised fleet run, anything touching money or auth. Committing every run
turns the log into sediment.

Nothing enforces this and nothing should. A decision log that a hook writes is a
transcript with extra steps; the value is entirely in a judgement about what
counted as a decision.
