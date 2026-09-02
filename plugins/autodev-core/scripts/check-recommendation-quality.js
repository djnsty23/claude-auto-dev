#!/usr/bin/env node
/**
 * check-recommendation-quality - measure whether the option marked (Recommended)
 * is the one the user actually picks.
 *
 * WHY THIS IS MEASURABLE AT ALL. "The recommendation was bad" is a judgement and
 * a script cannot make it. "The recommendation was REJECTED" is exact and sits in
 * the transcript: the panel names one option (Recommended), the tool result names
 * what was selected, and either that label is in the selection or it is not.
 *
 * So this reports rejection, never quality, and the distinction is the whole
 * point. A rejected recommendation is not proof of a bad one. The user may pick
 * everything on a multi-select, may pick a different option for reasons the panel
 * could not know, or may be sequencing rather than disagreeing. What a RATE gives
 * you is a place to look, and the individual cases are readable enough to judge
 * by hand.
 *
 * THREE SIGNALS, deliberately different in strength:
 *
 *   NO-RECOMMENDATION  exact, and a rules violation. rules/options-protocol.md
 *                      requires option #1 of EVERY question to carry
 *                      "(Recommended)". A panel without one is a menu, which
 *                      pushes the ranking work back onto the reader.
 *
 *   NOT-FIRST          exact. The recommended option was not option #1. Same rule,
 *                      different breach: marking #3 recommended means the reading
 *                      order and the ranking disagree.
 *
 *   REJECTED           exact about the selection, ADVISORY about quality. On a
 *                      SINGLE-select panel the user chose something else, which is
 *                      a real disagreement. On a MULTI-select panel a rejection
 *                      means the recommended item was left out while others were
 *                      taken, which is stronger than it sounds: they read the list
 *                      and dropped the one thing you argued for.
 *
 * WHAT IS DELIBERATELY NOT COUNTED. A multi-select where the user picked
 * everything is not agreement with the recommendation, it is a user who wanted the
 * lot. Counting those as agreement would inflate the pass rate with exactly the
 * panels that exercised no judgement, which is the same shape as a gate that
 * cannot fire. They are reported separately as SWEPT.
 *
 * Usage:
 *   node check-recommendation-quality.js                 every transcript on disk
 *   node check-recommendation-quality.js --session <p>   one transcript
 *   node check-recommendation-quality.js --days 7        recent transcripts only
 *   node check-recommendation-quality.js --list          print every rejected case
 *   node check-recommendation-quality.js --selftest      prove the detector fires
 *
 * Exits 0 in report mode: a rejection rate is information, never a blocker.
 * --selftest exits 1 on failure, because that one IS a gate.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RECOMMENDED_RE = /\s*\(recommended\)\s*$/i;
const isRecommended = (l) => RECOMMENDED_RE.test(String(l).trim());

// The mark also lands at the FRONT of a description, which is the most literal
// reading of "mark option #1, with the reason in its first clause". Measured
// 2026-08-26: 24 panels across 242 transcripts did it that way, every one of
// them on option #1, and a label-only test called all 24 a rules breach. Anchored
// at the start on purpose - an unanchored /\(recommended\)/ would also match prose
// discussing the convention, which several of these descriptions do.
const DESC_RECOMMENDED_RE = /^\s*\(recommended\)/i;
const isRecommendedDesc = (d) => DESC_RECOMMENDED_RE.test(String(d).trim());
const clean = (l) => String(l).replace(RECOMMENDED_RE, '').trim();

function arg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i === -1 ? fallback : process.argv[i + 1];
}
const has = (flag) => process.argv.indexOf(flag) !== -1;

/**
 * Pull every ANSWERED panel out of a transcript.
 *
 * The selection-matching follows check-queue-drained.js deliberately: the answer
 * string joins labels with commas and labels themselves contain commas, so
 * splitting on comma shreds them. Test each of THIS panel's own labels for
 * containment instead. The selftest plants a comma in a label to pin that.
 */
