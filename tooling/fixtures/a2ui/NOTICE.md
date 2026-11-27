# A2UI v1.0 conformance cases

Two files copied unchanged from the A2UI specification repository,
github.com/a2ui-project/a2ui at commit `36725eee042da90c526f469f94246f96e16fdc35`,
under the Apache License 2.0:

| File here | Source path |
|---|---|
| `renderer_messages.json` | `specification/v1_0/test/cases/renderer_messages.json` |
| `contact_form_example.jsonl` | `specification/v1_0/json/contact_form_example.jsonl` |

`tooling/test-live-edit-asks.js` grades `plugins/autodev-core/scripts/live-edit-a2ui.js`
against them: every renderer case must get the verdict the spec gives it, and every
example line must pass the envelope check. The example uses the spec's basic catalog,
so live edit's own catalog check must refuse it.
