#!/usr/bin/env node
/**
 * live-edit.js - a localhost page that shows an edit within seconds and draws,
 * on the page itself, how long until that edit would be live in production.
 *
 * WHY. The edit loop already exists: a dev server hot-reloads a saved file in
 * under a second. What it lacks is the second half of the question, "and when
 * would that be live?". The answer is a sum the machine has already measured
 * (gate, review, the wait for the next landing slot, the host's build), so it
 * can be drawn next to the change instead of guessed in chat.
 *
 * HOW. `serve` puts a small proxy in front of the dev server and adds one
 * script tag to every HTML response. The tag loads an overlay from the proxy,
 * which polls the proxy for the working tree's pending changes and the ETA.
 * Nothing is written to the site's repository, so a production build cannot
 * contain the overlay: there is no code for it to ship. The proxy listens on
 * 127.0.0.1 only and refuses a request whose Host is not a loopback name.
 *
 *   node live-edit.js serve --dir SITE --port 3417 [--upstream URL | -- COMMAND...]
 *                           [--base origin/main] [--calibration FILE] [--variant pill|bar|dot]
 *                           [--headline queue|direct]
 *       Without --upstream it starts the dev server itself (`npm run dev -- --port N`
 *       in SITE, or COMMAND, with PORT set to a free port) and stops it on exit.
 *   node live-edit.js state --dir SITE [--base REF] [--calibration FILE]
 *       The JSON the overlay draws: pending changes, lane and ETA.
 *   node live-edit.js note --dir SITE --text "what changed"
 *       One line per instruction, kept in the git dir, never in the tree.
 *   node live-edit.js calibrate --repo OWNER/NAME --out FILE [--locks-dir DIR] [--min-hold MIN]
 *                           [--fast-receipts PATH,..] [--review-receipts PATH,..] [--review-any-repo]
 *                           [--deployments FILE] [--merges FILE] [--land-minutes 37] [--since ISO]
 *       Builds the samples file from records already on disk and from two JSON
 *       files the caller fetched (the host's deployments, the merged pull requests).
 *       `serve` and `state` read <git common dir>/live-edit/calibration.json when no
 *       --calibration is named, so one file serves every worktree of a clone.
 *   node live-edit.js backtest --calibration FILE --cases FILE
 *       Predicted against actual for past merges: [{ pr, pushedAt, liveAt, lane }].
 *   node live-edit.js --help
 *
 * THE ETA. Every part is the median of measured samples, with the 10th and
 * 90th percentile as its range. The parts in order: the gate (the fast lane
 * when fast-lane.js's classifier accepts the working tree's diff, else the
 * full gate), the review, the wait until the next landing slot plus the time
 * that slot takes to merge, and the host's build. The total is the sum along
 * that path, computed three times (low, median, high), because the slot a
 * change catches depends on when its gate ends. A part with no samples is
 * "not measured": it adds nothing and the total is marked partial. No number
 * here is a default. `direct` is the other path, a merge outside the landing
 * queue, from the measured push-to-merge time of such merges. --headline picks
 * which path is the large number. The other one stays in the panel as a row.
 *
 * LIMITS. A page whose Content-Security-Policy pins scripts by nonce gets the
 * page's own nonce on the tag. A policy that pins by hash refuses the overlay.
 * A release record has minute resolution, so a gate sample is exact to a
 * minute. The landing minutes are local time, as a cron line is.
 *
 * EXIT. state, note, calibrate, backtest: 0 done, 1 bad arguments or an
 * unreadable input. serve: the dev server's exit code, or 1 when the port
 * cannot be bound.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TAG = 'live-edit:';
const KIND = 'autodev-live-edit-calibration';
const VERSION = 1;
const PREFIX = '/__live-edit/';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const PARTS = ['gateFull', 'gateFast', 'review', 'land', 'build', 'direct'];
const VARIANTS = ['pill', 'bar', 'dot'];
const MIN = 60e3;
const MAX_LINES = 6;
const KEEP = 10;

// ---------------------------------------------------------------------------
// Numbers and words
// ---------------------------------------------------------------------------

/** Median, 10th and 90th percentile of a list of milliseconds, or null when it is empty. */
function stats(ms) {
    const s = (Array.isArray(ms) ? ms : []).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    if (!s.length) return null;
    const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
    const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    return { n: s.length, low: at(0.1), median: mid, high: at(0.9) };
}

