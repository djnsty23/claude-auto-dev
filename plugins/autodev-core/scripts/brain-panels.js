#!/usr/bin/env node
'use strict';
/**
 * Turn panels off in the repos a Brain session is coordinating, and put them
 * back.
 *
 * `[stated 2026-08-25]` — "panels should be forced off through settings then
 * reverted when i input the brain stop command". A managed session that stops on
 * a panel blocks until a human looks, and overnight nobody does. Asking it not
 * to panel is a convention; this is the enforcement.
 *
 * THREE THINGS THAT KEEP IT FROM BECOMING A TRAP, all learned the hard way.
 *
 * 1. It is PER-PROJECT, never machine-wide. A user-level deny would strip the
 *    coordinator's own panels too, and the panel is how the coordinator asks the
 *    user anything — turning it off would silence the one channel that carries
 *    a decision. Each managed repo gets the rule in its own
 *    `.claude/settings.local.json`; the coordinator's repo is excluded by name.
 *
 * 2. It records the PRIOR state, so restoring never guesses. A revert that
 *    assumes "there was no deny list before" would silently delete a rule
 *    someone added for their own reasons.
 *
 * 3. It is restorable by ANY session, not only the one that set it. The revert
 *    otherwise depends on a clean exit — and `[measured 2026-08-25]` two
 *    sessions died the same night without one, one of them mid-queue.
 *
 * The failure this is designed against is not "panels stay off for an hour". It
 * is panels staying off silently, forever, in a repo nobody is coordinating any
 * more, with nothing to announce it.
 *
 * THE FIRST DESIGN LOST TO EXACTLY THAT FAILURE — corrected 2026-08-27.
 *
 * `[measured]` five denies were found across two repos, all written in one bulk
 * pass 26 hours earlier, with the central marker gone. Nothing on disk said when
 * they were set, by whom, why, or whether they were still wanted, so no session
 * could safely clear them and `--status` read as an all-clear. A client-work
 * session spent a day unable to ask the operator a question.
 *
 * Two things caused it and both are now closed:
 *
 *   The prior state lived ONLY in a central marker, which is a single point of
 *   failure that duly failed. It now ALSO lives in a sibling `panel-deny.json`
 *   beside each settings file, carrying setAt, expiresAt, reason and the prior
 *   settings verbatim. State and its justification travel together.
 *
 *   A deny had no expiry, so nothing could tell a live one from an abandoned
 *   one. `--off` now REFUSES without `--hours N` and `--reason "why"`, and any
 *   session may run `--expire` to clear what is past its window and only that.
 *
 * `[stated 2026-08-27]` the operator, narrowing the precondition: panels off is
 * only correct while the coordinator is genuinely answering for every session.
 * That is the unattended overnight case and nothing else. Never while he is
 * working, and never as a standing configuration.
 *
 *   node brain-panels.js --off --hours 8 --reason "overnight fleet run"
 *   node brain-panels.js --on          restore everything this tool set
 *   node brain-panels.js --expire      clear ONLY denies past their window
 *   node brain-panels.js --status      live vs EXPIRED vs unaccounted
 *   node brain-panels.js --repos a,b   an explicit list rather than the default
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const CODE = path.join(HOME, 'Downloads', 'code');
const MARKER = path.join(HOME, '.claude', 'brain-panels-marker.json');
const TOOL = 'AskUserQuestion';

// The coordinator's own repo. Never denied: the panel is how it reaches the
// user, and a coordinator that cannot ask is worse than a session that can.
const NEVER = new Set(['autodev', 'claude-auto-dev']);

function readJSON(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function settingsPath(repo) {
    return path.join(repo, '.claude', 'settings.local.json');
}

// A SIBLING record, written beside the settings file it explains.
//
// `[measured 2026-08-27]` five denies were found whose central marker was gone.
// Nothing on disk could say when they were set, by whom, why, or whether they
// were still wanted, so no session could safely clear them and they stood for 26
// hours in repos nobody was coordinating. The central marker was the single point
// of failure, and it failed.
//
// So the record travels WITH the state it describes, and it carries enough to
// restore without the marker: the prior settings verbatim, including "there was
// no file", so a revert can delete rather than leave an empty shell.
function denyRecordPath(repo) {
    return path.join(repo, '.claude', 'panel-deny.json');
}

function readDenyRecord(repo) {
    return readJSON(denyRecordPath(repo));
}

// Expired means "past the window its author chose". An unreadable or absent
// expiry counts as EXPIRED, not as live: an unrecognised state must be the
// dangerous case, and here the dangerous case is a deny nobody can account for.
function isExpired(rec) {
    if (!rec || !rec.expiresAt) return true;
    const t = Date.parse(rec.expiresAt);
    if (Number.isNaN(t)) return true;
    return t <= Date.now();
}

// Put one location back from its own sibling record, marker or no marker.
function restoreFrom(repo, rec) {
    const sp = settingsPath(repo);
    try {
        if (rec && rec.existed === false) fs.unlinkSync(sp);
        else if (rec && rec.before) fs.writeFileSync(sp, JSON.stringify(rec.before, null, 2) + '\n', 'utf8');
        else {
            // No prior state recorded: strip only our own entry rather than
            // guessing, so a rule somebody else added survives.
            const j = readJSON(sp);
            if (j && j.permissions && Array.isArray(j.permissions.deny)) {
                j.permissions.deny = j.permissions.deny.filter((d) => d !== TOOL);
                fs.writeFileSync(sp, JSON.stringify(j, null, 2) + '\n', 'utf8');
            }
        }
    } catch (e) {
        console.error('  COULD NOT RESTORE ' + sp + ': ' + e.message);
        return false;
    }
    try { fs.unlinkSync(denyRecordPath(repo)); } catch { /* already gone */ }
    return true;
}

