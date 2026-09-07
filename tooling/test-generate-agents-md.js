#!/usr/bin/env node
// Suite for generate-agents-md.js — the AGENTS.md distiller and its drift gate.
//
// Drives the generator as a SUBPROCESS throughout, because the gate is consumed
// as a CLI (npm run check:agents-md) and only a spawned run can see an exit code.
// Every fixture rule is written by hand here, with its own dated paragraph and
// its own sentinel strings, so nothing the suite asserts is derived from the
// generator's own regexes: a fixture that shrank when the generator shrank would
// be decorative (rule-gate-integrity §3).
//
// What it proves, in order:
//   1. a fixture rule with a WRAPPED dated paragraph survives whole in variant B,
//      and is absent from variant C (so "kept" is not vacuous);
//   2. paths, description, Never/Always, version and the banner all appear;
//   3. the hand-maintained section round-trips byte-for-byte, and --write is idempotent;
//   4. --check is green after --write and red after editing one byte of a rule,
//      and the red names the first differing line;
//   5. a rule without frontmatter, and one without a description, fail LOUDLY
//      (exit 1, file named) and leave AGENTS.md untouched;
//   6. zero rules is exit 2, not an empty green file; bare invocation is exit 2;
//   7. over the REAL tree: every rule-* dir has a section (relational, not a
//      floor), the committed AGENTS.md is current, and the generated text passes
//      tooling/check-no-private-names.js — the rules are written for a public
//      repo, but AGENTS.md is a new file the digest gate must also see.
//
// Run: node tooling/test-generate-agents-md.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GEN = path.join(__dirname, 'generate-agents-md.js');
const PRIVATE_NAMES = path.join(__dirname, 'check-no-private-names.js');

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + String(detail).slice(0, 300) : '')); }
};

const run = (args, opts = {}) => spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8', ...opts });

// ---------------------------------------------------------------------------
// Fixture tree: <tmp>/plugins/autodev-core/skills/rule-*/SKILL.md, VERSION, AGENTS.md
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-suite-'));
const skills = path.join(tmp, 'plugins', 'autodev-core', 'skills');
fs.mkdirSync(skills, { recursive: true });
fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.3\n');

const HAND = '# AGENTS.md\n\nHAND-SENTINEL-7f3a: this paragraph is hand-written and must survive verbatim.\n\n## Local facts\n\n- one\n- two\n';
const OUT = path.join(tmp, 'AGENTS.md');
fs.writeFileSync(OUT, HAND);

// The dated claim is deliberately WRAPPED over two lines with the marker on the
// first. A line-shaped extractor keeps only "…renders 4,242 bytes of" and loses
// the rest; the paragraph shape must keep both halves.
const DATED_P1 = 'The probe reported nothing. `[measured 2026-01-02]` the fixture channel renders 4,242 bytes of';
const DATED_P2 = 'model-visible input on a cold start, none of it from the caller. SENTINEL-DATED-9c1e.';
const NEVER_LINE = '**Never** report a count without its population. SENTINEL-NEVER-2b8d.';
const FIRST_PARA = 'A fixture rule exists to be distilled. SENTINEL-FIRST-5e4f is its opening paragraph.';
const RULE_A = [
    '---',
    'name: rule-fixture-alpha',
    'description: "Fixture alpha: SENTINEL-DESC-1a2b describes when this rule applies."',
    'when_to_use: "Before anything, in a fixture."',
    'user-invocable: false',
    'allowed-tools: Read',
    'paths:',
    '  - "**/*.fixture.ts"',
    '  - "**/alpha-*.md"',
    '---',
    '',
    '# Fixture alpha',
    '',
    FIRST_PARA,
    '',
    '## A dated section',
    '',
    DATED_P1,
    DATED_P2,
    '',
    'An undated paragraph that variant B must NOT carry. SENTINEL-UNDATED-c0de.',
    '',
    NEVER_LINE,
    '',
].join('\n');
const alphaDir = path.join(skills, 'rule-fixture-alpha');
fs.mkdirSync(alphaDir);
fs.writeFileSync(path.join(alphaDir, 'SKILL.md'), RULE_A);

const fixtureArgs = ['--root', tmp];

console.log('test-generate-agents-md');

