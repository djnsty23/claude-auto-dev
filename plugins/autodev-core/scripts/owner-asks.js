#!/usr/bin/env node
'use strict';
/**
 * owner-asks.js - every question the fleet puts to its owner, with a receipt
 * trail, an inventory of where asks come from, and measured owner minutes.
 *
 * WHY. Before this, an ask was a file and a toast. fleet-notify.js stamped each
 * ask with its mtime, so a worker rewriting the same question re-raised it, and
 * the only delivery fact anyone had was that powershell exited 0. That exit says
 * the OS accepted a toast, never that a person saw it. A source that could not
 * be read was a population line on one page and absent from the other.
 *
 * FOUR RULES, each a check in tooling/test-owner-asks.js:
 *
 *   IDENTITY  An ask is keyed by its decision and its input version: the
 *             decision id (ask.json `decision`, else the channel that asked)
 *             and a sha256 of the question, the option labels and any declared
 *             inputs. File times never enter the key, so an unchanged ask
 *             re-raised N times is one ask with N raises.
 *   DELIVERY  Four states in order: queued (raised, nothing sent), os-submitted
 *             (the notifier returned, exit 0), receipted (the owner's own
 *             acknowledgement was recorded) and resolved (the owner answered).
 *             Delivery reads DELIVERED only from a receipt or a resolution.
 *             Everything before that reads UNKNOWN, never delivered.
 *   VISIBLE   Every expected source is listed with its state: ok, STALE (with
 *             its age), INACCESSIBLE (with the reason) or none-yet. Windows
 *             notification history has no supported adapter here, so it is
 *             always listed as INACCESSIBLE rather than left out.
 *   SILENCE   No authority comes from an unanswered ask. A `default`, `deadline`
 *             or `onTimeout` field in ask.json is recorded and never acted on.
 *
 * OWNER MINUTES. Active owner time is what the owner records: `time start`,
 * `time stop`, or `time correct --minutes N`. Acknowledgement latency is never
 * read as active time, and an open start counts nothing until it is stopped.
 *
 * STORE. `<autodev>/owner-asks/ledger.jsonl`, one JSON event per line, appended
 * only. A torn line is counted and reported, never silently dropped.
 *
 * Usage:
 *   node owner-asks.js status [--json] [--home <dir>] [--config-dir <dir>]
 *   node owner-asks.js ack --key <key> [--home <dir>]
 *   node owner-asks.js time start|stop [--note <text>] [--home <dir>]
 *   node owner-asks.js time correct --minutes <signed n> --note <text> [--home <dir>]
 *   node owner-asks.js --help
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const USAGE = [
    'Usage: node owner-asks.js status [--json] [--home <dir>] [--config-dir <dir>]',
    '       node owner-asks.js ack --key <key>          record the owner\'s receipt of one ask',
    '       node owner-asks.js time start|stop [--note <text>]   active owner time',
    '       node owner-asks.js time correct --minutes <signed n> --note <text>',
    'Delivery reads DELIVERED only from an owner receipt or answer. A notifier exit 0 is os-submitted: UNKNOWN.',
    'Every expected source is listed with ok, STALE, INACCESSIBLE or none-yet. Silence grants no authority.',
].join('\n') + '\n';

// The notifier task runs every 2 minutes by default (install-fleet-notify-task.ps1),
// 5 at most in its own docs. Seven missed passes at the slow setting is stale.
const STALE_MS = 35 * 60 * 1000;
const STATES = ['queued', 'os-submitted', 'receipted', 'resolved'];
const RECEIPTED = new Set(['receipted', 'resolved']);
const SILENCE_FIELDS = ['default', 'deadline', 'onTimeout', 'timeoutAction'];

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** JSON with sorted keys, so two equal inputs hash equal whatever order they were written in. */
function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}

function ledgerPath(autodev) { return path.join(autodev, 'owner-asks', 'ledger.jsonl'); }

/**
 * The identity of one ask: { decision, inputVersion, key }. `ask` is the parsed
 * ask.json (or a string that failed to parse), `fallbackDecision` names the
 * channel when the ask declares no decision id. `file` is provenance only.
 */
