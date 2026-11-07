#!/usr/bin/env node
'use strict';
/**
 * notify-policy.js - which events are worth the owner's attention now, and
 * where every other event goes.
 *
 * WHY. A fleet that pings on every state change trains its owner to mute it,
 * and a muted channel also hides the one ping that mattered. The rule is
 * narrow on purpose: the owner is interrupted for FOUR kinds of event, and
 * everything else lands in a daily digest the owner reads when they choose.
 *
 *   notify   blocked-on-owner   work stopped on a decision only the owner can make
 *            ready-to-merge     a PR with BOTH a review receipt (verdict approve)
 *                               AND a gate receipt in the event
 *            deploy-done        a production deploy passed its smoke check
 *            deploy-failed      a production deploy failed its smoke check
 *   digest   anything else, including a kind this file has never heard of
 *
 * FAIL CLOSED TOWARD THE DIGEST, NEVER TOWARD SILENCE. An unknown kind, an
 * event that is not an object, a missing kind, and a ready-to-merge without
 * both receipts all route to the digest, and each leaves one line there. A
 * silent drop would hide a new event kind until someone noticed the owner had
 * never been told about it. A ready-to-merge missing a receipt is "not ready":
 * it goes to the digest with the reason, so a pending review is visible
 * without interrupting anyone.
 *
 * EVENT. { kind, summary?, repo?, pr?, sha?, url?,
 *          reviewReceipt?: { verdict: 'approve' | ... },
 *          gateReceipt?: object | non-empty string path }
 * This module does not read receipt files and does not decide a receipt is
 * genuine: merge-lock.js does that. It checks that the event CLAIMS both, so a
 * caller cannot announce ready-to-merge with nothing behind it.
 *
 * DIGEST FILE. One line per event appended to
 * `<digest dir>/YYYY-MM-DD.md`, the date in the LOCAL time zone. The digest
 * dir is `$AUTODEV_DIGEST_DIR`, else `<config dir>/autodev/digest`.
 *
 * OWNER NOTIFICATIONS. emit() routes, and a 'notify' result is recorded as one
 * JSON line in `<notify dir>/owner.jsonl` (`$AUTODEV_NOTIFY_DIR`, else
 * `<config dir>/autodev/notify`) for whatever delivers to the owner (a toast
 * watcher, the Brain) to pick up. route() alone only decides and writes the
 * digest line for a digest event; it never delivers.
 *
 *   node notify-policy.js --kind <kind> [--summary TEXT] [--repo R] [--pr N]
 *        [--sha S] [--url U] [--review-receipt FILE] [--gate-receipt FILE]
 *        [--event-json FILE|-]
 *   node notify-policy.js --help
 *
 * Prints one line: `notify <kind>` or `digest <kind>`. Exit 0 routed,
 * 2 when the event could not be recorded (a digest or outbox line that could
 * not be written is never reported as delivered).
 *
 * Test seam: AUTODEV_NOTIFY_NOW is an ISO time that replaces the clock.
 */
const fs = require('node:fs');
const path = require('node:path');

const NOTIFY_KINDS = Object.freeze(['blocked-on-owner', 'ready-to-merge', 'deploy-done', 'deploy-failed']);
const MAX_SUMMARY = 300;

function configDir(env) {
    return require('./claude-paths.js').configDir(env);
}
function digestDir(env = process.env) {
    return path.resolve(env.AUTODEV_DIGEST_DIR || path.join(configDir(env), 'autodev', 'digest'));
}
function notifyDir(env = process.env) {
    return path.resolve(env.AUTODEV_NOTIFY_DIR || path.join(configDir(env), 'autodev', 'notify'));
}

function clock(env = process.env) {
    if (env.AUTODEV_NOTIFY_NOW) {
        const t = new Date(env.AUTODEV_NOTIFY_NOW);
        if (!Number.isNaN(t.getTime())) return t;
    }
    return new Date();
}

const pad = (n) => String(n).padStart(2, '0');
/** YYYY-MM-DD in the local time zone. */
function localDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function localTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

/** One line, no control characters, bounded. */
function oneLine(text, max = MAX_SUMMARY) {
    const s = String(text === undefined || text === null ? '' : text)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const has = (v) => (typeof v === 'string' && v.trim() !== '')
    || (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0);

/**
 * Decide an event: { route: 'notify' | 'digest', kind, reason }. Pure.
 * `reason` says why a digest event is a digest event.
 */
function decide(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return { route: 'digest', kind: '(not an event)', reason: 'the event is not an object' };
    }
    const kind = typeof event.kind === 'string' && event.kind.trim() ? event.kind.trim() : null;
    if (!kind) return { route: 'digest', kind: '(no kind)', reason: 'the event has no kind' };
    if (!NOTIFY_KINDS.includes(kind)) return { route: 'digest', kind, reason: 'not a kind that interrupts the owner' };
    if (kind === 'ready-to-merge') {
        const review = event.reviewReceipt;
        const approved = review && typeof review === 'object' && review.verdict === 'approve';
        if (!approved) return { route: 'digest', kind, reason: 'ready-to-merge without a review receipt whose verdict is approve' };
        if (!has(event.gateReceipt)) return { route: 'digest', kind, reason: 'ready-to-merge without a gate receipt' };
    }
    return { route: 'notify', kind, reason: null };
}

function describeEvent(event, kind) {
    const parts = [];
    if (event && typeof event === 'object' && !Array.isArray(event)) {
        if (event.repo) parts.push(event.pr ? `${oneLine(event.repo, 80)}#${oneLine(event.pr, 12)}` : oneLine(event.repo, 80));
        else if (event.pr) parts.push(`#${oneLine(event.pr, 12)}`);
        if (event.sha) parts.push(oneLine(event.sha, 12));
        if (event.url) parts.push(oneLine(event.url, 160));
        if (event.summary) parts.push(oneLine(event.summary));
    }
    return parts.join(' | ') || kind;
}

