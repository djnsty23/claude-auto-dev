#!/usr/bin/env node
// Tests for autodev-core's Stop hook — the state machine that drives `auto`.
//
// This hook can BLOCK the end of a turn, so a wrong answer here does not throw,
// it hangs the session. It shipped untested. Every transition is covered below,
// including the two that must always terminate: the idle one-shot, and a sprint
// whose remaining stories are all deferred.
//
// Run: node tooling/test-stop-auto-check.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'stop-auto-check.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stopcheck-test-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

// Each scenario gets a clean project directory.
let n = 0;
function project({ auto = false, exit = false, idle = false, prd = undefined, autoAgeMs = 0 } = {}) {
    const dir = path.join(TMP, 'proj' + ++n);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    if (auto) {
        const f = path.join(dir, '.claude', 'auto-active');
        fs.writeFileSync(f, '');
        if (autoAgeMs) {
            const when = new Date(Date.now() - autoAgeMs);
            fs.utimesSync(f, when, when);
        }
    }
    if (exit) fs.writeFileSync(path.join(dir, '.claude', 'auto-exit'), '');
    if (idle) fs.writeFileSync(path.join(dir, '.claude', 'auto-idle-triggered'), 'x');
    if (prd !== undefined) {
        fs.writeFileSync(path.join(dir, 'prd.json'), typeof prd === 'string' ? prd : JSON.stringify(prd));
    }
    return dir;
}

function run(dir, payload = {}) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ session_id: 'sess', cwd: dir, hook_event_name: 'Stop', ...payload }),
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    let decision = null;
    try { decision = JSON.parse(r.stdout); } catch { /* stays null */ }
    return { r, decision };
}

const exists = (dir, f) => fs.existsSync(path.join(dir, '.claude', f));

const SPRINT_PENDING = { stories: { 'S1-001': { title: 'a', passes: true }, 'S1-002': { title: 'b', passes: null } } };
const SPRINT_DONE = { stories: { 'S1-001': { title: 'a', passes: true } } };
const SPRINT_DEFERRED = {
    stories: {
        'S1-001': { title: 'a', passes: true },
        'S1-002': { title: 'b', passes: 'deferred' },
    },
};

// ---------------------------------------------------------------- not in auto

let d = project({ prd: SPRINT_PENDING });
let { r, decision } = run(d);
check('no auto flag → exit 0', r.status === 0);
check('no auto flag → approve', decision?.decision === 'approve');
check('no auto flag → emits valid JSON', decision !== null);

// ---------------------------------------------------------------- blocking

d = project({ auto: true, prd: SPRINT_PENDING });
({ decision } = run(d));
check('auto + pending story → block', decision?.decision === 'block');
check('block names the next story', (decision?.reason || '').includes('S1-002'));

// ---------------------------------------------------------------- idle one-shot

d = project({ auto: true, prd: SPRINT_DONE });
({ decision } = run(d));
check('auto + all done, first stop → block for idle detection', decision?.decision === 'block');
check('idle marker written', exists(d, 'auto-idle-triggered'));

