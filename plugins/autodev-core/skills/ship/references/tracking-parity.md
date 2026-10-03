# Tracking parity

How ship checks that a UI change kept every tracking attribute and fires each event once.

A redesign can drop a tracking attribute or wire a button to fire twice while
every other check stays green. Two subcommands, run BEFORE the merge:

- `static` on every UI diff. It walks the public pages and their imports and
  flags each clickable without the action attribute (default `data-cta`) and
  each form without the form attribute (default `data-form`). Read the
  population line: zero roots exits 2 and means the config is wrong.

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/tracking-parity.js" static . --config tracking-parity.json
  ```

- `judge` against a local or preview build, never production: the probe clicks
  every tracked element and their handlers really run. Harvest the base branch
  and the candidate on the same page, then compare:

  ⚠️ **A local build pointed at the production database changes real data.**
  `preventDefault` stops navigation and form submission, not an `onClick` that
  calls an API. Point the build at a disposable database, and mark every
  control that writes, deletes or sends with `data-parity-skip` (on the element
  or on a region around it). The probe also refuses an unmarked control that
  reads as destructive (delete, remove, revoke, unsubscribe, a `destructive` or
  `danger` style) and leaves the run at exit 2 until it is marked.
  1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracking-parity.js" judge --print-probe --settle-ms 400`
     prints one expression.
  2. In the in-app Browser pane, open the page (for example
     `http://localhost:3000/`) and run `javascript_tool` with
     `JSON.stringify(await <printed expression>)`. The probe blocks navigation
     and form submission with a capture-phase `preventDefault`.
  3. Save the returned JSON as `before.json` (base) and `after.json` (candidate).
  4. `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracking-parity.js" judge --baseline before.json --candidate after.json`

Exit 1 names each `untracked` or `double` element and each `lost-event` (a name
the baseline fired that the candidate never fires). Exit 2 means a harvest was
missing, empty or unreadable, or an element was refused as destructive or could
not be clicked: something was not judged, so it is not a pass.
