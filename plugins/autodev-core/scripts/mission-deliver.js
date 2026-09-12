#!/usr/bin/env node
'use strict';
/**
 * mission-deliver.js — the coordinator's side of the mission store's outbox
 * (backlog item B07): consume a worker's durable result once, acknowledge it,
 * and keep sent, received and accepted apart.
 *
 * WHY. A worker that finishes in one turn may never see a later Stop; a cooldown
 * or a crash can swallow its report. The worker therefore enqueues its result in
 * the store before it exits (mission-dispatch.js's protocol requires it), and this
 * script is what turns that durable row into a consumed one. Nothing here
 * depends on a hook firing, a message arriving, or a coordinator being awake at
 * the moment the worker stopped.
 *
 * WHAT IT DOES. `deliver` walks every unacknowledged outbox row of a mission. If
 * an ingestion receipt for that attempt is already saved (a previous run lost
 * its acknowledgement), it acknowledges from the receipt and spends no send. If
 * the row's send budget is exhausted it says so and stops. Otherwise it spends one
 * send (`begin-delivery`), ingests the payload (`receive`, which quarantines a
 * result from a retired attempt instead of dropping it) and acknowledges with the
 * receipt the ingestion returned. Every event id is derived from the message and
 * the send number, so re-running is idempotent by construction: the store answers
 * a replayed event with its first answer. `accept` records that a received
 * envelope matches the contract (metadata only); `reject` records that its
 * evidence was refused; `status` counts pending, sent, exhausted, acknowledged,
 * received, quarantined, rejected and accepted separately.
 *
 * WHAT IT IS NOT. The receiver is THIS store: one user, one machine, the
 * coordinator and its workers sharing a private store. A coordinator on another
 * host needs a transport adapter that does not exist yet; this script does not
 * pretend to reach one. Acceptance here validates declared metadata, never
 * execution or artifacts; every answer says `verified: false`.
 *
 * Usage:
 *   node mission-deliver.js deliver --store <dir> --mission <id>
 *   node mission-deliver.js accept  --store <dir> --mission <id> --owner <name> --attempt <id> --generation <n> --result <id>
 *   node mission-deliver.js reject  --store <dir> --mission <id> --owner <name> --attempt <id> --generation <n> --result <id> --code <evidence-rejected|context-invalid|hook-blocked>
 *   node mission-deliver.js status  --store <dir> --mission <id>
 * Output: {"ok":true,"value":...} exit 0; {"ok":false,"error":{"code","message"}} exit 1.
 */
const path = require('node:path');
const { execute } = require('./mission-store.js');

const USAGE = [
    'Usage: node mission-deliver.js deliver --store <dir> --mission <id>',
    '       node mission-deliver.js accept  --store <dir> --mission <id> --owner <name> --attempt <id> --generation <n> --result <id>',
    '       node mission-deliver.js reject  --store <dir> --mission <id> --owner <name> --attempt <id> --generation <n> --result <id> --code <evidence-rejected|context-invalid|hook-blocked>',
    '       node mission-deliver.js status  --store <dir> --mission <id>',
    'deliver: consume every unacknowledged outbox row once (a saved ingestion receipt is acknowledged',
    '         without spending a send; an exhausted row is reported, not retried). Re-running is idempotent.',
    'accept / reject: record the coordinator\'s verdict on a received envelope (metadata only, never verification).',
    'status:  pending, sent, exhausted, acked, received, quarantined, rejected and accepted, counted apart.',
    'Receiver: this store, one user, one machine. A remote coordinator needs a transport adapter that does not exist.',
].join('\n') + '\n';

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }
function word(s) { return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s); }
function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const eq = a.indexOf('='); const key = eq > 0 ? a.slice(2, eq) : a.slice(2); const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined) fault('usage', `--${key} needs a value`);
        if (Object.prototype.hasOwnProperty.call(out, key)) fault('usage', `--${key} given twice`);
        out[key] = value;
    }
    const known = ['_', 'help', 'store', 'mission', 'owner', 'attempt', 'generation', 'result', 'code'];
    for (const k of Object.keys(out)) if (!known.includes(k)) fault('usage', `unknown flag --${k}`);
    return out;
}
const call = (store, command, payload) => execute(command, store, payload);
const status = (store, missionId) => call(store, 'status', { missionId });

