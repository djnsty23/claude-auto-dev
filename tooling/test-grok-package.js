#!/usr/bin/env node
'use strict';
// Subprocess suite for plugins/autodev-core/scripts/grok-package.js.
// Every source lives under a scratch home passed with --home, so no real memory
// is read. Planted values are assembled at runtime: a literal secret shape or
// e-mail in a tracked file would trip the scanners this repository runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const subject = process.env.GROK_PACKAGE_SUBJECT
    || path.resolve(__dirname, '../plugins/autodev-core/scripts/grok-package.js');
const denylist = path.resolve(__dirname, 'check-no-private-names.js');
const WITHHELD = '[line withheld]';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-package-'));
const home = path.join(root, 'home');
const out = path.join(root, 'out');
let total = 0;
let failed = 0;
function check(name, ok, detail = '') {
    total++;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
}

function put(rel, text) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function run(...args) {
    return spawnSync('node', [subject, '--home', home, ...args], { encoding: 'utf8' });
}

const PLANT_NAME = 'Zarblewidget';
const PLANT_EMAIL = ['plant', 'example.test'].join('@');
const PLANT_SECRET = `${'sbp'}_${'a1'.repeat(20)}`;
const memory = (description, body, type = 'feedback') => `---\nname: ${description.split(' ')[0]}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;

try {
    const digest = spawnSync('node', [denylist, '--digest', PLANT_NAME], { encoding: 'utf8' }).stdout.trim();
    check('fixture digest generated', /^[0-9a-f]{16}$/.test(digest), digest);
    const extra = path.join(root, 'extra-digests.txt');
    fs.writeFileSync(extra, `${digest}\n`);

    put('.claude/memory/keep.md', memory('keepme survives', '[stated 2026-03-04] the keeper line stays readable'));
    put('.claude/memory/mail.md', memory('mailplant', `contact ${PLANT_EMAIL} for this`, 'user'));
    put('.claude/memory/token.md', memory('tokenplant', `the value is ${PLANT_SECRET} here`, 'project'));
    put('.claude/memory/name.md', memory('nameplant', `this concerns ${PLANT_NAME} directly`, 'reference'));
    put('.claude/memory/thread.md', memory('threadplant', 'see ~/.claude/comms/threads/one for it', 'reference'));
    put('.claude/memory/he-is-fixture.md', memory('he-is-fixture identityentry', 'identitybody stays'));
    put('.claude/memory/MEMORY.md', 'indexline should not be exported\n');
    put(`.claude/projects/${path.basename(home)}/memory/long.md`, memory('longplant', Array.from({ length: 40 }, (_, i) => `longline ${i}`).join('\n'), 'project'));
    put('.claude/comms/threads/one.md', 'commsbody must never be read\n');
    put('claude-auto-dev/.claude/worktrees/wt/.claude/handoffs/HANDOFF-brain-2026-01-01.md', '# Handoff body\n');
    put('claude-memory/mail/README.md', '# Mail\n');
    put('.claude/autodev/BRAIN-START.md', `# Start\nsee ${path.join(home, 'notes.md')} for detail\n`);
    put('.claude/autodev/reports/worker-a/REPORT.md', 'body\nRESULT: PARTIAL first\nRESULT: DONE last\n');
    put('.claude/rules/always.md', '# Always loaded rule\n');
    put('.claude/rules/scoped.md', '---\npaths:\n  - "**/*.tsx"\n---\nscopedbody\n');
    put('.claude/skills/one/SKILL.md', `---\nname: one\ndescription: >-\n  ${'folded text '.repeat(40)}\nmodel: opus\n---\nbody\n`);
    put('.claude/scheduled-tasks/fleet-tick/SKILL.md', '---\nname: fleet-tick\ndescription: tick\nmodel: claude-haiku-5-5\neffort: xhigh\nschedule: "40 6 * * *"\n---\nrun\n');

    const dry = run('--dry-run', '--out', out, '--extra-digests', extra);
    check('dry run exits 0', dry.status === 0, dry.stderr);
    check('dry run reports four files', (dry.stdout.match(/^\d\d-[a-z-]+\.md: [1-9]\d* entries/gm) || []).length === 4, dry.stdout);
    check('dry run writes nothing', !fs.existsSync(out));

    const res = run('--out', out, '--extra-digests', extra);
    check('real run exits 0', res.status === 0, res.stderr);
    const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
    for (const f of ['00-README.md', '10-memory-export.md', '20-handoffs.md', '30-skills.md', '40-harness.md']) {
        check(`${f} exists`, fs.existsSync(path.join(out, f)));
    }

    const mem = read('10-memory-export.md');
    const withheldLines = mem.split('\n').filter((l) => l === WITHHELD).length;
    check('planted e-mail is gone', !mem.includes(PLANT_EMAIL));
    check('planted secret is gone', !mem.includes(PLANT_SECRET));
    check('planted denylisted name is gone', !mem.toLowerCase().includes(PLANT_NAME.toLowerCase()));
    check('comms path line is gone', !mem.includes('comms/threads'));
    check('the four planted lines are withheld', withheldLines === 4, String(withheldLines));
    console.log(`planted lines reported withheld: e-mail, secret, name, comms path (${withheldLines})`);
    check('run reports the withheld count', /10-memory-export\.md: .* 4 withheld/.test(res.stdout), res.stdout);
    check('clean entry survives with its tag date', mem.includes('[2026-03-04] - keepme: [stated 2026-03-04] the keeper line stays readable'));
    check('description is exported', mem.includes('- keepme: keepme survives'));
    check('feedback lands under Instructions', mem.indexOf('## Instructions') < mem.indexOf('keepme') && mem.indexOf('keepme') < mem.indexOf('## Identity'));
    check('identity slug lands under Identity', mem.indexOf('## Identity') < mem.indexOf('identitybody') && mem.indexOf('identitybody') < mem.indexOf('## Career'));
    check('index file is skipped', !mem.includes('indexline'));
    check('long memory is capped', mem.includes('longline 14') && !mem.includes('longline 15') && mem.includes('25 more lines not exported'));
    check('all five sections present', ['Instructions', 'Identity', 'Career', 'Projects', 'Preferences'].every((s) => mem.includes(`## ${s}`)));
    const all = ['10-memory-export.md', '20-handoffs.md', '30-skills.md', '40-harness.md'].map(read).join('\n');
    check('comms body was not read', !all.includes('commsbody'));

    const hand = read('20-handoffs.md');
    check('handoff is included', hand.includes('## HANDOFF-brain-2026-01-01.md') && hand.includes('# Handoff body'));
    check('last RESULT line is used', hand.includes('- worker-a: RESULT: DONE last') && !hand.includes('PARTIAL first'));

    const skills = read('30-skills.md');
    check('folded description is parsed and cut to 300', /\*\*one\*\* \[opus\]: folded text/.test(skills) && !skills.includes('folded text '.repeat(30)));
    check('routine carries pin and schedule', skills.includes('**fleet-tick** [claude-haiku-5-5 xhigh, schedule: 40 6 * * *]: tick'));

    const harness = read('40-harness.md');
    check('always-loaded rule is included', harness.includes('## rules/always.md'));
    check('paths-scoped rule is excluded', !harness.includes('scopedbody'));
    check('home path is rewritten to ~', harness.includes('~') && !harness.includes(path.basename(root)));

    const readme = read('00-README.md');
    check('README table lists the four files', ['10-memory-export.md', '20-handoffs.md', '30-skills.md', '40-harness.md'].every((f) => readme.includes(`| \`${f}\` |`)));
    check('README keeps both sections', readme.includes('## How it was made safe') && readme.includes('## How to read it'));
    check('README carries no withheld line', !readme.split('\n').includes(WITHHELD));

    const emptyHome = path.join(root, 'empty');
    fs.mkdirSync(emptyHome);
    const emptyOut = path.join(root, 'empty-out');
    const refused = spawnSync('node', [subject, '--home', emptyHome, '--out', emptyOut], { encoding: 'utf8' });
    check('empty sources refuse with exit 1', refused.status === 1, String(refused.status));
    check('empty sources write nothing', !fs.existsSync(emptyOut));

    const badFlag = run('--nonsense');
    check('unknown flag exits 1', badFlag.status === 1, String(badFlag.status));
    const help = run('--help');
    check('--help returns usage', help.status === 0 && help.stdout.includes('Usage'));
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

console.log(`${total - failed}/${total} passed`);
process.exitCode = failed ? 1 : 0;
