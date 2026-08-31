#!/usr/bin/env node
// check-claim-provenance.js - a completeness or absence claim must say where it
// came from.
//
// WHY THIS EXISTS, measured rather than imagined.
//
// On 2026-08-31 one session produced five confident claims that were wrong, in
// a single working day:
//
//   "valid GPT models are exactly 3"     the real list was 8; three invented
//                                        names had 400'd and that was reported
//                                        as a fact about the API
//   "the reviewer has an edge on X"      the two reviewers had unequal tool
//                                        grants, so the comparison was void
//   "its test file was erased"           a timeline inference; the file had
//                                        been restored deliberately
//   "model read-back returned nothing"   the parser was broken, not the data
//   "that model ran 40 times"            the wrong sample of files
//
// Every one was caught by a human, by the other model, or by a second probe run
// on a hunch. NOTHING in this repo could tell a measurement from a guess,
// because provenance is a prose rule with no enforcement. A wrong claim told to
// a person costs a correction; the same claim written into another agent's
// brief becomes built work.
//
// WHAT IT CHECKS, and deliberately what it does not.
//
// Only ABSENCE and COMPLETENESS claims: "exactly N", "only N", "no X found",
// "none", "zero X", "all of them". Those are linguistically distinctive, they
// are where every one of the five failures lived, and they are the shape that
// reads as authoritative while resting on whatever population the author
// happened to scan.
//
// It does NOT try to detect qualitative claims ("X is better at Y"). Two of the
// five were that shape and this gate would not have caught them. Claiming
// otherwise would make it exactly the kind of check it exists to prevent, so
// the limit is stated here and in --history output.
//
// A claim clears the gate when its paragraph carries provenance: a [measured],
// [measured <date>], [reported], [stated] or [inferred] tag, or a backticked
// command that a reader could re-run.
//
// Usage:
//   node tooling/check-claim-provenance.js --check-message <file>   (commit-msg hook)
//   node tooling/check-claim-provenance.js --history [N]            (precision on real history)
//   node tooling/check-claim-provenance.js --selftest

const fs = require('fs');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// The patterns. Narrow on purpose: this gate is worth nothing if it gets muted,
// and a detector that fires on ordinary prose gets muted within a day.
// ---------------------------------------------------------------------------
const CLAIM = [
    // "exactly 3", "only 8 models", "just 2 remaining"
    /\b(?:exactly|only|just)\s+\d+\b/i,
    // "no X found", "found no X", "nothing found"
    /\b(?:no|zero)\s+[\w-]+(?:\s+[\w-]+)?\s+(?:found|exist|exists|remain|remains|present)\b/i,
    /\bfound\s+(?:no|zero|nothing)\b/i,
    // "none found", "none of them", bare "none" as a verdict
    /\bnone\s+(?:found|remain|exist|of\s+them)\b/i,
    // completeness: "all N", "every one of the N", "the complete list"
    /\b(?:all|every)\s+\d+\b/i,
    /\bcomplete\s+list\b/i,
    // "N of N" is NOT detected, and that is a decision rather than an
    // oversight. It was in the first version, and on 400 real commits it was
    // the single largest source of noise: this repo reports every gate run that
    // way ("76/76 exit 0", "5/5", "68/68 suites"), so the pattern fires
    // constantly on numbers that came straight off a run. It is also not the
    // shape that caused harm - the five wrong claims this gate exists for were
    // completeness and absence claims, not coverage counts. Detecting it would
    // buy nothing and cost the gate its credibility.
];

// Provenance that satisfies the gate.
const PROVENANCE = [
    /\[measured(?:\s+\d{4}-\d{2}-\d{2})?\]/i,
    /\[reported(?:\s+\d{4}-\d{2}-\d{2})?\]/i,
    /\[stated(?:\s+\d{4}-\d{2}-\d{2})?\]/i,
    /\[inferred\]/i,
    /\[unverified\]/i,
    // A command a reader could re-run is provenance by construction, backticked
    // or not. THIS REPO WRITES THEM BARE ("npm test 76/76 exit 0"), and the first
    // version demanded backticks, so its first real-history run flagged 186 of 400
    // commits: 46.5%, almost all false. A detector at that rate is muted within a
    // day and then misses the real one, which this repo already has an incident
    // about. Widened after measuring, not before.
    /\b(?:npm|node|git|gh|grep|rg|python|py|curl|doppler|pytest|cargo)\s+[\w:.\/-]/,
    // Words this repo uses to mark a result as observed rather than believed.
    /\b(?:measured|verified|gate|selftest)\b/i,
    // An explicit exit status is a result someone read off a run.
    /\bexit\s+\d+\b/i,
];