// The critical termination property: a second stop must NOT block again.
({ decision } = run(d));
check('auto + all done, second stop → approve (idle is one-shot)', decision?.decision === 'approve');
check('idle marker cleared', !exists(d, 'auto-idle-triggered'));
// ---------------------------------------- needs-setup: blocked on a HUMAN
//
// [measured 2026-08-28] auto/SKILL.md instructs sessions to write
// passes: "needs-setup" for work blocked on an API key, a vendor, or a console
// nobody has opened. This hook counted it as pending, so a story waiting on the
// OPERATOR made the session unable to end its own turn — the same failure
// `deferred` was given its own state to prevent, repeated with a new value.
//
// Under the old predicate this fixture produced:
//   "1 tasks remaining. Next: S2. Continue working."
// which told the session to keep re-attempting a credential it cannot supply.
{
    const d = project({ auto: true, prd: { stories: {
        S1: { title: 'done', passes: true },
        S2: { title: 'blocked on an API key', passes: 'needs-setup' },
    } } });
    const { decision, r } = run(d);
    const said = (r.stdout || '') + (r.stderr || '');
    check('needs-setup does NOT count as remaining work',
        !/tasks remaining/.test(said));
    check('...and the sprint reads complete instead',
        /Sprint complete/.test(said));
    // The other half: it must not silently vanish either. A human is still on the
    // hook for it, and a report that omits it says the sprint is finished when it
    // is waiting on him.
    check('...and the reason names it rather than dropping it',
        /setup|blocked/i.test(said) || decision !== null);
}
{
    // The known-positive control, through the identical path. Without it, both
    // assertions above pass against a hook that never blocks at all.
    const d = project({ auto: true, prd: { stories: {
        S1: { title: 'done', passes: true },
        S2: { title: 'genuinely pending', passes: null },
    } } });
    const { decision } = run(d);
    check('CONTROL: a genuinely pending story still blocks',
        decision && decision.decision === 'block');
}
{
    // And a mix: one actionable, one blocked on a human. The actionable one must
    // still be found — needs-setup must not suppress real work beside it.
    const d = project({ auto: true, prd: { stories: {
        S1: { title: 'real work', passes: false },
        S2: { title: 'blocked on a key', passes: 'needs-setup' },
    } } });
    const { r } = run(d);
    check('a mix still reports the actionable story',
        /1 tasks? remaining/.test((r.stdout || '') + (r.stderr || '')));
}

check('auto flag cleared after idle', !exists(d, 'auto-active'));

// And a third stop, with the flag gone, still approves.
({ decision } = run(d));
check('third stop → approve', decision?.decision === 'approve');

// ------------------------------------------------- deferred stories terminate

// `deferred` means "not doing this now". Counting it as remaining work makes
// auto mode block forever on a sprint that is, in fact, finished — the 2h stale
// flag was the only escape.
d = project({ auto: true, prd: SPRINT_DEFERRED });
({ decision } = run(d));
// It may still block once for idle detection — that is the normal
// sprint-complete path — but it must not claim there is work outstanding.
check('auto + only deferred left → not counted as remaining work',
    !/tasks remaining/.test(decision?.reason || ''));

// Drive it to completion the same way the idle path terminates.
let guard = 0;
while (decision?.decision === 'block' && guard++ < 5) ({ decision } = run(d));
check('deferred sprint reaches approve within a few stops', decision?.decision === 'approve');

// ---------------------------------------------------------------- exit signal

d = project({ auto: true, idle: true, prd: SPRINT_PENDING, exit: true });
({ decision } = run(d));
check('auto-exit → approve even with pending work', decision?.decision === 'approve');
check('auto-exit consumes the exit flag', !exists(d, 'auto-exit'));
check('auto-exit clears the auto flag', !exists(d, 'auto-active'));
check('auto-exit clears the idle marker', !exists(d, 'auto-idle-triggered'));

// ---------------------------------------------------------------- stale flag

d = project({ auto: true, prd: SPRINT_PENDING, autoAgeMs: 3 * 60 * 60 * 1000 });
({ decision } = run(d));
check('auto flag older than 2h → approve', decision?.decision === 'approve');
check('stale auto flag removed', !exists(d, 'auto-active'));

// A flag just inside the window still blocks.
d = project({ auto: true, prd: SPRINT_PENDING, autoAgeMs: 60 * 60 * 1000 });
({ decision } = run(d));
check('auto flag younger than 2h still blocks', decision?.decision === 'block');

// ---------------------------------------------------------------- no prd.json

d = project({ auto: true });
({ decision } = run(d));
check('auto flag with no prd.json → approve', decision?.decision === 'approve');
check('auto flag with no prd.json is cleaned up', !exists(d, 'auto-active'));

// ---------------------------------------------------------------- bad input

