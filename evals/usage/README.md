# Usage evals

Replayable cases for the failure classes that `usage-mine.js` ranks highest in this machine's own
Claude Code transcripts. A change to an autodev rule, skill, hook or launcher is measured by whether
the cases it targets turn green and the others stay as they were.

The study behind the ranking, its populations and its limits: [docs/usage-evals.md](../../docs/usage-evals.md).

## Run

```bash
node evals/usage/run.js                      # harness cases against this tree, no tokens
node evals/usage/run.js --repo <other tree>  # the same cases against another checkout
node evals/usage/run.js --replay --model claude-haiku-5-5   # replay cases, spends tokens
node evals/usage/run.js --list
```

Exit 0 every case ran as expected, 1 a case did not, 2 a case could not run or nothing ran.

- `--expect-red <id,...>` inverts named cases, for a planted defect or the old tree in a before/after.
- `--ignore-known-red` grades a known-red case as an ordinary one.
- `--case <id,...>` runs a subset, `--json` prints the results.

## Two kinds of case

| Kind | What runs | Cost | Graded by |
|---|---|---|---|
| harness | The real script, hook or launcher of the tree under test, in a scratch HOME | None | The case's checker module |
| replay | The paraphrased prompt through `claude -p` in a scratch folder with the case's files | Tokens | usage-mine's own extractor over the stream: the class must not exceed `maxEvents`, the done-marker must appear |

A replay case grades the model under the plugins installed on this machine, not the tree under
test, so it measures a rule or skill change only after that change is installed. A harness case
grades the tree.

## knownRed

A case red on `main` for a known reason carries `knownRed.until`, naming the work that fixes it.
It must stay red: when it passes, run.js fails and says the entry is stale, so the fixing change
deletes it in the same commit.

## Adding a case

1. Rank first: `node plugins/autodev-core/scripts/usage-mine.js report --since <date>`.
2. Read real instances before writing a checker. A count is a hypothesis, the cause is in the rows.
3. Paraphrase. A case holds counts and a minimal invented fixture, never transcript text, names,
   paths from a real session or client data.
4. Give the checker a population floor and a control, so an empty or unreached fixture reads as
   could-not-run, not as a pass.
5. Plant the defect and watch the case go red for the reason its detail names.
6. Run `node ~/.claude/scripts/scan-transcript-secrets.js` over `evals/usage` before committing.
