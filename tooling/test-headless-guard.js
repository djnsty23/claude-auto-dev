#!/usr/bin/env node
// Tests for hooks/headless-guard.js: the backgrounded-Bash deny in a headless worker.
// Run: node tooling/test-headless-guard.js
// Exits 1 on any failure; 0 if all pass; 2 if a spawn produced no verdict.
//
// Built the way tooling/test-coordinator-write-guard.js is built, for the
// same two reasons.
//
// 1. ZERO BYTES ON BOTH STREAMS, asserted separately. This hook runs on every
//    Bash call in every installed session, headless or not, and the common
//    case must say nothing. A suite that checks only stdout lets a mutant that
//    chatters on stderr survive, and vice versa: every allow case asserts the
//    exit code, the stdout length AND the stderr length.
//
// 2. THE MUTATION IS THE ENV VARIABLE. The last block takes the exact bytes
//    that denied earlier, removes AUTODEV_HEADLESS and nothing else, and
//    asserts the deny disappears. Both arms run in the same process, so the
//    variable is the only variable.
//
// Every spawn SCRUBS AUTODEV_HEADLESS from the inherited environment before
// setting it per case, so a suite run from inside a headless worker cannot
// pass its "unset" cases for the wrong reason.

const { classify, reason, runBudgeted, tally, exitCode } = require('./spawn-budget.js');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'headless-guard.js');

let pass = 0;
let fail = 0;
let infra = 0;
const failures = [];
const indeterminate = [];

function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

/**
 * Drive the hook as a subprocess. `headless` is the value AUTODEV_HEADLESS
 * takes for this run, or undefined to leave it unset. The inherited copy is
 * removed first in every case.
 */