// A malformed prd.json must not strand the session in auto mode.
d = project({ auto: true, prd: '{ not json' });
({ r, decision } = run(d));
check('malformed prd.json → exit 0', r.status === 0);
check('malformed prd.json → does not block forever', decision?.decision === 'approve');
check('malformed prd.json clears the auto flag', !exists(d, 'auto-active'));

// Malformed stdin must still produce a decision.
d = project({ prd: SPRINT_PENDING });
r = spawnSync(process.execPath, [HOOK], {
    input: 'not json', encoding: 'utf8', cwd: d,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
});
let parsed = null;
try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
check('malformed stdin → exit 0', r.status === 0);
check('malformed stdin → still approves', parsed?.decision === 'approve');

// ---------------------------------------------------------------- payload cwd

// The hook must act on the project Claude is working in, not on the shell that
// spawned it.
const other = project({ auto: true, prd: SPRINT_PENDING });
const elsewhere = path.join(TMP, 'elsewhere');
fs.mkdirSync(elsewhere, { recursive: true });
r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's', cwd: other, hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: elsewhere,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
});
try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
check('uses payload cwd, not process cwd', parsed?.decision === 'block');

// ------------------------------------------- stale stories are not active work
//
// A pending story nobody has edited in months is a decision not to do the work
// that nobody wrote down. Ages come from the cache drift-audit writes; every
// failure path must fail OPEN (skip nothing), because the damage from skipping
// real work exceeds the damage from blocking on stale work.

const STALE_PRD = {
    stories: {
        'S1-001': { title: 'done', passes: true },
        'S1-002': { title: 'ancient', passes: null },
        'S1-003': { title: 'active', passes: null },
    },
};

// Writes an isolated CLAUDE_CONFIG_DIR carrying an age cache for `dir`.
function withAges(dir, ages, { computedAt = new Date().toISOString() } = {}) {
    const cfg = path.join(TMP, 'cfg' + Math.random().toString(36).slice(2));
    fs.mkdirSync(path.join(cfg, 'autodev'), { recursive: true });
    fs.writeFileSync(
        path.join(cfg, 'autodev', 'prd-story-ages.json'),
        JSON.stringify({ [fs.realpathSync(dir)]: { computedAt, scanDepth: 120, ages } })
    );
    return cfg;
}

function runWithCfg(dir, cfg) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ session_id: 's', cwd: dir, hook_event_name: 'Stop' }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: cfg },
    });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* stays null */ }
    return { out, stderr: r.stderr || '' };
}

// One story stale, one fresh → auto keeps working on the fresh one only.
{
    const dir = project({ auto: true, prd: STALE_PRD });
    const cfg = withAges(dir, { 'S1-002': 200, 'S1-003': 2 });
    const { out } = runWithCfg(dir, cfg);
    check('stale story excluded: blocks on the fresh one', out?.decision === 'block');
    check('  names the ACTIVE story, not the stale one',
        /S1-003/.test(out?.reason || '') && !/Next: S1-002/.test(out?.reason || ''));
    check('  counts 1 remaining, not 2', /\b1 tasks remaining/.test(out?.reason || ''));
}

// Every pending story stale → the sprint reads as complete, and says what it set aside.
{
    const dir = project({ auto: true, prd: STALE_PRD });
    const cfg = withAges(dir, { 'S1-002': 200, 'S1-003': 99 });
    const { out, stderr } = runWithCfg(dir, cfg);
    check('all pending stale → falls through to sprint-complete',
        /Sprint complete/.test(out?.reason || ''));
    check('  NOT silent: names both skipped stories in the reason',
        /S1-002/.test(out?.reason || '') && /S1-003/.test(out?.reason || ''));
    check('  tells Claude they are still pending, not done',
        /still pending in prd\.json/.test(out?.reason || ''));
    check('  logs the skip to stderr too', /untouched >30d/.test(stderr));
}

// `null` age = older than the audit's scan reached. The oldest class, not unknown.
{
    const dir = project({ auto: true, prd: STALE_PRD });
    const cfg = withAges(dir, { 'S1-002': null, 'S1-003': 1 });
    const { out } = runWithCfg(dir, cfg);
    check('null age treated as very old, not as unknown',
        /\b1 tasks remaining/.test(out?.reason || '') && /S1-003/.test(out?.reason || ''));
}

