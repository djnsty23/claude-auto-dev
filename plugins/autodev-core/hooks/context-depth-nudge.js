#!/usr/bin/env node
// Stop hook — says, once, when a session has grown past the restart line.
//
// THE RULE IT ENFORCES. Context depth is the bill: measured over 19,419
// requests in one weekly quota window, 77% of weighted cost was cache READ, the
// average main-thread request re-read 405k tokens to emit 1,063, and the second
// half of a session cost 1.44x the first half for the same turn count. The rule
// that came out of it says: past ~300k, finish the step, write RESUME.md, and
// start fresh. Modelled saving 29% at a 300k reset, 46% at 200k.
//
// Until 2026-09-05 nothing in this plugin enforced that. The rule lived in
// prose, and prose does not fire. This hook is the mechanical half. The shape
// was borrowed from the one idea worth taking out of an evaluation of a much
// larger harness (docs/decisions.md, 2026-09-05), whose context monitor guessed
// depth from transcript BYTES. This one reads the TRUE figure: every assistant
// row in a Claude Code transcript carries `message.usage`, and
// input + cache_read + cache_creation on the latest one is the context that
// call was billed for.
//
// WHY STOP, AND WHY IT NEVER BLOCKS. Stop fires once per turn, not once per
// tool call, so the transcript is read once per turn from its tail. A Stop hook
// can hold a turn open; this one must not, because it ships installed and the
// thing it would hold a turn for is a nudge. It emits `additionalContext` (the
// field the model reads at the start of its next turn) and `systemMessage` (the
// line the operator sees), and no `decision`, so it cannot fight
// stop-auto-check's approve/block. Every path exits 0.
//
// WHY IT SPEAKS ONCE PER STEP. A hook that speaks every turn is a hook that gets
// ignored; the same repo's own Stop hooks say so and throttle. This one speaks
// when a session first crosses the line, then again per further STEP (default
// 100k), and is silent in between. The ledger is per session_id so two
// sessions in one home directory do not share a memory.
//
// SILENT MEANS ZERO BYTES on both streams. A hook with nothing to say emits
// nothing, and the suite asserts that against every quiet path.

const fs = require('fs');
const os = require('os');
const path = require('path');

const THRESHOLD_DEFAULT = 300_000;
const STEP_DEFAULT = 100_000;
const CHUNK = 256 * 1024;        // bytes read per backward step
const MAX_SCAN = 16 * 1024 * 1024; // give up past this much tail; a row can be big
const LEDGER_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('context-depth-nudge.js — Stop hook.\n'
        + 'Reads the latest assistant row\'s usage from transcript_path and, once per\n'
        + 'step past the restart line, tells the model to finish the step and write\n'
        + 'RESUME.md, and tells the operator to start a fresh session.\n'
        + 'Line:     $AUTODEV_CONTEXT_NUDGE_TOKENS, default ' + THRESHOLD_DEFAULT + ' (rule 14c).\n'
        + 'Step:     $AUTODEV_CONTEXT_NUDGE_STEP, default ' + STEP_DEFAULT + '.\n'
        + 'Ledger:   $AUTODEV_CONTEXT_NUDGE_STATE, else ~/.claude/context-nudge-state.json.\n'
        + 'Disable:  AUTODEV_CONTEXT_NUDGE=off.\n'
        + 'Never blocks a turn; every path exits 0; silence is zero bytes.');
    process.exit(0);
}

/** Nothing to say. */
function silent() {
    process.exit(0);
}

