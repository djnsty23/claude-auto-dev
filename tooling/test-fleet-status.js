#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/fleet-status.js - the single transcript
// parser behind the fleet board, the notifier and the status skills.
// Run: node tooling/test-fleet-status.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY A FIXTURE MACHINE, AND NOT THIS ONE.
//
// Every input this script reads is derived from three environment variables:
//
//   USERPROFILE / HOME   ->  <home>/.claude/projects   (the transcripts)
//   APPDATA              ->  <appdata>/Claude/claude-code-sessions (desktop records)
//   AUTODEV_FLEET_DIR    ->  the heartbeat store, via fleet-heartbeat.js
//
// All three are read at module load, so a child process pointed at a temp tree
// sees a whole synthetic fleet and nothing of the real one. That is the only way
// this suite can assert a POPULATION - "5 transcripts in 2 project dirs" is a
// fact about a fixture and a coin toss about a live machine. It also means the
// suite cannot pass by accident on a quiet day, and cannot fail on a busy one.
//
// WHAT IS PINNED, and why each one is worth a test:
//
//   readTranscript   an AskUserQuestion whose tool_use id never receives a
//                    tool_result is PENDING; one that does is not. Only the LAST
//                    panel decides, so an old unanswered panel followed by an
//                    answered one is not a block. Six consumers read this flag
//                    and a wrong answer is wrong in all six at once, silently.
//   classify         the state policy, branch by branch, including the guards
//                    that each make a branch mean something: 'stalled' requires
//                    an addressable AND likely-running session inside a bounded
//                    idle window, so a session nobody can reach is never stalled.
//   scanFleet        population counts against a known fixture, and the
//                    heartbeat join (endedCleanly true / false / null).
//   archived rows    excluded from the session list but still counted in the
//                    transcript population, and restored by --all.
//
// Everything is asserted on a child process's stdout, stderr or exit status.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-status.js'
);

let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  (' + detail + ')'}`);
}

function eq(label, actual, expected) {
    check(label, actual === expected,
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// Fixture machine
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-status-'));
const HOMEDIR = path.join(fixture, 'home');
const APPDIR = path.join(fixture, 'appdata');
const FLEETDIR = path.join(fixture, 'fleet');
const EMPTYHOME = path.join(fixture, 'emptyhome');

const ROOT = path.join(HOMEDIR, '.claude', 'projects');
const STORE = path.join(APPDIR, 'Claude', 'claude-code-sessions');
const PROJ_A = path.join(ROOT, 'proj-a');
const PROJ_B = path.join(ROOT, 'proj-b');
const DRIVER = path.join(fixture, 'driver.js');

// Real session ids are UUIDs; fleet-heartbeat.js refuses any other shape, so a
// fixture that used friendly names would exercise a path nothing ships.
const ID11 = '11111111-1111-4111-8111-111111111111';   // unanswered panel
const ID22 = '22222222-2222-4222-8222-222222222222';   // answered panel
const ID33 = '33333333-3333-4333-8333-333333333333';   // no panel, not addressable
const ID44 = '44444444-4444-4444-8444-444444444444';   // archived
const ID55 = '55555555-5555-4555-8555-555555555555';   // older than the cutoff
const ID66 = '66666666-6666-4666-8666-666666666666';   // two panels, last answered

function writeTranscript(dir, id, lines, ageMinutes) {
    const p = path.join(dir, id + '.jsonl');
    const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    fs.writeFileSync(p, body + '\n');
    const t = new Date(Date.now() - ageMinutes * 60000);
    fs.utimesSync(p, t, t);
    return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
}

function panel(id, sessionId, ts, questions) {
    return {
        type: 'assistant', sessionId, timestamp: ts,
        message: {
            role: 'assistant',
            content: [
                { type: 'text', text: 'here are the options' },
                { type: 'tool_use', name: 'AskUserQuestion', id, input: { questions } },
            ],
        },
    };
}

function answer(id, sessionId, ts) {
    return {
        type: 'user', sessionId, timestamp: ts,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'picked one' }] },
    };
}

function text(role, sessionId, ts, body) {
    return { type: role, sessionId, timestamp: ts, message: { role, content: body } };
}

