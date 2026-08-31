#!/usr/bin/env node
// reap-orphan-waiters.js - find until-loop waiters whose producer is dead.
//
// WHY, measured. On 2026-08-31 two background waiters ran for 1h50m each,
// polling a file for a sentinel that could never arrive: the process meant to
// write it had been killed an hour and fifty minutes earlier. They were shaped
//
//     until grep -q "median" "$F"; do sleep 20; done
//
// which is a correct wait and an incorrect LIFETIME. Nothing reaped them, and
// nothing could notice, because a poll loop and a working poll loop look
// identical from outside. They were found only when a human happened to open
// the task panel.
//
// This is the resource half of a rule this repo already writes down for
// verification: a one-shot wait armed as an endless monitor. A waiter needs a
// producer-liveness check or a deadline, and the ones that shipped had neither.
//
// WHAT IT DOES, and what it deliberately will not do.
//
// Reports - and with --kill, stops - shell processes that are (a) polling in a
// sleep loop, and (b) waiting on an output file that no live process is
// writing. It NEVER kills a producer, never kills a loop whose target is still
// being written, and never touches a process it cannot positively classify.
// A process it cannot classify is reported and left, because a reaper that
// guesses is worse than no reaper.
//
// Usage:
//   node tooling/reap-orphan-waiters.js            report only
//   node tooling/reap-orphan-waiters.js --kill     stop the confirmed orphans
//   node tooling/reap-orphan-waiters.js --selftest

const { spawnSync } = require('child_process');
const fs = require('fs');

const KILL = process.argv.includes('--kill');
const WIN = process.platform === 'win32';

// A waiter is a shell polling in a loop. The shapes this repo actually
// produces: `until <check>; do sleep N; done` and `while ...; do sleep N; done`.
const WAITER = /\b(?:until|while)\b[\s\S]*\bsleep\s+\d+/;
// The file a waiter is polling. Quote-agnostic ON PURPOSE: a real Windows
// command line arrives with ESCAPED quotes, so the character after the path is
// a backslash, not the quote the first version required. That version passed
// its own selftest because the fixture was written with simple quotes, which
// is a test agreeing with the code rather than checking it. A known-positive
// control against a live process caught it; the escaped shape is now a case.
const TARGET = /([A-Za-z]:[\\/][^\s"']*\.output|\/[^\s"']*\.output)/;

function processes() {
    if (!WIN) {
        const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
        return (r.stdout || '').split('\n').map((l) => {
            const m = l.trim().match(/^(\d+)\s+([\s\S]*)$/);
            return m ? { pid: +m[1], cmd: m[2] } : null;
        }).filter(Boolean);
    }
    const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'bash|sh\' } | '
        + 'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    return (r.stdout || '').split('\n').map((l) => {
        const i = l.indexOf('\t');
        return i > 0 ? { pid: +l.slice(0, i), cmd: l.slice(i + 1) } : null;
    }).filter((x) => x && x.pid);
}

function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

// Is anything still WRITING this file? Growth over a short window is the only
// evidence available without owning the producer, and it is deliberately the
// conservative direction: a file that grows is treated as live.
function stillGrowing(file, ms) {
    let a = -1;
    try { a = fs.statSync(file).size; } catch { return false; }
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin briefly; this runs for ~1.2s total */ }
    let b = -1;
    try { b = fs.statSync(file).size; } catch { return false; }
    return b !== a;
}

function classify() {
    const rows = [];
    for (const p of processes()) {
        if (!WAITER.test(p.cmd)) continue;
        const m = p.cmd.match(TARGET);
        if (!m) { rows.push({ ...p, verdict: 'UNCLASSIFIED', why: 'no output target found' }); continue; }
        const file = m[1];
        const exists = fs.existsSync(file);
        if (!exists) { rows.push({ ...p, file, verdict: 'ORPHAN', why: 'target file does not exist' }); continue; }
        if (stillGrowing(file, 1200)) {
            rows.push({ ...p, file, verdict: 'LIVE', why: 'target is still being written' });
            continue;
        }
        // The target is static. If its producing task already finished, the
        // sentinel it waits for is never coming.
        const age = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 1000);
        rows.push({
            ...p, file,
            verdict: age > 300 ? 'ORPHAN' : 'UNCLASSIFIED',
            why: age > 300 ? ('target unwritten for ' + age + 's') : ('target quiet only ' + age + 's'),
        });
    }
    return rows;
}

function selftest() {
    const cases = [
        ['until+sleep is a waiter', 'bash -c "until grep -q X \'/tmp/a.output\'; do sleep 20; done"', true],
        ['while+sleep is a waiter', 'bash -c "while true; do sleep 5; done"', true],
        ['a plain command is not', 'node tooling/validate.js', false],
        ['npm test is not a waiter', 'cmd /c npm test', false],
    ];
    let pass = 0; let fail = 0;
    for (const [label, cmd, expect] of cases) {
        const ok = WAITER.test(cmd) === expect;
        console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
        ok ? pass++ : fail++;
    }
    // Both quoting shapes, because only the second one occurs in reality.
    const targets = [
        ['simple quotes', 'bash -c "until grep -q X \'C:/tmp/x.output\'; do sleep 2; done"', 'C:/tmp/x.output'],
        ['ESCAPED quotes, as a real Windows command line arrives',
            String.raw`"C:\Git\bash.exe" -c "until grep -q S \"C:/tmp/y.output\"; do sleep 5; done"`,
            'C:/tmp/y.output'],
        ['posix path', "bash -c 'until grep -q S /tmp/z.output; do sleep 5; done'", '/tmp/z.output'],
    ];
    for (const [label, cmd, want] of targets) {
        const got = (cmd.match(TARGET) || [])[1];
        const ok = got === want;
        console.log((ok ? 'PASS  ' : 'FAIL  ') + 'extracts target: ' + label
            + (ok ? '' : '  wanted ' + want + ', got ' + got));
        ok ? pass++ : fail++;
    }
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();

const rows = classify();
const orphans = rows.filter((r) => r.verdict === 'ORPHAN');
// Population beside the count: a bare "0 orphans" is indistinguishable from a
// scan that found no shells at all.
console.log('population: ' + rows.length + ' polling shell(s) examined, '
    + orphans.length + ' orphaned, '
    + rows.filter((r) => r.verdict === 'LIVE').length + ' live, '
    + rows.filter((r) => r.verdict === 'UNCLASSIFIED').length + ' unclassified (left alone)');
for (const r of rows) {
    console.log('  [' + r.verdict + '] pid ' + r.pid + '  ' + r.why
        + (r.file ? '\n      target: ' + r.file : ''));
}
if (!orphans.length) process.exit(0);
if (!KILL) {
    console.log('\nRe-run with --kill to stop the orphans above. Nothing was stopped.');
    process.exit(0);
}
for (const o of orphans) {
    if (!alive(o.pid)) { console.log('  already gone: ' + o.pid); continue; }
    try { process.kill(o.pid); console.log('  stopped ' + o.pid); }
    catch (e) { console.log('  could NOT stop ' + o.pid + ': ' + (e.code || e.message)); }
}
process.exit(0);
