#!/usr/bin/env node
'use strict';
// Drives check-skill-plugin-root.js against fixture trees. Every case states
// what it proves. The point of the suite is the FAILING cases: a gate nobody
// has watched go red is a gate nobody knows the shape of.
//
// Run: node tooling/test-skill-plugin-root.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GATE = path.resolve(__dirname, 'check-skill-plugin-root.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-plugin-root-'));

let passed = 0;
const failures = [];

function check(label, cond, detail) {
    if (cond) { passed++; return; }
    failures.push({ label, detail });
}

function tree(name, files) {
    const root = path.join(TMP, name);
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body);
    }
    return root;
}

function run(root) {
    const r = spawnSync(process.execPath, [GATE, root], { encoding: 'utf8', timeout: 20000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const fence = (cmd) => '# Skill\n\n```bash\n' + cmd + '\n```\n';

// ---- the defect this gate exists for -------------------------------------
{
    const root = tree('bad', {
        'plugins/p/skills/s/SKILL.md': fence('node "${autodev_core_root}/scripts/deploy-ledger.js"'),
    });
    const r = run(root);
    check('an unguarded non-CLAUDE_PLUGIN_ROOT variable FAILS', r.code === 1, r);
    check('the failure names the variable', /autodev_core_root/.test(r.out), r.out);
    check('the failure names the file and line', /SKILL\.md:4/.test(r.out), r.out);
    check('the failure explains what an unset variable does', /empty in a fresh shell call/.test(r.out), r.out);
}
{
    const root = tree('bad-bare', {
        'plugins/p/skills/s/SKILL.md': fence('node "$core_root/hooks/x.js"'),
    });
    check('bare $VAR form is caught too, not just ${VAR}', run(root).code === 1);
}
{
    // The real PR shape: one good line and one bad line in the same file.
    const root = tree('mixed', {
        'plugins/p/skills/s/SKILL.md':
            fence('node "${CLAUDE_PLUGIN_ROOT}/scripts/a.js"') +
            fence('node "${autodev_core_root}/scripts/b.js"'),
    });
    const r = run(root);
    check('one bad line among good ones still FAILS', r.code === 1, r);
    check('and the good line is not reported', !/scripts\/a\.js/.test(r.out), r.out);
}

{
    // The javascript fence form. Same mistake, different syntax: a free
    // identifier instead of a shell expansion, so the shell regex cannot see it.
    const root = tree('bad-js', {
        'plugins/p/skills/s/SKILL.md':
            "# Skill\n\n```javascript\nconst { workPlan } = require(require('path').join(autodevCoreRoot, 'scripts', 'prd-states.js'));\n```\n",
    });
    const r = run(root);
    check('an unguarded free identifier in a javascript fence FAILS', r.code === 1, r);
    check('and the javascript failure names the identifier', /autodevCoreRoot/.test(r.out), r.out);
}
{
    // Paired with a shell line so the population is non-empty: a member
    // expression is never counted, which is exactly why it cannot be graded alone.
    const root = tree('good-js', {
        'plugins/p/skills/s/SKILL.md':
            fence('node "${CLAUDE_PLUGIN_ROOT}/scripts/a.js"') +
            "\n```javascript\nconst p = require('path').join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'a.js');\n```\n",
    });
    const r = run(root);
    check('CONTROL: process.env.CLAUDE_PLUGIN_ROOT in javascript passes', r.code === 0, r);
    check('CONTROL: a member expression is not counted into the population', /1 plugin-path expansion/.test(r.out), r.out);
}

// ---- what must stay green ------------------------------------------------
{
    const root = tree('good', {
        'plugins/p/skills/s/SKILL.md': fence('node "${CLAUDE_PLUGIN_ROOT}/scripts/a.js"'),
    });
    const r = run(root);
    check('CONTROL: ${CLAUDE_PLUGIN_ROOT} passes', r.code === 0, r);
    check('CONTROL: the pass states its population', /1 skill markdown file/.test(r.out) && /1 plugin-path expansion/.test(r.out), r.out);
}
{
    // core/SKILL.md's shape before this branch consolidated it: a different
    // variable, but guarded by a throw naming it. Must remain allowed, or the
    // gate forbids the one safe alternative.
    const root = tree('guarded', {
        'plugins/p/skills/s/SKILL.md':
            fence("node -e \"if(!process.env.MY_ROOT)throw new Error('MY_ROOT is required');\"") +
            fence('node "${MY_ROOT}/scripts/a.js"'),
    });
    check('CONTROL: a variable guarded by a throw in the same file passes', run(root).code === 0);
}
{
    const root = tree('guard-elsewhere', {
        'plugins/p/skills/s/SKILL.md': fence('node "${MY_ROOT}/scripts/a.js"'),
        'plugins/p/skills/other/SKILL.md': fence("node -e \"if(!process.env.MY_ROOT)throw new Error('MY_ROOT is required');\""),
    });
    check('a guard in a DIFFERENT file does not excuse this one', run(root).code === 1);
}
{
    const root = tree('prose', {
        'plugins/p/skills/s/SKILL.md': '# Skill\n\nSet `$HOME/notes` and `${FOO}/bar` as you like.\n',
    });
    const r = run(root);
    check('ordinary prose variables are not in the population', r.code === 2, r);
    check('and an empty population reports INDETERMINATE, not OK', /INDETERMINATE/.test(r.out), r.out);
}

// ---- the gate must not pass on nothing -----------------------------------
{
    const root = tree('empty', { 'plugins/p/skills/s/SKILL.md': '# Skill\n\nNo commands.\n' });
    const r = run(root);
    check('a population with no expansions is INDETERMINATE (exit 2), not a pass', r.code === 2, r);
}
{
    const root = tree('no-skills', { 'README.md': 'nothing here\n' });
    check('a tree with no skills at all is INDETERMINATE, not a pass', run(root).code === 2);
}

// -------------------------------------------------------------------- report
fs.rmSync(TMP, { recursive: true, force: true });
const total = passed + failures.length;
if (failures.length) {
    for (const f of failures) {
        console.error(`FAIL: ${f.label}`);
        if (f.detail) console.error('  ' + JSON.stringify(f.detail).slice(0, 300));
    }
    console.error(`\n${failures.length} of ${total} checks failed.`);
    process.exitCode = 1;
} else {
    console.log(`skill-plugin-root: ${passed}/${total} passed — the gate fails on the real defect and stays green on the two safe forms.`);
    process.exitCode = 0;
}
