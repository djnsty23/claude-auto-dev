#!/usr/bin/env node
'use strict';

// peer-message-budget.js — refuse a fourth message to the same session inside an
// hour, because the rule saying not to has been written down twice and broken
// twice, and prose does not enforce.
//
// THE ASYMMETRY THAT MAKES THIS NECESSARY. A peer message is nearly free to send
// and expensive to receive: it arrives as a full user turn at the RECEIVER's
// context depth, not the sender's. So the sender has no feedback signal at all.
// Nothing gets slower, nothing costs more, nothing goes red. The cost lands
// somewhere the sender cannot see, which is exactly the shape a gate is for.
//
// `[measured 2026-08-25]` One session was sent NINE messages and another six as
// direction evolved. Both were opus-5 at xhigh effort, 31 and 50 hours old. One
// errored outright; both went silent, and both were holding unreported work. The
// rule "past three to a single session in an hour, stop and batch" was written
// from that night.
//
// `[measured 2026-09-05]` A coordinator then sent 59 messages totalling 135,242
// characters across 22 sessions in one night, including TEN to one session
// (26,341 chars) and NINE to another (19,688). It had the rule in context the
// whole time and had relayed it to others. That is the second occurrence, so the
// remedy is a gate rather than a third sentence.
//
// WHY THE COUNT IS PER RECIPIENT AND NOT GLOBAL. Fifty messages to fifty
// sessions is a broadcast, which is the half of coordination that measured well.
// Ten to one session is a relay layer wearing a delegate's clothes, and it is the
// half that measured at zero. The budget has to distinguish them, so it keys on
// session_id.
//
// IT FAILS OPEN. This ships installed in other people's sessions, so a defect
// here would persist until they reinstall. Any error, any unreadable transcript,
// any surprise payload shape: allow the send. A coordinator that cannot message
// its fleet is worse than one that messages it too much.
//
// Escape hatch: AUTODEV_PEER_BUDGET=off, and a deliberate override by putting
// the word OVERRIDE-BUDGET in the message itself, which forces the sender to say
// out loud that they are exceeding it.

const fs = require('fs');

const WINDOW_MIN = 60;
const LIMIT = 3;
const TOOL = 'mcp__ccd_session_mgmt__send_message';

/**
 * Prior DELIVERED sends to `target` within the window, newest first.
 * Returns null when the transcript cannot be read, which is NOT the same as
 * zero and must not be reported as a clean budget.
 *
 * `[measured 2026-09-09]` This counted `tool_use` blocks, and a call this hook
 * REFUSED is still a `tool_use` block in the transcript. Two consequences, both
 * seen the same night:
 *
 *   1. The budget became unrecoverable. Once blocked, the refusal itself
 *      occupied a slot, so every retry raised the count it was measured
 *      against. A coordinator that hit the limit could not send to that session
 *      again for the rest of the window even after waiting -- the only exits
 *      were OVERRIDE-BUDGET or the env switch. A budget you cannot get back
 *      under is not a budget, it is a ban, and it trains the override.
 *   2. It was off by one. The in-flight call is already in the transcript when
 *      PreToolUse runs, so it counted ITSELF as a prior send and refused the
 *      THIRD message while reporting it as "number 4". The header said "the
 *      limit is 3" over a list of two.
 *
 * Both come from one substitution: an ATTEMPT is not a SEND. The docstring said
 * "prior sends" the whole time; only the code disagreed.
 *
 * A refused call is identified by a `tool_result` carrying `is_error: true` and
 * the `tool_use_id` -- that is the shape a PreToolUse denial leaves. Results
 * always follow their call in the file, so one pass collects both and the
 * filtering happens at the end.
 *
 * The in-flight call is excluded by id: `selfUseId` comes from the PreToolUse
 * payload's `tool_use_id`, and a call is never its own precedent.
 *
 * WHY ABSENCE OF A RESULT DOES NOT EXEMPT A CALL, though it would have been the
 * tidier rule. "Count it only if it returned without an error" excludes the
 * in-flight call for free and needs no id. It was written that way first and
 * then withdrawn: if results were ever absent from the transcript this hook
 * reads -- lagging, written elsewhere, a shape change -- then NOTHING would
 * count, the budget would never fire, and it would look exactly like a
 * coordinator that stayed within it. That is the failure this repo keeps
 * finding: a check that is green because it cannot fail. The existing fixtures
 * in the suite are themselves result-free, which is how close it came.
 *
 * So the default is to COUNT, and only a positive refusal signal
 * (`is_error: true` against the call's id) removes one. The residual defect is
 * bounded and visible: if `tool_use_id` is ever missing from the payload, the
 * in-flight call counts itself and the budget refuses the third message instead
 * of the fourth -- which is exactly today's behaviour, so no regression, and it
 * errs toward enforcing.
 */
