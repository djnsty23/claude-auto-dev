#!/usr/bin/env node
'use strict';
/**
 * A decision log that does not live on a branch.
 *
 * WHY. `[measured 2026-08-28]` two sessions in one repo each appended to that
 * repo's `DECISIONS.md` on an unpushed branch. One recorded "Three advertised
 * Pro features were unenforced" and started building the Pro gate; the other
 * recorded "Features are free. Limits are what you pay for." and "AI tagging is
 * free, and the tier is the volume". Neither could see the other, because
 * `origin/main` was three entries behind both of them.
 *
 * The NUMBERING collided visibly — D18 twice, then D19 against D20 — and a
 * numbering check catches that, because numbers compare across trees without
 * knowing intent. The CONTRADICTION did not surface at all, for the same reason
 * it mattered: seeing it requires knowing what each decision meant.
 *
 * A per-repo file in git is the right home for a decision's final text and the
 * wrong channel for finding out someone else is deciding the same thing right
 * now. This is the second thing: append-only, outside every working tree, and
 * readable with no fetch.
 *
 * IT DOES NOT REPLACE DECISIONS.md. It is an index of who is deciding what,
 * so the durable write can happen without two sessions discovering each other
 * afterwards.
 *
 * The load-bearing verb is `--check`, not `--record`. A log everyone writes and
 * nobody reads reproduces the failure with better bookkeeping.
 *
 *   node fleet-decisions.js --check --repo qr --subject ai-pricing
 *   node fleet-decisions.js --record --repo qr --subject ai-pricing \
 *        --decision "AI stays Pro-gated" --author "session-x" [--force]
 *   node fleet-decisions.js --list [--repo qr] [--subject ai-pricing] [--days 7]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const LOG = path.join(CFG, 'fleet', 'DECISIONS.jsonl');

// A subject is a coarse topic key, not a title. Two sessions will never write the
// same sentence; they can plausibly write the same topic. Normalised hard so
// "AI Pricing", "ai-pricing" and "ai pricing" collide on purpose — a key that is
// easy to miss by punctuation is a key that does not detect anything.
function normSubject(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function readAll() {
    let raw;
    try { raw = fs.readFileSync(LOG, 'utf8'); } catch { return { entries: [], readable: false }; }
    const entries = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* one bad line must not blind the rest */ }
    }
    return { entries, readable: true };
}

function priorFor(repo, subject) {
    const { entries } = readAll();
    const s = normSubject(subject);
    return entries.filter((e) => e.subject === s && (!repo || e.repo === repo));
}

/**
 * `write` is a parameter because a refusal must arrive on ONE stream. The first
 * version printed the "REFUSING" line to stderr and the entries it refers to on
 * stdout, so a caller capturing stderr — which is what a caller capturing a
 * failure does — got "1 other session already decided" and none of the detail
 * that makes it actionable. A split message is a message that arrives torn.
 */
function printEntry(e, indent = '  ', write = console.log) {
    write(`${indent}[${e.at}] ${e.repo}/${e.subject}`);
    write(`${indent}  by ${e.author}`);
    write(`${indent}  ${e.decision}`);
    if (e.because) write(`${indent}  because: ${e.because}`);
}

// ------------------------------------------------------------------- check

if (has('--check')) {
    const repo = val('--repo', null);
    const subject = val('--subject', null);
    if (!repo || !subject) {
        console.error('REFUSING: --check needs --repo and --subject.');
        process.exit(2);
    }
    const { readable } = readAll();
    const prior = priorFor(repo, subject);
    if (!readable) {
        console.log(`no decision log yet at ${LOG}`);
        console.log('  Nothing has been recorded. That is a real absence, not an unread file.');
        process.exit(0);
    }
    if (!prior.length) {
        console.log(`no prior decision on ${repo}/${normSubject(subject)} — ${readAll().entries.length} entr(y/ies) scanned`);
        console.log('  Note this only covers what sessions RECORDED here. A decision made and');
        console.log('  never logged is invisible to it, so absence is weaker evidence than presence.');
        process.exit(0);
    }
    console.log(`${prior.length} prior decision(s) on ${repo}/${normSubject(subject)}:\n`);
    for (const e of prior) { printEntry(e); console.log(''); }
    console.log('If yours contradicts one of these, do NOT just record over it — say so to');
    console.log('whoever owns the question. Two sessions building opposite answers is more');
    console.log('expensive than one session waiting.');
    process.exit(0);
}

