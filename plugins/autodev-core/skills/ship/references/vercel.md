# Vercel: declare the intent, deploy, read the target back

Loaded from Step 4 of `ship` before any Vercel deploy.

**`vercel --yes` IS NOT RELIABLY A PREVIEW.** On a project's *first* deployment
Vercel assigns it to production regardless of flags, and says so only after the
fact:

> "This is the project's first deployment, so it was assigned to production.
> Future deployments will be preview deployments unless you use `--prod`."

`[measured 2026-09-08]` this was hit twice in one day: by a greenfield run on a
throwaway project, and by the fleet coordinator by accident, which created a
public production alias for a repo worktree. No pre-check can prevent it:
whether a project has ever deployed is a fact about Vercel's account state, not
about the tree or the flags.

## Before the first deploy from any directory

Check what would be uploaded. The Vercel CLI **does not read `.gitignore`**; see
[vercelignore.md](vercelignore.md).

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-deploy-target.js" --ignore-file .
```

`--dry` shows the real answer rather than a pattern floor. It "inspects the
detected framework preset and source files **without uploading or creating a
deployment**", and in non-TTY output lists every file it would send:

```bash
npx vercel deploy --dry --json      # no upload, no deployment — read the file list
```

The floor check is cheap and CLI-free; the dry run is what the CLI would do.

## Deploy, then read the target back

```bash
npx vercel deploy --target=preview --yes
npx vercel inspect <deployment-url> --json > /tmp/deploy.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-deploy-target.js" \
  --deployment /tmp/deploy.json --intent preview

# Only after the preview is verified, promote deliberately
npx vercel --prod --yes
npx vercel inspect <deployment-url> --json > /tmp/deploy.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-deploy-target.js" \
  --deployment /tmp/deploy.json --intent production
```

| Exit | Meaning | Action |
|---|---|---|
| 0 | target matches the declared intent | Continue |
| 1 | **it already went to production** | Stop. Undo, then tell the user what was exposed |
| 2 | the target could not be read | Treat as unverified. **Never as a preview** |

**If it exits 1 on `--intent preview`, the deploy has already happened.** Undo by
which case it is; `vercel ls` says whether any earlier production deployment
exists:

- **First deployment of a new project**: `vercel remove <project> --yes`.
  `vercel rollback` cannot help; there is nothing behind it to roll back to.
- **A project that already had production traffic**: `vercel rollback`.

Then check what was uploaded and report both to the user. A production deploy
nobody intended is not undone by removing it: whatever was served was public
while it was up.

## Environment variables

```bash
vercel env ls
netlify env:list
supabase secrets list --project-ref [ref]
```

Missing env vars mean a broken deploy. Check before shipping.
