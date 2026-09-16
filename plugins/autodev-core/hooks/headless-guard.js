#!/usr/bin/env node
// PreToolUse hook on Bash: in a HEADLESS worker, refuse a backgrounded command.
//
// WHY. A `claude -p` worker exits the moment its turn ends. A Bash command
// started with `run_in_background: true`, or with a trailing `&`, keeps running
// as an orphan of a process that is gone: its completion notification never
// arrives, nobody reads its exit code, and the worker reports done with a gate
// still running. `[measured 2026-09-16]` a headless worker backgrounded
// `npm run gate`, ended its turn, and reported the gate as passed while the
// sweep was still in flight. Prose in the brief had told it not to; prose did
// not stop it. This hook does.
//
// IT IS A GUARD, NOT ADVICE. There is no userConfig switch, deliberately: a
// guard the model can switch off by asking for a setting is not a guard, and
// tooling/test-hooks-profile.js lists this file under GUARDING for exactly that
// reason. If a real worker hits this deny repeatedly, the fix is a longer
// FOREGROUND timeout in its brief (the Bash tool's `timeout` goes to ten
// minutes) and splitting the work, never a key on this hook. Adding one would
// also silently unclassify it in that suite.
//
// ARMING. The whole body is behind one env check, before stdin is even read:
// `AUTODEV_HEADLESS === '1'`, the exact string. `'true'`, `'0'`, empty and
// unset all mean "not headless", and on that path this hook costs one string
// compare and a process spawn. That floor is charged to EVERY Bash call in
// every installed session, headless or not (coordinator-write-guard.js
// measured it at ~50 ms on a loaded box), which is why nothing else happens
// before the check.
//
// PROPAGATION IS MEASURED, NOT ASSUMED. The suite proves the hook's behaviour
// GIVEN the variable in its own environment. Whether Claude Code carries
// AUTODEV_HEADLESS from a `claude -p` process into its hook subprocesses is a
// separate claim. `[measured 2026-09-17]` a `claude -p` worker launched with
// AUTODEV_HEADLESS=1 ran `echo $AUTODEV_HEADLESS` from a foreground Bash call
// and printed 1, then piped a run_in_background payload into this hook from
// that same Bash call and got the deny JSON back. That proves the variable
// crosses from the claude process into its tool children; hook subprocesses
// are spawned by the same process, and were not probed separately. If a
// future Claude Code release starts scrubbing the child env, this hook goes
// quiet rather than loud: re-run that probe before trusting a green.
//
// THE `&` RULE. Deny any `&` that is outside single quotes, double quotes, a
// backslash escape and a heredoc body, and is not part of `&&`, `>&`, `<&` or
// `&>` (so `2>&1`, `>&2`, `<&0` and `&> log` pass). That catches a trailing
// `&`, a `&` before a following command (`npm run gate > log 2>&1 & echo
// started`), a `&` inside a subshell (`(npm run gate &)`) and one glued to
// its command (`sleep 5&`). The rule used to be "the last character is a
// lone `&`", and the first two shapes went through it. The scan is one pass
// over the string and no parser: a `#` comment is not stripped, backticks and
// `$(...)` are scanned like the text around them, and a heredoc whose word
// is not a plain token has its body scanned as ordinary text. Each of those
// can only produce a false DENY, which is the acceptable direction here.
//
// TWO PreToolUse HOOKS SIT ON MATCHER Bash. coordinator-write-guard.js exits 2
// to block, or exits 0 with a `permissionDecision: ask` JSON object on ITS
// stdout. Each hook is its own subprocess with its own stdout, so this hook's
// deny and that hook's ask can be emitted for the same call and never share a
// stream: Claude Code reads one JSON document per hook and resolves deny over
// ask. This deny stands alone.
//
// NO CHILD PROCESS. Nothing here spawns, so validate's windowsHide sweep has
// nothing to find, and the no-op path stays one compare.
//
// FAILS OPEN. Any throw, including a stdin that is not JSON, exits 0 with zero
// bytes on both streams. This ships installed: a defect here would otherwise
// stop a stranger's every Bash call until they reinstall. That is the same
// call pre-tool-filter.js makes for its private-name block, and for the same
// reason.

'use strict';

if (process.env.AUTODEV_HEADLESS !== '1') process.exit(0);

const REASON = 'This session runs headless: the process exits the moment the turn ends, '
    + 'so a backgrounded command is orphaned and its completion is never seen. '
    + 'Run it in the FOREGROUND with the Bash timeout at its maximum (600000 ms), '
    + 'splitting the work into more than one call if it does not fit.';

/**
 * Does the command carry a `&` that backgrounds something? One pass: quoted
 * segments, backslash escapes and heredoc bodies are skipped, and a bare `&`
 * counts unless its neighbours make it `&&`, `>&`, `<&` or `&>`.
 */
function hasBackgroundAmp(cmd) {
    const n = cmd.length;
    const heredocs = [];
    let i = 0;
    while (i < n) {
        const c = cmd[i];
        if (c === '\\') { i += 2; continue; }
        if (c === "'") { const j = cmd.indexOf("'", i + 1); i = j < 0 ? n : j + 1; continue; }
        if (c === '"') {
            i++;
            while (i < n && cmd[i] !== '"') i += cmd[i] === '\\' ? 2 : 1;
            i++;
            continue;
        }
        if (c === '<' && cmd[i + 1] === '<') {
            const m = /^<<-?[ \t]*(?:'([^']+)'|"([^"]+)"|([^\s;&|<>()'"\\]+))/.exec(cmd.slice(i));
            if (m) { heredocs.push(m[1] || m[2] || m[3]); i += m[0].length; continue; }
            i += 2;
            continue;
        }
        if (c === '\n' && heredocs.length) {
            // Skip each pending body up to its terminator line; an unterminated one runs to the end.
            let j = i + 1;
            for (const word of heredocs.splice(0)) {
                while (j < n) {
                    const end = cmd.indexOf('\n', j);
                    const line = cmd.slice(j, end < 0 ? n : end);
                    j = end < 0 ? n : end + 1;
                    if (line.replace(/^\t+/, '').replace(/\r$/, '') === word) break;
                }
            }
            i = j;
            continue;
        }
        if (c === '&') {
            const prev = cmd[i - 1];
            const next = cmd[i + 1];
            const glued = prev === '&' || prev === '>' || prev === '<' || next === '&' || next === '>';
            if (!glued) return true;
        }
        i++;
    }
    return false;
}

try {
    const fs = require('fs');
    let data;
    try {
        data = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        process.exit(0);
    }
    if (!data || typeof data !== 'object') process.exit(0);
    if ((data.tool_name || '') !== 'Bash') process.exit(0);

    const input = data.tool_input;
    const backgrounded = !!input && typeof input === 'object' && input.run_in_background === true;
    const backgroundAmp = !!input && typeof input === 'object' && typeof input.command === 'string'
        && hasBackgroundAmp(input.command);

    if (backgrounded || backgroundAmp) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: REASON,
            },
        }) + '\n');
    }
    process.exit(0);
} catch {
    process.exit(0);
}
