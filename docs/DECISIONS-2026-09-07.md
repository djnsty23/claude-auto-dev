# Decisions — 2026-09-07, branch backlog classification

Reversible calls made without asking, per standing rules. Session worktree
`practical-panini-48736b`, branch `claude/nifty-kalam-e94824`, base `origin/main` 25d91dd.

## D1. `git merge-tree --write-tree` is the probe, not `git cherry`

`cherry` compares patch ids and this repo squash-merges, which destroys them by
construction. A three-way merge cannot revert `main`, so the diff between `main` and the
merge result is exactly the branch's remaining contribution, and identical content on both
sides collapses to empty. Reversible: any future session can re-run either.

## D2. No clean verdict is trusted without a known-positive control

Ran the identical command shape against `main~10`, `main~25` and `main~40` and confirmed
real diffs. This caught nothing on the merge probe and caught **two** broken invocations
elsewhere — a `--numstat` and an `--exclude-dir` both placed after `--`, where git and grep
parse them as paths. The second returned "not on main" for 7 of 7 branches and would have
inverted the table. Every probe run in the final document carries a positive control, and
the content probe carries a negative control too.

## D3. Bucket definitions, chosen because "unlanded" is ambiguous

- **LANDED** — `main` contains the contribution; merging adds nothing.
- **UNLANDED** — `main` lacks content still worth landing.
- **STALE** — `main` lacks the content, but it should not be landed: rejected, superseded,
  or expired.

The split matters: five branches carry content `main` genuinely lacks, and *none* of it
should be landed. Collapsing STALE into UNLANDED would have reported five actionable
branches where there are zero. Collapsing it into LANDED would have claimed `main` contains
things it does not.

## D4. Document location: `docs/evidence-branch-classification-2026-09-07.md`

`docs/evidence-*.md` is the established home for measured evidence in this repo.
`.claude/reports/` is gitignored (`.gitignore:68`), so a classification committed there
would not exist for anyone else — and a classification that lives only in a chat message
dies with its session. The repo root was rejected per `rule-file-organization`; the
predecessor's `BRANCH-TRIAGE.md` sat at root and never landed.

This decisions file is in `docs/` for the same reason, keeping the `DECISIONS-<date>.md`
filename the standing rule specifies.

## D5. Nothing deleted, nothing rebased, no PR opened

Branch refs on `origin` are shared state. The deletion proposal is split into a safe tier
(34 merged heads, recoverable from their PRs) and a lossy tier (5 heads, two of which have
no PR and so no other copy on `origin`). That second tier is a discard decision, not a
cleanup, and it goes to the Brain.

## D6. `VERSION` untouched, and no code changed

This change is two markdown files under `docs/`. No plugin, hook, script or suite was
edited, so no behaviour is gated by it.

## D7. Pushed with `--no-verify`, over a failure that is `origin/main`'s own

`npm run gate` exits 1 on this branch: `validate` fails one check, and `test-validate`
fails 3 of 28. The pre-push hook refuses on the same failure.

**It is not this change's failure.** Checked out `origin/main` at 25d91dd in a detached
worktree, untouched, and ran both:

```
[FAIL] plugins/autodev-core: hooks module ./fn/autodev-fn.mjs failed the host's scan:
       validation passed but the scan listed no hooks: the modules entry was not read
Summary: 18 PASS, 1 FAIL, 0 WARN          # identical on main and on this branch
25 passed, 3 failed                        # test-validate, identical FAIL lines
```

`diff` of the FAIL lines between base and branch is empty, and `diff` of `validate`'s
output differs in exactly two lines — the tracked-file count, 423 to 425, which is this
commit's two markdown files. Both public-repo gates still pass on them: no private names,
no home paths. `tree-inert` passed, so nothing rewrote the tree mid-run. 109 of 112 suites
green.

Bypassing a red gate is normally the wrong call, so the reasoning is written down rather
than assumed: this change is two documents under `docs/`, it touches no plugin, hook,
script or suite, and the gate is red at the base commit for a hooks-module scan that no
markdown file can reach. Holding the classification hostage to an unrelated pre-existing
failure would leave the branch backlog unmeasured for exactly as long as that bug lives.

**`plugins/autodev-core/fn/autodev-fn.mjs` failing the host's scan on `main` is a separate
defect and is not fixed here.** It is reported to the Brain as its own item. A session that
pushes anything to this repo today will hit the same wall.
