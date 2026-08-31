# AGENTS.md

**Read `CLAUDE.md` first. It is the single source of guidance for this repo.**
This file is not a summary of it and deliberately does not repeat it. Codex
looks for `AGENTS.md`, so this exists to point you at the real document and to
carry the few things that are true only for you.

## Why this is a pointer and not a copy

A copy was tried. It was produced by find-replacing "Claude" with "Codex" across
`CLAUDE.md`, and the replace inverted repo facts: it described this as a Codex
plugin marketplace, which it is not, and told the reader the validator rejects
`~/.Codex`, a string that appears nowhere in `tooling/`. An agent following that
briefing writes the one path the validator refuses.

Two documents saying the same thing means one of them is wrong and nothing
reports which. Read `CLAUDE.md`.

## What is true for you and not written there

- **You start cold.** Every CLI and MCP invocation is a fresh session. You do
  not inherit the caller's context window, its conversation, its memory, or the
  operator's machine-level rules. Only a threaded reply carries context, and
  only within that one thread. If a brief assumes you know something, it is
  wrong; say so rather than inferring.
- **The repo is the only shared channel.** Anything you find that matters must
  be written to a file. A conclusion that exists only in your reply reaches one
  caller once and is then gone.
- **Write incrementally.** Append findings to your output file as you go rather
  than composing one answer at the end, and use a format that survives being cut
  in half. A run that ends early then still leaves work behind.
- **Commit the deliverable as you go if you are able to.** An untracked file has
  no recovery path, so an overwrite is a total loss rather than a diff.
- **A caller's timeout does not stop you.** Your handle dies and you keep
  running. Assume the caller may dispatch again and may not realise you are
  still writing, so never leave a file in a half-written state you would not
  want read.
- **Every claim carries the command that produced it and what it printed.**
  Print the population beside any count. Before reporting that something is
  absent, run a known-positive control and say what it found.

## Scope

Change only what the brief names. This repo ships into other people's sessions:
a hook that throws kills their turn and a hook that prints costs them context on
every prompt, so the blast radius of a careless edit here is other users, not
this machine. `CLAUDE.md` has the specifics.
