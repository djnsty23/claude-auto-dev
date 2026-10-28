# Harness2 adoption A/B: preregistered before any trial ran (2026-10-28)

Subject: headless Opus 5.5, effort medium, Andy's user rules loaded (`--setting-sources user`),
no tools, no MCP, cwd outside any repo. 116 trials. Arm A is today's harness text.

| Exp | Mechanism | Arms | Trials | Primary metric |
|---|---|---|---|---|
| E1 | H2 blind selection | A labelled, C labelled + ordered criteria, B blind + baseline note + criteria | 10 cases x 3 arms x 2 orders | correct picks of 20; order flips |
| E2 | H1 lesson schema | A current lessons text, B + "Writing a new entry" | 8 cases x 2 arms x 2 reps | over-attribution on 4 confounded cases (of 8 trials); correct attribution on 4 clean cases |
| E4 | H4 placement ladder | A current "Learn" line, B + "Where the lesson goes" | 6 cases x 2 arms x 2 reps | correct home of 12; always-on bytes added, net of cuts |

## Adoption criteria

- E1: adopt H2 if B beats A by at least 2 correct picks of 20 and does not lose to C. B vs C
  isolates anonymity, C vs A isolates the criteria. A tie keeps the skill as it is.
- E2: adopt H1 if B over-attributes at least 2 fewer times of 8 than A, and loses at most 1
  correct clean attribution of 8.
- E4: adopt H4 if B places at least 2 more of 12 correctly, or adds at least 30% fewer net
  always-on bytes with accuracy not lower.
- H3 (duplicate-label budget check) is graded by reading code, not by trials.

## Amendment, after E1 scored 20/20 in all three arms (before any E1H trial ran)

E1 could not discriminate: its defects are ones Andy's always-on rules name. E1H adds 8 harder
cases (5 keep-current, 3 adopt), each worse proposal carrying a persuasive comment, x 3 arms x 2
orders = 48 trials. Same E1 criterion: B must beat A by at least 2 of 16 and not lose to C. This is
the one bounded extra round. If E1H also ties, H2 is not adopted.

## Amendment 2, after E2 and E4 scored (before any E2C trial ran)

E2 tied on attribution (16/16 both). Exploratory, not preregistered: by hand reading, arm A
proposed a new always-on rule line in 6 of 16 trials and arm B in 0 of 16. E2C tests that on 6
fresh incidents (3 clean, 3 confounded) x 2 arms x 2 reps = 24 trials, with a machine-read
`RULE_LINE:` field added to both arms.

- Adopt H1 if B adds an always-on line in at least 3 fewer trials of 12 than A, B's correct
  attributions are at most 1 below A's, and B writes an entry (not NO_ENTRY) on every clean trial.
- E4 (9 vs 8 of 12) did not meet its bar. H4 is not adopted and gets no extra round. Its
  `never-print-secret` case was defective (security.md already holds that rule, so "none" is
  defensible), which is recorded rather than re-scored.

Small samples: every result is reported as raw counts, with a Fisher exact p where it applies.
