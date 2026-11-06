'use strict';
// session-error-classes.js: the tool-error taxonomy that analyze-session-patterns.js ranks
// and usage-mine.js indexes. One copy, so the two readers can never disagree on a class.
// ---------------------------------------------------------------------------
// The classes. Every pattern here was read off real transcripts on this machine
// (2026-08-19, 277 errored tool calls over 36h) rather than imagined — an
// invented taxonomy ranks the classes you thought of, not the ones you hit.
//
// `fix` is what would stop the class recurring. It is the payload: a ranked list
// with no remedy is a complaint.
// ---------------------------------------------------------------------------
// What separates a shell fault from a shell ANSWER. Deliberately narrow: these
// are markers a failing program emits, not words that merely appear in output.
const ERROR_MARKER = /Traceback|node:internal|at Object\.<anonymous>|SyntaxError|TypeError|ReferenceError|fatal:|error:|Error:/;

const CLASSES = [
    {
        id: 'edit-before-read',
        test: /has not been read yet/i,
        fix: 'Read (or open) the file in-session before Edit/Write. Cheapest class to kill: it is one extra call, always known in advance.',
    },
    {
        id: 'file-changed-since-read',
        test: /has been modified since read|File has been modified/i,
        fix: 'Something rewrote the file between the Read and the Edit — usually a formatter or the PostToolUse typecheck, not the user. Distinct from edit-before-read: the read HAPPENED and was invalidated, so the cost is a forced re-read per edit, not a forgotten one.',
    },
    {
        id: 'tool-disabled-for-agent',
        test: /No such tool available|is disabled for this session/i,
        fix: 'A read-only agent was handed writing work. Fix the dispatch, not the agent: send the edit to a agent that has Write, or stop asking a reviewer to apply its own findings.',
    },
    {
        id: 'security-file-blocked',
        test: /Cannot modify security-critical file/i,
        fix: "The harness's own guard, working as designed. Route settings changes through the documented path instead of retrying the edit.",
    },
    {
        // Merged from the old browser-no-site and browser-no-preview. Triage of
        // 25 unclassified errors found 14 were browser failures and every one
        // was the same mistake wearing a different message: a call whose
        // precondition had not been established, or had expired. Splitting them
        // by wording produced classes with one identical fix, which is one class.
        id: 'browser-state-not-established',
        test: /No site is open in this tab|Inspected target navigated or closed|Server not found\. No running servers|No preview is open|tab group no longer exists|not found — it may be stale|pinned to a local file preview|no read_page tree cached|requires a prior computer\{action:"screenshot"\}|navigation to \S+ was denied/i,
        fix: 'A browser call ran before its precondition existed, or after it expired. Establish state first (preview_start / navigate / read_page / screenshot) and RE-assert it after any navigation — tab groups, serverIds and cached trees do not survive one. "Inspected target navigated or closed" is often SELF-inflicted: a script that calls location.reload() or navigates and then awaits has destroyed the context it is running in, so it can never return. Navigate in one call, evaluate in the next.',
    },
    {
        id: 'browser-renderer-hung',
        test: /renderer may be frozen|No browser responded within the timeout|CDP sendCommand .* timed out|timed out after \d+s\.? The (?:preview|Browser pane)/i,
        fix: 'The page or the pane stopped responding, which is not the same as a wrong call — retrying the identical command is the one thing that cannot help. Check console logs, then reload the tab or restart the browser surface.',
    },
    {
        // `[measured 2026-11-05]` usage-mine's largest unclassified sub-shape: about 330 events,
        // a worktree-isolated session or agent reaching outside its worktree.
        id: 'worktree-isolation',
        test: /(?:session|agent) is (?:isolated in the worktree|running in an isolated)|working-directory isolation context/i,
        fix: 'The session is pinned to its worktree. Use paths inside it, run one simple command per call (a compound or eval command cannot be verified), and leave out-of-tree writes to the session that owns them.',
    },
    {
        id: 'browser-profile-locked',
        test: /The browser is already running for /i,
        fix: 'Another process holds the browser profile. Reuse the open browser, or close it first; a retry cannot succeed while the lock is held.',
    },
    {
        id: 'hook-blocked-command',
        // autodev-fn refusals name their rule: `<tool_use_error>autodev-fn (heredoc-backslash): ...`.
        test: /Blocked potentially dangerous command|<tool_use_error>Blocked:|<tool_use_error>autodev-fn \([\w-]+\)/i,
        fix: 'The PreToolUse filter refused the command. Long inline `node -e`/`python -c` and chained sleeps are the usual triggers — write a script file and run that.',
    },
    {
        id: 'permission-denied',
        // `[measured 2026-11-05]` dontAsk words it "Permission to use Write has been denied
        // because Claude Code is running in don't ask mode": the first spelling missed it.
        test: /Permission to use \w+ (?:with command|has been denied)|denied by the Claude Code auto mode classifier|requested permissions|user doesn't want to proceed/i,
        fix: 'A denial is a decision, not an obstacle. Prose-style denials come from the semantic judge, not the allowlist — do not promise an allowlist fix for one.',
    },
    {
        id: 'browser-not-composited',
        test: /Browser pane is not displayed|not composit|Screenshot timed out/i,
        fix: 'The in-app Browser pane cannot screenshot while it is not displayed. Use chrome-devtools for screenshots, or bring the pane forward first.',
    },
    {
        id: 'browser-script-error',
        test: /javascript_tool failed|Failed to fetch at <anonymous>|has already been declared/i,
        fix: 'The injected script itself threw. Note the page keeps one scope across calls, so a re-run of the same `const` is a redeclaration error rather than a fresh start — wrap in an IIFE.',
    },
    {
        id: 'sql-schema-guess',
        test: /42703|column \S+ does not exist|relation \S+ does not exist/i,
        fix: 'The query named a column the table does not have. Introspect the schema once (information_schema, or a select * limit 1) instead of paying a failed round trip per guessed column — seven in a row on one agent is the observed worst case.',
    },
    {
        id: 'shell-quoting',
        test: /unexpected EOF while looking for matching|unterminated quoted string|syntax error near unexpected token/i,
        fix: 'Quoting collapsed in a long one-liner. Write the script to a file and run that; the same text behaves differently in Git Bash, cmd and PowerShell.',
    },
    {
        id: 'agent-schema-violation',
        test: /Output does not match required schema/i,
        fix: 'A subagent returned a shape its schema forbids. Usually an over-strict additionalProperties or a required field the prompt never asked the agent to produce — fix the contract, not the agent.',
    },
    {
        id: 'browser-chrome-unselected',
        test: /Multiple Chrome browsers are connected/i,
        fix: 'BLOCKED ON A USER DECISION, not a bug: the message says AskUserQuestion is required, and every browser call fails identically until someone picks a browser. Observed 2026-08-19: a session spent two hours retrying browser calls against this instead of asking. Ask, or stop the browser work and say why.',
    },
    {
        id: 'js-top-level-await',
        test: /await is only valid in async functions/i,
        fix: 'javascript_tool evaluates an expression, not a module. Wrap in (async () => { ... })() or use .then().',
    },
    {
        id: 'command-timeout',
        test: /Command timed out after|Exit code 143/i,
        fix: 'Raise the timeout explicitly or background the command. A 2m default kill mid-write can leave a partial file.',
    },
    {
        id: 'edit-anchor-missing',
        test: /String to replace not found|Found \d+ matches of the string to replace/i,
        fix: 'Anchor discipline: re-read the exact bytes before editing. A stale anchor means the file moved under you.',
    },
    {
        // Split out of file-missing on purpose: this one is a CROSS-TOOL
        // structural fault (the shell and Node disagree about what /tmp is), not
        // a typo, so it is the only path-failure a guard could plausibly catch.
        // Kept separate so its frequency can be measured rather than assumed.
        id: 'tmp-path-split',
        // The commonest form is a bare POSIX /tmp path that Node could not
        // resolve — "Cannot find module '/tmp/ai.json'". The first version of
        // this pattern only matched the C:\tmp spelling, so it missed exactly
        // the case the rule exists for and filed it under shell-nonzero-exit.
        test: /[A-Za-z]:\\+tmp[\\/]|open '[A-Za-z]:\\tmp|(?:Cannot find module|ENOENT[^\n]*open|cannot open) '\/tmp\/|cannot open '\/[^/]+\.(txt|json|log)'/i,
        fix: 'Git Bash resolves /tmp differently from Node/Python on Windows: the shell writes /tmp/x, the reader looks in C:\\tmp\\x. Use the session scratchpad absolute path on both sides.',
    },
    {
        id: 'file-missing',
        test: /File does not exist|ENOENT|no such file or directory|readFileUtf8/i,
        fix: 'Path did not resolve. On Windows the usual causes are /tmp meaning two different places and a worktree-relative path used from the main tree.',
    },
    {
        id: 'not-a-git-repo',
        test: /Not a git repository|not a git repository/i,
        fix: 'The cwd is not the repo. Downloads/code/autodev in particular is the telemetry dir, not the source tree.',
    },
    {
        id: 'network-unreachable',
        test: /getaddrinfo|ENOTFOUND|ECONNREFUSED|Max retries exceeded|Failed to resolve/i,
        fix: 'No egress from this shell. Prefer a local ground truth; do not report a network failure as an empty result.',
    },
    {
        // 127 = command not found, 126 = found but not executable. Split out
        // because the fix is specific and nothing else in the shell family
        // shares it: 15 of 100 shell exits in 24h, and they are never "the
        // answer" — a missing binary is always a fault.
        id: 'command-not-found',
        test: /^Exit code 12[67](?![0-9])/im,
        fix: 'The binary is missing or not executable on this machine, not wrong. Check the tool is installed and on PATH before rewriting the command around it.',
    },
    {
        // The split that stops the shell catch-all being half fiction. Measured
        // over 100 shell exits in 24h: 34 carried an error marker, 37 were an
        // exit of 1 or 2 with real output and no marker at all. The second group
        // is dominated by commands where a NON-ZERO EXIT IS THE ANSWER — grep
        // exits 1 on no-match, `git diff --quiet` exits 1 when there ARE
        // differences — usually surfaced because the command was chained with &&
        // so the whole chain reports failure after doing exactly what was asked.
        id: 'shell-exit-may-be-the-answer',
        test: (head) => /^Exit code [12](?![0-9])/im.test(head) && !ERROR_MARKER.test(head),
        fix: 'Probably not a fault: grep/diff --quiet/test/cmp all exit non-zero to REPORT something, and an && chain turns that answer into a failed command. Read the output before reacting to the badge; use ; or || true when the count is the point.',
    },
    // Catch-all LAST: a non-zero shell exit carrying an actual error marker.
    {
        id: 'shell-fault',
        test: /^Exit code [1-9]/im,
        fix: 'A real non-zero exit with error text. Read the marker (Traceback, fatal:, SyntaxError) rather than re-running the command unchanged.',
    },
];

// Classify on the HEAD of the message, not the whole blob. A 6KB command output
// that happens to contain the word ENOENT three screens down is not an ENOENT
// failure, and matching deep into the body mislabels long outputs as whatever
// they happen to mention.
// A `test` may be a RegExp or a predicate over the head. The predicate form
// exists because the shell classes need two factors — the exit code AND whether
// the output carries an error marker — and no single regex states both.
function classify(text) {
    const head = text.slice(0, 400);
    for (const c of CLASSES) {
        const hit = typeof c.test === 'function' ? c.test(head) : c.test.test(head);
        if (hit) return c.id;
    }
    return 'unclassified';
}

module.exports = { ERROR_MARKER, CLASSES, classify };