function askIdentity(ask, { fallbackDecision, file } = {}) {
    const a = ask && typeof ask === 'object' ? ask : { unparsed: String(ask) };
    const declared = a.decision || a.decisionId || a.id;
    const decision = String(declared || fallbackDecision || 'unnamed');
    const options = Array.isArray(a.options) ? a.options.map((o) => (o && typeof o === 'object' ? o.label : o)) : [];
    const input = { question: a.question === undefined ? null : a.question, options, inputs: a.inputs === undefined ? null : a.inputs };
    if (a.unparsed !== undefined) input.unparsed = a.unparsed;
    const inputVersion = sha256(canonical(input)).slice(0, 16);
    return { decision, inputVersion, key: `${decision}@${inputVersion}`, file: file || null };
}

/** Read an ask.json and return its identity, or null when the file is gone. */
function identityOfFile(file, fallbackDecision) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    let ask; try { ask = JSON.parse(raw); } catch { ask = raw; }
    return askIdentity(ask, { fallbackDecision, file });
}

function append(file, ev) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...ev });
    fs.appendFileSync(file, line + '\n', 'utf8');
    return JSON.parse(line);
}

function readLedger(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        return e.code === 'ENOENT' ? { ok: true, exists: false, events: [], torn: 0 } : { ok: false, exists: true, events: [], torn: 0, why: e.code || e.message };
    }
    const events = []; let torn = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { torn++; }
    }
    return { ok: true, exists: true, events, torn };
}

/** Record one raise. The caller passes an identity from askIdentity; extra fields are kept as provenance. */
function raise(file, id, extra = {}) {
    const silence = {};
    for (const f of SILENCE_FIELDS) if (extra.ask && extra.ask[f] !== undefined) silence[f] = extra.ask[f];
    return append(file, { type: 'raised', key: id.key, decision: id.decision, inputVersion: id.inputVersion, file: id.file,
        ...(Object.keys(silence).length ? { silenceFields: silence } : {}), ...(extra.source ? { source: extra.source } : {}) });
}
function submitted(file, key, via, exit = 0) { return append(file, { type: 'os-submitted', key, via, exit }); }
function receipt(file, key, how) { return append(file, { type: 'receipt', key, by: 'owner', how }); }
function resolve(file, key, label, how) { return append(file, { type: 'resolved', key, by: 'owner', label: String(label).slice(0, 200), how }); }

/** One entry per ask key: raises, its delivery state, and DELIVERED or UNKNOWN. */
function summarise(events) {
    const byKey = new Map();
    for (const ev of events) {
        if (!ev || !ev.key || ev.type === undefined || String(ev.type).startsWith('owner-time')) continue;
        let e = byKey.get(ev.key);
        if (!e) { e = { key: ev.key, decision: ev.decision || null, raises: 0, state: 'queued', firstAt: ev.at, events: [] }; byKey.set(ev.key, e); }
        e.events.push(ev);
        if (ev.type === 'raised') {
            e.raises++;
            if (ev.silenceFields) e.silenceFields = ev.silenceFields;
            // A raise after a resolution is a new round of the same decision and input.
            if (e.state === 'resolved') e.state = 'queued';
        } else if (ev.type === 'os-submitted') {
            if (e.state === 'queued') e.state = 'os-submitted';
        } else if (ev.type === 'receipt') {
            if (e.state !== 'resolved') e.state = 'receipted';
        } else if (ev.type === 'resolved') {
            e.state = 'resolved';
        }
    }
    const asks = [...byKey.values()].map((e) => ({ ...e, delivery: RECEIPTED.has(e.state) ? 'DELIVERED' : 'UNKNOWN' }));
    const counts = Object.fromEntries(STATES.map((s) => [s, asks.filter((a) => a.state === s).length]));
    return { asks, counts, unknown: asks.filter((a) => a.delivery === 'UNKNOWN').length };
}

/**
 * What the fleet may do about one ask. Authority comes only from the owner's
 * answer: a deadline that passed, a default option or an onTimeout field in the
 * ask grant nothing, and an unanswered ask always reads `wait`.
 */
function authority(entry) {
    const answer = [...(entry.events || [])].reverse().find((ev) => ev.type === 'resolved' && ev.by === 'owner');
    if (answer && entry.state === 'resolved') return { granted: true, action: 'act-on-answer', label: answer.label, from: 'owner-answer' };
    return { granted: false, action: 'wait', from: null };
}

