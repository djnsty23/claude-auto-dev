#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/fleet-notify.js
//
// This is the one script in the fleet set that reaches a human directly: every
// pass can put a Windows toast on the screen. That makes both failure modes
// expensive and neither of them loud.
//
//   TOO MANY   a notifier that repeats itself gets muted, and a muted notifier
//              is worse than none because it also stops you checking manually.
//              The dedup key is sessionId + askedAt, so a rescan of the same
//              open panel must be silent.
//   TOO FEW    a session that unblocks and later re-blocks must notify again.
//              That needs the state PRUNED, and persisted, on a pass where
//              nothing fired. Returning early there without writing was a real
//              bug — the subject's own comment records it — and nothing about
//              the symptom is visible: the toast that never arrives leaves no
//              trace anywhere.
//
// The re-block fixture below re-uses the ORIGINAL askedAt on purpose. With a
// fresh timestamp the re-block notifies whether or not the prune persisted, so
// the assertion would pass against exactly the bug it exists to catch.
//
// METHOD. Every case drives the subject as a SUBPROCESS through a tiny driver
// written into the fixture tree, which calls the script's own `setNotifier`
// seam and counts what it was handed. Nothing here requires the subject into
// this process: STATE, the transcript root and the desktop session store are
// all resolved at module load from the environment, so they have to reach a
// child's env to be redirected.
//
// HERMETIC BY CONSTRUCTION. Each case gets its own fixture HOME holding its own
// transcripts and its own desktop session records, so no assertion depends on
// this machine's live sessions, and a quiet day cannot turn the suite green by
// accident. AUTODEV_FLEET_STATE deliberately points somewhere the default
// HOME-relative path would NOT resolve to, and the default path is asserted
// absent: if the override were ignored the suite fails loudly rather than
// writing into the live notifier's dedup memory.
//
// A WORKER'S ASK is the second thing that notifies: an ask.json under runs/ or
// beside a headless worker's report. The page (fleet-view.js) already showed
// those, so the case that matters is the two DISAGREEING. The ask section runs
// the page's own `list --json` over the same fixture and compares the ask files
// it shows with the ones the notifier recorded, file for file.
//
// FOUR THINGS ARE NOT PINNED HERE, deliberately, so nobody reads this file as
// full coverage of the script:
//   - the real toast. Delivery goes through powershell + toast.ps1 and firing
//     one to prove a test passed is precisely the noise the min-age threshold
//     exists to prevent. `--dry` is exercised instead, which is the same
//     toast() function up to the last call.
//   - `--test`, for the same reason.
//   - `--watch`, which only wraps pass() in a try/catch on a timer.
//   - the non-Windows stderr branch of toast(), and main()'s missing-toast.ps1
//     guard. Both key on values a child process cannot be given a different
//     answer for (process.platform, a file that ships beside the script).
//
// Run: node tooling/test-fleet-notify.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-notify.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-notify-'));
const DRIVER = path.join(ROOT, 'drive-notify.js');
const VIEW = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-view.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' - ' + detail}`);
    if (cond) passed++; else failed++;
}

// --- fixture construction ------------------------------------------------

// A fresh HOME per case. The transcript root, the heartbeat store and (via
// APPDATA) the desktop session store all hang off it.
function makeHome(name) {
    const home = path.join(ROOT, name);
    fs.mkdirSync(path.join(home, '.claude', 'projects', 'proj'), { recursive: true });
    fs.mkdirSync(path.join(home, 'appdata', 'Claude', 'claude-code-sessions'), { recursive: true });
    return home;
}

const transcript = (home, id) => path.join(home, '.claude', 'projects', 'proj', id + '.jsonl');
// NOT under `home/.claude/fleet` — see the header. The default would resolve
// there, so pointing the override elsewhere is what makes it observable.
const stateFile = (home) => path.join(home, 'state', '.notified.json');
const markerFile = (home) => path.join(home, 'state', '.notify-last-run.json');
const defaultStateFile = (home) => path.join(home, '.claude', 'fleet', '.notified.json');

// Realistic session ids: eight of one hex digit, in the UUID shape the rest of
// the fleet tooling expects.
const sid = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

/** Append an unanswered AskUserQuestion — i.e. block the session. */
function block(home, id, { at, callId = 'tu_1', question = null, options = 0 } = {}) {
    const questions = question === null ? [] : [{
        question,
        header: 'Ship',
        multiSelect: false,
        options: Array.from({ length: options }, (_, i) => ({ label: 'opt' + i, description: 'd' + i })),
    }];
    fs.appendFileSync(transcript(home, id), JSON.stringify({
        sessionId: id, cwd: '/fixture/project', gitBranch: 'main', timestamp: at,
        type: 'assistant',
        message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: callId, name: 'AskUserQuestion', input: { questions } }],
        },
    }) + '\n', 'utf8');
}

/** Append the tool_result that answers a panel — i.e. unblock the session. */
function answer(home, id, callId) {
    fs.appendFileSync(transcript(home, id), JSON.stringify({
        sessionId: id, cwd: '/fixture/project', timestamp: new Date().toISOString(),
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'ok' }] },
    }) + '\n', 'utf8');
}

/** A desktop session record, which is where a toast's title comes from. */
function desktop(home, id, title) {
    fs.writeFileSync(
        path.join(home, 'appdata', 'Claude', 'claude-code-sessions', 'local_' + id + '.json'),
        JSON.stringify({
            sessionId: 'local_' + id, cliSessionId: id, title,
            isArchived: false, lastActivityAt: Date.now(), originCwd: '/fixture/project',
        }) + '\n', 'utf8');
}

const autodev = (home) => path.join(home, '.claude', 'autodev');

/** A runs/ job its launcher still calls running, with an open ask.json. */
function runAsk(home, job, q) {
    const dir = path.join(autodev(home), 'runs', job, '2026-09-24T00-00-00-000Z');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
        job, cwd: '/fixture/project', state: 'running', started: minutesAgo(5),
    }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'ask.json'), JSON.stringify(q) + '\n', 'utf8');
    return path.join(dir, 'ask.json');
}

/**
 * A headless worker that asked and then stopped, which is what the ask note
 * tells one to do when nothing independent is left. Its ask.json lives in the
 * scratch dir named by its code, beside its report.
 */
function headlessAsk(home, code, q) {
    const wdir = path.join(home, 'workers');
    fs.mkdirSync(path.join(wdir, code), { recursive: true });
    const rec = {
        code, pid: 0, startedAt: minutesAgo(5), cwd: '/fixture/project', state: 'running',
        log: path.join(wdir, code + '.jsonl'), report: path.join(wdir, code + '.report.md'), promptFile: path.join(wdir, code + '.md'),
    };
    fs.writeFileSync(rec.promptFile, `# ${code} brief\n`, 'utf8');
    fs.writeFileSync(rec.log, 'CLAUDE_EXIT=0\n', 'utf8');
    fs.writeFileSync(rec.report, `RESULT ${code} stopped: waiting on an answer\n`, 'utf8');
    const ledger = path.join(autodev(home), 'headless-workers.json');
    const cur = readJson(ledger) || { version: 1, records: [] };
    cur.records.push(rec);
    fs.mkdirSync(autodev(home), { recursive: true });
    fs.writeFileSync(ledger, JSON.stringify(cur) + '\n', 'utf8');
    fs.writeFileSync(path.join(wdir, code, 'ask.json'), JSON.stringify(q) + '\n', 'utf8');
    return path.join(wdir, code, 'ask.json');
}

