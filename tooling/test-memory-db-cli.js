#!/usr/bin/env node
// Tests for memory-db.js's CLI dispatch.
//
// `npm run check:functions` reported six of memory-db's methods as never entered
// by the suite. Reading them showed five were not dead at all — getRecent,
// searchTimeline, listSessions, getByType and cleanup are reachable as
// `node memory-db.js recent|timeline|sessions|decisions|cleanup`. User-facing
// entry points with no test. (The sixth, getSession, had no caller anywhere and
// was deleted.)
//
// What matters here is not the query results — those are the DB's job and are
// covered elsewhere. It is that every advertised subcommand RUNS, exits 0, and
// prints parseable JSON. A CLI that throws on `sessions` is broken for everyone
// who types it, and nothing would have noticed.
//
// Run: node tooling/test-memory-db-cli.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB = path.resolve(__dirname, '..', 'plugins', 'autodev-memory', 'scripts', 'memory-db.js');
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memdb-cli-')));
const PROJ = path.join(HOME, 'proj');
fs.mkdirSync(PROJ, { recursive: true });

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

const cli = (...args) => spawnSync(process.execPath, [DB, ...args], {
    encoding: 'utf8', cwd: PROJ,
    env: { ...process.env, HOME, USERPROFILE: HOME },
});

const memDB = (() => {
    const prev = process.env.HOME;
    process.env.HOME = HOME; process.env.USERPROFILE = HOME;
    const m = require(DB);
    process.env.HOME = prev;
    return m;
})();

if (!memDB.isAvailable()) {
    console.log('[skip] node:sqlite unavailable — skipping memory-db CLI tests');
    console.log('\n0 passed, 0 failed');
    process.exit(0);
}

// Seed one of each type so the type-filtered commands have something to return
// and an empty result cannot be mistaken for a working command.
{
    const prev = process.env.HOME;
    process.env.HOME = HOME; process.env.USERPROFILE = HOME;
    const sid = memDB.startSession(PROJ);
    for (const [type, title] of [
        ['decision', 'chose sqlite for local memory'],
        ['bugfix', 'fixed the carrier race'],
        ['discovery', 'the limiter is per-node'],
    ]) {
        memDB.saveObservation({ sessionId: sid, projectPath: PROJ, type, title,
            concept: 'seeded for the CLI smoke test', sourceFiles: ['src/x.js'] });
    }
    memDB.endSession(sid, { completed: 'seeded' });
    process.env.HOME = prev;
}

// Every subcommand the dispatch advertises. `test` is excluded deliberately —
// it is the module's own self-check, not a query.
// `knowledge` is NOT here on purpose: it prints a rendered human brief via
// renderKnowledgeBrief, not JSON. Asserting JSON on it failed, and the
// assumption was wrong rather than the code — it has its own case below.
const JSON_COMMANDS = ['stats', 'recent', 'sessions', 'decisions', 'bugs',
                       'search', 'semantic', 'timeline'];

for (const cmd of JSON_COMMANDS) {
    // The search-shaped commands take a query; the others ignore extra args.
    const r = cli(cmd, PROJ, 'sqlite');
    const ok = r.status === 0;
    check(`${cmd}: exits 0`, ok);
    if (!ok && r.stderr) console.log('       stderr:', (r.stderr || '').split('\n')[0]);

    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
    check(`  ${cmd}: prints parseable JSON`, parsed !== null);
}

// knowledge renders for a human. The contract is that it produces readable text
// and does not throw — the brief's content is asserted where it is built.
{
    const r = cli('knowledge', PROJ, 'src');
    check('knowledge: exits 0', r.status === 0);
    check('  and prints a rendered brief, not JSON',
        (r.stdout || '').trim().length > 0 && !/^\s*[{[]/.test(r.stdout || ''));
}

// cleanup MUTATES, so it gets its own case: it must run, exit 0, and report a
// number rather than throwing on an empty database.
{
    const r = cli('cleanup', PROJ, '3650');   // far enough back to delete nothing
    check('cleanup: exits 0', r.status === 0);
    check('  and says how many rows it removed', /\d/.test(r.stdout || ''));
}

// An unknown subcommand must not look like success.
{
    const r = cli('definitely-not-a-command', PROJ);
    check('an unknown subcommand does not silently succeed',
        r.status !== 0 || /usage|unknown|commands/i.test((r.stdout || '') + (r.stderr || '')));
}

// The seeded data must actually come back — otherwise every assertion above
// would pass against a CLI that returns empty arrays for everything.
{
    const r = cli('decisions', PROJ);
    check('decisions returns the seeded decision', /chose sqlite/.test(r.stdout || ''));
    const s = cli('stats', PROJ);
    check('stats counts the seeded observations', /"totalObservations": [1-9]/.test(s.stdout || ''));
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
