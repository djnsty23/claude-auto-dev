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
    // fleet-status.js resolves the desktop session store through claude-paths.js.
    // A copy without that sibling silently loses the store, so every session comes
    // back "(not addressable)" and the addressability assertions below fail for a
    // reason that has nothing to do with the subject. The shipped plugin always
    // carries the whole scripts directory; the fixture must too.
    fs.copyFileSync(path.join(SCRIPTS, 'claude-paths.js'), path.join(REAL_DIR, 'claude-paths.js'));
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

/**
 * One session in the shape fleet-status.js --json emits.
 *
 * `cwd` and `wt` are DIFFERENT fields and the distinction is load-bearing.
 * fleet-status emits `originCwd` (the clone the session belongs to) and `cwd`
 * (the worktree it is actually sitting in). repoOf reads the former; the file
 * signal must read the LATTER, because every worktree of one clone shares an
 * originCwd and reading that would point 36 sessions at the same directory.
 * So `cwd:` here fills originCwd for the repo/topic tests, and `wt:` fills the
 * real working directory for the file tests.
 */
function S(o) {
    seq++;
    return {
        sessionId: o.sessionId || ('sess-' + seq),
        addressableId: o.addressableId === undefined ? ('local-' + seq) : o.addressableId,
        title: o.title,
        cwd: o.wt === undefined ? null : o.wt,
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

/**
 * Just the pair block. "Not reported as overlapping" is a claim about the PAIRS,
 * and the report also names sessions in its worktree-readability diagnostics and
 * its awaiting-input list. Asserting over the whole of stdout conflates the
 * three, so a session that appears only as COULD-NOT-CHECK would read as a
 * false positive that never happened.
 */
/**
 * The reported pair naming both `x` and `y`, as its three rendered lines, or
 * null if the detector declined to report it. Scans only lines that open a pair
 * (`[ nn] title`), so a session named in a diagnostic block is not mistaken for
 * a reported collision.
 */
const pairIn = (out, x, y) => {
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!/^\[\s*\d+\]/.test(lines[i])) continue;
        const two = lines[i] + '\n' + lines[i + 1];
        if (two.includes(x) && two.includes(y)) {
            return lines[i] + '\n' + lines[i + 1] + '\n' + lines[i + 2];
        }
    }
    return null;
};

