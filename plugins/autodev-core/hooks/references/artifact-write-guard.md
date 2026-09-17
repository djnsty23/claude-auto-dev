# artifact-write-guard

A PreToolUse hook on the `ArtifactData` tool. It checks writes to an Artifact's
shared database against a schema you keep on your own machine, and refuses a
write that breaks it before anything reaches the database.

It exists because the tool validates nothing. Sessions wrote field names the page
never reads, enum values the page cannot render, and timestamps ahead of the real
clock. Each write returned success and reached every viewer.

## Turning it on

The hook does nothing until a schema file exists for an artifact. Put one at

```
~/.claude/autodev/artifact-schemas/<artifact id>.json
```

The artifact id is the last path segment of the artifact URL. Only ids made of
letters, digits, `_` and `-`, up to 64 characters, are looked up. Set
`AUTODEV_ARTIFACT_SCHEMA_DIR` to keep the schemas somewhere else.

Schemas describe your private boards, so keep them out of any public repo.

## Schema format

```json
{
  "futureToleranceSeconds": 120,
  "collections": {
    "tasks": {
      "fields": {
        "title": { "type": "string" },
        "status": { "type": "string", "enum": ["todo", "doing", "done"] },
        "owner": { "type": "string", "notEnum": ["unassigned"] },
        "updatedAt": { "type": "timestamp" },
        "results.*.state": { "enum": ["pass", "fail"] }
      },
      "requiredOnSet": ["title"],
      "requiredOnWrite": ["updatedAt"],
      "noDelete": true,
      "unknownFields": "deny"
    }
  }
}
```

- A collection key is the tool's `collection` value, exactly. Collections the
  schema does not name pass untouched.
- A field path uses dots for nesting and `*` for any one key or array index.
- `type` is one of `string`, `boolean`, `number`, `timestamp`, `object`, `array`.
  Leave it out to allow any type.
- A `timestamp` is an ISO 8601 string with `Z` or an offset, such as
  `2026-01-01T12:00:00Z`. It may be at most `futureToleranceSeconds` (default 120)
  ahead of the current time.
- `enum` lists the only allowed values. `notEnum` lists values that are refused.
- `requiredOnSet` must be present on `set`. `requiredOnWrite` must be present on
  `set` and `update`. A wildcard path such as `results.*.state` requires the last
  key on every child that exists.
- `noDelete: true` refuses `delete` on the collection.
- `unknownFields: "deny"` refuses any field no path covers. A path covers its
  whole subtree unless a longer path names something inside it.

## What each action gets

| action | checks |
|---|---|
| `set` | `requiredOnSet` and `requiredOnWrite` present, present fields valid |
| `update` | `requiredOnWrite` present, present fields valid |
| `batch` | each entry by its own `op` |
| `delete` | refused only with `noDelete` |
| `str_replace` | refused when the field has an `enum` or is a `timestamp`, since a text splice cannot be validated. Use `update`. |
| `get`, `list`, `query` | not inspected |

A write that uses `file_path` is checked against the parsed file. If the file
cannot be read, the hook allows the call and the tool reports the error itself.

## When it refuses

The writer sees one reason naming the document, every violation and the schema
path. A future timestamp also names the current UTC time, so the writer can
correct the value and retry.

## Failure behaviour

The hook fails open. A schema that does not parse, an unexpected payload or any
internal error allows the write and prints nothing. A defect in an installed hook
must never block your writes.
