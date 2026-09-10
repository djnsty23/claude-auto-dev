#!/usr/bin/env node
'use strict';
// Tests for tooling/subject-evidence.js — the ordering and traversal that decides
// which derived subject check-suites-can-fail.js stubs first, and when it stops.
//
// WHAT THIS IS FOR. `[measured 2026-09-10]` the sweep performed 350 suite PROCESS
// RUNS for 123 suites because it stubbed every derived candidate in turn, and
// candidates come from path literals: test-fleet-overlap derives 12, of which 7
// are entries in fixture arrays naming files it writes into throwaway git repos
// and never reads. Its real subject sat NINTH.
//
// THREE THINGS THIS DOES THAT THE MODULE'S OWN --selftest CANNOT.
//
//   1. It SPAWNS the CLI and reads the exit code. No in-process assertion sees one.
//   2. It ranks the REAL derived lists of the REAL suites in this tree, rather
//      than hand-built fixtures, so a ranking that works only on examples chosen
//      to suit it is caught.
//   3. It guards the WIRING: check-suites-can-fail.js must actually call
//      firstKiller, and must not have grown a second hand-rolled traversal beside
//      it. A policy module nothing routes through is the silent-skip failure that
//      file exists to prevent, turned on this change.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ev = require('./subject-evidence.js');

const TOOLING = __dirname;
const SUBJECT = path.join(TOOLING, 'subject-evidence.js');
const SWEEP = path.join(TOOLING, 'check-suites-can-fail.js');

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
}