function collectPanels(source) {
    const records = Array.isArray(source)
        ? source
        : fs.readFileSync(source, 'utf8').split('\n').filter(Boolean).map((l) => {
            try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);

    const panels = [];
    const byId = new Map();

    for (const rec of records) {
        const content = rec && rec.message && rec.message.content;
        if (!Array.isArray(content)) continue;

        for (const part of content) {
            if (part.type === 'tool_use' && part.name === 'AskUserQuestion') {
                const questions = (part.input && part.input.questions) || [];
                const qs = questions.map((q) => ({
                    question: String(q.question || ''),
                    multi: q.multiSelect === true,
                    labels: (q.options || []).map((o) => String(o.label || '')),
                    descriptions: (q.options || []).map((o) => String(o.description || '')),
                }));
                const panel = { id: part.id, questions: qs, selected: null };
                byId.set(part.id, panel);
                panels.push(panel);
            } else if (part.type === 'tool_result' && byId.has(part.tool_use_id)) {
                const panel = byId.get(part.tool_use_id);
                const text = JSON.stringify(part.content);
                const all = panel.questions.flatMap((q) => q.labels);
                panel.selected = all.filter((l) => l && text.includes(l));
            }
        }
    }

    return panels.filter((p) => p.selected && p.selected.length);
}

function analyse(panels, sourceName) {
    const out = {
        panels: 0,
        questions: 0,
        noRecommendation: [],
        notFirst: [],
        rejected: [],
        honoured: 0,
        swept: 0,
    };

    for (const p of panels) {
        out.panels += 1;
        const sel = new Set(p.selected);

        for (const q of p.questions) {
            if (!q.labels.length) continue;
            out.questions += 1;

            let recIdx = q.labels.findIndex(isRecommended);
            if (recIdx === -1) {
                recIdx = (q.descriptions || []).findIndex(isRecommendedDesc);
            }
            const ctx = {
                source: sourceName,
                question: q.question.slice(0, 160),
                multi: q.multi,
                options: q.labels.length,
            };

            if (recIdx === -1) {
                out.noRecommendation.push(ctx);
                continue;
            }
            if (recIdx !== 0) {
                out.notFirst.push(Object.assign({ position: recIdx + 1 }, ctx));
            }

            const rec = q.labels[recIdx];
            const chosenHere = q.labels.filter((l) => sel.has(l));
            if (!chosenHere.length) continue;

            // Everything picked. The panel exercised no judgement, so counting it
            // as agreement would inflate the rate with the least informative rows.
            if (q.multi && chosenHere.length === q.labels.length) {
                out.swept += 1;
                continue;
            }

            if (sel.has(rec)) {
                out.honoured += 1;
            } else {
                out.rejected.push(Object.assign({
                    recommended: clean(rec),
                    chosen: chosenHere.map(clean),
                }, ctx));
            }
        }
    }

    return out;
}

function transcripts(days) {
    const root = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');
    const found = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
    const cutoff = days ? Date.now() - Number(days) * 86400000 : null;

    for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(root, d.name);
        let files = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const full = path.join(dir, f);
            if (cutoff) {
                try { if (fs.statSync(full).mtimeMs < cutoff) continue; } catch { continue; }
            }
            found.push(full);
        }
    }
    return found;
}

/**
 * Prove the detector can fire, on each signal separately.
 *
 * A selftest that only proves a pattern CAN match never proves it fires ONLY when
 * it should, so every case below is paired: one that must be caught and one that
 * must not. The comma in "Merge #17, then clear #16" is planted on purpose,
 * because a comma-splitting selection parser shreds it and would silently score
 * every multi-label panel wrong.
 */
