#!/usr/bin/env node
'use strict';
/**
 * restore-drill.js - a restore drill of the operating layer, run on a copy of the real state.
 *
 * WHY. The recovery window asks for a real restore drill inside 60 minutes with no acknowledged
 * intent lost. A drill on the live clock state cannot run from inside a clock pass, which already
 * holds the lock that runtime-release.js takes, and a drill that rewrites live state is a risk the
 * drill exists to measure, not to take. So the drill copies the live clock state and the ask queue
 * into a scratch claude dir and runs the real verbs there:
 *   1. `runtime-release.js backup`, as an operator would before a change,
 *   2. the loss: every clock state file is deleted,
 *   3. `runtime-release.js restore --backup <name>`,
 *   4. every restored file must hash-equal the copied original, and `ask-queue.js status` must
 *      report every intent it reported delivered before, still delivered.
 * The scratch dir is removed afterwards. Nothing live is written but the drill's own row.
 *
 * ROW. One JSON line appended to <claude dir>/autodev/windows/restore-drills.jsonl:
 *   { at, ok, durationMs, files, bytes, intentsDelivered, intentsKept, why }
 * <claude dir> is BRAIN_CLOCK_CLAUDE_DIR, else ~/.claude, the clock's own rule.
 *
 * USAGE. node restore-drill.js [--json]
 * Exit codes: 0 the drill passed, 1 it failed (the row says why), 2 the row could not be written.
 *
 * What it does not cover: the live directory's own permissions and disk, and acks that land
 * between a real backup and a real restore. The ask queue is the canonical store of intents and a
 * clock restore does not write it, so the intent check proves the restore left it whole.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CLAUDE_DIR = process.env.BRAIN_CLOCK_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const AUTODEV = path.join(CLAUDE_DIR, 'autodev');
const LIVE_STATE = path.join(AUTODEV, 'brain-clock');
const LIVE_QUEUE = process.env.ASK_QUEUE_DIR || path.join(AUTODEV, 'ask-queue');
const LOG = path.join(AUTODEV, 'windows', 'restore-drills.jsonl');
const LIMIT_MS = 60 * 60 * 1000;
const RUNTIME_RELEASE = path.join(__dirname, 'runtime-release.js');
const ASK_QUEUE = path.join(__dirname, 'ask-queue.js');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stateNames = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !/^lock\.json/.test(e.name) && !/\.tmp(-\d+)?$/.test(e.name)).map((e) => e.name).sort() : []);

function verb(script, args, env) {
    const r = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 });
    let out = null;
    try { out = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
    if (r.status !== 0 || !out || out.ok !== true) {
        const msg = out && out.error ? `${out.error.code}: ${out.error.message}` : String(r.stderr || r.stdout || r.error || '').trim().slice(0, 300);
        throw new Error(`${path.basename(script)} ${args[0]} exited ${r.status}: ${msg}`);
    }
    return out.value;
}

function delivered(env) {
    const s = verb(ASK_QUEUE, ['status'], env);
    return Object.entries(s.intents || {}).filter(([, st]) => st === 'delivered').map(([id]) => id).sort();
}

function drill(opts = {}) {
    const now = opts.now || Date.now;
    const t0 = now();
    const row = { at: new Date(t0).toISOString(), ok: false, durationMs: null, files: 0, bytes: 0, intentsDelivered: null, intentsKept: null, why: null };
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-drill-'));
    try {
        const claude = path.join(scratch, 'claude');
        const state = path.join(claude, 'autodev', 'brain-clock');
        const queue = path.join(claude, 'autodev', 'ask-queue');
        fs.mkdirSync(state, { recursive: true });
        const names = stateNames(LIVE_STATE);
        if (!names.length) throw new Error(`${LIVE_STATE} holds no clock state to drill on`);
        const want = {};
        for (const n of names) {
            fs.copyFileSync(path.join(LIVE_STATE, n), path.join(state, n));
            want[n] = sha(path.join(state, n));
            row.bytes += fs.statSync(path.join(state, n)).size;
        }
        row.files = names.length;
        if (fs.existsSync(LIVE_QUEUE)) fs.cpSync(LIVE_QUEUE, queue, { recursive: true });
        const env = { ...process.env, BRAIN_CLOCK_CLAUDE_DIR: claude, AUTODEV_RUNTIME_DIR: path.join(claude, 'autodev', 'runtime'), ASK_QUEUE_DIR: queue };
        delete env.BRAIN_CLOCK_OBSERVERS;
        const before = delivered(env);
        row.intentsDelivered = before.length;

        const b = verb(RUNTIME_RELEASE, ['backup', '--wait-s', '30'], env);
        for (const n of stateNames(state)) fs.rmSync(path.join(state, n), { force: true });
        if (stateNames(state).length) throw new Error('the simulated loss left state files behind');
        verb(RUNTIME_RELEASE, ['restore', '--backup', b.name, '--wait-s', '30'], env);

        const got = stateNames(state);
        const wrong = names.filter((n) => !got.includes(n) || sha(path.join(state, n)) !== want[n]);
        const extra = got.filter((n) => !names.includes(n));
        const after = new Set(delivered(env));
        const lost = before.filter((id) => !after.has(id));
        row.intentsKept = before.length - lost.length;
        row.durationMs = now() - t0;
        const faults = [];
        if (wrong.length) faults.push(`${wrong.length} of ${names.length} state files did not come back byte for byte (${wrong.slice(0, 5).join(', ')})`);
        if (extra.length) faults.push(`the restore left ${extra.length} file(s) the backup did not hold (${extra.slice(0, 5).join(', ')})`);
        if (lost.length) faults.push(`${lost.length} delivered intent(s) were no longer delivered (${lost.slice(0, 5).join(', ')})`);
        if (row.durationMs > LIMIT_MS) faults.push(`the drill took ${Math.round(row.durationMs / 60000)} min, over 60`);
        row.ok = faults.length === 0;
        row.why = faults.length ? faults.join('; ') : null;
    } catch (e) {
        row.durationMs = now() - t0;
        row.why = String(e && e.message || e).slice(0, 500);
    } finally {
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a drill result */ }
    }
    return row;
}

function main(argv) {
    const row = drill();
    try {
        fs.mkdirSync(path.dirname(LOG), { recursive: true });
        fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
    } catch (e) {
        process.stderr.write(`restore-drill: the row could not be written (${e.code || e.message})\n`);
        return 2;
    }
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(row) + '\n');
    else process.stdout.write(`restore-drill: ${row.ok ? 'PASS' : 'FAIL'} ${row.files} files, ${row.intentsKept ?? '?'} of ${row.intentsDelivered ?? '?'} delivered intents kept, ${row.durationMs} ms${row.why ? `: ${row.why}` : ''}\n`);
    return row.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { drill, LOG };
