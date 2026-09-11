---
name: memory-backup
description: Back up and restore authorized memory files in a private Git repository, with an exact file manifest and a verified restore before reporting success.
when_to_use: "Invoked when the user says \"memory backup\", \"backup memory\", or \"restore memory\"."
allowed-tools: Bash, Read, Write, Edit, Glob
model: opus
user-invocable: true
argument-hint: "[setup|now|restore|status]"
---

# Memory Backup

Preserve the user's memory in a form another session can restore. A successful
copy, a local commit, a remote backup and a verified restore are separate facts.
Report the furthest state actually verified.

## Resolve the source and destination

Use the current request and any still-valid backup mandate. Preserve authorized
repository, account, scope and publication preferences across turns. A statement
in this public skill grants no access to a particular account or repository.

Resolve the active Claude configuration directory from `CLAUDE_CONFIG_DIR` when
set, otherwise the current user's `.claude` directory. Confirm it is the store
the host uses before copying. Read an existing `.memory-backup-path` pointer as
data; require a nonempty absolute path to the expected backup repository, with
its remote and visibility checked. Never let a failed `cd` leave subsequent
commands running in the caller's project.

For setup, reuse an authorized existing private backup repository. If creating
one is within the request, derive the account from the authenticated host and
create it there using the available GitHub tool or CLI. Do not copy a username
from documentation. Validate that the resulting repository is private before
uploading memory. Keep any publication work within the current mandate.

## Enumerate before copying

Build an explicit manifest from approved regular files:

- Approved Markdown files under each included
  `<config>/projects/<storage-id>/memory/` tree, preserving their relative
  subdirectory paths. Enumerate regular files recursively without following
  symlinks; a top-level `*.md` selection can omit a linked domain note.
- `<config>/CLAUDE.md` and approved Markdown under `<config>/rules/`, preserving
  relative subdirectories, when included in the backup scope.

Use filesystem APIs or argument arrays, not unquoted shell globs. Resolve every
source and destination under their expected roots. Do not follow symlinks or
guess a repository path by replacing hyphens in a storage id with separators;
that encoding is lossy. Keep the storage id opaque and record a verified project
mapping separately. Report unreadable or excluded linked memory files so the
manifest's coverage is clear.

Copy only the enumerated files. Do not copy the projects directory and filter
afterward: session transcripts can be files beside `memory/`, not just a
`sessions/` directory. Exclude conversation JSONL, task/session carriers,
settings, credentials, installed plugins and the SQLite observation store from
this Markdown-memory backup. A SQLite backup is a separate scope and requires
a consistent database snapshot, not a casual copy of a live WAL database.

Memory can contain sensitive material despite its filename. Do not print file
contents while inventorying, and do not assume `<private>` tags remove all
secrets. Handle any discovered credential through the project's existing
incident process; never upload it because the repository is private.

## Build one restorable layout

Use the same mapping for initial setup and every later sync:

```text
memory/projects/<storage-id>/<relative-memory-path>.md
CLAUDE.md                         # if included
rules/<relative-rule-path>.md       # if included
memory-manifest.json
```

The manifest records the format version, capture time, approved roots/project
mapping, relative source and backup paths, size and SHA256 for every file.
Keep machine paths and the manifest in the private backup, never a public
product repository. This mapping removes exactly the source's `memory/` level;
restoring adds it exactly once. Nested paths such as `domains/auth.md` stay
nested; do not collapse them to basename or let equal filenames collide.

Build a staging generation from the manifest. Verify the copied file set and
hashes before updating the backup checkout. If a source changes during capture,
retry that file and recheck the resulting generation. Do not publish an
inconsistent snapshot: re-enumerate and hash the full approved source set after
capture, including added or removed files, and require it to match the manifest.
Reconcile only paths owned by the previous manifest;
retain unrelated backup files and record intentional removals. Detect a legacy
layout first and verify its migration in a temporary directory before changing
the only existing backup.

## Commit and publish the verified snapshot

Inspect tracked changes **and untracked files** for the explicit backup paths.
`git diff --quiet` alone misses a newly created memory file. Stage only the
manifest and its owned additions, changes and removals; use argument arrays for
paths containing spaces. Never sweep the caller's checkout with `git add -A`.

Commit with a message file after inspecting the staged path set. If publication
is authorized, push to the verified backup remote and retain the push exit and
error output. Read back the destination ref and compare it with the intended
commit. Do not pipe the operation into `tail` and then print “Backed up.” A local
commit awaiting publication remains recoverable pending work, not a remote
backup. If there is no diff, still distinguish “snapshot unchanged” from an
existing local commit that has not reached the remote.

## Restore and prove it

Validate the manifest and source hashes, then restore into a fresh temporary
directory first. Check exact file count, relative paths and hashes, including
a known nested file when the source contains one. Resolve the restored index
links and report out-of-scope targets separately. A successful
round trip must yield `<storage-id>/memory/MEMORY.md`, not
`<storage-id>/memory/memory/MEMORY.md`, and no transcript files.

For the real restore, map each project to its verified current store location;
cross-machine paths and storage ids may differ. Back up existing destination
files before replacing them, preserve unique newer content, and merge explicit
conflicts with provenance. Do not overwrite current instructions or erase
unmapped projects to make counts agree. Report unmapped or conflicting entries
as pending. Restore the global config and rules only when they are in scope.

Read back the restored files and their index links. Report restored files and
unresolved entries separately. Files at the correct path prove restoration;
claim they loaded into a session only after observing that session's loader.

## Status and automation

Status reports source file count, latest local snapshot commit, verified remote
commit, last successful restore check, and any pending paths or publication.
Do not dump memory bodies to show activity.

For a requested schedule, use the scheduler actually available on this host.
Update the existing matching task rather than duplicating it. Give it the exact
backup repository, approved scope and publication mandate; verify registration,
an invocation and its durable result before calling it active. This skill does
not itself install a Stop hook or background worker. A hook mention or a recent
file timestamp is not evidence that a backup ran.

Keep scheduled runs quiet when nothing changed, while recording their run id,
result and any pending publication in private task state. Notify on a failed
backup, an actionable conflict, or another outcome the user requested.
