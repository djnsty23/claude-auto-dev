#!/usr/bin/env node
'use strict';
/**
 * check-brain-role.js - refuse a `~/.claude/brain-role.json` that names a dead
 * session.
 *
 * WHY. That file is read by two hooks: `stop-brain-report.js`, which tells
 * every session's Stop hook where to send its idle report, and
 * `coordinator-write-guard.js`, which arms the product-repo rail for the session
 * it names. It is hand-written at boot, and `[measured 2026-09-04]` it was wrong
 * twice in one day by two mechanisms: a `peer_name` with a stale suffix that no
 * peer could resolve, then a whole record naming a session archived the previous
 * afternoon. Under the second, every Stop hook routed idle reports to a dead
 * Brain for a day, the guard protected nobody while being believed, and because
 * a peer name resolves through a WORKTREE the reports landed on whichever session
 * later occupied that directory: three inside one hour, two of them client
 * sessions. A third error the same afternoon wrote the desktop uuid into
 * `session_id`, which the hooks compare against the CLI session uuid, so the
 * guard stayed inert after the "fix".
 *
 * A hand-maintained field read by a hook wants a check, not another correction.
 *
 * WHAT IT READS, and none of it is an MCP call, so a hook can afford it:
 *
 *   ~/.claude/sessions/<pid>.json   one file per live CLI session: `pid`,
 *                                   `sessionId` (the CLI uuid the hook payload
 *                                   carries), `name` (the peer name). Liveness is
 *                                   the pid answering `process.kill(pid, 0)`.
 *   the desktop session store       `local_<uuid>.json` records, NESTED two
 *                                   directories down; `cliSessionId` is the only
 *                                   field that joins them to the CLI uuid.
 *
 * `process.kill(pid, 0)` DOES distinguish on Windows under Node: measured alive
 * for a live peer's pid and ESRCH for 999999. Python's os.kill raises for both,
 * which is where "the pid check does not work on Windows" came from. EPERM is
 * alive: a process you cannot signal still exists.
 *
 * FOUR STATES, and only one of them is a pass:
 *   absent   no role file          -> no coordinator claimed; exit 0
 *   ok       every field checks    -> exit 0
 *   fault    something is wrong    -> exit 2, every fault named with its id
 *   (a store that cannot be found is NOT CHECKED, printed as such, never a pass)
 *
 * FAILS LOUD, NOT OPEN. A silently wrong route produces no error at either end:
 * the sender thinks it delivered and the recipient never hears. So a stale
 * record is a visible refusal naming the dead id, and there is deliberately no
 * cwd fallback anywhere in here: a worktree outlives the session in it, so
 * resolving a coordinator by directory finds a place, not a correspondent.
 *
 * Usage:
 *   node check-brain-role.js --status            human-readable, exit 0/2
 *   node check-brain-role.js --json
 *   node check-brain-role.js --selftest          fixture with this process's own
 *                                                pid live and 999999 dead
 *   node check-brain-role.js --role <file>       (default $AUTODEV_BRAIN_ROLE_FILE,
 *                                                else ~/.claude/brain-role.json)
 *   node check-brain-role.js --sessions-dir <d>  (default $AUTODEV_SESSIONS_DIR,
 *                                                else ~/.claude/sessions)
 *   store: $CLAUDE_SESSION_STORE, else claude-paths.sessionStore()
 *
 *   const { checkBrainRole } = require('./check-brain-role.js');
 *   checkBrainRole({ roleFile, role, sessionsDir, store })   // never throws
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const REQUIRED = ['session_id', 'peer_name', 'desktop_session_id'];
const STORE_DEPTH = 4;

function readJSON(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function defaultRoleFile() {
    return process.env.AUTODEV_BRAIN_ROLE_FILE || path.join(HOME, '.claude', 'brain-role.json');
}

function defaultSessionsDir() {
    return process.env.AUTODEV_SESSIONS_DIR || path.join(HOME, '.claude', 'sessions');
}

function defaultStore() {
    try { return require(path.join(__dirname, 'claude-paths.js')).sessionStore(); } catch { return null; }
}

/** Does `pid` answer? EPERM counts as alive: it exists and is somebody else's. */
function isPidAlive(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * Every `<pid>.json` in the sessions dir, parsed, with `alive` decided by the
 * pid rather than by the file's presence: a file can outlive its process.
 */
function readLiveSessions(dir) {
    const out = { dir, readable: false, files: 0, live: [], dead: 0 };
    let names;
    try { names = fs.readdirSync(dir); } catch { return out; }
    out.readable = true;
    for (const f of names) {
        if (!/^\d+\.json$/.test(f)) continue;
        const rec = readJSON(path.join(dir, f));
        if (!rec || typeof rec !== 'object') continue;
        out.files++;
        const pid = Number(rec.pid) || Number(f.slice(0, -5));
        if (isPidAlive(pid)) out.live.push({ pid, sessionId: String(rec.sessionId || ''), name: String(rec.name || ''), file: f });
        else out.dead++;
    }
    return out;
}

/** Walk the store (it nests) for one `local_<id>.json` record by its sessionId. */
function findStoreRecord(store, desktopId) {
    const out = { store, readable: false, records: 0, archived: 0, record: null };
    if (!store) return out;
    const want = desktopId ? String(desktopId) : null;
    const walk = (dir, depth) => {
        if (depth > STORE_DEPTH) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        out.readable = true;
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p, depth + 1); continue; }
            if (!e.isFile() || !e.name.startsWith('local_') || !e.name.endsWith('.json')) continue;
            const rec = readJSON(p);
            if (!rec || typeof rec !== 'object') continue;
            out.records++;
            if (rec.isArchived) out.archived++;
            if (want && !out.record && (String(rec.sessionId || '') === want || e.name === want + '.json')) {
                out.record = { file: p, sessionId: String(rec.sessionId || ''), cliSessionId: String(rec.cliSessionId || ''), isArchived: !!rec.isArchived, title: rec.title || null };
            }
        }
    };
    walk(store, 0);
    return out;
}

