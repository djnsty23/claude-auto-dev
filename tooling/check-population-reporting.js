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
// KNOWN SCOPE LIMIT, stated because a silent one is worse than a loud gap:
// NO-CONTROL reads only the subject file. A script whose known-positive lives
// in a separate suite is reported here even though it is covered, and the
// review that found this was right to call it a false positive by that
// reading. It is deliberate rather than unfixed: the question this asks is
// whether a LIVE RUN proves it can see before it reports nothing, and a suite
// that runs in CI does not travel with the live run. Read a NO-CONTROL row as
// "this script cannot vouch for itself at runtime", not as "untested".
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
//
// EVERY PATTERN MUST BIND A NUMBER TO THE SUBJECT. The first version accepted
// the bare phrase "out of" and the bare words "scanned", "population" and
// "examined", so the string "no issues found; scanner ran out of memory"
// counted as a population and lost its finding. A population word with no
// quantity beside it is prose, not a denominator.
const NUM = String.raw`(?:\d+|\$\{[^}]*\})`;
const POPULATION = [
    new RegExp(`${NUM}\\s+of\\s+${NUM}`),        // "310 of 310", "${hit} of ${total}"
    new RegExp(`${NUM}\\s*/\\s*${NUM}`),         // "85/85", "${pass}/${total}"
    /\$\{[^}]*\.length\b/,                       // "${files.length} files"
    /\$\{[^}]*\b(?:count|total|scanned|population|seen|examined)\b[^}]*\}/i,
    // A population word, but only with a quantity within a short reach of it.
    new RegExp(`\\b(?:scanned|examined|read|seen|population)\\b[^\\n.;]{0,30}${NUM}`, 'i'),
    new RegExp(`${NUM}[^\\n.;]{0,30}\\b(?:scanned|examined|read|seen|files?|scripts?|rows?|records?)\\b`, 'i'),
];

// Evidence the script proves it can see before reporting that it saw nothing.
//
// The second half of this list is THIS REPO'S OWN VOCABULARY for the idea, and
// leaving it out was the third time in one day a gate was keyed on the author's
// words instead of the codebase's. analyze-session-patterns.js prints "PROBE
// BLIND - no transcripts found at all"; analyze-agent-cost.js prints "REFUSING
// TO REPORT: found main transcripts but zero subagent files"; auto-brain-survey
// and check-assignment both print "COULD NOT ...: this is NOT '0 repos'". Every
// one of those IS the control, expressed better than the word "control" would
// have expressed it.
const CONTROL = [
    /\bknown[- ]positive\b/i,
    /\bcontrol\b/i,
    /\bselftest\b/i,
    /\bmutation\b/i,
    /\bPROBE BLIND\b/i,
    /\bREFUSING TO (?:REPORT|RUN|ANSWER)\b/i,
    /\bCOULD NOT [A-Z]/,
    /\bthis is NOT\b/,
    /\bso the probe could see\b/i,
];

// Only lines that actually reach a reader. A regex living in a pattern table
// is not a verdict, and counting it as one is how a linter invents findings.
const EMITS = /\bconsole\.(?:log|error|warn)\b|\bprocess\.std(?:out|err)\.write\b/;

