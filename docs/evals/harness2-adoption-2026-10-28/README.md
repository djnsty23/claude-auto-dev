# Harness2 adoption A/B (2026-10-28)

Four mechanisms from google-research/harness2 were measured against today's harness text before
any adoption. None met its preregistered bar, so no skill or rule changed.
Criteria and both amendments are in [PREREGISTRATION.md](PREREGISTRATION.md). Raw metrics are in [scores.json](scores.json).

| Code | Mechanism | Landing site it would have taken |
|---|---|---|
| H1 | Reflector entry schema: per-change verdict, `confounded`, at most one lesson or NO_ENTRY | lessons skill, "Writing a new entry" |
| H2 | Blind selection: anonymous X/Y, baseline in the pool, ordered criteria, both orders | `rule-ab-testing` |
| H3 | Budget identity with duplicate labels checked before counts | `tooling/coverage-receipt.js` |
| H4 | Placement ladder: script, skill, hook, always-on, none | lessons skill, "Where the lesson goes" |

## Results

Subject: headless Opus 5.5, effort medium, user rules loaded, no tools, no MCP. 188 trials, 0
failed, $25.53 total.

| Exp | Arms | Primary result | Bar met |
|---|---|---|---|
| E1 (H2) | A labelled / C criteria / B blind | 20/20, 20/20, 20/20, 0 order flips, p=1 | No, tie |
| E1H (H2, harder) | A / C / B | 16/16, 16/16, 16/16, p=1 | No, tie |
| E2 (H1) | A / B | attribution 16/16 both, over-attribution 0 vs 0, p=1 | No, tie |
| E2C (H1 confirmation) | A / B | attribution 12/12 both, always-on rule lines 0 vs 0 | No, the E2 signal did not replicate |
| E4 (H4) | A / B | correct home 8/12 vs 9/12, always-on bytes added 0 vs 0, p=1 | No, +1 against a bar of +2 |
| H3 | code plant | 6/6 planted duplicate-label receipts graded as expected | Already covered, no change |

## Reading

- Every discriminating fixture hit the ceiling in arm A. The current always-on rules already name
  the defects these mechanisms guard against, so the probe could not separate the arms.
- H1 changed behaviour without changing correctness. Arm B wrote NO_ENTRY on 5 of 6 confounded
  E2C trials against 0 of 6 in arm A. That is restraint, not a measured accuracy gain.
- The E2 exploratory signal (A proposed always-on rule lines in 6 of 16 trials, B in 0) vanished
  once both arms had an explicit `RULE_LINE:` field. The field itself likely primed restraint.
- Arm B was terser in E1 (11.8k vs 15.4k output tokens) and E1H (10.7k vs 13.3k). Too small to adopt on.
- E4's `never-print-secret` fixture was defective: `security.md` already holds that rule, so
  "none" is defensible. It is recorded, not re-scored.

## Rerun

```bash
CLAUDE_EXE=/path/to/claude.exe node docs/evals/harness2-adoption-2026-10-28/run-ab.js
node docs/evals/harness2-adoption-2026-10-28/score.js
node docs/evals/harness2-adoption-2026-10-28/h3-plant.js
```

`run-ab.js` is resumable and writes `runs/` beside itself. Pass `E1H` or `E2C` to run one round,
or `--dump` to print sample prompts and the trial count without calling the model.