/** "45 s", "21 min", "2 h 5 min". */
function fmtDuration(ms) {
    if (!Number.isFinite(ms)) return 'not measured';
    if (ms < 90e3) return `${Math.max(1, Math.round(ms / 1e3))} s`;
    const min = Math.round(ms / MIN);
    if (min < 90) return `${min} min`;
    return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min / 60} h`;
}

/** Local "15:42", with the day named when it is not the day of `now`. */
function fmtClock(ms, now) {
    const d = new Date(ms);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const day = (t) => { const x = new Date(t); return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()); };
    const days = Math.round((day(ms) - day(now)) / (24 * 60 * MIN));
    if (days === 0) return hm;
    return days === 1 ? `tomorrow ${hm}` : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

/** "37" or "7,37" as a sorted list of minutes past the hour, null for none. Throws on anything else. */
function parseLandMinutes(text) {
    if (text === undefined || text === null || text === '' || text === 'none') return null;
    const list = String(text).split(',').map((p) => p.trim());
    const out = list.map(Number);
    if (out.some((n, i) => !/^\d{1,2}$/.test(list[i]) || n > 59)) throw new Error(`--land-minutes takes minutes past the hour (37 or 7,37), got ${JSON.stringify(text)}`);
    return [...new Set(out)].sort((a, b) => a - b);
}

/** The first landing slot strictly after `t`, in local time. `t` itself when there are no slots. */
function nextSlot(t, minutes) {
    if (!minutes || !minutes.length) return t;
    const d = new Date(t);
    d.setSeconds(0, 0);
    for (let i = 0; i < 61 * 2; i++) {
        d.setMinutes(d.getMinutes() + 1);
        if (minutes.includes(d.getMinutes())) return d.getTime();
    }
    return t;
}

/** The last landing slot at or before `t`. */
function lastSlot(t, minutes) {
    const d = new Date(t);
    d.setSeconds(0, 0);
    for (let i = 0; i < 61; i++) {
        if (minutes.includes(d.getMinutes())) return d.getTime();
        d.setMinutes(d.getMinutes() - 1);
    }
    return t;
}

// ---------------------------------------------------------------------------
// The ETA: a pure function of the samples, the lane and the clock
// ---------------------------------------------------------------------------

/** Reads a calibration file. Returns { ok, calibration } or { ok: false, why }. */
function readCalibration(file) {
    if (!file) return { ok: false, why: 'no calibration file was named' };
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, why: `cannot read ${path.basename(file)}: ${e.code || e.message}` }; }
    if (!j || j.kind !== KIND || !j.parts || typeof j.parts !== 'object') return { ok: false, why: `${path.basename(file)} is not a ${KIND} file` };
    return { ok: true, calibration: j };
}

/**
 * The estimate for a change whose gate starts at `now`.
 * lane is 'fast' or 'full'. Returns { partial, medianMs, lowMs, highMs, liveAt, parts, direct, measuredAt }.
 */
function estimate(calibration, lane, now) {
    const sample = (key) => stats(calibration.parts[key] && calibration.parts[key].ms);
    const fast = lane === 'fast' ? sample('gateFast') : null;
    const gate = fast || sample('gateFull');
    const gateLabel = fast ? 'Gate (fast lane)' : lane === 'fast' ? 'Gate (full, fast lane not measured)' : 'Gate (full)';
    const review = sample('review');
    const land = sample('land');
    const build = sample('build');
    const minutes = Array.isArray(calibration.landMinutes) && calibration.landMinutes.length ? calibration.landMinutes : null;
    const of = (s, q) => (s ? s[q] : 0);
    const walk = (q) => {
        const ready = now + of(gate, q) + of(review, q);
        const slot = nextSlot(ready, minutes);
        const merged = slot + of(land, q);
        return { ready, slot, merged, live: merged + of(build, q) };
    };
    const lo = walk('low');
    const mid = walk('median');
    const hi = walk('high');
    const part = (key, label, s, extra) => ({
        key, label, measured: Boolean(s), n: s ? s.n : 0,
        medianMs: s ? s.median : null, lowMs: s ? s.low : null, highMs: s ? s.high : null,
        text: s ? fmtDuration(s.median) : 'not measured', ...extra,
    });
    const slotMs = mid.merged - mid.ready;
    const parts = [
        part('gate', gateLabel, gate),
        part('review', 'Review', review),
        {
            key: 'slot', label: minutes ? `Landing slot ${fmtClock(mid.slot, now)}` : 'Merge', measured: Boolean(land) || Boolean(minutes), n: land ? land.n : 0,
            medianMs: slotMs, lowMs: lo.merged - lo.ready, highMs: hi.merged - hi.ready, text: fmtDuration(slotMs),
            slotAt: minutes ? mid.slot : null, waitMs: mid.slot - mid.ready,
        },
        part('build', 'Production build', build),
    ];
    const d = sample('direct');
    const direct = d && build ? {
        n: d.n, mergeMs: d.median, buildMs: build.median, medianMs: d.median + build.median, lowMs: d.low + build.low, highMs: d.high + build.high,
        liveAt: now + d.median + build.median, text: fmtDuration(d.median + build.median), clock: fmtClock(now + d.median + build.median, now),
    } : null;
    const medianMs = mid.live - now;
    const lowMs = Math.min(lo.live - now, medianMs);
    const highMs = Math.max(hi.live - now, medianMs);
    return {
        partial: parts.some((p) => !p.measured), medianMs, lowMs, highMs,
        liveAt: mid.live, liveAtLow: now + lowMs, liveAtHigh: now + highMs,
        text: fmtDuration(medianMs), clock: fmtClock(mid.live, now),
        rangeText: fmtDuration(lowMs) === fmtDuration(highMs) ? `${fmtClock(now + lowMs, now)} to ${fmtClock(now + highMs + MIN, now)}` : `${fmtDuration(lowMs)} to ${fmtDuration(highMs)}`,
        thin: parts.filter((p) => p.measured && p.n > 0 && p.n < 3).map((p) => `${p.label.toLowerCase()} has ${p.n} sample${p.n === 1 ? '' : 's'}`),
        parts, direct, measuredAt: calibration.measuredAt || null, repo: calibration.repo || null,
    };
}

/**
 * What the overlay prints: one path as the headline, the other as a row.
 * headline is 'queue' (wait for the landing slot) or 'direct' (a merge outside
 * the queue). A direct headline with no direct samples falls back to the queue.
 */
function headlineView(eta, headline) {
    const d = eta.direct;
    if (headline === 'direct' && d) {
        return {
            path: 'direct', text: d.text, clock: d.clock, rangeText: `${fmtDuration(d.lowMs)} to ${fmtDuration(d.highMs)}`,
            rows: [
                { label: 'Gate, review and merge', text: fmtDuration(d.mergeMs) },
                { label: 'Production build', text: fmtDuration(d.buildMs) },
                { label: 'Through the landing queue', text: `${eta.text}, at ${eta.clock}` },
            ],
        };
    }
    const rows = eta.parts.map((p) => ({ label: p.label, text: p.text }));
    if (d) rows.push({ label: 'Merged outside the queue', text: `${d.text}, at ${d.clock}` });
    return { path: 'queue', text: eta.text, clock: eta.clock, rangeText: eta.rangeText, rows };
}

// ---------------------------------------------------------------------------
// The working tree: what is pending against the branch point
// ---------------------------------------------------------------------------

function git(dir, args) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { ok: !r.error && r.status === 0, stdout: r.stdout || '' };
}

/** Lines in an untracked file, null for a binary or unreadable one. */
function countLines(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { return null; }
    if (buf.includes(0)) return null;
    if (!buf.length) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
}

/**
 * Every file that differs from the merge base with `baseRef`: committed,
 * staged, unstaged and untracked. A live edit is uncommitted, so the working
 * tree is the subject, never the commit list.
 */
function pendingFiles(dir, baseRef) {
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (!top.ok) return { ok: false, why: `${dir} is not inside a git repository` };
    const root = top.stdout.trim();
    const mb = git(root, ['merge-base', 'HEAD', baseRef]);
    if (!mb.ok) return { ok: false, why: `cannot find the branch point with ${baseRef}` };
    const mergeBase = mb.stdout.trim();
    const diff = git(root, ['diff', '--numstat', '-z', '--no-renames', mergeBase]);
    const others = git(root, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z']);
    if (!diff.ok || !others.ok) return { ok: false, why: 'git could not list the changes' };
    const files = [];
    for (const rec of diff.stdout.split('\0')) {
        const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
        if (m) files.push({ path: m[3], added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
    }
    for (const p of others.stdout.split('\0')) {
        if (p) files.push({ path: p, added: countLines(path.join(root, p)), deleted: 0, untracked: true });
    }
    return { ok: true, root, mergeBase, files };
}

/** Where the notes live: inside this worktree's git dir, so no tree and no build ever holds them. */
function journalPath(dir) {
    const g = git(dir, ['rev-parse', '--absolute-git-dir']);
    return g.ok ? path.join(g.stdout.trim(), 'live-edit', 'journal.jsonl') : null;
}

/** The calibration a clone uses when none is named: one file in the shared git dir, for every worktree. */
function defaultCalibration(dir) {
    const g = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return g.ok ? path.join(g.stdout.trim(), 'live-edit', 'calibration.json') : null;
}

/** Appends one instruction line to the journal. Returns the entry, or null when it could not be written. */
function addNote(dir, text, baseRef, now) {
    const file = journalPath(dir);
    const pending = pendingFiles(dir, baseRef);
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!file || !pending.ok || !line) return null;
    const entry = { at: new Date(now).toISOString(), text: line.slice(0, 160), base: pending.mergeBase };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return entry;
}

/** The notes written against this merge base. A rebase or a landed branch moves the base and retires them. */
function readNotes(dir, mergeBase) {
    const file = journalPath(dir);
    let text = '';
    try { text = file ? fs.readFileSync(file, 'utf8') : ''; } catch { return []; }
    const out = [];
    for (const l of text.split('\n')) {
        try { const e = JSON.parse(l); if (e && e.base === mergeBase && typeof e.text === 'string') out.push(e); } catch { /* a torn line is skipped */ }
    }
    return out;
}

/** The fast lane's own classifier over the working tree's diff, with the product's config read at the base. */
function classifyLane(root, mergeBase, files) {
    const fastLane = require('./fast-lane.js');
    const pkg = git(root, ['show', `${mergeBase}:package.json`]);
    let config;
    try { config = fastLane.parseConfig(pkg.ok ? pkg.stdout : null); } catch (e) { return { kind: 'full', reasons: [`the fast lane config is unreadable: ${e.message}`] }; }
    const v = fastLane.classify(files.map((f) => ({ path: f.path, added: f.added, deleted: f.deleted })), config);
    return { kind: v.eligible ? 'fast' : 'full', profile: v.profile, changedLines: v.changedLines, maxLines: v.maxLines, reasons: v.reasons.slice(0, 3) };
}

/** Everything the overlay draws, as plain data with its words already written. */
function computeState({ dir, baseRef = 'origin/main', calibrationFile = null, headline = 'queue', now = Date.now() }) {
    const pending = pendingFiles(dir, baseRef);
    if (!pending.ok) return { ok: false, generatedAt: now, why: pending.why, pill: 'not a branch', changes: { count: 0, lines: [] }, eta: null };
    const { files, mergeBase, root } = pending;
    const added = files.reduce((a, f) => a + (f.added || 0), 0);
    const deleted = files.reduce((a, f) => a + (f.deleted || 0), 0);
    const notes = files.length ? readNotes(dir, mergeBase) : [];
    const all = notes.length
        ? notes.map((n) => n.text)
        : files.map((f) => `${f.path}  +${f.added === null ? '?' : f.added} -${f.deleted === null ? '?' : f.deleted}`);
    const count = all.length;
    const lines = all.slice(-MAX_LINES);
    const summary = `${files.length} file${files.length === 1 ? '' : 's'}, +${added} -${deleted} lines since ${baseRef}`;
    const changes = { count, lines, more: count - lines.length, files: files.length, added, deleted, summary, noted: notes.length > 0 };
    const base = { ok: true, generatedAt: now, base: baseRef, mergeBase: mergeBase.slice(0, 8), changes };
    if (!files.length) return { ...base, pill: 'No pending changes', lane: null, eta: null, etaNote: 'Nothing to ship yet.' };
    const lane = classifyLane(root, mergeBase, files);
    const cal = readCalibration(calibrationFile || defaultCalibration(dir));
    const label = `${count} change${count === 1 ? '' : 's'}`;
    if (!cal.ok) return { ...base, pill: label, lane, eta: null, etaNote: `ETA not measured: ${cal.why}.` };
    const eta = estimate(cal.calibration, lane.kind, now);
    eta.view = headlineView(eta, headline);
    const caveats = [];
    if (headline === 'direct' && eta.view.path !== 'direct') caveats.push('No merge outside the queue is measured, so this is the queue path.');
    if (eta.partial) caveats.push('Some parts are not measured, so this is a floor.');
    if (eta.thin.length) caveats.push(`Thin data: ${eta.thin.join(', ')}.`);
    return { ...base, pill: label, lane, eta, etaNote: caveats.join(' ') || null };
}

// ---------------------------------------------------------------------------
// The overlay: one function, sent to the browser as text. It may name nothing
// outside its three arguments, because the browser gets its source alone.
// ---------------------------------------------------------------------------

const OVERLAY_CSS = [
    ':host{all:initial;position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:block;',
    '--le-bg:#ffffff;--le-fg:#16181d;--le-muted:#5b6270;--le-line:#d9dce3;--le-accent:#2f6f4f;--le-warn:#8a5a00;--le-shadow:0 6px 24px rgba(16,18,24,.16);',
    'font:500 13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--le-fg);font-variant-numeric:tabular-nums}',
    '@media (prefers-color-scheme:dark){:host{--le-bg:#17191e;--le-fg:#eef0f4;--le-muted:#a3aab8;--le-line:#343943;--le-accent:#7fd3a4;--le-warn:#f0c36a;--le-shadow:0 6px 24px rgba(0,0,0,.5)}}',
    '.le{position:absolute;display:flex;flex-direction:column;gap:8px;max-width:calc(100vw - 24px);pointer-events:none}',
    '.le[data-corner="bottom-left"]{left:12px;bottom:12px;align-items:flex-start;flex-direction:column-reverse}',
    '.le[data-corner="bottom-right"]{right:12px;bottom:12px;align-items:flex-end;flex-direction:column-reverse}',
    '.le[data-corner="top-right"]{right:12px;top:12px;align-items:flex-end}',
    '.le[data-corner="top-left"]{left:12px;top:12px;align-items:flex-start}',
    '.le[data-corner="right"]{right:0;top:38vh;align-items:flex-end}.le[data-corner="left"]{left:0;top:38vh;align-items:flex-start}',
    '.le[data-corner="right"] .pill{border-radius:18px 0 0 18px;border-right-width:0}.le[data-corner="left"] .pill{border-radius:0 18px 18px 0;border-left-width:0}',
    '.le[data-corner="right"] .count,.le[data-corner="left"] .count{display:none}.le[data-corner="right"] .panel{margin-right:12px}.le[data-corner="left"] .panel{margin-left:12px}',
    '.pill{pointer-events:auto;appearance:none;border:1px solid var(--le-line);background:var(--le-bg);color:var(--le-fg);',
    'font:inherit;min-height:36px;padding:0 12px;border-radius:18px;display:inline-flex;align-items:center;gap:8px;cursor:pointer;box-shadow:var(--le-shadow);white-space:nowrap}',
    '@media (pointer:coarse){.pill{min-height:44px}}',
    '.pill:focus-visible{outline:2px solid var(--le-accent);outline-offset:2px}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--le-accent);flex:none}',
    '.le[data-state="idle"] .dot{background:var(--le-muted)}.le[data-state="stale"] .dot,.le[data-state="unmeasured"] .dot{background:var(--le-warn)}',
    '.eta{color:var(--le-muted)}.eta b{color:var(--le-fg);font-weight:600}',
    '.panel{pointer-events:auto;box-sizing:border-box;width:min(340px,calc(100vw - 24px));max-height:min(70vh,520px);overflow:auto;background:var(--le-bg);',
    'border:1px solid var(--le-line);border-radius:12px;box-shadow:var(--le-shadow);padding:14px;display:none}',
    '.le[data-open="true"] .panel{display:block;animation:le-in .16s ease-out}',
    '@media (hover:hover){.le:hover .panel{display:block;animation:le-in .16s ease-out}}',
    // Transform only: a page in a background tab may never advance an animation, and a frozen first frame must still be readable.
    '@keyframes le-in{from{transform:translateY(4px)}to{transform:none}}',
    '@media (prefers-reduced-motion:reduce){.le .panel{animation:none!important}}',
    '.h{font-size:12px;font-weight:600;color:var(--le-muted);margin:0 0 6px}',
    '.big{font-size:20px;font-weight:650;margin:0}.sub{color:var(--le-muted);margin:2px 0 12px}',
    '.list{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:4px}.list li{overflow-wrap:anywhere}',
    '.rows{display:grid;grid-template-columns:1fr auto;gap:4px 16px;margin:0}.rows dt{color:var(--le-muted)}.rows dd{margin:0;text-align:right}',
    '.note{color:var(--le-muted);font-size:12px;margin:10px 0 0}',
    '.le[data-variant="bar"]{left:0!important;right:0!important;bottom:0!important;top:auto!important;max-width:none;align-items:stretch!important;flex-direction:column-reverse!important;gap:0}',
    '.le[data-variant="bar"] .pill{border-radius:0;border-width:1px 0 0;justify-content:center;box-shadow:none;min-height:32px}',
    '.le[data-variant="bar"] .panel{margin:0 12px 8px;align-self:flex-start}',
    '.le[data-variant="dot"] .pill{padding:0;width:36px;justify-content:center}.le[data-variant="dot"] .pill .count,.le[data-variant="dot"] .pill .eta{display:none}',
    '.le[data-variant="dot"] .dot{width:12px;height:12px;box-shadow:0 0 0 4px color-mix(in srgb,var(--le-accent) 25%,transparent)}',
].join('');

/* eslint-disable no-var */
function overlayClient(window, document, config) {
    if (window.__liveEditOverlay) return window.__liveEditOverlay;
    var CONTROL = 'a,button,input,select,textarea,summary,label,[role="button"],[role="link"],[tabindex]';
    var make = function (tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    var host = make('live-edit-overlay');
    host.setAttribute('aria-live', 'off');
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var wrap = make('div', 'le');
    var pill = make('button', 'pill');
    var count = make('span', 'count', 'Live edit');
    var eta = make('span', 'eta', '');
    var panel = make('div', 'panel');
    var open = false;
    var placed = false;
    pill.setAttribute('type', 'button');
    pill.setAttribute('aria-expanded', 'false');
    pill.appendChild(make('span', 'dot'));
    pill.appendChild(count);
    pill.appendChild(eta);
    wrap.setAttribute('data-variant', config.variant);
    wrap.setAttribute('data-corner', config.corners[0]);
    wrap.setAttribute('data-open', 'false');
    wrap.setAttribute('data-state', 'idle');
    root.appendChild(make('style', '', config.css));
    wrap.appendChild(pill);
    wrap.appendChild(panel);
    root.appendChild(wrap);

    var attach = function () {
        if (host.isConnected) return false;
        document.documentElement.appendChild(host);
        return true;
    };

    // True when the pill would sit on one of the page's controls or on another tool's widget.
    // strict counts every control on screen now. Otherwise only the ones the page pins
    // (fixed or sticky), because a control in the flow scrolls out from under a fixed pill.
    var blocked = function (strict) {
        var r = pill.getBoundingClientRect();
        // A grid of points 12 px apart: a small round widget fits between a rectangle's corners.
        var points = [];
        var rows = [r.top + 2, (r.top + r.bottom) / 2, r.bottom - 2];
        for (var x = r.left + 2; x < r.right; x += 12) for (var y = 0; y < rows.length; y++) points.push([x, rows[y]]);
        for (var i = 0; i < points.length; i++) {
            var stack = document.elementsFromPoint(points[i][0], points[i][1]);
            for (var j = 0; j < stack.length; j++) {
                var el = stack[j];
                if (el === host) continue;
                // A framework's dev indicator is drawn inside its own shadow root.
                if (el.shadowRoot) return true;
                if (!el.closest || !el.closest(CONTROL)) continue;
                if (strict) return true;
                for (var up = el; up && up !== document.documentElement; up = up.parentElement) {
                    var pos = window.getComputedStyle(up).position;
                    if (pos === 'fixed' || pos === 'sticky') return true;
                }
            }
        }
        return false;
    };

    // Keeps the pill where it is while nothing pinned sits under it. Otherwise the first
    // spot that covers no control at all, then the first that covers nothing pinned.
    var place = function (fresh) {
        if (fresh !== true && !blocked(false)) return wrap.getAttribute('data-corner');
        for (var pass = 0; pass < 2; pass++) {
            for (var i = 0; i < config.corners.length; i++) {
                wrap.setAttribute('data-corner', config.corners[i]);
                if (!blocked(pass === 0)) { wrap.removeAttribute('data-blocked'); return config.corners[i]; }
            }
        }
        wrap.setAttribute('data-corner', config.corners[0]);
        wrap.setAttribute('data-blocked', 'true');
        return null;
    };

    var draw = function (state) {
        var e = state.eta;
        wrap.setAttribute('data-state', !state.ok ? 'stale' : !state.changes.count ? 'idle' : e ? 'ready' : 'unmeasured');
        count.textContent = state.pill;
        eta.textContent = '';
        if (e) {
            eta.appendChild(make('b', '', e.view.text));
            eta.appendChild(document.createTextNode(' · ' + e.view.clock));
        }
        while (panel.firstChild) panel.removeChild(panel.firstChild);
        if (!state.ok) { panel.appendChild(make('p', 'note', state.why)); return; }
        if (e) {
            panel.appendChild(make('p', 'h', 'Live in production in about'));
            panel.appendChild(make('p', 'big', e.view.text + ', at ' + e.view.clock));
            panel.appendChild(make('p', 'sub', 'Range ' + e.view.rangeText));
            var rows = make('dl', 'rows');
            for (var i = 0; i < e.view.rows.length; i++) {
                rows.appendChild(make('dt', '', e.view.rows[i].label));
                rows.appendChild(make('dd', '', e.view.rows[i].text));
            }
            panel.appendChild(rows);
        }
        if (state.changes.count) {
            var head = make('p', 'h', 'Pending changes');
            head.setAttribute('style', e ? 'margin-top:12px' : '');
            panel.appendChild(head);
            var list = make('ul', 'list');
            for (var k = 0; k < state.changes.lines.length; k++) list.appendChild(make('li', '', state.changes.lines[k]));
            if (state.changes.more > 0) list.appendChild(make('li', 'note', 'and ' + state.changes.more + ' earlier'));
            panel.appendChild(list);
            panel.appendChild(make('p', 'note', state.changes.summary));
        }
        if (state.etaNote) panel.appendChild(make('p', 'note', state.etaNote));
    };

    var refresh = function () {
        return window.fetch(config.stateUrl, { cache: 'no-store' })
            .then(function (res) { return res.json(); })
            .then(function (state) { draw(state); place(!placed); placed = true; return state; })
            .catch(function () {
                wrap.setAttribute('data-state', 'stale');
                count.textContent = 'Live edit helper stopped';
                eta.textContent = '';
                return null;
            });
    };

    pill.addEventListener('click', function () {
        open = !open;
        wrap.setAttribute('data-open', String(open));
        pill.setAttribute('aria-expanded', String(open));
    });
    window.addEventListener('resize', function () { place(true); });
    attach();
    if (window.MutationObserver) new window.MutationObserver(attach).observe(document.documentElement, { childList: true });
    var api = { host: host, wrap: wrap, pill: pill, panel: panel, draw: draw, place: place, refresh: refresh, attach: attach };
    window.__liveEditOverlay = api;
    refresh();
    window.setInterval(refresh, config.pollMs);
    return api;
}
/* eslint-enable no-var */

/** The script the proxy serves: the overlay's source applied to this page. */
function overlayScript(variant) {
    const config = { variant, css: OVERLAY_CSS, stateUrl: `${PREFIX}state`, pollMs: 2000, corners: ['bottom-left', 'bottom-right', 'top-right', 'top-left', 'right', 'left'] };
    return `(${overlayClient.toString()})(window, document, ${JSON.stringify(config)});\n`;
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

/** The script tag, carrying the page's own nonce when its policy pins scripts by nonce. */
function scriptTag(csp) {
    const m = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(String(csp || ''));
    return `<script src="${PREFIX}overlay.js" defer${m ? ` nonce="${m[1]}"` : ''}></script>`;
}

/**
 * A byte-safe inserter: returns { push(chunk) -> Buffer, end() -> Buffer }.
 * The tag goes right after the opening <head> tag, because a streamed page
 * may never close its body. A page with no head gets it at the end.
 */
function injector(tag) {
    let held = '';
    let done = false;
    return {
        push(chunk) {
            if (done) return chunk;
            held += chunk.toString('latin1');
            const m = /<head(?:\s[^>]*)?>/i.exec(held);
            if (!m && held.length < 256 * 1024) return Buffer.alloc(0);
            const cut = m ? m.index + m[0].length : held.length;
            const out = Buffer.from(held.slice(0, cut) + (m ? tag : '') + held.slice(cut), 'latin1');
            done = Boolean(m);
            held = '';
            return out;
        },
        end() {
            const out = Buffer.from(done ? '' : held + tag, 'latin1');
            held = '';
            done = true;
            return out;
        },
    };
}

/** True when the Host header names this machine, so a rebound DNS name cannot read the tree's state. */
function loopbackHost(header) {
    const host = String(header || '').toLowerCase().replace(/:\d+$/, '');
    return LOOPBACK.has(host) || host.endsWith('.localhost');
}

/** The request headers as the dev server should see them: its own host, its own origin, no compression. */
function upstreamHeaders(headers, upstream) {
    const out = { ...headers, host: upstream.host };
    delete out['accept-encoding'];
    for (const key of ['origin', 'referer']) {
        if (!out[key]) continue;
        try { const u = new URL(out[key]); u.protocol = 'http:'; u.host = upstream.host; out[key] = key === 'origin' ? u.origin : u.href; } catch { delete out[key]; }
    }
    return out;
}

/**
 * The proxy server, not yet listening. `upstream` is a URL object; `getState`
 * returns the state object; `variant` picks the overlay's look.
 */
function createProxy({ upstream, getState, variant = 'pill', log = () => {} }) {
    const waiting = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1"><title>Starting</title>'
        + '<body style="font:16px system-ui;padding:24px">The dev server is starting. This page reloads by itself.</body>';
    const server = http.createServer((req, res) => {
        if (!loopbackHost(req.headers.host)) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('live-edit serves this machine only\n'); return; }
        if (req.url.startsWith(PREFIX)) {
            const name = req.url.slice(PREFIX.length).split('?')[0];
            const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
            if (name === 'overlay.js') return send('application/javascript; charset=utf-8', overlayScript(variant));
            if (name === 'state') return send('application/json; charset=utf-8', JSON.stringify(getState()));
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found\n');
            return;
        }
        const proxyOrigin = `http://${req.headers.host}`;
        const out = http.request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, upstream) }, (up) => {
            const headers = { ...up.headers };
            if (headers.location) headers.location = String(headers.location).replace(upstream.origin, proxyOrigin);
            const html = /text\/html/i.test(String(headers['content-type'] || '')) && req.method !== 'HEAD' && ![204, 304].includes(up.statusCode);
            if (!html) { res.writeHead(up.statusCode, headers); up.pipe(res); return; }
            delete headers['content-length'];
            const inject = injector(scriptTag(headers['content-security-policy']));
            res.writeHead(up.statusCode, headers);
            up.on('data', (chunk) => { const b = inject.push(chunk); if (b.length) res.write(b); });
            up.on('end', () => res.end(inject.end()));
        });
        out.on('error', (e) => {
            log(`${TAG} the dev server did not answer ${req.url}: ${e.code || e.message}`);
            if (res.headersSent) { res.destroy(); return; }
            res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(waiting);
        });
        req.pipe(out);
    });
    // Hot reload rides a websocket: hand the raw socket to the dev server and step aside.
    const sockets = new Set();
    server.liveEditSockets = sockets;
    server.on('upgrade', (req, socket, head) => {
        if (!loopbackHost(req.headers.host)) { socket.destroy(); return; }
        const up = net.connect(Number(upstream.port), upstream.hostname, () => {
            const headers = upstreamHeaders(req.headers, upstream);
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) lines.push(`${k}: ${one}`);
            up.write(lines.join('\r\n') + '\r\n\r\n');
            if (head && head.length) up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        sockets.add(socket).add(up);
        up.on('error', () => socket.destroy());
        socket.on('error', () => up.destroy());
        up.on('close', () => { sockets.delete(up); socket.destroy(); });
        socket.on('close', () => { sockets.delete(socket); up.destroy(); });
        // An http server's sockets stay half open after the other end hangs up, so a closed
        // tab would leave both ends here for ever. One end finishing ends the pair.
        socket.on('end', () => { socket.destroy(); up.destroy(); });
        up.on('end', () => { up.destroy(); socket.destroy(); });
    });
    return server;
}

