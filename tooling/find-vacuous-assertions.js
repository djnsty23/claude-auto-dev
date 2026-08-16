#!/usr/bin/env node
// find-vacuous-assertions.js — per-ASSERTION vacuity via operator mutation.
//
// check-suites-can-fail.js replaces the whole subject file with a canary stub.
// That proves a suite depends on its subject; it cannot prove any GIVEN
// assertion is live, because one guard in a code path can mask another. This is
// the finer version: mutate one decision at a time and see whether the suite
// notices. A mutant the suite does not notice is a CANDIDATE vacuity.
//
// THIS IS ADVISORY, NOT A GATE. Do not wire it into validate or CI, and do not
// report its survivor count as a defect count. Measured on this repo's own
// pre-tool-filter.js the first time it ran:
//
//   59 mutants · 1 unparseable (discarded) · 42 caught · 16 survived
//   of the 16, read individually: ~10 real coverage gaps, ~6 equivalent mutants
//
// So roughly a third of survivors are noise — mutants whose behaviour is
// genuinely unobservable (a platform-gated branch on the wrong platform, a
// condition whose operands are empty in every reachable input). That ratio is
// fine for a tool you run deliberately and read; it would be intolerable for a
// gate that blocks a push. EVERY SURVIVOR MUST BE READ. A survivor count on its
// own means nothing.
//
// What it found on its first real run, all confirmed by hand afterwards:
//   - the fail-closed "input did not parse" branch was unreachable from the
//     suite, so flipping its exit(2) to exit(0) went unnoticed
//   - the win32 dangerous-command patterns have no test on any other platform
//   - `if (hit)` -> `if (true)` survived because the surrounding fail-OPEN
//     catch swallowed the resulting TypeError — one guard masking another,
//     which is exactly the case check-suites-can-fail structurally cannot see
//
// Cost: one suite run per mutant. Measured here at 1.3s x 59 = ~80s for a
// 240-line subject. Scales with suite runtime, so point it at one pair at a
// time rather than the whole repo.
//
// Usage: node tooling/find-vacuous-assertions.js <subject.js> <suite.js>

const fs = require('fs');
const { spawnSync } = require('child_process');

const [subject, suite] = process.argv.slice(2);
const original = fs.readFileSync(subject, 'utf8');
const lines = original.split('\n');

const isCode = (l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l);

// Mutation operators. Each returns a mutated line, or null if inapplicable.
const OPS = [
    ['=== -> !==', (l) => (l.includes('===') ? l.replace('===', '!==') : null)],
    ['!== -> ===', (l) => (l.includes('!==') ? l.replace('!==', '===') : null)],
    ['&& -> ||', (l) => (l.includes('&&') ? l.replace('&&', '||') : null)],
    ['|| -> &&', (l) => (l.includes('||') ? l.replace('||', '&&') : null)],
    ['if(x) -> if(true)', (l) => (/^\s*if \(/.test(l) ? l.replace(/if \((.*)\) \{/, 'if (true) {') : null)],
    ['if(x) -> if(false)', (l) => (/^\s*if \(/.test(l) ? l.replace(/if \((.*)\) \{/, 'if (false) {') : null)],
    ['drop negation', (l) => (/[^=!]!\w/.test(l) ? l.replace(/([^=!])!(\w)/, '$1$2') : null)],
    ['exit(2) -> exit(0)', (l) => (l.includes('process.exit(2)') ? l.replace('process.exit(2)', 'process.exit(0)') : null)],
];

function suiteIsRed() {
    const r = spawnSync('node', [suite], { encoding: 'utf8', timeout: 60000 });
    return { red: r.status !== 0, out: r.stdout || '' };
}

const base = suiteIsRed();
if (base.red) { console.error('Baseline suite is already red — fix that first.'); process.exit(1); }

const results = { caught: 0, survived: [], invalid: 0 };
let n = 0;

for (let i = 0; i < lines.length; i++) {
    if (!isCode(lines[i])) continue;
    for (const [opName, op] of OPS) {
        const mutatedLine = op(lines[i]);
        if (mutatedLine === null || mutatedLine === lines[i]) continue;
        n++;
        const copy = [...lines];
        copy[i] = mutatedLine;
        fs.writeFileSync(subject, copy.join('\n'));

        // A mutant that does not parse tests nothing — discard, do not score.
        const parses = spawnSync('node', ['--check', subject], { encoding: 'utf8' }).status === 0;
        if (!parses) { results.invalid++; fs.writeFileSync(subject, original); continue; }

        const r = suiteIsRed();
        fs.writeFileSync(subject, original);
        if (r.red) results.caught++;
        else results.survived.push({ line: i + 1, op: opName, was: lines[i].trim(), now: mutatedLine.trim() });
    }
}

fs.writeFileSync(subject, original);
const restored = fs.readFileSync(subject, 'utf8') === original;

console.log(`\nsubject: ${subject}`);
console.log(`suite:   ${suite}`);
console.log(`\n${n} mutant(s) generated · ${results.invalid} did not parse (discarded) · `
    + `${results.caught} caught · ${results.survived.length} SURVIVED`);
console.log(`subject restored: ${restored}\n`);

if (results.survived.length) {
    console.log('Survivors — every one must be read before this number means anything:\n');
    for (const s of results.survived) {
        console.log(`  line ${String(s.line).padStart(3)}  [${s.op}]`);
        console.log(`      was: ${s.was.slice(0, 110)}`);
        console.log(`      now: ${s.now.slice(0, 110)}`);
    }
    console.log();
}
