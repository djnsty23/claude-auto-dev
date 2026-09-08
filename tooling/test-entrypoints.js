#!/usr/bin/env node
// Every shipped entry point returns on --help, and the checker that proves it
// can itself fail. Drives tooling/check-entrypoints.js as a subprocess, twice:
// its selftest (the classifier, the verdict, and the scratch-copy isolation that
// keeps a mutating script off the working tree), then the real population, which
// must be at zero hangs for this to be a gate rather than a report.
//
// Why the corpus assertion names the three scripts: `[measured 2026-09-02]`
// watch-panels.js, fleet-stop-watch.js and quota-tripwire.js all hung on --help.
// Asserting each is present in the population AND returned means a future rename
// cannot make this suite pass by making the subject disappear.

const path = require('path');
const { spawnSync } = require('child_process');
const { classify, reason, runBudgeted, tally, exitCode } = require('./spawn-budget.js');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tooling', 'check-entrypoints.js');
const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
let infra = 0;
const indeterminate = [];

// A child that produced no verdict is INFRASTRUCTURE, not a finding about
// check-entrypoints.js. Measured 2026-09-08 by forcing a budgeted spawn here to
// return `status=null signal=SIGTERM ETIMEDOUT`: this suite printed
// `FAIL  selftest exits 0` with `status=null signal=SIGTERM error=spawnSync
// ETIMEDOUT` and seven more reds, then exited 1.
//
// The false GREEN matters as much here. `zero hangs in the corpus` reads
// `parsed.hung.length === 0`, and a killed child parses to nothing -- so the
// same timeout that reddens the lines above can also satisfy an assertion about
// ABSENCE further down. Neither reading is evidence; the tally and exit code now
// say so.
const run = (args, timeout, what) => {
    const r = runBudgeted(process.execPath, [GATE, ...args], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024,
        // Contention is clamped at 20, so an uncapped widening of the 600s
        // population budget would reach nearly three hours inside `npm test`.
        maxTimeout: Math.max(timeout, 900000),
    });
    if (classify(r) === 'infrastructure') {
        infra++;
        indeterminate.push(what + ' (' + reason(r) + ')');
        console.error('infrastructure: ' + what + ' produced no verdict (' + reason(r)
            + '; ' + r.attempts + ' attempt(s), budget ' + r.budgetMs + 'ms)');
    }
    return r;
};
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error ? r.error.message : 'none'}\n${(r.stdout + r.stderr).slice(-600)}`;

const self = run(['--selftest'], 120000, 'the gate selftest');
check('selftest exits 0', self.status === 0 && !self.error, detail(self));
check('selftest prints its population line', /population: \d+ assertions run/.test(self.stdout), detail(self));
check('selftest proves a planted setInterval is HUNG', /PASS  planted setInterval is classified HUNG/.test(self.stdout), detail(self));
check('selftest proves scratch-copy isolation', /PASS  and never into the source tree/.test(self.stdout), detail(self));

const real = run(['--json'], 600000, 'the gate --json population run');
check('the repo population returns on --help (exit 0)', real.status === 0 && !real.error, detail(real));
let parsed = null;
try { parsed = JSON.parse(real.stdout); } catch { /* asserted below */ }
check('gate emits JSON with a population', !!parsed && typeof parsed.population === 'number', real.stdout.slice(0, 300));
check('population is the whole tree, not a sample (>= 60)', !!parsed && parsed.population >= 60, parsed ? String(parsed.population) : 'unparsed');
check('zero hangs in the corpus', !!parsed && Array.isArray(parsed.hung) && parsed.hung.length === 0, parsed ? parsed.hung.join(',') : 'unparsed');

// The three scripts that motivated this must be in the population and return.
const readable = run([], 600000, 'the gate human-report run');
for (const name of ['watch-panels.js', 'fleet-stop-watch.js', 'quota-tripwire.js']) {
    const direct = runBudgeted(process.execPath, [path.join(ROOT, 'plugins', 'autodev-core', 'scripts', name), '--help'], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10000, input: '',
        maxTimeout: 120000,
    });
    if (classify(direct) === 'infrastructure') {
        infra++;
        indeterminate.push(name + ' --help (' + reason(direct) + ')');
        console.error('infrastructure: ' + name + ' --help produced no verdict (' + reason(direct)
            + '; ' + direct.attempts + ' attempt(s), budget ' + direct.budgetMs + 'ms)');
    }
    check(`${name} --help returns 0 with usage text`,
        direct.status === 0 && !direct.error && /node .*\.js/.test(direct.stdout), detail(direct));
}
check('human report names the budget and the counts', /\d+ script\(s\) probed with --help under a \d+ms budget, \d+ returned, 0 hung/.test(readable.stdout), readable.stdout.slice(0, 300));

let failed = 0;
for (const [label, ok, d] of cases) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
    if (!ok) { failed++; console.log('        ' + String(d).replace(/\n/g, '\n        ')); }
}
console.log(tally(cases.length - failed, failed, infra));
if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
process.exit(exitCode(failed, infra));