/** How many granted authorities came from anything but an owner answer. Always 0 when authority() holds. */
function authorityFromSilence(summary) {
    return summary.asks.filter((a) => { const g = authority(a); return g.granted && g.from !== 'owner-answer'; }).length;
}

/**
 * Active owner minutes from the owner's own start/stop/correct records. A start
 * with no stop is open and counts nothing. Receipt latency never contributes.
 */
function ownerMinutes(events) {
    let ms = 0; let open = null; let corrections = 0; let pairs = 0;
    for (const ev of events) {
        if (ev.type === 'owner-time-start') { if (!open) open = ev; }
        else if (ev.type === 'owner-time-stop') {
            if (open) { const d = Date.parse(ev.at) - Date.parse(open.at); if (d > 0) { ms += d; pairs++; } open = null; }
        } else if (ev.type === 'owner-time-correct' && Number.isFinite(Number(ev.minutes))) {
            ms += Number(ev.minutes) * 60000; corrections++;
        }
    }
    return { minutes: Math.round((ms / 60000) * 10) / 10, pairs, corrections, open: open ? open.at : null };
}

function timeEvent(file, kind, { minutes, note } = {}) {
    if (kind === 'start') return append(file, { type: 'owner-time-start', note: note || null });
    if (kind === 'stop') return append(file, { type: 'owner-time-stop', note: note || null });
    if (kind === 'correct') {
        const m = Number(minutes);
        if (!Number.isFinite(m) || m === 0) fault('usage', 'time correct needs --minutes <nonzero signed number>');
        if (!note) fault('usage', 'time correct needs --note saying why');
        return append(file, { type: 'owner-time-correct', minutes: m, note });
    }
    fault('usage', `time ${kind}: expected start, stop or correct`);
}