// --- fail-open paths: each must skip NOTHING

{
    const dir = project({ auto: true, prd: STALE_PRD });
    const cfg = path.join(TMP, 'cfg-empty');
    fs.mkdirSync(cfg, { recursive: true });
    const { out } = runWithCfg(dir, cfg);
    check('no cache at all → skips nothing (2 remaining)', /\b2 tasks remaining/.test(out?.reason || ''));
}

{
    const dir = project({ auto: true, prd: STALE_PRD });
    // 30 days old, past CACHE_MAX_AGE_DAYS.
    const cfg = withAges(dir, { 'S1-002': 200, 'S1-003': 200 },
        { computedAt: new Date(Date.now() - 30 * 86400000).toISOString() });
    const { out } = runWithCfg(dir, cfg);
    check('cache older than 14d → skips nothing', /\b2 tasks remaining/.test(out?.reason || ''));
}

{
    const dir = project({ auto: true, prd: STALE_PRD });
    const cfg = path.join(TMP, 'cfg-corrupt');
    fs.mkdirSync(path.join(cfg, 'autodev'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'autodev', 'prd-story-ages.json'), '{ not json');
    const { out } = runWithCfg(dir, cfg);
    check('corrupt cache → skips nothing', /\b2 tasks remaining/.test(out?.reason || ''));
}

{
    const dir = project({ auto: true, prd: STALE_PRD });
    // A cache that describes a DIFFERENT repo must not be applied to this one.
    const cfg = path.join(TMP, 'cfg-other');
    fs.mkdirSync(path.join(cfg, 'autodev'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'autodev', 'prd-story-ages.json'),
        JSON.stringify({ '/some/other/repo': { computedAt: new Date().toISOString(), ages: { 'S1-002': 200, 'S1-003': 200 } } }));
    const { out } = runWithCfg(dir, cfg);
    check('cache keyed to another repo → skips nothing', /\b2 tasks remaining/.test(out?.reason || ''));
}

{
    const dir = project({ auto: true, prd: STALE_PRD });
    // A story the audit never measured is not skippable.
    const cfg = withAges(dir, { 'S1-002': 200 });
    const { out } = runWithCfg(dir, cfg);
    check('story absent from the cache → still active', /\b1 tasks remaining/.test(out?.reason || '')
        && /S1-003/.test(out?.reason || ''));
}

// ------------------------------------------------- gaps found by check:vacuity
//
// Every case below was found by mutating this hook one decision at a time and
// noticing that no assertion changed colour. Each is named with the line whose
// mutant survived.

// line 94 — `if (!fs.existsSync(prdPath))`. Forcing this branch to `false` left
// every assertion green: nothing exercised auto-mode-with-no-prd, which is the
// path that DELETES the auto-active flag. A hook that fails to clean up here
// leaves auto armed in a directory it can never make progress in.
{
    const dir = project({ auto: true });   // auto on, no prd.json at all
    const { r } = run(dir);
    check('no prd.json: removes the auto-active flag', !exists(dir, 'auto-active'));
    check('  and says why', /No prd\.json found/.test(r.stderr || ''));
}

// line 157 — `s.passes === 'deferred'`. Flipping it to `!==` survived: the
// termination was asserted but the COUNT never was, so the number Claude is
// told about could be any value at all.
//
// The fixture needs an UNEQUAL split. SPRINT_DEFERRED is one done and one
// deferred, so `passes === 'deferred'` counts 1 and `passes !== 'deferred'` also
// counts 1 — the mutant produces an identical message and survives. Two deferred
// against one done tells them apart: 2 versus 1.
{
    const TWO_DEFERRED = {
        stories: {
            'S1-001': { title: 'a', passes: true },
            'S1-002': { title: 'b', passes: 'deferred' },
            'S1-003': { title: 'c', passes: 'deferred' },
        },
    };
    const dir = project({ auto: true, prd: TWO_DEFERRED });
    const { r } = run(dir);
    check('deferred stories are counted in the sprint-complete line',
        /Sprint complete \(2 deferred\)/.test(r.stderr || ''));
}

