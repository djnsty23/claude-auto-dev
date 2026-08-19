---
name: wizard
description: "Work is blocked on something only the user can do: choosing a browser or account, clicking a dashboard toggle, entering a credential, approving a grant, plugging in a device. Load the moment an error names a human decision, before retrying it."
when_to_use: "The moment a tool error names a decision, a permission, or a credential rather than a fault. Do not load it after the second identical retry — by then it has already cost what it exists to save."
allowed-tools: Read, Grep, Glob, Bash
---

# Hand the work back cleanly

Some steps are not yours to take. When one appears, the failure mode is not
getting it wrong — it is not noticing, and retrying instead.

## The measurement this exists for

2026-08-19, one session on this machine: a browser call returned *"Multiple
Chrome browsers are connected to this account and none has been selected. Before
any browser action, you MUST call the AskUserQuestion tool."* The session retried
browser calls against that message from **10:14 to 12:24** — two hours and ten
minutes — and never asked. The error had named the remedy in its own text.

That is the whole class. The message is accurate, it names a human, and every
retry fails identically because nothing about the situation changed.

## Recognise it

You are blocked on a human when any of these is true:

- The error names a **choice** ("none has been selected", "multiple accounts").
- It names a **permission or grant** you cannot issue yourself.
- It asks for a **credential**. You must never enter one anyway — see below.
- It requires a **physical or out-of-band act**: plug in a device, click a link
  in an email, approve a push notification, flip a setting in a console you have
  no API for.
- The identical call has failed twice with byte-identical output. Two is the
  signal; there is no information in a third.

Distinguish it from a hang or a flake. A frozen renderer, a timeout, a 502 — those
are worth one retry. A decision is not.

## Stop, then write the steps

**Stop the retry loop first.** Not after one more attempt.

Then write the handback. It goes in the message to the user, not in a file they
have to find. Every step must be executable by someone who has not read the
transcript and does not know what you were doing:

1. **Number the steps and keep them atomic.** One action per line. If a step has
   an "and" in it, it is two steps.
2. **Give the exact target.** The full URL, the settings path as it is labelled
   in that UI, the device name. Never "the browser settings" — say which menu.
   A link the user can click beats a description of where to find it.
3. **Say what done looks like.** "The dropdown shows exactly one profile" is
   checkable. "Configure the browser" is not.
4. **Say how long it takes.** A user deciding whether to do it now needs that.
5. **Flag anything irreversible** before the step, not after.

## Then say what happens next

A handback that ends at the last step is half a handback. Close with:

- **What you will do when they confirm** — the exact next call, so they can see
  the work resumes rather than restarts.
- **What you are doing meanwhile.** Blocked on one thing is rarely blocked on
  everything. Name the work you are continuing, or say plainly that this blocks
  the rest and why.
- **What you already tried**, in one line. Not a log — enough that they do not
  repeat it.

## Never ask for these

- **A secret in the chat.** No API keys, tokens, passwords, or connection
  strings, even when the user offers. They go to the clipboard, the environment
  editor, or the secret manager. Ask them to put it there and tell you the NAME.
- **Something you can do yourself.** Check first. A handback for work you could
  have finished is the ritual this skill is meant to prevent, and it trains the
  user to skim these.
- **A decision you should be making.** If it is reversible, in scope, and
  obvious, do it and say you did.

## When the blocked step is a credential, write a throwaway script

Asking the user to paste a secret is forbidden, but "put it in Doppler and tell
me the name" is not always enough either: a multi-value setup is tedious by hand
and more tedious to re-explain every time.

Borrowed from Matt Pocock's wizard skill (github.com/mattpocock/skills, MIT),
which solves the adjacent problem of scripted setup procedures. Two of its rules
are worth taking whole:

- **Open the URL before asking for the value.** The script prints the exact
  console page, waits, and only then prompts. A prompt with no page in front of
  it is a puzzle.
- **Read secrets with a silent local prompt** and write them straight to their
  destination. The value never enters the transcript, so this is strictly better
  than asking for it in chat, not merely permitted.

```bash
read -rsp "Paste the key from the page just opened: " VALUE; echo
doppler secrets set MY_KEY="$VALUE" --project app-x --config prd >/dev/null
echo "stored as MY_KEY; not printed here"
```

Write it to the scratchpad, tell the user the one command to run, and delete it
afterwards. Verify by reading the NAME back, never the value.

## The shape, compressed

> Blocked: Chrome has three profiles connected and none is selected, so every
> browser call fails the same way. I stopped after the second identical error.
>
> 1. Open the Claude extension in the Chrome window you want me to drive (~10s).
> 2. Confirm the extension header shows that profile name.
> 3. Reply "ready".
>
> Then I re-run the consent-banner check on the staging URL and carry on. While
> waiting I am finishing the SPA-navigation diff, which needs no browser.

Three lines of steps, a resume plan, and parallel work named. That is the format.
