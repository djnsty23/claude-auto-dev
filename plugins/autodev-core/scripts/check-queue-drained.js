#!/usr/bin/env node
/**
 * check-queue-drained - surface the options-protocol queue at commit time.
 *
 * Two findings, deliberately different in strength:
 *
 *   CARRY-FORWARD  exact. A label selected in two or more SEPARATE panels was
 *                  re-offered, and an item is only re-offered because it was not
 *                  delivered. No semantics involved - the transcript proves it.
 *
 *   QUEUE          advisory. The selections from the most recent panel. This check
 *                  CANNOT tell delivered from undelivered; it prints the list so the
 *                  turn has to report against it, which is the delivery contract in
 *                  rules/options-protocol.md ("Report against the list, every turn").
 *
 * Usage:
 *   node check-queue-drained.js --transcript <path>    CLI / npm run check:queue
 *   echo '{"transcript_path":"..."}' | node ...        hook stdin
 *   node check-queue-drained.js --selftest             prove the detector can fire
 *
 * Always exits 0 in report mode. A false positive must never block a commit.
 * --selftest exits 1 on failure, because that one IS a gate.
 */
'use strict';
const fs = require('fs');

const STOP_RE = /^stop here/i;
const RECOMMENDED_RE = /\s*\(recommended\)\s*$/i;

const clean = (l) => String(l).replace(RECOMMENDED_RE, '').trim();
const norm = (l) => clean(l).toLowerCase();

/**
 * Pull every ANSWERED panel out of a transcript, oldest first.
 * Accepts a path, or an array of already-parsed records (the selftest uses that).
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
                const labels = [];
                for (const q of (part.input && part.input.questions) || []) {
                    for (const o of q.options || []) labels.push(o.label);
                }
                const panel = { id: part.id, labels, selected: null };
                byId.set(part.id, panel);
                panels.push(panel);
            } else if (part.type === 'tool_result' && byId.has(part.tool_use_id)) {
                // The answer string joins labels with commas - and labels CONTAIN
                // commas ("Merge #17, then clear #16"). Splitting on comma shreds
                // them, so test each of THIS panel's own labels for containment
                // instead. The selftest pins this: it plants a comma in a label.
                const panel = byId.get(part.tool_use_id);
                const text = JSON.stringify(part.content);
                panel.selected = panel.labels.filter((l) => text.includes(l));
            }
        }
    }

    for (const p of panels) p.work = (p.selected || []).filter((l) => !STOP_RE.test(l.trim()));
    return panels.filter((p) => p.selected && p.selected.length);
}

/** Pure analysis, so the CLI, the hook and the selftest cannot diverge. */
function analyse(source) {
    const panels = collectPanels(source);
    const actionable = panels.reduce((n, p) => n + p.work.length, 0);

    const seen = new Map();
    for (const p of panels) {
        for (const l of p.work) {
            const k = norm(l);
            if (!seen.has(k)) seen.set(k, { label: clean(l), panels: 0 });
            seen.get(k).panels += 1;
        }
    }

    const last = panels[panels.length - 1];
    return {
        panelCount: panels.length,
        actionable,
        carried: [...seen.values()].filter((v) => v.panels >= 2),
        standing: last ? last.work.map(clean) : [],
    };
}

function report(source, out = console.log) {
    const r = analyse(source);

    // Population first, so a zero is distinguishable from a no-op (rule 22c).
    out(`[queue] ${r.panelCount} answered panel(s) scanned, ${r.actionable} actionable selection(s).`);

    if (!r.panelCount) {
        out('[queue] no options panel was answered this session - nothing to report against.');
        return r;
    }

    if (r.carried.length) {
        out(`[queue] CARRIED FORWARD - ${r.carried.length} item(s) were selected, then offered again:`);
        for (const c of r.carried) out(`          - "${c.label}" - selected in ${c.panels} separate panels`);
        out('        An item is only re-offered because it was not delivered. Say where each one stands.');
    } else {
        out('[queue] no item was selected twice - nothing measurably carried forward.');
    }

    if (r.standing.length) {
        out(`[queue] standing work order (most recent panel), ${r.standing.length} item(s):`);
        for (const l of r.standing) out(`          - ${l}`);
        out('        Advisory: this check cannot tell delivered from undelivered. Report against the list.');
    } else {
        out('[queue] most recent panel selected only "stop here" - queue is drained.');
    }
    return r;
}

