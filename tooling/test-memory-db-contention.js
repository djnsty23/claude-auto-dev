#!/usr/bin/env node
// Tests for the memory DB under concurrent sessions (F15).
//
// Every Claude session on a machine writes the same sqlite file from its
// PostToolUse hook. The connection set WAL and no busy_timeout, which is 0, so
// a write that met another session's write lock failed at once with
// SQLITE_BUSY. The circuit breaker swallowed it, printed a stderr line nobody
// reads, and the observation was gone. Three in a row opened the breaker, and
// that process recorded nothing more.
//
// The properties pinned here:
//   1. a write that meets a lock held for well under 2 s WAITS and lands;
//   2. the connection carries a journal size limit, so a WAL grown by a long
//      session is cut back when it resets rather than kept at its peak;
//   3. SessionEnd runs a truncating checkpoint, so the WAL is 0 bytes after it.
//
// Everything runs in child processes against a throwaway CLAUDE_CONFIG_DIR, so
// the real memory DB is never opened.
//
// Run: node tooling/test-memory-db-contention.js

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_SRC = path.resolve(__dirname, '..', 'plugins', 'autodev-memory');
const DB_JS = path.join(PLUGIN_SRC, 'scripts', 'memory-db.js');
const SESSION_END = path.join(PLUGIN_SRC, 'hooks', 'memory-session-end.js');

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let sqliteOk = true;
try { require('node:sqlite'); } catch { sqliteOk = false; }
if (!sqliteOk) {
    // Not a pass: the subject cannot run here, and saying so is the result.
    console.log('INDETERMINATE  node:sqlite is unavailable in this Node, nothing was tested');
    process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memdb-contention-')));
const DB_PATH = path.join(TMP, 'auto-dev-memory.db');
const env = { ...process.env, CLAUDE_CONFIG_DIR: TMP };
const slash = (p) => p.replace(/\\/g, '/');

function script(name, body) {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, body);
    return p;
}

// Create the schema through the subject itself, the way a first hook would.
const init = script('init.js', `
const db = require(${JSON.stringify(slash(DB_JS))});
process.stdout.write(String(db.startSession('/proj')));
`);
const initRun = spawnSync(process.execPath, [init], { encoding: 'utf8', env });
// Observations carry a foreign key to sessions, so every write names this id.
const SID = initRun.stdout;
check('setup: the subject creates its store and a session in the sandbox', /^ses/.test(SID) && fs.existsSync(DB_PATH));

// Holds a write lock for HOLD_MS, announcing the moment it has it.
const HOLD_MS = 700;
const holder = script('holder.js', `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(slash(DB_PATH))});
db.exec('BEGIN IMMEDIATE');
process.stdout.write('locked\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS});
db.exec('COMMIT');
db.close();
`);

const writer = script('writer.js', `
const db = require(${JSON.stringify(slash(DB_JS))});
const t = Date.now();
const id = db.saveObservation({ sessionId: process.argv[3], projectPath: '/proj', type: 'change', title: 'under lock ' + process.argv[2] });
process.stdout.write(JSON.stringify({ id, ms: Date.now() - t }));
`);

function underLock(tag) {
    return new Promise((resolve) => {
        const h = spawn(process.execPath, [holder], { env });
        let out = '';
        let fired = false;
        h.stdout.on('data', (d) => {
            out += d;
            if (!fired && out.includes('locked')) {
                fired = true;
                const w = spawnSync(process.execPath, [writer, tag, SID], { encoding: 'utf8', env });
                let parsed = null;
                try { parsed = JSON.parse(w.stdout); } catch { /* reported below */ }
                h.on('exit', () => resolve({ parsed, stderr: w.stderr || '' }));
            }
        });
        h.on('exit', () => { if (!fired) resolve({ parsed: null, stderr: 'holder never locked' }); });
    });
}

const pragmas = script('pragmas.js', `
const db = require(${JSON.stringify(slash(DB_JS))});
process.stdout.write(JSON.stringify(db.pragmas ? db.pragmas() : null));
`);

(async () => {
    const r = await underLock('a');
    check(`a write that meets a ${HOLD_MS} ms lock waits and lands (${JSON.stringify(r.parsed)})`,
        !!r.parsed && typeof r.parsed.id === 'string' && r.parsed.id.length > 0);
    check('  and it did wait, so the lock was really held', !!r.parsed && r.parsed.ms >= HOLD_MS / 2);
    check('  and nothing was reported as a DB error', !/DB error|database is locked/i.test(r.stderr));

    const p = spawnSync(process.execPath, [pragmas], { encoding: 'utf8', env });
    let got = null;
    try { got = JSON.parse(p.stdout); } catch { /* null */ }
    check(`the connection sets busy_timeout 2000 (${JSON.stringify(got)})`, !!got && got.busy_timeout === 2000);
    check('  and a journal size limit', !!got && got.journal_size_limit > 0);
    check('  and stays in WAL mode', !!got && String(got.journal_mode).toLowerCase() === 'wal');

    // Grow the WAL, then run the real SessionEnd hook and read the file size.
    // A peer session keeps a connection open throughout, as a live one does.
    // Without it the last close checkpoints and deletes the WAL by itself, and
    // the control below reads -1: the lone-session case never needed a fix.
    const idle = script('idle.js', `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(slash(DB_PATH))});
db.prepare('SELECT 1').get();
process.stdout.write('open\\n');
setTimeout(() => {}, 60000);
`);
    const peer = spawn(process.execPath, [idle], { env });
    await new Promise((resolve) => {
        let buf = '';
        peer.stdout.on('data', (d) => { buf += d; if (buf.includes('open')) resolve(); });
        peer.on('exit', resolve);
    });
    const grow = script('grow.js', `
const db = require(${JSON.stringify(slash(DB_JS))});
for (let i = 0; i < 200; i++) db.saveObservation({ sessionId: process.argv[2], projectPath: '/proj', type: 'change', title: 'row ' + i + ' ' + 'x'.repeat(200) });
`);
    spawnSync(process.execPath, [grow, SID], { encoding: 'utf8', env });
    const wal = DB_PATH + '-wal';
    const before = fs.existsSync(wal) ? fs.statSync(wal).size : -1;
    const proj = path.join(TMP, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const end = spawnSync(process.execPath, [SESSION_END], {
        encoding: 'utf8',
        env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN_SRC },
        cwd: proj,
        input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'h1', cwd: proj }),
    });
    const after = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
    peer.kill(); // our own child, by its handle
    await new Promise((resolve) => (peer.exitCode !== null ? resolve() : peer.on('exit', resolve)));
    check(`control: the WAL had grown before SessionEnd (${before} bytes)`, before > 0);
    check(`SessionEnd truncates the WAL (${after} bytes after)`, end.status === 0 && after === 0);

    let pass = 0, fail = 0;
    for (const [label, ok] of cases) {
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
        ok ? pass++ : fail++;
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exitCode = fail > 0 ? 1 : 0;
})();
