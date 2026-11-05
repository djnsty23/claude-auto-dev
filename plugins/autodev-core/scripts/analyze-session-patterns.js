#!/usr/bin/env node
// analyze-session-patterns.js — rank the failure classes sessions actually HIT.
//
// `mine-fixes.js` mines git history: what shipped broken and got fixed later.
// That is the post-hoc surface. This is the other half — what goes wrong DURING
// a session and never reaches a commit: an Edit refused because the file was
// never read, a hook-blocked command, a browser probe against a pane that is not
// composited, a 2-minute timeout. None of that is in git, and the telemetry hook
// could not see it either (it recorded ok:true on 878/878 rows until 2026-08-19,
// because it read a payload key the CLI does not send).
//
// Reads ~/.claude/projects/**/*.jsonl, which is every session on this machine
// including subagents — the only surface that sees all sessions at once. The
// per-project .claude/reports/telemetry-*.jsonl only ever sees its own project.
//
// Usage:
//   node plugins/autodev-core/scripts/analyze-session-patterns.js [--days N] [--json]
//                                            [--min N] [--project SUBSTR]
//
// Pure Node, no dependencies, read-only. Never writes anything.
//
// PRIVACY: error TEXT is read to classify it, and one short redacted excerpt per
// class is printed so a finding can be acted on. Excerpts are capped, stripped
// of anything token-shaped, and never include tool INPUT. Run with --no-examples
// to print counts only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const claudePaths = require('./claude-paths.js');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.split('=').slice(1).join('=');
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
    return dflt;
};

const DAYS = Number(flag('days', 1)) || 1;
const AS_JSON = args.includes('--json');
const NO_EXAMPLES = args.includes('--no-examples');
const MIN = Number(flag('min', 1)) || 1;
const PROJECT = flag('project', '');
const ROOT = flag('root', path.join(claudePaths.configDir(), 'projects'));

const { CLASSES, classify } = require('./session-error-classes.js');

const REDACT = [
    [/\b(sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{8,}/g, '<token>'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, '<jwt>'],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
];
const redact = (s) => REDACT.reduce((acc, [re, to]) => acc.replace(re, to), s);


// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
}

const cutoff = Date.now() - DAYS * 86400_000;
// Same instant, as the ISO prefix the transcripts carry. The mtime filter below
// stays as a cheap pre-filter — a file untouched for N days cannot hold an event
// inside N days — but it is NOT the window; the per-event check is.
const cutoffISO = new Date(cutoff).toISOString().slice(0, 24);
const all = walk(ROOT);
const files = all.filter((f) => {
    if (PROJECT && !f.toLowerCase().includes(PROJECT.toLowerCase())) return false;
    try { return fs.statSync(f).mtimeMs >= cutoff; } catch { return false; }
});

const stats = {
    filesSeen: all.length,
    filesInWindow: files.length,
    lines: 0,
    linesBeforeWindow: 0,
    toolResults: 0,
    errors: 0,
    timed: 0,
};
const byClass = new Map();   // id -> { count, sessions:Set, perSession:Map, examples }
const bySession = new Map(); // session file -> { errors, classes:Map }
const byDay = new Map();     // YYYY-MM-DD -> Map(classId -> count)
// tool_use id -> its timestamp, so an error can be priced in wall clock.
// Filled on the same forward pass: a tool_use always precedes its result.
const useTs = new Map();

