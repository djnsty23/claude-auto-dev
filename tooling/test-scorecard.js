#!/usr/bin/env node
'use strict';
// test-scorecard.js: the scorecard reader never scores without fresh, populated,
// matching evidence of the required kind, and its arithmetic adds up.
//
// Prints one summary line:
//   stale=UNKNOWN missing_population=UNKNOWN failed_control=FAIL fixture_only=NOT_OPERATIONAL arithmetic=PASS
// and sets a nonzero exitCode when any value differs or any case fails.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sc = require('./scorecard.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-13T20:00:00Z');
let failed = 0;
let ran = 0;
function check(name, cond, detail) {
    ran++;
    if (cond) return;
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard'));
try {
    fs.writeFileSync(path.join(tmp, 'watched.txt'), 'v1');
    const manifest = {
        root: '.',
        aspects: [
            { id: 'A1', name: 'Gate', criteria: [
                { id: 'gate-green', kind: 'installed', watch: ['watched.txt'], probe: 'node -e "console.log(\'suites 7 of 7\')"', expect: 'suites (?<population>\\d+) of \\d+', populationLabel: 'suites' },
                { id: 'gate-weighted', kind: 'fixture', weight: 3, watch: [], probe: 'node -e "process.exitCode=1; console.log(\'suites 7 of 7\')"', expect: 'suites (?<population>\\d+) of \\d+' },
            ] },
            { id: 'A2', name: 'Operation', criteria: [
                { id: 'ops-window', kind: 'operational', watch: [] },
            ] },
        ],
    };
    const mfile = path.join(tmp, 'manifest.json');
    fs.writeFileSync(mfile, JSON.stringify(manifest));
    const loaded = sc.loadManifest(mfile);
    check('manifest loads', loaded.aspects.length === 2);
    check('a bad manifest is refused', sc.validateManifest({ aspects: [{ id: 'X', criteria: [{ id: 'a', kind: 'vibes' }, { id: 'a', kind: 'fixture', weight: 0 }] }] }).length === 3);
    check('an empty manifest is refused', sc.validateManifest({}).length === 1);

    const h1 = sc.watchHash(['watched.txt'], tmp);
    const rec = (over) => ({ criterion: 'gate-green', kind: 'installed', ranUtc: new Date(NOW - DAY).toISOString(), status: 'PASS', population: 7, watchHash: h1, ...over });
    const c = manifest.aspects[0].criteria[0];
    const opts = { now: NOW, currentHash: h1 };

    // Control: fresh, populated, matching, right kind.
    check('fresh evidence passes', sc.criterionStatus(c, [rec()], opts).status === 'PASS');
    check('no receipt is unknown', sc.criterionStatus(c, [], opts).status === 'UNKNOWN');

    const staleR = sc.criterionStatus(c, [rec({ ranUtc: new Date(NOW - 15 * DAY).toISOString() })], opts);
    check('stale for the age reason', /older than 14 days/.test(staleR.why), staleR.why);
    const stale = /older than 14 days/.test(staleR.why) ? staleR.status : `${staleR.status}(wrong reason)`;
    const changed = sc.criterionStatus(c, [rec()], { now: NOW, currentHash: 'other' }).status;
    check('a changed watched file is unknown', changed === 'UNKNOWN', changed);
    const missingPop = sc.criterionStatus(c, [rec({ population: null })], opts).status;
    const zeroPop = sc.criterionStatus(c, [rec({ population: 0 })], opts).status;
    check('a zero population is unknown', zeroPop === 'UNKNOWN', zeroPop);
    const failedControl = sc.criterionStatus(c, [rec({ ranUtc: new Date(NOW - 2 * DAY).toISOString() }), rec({ status: 'FAIL', population: null })], opts);
    check('first red is kept', failedControl.firstRedUtc === new Date(NOW - DAY).toISOString(), failedControl.firstRedUtc);
    const fixtureOnly = sc.criterionStatus(manifest.aspects[1].criteria[0], [{ criterion: 'ops-window', kind: 'fixture', ranUtc: new Date(NOW - DAY).toISOString(), status: 'PASS', population: 30 }], { now: NOW }).status;
    const installedForFixture = sc.criterionStatus({ id: 'gate-green', kind: 'fixture' }, [rec()], opts).status;
    check('a stronger kind satisfies a weaker one', installedForFixture === 'PASS', installedForFixture);
    const fixtureForInstalled = sc.criterionStatus(c, [rec({ kind: 'fixture' })], opts).status;
    check('a fixture never satisfies an installed criterion', fixtureForInstalled === 'UNKNOWN', fixtureForInstalled);

    // Arithmetic: A1 has weights 1 and 3, only weight 1 passes -> 2.5. A2 has nothing -> 0.
    const g = sc.grade(manifest, [rec()], { now: NOW, hashFor: (x) => sc.watchHash(x.watch, tmp) });
    const arithmetic = g.aspects[0].score === 2.5 && g.aspects[1].score === 0 && g.sum === 2.5 && g.mean === 1.3 && g.max === 20;
    check('weights, sum and mean', arithmetic, JSON.stringify({ a1: g.aspects[0].score, a2: g.aspects[1].score, sum: g.sum, mean: g.mean }));
    const report = sc.formatReport(g);
    check('the report prints the population', /over 2 aspects and 3 criteria/.test(report), report.split('\n').pop());

    // Real probes: a passing one writes a populated PASS receipt, a nonzero exit is FAIL even when the pattern matches.
    const receipts = path.join(tmp, 'receipts');
    const pass = sc.runProbe(c, { root: tmp, now: NOW });
    check('a passing probe records its population', pass.status === 'PASS' && pass.population === 7 && pass.watchHash === h1, JSON.stringify(pass).slice(0, 200));
    const nonzero = sc.runProbe(manifest.aspects[0].criteria[1], { root: tmp, now: NOW });
    fs.writeFileSync(path.join(tmp, 'counted.js'), "for (const l of ['ok a', 'ok b', 'BAD c', 'ok d', 'all=PASS']) console.log(l);");
    fs.writeFileSync(path.join(tmp, 'uncounted.js'), "console.log('all=PASS');");
    const counted = sc.runProbe({ id: 'counted', kind: 'fixture', watch: [], probe: 'node counted.js', expect: '^all=PASS$', populationCount: '^ok ' }, { root: tmp, now: NOW });
    check('populationCount counts the matching lines', counted.status === 'PASS' && counted.population === 3, JSON.stringify(counted).slice(0, 200));
    const uncounted = sc.runProbe({ id: 'uncounted', kind: 'fixture', watch: [], probe: 'node uncounted.js', expect: '^all=PASS$', populationCount: '^ok ' }, { root: tmp, now: NOW });
    check('a zero count is no population', uncounted.population === 0 && sc.criterionStatus({ id: 'uncounted', kind: 'fixture' }, [uncounted], { now: NOW }).status === 'UNKNOWN', String(uncounted.population));
    check('a matching line from a failed process is FAIL', nonzero.status === 'FAIL' && nonzero.why === 'exit 1', nonzero.why);

    // A probe killed from outside never reaches its exit event. SIGKILL to itself stands in for
    // the outside kill: TerminateProcess on Windows, an uncatchable signal on POSIX.
    const killSelf = "process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 5000);";
    fs.writeFileSync(path.join(tmp, 'killed.js'), `console.log('all=PASS'); ${killSelf}`);
    const killed = sc.runProbe({ id: 'killed', kind: 'fixture', watch: [], probe: 'node killed.js', expect: '^all=PASS$' }, { root: tmp, now: NOW });
    check('a probe killed twice is INDETERMINATE, not FAIL', killed.status === 'INDETERMINATE' && killed.attempts === 2 && /terminated from outside/.test(killed.why), JSON.stringify(killed).slice(0, 240));
    const killedGrade = sc.criterionStatus({ id: 'killed', kind: 'fixture' }, [killed], { now: NOW });
    check('an INDETERMINATE receipt grades UNKNOWN and says why', killedGrade.status === 'UNKNOWN' && /terminated from outside/.test(killedGrade.why), JSON.stringify(killedGrade));
    fs.writeFileSync(path.join(tmp, 'once.js'), `const f = require('path').join(__dirname, 'once.flag'); if (!require('fs').existsSync(f)) { require('fs').writeFileSync(f, '1'); ${killSelf} } else { console.log('ok a'); console.log('all=PASS'); }`);
    const once = sc.runProbe({ id: 'once', kind: 'fixture', watch: [], probe: 'node once.js', expect: '^all=PASS$', populationCount: '^ok ' }, { root: tmp, now: NOW });
    check('a probe killed once is run again and its second run counts', once.status === 'PASS' && once.attempts === 2 && once.population === 1, JSON.stringify(once).slice(0, 240));
    fs.writeFileSync(path.join(tmp, 'throws.js'), "throw new Error('a real defect');");
    const threw = sc.runProbe({ id: 'throws', kind: 'fixture', watch: [], probe: 'node throws.js', expect: '^all=PASS$' }, { root: tmp, now: NOW });
    check('a probe that throws reached its exit event, so it is FAIL on one run', threw.status === 'FAIL' && threw.attempts === 1, JSON.stringify(threw).slice(0, 240));
    const shellOnly = sc.runProbe({ id: 'shell', kind: 'fixture', watch: [], probe: 'exit 3', expect: '^all=PASS$' }, { root: tmp, now: NOW });
    check('a probe that runs no node process makes no kill claim', shellOnly.status === 'FAIL' && shellOnly.attempts === 1, JSON.stringify(shellOnly).slice(0, 240));
    fs.writeFileSync(path.join(tmp, 'killed-manifest.json'), JSON.stringify({ aspects: [{ id: 'K', criteria: [{ id: 'killed', kind: 'fixture', watch: [], probe: 'node killed.js', expect: '^all=PASS$' }] }] }));
    const mainRc = sc.main(['record', '--manifest', path.join(tmp, 'killed-manifest.json'), '--criterion', 'killed', '--receipts', path.join(tmp, 'killed-receipts')], { log: () => {}, err: () => {} });
    check('record exits 2 for an INDETERMINATE probe', mainRc === 2, String(mainRc));
    sc.writeReceipt(receipts, pass);
    sc.writeReceipt(receipts, nonzero);
    check('receipts read back', sc.readReceipts(receipts).length === 2);
    check('an unreadable dir is no evidence', sc.readReceipts(path.join(tmp, 'absent')).length === 0);
    fs.writeFileSync(path.join(tmp, 'watched.txt'), 'v2');
    check('editing a watched file invalidates the receipt', sc.criterionStatus(c, sc.readReceipts(receipts), { now: NOW + 1000, currentHash: sc.watchHash(['watched.txt'], tmp) }).status === 'UNKNOWN');

    // Owner-held: a decision the owner keeps. No receipt, however good, may turn it PASS.
    const held = { id: 'held', kind: sc.OWNER_HELD, weight: 2, needs: 'the owner reopens X1', watch: [] };
    const heldReceipt = { criterion: 'held', kind: 'operational', ranUtc: new Date(NOW - DAY).toISOString(), status: 'PASS', population: 50, watchHash: sc.watchHash([], tmp) };
    const heldGrade = sc.criterionStatus(held, [heldReceipt], { now: NOW, currentHash: sc.watchHash([], tmp) });
    check('an owner-held criterion never reads PASS from a fresh operational receipt', heldGrade.status === 'OWNER_HELD', JSON.stringify(heldGrade));
    check('an owner-held criterion names its blocker', heldGrade.why === 'owner-held: the owner reopens X1', heldGrade.why);
    check('an owner-held criterion with no receipt is still OWNER_HELD', sc.criterionStatus(held, [], { now: NOW }).status === 'OWNER_HELD');
    const heldAspect = sc.grade({ aspects: [{ id: 'H', criteria: [{ id: 'h-pass', kind: 'fixture', weight: 8, watch: [] }, held] }] },
        [{ criterion: 'h-pass', kind: 'fixture', ranUtc: new Date(NOW - DAY).toISOString(), status: 'PASS', population: 3 }, heldReceipt], { now: NOW });
    check('an owner-held weight counts zero against the aspect', heldAspect.aspects[0].score === 8, String(heldAspect.aspects[0].score));
    check('an owner-held criterion must name its decision', sc.validateManifest({ aspects: [{ id: 'H', criteria: [{ id: 'h', kind: sc.OWNER_HELD }] }] }).length === 1);
    check('an owner-held criterion must have no probe', sc.validateManifest({ aspects: [{ id: 'H', criteria: [{ ...held, probe: 'node x.js' }] }] }).length === 1);
    check('owner-held stays out of the evidence kinds', !sc.KINDS.includes(sc.OWNER_HELD));
    fs.writeFileSync(path.join(tmp, 'held-manifest.json'), JSON.stringify({ aspects: [{ id: 'H', criteria: [held] }] }));
    let heldRc;
    try { heldRc = sc.main(['record', '--manifest', path.join(tmp, 'held-manifest.json'), '--criterion', 'held', '--receipts', path.join(tmp, 'held-receipts')], { log: () => {}, err: () => {} }); }
    catch (e) { heldRc = `threw ${e.code || e.message}`; }
    check('record refuses an owner-held criterion and writes nothing', heldRc === 2 && sc.readReceipts(path.join(tmp, 'held-receipts')).length === 0, String(heldRc));
    const real = sc.loadManifest(path.join(__dirname, '..', 'docs', 'scorecard-criteria.json'));
    const cb = real.aspects.flatMap((a) => a.criteria).find((x) => x.id === 'credential-boundary');
    const cbGrade = cb && sc.criterionStatus(cb, [{ ...heldReceipt, criterion: 'credential-boundary' }], { now: NOW });
    check('the real credential-boundary is owner-held on the N5 decision', cbGrade && cbGrade.status === 'OWNER_HELD' && cbGrade.why === 'owner-held: Andy reopens N5 (declined 2026-09-23)', JSON.stringify(cbGrade));

    // CLI.
    const lines = [];
    const io = { log: (s) => lines.push(s), err: (s) => lines.push(s) };
    check('usage on no command', sc.main([], io) === 2);
    check('report runs', sc.main(['report', '--manifest', mfile, '--receipts', receipts], io) === 0 && /^overall /m.test(lines.join('\n')));
    check('record writes a receipt', sc.main(['record', '--manifest', mfile, '--criterion', 'gate-green', '--receipts', receipts], io) === 0 && sc.readReceipts(receipts).length === 3);
    check('an unknown criterion is refused', sc.main(['record', '--manifest', mfile, '--criterion', 'nope', '--receipts', receipts], io) === 2);
    check('argument parsing', sc.parseArgs(['report', '--json', '--manifest', 'm']).json === true);
    check('default receipts dir', /scorecard[\\/]receipts$/.test(sc.defaultReceiptsDir()));
    check('three kinds', sc.KINDS.length === 3);

    const line = `stale=${stale} missing_population=${missingPop} failed_control=${failedControl.status} fixture_only=${fixtureOnly} arithmetic=${arithmetic ? 'PASS' : 'FAIL'}`;
    const want = 'stale=UNKNOWN missing_population=UNKNOWN failed_control=FAIL fixture_only=NOT_OPERATIONAL arithmetic=PASS';
    check('summary line', line === want, line);
    console.log(`${ran} checks, ${failed} failed`);
    console.log(line);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
