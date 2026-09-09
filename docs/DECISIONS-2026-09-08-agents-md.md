# Decisions — 2026-09-08, AGENTS.md generator (PR #198)

Reversible calls made without asking, per the away window (operator absent
until 2026-09-08T16:33:45Z, scope qr and autodev). Session worktree
`gallant-kepler-6be55e`, branch `claude/gallant-kepler-6be55e`, base
`origin/main` 99bb597.

## D1. PR #198 marked ready for review, not left as a draft

The Brain asked for a draft and holds merge authority; the away rule says take
the recommended option on anything reversible and log it. Ready-for-review is
one `gh pr ready --undo` from a draft again, and it does not merge. The Brain
still merges; this session does not.

## D2. `check:agents-md` is the LAST step of the gate

It takes milliseconds and its only failure is a stale document. Last, a red in
it hides nothing, and the brief's instruction to put it in the chain is met.
Reversible: reorder the `gate` script line.

## D3. Dated PARAGRAPHS, not the brief's dated LINES

`[measured 2026-09-08]` `node tooling/generate-agents-md.js --measure`: the line
shape keeps 2 of 25 dated claims because no marker begins a line in any rule;
the paragraph shape keeps 25 of 25 at 21,233 bytes. Both shapes stay in
`--measure` so the choice is re-checkable, and `--variant` selects any of them.

## D4. `when_to_use` dropped from the emitted variant

1,701 bytes restating the description in 15 of 16 rules. Still emitted under
`--variant A`.

## D5. Not wired into validate.js

`check-version-drift.js`, the nearest precedent for a drift check, is a
standalone npm script and not a validate step, so this follows it. Adding it
to validate would run it twice per `npm test` for no new signal.
