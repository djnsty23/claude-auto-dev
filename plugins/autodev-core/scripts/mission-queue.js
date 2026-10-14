#!/usr/bin/env node
// The mission queue: work a long-running session has committed to outside prd.json.
//
// stop-auto-check.js guards only a prd.json sprint. A Brain mission ("raise the
// scorecard tonight") never writes one, so nothing stopped its turn from ending
// with work queued. `[measured 2026-10-14]` an overnight Brain ended its turn on
// one failed `gh pr create` (exit 4) and the queue sat idle for about six hours.
// A retry the next morning worked at once.
//
// The session records its items here, and the Stop hook blocks while any item is
// `pending`. The states say who can move an item:
//
//   pending   this session can act on it now
//   inflight  delegated, and something will wake this session (a worker, a wakeup)
//   blocked   waiting on a person, named in its note
//   done      finished, with evidence in its note
//   dropped   decided against, with the reason in its note
//
// A failed command leaves its item pending: retry it, or record it as blocked.
//
// The file lives in the profile's state, keyed on the project directory, so it
// never dirties the user's tree. The first session whose Stop hook reads it owns
// it, and a peer session in the same directory ignores it.
//
// Every read fails open: a missing, corrupt or unwritable queue never blocks a turn.
//
// Run with --help for usage.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATES = ['pending', 'inflight', 'blocked', 'done', 'dropped'];
// Blocked stops with no change to the queue before the hook lets the turn end.
const NO_PROGRESS_LIMIT = 3;

function configDir() {
    return require(path.join(__dirname, 'claude-paths.js')).configDir();
}

function missionsDir() {
    return process.env.AUTODEV_MISSIONS_DIR || path.join(configDir(), 'autodev', 'missions');
}

function projectKey(cwd) {
    let where = path.resolve(cwd);
    if (process.platform === 'win32') where = where.toLowerCase();
    return crypto.createHash('sha256').update(where).digest('hex').slice(0, 12);
}

function fileFor(cwd) {
    return path.join(missionsDir(), projectKey(cwd) + '.json');
}

function read(cwd) {
    try {
        const q = JSON.parse(fs.readFileSync(fileFor(cwd), 'utf8'));
        return q && Array.isArray(q.items) ? q : null;
    } catch { return null; }
}

function write(cwd, q) {
    const file = fileFor(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(q, null, 1) + '\n');
    fs.renameSync(tmp, file);
}

function now() { return new Date().toISOString(); }

function start(cwd, mission) {
    const q = { version: 1, cwd: path.resolve(cwd), owner: null, mission: String(mission || ''), items: [], updatedAt: now() };
    write(cwd, q);
    return q;
}

function upsert(cwd, id, fields) {
    const q = read(cwd);
    if (!q) throw new Error('no mission queue here: run `start` first');
    if (fields.state && !STATES.includes(fields.state)) throw new Error(`state must be one of ${STATES.join(', ')}`);
    let item = q.items.find((i) => i.id === id);
    if (!item) {
        item = { id, title: '', state: 'pending', note: '' };
        q.items.push(item);
    }
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) item[k] = v;
    item.updatedAt = q.updatedAt = now();
    write(cwd, q);
    return item;
}

function clear(cwd) {
    try { fs.unlinkSync(fileFor(cwd)); return true; } catch { return false; }
}

const pendingOf = (q) => q.items.filter((i) => i.state === 'pending');

/**
 * The Stop hook's question: may this session end its turn?
 * Returns null (no opinion), { block: reason } or { note: text } (approve with a note).
 * Never throws.
 */
function stopDecision(cwd, sid, at = Date.now()) {
    try {
        const q = read(cwd);
        if (!q) return null;
        if (!q.owner) q.owner = sid;
        if (q.owner !== sid) return null;
        const pending = pendingOf(q);
        q.lastStopAt = new Date(at).toISOString();
        let out = null;
        if (!pending.length) {
            q.lastDecision = 'approve';
            q.noProgress = null;
        } else {
            // Progress is any write to the queue since the last blocked stop.
            const prior = q.noProgress && q.noProgress.since === q.updatedAt ? q.noProgress.count : 0;
            q.noProgress = { since: q.updatedAt, count: prior + 1 };
            const list = pending.slice(0, 5).map((i) => i.id + (i.title ? ` (${String(i.title).slice(0, 60)})` : '')).join(', ');
            if (q.noProgress.count > NO_PROGRESS_LIMIT) {
                q.lastDecision = 'approve';
                out = {
                    note: `[mission] ${pending.length} pending item(s) unchanged across ${NO_PROGRESS_LIMIT} blocked stops: ${list}. `
                        + 'Record each one as blocked (who it waits on), inflight (what wakes you) or dropped (why).',
                };
            } else {
                q.lastDecision = 'block';
                out = {
                    block: `[mission] ${pending.length} pending item(s) in this session's mission queue, next: ${list}. `
                        + 'A failed command is a step to retry or a blocker to record, never a reason to stop. '
                        + `Continue, or mark the item: node "${__filename}" set <id> blocked --note "<who it waits on>" --cwd "${cwd}".`,
                };
            }
        }
        write(cwd, q);
        return out;
    } catch { return null; }
}

