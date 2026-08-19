#!/usr/bin/env node
// tool-failure-advisory.js — name the cause when a tool failure misdirects.
//
// Every rule here shares one shape, and it is the only shape that earns an
// advisory: the error message is accurate, and reading it leads somewhere
// useless. A message that already names its own cause needs nothing from this
// file — restating it would be noise on a hook that runs on every tool call.
//
// Each rule also has to be STILL FIRING despite being documented (or having
// nowhere left to be documented). That is the evidence prose is not reaching
// anyone: the rule sits in an always-loaded file, sessions read it, and the
// class does not fall. Measured 2026-08-19 across every session on this machine.
//
// WHY THIS IS NOT ITS OWN HOOK. One extra Node spawn costs 64ms median here and
// Bash alone is 70% of tool calls — 5,923 a day. A dedicated hook would spend
// ~6.3 minutes of wall clock a day to save a handful: a guard more expensive
// than the bugs it catches. So this is a pure function called from a hook that
// already spawns on every call — the same trade the self-heal RFC made when it
// extended session-start instead of adding a hook.
//
// It speaks only on a FAILED call matching a signature, well under 1% of calls,
// which is why it can live in a hook whose contract is "does not print". That
// contract exists because printing on every call costs context on every call.
//
// The browser rules are here rather than in a skill because there is no browser
// skill any more — it was removed in 8.79.0 when that work migrated to the
// built-in tools, and its guidance is now spread across five unrelated skills.
// A checklist copied into five files is worse than none. This fires at the one
// moment such a checklist would actually be read: when a session is stuck.

'use strict';

// `tools: null` means any tool. It is null for the browser rules because their
// signatures are unambiguous on their own, and the browser surface spans several
// MCP servers whose tool names would otherwise need enumerating — and
// re-enumerating every time one is added.
const RULES = [
    {
        id: 'tmp-path-split',
        tools: ['Bash'],
        // 14 sessions in 24h, one hit each. Nobody hits it twice; everybody hits
        // it once. The message says "Cannot find module '/tmp/ai.json'", which
        // reads as "the file was not created" and sends you to debug the writer
        // — correct-looking, and it fixes nothing.
        signatures: [
            /Cannot find module '\/tmp\//i,
            /ENOENT[^\n]*'\/tmp\//i,
            /ENOENT[^\n]*[A-Za-z]:\\+tmp\\+/i,
            /cannot open '\/tmp\//i,
            /no such file or directory[^\n]*[A-Za-z]:\\+tmp\\+/i,
        ],
        advice: 'This looks like the Windows /tmp split, not a missing file: Git Bash '
            + 'resolves /tmp inside its own root while Node and Python read it as C:\\tmp, '
            + 'so a file written by the shell is invisible to the reader. Do not debug the '
            + 'writer — use one absolute path on both sides (the session scratchpad), and '
            + 're-run the step that wrote the file.',
    },
    {
        id: 'shell-quoting',
        tools: ['Bash'],
        // 9 sessions in 24h. The reported line number belongs to a command bash
        // never received, so the instinct is to re-escape the one-liner — which
        // is how the same failure recurs wearing different quotes.
        signatures: [
            /unexpected EOF while looking for matching/i,
            /unterminated quoted string/i,
            /syntax error near unexpected token/i,
        ],
        advice: 'Quoting collapsed before bash ever ran this, so the line number points at '
            + 'a command that was never sent. Re-escaping the one-liner is how this recurs '
            + 'with different quoting — the same text collapses differently in Git Bash, cmd '
            + 'and PowerShell. Write the script to a file (with the Write tool, not a '
            + 'heredoc) and run the file instead.',
    },
    {
        id: 'browser-blocked-on-user',
        tools: null,
        // The most expensive class measured all day: one session spent 10:14 to
        // 12:24 retrying browser calls against this, because it reads like a
        // transient connection problem. It is not. It is a question waiting for
        // a person, and no number of retries answers it.
        signatures: [/Multiple Chrome browsers are connected/i],
        advice: 'This is a blocked USER DECISION, not a transient failure: the message asks '
            + 'for a browser to be selected, and every browser call fails identically until '
            + 'someone picks one. Retrying is the one response that cannot work — a session '
            + 'was observed spending two hours doing exactly that. Ask with AskUserQuestion, '
            + 'or stop the browser work and say why it stopped.',
    },
    {
        id: 'browser-self-destroyed-eval',
        tools: null,
        // Reads as a race against the page; usually self-inflicted.
        signatures: [/Inspected target navigated or closed/i],
        advice: 'Often self-inflicted rather than a race: a script that calls '
            + 'location.reload(), follows a link, or navigates and THEN awaits has destroyed '
            + 'the execution context it runs in, so the call can never return. Check whether '
            + 'the script that just failed navigated itself. Navigate in one call, evaluate '
            + 'in the next, and re-establish the tab reference in between.',
    },
];

/**
 * @param {string} toolName
 * @param {unknown} toolResponse  the CLI's tool_response (string or object)
 * @param {boolean} failed        whether the call was recorded as a failure
 * @returns {{id: string, advice: string}|null}
 */
function adviseOnToolFailure(toolName, toolResponse, failed) {
    // Only speak about a call that actually failed. A command that merely
    // MENTIONS /tmp — grepping for it, printing a path — is not a fault, and
    // advising on it would be the noise that gets hooks disabled.
    if (!failed) return null;

    const text = typeof toolResponse === 'string'
        ? toolResponse
        : (() => { try { return JSON.stringify(toolResponse || ''); } catch { return ''; } })();
    if (!text) return null;

    // Bounded: the signature is in the error, not three screens into a log.
    const head = text.slice(0, 600);
    for (const rule of RULES) {
        if (rule.tools && !rule.tools.includes(toolName)) continue;
        if (rule.signatures.some((re) => re.test(head))) return { id: rule.id, advice: rule.advice };
    }
    return null;
}

module.exports = { adviseOnToolFailure, RULES };
