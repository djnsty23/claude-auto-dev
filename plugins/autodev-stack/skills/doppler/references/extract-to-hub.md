# Extract shared secrets only within the selected scope

Use this when the current mandate includes sharing the selected credentials
across the named projects/configs. Reusing a value does not by itself authorize
centralizing every application or choosing production defaults.

## Plan one recoverable transfer

Record source, hub and consumer identifiers, the exact key set, current
configuration revisions and an available secure recovery mechanism. Keep secret
values out of the report. Check the installed CLI/API and current reference
syntax; do not derive targets from project-name guesses.

Treat related credentials as a group. For example, a backend URL and its access
credentials must agree on one backend. Do not replace all source values after
only some hub writes succeeded.

## Stage, verify, then repoint

1. Read each selected source value through the configured secret mechanism.
   A failed read or empty required value stops that group before any consumer
   is repointed. Preserve every process status.
2. Write the complete group into the intended hub/config. A failed write stops
   progression. Retain the old consumer configuration for recovery.
3. Verify each hub key contains the intended value using an in-process
   comparison that reports only success/failure. Verify the account/config
   identity separately; a matching key name alone is insufficient.
4. Exercise the proposed references in an authorized isolated test config or
   another supported preflight before changing live consumers. Use a fresh child
   without inherited target variables or a stale fallback cache. Presence alone
   can be satisfied by an old value; compare the expected configuration and
   run the relevant authentication check without logging secrets.
5. Repoint the explicit consumer/key list, preserving each operation's result.
   After each consumer group, verify effective values and application behavior.
   If any operation fails, restore the affected group from the verified secure
   recovery state or report exactly which part remains pending.
6. Clear owned secret buffers/temporary files as appropriate. Record verified,
   pending and restored consumers separately.

The former two-loop recipe populated whichever values were available, then
repointed every key regardless of failures. A successful final command could
hide an earlier failed read/upload. Never infer completion from that shell's
last status.

A reference update affects future retrieval. Already running services may need
a restart or deployment within the existing mandate; verify their actual
behavior before saying rotation propagated everywhere.

[Doppler CLI guide](https://docs.doppler.com/docs/cli) is the starting point for
current command and reference documentation. This procedure defines the
transaction/recovery contract; it is not a shipped atomic migration executor.
