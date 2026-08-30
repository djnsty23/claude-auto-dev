#!/usr/bin/env node
// Acceptance tests for F8: help and module import are non-serving entrypoints.
// Expected failures before the fix: both paths execute top-level listen(), scan
// fleet state, and remain alive until this suite's timeout terminates them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error?.message || 'none'}`;
const run = (args) => spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000,
});

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