function paragraphs(text) {
    // Comment lines never reach a commit message, so they are not claims.
    const body = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const out = [];
    let buf = [];
    let start = 1;
    let n = 0;
    for (const line of body.split('\n')) {
        n += 1;
        if (line.trim() === '') {
            if (buf.length) { out.push({ start, text: buf.join('\n') }); buf = []; }
            start = n + 1;
        } else {
            if (!buf.length) start = n;
            buf.push(line);
        }
    }
    if (buf.length) out.push({ start, text: buf.join('\n') });
    return out;
}

function scan(text) {
    const findings = [];
    let claimParas = 0;
    const paras = paragraphs(text);
    for (const p of paras) {
        const hit = CLAIM.find((re) => re.test(p.text));
        if (!hit) continue;
        claimParas += 1;
        if (PROVENANCE.some((re) => re.test(p.text))) continue;
        const line = p.text.split('\n').find((l) => hit.test(l)) || p.text.split('\n')[0];
        findings.push({ line: p.start, text: line.trim().slice(0, 110) });
    }
    return { findings, paragraphs: paras.length, claimParagraphs: claimParas };
}

// ---------------------------------------------------------------------------
function checkMessage(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        console.error('cannot read message file: ' + (e.code || e.message));
        process.exit(2);
    }
    const r = scan(text);
    // Population beside the count, always: a bare verdict is indistinguishable
    // from a check that found nothing because it looked nowhere.
    console.error('  scanned ' + r.paragraphs + ' paragraph(s), '
        + r.claimParagraphs + ' carrying an absence/completeness claim, '
        + r.findings.length + ' unlabelled');
    if (!r.findings.length) process.exit(0);
    for (const f of r.findings) console.error('  ' + f.line + ': ' + f.text);
    process.exit(1);
}

function history(n) {
    let log;
    try {
        log = execFileSync('git',
            ['log', '-n', String(n), '--format=%H%x00%B%x01'], { encoding: 'utf8' });
    } catch (e) {
        console.error('git log failed: ' + (e.message || e));
        process.exit(2);
    }
    const commits = log.split('\x01').map((c) => c.trim()).filter(Boolean);
    let withClaims = 0;
    let unlabelled = 0;
    const examples = [];
    for (const c of commits) {
        const [sha, body] = c.split('\x00');
        const r = scan(body || '');
        if (r.claimParagraphs) withClaims += 1;
        if (r.findings.length) {
            unlabelled += 1;
            if (examples.length < 12) {
                examples.push((sha || '').slice(0, 9) + '  ' + r.findings[0].text);
            }
        }
    }
    console.log('population: ' + commits.length + ' commit message(s) scanned');
    console.log('  ' + withClaims + ' carry an absence or completeness claim');
    console.log('  ' + unlabelled + ' of those carry NO provenance tag or command');
    console.log('');
    for (const e of examples) console.log('  ' + e);
    console.log('');
    console.log('This gate detects absence and completeness claims only. Qualitative');
    console.log('claims ("X is better at Y") are NOT detected and never will be by this');
    console.log('check. Two of the five failures that motivated it were that shape.');
    process.exit(0);
}

function selftest() {
    const cases = [
        // [label, text, expect findings]
        ['bare "exactly N" is a claim', 'Valid models are exactly 3.', 1],
        ['same claim with [measured] passes', 'Valid models are exactly 3. [measured 2026-08-31]', 0],
        ['same claim with a command passes', 'Valid models are exactly 3, per `node probe.js --list`.', 0],
        ['absence claim is caught', 'Swept the tree and no orphan files exist.', 1],
        ['absence claim with [reported] passes', 'no orphan files exist [reported]', 0],
        ['coverage verdict is deliberately NOT a claim', 'The suite is 84 of 85 green.', 0],
        ['coverage verdict with a command also passes', '84 of 85 green, from `npm test`.', 0],
        ['ordinary prose is not a claim', 'Refactored the loader and tidied its comments.', 0],
        ['a version number is not a claim', 'Bumped to 8.143.0 across the manifests.', 0],
        ['comment lines are ignored', '# exactly 3 things\nRefactored the loader.', 0],
        ['provenance in the SAME paragraph only', 'exactly 3 models.\n\n[measured] unrelated note.', 1],
    ];
    let pass = 0;
    let fail = 0;
    for (const [label, text, expect] of cases) {
        const got = scan(text).findings.length;
        const ok = got === expect;
        console.log((ok ? 'PASS  ' : 'FAIL  ') + label
            + (ok ? '' : '  (expected ' + expect + ', got ' + got + ')'));
        ok ? pass++ : fail++;
    }
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv[0] === '--check-message' && argv[1]) checkMessage(argv[1]);
else if (argv[0] === '--history') history(parseInt(argv[1] || '400', 10));
else if (argv[0] === '--selftest') selftest();
else {
    console.error('usage: --check-message <file> | --history [N] | --selftest');
    process.exit(2);
}
