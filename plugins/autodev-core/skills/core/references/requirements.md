# Requirements across planning, execution and review

Load when creating or revising stories, admitting a mission, or reviewing its
result. `scripts/prd-requirements.js` is the shared reader used by the plan
checker and mission contract builder.

## One canonical interpretation

- `acceptance`: non-empty array of strings or `{id, description}` objects.
  Prefer explicit stable IDs for new criteria; preserve an ID when its meaning
  is revised. String entries remain supported and get IDs derived from their
  normalized text. Their IDs change when their text changes.
- `verify`: optional array of strings (including existing verify tags) or
  `{id, description}` obligations. These become `contract.verification`,
  separate from the outcomes in `contract.acceptance`.
- `notes`: diagnostic context when `acceptance` exists. Only when acceptance
  is absent does notes supply the legacy single criterion, with the story ID.
  An explicitly empty or malformed acceptance array is an error, not a fallback.
- Criterion text normalizes whitespace, has a 2048-character bound, and is
  never truncated. IDs must be unique within each array. Array order is retained.
- `blockedBy`: array of prerequisite story IDs. Pending prerequisites are valid
  planning; malformed edges, missing IDs and cycles are errors. Use the same
  checker for both entry routes: `check-spec-output.js prd.json` for a fresh
  plan and `check-spec-output.js --existing prd.json` when advancing a sprint.
  Existing mode permits the five states; it does not infer completion.

## Bind specifications to the tickets they actually affect

`specRefs` is an optional array of `{path, revision}`. Each path is a file
relative to the project root containing the requirement used to plan this
story. Each revision is the SHA-256 of that file's **exact UTF-8 bytes**.
The admitted contract retains path, revision and content so a fresh worker can
read the original requirement even if the source is later edited.

For new spec-driven work, keep the core loop, assumptions and non-goals in
`SPEC.md`, and linked requirement files in `specs/`. Refer to the files that
actually constrain each ticket. A whole `SPEC.md` reference is supported, but
every ticket referring to it is affected by any edit to that file. Include shared
constraints where relevant; unreferenced prose has no automatic impact mapping.

For example, a story may have acceptance ID `owner-only`, verification ID
`deny-other-account`, and `specRefs: [{path: "specs/record-access.md", revision:
"<reviewed SHA-256>"}]`. Compute the hash from the file; the placeholder is not
a valid revision. A portable command for one file is:

```bash
node -e "const fs=require('node:fs'),crypto=require('node:crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" specs/record-access.md
```

References must stay inside the repository, including their resolved symlink
targets. A file is at most 64 KiB; the combined requirements snapshot is at most
128 KiB. Split larger tickets. In detached worker mode, the supervisor reads
specs from the planning root and carries their snapshots to the worker. A direct
contract invocation can use `--source-root` for another worktree of the same
repository.

## Reconcile a spec edit before starting more work

From the project root, run the installed script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/prd-requirements.js" revisions --prd prd.json --root .
```

It reports the story population, stale references with expected/actual revisions,
affected stories (including transitive dependents), and unchanged stories.
Exit 0 means no stale references, 1 means affected work, and 2 means malformed
input prevents a verdict. It never edits the PRD, specs or evidence.

1. Read each changed requirement and reconcile the affected acceptance and
   verification obligations. Update referenced revisions only after that review.
   A hash refresh alone does not establish that the old criteria still fit.
2. Retain old results as history. Invalidate affected completion/evidence explicitly;
   preserve unrelated completed stories. Re-run the existing-plan checker and
   read the dependency-ready work plan before selecting the next ticket.
3. A supervisor refuses a new attempt when readiness, requirements, scope or
   retry policy no longer match admission. It reports `requires-reconciliation`;
   it does not silently replace the frozen mission or reset its attempt budget.
   A changed mission needs an explicit new admission after its existing ownership
   and results have been resolved. Automatic mission replacement is not implemented.
4. Live or uncertain attempts still reconcile and retain their reservations,
   even after their story is removed. A settled result remains unverified; the
   supervisor exposes `requirementsCurrent: false` when its requirement snapshot
   is stale. Only independent verification against the current requirements can
   justify completion. That verifier/completion writer is a separate runtime layer.

Re-read before each start: a tick can await one worker while another writer
changes the next ticket. The guard is a fresh pre-start observation, not a lock
on the user's PRD or a guarantee against edits after launch.