// 1. --write on the fixture.
const w1 = run(['--write', ...fixtureArgs]);
check('--write exits 0 on the fixture', w1.status === 0, w1.stderr || w1.stdout);
const out1 = fs.readFileSync(OUT, 'utf8');
check('wrapped dated paragraph survives WHOLE in variant B', out1.includes(DATED_P1 + '\n' + DATED_P2));
check('undated paragraph is not carried', !out1.includes('SENTINEL-UNDATED-c0de'));
check('first paragraph is carried', out1.includes(FIRST_PARA));
check('description is carried', out1.includes('SENTINEL-DESC-1a2b'));
check('**Never line is carried', out1.includes(NEVER_LINE));
check('paths line names both globs', /\*\*paths:\*\* `\*\*\/\*\.fixture\.ts`, `\*\*\/alpha-\*\.md`/.test(out1));
check('banner names the generator', out1.includes('Generator: tooling/generate-agents-md.js'));
check('banner names the source glob', out1.includes('plugins/autodev-core/skills/rule-*/SKILL.md'));
check('banner carries the VERSION it was generated from', out1.includes('autodev 1.2.3'));
check('entry points at the full text', out1.includes('Full text: `plugins/autodev-core/skills/rule-fixture-alpha/SKILL.md`'));
check('hand-maintained section is above the marker, verbatim',
    out1.startsWith(HAND.trimEnd() + '\n\n<!-- GENERATED BELOW'), JSON.stringify(out1.slice(0, 200)));

// 2. Variant C on the same fixture: description only. Proves the "kept" measurement
//    can go to zero, i.e. the survival assertions above are not passing vacuously.
const cPath = path.join(tmp, 'AGENTS-C.md');
const wc = run(['--write', '--variant', 'C', '--out', cPath, ...fixtureArgs]);
check('variant C writes', wc.status === 0, wc.stderr);
const outC = fs.readFileSync(cPath, 'utf8');
check('variant C keeps the description', outC.includes('SENTINEL-DESC-1a2b'));
check('variant C drops the dated paragraph', !outC.includes('SENTINEL-DATED-9c1e'));
check('variant C is smaller than variant B', Buffer.byteLength(outC) < Buffer.byteLength(out1));

// 3. Idempotence and round-trip: a second --write changes nothing, and the hand
//    section read back from the marker up equals what was written in.
const w2 = run(['--write', ...fixtureArgs]);
const out2 = fs.readFileSync(OUT, 'utf8');
check('second --write is byte-identical', w2.status === 0 && out2 === out1);
const handBack = out2.slice(0, out2.indexOf('<!-- GENERATED BELOW')).trimEnd();
check('hand-maintained section round-trips unchanged', handBack === HAND.trimEnd());

// Editing the hand section is a legitimate change and must NOT be a drift finding
// after a regenerate: the generator copies it through, so the file it produces
// carries the edit.
fs.writeFileSync(OUT, out2.replace('HAND-SENTINEL-7f3a', 'HAND-SENTINEL-EDITED'));
const w3 = run(['--write', ...fixtureArgs]);
check('an edited hand section survives regeneration', w3.status === 0 && fs.readFileSync(OUT, 'utf8').includes('HAND-SENTINEL-EDITED'));

// 4. --check: green after --write, red after one byte of a rule changes.
const c1 = run(['--check', ...fixtureArgs]);
check('--check exits 0 right after --write', c1.status === 0, c1.stderr);
check('--check green prints the population it compared', /matches 1 rules/.test(c1.stdout), c1.stdout);

const before = fs.readFileSync(OUT, 'utf8');
fs.writeFileSync(path.join(alphaDir, 'SKILL.md'), RULE_A.replace('4,242 bytes', '4,243 bytes'));
const c2 = run(['--check', ...fixtureArgs]);
check('--check exits 1 after editing one byte of a rule', c2.status === 1, 'exit ' + c2.status);
check('--check red says STALE and names the first differing line', /STALE/.test(c2.stderr) && /first difference at line \d+/.test(c2.stderr), c2.stderr);
check('--check did not rewrite AGENTS.md', fs.readFileSync(OUT, 'utf8') === before);
check('--check red tells the reader the fix', /--write/.test(c2.stderr));
fs.writeFileSync(path.join(alphaDir, 'SKILL.md'), RULE_A);
check('--check is green again once the rule is restored', run(['--check', ...fixtureArgs]).status === 0);

