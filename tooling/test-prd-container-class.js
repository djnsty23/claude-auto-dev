#!/usr/bin/env node
// CLASS TEST — every reader of prd.json must find the same stories in it,
// whichever of the two documented containers the file uses.
//
// prd.json has two legal shapes. This is the spec, quoted from
// autodev-core/skills/auto/SKILL.md:127-129, which is where the nested one is
// documented and is deliberately the ONLY source this file was written from:
//
//     // prd.json has two shapes:
//     // Flat:   { stories: { "S1-001": {...} }, sprint: "sprint-1" }
//     // Nested: { sprints: [{ id: "sprint-1", stories: { "S1-001": {...} } }] }
//
// Five call sites read that container, and each was written independently:
//
//     stop-auto-check.js:160          the Stop hook — can end a turn
//     session-start.js:124            the injected backlog line
//     drift-audit.js:443              auditPrd(), picks the pending set
//     drift-audit.js:280              storyValues(), ages those stories
//     memory-session-end.js:44        the summary the NEXT session reads
//
// WHY A CLASS TEST. `passes` was a per-reader guess about story STATE and five
// readers each guessed differently; prd-states.js exists because of it. The
// container is the same defect one level up — a per-reader guess about WHERE
// the stories are — and it was found the same way, one reader at a time. This
// file asserts the property for all five at once so the next one cannot drift.
//
// ---------------------------------------------------------------------------
// THE INVARIANT, and why it is not "all five report the same number".
//
// The five sites legitimately DISAGREE about which stories count, because they
// answer different questions. stop-auto-check and auditPrd want isActionable
// (work an agent can pick up). memory-session-end wants isOutstanding (work a
// human is still owed) and says so in a comment. session-start reports every
// state separately. Asserting a single shared number would encode THIS file's
// re-derivation of each site's predicate — and a test that re-derives its
// subject's logic agrees with the derivation, not with reality.
//
// So each site is its own oracle:
//
//     for every site:  observable(nested) === observable(flat)
//
// The predicate cancels out; only the container is under test. This file never
// asserts what any site SHOULD count, and so cannot be wrong about it.
//
// ---------------------------------------------------------------------------
// TWO WAYS THIS TEST COULD PASS WHILE PROVING NOTHING, both guarded below.
//
// 1. VACUOUS AGREEMENT. If the flat run also yields nothing, then
//    `null === null` passes and reports agreement on emptiness. Guarded by
//    NON-VACUITY: every flat observable must be non-empty and must contain a
//    non-zero count before any comparison is believed.
//
// 2. A DEAD PROBE. If a regex never matches, or a site is driven wrongly, its
//    observable is a constant — and a constant agrees with itself in every
//    shape. That is this bug's own signature (a reader that cannot tell "none"
//    from "none in the part I looked at") reproduced in the instrument that
//    hunts it. Guarded by LIVENESS: each probe is run against a SECOND, smaller
//    flat fixture and must return a DIFFERENT observable. A probe that cannot
//    tell two different flat files apart is reported as broken, not as passing.
//
// Liveness runs FIRST. A dead probe invalidates its own agreement result, so
// its container verdict is suppressed rather than reported as a pass.
//
// ---------------------------------------------------------------------------
// Run:  node test-prd-container-class.js
// Env:  AUTODEV_PLUGINS  -> .../marketplaces/autodev/plugins   (default: the
//       installed marketplace). Both plugin dirs are resolved from it, because
//       memory-session-end.js lives in autodev-memory, a DIFFERENT plugin from
//       the other four, and cannot be reached by a core-relative path.

'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Defaults to this repo's own plugins/, like every other file in tooling/.
// AUTODEV_PLUGINS points it at another tree (an installed marketplace, or a
// candidate build) without editing anything.
const PLUGINS = process.env.AUTODEV_PLUGINS || path.resolve(__dirname, '..', 'plugins');
const CORE = path.join(PLUGINS, 'autodev-core');
const MEMORY = path.join(PLUGINS, 'autodev-memory');

const HOOK_STOP = path.join(CORE, 'hooks', 'stop-auto-check.js');
const HOOK_START = path.join(CORE, 'hooks', 'session-start.js');
const DRIFT = path.join(CORE, 'scripts', 'drift-audit.js');
const HOOK_MEMEND = path.join(MEMORY, 'hooks', 'memory-session-end.js');

