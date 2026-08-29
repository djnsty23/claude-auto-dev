#!/usr/bin/env node
// Tests for autodev-memory's SessionEnd hook: hooks/memory-session-end.js.
//
// 68 lines, wired at SessionEnd, and it had no tests. Found by
// tooling/find-untested-hooks.js.
//
// The header records why it is on SessionEnd and not Stop: on Stop it closed the
// memory session after turn one and deleted the carrier, so every later turn's
// observations were silently dropped. That failure was invisible — nothing broke,
// memory just stopped recording. The tests below pin the properties that would
// have caught it: the carrier is cleared for THIS session only, and only when
// there is something to close.
//
// Run: node tooling/test-memory-session-end.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_SRC = path.resolve(__dirname, '..', 'plugins', 'autodev-memory');
const HOOK = path.join(PLUGIN_SRC, 'hooks', 'memory-session-end.js');
const carrier = require(path.join(PLUGIN_SRC, 'scripts', 'session-carrier.js'));

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msend-test-')));
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msend-home-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let n = 0;
function project(files = {}) {
    const dir = path.join(TMP, 'p' + ++n);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
}

function run(dir, sessionId) {
    return spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ cwd: dir, session_id: sessionId, hook_event_name: 'SessionEnd' }),
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_SRC, HOME, USERPROFILE: HOME },
    });
}

// --------------------------------------------------------- teardown must be safe

// SessionEnd runs while Claude is shutting down. Nothing here may fail loudly.
{
    const dir = project();
    const r = run(dir, 'no-carrier-here');
    check('no carrier: exits 0', r.status === 0);
    check('  and emits no decision payload', (r.stdout || '') === '');
    check('  and reports no error', !/session close error/.test(r.stderr || ''));
}

// Malformed stdin must not break teardown either.
{
    const dir = project();
    const r = spawnSync(process.execPath, [HOOK], {
        input: 'not json', encoding: 'utf8', cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_SRC, HOME, USERPROFILE: HOME },
    });
    check('malformed stdin: exits 0', r.status === 0);
    check('  and stays silent', (r.stdout || '') === '');
}

// A prd.json that does not parse must not stop the session being closed. The
// summary is context, not the point.
{
    const dir = project({ 'prd.json': '{ broken' });
    carrier.write(dir, 'sess-broken-prd', 'ses_bp');
    const r = run(dir, 'sess-broken-prd');
    check('unparseable prd.json: still exits 0', r.status === 0);
    check('  and the carrier is still cleared', carrier.read(dir, 'sess-broken-prd') === null);
}

// ------------------------------------------------------ the concurrency property

// The regression this hook's placement exists to prevent, asserted directly:
// ending ONE session must not disturb another live session on the same project.
// On Stop this ran every turn and cleared the carrier, silently dropping every
// later observation.
{
    const dir = project({ 'prd.json': JSON.stringify({ stories: { 'S1-001': { title: 'a', passes: true } } }) });
    carrier.write(dir, 'sess-A', 'ses_a');
    carrier.write(dir, 'sess-B', 'ses_b');
    carrier.writePrompt(dir, 'sess-B', 'B is still working');

    const r = run(dir, 'sess-A');

    check('ending a session exits 0', r.status === 0);
    check("clears only the ending session's carrier", carrier.read(dir, 'sess-A') === null);
    check("  and leaves the other session's carrier intact", carrier.read(dir, 'sess-B') === 'ses_b');
    check("  and leaves the other session's prompt intact",
        carrier.readPrompt(dir, 'sess-B') === 'B is still working');
}

// The prompt carrier holds verbatim user text and must not outlive its session.
{
    const dir = project();
    carrier.write(dir, 'sess-P', 'ses_p');
    carrier.writePrompt(dir, 'sess-P', 'something the user typed');
    run(dir, 'sess-P');
    check('the ending session\'s stored prompt is cleared',
        carrier.readPrompt(dir, 'sess-P') === '');
}

