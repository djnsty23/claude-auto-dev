#!/usr/bin/env node
'use strict';
// test-skill-dispositions.js - every skill has a deliberate disposition.
//
// docs/skill-dispositions.json gives each skill in plugins/<plugin>/skills a
// proposed retain, merge or retire, with measured fire counts and a reason.
// This suite checks the manifest against the tree:
//
//   inventoried=classified       every skill on disk has exactly one valid
//                                entry, and every entry names a skill on disk
//   orphan_references=N          shipped files and the manifest's merge hosts
//                                that point at a skill not on disk
//   retained_emergency_drills    the drills below exist, are flagged and are
//                                proposed for retain
//   hooks_with_because=N/M       every hook wired in a hooks.json names the
//                                model weakness or harness gap it exists for,
//                                and a model reason names its retest
//
// The retest report (--retest --model <id>) is checked on planted fixtures:
// a new model makes it due, a rule with no reason in the sidecar is named,
// and a sidecar line for a deleted rule is reported as stale.
//
// The drill list is a literal, not read from the manifest, so dropping a
// drill's flag or proposing it for retirement cannot shrink the check with it.
// Frequency alone never retires a skill: the module refuses a merge without a
// host and a retire without what covers its job.
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('./skill-dispositions.js');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_DRILLS = ['production-radar', 'heal', 'security', 'adversarial-loop', 'setup-project', 'doppler', 'stripe'];

const lines = [];
const failures = [];
const check = (name, ok, detail) => {
    if (ok) lines.push(`ok ${name}`);
    else { lines.push(`FAIL ${name}${detail ? ` (${detail})` : ''}`); failures.push(name); }
};

const fires = { model: 0, typed: 0, preload: 0 };
const entry = (name, extra = {}) => Object.assign({ plugin: 'autodev-core', name, invocable: true, status: 'proposed', disposition: 'retain',
    reason: 'a reason long enough to read as one', evidence: { fires30d: fires } }, extra);

// Controls: each detector must fire on a planted defect before its zero means anything.
const inv2 = [{ plugin: 'autodev-core', name: 'alpha' }, { plugin: 'autodev-core', name: 'beta' }];
check('control: an unclassified skill on disk is reported',
    D.classify(inv2, { skills: [entry('alpha')] }).problems.some((p) => p.includes('beta') && p.includes('not classified')));
check('control: an entry for a skill not on disk is reported',
    D.classify(inv2, { skills: [entry('alpha'), entry('beta'), entry('gamma')] }).problems.some((p) => p.includes('gamma')));
check('control: a merge without an existing host is refused',
    D.classify(inv2, { skills: [entry('alpha', { disposition: 'merge', mergeInto: 'nowhere' }), entry('beta')] }).problems.length === 1);
check('control: a retire on frequency alone, with nothing covering its job, is refused',
    D.classify(inv2, { skills: [entry('alpha', { disposition: 'retire' }), entry('beta')] }).problems.some((p) => p.includes('covers its job')));
check('control: an entry without measured fire counts is refused',
    D.classify(inv2, { skills: [entry('alpha', { evidence: {} }), entry('beta')] }).problems.some((p) => p.includes('fire counts')));
check('control: a clean two-skill manifest classifies with no problems',
    D.classify(inv2, { skills: [entry('alpha'), entry('beta', { disposition: 'merge', mergeInto: 'alpha' })] }).problems.length === 0);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-dispositions-'));
