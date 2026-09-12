# Decisions become a directory, and the aggregate becomes generated

`[measured 2026-09-08]` Recorded here rather than in `docs/decisions.md`, with a
topic suffix, because appending to that file is the churn this change is about
and six open PRs are sitting on it. The irony is the evidence.

## The problem, measured rather than estimated

`docs/decisions.md` is 794 lines and its header says "one entry per decision,
**newest first**". Newest-first makes the top of the file a single shared
insertion point, so every session that records a decision writes at the same
place.

Of the **13 open PRs, 6 touch `docs/decisions.md`**. Replaying every pair among
those six with `git merge-tree` against their real merge bases:

| | pairs | conflicting | conflicting ON `docs/decisions.md` |
|---|---|---|---|
| the queue as it stands | 15 | **15** | **15** |

A complete graph. Every one of those PRs conflicts with every other one, and the
file is the reason in all fifteen cases.

## The same root cause did worse damage in the filenames

Two sessions each created `docs/DECISIONS-2026-09-07.md` on the same day.
Replaying one rename over the other made git rename *theirs* and apply the
other's diff on top, producing a 48 KB weld of two unrelated documents with no
copy of either original. **Every test passed**, because a file made of two real
documents still resolves every path it names and still names real scripts.

**A date is not a name.** The topic segment is what makes two sessions' filenames
differ, which is why `NAME_RE` in the generator refuses a date-only name with
that sentence in the error rather than accepting it and hoping.

## The corruption is not historical. Three open PRs carry it right now

The brief for this work said sessions were resolving these conflicts correctly.
They are not. `node tooling/generate-decisions.js --lint` over every open PR's
version of the file:

| ref | entries | the quota-wall decision | welded line |
|---|---|---|---|
| main | 18 | present, 3,045 B body | no |
| #208 | 18 | **reduced to a 79 B stub** | **yes** |
| #206 | 18 | present, 3,045 B body | no |
| #203 | 19 | present, 3,045 B body | no |
| #201 | 17 | **gone as an entry** | **yes** |
| #196 | 17 | **gone as an entry** | **yes** |
| #194 | 17 | present, 3,045 B body | no |

Three PRs carry the identical corrupted line:

    7,480 rows removed with a verified backup first.## 2026-09-08: the quota wall — detect it, name the resume, do not add a cap

No newline before the `##`, so markdown renders the heading as paragraph text.
In #208 the decision survives as a heading with an empty body *and* a welded
copy; in #201 and #196 it is not an entry at all — its body has been absorbed
into the decision above it. Nothing noticed, for the same reason nothing noticed
the 48 KB weld: the document still reads plausibly and still passes every check
that asks whether its paths resolve.

**This is why the lint had to ship before the migration.** A split run against
#201's tree would carve the corruption into per-file entries and lose one
decision permanently, with a byte-exact round-trip proof attached saying nothing
was lost. Faithful preservation of a corrupted input is still a loss.

## What was measured before choosing the shape

Three worlds, simulated with the real entries those six PRs add, replayed
pairwise against a common migrated base:

| world | conflicting pairs of 15 | resolution cost |
|---|---|---|
| **A** one file, newest-first (today) | **15** | hand-merge prose; 3 of 6 PRs already got it wrong |
| **B** per-file sources + generated aggregate COMMITTED | **4** | `--write`, then commit. No judgment, cannot lose content |
| **C** per-file sources, aggregate not committed | **0** | none |

B is shipped, and the number that decided it is the drop from 15 to 4 rather
than the drop to zero. The four survivors are pairs whose entries sort adjacent
in the aggregate; git auto-merges the rest because per-file sources make the
insertions land at different lines. **The residual four cost one command with no
judgment in it, and the catastrophic mode is gone in all four**: entry text lives
in files that cannot collide, and a resolution that mangles the aggregate is
caught by `check:decisions-drift` instead of shipping.

C was not chosen because it trades the reading experience — and every existing
link to `docs/decisions.md` — for four mechanical conflicts. If those four ever
hurt, C is a one-line change: stop committing the aggregate.

## The shape

- **`docs/decisions/<YYYY-MM-DD>-<topic>.md`**, one file per decision, holding
  the entry verbatim including its own `## <date>: <title>` heading.
- **`docs/decisions.md` is generated** from that directory, newest first,
  with the hand-written preamble above a `GENERATED BELOW` marker copied through
  verbatim — the same two-part shape as `AGENTS.md` (#198).
- **The generator never rewrites entry text.** It orders and concatenates,
  nothing else. A migration cannot reflow an entry if the code has no transform
  in it, which is a stronger guarantee than a careful transform.
- **Order is (date descending, then topic slug ascending)** — total, and derived
  only from per-file data. A shared sequence counter would be a new shared
  insertion point, which is the defect being removed.

## Two things found on the way, both worth keeping

**The file is not in the order its own header claims.** Entries 1-6 descend;
entries 7-18 ascend (eight from 2026-08-19, then 08-30, 09-04, 09-05). The
document is two documents in opposite orders — residue of exactly the merge
pressure this change addresses. So "preserve ordering verbatim" and "newest
first" cannot both hold, and the migration reorders **14 of 18** entries while
changing **0 bytes** of entry text. `--verify-split` reports both numbers.

**The lint's first version went red on the real defect for the wrong reason.**
`WELDED_HEADING` required whitespace after the date; the entire corpus writes
`## 2026-09-08: title`, so it matched nothing. The lint still exited 1 on #208 —
on the *empty-body* finding — and reading the exit code instead of the finding
would have banked a regex that matched nothing as proven. It was caught by
predicting which assertions each mutation should turn red and noticing one that
stayed green. The same discipline caught a second one: `the rejection says how to
fix it` was asserting on `<date>-<topic>.md`, a literal that also appears in the
generator's own `Source:` header, so a stale-diff report satisfied it without any
rejection having happened. Both are now anchored on text unique to the finding,
and the suite header says why.

## What is wired now, and what is held

**Wired.** `check:decisions` (`--lint`) as gate step 8 and a CI step on all three
platforms. It works on the single-file document as it exists today, so it needs
no migration to be useful, and it is green on main.

**Held: the migration itself.** `docs/decisions/` is not created and
`docs/decisions.md` is untouched by this PR. Six open PRs are on that file;
landing the migration now would conflict all six at once and force six rebases,
turning a fix for churn into a burst of it. Holding the *commit* rather than only
the merge is the stronger choice: the migration is a function of the file's final
state, so a snapshot committed today is stale the moment any of those six merges.
The tool is deterministic and re-runnable, so committing the tool and not its
output means the migration absorbs whatever landed in between.

**Held: `check:decisions-drift`** (`--check`). Defined as a script, deliberately
not in the gate chain: with no `docs/decisions/` it exits 2 INERT, and a gate step
that is inert is worse than no step. It goes into the chain in the same commit as
the migration.

## The migration runbook, for when the queue drains

Preconditions: the three welded PRs (#208, #201, #196) fixed or merged and
`npm run check:decisions` green on main; two or fewer open PRs touching
`docs/decisions.md`.

    node tooling/generate-decisions.js --lint            # must be green first
    node tooling/generate-decisions.js --verify-split     # byte-identical: YES
    node tooling/generate-decisions.js --split
    node tooling/generate-decisions.js --write
    node tooling/generate-decisions.js --check            # must be green
    # then add `&& npm run check:decisions-drift` to the gate chain and to CI

Recording a decision after that is a new file under `docs/decisions/` plus
`--write`. Never an edit below the marker.
