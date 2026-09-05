#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/fleet-board.js - the dispatch list a
// person opens to see which session is waiting on them.
// Run: node tooling/test-fleet-board.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS ONE NEEDS TESTING AT ALL.
//
// A broken board announces itself, so its blast radius is smaller than the
// silent consumers'. What it does NOT announce is a board that renders
// beautifully and is wrong: the wrong number under "blocked", a machines list
// that includes this host and so double-counts it, a stale snapshot served from
// the boot scan instead of a live read. Each of those looks exactly like a
// working board.
//
// The three contracts pinned here are the ones with no visible failure:
//
//   THE POPULATION LINE   `first scan: N transcripts, M blocked, K addressable`
//                         is the only evidence on stdout that the scan found
//                         anything. Swap two of those fields and the board still
//                         starts, still serves, and reports the wrong shape of
//                         the fleet forever.
//   LIVE, NOT CACHED      the header says "read live off disk". A handler that
//                         served the boot scan would pass every static check and
//                         quietly go stale. So a transcript is added while the
//                         server is running and the count must move.
//   THIS HOST IS NOT A    machines come from fleet-publish and must exclude the
//   PEER                  local host, or the board counts this machine twice.
//
// THE SEAM.
//
// fleet-board.js resolves fleet-status.js and fleet-publish.js off its own
// __dirname, so the seam is the DIRECTORY the subject sits in: copy it beside
// whichever siblings a scenario wants and __dirname resolves to that copy's
// home. The subject itself is never modified - the bytes under test are the
// bytes that ship. No env-var override is added to plugins/ for this suite's
// benefit.
//
// Two planted subjects, deliberately:
//
//   subject-real  sits beside COPIES of the real fleet-status.js,
//                 fleet-heartbeat.js and fleet-publish.js, over a synthetic
//                 transcript tree in a fixture HOME. This is the wiring test:
//                 it proves the board's stdout line and its JSON body read the
//                 field names scanFleet actually emits, and that its classified
//                 states and sort order survive the trip. Rename `population`
//                 or reorder that sort upstream and this half goes red.
//
//   subject-stub  sits beside a stub fleet-status.js whose scanFleet returns an
//                 exact payload and can be made to throw AFTER the boot scan.
//                 This is the policy test: the 500 path, the missing-sibling
//                 fallback, and the --days value actually reaching scanFleet -
//                 all of which are tedious to produce through real transcripts
//                 and exact when handed over directly.
//
// Neither half reads this machine's transcripts, session records, heartbeats or
// published status, so the suite cannot pass on a quiet day for the wrong
// reason. The one thing it does read from this machine is os.hostname(), which
// is the value under test in the self-filter assertion.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'fleet-board.js');
const REAL_STATUS = path.join(SCRIPTS, 'fleet-status.js');
const REAL_HEARTBEAT = path.join(SCRIPTS, 'fleet-heartbeat.js');
const REAL_PUBLISH = path.join(SCRIPTS, 'fleet-publish.js');

let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  (' + detail + ')'}`);
}

