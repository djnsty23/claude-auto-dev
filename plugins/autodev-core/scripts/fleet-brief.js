#!/usr/bin/env node
'use strict';
/**
 * A standing brief every session picks up at start, without the Brain having to
 * remember to send it.
 *
 * WHY. `[measured 2026-08-28]` a coordinating session denied panels across the
 * fleet and messaged the seven sessions it could see. Two worktrees created an
 * hour later inherited the deny and were never told, because they did not exist
 * when the announcement went out. Two more finished their work and went silent,
 * because "message me when done" reached them once and nothing repeated it.
 *
 * A brief delivered by hand reaches the sessions the coordinator remembered, at
 * the moment it remembered them. That is not a channel, it is an errand. This
 * makes it state: written once, read by every session at start, including every
 * session started afterwards.
 *
 * THREE THINGS THAT KEEP IT FROM BECOMING THE NEXT STALE DENY:
 *
 * 1. It EXPIRES. `--set` refuses without `--hours`. An instruction nobody can
 *    date is one no later session can safely disobey, and the panel-deny
 *    incident is the whole argument: five denies stood 26 hours because nothing
 *    on disk said when they were meant to stop.
 * 2. It is SIGNED and dated in the injected text itself, so a session can weigh
 *    it rather than obey it. It carries a coordinator's judgement, never the
 *    operator's authority — the reader must be able to tell.
 * 3. It is SIZE-CAPPED. This lands in the context of every session on the
 *    machine, on every start. A brief that grows without limit is a tax charged
 *    to everyone, forever.
 *
 *   node fleet-brief.js --set "text" --hours 8    publish
 *   node fleet-brief.js --set-file brief.md --hours 8
 *   node fleet-brief.js --status                  what is live, and its age
 *   node fleet-brief.js --clear                   take it down
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const BRIEF = path.join(CFG, 'fleet', 'BRIEF.json');

// Every session pays this on every start. 4000 characters is roughly a page —
// enough for the standing rules, far too small for a report.
const MAX_CHARS = 4000;
const MAX_HOURS = 24;

function readBrief() {
    try { return JSON.parse(fs.readFileSync(BRIEF, 'utf8')); } catch { return null; }
}

/**
 * The live brief's text, or null. Exported so the session-start hook uses the
 * SAME expiry logic rather than reimplementing it — two readers with two
 * opinions about "expired" is how a stale instruction survives one of them.
 *
 * An unparseable or undated brief counts as EXPIRED, never as live: an
 * unrecognised state must be the harmless one here, because the harm is a
 * session acting on an instruction nobody can account for.
 */
function liveBrief(now = Date.now()) {
    const b = readBrief();
    if (!b || typeof b.text !== 'string' || !b.text.trim()) return null;
    // Redundant with the NaN test below — Date.parse(undefined) is already NaN —
    // and kept deliberately, because "no expiry is not live" is the rule and a
    // reader should not have to know that property of Date.parse to see it.
    // Mutation-testing will report this line as a survivor; that is correct and
    // is not a gap in the suite.
    if (!b.expiresAt) return null;
    const t = Date.parse(b.expiresAt);
    if (Number.isNaN(t) || t <= now) return null;
    return b;
}

module.exports = { liveBrief, BRIEF, MAX_CHARS };

if (require.main !== module) return;

// ------------------------------------------------------------------- CLI

if (has('--status')) {
    const raw = readBrief();
    if (!raw) {
        console.log('no fleet brief at ' + BRIEF);
        console.log('  That is a real absence: the file is not there, so nothing is being injected.');
        process.exit(0);
    }
    const live = liveBrief();
    console.log((live ? 'LIVE' : 'EXPIRED') + ' fleet brief — ' + BRIEF);
    console.log('  set by:    ' + (raw.author || '(unsigned)'));
    console.log('  set at:    ' + (raw.setAt || '(undated)'));
    console.log('  expires:   ' + (raw.expiresAt || '(no expiry — treated as EXPIRED)'));
    console.log('  size:      ' + (raw.text || '').length + ' chars');
    if (!live) console.log('  NOT being injected. --clear to remove it, or --set to replace it.');
    console.log('\n' + (raw.text || '').split('\n').map((l) => '  | ' + l).join('\n'));
    process.exit(0);
}

if (has('--clear')) {
    try { fs.unlinkSync(BRIEF); console.log('fleet brief cleared: ' + BRIEF); }
    catch { console.log('nothing to clear at ' + BRIEF); }
    process.exit(0);
}

if (has('--set') || has('--set-file')) {
    const file = val('--set-file', null);
    let text = file ? (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } })()
        : val('--set', null);

    if (text === null) {
        console.error('REFUSING: could not read ' + (file || 'the --set text') + '.');
        process.exit(2);
    }
    text = String(text).trim();
    if (!text) {
        console.error('REFUSING: an empty brief. Use --clear to take one down.');
        process.exit(2);
    }
    if (text.length > MAX_CHARS) {
        console.error(`REFUSING: ${text.length} chars exceeds the ${MAX_CHARS} cap.`);
        console.error('  This is injected into EVERY session on this machine at EVERY start.');
        console.error('  Put the detail in a file the sessions can read on demand and point at it.');
        process.exit(2);
    }

    const hours = parseFloat(val('--hours', ''));
    if (!Number.isFinite(hours) || hours <= 0) {
        console.error('REFUSING: --set needs --hours N.');
        console.error('  A brief with no expiry is an instruction no later session can safely');
        console.error('  disobey and none can date. That is how five panel denies stood for 26');
        console.error('  hours with nobody able to tell whether they were still wanted.');
        process.exit(2);
    }
    if (hours > MAX_HOURS) {
        console.error(`REFUSING: --hours is capped at ${MAX_HOURS}. Longer is a config change, not a brief.`);
        process.exit(2);
    }

    const author = val('--author', null);
    if (!author) {
        console.error('REFUSING: --author "<who>" is required.');
        console.error('  A session must be able to tell whose judgement this is. An unsigned');
        console.error('  brief reads as the operator\'s authority, which it is not.');
        process.exit(2);
    }

    const setAt = new Date();
    const rec = {
        setAt: setAt.toISOString(),
        expiresAt: new Date(setAt.getTime() + hours * 3600 * 1000).toISOString(),
        author,
        text,
    };
    fs.mkdirSync(path.dirname(BRIEF), { recursive: true });
    fs.writeFileSync(BRIEF, JSON.stringify(rec, null, 2) + '\n', 'utf8');

    console.log('fleet brief published: ' + BRIEF);
    console.log('  ' + text.length + ' chars, expires ' + rec.expiresAt);
    console.log('  Every session started before now still needs telling by hand — this');
    console.log('  reaches the ones that start FROM now.');
    process.exit(0);
}

console.error('usage: fleet-brief.js --set "<text>" --hours N --author "<who>"');
console.error('       fleet-brief.js --set-file <path> --hours N --author "<who>"');
console.error('       fleet-brief.js --status | --clear');
process.exit(2);