function writeRecord(rel, obj) {
    const p = path.join(STORE, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function build() {
    fs.mkdirSync(PROJ_A, { recursive: true });
    fs.mkdirSync(PROJ_B, { recursive: true });
    fs.mkdirSync(STORE, { recursive: true });
    fs.mkdirSync(FLEETDIR, { recursive: true });
    fs.mkdirSync(EMPTYHOME, { recursive: true });

    // A loose file directly under projects/ must not be counted as a project dir.
    fs.writeFileSync(path.join(ROOT, 'README.md'), 'not a project dir\n');
    // A non-jsonl file inside a project dir must not be counted as a transcript.
    fs.writeFileSync(path.join(PROJ_B, 'notes.txt'), 'not a transcript\n');

    const t11 = writeTranscript(PROJ_A, ID11, [
        { type: 'user', cwd: 'C:/work/alpha', sessionId: ID11, gitBranch: 'feature/alpha',
          timestamp: '2026-08-24T10:00:00.000Z', message: { role: 'user', content: 'go' } },
        '',                       // blank lines are skipped
        '{ this is not json',     // so are unparseable ones
        panel('toolu_alpha', ID11, '2026-08-24T10:01:00.000Z', [{
            question: 'Which path?',
            header: 'Path',
            multiSelect: true,
            options: [
                { label: 'Ship it', description: 'push now' },
                { label: 'Hold', description: 'wait for review' },
            ],
        }]),
    ], 5);

    const t22 = writeTranscript(PROJ_A, ID22, [
        text('user', ID22, '2026-08-24T11:00:00.000Z', 'start'),
        {
            type: 'assistant', sessionId: ID22, cwd: 'C:/work/bravo', timestamp: '2026-08-24T11:01:00.000Z',
            message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_bash', input: {} }] },
        },
        panel('toolu_bravo', ID22, '2026-08-24T11:02:00.000Z', [{
            question: 'Ready?', header: 'Ready', multiSelect: false,
            options: [{ label: 'Yes', description: 'go on' }],
        }]),
        answer('toolu_bravo', ID22, '2026-08-24T11:03:00.000Z'),
        text('assistant', ID22, '2026-08-24T11:04:00.000Z', 'carrying on'),
    ], 1);

    const t33 = writeTranscript(PROJ_A, ID33, [
        { type: 'assistant', sessionId: ID33, cwd: 'C:/work/charlie',
          timestamp: '2026-08-24T09:00:00.000Z', message: { role: 'assistant', content: 'working' } },
        text('user', ID33, '2026-08-24T09:05:00.000Z', 'and now this'),
    ], 30);

    writeTranscript(PROJ_B, ID44, [
        { type: 'assistant', sessionId: ID44, cwd: 'C:/work/delta',
          timestamp: '2026-08-24T08:00:00.000Z', message: { role: 'assistant', content: 'done' } },
    ], 10);

    // Older than the default 2-day window. Carries an unanswered panel that omits
    // multiSelect and options entirely, so the defaulting is exercised.
    writeTranscript(PROJ_B, ID55, [
        { type: 'user', sessionId: ID55, cwd: 'C:/work/echo',
          timestamp: '2026-08-14T08:00:00.000Z', message: { role: 'user', content: 'old' } },
        panel('toolu_echo', ID55, '2026-08-14T08:01:00.000Z', [{ question: 'Still there?', header: 'Echo' }]),
    ], 14400);

    // An unanswered panel FOLLOWED by an answered one. Two panels, not blocked:
    // only the last call decides, which is the whole point of the last-wins rule.
    writeTranscript(PROJ_B, ID66, [
        { type: 'user', sessionId: ID66, cwd: 'C:/work/foxtrot',
          timestamp: '2026-08-24T07:00:00.000Z', message: { role: 'user', content: 'go' } },
        panel('toolu_fox_a', ID66, '2026-08-24T07:01:00.000Z', [{
            question: 'First?', header: 'One', options: [{ label: 'A', description: 'a' }],
        }]),
        panel('toolu_fox_b', ID66, '2026-08-24T07:02:00.000Z', [{
            question: 'Second?', header: 'Two', options: [{ label: 'B', description: 'b' }],
        }]),
        answer('toolu_fox_b', ID66, '2026-08-24T07:03:00.000Z'),
    ], 45);

    const now = Date.now();

    writeRecord('local_aaa.json', {
        sessionId: 'local_aaa', cliSessionId: ID11, title: 'AlphaSession',
        lastActivityAt: now, isArchived: false, worktreeName: 'wt-alpha',
        originCwd: 'C:/work/alpha', model: 'opus', effort: 'high',
    });
    // One directory down, to prove the walk descends at all.
    writeRecord(path.join('nested', 'local_bbb.json'), {
        sessionId: 'local_bbb', cliSessionId: ID22, title: 'BravoSession', lastActivityAt: now,
    });
    // Archived, stale heartbeat, and a prs array whose LAST entry uses the
    // alternate key names. Both spellings ship in real records.
    writeRecord('local_ddd.json', {
        sessionId: 'local_ddd', cliSessionId: ID44, title: 'DeltaSession', isArchived: true,
        lastActivityAt: now - 3600000,
        prs: [{ number: 3, state: 'OPEN' }, { prNumber: 9, prState: 'MERGED' }],
    });
    writeRecord('local_fff.json', {
        sessionId: 'local_fff', cliSessionId: ID66, title: 'FoxtrotSession', lastActivityAt: now,
    });
    // Correct contents, wrong filename: the walk only reads local_*.json, so this
    // session must come out NOT addressable rather than silently joined.
    writeRecord('ignored.json', {
        sessionId: 'local_ccc', cliSessionId: ID33, title: 'CharlieSession', lastActivityAt: now,
    });
    // No join key, and unparseable. Neither may throw or land in the index.
    writeRecord('local_nocli.json', { sessionId: 'local_nocli', title: 'NoJoinKey' });
    writeRecord('local_broken.json', 'not json at all');
    // depth 3 is read; depth 4 is not.
    writeRecord(path.join('d1', 'd2', 'd3', 'local_deep.json'), {
        sessionId: 'local_deep', cliSessionId: 'deep-session', lastActivityAt: now,
    });
    writeRecord(path.join('d1', 'd2', 'd3', 'd4', 'local_toodeep.json'), {
        sessionId: 'local_toodeep', cliSessionId: 'toodeep-session', lastActivityAt: now,
    });

    // Heartbeats. The file name must be a UUID or fleet-heartbeat.js ignores it.
    fs.writeFileSync(path.join(FLEETDIR, ID22 + '.json'), JSON.stringify({
        cliSessionId: ID22, stoppedAt: new Date(t22.mtimeMs + 5000).toISOString(),
    }));
    fs.writeFileSync(path.join(FLEETDIR, ID33 + '.json'), JSON.stringify({
        cliSessionId: ID33, stoppedAt: new Date(t33.mtimeMs - 600000).toISOString(),
    }));
    // ID66 deliberately has none: endedCleanly must be null, not false.

    void t11;

    fs.writeFileSync(DRIVER, [
        "'use strict';",
        'const subject = require(process.env.FLEET_SUBJECT);',
        'const fs = require("fs");',
        'const mode = process.argv[2];',
        'let out;',
        "if (mode === 'classify') {",
        '  out = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).map((s) => subject.classify(s));',
        "} else if (mode === 'scan') {",
        '  out = subject.scanFleet(Number(process.argv[3]));',
        "} else if (mode === 'index') {",
        '  out = Array.from(subject.loadSessionIndex().entries());',
        "} else if (mode === 'read') {",
        '  out = subject.readTranscript(process.argv[3]);',
        '} else { throw new Error("unknown mode " + mode); }',
        'process.stdout.write(JSON.stringify(out));',
        '',
    ].join('\n'));
}

// ---------------------------------------------------------------------------
// Subprocess helpers. Nothing in this suite requires the subject in-process.
// ---------------------------------------------------------------------------

function env(home) {
    return {
        ...process.env,
        USERPROFILE: home || HOMEDIR,
        HOME: home || HOMEDIR,
        APPDATA: APPDIR,
        AUTODEV_FLEET_DIR: FLEETDIR,
        FLEET_SUBJECT: SUBJECT,
    };
}

function cli(args, home) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env: env(home) });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function cliJson(args, home) {
    const r = cli(args.concat(['--json']), home);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* left null; asserted by the caller */ }
    return { ...r, json: parsed };
}

