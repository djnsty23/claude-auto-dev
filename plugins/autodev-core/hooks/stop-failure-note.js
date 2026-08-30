#!/usr/bin/env node
// StopFailure hook (Claude Code 2.1.78+) - record a turn that ended on an API
// error rather than on a decision.
//
// WHY THIS EXISTS. stop-auto-check.js keeps `auto` running by BLOCKING the end
// of a turn until the sprint is genuinely finished, and its header lists the
// five ways a turn is allowed to end. There is a sixth it cannot see: when the
// turn dies on an API error (rate limit, auth failure, overload), the harness
// ends it through StopFailure, and the Stop hook never runs at all. Nothing was
// wired to StopFailure, so an unattended sprint stopped and left no trace: the
// auto-active flag stayed on disk, no story changed state, and the next session
// read a sprint that looked mid-run. The stall was invisible by construction,
// which is the worse half of the pair -- a stale "still running" produces no
// error and no diff, so nothing ever surfaces it.
//
// What this hook does NOT do: it does not clear the auto flag and it does not
// decide anything. A failing turn is the wrong moment to take an action, and
// stop-auto-check's own 2h stale-flag path already handles a crashed session.
// This only writes the record that was missing.
//
// Exits 0 on every path. A hook that fires because something already failed
// must never be the reason a second thing fails.

const fs = require('fs');
const path = require('path');

function main() {
    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return; // no stdin, or not JSON: nothing to record, nothing to report
    }

    const cwd = (() => {
        try { return path.resolve(data.cwd || process.cwd()); } catch { return process.cwd(); }
    })();

    // Same walk telemetry.js uses, and for the same reason: it collapses a start
    // deep inside a repo onto one location per repo. Bounded so a symlink cycle
    // cannot spin it.
    const reportRoot = (() => {
        let dir = cwd;
        for (let i = 0; i < 40; i++) {
            try { if (fs.existsSync(path.join(dir, '.git'))) return dir; } catch { /* unreadable rung */ }
            const up = path.dirname(dir);
            if (up === dir) break;
            dir = up;
        }
        return cwd;
    })();

    // Whether a sprint was actually in flight is the field that makes this
    // record worth keeping. A failed turn in an ordinary session is noise; a
    // failed turn with auto-active on disk is a stalled sprint.
    let autoActive = false;
    try { autoActive = fs.existsSync(path.join(cwd, '.claude', 'auto-active')); } catch { /* unreadable */ }

    const ts = new Date().toISOString();
    const record = {
        ts,
        session: data.session_id || null,
        cwd,
        auto_active: autoActive,
        // The harness names the failure differently across versions, so take the
        // first field that carries one rather than assuming a shape.
        reason: data.stop_reason || data.reason || data.error || data.message || null,
    };

    try {
        const dir = path.join(reportRoot, '.claude', 'reports');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
            path.join(dir, `auto-stalls-${ts.slice(0, 10)}.jsonl`),
            JSON.stringify(record) + '\n'
        );
    } catch { /* a full disk must not turn one failure into two */ }

    // Say it once on stderr as well. The record is for the next session; this is
    // for the operator watching this one, and only when a sprint was live.
    if (autoActive) {
        process.stderr.write(
            '[Auto-Dev] Turn ended on an API error with a sprint still active. ' +
            'Recorded in .claude/reports/auto-stalls-' + ts.slice(0, 10) + '.jsonl\n'
        );
    }
}

try { main(); } catch { /* never the second failure */ }
process.exit(0);