/** A port nothing listens on right now. */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

/** One command line for the shell, each argument quoted when it holds a space. */
function commandLine(argv) {
    return argv.map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a)).join(' ');
}

/** Stops the dev server and everything it started. */
function stopTree(child) {
    if (!child || child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; }
    // The shell is a group leader there (see serve), so the signal reaches what it started.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
}

/** Starts the proxy and, unless an upstream was named, the dev server behind it. Resolves once listening. */
async function serve(o, log = console.log) {
    const dir = path.resolve(o.dir);
    let upstream = o.upstream ? new URL(o.upstream) : null;
    let child = null;
    if (!upstream) {
        const port = await freePort();
        upstream = new URL(`http://localhost:${port}`);
        const argv = o.command && o.command.length ? o.command : ['npm', 'run', 'dev', '--', '--port', String(port)];
        // Windows: attached and hidden, because a detached or visible console is never acceptable for a helper.
        // Elsewhere the shell leads its own process group, so stopTree can signal the whole tree.
        child = spawn(commandLine(argv), {
            cwd: dir, env: { ...process.env, PORT: String(port) }, shell: true, windowsHide: true,
            detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit'],
        });
    }
    let cache = null;
    const getState = () => {
        const now = Date.now();
        if (!cache || now - cache.at > 1000) cache = { at: now, state: computeState({ dir, baseRef: o.base, calibrationFile: o.calibration, headline: o.headline, now }) };
        return cache.state;
    };
    const server = createProxy({ upstream, getState, variant: o.variant, log });
    let closed = false;
    // Once only: ends the dev server, the hot-reload sockets and the listener, so the process can exit.
    const close = () => {
        if (closed) return;
        closed = true;
        stopTree(child);
        for (const s of server.liveEditSockets) s.destroy();
        if (server.closeAllConnections) server.closeAllConnections();
        server.close();
    };
    if (child) child.on('exit', (code) => { if (!closed) process.exitCode = code === null ? 1 : code; close(); });
    // A port that cannot be bound must not leave the dev server running behind a helper that never served.
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(o.port), '127.0.0.1', resolve); });
    } catch (e) { close(); throw e; }
    log(`${TAG} http://localhost:${server.address().port} -> ${upstream.origin}, overlay "${o.variant}", changes since ${o.base}`);
    return { server, child, upstream, close };
}

