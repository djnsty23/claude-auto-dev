#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'population-strict-exit-'));

try {
    const tooling = path.join(box, 'tooling');
    fs.mkdirSync(tooling);

    const subject = path.join(__dirname, 'tooling', 'check-population-reporting.js');
    const copiedSubject = path.join(tooling, 'check-population-reporting.js');
    fs.copyFileSync(subject, copiedSubject);
    fs.writeFileSync(
        path.join(tooling, 'fixture-absence.js'),
        'console.log("no issues found");\n',
        'utf8'
    );

    const result = spawnSync(process.execPath, [copiedSubject, '--strict'], {
        encoding: 'utf8',
    });

    assert.match(
        result.stdout,
        /\bNO-POPULATION\b.*\bNO-CONTROL\b.*tooling\/fixture-absence\.js/,
        'fixture must produce a flagged-script row'
    );
    assert.notStrictEqual(
        result.status,
        0,
        `strict failure output must produce a failing exit code; stdout:\n${result.stdout}`
    );
} finally {
    fs.rmSync(box, { recursive: true, force: true });
}
