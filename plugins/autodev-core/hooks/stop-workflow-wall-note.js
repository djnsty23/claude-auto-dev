#!/usr/bin/env node
// hooks_profile=minimal (plugin userConfig, reaching hooks as CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE)
// skips this hook: it advises, it never guards. tooling/test-hooks-profile.js holds the list.
if (/^minimal$/i.test(process.env.CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE || process.env.CLAUDE_PLUGIN_OPTION_hooks_profile || '')) process.exit(0);

// Stop hook — says, once, that this session's latest workflow run lost agents
// to the session quota wall, and names the call that gets them back.
//
// THE GAP IT CLOSES. `[measured 2026-08-25]` 20 workflow agents on one machine
// died to "You've hit your session limit", 0 of them journaled, and the wall
// took every agent in flight at once. The harness already has the recovery,
// `Workflow({scriptPath, resumeFromRunId})`, which re-runs only the agent()
// calls with no journal result. `[measured 2026-09-08]` it names that call in
// the failure notification — at the instant the main thread is walled too, so
// nothing can act on it — and never again. After the reset the model works
// from memory: the one real resume on this disk was launched by a session
// that wrote "nothing cached, clean start", and when that resume was itself
// interrupted the second notification's resume advice went unread.
//
// WHY STOP, AND WHY NOT StopFailure. At the wall the turn ends through
// StopFailure, and that is the one moment a resume cannot run. This fires at
// the end of the next turn that ENDS NORMALLY, which is the first turn after
// the reset — the moment the model is about to go quiet with a recoverable run
// on disk. A fresh session cannot see the old session's runs (they live under
// the old session id); for that case run workflow-run-triage.js --all-since.
//
// IT NEVER BLOCKS. A Stop hook that blocks on a quota wall is a session that
// cannot end at the wall. This emits `systemMessage` for the operator and
// `additionalContext` for the model, and never a `decision` key, so it cannot
// fight stop-auto-check's approve/block. Every path exits 0.
//
// IT SPEAKS ONCE PER LOSS SET. The ledger remembers, per session and run, a
// digest of the lost agent ids. Same loss again: silent. A resume that loses a
// DIFFERENT set (the real case: 5 to the wall, then 1 to an interrupt): speaks
// once more. A run whose agents wrote in the last 5 minutes is in flight — the
// resume may already be running — and gets nothing.
//
// SILENT MEANS ZERO BYTES on both streams. The suite asserts that on every
// quiet path. One reading of a run directory exists, in
// scripts/workflow-run-triage.js; this hook calls it rather than re-deriving.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEDGER_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('stop-workflow-wall-note.js — Stop hook.\n'
        + 'When the latest workflow run of this session (under the session\'s own\n'
        + 'subagents/workflows/) has an agent lost to the session quota wall, says so\n'
        + 'once and names the Workflow({scriptPath, resumeFromRunId}) call that\n'
        + 're-runs only the lost agents.\n'
        + 'Ledger:   $AUTODEV_WORKFLOW_WALL_STATE, else ~/.claude/workflow-wall-state.json.\n'
        + 'Disable:  AUTODEV_WORKFLOW_WALL=off.\n'
        + 'Never blocks a turn; every path exits 0; silence is zero bytes.');
    process.exit(0);
}

/** Nothing to say. */
function silent() {
    process.exit(0);
}

function ledgerPath() {
    return process.env.AUTODEV_WORKFLOW_WALL_STATE
        || path.join(os.homedir(), '.claude', 'workflow-wall-state.json');
}

