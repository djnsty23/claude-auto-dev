# The first production run of the adversarial loop

This file holds the worked example of the first production run: its totals and what the rounds after the first one bought.

Worked example — the first production run, an 8-finding audit of a plugin
repo's own gates, merged as one squashed PR:

| | |
|---|---|
| Rounds to clean | 24 (capped at 5; see the bounding section) |
| Original findings | 8, every one a gate that could return a false verdict |
| Defects in the adversary's own tests | 2, found by mutation-testing them |
| Full gate runs | 14, all green at the commit reviewed |
| Rounds that changed the design | 11 — the shared-tree mutation engine was replaced by a private worktree, net −151 lines |
| Rounds spent on one decision | 5 (20–24), all real, all narrow |

The builder believed the work was done after round 1. What the following 23
rounds bought was not polish: they replaced three successive restore
strategies that each lost a concurrent writer's edit, deleted an entire
lock/nonce/announce protocol in favour of isolation, and established that an
infrastructure failure must never be scoreable as test evidence. Two of them
found defects in the acceptance tests themselves.

The honest cost line beside that: the last five rounds circled a single exit
code, and the loop kept its rigour long after it had stopped buying much.