// --- driving the subject -------------------------------------------------

function envFor(home) {
    const env = { ...process.env };
    // AUTODEV_FLEET_DIR would move the heartbeat store out of the fixture.
    for (const k of Object.keys(env)) if (/^AUTODEV_FLEET_DIR$/i.test(k)) delete env[k];
    return Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, 'appdata'),
        AUTODEV_FLEET_STATE: stateFile(home),
    });
}

// mode: 'count' records what the notifier was handed; 'throw' records it and
// then fails, standing in for a toast the OS refused; 'real' installs no
// notifier at all and so runs the shipped toast() — which is why the driver
// refuses that mode without --dry.
const drive = (home, mode, flags = []) => spawnSync(
    process.execPath, [DRIVER, SUBJECT, mode, ...flags],
    { encoding: 'utf8', env: envFor(home), windowsHide: true },
);

const outOf = (r) => (r.stdout || '');
const toastsIn = (r) => outOf(r).split('\n').filter((l) => l.startsWith('TOAST|'))
    .map((l) => { const p = l.slice(6).split('|'); return { title: p[0], body: p.slice(1).join('|') }; });
const firedIn = (r) => { const m = outOf(r).match(/^FIRED (\d+)$/m); return m ? Number(m[1]) : NaN; };
const popIn = (r) => {
    const m = outOf(r).match(/(\d+) transcripts, (\d+) blocked, (\d+) asking, (\d+) new/);
    return m ? { transcripts: +m[1], blocked: +m[2], asking: +m[3], fresh: +m[4] } : null;
};
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const summarise = (r) => `exit=${r.status} out=${JSON.stringify(outOf(r).slice(0, 240))}`
    + ` err=${JSON.stringify((r.stderr || '').slice(0, 160))}`;

