#!/usr/bin/env node
/**
 * fleet-publish.js - publish THIS machine's fleet status where other machines
 * can see it.
 *
 * WHY THIS PUBLISHES COUNTS AND NOTHING ELSE
 *
 * The session registry is machine-local, so a board on one machine silently
 * claims to show "the fleet" while covering one host. The only cross-machine
 * channel available is a git remote — and the obvious payload cannot go through
 * one, for two independent reasons:
 *
 *   1. claude-auto-dev is a PUBLIC repo. Session titles ("Retry Spotify 429 in
 *      convert-spotify-to-youtube"), branch names, project paths and panel
 *      question text are all working context, and rule 25 says assume every
 *      private repo becomes public anyway.
 *   2. The fleet includes CLIENT work. Client material never goes to personal
 *      GitHub — that is the backup protocol's second standing obligation, and a
 *      session title is client-derived metadata just as surely as code is.
 *
 * So this publishes an aggregate: how many sessions, how many blocked, how long
 * the oldest one has been waiting. That answers the question a remote board is
 * actually for — DOES THE OTHER MACHINE NEED ME — and carries nothing
 * identifying. If the answer is yes, you go to that machine for the detail.
 *
 * WHERE: ~/claude-memory/fleet/<hostname>.json, which is private and already
 * synced by the ClaudeMemorySync task. Writing the file is all this does; the
 * existing task commits and pushes it. That means up to 4h of latency, which is
 * poor for a live board and fine for "is anything waiting over there".
 *
 * Usage:
 *   node fleet-publish.js            # write this machine's status
 *   node fleet-publish.js --print    # show what WOULD be written, write nothing
 *   node fleet-publish.js --read     # show every machine's published status
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFleet } = require(path.join(__dirname, 'fleet-status.js'));

const HOME = process.env.USERPROFILE || process.env.HOME;
const DIR = process.env.AUTODEV_FLEET_PUBLISH_DIR || path.join(HOME, 'claude-memory', 'fleet');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DAYS = Number(val('--days', 2));

/**
 * Build the aggregate. Every field here is a COUNT or a DURATION - deliberately
 * nothing that names a project, a branch, a person or a question. If you add a
 * field, ask whether it would be safe on a public repo, because that is the
 * standard this file is held to regardless of where it lands.
 */
function summarise(fleet) {
    const S = fleet.sessions;
    const blocked = S.filter((s) => s.pending);

    // How long has the longest-waiting panel been open? A duration is safe; the
    // question it belongs to is not.
    let oldestBlockedMin = null;
    for (const s of blocked) {
        const t = Date.parse(s.pending.askedAt);
        if (!t) continue;
        const mins = Math.round((Date.now() - t) / 60000);
        if (oldestBlockedMin === null || mins > oldestBlockedMin) oldestBlockedMin = mins;
    }

    const byState = {};
    for (const s of S) byState[s.state] = (byState[s.state] || 0) + 1;

    return {
        host: os.hostname(),
        platform: process.platform,
        publishedAt: new Date().toISOString(),
        windowDays: DAYS,
        sessions: S.length,
        blocked: blocked.length,
        oldestBlockedMin,
        byState,
        // Named so a stale file is obvious rather than silently trusted: a board
        // reading this must be able to say "as of 3 hours ago".
        schema: 1,
    };
}

function readAll() {
    let names;
    try { names = fs.readdirSync(DIR); } catch { return []; }
    const out = [];
    for (const n of names) {
        if (!n.endsWith('.json')) continue;
        try { out.push(JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'))); } catch { /* skip */ }
    }
    return out.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

function main() {
    if (has('--read')) {
        const all = readAll();
        if (!all.length) { console.log(`no published status in ${DIR}`); return; }
        console.log(`${all.length} machine(s) publishing to ${DIR}\n`);
        for (const m of all) {
            const ageMin = Math.round((Date.now() - Date.parse(m.publishedAt)) / 60000);
            console.log(`${String(m.host).padEnd(14)} ${m.blocked} blocked / ${m.sessions} sessions`
                + (m.oldestBlockedMin !== null ? `  oldest waiting ${m.oldestBlockedMin}m` : '')
                + `   (as of ${ageMin}m ago)`);
        }
        return;
    }

    const summary = summarise(scanFleet(DAYS));

    if (has('--print')) { console.log(JSON.stringify(summary, null, 2)); return; }

    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, summary.host + '.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(summary, null, 1) + '\n');
    fs.renameSync(tmp, file);
    console.log(`published ${summary.blocked} blocked / ${summary.sessions} sessions -> ${file}`);
    console.log('  (ClaudeMemorySync commits and pushes this within ~4h)');
}

if (require.main === module) main();
module.exports = { summarise, readAll, DIR };
