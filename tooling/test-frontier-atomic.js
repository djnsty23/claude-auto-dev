'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SUBJECT = path.join(__dirname, 'frontier', 'run.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-atomic-'));
const preload = path.join(root, 'rename-plant.cjs');
fs.writeFileSync(preload, `
const fs = require('fs');
const rename = fs.renameSync;
let attempts = 0;
let injected = 0;
const published = [];
const record = () => fs.writeFileSync(process.env.RENAME_COUNT, JSON.stringify({ attempts, injected, published }));
fs.renameSync = function(from, to) {
    if (to === process.env.RENAME_TARGET) {
        attempts++;
        if (attempts <= Number(process.env.RENAME_FAILURES)) {
            injected++;
            record();
            const error = new Error('RENAME-PLANT');
            error.code = process.env.RENAME_CODE;
            throw error;
        }
        record();
        const result = rename.apply(this, arguments);
        published.push(JSON.parse(fs.readFileSync(to, 'utf8')).state);
        record();
        return result;
    }
    return rename.apply(this, arguments);
};
`);

function run(label, failures, code) {
    const data = path.join(root, label);
    const file = path.join(data, 'batches', 'B-fixture.json');
    const count = path.join(data, 'attempts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ id: 'B-fixture', state: 'running', loopPid: null, items: [] });
    fs.writeFileSync(file, original);
    const result = spawnSync(process.execPath, ['--require', preload, SUBJECT, 'batch-loop', '--batch', 'B-fixture', '--data', data], {
        encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: { ...process.env, RENAME_TARGET: file, RENAME_COUNT: count,
            RENAME_FAILURES: String(failures), RENAME_CODE: code },
    });
    assert.equal(result.error, undefined, label + ' completed within its safety deadline');
    return { ...result, ...JSON.parse(fs.readFileSync(count, 'utf8')),
        text: fs.readFileSync(file, 'utf8'), original };
}

try {
    const control = run('control', 0, 'EPERM');
    assert.equal(control.status, 0, control.stdout + control.stderr);
    assert.equal(JSON.parse(control.text).state, 'done');
    assert.ok(control.attempts >= 2);
    assert.equal(control.injected, 0);
    assert.deepEqual(control.published, ['running', 'done']);
    console.log('PASS real batch-loop publishes running and done without contention');

    for (const code of ['EPERM', 'EBUSY']) {
        const transient = run(code, 2, code);
        assert.equal(transient.status, 0, transient.stdout + transient.stderr);
        assert.equal(JSON.parse(transient.text).state, 'done');
        assert.ok(transient.attempts >= 4);
        assert.equal(transient.injected, 2);
        assert.deepEqual(transient.published, ['running', 'done']);
        console.log('PASS real batch-loop recovers after two ' + code + ' rename failures');
    }

    const permanent = run('permanent', 1000000, 'EPERM');
    assert.equal(permanent.status, 1, permanent.stdout + permanent.stderr);
    assert.equal(permanent.text, permanent.original);
    assert.ok(permanent.attempts > 1 && permanent.attempts <= 10);
    assert.deepEqual(permanent.published, []);
    assert.match(permanent.stdout, /RENAME-PLANT/);
    console.log('PASS permanent rename denial stays red and leaves the published batch unchanged');

    const other = run('other', 2, 'EIO');
    assert.equal(other.status, 1);
    assert.equal(other.attempts, 1);
    assert.deepEqual(other.published, []);
    assert.equal(other.text, other.original);
    assert.match(other.stdout, /RENAME-PLANT/);
    console.log('PASS unrelated I/O failures propagate without retries');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