// Blank out everything that is not code -- string bodies, template bodies,
// comments and regex literals -- preserving length and newlines so the result
// lines up with the original line for line.
//
// Counting raw characters was wrong twice over. A `)` inside a string literal
// drove the depth to zero and the rest of the call was silently dropped, which
// is a FALSE NEGATIVE: the gate reported nothing rather than reporting wrongly.
// A `(` inside a comment or a regex had the mirror effect. Parentheses only
// mean anything in code, so only code is counted.
// `commentsOnly` blanks comments and leaves strings and regexes intact. That is
// the right mask for the CONTROL check: a control described in a comment is not
// a control, but one whose message is a printed string literal is evidence of a
// real code path. Matching CONTROL against raw source accepted the comment
// `// known-positive control runs first` as an executable guard, and two
// selftest cases blessed that -- a gate certifying its own blind spot.
function maskNonCode(source, commentsOnly = false) {
    const out = Array.from(source);
    let i = 0;
    const n = source.length;
    // A `/` opens a regex only where a value may begin. This is the standard
    // heuristic; it cannot be exact without parsing, and it errs toward
    // treating a `/` as division, which is the safe direction here.
    const regexMayStart = (k) => {
        for (let p = k - 1; p >= 0; p--) {
            const c = source[p];
            if (c === ' ' || c === '\t') continue;
            if (c === '\n' || c === '\r') return true;
            return '(,=:[!&|?{};+-*%~^<>'.includes(c);
        }
        return true;
    };
    const blank = (from, to) => {
        for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    };

    while (i < n) {
        const c = source[i];
        const next = source[i + 1];
        if (c === '/' && next === '/') {
            let j = i;
            while (j < n && source[j] !== '\n') j++;
            blank(i, j);
            i = j;
        } else if (c === '/' && next === '*') {
            let j = i + 2;
            while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
            blank(i, Math.min(j + 2, n));
            i = j + 2;
        } else if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < n) {
                if (source[j] === '\\') { j += 2; continue; }
                if (source[j] === c) break;
                if (c !== '`' && source[j] === '\n') break; // unterminated; stop at EOL
                j++;
            }
            if (!commentsOnly) blank(i + 1, j);
            i = j + 1;
        } else if (c === '/' && !commentsOnly && regexMayStart(i)) {
            let j = i + 1;
            let closed = false;
            while (j < n && source[j] !== '\n') {
                if (source[j] === '\\') { j += 2; continue; }
                if (source[j] === '[') { while (j < n && source[j] !== ']' && source[j] !== '\n') j++; }
                if (source[j] === '/') { closed = true; break; }
                j++;
            }
            if (closed) { blank(i + 1, j); i = j + 1; } else i++;
        } else {
            i++;
        }
    }
    return out.join('');
}

// The unit a printed fact lives in is the CALL, not the line. test-all.js
// opens `console.log(` on one line and puts "${n}/${total} suites passed" on
// the next, and a line-scoped reader reports it as having no population --
// which is what the first live run did. Read from the emitting line until the
// parentheses balance IN CODE.
//
// The cap is a runaway guard, not a semantic limit. At 12 it silently truncated
// any legitimate call longer than 12 lines, which is a second false-negative
// class; a call that does not balance within the guard is now reported rather
// than quietly dropped.
const CALL_LINE_GUARD = 200;

function emittedText(source) {
    const lines = source.split(/\r?\n/);
    const masked = maskNonCode(source).split(/\r?\n/);
    const out = [];
    const unbalanced = [];
    for (let i = 0; i < lines.length; i++) {
        // Detect the call on MASKED text, so `console.log` mentioned inside a
        // string or a comment is not mistaken for a call.
        if (!EMITS.test(masked[i])) continue;
        let depth = 0;
        let opened = false;
        let closedAt = -1;
        for (let j = i; j < Math.min(lines.length, i + CALL_LINE_GUARD); j++) {
            out.push(lines[j]);
            for (const ch of masked[j]) {
                if (ch === '(') { depth++; opened = true; }
                else if (ch === ')') depth--;
            }
            if (opened && depth <= 0) { closedAt = j; break; }
        }
        if (opened && closedAt === -1) unbalanced.push(i + 1);
    }
    return { text: out.join('\n'), unbalanced };
}

function anyMatch(patterns, text) {
    return patterns.some((p) => p.test(text));
}

