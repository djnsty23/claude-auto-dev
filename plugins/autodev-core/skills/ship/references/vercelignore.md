# The .vercelignore rule

Why every directory deployed with the Vercel CLI needs a .vercelignore, and what it must cover. "This repo" below means the claude-auto-dev repository.

Independent of the target defect, and the one that turns a harmless mis-deploy
into a disclosure.

`[measured 2026-09-08]` on the accidental first deployment in SKILL.md, Step 4, **423 tracked files and
16 gitignored files were uploaded** — `.claude/settings.local.json`,
`.claude/memory-sessions/*`, `.claude/reports/telemetry-*.jsonl`. With no
framework detected Vercel set the output directory to `.` and **served the tree
statically**:

```
curl /.claude/settings.local.json  ->  HTTP 200     publicly fetchable
curl /                             ->  HTTP 404
```

That instance was low-value — a public repo, no secret-shaped strings in the
uploaded set. The mechanism does not know that. The same command from a product
worktree uploads whatever that repo gitignores.

**Every directory you deploy from needs a `.vercelignore`** covering at minimum
`.claude/`, `.git/`, `node_modules/` and `.env`, plus everything that repo's
`.gitignore` names. `check-deploy-target.js --ignore-file` refuses without one,
and refuses an empty one — the file existing is not the protection, the patterns
in it are.

**`.vercelignore` is not `.gitignore` again.** `.gitignore` decides what is
*tracked*; `.vercelignore` decides what is *uploaded and served*. A file can be
tracked and still be one you would never serve, so matching `.gitignore` is a
**floor, not the rule**. Where a repo names narrow paths because partial tracking
is deliberate, the deploy manifest still takes the wide pattern: over-excluding
costs a missing asset, under-excluding costs a public URL. This repo's own
`.vercelignore` is the worked example.
