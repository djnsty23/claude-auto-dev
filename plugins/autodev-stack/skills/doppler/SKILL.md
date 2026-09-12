---
name: doppler
description: Configure or migrate a project’s environment variables with Doppler. Resolve the intended account and environment, preserve secret scope, and verify application access and recovery.
when_to_use: "Invoked when the user says \"doppler\", \"setup doppler\", \"add doppler\", \"env to doppler\", \"migrate env\"."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[setup|link|run|migrate|rotate]"
---

# Doppler — environment management

Use the project's existing secret-management design. Shared references can
reduce rotation work, but centralizing unrelated projects is an architectural
choice with a wider failure scope, not an automatic cleanup.

## Establish scope and capability

Read `doppler.yaml`, the current mandate and the required environment. Resolve
project/config explicitly; local setup must not silently select production.
Check `doppler --version`, `doppler me` and relevant command help, retaining
their real exit status. Do not pipe prerequisite commands into `head`.

Install a missing CLI using the approved platform package manager when setup is
in scope. Use configured credentials or start the supported login flow; ask for
a human consent step only when the actual flow requires it. Do not ask for
secret values in chat.

Project limits and plan capabilities change. Inspect the actual account/plan
and current [Doppler documentation](https://docs.doppler.com/docs/cli) before
claiming a quota or recommending consolidation. A remembered ten-project cap is
not an instruction to delete resources.

## Link or migrate the selected environment

1. Inventory required variable **names**, current sources and consumers without
   printing values. Read the exact approved source file; do not select whichever
   env file happens to appear first.
2. Resolve whether the destination project/config already exists. Creation or
   an upload follows the user's scope; preserve existing destination keys and
   inspect overwrite consequences before the write.
3. Use supported `doppler setup` or deliberate `doppler.yaml` configuration
   for that verified project/config. Keep development and production distinct.
4. Upload only the selected file/keys using the installed CLI's documented
   command. Capture errors without exposing values; do not call a failed upload
   a completed migration.
5. Run the actual application/check through `doppler run -- <command>`.
   Verify required names are present and the intended dependency authenticates.
   A count of process environment variables is not proof Doppler injected the
   right secrets; inherited variables alone can satisfy that count.
6. Keep the previous ignored local source until the migration and recovery are
   verified. Retire it only within the authorized scope.

Commit `doppler.yaml` when it contains only intended shareable project/config
metadata. Keep secret files ignored; example/template files contain names or
safe placeholders only. Wrap commands once, preserving the child's exit status.

## References and rotation

When sharing is actually intended, load
[extract-to-hub.md](references/extract-to-hub.md) and check the current reference
syntax against installed documentation before writing values. A string that
looks like a reference is not proof it resolved.

Rotate the exact selected credential, then verify each affected consumer and
restart/redeploy behavior needed for it to receive the new value. A newly
started `doppler run` and an already running service have different lifecycles.
Preserve a recovery plan appropriate to the provider; do not revoke the old
credential before proving the replacement when overlap is supported.

## Backups must be encrypted and restorable

A backup/export is separate from ordinary setup or rotation. Use the requested
project/config scope; do not export every visible project's secrets.

The former `tar -czf` recipe compressed plaintext env files. Compression is
**not encryption**, and cloud storage does not turn that file into an encrypted
backup. Do not reuse that recipe.

For an authorized backup, select an available encryption tool and verified
recipient/key arrangement first. Keep plaintext in a private temporary location
only as necessary, retain real command statuses, and produce the encrypted
artifact before deleting inputs. Test decrypt/restore with synthetic secrets
using the same format before exporting real ones. Verify the resulting archive
can restore the intended layout without displaying values or overwriting live
secrets. Store keys separately; clean temporary plaintext with an explicit
owned-file list. Publish only the encrypted artifact to the intended destination.

Report which configurations and checks were covered, backup identity and
recovery location, without secret values. Unavailable credentials, failed
uploads, untested restore and pending propagation remain named gaps.
