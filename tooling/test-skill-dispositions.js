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

// The real tree.
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
console.log(`inventoried=${inventoried} orphan_references=${orphans.hits.length} retained_emergency_drills=${drills.verdict}`);
if (failures.length) {
    process.stderr.write(`FAIL ${failures.length} check(s): ${failures.join('; ')}\n`);
    process.exitCode = 1;
}
