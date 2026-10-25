# Live verification detail

Loaded from Step 5 of `ship`.

## The browser session

Use an actually available browser driver and its exposed schema to navigate,
inspect the DOM, capture desktop and mobile views and operate the affected
flows. Public and internal/admin UI both need live behaviour checks with the
appropriate role, console and network inspection, and the resulting data
verified after a reload.

Use a fresh isolated verification session where appropriate. If service-worker
or cache behaviour is part of the product, verify its supported update path
too: deleting the user's caches to get a passing screenshot can hide an upgrade
defect. A browser window opened for a human is not autonomous verification
without an agent-controllable driver. If the driver or credential is
unavailable, report that verification as unresolved and continue the checks
that can run.

## What to test by app type

| App Type | Critical Paths |
|----------|---------------|
| **SaaS** | Sign up → onboard → core action → billing |
| **E-commerce** | Browse → add to cart → checkout |
| **Content** | Load → search → read → interact |
| **API** | Health endpoint → auth → CRUD operations |

## Evidence for the human reviewer

A relative path does not reliably render in a PR body. After the branch is
pushed, use the raw URL:
`https://raw.githubusercontent.com/<owner>/<repo>/<tested-commit-sha>/.claude/evidence/<slug>/after.png`

Bind the artifact to the tested candidate SHA and environment, and read back
the link with the reviewer's intended access. A mutable branch can later
display different evidence. For a private repository, use its supported
authenticated artifact or review link; do not publish private evidence to make
a raw URL render.

For new behaviour, record that no earlier implementation existed and capture
the new acceptance evidence. Additive code still needs verification through its
real entry point; a missing historical screenshot does not waive that check.

## Rollback of a function that needs old source

Create an isolated worktree under `<repo>/.claude/worktrees/` at the verified
previous commit and deploy only the intended affected functions from there. Do
not check old files into a worker's active checkout or overwrite its
uncommitted changes.

## Quality metrics (non-blocking, report only)

Report metrics from the completed check artifacts with the measured
population, commit and conditions. Run more only when they answer a relevant
question, using the actual runner and preserved exit status. A missing metric
is unmeasured, not zero; a subjective score is not a completion condition.
