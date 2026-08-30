#!/usr/bin/env node
// FAILING TEST — stop-auto-check.js reads only the FLAT story container.
//
// autodev supports two prd.json shapes. auto/SKILL.md:128 documents both, and
// six status lines plus check-spec-output.js read them as
// `(prd.sprints?.at(-1).stories) || prd.stories`:
//
//   flat:    { stories: { "S1-001": {...} } }
//   nested:  { sprints: [ { id: "S1", stories: { "S1-001": {...} } } ] }
//
// stop-auto-check.js:160 reads `prd.stories || {}` only. Against a nested file
// it counts ZERO stories, declares the sprint complete, and — one turn later —
// APPROVES the stop and deletes the auto-active flag, ending auto mode with
// every story still pending. No error, no "failed", no mention of the stories.
//
// This is the same failure class as `deferred` and `needs-setup`, in the
// opposite direction: those made auto block forever on work nobody intended to
// do; this makes auto stop dead on work everybody intended to do.
//
// Drop into tooling/test-stop-auto-check.js. Run: node tooling/test-stop-auto-check.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = process.env.AUTODEV_PLUGIN_ROOT
    || path.resolve(__dirname, '..', 'plugins', 'autodev-core');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'stop-auto-check.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stopcheck-nested-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let n = 0;
function project(prd) {
    const dir = path.join(TMP, 'proj' + ++n);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'auto-active'), '');
    fs.writeFileSync(path.join(dir, 'prd.json'), JSON.stringify(prd));
    return dir;
}

function run(dir) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ session_id: 'sess', cwd: dir, hook_event_name: 'Stop' }),
        encoding: 'utf8', cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    let decision = null;
    try { decision = JSON.parse(r.stdout); } catch { /* stays null */ }
    return { decision, stderr: r.stderr };
}

// Identical work in both files. ONLY the container differs.
// 3 pending + 1 FAILED = 4 actionable; 1 deferred and 1 done are not.
const STORIES = {
    'S1-001': { title: 'pending one', passes: null },
    'S1-002': { title: 'pending two', passes: null },
    'S1-003': { title: 'pending three', passes: null },
    'S1-004': { title: 'failed one', passes: false },
    'S1-005': { title: 'deferred one', passes: 'deferred' },
    'S1-006': { title: 'done one', passes: true },
};

// ---- CONTROL: the flat shape, which the hook does handle. -------------------
// Without this a nested-shape failure is indistinguishable from a broken
// harness — the whole file would "fail" identically if HOOK were a bad path.
{
    const dir = project({ sprint: 'S1', stories: STORIES });
    const { decision } = run(dir);
    check('CONTROL flat shape: 4 actionable stories block the stop',
        decision?.decision === 'block' && /4 tasks remaining/.test(decision.reason));
}

// ---- THE BUG: same stories, nested container. ------------------------------
{
    const dir = project({ sprints: [{ id: 'S1', stories: STORIES }] });

    const first = run(dir);
    check('nested shape: 4 actionable stories block the stop',
        first.decision?.decision === 'block' && /4 tasks remaining/.test(first.decision.reason || ''));

    // The decisive one. The idle one-shot has now fired, so this turn is where
    // the hook lets the session end.
    const second = run(dir);
    check('nested shape: does NOT approve a stop with 4 stories still actionable',
        second.decision?.decision === 'block');

    check('nested shape: does NOT terminate auto mode while work remains',
        fs.existsSync(path.join(dir, '.claude', 'auto-active')));
}

// ---- The count the hook SHOULD have produced, from the shared predicate. ----
// summarise() is the plugin's own five-state reader. It is fed the nested
// container here to show the disagreement is the CONTAINER, not the states.
{
    const { summarise } = require(path.join(PLUGIN_ROOT, 'scripts', 'prd-states.js'));
    const c = summarise(STORIES);
    check('prd-states.summarise agrees 4 are actionable (3 pending + 1 FAILED)',
        c.actionable === 4 && c.pending === 3 && c.failed === 1
        && c.deferred === 1 && c.done === 1 && c.unrecognised === 0);
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
