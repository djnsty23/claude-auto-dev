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
const path = require('path');

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

/**
 * Repeat-suppression for the ADVISORY half only.
 *
 * [measured 2026-08-23] this check fired six times in one session with a
 * byte-identical four-item list, because the standing order genuinely had not
 * changed. A detector that reprints itself unchanged is one the reader learns
 * to skim, which is how a real finding gets missed later — the same failure
 * rules/security.md records about a muted scanner. So an unchanged advisory is
 * DEMOTED to one line carrying its repeat count, never hidden, and the count
 * itself becomes the signal: "unchanged x6" says more than a sixth reprint.
 *
 * Only the advisory is demoted. CARRIED FORWARD is exact and always prints in
 * full — demoting an exact finding would be hiding, not tidying.
 *
 * FAILS OPEN by construction: any unreadable or unwritable state, and every
 * caller that passes no stateFile at all (the sweep, the selftest), gets the
 * full report. The worst case is the noise this exists to reduce, never silence.
 */
function repeatState(stateFile, fingerprint) {
    if (!stateFile) return { repeats: 0, changed: true };
    try {
        const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const changed = prev.fingerprint !== fingerprint;
        const repeats = changed ? 0 : (prev.repeats || 0) + 1;
        fs.writeFileSync(stateFile, JSON.stringify({ fingerprint, repeats }), 'utf8');
        return { repeats, changed };
    } catch {
        try { fs.writeFileSync(stateFile, JSON.stringify({ fingerprint, repeats: 0 }), 'utf8'); } catch { /* fail open */ }
        return { repeats: 0, changed: true };
    }
}