try {
    const f = 'plugins/autodev-core/skills/alpha/SKILL.md';
    fs.mkdirSync(path.join(scratch, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(scratch, f), [
        'See plugins/autodev-core/skills/beta/SKILL.md and plugins/autodev-core/skills/rule-*/.',
        'Load ${CLAUDE_PLUGIN_ROOT}/skills/ghost/references/x.md, then autodev-core:phantom.',
        'Dispatch autodev-core:reviewer-agent, or call Skill("spectre").',
    ].join('\n'));
    const o = D.orphanReferences(scratch, inv2, [{ plugin: 'autodev-core', name: 'reviewer-agent' }],
        { skills: [entry('alpha', { disposition: 'merge', mergeInto: 'wraith' })] }, [f]);
    const refs = o.hits.map((h) => h.ref).sort().join(',');
    check('control: planted orphans are found in all four forms and the manifest, and real skills, agents and globs are not',
        refs === 'Skill(spectre),autodev-core/ghost,autodev-core:phantom,wraith', refs);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
const planted = { skills: [entry('alpha', { disposition: 'retire', coveredBy: 'beta', drill: true })] };
check('control: a drill proposed for retirement fails the drill check',
    D.drillsRetained(inv2, planted, ['alpha']).verdict === 'FAIL');
check('control: a required drill missing from the manifest fails the drill check',
    D.drillsRetained(inv2, { skills: [] }, ['alpha']).verdict === 'FAIL');

// Hooks and rules: each names why it exists, so a model bump can retest it.
const wired2 = [{ plugin: 'autodev-core', file: 'a.js', events: ['Stop'] }, { plugin: 'autodev-core', file: 'b.js', events: ['SessionStart'] }];
const hook = (file, extra = {}) => Object.assign({ plugin: 'autodev-core', file, kind: 'model',
    because: 'The model ends a turn with work pending, so it stalls.', retest: 'Count stalled turns in 20 runs with it off.' }, extra);
check('control: a wired hook with no because is reported',
    D.classifyHooks(wired2, { hooks: [hook('a.js')] }).problems.some((p) => p.includes('b.js') && p.includes('no because')));
check('control: a because entry for an unwired hook is reported',
    D.classifyHooks(wired2, { hooks: [hook('a.js'), hook('b.js'), hook('c.js')] }).problems.some((p) => p.includes('c.js') && p.includes('not wired')));
check('control: a kind other than model or harness is refused',
    D.classifyHooks(wired2, { hooks: [hook('a.js', { kind: 'other' }), hook('b.js')] }).problems.length === 1);
check('control: a because too short to name a weakness is refused',
    D.classifyHooks(wired2, { hooks: [hook('a.js', { because: 'safety' }), hook('b.js')] }).problems.some((p) => p.includes('no because')));
check('control: a model reason without a retest is refused',
    D.classifyHooks(wired2, { hooks: [hook('a.js', { retest: '' }), hook('b.js')] }).problems.some((p) => p.includes('retest')));
check('control: a harness reason needs no retest, and a clean pair has no problems',
    D.classifyHooks(wired2, { hooks: [hook('a.js'), hook('b.js', { kind: 'harness', retest: '' })] }).problems.length === 0);

const rscratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-because-'));
try {
    const rules = path.join(rscratch, 'rules');
    fs.mkdirSync(rules);
    fs.writeFileSync(path.join(rules, 'with.md'), '# With\n\n- rule\n');
    fs.writeFileSync(path.join(rules, 'without.md'), '# Without\n\n- rule\n');
    fs.writeFileSync(path.join(rules, 'short.md'), '# Short\n\n- rule\n');
    fs.writeFileSync(path.join(rules, 'scoped.md'), '---\npaths:\n  - "**/*.css"\n---\n\n# Scoped\n');
    const side = path.join(rscratch, 'rules-because.md');
    fs.writeFileSync(side, ['# Why each rule exists', '',
        '- with.md | model | the model skips the check unless told.',
        '- short.md | model | safety',
        '- scoped.md | harness | the UI library drifts between screens.',
        '- gone.md | model | a rule that was deleted keeps its line here.'].join('\n'));
    const rows = D.rulesBecause(rules, side);
    const by = Object.fromEntries(rows.map((r) => [r.file, r]));
    check('control: a rule\'s reason is read from the sidecar, a missing or too-short one reads null, and a paths: rule is scoped',
        by['with.md'].because === 'the model skips the check unless told.' && by['with.md'].kind === 'model'
        && by['without.md'].because === null && by['short.md'].because === null
        && by['scoped.md'].scoped === true && by['with.md'].scoped === false, JSON.stringify(rows));
    check('control: a sidecar line for a rule that no longer exists is reported as stale', rows.stale.join() === 'gone.md', JSON.stringify(rows.stale));
    const m = { hooks: [hook('a.js'), hook('b.js', { kind: 'harness' })], retested: { model: 'model-a', at: '2026-11-05' } };
    const dueR = D.retestReport({ manifest: m, rulesDir: rules, sidecarFile: side, model: 'model-b' });
    check('control: a new model makes the retest due and names each rule with no usable reason',
        dueR.due === true && /DUE/.test(dueR.text) && dueR.missingRules.join() === 'short.md,without.md' && /retires nothing/.test(dueR.text), dueR.text);
    const curR = D.retestReport({ manifest: m, rulesDir: rules, sidecarFile: side, model: 'model-a' });
    check('control: the model already checked against is current, not due', curR.due === false && /Current\./.test(curR.text), curR.text);
} finally {
    fs.rmSync(rscratch, { recursive: true, force: true });
}

// The real tree.
const wired = D.wiredHooks();
check(`population: ${wired.length} wired hook file(s), at least 20`, wired.length >= 20);
const hc = D.classifyHooks(wired, D.readManifest());
check(`every wired hook names why it exists: ${hc.listed} entries for ${hc.wired} hooks`, hc.problems.length === 0, hc.problems.slice(0, 5).join('; '));
const inv = D.inventory();
const agentRows = D.agents();
const manifest = D.readManifest();
check(`population: ${inv.length} skill(s) on disk, at least 20`, inv.length >= 20);
const c = D.classify(inv, manifest);
check(`every skill classified: ${c.classified} entries for ${c.onDisk} skills`, c.problems.length === 0, c.problems.slice(0, 5).join('; '));
const pending = manifest.skills.filter((e) => e.disposition !== 'retain');
check(`no merge or retire applied ahead of the decision: ${pending.length} proposed, each still on disk`,
    pending.every((e) => e.status === 'proposed' && inv.some((s) => s.name === e.name)));
const orphans = D.orphanReferences(ROOT, inv, agentRows, manifest);
check(`population: ${orphans.scanned} shipped file(s) scanned for skill references, at least 100`, orphans.scanned >= 100);
check(`no orphan references: ${orphans.hits.length}`, orphans.hits.length === 0, orphans.hits.slice(0, 5).map((h) => `${h.at} ${h.ref}`).join('; '));
const drills = D.drillsRetained(inv, manifest, REQUIRED_DRILLS);
for (const name of REQUIRED_DRILLS) check(`drill ${name} retained`, !drills.problems.some((p) => p.startsWith(`${name}:`)), drills.problems.join('; '));

for (const l of lines) console.log(l);
const inventoried = c.problems.length === 0 ? 'classified' : `UNCLASSIFIED(${c.problems.length})`;
console.log(`inventoried=${inventoried} orphan_references=${orphans.hits.length} retained_emergency_drills=${drills.verdict} hooks_with_because=${hc.problems.length ? `PROBLEMS(${hc.problems.length})` : `${hc.listed}/${hc.wired}`}`);
if (failures.length) {
    process.stderr.write(`FAIL ${failures.length} check(s): ${failures.join('; ')}\n`);
    process.exitCode = 1;
}
