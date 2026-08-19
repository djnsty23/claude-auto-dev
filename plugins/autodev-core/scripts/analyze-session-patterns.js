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
const ROOT = flag('root', path.join(os.homedir(), '.claude', 'projects'));

// ---------------------------------------------------------------------------
// The classes. Every pattern here was read off real transcripts on this machine
// (2026-08-19, 277 errored tool calls over 36h) rather than imagined — an
// invented taxonomy ranks the classes you thought of, not the ones you hit.
//
// `fix` is what would stop the class recurring. It is the payload: a ranked list
// with no remedy is a complaint.
// ---------------------------------------------------------------------------
const CLASSES = [
    {
        id: 'edit-before-read',
        test: /has not been read yet/i,
        fix: 'Read (or open) the file in-session before Edit/Write. Cheapest class to kill: it is one extra call, always known in advance.',
    },
    {
        id: 'file-changed-since-read',
        test: /has been modified since read|File has been modified/i,
        fix: 'Something rewrote the file between the Read and the Edit — usually a formatter or the PostToolUse typecheck, not the user. Distinct from edit-before-read: the read HAPPENED and was invalidated, so the cost is a forced re-read per edit, not a forgotten one.',
    },
    {
        id: 'tool-disabled-for-agent',
        test: /No such tool available|is disabled for this session/i,
        fix: 'A read-only agent was handed writing work. Fix the dispatch, not the agent: send the edit to a agent that has Write, or stop asking a reviewer to apply its own findings.',
    },
    {
        id: 'security-file-blocked',
        test: /Cannot modify security-critical file/i,
        fix: "The harness's own guard, working as designed. Route settings changes through the documented path instead of retrying the edit.",
    },
    {
        // Merged from the old browser-no-site and browser-no-preview. Triage of
        // 25 unclassified errors found 14 were browser failures and every one
        // was the same mistake wearing a different message: a call whose
        // precondition had not been established, or had expired. Splitting them
        // by wording produced classes with one identical fix, which is one class.
        id: 'browser-state-not-established',
        test: /No site is open in this tab|Inspected target navigated or closed|Server not found\. No running servers|No preview is open|tab group no longer exists|not found — it may be stale|pinned to a local file preview|no read_page tree cached|requires a prior computer\{action:"screenshot"\}|navigation to \S+ was denied/i,
        fix: 'A browser call ran before its precondition existed, or after it expired. Establish state first (preview_start / navigate / read_page / screenshot) and RE-assert it after any navigation — tab groups, serverIds and cached trees do not survive one.',
    },
    {
        id: 'browser-renderer-hung',
        test: /renderer may be frozen|No browser responded within the timeout|CDP sendCommand .* timed out|timed out after \d+s\.? The (?:preview|Browser pane)/i,
        fix: 'The page or the pane stopped responding, which is not the same as a wrong call — retrying the identical command is the one thing that cannot help. Check console logs, then reload the tab or restart the browser surface.',
    },
    {
        id: 'hook-blocked-command',
        test: /Blocked potentially dangerous command|<tool_use_error>Blocked:/i,
        fix: 'The PreToolUse filter refused the command. Long inline `node -e`/`python -c` and chained sleeps are the usual triggers — write a script file and run that.',
    },
    {
        id: 'permission-denied',
        test: /Permission to use \w+ with command|denied by the Claude Code auto mode classifier|requested permissions|user doesn't want to proceed/i,
        fix: 'A denial is a decision, not an obstacle. Prose-style denials come from the semantic judge, not the allowlist — do not promise an allowlist fix for one.',
    },
    {
        id: 'browser-not-composited',
        test: /Browser pane is not displayed|not composit|Screenshot timed out/i,
        fix: 'The in-app Browser pane cannot screenshot while it is not displayed. Use chrome-devtools for screenshots, or bring the pane forward first.',
    },
    {
        id: 'browser-script-error',
        test: /javascript_tool failed|Failed to fetch at <anonymous>|has already been declared/i,
        fix: 'The injected script itself threw. Note the page keeps one scope across calls, so a re-run of the same `const` is a redeclaration error rather than a fresh start — wrap in an IIFE.',
    },
    {
        id: 'sql-schema-guess',
        test: /42703|column \S+ does not exist|relation \S+ does not exist/i,
        fix: 'The query named a column the table does not have. Introspect the schema once (information_schema, or a select * limit 1) instead of paying a failed round trip per guessed column — seven in a row on one agent is the observed worst case.',
    },
    {
        id: 'shell-quoting',
        test: /unexpected EOF while looking for matching|unterminated quoted string|syntax error near unexpected token/i,
        fix: 'Quoting collapsed in a long one-liner. Write the script to a file and run that; the same text behaves differently in Git Bash, cmd and PowerShell.',
    },
    {
        id: 'agent-schema-violation',
        test: /Output does not match required schema/i,
        fix: 'A subagent returned a shape its schema forbids. Usually an over-strict additionalProperties or a required field the prompt never asked the agent to produce — fix the contract, not the agent.',
    },
    {
        id: 'browser-chrome-unselected',
        test: /Multiple Chrome browsers are connected/i,
        fix: 'select_browser once at the start of a browser task; every subsequent call fails identically until you do.',
    },
    {
        id: 'js-top-level-await',
        test: /await is only valid in async functions/i,
        fix: 'javascript_tool evaluates an expression, not a module. Wrap in (async () => { ... })() or use .then().',
    },
    {
        id: 'command-timeout',
        test: /Command timed out after|Exit code 143/i,
        fix: 'Raise the timeout explicitly or background the command. A 2m default kill mid-write can leave a partial file.',
    },
    {
        id: 'edit-anchor-missing',
        test: /String to replace not found|Found \d+ matches of the string to replace/i,
        fix: 'Anchor discipline: re-read the exact bytes before editing. A stale anchor means the file moved under you.',
    },
    {
        // Split out of file-missing on purpose: this one is a CROSS-TOOL
        // structural fault (the shell and Node disagree about what /tmp is), not
        // a typo, so it is the only path-failure a guard could plausibly catch.
        // Kept separate so its frequency can be measured rather than assumed.
        id: 'tmp-path-split',
        // The commonest form is a bare POSIX /tmp path that Node could not
        // resolve — "Cannot find module '/tmp/ai.json'". The first version of
        // this pattern only matched the C:\tmp spelling, so it missed exactly
        // the case the rule exists for and filed it under shell-nonzero-exit.
        test: /[A-Za-z]:\\+tmp[\\/]|open '[A-Za-z]:\\tmp|(?:Cannot find module|ENOENT[^\n]*open|cannot open) '\/tmp\/|cannot open '\/[^/]+\.(txt|json|log)'/i,
        fix: 'Git Bash resolves /tmp differently from Node/Python on Windows: the shell writes /tmp/x, the reader looks in C:\\tmp\\x. Use the session scratchpad absolute path on both sides.',
    },
    {
        id: 'file-missing',
        test: /File does not exist|ENOENT|no such file or directory|readFileUtf8/i,
        fix: 'Path did not resolve. On Windows the usual causes are /tmp meaning two different places and a worktree-relative path used from the main tree.',
    },
    {
        id: 'not-a-git-repo',
        test: /Not a git repository|not a git repository/i,
        fix: 'The cwd is not the repo. Downloads/code/autodev in particular is the telemetry dir, not the source tree.',
    },
    {
        id: 'network-unreachable',
        test: /getaddrinfo|ENOTFOUND|ECONNREFUSED|Max retries exceeded|Failed to resolve/i,
        fix: 'No egress from this shell. Prefer a local ground truth; do not report a network failure as an empty result.',
    },
    // Catch-all LAST: a non-zero shell exit that no class above explains. Note a
    // counting grep exits 1 on no-match, so some of these are answers, not faults.
    {
        id: 'shell-nonzero-exit',
        test: /^Exit code [1-9]/im,
        fix: 'Check whether the non-zero exit IS the answer (grep/diff --quiet/test exit 1 on "found nothing") before treating it as a fault.',
    },
];

