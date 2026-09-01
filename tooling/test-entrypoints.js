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

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tooling', 'check-entrypoints.js');
const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const run = (args, timeout) => spawnSync(process.execPath, [GATE, ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024,
});
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error ? r.error.message : 'none'}\n${(r.stdout + r.stderr).slice(-600)}`;

const self = run(['--selftest'], 120000);
check('selftest exits 0', self.status === 0 && !self.error, detail(self));
check('selftest prints its population line', /population: \d+ assertions run/.test(self.stdout), detail(self));
check('selftest proves a planted setInterval is HUNG', /PASS  planted setInterval is classified HUNG/.test(self.stdout), detail(self));
check('selftest proves scratch-copy isolation', /PASS  and never into the source tree/.test(self.stdout), detail(self));

const real = run(['--json'], 600000);
check('the repo population returns on --help (exit 0)', real.status === 0 && !real.error, detail(real));
let parsed = null;
try { parsed = JSON.parse(real.stdout); } catch { /* asserted below */ }
check('gate emits JSON with a population', !!parsed && typeof parsed.population === 'number', real.stdout.slice(0, 300));
check('population is the whole tree, not a sample (>= 60)', !!parsed && parsed.population >= 60, parsed ? String(parsed.population) : 'unparsed');
check('zero hangs in the corpus', !!parsed && Array.isArray(parsed.hung) && parsed.hung.length === 0, parsed ? parsed.hung.join(',') : 'unparsed');

// The three scripts that motivated this must be in the population and return.
const readable = run([], 600000);
for (const name of ['watch-panels.js', 'fleet-stop-watch.js', 'quota-tripwire.js']) {
    const direct = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'autodev-core', 'scripts', name), '--help'], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10000, input: '',
    });
    check(`${name} --help returns 0 with usage text`,
        direct.status === 0 && !direct.error && /node .*\.js/.test(direct.stdout), detail(direct));
}
check('human report names the budget and the counts', /\d+ script\(s\) probed with --help under a \d+ms budget, \d+ returned, 0 hung/.test(readable.stdout), readable.stdout.slice(0, 300));

let failed = 0;
for (const [label, ok, d] of cases) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
    if (!ok) { failed++; console.log('        ' + String(d).replace(/\n/g, '\n        ')); }
}
console.log(`${cases.length - failed}/${cases.length} assertions passed`);
process.exit(failed ? 1 : 0);
