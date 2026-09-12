# Mission runtime v3 review draft

Derived from frozen v2 after independent write-boundary findings. V2 evidence remains unchanged.

Adopted on branch `codex/audit-4-mission-store`: the store is
`plugins/autodev-core/scripts/mission-store.js`, the fixtures are under
`tooling/fixtures/mission-runtime/`, and the suites are `tooling/test-mission-*.js`
(the `.cjs` suites were renamed so `test-all.js` discovers them; their fixture
roots and report files moved out of the tree). This directory stays as the
frozen review evidence, including the mutation copies under `hardening-mutations/`.