function priorSends(transcriptPath, target, nowMs, selfUseId) {
    let raw;
    try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }

    const cutoff = nowMs - WINDOW_MIN * 60 * 1000;
    const candidates = [];
    const refused = new Set();
    let scanned = 0;

    for (const line of raw.split('\n')) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const content = row && row.message && row.message.content;
        if (!Array.isArray(content)) continue;

        const t = Date.parse(row.timestamp || '');
        if (!Number.isFinite(t)) continue;

        for (const block of content) {
            if (!block) continue;

            // A refusal can be recorded outside the window while its call sits
            // inside it, so results are collected without the cutoff test.
            if (block.type === 'tool_result' && block.is_error === true && block.tool_use_id) {
                refused.add(block.tool_use_id);
                continue;
            }

            if (t < cutoff) continue;
            if (block.type !== 'tool_use' || block.name !== TOOL) continue;
            scanned++;
            const to = block.input && block.input.session_id;
            if (to !== target) continue;
            candidates.push({
                at: t,
                id: block.id,
                chars: String((block.input && block.input.message) || '').length,
            });
        }
    }

    // A call is not its own precedent, and a call this hook refused was never
    // received by anyone. Everything else counts, including a call whose result
    // is missing -- see the note above on why absence must not exempt.
    const hits = candidates.filter(
        (c) => (c.id === undefined || c.id !== selfUseId) && !refused.has(c.id),
    );

    hits.sort((a, b) => b.at - a.at);
    return { hits, scanned };
}

function minutesAgo(ms, nowMs) { return Math.max(0, Math.round((nowMs - ms) / 60000)); }

function main(rawPayload) {
    if (String(process.env.AUTODEV_PEER_BUDGET || '').toLowerCase() === 'off') return 0;

    let payload;
    try { payload = JSON.parse(rawPayload); } catch { return 0; }

    const name = payload && (payload.tool_name || payload.toolName);
    if (name !== TOOL) return 0;

    const input = (payload && (payload.tool_input || payload.toolInput)) || {};
    const target = input.session_id;
    if (!target) return 0;

    // A deliberate override still gets counted, it just is not blocked. The
    // sender has to write the word, which is the point: it cannot happen by
    // reflex, which is how all 59 of them happened.
    if (/OVERRIDE-BUDGET/.test(String(input.message || ''))) return 0;

    const transcript = payload.transcript_path || payload.transcriptPath;
    if (!transcript) return 0;

    const now = Date.now();
    const result = priorSends(transcript, target, now, payload.tool_use_id || payload.toolUseId);
    if (result === null) return 0;   // unreadable is not zero; fail open

    const { hits, scanned } = result;
    if (hits.length < LIMIT) return 0;

    const when = hits.slice(0, LIMIT + 2)
        .map((h) => '    ' + minutesAgo(h.at, now) + ' min ago, ' + h.chars + ' chars')
        .join('\n');

    process.stderr.write(
        'Peer message BLOCKED: this is number ' + (hits.length + 1) + ' to the same session\n'
        + 'inside ' + WINDOW_MIN + ' minutes, and the limit is ' + LIMIT + '.\n\n'
        + '  recipient : ' + target + '\n'
        + '  already sent:\n' + when + '\n'
        + '  population: ' + scanned + ' peer message(s) in the window, to all recipients\n\n'
        + 'A message is free to send and expensive to receive: it arrives as a full\n'
        + 'user turn at THEIR context depth, so nothing about sending it feels costly\n'
        + 'to you. [measured 2026-08-25] one session sent nine messages went silent\n'
        + 'holding unreported work; [measured 2026-09-05] a coordinator sent ten to\n'
        + 'one session in a night while having this rule in context.\n\n'
        + 'Do one of these instead:\n'
        + '  - wait for their next report and reply once, batching what you have\n'
        + '  - write the fact into the REPO they are working in, which costs them no\n'
        + '    turn and reaches whoever picks the work up next\n'
        + '  - if it is genuinely one direction change that cannot wait, put\n'
        + '    OVERRIDE-BUDGET in the message and send it\n\n'
        + 'Set AUTODEV_PEER_BUDGET=off to disable this check.\n'
    );
    return 2;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
    let code = 0;
    try { code = main(buf); } catch { code = 0; }   // fails open, always
    process.exit(code);
});
process.stdin.on('error', () => process.exit(0));

module.exports = { priorSends, WINDOW_MIN, LIMIT, TOOL };