// --- the CLI contract, which only a subprocess can see -----------------------
{
    const st = spawnSync(process.execPath, [SUBJECT, '--selftest'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const childFails = (st.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
    // Exit 0 ALONE is not evidence here, and a canary proved it: stubbed with
    // `module.exports = {}` the module has no CLI at all, so --selftest exits 0
    // having run nothing and an assertion on the status alone PASSES. A gate that
    // passes on emptiness is worse than no gate, so the status is asserted
    // together with the module having actually said something.
    check("the module's own --selftest is RUN here, so it is not a check nobody executes",
        st.status === 0 && /^PASS /m.test(st.stdout || ''),
        `status=${st.status} signal=${st.signal} stdout=${JSON.stringify((st.stdout || '').slice(0, 80))}`
        + (childFails.length ? ' -> ' + childFails.join(' | ') : ''));
    const m = /population: (\d+) assertions run, (\d+) passed, (\d+) failed/.exec(st.stdout || '');
    check('  and it reports the population it ran, not a bare verdict', !!m,
        JSON.stringify((st.stdout || '').slice(-200)));
    check('  with nothing failing', !!m && m[3] === '0', m ? m[3] + ' failed' : 'no population line');
    check('  over a non-trivial number of cases', !!m && Number(m[1]) >= 15, m ? m[1] : 'none');

    const h = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    check('--help RETURNS rather than doing anything, which check-entrypoints requires of '
        + 'every tooling/*.js', h.status === 0 && /usage:/.test(h.stdout || ''), `status=${h.status}`);
    const bare = spawnSync(process.execPath, [SUBJECT], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    check('run bare it prints usage and exits 0 rather than doing something destructive',
        bare.status === 0 && /usage:/.test(bare.stdout || ''), `status=${bare.status}`);
}

// --- ranking over the REAL suites in this tree, via the REAL derivation -------
// Not hand-built fixtures, and not a reimplementation: deriveCandidates is the
// function check-suites-can-fail.js calls. The first draft of this block
// reimplemented rule 1 alone and covered 0 of the namesake cases the change is
// about — caught by the population floor below, which is why it is there.
//
// The property asserted is decidable without knowing which file is "really" the
// subject: whenever a suite has a namesake among its candidates, ranking puts it
// first; and ranking is always a permutation, never a filter.
{
    const ROOT = path.join(TOOLING, '..');
    const suites = fs.readdirSync(TOOLING).filter((f) => /^test-.*\.js$/.test(f)).sort();
    let withNamesake = 0, firstAlready = 0, movedUp = 0, scanned = 0, totalCandidates = 0;
    const notPermutation = [], namesakeNotFirst = [], positions = [];
    for (const suite of suites) {
        const prov = ev.deriveCandidates(path.join(TOOLING, suite), ROOT);
        const cands = [...prov.keys()];
        if (cands.length < 2) continue;
        scanned++;
        totalCandidates += cands.length;
        const ranked = ev.rankSubjects(suite, cands, prov);
        if (ranked.length !== cands.length || !cands.every((c) => ranked.includes(c))
            || new Set(ranked).size !== ranked.length) {
            notPermutation.push(suite);
        }
        const namesake = ev.namesakeOf(suite);
        const has = cands.find((c) => path.basename(c) === namesake);
        if (!has) continue;
        withNamesake++;
        const before = cands.indexOf(has);
        if (ranked[0] === has) {
            if (before === 0) firstAlready++;
            else { movedUp++; positions.push(`${suite}: ${before + 1} -> 1 of ${cands.length}`); }
        } else {
            namesakeNotFirst.push(`${suite}: namesake ${has} ranked ${ranked.indexOf(has) + 1}`);
        }
    }
    check(`ranking is a permutation for all ${scanned} real suites with 2+ derived candidates `
        + `(${totalCandidates} candidates in total) — no duplicates, no losses`,
        notPermutation.length === 0, notPermutation.join(', '));
    check(`every real suite with a namesake candidate ranks it first (${withNamesake} such suites)`,
        namesakeNotFirst.length === 0, namesakeNotFirst.slice(0, 4).join(' | '));
    check('  population floor: real suites with a namesake candidate were actually found, so '
        + 'the line above is not passing on an empty scan', withNamesake >= 5,
        `withNamesake=${withNamesake} scanned=${scanned}`);
    check(`  and ranking does real work — ${movedUp} suite(s) had their namesake PROMOTED from `
        + `a later position (${firstAlready} were already first)`, movedUp >= 1,
        positions.slice(0, 5).join(' | ') || `movedUp=${movedUp} firstAlready=${firstAlready}`);
    // The measured case that started this, named so a future change that loses it
    // fails here rather than quietly costing eight runs again.
    {
        const suite = 'test-fleet-overlap.js';
        if (fs.existsSync(path.join(TOOLING, suite))) {
            const prov = ev.deriveCandidates(path.join(TOOLING, suite), ROOT);
            const cands = [...prov.keys()];
            const ranked = ev.rankSubjects(suite, cands, prov);
            const before = cands.findIndex((c) => path.basename(c) === 'fleet-overlap.js');
            check(`the measured case: test-fleet-overlap's real subject was candidate `
                + `${before + 1} of ${cands.length} and is now first`,
                before > 0 && path.basename(ranked[0]) === 'fleet-overlap.js',
                `before=${before + 1} ranked[0]=${ranked[0]}`);
        }
    }
}

// --- the wiring, which is how this change could silently stop applying -------
{
    const src = fs.readFileSync(SWEEP, 'utf8');
    check('check-suites-can-fail.js requires the policy module', /require\('\.\/subject-evidence\.js'\)/.test(src));
    check('  and routes its traversal through firstKiller', /ev\.firstKiller\(/.test(src));
    check('  and ranks derived candidates through rankSubjects', /ev\.rankSubjects\(/.test(src));
    check('  and still offers --all-subjects, so the full kill set stays obtainable',
        /--all-subjects/.test(src));
    // A derived list must never be FILTERED by evidence. This is the invariant the
    // whole design rests on, and the grep is deliberately about the shape of the
    // call: rankSubjects returns a permutation, so its result must not be narrowed.
    check('  and the ranked result is not filtered before use — ordering may be a guess, '
        + 'selection may not', !/rankSubjects\([^)]*\)\s*\.filter/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('subject: tooling/subject-evidence.js; its --selftest is spawned here so the exit '
    + 'code is asserted, the ranking is applied to the real suites in this tree rather than to '
    + 'fixtures, and the wiring into check-suites-can-fail.js is grepped so the policy cannot '
    + 'stop applying in silence.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