function selftest() {
    const mk = (id, questions, answerLabels) => ([
        { message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } },
        { message: { content: [{ type: 'tool_result', tool_use_id: id, content: answerLabels.join(', ') }] } },
    ]);

    const fails = [];
    // `ran` exists so the count below is DERIVED. It read a literal `10` until
    // 2026-09-02: a population that cannot move when the population does, which
    // is the rot a population line exists to prevent.
    let ran = 0;
    const check = (name, cond) => { ran++; if (!cond) fails.push(name); };

    // 1. REJECTED fires when the recommendation is left out.
    let r = analyse(collectPanels(mk('a', [{
        question: 'Which?', multiSelect: false,
        options: [{ label: 'Alpha (Recommended)' }, { label: 'Beta' }],
    }], ['Beta'])), 'selftest');
    check('rejected fires', r.rejected.length === 1 && r.honoured === 0);
    check('rejected names the recommendation', r.rejected[0] && r.rejected[0].recommended === 'Alpha');

    // 2. ...and does NOT fire when it is honoured. The negative half.
    r = analyse(collectPanels(mk('b', [{
        question: 'Which?', multiSelect: false,
        options: [{ label: 'Alpha (Recommended)' }, { label: 'Beta' }],
    }], ['Alpha (Recommended)'])), 'selftest');
    check('honoured does not fire rejected', r.rejected.length === 0 && r.honoured === 1);

    // 3. A label containing a comma must survive selection matching.
    r = analyse(collectPanels(mk('c', [{
        question: 'Which?', multiSelect: false,
        options: [{ label: 'Merge #17, then clear #16 (Recommended)' }, { label: 'Wait' }],
    }], ['Merge #17, then clear #16 (Recommended)'])), 'selftest');
    check('comma label matches', r.honoured === 1 && r.rejected.length === 0);

    // 4. A full multi-select sweep is SWEPT, not honoured. Guards the inflation.
    r = analyse(collectPanels(mk('d', [{
        question: 'Which?', multiSelect: true,
        options: [{ label: 'One (Recommended)' }, { label: 'Two' }, { label: 'Three' }],
    }], ['One (Recommended)', 'Two', 'Three'])), 'selftest');
    check('full sweep is swept', r.swept === 1 && r.honoured === 0 && r.rejected.length === 0);

    // 5. A PARTIAL multi-select that drops the recommendation IS a rejection.
    r = analyse(collectPanels(mk('e', [{
        question: 'Which?', multiSelect: true,
        options: [{ label: 'One (Recommended)' }, { label: 'Two' }, { label: 'Three' }],
    }], ['Two', 'Three'])), 'selftest');
    check('partial multi drop is rejected', r.rejected.length === 1 && r.swept === 0);

    // 6. NO-RECOMMENDATION fires, and does not double-count as rejected.
    r = analyse(collectPanels(mk('f', [{
        question: 'Which?', multiSelect: false,
        options: [{ label: 'One' }, { label: 'Two' }],
    }], ['Two'])), 'selftest');
    check('missing recommendation fires', r.noRecommendation.length === 1 && r.rejected.length === 0);

    // 7. NOT-FIRST fires when the mark is not on option 1.
    r = analyse(collectPanels(mk('g', [{
        question: 'Which?', multiSelect: false,
        options: [{ label: 'One' }, { label: 'Two (Recommended)' }],
    }], ['Two (Recommended)'])), 'selftest');
    check('not-first fires', r.notFirst.length === 1 && r.notFirst[0].position === 2);

    // 8. An UNANSWERED panel is not scored at all.
    r = analyse(collectPanels([
        { message: { content: [{ type: 'tool_use', id: 'h', name: 'AskUserQuestion', input: { questions: [{ question: 'Q', options: [{ label: 'One (Recommended)' }] }] } }] } },
    ]), 'selftest');
    check('unanswered panel is ignored', r.panels === 0 && r.questions === 0);

    // 9. The mark at the FRONT of a description counts, and does not read as a
    //    breach. The panel below is rule-compliant in every way except that the
    //    author put the mark where the reason goes.
    r = analyse(collectPanels(mk('i', [{
        question: 'Which?', multiSelect: false,
        options: [
            { label: 'One', description: '(Recommended) Because it unblocks the rest.' },
            { label: 'Two', description: 'Slower.' },
        ],
    }], ['One'])), 'selftest');
    check('description mark counts', r.noRecommendation.length === 0 && r.honoured === 1);
    check('description mark is option 1', r.notFirst.length === 0);

    // 10. The negative half. A description that merely TALKS about the convention
    //     is not a mark, which is why the pattern is anchored at the start.
    r = analyse(collectPanels(mk('j', [{
        question: 'Which?', multiSelect: false,
        options: [
            { label: 'One', description: 'Panels without a (Recommended) option read as menus.' },
            { label: 'Two', description: 'Slower.' },
        ],
    }], ['Two'])), 'selftest');
    check('prose mentioning the mark is not a mark', r.noRecommendation.length === 1);

    if (fails.length) {
        console.error('SELFTEST FAILED: ' + fails.join('; '));
        process.exit(1);
    }
    console.log(`selftest ok: ${ran} cases, each paired with the negative it must not fire on`);
    process.exit(0);
}