// ---------------------------------------------------------------------------
// Calibration: samples from records that already exist
// ---------------------------------------------------------------------------

/** Every .json file named, or directly inside a directory named. */
function jsonFiles(list) {
    const out = [];
    for (const p of list) {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) { for (const f of fs.readdirSync(p)) if (f.endsWith('.json')) out.push(path.join(p, f)); } else out.push(p);
    }
    return out;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The newest `KEEP` durations, oldest first, from [{ at, ms }]. */
function newest(samples) {
    return samples.filter((s) => Number.isFinite(s.ms) && s.ms > 0 && Number.isFinite(s.at)).sort((a, b) => a.at - b.at).slice(-KEEP);
}

/** Full-gate holds for one repository, from the release records beside the gate lock. */
function gateSamples(locksDir, repo, minHoldMin) {
    const gateCost = require('./gate-cost.js');
    let names;
    try { names = fs.readdirSync(locksDir); } catch { return { samples: [], short: 0, why: `cannot read ${locksDir}` }; }
    const all = [];
    let short = 0;
    for (const name of names) {
        const m = name.match(gateCost.RECORD);
        if (!m) continue;
        let r = null;
        try { r = gateCost.readRecord(locksDir, name, m); } catch { r = null; }
        if (!r || r.project !== repo) continue;
        if (r.holdMin < minHoldMin) { short++; continue; }
        all.push({ at: r.start, ms: r.holdMin * MIN });
    }
    return { samples: newest(all), short, why: null };
}