/**
 * The check. Never throws.
 *
 * @param {{roleFile?:string, role?:object, sessionsDir?:string, store?:string|null}} [opts]
 * @returns {{state:'absent'|'ok'|'fault', roleFile:string, role:object|null,
 *            faults:Array<{code:string, detail:string}>, lines:string[],
 *            population:{sessionsDir:string, sessionFiles:number, livePids:number, deadPids:number,
 *                        sessionsReadable:boolean, store:string|null, storeReadable:boolean,
 *                        storeRecords:number, storeArchived:number}}}
 */
function checkBrainRole(opts) {
    const o = opts || {};
    const roleFile = o.roleFile || defaultRoleFile();
    const sessionsDir = o.sessionsDir || defaultSessionsDir();
    const store = o.store === undefined ? defaultStore() : o.store;
    const faults = [];
    const lines = [];
    const fault = (code, detail) => faults.push({ code, detail });
    // Declared before any early return: finish() reads both, and an unparseable
    // role file returns before the registries are read.
    let sessions = null;
    let found = { store: store || null, readable: false, records: 0, archived: 0, record: null };

    let role = o.role || null;
    if (!role) {
        if (!fs.existsSync(roleFile)) {
            return { state: 'absent', roleFile, role: null, faults, lines: ['no role file at ' + roleFile + ': no coordinator has claimed this machine'], population: emptyPopulation(sessionsDir, store) };
        }
        role = readJSON(roleFile);
        if (!role || typeof role !== 'object') {
            fault('unreadable', roleFile + ' is present and did not parse as a JSON object');
            return finish('fault');
        }
    }

    for (const k of REQUIRED) {
        if (typeof role[k] !== 'string' || !role[k].trim()) fault('missing-field', '`' + k + '` is absent; a role file with one address reaches half the fleet and one with no session_id arms no guard');
    }

    sessions = readLiveSessions(sessionsDir);
    const byId = new Map(sessions.live.map((s) => [s.sessionId, s]));
    const byName = new Map(sessions.live.map((s) => [s.name, s]));

    if (!sessions.readable) {
        fault('sessions-unreadable', 'could not read ' + sessionsDir + ', so no session can be shown live');
    } else {
        if (typeof role.session_id === 'string' && role.session_id) {
            const s = byId.get(role.session_id);
            if (s) lines.push('session_id ' + role.session_id + ' -> live session, pid ' + s.pid + (s.name ? ' (' + s.name + ')' : ''));
            else fault('dead-session', 'session_id ' + role.session_id + ' has NO live session file under ' + sessionsDir + ' (' + sessions.live.length + ' live of ' + sessions.files + ' scanned); it is archived, dead, or not a CLI session uuid at all');
        }
        if (typeof role.peer_name === 'string' && role.peer_name) {
            const s = byName.get(role.peer_name);
            if (s) lines.push('peer_name ' + role.peer_name + ' -> live session, pid ' + s.pid);
            else fault('dead-peer', 'peer_name ' + role.peer_name + ' is not the name of any live session under ' + sessionsDir + ' (' + sessions.live.length + ' live); a message to it resolves nowhere');
        }
        const a = byId.get(role.session_id), b = byName.get(role.peer_name);
        if (a && b && a.file !== b.file) {
            fault('mismatch', 'session_id belongs to pid ' + a.pid + ' (' + a.name + ') but peer_name belongs to pid ' + b.pid + '; one record, two sessions');
        }
    }

    found = findStoreRecord(store, role.desktop_session_id);
    if (typeof role.desktop_session_id === 'string' && role.desktop_session_id) {
        if (!found.readable) {
            lines.push('desktop_session_id ' + role.desktop_session_id + ' -> NOT CHECKED: no readable desktop store' + (store ? ' at ' + store : ''));
        } else if (!found.record) {
            fault('unknown-desktop', 'desktop_session_id ' + role.desktop_session_id + ' has no record in the desktop store (' + found.records + ' records read); nothing can be messaged at it');
        } else if (found.record.isArchived) {
            fault('archived-desktop', 'desktop_session_id ' + role.desktop_session_id + ' is ARCHIVED in the desktop store' + (found.record.title ? ' ("' + found.record.title + '")' : ''));
        } else if (typeof role.session_id === 'string' && role.session_id && found.record.cliSessionId && found.record.cliSessionId !== role.session_id) {
            fault('desktop-mismatch', 'desktop record ' + role.desktop_session_id + ' belongs to CLI session ' + found.record.cliSessionId + ', not to session_id ' + role.session_id + '; the two registries key differently and nothing converts one uuid into the other');
        } else {
            lines.push('desktop_session_id ' + role.desktop_session_id + ' -> live desktop record, cliSessionId matches');
        }
    }

    return finish(faults.length ? 'fault' : 'ok');

    function finish(state) {
        return {
            state, roleFile, role, faults, lines,
            population: {
                sessionsDir, sessionFiles: sessions ? sessions.files : 0,
                livePids: sessions ? sessions.live.length : 0, deadPids: sessions ? sessions.dead : 0,
                sessionsReadable: !!(sessions && sessions.readable),
                store: store || null, storeReadable: !!found.readable,
                storeRecords: found.records, storeArchived: found.archived,
            },
        };
    }
}