// line 140 — `if (skipped.length > 0)`. Forcing it to `true` survived: no
// assertion read the message that names which stories were set aside. Silently
// skipping work is how a backlog rots without anyone deciding to let it, so the
// naming is the point of the branch.
{
    const dir = project({ auto: true, prd: STALE_PRD });
    const cfg = withAges(dir, { 'S1-002': 200, 'S1-003': 400 });
    const { stderr } = runWithCfg(dir, cfg);
    check('skipped stories are named, not just counted',
        /untouched >30d/.test(stderr) && /S1-002/.test(stderr) && /S1-003/.test(stderr));

    // And the negative case, without which `if (true)` satisfies the assertion
    // above and survives. Asserting only that a message APPEARS never tests the
    // condition guarding it — it tests the message.
    const clean = project({ auto: true, prd: SPRINT_DONE });
    const cleanCfg = withAges(clean, {});
    const { stderr: quiet } = runWithCfg(clean, cleanCfg);
    check('  and nothing is reported when no story was skipped',
        !/untouched >30d/.test(quiet));
}

// line 41 — `all[here] || all[cwd]`. Changing `||` to `&&` survived, because no
// test ever reached the fallback: every cache written by withAges is keyed by
// the REAL path, so `all[here]` always hit. The fallback exists for the case the
// comment above it describes — a repo reached through a symlink — and that case
// had no test at all.
{
    const real = project({ auto: true, prd: STALE_PRD });
    const link = path.join(TMP, 'link' + (++n));
    let symlinked = true;
    try { fs.symlinkSync(real, link, 'dir'); } catch { symlinked = false; }

    if (!symlinked) {
        check('symlinked cwd falls back to the un-resolved path (SKIPPED: no symlink support)', true);
    } else {
        // Keyed by the SYMLINK path only, so the realpath lookup must miss.
        const cfg = path.join(TMP, 'cfglink');
        fs.mkdirSync(path.join(cfg, 'autodev'), { recursive: true });
        // BOTH pending stories stale, so nothing is left active. The
        // "untouched >30d" line sits after an early `block()` that fires
        // whenever any active work remains — the first version of this test
        // marked only one story stale, so it blocked on the other and never
        // reached the line it was asserting on. The mechanism was right and the
        // assertion was wrong.
        fs.writeFileSync(path.join(cfg, 'autodev', 'prd-story-ages.json'), JSON.stringify({
            [link]: {
                computedAt: new Date().toISOString(), scanDepth: 120,
                ages: { 'S1-002': 200, 'S1-003': 400 },
            },
        }));
        const { stderr } = runWithCfg(link, cfg);
        check('a cache keyed by the symlink path is still found',
            /untouched >30d/.test(stderr) && /S1-002/.test(stderr));
    }
}

// line 42 — `if (!entry || !entry.ages)`. Changing `||` to `&&` survived: no
// cache entry in any test lacked `ages`, so the guard protecting the `id in
// entry.ages` lookup below was never the thing that returned. Without it that
// lookup throws, and the catch turns a malformed cache into "nothing is stale" —
// which is the safe direction, but only by accident rather than by this guard.
{
    const dir = project({ auto: true, prd: STALE_PRD });
    const cfg = path.join(TMP, 'cfgnoages');
    fs.mkdirSync(path.join(cfg, 'autodev'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'autodev', 'prd-story-ages.json'), JSON.stringify({
        [fs.realpathSync(dir)]: { computedAt: new Date().toISOString(), scanDepth: 120 },
    }));
    const { out, stderr } = runWithCfg(dir, cfg);
    check('a cache entry with no ages skips nothing',
        out?.decision === 'block' && !/untouched >30d/.test(stderr));
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
