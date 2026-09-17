#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/hooks/session-register.js.
//
// The hook writes one record per session at <fleetDir>/sessions/<uuid>.json on
// SessionStart and marks it ended on SessionEnd, so fleet-registry.js can list
// sessions across config dirs. Every case is a subprocess run of the real hook
// with AUTODEV_FLEET_DIR pointed at a fixture directory whose path contains a
// space: a suite that could write into the live fleet directory is worse than
// no suite, and planted test data has reached a live board in this repo before.
//
// The non-interference control at the end drives the REAL fleet-heartbeat.js
// prune and readAll over the same fixture, so the sessions/ subdirectory is
// proven invisible to the heartbeat store rather than assumed to be.
//
// Run: node tooling/test-session-register.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const sb = require('./spawn-budget.js');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'session-register.js');
const BUDGET_MS = 20000;

let pass = 0, fail = 0, infra = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail !== undefined ? '  (' + detail + ')' : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session register '));
let n = 0;
const freshFleet = () => { const d = path.join(TMP, 'fleet ' + (++n)); fs.mkdirSync(d, { recursive: true }); return d; };
const sessionsDir = (fleet) => path.join(fleet, 'sessions');
const recordOf = (fleet, id) => {
    try { return JSON.parse(fs.readFileSync(path.join(sessionsDir(fleet), id + '.json'), 'utf8')); } catch { return null; }
};
const listing = (fleet) => { try { return fs.readdirSync(sessionsDir(fleet)).sort(); } catch { return null; } };

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID2 = 'ffffffff-1111-4222-8333-444444444444';
const startPayload = (fleet, extra) => Object.assign({
    session_id: UUID, cwd: path.join(fleet, 'proj'), hook_event_name: 'SessionStart',
    transcript_path: path.join(fleet, 'proj', UUID + '.jsonl'),
}, extra || {});

