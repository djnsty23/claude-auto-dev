#!/usr/bin/env node
// hooks_profile=minimal (plugin userConfig, reaching hooks as CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE)
// skips this hook: it advises, it never guards. tooling/test-hooks-profile.js holds the list.
if (/^minimal$/i.test(process.env.CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE || process.env.CLAUDE_PLUGIN_OPTION_hooks_profile || '')) process.exit(0);

// PreModelSwitch hook: says what a model switch forfeits, before it happens.
//
// THE RULE IT ENFORCES. "Never alternate models on one thread." Prompt caches
// are model-scoped, so a switch makes the new model re-read the whole
// conversation uncached. Switching AWAY from Fable 5.1 also drops its thinking
// blocks, because no other model can read them. Until this hook, only prose
// carried that rule, and prose does not fire at the moment a switch is typed.
//
// THE CONTRACT, READ FROM THE BINARY AND A CAPTURED PAYLOAD, NOT FROM THE DOCS.
// [measured 2026-09-13, Claude Code 2.1.261] the hook-input schema carries, on
// top of session_id / transcript_path / cwd: from_model, to_model,
// requested_model, source (command|picker|sdk), context_tokens,
// prompt_cache_warm, cache_ttl, estimated_cache_write_usd and pricing. A real
// headless set_model delivered exactly those keys. So depth comes from
// `context_tokens`, the harness's own figure; the transcript is read only when
// that field is absent (an older build).
//
// WHY IT NEVER RETURNS A permissionDecision. The schema describes `allow` as
// "skipping the interactive cache-miss confirm". A hook that said allow would
// silently switch off the harness's own guard for exactly the case this hook
// exists to flag. `deny` is wrong too: the user typed /model on purpose. So the
// hook emits a top-level `systemMessage` and nothing else. It also emits no
// `hookSpecificOutput.additionalContext`: that field is in PostModelSwitch's
// output schema and absent from PreModelSwitch's.
//
// WHEN IT SPEAKS. Only when the two models differ AND context is at or above
// the line (default 100k). Below it the cold read is cheap. At or above it, it
// names the forfeited cache when the cache is warm (a cold cache is re-read in
// full either way, so nothing is lost), and the dropped thinking blocks when
// leaving Fable 5.1. No prices: they are volatile and this machine bills a
// subscription.
//
// SILENT MEANS ZERO BYTES on both streams, and every path exits 0.

const fs = require('fs');

const THRESHOLD_DEFAULT = 100_000;
const CHUNK = 256 * 1024;
const MAX_SCAN = 16 * 1024 * 1024;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('model-switch-note.js — PreModelSwitch hook.\n'
        + 'When from_model and to_model differ and context is at or above the line, tells\n'
        + 'the operator the new model re-reads that context uncached (when the cache is\n'
        + 'warm) and that Fable 5.1 thinking blocks are dropped (when leaving Fable 5.1).\n'
        + 'Depth:    payload context_tokens, else the latest usage row in transcript_path.\n'
        + 'Line:     $AUTODEV_MODEL_SWITCH_NOTE_TOKENS, default ' + THRESHOLD_DEFAULT + '.\n'
        + 'Disable:  AUTODEV_MODEL_SWITCH_NOTE=off.\n'
        + 'Never returns a permissionDecision: allow would skip the harness cache-miss confirm.\n'
        + 'Every path exits 0; silence is zero bytes.');
    process.exit(0);
}

function positiveInt(raw, fallback) {
    const n = Number.parseInt(String(raw == null ? '' : raw), 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function readPayload() {
    try {
        if (process.stdin.isTTY) return null;
        const v = JSON.parse(fs.readFileSync(0, 'utf8'));
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

/** True for any Fable 5.1 id, including suffixed variants such as `[1m]`. */
function isFable51(id) {
    return /fable-5-1/i.test(id);
}

/**
 * Context of the latest assistant call, read backwards from the transcript
 * tail. Summed the way the harness defines context_tokens: input + cache_read
 * + cache_creation + output. Null when unreadable or no usage row is found.
 */
function transcriptDepth(transcriptPath) {
    let fd;
    try {
        fd = fs.openSync(transcriptPath, 'r');
        let end = fs.fstatSync(fd).size;
        let carry = '';
        let scanned = 0;
        while (end > 0 && scanned < MAX_SCAN) {
            const start = Math.max(0, end - CHUNK);
            const buf = Buffer.alloc(end - start);
            fs.readSync(fd, buf, 0, end - start, start);
            scanned += end - start;
            const lines = (buf.toString('utf8') + carry).split('\n');
            carry = start > 0 ? lines.shift() : '';
            for (let i = lines.length - 1; i >= 0; i--) {
                const d = depthOfRow(lines[i]);
                if (d != null) return d;
            }
            end = start;
        }
        return carry ? depthOfRow(carry) : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* nothing to recover */ }
        }
    }
}

function depthOfRow(line) {
    if (!line || line.indexOf('"usage"') === -1) return null;
    let row;
    try {
        row = JSON.parse(line);
    } catch {
        return null;
    }
    if (!row || row.type !== 'assistant' || !row.message || !row.message.usage) return null;
    const u = row.message.usage;
    const n = (Number(u.input_tokens) || 0)
        + (Number(u.cache_read_input_tokens) || 0)
        + (Number(u.cache_creation_input_tokens) || 0)
        + (Number(u.output_tokens) || 0);
    return n > 0 ? n : null;
}

/** The operator line for this payload, or null when there is nothing to say. */
function noteFor(payload) {
    if (!payload) return null;
    if (typeof payload.hook_event_name === 'string' && payload.hook_event_name !== 'PreModelSwitch') return null;
    const from = typeof payload.from_model === 'string' ? payload.from_model.trim() : '';
    const to = typeof payload.to_model === 'string' ? payload.to_model.trim() : '';
    if (!from || !to || from === to) return null;

    const reported = payload.context_tokens;
    let depth = null;
    if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
        depth = reported;
    } else if (typeof payload.transcript_path === 'string' && payload.transcript_path) {
        depth = transcriptDepth(payload.transcript_path);
    }
    const threshold = positiveInt(process.env.AUTODEV_MODEL_SWITCH_NOTE_TOKENS, THRESHOLD_DEFAULT);
    if (depth == null || depth < threshold) return null;

    // Only an explicit false means cold. An absent field (older build) is
    // treated as warm, because warm is the case with something to lose.
    const cacheForfeited = payload.prompt_cache_warm !== false;
    const thinkingDropped = isFable51(from) && !isFable51(to);
    if (!cacheForfeited && !thinkingDropped) return null;

    const k = Math.round(depth / 1000) + 'k';
    const parts = ['Model switch ' + from + ' to ' + to + ' at ~' + k + ' tokens of context.'];
    if (cacheForfeited) {
        parts.push('Prompt caches are model-scoped, so ' + to + ' re-reads all ~' + k + ' uncached.');
    }
    if (thinkingDropped) {
        parts.push(from + ' thinking blocks are dropped: no other model can read them.');
    }
    return parts.join(' ');
}

const disabled = String(process.env.AUTODEV_MODEL_SWITCH_NOTE || '').trim().toLowerCase();
if (disabled !== 'off' && disabled !== '0' && disabled !== 'false') {
    const note = noteFor(readPayload());
    if (note) process.stdout.write(JSON.stringify({ systemMessage: note }) + '\n');
}
process.exitCode = 0;
