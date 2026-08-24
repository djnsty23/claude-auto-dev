#!/usr/bin/env node
'use strict';
/**
 * Suite for find-record-drift.js.
 *
 * The detector exists because fleet-status.js's main() and scanFleet() built the
 * same record and disagreed about two fields, so `fleet-status --stalled` could
 * not report a stalled session at all. It was validated by hand against the
 * pre-fix file, which is a git blob and therefore not something a suite can lean
 * on forever. These fixtures reproduce both directions from scratch.
 *
 * A detector that has only ever been run against the world cannot be trusted to
 * FAIL. Every case here plants an input whose correct answer is known.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, 'find-record-drift.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'record-drift-'));
let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

function run(file) {
    const r = spawnSync(process.execPath, [SUBJECT, file], { encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function write(name, body) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, body, 'utf8');
    return p;
}

try {
    // ---- the known positive, rebuilt: the exact shape of the real incident ----
    {
        const f = write('drift.js', [
            'function rich(list) {',
            '    for (const x of list) {',
            '        const rec = read(x);',
            '        rec.idleMinutes = 1;',
            '        rec.isRunning = null;',
            '        rec.state = "a";',
            '        rec.endedCleanly = true;',
            '        rec.stoppedAt = "t";',
            '    }',
            '}',
            'function poor(list) {',
            '    for (const x of list) {',
            '        const rec = read(x);',
            '        rec.idleMinutes = 1;',
            '        rec.isRunning = null;',
            '        rec.state = "a";',
            '    }',
            '}',
            '',
        ].join('\n'));
        const r = run(f);
        check('a strict subset of another function is reported', /subset pair/.test(r.out) && !/0 subset pair/.test(r.out),
            r.out.split('\n')[1]);
        check('  it names the poorer function', /MISSING from poor\(\)/.test(r.out), r.out.slice(0, 200));
        check('  and names BOTH missing fields, not just one',
            /endedCleanly/.test(r.out) && /stoppedAt/.test(r.out));
        check('  and exits non-zero so a runner can gate on it', r.status === 1, 'status ' + r.status);
    }

    // ---- known negative: equal field sets are not drift ----
    {
        const f = write('same.js', [
            'function a(x) { const rec = read(x); rec.one = 1; rec.two = 2; rec.three = 3; }',
            'function b(x) { const rec = read(x); rec.one = 1; rec.two = 2; rec.three = 3; }',
            '',
        ].join('\n'));
        const r = run(f);
        check('identical field sets are NOT reported', /0 subset pair/.test(r.out), r.out.split('\n')[1]);
        check('  and it exits 0', r.status === 0, 'status ' + r.status);
    }

    // ---- known negative: each having its own field is divergence, not a subset ----
    {
        const f = write('mutual.js', [
            'function a(x) { const rec = read(x); rec.one = 1; rec.two = 2; rec.onlyA = 3; }',
            'function b(x) { const rec = read(x); rec.one = 1; rec.two = 2; rec.onlyB = 3; }',
            '',
        ].join('\n'));
        check('mutually exclusive extras are not a subset', /0 subset pair/.test(run(f).out));
    }

    // ---- known negative: one shared field is coincidence, below MIN_OVERLAP ----
    {
        const f = write('thin.js', [
            'function a(x) { const rec = read(x); rec.one = 1; rec.two = 2; }',
            'function b(x) { const rec = read(x); rec.one = 1; }',
            '',
        ].join('\n'));
        check('a single shared field is below the overlap floor', /0 subset pair/.test(run(f).out));
    }

    // ---- the precision fix, both halves ----
    //
    // quota-tripwire's loadState does `Object.assign(emptyState(), o)`, so its
    // s.f = lines are a floor rather than a census and every comparison against
    // it is a false subset. But fleet-status's main() calls Object.assign(rec, x)
    // to MUTATE an existing rec, and main() is the known positive above. Skipping
    // on the mere presence of Object.assign would blind the detector to the only
    // bug it has ever caught, so both halves need pinning.
    {
        const f = write('opaque.js', [
            'function rich(x) { const s = read(x); s.one = 1; s.two = 2; s.three = 3; }',
            'function poor(x) { const s = Object.assign(defaults(), x); s.one = 1; s.two = 2; }',
            '',
        ].join('\n'));
        check('a local DECLARED FROM Object.assign is not compared', /0 subset pair/.test(run(f).out),
            run(f).out.split('\n')[1]);
    }
    {
        const f = write('mutate.js', [
            'function rich(x) { const rec = read(x); rec.one = 1; rec.two = 2; rec.three = 3; }',
            'function poor(x) { const rec = read(x); Object.assign(rec, x); rec.one = 1; rec.two = 2; }',
            '',
        ].join('\n'));
        const r = run(f);
        check('...but a local merely MUTATED by Object.assign still is', !/0 subset pair/.test(r.out),
            r.out.split('\n')[1]);
    }
    {
        const f = write('spread.js', [
            'function rich(x) { const s = read(x); s.one = 1; s.two = 2; s.three = 3; }',
            'function poor(x) { const s = { ...x }; s.one = 1; s.two = 2; }',
            '',
        ].join('\n'));
        check('a local declared from a SPREAD is not compared either', /0 subset pair/.test(run(f).out));
    }

    // ---- the population line must be real, per rules 22c ----
    {
        const f = write('same2.js', 'function a(x) { const r = read(x); r.p = 1; r.q = 2; }\n');
        const r = run(f);
        check('a clean run prints the population it scanned, not just a verdict',
            /1 file\(s\) scanned, 1 named function\(s\)/.test(r.out), r.out.split('\n')[1]);
        check('  and says a zero is only real if the scan saw the file',
            /real zero only if the scan saw your file/.test(r.out));
    }
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