for (const f of [HOOK_STOP, HOOK_START, DRIFT, HOOK_MEMEND]) {
    if (!fs.existsSync(f)) {
        console.error(`cannot find ${f}\nset AUTODEV_PLUGINS to the marketplace plugins dir`);
        process.exit(2);
    }
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prd-container-')));
let seq = 0;
const scratch = (tag) => {
    const d = path.join(TMP, `${tag}-${++seq}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
};

// ---------------------------------------------------------------- fixtures

// All five states present, so a CONTAINER fault and a STATE fault cannot be
// confused: a reader that lost the container reports nothing at all, while a
// reader that mishandled one state still reports the other four.
const STORIES_FULL = {
    'S1-001': { title: 'pending one', passes: null },
    'S1-002': { title: 'pending two', passes: null },
    'S1-003': { title: 'pending three', passes: null },
    'S1-004': { title: 'failed one', passes: false },
    'S1-005': { title: 'deferred one', passes: 'deferred' },
    'S1-006': { title: 'needs setup one', passes: 'needs-setup' },
    'S1-007': { title: 'done one', passes: true },
    'S1-008': { title: 'done two', passes: true },
};

// The liveness fixture. Deliberately a different size and mix, so any live
// probe must report something different for it.
const STORIES_SMALL = {
    'S1-001': { title: 'pending one', passes: null },
    'S1-007': { title: 'done one', passes: true },
};

// The two containers, exactly as auto/SKILL.md documents them.
const flat = (stories) => ({ sprint: 'sprint-1', stories });
const nested = (stories) => ({ sprints: [{ id: 'sprint-1', stories }] });

// ---------------------------------------------------------------------------
// MULTI-SPRINT — the case the single-sprint fixture above CANNOT SEE.
//
// A nested file with one sprint reads identically whether a reader flattens
// every sprint or takes only the last one. So the agreement block below passes
// under both semantics, and passing there is not evidence for either. This
// file's first version stopped at that point and reported green; the green was
// real for the container question and silent on this one.
//
// The separating input is pending work in an EARLIER sprint. Under last-sprint
// -only it is invisible: summarise().actionable is 0 and the Stop hook approves
// the stop — the original bug with a narrower trigger. Under flatten-all it is
// counted, which is the answer that cannot silently drop work.
//
// [measured 2026-08-29] against this exact fixture:
//   flatten-all     -> {total:3, actionable:2}  Stop: "2 tasks remaining"
//   last-sprint-only-> {total:1, actionable:0}  Stop: "Sprint complete"
//
// The invariant is the same one as above, extended: a nested file must read the
// same as the FLAT file holding the union of its sprints. That follows from the
// property already under test — moving stories between containers must not
// change what a reader finds — and it happens to pin the semantics, which the
// one-line contract in auto/SKILL.md does not.
const CARRIED = {
    'S0-001': { title: 'carried pending', passes: null },
    'S0-002': { title: 'carried failed', passes: false },
    'S0-003': { title: 'carried needs setup', passes: 'needs-setup' },
};
const CURRENT = {
    'S1-001': { title: 'current pending', passes: null },
    'S1-007': { title: 'current done', passes: true },
};
const multiNested = () => ({ sprints: [
    { id: 'sprint-0', stories: CARRIED },
    { id: 'sprint-1', stories: CURRENT },
] });
// The union, in the shape every reader already agrees about.
const multiFlatUnion = () => flat({ ...CARRIED, ...CURRENT });

// ------------------------------------------------------------ probe: stop

// Observable: the number of remaining tasks the hook believes in. "Sprint
// complete" is that number reaching zero, so it normalises to 0 rather than to
// a separate token — the whole point is that zero is a COUNT here.
function probeStop(prd) {
    const dir = scratch('stop');
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'auto-active'), '');
    fs.writeFileSync(path.join(dir, 'prd.json'), JSON.stringify(prd));
    const r = spawnSync(process.execPath, [HOOK_STOP], {
        input: JSON.stringify({ session_id: 's', cwd: dir, hook_event_name: 'Stop' }),
        encoding: 'utf8', cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: CORE },
    });
    let d = null;
    try { d = JSON.parse(r.stdout); } catch { return null; }
    if (!d || !d.decision) return null;
    const m = /(\d+) tasks remaining/.exec(d.reason || '');
    if (m) return { remaining: Number(m[1]) };
    if (/Sprint complete/.test(d.reason || '')) return { remaining: 0 };
    return null;
}

// ----------------------------------------------------------- probe: start

// Observable: the per-state counts in the line injected into every session.
function probeStart(prd) {
    const dir = scratch('start');
    fs.writeFileSync(path.join(dir, 'prd.json'), JSON.stringify(prd));
    const r = spawnSync(process.execPath, [HOOK_START], {
        input: JSON.stringify({ session_id: 's', cwd: dir, hook_event_name: 'SessionStart' }),
        encoding: 'utf8', cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: CORE },
    });
    let d = null;
    try { d = JSON.parse(r.stdout); } catch { return null; }
    const text = (d && d.systemMessage) || '';
    // The sprint NAME is deliberately not part of the observable: flat carries
    // it on `sprint` and nested on `sprints[].id`, so comparing it would fail
    // for a reason that has nothing to do with finding the stories.
    //
    // Each count is read on its own rather than with one whole-line regex. The
    // line is not fixed-shape: it appends ", N blocked on setup" only when a
    // needs-setup story exists. A single regex over the whole line matched the
    // fixture WITHOUT needs-setup and returned null for the one WITH it — so
    // the richer fixture read as "no counts at all", which is indistinguishable
    // from the container bug being hunted. The liveness guard caught it.
    const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null; };
    const total = num(/\((\d+) total\)/);
    if (total === null) return null;
    return {
        done: num(/(\d+) done/), pending: num(/(\d+) pending/),
        failed: num(/(\d+) FAILED/), deferred: num(/(\d+) deferred/),
        blockedOnSetup: num(/(\d+) blocked on setup/) || 0,
        total,
    };
}

// ----------------------------------------------------------- probe: drift

// drift-audit is a whole-machine scan, so it is given a sandboxed HOME and
// CLAUDE_CONFIG_DIR and discovers exactly one repo — the fixture. It is
// account-agnostic by design (its header says so), which is what makes this
// hermetic rather than dependent on the real machine's projects.
//
// One run exercises BOTH of its call sites, and they are observed separately:
//   auditPrd (:443)    chooses the pending id set  -> the KEYS of the cache
//   storyValues (:280) ages each of those stories  -> the VALUES of the cache
// If auditPrd loses the container it returns early and no cache entry is
// written at all; if storyValues loses it, the keys survive and the ages do not.
function probeDrift(prd) {
    const home = scratch('drift');
    const cfg = path.join(home, 'cfg');
    const repo = path.join(home, 'repo');
    fs.mkdirSync(path.join(cfg, 'projects', '-repo'), { recursive: true });
    fs.mkdirSync(repo, { recursive: true });

    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
    git('init', '-q', '.');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'prd.json'), JSON.stringify(prd));
    git('add', '-A'); git('commit', '-qm', 'one');
    // A second revision that edits EVERY story, so ages come from real history
    // rather than from a single commit.
    //
    // Editing only the first story made this probe blind: the first key is
    // 'S1-001' in both fixtures, so exactly one id resolved in both and the
    // observable was the constant {resolved:['S1-001']}. A constant agrees with
    // itself in every container, which is this bug's own signature reproduced
    // in the instrument hunting it. The liveness guard caught it. Editing all
    // of them makes `resolved` track the pending set's SIZE, which differs
    // between the two flat fixtures.
    // EVERY sprint's stories, not just the last one. Editing only
    // `sprints[last]` left earlier-sprint stories unchanged across the whole
    // scanned history, so their age resolved to null and this probe reported
    // that the SUBJECT had dropped them. It had not — the fixture generator had.
    // That is the same last-sprint-wins assumption this test exists to catch,
    // reproduced in the harness, and it produced a false finding against a
    // correct implementation before it was caught.
    const touched = JSON.parse(JSON.stringify(prd));
    const bags = touched.sprints
        ? touched.sprints.map((s) => s.stories).filter(Boolean)
        : [touched.stories];
    for (const bag of bags) {
        for (const id of Object.keys(bag)) bag[id].title += ' (edited)';
    }
    fs.writeFileSync(path.join(repo, 'prd.json'), JSON.stringify(touched));
    git('add', '-A'); git('commit', '-qm', 'two');

    // Discovery reads the real cwd out of a session transcript.
    fs.writeFileSync(path.join(cfg, 'projects', '-repo', 't.jsonl'),
        JSON.stringify({ cwd: repo }) + '\n');

    spawnSync(process.execPath, [DRIFT, '--json'], {
        encoding: 'utf8', cwd: home,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg },
    });

    let cache = null;
    try { cache = JSON.parse(fs.readFileSync(path.join(cfg, 'autodev', 'prd-story-ages.json'), 'utf8')); }
    catch { return { auditPrd: null, storyValues: null }; }
    const entry = cache[repo] || cache[fs.realpathSync(repo)];
    if (!entry || !entry.ages) return { auditPrd: null, storyValues: null };

    return {
        // The pending set auditPrd chose.
        auditPrd: { ids: Object.keys(entry.ages).sort() },
        // Whether storyValues could actually resolve each of them. The age
        // NUMBER is not comparable across runs (it is wall-clock days), so the
        // observable is which ids resolved to a value at all — `null` from
        // storyValues means "never seen in the scanned history", which is
        // exactly what a lost container produces for every story at once.
        storyValues: {
            resolved: Object.entries(entry.ages)
                .filter(([, v]) => v !== null).map(([k]) => k).sort(),
        },
    };
}

// ---------------------------------------------------------- probe: memory

// memory-session-end.js lives in autodev-memory. It is run REAL and unmodified;
// only its two collaborators are stubbed, because the observable — the summary
// handed to the memory store — is otherwise written into a database. The
// container read under test (line 44) is the hook's own code.
function probeMemory(prd) {
    const dir = scratch('mem');
    const root = path.join(dir, 'root');
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    const capture = path.join(dir, 'captured.json');

    fs.writeFileSync(path.join(root, 'scripts', 'memory-db.js'),
        'const fs=require("fs");\n'
        + 'module.exports={isAvailable:()=>true,'
        + 'endSession:(id,s)=>fs.writeFileSync(process.env.PRD_CONTAINER_CAPTURE,JSON.stringify(s))};\n');
    fs.writeFileSync(path.join(root, 'scripts', 'session-carrier.js'),
        'module.exports={read:()=>"sess-1",clear:()=>{},clearPrompt:()=>{}};\n');
    fs.writeFileSync(path.join(proj, 'prd.json'), JSON.stringify(prd));

    spawnSync(process.execPath, [HOOK_MEMEND], {
        input: JSON.stringify({ session_id: 'h1', cwd: proj, hook_event_name: 'SessionEnd' }),
        encoding: 'utf8', cwd: proj,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PRD_CONTAINER_CAPTURE: capture },
    });

    let s = null;
    try { s = JSON.parse(fs.readFileSync(capture, 'utf8')); } catch { return null; }
    const m = /(\d+) tasks remaining: (.*)$/.exec(s.nextSteps || '');
    return {
        // `completed` is the done-story half; it comes from the same container
        // read, so losing the container empties it too.
        completed: s.completed || '',
        remaining: m ? Number(m[1]) : 0,
        ids: m ? m[2].split(', ').sort() : [],
    };
}

// ------------------------------------------------------------------ sites

const SITES = [
    { name: 'stop-auto-check.js:160', where: 'autodev-core',   probe: probeStop,
      note: 'the Stop hook — a wrong answer ends a turn that should have continued' },
    { name: 'session-start.js:124',   where: 'autodev-core',   probe: probeStart,
      note: 'frames every session\'s view of its own backlog before anyone asks' },
    { name: 'drift-audit.js:443',     where: 'autodev-core',   probe: (p) => probeDrift(p).auditPrd,
      note: 'auditPrd() — chooses the pending set' },
    { name: 'drift-audit.js:280',     where: 'autodev-core',   probe: (p) => probeDrift(p).storyValues,
      note: 'storyValues() — ages the stories; feeds the cache the Stop hook trusts' },
    { name: 'memory-session-end.js:44', where: 'autodev-memory', probe: probeMemory,
      note: 'the summary the NEXT session reads as fact' },
];

// A count is "real" if the observable carries a non-zero number or a non-empty
// list somewhere. This is what stops `nothing === nothing` counting as
// agreement.
function isSubstantive(o) {
    if (o === null || o === undefined) return false;
    return Object.values(o).some((v) => {
        if (typeof v === 'number') return v > 0;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'string') return v.length > 0;
        return false;
    });
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (o) => (o === null ? 'NOTHING' : JSON.stringify(o));

// ------------------------------------------------------------------- run

const results = [];
for (const site of SITES) {
    const r = { site, live: false, vacuous: true, agrees: false };
    r.flat = site.probe(flat(STORIES_FULL));
    r.small = site.probe(flat(STORIES_SMALL));
    // LIVENESS first: two different flat files must look different.
    r.live = r.flat !== null && r.small !== null && !eq(r.flat, r.small);
    r.vacuous = !isSubstantive(r.flat);
    r.nested = site.probe(nested(STORIES_FULL));
    r.agrees = eq(r.flat, r.nested);
    results.push(r);
}

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

console.log('PROBE LIVENESS — can each probe tell two different FLAT files apart?');
console.log('  (a probe that cannot is blind, and its agreement result means nothing)\n');
for (const r of results) {
    console.log(`  ${r.live ? 'live' : 'DEAD'}  ${r.site.name}`);
    if (!r.live) {
        console.log(`        8-story: ${show(r.flat)}`);
        console.log(`        2-story: ${show(r.small)}`);
    }
    check(`probe is live (distinguishes two flat files): ${r.site.name}`, r.live);
}

console.log('\nNON-VACUITY — does the FLAT run actually find work?');
console.log('  (if it finds none, agreement is agreement on emptiness)\n');
for (const r of results) {
    console.log(`  ${r.vacuous ? 'VACUOUS' : 'ok     '}  ${r.site.name}  ${show(r.flat)}`);
    check(`flat run is substantive: ${r.site.name}`, !r.vacuous);
}

console.log('\nCONTAINER AGREEMENT — same stories, nested container.');
console.log('  invariant: observable(nested) === observable(flat), per site\n');
for (const r of results) {
    const valid = r.live && !r.vacuous;
    console.log(`  ${!valid ? 'UNTESTED' : r.agrees ? 'agrees  ' : 'DIFFERS '}  ${r.site.name}  [${r.site.where}]`);
    if (valid && !r.agrees) {
        console.log(`        flat:   ${show(r.flat)}`);
        console.log(`        nested: ${show(r.nested)}`);
        console.log(`        ${r.site.note}`);
    }
    // A site whose probe is dead or vacuous is NOT reported as passing — its
    // verdict is unknown, and unknown is a failure here. Reporting it green is
    // the exact error this whole file exists to catch.
    check(`nested container finds the same stories as flat: ${r.site.name}`,
        valid && r.agrees);
}

console.log('\nMULTI-SPRINT — pending work in an EARLIER sprint.');
console.log('  invariant: observable(multi-sprint nested) === observable(flat union)');
console.log('  this is the case the single-sprint block above cannot see\n');
for (const r of results) {
    const union = r.site.probe(multiFlatUnion());
    const multi = r.site.probe(multiNested());
    // Same two guards. A non-substantive union baseline would make this agree
    // on emptiness exactly as before.
    const substantive = isSubstantive(union);
    const agrees = eq(union, multi);
    console.log(`  ${!substantive ? 'UNTESTED' : agrees ? 'agrees  ' : 'DIFFERS '}  ${r.site.name}`);
    if (substantive && !agrees) {
        console.log(`        flat union:   ${show(union)}`);
        console.log(`        multi-sprint: ${show(multi)}`);
        console.log('        earlier-sprint work is being dropped');
    }
    check(`earlier-sprint work survives the nested container: ${r.site.name}`,
        substantive && agrees);
}

console.log('\n---------------------------------------------------------------\n');
let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