function run({ payload, raw = null, args = [], headless = undefined }) {
    const input = raw !== null ? raw : JSON.stringify(payload);
    const env = { ...process.env };
    delete env.AUTODEV_HEADLESS;
    if (headless !== undefined) env.AUTODEV_HEADLESS = headless;
    const r = runBudgeted(process.execPath, [HOOK, ...args], {
        input,
        encoding: 'utf8',
        env,
        windowsHide: true,
        timeout: 20000,
        maxTimeout: 300000,
    });
    if (classify(r) === 'infrastructure') {
        infra++;
        const what = 'the hook run ' + JSON.stringify(args.length ? args : (payload ? 'payload' : 'raw'));
        indeterminate.push(what + ' (' + reason(r) + ')');
        console.error('infrastructure: ' + what + ' produced no verdict (' + reason(r)
            + '; ' + r.attempts + ' attempt(s), budget ' + r.budgetMs + 'ms)');
    }
    return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const bash = (tool_input, over = {}) => ({
    tool_name: 'Bash',
    session_id: 'SESSION-A',
    cwd: process.cwd(),
    tool_input,
    ...over,
});

const detail = (res) => `exit ${res.exit}, stdout ${res.stdout.length}B, stderr ${res.stderr.length}B`;

/** An allow: exit 0 and NOT ONE BYTE on either stream. */
function expectSilentAllow(label, res) {
    check(label, res.exit === 0 && res.stdout.length === 0 && res.stderr.length === 0, detail(res));
}

/** A deny: exit 0, one JSON document on stdout carrying the decision, stderr empty. */
function parseDeny(res) {
    let out = null;
    try { out = JSON.parse(res.stdout); } catch { return null; }
    return out && out.hookSpecificOutput ? out.hookSpecificOutput : null;
}
function expectDeny(label, res) {
    const h = parseDeny(res);
    check(`${label}: exit 0`, res.exit === 0, `exit ${res.exit}`);
    check(`${label}: stdout is one JSON document with hookEventName PreToolUse`,
        !!h && h.hookEventName === 'PreToolUse', JSON.stringify(res.stdout.slice(0, 80)));
    check(`${label}: permissionDecision is deny`, !!h && h.permissionDecision === 'deny',
        h ? String(h.permissionDecision) : 'no hookSpecificOutput');
    check(`${label}: reason names the foreground and the exit`,
        !!h && /foreground/i.test(h.permissionDecisionReason || '') && /exit/i.test(h.permissionDecisionReason || ''),
        h ? JSON.stringify(String(h.permissionDecisionReason).slice(0, 80)) : 'no reason');
    check(`${label}: stderr is empty`, res.stderr.length === 0, `stderr ${res.stderr.length}B`);
}

// ---------------------------------------------------------------------------
// 1. --help with stdin closed returns, silently. check-entrypoints probes every
//    hook this way, and a hook that reads stdin to EOF returns because EOF
//    arrives at once. Both arms, since the armed one is the one that reads.
expectSilentAllow('1a. --help, env unset, empty stdin: exit 0 and zero bytes',
    run({ raw: '', args: ['--help'] }));
expectSilentAllow('1b. --help, env armed, empty stdin: exit 0 and zero bytes',
    run({ raw: '', args: ['--help'], headless: '1' }));

// 2. The population that matters most: every session that is not headless.
expectSilentAllow('2. env unset, run_in_background true: silent allow',
    run({ payload: bash({ command: 'npm run gate', run_in_background: true }) }));

// 3. The deny.
const DENIED_BYTES = JSON.stringify(bash({ command: 'npm run gate', run_in_background: true }));
expectDeny('3. env armed, run_in_background true',
    run({ raw: DENIED_BYTES, headless: '1' }));

// 4. A trailing `&` with run_in_background absent is the same orphan by another route.
expectDeny('4. env armed, command ends in a single &',
    run({ payload: bash({ command: 'npm run gate > log 2>&1 &' }), headless: '1' }));
expectDeny('4b. env armed, trailing & followed by whitespace',
    run({ payload: bash({ command: 'sleep 5 &   \n' }), headless: '1' }));
// 4c-4f. A `&` that is not the last character backgrounds just the same. The
// first two are the shapes the old trailing-only rule let through.
expectDeny('4c. env armed, `npm run gate > log 2>&1 & echo started`: the & before a following command',
    run({ payload: bash({ command: 'npm run gate > log 2>&1 & echo started' }), headless: '1' }));
expectDeny('4d. env armed, `(npm run gate &)`: the & inside a subshell',
    run({ payload: bash({ command: '(npm run gate &)' }), headless: '1' }));
expectDeny('4e. env armed, `sleep 5&`: the & glued to its command',
    run({ payload: bash({ command: 'sleep 5&' }), headless: '1' }));
expectDeny('4f. env armed, a heredoc whose OPENER line ends in &: the body is skipped, the opener is not',
    run({ payload: bash({ command: 'cat <<EOF &\nbody\nEOF\n' }), headless: '1' }));

// 5-7. A `&` that is part of an operator, or quoted, or escaped, or in a heredoc body, backgrounds nothing.
expectSilentAllow('5. env armed, `a && b`: silent allow',
    run({ payload: bash({ command: 'a && b' }), headless: '1' }));
expectSilentAllow('5b. env armed, `cmd 2>&1`: silent allow',
    run({ payload: bash({ command: 'cmd 2>&1' }), headless: '1' }));
expectSilentAllow('5c. env armed, `cmd >&2`: silent allow',
    run({ payload: bash({ command: 'cmd >&2' }), headless: '1' }));
expectSilentAllow('5d. env armed, `cmd &> log`: silent allow',
    run({ payload: bash({ command: 'cmd &> log' }), headless: '1' }));
expectSilentAllow('5e. env armed, `cmd <&0`: silent allow',
    run({ payload: bash({ command: 'cmd <&0' }), headless: '1' }));
expectSilentAllow('6. env armed, `echo "done &"` ends in a quote: silent allow',
    run({ payload: bash({ command: 'echo "done &"' }), headless: '1' }));
expectSilentAllow('6b. env armed, `echo "a & b"`: a & inside double quotes: silent allow',
    run({ payload: bash({ command: 'echo "a & b"' }), headless: '1' }));
expectSilentAllow("6c. env armed, `echo 'a & b'`: a & inside single quotes: silent allow",
    run({ payload: bash({ command: "echo 'a & b'" }), headless: '1' }));
expectSilentAllow('6d. env armed, `echo a \\& b`: a backslash-escaped &: silent allow',
    run({ payload: bash({ command: 'echo a \\& b' }), headless: '1' }));
expectSilentAllow('6e. env armed, a & inside a heredoc BODY, with a command after the terminator: silent allow',
    run({ payload: bash({ command: "cat > f <<'EOF'\nfoo & bar\nEOF\necho done\n" }), headless: '1' }));
expectSilentAllow('7. env armed, an ordinary command: silent allow',
    run({ payload: bash({ command: 'git log --oneline -5' }), headless: '1' }));

// 8. Only the exact string '1' arms it.
for (const v of ['true', '0', '', 'yes', '1 ']) {
    expectSilentAllow(`8. AUTODEV_HEADLESS=${JSON.stringify(v)}, run_in_background true: silent allow`,
        run({ payload: bash({ command: 'npm run gate', run_in_background: true }), headless: v }));
}

// 9. Another tool's payload, even one carrying the flag, is not this hook's business.
expectSilentAllow('9. env armed, tool_name Read with run_in_background true: silent allow',
    run({ payload: bash({ command: 'x', run_in_background: true }, { tool_name: 'Read' }), headless: '1' }));
expectSilentAllow('9b. env armed, tool_name absent: silent allow',
    run({ payload: { tool_input: { command: 'x', run_in_background: true } }, headless: '1' }));

// 10-11. Unreadable stdin fails open, silently.
expectSilentAllow('10. env armed, stdin `not json`: exit 0 and zero bytes',
    run({ raw: 'not json', headless: '1' }));
expectSilentAllow('11. env armed, empty stdin: exit 0 and zero bytes',
    run({ raw: '', headless: '1' }));
expectSilentAllow('11b. env armed, stdin is the JSON literal null: exit 0 and zero bytes',
    run({ raw: 'null', headless: '1' }));

// 12. A tool_input that is not an object must not throw a visible error.
expectSilentAllow('12a. env armed, tool_input is the string "ls": silent allow',
    run({ payload: bash('ls'), headless: '1' }));
expectSilentAllow('12b. env armed, tool_input is null: silent allow',
    run({ payload: bash(null), headless: '1' }));
expectSilentAllow('12c. env armed, tool_input.command is a number: silent allow',
    run({ payload: bash({ command: 42 }), headless: '1' }));

// 13. Strict comparison: the string 'true' is not the boolean.
expectSilentAllow('13. env armed, run_in_background is the string "true": silent allow',
    run({ payload: bash({ command: 'npm run gate', run_in_background: 'true' }), headless: '1' }));
expectSilentAllow('13b. env armed, run_in_background is 1: silent allow',
    run({ payload: bash({ command: 'npm run gate', run_in_background: 1 }), headless: '1' }));

// 14. THE CONTROL. The same bytes that denied in 3, with the env variable
//     removed and nothing else changed. If this arm also denies, or 3 did not,
//     the env check is decorative.
{
    const armed = run({ raw: DENIED_BYTES, headless: '1' });
    const disarmed = run({ raw: DENIED_BYTES });
    const a = parseDeny(armed);
    const ok = !!a && a.permissionDecision === 'deny' && armed.exit === 0 && armed.stderr.length === 0
        && disarmed.exit === 0 && disarmed.stdout.length === 0 && disarmed.stderr.length === 0;
    check('14. MUTATION: removing AUTODEV_HEADLESS, and nothing else, removes the deny', ok,
        `armed: ${detail(armed)}; disarmed: ${detail(disarmed)}`);
}

// The population, not a bare verdict: what was driven, and how.
console.log(`\n${tally(pass, fail, infra)}`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), HOOK)}, `
    + 'driven as a subprocess with AUTODEV_HEADLESS scrubbed from the inherited env and set per case; '
    + 'every allow asserted zero bytes on BOTH stdout and stderr.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
process.exit(exitCode(fail, infra));
