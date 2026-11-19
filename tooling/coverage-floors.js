'use strict';
// coverage-floors.js: the per-platform coverage ceilings and the files a platform
// refuses by design. Data only, so two readers share one definition:
//   find-untested-functions.js --gate (check:coverage, the release gate) and
//   coverage-diff.js (gate:fast), which reads this file at the merge base and at
//   HEAD to learn how far a diff raised a ceiling. It must stay loadable by
//   itself: no require, no side effect, module.exports only.
//
// Moved out of find-untested-functions.js unchanged; "below" and "above" in the
// comments refer to that file's gate.

// THE FLOOR. `[measured 2026-09-08]` at fcfb8fa (main), on a GREEN run of the suite
// under coverage (load 9 to 14): 40 named function(s) never called across the
// loaded plugin files, and 1 plugin source file never loaded at all. Measured
// three times the same day as main moved under the PR that wired this: 37 at
// b8eae1f, 39 at f870b15 (#189 fleet-overlap's degrade(), #200
// workflow-run-triage's projectsDir()), 40 at fcfb8fa (#196 production-signals'
// httpGetJson()). Each time this gate at the previous floor exited 1 on the
// rebase, which is the behaviour it exists for, recorded in
// docs/evidence-coverage-gate-2026-09-08.md. The floor was re-measured rather
// than the three functions being driven here, because they belong to other
// sessions' merges and are follow-up tests, not defects. --gate
// fails only ABOVE these. The bare run's own header, further up, explains why
// the count is not a debt to chase to zero (platform-gated code, defence-in-depth
// handlers). Lowering a ceiling is a ratchet decision, recorded in
// docs/decisions.md; raising one is a regression wearing a config edit, so the
// run that needs it should be looked at first. Whoever changes either re-measures
// on a green run and replaces the date and commit above in the same edit.
//
// ONE FLOOR PER PLATFORM, because the census is platform-sensitive and a floor
// measured on one host is not a claim about another. `[measured 2026-09-13]` on
// Windows 11 at b9d0d56 the suite was green and this gate exited 1 at 94 against
// the 40 above, on a markdown-only PR, while ubuntu-latest CI scored 37 on the
// same commit. 61 of the 94 are code that cannot run on win32 by design: the
// mission runtime (mission-store.js refuses without process.getuid, and its
// eight suites run one case there and skip the rest) and agent-browser-cleanup's
// `ps` branch. The single floor read that as "this change added plugin code no
// suite enters" and sent a session to blame main for a platform. Reading in
// docs/evidence-coverage-floor-per-platform-2026-09-13.md.
//
// The 40 was measured on macOS; linux shares it because ubuntu-latest scored the
// same 37 as the Mac at b8eae1f (CI run 34209762305) and 37 at b9d0d56 (run
// 34673906530). A platform with no entry here is NO VERDICT (exit 2) before the
// suite runs, never a pass and never a regression: it has no floor to exceed.
const FLOORS = {
    darwin: { untested: 40, neverLoaded: 1, measured: '2026-09-08 at fcfb8fa' },
    // `[measured 2026-10-04]` ubuntu-latest CI runs 37166302077 and 37166303320
    // at 061a180, both green through the suite and listing the same 44. The last
    // graded linux run, ee675ab1 on 2026-10-02, scored 39. Main's own ubuntu
    // job never reached this step in between, because test-gate-ownership S8
    // failed first, so the rise surfaced on the PR that fixed S8. Six named
    // functions arrived through main's merges, none through that PR, and none can
    // run on linux: gate-identity.js runPowerShell(), windowsSnapshot(),
    // resolvePs() and parsePsW() (b297b4db, the win32 and MSYS probes),
    // reap-build-output.js expandShortPaths() (124d92ae, 8.3 aliases, win32
    // only), and layout-probe.js harvestComponents(), which runs only inside a
    // page after toString(), as harvest() does. The other 38 all predate
    // ee675ab1. darwin keeps its own number: macOS CI does not run this step.
    linux: { untested: 44, neverLoaded: 1, measured: '2026-10-04 at 061a180' },
    // `[measured 2026-09-13]` on Windows 11 at 84e0a75: 1061 named functions, 93
    // never called, of which 57 are REFUSED_BY_DESIGN below and 36 are graded
    // (the linux buckets plus four POSIX-gated single functions), 1 never loaded.
    // `[measured 2026-09-28]` at 1264796: 37. The one added is tracking-parity.js
    // harvest(), which runs only inside a page after toString(), as layout-probe.js
    // harvest() does. Of the four this release added, the other three are driven by suites.
    win32: { untested: 37, neverLoaded: 1, measured: '2026-09-28 at 1264796' },
};

// CODE A PLATFORM REFUSES BY DESIGN, reported as its own population rather than
// folded into that platform's floor. `[measured 2026-09-13]` the mission runtime
// added 57 named functions across four files in three days (stories B05 to B08),
// and every one is never entered on win32 because mission-store.js
// sqliteRuntime() refuses with runtime-unavailable when process.getuid is
// missing. A win32 floor that COUNTED them would go red on Windows for every
// mission change, while linux, where the same suites run their POSIX+SQLite
// cases, grades those functions properly. Re-measuring the win32 floor on each
// of those PRs is the "regression wearing a config edit" the paragraph above
// warns about, repeated until nobody reads the number.
//
// So when this repo is measured on the listed platform, and only while the
// stated precondition holds on the host, never-called functions in these files
// are printed as a separate count per file and not graded. Everything else stays
// in the count, including the four platform-gated FUNCTIONS in other files
// (prd-requirements validateSnapshot, agent-browser-cleanup's ps branch): those
// are single functions that do not grow with a runtime under construction.
//
// Two guards keep this from becoming a place to hide code. A listed file that
// does not exist, was never loaded, or has NO never-called function on this run
// is a stale listing and NO VERDICT (exit 2): the refusal it names did not
// happen here. And the entries are whole files in this table, each with its
// reason, so widening the list is a reviewed edit here and never a flag in
// package.json. `--refused FILE` exists for the fixture suite and is printed in
// every verdict it affects.
const REFUSED_BY_DESIGN = {
    win32: {
        precondition: 'process.getuid is not a function',
        holds: () => typeof process.getuid !== 'function',
        reason: 'mission-store.js refuses with runtime-unavailable without POSIX ownership checks; linux and darwin grade it',
        files: [
            'plugins/autodev-core/scripts/mission-deliver.js',
            'plugins/autodev-core/scripts/mission-dispatch.js',
            'plugins/autodev-core/scripts/mission-store.js',
            'plugins/autodev-core/scripts/mission-supervisor.js',
        ],
    },
};

module.exports = { FLOORS, REFUSED_BY_DESIGN };