const REDACT = [
    [/\b(sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{8,}/g, '<token>'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, '<jwt>'],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
];
const redact = (s) => REDACT.reduce((acc, [re, to]) => acc.replace(re, to), s);

// Classify on the HEAD of the message, not the whole blob. A 6KB command output
// that happens to contain the word ENOENT three screens down is not an ENOENT
// failure, and matching deep into the body mislabels long outputs as whatever
// they happen to mention.
function classify(text) {
    const head = text.slice(0, 400);
    for (const c of CLASSES) if (c.test.test(head)) return c.id;
    return 'unclassified';
}

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
};
const byClass = new Map();   // id -> { count, sessions:Set, perSession:Map, examples }
const bySession = new Map(); // session file -> { errors, classes:Map }
const byDay = new Map();     // YYYY-MM-DD -> Map(classId -> count)

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

            if (!byClass.has(id)) byClass.set(id, { count: 0, sessions: new Set(), perSession: new Map(), examples: [] });
            const c = byClass.get(id);
            c.count++;
            c.sessions.add(sessionKey);
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
        return {
            id,
            count: v.count,
            sessions: v.sessions.size,
            top_session: top[0],
            top_session_share: v.count ? top[1] / v.count : 0,
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

if (AS_JSON) {
    console.log(JSON.stringify({ window_days: DAYS, population: stats, classes: ranked, stuck }, null, 2));
    process.exit(0);
}

// Population FIRST. A ranked list with no denominator is indistinguishable from
// a probe that returned nothing — print what was scanned, per rule-gate-integrity.
console.log(`session-pattern scan — last ${DAYS} day(s), root ${ROOT}`);
console.log(`population: ${stats.filesInWindow} of ${stats.filesSeen} transcripts touched in window, `
    + `${stats.lines} lines read (${stats.linesBeforeWindow} older than the window, skipped),`);
console.log(`            ${stats.toolResults} tool results IN WINDOW, ${stats.errors} errored`
    + `${stats.toolResults ? ` (${((stats.errors / stats.toolResults) * 100).toFixed(1)}%)` : ''}\n`);

if (stats.filesSeen === 0) {
    console.log('PROBE BLIND — no transcripts found at all. Wrong --root, or this is not the machine that ran them.');
    process.exit(2);
}
if (stats.errors === 0) {
    console.log(`No errored tool calls in the window. (${stats.toolResults} tool results were scanned, so the probe could see.)`);
    process.exit(0);
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

process.exit(0);