function deliver(store, missionId) {
    const s = status(store, missionId);
    const report = [];
    for (const row of s.outbox.filter((b) => b.state !== 'acked')) {
        const saved = s.results.find((r) => r.attempt_id === row.attempt_id);
        if (saved) {
            // The ingestion already happened; only the acknowledgement was lost.
            try { call(store, 'ack-delivery', { missionId, eventId: 'ack:' + row.message_id, messageId: row.message_id, receipt: JSON.parse(saved.ingestion_receipt) }); report.push({ messageId: row.message_id, state: 'acked', via: 'saved-receipt', resultState: saved.state, sendCount: row.send_count }); }
            catch (e) { report.push({ messageId: row.message_id, state: e.publicCode || 'error', via: 'saved-receipt', sendCount: row.send_count }); }
            continue;
        }
        if (row.state === 'exhausted') { report.push({ messageId: row.message_id, state: 'delivery-exhausted', sendCount: row.send_count }); continue; }
        let delivery;
        try { delivery = call(store, 'begin-delivery', { missionId, eventId: `send:${row.message_id}:${row.send_count + 1}`, messageId: row.message_id }); }
        catch (e) { report.push({ messageId: row.message_id, state: e.publicCode || 'error', sendCount: row.send_count }); continue; }
        const p = delivery.payload;
        const receipt = call(store, 'receive', { missionId, eventId: `receive:${row.message_id}:${delivery.sendCount}`, owner: p.owner, attemptId: p.attemptId, generation: p.generation, result: p.result });
        call(store, 'ack-delivery', { missionId, eventId: 'ack:' + row.message_id, messageId: row.message_id, receipt });
        report.push({ messageId: row.message_id, state: 'acked', via: 'sent', sendCount: delivery.sendCount, resultState: receipt.state });
    }
    return { missionId, delivered: report, ...counters(status(store, missionId)), verified: false };
}
function counters(s) {
    const c = { pending: 0, sent: 0, exhausted: 0, acked: 0, received: 0, quarantined: 0, rejected: 0, accepted: 0 };
    for (const b of s.outbox) { if (b.state === 'acked') c.acked++; else if (b.state === 'exhausted') c.exhausted++; else if (b.send_count > 0) c.sent++; else c.pending++; }
    for (const r of s.results) { if (r.state === 'received') c.received++; else if (r.state === 'quarantined') c.quarantined++; else if (r.state === 'rejected') c.rejected++; else if (r.state === 'envelope-accepted') c.accepted++; }
    return { counters: c, mission: { state: s.mission.state, attemptCount: s.mission.attemptCount, activeAttempt: s.mission.activeAttempt } };
}
function fence(opts) {
    for (const r of ['owner', 'attempt', 'generation', 'result']) if (!opts[r]) fault('usage', `--${r} is required`);
    const generation = Number(opts.generation); if (!Number.isSafeInteger(generation) || generation < 1) fault('usage', '--generation must be a positive integer');
    if (!word(opts.result)) fault('usage', '--result must be a mission word');
    return { missionId: opts.mission, owner: opts.owner, attemptId: opts.attempt, generation };
}

module.exports = { deliver, counters, parseArgs };

if (require.main === module) {
    try {
        const opts = parseArgs(process.argv.slice(2));
        if (opts.help || !opts._.length) { process.stdout.write(USAGE); }
        else {
            const cmd = opts._[0];
            if (opts._.length !== 1 || !['deliver', 'accept', 'reject', 'status'].includes(cmd)) fault('usage', 'command must be deliver, accept, reject or status');
            for (const r of ['store', 'mission']) if (!opts[r]) fault('usage', `--${r} is required`);
            if (!word(opts.mission)) fault('usage', '--mission must be a mission word');
            const store = path.resolve(opts.store);
            let value;
            if (cmd === 'deliver') value = deliver(store, opts.mission);
            else if (cmd === 'status') value = { missionId: opts.mission, ...counters(status(store, opts.mission)), verified: false };
            else if (cmd === 'accept') { const f = fence(opts); value = { ...call(store, 'accept-envelope', { ...f, eventId: 'accept:' + opts.result, resultId: opts.result }), verified: false }; }
            else { const f = fence(opts); if (!['evidence-rejected', 'context-invalid', 'hook-blocked'].includes(opts.code)) fault('usage', '--code must be evidence-rejected, context-invalid or hook-blocked'); value = { ...call(store, 'reject-result', { ...f, eventId: `reject:${opts.result}:${opts.code}`, resultId: opts.result, code: opts.code }), verified: false }; }
            process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
        }
    } catch (e) {
        const code = e.publicCode || (e.errcode === 5 || e.errcode === 6 ? 'store-busy' : 'error');
        process.stdout.write(JSON.stringify({ ok: false, error: { code, message: e.publicCode ? e.message : code } }) + '\n'); process.exitCode = 1;
    }
}