function eq(label, actual, expected) {
    check(label, actual === expected,
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function deq(label, actual, expected) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    check(label, a === b, `got ${a}, expected ${b}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixture machine
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-board-'));

const HOME = path.join(fixture, 'home');
const APPDIR = path.join(fixture, 'appdata');
const BEATS = path.join(fixture, 'beats');          // empty: no heartbeats anywhere
const PUBLISHED = path.join(fixture, 'published');  // other machines' status files
const REAL_DIR = path.join(fixture, 'subject-real');
const STUB_DIR = path.join(fixture, 'subject-stub');

const STORE = path.join(APPDIR, 'Claude', 'claude-code-sessions');
const PROJ = path.join(HOME, '.claude', 'projects', 'proj');

// Real ids are UUIDs; a fixture using friendly names exercises a shape that
// never ships.
const T1 = 'bbbbbbbb-1111-4111-8111-111111111111';  // blocked on an unanswered panel
const T2 = 'bbbbbbbb-2222-4222-8222-222222222222';  // raised a panel and got an answer
const T3 = 'bbbbbbbb-3333-4333-8333-333333333333';  // quiet 30h, no desktop record
const T4 = 'bbbbbbbb-4444-4444-8444-444444444444';  // user spoke last, 30m ago
const T5 = 'bbbbbbbb-5555-4555-8555-555555555555';  // written WHILE the server runs

function plantSubject(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(SUBJECT, path.join(dir, 'fleet-board.js'));
    return path.join(dir, 'fleet-board.js');
}

// The mtime is the only thing scanFleet reads for idleMinutes, so it is set
// explicitly rather than inferred from when the fixture happened to be written.
function writeTranscript(id, lines, ageMinutes) {
    const p = path.join(PROJ, id + '.jsonl');
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const t = new Date(Date.now() - ageMinutes * 60000);
    fs.utimesSync(p, t, t);
    return p;
}

const opening = (id, cwd, branch) => ({
    type: 'user', sessionId: id, cwd, gitBranch: branch,
    timestamp: '2026-08-24T10:00:00.000Z',
    message: { role: 'user', content: 'go' },
});

const spoke = (id) => ({
    type: 'assistant', sessionId: id, timestamp: '2026-08-24T10:05:00.000Z',
    message: { role: 'assistant', content: 'working on it' },
});

const said = (id) => ({
    type: 'user', sessionId: id, timestamp: '2026-08-24T10:07:00.000Z',
    message: { role: 'user', content: 'carry on' },
});

const panel = (id, toolId) => ({
    type: 'assistant', sessionId: id, timestamp: '2026-08-24T10:06:00.000Z',
    message: {
        role: 'assistant',
        content: [{
            type: 'tool_use', name: 'AskUserQuestion', id: toolId,
            input: {
                questions: [{
                    question: 'Which path?', header: 'Path', multiSelect: false,
                    options: [
                        { label: 'Prune', description: 'cut it back' },
                        { label: 'Graft', description: 'join a new branch on' },
                    ],
                }],
            },
        }],
    },
});

const answer = (id, toolId) => ({
    type: 'user', sessionId: id, timestamp: '2026-08-24T10:08:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Prune' }] },
});

const writeRecord = (name, rec) =>
    fs.writeFileSync(path.join(STORE, name), JSON.stringify(rec));

function buildFixture() {
    fs.mkdirSync(PROJ, { recursive: true });
    fs.mkdirSync(STORE, { recursive: true });
    fs.mkdirSync(BEATS, { recursive: true });
    fs.mkdirSync(PUBLISHED, { recursive: true });

    plantSubject(REAL_DIR);
    // fleet-status requires fleet-heartbeat off its own __dirname, and
    // fleet-publish requires fleet-status the same way, so the set travels
    // together or a copy reaches into a different clone.
    fs.copyFileSync(REAL_STATUS, path.join(REAL_DIR, 'fleet-status.js'));
    // fleet-status.js resolves the desktop session store through claude-paths.js.
    // A copy without that sibling silently loses the store, so every session comes
    // back "(not addressable)" and the addressability assertions below fail for a
    // reason that has nothing to do with the subject. The shipped plugin always
    // carries the whole scripts directory; the fixture must too.
    fs.copyFileSync(path.join(SCRIPTS, 'claude-paths.js'), path.join(REAL_DIR, 'claude-paths.js'));
    fs.copyFileSync(REAL_HEARTBEAT, path.join(REAL_DIR, 'fleet-heartbeat.js'));
    fs.copyFileSync(REAL_PUBLISH, path.join(REAL_DIR, 'fleet-publish.js'));

    writeTranscript(T1, [opening(T1, 'C:/code/orchard', 'feature/prune'), panel(T1, 'toolu_t1')], 5);
    writeTranscript(T2, [
        opening(T2, 'C:/code/ledger', 'main'), panel(T2, 'toolu_t2'),
        answer(T2, 'toolu_t2'), spoke(T2),
    ], 10);
    writeTranscript(T3, [opening(T3, 'C:/code/quarry', 'main'), spoke(T3)], 1800);
    // The user spoke last and nothing has happened since: the 'stalled' branch,
    // which only fires for a session that is addressable AND likely running.
    writeTranscript(T4, [opening(T4, 'C:/code/basalt', 'wip/kiln'), spoke(T4), said(T4)], 30);

    const now = Date.now();
    writeRecord('local_one.json', {
        sessionId: 'local_one', cliSessionId: T1, title: 'Orchard Harvest',
        originCwd: 'C:/code/orchard', lastActivityAt: now,
    });
    writeRecord('local_two.json', {
        sessionId: 'local_two', cliSessionId: T2, title: 'Ledger Rewrite',
        originCwd: 'C:/code/ledger', lastActivityAt: now,
    });
    writeRecord('local_four.json', {
        sessionId: 'local_four', cliSessionId: T4, title: 'Basalt Kiln',
        originCwd: 'C:/code/basalt', lastActivityAt: now,
    });
    // T3 deliberately gets no record: an unaddressable row must still be shown.

    // Other machines. This host's own file must be filtered out; the two peers
    // must survive in published-at order, newest first.
    const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
    writeRecordFile('thisbox.json', { host: os.hostname(), blocked: 9, sessions: 20, oldestBlockedMin: 5, publishedAt: iso(0) });
    writeRecordFile('otherbox.json', { host: 'otherbox', blocked: 4, sessions: 11, oldestBlockedMin: 33, publishedAt: iso(60) });
    writeRecordFile('thirdbox.json', { host: 'thirdbox', blocked: 0, sessions: 3, oldestBlockedMin: null, publishedAt: iso(500) });
}

const writeRecordFile = (name, rec) =>
    fs.writeFileSync(path.join(PUBLISHED, name), JSON.stringify(rec));

// The stub half. scanFleet returns an exact payload, echoes the days it was
// given, and - when told - throws on every call AFTER the boot scan, because a
// throw during listen() would kill the process before it printed anything.
function buildStub(dir, extra) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(SUBJECT, path.join(dir, 'fleet-board.js'));
    fs.writeFileSync(path.join(dir, 'fleet-status.js'), [
        "'use strict';",
        'let calls = 0;',
        'function scanFleet(days) {',
        '  calls++;',
        "  if (calls > 1 && process.env.BOARD_THROW) throw new Error('scan exploded');",
        '  return {',
        '    scannedAt: new Date().toISOString(),',
        '    population: { dirs: 3, transcripts: 41, withPanels: 9, blocked: 7, addressable: 13 },',
        // idleMinutes carries the days argument back out, so the flag can be
        // asserted by VALUE rather than by the board merely starting.
        "    sessions: [{ sessionId: 'stub-1', state: 'waiting', title: 'Stub Row', idleMinutes: days }],",
        '  };',
        '}',
        'module.exports = { scanFleet };',
        '',
    ].join('\n'));
    // Deliberately NO fleet-publish.js here: the board must survive its absence.
    if (extra) extra(dir);
}

// ---------------------------------------------------------------------------
// Subprocess + HTTP helpers. Nothing here requires the subject in-process.
// ---------------------------------------------------------------------------

const children = [];

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

// freePort() binds 0, reads the number the OS assigned, then CLOSES. The child
// therefore binds a port this process no longer holds, and anything on the
// machine can take it in that window. On a loaded box it does: the child dies
// with EADDRINUSE and every assertion below fails for a reason that has nothing
// to do with the board.
//
// Measured 2026-09-02: this suite passed standalone (62/62) while
// check-suites-can-fail reported it `RED  already failing` in the same tree,
// with ~116 node processes running. Same signature as a leftover fixture, and a
// completely different cause - so the shared symptom is "a baseline fails for an
// ambient reason", not one bug.
//
// Only EADDRINUSE is retried. A board that dies for any other reason must still
// fail the suite: a broader catch would hide precisely the startup defects this
// file exists to catch, which is the "narrowing a filter hides what it was
// compensating for" trap in reverse.
const ADDR_IN_USE = /EADDRINUSE/;
const START_ATTEMPTS = 5;

/**
 * Start the board and wait for a POSITIVE signal that it is up - the second of
 * the two lines it prints, which lands only after the boot scan has returned.
 * Waiting on a quiet period instead would conclude before the scan began.
 *
 * Retries only a port collision, and only with a FRESH port each time.
 */
async function startBoard(dir, args, env) {
    let last;
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
        last = await startBoardOnce(dir, args, env);
        const lost = last.died() && ADDR_IN_USE.test(last.stderr());
        if (!lost) return last;
        if (attempt < START_ATTEMPTS) {
            console.error(`  [retry ${attempt}/${START_ATTEMPTS - 1}] port ${last.port} was taken between freePort() and bind; retrying on a fresh one`);
        }
    }
    return last;
}

async function startBoardOnce(dir, args, env) {
    const port = await freePort();
    const child = spawn(process.execPath,
        [path.join(dir, 'fleet-board.js'), '--port', String(port), ...(args || [])], {
            env: {
                ...process.env,
                USERPROFILE: HOME,
                HOME,
                APPDATA: APPDIR,
                AUTODEV_FLEET_DIR: BEATS,
                AUTODEV_FLEET_PUBLISH_DIR: PUBLISHED,
                BOARD_THROW: '',
                ...(env || {}),
            },
        });
    children.push(child);

    let out = '', err = '', closed = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const closePromise = new Promise((r) => child.on('close', () => { closed = true; r(); }));

    const deadline = Date.now() + 30000;
    while (!closed && !/first scan:/.test(out) && Date.now() < deadline) await sleep(25);

    return {
        port, child, closePromise,
        stdout: () => out,
        stderr: () => err,
        lines: () => out.split('\n').filter(Boolean),
        died: () => closed,
        stop: async () => { child.kill(); await closePromise; },
    };
}

function get(port, p) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
            let b = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { b += d; });
            res.on('end', () => resolve({
                status: res.statusCode, headers: res.headers, body: b,
                json: () => { try { return JSON.parse(b); } catch { return null; } },
            }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
    });
}

// ---------------------------------------------------------------------------

(async () => {
    try {
        buildFixture();
        buildStub(STUB_DIR);

        // -------------------------------------------------------------------
        // END TO END over the REAL fleet-status.js and a real transcript tree.
        // -------------------------------------------------------------------
        {
            const b = await startBoard(REAL_DIR);
            check('the board starts over a real transcript tree', !b.died(),
                'exited early; stderr=' + JSON.stringify(b.stderr()));
            eq('...printing the address it is actually listening on',
                b.lines()[0], `fleet board on http://127.0.0.1:${b.port}`);

            // The population line. Read by capture, so the assertion is about
            // which number sits under which label - a swap of two fields is
            // invisible in a substring check and is the failure being pinned.
            const m = b.lines()[1].match(
                /^ {2}first scan: (\d+) transcripts, (\d+) blocked, (\d+) addressable \((\d+)ms\)$/);
            check('...and a population line in the documented shape', !!m,
                JSON.stringify(b.lines()[1]));
            if (m) {
                eq('four transcripts were in the two-day window', m[1], '4');
                eq('...one of them blocked on an unanswered panel', m[2], '1');
                eq('...and three carrying a desktop record that can be addressed', m[3], '3');
                check('...with the scan timed', Number.isFinite(Number(m[4])), m[4]);
            }
            eq('a healthy start writes nothing to stderr', b.stderr(), '');

            const r = await get(b.port, '/api/fleet');
            eq('the api answers 200', r.status, 200);
            eq('...as json', r.headers['content-type'], 'application/json');
            eq('...uncacheable, because the whole point is that it is current',
                r.headers['cache-control'], 'no-store');

            const d = r.json();
            deq('the population it serves is the population it scanned',
                d.population,
                { dirs: 1, transcripts: 4, withPanels: 2, blocked: 1, addressable: 3 });
            deq('rows arrive blocked first, then longest-waiting last',
                d.sessions.map((s) => s.state), ['blocked', 'waiting', 'stalled', 'cold']);

            const top = d.sessions[0];
            eq('the blocked row carries its desktop title', top.title, 'Orchard Harvest');
            eq('...the id the app needs to reach it', top.addressableId, 'local_one');
            eq('...the branch it is on', top.gitBranch, 'feature/prune');
            eq('...how long it has been waiting', top.idleMinutes, 5);
            eq('...and the question it is actually blocked on',
                top.pending.questions[0].question, 'Which path?');
            deq('...with every option label the reader has to choose between',
                top.pending.questions[0].options.map((o) => o.label), ['Prune', 'Graft']);
            eq('...and the description under the first of them',
                top.pending.questions[0].options[0].description, 'cut it back');

            eq('a session whose panel was answered has raised one', d.sessions[1].panelCount, 1);
            eq('...and is no longer pending', d.sessions[1].pending, null);
            eq('a session with no desktop record is still shown',
                d.sessions[3].sessionId, T3);
            eq('...marked as unreachable rather than dropped',
                d.sessions[3].addressableId, null);

            // Other machines.
            deq('peers are listed newest-published first',
                d.machines.map((x) => x.host), ['otherbox', 'thirdbox']);
            eq('...carrying the count they published', d.machines[0].blocked, 4);
            eq('...and their session total', d.machines[0].sessions, 11);
            check('this host is never listed as a peer of itself',
                !d.machines.some((x) => x.host === os.hostname()),
                JSON.stringify(d.machines.map((x) => x.host)));
            eq('...and the board says where it read them from',
                d.machinesDir, PUBLISHED);

            // Routing.
            const homePage = await get(b.port, '/');
            eq('the root path serves the page', homePage.status, 200);
            eq('...as html', homePage.headers['content-type'], 'text/html; charset=utf-8');
            eq('...uncacheable too', homePage.headers['cache-control'], 'no-store');
            check('...and it is a document, not a json body',
                homePage.body.trimStart().toLowerCase().startsWith('<!doctype html>'),
                JSON.stringify(homePage.body.slice(0, 80)));

            const stray = await get(b.port, '/not/a/route');
            eq('an unknown path serves the page rather than 404ing', stray.status, 200);
            eq('...as html', stray.headers['content-type'], 'text/html; charset=utf-8');

            // The page and the handler must agree on the endpoint. Taking the
            // path out of the SERVED document and driving it is the only check
            // that fails when one side is renamed and the other is not.
            const fetched = homePage.body.match(/fetch\('([^']+)'\)/);
            check('the served page names the endpoint it polls', !!fetched,
                JSON.stringify(homePage.body.slice(0, 200)));
            if (fetched) {
                const viaPage = await get(b.port, fetched[1]);
                eq(`...and ${fetched[1]} is served as json by this same server`,
                    viaPage.headers['content-type'], 'application/json');
            }

            const query = await get(b.port, '/api/fleet?refresh=1');
            eq('a query string does not knock the api off its route',
                query.headers['content-type'], 'application/json');

            const upper = await get(b.port, '/API/fleet');
            eq('route matching is case-sensitive, so /API/fleet is the page',
                upper.headers['content-type'], 'text/html; charset=utf-8');

            // LIVE, NOT CACHED. A handler serving the boot scan passes every
            // assertion above and is wrong within the minute.
            writeTranscript(T5, [opening(T5, 'C:/code/willow', 'wip/new'), spoke(T5)], 1);
            const again = (await get(b.port, '/api/fleet')).json();
            eq('a transcript written while the server runs is picked up',
                again.population.transcripts, 5);
            eq('...so the body is a fresh scan, not the one from boot',
                again.sessions.length, 5);

            await b.stop();
        }

        // The window flag has to reach scanFleet, and the cold row is the only
        // observable that says whether it did.
        fs.unlinkSync(path.join(PROJ, T5 + '.jsonl'));
        {
            const b = await startBoard(REAL_DIR, ['--days', '1']);
            const m = b.lines()[1].match(/first scan: (\d+) transcripts, (\d+) blocked/);
            eq('--days narrows the scan window', m && m[1], '3');
            eq('...without losing the blocked row', m && m[2], '1');

            const d = (await get(b.port, '/api/fleet')).json();
            eq('...and the api agrees with the line it printed',
                d.population.transcripts, 3);
            deq('...the row quiet for 30h having dropped out',
                d.sessions.map((s) => s.state), ['blocked', 'waiting', 'stalled']);
            await b.stop();
        }

        // -------------------------------------------------------------------
        // The stub half: exact numbers, and the siblings that may be missing.
        // -------------------------------------------------------------------
        {
            const b = await startBoard(STUB_DIR, ['--days', '5']);
            check('the board starts with no fleet-publish.js beside it', !b.died(),
                'exited early; stderr=' + JSON.stringify(b.stderr()));
            const m = b.lines()[1].match(
                /^ {2}first scan: (\d+) transcripts, (\d+) blocked, (\d+) addressable \(\d+ms\)$/);
            check('...still printing a population line', !!m, JSON.stringify(b.lines()[1]));
            if (m) {
                eq('transcripts is the transcripts field', m[1], '41');
                eq('blocked is the blocked field', m[2], '7');
                eq('addressable is the addressable field', m[3], '13');
            }

            const r = await get(b.port, '/api/fleet');
            eq('the api still answers 200 with no peer file to read', r.status, 200);
            const d = r.json();
            eq('--days is passed through to the scan, not merely parsed',
                d.sessions[0].idleMinutes, 5);
            deq('a missing fleet-publish.js yields no peers rather than an error',
                d.machines, []);
            check('...and no claim about where peers were read from',
                !('machinesDir' in d), JSON.stringify(Object.keys(d)));
            await b.stop();
        }
        {
            const b = await startBoard(STUB_DIR);
            const d = (await get(b.port, '/api/fleet')).json();
            eq('the default window is two days', d.sessions[0].idleMinutes, 2);
            await b.stop();
        }

        // A scan that throws must reach the reader as an error, and must not
        // take the server down with it - a board that dies on one bad scan is
        // indistinguishable from a board nobody started.
        {
            const b = await startBoard(STUB_DIR, [], { BOARD_THROW: '1' });
            check('the board survives its boot scan', !b.died(),
                'exited early; stderr=' + JSON.stringify(b.stderr()));

            const r = await get(b.port, '/api/fleet');
            eq('a failed scan answers 500', r.status, 500);
            eq('...as json, so the page can read it', r.headers['content-type'], 'application/json');
            deq('...carrying the reason', r.json(), { error: 'scan exploded' });

            const page = await get(b.port, '/');
            eq('...while the page itself is still served', page.status, 200);
            const second = await get(b.port, '/api/fleet');
            eq('...and a second failing request is still answered, not dropped',
                second.status, 500);
            check('the process is still alive after two failed scans', !b.died(),
                'server exited; stderr=' + JSON.stringify(b.stderr()));
            await b.stop();
        }

        // The retry above is worthless if ADDR_IN_USE never matches what the
        // child actually prints, and that is a silent failure: the suite would
        // simply go on failing intermittently while the guard sat there looking
        // correct. So hold a port OURSELVES and make the board collide with it,
        // rather than trusting that node's message still says EADDRINUSE.
        {
            const held = net.createServer();
            const takenPort = await new Promise((res, rej) => {
                held.on('error', rej);
                held.listen(0, '127.0.0.1', () => res(held.address().port));
            });
            try {
                const child = spawn(process.execPath,
                    [path.join(REAL_DIR, 'fleet-board.js'), '--port', String(takenPort)],
                    { env: { ...process.env, USERPROFILE: HOME, HOME, APPDATA: APPDIR,
                        AUTODEV_FLEET_DIR: BEATS, AUTODEV_FLEET_PUBLISH_DIR: PUBLISHED, BOARD_THROW: '' } });
                children.push(child);
                let err = '';
                child.stderr.on('data', (d) => { err += d; });
                await new Promise((r) => child.on('close', r));
                check('a board whose port is already held dies rather than serving',
                    err.length > 0, 'the child exited silently, so nothing proves it collided');
                // The load-bearing one. If node ever reworded this, the retry
                // would stop firing and nothing else would say so.
                check('  and ADDR_IN_USE matches the message it really prints',
                    ADDR_IN_USE.test(err), `stderr was: ${err.slice(0, 200)}`);
            } finally {
                await new Promise((r) => held.close(r));
            }
        }

    } finally {
        for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
        fs.rmSync(fixture, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    console.error(e && e.stack || e);
    for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch { /* already gone */ }
    process.exit(1);
});

// FINDINGS - observed while writing this suite, deliberately NOT fixed here.
//
// 1. `module.exports = { esc }` exports a server-side escaper that nothing in
//    the file calls. The page does its own escaping in browser JS; the served
//    HTML is a static template. Nothing requires fleet-board.js either, so the
//    export is unreachable. Not covered: reaching it means require()ing the
//    subject, which starts a listening server as a side effect.
//
// 2. The docstring says "binds loopback only", and the listen call does pass
//    '127.0.0.1'. Not asserted here: proving a socket is NOT reachable from
//    another interface needs a second address this machine may not have, and a
//    check that silently finds no second interface would report a pass it never
//    earned.