/** Fast-lane receipts that ran green: the sum of their steps. */
function fastSamples(files) {
    const { KIND: FAST_KIND } = require('./fast-lane.js');
    const all = [];
    for (const f of jsonFiles(files)) {
        const j = readJson(f);
        if (!j || j.kind !== FAST_KIND || j.exit !== 0 || !Array.isArray(j.steps)) continue;
        all.push({ at: Date.parse(j.finishedAt), ms: j.steps.reduce((a, s) => a + (Number(s.ms) || 0), 0) });
    }
    return newest(all);
}

/** Review receipts: how long the reviewer took. One repository unless anyRepo. An escalation is a hand-off, not a review. */
function reviewSamples(files, repo, anyRepo) {
    const all = [];
    for (const f of jsonFiles(files)) {
        const j = readJson(f);
        if (!j || !Number.isFinite(j.diff_lines) || !(j.ms > 0) || j.verdict === 'escalate' || (!anyRepo && j.repo !== repo)) continue;
        all.push({ at: Date.parse(j.started_at), ms: j.ms });
    }
    return newest(all);
}

/** Production deployments that went ready: creation to ready, queue time included. */
function buildSamples(list) {
    const rows = Array.isArray(list) ? list : (list && list.deployments) || [];
    const all = [];
    for (const d of rows) {
        const created = d.createdAt || d.created;
        const state = d.readyState || d.state;
        if ((d.target && d.target !== 'production') || (state && state !== 'READY')) continue;
        all.push({ at: created, ms: d.ready - created });
    }
    return newest(all);
}

