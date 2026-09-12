---
name: rule-options-protocol
description: "How to end a turn: a clickable AskUserQuestion panel of vetted, complementary options with a recommendation in every block."
when_to_use: "Before ending a turn that asks the user for direction."
user-invocable: true
allowed-tools: Read, Grep, Glob
---

# Options protocol

A decision panel gathers direction after delivering substantive work. It is not
a permission reset or a reason to stop work the user already authorized. Follow
the user's current preferences and the host's actual question-tool schema.

## Offer work with distinct outcomes

- Offer only concrete next steps that serve the goal and are ready to start.
  Vet their mechanism, prerequisites and relevant costs first.
- Put the recommendation first and label it `(Recommended)`; explain its
  consequence. Do not invent a time estimate to make an option look measured.
- Use one question in the usual case. Two to four useful options are enough;
  do not pad a list to a fixed count.
- Use multi-select for independent, complementary work when the host supports
  it. Use single-select for genuine forks. If multi-select is unavailable,
  use a supported free-text selection or coherent combined option; never send
  an unsupported parameter.
- Do not offer “continue / stop,” a restatement of completed work, or “would you
  like me to proceed.” A real option names what will change.
- The tool supplies a free-text/Other route when its schema says so; do not
  invent a duplicate choice.

## Finish the current work order

A selection persists until delivered or redirected. Report completed, active
and queued items against that selection. New steering reorders the queue; it
does not silently erase it. Complete necessary, authorized work before asking
for a new decision. While work remains, a panel should resolve a real fork or
reprioritize that work, not manufacture a competing backlog.

Honor existing authorization for production, external writes and other scoped
actions. Ask only when a necessary decision or authority is actually missing,
after making the result concrete and reviewable. Silence is not approval.
For optional preferences, use a stated reasonable assumption if no answer arrives
and the host permits continuing. Keep independent work moving.

## Match the current host

Claude Code may expose `AskUserQuestion`; other hosts expose different question
tools, or none. Use the available mechanism and its real limits. Do not call a
Plan-only tool from another mode or pretend a text list is a clickable panel.

Under the standing menu preference, end substantive completed work with the
panel. Skip it for a pure factual answer with no useful next step, or when every
path is blocked on an external action already named. Never invent “reopen” or a
one-option panel to satisfy a ritual.

## Make the answer stand alone

Report the result before the next-step panel. Link every referenced artifact in
the host's supported form: verified web URLs, and clickable absolute local file
paths where the app supports them. Do not attach credentials or signed secrets
to links. The user should not need a tool transcript or collapsed progress
updates to understand what was delivered and what remains.