// A worktree is where a session ACTUALLY runs, and it carries its own
// settings.local.json. Enumerating only the top-level repo therefore denies
// panels in the one directory no session is sitting in.
//
// `[measured 2026-08-27]` a Brain boot found five worktrees still denying this
// tool while --status reported no marker at all. They had been set by something
// that reached that deep; this function could not, so --on could never clear
// them, and three of the five held live sessions.
//
// Git marks a linked worktree with a .git FILE rather than a directory, so the
// existsSync test below is deliberately indifferent to which it is.
function worktreesOf(repo) {
    const root = path.join(repo, '.claude', 'worktrees');
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => path.join(root, e.name))
        .filter((d) => fs.existsSync(path.join(d, '.git')));
}

// Each repo contributes itself plus its worktrees. The coordinator is filtered
// out BEFORE this expansion, so its worktrees are never reached either - the
// exclusion has to cover the directory a Brain session is really in, not just
// the clone it was cut from.
function expand(repos) {
    const out = [];
    for (const r of repos) {
        out.push(r);
        for (const w of worktreesOf(r)) out.push(w);
    }
    return out;
}

function managedRepos() {
    const explicit = val('--repos', null);
    if (explicit) {
        return expand(explicit.split(',')
            .map((n) => path.join(CODE, n.trim()))
            .filter((d) => fs.existsSync(d)));
    }
    let entries;
    try { entries = fs.readdirSync(CODE, { withFileTypes: true }); } catch { return []; }
    return expand(entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NEVER.has(e.name))
        .map((e) => path.join(CODE, e.name))
        .filter((d) => fs.existsSync(path.join(d, '.git'))));
}

// Every location that currently denies the tool, whether or not this tool set
// it. --status alone cannot answer this: it reads the marker, so a deny set by
// anything else reports as "panels are on". That is not a hypothetical - it is
// how five worktrees stayed denied through a clean --status on 2026-08-27.
function scanForDenies() {
    const found = [];
    for (const loc of managedRepos()) {
        const j = readJSON(settingsPath(loc));
        const deny = j && j.permissions && j.permissions.deny;
        if (Array.isArray(deny) && deny.indexOf(TOOL) !== -1) found.push(loc);
    }
    return found;
}

