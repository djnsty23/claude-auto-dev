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
// THE STOPPING RULE (decided 2026-08-19). Six rules is the cap, and a seventh
// earns its place on COST PER HIT, never on frequency. The two rules that
// justified themselves did so because one class cost a session two hours
// across two hits; a class a session shrugs off and recovers from unaided is
// noise on a hook that evaluates every rule on every failed call. If a new
// class is genuinely worth an advisory, ask first which existing rule it
// replaces.
//
// THE CAP HELD, AND THE SWAP IS DONE (2026-08-26). shell-exit-may-be-the-answer
// came in on the cost test above — 0.22 min/hit, ahead of five of the six that
// were here, and third by total cost — and agent-schema-violation went out at
// 0.02 min/hit, the lowest of all 16 measured classes. Still six.
//
// That is the stopping rule working as designed rather than an exception to it:
// the question "which one does it replace" had an answer, and the answer was
// the rule the same measurement ranked last. The tombstone below records why,
// because the class remains in the analyzer's taxonomy and will keep showing up
// in sweeps looking like an omission.
//
// The measurement to run before proposing one: npm run check:patterns -- --by-cost.
// Breadth and cost disagree, and cost is the one that matters here.
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
    {
        id: 'sql-schema-guess',
        tools: null,
        // 4 sessions, 7 hits. One agent guessed seven column names in a row,
        // each costing a full failed round trip to a production database, when
        // one introspection query would have answered all seven.
        signatures: [
            /42703/,
            /column [^ ]+ does not exist/i,
            /relation [^ ]+ does not exist/i,
        ],
        advice: 'The query named something the schema does not have. Guessing the next '
            + 'column name costs another full round trip and the failure rate does not '
            + 'improve — one agent was observed missing seven in a row. Introspect once '
            + '(information_schema.columns, or select * limit 1) and read the real names, '
            + 'then write the query. Note a column name is not a contract either: check '
            + 'what WRITES it before grouping by it.',
    },
    // REMOVED 2026-08-26: agent-schema-violation, to keep the cap at six when
    // shell-exit-may-be-the-answer was added below. It was the cheapest rule
    // here by the file's own test — 0.02 min/hit and a 0.2s median, lowest of
    // all 16 measured classes, and falling (1.7% of errors against 3.5% at the
    // 2026-08-19 baseline).
    //
    // Do not re-add it from a frequency measurement. The class is STILL in the
    // analyzer's taxonomy and still ranks 14-ish by sessions affected, so a
    // future sweep will surface it again looking like an omission. It is not:
    // the stopping rule at the top of this file admits a rule on COST PER HIT,
    // and on that test this was last.
    //
    // The known objection, recorded so it does not have to be rediscovered: the
    // wall-clock probe prices a failure tool_use -> tool_result, and this
    // class's worst case is a workflow run dying at the StructuredOutput retry
    // cap with the investigation already finished — which the probe sees as a
    // 0.2s schema error. That cost is real and this file cannot measure it. The
    // remedy for it is rules/fleet-brief.md (read __unparsedToolInput from the
    // transcript before re-running anything expensive), not a hook that speaks
    // after the run is already dead.
    {
        // LAST on purpose. Its signature is the weakest in the file — "exit 1 or
        // 2" — so every rule above must get first refusal, exactly as the
        // analyzer ranks this class behind shell-quoting, file-missing and
        // command-not-found. Measured 2026-08-26 over 7 days: 93 quoting
        // collapses and 26 /tmp splits are claimed above and never reach here.
        //
        // 90 sessions, 161 hits, FLAT against the 2026-08-19 baseline despite an
        // entire section of rules/verification-traps.md devoted to it. That is
        // the evidence prose is not reaching anyone. Cost is 34.9 min/week,
        // third by total, and 0.22 min/hit — above five of the six rules above.
        id: 'shell-exit-may-be-the-answer',
        tools: ['Bash'],
        signatures: [/^(?:Error:\s*)?Exit code [12](?![0-9])/],
        // The prefix comes off BEFORE the marker test. `tool_response` is
        // "Error: " + content on 100% of 489 measured failures, and the
        // analyzer's ERROR_MARKER contains /Error:/ — so testing the raw string
        // matches its own prefix every time and this rule could never fire.
        // That is the whole reason `unless` is a function and not a regex list.
        //
        // UPSTREAM_FAULT does the job that ORDERING does in the analyzer, where
        // file-missing, command-not-found and not-a-git-repo all rank ahead of
        // this class and absorb those faults first. This file has no such rules,
        // so without these the advice would land on a failed ls, sed, cd or
        // merge — telling a session "probably not a fault" about a real one.
        unless: (head) => {
            const ERROR_MARKER = /Traceback|node:internal|at Object\.<anonymous>|SyntaxError|TypeError|ReferenceError|fatal:|error:|Error:/;
            const UPSTREAM_FAULT = /No such file or directory|cannot access|can't read|cannot open|cannot stat|command not found|Permission denied|unknown option|invalid option|\bUsage: |not a git repository|\bE(?:NOENT|ACCES|NOTDIR|NAMETOOLONG|ISDIR|PERM)\b|CONFLICT \(|Automatic merge failed|\bcommit-msg:|\bpre-commit:/i;
            return ERROR_MARKER.test(head.replace(/^Error:\s*/i, '')) || UPSTREAM_FAULT.test(head);
        },
        advice: 'Read the output before reacting to the badge — this exit code is probably '
            + 'the ANSWER, not a fault. grep, diff --quiet, test and cmp all exit non-zero '
            + 'to REPORT something, and no output carrying an error marker reached this '
            + 'rule. In an && chain that answer becomes a failed command and the red badge '
            + 'stops you reading the number you asked for. Use ; between steps, or '
            + '|| true when the count is the point. Do not re-run or rewrite the command '
            + 'before checking whether it already answered.',
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
        if (!rule.signatures.some((re) => re.test(head))) continue;
        // `unless` is for a rule whose signature is necessary but not sufficient.
        // Only shell-exit-may-be-the-answer needs it: "exit 1 or 2" is the whole
        // signature, and what separates an answer from a fault is what ELSE the
        // output carries. A rule without `unless` behaves exactly as before.
        if (rule.unless && rule.unless(head)) continue;
        return { id: rule.id, advice: rule.advice };
    }
    return null;
}

module.exports = { adviseOnToolFailure, RULES };
