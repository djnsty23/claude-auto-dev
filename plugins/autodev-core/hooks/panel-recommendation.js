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

function main(raw) {
    if (String(process.env.AUTODEV_PANEL_CHECK || '').toLowerCase() === 'off') return 0;

    let payload;
    try { payload = JSON.parse(raw); } catch { return 0; }

    const name = payload && (payload.tool_name || payload.toolName);
    if (name !== 'AskUserQuestion') return 0;

    const input = (payload && (payload.tool_input || payload.toolInput)) || {};
    const questions = input.questions;
    if (!Array.isArray(questions) || !questions.length) return 0;

    const bad = unmarkedQuestions(questions);
    if (!bad.length) return 0;

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
