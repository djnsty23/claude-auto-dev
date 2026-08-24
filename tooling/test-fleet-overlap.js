#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/fleet-overlap.js - the duplicate-work
// detector an overseer session reads before handing anyone a brief.
// Run: node tooling/test-fleet-overlap.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS ONE NEEDS TESTING AT ALL.
//
// Both of its failure modes are silent. Lose the stopword or project-word
// filter and every pair of sessions "overlaps", which is a detector that fires
// on everything and therefore gets muted. Lose a guard the other way - the
// score threshold, the live filter, the branch equality - and it reports zero
// pairs, which reads as "no collisions" and is indistinguishable from working.
// Neither degradation errors, and neither is visible in the output.
//
// So every zero asserted below sits in the same run as a PLANTED POSITIVE: a
// beacon pair on one branch that must always score 105. A run that reports the
// canary and not the case under test is a run whose probe demonstrably fires.
//
// THE SEAM, AND WHY IT IS THE REAL ONE.
//
// fleet-overlap.js has no exports and no arguments. Its only input is
// `execFileSync(node, [path.join(__dirname, 'fleet-status.js'),
// '--days','2','--json'])`, read at module load. fleet-status is a same-plugin
// SIBLING and is resolved as one, so the seam is the DIRECTORY the subject sits
// in: copy fleet-overlap.js next to whichever fleet-status.js a scenario wants
// and __dirname resolves to that copy's home. Every assertion here is on the
// stdout of the real CLI end to end - never a helper called directly, because
// there is no helper to call.
//
// This used to be done by pointing USERPROFILE at a fixture home, back when the
// subject hardcoded <USERPROFILE>/claude-auto-dev/.../fleet-status.js. That path
// was a production defect - an installed plugin invoked a different clone's
// parser, and a machine with no USERPROFILE threw on load - so it is gone, and
// with it that seam. Copying the subject replaces it WITHOUT asking plugins/ to
// carry an env-var override that exists only for this file's benefit.
//
// Two planted subjects, deliberately:
//
//   subject-real   sits beside a COPY of the real fleet-status.js and
//                  fleet-heartbeat.js, over a synthetic transcript tree in a
//                  fixture HOME. This is the wiring test: it proves
//                  fleet-overlap reads the field names fleet-status actually
//                  emits. Rename `gitBranch` upstream and this half goes red -
//                  measured, 64 passed / 6 failed - which is the whole point: a
//                  suite that only ever fed the detector its own hand-written
//                  JSON would keep passing while the join rotted.
//
//                  NOT `originCwd`, though an earlier version of this comment
//                  said so. repoOf() reads `r.originCwd || r.cwd`, and the
//                  fixture deliberately leaves one session without originCwd to
//                  exercise that fallback, so renaming the field upstream is
//                  absorbed rather than caught. Measured: that mutant SURVIVES.
//                  Left as a fallback worth having, but do not cite this suite
//                  as proof that field name is pinned - it is not.
//
//   subject-stub   sits beside a stub fleet-status.js that prints a fixture
//                  payload and logs its own argv. This is the policy test: score
//                  boundaries, stopwords and the live cutoff need session shapes
//                  that are tedious to produce through real transcripts and
//                  exact when handed over directly.
//
// Neither half reads this machine's transcripts, session records or heartbeat
// store, so the suite cannot pass on a quiet day for the wrong reason.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'fleet-overlap.js');
const REAL_STATUS = path.join(SCRIPTS, 'fleet-status.js');
const REAL_HEARTBEAT = path.join(SCRIPTS, 'fleet-heartbeat.js');

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

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-overlap-'));