/**
 * Missions whose owner stopped with pending work and has not touched the queue
 * for `minutes`. For a clock or board to raise, never to act on.
 */
function stalled(minutes, at = Date.now()) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(missionsDir()).filter((n) => n.endsWith('.json')); } catch { return out; }
    for (const name of names) {
        let q;
        try { q = JSON.parse(fs.readFileSync(path.join(missionsDir(), name), 'utf8')); } catch { continue; }
        if (!q || !Array.isArray(q.items)) continue;
        const pending = pendingOf(q);
        if (!pending.length) continue;
        const last = Math.max(Date.parse(q.updatedAt) || 0, Date.parse(q.lastStopAt) || 0);
        const idleMin = (at - last) / 60000;
        if (!(idleMin >= minutes)) continue;
        out.push({
            cwd: q.cwd, owner: q.owner, mission: q.mission, pending: pending.map((i) => i.id),
            idleMinutes: Math.round(idleMin),
            reason: q.lastDecision === 'approve' ? 'turn ended with pending work' : 'no queue activity',
        });
    }
    return out;
}

module.exports = { STATES, NO_PROGRESS_LIMIT, fileFor, read, start, upsert, clear, stopDecision, stalled };

function flag(args, name) {
    const i = args.indexOf('--' + name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, v !== undefined && !v.startsWith('--') ? 2 : 1);
    return v !== undefined && !v.startsWith('--') ? v : true;
}

function main(argv) {
    const args = argv.slice();
    const cwd = flag(args, 'cwd') || process.cwd();
    const json = flag(args, 'json') === true;
    const [verb, id, ...rest] = args;
    if (!verb || verb === '--help' || verb === '-h') {
        console.log([
            'mission-queue.js: the work this session has committed to, outside prd.json.',
            'The Stop hook blocks the turn while any item is pending.',
            '',
            '  start --mission "<text>"          begin a queue for this directory (replaces any old one)',
            '  add <id> [title...]                add a pending item',
            '  set <id> <state> [--note "<text>"] state: ' + STATES.join(', '),
            '  status [--json]                    print the queue',
            '  clear                              remove the queue (mission finished or abandoned)',
            '  stalled [--minutes 60] [--json]    missions stopped with pending work, machine-wide',
            '',
            'Every verb takes --cwd <dir> (default: the current directory).',
        ].join('\n'));
        return 0;
    }
    if (verb === 'start') {
        const mission = flag(args, 'mission');
        const q = start(cwd, typeof mission === 'string' ? mission : rest.join(' '));
        console.log(`mission queue started: ${fileFor(cwd)}${q.mission ? ' | ' + q.mission.slice(0, 80) : ''}`);
        return 0;
    }
    if (verb === 'add') {
        if (!id) { console.error('add needs an id'); return 1; }
        const it = upsert(cwd, id, { title: rest.join(' '), state: 'pending' });
        console.log(`${it.id} pending`);
        return 0;
    }
    if (verb === 'set') {
        const note = flag(rest, 'note');
        const state = rest[0];
        if (!id || !state) { console.error('set needs <id> <state>'); return 1; }
        const it = upsert(cwd, id, { state, note: typeof note === 'string' ? note : undefined });
        console.log(`${it.id} ${it.state}`);
        return 0;
    }
    if (verb === 'status') {
        const q = read(cwd);
        if (json) { console.log(JSON.stringify(q)); return 0; }
        if (!q) { console.log('no mission queue here'); return 0; }
        const count = (s) => q.items.filter((i) => i.state === s).length;
        console.log(`${q.mission || '(no mission text)'} | ` + STATES.map((s) => `${s}=${count(s)}`).join(' '));
        for (const i of q.items) console.log(`  ${i.state.padEnd(8)} ${i.id}${i.title ? '  ' + i.title : ''}${i.note ? '  | ' + i.note : ''}`);
        return 0;
    }
    if (verb === 'clear') {
        console.log(clear(cwd) ? 'mission queue cleared' : 'no mission queue here');
        return 0;
    }
    if (verb === 'stalled') {
        const m = Number(flag(args, 'minutes') || 60);
        const list = stalled(m);
        if (json) { console.log(JSON.stringify(list)); return 0; }
        console.log(`${list.length} stalled mission(s), idle ${m}+ min`);
        for (const s of list) console.log(`  ${s.idleMinutes} min | ${s.reason} | ${s.pending.length} pending | ${s.cwd}`);
        return 0;
    }
    console.error(`unknown verb ${verb}; run with --help`);
    return 1;
}

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
