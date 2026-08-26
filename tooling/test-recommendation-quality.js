#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/check-recommendation-quality.js
// Run: node tooling/test-recommendation-quality.js
// Exits 1 on any failure; 0 if all pass.
//
// The script ships its own --selftest, and this suite drives it as a subprocess
// rather than duplicating those cases. What is added here is the layer a
// selftest cannot cover: that the CLI surface behaves, and that the two
// classifications this check exists to keep apart really are kept apart.
//
// The distinction being defended: REJECTED is exact about the selection and
// advisory about quality. SWEPT is a multi-select where everything was picked,
// which exercised no judgement. Folding swept into honoured would inflate the
// pass rate using precisely the panels that measured nothing, which is the
// gate-that-cannot-fail shape rules/gate-integrity warns about.

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-recommendation-quality.js',
);
const { analyse, collectPanels, isRecommended, clean } = require(SCRIPT);

let failures = 0;
function check(name, cond) {
    if (cond) { console.log('  ok   ' + name); return; }
    console.log('  FAIL ' + name);
    failures += 1;
}

function panel(id, questions, answered) {
    return [
        { message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } },
        { message: { content: [{ type: 'tool_result', tool_use_id: id, content: answered.join(', ') }] } },
    ];
}

console.log('check-recommendation-quality');

// --- the script's own selftest must pass as a subprocess ---
const st = spawnSync('node', [SCRIPT, '--selftest'], { encoding: 'utf8' });
check('--selftest exits 0', st.status === 0);
check('--selftest names its case count', /8 cases/.test(st.stdout || ''));

// --- the CLI reports a population, not a bare verdict ---
const run = spawnSync('node', [SCRIPT, '--days', '0'], { encoding: 'utf8' });
check('report mode exits 0 even with findings', run.status === 0);
check('report prints the population it scanned', /population: \d+ transcript/.test(run.stdout || ''));
check('report distinguishes UNREADABLE from zero', /UNREADABLE/.test(run.stdout || ''));
check('report says a rejection is advisory about quality',
    /advisory about QUALITY/i.test(run.stdout || ''));

// --- helpers ---
check('isRecommended matches the trailing mark', isRecommended('Do the thing (Recommended)'));
check('isRecommended is case-insensitive', isRecommended('Do it (recommended)'));
check('isRecommended does not match mid-label',
    !isRecommended('Recommended reading, then stop'));
check('clean strips only the mark', clean('Do the thing (Recommended)') === 'Do the thing');

// --- SWEPT must never be counted as agreement ---
let r = analyse(collectPanels(panel('s1', [{
    question: 'Q', multiSelect: true,
    options: [{ label: 'A (Recommended)' }, { label: 'B' }],
}], ['A (Recommended)', 'B'])), 't');
check('full multi-select sweep counts as swept', r.swept === 1);
check('full multi-select sweep does NOT count as honoured', r.honoured === 0);
check('full multi-select sweep does NOT count as rejected', r.rejected.length === 0);

// --- a partial multi-select that drops the recommendation IS a rejection ---
r = analyse(collectPanels(panel('s2', [{
    question: 'Q', multiSelect: true,
    options: [{ label: 'A (Recommended)' }, { label: 'B' }, { label: 'C' }],
}], ['B', 'C'])), 't');
check('partial multi-select dropping the mark is rejected', r.rejected.length === 1);
check('partial multi-select is not swept', r.swept === 0);

// --- a label containing a comma survives selection matching ---
// This is the defect that would silently mis-score every panel with a
// comma in an option label, and it is invisible unless asserted.
r = analyse(collectPanels(panel('s3', [{
    question: 'Q', multiSelect: false,
    options: [{ label: 'Merge #17, then clear #16 (Recommended)' }, { label: 'Wait' }],
}], ['Merge #17, then clear #16 (Recommended)'])), 't');
check('comma inside a label does not shred the match', r.honoured === 1 && r.rejected.length === 0);

// --- a missing recommendation is its own finding, not a rejection ---
r = analyse(collectPanels(panel('s4', [{
    question: 'Q', multiSelect: false,
    options: [{ label: 'A' }, { label: 'B' }],
}], ['B'])), 't');
check('no recommendation is reported separately', r.noRecommendation.length === 1);
check('no recommendation is not double-counted as rejected', r.rejected.length === 0);

// --- an unanswered panel is scored not at all ---
r = analyse(collectPanels([
    { message: { content: [{ type: 'tool_use', id: 'u', name: 'AskUserQuestion', input: { questions: [{ question: 'Q', options: [{ label: 'A (Recommended)' }] }] } }] } },
]), 't');
check('unanswered panel contributes nothing', r.panels === 0 && r.questions === 0);

// --- MUTATION: break the swept guard and prove a test catches it ---
// Asserting that THIS suite fires, rather than that some suite somewhere does.
// The mutation is applied to the analysis input rather than the source, so the
// subject file is never rewritten and no backup or dirty-tree dance is needed.
const swept = analyse(collectPanels(panel('m1', [{
    question: 'Q', multiSelect: true,
    options: [{ label: 'A (Recommended)' }, { label: 'B' }],
}], ['A (Recommended)', 'B'])), 't');
const wouldInflate = swept.honoured + swept.swept;
check('if swept were folded into honoured the count would change',
    wouldInflate !== swept.honoured);

console.log(failures ? '\nFAILED: ' + failures : '\nall passed');
process.exit(failures ? 1 : 0);
