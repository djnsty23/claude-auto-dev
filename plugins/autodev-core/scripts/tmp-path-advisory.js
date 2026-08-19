#!/usr/bin/env node
// tmp-path-advisory.js — name the cause when a /tmp path fails to resolve.
//
// WHY THIS EXISTS AT ALL, given the rule is already written down: on Windows the
// shell and the runtime disagree about what /tmp means. Git Bash resolves it
// inside its own root; Node and Python read it as C:\tmp. So a command writes
// /tmp/x.json, the next step reads /tmp/x.json, and the read fails. Measured
// 2026-08-19: 13 distinct sessions in 24 hours, one hit each — nobody hits it
// twice, everybody hits it once.
//
// The error text is the problem. "Cannot find module '/tmp/ai.json'" reads as
// "the file was not created", so the natural next move is to debug the writer,
// which is fine and correct and fixes nothing. The cause is never mentioned by
// the message that reports it.
//
// WHY IT IS NOT ITS OWN HOOK. Measured on this machine: one extra Node spawn
// costs 64ms median, and Bash is 70% of tool calls — 5,923 a day. A dedicated
// PostToolUse hook on Bash would spend ~6.3 minutes of wall clock a day to save
// roughly five. So this is a pure function called from a hook that already
// spawns on every call, which is the same trade the self-heal RFC made when it
// extended session-start rather than adding a hook.
//
// It fires ONLY on a failed call whose text carries the signature — about 0.15%
// of calls — so the "telemetry never prints" contract still holds in the case
// that contract is about: a hook that prints on every call costs context on
// every call. This one is silent 999 times in 1000.

'use strict';

// A /tmp path that a runtime could not resolve. Both spellings, because the
// shell writes the POSIX form and the error comes back in whichever form the
// reader used.
const SIGNATURES = [
    /Cannot find module '\/tmp\//i,
    /ENOENT[^\n]*'\/tmp\//i,
    /ENOENT[^\n]*[A-Za-z]:\\+tmp\\+/i,
    /cannot open '\/tmp\//i,
    /no such file or directory[^\n]*[A-Za-z]:\\+tmp\\+/i,
];

/**
 * @param {string} toolName
 * @param {unknown} toolResponse  the CLI's tool_response (string or object)
 * @param {boolean} failed        whether the call was recorded as a failure
 * @returns {string|null} advisory text, or null when there is nothing to say
 */
function adviseOnTmpSplit(toolName, toolResponse, failed) {
    // Only speak about a call that actually failed. A command that merely
    // MENTIONS /tmp — grepping for it, printing a path — is not a fault, and
    // advising on it would be the noise that gets hooks disabled.
    if (!failed) return null;
    if (toolName !== 'Bash') return null;

    const text = typeof toolResponse === 'string'
        ? toolResponse
        : (() => { try { return JSON.stringify(toolResponse || ''); } catch { return ''; } })();
    if (!text) return null;

    // Bounded: the signature is in the error, not three screens into a log.
    const head = text.slice(0, 600);
    if (!SIGNATURES.some((re) => re.test(head))) return null;

    return 'This looks like the Windows /tmp split, not a missing file: Git Bash '
        + 'resolves /tmp inside its own root while Node and Python read it as C:\\tmp, '
        + 'so a file written by the shell is invisible to the reader. Do not debug the '
        + 'writer — use one absolute path on both sides (the session scratchpad), and '
        + 're-run the step that wrote the file.';
}

module.exports = { adviseOnTmpSplit, SIGNATURES };