/**
 * Merged pull requests, split by how they landed. A pull request pushed before
 * a landing slot and merged within `windowMin` after it was landed by the queue:
 * its sample is slot to merge. Any other merge was direct: its sample is push to
 * merge, when under an hour.
 */
function mergeSamples(list, minutes, sinceMs, windowMin = 25) {
    const land = [];
    const direct = [];
    let skipped = 0;
    for (const p of Array.isArray(list) ? list : []) {
        const merged = Date.parse(p.mergedAt);
        const last = Array.isArray(p.commits) && p.commits.length ? p.commits[p.commits.length - 1].committedDate : null;
        const pushed = Date.parse(p.pushedAt || last);
        if (!Number.isFinite(merged) || merged < sinceMs) continue;
        const slot = minutes ? lastSlot(merged, minutes) : null;
        if (slot !== null && merged - slot <= windowMin * MIN && Number.isFinite(pushed) && pushed <= slot) land.push({ at: merged, ms: merged - slot });
        else if (Number.isFinite(pushed) && merged - pushed <= 60 * MIN) direct.push({ at: merged, ms: merged - pushed });
        else skipped++;
    }
    return { land: newest(land), direct: newest(direct), skipped };
}

/** Builds the calibration object. Every part names its source and how many samples it holds. */
function calibrate(o, now = Date.now()) {
    const minutes = parseLandMinutes(o.landMinutes);
    const since = o.since ? Date.parse(o.since) : 0;
    const gate = o.locksDir ? gateSamples(o.locksDir, o.repo, o.minHold) : { samples: [], short: 0, why: 'no --locks-dir' };
    const merges = o.merges ? mergeSamples(readJson(o.merges), minutes, since) : { land: [], direct: [], skipped: 0 };
    const part = (samples, source) => ({ ms: samples.map((s) => Math.round(s.ms)), source });
    return {
        kind: KIND, version: VERSION, repo: o.repo, measuredAt: new Date(now).toISOString(), landMinutes: minutes,
        parts: {
            gateFull: part(gate.samples, gate.why || `release records beside the gate lock, holds of ${o.minHold}+ min (${gate.short} shorter left out)`),
            gateFast: part(o.fastReceipts ? fastSamples(o.fastReceipts) : [], 'green fast-lane receipts, sum of steps'),
            review: part(o.reviewReceipts ? reviewSamples(o.reviewReceipts, o.repo, o.reviewAnyRepo) : [], o.reviewAnyRepo ? 'review receipts, every repository' : 'review receipts for this repository'),
            land: part(merges.land, 'merged pull requests: landing slot to merge'),
            build: part(o.deployments ? buildSamples(readJson(o.deployments)) : [], 'production deployments: created to ready'),
            direct: part(merges.direct, `merged pull requests outside the queue: last push to merge (${merges.skipped} over an hour left out)`),
        },
    };
}

