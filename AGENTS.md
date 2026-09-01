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
- **Give your deliverable a recovery path.** An untracked file has none, so an
  overwrite is total loss rather than a diff. Repo content: commit it to the
  working branch as it grows, locally, and leave pushing to the caller. An
  audit report belongs under `.claude/reports/`, which is gitignored here on
  purpose; there the recovery path is appending every round, not a commit.
- **A caller's timeout may not stop you.** Its handle dies whether or not you
  do. Assume the caller may dispatch again without realising you are still
  writing, so never leave a file in a half-written state you would not want
  read, and clean up anything you planted.
- **Every claim carries the command that produced it and what it printed.**
  Print the population beside any count. Before reporting that something is
  absent, run a known-positive control and say what it found.
- **Starting cold is not starting empty, and the difference is whose context.**
  `[measured 2026-09-01]` `codex debug prompt-input` renders 44,220 bytes of
  model-visible input on the operator's machine, carrying `AGENTS.md`, skills
  and plugin instructions. So you arrive with your own briefing and none of the
  caller's. Do not report that you received no instructions; report which ones
  you received, since the caller usually cannot see them.
- **Your sandbox may be wider than the brief implies.** A call that omits a
  sandbox setting inherits `~/.codex/config.toml`, where the operator's default
  may be `danger-full-access`. Read your session header rather than assuming the
  brief's tone constrains you, and hold to the cleanup obligation above: write
  only where the brief says, and remove anything you planted.

## Working on the Codex integration itself

`docs/codex-channels.md` holds what has been measured about the three channels
that reach you, and it is where a new measurement belongs. It is written for the
caller choosing a channel rather than for you, so most of it will not change how
you work. Two parts do, and both are above.

Read it before changing `tooling/review-diff.js` or anything else that shells
out to the CLI: it records constraints that cost real time to find, including
that `codex exec review` rejects the prompt argument its own usage string
advertises.

## Scope

Change only what the brief names. This repo ships into other people's sessions:
a hook that throws kills their turn and a hook that prints costs them context on
every prompt, so the blast radius of a careless edit here is other users, not
this machine. `CLAUDE.md` has the specifics.
