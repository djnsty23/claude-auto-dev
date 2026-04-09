#!/usr/bin/env node
// UserPromptSubmit hook — detect image attachments and ask the model to
// scan the whole image for every issue, not only what the user asked about.
//
// Fires on every user turn. Reads the transcript tail to find the latest user
// message; if any content item has type:"image", injects a directive via
// additionalContext. No-op otherwise. Must be cheap: target < 50 ms.

const fs = require('fs');
const path = require('path');

// Hard budget — if anything takes longer, bail silently.
const DEADLINE_MS = 150;
const started = Date.now();
const timeLeft = () => DEADLINE_MS - (Date.now() - started);

function done(extraContext) {
    if (extraContext) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: extraContext,
            },
        }));
    }
    process.exit(0);
}

function fail(msg) {
    // Never block the prompt — degraded scan is better than a broken turn.
    process.stderr.write('[image-scan] ' + msg + '\n');
    process.exit(0);
}

// --- Read stdin (UTF-8) ---
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
    try {
        if (timeLeft() <= 0) return done(null);

        let payload;
        try { payload = JSON.parse(raw); } catch { return done(null); }

        const transcriptPath = payload && payload.transcript_path;
        if (!transcriptPath || !fs.existsSync(transcriptPath)) return done(null);

        // --- Tail-read transcript: last ~128 KB is plenty for the current turn ---
        const TAIL_BYTES = 128 * 1024;
        let tail;
        let tailedMidFile = false;
        try {
            const stat = fs.statSync(transcriptPath);
            const start = Math.max(0, stat.size - TAIL_BYTES);
            tailedMidFile = start > 0;
            const fd = fs.openSync(transcriptPath, 'r');
            const buf = Buffer.alloc(stat.size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            fs.closeSync(fd);
            tail = buf.toString('utf8');
        } catch { return done(null); }

        // JSONL: split; if we started mid-file the first line is likely partial, drop it.
        const lines = tail.split('\n');
        if (tailedMidFile && lines.length > 1) lines.shift();

        // Walk backwards to find the most recent user-role message.
        let userEntry = null;
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            if (timeLeft() <= 0) return done(null);
            let rec;
            try { rec = JSON.parse(line); } catch { continue; }
            // CC transcript shape: { type: "user", message: { role: "user", content: [...] } }
            // Be permissive — also accept {role: "user", content: [...]}.
            const msg = rec.message || rec;
            if (msg && msg.role === 'user' && Array.isArray(msg.content)) {
                userEntry = msg;
                break;
            }
        }
        if (!userEntry) return done(null);

        // --- Detect image content items ---
        let imageCount = 0;
        for (const item of userEntry.content) {
            if (item && typeof item === 'object' && item.type === 'image') {
                imageCount++;
            }
        }
        if (imageCount === 0) return done(null);

        // --- Auto mode quieter directive ---
        // Use payload.cwd (the project Claude is working in), not process.cwd()
        // which reflects the shell that spawned the hook.
        const projectCwd = (payload && payload.cwd) || process.cwd();
        const autoActive = fs.existsSync(path.join(projectCwd, '.claude', 'auto-active'));

        const suffix = imageCount > 1 ? 's' : '';
        const lead = imageCount > 1
            ? imageCount + ' images are attached to this turn.'
            : 'An image is attached to this turn.';

        const baseDirective =
`${lead} In addition to answering the user's explicit question, do a full pass on the image${suffix}:

1. Extract every distinct issue, concern, bug report, error, TODO, or risk visible in the image${suffix} — not only the one the user named.
2. For each one, decide whether it is actionable in this codebase. Cross-check against the repo only when the finding references a file path, function name, URL on a known project domain, error string, or obvious code construct. Skip cross-checks that would require speculative searches.
3. Cap output at 5 additional findings per image. Prefer high-signal over completeness.
4. Present the extras under a final section titled "Also found in the image" with one bullet per finding and a one-line rationale. If nothing extra is found, omit the section entirely — do not write "nothing else found."
5. Do not echo sensitive substrings (emails, tokens, names) verbatim; summarise instead.
6. If the user's prompt contains "[focus]" anywhere, skip this extra scan — they explicitly asked for a narrow response.`;

        const autoDirective =
`${baseDirective}

AUTO MODE IS ACTIVE: do not act on the extra findings in this turn. Instead, append them as a markdown section to .claude/reports/image-scan-${Date.now()}.md (create the directory if missing via the Write tool). Keep your current sprint task as the primary focus.`;

        return done(autoActive ? autoDirective : baseDirective);
    } catch (e) {
        return fail(e.message);
    }
});

process.stdin.on('error', (e) => fail('stdin error: ' + e.message));

// Safety net: if stdin never closes, exit after the deadline.
setTimeout(() => done(null), DEADLINE_MS + 50).unref();
