'use strict';
// usage-limit-hold.js - when a run ended on the account's usage limit, the next
// unattended launch waits. Pure over the headless ledger and each run's own log:
// there is no hold file to go stale, repair or clear.
//
// WHY. `[measured 2026-11-09]` four runs in one night ended on the weekly limit and
// two of them were launched after it was already hit. Each such launch is a wasted
// run and a record someone has to settle.
//
// THE RULE, decided 2026-11-10.
//   - A run ended on the limit when the LAST result event of its log is an error
//     event whose text starts "You've hit your ... limit". It holds from then on,
//     settled or not: a run started directly has nobody settling it soon after.
//   - The hold lifts 2 minutes after the reset time the limit message states.
//   - A message with no reset time this parser can read holds for 60 minutes after
//     the ending. Unreadable means any of: no time, an unknown zone, a date that does
//     not exist, a wall-clock time a daylight change skips, or a reset that is not
//     in the 8 days after the ending. It never guesses a zone.
//   - Every limit ending is computed separately and the latest lift wins, so a later
//     run settling on the limit extends the hold and can never shorten it.
//   - One config dir is one login, so the hold is per config dir.
//
// THE FORMAT IS OBSERVED. `[measured 2026-11-10]` every limit text in the recorded
// worker logs is one of these three shapes:
//   You've hit your session limit · resets 5:30am (Europe/Bucharest)
//   You've hit your weekly limit · resets 8pm (Europe/Bucharest)
//   You've hit your weekly limit · resets Nov 11, 1am (Europe/Bucharest)
// A time with no date is the next time that wall clock comes round after the ending.
// A date with no year is the next such date after the ending. A wall-clock time a
// daylight change repeats takes the later instant, the one that cannot lift early.
const fs = require('fs');

const LIMIT_ENDING_RE = /^You['’]ve hit your\b[^.\n]{0,40}\blimit\b/;
const RESET_RE = /\bresets\s+(?:([A-Z][a-z]{2})\s+(\d{1,2}),\s+)?(\d{1,2})(?::(\d{2}))?(am|pm)\s+\(([^()\s]+)\)\s*$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const RESET_MARGIN_MS = 2 * MINUTE;
const NO_RESET_HOLD_MS = 60 * MINUTE;
const MAX_RESET_AHEAD_MS = 8 * DAY;
// A log last written longer ago than this cannot hold anything: no reset is accepted further out.
const LOG_MAX_AGE_MS = MAX_RESET_AHEAD_MS + RESET_MARGIN_MS;
const HOLD_CODE = 'usage-limit-hold';
const TEXT_MAX = 300;

/** The last stream-json result event of a log, or null. */
function lastResultEvent(logText) {
    let last = null;
    for (const line of String(logText || '').split(/\r?\n/)) {
        if (!line.startsWith('{') || !line.includes('"type":"result"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j && j.type === 'result') last = j;
    }
    return last;
}

// Only the last result event counts, it must be an error event, and the text is
// anchored: a worker's closing message that quotes a limit is neither.
/** The text of a usage-limit ending, from the LAST result event of a log, or null. */
function usageLimit(logText) {
    const last = lastResultEvent(logText);
    if (!last || last.is_error !== true || typeof last.result !== 'string') return null;
    const t = last.result.trim();
    return LIMIT_ENDING_RE.test(t) ? t.slice(0, TEXT_MAX) : null;
}

/** The wall clock of an instant in a zone, as numbers. Throws RangeError on an unknown zone. */
function wallOf(atMs, zone) {
    const parts = {};
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    for (const p of f.formatToParts(new Date(atMs))) parts[p.type] = Number(p.value);
    return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour, mi: parts.minute };
}

const sameWall = (a, b) => a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi;
const asUtc = (w) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);

/**
 * The instant of a wall-clock time in a zone, or null when that wall clock never
 * happens there (a date like Feb 30, or a time a daylight change skips). The zone's
 * offset is sampled a day either side, so a time a change repeats has two answers,
 * and the later one is returned.
 */
function instantOf(wall, zone) {
    const guess = asUtc(wall);
    const found = [guess - DAY, guess + DAY].map((probe) => guess - (asUtc(wallOf(probe, zone)) - probe))
        .filter((at) => sameWall(wallOf(at, zone), wall));
    return found.length ? Math.max(...found) : null;
}

/** The reset instant a limit message states, in epoch ms, or null when it cannot be read. */
function parseResetAt(text, endedAtMs) {
    const m = RESET_RE.exec(String(text || ''));
    if (!m || !Number.isFinite(endedAtMs)) return null;
    const [, mon, dayText, hourText, minText, ampm, zone] = m;
    const hour12 = Number(hourText);
    const mi = minText === undefined ? 0 : Number(minText);
    if (hour12 < 1 || hour12 > 12 || mi > 59) return null;
    const h = (hour12 % 12) + (ampm === 'pm' ? 12 : 0);
    let at;
    try {
        const ended = wallOf(endedAtMs, zone);
        if (mon !== undefined) {
            const mo = MONTHS.indexOf(mon) + 1;
            if (mo === 0) return null;
            const d = Number(dayText);
            at = instantOf({ y: ended.y, mo, d, h, mi }, zone);
            if (at !== null && at <= endedAtMs) at = instantOf({ y: ended.y + 1, mo, d, h, mi }, zone);
        } else {
            at = instantOf({ y: ended.y, mo: ended.mo, d: ended.d, h, mi }, zone);
            if (at !== null && at <= endedAtMs) {
                const next = new Date(Date.UTC(ended.y, ended.mo - 1, ended.d + 1));
                at = instantOf({ y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate(), h, mi }, zone);
            }
        }
    } catch { return null; }
    if (at === null || at <= endedAtMs || at - endedAtMs > MAX_RESET_AHEAD_MS) return null;
    return at;
}

/** When one limit ending stops holding launches, in epoch ms. The rule is in this file's header. */
function liftAt(text, endedAtMs) {
    const reset = parseResetAt(text, endedAtMs);
    return reset !== null ? reset + RESET_MARGIN_MS : endedAtMs + NO_RESET_HOLD_MS;
}

const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };

/** The limit ending a ledger record carries, as {text, endedAt}, or null. */
function endingOf(rec, now) {
    if (rec.state === 'settled') {
        const stamped = rec.usageLimit && typeof rec.usageLimit === 'object' ? rec.usageLimit : null;
        const text = stamped ? stamped.text : rec.blocker && rec.blocker.status === 'usage-limit' ? rec.blocker.text : null;
        if (typeof text === 'string') {
            const endedAt = (stamped && ms(stamped.endedAt)) ?? ms(rec.settledAt) ?? ms(rec.startedAt);
            return endedAt === null ? null : { text, endedAt };
        }
        // `[measured 2026-11-10]` every limit ending settled before settle stamped usageLimit
        // carries a blocker of unknown or stated, so only its log can say how it ended.
    }
    if (!rec.log) return null;
    let log;
    let endedAt;
    try {
        endedAt = fs.statSync(rec.log).mtimeMs;
        // Records are never pruned while unsettled, so this is what keeps the cost flat.
        if (now - endedAt > LOG_MAX_AGE_MS) return null;
        log = fs.readFileSync(rec.log, 'utf8');
    } catch { return null; }
    if (!/^CLAUDE_EXIT=/m.test(log)) return null;
    const text = usageLimit(log);
    return text ? { text, endedAt } : null;
}

const holdLine = (untilIso, cfg) => `launch hold: usage limit until ${untilIso}${cfg ? ` (config dir ${cfg})` : ''}`;

/**
 * The live hold of every config dir in these records, newest lift first:
 * [{ configDir, until, code, text, line }]. Empty when nothing holds.
 */
function limitHolds(records, now = Date.now()) {
    const best = new Map();
    for (const rec of records || []) {
        const ending = endingOf(rec, now);
        if (!ending) continue;
        const cfg = rec.configDir || null;
        const lift = liftAt(ending.text, ending.endedAt);
        // A corrupt ending past the Date range would throw below, on a path every tick runs.
        if (Number.isNaN(new Date(lift).getTime())) continue;
        if (!best.has(cfg) || lift > best.get(cfg).lift) best.set(cfg, { lift, code: rec.code, text: ending.text });
    }
    return [...best].filter(([, b]) => b.lift > now).sort((a, b) => b[1].lift - a[1].lift).map(([configDir, b]) => {
        const until = new Date(b.lift).toISOString();
        return { configDir, until, code: b.code, text: b.text, line: holdLine(until, configDir) };
    });
}

/** The live hold on one config dir (a basename, null for the default login), or null. */
function limitHold(records, cfg = null, now = Date.now()) {
    return limitHolds(records, now).find((h) => h.configDir === cfg) || null;
}

module.exports = { HOLD_CODE, lastResultEvent, usageLimit, parseResetAt, liftAt, limitHolds, limitHold };