const pairsOnly = (out) => {
    const a = out.indexOf('overlapping pair(s) at score >= 20');
    if (a < 0) return out;
    const b = out.indexOf('awaiting input right now:');
    return out.slice(a, b < 0 ? undefined : b);
};

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
            !pairsOnly(r.stdout).includes('Quarry Blasting'), clip(r.stdout));
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
            !pairsOnly(r.stdout).includes('Nimbus Widgets'), clip(r.stdout));
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
            !pairsOnly(r.stdout).includes('Fix Session Status Checks'), clip(r.stdout));
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
            !pairsOnly(r.stdout).includes('Willow API Gateway'), clip(r.stdout));
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
            !pairsOnly(r.stdout).includes('Zephyr Alpha'), clip(r.stdout));
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
            !pairsOnly(r.stdout).includes('Basalt Kiln'), clip(r.stdout));
    }
    {
        const r = runStub(canary().concat([
            S({ title: 'Cinder Smelter', cwd: 'C:/code/cinder', branch: null }),
            S({ title: 'Cinder Bellows', cwd: 'C:/code/cinder', branch: null }),
        ]));
        eq('two sessions with no branch recorded are not a branch collision',
            pairCount(r.stdout), 1);
        check('...so neither unbranched session was reported',
            !pairsOnly(r.stdout).includes('Cinder Smelter'), clip(r.stdout));
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
    // Container validation must precede session filtering. An unknown/malformed
    // envelope is unavailable evidence, including when another key looks valid.
    for (const [label, payload] of [
        ['empty array', []], ['empty sessions', { sessions: [] }],
        ['empty rows', { rows: [] }], ['empty with metadata', { sessions: [], population: { dirs: 0 } }],
    ]) {
        const r = runPayload(payload);
        eq(label + ' is a successful empty scan', r.status, 0);
        eq(label + ' explicitly scans zero rows', scanned(r.stdout), 0);
        eq(label + ' reports zero pairs', pairCount(r.stdout), 0);
    }
    {
        const r = runPayload({ sessions: canary(), population: { dirs: 2 } });
        eq('metadata does not reject a valid envelope', r.status, 0);
        eq('metadata control still detects the planted overlap', pairCount(r.stdout), 1);
    }
    for (const [label, payload] of [
        ['null', null], ['boolean', false], ['number', 0], ['string', 'sessions'],
        ['unknown empty envelope', {}], ['metadata only', { population: { dirs: 0 } }],
        ['unknown populated envelope', { records: canary() }],
        ...[null, 0, false, '', {}].map(value => ['invalid sessions ' + JSON.stringify(value), { sessions: value }]),
        ...[null, 0, false, '', {}].map(value => ['invalid rows ' + JSON.stringify(value), { rows: value }]),
        ['invalid primary with valid fallback', { sessions: 0, rows: canary() }],
        ['empty primary hides populated rows', { sessions: [], rows: canary() }],
        ['populated primary with empty rows', { sessions: canary(), rows: [] }],
        ['two empty session keys', { sessions: [], rows: [] }],
    ]) {
        const r = runPayload(payload);
        eq(label + ' exits with unavailable evidence', r.status, 2);
        check(label + ' names the unsupported envelope', /COULD NOT CHECK overlap.*unsupported session envelope/.test(r.stdout), clip(r.stdout));
        check(label + ' does not print a clearance population', !/^population:/m.test(r.stdout), clip(r.stdout));
        check(label + ' does not print a pair verdict', !/\d+ overlapping pair\(s\)/.test(r.stdout), clip(r.stdout));
    }

    // Validate all consumed row fields before filtering or printing clearance.
    for (const [label, row] of [
        ...[null, 1, true, 'row', [], {}].map(value => ['invalid row ' + JSON.stringify(value), value]),
        ['missing identity', { ...canary()[0], sessionId: undefined }],
        ['empty identity', { ...canary()[0], sessionId: '' }],
        ['missing idle', { ...canary()[0], idleMinutes: undefined }],
        ['string idle', { ...canary()[0], idleMinutes: '0' }],
        ['null idle', { ...canary()[0], idleMinutes: null }],
        ['string archived', { ...canary()[0], isArchived: 'false' }],
        ...[null, {}, 'unknown'].map(value => ['invalid state ' + JSON.stringify(value), { ...canary()[0], state: value }]),
        ...['cwd', 'originCwd', 'gitBranch', 'title', 'addressableId'].map(key => ['invalid ' + key, { ...canary()[0], [key]: {} }]),
    ]) {
        const r = runPayload({ sessions: [...canary(), row] });
        eq(label + ' exits unavailable before any population', r.status, 2);
        check(label + ' names malformed row', /COULD NOT CHECK overlap.*invalid session row 3/.test(r.stdout), clip(r.stdout));
        check(label + ' produces no partial clearance', !/^population:|\d+ overlapping pair\(s\)/m.test(r.stdout), clip(r.stdout));
    }
    {
        const rows = canary().map(({ isArchived, ...r }) => ({ ...r, extraMetadata: { future: true } }));
        const r = runPayload({ sessions: rows });
        eq('missing archive lookup remains a valid visible row', r.status, 0);
        eq('unknown metadata preserves the positive overlap', pairCount(r.stdout), 1);
    }

    // =======================================================================
    // SIGNAL 4: FILES. Real git repositories, because the signal shells out to
    // git and a hand-written file list would test a mock of the thing.
    //
    // THE FIXTURE IS THE INCIDENT. The six pairs below are the six real
    // collisions of 2026-09-07/08, reproduced with their measured paths: every
    // one was invisible to the title-and-repo detector, and every one was found
    // hours later at PR-or-report time. Five of the six scored NOTHING before
    // this signal existed (measured: they scored 5, for the shared repo, against
    // a threshold of 20). If a future change makes any of them stop scoring,
    // that change has re-opened the incident, and this is where it says so.
    //
    // Both controls are here in the same scan, because a detector is only as
    // good as the pairs it declines:
    //   MUST FIRE      two sessions that genuinely edited one path
    //   MUST NOT FIRE  two sessions sharing only RESUME.md, the shared journal
    // =======================================================================

    const GITROOT = path.join(fixture, 'git');

    function git(cwd, args) {
        const r = spawnSync('git', [
            '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
            '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args,
        ], { cwd, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
        return (r.stdout || '').trim();
    }

    /** A bare origin with one commit on main, so every clone gets origin/main. */
    function makeOrigin(name, seedFiles) {
        const bare = path.join(GITROOT, name + '.git');
        const seed = path.join(GITROOT, name + '-seed');
        fs.mkdirSync(seed, { recursive: true });
        git(seed, ['init', '-q']);
        for (const f of seedFiles) {
            fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true });
            fs.writeFileSync(path.join(seed, f), 'seed\n');
        }
        git(seed, ['add', '-A']);
        git(seed, ['commit', '-q', '-m', 'seed']);
        git(GITROOT, ['clone', '-q', '--bare', seed, bare]);
        return bare;
    }

    function makeClone(bare, name) {
        const dir = path.join(GITROOT, name);
        git(GITROOT, ['clone', '-q', bare, dir]);
        return dir;
    }

    /** Edit + commit: the COMMITTED half of the union (merge-base..HEAD). */
    function committed(dir, files) {
        for (const f of files) {
            fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
            fs.appendFileSync(path.join(dir, f), 'committed change in ' + name(dir) + '\n');
        }
        git(dir, ['add', '-A']);
        git(dir, ['commit', '-q', '-m', 'work']);
    }
    /** Edit and leave dirty: the UNCOMMITTED half. */
    function dirty(dir, files) {
        for (const f of files) fs.appendFileSync(path.join(dir, f), 'dirty\n');
    }
    /** A new file never added: the UNTRACKED half. */
    function untracked(dir, files) {
        for (const f of files) {
            fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
            fs.writeFileSync(path.join(dir, f), 'new\n');
        }
    }
    const name = (dir) => path.basename(dir);

    fs.mkdirSync(GITROOT, { recursive: true });

    // -----------------------------------------------------------------------
    // THE SIX. Two repos, nine sessions, reproducing the measured collisions.
    // -----------------------------------------------------------------------
    {
        const PLUGIN_SEED = [
            'CLAUDE.md', 'tooling/validate.js', 'tooling/test-pre-tool-filter.js',
            'plugins/autodev-core/scripts/rendered-layout-gate.js',
            'tooling/test-rendered-layout-gate.js', '.github/workflows/ci.yml',
            'tooling/find-untested-hooks.js', 'tooling/spawn-budget.js',
            'tooling/test-quota-tripwire.js', 'RESUME.md',
        ];
        const APP_SEED = [
            'scripts/seo-snapshot.mjs', 'tests/seo.test.ts', 'package.json', 'RESUME.md',
        ];
        const pluginOrigin = makeOrigin('plugintree', PLUGIN_SEED);
        const appOrigin = makeOrigin('apptree', APP_SEED);

        // --- collisions 2, 3 and 5, all in the plugin repo.
        const wEcc = makeClone(pluginOrigin, 'ecc-harness');
        committed(wEcc, ['plugins/autodev-core/scripts/rendered-layout-gate.js', 'tooling/validate.js']);

        const wPipe = makeClone(pluginOrigin, 'pipe-defect');
        committed(wPipe, ['plugins/autodev-core/scripts/rendered-layout-gate.js', 'tooling/validate.js']);
        dirty(wPipe, ['.github/workflows/ci.yml']);

        const wValidate = makeClone(pluginOrigin, 'validate-falsefail');
        dirty(wValidate, ['tooling/validate.js']);

        const wAgents = makeClone(pluginOrigin, 'agents-md');
        committed(wAgents, ['.github/workflows/ci.yml']);

        // --- collision 6: the full duplicate, seven shared paths.
        const SUITES = [
            'CLAUDE.md', 'tooling/find-untested-hooks.js', 'tooling/spawn-budget.js',
            'tooling/test-quota-tripwire.js',
        ];
        const wFlakyA = makeClone(pluginOrigin, 'flaky-a');
        committed(wFlakyA, SUITES);
        const wFlakyB = makeClone(pluginOrigin, 'flaky-b');
        committed(wFlakyB, SUITES);

        // --- collisions 1 and 4, in the app repo.
        const wA11y = makeClone(appOrigin, 'a11y-audit');
        committed(wA11y, ['scripts/seo-snapshot.mjs', 'tests/seo.test.ts', 'package.json']);

        const wCheckout = makeClone(appOrigin, 'checkout-deadend');
        committed(wCheckout, ['scripts/seo-snapshot.mjs', 'package.json']);
        untracked(wCheckout, ['tests/seo.test.ts.new']);
        dirty(wCheckout, ['tests/seo.test.ts']);

        const wResume = makeClone(appOrigin, 'resume-reconcile');
        dirty(wResume, ['tests/seo.test.ts']);

        // --- BOTH CONTROLS, in the same scan as the six.
        // Fires: two clones that genuinely edited one path.
        const wCtlHitA = makeClone(pluginOrigin, 'control-hit-a');
        dirty(wCtlHitA, ['tooling/test-pre-tool-filter.js']);
        const wCtlHitB = makeClone(pluginOrigin, 'control-hit-b');
        dirty(wCtlHitB, ['tooling/test-pre-tool-filter.js']);
        // Must NOT fire: two clones sharing only the journal every session appends to.
        const wCtlLedgerA = makeClone(pluginOrigin, 'control-ledger-a');
        dirty(wCtlLedgerA, ['RESUME.md']);
        const wCtlLedgerB = makeClone(pluginOrigin, 'control-ledger-b');
        dirty(wCtlLedgerB, ['RESUME.md']);

        const sess = (title, wt, branch) =>
            S({ title, wt, branch: branch || 'wt/' + path.basename(wt) });
        // originCwd is what repoOf reads, and these tmpdirs carry no code/ segment,
        // so every score below is the FILE signal alone with no repo credit. That
        // is deliberate: it makes the arithmetic readable.
        const r = runStub([
            sess('Cedar harness evaluation', wEcc),
            sess('Dune trunk pipeline defect', wPipe),
            sess('Falcon verdict rescan', wValidate),
            sess('Gorse generated agent manifest', wAgents),
            sess('Hazel repair probes', wFlakyA),
            sess('Iris poisoned runner', wFlakyB),
            sess('Amber route audit', wA11y),
            sess('Basalt checkout money path', wCheckout),
            sess('Juniper reconcile claims', wResume),
            sess('Kelp strike alpha', wCtlHitA),
            sess('Lupin impact bravo', wCtlHitB),
            sess('Myrtle journal keeper', wCtlLedgerA),
            sess('Nettle notebook writer', wCtlLedgerB),
        ]);

        eq('the file-signal scan exits 0', r.status, 0);
        eq('every fixture worktree was read', 13, Number(
            (r.stdout.match(/^worktrees: (\d+) read/m) || [])[1]));
        check('...and none was unreadable',
            r.stdout.includes('worktrees: 13 read, 0 partially read, 0 COULD NOT CHECK'),
            clip(r.stdout));

        // --- The six, each asserted on the PATH it must name, not just a score.
        const pairText = (x, y) => pairIn(r.stdout, x, y);
        const fires = (label, x, y, path_, score) => {
            const t = pairText(x, y);
            check(label, !!t && t.includes(path_) && t.includes('[' + String(score).padStart(3) + ']'),
                t ? JSON.stringify(t) : 'pair not reported at all');
        };

        fires('collision 1: two sessions rewriting the same snapshot script',
            'Amber route audit', 'Basalt checkout', 'scripts/seo-snapshot.mjs', 80);
        fires('collision 2: two sessions rewriting the same rendered-layout gate',
            'Cedar harness', 'Dune trunk',
            'plugins/autodev-core/scripts/rendered-layout-gate.js', 60);
        fires('collision 3: two sessions rewriting the same validate script',
            'Falcon verdict', 'Cedar harness', 'tooling/validate.js', 40);
        fires('collision 4: two sessions fixing the same test file',
            'Amber route audit', 'Juniper reconcile', 'tests/seo.test.ts', 40);
        fires('collision 5: two sessions editing the same CI workflow',
            'Dune trunk', 'Gorse generated', '.github/workflows/ci.yml', 40);
        fires('collision 6: the full duplicate, four shared paths, capped at 100',
            'Hazel repair', 'Iris poisoned', 'tooling/spawn-budget.js', 100);

        // --- The controls.
        fires('CONTROL, must fire: a pair that genuinely shares one file',
            'Kelp strike', 'Lupin impact', 'tooling/test-pre-tool-filter.js', 40);
        check('CONTROL, must NOT fire: a pair sharing only the RESUME journal',
            !pairText('Myrtle journal', 'Nettle notebook'),
            JSON.stringify(pairText('Myrtle journal', 'Nettle notebook')));
        check('...and the run says so, naming RESUME.md as suppressed',
            r.stdout.includes('suppressed this run:') && r.stdout.includes('RESUME.md (2 worktree(s))'),
            clip(r.stdout));
        check('...so the ledger pair was EXCLUDED, not simply never seen',
            r.stdout.includes('file-signal exclusions (paths that collide by construction):'),
            clip(r.stdout));

        // Cross-repo isolation is NOT asserted here. It used to be, and the
        // assertion was vacuous: these two repos share no path that any session
        // touches, so declining to pair them cost the guard nothing. The real
        // control is its own scenario below, where two repos touch a path with
        // the same name on purpose.
    }

    // -----------------------------------------------------------------------
    // Each of the three sources of "touched" contributes on its own. A dropped
    // one is invisible: the detector keeps working, just blind to a third of
    // the evidence.
    // -----------------------------------------------------------------------
    {
        const bare = makeOrigin('sources', ['src/alpha.js', 'src/beta.js', 'src/gamma.js']);
        const mk = (n, fn) => { const d = makeClone(bare, n); fn(d); return d; };

        const c1 = mk('src-committed-1', (d) => committed(d, ['src/alpha.js']));
        const c2 = mk('src-committed-2', (d) => committed(d, ['src/alpha.js']));
        const d1 = mk('src-dirty-1', (d) => dirty(d, ['src/beta.js']));
        const d2 = mk('src-dirty-2', (d) => dirty(d, ['src/beta.js']));
        const u1 = mk('src-untracked-1', (d) => untracked(d, ['src/delta.js']));
        const u2 = mk('src-untracked-2', (d) => untracked(d, ['src/delta.js']));
        // Staged but never committed. `git diff --name-only` alone cannot see this;
        // only `diff --name-only HEAD` can, and a session that has staged its edit
        // is exactly as much of a collision as one that has not.
        const s1 = mk('src-staged-1', (d) => { dirty(d, ['src/gamma.js']); git(d, ['add', 'src/gamma.js']); });
        const s2 = mk('src-staged-2', (d) => { dirty(d, ['src/gamma.js']); git(d, ['add', 'src/gamma.js']); });

        const r = runStub([
            S({ title: 'Oakwood', wt: c1, branch: 'w/c1' }),
            S({ title: 'Pinewood', wt: c2, branch: 'w/c2' }),
            S({ title: 'Rowanberry', wt: d1, branch: 'w/d1' }),
            S({ title: 'Sablewood', wt: d2, branch: 'w/d2' }),
            S({ title: 'Thistledown', wt: u1, branch: 'w/u1' }),
            S({ title: 'Umberstone', wt: u2, branch: 'w/u2' }),
            S({ title: 'Violetgrass', wt: s1, branch: 'w/s1' }),
            S({ title: 'Walnutshell', wt: s2, branch: 'w/s2' }),
        ]);
        check('a COMMITTED edit to a shared path is evidence',
            r.stdout.includes('SAME FILES (1): src/alpha.js'), clip(r.stdout));
        check('an UNCOMMITTED edit to a shared path is evidence',
            r.stdout.includes('SAME FILES (1): src/beta.js'), clip(r.stdout));
        check('an UNTRACKED new file at a shared path is evidence',
            r.stdout.includes('SAME FILES (1): src/delta.js'), clip(r.stdout));
        check('a STAGED but uncommitted edit is evidence',
            r.stdout.includes('SAME FILES (1): src/gamma.js'), clip(r.stdout));
        eq('...and each pairs only with its own twin', pairCount(r.stdout), 4);
    }

    // -----------------------------------------------------------------------
    // Score arithmetic and the threshold. One shared file must clear 20 ALONE:
    // with dozens of worktrees in one repo the shared-repo prior beneath it has
    // stopped carrying information, so the file has to stand up by itself.
    // -----------------------------------------------------------------------
    {
        const bare = makeOrigin('arith', ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
        const mk = (n, files) => { const d = makeClone(bare, n); dirty(d, files); return d; };
        const one = ['f1'], four = ['f1', 'f2', 'f3', 'f4'], six = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
        const r = runStub([
            S({ title: 'Xenonlight', wt: mk('ar-1a', one), branch: 'w/1a' }),
            S({ title: 'Yarrowfield', wt: mk('ar-1b', one), branch: 'w/1b' }),
        ]);
        check('one shared file scores 40 and so clears the threshold alone',
            r.stdout.includes('[ 40] Xenonlight'), clip(r.stdout));
        eq('...and is reported', pairCount(r.stdout), 1);

        const r4 = runStub([
            S({ title: 'Zirconpeak', wt: mk('ar-4a', four), branch: 'w/4a' }),
            S({ title: 'Auburnvale', wt: mk('ar-4b', four), branch: 'w/4b' }),
        ]);
        check('four shared files reach the cap of 100, not 100+',
            r4.stdout.includes('[100] Zirconpeak'), clip(r4.stdout));

        const r6 = runStub([
            S({ title: 'Berylhollow', wt: mk('ar-6a', six), branch: 'w/6a' }),
            S({ title: 'Cobaltridge', wt: mk('ar-6b', six), branch: 'w/6b' }),
        ]);
        check('six shared files stay capped at 100 so files never outrank a branch',
            r6.stdout.includes('[100] Berylhollow'), clip(r6.stdout));
        check('...naming the first six paths and counting the rest',
            r6.stdout.includes('SAME FILES (6): f1, f2, f3, f4, f5, f6'), clip(r6.stdout));
    }

    // -----------------------------------------------------------------------
    // A worktree that cannot be read is COULD-NOT-CHECK, never a zero. With
    // dozens of worktrees some are always mid-rebase, detached, or pruned out
    // from under the session record that still names them.
    // -----------------------------------------------------------------------
    {
        const bare = makeOrigin('unreadable', ['only.js']);
        const good = makeClone(bare, 'readable-one');
        dirty(good, ['only.js']);
        const goodToo = makeClone(bare, 'readable-two');
        dirty(goodToo, ['only.js']);
        const notGit = path.join(GITROOT, 'plain-directory');
        fs.mkdirSync(notGit, { recursive: true });

        const r = runStub([
            S({ title: 'Dahliabank', wt: good, branch: 'w/g1' }),
            S({ title: 'Eldermarsh', wt: goodToo, branch: 'w/g2' }),
            S({ title: 'Fennelgone', wt: path.join(GITROOT, 'never-existed'), branch: 'w/x' }),
            S({ title: 'Ginkgoplain', wt: notGit, branch: 'w/y' }),
            S({ title: 'Hollyabsent', wt: null, branch: 'w/z' }),
        ]);
        check('unreadable worktrees are counted apart from read ones',
            r.stdout.includes('worktrees: 2 read, 0 partially read, 3 COULD NOT CHECK'),
            clip(r.stdout));
        check('...each named with why it could not be read',
            r.stdout.includes('COULD NOT CHECK: Fennelgone - worktree path no longer exists')
            && r.stdout.includes('COULD NOT CHECK: Ginkgoplain - not a readable git worktree')
            && r.stdout.includes('COULD NOT CHECK: Hollyabsent - no cwd recorded for this session'),
            clip(r.stdout));
        check('...and the report refuses to let that read as "no overlap"',
            r.stdout.includes('contributed NO file evidence. That is not a finding of "no overlap".'),
            clip(r.stdout));
        eq('...while the readable pair still fires in the same scan',
            pairCount(r.stdout), 1);
    }

    // -----------------------------------------------------------------------
    // The exclusion list is printed on EVERY run, including the run where it
    // suppressed nothing. A reader has to be able to tell "nothing was
    // excluded" from "the exclusion step did not happen".
    // -----------------------------------------------------------------------
    {
        const bare = makeOrigin('noledger', ['work.js']);
        const a = makeClone(bare, 'noledger-a'); dirty(a, ['work.js']);
        const b = makeClone(bare, 'noledger-b'); dirty(b, ['work.js']);
        const r = runStub([
            S({ title: 'Indigoreach', wt: a, branch: 'w/n1' }),
            S({ title: 'Jasminecove', wt: b, branch: 'w/n2' }),
        ]);
        check('the exclusion rules are printed even when nothing matched them',
            r.stdout.includes('file-signal exclusions (paths that collide by construction): '
                + 'RESUME.md, DECISIONS.md and DECISIONS-*.md, PUBLISH-QUEUE.md, prd.json, '
                + 'lockfiles, .claude/reports/*'), clip(r.stdout));
        check('...and an empty suppression is stated rather than left blank',
            r.stdout.includes('suppressed this run: none'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // Each ledger pattern, one at a time. A list this size rots by having one
    // entry silently stop matching, which nothing else here would catch.
    // -----------------------------------------------------------------------
    {
        const LEDGERS = [
            ['RESUME.md', 'RESUME.md'],
            ['DECISIONS.md', 'DECISIONS.md'],
            ['a dated decisions file', 'DECISIONS-2026-09-08.md'],
            ['a decisions file in a subdirectory', 'docs/DECISIONS-2026-09-08-topic.md'],
            ['a lowercase decisions file', 'docs/decisions.md'],
            ['PUBLISH-QUEUE.md', 'PUBLISH-QUEUE.md'],
            ['the sprint state file', 'prd.json'],
            ['an npm lockfile', 'package-lock.json'],
            ['a yarn lockfile', 'yarn.lock'],
            ['a report ledger', '.claude/reports/telemetry-2026-09-08.jsonl'],
        ];
        let i = 0;
        for (const [label, file] of LEDGERS) {
            i++;
            const bare = makeOrigin('ledger' + i, ['real.js']);
            const a = makeClone(bare, 'led-a-' + i);
            const b = makeClone(bare, 'led-b-' + i);
            untracked(a, [file]);
            untracked(b, [file]);
            const r = runStub([
                S({ title: 'Kestrelmoor', wt: a, branch: 'w/j' + i + 'a' }),
                S({ title: 'Linnetbrook', wt: b, branch: 'w/j' + i + 'b' }),
            ]);
            eq(`${label} alone is not a collision`, pairCount(r.stdout), 0);
            check(`...and ${file} is reported as suppressed, not silently dropped`,
                r.stdout.includes(file + ' (2 worktree(s))'), clip(r.stdout));
        }
    }

    // -----------------------------------------------------------------------
    // CLAUDE.md is deliberately NOT a ledger. It was sixth by volume in the
    // measurement that built the list, and excluding it on volume alone would
    // have blinded the detector to a file this repo genuinely conflicts over.
    // Being append-only is what makes a ledger, not being popular.
    // -----------------------------------------------------------------------
    {
        const bare = makeOrigin('claudemd', ['CLAUDE.md']);
        const a = makeClone(bare, 'cmd-a'); dirty(a, ['CLAUDE.md']);
        const b = makeClone(bare, 'cmd-b'); dirty(b, ['CLAUDE.md']);
        const r = runStub([
            S({ title: 'Mallowcrest', wt: a, branch: 'w/cm1' }),
            S({ title: 'Nutmegholt', wt: b, branch: 'w/cm2' }),
        ]);
        eq('two sessions editing the guidance file DO collide', pairCount(r.stdout), 1);
        check('...named as the shared file',
            r.stdout.includes('SAME FILES (1): CLAUDE.md'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // The title signal SURVIVES. It catches a class the file signal physically
    // cannot see - two sessions about to work the same thing that have not
    // edited anything yet - and replacing rather than adding would have traded
    // one blind spot for another.
    // -----------------------------------------------------------------------
    {
        const bare = makeOrigin('untouched', ['nothing.js']);
        const a = makeClone(bare, 'untouched-a');   // deliberately no edits
        const b = makeClone(bare, 'untouched-b');
        const r = runStub([
            S({ title: 'Telemetry backfill rewrite', wt: a, branch: 'w/t1' }),
            S({ title: 'Backfill the telemetry rows', wt: b, branch: 'w/t2' }),
        ]);
        eq('two sessions that have edited NOTHING still pair on their titles',
            pairCount(r.stdout), 1);
        check('...on the topic signal, with no file evidence to offer',
            r.stdout.includes('topic: ') && !r.stdout.includes('SAME FILES'), clip(r.stdout));
        check('...and both worktrees were genuinely read, so this is a real zero',
            r.stdout.includes('worktrees: 2 read, 0 partially read, 0 COULD NOT CHECK'),
            clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // TWO DIFFERENT REPOS, THE SAME RELATIVE PATH. src/shared-name.js in repo
    // one and src/shared-name.js in repo two are two different files, and
    // pairing them would fire on every project that has a src/index.js.
    //
    // This scenario exists because the assertion that used to stand here was
    // VACUOUS and a mutation proved it. Dropping the repo-equality check
    // entirely left the whole suite green: the two fixture repos happened to
    // share only paths nobody touched, or paths the ledger list excluded, so
    // there was never a cross-repo collision available to be wrongly reported.
    // An assertion that only ever declines to see something that could not have
    // happened is not testing the guard, and this one was measured surviving.
    //
    // So the two repos below touch a path with the SAME NAME, deliberately, and
    // a same-repo pair touching that SAME path rides along in the scan as the
    // planted positive - the zero below means "declined", not "saw nothing".
    // -----------------------------------------------------------------------
    {
        const SHARED = 'src/shared-name.js';
        const oneBare = makeOrigin('xrepo-one', [SHARED]);
        const twoBare = makeOrigin('xrepo-two', [SHARED]);

        const x1 = makeClone(oneBare, 'xrepo-one-a'); dirty(x1, [SHARED]);
        const x2 = makeClone(twoBare, 'xrepo-two-a'); dirty(x2, [SHARED]);
        // The planted positive: same repo, same path, must fire in this very scan.
        const x3 = makeClone(oneBare, 'xrepo-one-b'); dirty(x3, [SHARED]);

        const r = runStub([
            S({ title: 'Opaline', wt: x1, branch: 'w/x1' }),
            S({ title: 'Peridot', wt: x2, branch: 'w/x2' }),
            S({ title: 'Quartzvein', wt: x3, branch: 'w/x3' }),
        ]);
        eq('all three worktrees were read', 3, Number(
            (r.stdout.match(/^worktrees: (\d+) read/m) || [])[1]));
        check('the SAME path in the SAME repo fires',
            r.stdout.includes('[ 40] Opaline') && r.stdout.includes('SAME FILES (1): ' + SHARED),
            clip(r.stdout));
        eq('...and it is the ONLY pair: the same path in a DIFFERENT repo does not',
            pairCount(r.stdout), 1);
        check('...so neither cross-repo pair was reported',
            !pairsOnly(r.stdout).includes('Peridot'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // A REVIEWER IS NOT A COLLIDER. This is the false positive that reached the
    // top of the live report on 2026-09-08, and it is a systematic class rather
    // than one bad row.
    //
    // A session assigned to review a PR checks that PR's branch out. Both
    // worktrees then sit at the same tip with the SAME file list and no local
    // edits, which under a flat committed-file diff is indistinguishable from
    // two authors converging - except that it scores higher, because the file
    // sets match exactly. Nine review assignments went out the same night. A
    // detector whose loudest rows are all correct behaviour is one that gets
    // ignored, and this fleet has already muted a detector once.
    //
    // The rule: a file is this session's OWN only if a commit absent from the
    // other's history touched it. All four shapes below are exercised, because
    // the cheap discriminators each get one of them wrong.
    // -----------------------------------------------------------------------
    {
        const bare = makeOrigin('review', ['src/feature.js', 'src/other.js']);

        // 1. The author, with a real commit of their own.
        const author = makeClone(bare, 'rv-author');
        committed(author, ['src/feature.js']);
        const tip = git(author, ['rev-parse', 'HEAD']);
        git(author, ['push', '-q', 'origin', 'HEAD:refs/heads/feature']);

        // 2. The reviewer: the SAME commit, checked out detached. No work of
        //    their own anywhere.
        const reviewer = makeClone(bare, 'rv-reviewer');
        git(reviewer, ['fetch', '-q', 'origin', 'feature']);
        git(reviewer, ['checkout', '-q', '--detach', tip]);

        // 3. An ANCESTOR reviewer: sitting on an earlier commit of that branch.
        //    Same shape, and the equal-tips test cannot see it.
        const older = makeClone(bare, 'rv-older');
        git(older, ['fetch', '-q', 'origin', 'feature']);
        git(older, ['checkout', '-q', '--detach', tip + '~1']);

        // 4. A second author with an INDEPENDENT commit to the same path. Must
        //    still fire - this is the case the whole signal exists for, and it
        //    rides along so the zeros above mean "declined", not "saw nothing".
        const rival = makeClone(bare, 'rv-rival');
        committed(rival, ['src/feature.js']);

        const r = runStub([
            S({ title: 'Opalstone', wt: author, branch: 'w/rv1' }),
            S({ title: 'Peridotleaf', wt: reviewer, branch: 'w/rv2' }),
            S({ title: 'Quicksilver', wt: older, branch: 'w/rv3' }),
            S({ title: 'Rosewater', wt: rival, branch: 'w/rv4' }),
        ]);
        check('a reviewer holding the author\'s own commit is not a collision',
            !pairIn(r.stdout, 'Opalstone', 'Peridotleaf'),
            JSON.stringify(pairIn(r.stdout, 'Opalstone', 'Peridotleaf')));
        check('...nor is a reviewer sitting on an ANCESTOR of it',
            !pairIn(r.stdout, 'Opalstone', 'Quicksilver'),
            JSON.stringify(pairIn(r.stdout, 'Opalstone', 'Quicksilver')));
        check('...and the suppression is COUNTED, not silent',
            /shared-history pairs not reported: [1-9]/.test(r.stdout), clip(r.stdout));
        check('CONTROL: an independent commit to the same path still fires',
            !!pairIn(r.stdout, 'Opalstone', 'Rosewater')
            && pairIn(r.stdout, 'Opalstone', 'Rosewater').includes('src/feature.js'),
            clip(r.stdout));
        check('...and all four worktrees were read, so these zeros are decisions',
            r.stdout.includes('worktrees: 4 read, 0 partially read, 0 COULD NOT CHECK'),
            clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // The edge that rules out the cheaper fix. Two sessions at the SAME TIP,
    // both with the same file dirty, ARE colliding: uncommitted work is exactly
    // what this signal exists to catch, and no commit history can account for
    // it. Suppressing on equal tips - the obvious one-line version of the fix
    // above - would go blind here.
    // -----------------------------------------------------------------------
    {
        const bare = makeOrigin('sametip', ['src/contested.js']);
        const a = makeClone(bare, 'st-a'); dirty(a, ['src/contested.js']);
        const b = makeClone(bare, 'st-b'); dirty(b, ['src/contested.js']);
        const r = runStub([
            S({ title: 'Sandalwood', wt: a, branch: 'w/st1' }),
            S({ title: 'Tourmaline', wt: b, branch: 'w/st2' }),
        ]);
        eq('two worktrees at one tip, both with the file dirty, DO collide',
            pairCount(r.stdout), 1);
        check('...named as the contested path',
            r.stdout.includes('SAME FILES (1): src/contested.js'), clip(r.stdout));
        check('...and nothing was written off as shared history',
            r.stdout.includes('shared-history pairs not reported: 0'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // The partial case, which is the one that carries the real diagnostic gain.
    // Two sessions sharing SOME history and diverging on one file must report
    // that ONE file, not everything both branches touch. Measured on the live
    // fleet: a pair scoring 7 shared paths was really two shared commits plus a
    // single genuine conflict, and naming the seven buried the one.
    // -----------------------------------------------------------------------
    {
        const bare = makeOrigin('partial', ['a.js', 'b.js', 'contested.js']);
        const one = makeClone(bare, 'pt-one');
        committed(one, ['a.js', 'b.js']);           // common work...
        git(one, ['push', '-q', 'origin', 'HEAD:refs/heads/shared']);
        const shared = git(one, ['rev-parse', 'HEAD']);
        committed(one, ['contested.js']);           // ...then its own

        const two = makeClone(bare, 'pt-two');
        git(two, ['fetch', '-q', 'origin', 'shared']);
        git(two, ['checkout', '-q', '--detach', shared]);
        committed(two, ['contested.js']);           // its own, independently

        const r = runStub([
            S({ title: 'Umbercliff', wt: one, branch: 'w/pt1' }),
            S({ title: 'Vermillion', wt: two, branch: 'w/pt2' }),
        ]);
        eq('the pair is still reported', pairCount(r.stdout), 1);
        check('ONLY the independently-touched file is named, not the shared history',
            r.stdout.includes('SAME FILES (1): contested.js'), clip(r.stdout));
        check('...so a.js and b.js, touched by the commit BOTH hold, are absent',
            !r.stdout.includes('a.js, b.js'), clip(r.stdout));
    }

} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