// Facts about an unaccounted deny that are cheap to gather, assembled here so
// the policy below is a decision rather than a research task. Anything needing
// a transcript read (is a session live in this worktree?) deliberately stays
// out: it would put a multi-second scan behind every --status.
function contextFor(loc, siblings) {
    const sp = settingsPath(loc);
    let mtime = null;
    try { mtime = fs.statSync(sp).mtime; } catch { /* unreadable */ }
    const j = readJSON(sp);
    const deny = (j && j.permissions && j.permissions.deny) || [];

    // THE STRONGEST SIGNAL, and it is free from the stat above.
    //
    // `[measured 2026-08-27]` the five denies found that morning shared an mtime
    // identical to the NANOSECOND, across two different repos. One instant, five
    // files: that is a bulk write. Somebody denying panels in the worktree they
    // were working in would leave five distinct timestamps.
    //
    // The two fields below it are weaker than they look. Both real cases carried
    // an `allow` list beside the deny, with 2 and 31 entries, so "holds only the
    // deny, therefore machine-written" would have scored both wrong.
    let sharedInstant = 0;
    if (mtime) {
        for (const other of siblings || []) {
            if (other === loc) continue;
            try {
                if (fs.statSync(settingsPath(other)).mtime.getTime() === mtime.getTime()) sharedInstant++;
            } catch { /* unreadable sibling */ }
        }
    }

    return {
        loc,
        isWorktree: loc.includes(path.join('.claude', 'worktrees')),
        // Age of the settings file in hours, or null if it could not be read.
        ageHours: mtime ? (Date.now() - mtime.getTime()) / 3600000 : null,
        // How many OTHER unaccounted denies were written at the same instant.
        // Above zero means a bulk write, which no human hand produces.
        sharedInstant,
        denyCount: deny.length,
        otherKeys: j ? Object.keys(j.permissions || {}).filter((k) => k !== 'deny') : [],
    };
}

// DECISION POINT.
//
// A location denies panels and the marker does not account for it. Two readings
// are indistinguishable from the filesystem and lead to opposite actions:
//
//   ORPHAN     - a previous run set it and lost its marker. Safe to clear, and
//                clearing is the whole point of noticing.
//   DELIBERATE - somebody denied panels there on purpose. Clearing it silently
//                overrides a decision, and nothing records that it did.
//
// rules/backup-protocol.md hit this exact fork and landed on report-never-prune,
// because the detector answers "what is set and not in my marker", which is a
// different question from "what is stale". The default below follows that
// precedent. The return value is a label printed by --status; it never gates a
// write, so a wrong answer here misinforms and cannot destroy anything.
function classifyUnaccounted(ctx) {
    // A bulk write is the one thing a human hand cannot produce, so it is the
    // only signal here that discriminates rather than describes.
    if (ctx.sharedInstant > 0) {
        return 'orphan, bulk write of ' + (ctx.sharedInstant + 1) + ' at one instant';
    }
    if (ctx.ageHours !== null && ctx.ageHours > 24) {
        return 'stale ' + Math.round(ctx.ageHours) + 'h, sole author';
    }
    // Deliberately a question. Nothing observed here rules out somebody having
    // set this on purpose, and a label that reads as a verdict would invite
    // exactly the blind prune this function exists to prevent.
    return 'deliberate?';
}

