#!/usr/bin/env node
// Acceptance tests for F8: help and module import are non-serving entrypoints.
// Expected failures before the fix: both paths execute top-level listen(), scan
// fleet state, and remain alive until this suite's timeout terminates them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { contentionFactor, timedOut } = require('./spawn-budget.js');

const ROOT = path.resolve(__dirname, '..');
const BOARD = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'fleet-board.js');
const HELP_CONTROL = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'brain-brief.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-board-entrypoints-'));
const importProbe = path.join(tempRoot, 'import-probe.js');
const env = {
    ...process.env,
    USERPROFILE: tempRoot,
    HOME: tempRoot,
    CLAUDE_CONFIG_DIR: path.join(tempRoot, 'config'),
    AUTODEV_FLEET_DIR: path.join(tempRoot, 'fleet'),
    AUTODEV_FLEET_PUBLISH_DIR: path.join(tempRoot, 'published'),
};

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
// A timeout here names the CONTENTION measured at that moment, because that is
// the competing explanation a reader needs to weigh -- see the note on `run`.
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error?.message || 'none'}`
    + (r.contention === undefined ? '' : `; contention x${r.contention.toFixed(2)} at the timeout`);

// THIS SUITE IS THE ONE PLACE IN THE SWEEP WHERE A TIMEOUT IS EVIDENCE ABOUT THE
// SUBJECT, so it is deliberately NOT routed through classify().
//
// The regression it exists to catch is a --help path that executes top-level
// listen() and never exits; the budget is what detects it. Reclassifying a
// timeout as indeterminate would make the gate report INDETERMINATE on exactly
// the failure it was written for -- on a healthy machine, where a serving child
// times out on every attempt no matter how wide the budget. And retrying is
// worse than useless: a child that never exits blows the retry too, at a
// multiple of the cost.
//
// What CAN be fixed is the margin. `[measured 2026-09-08]` the three children
// cost 72ms, 125ms and 61ms against a 3000ms budget -- 24x headroom, the
// tightest in the eleven suites surveyed and inside the range contention can
// reach. The budget goes to 30s, which is ~240x and costs nothing on a healthy
// run (these children exit in a tenth of a second); the only run that pays it is
// one where the regression has actually fired, and that run is worth 30s.
//
// A wider budget makes the false red rarer, not impossible, and no result field
// can separate "served forever" from "killed while contended". So when the
// budget does blow, the report names the contention measured at that instant,
// and a reader can tell a busy machine from a serving one instead of guessing.
const run = (args) => {
    const r = spawnSync(process.execPath, args, {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
    });
    if (timedOut(r)) r.contention = contentionFactor();
    return r;
};

try {
    const control = run([HELP_CONTROL, '--help']);
    check('control: a sibling CLI help path exits successfully',
        control.status === 0 && control.signal === null && !control.error
            && control.stdout.trim().length > 0,
        detail(control));

    const help = run([BOARD, '--help', '--port', '0']);
    check('fleet-board --help exits 0 without starting the service',
        help.status === 0 && help.signal === null && !help.error
            && help.stdout.trim().length > 0,
        detail(help));

    fs.writeFileSync(importProbe,
        `require(${JSON.stringify(BOARD)});\n` +
        "process.stdout.write('module imported without serving');\n");
    const imported = run([importProbe, '--port', '0']);
    check('requiring fleet-board has no listening or scan side effect',
        imported.status === 0 && imported.signal === null && !imported.error
            && imported.stdout === 'module imported without serving',
        detail(imported));
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let pass = 0;
let fail = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