/** Append one line to today's digest. { ok, file, why }. */
function appendDigest(event, decision, env = process.env) {
    const now = clock(env);
    const dir = digestDir(env);
    const file = path.join(dir, `${localDate(now)}.md`);
    const note = oneLine(decision.reason ? `(${decision.reason})` : '', 160);
    const line = `- ${localTime(now)} ${oneLine(decision.kind, 80)}: ${describeEvent(event, decision.kind)}${note ? ' ' + note : ''}\n`;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const header = fs.existsSync(file) ? '' : `# Digest ${localDate(now)}\n\n`;
        fs.appendFileSync(file, header + line, 'utf8');
        return { ok: true, file, why: null };
    } catch (e) {
        return { ok: false, file, why: e.code || e.message };
    }
}

/**
 * Route an event. Returns 'notify' or 'digest'. A digest event is appended to
 * the day's digest before this returns. Never throws: a digest that cannot be
 * written still returns 'digest', and the failure is on `route.lastWrite`.
 */
function route(event, env = process.env) {
    const d = decide(event);
    route.lastWrite = d.route === 'digest' ? appendDigest(event, d, env) : { ok: true, file: null, why: null };
    return d.route;
}
route.lastWrite = null;

/**
 * Route and, for 'notify', record the owner notification. Returns
 * { route, kind, ok, file, why }: ok is false when the line could not be
 * written, so a caller never reports a notification that was not recorded.
 */
function emit(event, env = process.env) {
    const d = decide(event);
    if (d.route === 'digest') {
        const w = appendDigest(event, d, env);
        return { route: 'digest', kind: d.kind, ok: w.ok, file: w.file, why: w.why };
    }
    const now = clock(env);
    const dir = notifyDir(env);
    const file = path.join(dir, 'owner.jsonl');
    const row = {
        schema: 1, at: now.toISOString(), kind: d.kind, text: describeEvent(event, d.kind),
        repo: event.repo || null, pr: event.pr === undefined ? null : event.pr, sha: event.sha || null, url: event.url || null,
    };
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
        return { route: 'notify', kind: d.kind, ok: true, file, why: null };
    } catch (e) {
        return { route: 'notify', kind: d.kind, ok: false, file, why: e.code || e.message };
    }
}

// ---------------------------------------------------------------------- CLI

const USAGE = [
    'notify-policy.js - route an event to the owner (notify) or the daily digest',
    '',
    '  node notify-policy.js --kind <kind> [--summary TEXT] [--repo R] [--pr N] [--sha S] [--url U]',
    '       [--review-receipt FILE] [--gate-receipt FILE] [--event-json FILE|-]',
    '',
    `notify kinds: ${NOTIFY_KINDS.join(', ')}. Every other kind, including an unknown one, goes to the digest.`,
    'ready-to-merge needs --review-receipt (verdict approve) AND --gate-receipt, else it is a digest line.',
    'env: AUTODEV_DIGEST_DIR, AUTODEV_NOTIFY_DIR (default under <config dir>/autodev)',
    'Prints `notify <kind>` or `digest <kind>`. Exit 0 routed and recorded, 2 not recorded or bad input.',
].join('\n');

function readJson(file, label) {
    let raw;
    try { raw = fs.readFileSync(file === '-' ? 0 : file, 'utf8'); } catch (e) { throw new Error(`${label}: cannot read (${e.code || e.message})`); }
    try { return JSON.parse(raw); } catch { throw new Error(`${label}: not JSON`); }
}

function eventFromArgs(argv) {
    const a = {};
    const flags = new Set(['kind', 'summary', 'repo', 'pr', 'sha', 'url', 'review-receipt', 'gate-receipt', 'event-json']);
    for (let i = 0; i < argv.length; i++) {
        const m = /^--([a-z-]+)$/.exec(argv[i]);
        if (!m || !flags.has(m[1])) throw new Error(`unrecognised argument: ${argv[i]}`);
        if (argv[i + 1] === undefined) throw new Error(`--${m[1]} needs a value`);
        a[m[1]] = argv[++i];
    }
    let event = {};
    if (a['event-json']) event = readJson(a['event-json'], '--event-json');
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('--event-json: not an object');
    for (const k of ['kind', 'summary', 'repo', 'pr', 'sha', 'url']) if (a[k] !== undefined) event[k] = a[k];
    if (a['review-receipt']) event.reviewReceipt = readJson(a['review-receipt'], '--review-receipt');
    if (a['gate-receipt'] && fs.existsSync(a['gate-receipt'])) event.gateReceipt = path.resolve(a['gate-receipt']);
    return event;
}

function main(argv, env = process.env) {
    if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
        process.stdout.write(USAGE + '\n');
        return argv.length === 0 ? 2 : 0;
    }
    let event;
    try { event = eventFromArgs(argv); } catch (e) {
        process.stderr.write(`notify-policy: ${e.message}\n`);
        return 2;
    }
    const r = emit(event, env);
    if (!r.ok) {
        process.stderr.write(`notify-policy: ${r.route} ${r.kind} was NOT recorded (${r.why})\n`);
        return 2;
    }
    process.stdout.write(`${r.route} ${r.kind}\n`);
    return 0;
}

module.exports = { NOTIFY_KINDS, decide, route, emit, digestDir, notifyDir, localDate, oneLine };

if (require.main === module) {
    // process.exitCode, never process.exit(): a pending stdout write is not truncated.
    process.exitCode = main(process.argv.slice(2));
}