function readJson(p) {
    try {
        const v = JSON.parse(fs.readFileSync(p, 'utf8'));
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

function readPayload() {
    try {
        if (process.stdin.isTTY) return null;
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return null;
    }
}

/** journal mtime plus every agent transcript's mtime and size, or null if unreadable. */
function dirStamp(dir) {
    try {
        const parts = [];
        for (const name of fs.readdirSync(dir).sort()) {
            if (name !== 'journal.jsonl' && !/^agent-.*\.jsonl$/.test(name)) continue;
            const st = fs.statSync(path.join(dir, name));
            parts.push(name + ':' + Math.round(st.mtimeMs) + ':' + st.size);
        }
        return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
    } catch {
        return null;
    }
}

function writeLedger(all, key, entry) {
    try {
        const cutoff = Date.now() - LEDGER_MAX_AGE_MS;
        for (const k of Object.keys(all)) {
            const e = all[k];
            if (!e || typeof e !== 'object' || !(Number(e.at) > cutoff)) delete all[k];
        }
        all[key] = entry;
        const p = ledgerPath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(all, null, 2) + '\n');
    } catch {
        /* a ledger we cannot write costs a repeated note, never a broken turn */
    }
}

function main() {
    const disabled = String(process.env.AUTODEV_WORKFLOW_WALL || '').trim().toLowerCase();
    if (disabled === 'off' || disabled === '0' || disabled === 'false') silent();

    const payload = readPayload();
    if (!payload || typeof payload !== 'object') silent();
    const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
    const transcriptPath = typeof payload.transcript_path === 'string' && payload.transcript_path ? payload.transcript_path : null;
    if (!sessionId || !transcriptPath) silent();

    let triage;
    try {
        triage = require(path.join(__dirname, '..', 'scripts', 'workflow-run-triage.js'));
    } catch {
        silent(); // a broken sibling must not become a broken turn
    }

    const runs = triage.sessionRunDirs(transcriptPath, sessionId);
    if (!runs.length) silent();
    const latest = runs[0];

    // Cheap gate before the transcripts are read: a run already noted, whose
    // journal and agent files have not moved since, is the same run. Twelve
    // stats instead of tens of megabytes on every later turn of that session.
    const key = sessionId + ':' + latest.id;
    const ledger = readJson(ledgerPath()) || {};
    const prior = ledger[key];
    const stamp = dirStamp(latest.dir);
    if (prior && stamp && prior.stamp === stamp) silent();

    const t = triage.triageRun(latest);
    if (!t.ok) silent();
    // A run with nothing to say is remembered too, under its stamp, so a
    // fully journaled 10 MB run is read once per session and not once per turn.
    if (t.counts.lostQuotaWall === 0) { writeLedger(ledger, key, { digest: null, stamp, at: Date.now() }); silent(); }
    if (t.inFlight) silent();

    const lostIds = t.agents.filter((a) => a.outcome !== 'journaled').map((a) => a.id).sort();
    const digest = crypto.createHash('sha1').update(lostIds.join(',')).digest('hex');
    if (prior && prior.digest === digest) {
        writeLedger(ledger, key, { digest, stamp, at: Date.now() });
        silent();
    }
    writeLedger(ledger, key, { digest, stamp, at: Date.now() });

    const c = t.counts;
    const n = (v) => Number(v || 0).toLocaleString('en-US');
    const otherLost = c.lost - c.lostQuotaWall;
    const forOperator = `Workflow ${t.id} lost ${c.lostQuotaWall} agent(s) to the session quota wall`
        + (otherLost ? ` and ${otherLost} to something else` : '')
        + `: ${n(t.lostSecs)} agent-seconds and ${n(t.lostTools)} tool calls never reached this thread. `
        + `${c.journaled} of ${c.onDisk} agents are journaled and come back from cache. The resume call is in the model's context; `
        + `or run: node ${path.join(__dirname, '..', 'scripts', 'workflow-run-triage.js')} ${t.id}`;
    const forModel = `WORKFLOW ${t.id} LOST ${c.lostQuotaWall} AGENT(S) TO THE SESSION QUOTA WALL`
        + (t.wallText ? ` ("${t.wallText}")` : '')
        + (otherLost ? ` AND ${otherLost} TO SOMETHING ELSE` : '')
        + `. ${n(t.lostSecs)} agent-seconds and ${n(t.lostTools)} tool calls ran and left no journal result. `
        + `${t.keys.resulted} of ${t.keys.started} agent() calls have a journaled result and return from cache; `
        + `resuming re-runs only the ${t.keys.rerun} call(s) without one, plus any stage that never started. `
        + `Once the limit has reset, resume with exactly: ${t.resume.command} `
        + `Do NOT re-send the script as a fresh Workflow call: that discards the cached results and re-runs every agent. `
        + `Read ${path.join(t.dir, 'journal.jsonl')} first if you need to know what the cached results hold.`;

    console.log(JSON.stringify({
        systemMessage: forOperator,
        hookSpecificOutput: {
            hookEventName: 'Stop',
            additionalContext: forModel,
        },
    }));
    process.exit(0);
}

try { main(); } catch { /* never the reason a turn cannot end */ }
process.exit(0);