for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const sessionKey = path.basename(path.dirname(f)) + '/' + path.basename(f, '.jsonl').slice(0, 8);
    for (const ln of raw.split('\n')) {
        if (!ln) continue;
        stats.lines++;
        // Window by the EVENT's own timestamp, not the file's mtime. A session
        // file is appended to for months under one name, so an mtime filter
        // admits the file and then counts every event in it — which is how a
        // "last 2 days" scan reported blocked commands from five weeks earlier
        // and made one long-lived transcript look like a runaway session.
        // ISO-8601 sorts lexicographically, so this needs no date parsing.
        const tsAt = ln.indexOf('"timestamp":"');
        if (tsAt !== -1) {
            const ts = ln.slice(tsAt + 13, tsAt + 37);
            if (ts < cutoffISO) { stats.linesBeforeWindow++; continue; }
        }
        // The DENOMINATOR must be counted before the error filter, or it reports
        // "783 of 783 failed" — a share of itself. Substring count, no parse:
        // parsing 145k lines to get a total is the slow way round.
        let at = -1;
        while ((at = ln.indexOf('"type":"tool_result"', at + 1)) !== -1) stats.toolResults++;
        // Capture tool_use times so a failure can be priced. Same prefilter
        // discipline as below: only lines that can carry one are parsed.
        if (ln.indexOf('"type":"tool_use"') !== -1) {
            try {
                const u = JSON.parse(ln);
                const uc = u && u.message && u.message.content;
                if (Array.isArray(uc) && typeof u.timestamp === 'string') {
                    for (const b of uc) if (b && b.type === 'tool_use' && b.id) useTs.set(b.id, Date.parse(u.timestamp));
                }
            } catch { /* a malformed line is not worth failing the scan */ }
        }
        // Cheap pre-filter: parsing 145k JSON lines to find a few hundred is waste.
        if (ln.indexOf('"is_error":true') === -1) continue;
        let d;
        try { d = JSON.parse(ln); } catch { continue; }
        const content = d && d.message && d.message.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
            if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue;
            if (!b.is_error) continue;
            stats.errors++;
            let text = b.content;
            if (Array.isArray(text)) text = text.map((x) => (x && x.text) || '').join(' ');
            text = String(text == null ? '' : text);
            const id = classify(text);

            // Wall clock from request to result. It INCLUDES any permission
            // prompt and user think-time, which is the honest metric for how
            // long the work was blocked, but is not tool execution time and
            // must never be reported as such. Median, not mean: one call left
            // pending overnight would otherwise own the ranking.
            const startedAt = useTs.get(b.tool_use_id);
            const endedAt = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
            const elapsed = (startedAt && !Number.isNaN(endedAt) && endedAt >= startedAt)
                ? endedAt - startedAt : null;
            if (elapsed !== null) stats.timed++;

            if (!byClass.has(id)) byClass.set(id, { count: 0, sessions: new Set(), perSession: new Map(), examples: [], ms: [] });
            const c = byClass.get(id);
            c.count++;
            c.sessions.add(sessionKey);
            if (elapsed !== null) c.ms.push(elapsed);
            c.perSession.set(sessionKey, (c.perSession.get(sessionKey) || 0) + 1);
            if (c.examples.length < 3) {
                const ex = redact(text.replace(/\s+/g, ' ').trim()).slice(0, 160);
                if (!c.examples.includes(ex)) c.examples.push(ex);
            }

            // Per-day series. A harness change is only known to have worked if
            // the class it targeted actually falls afterwards; a single-window
            // total cannot show that, and "it feels better" is not a measurement.
            const day = (typeof d.timestamp === 'string' ? d.timestamp : '').slice(0, 10) || 'undated';
            if (!byDay.has(day)) byDay.set(day, new Map());
            const dm = byDay.get(day);
            dm.set(id, (dm.get(id) || 0) + 1);
            dm.set('__total', (dm.get('__total') || 0) + 1);

            if (!bySession.has(sessionKey)) bySession.set(sessionKey, { errors: 0, classes: new Map() });
            const s = bySession.get(sessionKey);
            s.errors++;
            s.classes.set(id, (s.classes.get(id) || 0) + 1);
        }
    }
}