function emptyPopulation(sessionsDir, store) {
    return { sessionsDir, sessionFiles: 0, livePids: 0, deadPids: 0, sessionsReadable: false, store: store || null, storeReadable: false, storeRecords: 0, storeArchived: 0 };
}

function render(r) {
    const p = r.population;
    const out = [];
    out.push('brain-role: ' + r.state.toUpperCase() + '  (read ' + r.roleFile + ')');
    out.push('population: ' + p.sessionFiles + ' session file(s) under ' + p.sessionsDir + (p.sessionsReadable ? '' : ' (UNREADABLE)')
        + ', ' + p.livePids + ' with a live pid, ' + p.deadPids + ' dead; desktop store '
        + (p.storeReadable ? p.storeRecords + ' record(s), ' + p.storeArchived + ' archived, at ' + p.store : 'NOT FOUND' + (p.store ? ' at ' + p.store : '')));
    for (const l of r.lines) out.push('  ' + l);
    for (const f of r.faults) out.push('!! FAULT ' + f.code + ': ' + f.detail);
    if (r.state === 'fault') {
        out.push('');
        out.push('   Nobody can be reached at this record, and nothing here resolves a coordinator');
        out.push('   by cwd: a worktree outlives the session in it. Rewrite the record from');
        out.push('   ~/.claude/sessions/<pid>.json (`sessionId`, `name`) and the desktop store,');
        out.push('   or delete it so the hooks fall silent rather than routing to a dead session.');
    }
    return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// selftest: a fixture where this process is the live session and 999999 is dead
// ---------------------------------------------------------------------------

function selftest() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-brain-role-'));
    const sessionsDir = path.join(root, 'sessions');
    const store = path.join(root, 'store');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(store, 'account-fixture', 'bucket-fixture'), { recursive: true });
    const w = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
    w(path.join(sessionsDir, process.pid + '.json'), { pid: process.pid, sessionId: 'selftest-live-cli', name: 'selftest-live-peer' });
    w(path.join(sessionsDir, '999999.json'), { pid: 999999, sessionId: 'selftest-dead-cli', name: 'selftest-dead-peer' });
    w(path.join(store, 'account-fixture', 'bucket-fixture', 'local_selftest-live-desktop.json'), { sessionId: 'local_selftest-live-desktop', cliSessionId: 'selftest-live-cli', isArchived: false });
    w(path.join(store, 'account-fixture', 'bucket-fixture', 'local_selftest-archived-desktop.json'), { sessionId: 'local_selftest-archived-desktop', cliSessionId: 'selftest-dead-cli', isArchived: true });
    const roleAt = (name, obj) => { const p = path.join(root, name + '.json'); if (obj !== null) w(p, obj); return p; };

    const cases = [];
    const expect = (label, r, state, codes) => {
        const got = r.faults.map((f) => f.code).sort().join(',');
        const ok = r.state === state && got === codes.slice().sort().join(',');
        cases.push({ label, ok, detail: 'state=' + r.state + ' faults=[' + got + ']' });
    };
    const run = (name, obj) => checkBrainRole({ roleFile: roleAt(name, obj), sessionsDir, store });

    // The probe must distinguish before any verdict below is worth anything.
    cases.push({ label: 'pid probe: own pid is alive', ok: isPidAlive(process.pid), detail: String(process.pid) });
    cases.push({ label: 'pid probe: 999999 is dead (negative control)', ok: !isPidAlive(999999), detail: '999999' });

    expect('known-positive: a live, complete record passes',
        run('ok', { session_id: 'selftest-live-cli', peer_name: 'selftest-live-peer', desktop_session_id: 'local_selftest-live-desktop' }), 'ok', []);
    expect('dead session, dead peer, archived desktop: all three named',
        run('dead', { session_id: 'selftest-dead-cli', peer_name: 'selftest-dead-peer', desktop_session_id: 'local_selftest-archived-desktop' }), 'fault', ['dead-session', 'dead-peer', 'archived-desktop']);
    expect('desktop uuid written into session_id (the 2026-09-04 conflation)',
        run('conflated', { session_id: 'selftest-live-desktop', peer_name: 'selftest-live-peer', desktop_session_id: 'local_selftest-live-desktop' }), 'fault', ['dead-session', 'desktop-mismatch']);
    expect('one address only is incomplete',
        run('half', { session_id: 'selftest-live-cli', peer_name: 'selftest-live-peer' }), 'fault', ['missing-field']);
    expect('a desktop id nothing in the store knows',
        run('unknown', { session_id: 'selftest-live-cli', peer_name: 'selftest-live-peer', desktop_session_id: 'local_no-such-record' }), 'fault', ['unknown-desktop']);
    expect('no role file is absent, not a fault', run('absent', null), 'absent', []);
    {
        const p = roleAt('garbage', null); fs.writeFileSync(p, '{ not json');
        expect('an unparseable role file is a fault, not silence', checkBrainRole({ roleFile: p, sessionsDir, store }), 'fault', ['unreadable']);
    }
    expect('a store that cannot be found is NOT CHECKED, not a pass and not a fault',
        checkBrainRole({ roleFile: roleAt('nostore', { session_id: 'selftest-live-cli', peer_name: 'selftest-live-peer', desktop_session_id: 'local_selftest-live-desktop' }), sessionsDir, store: null }), 'ok', []);

    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
    const failed = cases.filter((c) => !c.ok);
    for (const c of cases) console.log((c.ok ? '  ok   ' : '  FAIL ') + c.label + (c.ok ? '' : '  (' + c.detail + ')'));
    console.log('selftest: ' + (cases.length - failed.length) + ' of ' + cases.length + ' cases, fixture of 2 session files (1 live pid, 1 dead) and 2 store records (1 archived)');
    return failed.length === 0;
}

module.exports = { checkBrainRole, isPidAlive, readLiveSessions, findStoreRecord, render };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n'use strict';\n/, ''));
        process.exit(0);
    }
    if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
    const r = checkBrainRole({ roleFile: val('--role'), sessionsDir: val('--sessions-dir') });
    if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); }
    else process.stdout.write(render(r));
    process.exit(r.state === 'fault' ? 2 : 0);
}
