#!/usr/bin/env node
'use strict';

// PreToolUse on AskUserQuestion. rules/options-protocol.md requires that every
// question block mark one option (Recommended); a block without one is a menu,
// and a menu pushes the ranking work back onto the reader.
//
// Why this exists as a gate rather than a note in the rule. Measured 2026-08-26
// over 242 transcripts and 1732 questions: 205 questions carried no mark at all,
// running at 12% across the last seven days and still firing that morning. The
// rule has been written down the whole time. Writing it down again is not the
// missing piece.
//
// Exit 2 rather than an advisory, because PreToolUse stderr is the only channel
// that reaches the model in time to fix THIS panel. The cost of a hit is one
// retry before the user sees anything; the cost of an advisory is a panel that
// ships wrong and gets corrected next time, which is what the rule already does.
//
// It fails OPEN on every internal error. This ships installed, so a defect here
// would suppress panels in someone else's session until they reinstall, and a
// missing recommendation is a style breach while a swallowed panel is a broken
// turn. Same reasoning as pre-tool-filter's private-name block.
//
// Kill switch: AUTODEV_PANEL_CHECK=off. Present because the convention is this
// marketplace's, not every installer's, and nobody should have to fork a plugin
// to disagree with a house style.
//
// ---------------------------------------------------------------------------
// SECOND JOB, added 2026-09-02: the AWAY branch.
//
// `[measured 2026-09-02 01:06]` one session sat 50 minutes on "main is red and
// PR #83 is the green fix. Merge it?" while `list_sessions` already showed that
// PR MERGED. The question was moot and nothing could notice, because a worker
// with a question and no operator has exactly one legal move today, and it is
// stop.
//
// This hook is the enforcement point rather than a new one, for a reason that
// is structural: it ALREADY parses every outgoing panel and already knows which
// option is recommended. A second hook would have to re-derive both, and two
// mechanisms pointed at the same behaviour is what produced the contradiction
// this replaces — `rule-options-protocol` is always-on and tells every worker to
// end a substantive turn with a panel, while `brain-panels.js` wrote
// `AskUserQuestion` into `permissions.deny` so raising one was impossible.
//
// ORDER IS DELIBERATE: the recommendation check runs FIRST. Branch 2 says "take
// the recommended option", and a panel with no mark has none to take. Under an
// active AWAY a panel is therefore made well-formed first, then self-resolved.
//
// SEPARATE KILL SWITCH, AUTODEV_AWAY_CHECK=off. Folding it into
// AUTODEV_PANEL_CHECK would mean that turning off a house STYLE rule silently
// turns off a coordination MECHANISM — absent coverage arriving disguised as a
// preference. Two switches, each doing one thing.
//
// Fails open like everything else here: if the state cannot be read, the panel
// goes to the operator, which is the safe direction. Three of the four AWAY
// states mean "ask" for the same reason.

const LABEL_MARK = /\s*\(recommended\)\s*$/i;   // "Do the thing (Recommended)"
const DESC_MARK = /^\s*\(recommended\)/i;       // "(Recommended) Because ..."

// Anchored on purpose, both of them. An unanchored /\(recommended\)/ scores a
// description that merely DISCUSSES the convention as a mark, and panels about
// panels are exactly what this repo produces.
function isMarked(option) {
    if (!option || typeof option !== 'object') return false;
    return LABEL_MARK.test(String(option.label || '').trim())
        || DESC_MARK.test(String(option.description || '').trim());
}

function unmarkedQuestions(questions) {
    const bad = [];
    for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i];
        const options = (q && q.options) || [];
        // A question with fewer than two options has no ranking to express.
        if (!Array.isArray(options) || options.length < 2) continue;
        if (!options.some(isMarked)) {
            bad.push({ index: i + 1, question: String((q && q.question) || '').slice(0, 90) });
        }
    }
    return bad;
}

/** The option a session should take under branch 2: the marked one, else #1. */
function recommendedOption(question) {
    const options = (question && question.options) || [];
    if (!Array.isArray(options) || !options.length) return null;
    return options.find(isMarked) || options[0];
}