function turnOff() {
    // A WINDOW AND A REASON ARE REQUIRED.
    //
    // `[stated 2026-08-27]` panels off is only correct while the coordinator is
    // genuinely answering for every session, which is the unattended overnight
    // case and nothing else. The old bare `--off` could not express that, so a
    // deny set for one night stood for 26 hours across two repos while nobody
    // was coordinating, and a client-work session spent a day unable to ask a
    // question.
    //
    // Refusing here is the enforcement. An author who cannot say how long, or
    // why, is not running the case this exists for.
    const hours = Number(val('--hours', ''));
    const reason = val('--reason', '');
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
        console.error('REFUSING: --off needs --hours N (a window, 0 < N <= 24).');
        console.error('  A deny with no stated window is the one that outlives its');
        console.error('  coordination. 24h is the cap because a longer one is a');
        console.error('  standing config change, not a coordination window.');
        process.exit(2);
    }
    if (!reason || reason.trim().length < 8) {
        console.error('REFUSING: --off needs --reason "<why>" (at least 8 characters).');
        console.error('  The next session to find this has to know whether it is still');
        console.error('  wanted, and only you can say.');
        process.exit(2);
    }

    if (fs.existsSync(MARKER)) {
        console.error('REFUSING: a marker already exists at ' + MARKER);
        console.error('  Panels are already off, or a previous run never restored them.');
        console.error('  Run --status to see what it holds, then --on to restore first.');
        console.error('  Setting twice would record the DENIED state as the prior one, and');
        console.error('  the restore would then put the deny back rather than remove it.');
        process.exit(3);
    }

    const repos = managedRepos();
    const setAt = new Date();
    const expiresAt = new Date(setAt.getTime() + hours * 3600 * 1000).toISOString();
    const record = { setAt: setAt.toISOString(), expiresAt, reason, tool: TOOL, repos: [] };

    for (const repo of repos) {
        const sp = settingsPath(repo);
        const before = readJSON(sp);
        // The prior state is recorded verbatim, including "the file did not
        // exist", so restoring can delete it rather than leave an empty shell.
        record.repos.push({ repo, existed: before !== null, before: before });

        const next = before ? JSON.parse(JSON.stringify(before)) : {};
        next.permissions = next.permissions || {};
        next.permissions.deny = Array.isArray(next.permissions.deny) ? next.permissions.deny.slice() : [];
        if (next.permissions.deny.indexOf(TOOL) === -1) next.permissions.deny.push(TOOL);

        fs.mkdirSync(path.dirname(sp), { recursive: true });
        fs.writeFileSync(sp, JSON.stringify(next, null, 2) + '\n', 'utf8');

        // The sibling carries everything a restore needs, so losing the central
        // marker can no longer orphan this deny.
        fs.writeFileSync(denyRecordPath(repo), JSON.stringify({
            tool: TOOL,
            setAt: record.setAt,
            expiresAt: expiresAt,
            reason: reason,
            existed: before !== null,
            before: before,
            note: 'Set by brain-panels.js. Past expiresAt this is a FAULT, not a state: '
                + 'any session may clear it with `brain-panels.js --expire`.',
        }, null, 2) + '\n', 'utf8');
    }

    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify(record, null, 2) + '\n', 'utf8');

    // Print the population, split by kind. A bare count of "30" cannot tell a
    // reader whether the worktrees - where the sessions actually are - were
    // covered at all, which is the failure this tool shipped with.
    const wt = repos.filter((r) => r.includes(path.join('.claude', 'worktrees')));
    console.log('panels DENIED in ' + repos.length + ' location(s): '
        + (repos.length - wt.length) + ' repo(s), ' + wt.length + ' worktree(s)');
    for (const r of repos) console.log('  ' + path.relative(CODE, r));
    console.log('');
    console.log('  excluded (the coordinator keeps its panels, worktrees included): ' + [...NEVER].join(', '));
    console.log('  marker: ' + MARKER);
    console.log('');
    console.log('  Restore with --on. Any session can run it, not only this one.');
    console.log('  NOTHING restores this automatically - there is deliberately no');
    console.log('  hook, because one would fire for every session and a managed');
    console.log('  session ending would revert the block constraining it. The');
    console.log('  marker outlives this process, and a Brain boot checks for it.');
}

function turnOn() {
    const record = readJSON(MARKER);
    if (!record) {
        console.log('nothing to restore: no marker at ' + MARKER);
        console.log('  That is not proof panels are on — it is proof THIS tool did not');
        console.log('  turn them off. Check a repo settings file directly if unsure.');
        process.exit(0);
    }

    let restored = 0, removed = 0;
    for (const entry of record.repos || []) {
        const sp = settingsPath(entry.repo);
        if (!entry.existed) {
            // We created it. Delete rather than leave an empty settings file
            // behind, which would look deliberate to the next reader.
            try { fs.unlinkSync(sp); removed++; } catch { /* already gone */ }
            continue;
        }
        try {
            fs.writeFileSync(sp, JSON.stringify(entry.before, null, 2) + '\n', 'utf8');
            restored++;
        } catch (e) {
            console.error('  COULD NOT RESTORE ' + sp + ': ' + e.message);
        }
    }

    fs.unlinkSync(MARKER);
    console.log('panels restored. ' + restored + ' file(s) put back, ' + removed + ' removed as ours.');
    console.log('  set at ' + record.setAt);
}

// The scan runs on EVERY status, marker or not. A marker-only report is the
// thing that read as an all-clear while five worktrees stayed denied.
// Classify every deny found on disk, not only the ones this tool's marker knows
// about. Three outcomes, never two: LIVE, EXPIRED and UNACCOUNTED are different
// facts and only one of them is fine.
function classifyAll() {
    const found = scanForDenies();
    const live = [], expired = [], unaccounted = [];
    for (const loc of found) {
        const rec = readDenyRecord(loc);
        if (!rec) unaccounted.push(loc);
        else if (isExpired(rec)) expired.push({ loc, rec });
        else live.push({ loc, rec });
    }
    return { found, live, expired, unaccounted };
}

