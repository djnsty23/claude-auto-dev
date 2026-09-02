#!/usr/bin/env node
'use strict';

// Tests for scripts/check-idle-with-queue.js — C1's instrument.
// Run: node tooling/test-idle-with-queue.js
//
// EVERY RUN USES A FIXTURE FLEET. fleet-heartbeat.js honours AUTODEV_FLEET_DIR,
// so the real ~/.claude/fleet is never read and this suite cannot be swayed by
// whatever 178 live sessions happen to be doing. A gate whose acceptance test
// depends on live fleet state is green or red for reasons unrelated to its code.
//
// THE ASSERTION THIS FILE EXISTS FOR is that the gate CAN FIRE. Its first design
// keyed on "queue modified after the heartbeat", which sounds like the sharpest
// signal and needs an external writer, so it flagged 0 of 178 live sessions and
// would have been structurally incapable of firing while looking rigorous. Both
// arms are therefore asserted here: a planted positive that must flag, and the
// three near-misses that must not.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-idle-with-queue.js');

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciwq-suite-'));
const fleet = path.join(tmp, 'fleet');
fs.mkdirSync(fleet);

/** A working directory, optionally carrying a QUEUE.md of a given age. */
function workdir(name, queueAgeHours) {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    if (queueAgeHours !== undefined) {
        const q = path.join(d, 'QUEUE.md');
        fs.writeFileSync(q, '# QUEUE\n\nprose, no checkboxes — which is the whole point\n');
        const when = new Date(Date.now() - queueAgeHours * 3600000);
        fs.utimesSync(q, when, when);
    }
    return d;
}

/** A heartbeat record, idle by `agoMinutes`. */
function heartbeat(id, cwd, agoMinutes) {
    fs.writeFileSync(path.join(fleet, `${id}.json`), JSON.stringify({
        cliSessionId: id,
        cwd,
        transcript: path.join(tmp, `${id}.jsonl`),
        stoppedAt: new Date(Date.now() - agoMinutes * 60000).toISOString(),
        stopHookActive: false,
    }));
}

function run(args, env) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(args || []), {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { AUTODEV_FLEET_DIR: fleet }, env || {}),
        timeout: 20000,
    });
    return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// --- the script's own selftest must pass, and must be reachable -----------
{
    const r = run(['--selftest']);
    check('--selftest exits 0', r.status === 0, 'exit ' + r.status);
    check('  and reports its own case count rather than a bare verdict',
        /\d+ passed, \d+ failed/.test(r.out) && /cases: \d+ rule, \d+ scan/.test(r.out));
}
{
    const r = run(['--help']);
    check('--help exits 0 with usage', r.status === 0 && r.out.includes('usage:'), 'exit ' + r.status);
    check('  and says plainly that it does NOT implement C1 as written',
        /OPEN ITEMS; those do not exist/.test(r.out));
}

// --- the positive: this gate can fire ------------------------------------
{
    const live = workdir('live-queue', 2);          // queue written 2h ago
    heartbeat('aaaaaaaa-0000-0000-0000-000000000000', live, 60);   // idle 60m
    const r = run([]);
    check('a session idle with a FRESH queue is flagged', r.status === 1, 'exit ' + r.status);
    check('  and the row names the session, the idle time and the queue age',
        /aaaaaaaa/.test(r.out) && /60m idle/.test(r.out) && /queue 2h old/.test(r.out),
        JSON.stringify(r.out.split('\n').filter((l) => /aaaaaaaa/.test(l))[0] || ''));
    check('  and the population is printed before the verdict',
        /heartbeat\(s\) scanned/.test(r.out) && /in a directory holding a QUEUE\.md/.test(r.out));
    check('  and the flagging rule is stated, not left implicit',
        /flagging: idle > 20m AND QUEUE\.md written within 24h/.test(r.out));
}