/** The inputs as text: one row per part. */
function describe(calibration) {
    const rows = PARTS.map((key) => {
        const p = calibration.parts[key] || { ms: [], source: '' };
        const s = stats(p.ms);
        return `  ${key.padEnd(9)} n=${String(s ? s.n : 0).padEnd(3)} ${s ? `median ${fmtDuration(s.median)}, ${fmtDuration(s.low)} to ${fmtDuration(s.high)}` : 'not measured'}  [${p.source}]`;
    });
    const slots = calibration.landMinutes ? calibration.landMinutes.map((m) => `:${String(m).padStart(2, '0')}`).join(' ') : 'none';
    return [`${TAG} ${calibration.repo}, measured ${calibration.measuredAt}, landing slots ${slots}`, ...rows].join('\n');
}

/** Predicted against actual for past merges. Errors are predicted minus actual, in minutes. */
function backtest(calibration, cases) {
    const rows = cases.map((c) => {
        const pushed = Date.parse(c.pushedAt);
        const actual = Date.parse(c.liveAt) - pushed;
        const e = estimate(calibration, c.lane === 'fast' ? 'fast' : 'full', pushed);
        const err = (ms) => Math.round(((ms - actual) / MIN) * 10) / 10;
        return { pr: c.pr, actualMin: Math.round((actual / MIN) * 10) / 10, queueMin: Math.round((e.medianMs / MIN) * 10) / 10, queueErrMin: err(e.medianMs), directMin: e.direct ? Math.round((e.direct.medianMs / MIN) * 10) / 10 : null, directErrMin: e.direct ? err(e.direct.medianMs) : null, inRange: actual >= e.lowMs && actual <= e.highMs };
    });
    const abs = (key) => stats(rows.map((r) => r[key]).filter((n) => n !== null).map(Math.abs));
    const q = abs('queueErrMin');
    const d = abs('directErrMin');
    return { rows, queueMedianAbsErrMin: q ? q.median : null, directMedianAbsErrMin: d ? d.median : null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_FLAGS = ['dir', 'port', 'upstream', 'base', 'calibration', 'variant', 'headline', 'text', 'repo', 'out', 'locks-dir', 'min-hold', 'fast-receipts', 'review-receipts', 'deployments', 'merges', 'land-minutes', 'since', 'cases'];
const BOOL_FLAGS = ['help', 'json', 'review-any-repo'];

function parseArgs(argv) {
    const o = { _: [], command: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') { o.command = argv.slice(i + 1); break; }
        if (a === '-h') { o.help = true; continue; }
        if (!a.startsWith('--')) { o._.push(a); continue; }
        const name = a.slice(2);
        if (BOOL_FLAGS.includes(name)) { o[name] = true; continue; }
        if (!VALUE_FLAGS.includes(name)) return { error: `unknown argument ${a}` };
        if (argv[i + 1] === undefined) return { error: `${a} needs a value` };
        o[name] = argv[++i];
    }
    return { o };
}

function help() {
    return [
        'usage: node live-edit.js <serve|state|note|calibrate|backtest> [options]',
        '  serve     --dir SITE --port N [--upstream URL | -- COMMAND...] [--base REF] [--calibration FILE]',
        '            [--variant pill|bar|dot] [--headline queue|direct]',
        '  state     --dir SITE [--base REF] [--calibration FILE] [--headline queue|direct]',
        '  note      --dir SITE --text "what changed" [--base REF]',
        '  calibrate --repo OWNER/NAME --out FILE [--locks-dir DIR] [--min-hold MIN] [--fast-receipts PATHS] [--review-receipts PATHS]',
        '            [--review-any-repo] [--deployments FILE] [--merges FILE] [--land-minutes 37] [--since ISO]',
        '  backtest  --calibration FILE --cases FILE',
        'A localhost proxy that draws pending changes and the time until they would be live. It writes nothing to the site.',
    ].join('\n');
}

function defaultLocksDir() {
    return path.dirname(path.resolve(process.env.AUTODEV_GATE_LOCK_PATH || path.join(os.homedir(), '.claude', 'autodev', 'locks', 'full-gate.lock')));
}

async function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n')) {
    const parsed = parseArgs(argv);
    const fail = (why) => { err(`${TAG} ${why}`); err(help()); return 1; };
    if (parsed.error) return fail(parsed.error);
    const o = parsed.o;
    const cmd = o._[0];
    if (o.help || !cmd) { out(help()); return o.help ? 0 : 1; }
    const base = o.base || 'origin/main';
    const variant = o.variant || 'pill';
    if (!VARIANTS.includes(variant)) return fail(`--variant is one of ${VARIANTS.join(', ')}`);
    const headline = o.headline || 'queue';
    if (!['queue', 'direct'].includes(headline)) return fail('--headline is queue or direct');
    if (['serve', 'state', 'note'].includes(cmd) && !o.dir) return fail(`${cmd} needs --dir SITE`);
    if (cmd === 'state') {
        out(JSON.stringify(computeState({ dir: path.resolve(o.dir), baseRef: base, calibrationFile: o.calibration || null, headline }), null, 2));
        return 0;
    }
    if (cmd === 'note') {
        const entry = addNote(path.resolve(o.dir), o.text, base, Date.now());
        if (!entry) return fail('note needs --text and a branch with a readable base');
        out(`${TAG} noted "${entry.text}"`);
        return 0;
    }
    if (cmd === 'calibrate') {
        if (!o.repo || !o.out) return fail('calibrate needs --repo OWNER/NAME and --out FILE');
        const list = (v) => (v ? String(v).split(',').map((p) => path.resolve(p.trim())) : null);
        let cal;
        try {
            cal = calibrate({
                repo: o.repo, locksDir: o['locks-dir'] ? path.resolve(o['locks-dir']) : defaultLocksDir(), minHold: o['min-hold'] === undefined ? 3 : Number(o['min-hold']),
                fastReceipts: list(o['fast-receipts']), reviewReceipts: list(o['review-receipts']), reviewAnyRepo: Boolean(o['review-any-repo']),
                deployments: o.deployments, merges: o.merges, landMinutes: o['land-minutes'], since: o.since,
            });
        } catch (e) { return fail(e.message); }
        const file = path.resolve(o.out);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(cal, null, 2) + '\n');
        fs.renameSync(`${file}.tmp`, file);
        out(describe(cal));
        return 0;
    }
    if (cmd === 'backtest') {
        const cal = readCalibration(o.calibration);
        const cases = o.cases ? readJson(o.cases) : null;
        if (!cal.ok) return fail(cal.why);
        if (!Array.isArray(cases) || !cases.length) return fail('backtest needs --cases FILE holding [{ pr, pushedAt, liveAt, lane }]');
        const r = backtest(cal.calibration, cases);
        if (o.json) { out(JSON.stringify(r, null, 2)); return 0; }
        out(describe(cal.calibration));
        for (const row of r.rows) out(`  #${row.pr}: actual ${row.actualMin} min, queue path ${row.queueMin} min (error ${row.queueErrMin}), direct path ${row.directMin === null ? 'not measured' : `${row.directMin} min (error ${row.directErrMin})`}, inside range: ${row.inRange ? 'yes' : 'no'}`);
        out(`  median absolute error over ${r.rows.length} case(s): queue path ${r.queueMedianAbsErrMin} min, direct path ${r.directMedianAbsErrMin === null ? 'not measured' : `${r.directMedianAbsErrMin} min`}`);
        return 0;
    }
    if (cmd === 'serve') {
        if (!o.port || !/^\d+$/.test(o.port)) return fail('serve needs --port N');
        let running;
        try { running = await serve({ dir: o.dir, port: o.port, upstream: o.upstream, base, calibration: o.calibration || null, variant, headline, command: o.command }, out); } catch (e) { return fail(`cannot serve on port ${o.port}: ${e.code || e.message}`); }
        process.once('SIGINT', running.close);
        process.once('SIGTERM', running.close);
        process.once('exit', running.close);
        return null;
    }
    return fail(`unknown command ${cmd}`);
}

module.exports = {
    stats, fmtDuration, fmtClock, parseLandMinutes, nextSlot, lastSlot, readCalibration, estimate, headlineView,
    countLines, pendingFiles, journalPath, defaultCalibration, addNote, readNotes, classifyLane, computeState,
    overlayClient, overlayScript, OVERLAY_CSS, scriptTag, injector, loopbackHost, upstreamHeaders, createProxy,
    freePort, commandLine, stopTree, serve, jsonFiles, newest, gateSamples, fastSamples, reviewSamples, buildSamples,
    mergeSamples, calibrate, describe, backtest, parseArgs, help, main, KIND, PREFIX, VARIANTS,
};

if (require.main === module) {
    main().then((code) => { if (code !== null) process.exitCode = code; }, (e) => { process.stderr.write(`${TAG} ${e.stack || e}\n`); process.exitCode = 1; });
}