function positiveInt(raw, fallback) {
    const n = Number.parseInt(String(raw == null ? '' : raw), 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function ledgerPath() {
    return process.env.AUTODEV_CONTEXT_NUDGE_STATE
        || path.join(os.homedir(), '.claude', 'context-nudge-state.json');
}

function readJson(p) {
    try {
        const v = JSON.parse(fs.readFileSync(p, 'utf8'));
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

/**
 * Context depth of the latest assistant call in a transcript, read from the
 * tail backwards so a multi-megabyte transcript costs one stat and a few
 * chunk reads. Returns null when no assistant row with usage is found within
 * MAX_SCAN bytes, or the file cannot be read.
 *
 * Why backwards and chunked rather than "read the last 256KB": a single
 * attachment row (a large tool result) can exceed any fixed tail, and a fixed
 * tail with no usage row in it would read as "no depth", which is a silence
 * that means the probe was too small rather than the session too shallow.
 */
function latestContextDepth(transcriptPath) {
    let fd;
    try {
        fd = fs.openSync(transcriptPath, 'r');
        const size = fs.fstatSync(fd).size;
        let end = size;
        let carry = '';
        let scanned = 0;
        while (end > 0 && scanned < MAX_SCAN) {
            const start = Math.max(0, end - CHUNK);
            const buf = Buffer.alloc(end - start);
            fs.readSync(fd, buf, 0, end - start, start);
            scanned += end - start;
            const text = buf.toString('utf8') + carry;
            const lines = text.split('\n');
            // The first element may be a partial line cut by the chunk boundary;
            // it is carried into the next (earlier) chunk and completed there.
            carry = start > 0 ? lines.shift() : '';
            for (let i = lines.length - 1; i >= 0; i--) {
                const depth = depthOfRow(lines[i]);
                if (depth != null) return depth;
            }
            end = start;
        }
        // Reached the file start: the carry is now a whole first line.
        return carry ? depthOfRow(carry) : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* nothing to recover */ }
        }
    }
}

/** Context depth from one transcript row, or null if it is not an assistant row with usage. */
function depthOfRow(line) {
    if (!line || line.indexOf('"usage"') === -1) return null;
    let row;
    try {
        row = JSON.parse(line);
    } catch {
        return null; // a truncated or foreign line; keep scanning
    }
    if (!row || row.type !== 'assistant' || !row.message || !row.message.usage) return null;
    const u = row.message.usage;
    const n = (Number(u.input_tokens) || 0)
        + (Number(u.cache_read_input_tokens) || 0)
        + (Number(u.cache_creation_input_tokens) || 0);
    return n > 0 ? n : null;
}

function readPayload() {
    try {
        if (process.stdin.isTTY) return null;
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return null;
    }
}

const disabled = String(process.env.AUTODEV_CONTEXT_NUDGE || '').trim().toLowerCase();
if (disabled === 'off' || disabled === '0' || disabled === 'false') silent();

const payload = readPayload();
if (!payload || typeof payload !== 'object') silent();

const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
const transcriptPath = typeof payload.transcript_path === 'string' && payload.transcript_path ? payload.transcript_path : null;
if (!sessionId || !transcriptPath) silent();

const threshold = positiveInt(process.env.AUTODEV_CONTEXT_NUDGE_TOKENS, THRESHOLD_DEFAULT);
const step = positiveInt(process.env.AUTODEV_CONTEXT_NUDGE_STEP, STEP_DEFAULT);

const depth = latestContextDepth(transcriptPath);
if (depth == null || depth < threshold) silent();

// 0 at the line, 1 one step past it, and so on. Speaks when this rises.
const bucket = Math.floor((depth - threshold) / step);

const ledger = readJson(ledgerPath()) || {};
const prior = ledger[sessionId];
if (prior && Number.isInteger(prior.bucket) && prior.bucket >= bucket) silent();

writeLedger(ledger, sessionId, { bucket, depth, at: Date.now() });

const k = (n) => Math.round(n / 1000) + 'k';
const forModel = 'CONTEXT DEPTH IS ' + depth.toLocaleString('en-US') + ' TOKENS, PAST THE '
    + k(threshold) + ' RESTART LINE. Rule 14c: 77% of cost is cache reads and every turn '
    + 're-reads this whole conversation, so a session past this line costs more per turn '
    + 'than it did at the start and clusters wrong diagnoses. Finish the CURRENT step, '
    + 'write RESUME.md (what is done, what was verified and by which command, what is '
    + 'next), say so to whoever is coordinating, and stop. Do not start a new piece of '
    + 'work at this depth.';
const forOperator = 'Context depth ' + k(depth) + ' tokens, past the ' + k(threshold)
    + ' restart line (rule 14c). Let this step finish, then start a fresh session.';

console.log(JSON.stringify({
    systemMessage: forOperator,
    hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: forModel,
    },
}));
process.exit(0);

function writeLedger(all, id, entry) {
    try {
        all[id] = entry;
        const cutoff = Date.now() - LEDGER_MAX_AGE_MS;
        for (const key of Object.keys(all)) {
            const e = all[key];
            if (!e || typeof e !== 'object' || !(Number(e.at) > cutoff)) delete all[key];
        }
        all[id] = entry;
        const p = ledgerPath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(all, null, 2) + '\n');
    } catch {
        /* a ledger we cannot write costs a repeated nudge, never a broken turn */
    }
}