// ------------------------------------------------------- the summary it writes
//
// Everything above asserts the carrier side, which lives OUTSIDE the
// `if (sessionId && memDB.isAvailable())` block — so the entire summary builder
// was untested and its mutants all survived, including `passes === true` flipped
// to `!==`, which would record the pending stories as the completed ones.
//
// The summary is what a later session reads to find out what happened. Asserting
// the hook exits 0 says nothing about whether it wrote the truth.
{
    // memory-db reads HOME at module load, so it is loaded with HOME pointed at
    // the fixture and then dropped from the cache again.
    const withHome = (fn) => {
        const prev = process.env.HOME, prevU = process.env.USERPROFILE;
        process.env.HOME = HOME; process.env.USERPROFILE = HOME;
        try { return fn(); } finally { process.env.HOME = prev; process.env.USERPROFILE = prevU; }
    };
    const loadDb = () => {
        const p = require.resolve(path.join(PLUGIN_SRC, 'scripts', 'memory-db.js'));
        delete require.cache[p];
        return require(p);
    };

    const available = withHome(() => loadDb().isAvailable());

    if (!available) {
        console.log('[skip] node:sqlite unavailable — skipping summary assertions');
    } else {
        const readSession = (id) => withHome(() => {
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(path.join(HOME, '.claude', 'auto-dev-memory.db'));
            const row = db.prepare('SELECT completed, next_steps, end_time FROM sessions WHERE id = ?').get(id);
            db.close();
            return row;
        });

        // One done, two pending.
        {
            const dir = project({
                'prd.json': JSON.stringify({
                    stories: {
                        'S1-001': { title: 'ship the thing', passes: true },
                        'S1-002': { title: 'b', passes: null },
                        'S1-003': { title: 'c', passes: null },
                    },
                }),
            });
            const sid = withHome(() => loadDb().startSession(dir));
            carrier.write(dir, 'sess-sum', sid);
            run(dir, 'sess-sum');
            const row = readSession(sid);

            check('the session is closed (end_time recorded)', !!row && !!row.end_time);
            check('completed lists the DONE story, by id and title',
                /S1-001/.test(row?.completed || '') && /ship the thing/.test(row?.completed || ''));
            check('  and does not list the pending ones as completed',
                !/S1-002/.test(row?.completed || ''));
            check('next_steps counts the pending stories', /2 tasks remaining/.test(row?.next_steps || ''));
            check('  and names them', /S1-002/.test(row?.next_steps || '') && /S1-003/.test(row?.next_steps || ''));
        }

        // Nothing pending — next_steps must be absent, not "0 tasks remaining".
        {
            const dir = project({
                'prd.json': JSON.stringify({ stories: { 'S1-001': { title: 'a', passes: true } } }),
            });
            const sid = withHome(() => loadDb().startSession(dir));
            carrier.write(dir, 'sess-done', sid);
            run(dir, 'sess-done');
            const row = readSession(sid);
            check('nothing pending: no next_steps recorded', !row?.next_steps);
        }

        // A deferred story is neither done nor outstanding.
        {
            const dir = project({
                'prd.json': JSON.stringify({
                    stories: {
                        'S1-001': { title: 'a', passes: true },
                        'S1-002': { title: 'b', passes: 'deferred' },
                    },
                }),
            });
            const sid = withHome(() => loadDb().startSession(dir));
            carrier.write(dir, 'sess-def', sid);
            run(dir, 'sess-def');
            const row = readSession(sid);
            check('a deferred story is not counted as pending', !row?.next_steps);
            check('  nor as completed', !/S1-002/.test(row?.completed || ''));
        }

        // A FAILED story is outstanding work, not completed work. The old suite
        // never constructed passes:false, so the `=== false` arm of the pending
        // filter was mutant-survivable.
        {
            const dir = project({
                'prd.json': JSON.stringify({
                    stories: {
                        'S1-001': { title: 'a', passes: true },
                        'S1-002': { title: 'broke', passes: false },
                    },
                }),
            });
            const sid = withHome(() => loadDb().startSession(dir));
            carrier.write(dir, 'sess-fail', sid);
            run(dir, 'sess-fail');
            const row = readSession(sid);
            check('a FAILED story counts as remaining', /1 tasks remaining/.test(row?.next_steps || '')
                && /S1-002/.test(row?.next_steps || ''));
            check('  and is not listed as completed', !/S1-002/.test(row?.completed || ''));
        }

        // needs-setup is blocked on a HUMAN but the human is still on the hook:
        // a session report that omits it says the project is finished while it
        // waits on the operator (prd-states.js isOutstanding). The old predicate
        // (isActionable) put it in neither completed nor nextSteps.
        {
            const dir = project({
                'prd.json': JSON.stringify({
                    stories: {
                        'S1-001': { title: 'a', passes: true },
                        'S1-002': { title: 'needs a key', passes: 'needs-setup' },
                    },
                }),
            });
            const sid = withHome(() => loadDb().startSession(dir));
            carrier.write(dir, 'sess-setup', sid);
            run(dir, 'sess-setup');
            const row = readSession(sid);
            check('a needs-setup story is outstanding: appears in next_steps',
                /1 tasks remaining/.test(row?.next_steps || '') && /S1-002/.test(row?.next_steps || ''));
            check('  and is not listed as completed', !/S1-002/.test(row?.completed || ''));
        }

        // An archived project: completed work leaves prd.stories, so the summary
        // must carry archived.totalCompleted or a project that shipped 159
        // stories records almost nothing.
        {
            const dir = project({
                'prd.json': JSON.stringify({
                    stories: { 'S9-001': { title: 'latest', passes: true } },
                    archived: { totalCompleted: 159 },
                }),
            });
            const sid = withHome(() => loadDb().startSession(dir));
            carrier.write(dir, 'sess-arch', sid);
            run(dir, 'sess-arch');
            const row = readSession(sid);
            check('archived count appears in completed', /\(\+159 archived\)/.test(row?.completed || ''));
            check('  alongside the active done story', /S9-001/.test(row?.completed || ''));
        }

        // Archive with nothing active done, and an unreadable count. "None" and
        // "could not read it" are different statements.
        {
            const dir = project({
                'prd.json': JSON.stringify({
                    stories: { 'S9-001': { title: 'wip', passes: null } },
                    archived: { totalCompleted: 'lots' },
                }),
            });
            const sid = withHome(() => loadDb().startSession(dir));
            carrier.write(dir, 'sess-archbad', sid);
            run(dir, 'sess-archbad');
            const row = readSession(sid);
            check('unreadable archive count is named, not zeroed',
                /archive present, count unreadable/.test(row?.completed || ''));
        }

        // No prd.json at all — the session still closes, with nothing to say.
        {
            const dir = project();
            const sid = withHome(() => loadDb().startSession(dir));
            carrier.write(dir, 'sess-noprd', sid);
            run(dir, 'sess-noprd');
            const row = readSession(sid);
            check('no prd.json: session still closed', !!row && !!row.end_time);
            check('  with no completed summary', !row?.completed);
        }
    }
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