function main() {
    if (has('--selftest')) return selftest();

    const one = arg('--session', null);
    const files = one ? [one] : transcripts(arg('--days', null));

    const total = {
        panels: 0, questions: 0, honoured: 0, swept: 0,
        noRecommendation: [], notFirst: [], rejected: [],
    };
    let read = 0, unreadable = 0;

    for (const f of files) {
        let r;
        try { r = analyse(collectPanels(f), path.basename(f)); } catch { unreadable += 1; continue; }
        read += 1;
        total.panels += r.panels;
        total.questions += r.questions;
        total.honoured += r.honoured;
        total.swept += r.swept;
        total.noRecommendation.push(...r.noRecommendation);
        total.notFirst.push(...r.notFirst);
        total.rejected.push(...r.rejected);
    }

    const judged = total.honoured + total.rejected.length;
    const pct = (n) => (judged ? Math.round((n / judged) * 100) : 0);

    console.log('RECOMMENDATION QUALITY');
    console.log('  population: ' + files.length + ' transcript(s) found, ' + read + ' read, '
        + unreadable + ' UNREADABLE');
    console.log('  ' + total.panels + ' answered panel(s), ' + total.questions + ' question(s)');
    console.log('');
    console.log('  judged   ' + judged + '   (a recommendation existed and the user chose something)');
    console.log('    honoured ' + total.honoured + '  (' + pct(total.honoured) + '%)');
    console.log('    REJECTED ' + total.rejected.length + '  (' + pct(total.rejected.length) + '%)');
    console.log('  swept    ' + total.swept + '   (multi-select, everything picked - no judgement exercised,');
    console.log('                 counted as neither, so the rate is not inflated by them)');
    console.log('');
    console.log('  rules/options-protocol.md breaches:');
    console.log('    no (Recommended) at all   ' + total.noRecommendation.length + ' question(s)');
    console.log('    marked, but not option 1  ' + total.notFirst.length + ' question(s)');

    if (has('--list') && total.rejected.length) {
        console.log('');
        console.log('  REJECTED, most recent last:');
        for (const r of total.rejected) {
            console.log('    Q: ' + r.question);
            console.log('       recommended: ' + r.recommended);
            console.log('       chosen:      ' + r.chosen.join(' | '));
            console.log('       ' + (r.multi ? 'multi-select' : 'single-select') + ', '
                + r.options + ' options, ' + r.source);
        }
    }

    console.log('');
    console.log('  A rejection is exact about the SELECTION and advisory about QUALITY.');
    console.log('  Read the cases before concluding anything: sequencing and disagreement');
    console.log('  look identical from here.');
    process.exit(0);
}

if (require.main === module) main();
module.exports = { collectPanels, analyse, isRecommended, clean };
