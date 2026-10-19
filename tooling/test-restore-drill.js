#!/usr/bin/env node
'use strict';
// test-restore-drill.js: the recovery window's writer. restore-drill.js copies the clock state and
// the ask queue into a scratch dir, backs up, deletes and restores them with the real
// runtime-release.js verbs, and appends one row per drill. The live state must never change.
//
// Every run is a subprocess with BRAIN_CLOCK_CLAUDE_DIR in a temp dir that stands in for the live
// profile. A delivered intent is made with the real ask-queue.js verbs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '../plugins/autodev-core/scripts');
const DRILL = path.join(SCRIPTS, 'restore-drill.js');
const QUEUE = path.join(SCRIPTS, 'ask-queue.js');
let ran = 0;
let failed = 0;
function check(name, cond, detail) {
    ran++;
    if (cond) { console.log(`ok ${name}`); return; }
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${String(detail).slice(0, 600)}` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-drill-test-'));
const live = path.join(root, 'claude');
const state = path.join(live, 'autodev', 'brain-clock');
const log = path.join(live, 'autodev', 'windows', 'restore-drills.jsonl');
const env = { ...process.env, BRAIN_CLOCK_CLAUDE_DIR: live, HOME: root, USERPROFILE: root };
for (const k of ['AUTODEV_RUNTIME_DIR', 'ASK_QUEUE_DIR', 'ASK_QUEUE_BOARD', 'BRAIN_CLOCK_OBSERVERS']) delete env[k];
const drill = () => spawnSync(process.execPath, [DRILL], { env, encoding: 'utf8', timeout: 120000 });
const rows = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const last = () => rows().slice(-1)[0] || {};
const q = (...a) => { const r = spawnSync(process.execPath, [QUEUE, ...a], { env, encoding: 'utf8', timeout: 30000 }); return JSON.parse(r.stdout.trim().split('\n').pop()); };
// Every file under the live profile but the drill's own log, with its hash.
function tree(dir, out = {}, rel = '') {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = path.join(rel, e.name);
        if (e.isDirectory()) tree(path.join(dir, e.name), out, r);
        else if (r !== path.join('autodev', 'windows', 'restore-drills.jsonl')) out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, e.name))).digest('hex');
    }
    return out;
}

try {
    let r = drill();
    check('no clock state to drill on: exit 1, a row that says so', r.status === 1 && last().ok === false && /holds no clock state/.test(last().why), r.stdout + r.stderr);

    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'state-meta.json'), JSON.stringify({ schema: 1 }));
    fs.writeFileSync(path.join(state, 'passes.jsonl'), '{"at":"2026-10-19T00:00:00Z"}\n'.repeat(500));
    fs.writeFileSync(path.join(state, 'last.json'), '{"pass":1}');
    fs.writeFileSync(path.join(state, 'lock.json'), '{"pid":1}');
    const a = q('accept', '--source', 'test', '--body', 'drill intent');
    const id = a.value.intentId;
    const c = q('claim', '--intent', id);
    q('start', '--intent', id, '--epoch', String(c.value.epoch));
    const k = q('ack', '--intent', id, '--epoch', String(c.value.epoch), '--receipt', 'r-1');
    q('accept', '--source', 'test', '--body', 'a pending intent');
    check('the fixture holds one delivered intent made by the real queue', k.ok === true && q('status').value.counts.delivered === 1, JSON.stringify(k));

    const before = tree(live);
    r = drill();
    const row = last();
    check('a drill on readable state passes: exit 0, the state files and the delivered intent counted',
        r.status === 0 && /^restore-drill: PASS 3 files, 1 of 1 delivered intents kept/.test(r.stdout) && row.ok === true && row.files === 3 && row.intentsDelivered === 1 && row.intentsKept === 1 && row.why === null,
        r.stdout + r.stderr + JSON.stringify(row));
    check('the row carries a duration under the 60 minute limit', Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs < 60 * 60 * 1000, JSON.stringify(row));
    const after = tree(live);
    check('the live profile is byte for byte unchanged, with no runtime or backups dir added',
        JSON.stringify(after) === JSON.stringify(before) && !fs.existsSync(path.join(live, 'autodev', 'runtime')), `${Object.keys(before).length} vs ${Object.keys(after).length}`);
    check('the lock file is not a state file, so it is neither counted nor restored', row.files === 3);

    r = drill();
    check('every drill appends exactly one row', rows().length === 3, rows().length);

    fs.rmSync(path.dirname(log), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(path.dirname(log)), { recursive: true });
    fs.writeFileSync(path.dirname(log), 'a file where the directory should be');
    r = drill();
    check('an unwritable drill log exits 2 and says so', r.status === 2 && /could not be written/.test(r.stderr), r.stdout + r.stderr);
} catch (e) {
    failed++;
    console.log(`FAIL the suite crashed: ${e.stack || e}`);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\nrestore drill: ${ran - failed}/${ran} checks passed`);
process.exitCode = failed ? 1 : 0;