function ageText(ms) { const m = Math.round(ms / 60000); return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`; }

/**
 * Every source owner asks come from or depend on, each with a state. Nothing is
 * left out for being unreadable: that is the point of the list.
 *   askSources  the population results fleet-view read for runs/ and the
 *               headless ledger: [{ source, readable, population }]
 *   notifyDir   the directory fleet-notify writes .notify-last-run.json into
 */
function inventory({ autodev, notifyDir, askSources = [], now = Date.now(), platform = process.platform, staleMs = STALE_MS }) {
    const list = [];
    for (const src of askSources) {
        list.push({ source: `asks:${src.source}`, state: src.readable ? 'ok' : 'INACCESSIBLE', detail: src.population });
    }
    const marker = path.join(notifyDir, '.notify-last-run.json');
    let m = null; let why = null;
    try { m = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) { why = e.code === 'ENOENT' ? `${marker} does not exist: the notifier never ran here` : `${marker}: ${e.code || e.message}`; }
    const at = m && Date.parse(m.at);
    if (!m || !Number.isFinite(at)) {
        const reason = why || `${marker} has no readable "at"`;
        list.push({ source: 'notifier', state: 'INACCESSIBLE', detail: reason });
        list.push({ source: 'desktop-panels', state: 'INACCESSIBLE', detail: `read only by the notifier, and ${reason}` });
    } else {
        const age = now - at;
        const stale = age > staleMs;
        list.push({ source: 'notifier', state: stale ? 'STALE' : 'ok', detail: `last pass ${ageText(age)} ago at ${m.at}${m.dry ? ' (dry)' : ''}` });
        list.push({ source: 'desktop-panels', state: stale ? 'STALE' : 'ok', detail: `${m.transcripts} transcript(s), ${m.blocked} blocked, read by the notifier ${ageText(age)} ago` });
    }
    const led = readLedger(ledgerPath(autodev));
    if (!led.ok) list.push({ source: 'owner-asks-ledger', state: 'INACCESSIBLE', detail: `${ledgerPath(autodev)}: ${led.why}` });
    else if (!led.exists) list.push({ source: 'owner-asks-ledger', state: 'none-yet', detail: `${ledgerPath(autodev)} does not exist: no ask was raised through it yet` });
    else list.push({ source: 'owner-asks-ledger', state: 'ok', detail: `${led.events.length} event(s)${led.torn ? `, ${led.torn} torn line(s)` : ''}` });
    // There is no supported adapter for Windows notification history (WinRT
    // ToastNotificationHistory needs the notifier's AppId and a packaged caller),
    // so whether a toast was seen is never read from Windows. Listed, not omitted.
    list.push({ source: 'windows-toast-history', state: 'INACCESSIBLE', detail: platform === 'win32'
        ? 'no supported adapter reads Windows notification history: an OS-submitted toast stays UNKNOWN until the owner records a receipt'
        : `not applicable on ${platform}: the toast notifier is Windows only, so delivery needs an owner receipt` });
    return list;
}

/** The view: summary, inventory and owner minutes for one autodev directory. */
function view({ autodev, notifyDir, askSources, now = Date.now(), platform } = {}) {
    const led = readLedger(ledgerPath(autodev));
    const sum = summarise(led.events);
    return {
        ledger: ledgerPath(autodev), counts: sum.counts, asks: sum.asks.map(({ events, ...a }) => a),
        deliveryUnknown: sum.unknown, authorityFromSilence: authorityFromSilence(sum),
        ownerMinutes: ownerMinutes(led.events), torn: led.torn,
        sources: inventory({ autodev, notifyDir, askSources, now, platform }),
    };
}

/** Lines for a text view: one summary line, then one line per source. */
function viewLines(v) {
    const c = v.counts;
    const out = [`owner-asks: ${v.asks.length} ask(s): queued ${c.queued}, os-submitted ${c['os-submitted']}, receipted ${c.receipted}, resolved ${c.resolved}; `
        + `delivery UNKNOWN for ${v.deliveryUnknown} without a receipt; authority from silence ${v.authorityFromSilence}; `
        + `owner minutes ${v.ownerMinutes.minutes}${v.ownerMinutes.open ? ` (a start since ${v.ownerMinutes.open} is open)` : ''}`];
    for (const s of v.sources) out.push(`owner-asks source ${s.source}: ${s.state} (${s.detail})`);
    return out;
}

function parseArgs(argv) {
    const out = { _: [] };
    const flags = ['json', 'help'];
    const known = [...flags, 'home', 'config-dir', 'key', 'minutes', 'note'];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const eq = a.indexOf('=');
        const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (!known.includes(key)) fault('usage', `unknown flag --${key}`);
        if (flags.includes(key)) { out[key] = true; continue; }
        const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined || value === '') fault('usage', `--${key} needs a value`);
        out[key] = value;
    }
    return out;
}

function main(argv) {
    const o = parseArgs(argv);
    if (o.help || !o._.length) { process.stdout.write(USAGE); return; }
    const home = path.resolve(o.home || process.env.USERPROFILE || process.env.HOME || os.homedir());
    const configDir = o['config-dir'] ? path.resolve(o['config-dir']) : path.join(home, '.claude');
    const autodev = path.join(configDir, 'autodev');
    const file = ledgerPath(autodev);
    const cmd = o._[0];
    if (cmd === 'status') {
        const v = view({ autodev, notifyDir: path.join(configDir, 'fleet') });
        process.stdout.write(o.json ? JSON.stringify(v) + '\n' : viewLines(v).join('\n') + '\n');
        return;
    }
    if (cmd === 'ack') {
        if (!o.key) fault('usage', 'ack needs --key');
        const known = summarise(readLedger(file).events).asks.some((a) => a.key === o.key);
        if (!known) fault('unknown-key', `no ask ${o.key} in ${file}`);
        receipt(file, o.key, 'owner-asks ack');
        process.stdout.write(`receipted ${o.key} in ${file}\n`);
        return;
    }
    if (cmd === 'time') {
        const ev = timeEvent(file, o._[1], { minutes: o.minutes, note: o.note });
        process.stdout.write(`recorded ${ev.type} at ${ev.at} in ${file}\n`);
        return;
    }
    fault('usage', `unknown command ${cmd}`);
}

if (require.main === module) {
    try { main(process.argv.slice(2)); } catch (e) {
        process.stderr.write(`owner-asks: ${e.publicCode || 'internal'}: ${e.message}\n`);
        process.exitCode = e.publicCode === 'usage' ? 2 : 1;
    }
}

module.exports = {
    STALE_MS, STATES, ledgerPath, askIdentity, identityOfFile, readLedger, raise, submitted, receipt, resolve,
    summarise, authority, authorityFromSilence, ownerMinutes, timeEvent, inventory, view, viewLines, canonical,
};
