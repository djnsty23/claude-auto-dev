#!/usr/bin/env node
// Stop hook — keeps `auto` running until the sprint is genuinely finished.
//
// This hook can BLOCK the end of a turn, so every path below must be able to
// reach `approve`. The escape hatches, in order: an explicit auto-exit signal,
// a stale flag (>2h), an unparseable prd.json, a missing prd.json, and the
// one-shot idle marker. tooling/test-stop-auto-check.js covers all of them.

const fs = require('fs');
const path = require('path');

function approve() {
    console.log(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
}

function block(reason) {
    console.log(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
}

try {
    // The project Claude is working in, not the shell that spawned the hook.
    let cwd = process.cwd();
    try {
        const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
        if (payload && payload.cwd) cwd = payload.cwd;
    } catch { /* no or malformed payload — fall back to process.cwd() */ }

    const autoFlag = path.join(cwd, '.claude', 'auto-active');
    const exitFlag = path.join(cwd, '.claude', 'auto-exit');
    const idleMarker = path.join(cwd, '.claude', 'auto-idle-triggered');
    const prdPath = path.join(cwd, 'prd.json');

    // Stale flag cleanup (>2 hours old = crashed session)
    try {
        const flagAgeMs = Date.now() - fs.statSync(autoFlag).mtimeMs;
        if (flagAgeMs > 2 * 60 * 60 * 1000) {
            fs.unlinkSync(autoFlag);
            process.stderr.write('[Auto-Dev] Removed stale auto-active flag (>2h old)\n');
        }
    } catch {
        // Flag doesn't exist — no cleanup needed
    }

    // Explicit exit signal — the user asked Claude to deactivate auto. Claude
    // can't rm the flag (sensitive-file prompt), so it writes auto-exit instead.
    if (fs.existsSync(exitFlag)) {
        for (const f of [exitFlag, autoFlag, idleMarker]) {
            try { fs.unlinkSync(f); } catch { /* already gone */ }
        }
        process.stderr.write('[Auto-Dev] auto-exit signal received. Cleaning up and allowing stop.\n');
        approve();
    }

    if (!fs.existsSync(autoFlag)) approve();  // not in auto mode

    if (!fs.existsSync(prdPath)) {
        try { fs.unlinkSync(autoFlag); } catch {}
        process.stderr.write('[Auto-Dev] No prd.json found. Cleaning up auto-active flag.\n');
        approve();
    }

    let stories;
    try {
        stories = JSON.parse(fs.readFileSync(prdPath, 'utf8')).stories || {};
    } catch (parseErr) {
        // Auto mode has no task list it can act on. Blocking here would loop the
        // session against a file that cannot be read.
        try { fs.unlinkSync(autoFlag); } catch {}
        process.stderr.write(
            `[Auto-Dev] prd.json parse error: ${parseErr.message}. Leaving auto mode — fix the file and re-run 'auto'.\n`
        );
        approve();
    }

    // `deferred` is a decision not to do the work, so it is NOT remaining work.
    // Counting it as pending (passes !== true) made auto block forever on a
    // sprint whose leftovers were all deferred — the 2h stale flag was the only
    // way out.
    const pending = Object.entries(stories)
        .filter(([, s]) => s.passes !== true && s.passes !== 'deferred');

    if (pending.length > 0) {
        process.stderr.write(`[Auto-Dev] Auto mode active. ${pending.length} tasks remaining. Continuing...\n`);
        block(`${pending.length} tasks remaining. Next: ${pending[0][0]}. Continue working.`);
    }

    // Sprint complete. Give Claude exactly one turn to choose a next action,
    // tracked by a marker file so this can never become a loop.
    if (fs.existsSync(idleMarker)) {
        for (const f of [idleMarker, autoFlag]) {
            try { fs.unlinkSync(f); } catch { /* already gone */ }
        }
        process.stderr.write('[Auto-Dev] IDLE detection already ran. Allowing stop.\n');
        approve();
    }

    fs.writeFileSync(idleMarker, new Date().toISOString());
    const deferred = Object.values(stories).filter((s) => s.passes === 'deferred').length;
    process.stderr.write(`[Auto-Dev] Sprint complete${deferred ? ` (${deferred} deferred)` : ''}. Running IDLE detection...\n`);
    block(
        '[Auto-Dev] Sprint complete - running smart next action' +
        (deferred ? `. ${deferred} story(ies) deferred; do not treat them as outstanding work.` : '')
    );
} catch (err) {
    // Hook must never crash — a thrown error here would strand the session.
    process.stderr.write(`stop-auto-check error: ${err.message}\n`);
    approve();
}
