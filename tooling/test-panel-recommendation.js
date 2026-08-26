'use strict';

// Drives the hook as a subprocess, the way the harness runs it. Every case is
// paired: one the hook must block and one it must not, because a test that only
// proves a pattern CAN fire never proves it fires ONLY when it should.

const { spawnSync } = require('child_process');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'panel-recommendation.js');

const fails = [];
const check = (name, cond) => {
    console.log((cond ? '  ok   ' : '  FAIL ') + name);
    if (!cond) fails.push(name);
};

const run = (payload, env) => spawnSync('node', [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: Object.assign({}, process.env, env || {}),
});

const panel = (questions) => ({ tool_name: 'AskUserQuestion', tool_input: { questions } });
const opts = (...labels) => labels.map((l) => ({ label: l }));

console.log('panel-recommendation');

// --- blocks when nothing is marked ---
let r = run(panel([{ question: 'Which?', options: opts('One', 'Two') }]));
check('blocks an unmarked question', r.status === 2);
check('names the rule in the message', /options-protocol/.test(r.stderr || ''));
check('names how many questions failed', /1 of 1 question/.test(r.stderr || ''));

// --- the negative half: a label mark is accepted ---
r = run(panel([{ question: 'Which?', options: opts('One (Recommended)', 'Two') }]));
check('label mark passes', r.status === 0);
check('passing hook emits zero bytes on stdout', (r.stdout || '') === '');
check('passing hook emits zero bytes on stderr', (r.stderr || '') === '');

// --- a description mark is accepted, at the front only ---
r = run(panel([{ question: 'Which?', options: [
    { label: 'One', description: '(Recommended) Because it unblocks the rest.' },
    { label: 'Two', description: 'Slower.' },
] }]));
check('description mark passes', r.status === 0);

r = run(panel([{ question: 'Which?', options: [
    { label: 'One', description: 'A panel with no (Recommended) reads as a menu.' },
    { label: 'Two', description: 'Slower.' },
] }]));
check('prose mentioning the mark does not count', r.status === 2);

// --- multi-question panels are judged per question ---
r = run(panel([
    { question: 'A?', options: opts('One (Recommended)', 'Two') },
    { question: 'B?', options: opts('Three', 'Four') },
]));
check('one bad question in two blocks', r.status === 2);
check('reports the failing count, not the total', /1 of 2 question/.test(r.stderr || ''));

// --- a single-option question has no ranking to express ---
r = run(panel([{ question: 'Proceed?', options: opts('Yes') }]));
check('single-option question is exempt', r.status === 0);

// --- everything else passes straight through ---
r = run({ tool_name: 'Bash', tool_input: { command: 'ls' } });
check('other tools are ignored', r.status === 0 && (r.stderr || '') === '');

// --- FAIL OPEN. Each of these is a defect that must not brick a panel. ---
r = run('not json at all');
check('unparseable stdin fails open', r.status === 0);
r = run({ tool_name: 'AskUserQuestion', tool_input: {} });
check('missing questions fails open', r.status === 0);
r = run({ tool_name: 'AskUserQuestion', tool_input: { questions: 'nope' } });
check('non-array questions fails open', r.status === 0);
r = run(panel([{ question: 'Which?', options: [null, 'string-not-object'] }]));
check('malformed options fail open rather than throwing', r.status === 0 || r.status === 2);
check('malformed options do not crash', r.status !== 1);

// --- the kill switch ---
r = run(panel([{ question: 'Which?', options: opts('One', 'Two') }]), { AUTODEV_PANEL_CHECK: 'off' });
check('kill switch disables the block', r.status === 0);
r = run(panel([{ question: 'Which?', options: opts('One', 'Two') }]), { AUTODEV_PANEL_CHECK: 'ON' });
check('kill switch only accepts off', r.status === 2);

console.log('');
if (fails.length) {
    console.log('FAILED: ' + fails.length);
    process.exit(1);
}
console.log('all passed');
