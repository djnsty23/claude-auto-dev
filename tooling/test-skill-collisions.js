#!/usr/bin/env node
// Acceptance tests for check-skill-collisions.js.
//
// The thing worth testing is not "does it print pairs". It is that the TRIAGE
// map cannot rot into a blanket exemption, because that is how a reviewed-once
// gate stops being a gate. Two of the cases below therefore mutate the checker
// in a scratch copy and assert it goes red: one un-triages a cleared pair, one
// points an entry at a skill that does not exist.
//
// The copy lives in tooling/ on purpose. The checker resolves its corpus as
// `__dirname/../plugins`, so a copy anywhere else silently audits nothing and
// every assertion here would pass against an empty population.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUBJECT = path.join(ROOT, 'tooling', 'check-skill-collisions.js');

const cases = [];
const check = (label, ok, why) => cases.push([label, ok, why]);
const run = (file, args = []) =>
    spawnSync(process.execPath, [file, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
    });

/** Write a mutated copy beside the subject, run it, always clean up. */
function withMutant(replace, fn) {
    const src = fs.readFileSync(SUBJECT, 'utf8');
    if (!src.includes(replace.from)) {
        throw new Error(`mutation anchor absent, the subject changed: ${replace.from}`);
    }
    const file = path.join(ROOT, 'tooling', `_mutant-collisions-${process.pid}.js`);
    fs.writeFileSync(file, src.replace(replace.from, replace.to), 'utf8');
    try {
        return fn(file);
    } finally {
        fs.rmSync(file, { force: true });
    }
}

try {
    const help = run(SUBJECT, ['--help']);
    check('--help returns 0 without auditing', help.status === 0, `status=${help.status}`);
    check('  and names the flags', /--selftest/.test(help.stdout), 'no flag list in output');

    const self = run(SUBJECT, ['--selftest']);
    check('--selftest passes', self.status === 0 && /0 failed/.test(self.stdout), self.stdout.slice(-200));

    const audit = run(SUBJECT);
    check('the repo audit is clean', audit.status === 0, `status=${audit.status}\n${audit.stdout}`);

    // Population control. A clean exit from a run that compared nothing is
    // indistinguishable from a clean corpus, and this repo has been bitten by
    // exactly that shape before.
    const pop = audit.stdout.match(/population: (\d+) skill\(s\).*?(\d+) pair\(s\) compared/s);
    check('  and it reports the population it compared', Boolean(pop), audit.stdout.slice(0, 200));
    check('  with a real corpus behind it, not an empty scan',
        pop && Number(pop[1]) > 20 && Number(pop[2]) > 100,
        pop ? `skills=${pop[1]} pairs=${pop[2]}` : 'no population line');

    // MUTATION 1: a cleared pair that stops being cleared must go red.
    const unTriaged = withMutant(
        { from: "['grilling|rule-diagnosis',", to: "['grilling|rule-diagnosis-REMOVED'," },
        (f) => run(f),
    );
    check('un-triaging a cleared pair makes it FAIL',
        unTriaged.status === 1, `status=${unTriaged.status}`);
    check('  and the pair is reported as NEW, not silently counted',
        /NEW\s+grilling\s+<->\s+rule-diagnosis/.test(unTriaged.stdout),
        unTriaged.stdout.slice(0, 400));

    // MUTATION 2: an entry naming a skill that does not exist must go red,
    // so the map cannot outlive the skills it exempts.
    const staleEntry = withMutant(
        { from: "['learn-from-fixes|preflight',", to: "['no-such-skill|preflight'," },
        (f) => run(f),
    );
    check('an entry naming a missing skill is reported STALE',
        /STALE\s+no-such-skill\|preflight/.test(staleEntry.stdout),
        staleEntry.stdout.slice(0, 400));
    check('  and STALE alone fails the run', staleEntry.status === 1, `status=${staleEntry.status}`);

    check('control: no mutant file survives the run',
        fs.readdirSync(path.join(ROOT, 'tooling')).filter((f) => f.startsWith('_mutant-')).length === 0,
        'a mutant was left behind');
} catch (err) {
    check('the suite ran to completion', false, err.message);
}

let pass = 0, fail = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
