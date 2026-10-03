#!/usr/bin/env node
'use strict';
// Drives check-reference-contents.js against fixture trees. The failing cases
// are the point: each plants one defect and asserts the gate names it.
//
// Run: node tooling/test-reference-contents.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GATE = path.resolve(__dirname, 'check-reference-contents.js');
const lib = require(GATE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-contents-'));

let passed = 0;
const failures = [];

function check(label, cond) {
    if (cond) passed++;
    else failures.push(label);
}

// A body of `n` filler lines, so a fixture crosses the limit on purpose.
const filler = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

const GOOD = '# Title\n\nIntro.\n\n## Contents\n\n- Alpha\n- Beta\n  - Beta detail\n\n'
    + '## Alpha\n\n' + filler(60) + '## Beta\n\n### Beta detail\n\n' + filler(60);

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

const REF = 'plugins/p/skills/s/references/guide.md';

try {
    // Control: the planted cases below only mean something if a good file passes.
    {
        const r = run(tree('good', { [REF]: GOOD }));
        check('a long file with a matching contents list passes (exit 0)', r.status === 0);
        check('  and the population line counts it', /1 of 1 reference file\(s\) over 100 lines/.test(r.out));
    }
    {
        const r = run(tree('missing', { [REF]: '# Title\n\n## Alpha\n\n' + filler(120) }));
        check('a long file with no contents list fails (exit 1)', r.status === 1);
        check('  and names the file', r.out.includes('FAIL ' + REF));
        check('  and the population line says 0 of 1', /0 of 1 reference file/.test(r.out));
    }
    {
        const body = GOOD.replace('## Beta\n', '## Gamma\n');
        const r = run(tree('stale', { [REF]: body }));
        check('a contents entry naming no heading fails', r.status === 1 && /contents entry "Beta" names no/.test(r.out));
        check('  and the unlisted section is reported too', /section "Gamma" is missing/.test(r.out));
    }
    {
        const body = '# Title\n\n' + filler(55) + '## Contents\n\n- Alpha\n\n## Alpha\n\n' + filler(60);
        const r = run(tree('late', { [REF]: body }));
        check('a contents list below line 50 fails', r.status === 1 && /after line 50/.test(r.out));
    }
    {
        const body = '# Title\n\n## Alpha\n\n## Contents\n\n- Alpha\n\n' + filler(120);
        const r = run(tree('second', { [REF]: body }));
        check('a contents list that is not the first ## heading fails', r.status === 1);
    }
    {
        const r = run(tree('short', { [REF]: '# Title\n\n## Alpha\n\n' + filler(90) }));
        check('a file of 100 lines or fewer is exempt', r.status === 0 && /0 of 0 reference file/.test(r.out));
    }
    {
        const r = run(tree('skillmd', { 'plugins/p/skills/s/SKILL.md': '# Skill\n\n## Alpha\n\n' + filler(200) }));
        check('SKILL.md is exempt, it loads whole', r.status === 0 && /\(0 reference file\(s\) scanned\)/.test(r.out));
    }
    {
        const body = GOOD.replace('## Alpha\n\n', '## Alpha\n\n```bash\n## not a section\n```\n\n');
        const r = run(tree('fence', { [REF]: body }));
        check('a ## line inside a code fence is not a section', r.status === 0);
    }
    {
        // A later list must not be read as contents. The snapshot reference in
        // rule-local-first carries a frontmatter `paths:` list right after its
        // contents, which is how this case was found.
        const body = GOOD.replace('  - Beta detail\n\n', '  - Beta detail\n\n---\npaths:\n  - "**/x.md"\n---\n\n');
        const r = run(tree('trailing-list', { [REF]: body }));
        check('the contents list ends at the first non-list line', r.status === 0);
    }
    {
        const body = GOOD.replace('- Alpha\n', '- [Alpha](#alpha)\n');
        const r = run(tree('links', { [REF]: body }));
        check('a linked entry [Alpha](#alpha) names the heading Alpha', r.status === 0);
    }
    {
        const r = spawnSync(process.execPath, [GATE, '--help'], { encoding: 'utf8' });
        check('--help prints usage and exits 0', r.status === 0 && /^Usage: /.test(r.stdout));
    }

    // The pure helpers, called directly.
    check('lineCount counts like wc -l', lib.lineCount('a\nb\n') === 2 && lib.lineCount('a\nb') === 2);
    check('headings skips fenced lines', lib.headings('## A\n```\n## B\n```\n').map((h) => h.text).join() === 'A');
    check('contentsEntries stops at prose', lib.contentsEntries('## Contents\n\n- A\nprose\n- B\n', 1).join() === 'A');
    check('problems is empty for a short file', lib.problems('# x\n').length === 0);
    check('referenceFiles finds nothing without a plugins dir', lib.referenceFiles(TMP).length === 0);

    // The real tree is green: the gate grades what ships, not only fixtures.
    {
        const r = lib.checkTree(path.resolve(__dirname, '..'));
        check('this repo passes', r.failures.length === 0 && r.long > 0);
    }
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}

for (const f of failures) console.log('FAIL  ' + f);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
