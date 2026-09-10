# Independent fleet-row and host-admission review

Scope: seven current tracked/proposed source documents, compared with c1fa1c6. Read-only source review, no full suite/gate rerun, no live fleet read. Exact reviewed hashes follow. The package projection draft remains frozen separately.

## One retained blocker within the row-validation scope

`plugins/autodev-core/scripts/fleet-overlap.js:126–130` validates fields before filtering but omits state. Its `:464` displays state and `:467` uses `state === 'blocked'` to produce the awaiting-input population. Thus unknown or malformed state is still folded into a quiet result. This behavior predates the change; the new consumed-row validation leaves it unclosed.

Actual entrypoint probe: `python3 - <<'PY'` copied each real current consumer into an owned scratch directory, supplied a synthetic sibling fleet-status.js returning the specified JSON, and spawned `node fleet-overlap.js` / `node watch-panels.js --once` with an owned AUTODEV_FLEET_DIR. Exact rows/results are in fleet-host-independent/results.json. Fixture was removed. Population: five variants per consumer, ten actual child CLI runs.

The positive blocked row prints `awaiting input right now: 1`, exit0. Changing only state to null, an object, or `new-unrecognized-state` prints `awaiting input right now: 0`, exit0 in all3 cases. Watch-panels rejects all3 with exit2 and WATCHER-ERROR, creates no dedup state, and emits its expected panel for the positive. A fifth optional-fallback row retains the visible panel/blocked count, demonstrating that omitted optional text/pending does not require blanket rejection.

Correction: validate fleet-overlap state against the current producer's six-state enum, as watch-panels already does, before any population/verdict. Add null, object, missing and unknown-state cases beside a valid state control. Falsifier: a documented legitimate state outside that enum from this producer; current fleet-status.js classify returns only blocked/working/waiting/stalled/cold/done.

## Findings that did not become blockers

The root A/B artifact's candidate hashes match both reviewed consumers exactly. It reports fleet-overlap19/19 and watch-panels20/20 versus container-only3/19 and3/20 and object-only8/19 and8/20. I did not rerun this population. The independently probed state cases above are outside that recorded population and explain why those results do not establish complete consumed-field coverage.

Producer comparison: fleet-status sets idleMinutes from numeric filesystem mtime; its desktop index coerces isArchived to boolean, while a missing index leaves the property undefined. The new overlap guard allows the latter. classify emits exactly the watcher enum. Optional text and uncaptured-question fallbacks remain accepted and visible. The watcher completes row validation before emitting a panel or adding its key, so the new malformed-later-row controls check the right boundary; rendered question/option access has corresponding type validation. I found no introduced false-positive case against the stated current producer shape in this bounded pass.

The watcher one-shot status now distinguishes failed scans from a quiet successful scan. Its periodic retry/error cadence and swallowed persistence-write failure are preexisting behaviors, not newly established transport/ack guarantees. Successful console output still is not acknowledged delivery; the change does not claim it is.

The host documents correctly scope their measurements to synthetic native dispatch on the named versions/macOS, distinguish warnings from errors, preserve unmaterialized-item uncertainty, and say function-module/SessionEnd/Windows/installed-autodev admission is outstanding. The historical channel comparison is explicitly labeled; the new text does not claim that preserving Claude source proves Claude execution. The pre-model blocked/completed distinction agrees with the native receipts. No new doc blocker found in the reviewed text; the subsequently measured apply_patch/workdir guard gaps should remain in the next admission update/capability records, as already coordinated with root.

## Reviewed hashes

```json
{
  "plugins/autodev-core/scripts/fleet-overlap.js": "93e30da892e64790d9f38227de15162d2ead218d1c686177423ac077cd863d5c",
  "plugins/autodev-core/scripts/watch-panels.js": "8d5826b2f42a5d34b3a912f1589f82df63293f58d786c07a77bc7cafe4fb7c84",
  "tooling/test-fleet-overlap.js": "e69ec19d24bf604f8d209e1fe24f9a0c454a1093309014152637e8894aaa9fe5",
  "tooling/test-watch-panels.js": "6e3ec942194bcb6046f45c6cf229347eb2c25dcd53369872c0004aada19bc730",
  "plugins/autodev-core/skills/brain/SKILL.md": "b23a90507a5228163d2a5112d4df4c9511f4a947c038f0bf940df8b718e95fb8",
  "plugins/autodev-core/skills/brain/references/host-admission.md": "f07f04786fa93495b38e5382f36592e052984672f3960718aaa812812d083e36",
  "docs/codex-channels.md": "ca4e8f98960677ef57a9f43cc97ed89c49d58e5d013b987f1c8d1d62d9892c2a"
}
```


## Final recheck on committed 08cd93c

Disposition: the retained state-validation blocker above is resolved. Earlier hashes/counts describe the earlier review only. No additional adoption blocker found in this bounded fleet-row/host-document review; this is not whole-harness admission.

Actual independent command `python3 <reports>/fleet-host-independent/state-after.py` equivalent inline probe (the exact standalone reconstruction is now saved there) drove a committed-source CLI copy over five synthetic rows. `state-after.json`: 5/5 expected results, exits `[0,2,2,2,0]`. Null/object/unknown states each produce `COULD NOT CHECK overlap - fleet-status returned invalid session row 1` before any population; the known-positive blocked row and optional-fallback row both retain `awaiting input right now: 1`. Owned fixture removed. Source hash follows.