/* ----------------------------------------------------------------- selftest */

/**
 * Build a transcript in the SAME shape the real tool emits. The planted label
 * carries a comma on purpose: if anyone "simplifies" the matcher to split the
 * answer on commas, this goes red rather than silently under-reporting.
 */
function fixture(panels) {
    const out = [];
    panels.forEach(([labels, picks], i) => {
        out.push({
            message: {
                content: [{
                    type: 'tool_use', id: `p${i}`, name: 'AskUserQuestion',
                    input: { questions: [{ options: labels.map((l) => ({ label: l })) }] },
                }],
            },
        });
        out.push({
            message: {
                content: [{
                    type: 'tool_result', tool_use_id: `p${i}`,
                    content: `Your questions have been answered: "Q"="${picks.join(',')}". You can now continue.`,
                }],
            },
        });
    });
    return out;
}

function selftest() {
    const COMMA = 'Merge #17, then clear #16';   // a real label shape, comma included
    const OTHER = 'Nightly browser-gate workflow';
    const failures = [];
    const check = (name, cond, detail) => {
        console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' - ' + detail}`);
        if (!cond) failures.push(name);
    };

    // 1. POSITIVE - the same label selected in two panels must be reported.
    const pos = analyse(fixture([
        [[COMMA, OTHER, 'Stop here'], [COMMA, OTHER]],
        [[COMMA, 'Something else'], [COMMA]],
    ]));
    check('detects a carried-forward item', pos.carried.length === 1, `got ${pos.carried.length}`);
    check('names the carried label exactly',
        !!pos.carried[0] && pos.carried[0].label === COMMA,
        `got ${JSON.stringify(pos.carried[0] && pos.carried[0].label)}`);
    check('a label containing a comma survives matching',
        pos.actionable === 3, `expected 3 actionable, got ${pos.actionable}`);

    // 2. NEGATIVE - two panels sharing NO label must report nothing.
    const neg = analyse(fixture([
        [[COMMA, 'Stop here'], [COMMA]],
        [[OTHER, 'Stop here'], [OTHER]],
    ]));
    check('stays quiet when nothing repeats', neg.carried.length === 0, `got ${neg.carried.length}`);

    // 3. "Stop here" is a decision, not work.
    const stop = analyse(fixture([[[COMMA, 'Stop here'], ['Stop here']]]));
    check('"Stop here" is never counted as an item', stop.actionable === 0, `got ${stop.actionable}`);

    // 4. An empty transcript must be distinguishable from a finding.
    const empty = analyse([]);
    check('empty transcript reports zero panels', empty.panelCount === 0, `got ${empty.panelCount}`);

    console.log(failures.length
        ? `selftest: FAIL (${failures.length})`
        : 'selftest: PASS - 6 assertions, positive and negative both exercised');
    return failures.length ? 1 : 0;
}

/* --------------------------------------------------------------------- main */

function transcriptFrom(argv) {
    const i = argv.indexOf('--transcript');
    if (i !== -1 && argv[i + 1]) return argv[i + 1];
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    let input = {};
    try { input = JSON.parse(raw); } catch { /* tolerate */ }
    for (const k of ['transcript_path', 'transcriptPath', 'transcript']) {
        if (input && typeof input[k] === 'string') return input[k];
    }
    return null;
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) process.exit(selftest());
    const file = transcriptFrom(argv);
    if (!file || !fs.existsSync(file)) {
        console.log('[queue] NOT RUN - no readable transcript (need --transcript or hook stdin transcript_path).');
        process.exit(0);
    }
    report(file);
    process.exit(0);
}

module.exports = { analyse, report, collectPanels };
