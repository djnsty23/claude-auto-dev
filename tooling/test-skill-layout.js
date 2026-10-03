#!/usr/bin/env node
'use strict';
// Drives check-skill-layout.js against fixture trees. The failing cases are the
// point: each plants one defect and asserts the gate names it.
//
// Run: node tooling/test-skill-layout.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GATE = path.resolve(__dirname, 'check-skill-layout.js');
const lib = require(GATE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-layout-'));

let passed = 0;
const failures = [];

function check(label, cond) {
    if (cond) passed++;
    else failures.push(label);
}

// A body of `n` filler lines, so a fixture crosses the limit on purpose.
const filler = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

const SKILL = 'plugins/p/skills/s/SKILL.md';
const REF = 'plugins/p/skills/s/references/guide.md';
const LINKED = '---\nname: s\n---\n\n# S\n\nRead [references/guide.md](references/guide.md) for detail.\n';

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
    const r = spawnSync(process.execPath, [GATE, root], { encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

try {
    // Control: the planted cases below only mean something if a good skill passes.
    {
        const r = run(tree('good', { [SKILL]: LINKED, [REF]: '# Guide\n' }));
        check('a short SKILL.md that links its reference passes (exit 0)', r.status === 0);
        check('  and the population line counts it', /1 of 1 skill\(s\).*all 1 reference file/.test(r.out));
    }
    {
        // LINKED is 7 lines, so 494 filler lines make 501.
        const r = run(tree('long', { [SKILL]: LINKED + filler(494), [REF]: '# Guide\n' }));
        check('a SKILL.md over 500 lines fails (exit 1)', r.status === 1);
        check('  and names the skill and its length', r.out.includes('FAIL plugins/p/skills/s') && /SKILL\.md is 501 lines, over 500/.test(r.out));
        check('  and the population line says 0 of 1', /0 of 1 skill/.test(r.out));
    }
    {
        // 500 lines exactly is inside the limit: the guide says "under 500" and
        // the check reads it as "at most", so a file at the edge is not flagged.
        const body = LINKED + filler(500 - 7);
        const r = run(tree('edge', { [SKILL]: body, [REF]: '# Guide\n' }));
        check('a SKILL.md of exactly 500 lines passes', r.status === 0 && lib.problems(body, []).length === 0);
    }
    {
        const r = run(tree('orphan', { [SKILL]: '# S\n\nNo links here.\n', [REF]: '# Guide\n' }));
        check('a reference SKILL.md does not link fails', r.status === 1 && /references\/guide\.md is not linked from SKILL\.md/.test(r.out));
    }
    {
        // One level deep: a link from another reference is not a link from SKILL.md.
        const r = run(tree('nested', {
            [SKILL]: LINKED,
            [REF]: '# Guide\n\nSee [deep](deep.md).\n',
            'plugins/p/skills/s/references/deep.md': '# Deep\n',
        }));
        check('a file linked only from another reference fails', r.status === 1 && /references\/deep\.md is not linked/.test(r.out));
    }
    {
        // A longer name containing the path is not a link to it.
        const r = run(tree('prefix', {
            [SKILL]: '# S\n\nSee old-references/guide.md and references/guide.mdx.\n',
            [REF]: '# Guide\n',
        }));
        check('a longer path containing the name is not a link', r.status === 1);
    }
    {
        const r = run(tree('rules-dir', {
            [SKILL]: '# S\n\nLoad `rules/timing.md` for easing.\n',
            'plugins/p/skills/s/rules/timing.md': '# Timing\n',
        }));
        check('any subdirectory counts, linked by a code span', r.status === 0);
    }
    {
        // A nested skill owns its own files: they are graded against its SKILL.md.
        const r = run(tree('nested-skill', {
            [SKILL]: '# S\n',
            'plugins/p/skills/s/inner/SKILL.md': '# Inner\n\nSee references/x.md.\n',
            'plugins/p/skills/s/inner/references/x.md': '# X\n',
        }));
        check('a file belongs to its nearest SKILL.md', r.status === 0 && /2 of 2 skill/.test(r.out));
    }
    {
        const r = run(tree('dotdir', {
            [SKILL]: '# S\n',
            'plugins/p/skills/s/.drafts/x.md': '# X\n',
            'plugins/p/skills/s/node_modules/pkg/README.md': '# R\n',
        }));
        check('dot directories and node_modules are skipped', r.status === 0 && /all 0 reference file/.test(r.out));
    }
    {
        const r = spawnSync(process.execPath, [GATE, '--help'], { encoding: 'utf8' });
        check('--help prints usage and exits 0', r.status === 0 && /^Usage: /.test(r.stdout));
    }

    // The pure helpers, called directly.
    check('links matches a markdown link target', lib.links('[g](references/g.md)', 'references/g.md'));
    check('links matches a plugin-root path', lib.links('${CLAUDE_PLUGIN_ROOT}/skills/s/references/g.md', 'references/g.md'));
    check('links rejects a prefix', !lib.links('xreferences/g.md', 'references/g.md'));
    check('problems lists every orphan', lib.problems('# S\n', ['a.md', 'b.md']).length === 2);
    check('skills finds nothing without a plugins dir', lib.skills(TMP).length === 0);

    // The real tree is green: the gate grades what ships, not only fixtures.
    {
        const r = lib.checkTree(path.resolve(__dirname, '..'));
        check('this repo passes', r.failures.length === 0 && r.skills > 0 && r.files > 0);
    }
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}

for (const f of failures) console.log('FAIL  ' + f);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
