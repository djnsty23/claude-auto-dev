#!/usr/bin/env node
'use strict';

// away-state.js — reads the declared AWAY state, and nothing else.
//
// "Away" is a DECLARED state, never an inference. A session cannot tell an
// operator who has stepped out from one who is reading, and guessing wrong in
// either direction is expensive: guess away and a panel that needed a human is
// self-answered; guess present and the fleet stops on a reversible question.
// So the state lives in a file somebody wrote on purpose.
//
// FOUR STATES, and only one of them licenses self-resolution:
//
//   active     `until` parses and is in the FUTURE  -> self-resolve (branch 2)
//   expired    `until` parses and is in the PAST    -> the operator can be asked
//   absent     no file                              -> the operator can be asked
//   malformed  a file with no usable `until`        -> the operator can be asked,
//                                                      and the reason is reported
//
// Three of the four mean "ask", which is the fail-safe direction: the failure
// of asking is a delay, and the failure of not asking is a decision nobody
// authorised. `undefined` and `false` must not collapse onto the same answer
// when one of them licenses the riskier action, so `malformed` is its own state
// carrying a reason rather than being folded into `absent`.
//
// EXPIRY NEEDS NO WRITER. The state ends because a timestamp passes, not
// because something clears it — so a Brain that dies mid-window cannot strand
// the fleet in a self-resolving state. That is the whole reason `until` is an
// absolute ISO instant rather than a duration or a boolean.
//
// Usage:
//   const { readAwayState } = require('./away-state.js');
//   readAwayState()                     // default path
//   readAwayState({ file, now })        // injectable, for tests
//
//   node away-state.js --status [--file F]   human-readable, prints the population
//   node away-state.js --json   [--file F]
//   node away-state.js --help

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = () => process.env.AUTODEV_AWAY_FILE
    || path.join(os.homedir(), 'claude-memory', 'AWAY.md');

// `until:` on its own line, anywhere in the file. Deliberately lenient about
// surrounding prose, because the file also carries the operator's words
// verbatim and those must not have to be escaped or fenced to be safe.
const UNTIL_LINE = /^[ \t]*(?:-[ \t]*)?until[ \t]*:[ \t]*(\S+)[ \t]*$/im;

/**
 * Read the declared AWAY state.
 *
 * Never throws. A reader that throws is a reader that takes down whichever hook
 * required it, and the whole point of the four states is that every unhappy
 * path has a defined, safe reading.
 *
 * @returns {{state:'active'|'expired'|'absent'|'malformed', file:string,
 *            until:string|null, msRemaining:number|null, words:string,
 *            reason:string|null, canAsk:boolean}}
 */
function readAwayState(opts) {
    const o = opts || {};
    const file = o.file || DEFAULT_FILE();
    const now = o.now instanceof Date ? o.now : new Date();

    const base = { file, until: null, msRemaining: null, words: '', reason: null };

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        // ENOENT is the ordinary case and is not an error. Anything else — a
        // permission problem, a directory where a file should be — is reported
        // as malformed rather than absent, because "I could not read it" and
        // "it is not there" are different facts and only one of them is normal.
        if (err && err.code === 'ENOENT') {
            return { ...base, state: 'absent', canAsk: true };
        }
        return {
            ...base,
            state: 'malformed',
            reason: `could not read (${err && err.code ? err.code : 'unknown error'})`,
            canAsk: true,
        };
    }

    const m = UNTIL_LINE.exec(raw);
    if (!m) {
        return { ...base, state: 'malformed', reason: 'no `until:` line', canAsk: true };
    }

    const untilRaw = m[1];
    const untilMs = Date.parse(untilRaw);
    if (!Number.isFinite(untilMs)) {
        return {
            ...base,
            state: 'malformed',
            until: untilRaw,
            reason: `\`until: ${untilRaw}\` is not a parseable instant`,
            canAsk: true,
        };
    }

    // An instant with no timezone is ambiguous, and the ambiguity is an HOUR or
    // more wide — which is exactly the width of a short away window. Date.parse
    // reads a bare "2026-09-02T22:00:00" as LOCAL time, so the same file means
    // different things on two machines. Refuse it rather than pick one.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(untilRaw)) {
        return {
            ...base,
            state: 'malformed',
            until: untilRaw,
            reason: `\`until: ${untilRaw}\` carries no timezone, so it means different `
                + 'instants on different machines. Use a trailing Z or an explicit offset.',
            canAsk: true,
        };
    }

    // The operator's words: everything that is not the until line or a heading.
    const words = raw
        .split('\n')
        .filter((l) => !UNTIL_LINE.test(l) && !/^\s*#/.test(l))
        .join('\n')
        .trim();

    const msRemaining = untilMs - now.getTime();
    if (msRemaining > 0) {
        return { ...base, state: 'active', until: untilRaw, msRemaining, words, canAsk: false };
    }
    return { ...base, state: 'expired', until: untilRaw, msRemaining, words, canAsk: true };
}

module.exports = { readAwayState, DEFAULT_FILE, UNTIL_LINE };

// --- CLI ------------------------------------------------------------------
// A module that can also be RUN, because a state nobody can print is a state
// nobody can debug, and check-entrypoints probes every scripts/*.js with --help.

if (require.main === module) {
    const argv = process.argv.slice(2);
    const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('usage: away-state.js [--status|--json] [--file <path>]\n'
            + 'Reads the declared AWAY state. Four states: active (self-resolve),\n'
            + 'expired / absent / malformed (the operator can be asked).\n'
            + 'File: $AUTODEV_AWAY_FILE, else ~/claude-memory/AWAY.md');
        process.exit(0);
    }

    const s = readAwayState({ file: val('--file') });

    if (argv.includes('--json')) {
        console.log(JSON.stringify(s, null, 2));
        process.exit(0);
    }

    // Population beside the verdict: WHICH file was read, so a reader can tell
    // "no away window" from "looked at the wrong path".
    const mins = s.msRemaining === null ? null : Math.round(s.msRemaining / 60000);
    console.log(`away: ${s.state.toUpperCase()}  (read ${s.file})`);
    if (s.until) console.log(`  until: ${s.until}${mins === null ? '' : `  (${mins} min ${mins >= 0 ? 'remaining' : 'ago'})`}`);
    if (s.reason) console.log(`  reason: ${s.reason}`);
    console.log(`  panels: ${s.canAsk ? 'the operator can be asked' : 'SELF-RESOLVE — take the recommended option and log it'}`);
    if (s.words) console.log(`  operator's words: ${s.words.split('\n')[0].slice(0, 100)}`);
    process.exit(0);
}
