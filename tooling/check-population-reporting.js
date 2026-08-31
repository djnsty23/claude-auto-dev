#!/usr/bin/env node
'use strict';

// check-population-reporting.js
//
// A script that reports an absence or an all-clear must say what it scanned.
//
// The failure this exists for is recorded in the repo's own rules: an empty
// result is a claim about the probe, not about the world. A gate printing
// "no issues found" is indistinguishable from a gate that looked at nothing,
// and the two are told apart only by a population line -- "310 of 310 files
// read", "23 LLM calls, all bounded". Without one, a broken finder and a clean
// tree produce byte-identical output.
//
// Two findings, deliberately separate because they have different cures:
//
//   NO-POPULATION  the script announces an absence or an all-clear and never
//                  prints a count of what it examined. Cure: print the count.
//
//   NO-CONTROL     the script announces an absence and carries no
//                  known-positive control or selftest. Cure: make it prove it
//                  can see something before it reports seeing nothing.
//
// Warn-only by default, like check-claim-provenance. Its precision on this
// repo is unmeasured until its first run, and a check that fires on half the
// tree gets muted in a day and then misses the real one. --strict exits 1.
//
//   node tooling/check-population-reporting.js
//   node tooling/check-population-reporting.js --strict
//   node tooling/check-population-reporting.js --selftest

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Directories holding scripts whose output a human reads as an answer.
const SCAN_DIRS = [
    path.join(ROOT, 'tooling'),
    ...(fs.existsSync(path.join(ROOT, 'plugins'))
        ? fs.readdirSync(path.join(ROOT, 'plugins'))
              .map((p) => path.join(ROOT, 'plugins', p, 'scripts'))
              .filter((d) => fs.existsSync(d))
        : []),
];

// An absence or all-clear verdict. These are the shapes a reader takes as
// "there is nothing there", which is the claim that needs a denominator.
const ABSENCE = [
    /\b(?:no|zero|none)\b[^\n'"`]{0,40}\b(?:found|detected|match(?:es|ed)?|issues?|problems?|violations?|orphans?|failures?)\b/i,
    /\bnone found\b/i,
    /\ball (?:clear|good)\b/i,
    /\bnothing to (?:report|do|check)\b/i,
    /\b(?:tree|repo|scan)\b[^\n'"`]{0,20}\bclean\b/i,
];

// A count of what was examined. Any of these makes the verdict falsifiable.
//
// The N/N forms are here because the first live run flagged test-all.js, which
// prints "85/85 suites passed" -- a population, written the way this repo
// writes them. Demanding "of" would have made the gate's loudest finding a
// report about its own vocabulary. Same correction the claim gate needed.
const POPULATION = [
    /\d+\s+of\s+\d+/,                      // "310 of 310"
    /\d+\s*\/\s*\d+/,                      // "85/85"
    /\$\{[^}]*\}\s*of\s*\$\{/,             // "${hit} of ${total}"
    /\$\{[^}]*\}\s*\/\s*\$\{/,             // "${pass}/${total}"
    /\$\{[^}]*\.length\b/,                 // "${files.length} files"
    /\$\{[^}]*\b(?:count|total|scanned|population|seen|examined)\b[^}]*\}/i,
    /\b(?:scanned|files read|population|examined)\b/i,
    /\bout of\b/i,
];

// Evidence the script proves it can see before reporting that it saw nothing.
const CONTROL = [
    /\bknown[- ]positive\b/i,
    /\bcontrol\b/i,
    /\bselftest\b/i,
    /\bmutation\b/i,
];

// Only lines that actually reach a reader. A regex living in a pattern table
// is not a verdict, and counting it as one is how a linter invents findings.
const EMITS = /\bconsole\.(?:log|error|warn)\b|\bprocess\.std(?:out|err)\.write\b/;

// The unit a printed fact lives in is the CALL, not the line. test-all.js
// opens `console.log(` on one line and puts "${n}/${total} suites passed" on
// the next, and a line-scoped reader reports it as having no population --
// which is what the first live run did. Read from the emitting line until the
// parentheses balance.
const CALL_LINE_CAP = 12;

function emittedText(source) {
    const lines = source.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (!EMITS.test(lines[i])) continue;
        let depth = 0;
        for (let j = i; j < Math.min(lines.length, i + CALL_LINE_CAP); j++) {
            out.push(lines[j]);
            for (const ch of lines[j]) {
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
            }
            // Balanced once we have seen at least one opener.
            if (depth <= 0 && /\(/.test(lines.slice(i, j + 1).join(''))) break;
        }
    }
    return out.join('\n');
}

function anyMatch(patterns, text) {
    return patterns.some((p) => p.test(text));
}