function drive(args, home) {
    const r = spawnSync(process.execPath, [DRIVER, ...args], { encoding: 'utf8', env: env(home) });
    let parsed;
    let ok = true;
    try { parsed = JSON.parse(r.stdout); } catch { ok = false; }
    return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '', json: parsed, parsed: ok };
}

function byId(sessions, id) {
    return (sessions || []).find((s) => s.sessionId === id) || null;
}

// ---------------------------------------------------------------------------

try {
    build();

    // -----------------------------------------------------------------------
    // readTranscript: what makes a panel PENDING
    // -----------------------------------------------------------------------
    {
        const r = drive(['read', path.join(PROJ_A, 'does-not-exist.jsonl')]);
        eq('readTranscript returns null for a file it cannot read', r.json, null);
        eq('...and still exits 0', r.status, 0);
    }
    {
        const junk = path.join(fixture, 'junk.jsonl');
        fs.writeFileSync(junk, 'not json\n{also not\n\n');
        const r = drive(['read', junk]);
        eq('an all-garbage transcript yields no session id', r.json && r.json.sessionId, null);
        eq('...no panels', r.json && r.json.panelCount, 0);
        eq('...and nothing pending', r.json && r.json.pending, null);
    }
    {
        const r = drive(['read', path.join(PROJ_A, ID11 + '.jsonl')]);
        const p = r.json && r.json.pending;
        check('an unanswered AskUserQuestion is pending', !!p, `pending was ${JSON.stringify(p)}`);
        eq('the pending panel carries its question text', p && p.questions[0].question, 'Which path?');
        eq('...its header', p && p.questions[0].header, 'Path');
        eq('...its multiSelect flag', p && p.questions[0].multiSelect, true);
        eq('...and every option label', p && p.questions[0].options.map((o) => o.label).join(','), 'Ship it,Hold');
        eq('...with descriptions', p && p.questions[0].options[0].description, 'push now');
        eq('a malformed line does not stop the parse', r.json && r.json.gitBranch, 'feature/alpha');
        eq('...nor the cwd', r.json && r.json.cwd, 'C:/work/alpha');
    }
    {
        const r = drive(['read', path.join(PROJ_A, ID22 + '.jsonl')]);
        eq('an ANSWERED panel is not pending', r.json && r.json.pending, null);
        eq('...but is still counted', r.json && r.json.panelCount, 1);
        eq('a non-AskUserQuestion tool_use is not a panel', r.json && r.json.panelCount, 1);
        eq('the last message role is recorded', r.json && r.json.lastRole, 'assistant');
    }
    {
        const r = drive(['read', path.join(PROJ_B, ID66 + '.jsonl')]);
        eq('an old unanswered panel does not block once a later one is answered',
            r.json && r.json.pending, null);
        eq('...and both panels are counted', r.json && r.json.panelCount, 2);
    }
    {
        const r = drive(['read', path.join(PROJ_B, ID55 + '.jsonl')]);
        const p = r.json && r.json.pending;
        eq('a question with no multiSelect key defaults to false', p && p.questions[0].multiSelect, false);
        eq('a question with no options key yields an empty list', p && p.questions[0].options.length, 0);
    }

    // -----------------------------------------------------------------------
    // classify: the state policy, and the guard on each branch
    //
    // Each case differs from a neighbour in exactly one field, so a mutant that
    // deletes a guard changes a verdict here rather than merely narrowing one.
    // -----------------------------------------------------------------------
    {
        const base = {
            pending: null, idleMinutes: 60, lastRole: 'assistant',
            addressableId: null, likelyRunning: false, endedCleanly: null, prState: null,
        };
        const S = (o) => ({ ...base, ...o });
        const actionable = { addressableId: 'local_x', likelyRunning: true };

        const cases = [
            ['a pending panel is blocked whatever else is true',
                S({ pending: { askedAt: 'x' }, idleMinutes: 5000, endedCleanly: false, prState: 'MERGED', ...actionable }), 'blocked'],
            ['idle at the working boundary is working', S({ idleMinutes: 3 }), 'working'],
            ['one minute past it is not', S({ idleMinutes: 4 }), 'waiting'],
            ['a clean turn end reads as waiting, not stalled',
                S({ endedCleanly: true, idleMinutes: 100, prState: 'OPEN', lastRole: 'user', ...actionable }), 'waiting'],
            ['a clean turn end does NOT mask a merged PR',
                S({ endedCleanly: true, idleMinutes: 100, prState: 'MERGED', lastRole: 'user', ...actionable }), 'done'],
            ['a clean turn end does NOT mask a cold session',
                S({ endedCleanly: true, idleMinutes: 2000 }), 'cold'],
            ['an unclean end inside the window is stalled at the lower bound',
                S({ endedCleanly: false, idleMinutes: 15, ...actionable }), 'stalled'],
            ['...and at the upper bound', S({ endedCleanly: false, idleMinutes: 240, ...actionable }), 'stalled'],
            ['one minute below the window is not stalled',
                S({ endedCleanly: false, idleMinutes: 14, ...actionable }), 'waiting'],
            ['one minute above it is not stalled either',
                S({ endedCleanly: false, idleMinutes: 241, ...actionable }), 'waiting'],
            ['no heartbeat plus YOU spoke last is stalled',
                S({ endedCleanly: null, lastRole: 'user', idleMinutes: 60, ...actionable }), 'stalled'],
            ['no heartbeat but IT spoke last is not',
                S({ endedCleanly: null, lastRole: 'assistant', idleMinutes: 60, ...actionable }), 'waiting'],
            ['a session nobody can address is never stalled',
                S({ endedCleanly: false, idleMinutes: 60, addressableId: null, likelyRunning: true }), 'waiting'],
            ['a session that is not running is never stalled',
                S({ endedCleanly: false, idleMinutes: 60, addressableId: 'local_x', likelyRunning: false }), 'waiting'],
            ['an unknown likelyRunning is never stalled',
                S({ endedCleanly: false, idleMinutes: 60, addressableId: 'local_x', likelyRunning: undefined }), 'waiting'],
            ['stalled outranks done',
                S({ endedCleanly: false, idleMinutes: 100, prState: 'MERGED', ...actionable }), 'stalled'],
            ['a merged PR quiet for an hour is done', S({ prState: 'MERGED', idleMinutes: 60 }), 'done'],
            ['...but not a minute earlier', S({ prState: 'MERGED', idleMinutes: 59 }), 'waiting'],
            ['done outranks cold', S({ prState: 'MERGED', idleMinutes: 2000 }), 'done'],
            ['a day of silence is cold', S({ idleMinutes: 1440 }), 'cold'],
            ['...one minute short of a day is not', S({ idleMinutes: 1439 }), 'waiting'],
        ];

        const inputFile = path.join(fixture, 'classify-inputs.json');
        fs.writeFileSync(inputFile, JSON.stringify(cases.map((c) => c[1])));
        const r = drive(['classify', inputFile]);
        check('the classify driver produced parseable output', r.parsed,
            `exit ${r.status}, stderr ${JSON.stringify(r.stderr.slice(0, 200))}`);
        cases.forEach((c, i) => eq(c[0], r.json ? r.json[i] : undefined, c[2]));
    }

    // -----------------------------------------------------------------------
    // loadSessionIndex: the join from transcript id to an addressable id
    // -----------------------------------------------------------------------
    {
        const r = drive(['index']);
        const idx = new Map(r.json || []);
        eq('a desktop record joins on cliSessionId', idx.get(ID11) && idx.get(ID11).addressableId, 'local_aaa');
        eq('a fresh lastActivityAt reads as likely running', idx.get(ID11) && idx.get(ID11).likelyRunning, true);
        eq('an hour-old one does not', idx.get(ID44) && idx.get(ID44).likelyRunning, false);
        eq('isArchived is carried through', idx.get(ID44) && idx.get(ID44).isArchived, true);
        eq('the LAST pr in the array wins', idx.get(ID44) && idx.get(ID44).prNumber, 9);
        eq('...including its alternate key spelling', idx.get(ID44) && idx.get(ID44).prState, 'MERGED');
        eq('a record in a subdirectory is found', idx.get(ID22) && idx.get(ID22).addressableId, 'local_bbb');
        eq('a record not named local_*.json is ignored', idx.has(ID33), false);
        eq('a record at depth 3 is read', idx.has('deep-session'), true);
        eq('a record deeper than that is not', idx.has('toodeep-session'), false);
        // 9 record files exist under the store. Only these 5 carry a join key,
        // sit under a local_*.json name, and are shallow enough to be walked -
        // so a size of 5 is the population, not a spot check.
        eq('unparseable and key-less records are dropped, leaving 5 of 9', idx.size, 5);
    }

    // -----------------------------------------------------------------------
    // The CLI: population, ordering, and the archived filter
    // -----------------------------------------------------------------------
    {
        const r = cliJson([]);
        eq('--json exits 0', r.status, 0);
        check('--json emits parseable JSON', !!r.json, JSON.stringify(r.stdout.slice(0, 200)));
        const p = r.json && r.json.population;
        eq('project dirs counted', p && p.dirs, 2);
        eq('a loose file under projects/ is not a project dir', p && p.dirs, 2);
        eq('transcripts inside the window counted', p && p.transcripts, 5);
        eq('sessions with any panel counted', p && p.withPanels, 3);
        eq('sessions blocked on an unanswered panel counted', p && p.blocked, 1);
        eq('addressable sessions counted', p && p.addressable, 3);
        eq('the archived row is reported as hidden', p && p.archivedHidden, 1);

        const s = r.json && r.json.sessions;
        eq('the archived session is not listed', s && s.length, 4);
        eq('an archived row is excluded by id', !!byId(s, ID44), false);
        eq('blocked sorts first', s && s[0].sessionId, ID11);
        eq('then least-idle first', s && s.slice(1).map((x) => x.sessionId).join(','),
            [ID22, ID33, ID66].join(','));
        eq('the blocked session is state blocked', byId(s, ID11) && byId(s, ID11).state, 'blocked');
        eq('a transcript that just grew is working', byId(s, ID22) && byId(s, ID22).state, 'working');
        eq('a session with no desktop record is not addressable',
            byId(s, ID33) && byId(s, ID33).addressableId, null);
        eq('the title comes from the desktop record', byId(s, ID11) && byId(s, ID11).title, 'AlphaSession');
        eq('idle minutes are derived from the transcript mtime',
            byId(s, ID33) && byId(s, ID33).idleMinutes, 30);
    }
    {
        const r = cliJson(['--all']);
        const p = r.json && r.json.population;
        eq('--all keeps the same transcript population', p && p.transcripts, 5);
        eq('--all hides nothing', p && p.archivedHidden, 0);
        eq('--all restores the archived row', r.json && r.json.sessions.length, 5);
        eq('...and it is addressable', p && p.addressable, 4);
        const s = r.json && r.json.sessions;
        eq('--all order is blocked first then least idle',
            s && s.map((x) => x.sessionId).join(','), [ID11, ID22, ID44, ID33, ID66].join(','));
    }
    {
        const r = cliJson(['--days', '30']);
        const p = r.json && r.json.population;
        eq('--days widens the window', p && p.transcripts, 6);
        eq('...surfacing a second blocked session', p && p.blocked, 2);
        const s = r.json && r.json.sessions;
        eq('a blocked session outranks a less idle one regardless of age',
            s && s.map((x) => x.sessionId).join(','), [ID11, ID55, ID22, ID33, ID66].join(','));
        eq('a ten-day-old session with an unanswered panel is still blocked',
            byId(s, ID55) && byId(s, ID55).state, 'blocked');
        eq('...and its idle time reflects its real age',
            byId(s, ID55) && byId(s, ID55).idleMinutes, 14400);
    }
    {
        const r = cliJson(['--pending']);
        eq('--pending shows only blocked sessions', r.json && r.json.sessions.length, 1);
        eq('...and it is the right one', r.json && r.json.sessions[0].sessionId, ID11);
        eq('--pending does not change the population line',
            r.json && r.json.population.transcripts, 5);
    }

    // -----------------------------------------------------------------------
    // The CLI text report
    // -----------------------------------------------------------------------
    {
        const r = cli([]);
        eq('the text report exits 0', r.status, 0);
        check('it prints the population it scanned',
            r.stdout.includes('scanned 5 transcripts in 2 project dirs, last 2d'),
            JSON.stringify(r.stdout.slice(0, 300)));
        check('it prints the blocked count',
            r.stdout.includes('1 blocked on an unanswered panel'), JSON.stringify(r.stdout.slice(0, 300)));
        check('it says what it hid',
            r.stdout.includes('1 archived session(s) hidden (--all to show)'),
            JSON.stringify(r.stdout.slice(0, 300)));
        check('a blocked row is flagged with its branch',
            r.stdout.includes('* BLOCKED  5m idle  AlphaSession  [feature/alpha]'),
            JSON.stringify(r.stdout.slice(0, 600)));
        check('the pending question is printed', r.stdout.includes('      ? Which path?'),
            JSON.stringify(r.stdout.slice(0, 600)));
        check('so is every option label',
            r.stdout.includes('        - Ship it') && r.stdout.includes('        - Hold'),
            JSON.stringify(r.stdout.slice(0, 800)));
        check('a session with no record falls back to its cwd and is marked unreachable',
            r.stdout.includes('waiting  30m idle  charlie  (not addressable)'),
            JSON.stringify(r.stdout.slice(0, 800)));
    }
    {
        const r = cli(['--all']);
        check('--all drops the hidden-rows line',
            !r.stdout.includes('archived session(s) hidden'), JSON.stringify(r.stdout.slice(0, 300)));
        check('--all prints the archived row', r.stdout.includes('DeltaSession'),
            JSON.stringify(r.stdout.slice(0, 800)));
    }
    {
        const r = cli(['--pending']);
        check('--pending prints the blocked row', r.stdout.includes('AlphaSession'),
            JSON.stringify(r.stdout.slice(0, 400)));
        check('--pending prints no other row',
            !r.stdout.includes('BravoSession') && !r.stdout.includes('FoxtrotSession')
            && !r.stdout.includes('charlie'),
            JSON.stringify(r.stdout.slice(0, 400)));
    }

    // -----------------------------------------------------------------------
    // scanFleet: same population, plus the heartbeat join the CLI never makes
    // -----------------------------------------------------------------------
    {
        const r = drive(['scan', '2']);
        check('scanFleet produced parseable output', r.parsed,
            `exit ${r.status}, stderr ${JSON.stringify(r.stderr.slice(0, 200))}`);
        const p = r.json && r.json.population;
        eq('scanFleet counts the same project dirs', p && p.dirs, 2);
        eq('scanFleet counts the same transcripts', p && p.transcripts, 5);
        eq('scanFleet counts the same panels', p && p.withPanels, 3);
        eq('scanFleet counts the same blocked', p && p.blocked, 1);
        eq('scanFleet counts the same addressable', p && p.addressable, 3);
        eq('scanFleet hides the archived row too', r.json && r.json.sessions.length, 4);

        const s = r.json && r.json.sessions;
        eq('a heartbeat at or after the last write means the turn ended cleanly',
            byId(s, ID22) && byId(s, ID22).endedCleanly, true);
        check('...and the stop time is carried',
            !!(byId(s, ID22) && byId(s, ID22).stoppedAt),
            JSON.stringify(byId(s, ID22) && byId(s, ID22).stoppedAt));
        eq('a heartbeat before the last write means it did not',
            byId(s, ID33) && byId(s, ID33).endedCleanly, false);
        eq('no heartbeat at all stays UNKNOWN rather than false',
            byId(s, ID66) && byId(s, ID66).endedCleanly, null);
        eq('...and no heartbeat leaves stoppedAt null',
            byId(s, ID66) && byId(s, ID66).stoppedAt, null);
        // ID33 ended uncleanly and is idle 30m, so only the addressability guard
        // keeps it out of 'stalled'. That guard is the whole reason 'stalled' is
        // worth surfacing: an unreachable session cannot be rescued.
        eq('an unclean end on an unreachable session is still not stalled',
            byId(s, ID33) && byId(s, ID33).state, 'waiting');
        eq('an unknown end plus YOU spoke last, on a reachable session, is stalled',
            byId(s, ID66) && byId(s, ID66).state, 'stalled');
    }
    {
        const r = drive(['scan', '2', '--all']);
        eq('scanFleet honours --all on the command line', r.json && r.json.sessions.length, 5);
        eq('...and counts the archived row as addressable',
            r.json && r.json.population.addressable, 4);
    }
    {
        const r = drive(['scan', '30']);
        eq('scanFleet takes its window from its argument, not --days',
            r.json && r.json.population.transcripts, 6);
    }

    // -----------------------------------------------------------------------
    // No transcript root at all. This is a report, never a gate: it must say so
    // on stderr and still exit 0, and scanFleet must return a zeroed population
    // rather than throwing at the caller that embeds it.
    // -----------------------------------------------------------------------
    {
        const r = cli([], EMPTYHOME);
        eq('a missing transcript root still exits 0', r.status, 0);
        check('...and says so on stderr', /no transcript root at/.test(r.stderr),
            JSON.stringify(r.stderr.slice(0, 200)));
        eq('...printing nothing to stdout', r.stdout, '');
    }
    {
        const r = drive(['scan', '2'], EMPTYHOME);
        eq('scanFleet returns an empty session list with no root', r.json && r.json.sessions.length, 0);
        eq('...a zero transcript population', r.json && r.json.population.transcripts, 0);
        eq('...a zero dir population', r.json && r.json.population.dirs, 0);
        eq('...and does not crash', r.status, 0);
    }
} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
