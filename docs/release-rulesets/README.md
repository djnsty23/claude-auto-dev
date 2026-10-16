# Release protection

A version is a cache key: an install of `v8.193.0` must always get the same tree.
GitHub enforces that with three repository rulesets, defined in this folder.

| Ruleset | Refs | Rules | Bypass |
|---|---|---|---|
| `main.json` (release-main) | the default branch | pull_request (0 approvals), non_fast_forward, deletion | none |
| `stable.json` (release-stable) | `refs/heads/stable` | pull_request (0 approvals), non_fast_forward, deletion | any repository deploy key |
| `tags.json` (release-tags) | `refs/tags/v*` | update, non_fast_forward, deletion (no creation rule) | none |

`node tooling/release-protection.js` reads them back for the acting account and
prints `direct_write=DENIED tag_replace=DENIED tag_delete=DENIED authorized_publish=PASS`
when they hold. `tooling/githooks/pre-push` runs `tooling/push-guard.js`, which
refuses the same force-pushes and tag rewrites locally before they leave.

## Why stable has a bypass and main does not

main changes only through a pull request, which `merge-lock.js` already merges
with `gh pr merge --rebase`. stable must equal the release tag's commit, and a
pull request merge rewrites SHAs, so stable cannot move through one. Its one
bypass actor is a deploy key that lives only on the operator's machine and is
used only by `tooling/publish-release.js`. That script refuses unless the tag
commit is on main, stable moves forward, and the gate receipt proves the tag
commit's tree. The rationale is in [docs/decisions.md](../decisions.md).

## Publishing a release

After `tooling/bump.js` and the changelog, gate the release PR's candidate and
merge it through merge-lock. The plain gate log is the receipt: gate-lock prints
`gate-lock: head <full sha>` first and again just before its verdict, so no
wrapper around `npm run gate` is needed.

```bash
npm run gate > gate.log 2>&1
node plugins/autodev-core/scripts/merge-lock.js merge --repo djnsty23/claude-auto-dev --pr <N> --head <PR head sha> --gate-receipt gate.log
git fetch origin
git tag -a v8.193.0 -m "v8.193.0" <the merged release commit on origin/main>
node tooling/publish-release.js --version 8.193.0 --gate-receipt gate.log --head <PR head sha> --dry-run
node tooling/publish-release.js --version 8.193.0 --gate-receipt gate.log --head <PR head sha>
```

`--head` is the commit the receipt names. The rebase merge gives the main
commit a new SHA with the same tree, and the script checks the trees match.
Without `--head` the receipt must name the tag commit itself. The script pushes
the tag and stable in one atomic SSH push with the deploy key, then reads both
back over HTTPS.

## One-time setup of the deploy key

The private key stays in the operator's `~/.ssh`, readable only by that
account. It is never printed, committed or passed on a command line.

```powershell
ssh-keygen -t ed25519 -N '""' -C "claude-auto-dev publish" -f "$env:USERPROFILE\.ssh\claude-auto-dev-publish"
icacls "$env:USERPROFILE\.ssh\claude-auto-dev-publish" /inheritance:r /grant:r "${env:USERNAME}:F"
gh api repos/djnsty23/claude-auto-dev/keys -f title="publish-release (stable bypass)" -f key="$(Get-Content "$env:USERPROFILE\.ssh\claude-auto-dev-publish.pub")" -F read_only=false
```

## Creating the rulesets

```bash
for f in main stable tags; do gh api -X POST repos/djnsty23/claude-auto-dev/rulesets --input docs/release-rulesets/$f.json --jq '.id,.name'; done
node tooling/release-protection.js
```

## Rolling back

Each command is independent. Read the ids first:

```bash
gh api repos/djnsty23/claude-auto-dev/rulesets --jq '.[] | "\(.id) \(.name)"'
gh api -X DELETE repos/djnsty23/claude-auto-dev/rulesets/<id>
gh api repos/djnsty23/claude-auto-dev/keys --jq '.[] | "\(.id) \(.title)"'
gh api -X DELETE repos/djnsty23/claude-auto-dev/keys/<key id>
```

Deleting a ruleset reopens what it guarded at once. Deleting the deploy key
stops `publish-release.js` until a new key is registered. With no rulesets left,
CLAUDE.md's force-push sentence is still true through the pre-push hook, so
`check:claude-md` stays green.