const REAL_HOME = path.join(fixture, 'realhome');
const STUB_HOME = path.join(fixture, 'stubhome');
const REAL_DIR = path.join(fixture, 'subject-real');   // subject + real fleet-status
const STUB_DIR = path.join(fixture, 'subject-stub');   // subject + stub fleet-status
const APPDIR = path.join(fixture, 'appdata');
const FLEETDIR = path.join(fixture, 'fleet');          // empty: no heartbeats
const PAYLOAD = path.join(fixture, 'payload.json');
const ARGVLOG = path.join(fixture, 'argv.json');

const STORE = path.join(APPDIR, 'Claude', 'claude-code-sessions');
const PROJ = path.join(REAL_HOME, '.claude', 'projects', 'proj');

/**
 * Plant a copy of the SHIPPED subject in `dir`. Whatever fleet-status.js the
 * caller then writes beside it is the one the copy will resolve, because the
 * subject joins its own __dirname. The subject itself is never modified - the
 * bytes under test are the bytes that ship.
 */
function plantSubject(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(SUBJECT, path.join(dir, 'fleet-overlap.js'));
    return path.join(dir, 'fleet-overlap.js');
}

// Real ids are UUIDs, and fleet-heartbeat.js refuses any other shape, so a
// fixture using friendly names would exercise a path nothing ships.
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';   // blocked on a panel
const A2 = 'aaaaaaaa-2222-4222-8222-222222222222';   // same branch as A1
const A3 = 'aaaaaaaa-3333-4333-8333-333333333333';   // unrelated repo
const A4 = 'aaaaaaaa-4444-4444-8444-444444444444';   // A3's branch twin, but stale

// The mtime is the only thing fleet-status reads for idleMinutes, so it is set
// explicitly rather than inferred from when the fixture happened to be written.
function writeTranscript(id, lines, ageMinutes) {
    const p = path.join(PROJ, id + '.jsonl');
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const t = new Date(Date.now() - ageMinutes * 60000);
    fs.utimesSync(p, t, t);
}

function opening(id, cwd, branch) {
    return {
        type: 'user', sessionId: id, cwd, gitBranch: branch,
        timestamp: '2026-08-24T10:00:00.000Z',
        message: { role: 'user', content: 'go' },
    };
}

// lastRole 'assistant' keeps classify() out of its 'stalled' branch, so the
// states these fixtures report are decided here rather than by the clock.
function spoke(id) {
    return {
        type: 'assistant', sessionId: id, timestamp: '2026-08-24T10:05:00.000Z',
        message: { role: 'assistant', content: 'working on it' },
    };
}

function panel(id, toolId) {
    return {
        type: 'assistant', sessionId: id, timestamp: '2026-08-24T10:06:00.000Z',
        message: {
            role: 'assistant',
            content: [{
                type: 'tool_use', name: 'AskUserQuestion', id: toolId,
                input: { questions: [{ question: 'Which path?', header: 'Path', options: [] }] },
            }],
        },
    };
}

function writeRecord(name, rec) {
    fs.writeFileSync(path.join(STORE, name), JSON.stringify(rec));
}