// A test suite IS the control for its own assertions, and the repo already
// owns a better instrument for a suite that asserts nothing meaningful:
// check:vacuity mutates the subject and watches whether the suite notices.
// Asking a suite to carry a second, weaker control would fire on nearly every
// one of them while measuring a question that tool answers properly.
const isSuite = (file) => /^test-.*\.js$/.test(path.basename(file));

function inspect(file) {
    const source = fs.readFileSync(file, 'utf8');
    const printed = emittedText(source);

    const claimsAbsence = anyMatch(ABSENCE, printed);
    if (!claimsAbsence) return { file, claimsAbsence: false, findings: [] };

    const findings = [];
    // The population may be printed anywhere the reader sees it, not only on
    // the same line as the verdict.
    if (!anyMatch(POPULATION, printed)) findings.push('NO-POPULATION');
    // A control may live anywhere in the file, including a --selftest branch.
    if (!isSuite(file) && !anyMatch(CONTROL, source)) findings.push('NO-CONTROL');

    return { file, claimsAbsence: true, findings };
}

function collect() {
    const files = [];
    for (const dir of SCAN_DIRS) {
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.js')) continue;
            files.push(path.join(dir, name));
        }
    }
    return files.sort();
}

function scan({ strict }) {
    const files = collect();
    const results = files.map(inspect);
    const reporters = results.filter((r) => r.claimsAbsence);
    const flagged = reporters.filter((r) => r.findings.length);

    for (const r of flagged) {
        const rel = path.relative(ROOT, r.file).replace(/\\/g, '/');
        console.log(`  ${r.findings.join(' ')}  ${rel}`);
    }

    // This gate reports its own population, for the reason it exists.
    console.log(
        `[population] ${files.length} script(s) read across ${SCAN_DIRS.length} directory(ies), ` +
            `${reporters.length} report an absence or all-clear, ` +
            `${flagged.length} of those are missing a population line or a control`
    );

    if (!flagged.length) {
        process.exit(0);
    }
    if (strict) process.exit(1);
    console.log('[population] advisory only; pass --strict to fail on these');
    process.exit(0);
}

// A planted negative must be impossible by construction, so the fixtures are
// derived from the patterns under test rather than from a hand-written guess.
function selftest() {
    const cases = [
        {
            name: 'absence with no population and no control is flagged twice',
            source: 'console.log("no issues found");',
            expect: ['NO-POPULATION', 'NO-CONTROL'],
        },
        {
            name: 'absence with a population and a control is clean',
            source:
                '// known-positive control runs first\n' +
                'console.log(`no issues found (${n} of ${total} files scanned)`);',
            expect: [],
        },
        {
            name: 'absence with a population but no control keeps NO-CONTROL',
            source: 'console.log("no issues found in 12 of 12 files");',
            expect: ['NO-CONTROL'],
        },
        {
            name: 'a script making no absence claim is never inspected',
            source: 'console.log("wrote 3 files");',
            expect: [],
        },
        {
            name: 'an absence pattern in a non-printing line is not a verdict',
            source: 'const ABSENCE = /none found/i;\nconsole.log("done");',
            expect: [],
        },
        {
            // The repo writes populations as N/N. The first live run flagged
            // test-all.js for exactly this and the gate was wrong, not the file.
            name: 'the N/N idiom counts as a population',
            source: '// control\nconsole.log("85/85 suites passed, none found failing");',
            expect: [],
        },
        {
            name: 'a suite is exempt from NO-CONTROL but not from NO-POPULATION',
            file: 'test-fixture-example.js',
            source: 'console.log("no issues found");',
            expect: ['NO-POPULATION'],
        },
        {
            // Derived from the real defect: this is test-all.js's own shape,
            // and a line-scoped reader calls it NO-POPULATION.
            name: 'a population on a continuation line of the same call is seen',
            file: 'test-fixture-multiline.js',
            source:
                'console.log(\n' +
                '  `\\n${results.length - failed}/${results.length} suites passed, none failing`\n' +
                ');\n',
            expect: [],
        },
    ];

    // Fixtures live outside the repo. A gate that writes into the tree it
    // grades makes any concurrent run read a file that was never committed --
    // the same tree-instability that produced a false failure here before.
    const box = fs.mkdtempSync(path.join(require('os').tmpdir(), 'population-selftest-'));
    let failed = 0;
    try {
        for (const c of cases) {
            const tmp = path.join(box, c.file || 'fixture.js');
            fs.writeFileSync(tmp, c.source, 'utf8');
            const got = inspect(tmp).findings.sort();
            const want = c.expect.slice().sort();
            const ok = got.join(',') === want.join(',');
            if (!ok) failed++;
            console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : `  got [${got}] want [${want}]`}`);
        }
    } finally {
        fs.rmSync(box, { recursive: true, force: true });
    }

    console.log(`[selftest] ${cases.length} case(s) run, ${cases.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
else scan({ strict: argv.includes('--strict') });
