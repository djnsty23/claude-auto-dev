#!/usr/bin/env node
// Acceptance test for F1: check:vacuity must carry its survivor verdict in the
// process status. Expected failure before the fix: the real runner restores the
// subject and reports surviving mutants, but exits 0 instead of 1.
//
// This fixture is deliberately committed in its own temporary git repository.
// The production runner refuses dirty subjects, so an uncommitted fixture would
// exercise that guard rather than the survivor-exit contract under test.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, 'find-vacuous-assertions.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuity-exit-'));
const subject = path.join(tempRoot, 'subject.js');
const suite = path.join(tempRoot, 'suite.js');
const message = path.join(tempRoot, 'commit-message.txt');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);

const git = (...args) => execFileSync('git', args, {
    cwd: tempRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
});

try {
    fs.writeFileSync(subject,
        "function classify(value) {\n" +
        "    if (value === 'kept') {\n" +
        "        return 'stable';\n" +
        "    }\n" +
        "    return 'stable';\n" +
        "}\n" +
        "module.exports = classify;\n");
    fs.writeFileSync(suite,
        "const classify = require('./subject.js');\n" +
        "if (classify('kept') !== 'stable') process.exit(1);\n" +
        "console.log('1 passed, 0 failed');\n");
    fs.writeFileSync(message, 'test fixture\n');

    git('init');
    git('config', 'user.name', 'Test Fixture');
    git('config', 'user.email', 'test@example.invalid');
    git('add', 'subject.js', 'suite.js');
    git('commit', '-F', message);

    const baseline = spawnSync(process.execPath, [suite], {
        cwd: tempRoot,
        encoding: 'utf8',
        windowsHide: true,
    });
    check('control: the committed suite is green before mutation',
        baseline.status === 0 && baseline.signal === null && !baseline.error,
        `status=${baseline.status} signal=${baseline.signal} error=${baseline.error?.message || 'none'}`);

    const original = fs.readFileSync(subject, 'utf8');
    const result = spawnSync(process.execPath, [RUNNER, subject, suite], {
        cwd: tempRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
    });

    check('surviving mutants make check:vacuity exit 1',
        result.status === 1 && result.signal === null && !result.error,
        `status=${result.status} signal=${result.signal} error=${result.error?.message || 'none'}`);
    check('control: the mutation run restores the committed subject',
        fs.readFileSync(subject, 'utf8') === original,
        'subject content changed during the acceptance test');
    check('control: the mutation backup is removed after a completed run',
        !fs.existsSync(subject + '.vacuity-backup'),
        'the completed mutation run left its backup behind');
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let pass = 0;
let fail = 0;
for (const [label, ok, detail] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !detail ? '' : '  -> ' + detail));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