// The suite itself may run under a config dir, a headless flag or a worker code;
// every case starts from none of them and sets only what it asserts.
function run(args, input, fleet, envExtra) {
    const env = Object.assign({}, process.env, { AUTODEV_FLEET_DIR: fleet });
    delete env.CLAUDE_CONFIG_DIR;
    delete env.AUTODEV_HEADLESS;
    delete env.AUTODEV_WORKER_CODE;
    Object.assign(env, envExtra || {});
    const r = sb.runBudgeted(process.execPath, [HOOK, ...args], {
        input: input === undefined ? '' : input, encoding: 'utf8', env, timeout: BUDGET_MS, windowsHide: true,
    });
    if (sb.classify(r) !== 'verdict') {
        infra++;
        console.log('INDETERMINATE  hook run produced no verdict: ' + sb.reason(r) + ' ' + sb.lastWords(r, 300));
        return null;
    }
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const runEvent = (fleet, payload, envExtra) => run([], JSON.stringify(payload), fleet, envExtra);
const silent = (r) => !!r && r.code === 0 && r.out === '' && r.err === '';
const detail = (r) => r ? 'exit ' + r.code + ', stdout ' + JSON.stringify(r.out.slice(0, 80)) + ', stderr ' + JSON.stringify(r.err.slice(0, 80)) : 'no verdict';

try {
    check('every fixture path contains a space', / /.test(TMP), TMP);

    // ---- 1. --help ----------------------------------------------------------
    {
        const fleet = freshFleet();
        const r = run(['--help'], '', fleet);
        check('--help with empty stdin: exit 0, zero bytes on both streams', silent(r), detail(r));
        check('  and nothing was written', listing(fleet) === null, JSON.stringify(listing(fleet)));
    }

    // ---- 2. SessionStart writes a full record ------------------------------
    const FIELDS = ['sessionId', 'configDir', 'cwd', 'pid', 'headless', 'workerCode', 'transcriptPath', 'startedAt', 'refreshedAt', 'endedAt', 'endReason'];
    {
        const fleet = freshFleet();
        const before = Date.now();
        const r = runEvent(fleet, startPayload(fleet));
        check('SessionStart with a UUID id: exit 0 and stdout is zero bytes', !!r && r.code === 0 && r.out === '', detail(r));
        check('  and stderr is zero bytes', !!r && r.err === '', detail(r));
        const rec = recordOf(fleet, UUID);
        check('  <fleet>/sessions/<uuid>.json exists', !!rec);
        check('  and carries every documented field', !!rec && FIELDS.every((f) => f in rec) && Object.keys(rec).length === FIELDS.length, rec && Object.keys(rec).join(','));
        check('  sessionId, cwd and transcriptPath come from the payload',
            !!rec && rec.sessionId === UUID && rec.cwd === path.join(fleet, 'proj') && rec.transcriptPath === path.join(fleet, 'proj', UUID + '.jsonl'));
        const started = rec ? Date.parse(rec.startedAt) : NaN;
        check('  startedAt and refreshedAt are ISO stamps from this run', !!rec && rec.startedAt === rec.refreshedAt && started >= before - 1000 && started <= Date.now() + 1000, rec && rec.startedAt);
        check('  endedAt and endReason are null on a start', !!rec && rec.endedAt === null && rec.endReason === null);
        check('  the file ends in one newline', fs.readFileSync(path.join(sessionsDir(fleet), UUID + '.json'), 'utf8').endsWith('}\n'));
    }

    // ---- 3. configDir is the basename of CLAUDE_CONFIG_DIR, or default -----
    {
        const fleet = freshFleet();
        const cfg = path.join(TMP, 'cfg ' + (++n), 'alt-config');
        fs.mkdirSync(cfg, { recursive: true });
        runEvent(fleet, startPayload(fleet), { CLAUDE_CONFIG_DIR: cfg });
        const rec = recordOf(fleet, UUID);
        check('CLAUDE_CONFIG_DIR set: configDir is its basename', !!rec && rec.configDir === 'alt-config', rec && rec.configDir);
        const raw = fs.readFileSync(path.join(sessionsDir(fleet), UUID + '.json'), 'utf8');
        check('  and the record carries no absolute path for it', !raw.includes(cfg) && !raw.includes(cfg.replace(/\\/g, '/')));
        const fleet2 = freshFleet();
        runEvent(fleet2, startPayload(fleet2));
        const rec2 = recordOf(fleet2, UUID);
        check('CLAUDE_CONFIG_DIR unset: configDir is "default"', !!rec2 && rec2.configDir === 'default', rec2 && rec2.configDir);
    }

    // ---- 4. headless and workerCode -----------------------------------------
    {
        const fleet = freshFleet();
        runEvent(fleet, startPayload(fleet), { AUTODEV_HEADLESS: '1', AUTODEV_WORKER_CODE: 'ZZ1' });
        const rec = recordOf(fleet, UUID);
        check('AUTODEV_HEADLESS=1 and AUTODEV_WORKER_CODE=ZZ1 are recorded', !!rec && rec.headless === true && rec.workerCode === 'ZZ1', JSON.stringify(rec));
        const fleet2 = freshFleet();
        runEvent(fleet2, startPayload(fleet2));
        const rec2 = recordOf(fleet2, UUID);
        check('  neither set: headless false and workerCode null', !!rec2 && rec2.headless === false && rec2.workerCode === null, JSON.stringify(rec2));
    }

    // ---- 5. pid is the spawning process --------------------------------------
    {
        const fleet = freshFleet();
        runEvent(fleet, startPayload(fleet));
        const rec = recordOf(fleet, UUID);
        check('pid is the pid of the process that spawned the hook (this suite)', !!rec && rec.pid === process.pid, rec && rec.pid + ' vs ' + process.pid);
    }

    // ---- 6. a second SessionStart refreshes, keeping startedAt ---------------
    {
        const fleet = freshFleet();
        runEvent(fleet, startPayload(fleet));
        const first = recordOf(fleet, UUID);
        const until = Date.now() + 5;
        while (Date.now() < until) { /* one tick, so refreshedAt can move */ }
        runEvent(fleet, startPayload(fleet));
        const second = recordOf(fleet, UUID);
        check('SessionStart twice: one file', listing(fleet) && listing(fleet).length === 1, JSON.stringify(listing(fleet)));
        check('  startedAt unchanged', !!first && !!second && first.startedAt === second.startedAt, first && second && first.startedAt + ' vs ' + second.startedAt);
        check('  refreshedAt strictly later', !!first && !!second && Date.parse(second.refreshedAt) > Date.parse(first.refreshedAt), first && second && first.refreshedAt + ' vs ' + second.refreshedAt);
    }

    // ---- 7. SessionEnd marks the record -------------------------------------
    {
        const fleet = freshFleet();
        runEvent(fleet, startPayload(fleet));
        const started = recordOf(fleet, UUID);
        const r = runEvent(fleet, startPayload(fleet, { hook_event_name: 'SessionEnd', reason: 'clear' }));
        check('SessionEnd with reason clear: silent', silent(r), detail(r));
        const rec = recordOf(fleet, UUID);
        check('  endedAt set and endReason is "clear"', !!rec && typeof rec.endedAt === 'string' && Number.isFinite(Date.parse(rec.endedAt)) && rec.endReason === 'clear', JSON.stringify(rec));
        check('  startedAt preserved', !!rec && !!started && rec.startedAt === started.startedAt);
        // A later start is the same session live again, so the end is cleared.
        runEvent(fleet, startPayload(fleet));
        const again = recordOf(fleet, UUID);
        check('  a SessionStart after the end clears endedAt and keeps startedAt', !!again && again.endedAt === null && again.endReason === null && again.startedAt === started.startedAt, JSON.stringify(again));
    }

    // ---- 8. SessionEnd for a session never started ---------------------------
    {
        const fleet = freshFleet();
        const r = runEvent(fleet, startPayload(fleet, { hook_event_name: 'SessionEnd', reason: 'other' }));
        check('SessionEnd for a session never started: silent', silent(r), detail(r));
        const rec = recordOf(fleet, UUID);
        check('  a record is created with endedAt set', !!rec && typeof rec.endedAt === 'string' && rec.endReason === 'other', JSON.stringify(rec));
        check('  and startedAt is null, since no start was seen', !!rec && rec.startedAt === null);
    }

    // ---- 9. a fixture-shaped session id writes nothing ----------------------
    {
        const fleet = freshFleet();
        const r = runEvent(fleet, startPayload(fleet, { session_id: 'sess' }));
        check('a non-UUID session_id ("sess"): silent', silent(r), detail(r));
        check('  and nothing is written: sessions/ does not exist', listing(fleet) === null, JSON.stringify(listing(fleet)));
        const r2 = runEvent(fleet, startPayload(fleet, { session_id: 'sess', hook_event_name: 'SessionEnd', reason: 'clear' }));
        check('  same on SessionEnd', silent(r2) && listing(fleet) === null, detail(r2));
    }

    // ---- 10. malformed and empty stdin ---------------------------------------
    {
        const fleet = freshFleet();
        const r = run([], 'not json', fleet);
        check('malformed stdin: exit 0, zero bytes both streams', silent(r), detail(r));
        const r2 = run([], '', fleet);
        check('empty stdin: exit 0, zero bytes both streams', silent(r2), detail(r2));
        check('  and nothing was written', listing(fleet) === null, JSON.stringify(listing(fleet)));
        const r3 = runEvent(fleet, startPayload(fleet, { hook_event_name: 'Stop' }));
        check('an event the hook is not wired for (Stop) writes nothing', silent(r3) && listing(fleet) === null, detail(r3));
    }

    // ---- 11. an unwritable fleet directory -----------------------------------
    {
        const parentFile = path.join(TMP, 'a file ' + (++n));
        fs.writeFileSync(parentFile, 'not a directory\n', 'utf8');
        const fleet = path.join(parentFile, 'fleet');
        const r = runEvent(fleet, startPayload(fleet));
        check('AUTODEV_FLEET_DIR whose parent is a regular file: exit 0, zero bytes both streams', silent(r), detail(r));
        check('  and the file is untouched', fs.readFileSync(parentFile, 'utf8') === 'not a directory\n');
    }

    // ---- 12. prune, with the heartbeat store as the non-interference control --
    {
        const fleet = freshFleet();
        const dir = sessionsDir(fleet);
        fs.mkdirSync(dir, { recursive: true });
        const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();
        const plant = (id, rec) => fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(rec) + '\n', 'utf8');
        const OLD = '01234567-89ab-4cde-8f01-23456789abcd';
        const RECENT = '76543210-ba98-4edc-8f10-fedcba987654';
        const ENDED_OLD = '00000000-0000-4000-8000-000000000001';
        plant(OLD, { sessionId: OLD, refreshedAt: daysAgo(8), endedAt: null });
        plant(RECENT, { sessionId: RECENT, refreshedAt: daysAgo(6), endedAt: null });
        // endedAt is what counts when present: refreshed 8 days ago but ended 1 day ago stays.
        plant(ENDED_OLD, { sessionId: ENDED_OLD, refreshedAt: daysAgo(8), endedAt: daysAgo(1) });
        const heartbeat = path.join(fleet, UUID2 + '.json');
        const heartbeatBytes = JSON.stringify({ cliSessionId: UUID2, stoppedAt: daysAgo(9) }) + '\n';
        fs.writeFileSync(heartbeat, heartbeatBytes, 'utf8');
        // fleet-heartbeat.js prunes by mtime, so the control needs an old one.
        const nineDaysAgo = new Date(Date.now() - 9 * 864e5);
        fs.utimesSync(heartbeat, nineDaysAgo, nineDaysAgo);
        const notifier = path.join(fleet, '.notified.json');
        fs.writeFileSync(notifier, '{}\n', 'utf8');

        const r = runEvent(fleet, startPayload(fleet));
        check('prune run: silent', silent(r), detail(r));
        const after = listing(fleet) || [];
        check('  the 8-day-old record is gone', !after.includes(OLD + '.json'), JSON.stringify(after));
        check('  the 6-day-old record remains', after.includes(RECENT + '.json'), JSON.stringify(after));
        check('  a record ended 1 day ago but refreshed 8 days ago remains (endedAt wins)', after.includes(ENDED_OLD + '.json'), JSON.stringify(after));
        check('  and the new record is there', after.includes(UUID + '.json'), JSON.stringify(after));
        check('  the 9-day-old heartbeat beside sessions/ is byte-identical', fs.readFileSync(heartbeat, 'utf8') === heartbeatBytes);
        check('  and the notifier dotfile beside it is untouched', fs.readFileSync(notifier, 'utf8') === '{}\n');

        // The other direction: the real heartbeat module, pointed at this fixture,
        // must neither read sessions/ as a heartbeat nor prune it.
        process.env.AUTODEV_FLEET_DIR = fleet;
        const hb = require(path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-heartbeat.js'));
        check('  control: fleet-heartbeat.js DIR is this fixture', hb.DIR === fleet, hb.DIR);
        hb.prune();
        const all = hb.readAll();
        check('  fleet-heartbeat.js prune leaves sessions/ and its records in place', fs.existsSync(dir) && (listing(fleet) || []).includes(RECENT + '.json'));
        check('  and fleet-heartbeat.js readAll never reads a session record', all.every((h) => h.cliSessionId !== RECENT && h.cliSessionId !== UUID), JSON.stringify(all.map((h) => h.cliSessionId)));
        check('  while it did prune the 9-day-old heartbeat (the control is live)', !fs.existsSync(heartbeat));
    }

    // ---- 13. no .tmp left behind by any case ----------------------------------
    {
        const leftovers = [];
        for (const d of fs.readdirSync(TMP)) {
            const sd = path.join(TMP, d, 'sessions');
            let names; try { names = fs.readdirSync(sd); } catch { continue; }
            for (const f of names) if (f.endsWith('.tmp')) leftovers.push(path.join(d, 'sessions', f));
        }
        check('no .tmp file remains in any sessions/ directory', leftovers.length === 0, JSON.stringify(leftovers));
    }
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
}

console.log('\n' + sb.tally(pass, fail, infra));
process.exitCode = sb.exitCode(fail, infra);