function buildRealHome() {
    plantSubject(REAL_DIR);
    fs.mkdirSync(PROJ, { recursive: true });
    fs.mkdirSync(STORE, { recursive: true });
    fs.mkdirSync(FLEETDIR, { recursive: true });

    // fleet-status.js requires fleet-heartbeat.js off its own __dirname, so the
    // pair travels together or the copy loads a different clone's heartbeat.
    fs.copyFileSync(REAL_STATUS, path.join(REAL_DIR, 'fleet-status.js'));
    fs.copyFileSync(REAL_HEARTBEAT, path.join(REAL_DIR, 'fleet-heartbeat.js'));

    // A1 and A2 share repo AND branch: the hardest evidence, score 105.
    writeTranscript(A1, [opening(A1, 'C:/code/orchard', 'feature/prune'), panel(A1, 'toolu_a1')], 5);
    writeTranscript(A2, [opening(A2, 'C:/code/orchard', 'feature/prune'), spoke(A2)], 10);
    // A3 shares nothing with either.
    writeTranscript(A3, [opening(A3, 'C:/code/quarry', 'main'), spoke(A3)], 30);
    // A4 is A3's repo AND branch twin - and 33h idle, so it must never pair.
    writeTranscript(A4, [opening(A4, 'C:/code/quarry', 'main'), spoke(A4)], 2000);

    const now = Date.now();
    writeRecord('local_orchard.json', {
        sessionId: 'local_orchard', cliSessionId: A1, title: 'Orchard Harvest',
        originCwd: 'C:/code/orchard', lastActivityAt: now,
    });
    // No originCwd: repoOf must fall back to the transcript's own cwd, or the
    // "same repo" half of the strongest pair silently disappears.
    writeRecord('local_ledger.json', {
        sessionId: 'local_ledger', cliSessionId: A2, title: 'Ledger Rewrite',
        lastActivityAt: now,
    });
    writeRecord('local_quarry.json', {
        sessionId: 'local_quarry', cliSessionId: A3, title: 'Quarry Blasting',
        originCwd: 'C:/code/quarry', lastActivityAt: now,
    });
    writeRecord('local_stale.json', {
        sessionId: 'local_stale', cliSessionId: A4, title: 'Stale Watcher',
        originCwd: 'C:/code/quarry', lastActivityAt: now,
    });
}

function buildStubHome() {
    plantSubject(STUB_DIR);
    fs.mkdirSync(STUB_HOME, { recursive: true });
    fs.writeFileSync(path.join(STUB_DIR, 'fleet-status.js'), [
        '#!/usr/bin/env node',
        "'use strict';",
        "const fs = require('fs');",
        // Recorded so the suite can assert WHICH question the detector asked.
        'fs.writeFileSync(process.env.OVERLAP_ARGV_LOG, JSON.stringify(process.argv.slice(2)));',
        "process.stdout.write(fs.readFileSync(process.env.OVERLAP_FIXTURE, 'utf8'));",
        '',
    ].join('\n'));
}

// ---------------------------------------------------------------------------
// Session payloads for the stub half
// ---------------------------------------------------------------------------

let seq = 0;

/** One session in the shape fleet-status.js --json emits. */
function S(o) {
    seq++;
    return {
        sessionId: o.sessionId || ('sess-' + seq),
        addressableId: o.addressableId === undefined ? ('local-' + seq) : o.addressableId,
        title: o.title,
        originCwd: o.cwd === undefined ? null : o.cwd,
        gitBranch: o.branch === undefined ? null : o.branch,
        idleMinutes: o.idle === undefined ? 5 : o.idle,
        isArchived: !!o.archived,
        state: o.state || 'waiting',
    };
}

// The planted positive. Same repo, same branch, titles sharing no distinctive
// token - so it scores exactly 100 + 5 and nothing else, in every fixture it
// appears in. A run where this is missing has a broken probe, not a clean fleet.
function canary() {
    return [
        S({
            sessionId: 'sess-beacon-a', addressableId: 'local_beacon_a',
            title: 'Beacon Lighthouse', cwd: 'C:/code/beacon', branch: 'release/canary',
        }),
        S({
            sessionId: 'sess-beacon-b', addressableId: 'local_beacon_b',
            title: 'Beacon Signalman', cwd: 'C:/code/beacon', branch: 'release/canary',
        }),
    ];
}

// ---------------------------------------------------------------------------
// Subprocess helpers. Nothing here requires the subject in-process.
// ---------------------------------------------------------------------------

