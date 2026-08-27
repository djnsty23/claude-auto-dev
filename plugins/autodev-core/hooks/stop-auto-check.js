#!/usr/bin/env node
// Stop hook — keeps `auto` running until the sprint is genuinely finished.
//
// This hook can BLOCK the end of a turn, so every path below must be able to
// reach `approve`. The escape hatches, in order: an explicit auto-exit signal,
// a stale flag (>2h), an unparseable prd.json, a missing prd.json, and the
// one-shot idle marker. tooling/test-stop-auto-check.js covers all of them.

const fs = require('fs');
const path = require('path');

// A carried-forward options-protocol item, if the transcript shows one. It rides
// on whatever decision this hook was already going to emit, rather than as a
// second Stop hook: `systemMessage` carries no decision, so it cannot fight
// stop-auto-check's approve/block, and there is no extra process.
//
// Only the EXACT finding is surfaced here - an item selected in two separate
// panels, which is proof it was re-offered. The advisory queue print stays on
// the commit path. A Stop hook fires far more often than a commit does, and a
// check that speaks every turn is one that gets ignored.
let carryNote = null;

function decide(o) {
    if (carryNote) o.systemMessage = carryNote;
    console.log(JSON.stringify(o));
    process.exit(0);
}

function approve() {
    decide({ decision: 'approve' });
}

function block(reason) {
    decide({ decision: 'block', reason });
}

// A pending story untouched for this long is not active work.
const STALE_DAYS = 30;
// Past this, the cache describes a repo that has moved on. Fail open — skip
// nothing — rather than set aside a story on a month-old measurement.
const CACHE_MAX_AGE_DAYS = 14;

// Which of these story ids the nightly drift-audit measured as long-untouched.
// Every failure path here returns an empty list, so a missing, stale, or
// corrupt cache can only make auto do MORE work, never less.
function staleStories(ids, cwd) {
    const none = { skipped: [], cacheAge: null };
    try {
        const config = process.env.CLAUDE_CONFIG_DIR
            || path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
        const file = path.join(config, 'autodev', 'prd-story-ages.json');
        const all = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Match on the real path — a repo reached through a symlink is the same
        // repo, and this hook is handed a cwd it does not control.
        const here = fs.realpathSync(cwd);
        const entry = all[here] || all[cwd];
        if (!entry || !entry.ages) return none;

        const cacheAge = (Date.now() - Date.parse(entry.computedAt)) / 86400000;
        if (!(cacheAge >= 0) || cacheAge > CACHE_MAX_AGE_DAYS) return none;

        // `null` means the audit's scan never saw the story change, i.e. it is
        // older than the scan reached — the oldest class there is, not unknown.
        const skipped = ids.filter((id) => {
            if (!(id in entry.ages)) return false;
            const d = entry.ages[id];
            return d === null || d > STALE_DAYS;
        });
        return { skipped, cacheAge };
    } catch { return none; }
}

try {
    // The project Claude is working in, not the shell that spawned the hook.
    let cwd = process.cwd();
    try {
        const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
        if (payload && payload.cwd) cwd = payload.cwd;

        // Computed BEFORE any approve()/block() below, since most turns exit at
        // the first one. Wrapped separately: a queue note must never be the
        // reason a turn cannot end.
        try {
            const transcript = payload && (payload.transcript_path || payload.transcriptPath);
            if (transcript && fs.existsSync(transcript)) {
                const { analyse } = require(path.join(__dirname, '..', 'scripts', 'check-queue-drained.js'));
                const r = analyse(transcript);
                if (r.carried.length) {
                    const items = r.carried.map((c) => `"${c.label}" (${c.panels} panels)`).join(', ');
                    // SAY WHAT WAS OBSERVED, NOT WHY IT HAPPENED.
                    //
                    // "offered again" is measured: the item was selected in one panel
                    // and appears in a later one. "without being delivered" is a CAUSE,
                    // and this hook cannot see delivery at all - it reads panels, not
                    // work. check-queue-drained.js says so in as many words on its other
                    // branch ("this check cannot tell delivered from undelivered"), so
                    // the same mechanism was asserting a fact here and disclaiming it
                    // there.
                    //
                    // `[measured 2026-08-27]` a session reported one undelivered item
                    // while this note claimed six. Only one of those can be right and
                    // the hook has no way to know which, so it should not have taken a
                    // side. A re-offer has innocent causes too: a panel re-listing
                    // context, a partial delivery, a user re-picking something done.
                    //
                    // The ask is unchanged and is the useful half - a session that says
                    // where each item stands resolves the ambiguity the hook cannot.
                    carryNote = `[queue] ${r.carried.length} selected item(s) were offered again in a later panel: `
                        + `${items}. That is a re-offer, not proof of non-delivery - this hook `
                        + `reads panels, not work. Say where each one stands before the turn ends.`;
                }
            }
        } catch { /* a queue note must never strand a turn */ }

        // Record that this turn ENDED. A transcript mtime says the file grew,
        // which is not the same thing and cannot tell working from waiting.
        // Metadata only, no transcript read: check-queue-drained above already
        // read that file, and it can run to several megabytes.
        try {
            require(path.join(__dirname, '..', 'scripts', 'fleet-heartbeat.js')).write(payload, cwd);
        } catch { /* a heartbeat must never strand a turn */ }
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

    // A story nobody has edited in months is a decision not to do the work that
    // nobody wrote down. One repo had 14 of 15 pending stories untouched for over
    // a month and 3 for over three months, several of them blocked on a person,
    // a vendor, or a console nobody had opened — and auto blocked on all of them.
    //
    // Ages come from a cache the nightly drift-audit writes. They are NOT
    // computed here: the walk costs 1,652ms against this hook's 31ms, on every
    // Stop, for a number that changes by days. No cache (or a stale one) simply
    // means no stories are skipped — the conservative direction.
    const { skipped } = staleStories(pending.map(([id]) => id), cwd);
    const active = pending.filter(([id]) => !skipped.includes(id));

    if (active.length > 0) {
        process.stderr.write(`[Auto-Dev] Auto mode active. ${active.length} tasks remaining. Continuing...\n`);
        block(`${active.length} tasks remaining. Next: ${active[0][0]}. Continue working.`);
    }

    // Everything left is stale. Say exactly which stories were set aside and
    // why — silently skipping work is how a backlog rots without anyone
    // deciding to let it.
    if (skipped.length > 0) {
        process.stderr.write(
            `[Auto-Dev] ${skipped.length} pending story(ies) untouched >${STALE_DAYS}d — not treated as active work: ${skipped.join(', ')}\n`
        );
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
        (deferred ? `. ${deferred} story(ies) deferred; do not treat them as outstanding work.` : '') +
        // Surfaced to Claude, not just to stderr: these stories are still
        // `passes: null` and auto walked past them. Reconciling or deferring
        // them for real is the next action, and it needs a human.
        (skipped.length
            ? `. ${skipped.length} story(ies) were skipped as untouched >${STALE_DAYS}d (${skipped.join(', ')})` +
              ' — they are still pending in prd.json. Reconcile them or mark them deferred rather than leaving them to age.'
            : '')
    );
} catch (err) {
    // Hook must never crash — a thrown error here would strand the session.
    process.stderr.write(`stop-auto-check error: ${err.message}\n`);
    approve();
}