// This repo builds printed lines two ways: a template literal, and string
// concatenation with `+`. steer-log.js prints
//   'ZERO steers found across ' + population.transcripts + ' transcripts.'
// which is a population by any reading, and matched nothing because every
// pattern was written for `${...}`. Rewriting a splice into template form lets
// one set of patterns cover both spellings, rather than doubling the table --
// keying a gate on one of two spellings is the same error four times over now.
function normalizeConcat(text) {
    return text
        .replace(/['"]\s*\+\s*([\w.$[\]()]+)\s*\+\s*['"]/g, '${$1}')
        .replace(/['"]\s*\+\s*([\w.$[\]()]+)\s*(?=[,;)\n]|$)/g, '${$1}');
}

// RETRACTED: an earlier version exempted `test-*.js` from NO-CONTROL, on the
// stated grounds that check:vacuity already answers the control question for
// suites. That justification was false. check:vacuity (find-vacuous-assertions)
// takes one explicit <subject.js> <suite.js> pair, documents in its own header
// that there is deliberately no sweep-the-whole-repo mode, and is not part of
// `npm run gate`. Nothing runs it over every suite, so the exemption was
// unconditional suppression rather than delegated coverage, and it would not
// have noticed a suite's existing guard being deleted. No exemption now.

function inspect(file) {
    const source = fs.readFileSync(file, 'utf8');
    const { text: printed, unbalanced } = emittedText(source);

    const claimsAbsence = anyMatch(ABSENCE, printed);
    if (!claimsAbsence) return { file, claimsAbsence: false, findings: [] };

    const findings = [];
    // The population may be printed anywhere the reader sees it, not only on
    // the same line as the verdict.
    if (!anyMatch(POPULATION, normalizeConcat(printed))) findings.push('NO-POPULATION');
    // A control may live anywhere in the file, including a --selftest branch,
    // but it must be CODE. Comments are stripped first; a promise in a comment
    // is not a guard that runs.
    if (!anyMatch(CONTROL, maskNonCode(source, true))) findings.push('NO-CONTROL');
    // Say so rather than silently reading a truncated call.
    if (unbalanced.length) findings.push(`UNREAD-CALL@${unbalanced.join(',')}`);

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
                'if (!total) console.error("PROBE BLIND: nothing was scanned");\n' +
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
            source:
                'if (!n) throw new Error("REFUSING TO REPORT: saw nothing");\n' +
                'console.log("85/85 suites passed, none found failing");',
            expect: [],
        },
        {
            // The exemption this replaces was justified on a false premise.
            // A suite now answers for its own control like anything else.
            name: 'a suite gets no exemption from NO-CONTROL',
            file: 'test-fixture-example.js',
            source: 'console.log("no issues found");',
            expect: ['NO-POPULATION', 'NO-CONTROL'],
        },
        {
            // Derived from the real defect: this is test-all.js's own shape,
            // and a line-scoped reader calls it NO-POPULATION.
            //
            // The first version of this fixture said "none failing", which
            // matches no absence pattern, so it asserted [] and got [] without
            // ever exercising the multi-line read. It passed for eight runs
            // while testing nothing. The verdict text now really is an absence.
            name: 'a population on a continuation line of the same call is seen',
            file: 'test-fixture-multiline.js',
            source:
                'console.log(\n' +
                '  `\\n${results.length - failed}/${results.length} suites passed, no failures found`\n' +
                ');\n',
            expect: ['NO-CONTROL'],
        },
        {
            // F1, from the review. "ran out of memory" is prose, not a count,
            // and the bare phrase "out of" used to satisfy the population rule.
            name: 'a population word with no quantity is prose, not a denominator',
            source: 'console.log("no issues found; scanner ran out of memory");',
            expect: ['NO-POPULATION', 'NO-CONTROL'],
        },
        {
            // F5, from the review. The word in a comment is a promise, not a
            // guard. Two fixtures used to pass on exactly this and blessed the
            // blind spot they were meant to catch.
            name: 'a control named only in a comment is not a control',
            source:
                '// known-positive control runs first\n' +
                'console.log("no issues found in 12 of 12 files");',
            expect: ['NO-CONTROL'],
        },
        {
            // steer-log.js's real shape. A count spliced with + is a count.
            name: 'a population spliced with + counts, not only a template literal',
            source:
                "if (!population.transcripts) console.error('PROBE BLIND: no transcripts');\n" +
                "console.log('  ZERO steers found across ' + population.transcripts + ' transcripts.');",
            expect: [],
        },
        {
            // Same shape, the other bare words that used to pass.
            name: 'bare scanned/examined/population without a number do not count',
            source: 'console.log("none found. the population was examined and scanned");',
            expect: ['NO-POPULATION', 'NO-CONTROL'],
        },
        {
            // F2, from the review. The `)` inside the string used to drive the
            // paren depth to zero, so the verdict on the next line was never
            // read and the script vanished from the findings entirely.
            name: 'a closing paren inside a string does not truncate the call',
            source:
                'console.log(\n' +
                "    'a closing parenthesis inside this string: )',\n" +
                "    'no issues found'\n" +
                ');\n',
            expect: ['NO-POPULATION', 'NO-CONTROL'],
        },
        {
            name: 'an opening paren in a comment or a regex does not extend the call',
            source:
                'console.log("no issues found"); // an unmatched ( in a comment\n' +
                'const RE = /a lone \\( in a regex/;\n',
            expect: ['NO-POPULATION', 'NO-CONTROL'],
        },
        {
            name: 'console.log named inside a string is not a call',
            source: 'const help = "run console.log(\\"none found\\") to print";\n',
            expect: [],
        },
        {
            // The old 12-line cap silently truncated any longer call.
            name: 'a call longer than the old 12-line cap is read whole',
            source:
                'console.log(\n' + '  "a",\n'.repeat(14) +
                '  "no issues found"\n' +
                ');\n',
            expect: ['NO-POPULATION', 'NO-CONTROL'],
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