/**
 * The AWAY branch. Returns 0 to let the panel through, or 2 having written the
 * decision the session should take instead.
 *
 * Every failure path returns 0. A panel reaching the operator is the safe
 * outcome; a panel swallowed by a defect in here is a turn nobody can finish.
 */
function awayBranch(questions) {
    if (String(process.env.AUTODEV_AWAY_CHECK || '').toLowerCase() === 'off') return 0;

    let state;
    try {
        // Sibling module inside this same plugin, resolved from __dirname, so
        // this is not the untrusted-path case pre-tool-filter reads as text.
        ({ readAwayState: state } = require('../scripts/away-state.js'));
        state = state();
    } catch {
        return 0;   // cannot read the state -> the operator can be asked
    }

    if (!state || state.state !== 'active') return 0;

    const mins = Math.max(0, Math.round((state.msRemaining || 0) / 60000));
    const picks = questions.map((q, i) => {
        const opt = recommendedOption(q);
        return `  question ${i + 1}: ${String((q && q.question) || '').slice(0, 80)}\n`
            + `    -> take: ${opt ? String(opt.label || '').slice(0, 80) : '(no options — decide and log it)'}`;
    });

    process.stderr.write(
        `Panel held: the operator declared AWAY until ${state.until} (${mins} min left).\n`
        + (state.words ? `Their words: ${state.words.split('\n')[0].slice(0, 160)}\n` : '')
        + '\n'
        + 'Do not wait. Resolve it here, by branch:\n'
        + '  1. Covered by a standing rule or order -> act, log, continue.\n'
        + '  2. Reversible and not covered -> take the option below, log it with the\n'
        + '     branch label in DECISIONS-<date>.md, and continue.\n'
        + '  3. IRREDUCIBLE -> money, production rows, deletes of unmeasured shared\n'
        + '     state, or taste on a daily surface. Write it to the queue as BLOCKED,\n'
        + '     send the four-part idle message, and take the NEXT queue item.\n'
        + '     Blocked on one item is not idle.\n'
        + '\n'
        + picks.join('\n') + '\n'
        + '\n'
        + `Branch 2 errs toward stopping, not toward damage: over 1,389 answered panels\n`
        + 'the only class rejected at a high rate is a recommended PAUSE (43% vs 9%).\n'
        + `This hook cannot judge reversibility — that call is yours, and branch 3 is\n`
        + 'the list above, verbatim.\n'
        + `Read: ${state.file}. Set AUTODEV_AWAY_CHECK=off to disable this branch.\n`
    );
    return 2;
}

function main(raw) {
    const styleOff = String(process.env.AUTODEV_PANEL_CHECK || '').toLowerCase() === 'off';

    let payload;
    try { payload = JSON.parse(raw); } catch { return 0; }

    const name = payload && (payload.tool_name || payload.toolName);
    if (name !== 'AskUserQuestion') return 0;

    const input = (payload && (payload.tool_input || payload.toolInput)) || {};
    const questions = input.questions;
    if (!Array.isArray(questions) || !questions.length) return 0;

    // The mark first: branch 2 says take the RECOMMENDED option, so a panel
    // with none has nothing to take. Make it well-formed, then self-resolve.
    const bad = styleOff ? [] : unmarkedQuestions(questions);
    if (!bad.length) return awayBranch(questions);

    const lines = bad.map((b) => `  question ${b.index}: ${b.question}`);
    process.stderr.write(
        'Panel blocked: ' + bad.length + ' of ' + questions.length
        + ' question(s) mark no option (Recommended).\n'
        + lines.join('\n') + '\n\n'
        + 'rules/options-protocol.md: mark option #1 of every question, with the\n'
        + 'reason in its first clause. Put "(Recommended)" at the end of the label\n'
        + 'or at the start of that option\'s description, then send the panel again.\n'
        + 'Set AUTODEV_PANEL_CHECK=off to disable this check.\n'
    );
    return 2;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
    let code = 0;
    try { code = main(buf); } catch { code = 0; }   // fail open, always
    process.exit(code);
});
process.stdin.on('error', () => process.exit(0));