function run() {
    fs.writeFileSync(DRIVER, [
        '// written by tooling/test-fleet-notify.js — one pass, no real toasts.',
        "const nl = String.fromCharCode(10);",
        'const subject = require(process.argv[2]);',
        'const mode = process.argv[3];',
        "if (mode === 'real' && !process.argv.includes('--dry')) {",
        "    process.stderr.write('refusing the shipped notifier without --dry' + nl);",
        '    process.exit(3);',
        '}',
        "if (mode !== 'real') {",
        '    subject.setNotifier((title, body) => {',
        "        process.stdout.write('TOAST|' + title + '|' + body + nl);",
        "        if (mode === 'throw') throw new Error('the OS refused this toast');",
        '    });',
        '}',
        'const fired = subject.pass();',
        "process.stdout.write('FIRED ' + fired + nl);",
        '',
    ].join('\n'), 'utf8');

    // =====================================================================
    console.log('\n=== one panel notifies exactly once, and the rescan is silent ===');
    // =====================================================================
    const A = sid('1');
    const hDedup = makeHome('dedup');
    const askedA = minutesAgo(60);
    desktop(hDedup, A, 'alpha');
    block(hDedup, A, { at: askedA, callId: 'tu_1', question: 'Ship the release?', options: 2 });

    const d1 = drive(hDedup, 'count');
    check('a blocked panel older than min-age fires exactly one toast',
        d1.status === 0 && firedIn(d1) === 1 && toastsIn(d1).length === 1, summarise(d1));
    check('the pass prints the population it scanned, not just a verdict',
        JSON.stringify(popIn(d1)) === JSON.stringify({ transcripts: 1, blocked: 1, asking: 0, fresh: 1 }),
        `got ${JSON.stringify(popIn(d1))}`);
    check('the toast is titled with the session title from the desktop record',
        (toastsIn(d1)[0] || {}).title === 'alpha', `got ${JSON.stringify((toastsIn(d1)[0] || {}).title)}`);
    check('the body carries the question and how many options it offers',
        (toastsIn(d1)[0] || {}).body === 'Ship the release?  (2 options)',
        `got ${JSON.stringify((toastsIn(d1)[0] || {}).body)}`);
    check('the session is named on stdout as notified',
        /^ {2}notified: alpha$/m.test(outOf(d1)), `out=${JSON.stringify(outOf(d1).slice(0, 240))}`);

    check('state is written where AUTODEV_FLEET_STATE points',
        fs.existsSync(stateFile(hDedup)), `no file at ${stateFile(hDedup)}`);
    check('and NOT at the HOME-relative default the override replaced',
        !fs.existsSync(defaultStateFile(hDedup)), `${defaultStateFile(hDedup)} was written`);
    check('the state keys the session on the askedAt of the panel that fired',
        (readJson(stateFile(hDedup)) || {})[A] === askedA,
        `got ${JSON.stringify(readJson(stateFile(hDedup)))}, want ${askedA}`);

    const m1 = readJson(markerFile(hDedup)) || {};
    check('a run marker records the population of the pass that fired',
        m1.blocked === 1 && m1.fresh === 1 && m1.transcripts === 1 && m1.dry === false,
        `got ${JSON.stringify(m1)}`);

    const d2 = drive(hDedup, 'count');
    check('re-scanning the same open panel notifies nothing',
        d2.status === 0 && firedIn(d2) === 0 && toastsIn(d2).length === 0, summarise(d2));
    check('and the silent pass still reports the session as blocked',
        JSON.stringify(popIn(d2)) === JSON.stringify({ transcripts: 1, blocked: 1, asking: 0, fresh: 0 }),
        `got ${JSON.stringify(popIn(d2))}`);
    check('a still-blocked session is NOT pruned out of the state',
        (readJson(stateFile(hDedup)) || {})[A] === askedA,
        `got ${JSON.stringify(readJson(stateFile(hDedup)))}`);

    const m2 = readJson(markerFile(hDedup)) || {};
    check('the marker is rewritten on a pass that fired nothing',
        m2.fresh === 0 && m2.blocked === 1 && Date.parse(m2.at) >= Date.parse(m1.at),
        `first=${JSON.stringify(m1)} second=${JSON.stringify(m2)}`);

    // A NEW panel in the same session: same sessionId, different askedAt. A
    // dedup keyed on the session alone would stay silent here and look correct
    // in every assertion above.
    answer(hDedup, A, 'tu_1');
    const askedA2 = minutesAgo(45);
    block(hDedup, A, { at: askedA2, callId: 'tu_2', question: 'Deploy now?', options: 3 });
    const d3 = drive(hDedup, 'count');
    check('a NEW panel in the same session notifies again',
        firedIn(d3) === 1 && (toastsIn(d3)[0] || {}).body === 'Deploy now?  (3 options)', summarise(d3));
    check('and the state moves to the new askedAt rather than keeping the old one',
        (readJson(stateFile(hDedup)) || {})[A] === askedA2,
        `got ${JSON.stringify(readJson(stateFile(hDedup)))}, want ${askedA2}`);

    // =====================================================================
    console.log('\n=== a panel younger than min-age fires nothing ===');
    // =====================================================================
    const B = sid('2');
    const hAge = makeHome('minage');
    block(hAge, B, { at: minutesAgo(1), callId: 'tu_1', question: 'Pick a colour?', options: 4 });

    const a1 = drive(hAge, 'count');
    check('a panel one minute old notifies nothing',
        a1.status === 0 && firedIn(a1) === 0 && toastsIn(a1).length === 0, summarise(a1));
    // Without this the case above is indistinguishable from a probe that saw
    // no sessions at all.
    check('and the same pass still SEES it as blocked, so the threshold is the reason',
        JSON.stringify(popIn(a1)) === JSON.stringify({ transcripts: 1, blocked: 1, asking: 0, fresh: 0 }),
        `got ${JSON.stringify(popIn(a1))}`);
    check('nothing is recorded for a panel that was held back',
        !fs.existsSync(stateFile(hAge)) || !((readJson(stateFile(hAge)) || {})[B]),
        `state=${JSON.stringify(readJson(stateFile(hAge)))}`);

    const a2 = drive(hAge, 'count', ['--min-age', '0']);
    check('the SAME panel fires once the threshold is lowered to zero',
        firedIn(a2) === 1 && toastsIn(a2).length === 1, summarise(a2));
    check('a session with no desktop record falls back to a generic title',
        (toastsIn(a2)[0] || {}).title === 'A session is waiting',
        `got ${JSON.stringify((toastsIn(a2)[0] || {}).title)}`);

    // =====================================================================
    console.log('\n=== unblocking prunes the state, even on a pass that fires nothing ===');
    // =====================================================================
    const C = sid('3');
    const hRe = makeHome('reblock');
    const askedC = minutesAgo(90);
    desktop(hRe, C, 'gamma');
    block(hRe, C, { at: askedC, callId: 'tu_1', question: 'Merge it?', options: 2 });

    const r1 = drive(hRe, 'count');
    check('the first block notifies', firedIn(r1) === 1, summarise(r1));

    answer(hRe, C, 'tu_1');
    const r2 = drive(hRe, 'count');
    check('once answered the session is no longer counted blocked',
        JSON.stringify(popIn(r2)) === JSON.stringify({ transcripts: 1, blocked: 0, asking: 0, fresh: 0 }),
        `got ${JSON.stringify(popIn(r2))}`);
    check('the prune is PERSISTED although nothing fired on that pass',
        JSON.stringify(readJson(stateFile(hRe))) === '{}',
        `state=${JSON.stringify(readJson(stateFile(hRe)))}`);
    check('the marker records that quiet pass too',
        (readJson(markerFile(hRe)) || {}).blocked === 0,
        `marker=${JSON.stringify(readJson(markerFile(hRe)))}`);

    // Same askedAt as the original panel. If the prune had not been written,
    // the key would still match and this would be silent.
    block(hRe, C, { at: askedC, callId: 'tu_2', question: 'Merge it?', options: 2 });
    const r3 = drive(hRe, 'count');
    check('re-blocking notifies again even at the ORIGINAL askedAt',
        firedIn(r3) === 1 && (toastsIn(r3)[0] || {}).title === 'gamma', summarise(r3));
    check('and the re-block is recorded, so the pass after it is silent again',
        (readJson(stateFile(hRe)) || {})[C] === askedC,
        `state=${JSON.stringify(readJson(stateFile(hRe)))}`);

    // =====================================================================
    console.log('\n=== more than three at once collapses into one summary ===');
    // =====================================================================
    const hMany = makeHome('many');
    const manyTitles = ['m-one', 'm-two', 'm-three', 'm-four'];
    ['4', '5', '6', '7'].forEach((c, i) => {
        const id = sid(c);
        desktop(hMany, id, manyTitles[i]);
        block(hMany, id, { at: minutesAgo(30 + i), callId: 'tu_1', question: 'Q' + i, options: 2 });
    });

    const s1 = drive(hMany, 'count');
    check('four waiting sessions produce ONE toast, not four',
        firedIn(s1) === 1 && toastsIn(s1).length === 1, summarise(s1));
    check('the summary title counts every one of them',
        (toastsIn(s1)[0] || {}).title === '4 sessions are waiting on you',
        `got ${JSON.stringify((toastsIn(s1)[0] || {}).title)}`);
    const named = ((toastsIn(s1)[0] || {}).body || '').match(/^(\S+), (\S+), (\S+) and 1 more\. Open the fleet board\.$/);
    check('the summary names three of them and says how many it left out',
        !!named && new Set(named.slice(1, 4)).size === 3 && named.slice(1, 4).every((n) => manyTitles.includes(n)),
        `body=${JSON.stringify((toastsIn(s1)[0] || {}).body)}`);
    check('all four are recorded by the summary, so the next pass is silent',
        Object.keys(readJson(stateFile(hMany)) || {}).length === 4 && firedIn(drive(hMany, 'count')) === 0,
        `state=${JSON.stringify(readJson(stateFile(hMany)))}`);

    const hThree = makeHome('three');
    ['8', '9', 'a'].forEach((c, i) => {
        block(hThree, sid(c), { at: minutesAgo(30 + i), callId: 'tu_1', question: 'T' + i, options: 1 });
    });
    const s2 = drive(hThree, 'count');
    check('exactly three stay individual — the summary is the boundary, not the rule',
        firedIn(s2) === 3 && toastsIn(s2).length === 3
        && !toastsIn(s2).some((t) => /sessions are waiting on you/.test(t.title)),
        summarise(s2));

    // =====================================================================
    console.log('\n=== --dry says what would fire and remembers nothing ===');
    // =====================================================================
    const D = sid('b');
    const hDry = makeHome('dry');
    desktop(hDry, D, 'delta');
    block(hDry, D, { at: minutesAgo(60), callId: 'tu_1', question: 'Publish?', options: 2 });

    // mode 'real' runs the shipped toast(); --dry is what stops it reaching
    // powershell, and the driver refuses to run this mode without it.
    const y1 = drive(hDry, 'real', ['--dry']);
    check('--dry prints what it would have sent, through the shipped toast()',
        y1.status === 0 && outOf(y1).includes('[dry] delta :: Publish?  (2 options)'), summarise(y1));
    check('--dry writes no state',
        !fs.existsSync(stateFile(hDry)), `state=${JSON.stringify(readJson(stateFile(hDry)))}`);
    check('--dry still leaves a run marker, flagged as a dry run',
        (readJson(markerFile(hDry)) || {}).dry === true,
        `marker=${JSON.stringify(readJson(markerFile(hDry)))}`);

    const y2 = drive(hDry, 'count');
    check('so a real pass afterwards still notifies',
        firedIn(y2) === 1 && (toastsIn(y2)[0] || {}).title === 'delta', summarise(y2));

    // =====================================================================
    console.log('\n=== a toast that fails is retried, not swallowed ===');
    // =====================================================================
    const E = sid('c');
    const hFail = makeHome('fail');
    desktop(hFail, E, 'epsilon');
    block(hFail, E, { at: minutesAgo(60), callId: 'tu_1', question: 'Retry?', options: 2 });

    const f1 = drive(hFail, 'throw');
    check('a failing notifier is still ATTEMPTED', toastsIn(f1).length === 1, summarise(f1));
    check('and the pass reports nothing fired rather than claiming success',
        firedIn(f1) === 0, summarise(f1));
    check('and it exits 0 — a failed toast must not take the watch loop down',
        f1.status === 0, summarise(f1));
    check('no state is written for a toast that never landed',
        !fs.existsSync(stateFile(hFail)) || !((readJson(stateFile(hFail)) || {})[E]),
        `state=${JSON.stringify(readJson(stateFile(hFail)))}`);

    const f2 = drive(hFail, 'count');
    check('so the next pass retries the same panel',
        firedIn(f2) === 1 && (toastsIn(f2)[0] || {}).title === 'epsilon', summarise(f2));

    // =====================================================================
    console.log('\n=== the unknown cases fall to the safe side ===');
    // =====================================================================
    const F = sid('d');
    const hBad = makeHome('badtime');
    block(hBad, F, { at: 'not-a-timestamp', callId: 'tu_1' });

    const b1 = drive(hBad, 'count');
    check('an unparseable askedAt notifies rather than being held back by min-age',
        firedIn(b1) === 1 && toastsIn(b1).length === 1, summarise(b1));
    check('a panel carrying no questions still toasts, with a placeholder body',
        (toastsIn(b1)[0] || {}).body === 'a question',
        `got ${JSON.stringify((toastsIn(b1)[0] || {}).body)}`);
    check('the raw askedAt is what gets recorded, so it dedups on the next pass',
        (readJson(stateFile(hBad)) || {})[F] === 'not-a-timestamp' && firedIn(drive(hBad, 'count')) === 0,
        `state=${JSON.stringify(readJson(stateFile(hBad)))}`);

    const hQuiet = makeHome('quiet');
    const q1 = drive(hQuiet, 'count');
    check('an empty fleet prints a zero population instead of nothing at all',
        q1.status === 0 && JSON.stringify(popIn(q1)) === JSON.stringify({ transcripts: 0, blocked: 0, asking: 0, fresh: 0 }),
        summarise(q1));
    check('and still writes a marker, so a quiet run is distinguishable from no run',
        (readJson(markerFile(hQuiet)) || {}).transcripts === 0,
        `marker=${JSON.stringify(readJson(markerFile(hQuiet)))}`);

    // =====================================================================
    console.log('\n=== a worker ask notifies once, and the page shows the same asks ===');
    // =====================================================================
    const hAsk = makeHome('asks');
    const runAskFile = runAsk(hAsk, 'job-seed',
        { question: 'Seeded or production?', options: [{ label: 'Seeded (Recommended)' }, { label: 'Production' }] });
    const wAskFile = headlessAsk(hAsk, 'W-ASK', { question: 'Which base?' });

    const k1 = drive(hAsk, 'count');
    check('two open asks fire two toasts, although both were written seconds ago',
        k1.status === 0 && firedIn(k1) === 2 && toastsIn(k1).length === 2, summarise(k1));
    check('the pass counts them as asking, apart from blocked panels',
        JSON.stringify(popIn(k1)) === JSON.stringify({ transcripts: 0, blocked: 0, asking: 2, fresh: 2 }),
        `got ${JSON.stringify(popIn(k1))}`);
    const byTitle = Object.fromEntries(toastsIn(k1).map((t) => [t.title, t.body]));
    check('each toast names the worker and carries its question and option count',
        byTitle['job-seed is asking'] === 'Seeded or production?  (2 options)' && byTitle['W-ASK is asking'] === 'Which base?',
        `got ${JSON.stringify(byTitle)}`);
    const st1 = readJson(stateFile(hAsk)) || {};
    check('each ask is recorded under its own file, stamped with its mtime',
        st1['ask:' + runAskFile] === fs.statSync(runAskFile).mtime.toISOString()
        && st1['ask:' + wAskFile] === fs.statSync(wAskFile).mtime.toISOString(),
        `state=${JSON.stringify(st1)}`);
    const km = readJson(markerFile(hAsk)) || {};
    check('the marker counts the asks and says what each source read',
        km.asking === 2 && Array.isArray(km.askSources) && km.askSources.length === 2
        && /^runs: 1 run\(s\) read under /.test(km.askSources[0]) && /: 1 record\(s\)$/.test(km.askSources[1]),
        `marker=${JSON.stringify(km)}`);

    // The page is fleet-view's own CLI over the same HOME, not a second reading
    // of the fixture: agreement is between the two programs, file for file.
    const page = spawnSync(process.execPath,
        [VIEW, 'list', '--json', '--home', hAsk, '--appdata', path.join(hAsk, 'appdata')],
        { encoding: 'utf8', env: envFor(hAsk), windowsHide: true });
    let pageAsks = null;
    try { pageAsks = JSON.parse(page.stdout).rows.filter((r) => r.question).map((r) => r.askFile).sort(); } catch { /* stays null */ }
    const notified = Object.keys(st1).filter((k) => k.startsWith('ask:')).map((k) => k.slice(4)).sort();
    check('the page shows exactly the asks the notifier recorded, file for file',
        notified.length === 2 && JSON.stringify(pageAsks) === JSON.stringify(notified),
        `page=${JSON.stringify(pageAsks)} notified=${JSON.stringify(notified)} exit=${page.status}`);

    const k2 = drive(hAsk, 'count');
    check('re-scanning the same two asks notifies nothing',
        firedIn(k2) === 0 && (popIn(k2) || {}).asking === 2, summarise(k2));

    fs.writeFileSync(path.join(path.dirname(runAskFile), 'answer.json'), JSON.stringify({ label: 'Production' }) + '\n', 'utf8');
    const k3 = drive(hAsk, 'count');
    const st3 = readJson(stateFile(hAsk)) || {};
    check('an answered ask stops counting, and its key is pruned on a pass that fired nothing',
        firedIn(k3) === 0 && (popIn(k3) || {}).asking === 1
        && !(('ask:' + runAskFile) in st3) && (('ask:' + wAskFile) in st3),
        `${summarise(k3)} state=${JSON.stringify(st3)}`);

    fs.writeFileSync(wAskFile, JSON.stringify({ question: 'Which base, now that main moved?' }) + '\n', 'utf8');
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(wAskFile, later, later);
    const k4 = drive(hAsk, 'count');
    check('a worker that rewrites its ask notifies again, with the new question',
        firedIn(k4) === 1 && (toastsIn(k4)[0] || {}).body === 'Which base, now that main moved?', summarise(k4));

    // =====================================================================
    console.log('\n=== panels and asks share one summary threshold ===');
    // =====================================================================
    const hMix = makeHome('mixed');
    ['e', 'f'].forEach((c, i) => {
        const id = sid(c);
        desktop(hMix, id, 'panel-' + i);
        block(hMix, id, { at: minutesAgo(40 + i), callId: 'tu_1', question: 'P' + i, options: 2 });
    });
    runAsk(hMix, 'job-x', { question: 'X?' });
    headlessAsk(hMix, 'W-Y', { question: 'Y?' });
    const x1 = drive(hMix, 'count');
    check('two panels plus two asks is four, so ONE summary toast',
        firedIn(x1) === 1 && toastsIn(x1).length === 1
        && (toastsIn(x1)[0] || {}).title === '4 sessions are waiting on you', summarise(x1));
    check('and all four are recorded, so the next pass is silent',
        Object.keys(readJson(stateFile(hMix)) || {}).length === 4 && firedIn(drive(hMix, 'count')) === 0,
        `state=${JSON.stringify(readJson(stateFile(hMix)))}`);

    // =====================================================================
    console.log('\n=== an unreadable ledger costs the asks, never the panels ===');
    // =====================================================================
    const hBadLedger = makeHome('badledger');
    fs.mkdirSync(autodev(hBadLedger), { recursive: true });
    fs.writeFileSync(path.join(autodev(hBadLedger), 'headless-workers.json'), '{not json', 'utf8');
    const G = sid('0');
    desktop(hBadLedger, G, 'zeta');
    block(hBadLedger, G, { at: minutesAgo(60), callId: 'tu_1', question: 'Still here?', options: 2 });
    const g1 = drive(hBadLedger, 'count');
    check('a ledger that does not parse still lets a blocked panel notify',
        g1.status === 0 && firedIn(g1) === 1 && (toastsIn(g1)[0] || {}).title === 'zeta', summarise(g1));
    check('and the marker names the source it could not read',
        ((readJson(markerFile(hBadLedger)) || {}).askSources || []).some((p) => /^headless-worker: COULD NOT READ/.test(p)),
        `marker=${JSON.stringify(readJson(markerFile(hBadLedger)))}`);
}

try {
    run();
} catch (e) {
    check('the suite ran to completion', false, `crashed: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
} finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows file locks */ }
}

const total = passed + failed;
console.log(`\ntest-fleet-notify: ${failed ? `FAIL (${failed} of ${total})` : `PASS (${total} assertions)`}\n`);
process.exit(failed ? 1 : 0);