const ranked = [...byClass.entries()]
    .map(([id, v]) => {
        // Domination: one stuck session can own a class outright, and then the
        // gross count describes that session rather than the fleet. Carry the
        // top contributor's share so the ranking cannot be silently misread.
        const top = [...v.perSession.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
        const sorted = [...v.ms].sort((x, y) => x - y);
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
        const totalMs = v.ms.reduce((acc, x) => acc + x, 0);
        return {
            id,
            count: v.count,
            sessions: v.sessions.size,
            top_session: top[0],
            top_session_share: v.count ? top[1] / v.count : 0,
            median_s: median === null ? null : Math.round(median / 100) / 10,
            total_min: Math.round(totalMs / 6000) / 10,
            timed: v.ms.length,
            fix: (CLASSES.find((c) => c.id === id) || {}).fix || '',
            examples: v.examples,
        };
    })
    .filter((r) => r.count >= MIN)
    // Sort by SESSIONS AFFECTED first: a class hitting 23 sessions once each is
    // a fleet problem; one hitting a single session 240 times is that session.
    .sort((a, b) => (b.sessions - a.sessions) || (b.count - a.count));

// A class that fires repeatedly inside ONE session is a session that got stuck,
// which is a different (and more expensive) problem than the same count spread
// thinly across many sessions.
const stuck = [...bySession.entries()]
    .flatMap(([sess, v]) => [...v.classes.entries()]
        .filter(([, n]) => n >= 3)
        .map(([id, n]) => ({ session: sess, class: id, count: n })))
    .sort((a, b) => b.count - a.count);

function main() {
    if (AS_JSON) {
        console.log(JSON.stringify({ window_days: DAYS, population: stats, classes: ranked, stuck }, null, 2));
        return 0;
    }

    // Population FIRST. A ranked list with no denominator is indistinguishable from
    // a probe that returned nothing — print what was scanned, per rule-gate-integrity.
    console.log(`session-pattern scan — last ${DAYS} day(s), root ${ROOT}`);
    // The registry of sessions is machine-local, so this reads THIS box only.
    // Saying "fleet" while covering one of two machines is the same error as
    // quoting a 7-day average as current state: the number is real and it
    // describes something narrower than the word attached to it.
    console.log(`scope: this machine only (${os.hostname()}) — sessions on other machines are invisible from here`);
    console.log(`population: ${stats.filesInWindow} of ${stats.filesSeen} transcripts touched in window, `
        + `${stats.lines} lines read (${stats.linesBeforeWindow} older than the window, skipped),`);
    console.log(`            ${stats.toolResults} tool results IN WINDOW, ${stats.errors} errored`
        + `${stats.toolResults ? ` (${((stats.errors / stats.toolResults) * 100).toFixed(1)}%)` : ''}\n`);
    console.log(`            ${stats.timed} of those errors could be priced in wall clock (tool_use to tool_result, permission waits included)`);

    if (stats.filesSeen === 0) {
        console.log('PROBE BLIND — no transcripts found at all. Wrong --root, or this is not the machine that ran them.');
        return 2;
    }
    if (stats.errors === 0) {
        console.log(`No errored tool calls in the window. (${stats.toolResults} tool results were scanned, so the probe could see.)`);
        return 0;
    }

    const pad = (s, n) => String(s).padEnd(n);
    console.log('ranked by SESSIONS AFFECTED (breadth), not gross hits');
    console.log(pad('class', 32) + pad('sessions', 10) + pad('hits', 7) + pad('of errs', 9) + 'concentration');
    console.log('-'.repeat(82));
    for (const r of ranked) {
        const share = ((r.count / stats.errors) * 100).toFixed(1) + '%';
        const conc = r.top_session_share >= 0.5
            ? `${(r.top_session_share * 100).toFixed(0)}% from ONE session`
            : '';
        console.log(pad(r.id, 32) + pad(r.sessions, 10) + pad(r.count, 7) + pad(share, 9) + conc);
    }

    if (!NO_EXAMPLES) {
        console.log('\nwhat to change:');
        for (const r of ranked) {
            if (!r.fix) continue;
            console.log(`\n  ${r.id} — ${r.sessions} session(s), ${r.count} hit(s)`);
            console.log(`    fix: ${r.fix}`);
            for (const ex of r.examples.slice(0, 2)) console.log(`    saw: ${ex}`);
        }
        const un = ranked.find((r) => r.id === 'unclassified');
        if (un) {
            console.log(`\n  unclassified — ${un.sessions} session(s), ${un.count} hit(s)`);
            console.log('    These are the classes the taxonomy does not know yet. Read them and');
            console.log('    add a CLASSES entry, or the ranking silently under-counts what you hit.');
            for (const ex of un.examples) console.log(`    saw: ${ex}`);
        }
    }

    // Cost view. Breadth answers 'how many sessions trip on this'; this answers
    // 'how long were they stuck', and the two disagree. The most expensive class
    // measured on this machine cost two hours across two hits, which any
    // frequency ranking buries.
    if (args.includes('--by-cost')) {
        const byCost = [...ranked].filter((r) => r.timed > 0).sort((a, b) => b.total_min - a.total_min);
        console.log('');
        console.log('ranked by WALL-CLOCK COST (includes permission waits; NOT execution time)');
        console.log(pad('class', 32) + pad('total min', 11) + pad('median s', 10) + 'timed/hits');
        console.log('-'.repeat(70));
        for (const r of byCost) {
            console.log(pad(r.id, 32) + pad(r.total_min, 11) + pad(r.median_s, 10) + r.timed + '/' + r.count);
        }
        console.log('');
        console.log('Median, not mean: one call left pending overnight would own a mean.');
    }

    if (args.includes('--by-day')) {
        const days = [...byDay.keys()].filter((d) => d !== 'undated').sort();
        const top = ranked.filter((r) => r.id !== 'unclassified').slice(0, 6).map((r) => r.id);
        console.log('\nper-day counts — did a harness change actually move the class it targeted?');
        console.log(pad('day', 12) + pad('total', 7) + top.map((t) => pad(t.slice(0, 13), 15)).join(''));
        for (const d of days) {
            const m = byDay.get(d);
            console.log(pad(d, 12) + pad(m.get('__total') || 0, 7) + top.map((t) => pad(m.get(t) || 0, 15)).join(''));
        }
        console.log('\nRead a fall here as evidence only if you can name the change that caused it,');
        console.log('and check the total: a class can drop because the fleet went quiet that day.');
    }

    if (stuck.length) {
        console.log('\nsessions that got STUCK (same class 3+ times in one session):');
        for (const s of stuck.slice(0, 12)) console.log(`  ${pad(s.count + 'x', 5)} ${pad(s.class, 26)} ${s.session}`);
    }

    return 0;
}

// process.exit() TRUNCATES output, and only on some platforms.
//
// node's process.stdout is ASYNCHRONOUS when it is a PIPE on POSIX (Linux and
// macOS alike) and synchronous when it is a pipe on win32; it is synchronous
// for a FILE everywhere. process.exit() terminates without draining a
// pending async write, so a run that prints more than the 64KiB OS pipe buffer
// and then exits delivers exactly 65536 bytes — under exit status 0, because
// the write never failed. A silent wrong answer, not a visible failure. The
// three things that hide it: a file redirect is synchronous so the output looks
// whole, the status is 0 so CI stays green (a Linux pipe is asynchronous too,
// so CI is exposed and cannot see it), and nothing compares byte counts.
//
// Setting process.exitCode instead lets the event loop drain the stream and
// exit on its own with the same status. Nothing here holds the loop open.
// See rendered-layout-gate.js for the case that cost this, and CLAUDE.md under
// conventions that have actually cost something.
process.exitCode = main();