// 5. A rule without frontmatter fails loudly, names the file, and leaves the
//    output alone. Then the same for a frontmatter with no description.
const betaDir = path.join(skills, 'rule-fixture-beta');
fs.mkdirSync(betaDir);
fs.writeFileSync(path.join(betaDir, 'SKILL.md'), '# No frontmatter here\n\nJust prose. [measured 2026-02-03] something.\n');
const nf = run(['--write', ...fixtureArgs]);
check('rule without frontmatter: exit 1', nf.status === 1, 'exit ' + nf.status);
check('rule without frontmatter: names the file', /rule-fixture-beta\/SKILL\.md: no frontmatter/.test(nf.stderr), nf.stderr);
check('rule without frontmatter: AGENTS.md untouched', fs.readFileSync(OUT, 'utf8') === before);
check('rule without frontmatter: --check is also red, not green-by-absence', run(['--check', ...fixtureArgs]).status === 1);

fs.writeFileSync(path.join(betaDir, 'SKILL.md'), '---\nname: rule-fixture-beta\nuser-invocable: false\n---\n\nBody without a description.\n');
const nd = run(['--write', ...fixtureArgs]);
check('rule without description: exit 1 and names the field', nd.status === 1 && /rule-fixture-beta.*no description/.test(nd.stderr), nd.stderr);
fs.rmSync(betaDir, { recursive: true });

// 6. Population floor and bare invocation.
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-empty-'));
fs.mkdirSync(path.join(emptyRoot, 'plugins', 'autodev-core', 'skills'), { recursive: true });
fs.writeFileSync(path.join(emptyRoot, 'VERSION'), '0.0.1\n');
const empty = run(['--write', '--root', emptyRoot]);
check('zero rules: exit 2, nothing written', empty.status === 2 && !fs.existsSync(path.join(emptyRoot, 'AGENTS.md')), 'exit ' + empty.status);
check('zero rules: says it read 0 rules', /read 0 rules/.test(empty.stderr), empty.stderr);
const bare = run([]);
check('bare invocation is exit 2 with usage, not a write', bare.status === 2 && /usage/.test(bare.stderr));
const help = run(['--help']);
check('--help exits 0 and describes --check', help.status === 0 && /--check/.test(help.stdout));

// 7. The real tree.
const realDirs = fs.readdirSync(path.join(ROOT, 'plugins', 'autodev-core', 'skills'))
    .filter((d) => d.startsWith('rule-') && fs.existsSync(path.join(ROOT, 'plugins', 'autodev-core', 'skills', d, 'SKILL.md')));
const real = run(['--print']);
check('real tree: --print exits 0', real.status === 0, real.stderr);
const sections = (real.stdout.match(/^### rule-[a-z-]+$/gm) || []).map((s) => s.slice(4));
check(`real tree: one section per rule-* dir (${realDirs.length} dirs, ${sections.length} sections)`,
    realDirs.length > 0 && sections.length === realDirs.length && realDirs.every((d) => sections.includes(d)),
    'missing: ' + realDirs.filter((d) => !sections.includes(d)).join(', '));
check('real tree: every section carries a paths line', sections.length > 0 && (real.stdout.match(/^\*\*paths:\*\* /gm) || []).length === sections.length);
check('real tree: banner carries the repo VERSION',
    real.stdout.includes('autodev ' + fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim()));

const realCheck = run(['--check']);
check('real tree: committed AGENTS.md is current (run --write and commit if not)', realCheck.status === 0, realCheck.stderr);

// Private names: the digest gate over the generated text. --check-text runs the
// name scan over one file; the known-positive control for that scanner lives in
// test-no-private-names.js, which plants a derived name and watches it fire.
const genFile = path.join(tmp, 'real-AGENTS.md');
fs.writeFileSync(genFile, real.stdout);
const pn = spawnSync(process.execPath, [PRIVATE_NAMES, '--check-text', genFile], { encoding: 'utf8' });
check('real tree: generated AGENTS.md passes check-no-private-names', pn.status === 0, (pn.stdout + pn.stderr).slice(0, 400));

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(emptyRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
