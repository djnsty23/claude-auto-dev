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

// AUTODEV_AWAY_CHECK=off by default, because this file is about the
// RECOMMENDATION rule and the hook gained a second, unrelated job on
// 2026-09-02: holding a panel while the operator has declared AWAY. Without
// this, every case here would quietly depend on whether ~/claude-memory/AWAY.md
// happens to be active on the machine running the suite — green all week and
// red on the one afternoon somebody steps out. A case can override it.
const run = (payload, env) => spawnSync('node', [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { AUTODEV_AWAY_CHECK: 'off' }, env || {}),
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

// ---------------------------------------------------------------------------
// THE AWAY BRANCH (added 2026-09-02).
//
// `[measured 2026-09-02 01:06]` a session sat 50 minutes on a question whose
// answer was already visible in fleet state. A worker with a question and no
// operator has one legal move today, and it is stop. Under a declared AWAY this
// hook returns the decision instead.
//
// Every case points AUTODEV_AWAY_FILE at a fixture. The operator's real
// ~/claude-memory/AWAY.md is never read: a suite that could self-resolve real
// panels is worse than no suite.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
// `path` is already required at the top of this file.

const awayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-away-'));
const awayFile = (name, body) => {
    const p = path.join(awayDir, name);
    fs.writeFileSync(p, body);
    return p;
};
const ACTIVE = awayFile('active.md', '# AWAY\n\nuntil: 2099-01-01T00:00:00Z\n\nout for the evening, self-resolve reversible things\n');
const EXPIRED = awayFile('expired.md', '# AWAY\n\nuntil: 2020-01-01T00:00:00Z\n\nold window\n');
const BROKEN = awayFile('broken.md', '# AWAY\n\nno until line\n');
const MISSING = path.join(awayDir, 'nope.md');

const marked = () => panel([{
    question: 'Ship it or hold?',
    options: [{ label: 'Ship it (Recommended)' }, { label: 'Hold' }],
}]);

// A well-formed panel is HELD under an active AWAY, and the block carries the
// decision rather than only a refusal.
r = run(marked(), { AUTODEV_AWAY_FILE: ACTIVE, AUTODEV_AWAY_CHECK: '' });
check('an active AWAY holds a well-formed panel', r.status === 2);
check('  and names the option to take', /-> take: Ship it \(Recommended\)/.test(r.stderr || ''));
check('  and gives all three branches, not just branch 2',
    /1\. Covered by a standing rule/.test(r.stderr || '')
    && /2\. Reversible/.test(r.stderr || '')
    && /3\. IRREDUCIBLE/.test(r.stderr || ''));
check('  and names the branch-3 classes verbatim, since the hook cannot judge reversibility',
    /money, production rows, deletes of unmeasured shared/.test(r.stderr || ''));
check('  and says which file it read', (r.stderr || '').includes(ACTIVE));
check('  and tells the session to log the decision',
    /DECISIONS-<date>\.md/.test(r.stderr || ''));

// The other three states all mean "the operator can be asked". Asserted
// separately, because folding any of them into `active` hands a session
// permission nobody granted.
for (const [label, file] of [['expired', EXPIRED], ['absent', MISSING], ['malformed', BROKEN]]) {
    r = run(marked(), { AUTODEV_AWAY_FILE: file, AUTODEV_AWAY_CHECK: '' });
    check(`${label} AWAY lets the panel through to the operator`,
        r.status === 0 && (r.stderr || '') === '');
}

// Order: the mark is enforced FIRST, because branch 2 says take the RECOMMENDED
// option and an unmarked panel has none to take.
r = run(panel([{ question: 'Which?', options: opts('One', 'Two') }]),
    { AUTODEV_AWAY_FILE: ACTIVE, AUTODEV_AWAY_CHECK: '' });
check('an UNMARKED panel is fixed before it is self-resolved',
    r.status === 2 && /mark no option/.test(r.stderr || '') && !/AWAY/.test(r.stderr || ''));

// Two switches, each doing one thing. Folding AWAY into AUTODEV_PANEL_CHECK
// would mean disabling a house STYLE rule silently disables a coordination
// MECHANISM, which is absent coverage wearing a preference's clothes.
r = run(marked(), { AUTODEV_AWAY_FILE: ACTIVE, AUTODEV_AWAY_CHECK: 'off' });
check('AUTODEV_AWAY_CHECK=off disables the AWAY branch', r.status === 0);
r = run(panel([{ question: 'Which?', options: opts('One', 'Two') }]),
    { AUTODEV_AWAY_FILE: ACTIVE, AUTODEV_PANEL_CHECK: 'off', AUTODEV_AWAY_CHECK: '' });
check('turning the STYLE check off leaves the AWAY branch armed', r.status === 2);
check('  and it still names an option, falling back to #1 when nothing is marked',
    /-> take: One/.test(r.stderr || ''));

// Fail open: an unreadable state must not swallow a panel.
r = run(marked(), { AUTODEV_AWAY_FILE: path.join(awayDir, 'a', 'b', 'c.md'), AUTODEV_AWAY_CHECK: '' });
check('an unreachable AWAY path fails open', r.status === 0);

fs.rmSync(awayDir, { recursive: true, force: true });

console.log('');
if (fails.length) {
    console.log('FAILED: ' + fails.length);
    process.exit(1);
}
console.log('all passed');
