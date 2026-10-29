#!/usr/bin/env node
'use strict';
// Configure brain-clock: {"id":"owner-time-baseline","script":"owner-time-baseline.js","everyMin":1440}.
// Completed UTC Monday weeks only. Active start/stop time is split at week
// boundaries; corrections belong to their recorded week. Receipt latency is
// never time worked. This is aggregate fleet time, not time attributed per ask.
// A week with unclosed timing, no measured time, no owner receipt, or no accepted
// task remains unknown. Revisions append; the reader selects the newest week row.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configDir } = require('./claude-paths.js');
const WEEK = 7 * 86400000;
function rows(file) {
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((s) => s.trim()).map(JSON.parse); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function monday(t) {
    const d = new Date(t); d.setUTCHours(0, 0, 0, 0);
    return d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000;
}
function main(argv) {
    if (argv.includes('--help')) { console.log('Usage: owner-time-baseline.js [--config-dir DIR] [--now ISO]'); return; }
    const opts = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!['--config-dir', '--now'].includes(argv[i]) || !argv[i + 1]) throw new Error('invalid arguments');
        opts[argv[i]] = argv[i + 1];
    }
    const root = path.join(opts['--config-dir'] || configDir(), 'autodev');
    const now = opts['--now'] ? Date.parse(opts['--now']) : Date.now();
    if (!Number.isFinite(now)) throw new Error('invalid time');
    const file = path.join(root, 'owner-asks', 'ledger.jsonl');
    const ledger = rows(file);
    const events = ledger.filter((r) => r && r.type !== 'owner-time-baseline' && Date.parse(r.at) <= now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!events.length) return;
    const accepts = new Map();
    for (const j of rows(path.join(root, 'brain-judge', 'judgements.jsonl'))) {
        if (!j || j.mode !== 'live' || j.decision !== 'accept' || j.applied !== true || !j.taskId || !(Date.parse(j.at) <= now)) continue;
        if (!accepts.has(j.taskId) || Date.parse(j.at) < Date.parse(accepts.get(j.taskId).at)) accepts.set(j.taskId, j);
    }
    const weeks = new Map();
    const get = (t) => {
        const start = monday(t);
        if (!weeks.has(start)) weeks.set(start, { start, minutes: 0, measured: 0, open: false, asks: new Set(), receipts: new Set(), accepted: new Set() });
        return weeks.get(start);
    };
    const raised = new Map(); let open = null;
    for (const e of events) {
        const t = Date.parse(e.at); const w = get(t);
        if (e.type === 'raised' && e.key) { raised.set(e.key, t); w.asks.add(e.key); }
        if (['receipt', 'resolved'].includes(e.type) && e.by === 'owner' && raised.has(e.key) && t >= raised.get(e.key)) w.receipts.add(e.key);
        if (e.type === 'owner-time-start' && open === null) open = t;
        if (e.type === 'owner-time-stop' && open !== null && t >= open) {
            for (let cursor = open; cursor < t;) {
                const segment = get(cursor); const end = Math.min(t, segment.start + WEEK);
                segment.minutes += (end - cursor) / 60000; segment.measured++; cursor = end;
            }
            open = null;
        }
        if (e.type === 'owner-time-correct' && Number.isFinite(e.minutes)) { w.minutes += e.minutes; w.measured++; }
    }
    if (open !== null) for (let cursor = monday(open); cursor <= now; cursor += WEEK) get(cursor).open = true;
    for (const j of accepts.values()) get(Date.parse(j.at)).accepted.add(j.taskId);
    const old = new Map();
    for (const r of ledger) if (r?.type === 'owner-time-baseline') old.set(r.weekStart, r);
    const pending = [];
    for (const w of [...weeks.values()].sort((a, b) => a.start - b.start)) {
        if (w.start + WEEK > now) continue;
        const measured = w.measured > 0 && !w.open && w.minutes >= 0 && w.receipts.size > 0 && w.accepted.size > 0;
        const value = { weekStart: new Date(w.start).toISOString().slice(0, 10), weekEnd: new Date(w.start + WEEK).toISOString().slice(0, 10),
            ownerMinutes: w.minutes, acceptedTasks: w.accepted.size, deliveredAsks: w.receipts.size, raisedAsks: w.asks.size,
            minutesPerAcceptedTask: measured ? w.minutes / w.accepted.size : null,
            measured, openTimer: w.open, timingRecords: w.measured, source: 'active-owner-time' };
        const signature = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
        if (old.get(value.weekStart)?.signature === signature) continue;
        pending.push({ type: 'owner-time-baseline', at: new Date(now).toISOString(), ...value, signature });
    }
    if (pending.length) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, pending.map((r) => JSON.stringify(r)).join('\n') + '\n');
        console.log(`owner-time-baseline: ${pending.length} weeks appended from ${events.length} events and ${accepts.size} accepted tasks; ${pending.filter((r) => r.measured).length} measured`);
    }
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error(`owner-time-baseline: ${e.message}`); process.exitCode = 2; } }
module.exports = { main, monday };