// --- the three near-misses, each of which must NOT flag -------------------
// These are the ways this gate goes silent. Asserted separately because a
// single "clean" case cannot tell them apart, and the first design failed by
// being unable to fire rather than by flagging wrongly.
for (const [label, dirName, queueAge, idleMin] of [
    ['a STALE queue (the abandoned case: live median was 55h)', 'stale', 55, 600],
    ['a LIVE session with a fresh queue', 'busy', 1, 2],
]) {
    const d = workdir(dirName, queueAge);
    const id = `bbbbbbbb-0000-0000-0000-${String(dirName).padEnd(12, '0').slice(0, 12)}`;
    heartbeat(id, d, idleMin);
    const r = run([]);
    check(`${label} is not flagged`, !new RegExp(id.slice(0, 8)).test(r.out.split('flagging:')[1] || ''));
    fs.rmSync(path.join(fleet, `${id}.json`));
}
{
    const d = workdir('no-queue-at-all');           // no QUEUE.md written
    heartbeat('cccccccc-0000-0000-0000-000000000000', d, 600);
    const r = run([]);
    check('a directory with no QUEUE.md is not flagged', !/cccccccc/.test(r.out));
    fs.rmSync(path.join(fleet, 'cccccccc-0000-0000-0000-000000000000.json'));
}

// --- the clean path must not overclaim -----------------------------------
{
    fs.rmSync(path.join(fleet, 'aaaaaaaa-0000-0000-0000-000000000000.json'));
    const d = workdir('quiet');
    heartbeat('dddddddd-0000-0000-0000-000000000000', d, 5);
    const r = run([]);
    check('with nothing to flag it exits 0', r.status === 0, 'exit ' + r.status);
    check('  and refuses to call that an all-clear about queued work',
        /NOT an all-clear/.test(r.out) && /invisible here, by construction/.test(r.out));
}

// --- thresholds are arguments, not decoration ----------------------------
{
    const d = workdir('tunable', 40);               // 40h queue: stale at 24, live at 48
    heartbeat('eeeeeeee-0000-0000-0000-000000000000', d, 60);
    const strict = run([]);
    const loose = run(['--queue-hours', '48']);
    check('a 40h queue is stale under the default 24h horizon', !/eeeeeeee/.test(strict.out));
    check('  and live under --queue-hours 48, so the flag is honoured',
        loose.status === 1 && /eeeeeeee/.test(loose.out), 'exit ' + loose.status);
}

// --- no population is not an all-clear -----------------------------------
//
// This case was written with an `||` and passed on the wrong arm: the script
// exited 0 over an absent fleet and the assertion accepted it because the output
// happened to contain a caveat. `readAll()` swallows a missing directory and
// returns [], so the exit-2 path in the script never ran. Asserted on the EXIT
// CODE alone now — a caveat in the text is not a substitute for a status a
// caller can branch on, and an `||` across two independent claims can be
// satisfied by either while the other is false.
{
    const r = run([], { AUTODEV_FLEET_DIR: path.join(tmp, 'no-such-fleet') });
    check('an absent fleet directory exits 2, never 0', r.status === 2, 'exit ' + r.status);
    check('  and says the run vouches for nothing',
        /vouches for NOTHING/.test(r.out + r.err),
        JSON.stringify((r.err || r.out).slice(0, 90)));
    // The discriminating control: a fleet that EXISTS and is simply quiet must
    // still exit 0, or the check above is satisfied by a script that always fails.
    const quiet = run([]);
    check('  control: a populated fleet with nothing to flag still exits 0',
        quiet.status === 0, 'exit ' + quiet.status);
}

// --- json ----------------------------------------------------------------
{
    const r = run(['--json']);
    let parsed = null;
    try { parsed = JSON.parse(r.out); } catch { /* stays null */ }
    check('--json emits parseable JSON carrying the population',
        parsed && typeof parsed.scanned === 'number' && typeof parsed.withQueue === 'number',
        'scanned=' + (parsed && parsed.scanned));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), SUBJECT)}; driven as a subprocess `
    + `against a FIXTURE fleet (AUTODEV_FLEET_DIR), never the real one. Both arms asserted: `
    + `one planted positive that must flag, three near-misses that must not.`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