function run(subjectDir, home, extra) {
    const r = spawnSync(process.execPath, [path.join(subjectDir, 'fleet-overlap.js')], {
        encoding: 'utf8',
        env: {
            ...process.env,
            USERPROFILE: home,
            HOME: home,
            APPDATA: APPDIR,
            AUTODEV_FLEET_DIR: FLEETDIR,
            ...extra,
        },
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Run the detector's real CLI over an exact payload from the stub. */
function runPayload(payload) {
    fs.writeFileSync(PAYLOAD, JSON.stringify(payload, null, 2));
    return run(STUB_DIR, STUB_HOME, { OVERLAP_FIXTURE: PAYLOAD, OVERLAP_ARGV_LOG: ARGVLOG });
}

/** The common case: a session list inside the envelope fleet-status emits. */
const runStub = (sessions) => runPayload({ sessions });

const num = (out, re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
const pairCount = (out) => num(out, /^(\d+) overlapping pair\(s\) at score >= 20$/m);
const blockedCount = (out) => num(out, /^awaiting input right now: (\d+)$/m);
const scanned = (out) => num(out, /^population: (\d+) scanned,/m);
const liveCount = (out) => num(out, /^population: \d+ scanned, (\d+) live/m);
const clip = (out) => JSON.stringify(out.slice(0, 700));

// ---------------------------------------------------------------------------

try {
    buildRealHome();
    buildStubHome();

    // -----------------------------------------------------------------------
    // END TO END over the REAL fleet-status.js and a real transcript tree.
    //
    // This is the half that can catch a field rename. Every assertion below
    // travels the whole path: transcripts -> fleet-status --json -> the
    // detector's own parse, filter, pairing and report.
    // -----------------------------------------------------------------------
    {
        const r = run(REAL_DIR, REAL_HOME);
        eq('the detector exits 0 over a real transcript tree', r.status, 0);

        check('it prints the population it scanned and what "live" means',
            r.stdout.includes('population: 4 scanned, 3 live (unarchived, active <24h)'),
            clip(r.stdout));

        eq('the same-branch pair is found', pairCount(r.stdout), 1);
        check('...scored 100 for the branch plus 5 for the repo',
            r.stdout.includes('[105] Orchard Harvest'), clip(r.stdout));
        check('...naming the other session',
            r.stdout.includes('\n      Ledger Rewrite\n'), clip(r.stdout));
        // The second reason is the only observable for repoOf's originCwd ->
        // cwd fallback: Ledger Rewrite's desktop record carries no originCwd.
        check('...and both reasons, branch first',
            r.stdout.includes('\n      SAME BRANCH feature/prune | same repo orchard\n'),
            clip(r.stdout));
        check('...with an addressable id for each side',
            r.stdout.includes('local_orchard  /  local_ledger'), clip(r.stdout));
        check('...and the state of each side',
            r.stdout.includes('states: blocked/waiting'), clip(r.stdout));

        check('two sessions in unrelated repos are not reported as overlapping',
            !r.stdout.includes('Quarry Blasting'), clip(r.stdout));
        check('a branch twin idle beyond 24h is not live and so never pairs',
            !r.stdout.includes('Stale Watcher'), clip(r.stdout));

        eq('awaiting input counts the session blocked on a panel',
            blockedCount(r.stdout), 1);
        check('...listing it with its state and idle time',
            r.stdout.includes('  - Orchard Harvest  [blocked, 5m idle]'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // What the detector ASKS fleet-status for. The 2-day window is the scope of
    // the whole report, and it is invisible in the output.
    // -----------------------------------------------------------------------
    {
        const r = runStub(canary());
        eq('the stub run exits 0', r.status, 0);
        eq('it asks fleet-status for two days of json',
            fs.readFileSync(ARGVLOG, 'utf8'), '["--days","2","--json"]');
        eq('a clean run writes nothing to stderr', r.stderr, '');
        eq('the planted pair is found', pairCount(r.stdout), 1);
        check('...at the branch-plus-repo score',
            r.stdout.includes('[105] Beacon Lighthouse'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // The score threshold. Reachable scores near it are 5 (repo only) and 20
    // (one shared title token), so those two are the boundary.
    // -----------------------------------------------------------------------
    {
        const r = runStub([
            S({ title: 'Nimbus Telemetry Backfill', cwd: 'C:/code/nimbus', branch: 'wip/a' }),
            S({ title: 'Cobalt Backfill Runner', cwd: 'C:/code/cobalt', branch: 'wip/b' }),
            S({ title: 'Nimbus Widgets', cwd: 'C:/code/nimbus', branch: 'wip/c' }),
        ]);
        eq('exactly one of three pairs clears the threshold', pairCount(r.stdout), 1);
        check('a single shared token scores exactly 20 and is reported',
            r.stdout.includes('[ 20] Nimbus Telemetry Backfill'), clip(r.stdout));
        check('...on the topic signal alone, with no repo credit',
            r.stdout.includes('\n      topic: backfill\n'), clip(r.stdout));
        check('a shared repo alone scores 5 and is dropped below the threshold',
            !r.stdout.includes('Nimbus Widgets'), clip(r.stdout));
        eq('all three sessions were live, so the drop was a decision not an empty scan',
            liveCount(r.stdout), 3);
    }

    // -----------------------------------------------------------------------
    // Topic score scales with how much is shared - one token is a coincidence,
    // two is a pattern.
    // -----------------------------------------------------------------------
    {
        const r = runStub([
            S({ title: 'Harbor Migration Rollback', cwd: 'C:/code/harbor', branch: 'wip/x' }),
            S({ title: 'Anvil Rollback Migration', cwd: 'C:/code/anvil', branch: 'wip/y' }),
        ]);
        check('two shared tokens score 40, not 20',
            r.stdout.includes('[ 40] Harbor Migration Rollback'), clip(r.stdout));
        check('...and both tokens are named in the reason',
            r.stdout.includes('\n      topic: migration, rollback\n'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // Stopwords. Without them every session overlaps on the words sessions are
    // named after, which is the "fires on everything" degradation.
    // -----------------------------------------------------------------------
    {
        const r = runStub(canary().concat([
            S({ title: 'Fix Session Status Checks', cwd: 'C:/code/pine', branch: 'wip/p' }),
            S({ title: 'Update Session Status Runs', cwd: 'C:/code/oakum', branch: 'wip/q' }),
        ]));
        eq('titles built from filler words alone produce no extra pair',
            pairCount(r.stdout), 1);
        check('...while the planted pair in the same scan still fires',
            r.stdout.includes('[105] Beacon Lighthouse'), clip(r.stdout));
        check('...so the filler pair was rejected, not missed',
            !r.stdout.includes('Fix Session Status Checks'), clip(r.stdout));
        eq('all four sessions were live', liveCount(r.stdout), 4);
    }

    // -----------------------------------------------------------------------
    // Short words are the other half of the same defence. A stopword list can
    // only name filler it has thought of; the length floor catches the rest.
    // -----------------------------------------------------------------------
    {
        const r = runStub(canary().concat([
            S({ title: 'Willow API Gateway', cwd: 'C:/code/willow', branch: 'wip/g' }),
            S({ title: 'Maple API Cache', cwd: 'C:/code/maple', branch: 'wip/h' }),
        ]));
        eq('a shared three-letter word is not a shared topic', pairCount(r.stdout), 1);
        check('...while the planted pair still fires',
            r.stdout.includes('[105] Beacon Lighthouse'), clip(r.stdout));
        check('...so neither short-token session was reported',
            !r.stdout.includes('Willow API Gateway'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // A repo's own name in both titles is not evidence: every session in that
    // repo carries it. The stopword list cannot cover this - the names are
    // derived from the live set, which is also what keeps them out of the file.
    // -----------------------------------------------------------------------
    {
        const r = runStub(canary().concat([
            S({ title: 'Zephyr Alpha', cwd: 'C:/code/zephyr', branch: 'wip/m' }),
            S({ title: 'Zephyr Bravo', cwd: 'C:/code/zephyr', branch: 'wip/n' }),
        ]));
        eq('a repo name shared by two titles does not make them overlap',
            pairCount(r.stdout), 1);
        check('...while the planted pair still fires',
            r.stdout.includes('[105] Beacon Lighthouse'), clip(r.stdout));
        check('...so the same-repo pair was scored at 5 and dropped',
            !r.stdout.includes('Zephyr Alpha'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // Branch equality has two guards, and each is the difference between a real
    // collision and a fleet-wide false positive.
    // -----------------------------------------------------------------------
    {
        const r = runStub(canary().concat([
            S({ title: 'Basalt Kiln', cwd: 'C:/code/basalt', branch: 'HEAD' }),
            S({ title: 'Basalt Vault', cwd: 'C:/code/basalt', branch: 'HEAD' }),
        ]));
        eq('two sessions on detached HEAD are not a branch collision',
            pairCount(r.stdout), 1);
        check('...while the planted pair still fires',
            r.stdout.includes('[105] Beacon Lighthouse'), clip(r.stdout));
        check('...so neither HEAD session was reported',
            !r.stdout.includes('Basalt Kiln'), clip(r.stdout));
    }
    {
        const r = runStub(canary().concat([
            S({ title: 'Cinder Smelter', cwd: 'C:/code/cinder', branch: null }),
            S({ title: 'Cinder Bellows', cwd: 'C:/code/cinder', branch: null }),
        ]));
        eq('two sessions with no branch recorded are not a branch collision',
            pairCount(r.stdout), 1);
        check('...so neither unbranched session was reported',
            !r.stdout.includes('Cinder Smelter'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // Sessions outside any code/ path, the "(none)" repo. Two of them share no
    // repo at all, so the repo signal must stay silent - and the pair order is
    // strongest first, because the reader acts on the top of the list.
    // -----------------------------------------------------------------------
    {
        const r = runStub(canary().concat([
            S({
                sessionId: 'sess-rowan-a', addressableId: null,
                title: 'Rowan Ledger Sweep', cwd: 'C:/work/rowan', branch: 'wip/r1',
            }),
            S({
                sessionId: 'sess-rowan-b', addressableId: null,
                title: 'Ledger Audit', cwd: 'D:/elsewhere/rowan', branch: 'wip/r2',
            }),
        ]));
        eq('both pairs are reported', pairCount(r.stdout), 2);
        check('a pair outside any code/ path scores on topic alone',
            r.stdout.includes('[ 20] Rowan Ledger Sweep'), clip(r.stdout));
        check('..."(none)" is never reported as a shared repo',
            !r.stdout.includes('same repo (none)'), clip(r.stdout));
        // Both sides of both pairs, because the id line is written twice in the
        // source and a suite that only exercised one side left the other free to
        // print "null" at the reader.
        check('an addressable session is reported by the id send_message accepts',
            r.stdout.includes('local_beacon_a  /  local_beacon_b'), clip(r.stdout));
        check('a session with no addressable id falls back to its transcript id',
            r.stdout.includes('sess-rowan-a  /  sess-rowan-b'), clip(r.stdout));
        check('pairs are ordered strongest first',
            r.stdout.indexOf('[105]') >= 0 && r.stdout.indexOf('[105]') < r.stdout.indexOf('[ 20]'),
            `105 at ${r.stdout.indexOf('[105]')}, 20 at ${r.stdout.indexOf('[ 20]')}`);
    }

    // -----------------------------------------------------------------------
    // "Awaiting input right now" is a different question from "who collides",
    // and answering one with the other is how a board loses a blocked session.
    // -----------------------------------------------------------------------
    {
        const r = runStub(canary().concat([
            S({ title: 'Tundra Prompt', cwd: 'C:/code/tundra', branch: 'wip/t', state: 'blocked', idle: 7 }),
            S({ title: 'Vellum Question', cwd: 'C:/code/vellum', branch: 'wip/v', state: 'blocked', idle: 41 }),
            S({ title: 'Ancient Slumber', cwd: 'C:/code/ancient', branch: 'wip/z', state: 'blocked', idle: 2000 }),
        ]));
        eq('blocked sessions do not inflate the pair count', pairCount(r.stdout), 1);
        eq('every live blocked session is counted', blockedCount(r.stdout), 2);
        check('...each listed with its state and idle time',
            r.stdout.includes('  - Tundra Prompt  [blocked, 7m idle]')
            && r.stdout.includes('  - Vellum Question  [blocked, 41m idle]'),
            clip(r.stdout));
        check('a blocked session idle beyond 24h is not awaiting input "right now"',
            !r.stdout.includes('Ancient Slumber'), clip(r.stdout));
        eq('...and it is still counted in the scanned population', scanned(r.stdout), 5);
        eq('...but not in the live one', liveCount(r.stdout), 4);
    }

    // -----------------------------------------------------------------------
    // The live cutoff, at the minute either side of it.
    // -----------------------------------------------------------------------
    {
        const r = runStub(canary().concat([
            S({ title: 'Ember Kiln', cwd: 'C:/code/ember', branch: 'edge/in', idle: 1439 }),
            S({ title: 'Ember Forge', cwd: 'C:/code/ember', branch: 'edge/in', idle: 1439 }),
            S({ title: 'Flint Spark', cwd: 'C:/code/flint', branch: 'edge/out', idle: 1440 }),
            S({ title: 'Flint Shard', cwd: 'C:/code/flint', branch: 'edge/out', idle: 1440 }),
        ]));
        eq('six sessions scanned', scanned(r.stdout), 6);
        eq('...four of them live', liveCount(r.stdout), 4);
        eq('two pairs, not three', pairCount(r.stdout), 2);
        check('a colliding pair one minute inside 24h is reported',
            r.stdout.includes('[105] Ember Kiln'), clip(r.stdout));
        check('...and the identical pair one minute outside it is not',
            !r.stdout.includes('Flint Spark'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // Archived rows. fleet-status hides them by default, so this filter is the
    // detector's own belt-and-braces - and it becomes load-bearing the moment
    // anyone adds --all to the exec call above.
    // -----------------------------------------------------------------------
    {
        const r = runStub(canary().concat([
            S({ title: 'Ghost Beacon', cwd: 'C:/code/beacon', branch: 'release/canary', archived: true }),
        ]));
        eq('an archived row is counted in the scanned population', scanned(r.stdout), 3);
        eq('...but excluded from the live one', liveCount(r.stdout), 2);
        eq('...so it cannot join a branch collision it would otherwise match',
            pairCount(r.stdout), 1);
        check('...and its title never reaches the report',
            !r.stdout.includes('Ghost Beacon'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // Two payload shapes fleet-status has emitted. Each is a separate branch of
    // the same expression, and a dropped one reports an empty fleet rather than
    // an error.
    // -----------------------------------------------------------------------
    {
        const bare = runPayload(canary());
        eq('a bare array of sessions is accepted', liveCount(bare.stdout), 2);
        eq('...and paired', pairCount(bare.stdout), 1);
    }
    {
        const wrapped = runPayload({ sessions: canary() });
        eq('a { sessions } envelope is accepted', liveCount(wrapped.stdout), 2);
        eq('...and paired', pairCount(wrapped.stdout), 1);
    }
    {
        const rows = runPayload({ rows: canary() });
        eq('a { rows } envelope is accepted', liveCount(rows.stdout), 2);
        eq('...and paired', pairCount(rows.stdout), 1);
    }
    {
        const none = runPayload({ population: { dirs: 0 } });
        eq('an envelope with no recognised session key reports an empty fleet, not a crash',
            none.status, 0);
        eq('...scanning nothing', scanned(none.stdout), 0);
        eq('...pairing nothing', pairCount(none.stdout), 0);
        eq('...and awaiting nothing', blockedCount(none.stdout), 0);
    }

} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
