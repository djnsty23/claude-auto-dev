#!/usr/bin/env node
'use strict';
// test-skill-routing.js - do the current skill descriptions route held-out
// scenarios to the right skill?
//
// THIS TESTS DESCRIPTION ROUTING, NOT LIVE MODEL SELECTION. skill-router.js
// reads the trigger phrases each description and when_to_use promise, and
// routes a scenario to every skill whose phrase it contains. No model is
// called. A pass says the descriptions are unambiguous on paper. Whether the
// live model then picks that skill is measured over transcripts by
// analyze-skill-invocations.js, outside this gate.
//
// Scenarios: tooling/frontier/routing/scenarios.json, written by hand.
//
//   critical_routes=P%          critical scenarios routing to exactly their target
//   ambiguous_routes=EXPLICIT   every multi-skill route is declared with its exact
//                               contestants and a winner, and no declaration is stale
//   missing_skill_control=FAIL  the negative control: with each critical target
//                               removed from the corpus, its scenario must fail.
//                               PASS here would mean the grader cannot see a
//                               missing skill.
//
// One more check reads the simpler skill set: the corpus minus every skill
// docs/skill-dispositions.json proposes to merge or retire. No critical
// scenario may route to a skill that set drops.
const path = require('path');
const R = require('./skill-router.js');

const FIXTURE = path.join(__dirname, 'frontier', 'routing', 'scenarios.json');
const DISPOSITIONS = path.join(__dirname, '..', 'docs', 'skill-dispositions.json');

const lines = [];
const failures = [];
const check = (name, ok, detail) => {
    if (ok) lines.push(`ok ${name}`);
    else { lines.push(`FAIL ${name}${detail ? ` (${detail})` : ''}`); failures.push(name); }
};

// Controls on a planted corpus, so each verdict is seen to move.
const toy = [
    { name: 'alpha', triggers: R.triggersOf('alpha', 'Does alpha things.', 'Invoked when the user says "zorblatt the ledger".') },
    { name: 'beta', triggers: R.triggersOf('beta', 'Beta work.', 'Use on the words quibnix or plinth.') },
];
const toyFix = { scenarios: [
    { id: 'c1', critical: true, target: 'alpha', prompt: 'Please zorblatt the ledger tonight.' },
    { id: 'c2', critical: true, target: 'beta', prompt: 'Run the quibnix pass.' },
    { id: 'a1', target: 'alpha', prompt: 'zorblatt the ledger, then quibnix it' },
], ambiguous: [{ id: 'a1', contestants: ['alpha', 'beta'], winner: 'alpha', reason: 'alpha names the whole phrase' }] };
check('control: quoted and "on the words" triggers both parse', toy[0].triggers.includes('zorblatt the ledger') && toy[1].triggers.includes('quibnix'));
const tg = R.grade(toy, toyFix);
check('control: a planted corpus routes its critical scenarios at 100%', tg.criticalRate === 1 && tg.explicit === true, JSON.stringify(tg));
const undeclared = R.grade(toy, { scenarios: toyFix.scenarios, ambiguous: [] });
check('control: an undeclared two-skill route is not explicit', undeclared.explicit === false && undeclared.undeclared.length === 1);
const stale = R.grade(toy, { scenarios: toyFix.scenarios, ambiguous: [...toyFix.ambiguous, { id: 'c2', contestants: ['alpha', 'beta'], winner: 'beta', reason: 'r' }] });
check('control: a declaration whose route is no longer ambiguous is stale', stale.explicit === false && stale.stale.length === 1);
check('control: removing a target makes its scenario fail', R.missingSkillControl(toy, toyFix).verdict === 'FAIL');
check('control: a word inside a longer word does not match', !R.phraseIn('test', 'the latest build') && R.phraseIn('test', 'run the test now'));

// The real corpus and the held-out scenarios.
const fixture = require(FIXTURE);
const corpus = R.readCorpus();
check(`population: ${corpus.length} skill(s) read, at least 20`, corpus.length >= 20);
const critical = fixture.scenarios.filter((s) => s.critical);
check(`population: ${critical.length} critical, ${(fixture.ambiguous || []).length} ambiguous and ${fixture.scenarios.filter((s) => s.target === null).length} no-route scenario(s)`,
    critical.length >= 15 && (fixture.ambiguous || []).length >= 3);
check('every critical target is a skill on disk', critical.every((s) => corpus.some((c) => c.name === s.target)),
    critical.filter((s) => !corpus.some((c) => c.name === s.target)).map((s) => s.target).join(','));
const g = R.grade(corpus, fixture);
for (const c of g.critical) check(`route ${c.id} -> ${c.target}`, c.ok, `got [${c.got.join(', ')}]`);
for (const a of g.ambiguous) check(`ambiguous ${a.id} [${a.want.join(', ')}] declared, winner ${a.winner}`, a.ok);
for (const s of g.stale) check(`ambiguous ${s.id} still ambiguous as declared`, false, `got [${s.got.join(', ')}]`);
for (const u of g.undeclared) check(`scenario ${u.id} has no undeclared ambiguity`, false, `got [${u.got.join(', ')}]`);
for (const n of g.none) check(`no-route ${n.id} routes to nothing`, n.ok, `got [${n.got.join(', ')}]`);

const control = R.missingSkillControl(corpus, fixture);
for (const r of control.results) check(`control ${r.id}: without ${r.target} the scenario fails`, r.removed && !r.stillPasses);

let dropped = [];
try {
    dropped = require(DISPOSITIONS).skills.filter((e) => e.disposition !== 'retain').map((e) => e.name);
} catch (e) {
    check('the disposition manifest is readable', false, e.message);
}
const simpler = corpus.filter((s) => !dropped.includes(s.name));
const sg = R.grade(simpler, { scenarios: critical, ambiguous: [] });
check(`simpler skill set (${simpler.length} of ${corpus.length}) keeps every critical route`, sg.criticalRate === 1,
    sg.critical.filter((c) => !c.ok).map((c) => c.id).join(','));

for (const l of lines) console.log(l);
const pct = g.criticalRate === null ? 'UNKNOWN' : `${Math.floor(g.criticalRate * 100)}%`;
console.log(`critical_routes=${pct} ambiguous_routes=${g.explicit ? 'EXPLICIT' : 'UNDECLARED'} missing_skill_control=${control.verdict}`);
if (failures.length) {
    process.stderr.write(`FAIL ${failures.length} check(s): ${failures.join('; ')}\n`);
    process.exitCode = 1;
}