### Mutation verification using actual committed suites

Commands: `python3 .claude/reports/brain-live-audit/fleet-host-independent/mutation-probe.py`, then `python3 .claude/reports/brain-live-audit/fleet-host-independent/mutation-recheck.py`. These copy exact 08cd93c source/suite Git objects into ignored fixtures and mutate only those copies. The suites drive their actual CLI subprocess entrypoints; they do not reimplement the row checks. Each mutant replacement matched exactly once. Full logs, exact argv, original/mutated source and suite hashes are retained under `mutations/`, `mutation-recheck/`, `mutation-results.json`, and `mutation-recheck-results.json`.

| Subject and deliberate mutation | Actual result | Relevant failure assertion population |
|---|---|---|
| Unchanged overlap | exit0, 295/295 | Positive overlap controls pass |
| Remove state enum validation | exit1, 286 pass / 9 fail | All 3 malformed states fail exit/unavailable diagnostic/no-partial-clearance assertions; no unrelated failures |
| Remove archive type validation | exit1, 292 pass / 3 fail | String-archive case fails exit/unavailable diagnostic/no-partial-clearance assertions; no unrelated failures |
| Unchanged watcher | exit0, 216/216 | Panel controls pass |
| Remove watcher row validation | exit1, 152 pass / 64 fail | 18 exit + 18 diagnostic + 14 dedup preservation + 14 recovered-panel assertions; no other failure kinds |
| Consume preceding valid panel before rejecting malformed later row | exit1, 180 pass / 36 fail | Exactly 18 dedup-preservation and 18 recovered-panel assertions; all 18 row-error-output assertions and unavailable-exit assertions still pass |

The final mutation is the narrow discriminator: an error message alone remains correct while the notification is lost, and the suite detects the actual loss. The failures are not summary-count fallout.

Own fixture error preserved, not hidden: the first overlap run set TMPDIR under the ignored repo. That introduced 13 unrelated baseline failures: its path contained `/Code/autodev`, so repoOf added the autodev +5 prior to synthetic git worktrees, and a deliberately non-git fixture inherited the ancestor repository. The state/archive mutants had those same13 plus the intended9/3. Those runs are not reported as clean baselines. Rechecking unchanged committed copies with a private OS-temp root produced 295/295, then only the intended9/3 mutation failures. The suite removed its child fixtures (tempEntries0); the harness removed its owned temp root (ownedTempRemovedtrue). This exposes a preexisting suite temp-location assumption, not an introduced row-validation regression. No tracked or live configuration files were changed.

### Native generated packaging evidence boundary

Read-only inspection of `generated-override-result.json` confirms native Codex0.153.4 discovered the synthetic four-hook fixture and produced positive SessionStart, guard UserPromptSubmit and SessionEnd receipts. The unmatched resume control has no receipt. This verifies the exact generated wrapper's transport on that synthetic native boundary, not execution of every real autodev handler. Missing model-request fields in that receipt are not silently interpreted as zero.

`generated-catalog-result.json` separately records 21 discovered handlers (core17 + memory4; stack has no hook expectation), zero catalog warnings/errors, `threadStarted:false`, `modelRequests:0`, and zero execution receipts. The eight generated manifests/capability/hook-file hashes match the exact 08cd93c Git objects 8/8; see `native-generated-hash-recheck.json`. Catalog entries are enabled but report `trustStatus:untrusted`; discovery alone is not trust or execution admission. Expected network/snapshot stderr is not misreported as empty stderr. No native call was rerun for this review.

The documents continue to distinguish synthetic transport, runtime protections and installed admission, and leave Claude function modules, unmatched/native payload protections, command workdir provenance and Windows behavior unverified. The later separately drafted apply_patch repair was not part of 08cd93c or this review and must receive its own regenerated capability/evidence update when adopted.

Final reviewed Git-object hashes:

```json
{
  "plugins/autodev-core/scripts/fleet-overlap.js": "0163cc548649c35995489febec16e84e2a80fc0fbe92637247d3316699456143",
  "plugins/autodev-core/scripts/watch-panels.js": "8d5826b2f42a5d34b3a912f1589f82df63293f58d786c07a77bc7cafe4fb7c84",
  "tooling/test-fleet-overlap.js": "40d7552f60c53219036be8e673378eb70bba7c43b1e36e16ba7bbb88b04aef3b",
  "tooling/test-watch-panels.js": "6e3ec942194bcb6046f45c6cf229347eb2c25dcd53369872c0004aada19bc730",
  "plugins/autodev-core/skills/brain/SKILL.md": "b23a90507a5228163d2a5112d4df4c9511f4a947c038f0bf940df8b718e95fb8",
  "plugins/autodev-core/skills/brain/references/host-admission.md": "c69c6b02e066afacab800f2b047b4d80a86ebda5c32b2c700dd6e81548678d35",
  "docs/codex-channels.md": "ca4e8f98960677ef57a9f43cc97ed89c49d58e5d013b987f1c8d1d62d9892c2a"
}
```