// ------------------------------------------------------------------ record

if (has('--record')) {
    const repo = val('--repo', null);
    const subject = val('--subject', null);
    const decision = val('--decision', null);
    const author = val('--author', null);
    const because = val('--because', null);

    for (const [flag, v] of [['--repo', repo], ['--subject', subject], ['--decision', decision], ['--author', author]]) {
        if (!v) {
            console.error(`REFUSING: --record needs ${flag}.`);
            console.error('  An unsigned or unattributed decision cannot be argued with, and a');
            console.error('  decision nobody can argue with is the one that causes the collision.');
            process.exit(2);
        }
    }

    // The collision check runs BEFORE the write and blocks it. A log that records
    // the contradiction after the fact documents the failure rather than
    // preventing it — which is what the per-repo DECISIONS.md already did.
    const prior = priorFor(repo, subject).filter((e) => e.author !== author);
    if (prior.length && !has('--force')) {
        console.error(`REFUSING: ${prior.length} other session(s) already decided on ${repo}/${normSubject(subject)}:\n`);
        for (const e of prior) { printEntry(e, '  ', console.error); console.error(''); }
        console.error('  Read those first. If yours AGREES, record with --force and say so in');
        console.error('  --because. If it CONTRADICTS one, that is a question for whoever owns');
        console.error('  the product, not something to settle by writing a later line.');
        process.exit(3);
    }

    const rec = {
        at: new Date().toISOString(),
        repo, subject: normSubject(subject), decision, author,
    };
    if (because) rec.because = because;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n', 'utf8');
    console.log(`recorded: ${repo}/${rec.subject} — ${decision}`);
    console.log(`  ${LOG}`);
    console.log('  This is an INDEX. The durable write still belongs in the repo\'s own');
    console.log('  DECISIONS.md, where it is versioned with the code it explains.');
    process.exit(0);
}

// -------------------------------------------------------------------- list

if (has('--list')) {
    const { entries, readable } = readAll();
    if (!readable) {
        console.log(`no decision log at ${LOG} — nothing recorded yet`);
        process.exit(0);
    }
    const repo = val('--repo', null);
    const subject = val('--subject', null);
    const days = parseFloat(val('--days', ''));
    const cutoff = Number.isFinite(days) ? Date.now() - days * 86400000 : null;

    const shown = entries.filter((e) => (!repo || e.repo === repo)
        && (!subject || e.subject === normSubject(subject))
        && (!cutoff || Date.parse(e.at) >= cutoff));

    console.log(`population: ${entries.length} entr(y/ies) in the log, ${shown.length} shown`);
    // Subjects with more than one author are where the contradictions live, so
    // they are surfaced rather than left for a reader to notice.
    const byKey = new Map();
    for (const e of entries) {
        const k = `${e.repo}/${e.subject}`;
        if (!byKey.has(k)) byKey.set(k, new Set());
        byKey.get(k).add(e.author);
    }
    const contested = [...byKey.entries()].filter(([, a]) => a.size > 1);
    if (contested.length) {
        console.log(`  ${contested.length} subject(s) decided by MORE THAN ONE session — check these first:`);
        for (const [k, a] of contested) console.log(`    ${k}  (${a.size} authors)`);
    }
    console.log('');
    for (const e of shown) { printEntry(e); console.log(''); }
    process.exit(0);
}

console.error('usage: fleet-decisions.js --check  --repo R --subject S');
console.error('       fleet-decisions.js --record --repo R --subject S --decision "..." --author "..." [--because "..."] [--force]');
console.error('       fleet-decisions.js --list [--repo R] [--subject S] [--days N]');
process.exit(2);
