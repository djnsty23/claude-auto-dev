#!/usr/bin/env node
// The `image_scan` switch (plugin userConfig, CLAUDE_PLUGIN_OPTION_IMAGE_SCAN="false")
// skips this hook: it advises, it never guards. tooling/test-hooks-profile.js holds the list.
if (process.env.CLAUDE_PLUGIN_OPTION_IMAGE_SCAN === 'false') process.exit(0);

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

// Read complete JSONL records from the tail. A base64 image can exceed one
// chunk, so keep its incomplete prefix as bytes until the record is complete.
// The first user record decides even when its content is plain text.
function latestUserMessage(transcriptPath) {
    const CHUNK_BYTES = 128 * 1024;
    const MAX_SCAN_BYTES = 16 * 1024 * 1024;
    let fd;
    try {
        fd = fs.openSync(transcriptPath, 'r');
        let pos = fs.fstatSync(fd).size;
        let scanned = 0;
        let carry = Buffer.alloc(0);
        while (pos > 0 && scanned < MAX_SCAN_BYTES && timeLeft() > 0) {
            const length = Math.min(CHUNK_BYTES, pos, MAX_SCAN_BYTES - scanned);
            pos -= length;
            const chunk = Buffer.alloc(length);
            let read = 0;
            while (read < length) {
                const n = fs.readSync(fd, chunk, read, length - read, pos + read);
                if (!n) return null;
                read += n;
            }
            scanned += length;
            const bytes = Buffer.concat([chunk, carry]);
            let end = bytes.length;
            while (end > 0 && timeLeft() > 0) {
                const newline = bytes.lastIndexOf(10, end - 1);
                if (newline < 0 && pos > 0) break;
                const line = bytes.subarray(newline + 1, end).toString('utf8').trim();
                end = newline < 0 ? 0 : newline;
                if (!line) continue;
                let rec;
                try { rec = JSON.parse(line); } catch { continue; }
                const msg = rec && (rec.message || rec);
                if (msg && msg.role === 'user') return msg;
            }
            carry = bytes.subarray(0, end);
        }
        return null;
    } catch { return null; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
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

        const userEntry = latestUserMessage(transcriptPath);
        if (!userEntry || !Array.isArray(userEntry.content)) return done(null);

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
        // THIS session's flag (scripts/auto-flag.js), or a plain one not yet claimed.
        const autoFlags = require(path.join(__dirname, '..', 'scripts', 'auto-flag.js'));
        const autoActive = autoFlags.isActive(projectCwd, autoFlags.sidOf(payload))
            || fs.existsSync(path.join(projectCwd, '.claude', 'auto-active'));

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
