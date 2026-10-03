# Deploy ledger details

How the deploy ledger treats regeneration and provenance, first deployments and baselines, and the three things it does not do.

Regeneration preserves checks and metrics only for the same resolved base and
candidate. Changing either commit or loading an older ledger without that
provenance resets them. Without `--candidate`, the CLI uses current HEAD and
still rejects evidence from an earlier candidate. An explicit older candidate
verifies only that historical record, never the newer checkout or deployment.
Commit/archive the evidence separately from a production trigger. If a later
commit is actually promoted, it is a new candidate requiring its own checks and
live readback; do not reuse historical verification to claim that commit passed.

This binds recorded assertions to a commit window, not to the actual
browser, deployed environment or business outcome. Keep those artifacts and
readbacks separately. Independently inventory affected flows from the product
contract and add checks the file/route heuristics cannot derive. Unsupported
Markdown/control characters in a surface path produce an explicit tool gap,
not a checked surface or permission to rename the user's files.

For a verified first deployment there is no prior deployed commit. Treat the
entire candidate as the affected surface inventory; the current ledger CLI
requires a commit baseline and cannot derive that first-release case from an
empty tree. Record that tool limitation and perform the complete first-release
acceptance checks; do not invent a deployed SHA or use HEAD to make it pass.

The CLI falls back from `--since` to `.claude/last-deploy`, then the most recent
tag. This workflow supplies the saved verified baseline explicitly; fallback
resolution is not evidence that a marker/tag was actually deployed. **If none resolves it refuses with exit 2 rather than
diffing against something arbitrary** — "no surfaces changed" and "I could not
tell what changed" are opposite answers and must not print the same.

Three things it deliberately does not do:

- **It does not execute verification.** A human or a browser-driving agent
  records the result. Row/commit validation cannot prove that a browser flow
  ran or its business outcome passed.
- **Its WIDE detection is heuristic.** Known config, token and layout names are
  considered across UI, JavaScript/TypeScript and JSON files, including
  `tailwind.config.js`. Other shared dependencies may still be omitted.
  Independently inspect them; a zero detector count does not prove that no
  user-facing behavior changed.
- **It does not derive metrics.** The ledger has a metrics section that must be
  filled or explicitly waived, and an empty one fails `--verify`. Nothing here
  knows which metrics your deploy could move.

Route derivation is convention-based (`app/`, `pages/`, `src/routes/`). A
project routing some other way gets its changed files listed without a route,
which is honest rather than wrong — the row still has to be checked.