function reportScan() {
    const { found, live, expired, unaccounted } = classifyAll();
    console.log('scan: ' + found.length + ' location(s) currently deny ' + TOOL
        + ' across ' + managedRepos().length + ' scanned, ' + live.length + ' live, '
        + expired.length + ' EXPIRED, ' + unaccounted.length + ' unaccounted');

    if (live.length) {
        console.log('');
        console.log('  LIVE - within the window its author set:');
        for (const { loc, rec } of live) {
            console.log('    ' + path.relative(CODE, loc) + '  until ' + rec.expiresAt
                + '  (' + rec.reason + ')');
        }
    }

    // Worded as a fault rather than as a category. A reassuring label on a
    // deficiency converts absent coverage into reported coverage, and that is how
    // five of these stood for 26 hours while --status read as an all-clear.
    if (expired.length) {
        console.log('');
        console.log('  !! EXPIRED - past the window its author chose. This is a FAULT,');
        console.log('     not a state: these sessions cannot ask the operator anything.');
        for (const { loc, rec } of expired) {
            console.log('     ' + path.relative(CODE, loc) + '  expired ' + rec.expiresAt
                + '  (' + rec.reason + ')');
        }
        console.log('');
        console.log('     Clear them: brain-panels.js --expire');
        console.log('     Any session may run it. It touches ONLY the expired.');
    }

    if (unaccounted.length) {
        console.log('');
        console.log('  UNACCOUNTED - denied, with no record beside it explaining why.');
        console.log('  This tool did not set these, so it will not clear them:');
        for (const loc of unaccounted) {
            console.log('    [' + classifyUnaccounted(contextFor(loc, unaccounted)) + '] '
                + path.relative(CODE, loc));
        }
        console.log('');
        console.log('  Reported, not cleared. "No record" is not the same claim as');
        console.log('  "stale", and only one of those is safe to act on blind.');
    }
}

// Clear ONLY what is past its window. Deliberately safe for any session to run
// at any time, which is the point: the restore must not depend on the session
// that set it still being alive.
function expire() {
    const { live, expired, unaccounted } = classifyAll();
    if (!expired.length) {
        console.log('nothing expired. ' + live.length + ' live, ' + unaccounted.length
            + ' unaccounted, 0 cleared.');
        console.log('population: ' + managedRepos().length + ' location(s) scanned');
        return;
    }
    let cleared = 0;
    for (const { loc, rec } of expired) if (restoreFrom(loc, rec)) cleared++;

    // Prune the central marker's entries for anything cleared, so a later --on
    // cannot put back what expired.
    const record = readJSON(MARKER);
    if (record && Array.isArray(record.repos)) {
        const gone = new Set(expired.map((e) => e.loc));
        record.repos = record.repos.filter((e) => !gone.has(e.repo));
        if (record.repos.length) fs.writeFileSync(MARKER, JSON.stringify(record, null, 2) + '\n', 'utf8');
        else { try { fs.unlinkSync(MARKER); } catch { /* gone */ } }
    }

    console.log('cleared ' + cleared + ' expired deny/denies. ' + live.length
        + ' live left untouched, ' + unaccounted.length + ' unaccounted left untouched.');
    console.log('population: ' + managedRepos().length + ' location(s) scanned');
}

function status() {
    const record = readJSON(MARKER);
    if (!record) {
        console.log('no marker: this tool has not denied panels anywhere.');
        console.log('population: checked ' + MARKER);
        reportScan();
        return;
    }
    console.log('panels DENIED since ' + record.setAt);
    console.log('population: ' + (record.repos || []).length + ' repo(s)');
    for (const e of record.repos || []) {
        console.log('  ' + path.relative(CODE, e.repo) + (e.existed ? '  (had settings, will be restored)' : '  (no settings, will be removed)'));
    }
    console.log('');
    reportScan();
    console.log('');
    console.log('Restore with --on.');
}

if (has('--expire')) expire();
else if (has('--on')) turnOn();
else if (has('--status')) status();
else if (has('--off')) turnOff();
else {
    status();
    console.log('');
    console.log('Usage:');
    console.log('  --off --hours N --reason "why"   deny panels for a bounded window');
    console.log('  --on                             restore everything this tool set');
    console.log('  --expire                         clear ONLY denies past their window');
    console.log('  --status                         what is set, live vs expired vs unaccounted');
    console.log('  --repos a,b                      an explicit list rather than the default');
}
