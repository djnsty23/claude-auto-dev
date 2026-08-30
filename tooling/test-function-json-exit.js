#!/usr/bin/env node
// Acceptance test for F6: JSON mode must reject coverage from a failing suite.
// Expected failure before the fix: the payload says suitePassed=false with no
// plugin file loaded, yet the process exits 0 because only dead functions feed
// the JSON exit status.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'tooling', 'test-all.js');
const CHECK = path.join(ROOT, 'tooling', 'find-untested-functions.js');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error?.message || 'none'}`;

const original = fs.readFileSync(RUNNER, 'utf8');
let result = null;
let payload = null;
try {
    // Stop before any suite or plugin source is loaded. This makes an empty
    // coverage population while keeping the failure intentional and parseable.
    fs.writeFileSync(RUNNER,
        "#!/usr/bin/env node\n" +
        "console.error('intentional F6 baseline failure');\n" +
        "process.exit(1);\n");
    result = spawnSync(process.execPath, [CHECK, '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
    });
    try { payload = JSON.parse(result.stdout); } catch { /* controls report it */ }
} finally {
    fs.writeFileSync(RUNNER, original);
}

const restoredSyntax = spawnSync(process.execPath, ['--check', RUNNER], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
});

check('control: JSON records the deliberately failed suite',
    payload?.suitePassed === false,
    `payload=${JSON.stringify(payload)}`);
check('control: the failed suite loaded zero plugin files',
    payload?.sourceFiles > 0
        && payload?.filesLoaded === 0
        && payload?.functionsSeen === 0
        && payload?.filesNeverLoaded?.length === payload?.sourceFiles,
    `payload=${JSON.stringify(payload)}`);
check('JSON mode exits 2 when its suite baseline is red',
    result?.status === 2 && result.signal === null && !result.error,
    result ? detail(result) : 'checker did not run');
check('control: the committed runner is restored with valid syntax',
    fs.readFileSync(RUNNER, 'utf8') === original
        && restoredSyntax.status === 0
        && restoredSyntax.signal === null
        && !restoredSyntax.error,
    detail(restoredSyntax));

let pass = 0;
let fail = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
