# The always-on rules

Twelve skills that load themselves. You never type them, they are not commands, and they are the
main reason this framework behaves differently from a bare session — so they are worth knowing
about even though you never invoke one.

Each is a `rule-*` skill with `user-invocable: false` and a `paths:` glob. Claude Code loads one
when the work matches its glob: styling work pulls `rule-design-system`, anything that proposes a
cause pulls `rule-diagnosis`, marking a task done pulls `rule-verification`. They cost context on
the turns they apply to and nothing on the turns they do not.

**They are not opinions. Every one was written after a specific failure**, and most carry the
measurement that produced them. `rule-ramifications` is derived from 3,127 fix commits across
three production repos. `rule-ab-testing` exists because measurement overturned sixteen
recommendations across two sessions — four of them proposals to build a detector that, once built,
found nothing true.

## What each one is for

| Rule | It stops you from |
|---|---|
| `rule-diagnosis` | Fixing the first plausible cause. A wrong fix costs one cycle; a wrong diagnosis costs every cycle until someone questions the premise. |
| `rule-gate-integrity` | Writing a check that cannot fail — grading a copy of itself, passing on emptiness, a canary that fires for the wrong reason, or a summary line read as a verdict. |
| `rule-ab-testing` | Claiming something is better, cheaper or faster without measuring it against what ships today and one alternative. |
| `rule-verification` | Calling a change done. Defines what "done" requires per task type, plus six checks that apply to everything. |
| `rule-ramifications` | Shipping a change that passes typecheck, build and a clean console and is still wrong. Eight named ways that happens. |
| `rule-agent-concurrency` | Burning a usage window on one fan-out. Caps, model tiers, and never nesting. |
| `rule-security` | Leaking a secret, trusting user input, or shipping a table without row-level security. |
| `rule-design-system` | Hardcoding a colour instead of using a semantic token, and the one case where hardcoding is right. |
| `rule-thumb-first` | Designing from a palette instead of from where the hand is and what each element means. |
| `rule-file-organization` | Writing generated artifacts into the project root instead of under `.claude/`. |
| `rule-options-protocol` | Ending a turn without offering the real next steps. |
| `rule-windows` | Windows-only traps: `cmd /c` for MCP, dev servers in an external terminal, the Supabase CLI firewall workaround. Loads only on Windows. |

## The four worth reading in full

Most are short and mechanical. These four carry worked examples and change how the work is done:

**`rule-diagnosis`** — reproduce before explaining, suspect the frame before inventing a mechanism,
attribute a failure before repairing it. The expensive hypothesis is an exotic mechanism; the cheap
one is that you measured the wrong thing, in the wrong place, or at the wrong time.

**`rule-gate-integrity`** — the four ways a green check means nothing. Its sharpest line is a
production preflight's own retrospective: *a verdict emitted before the work*. Its success line
printed before a single file was opened, so it said the same thing whether the directory held 200
files or did not exist.

**`rule-ab-testing`** — carries a table of sixteen claims that measurement overturned, including
"this gate already exists", "these 66 hits are all false positives", and one case where a fix had
shipped two minutes before the finding declared it missing. Its rule 5 is the one people skip:
**a result of zero is a result, and it needs reading like any other.**

**`rule-ramifications`** — the eight failure classes a passing build does not catch. Read it before
implementing a feature and again before calling it done; it is written to be used twice.

## Adding one

A rule earns its place by citing the failure that produced it. The bar is a real incident with a
measurement, not a preference — a rule nobody can point at an incident for is a style guide, and
style guides get ignored while rules get followed.

Put it at `plugins/autodev-core/skills/rule-<name>/SKILL.md` with `user-invocable: false` and a
`paths:` glob narrow enough that it does not load on turns it cannot help. `npm run validate`
checks the frontmatter; nothing checks whether the rule is *true*, which is why the citation
matters.