function report(source, out = console.log, stateFile = null) {
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
        out('        A re-offer is not proof of non-delivery: a panel re-listing context, a');
        out('        partial delivery, or a user re-picking something done all look the same');
        out('        from here. This reads panels, not work. Say where each one stands.');
    } else {
        out('[queue] no item was selected twice - nothing measurably carried forward.');
    }

    if (r.standing.length) {
        const fp = JSON.stringify(r.standing.slice().sort());
        const { repeats } = repeatState(stateFile, fp);
        if (repeats > 0) {
            out(`[queue] standing work order unchanged (${r.standing.length} item(s), ${repeats + 1} consecutive commits). Still open; still yours to report against.`);
        } else {
            out(`[queue] standing work order (most recent panel), ${r.standing.length} item(s):`);
            for (const l of r.standing) out(`          - ${l}`);
            out('        Advisory: this check cannot tell delivered from undelivered. Report against the list.');
        }
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
    // `ran` exists so the count below is DERIVED. It read a literal `12` until
    // 2026-09-02: a population that cannot move when the population does, which
    // is the rot a population line exists to prevent.
    let ran = 0;
    const check = (name, cond, detail) => {
        ran++;
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

    /* 5. THE NEW BEHAVIOUR. Without these the four above pass whether or not
          repeat-suppression works at all - a selftest that does not enter the
          code it ships is the vacuity this file's own header warns about. */
    const os = require('os');
    const tmp = path.join(os.tmpdir(), 'autodev-queue-selftest-' + process.pid + '.json');
    try { fs.unlinkSync(tmp); } catch { /* first run */ }
    const src = fixture([
        [[COMMA, OTHER, 'Stop here'], [COMMA, OTHER]],
        [[COMMA, 'Something else'], [COMMA]],
    ]);
    const cap = () => { const L = []; report(src, (s) => L.push(s), tmp); return L.join(String.fromCharCode(10)); };

    const first = cap();
    check('first run prints the standing list in full',
        first.includes('standing work order (most recent panel)'), 'was demoted on first sight');

    const second = cap();
    check('an UNCHANGED advisory is demoted on the next run',
        second.includes('standing work order unchanged') && !second.includes('(most recent panel)'),
        'reprinted identically - the muting failure this exists to stop');
    check('the demoted line still carries the repeat count',
        second.includes('2 consecutive commits'), second.slice(0, 120));

    check('CARRIED FORWARD is NEVER demoted, even when the advisory is',
        second.includes('CARRIED FORWARD'), 'an exact finding was suppressed - that is hiding, not tidying');

    /* Planted change derived FROM the real labels, so it cannot collide with
       them by construction (22c-i) rather than by my choosing an unused string. */
    const changedSrc = fixture([
        [[COMMA, OTHER, 'Stop here'], [COMMA, OTHER]],
        [[COMMA + ' (revised)', 'Something else'], [COMMA + ' (revised)']],
    ]);
    const L3 = []; report(changedSrc, (s) => L3.push(s), tmp);
    check('a CHANGED advisory prints in full again',
        L3.join(String.fromCharCode(10)).includes('standing work order (most recent panel)'), 'stayed demoted after the list changed');

    /* Fail-open: no state file at all must behave like a first run, forever. */
    const L4 = []; report(src, (s) => L4.push(s), null);
    const L5 = []; report(src, (s) => L5.push(s), null);
    check('no state file means never demoted (fails open)',
        L4.join(String.fromCharCode(10)).includes('(most recent panel)') && L5.join(String.fromCharCode(10)).includes('(most recent panel)'),
        'suppressed without state - it must fail toward noise, never toward silence');

    try { fs.unlinkSync(tmp); } catch { /* best effort */ }

    console.log(failures.length
        ? `selftest: FAIL (${failures.length})`
        : `selftest: PASS - ${ran} assertions, positive and negative both exercised`);
    return failures.length ? 1 : 0;
}

/* -------------------------------------------------------------------- sweep */

/**
 * Walk every transcript under a projects root and report carried-forward items.
 * Reuses analyse(), so the sweep and the live hook cannot disagree.
 *
 * Two tiers, because they are NOT the same claim:
 *   carried forward    re-offered, so undelivered AT THE TIME. Many land later.
 *                      This is history, not a backlog.
 *   open at session end also picked in the FINAL panel. Tighter, still not proof -
 *                      an item picked last can be delivered before the session
 *                      ends, and one measured case did exactly that. Candidates
 *                      for triage, never a to-do list.
 */
function sweep(root, out = console.log) {
    const NEEDLE = 'AskUserQuestion';
    const ANSWER = 'questions have been answered';
    let dirs = 0, files = 0, scanned = 0, skipped = 0, bytes = 0, panels = 0, errors = 0;
    const hits = [];

    let entries;
    try { entries = fs.readdirSync(root); } catch {
        out(`[sweep] NOT RUN - cannot read ${root}`);
        return null;
    }

    for (const dir of entries) {
        const full = path.join(root, dir);
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (!st.isDirectory()) continue;
        dirs++;

        let inner; try { inner = fs.readdirSync(full); } catch { continue; }
        for (const f of inner) {
            if (!f.endsWith('.jsonl')) continue;
            files++;
            const p = path.join(full, f);
            let raw;
            try { raw = fs.readFileSync(p, 'utf8'); } catch { errors++; continue; }
            bytes += raw.length;
            // A transcript with no panel cannot carry a finding.
            if (raw.indexOf(NEEDLE) === -1) { skipped++; continue; }
            scanned++;

            const records = [];
            for (const line of raw.split('\n')) {
                if (!line) continue;
                if (line.indexOf(NEEDLE) === -1 && line.indexOf(ANSWER) === -1) continue;
                try { records.push(JSON.parse(line)); } catch { /* partial write */ }
            }

            let r;
            try { r = analyse(records); } catch { errors++; continue; }
            panels += r.panelCount;
            if (!r.carried.length) continue;

            let date = null;
            try { date = fs.statSync(p).mtime.toISOString().slice(0, 10); } catch { /* ignore */ }
            const standing = new Set(r.standing.map((s) => s.toLowerCase()));
            hits.push({
                project: dir, session: f.replace('.jsonl', ''), date,
                carried: r.carried,
                openAtEnd: r.carried.filter((c) => standing.has(c.label.toLowerCase())),
            });
        }
    }

    // Population first, so a zero is a measurement and not a broken walk.
    out(`[sweep] ${dirs} project dir(s), ${files} transcript(s), ${(bytes / 1048576).toFixed(0)} MB read.`);
    out(`[sweep] ${scanned} held a panel and were analysed, ${skipped} had none, ${errors} unreadable, ${panels} panel(s) total.`);

    if (!hits.length) {
        out('[sweep] no carried-forward item in any transcript.');
        return { dirs, files, panels, hits };
    }

    hits.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const open = hits.filter((h) => h.openAtEnd.length);
    const nCarried = hits.reduce((n, h) => n + h.carried.length, 0);
    const nOpen = open.reduce((n, h) => n + h.openAtEnd.length, 0);

    out(`[sweep] CARRIED FORWARD: ${nCarried} item(s) in ${hits.length} session(s) - undelivered at the time, many landed later.`);
    out(`[sweep] OPEN AT SESSION END: ${nOpen} item(s) in ${open.length} session(s) - candidates for triage, not a backlog.`);
    for (const h of open) {
        out(`          ${h.date}  ${h.project}  (session ${h.session.slice(0, 8)})`);
        for (const c of h.openAtEnd) out(`            - "${c.label}"  (${c.panels} panels)`);
    }
    return { dirs, files, panels, hits, open };
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

    if (argv.includes('--sweep')) {
        const i = argv.indexOf('--root');
        const root = (i !== -1 && argv[i + 1])
            ? argv[i + 1]
            : path.join(process.env.CLAUDE_CONFIG_DIR
                || path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude'), 'projects');
        sweep(root);
        process.exit(0);
    }

    const file = transcriptFrom(argv);
    if (!file || !fs.existsSync(file)) {
        console.log('[queue] NOT RUN - no readable transcript (need --transcript or hook stdin transcript_path).');
        process.exit(0);
    }
    /* State lives in the OS temp dir, keyed by transcript path: it is ephemeral
       tooling state, it must not pollute a user's repo, and losing it costs one
       full reprint rather than a missed finding. */
    const key = require('crypto').createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16);
    const stateFile = path.join(require('os').tmpdir(), 'autodev-queue-' + key + '.json');
    report(file, console.log, stateFile);
    process.exit(0);
}

module.exports = { analyse, report, collectPanels };
