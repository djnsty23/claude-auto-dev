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
 * 2. It records the PRIOR state in a marker, so restoring never guesses. A
 *    revert that assumes "there was no deny list before" would silently delete
 *    a rule someone added for their own reasons.
 *
 * 3. It is restorable by ANY session, not only the one that set it. The revert
 *    otherwise depends on a clean exit — and `[measured 2026-08-25]` two
 *    sessions died the same night without one, one of them mid-queue. If the
 *    marker outlives its author, the next session reads it and puts things back.
 *
 * The failure this is designed against is not "panels stay off for an hour". It
 * is panels staying off silently, forever, in a repo nobody is coordinating any
 * more, with nothing to announce it.
 *
 *   node brain-panels.js --off               deny panels in the managed repos
 *   node brain-panels.js --on                restore from the marker
 *   node brain-panels.js --status            what is set, and by whom
 *   node brain-panels.js --off --repos a,b   explicit list rather than the default
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

function managedRepos() {
    const explicit = val('--repos', null);
    if (explicit) {
        return explicit.split(',').map((n) => path.join(CODE, n.trim())).filter((d) => fs.existsSync(d));
    }
    let entries;
    try { entries = fs.readdirSync(CODE, { withFileTypes: true }); } catch { return []; }
    return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NEVER.has(e.name))
        .map((e) => path.join(CODE, e.name))
        .filter((d) => fs.existsSync(path.join(d, '.git')));
}

function turnOff() {
    if (fs.existsSync(MARKER)) {
        console.error('REFUSING: a marker already exists at ' + MARKER);
        console.error('  Panels are already off, or a previous run never restored them.');
        console.error('  Run --status to see what it holds, then --on to restore first.');
        console.error('  Setting twice would record the DENIED state as the prior one, and');
        console.error('  the restore would then put the deny back rather than remove it.');
        process.exit(3);
    }

    const repos = managedRepos();
    const record = { setAt: new Date().toISOString(), tool: TOOL, repos: [] };

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
    }

    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify(record, null, 2) + '\n', 'utf8');

    console.log('panels DENIED in ' + repos.length + ' repo(s):');
    for (const r of repos) console.log('  ' + path.basename(r));
    console.log('');
    console.log('  excluded (the coordinator keeps its panels): ' + [...NEVER].join(', '));
    console.log('  marker: ' + MARKER);
    console.log('');
    console.log('  Restore with --on. Any session can run it, not only this one.');
    console.log('  A SessionEnd hook also restores, so a crash does not leave this set.');
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

function status() {
    const record = readJSON(MARKER);
    if (!record) {
        console.log('no marker: this tool has not denied panels anywhere.');
        console.log('population: checked ' + MARKER);
        return;
    }
    console.log('panels DENIED since ' + record.setAt);
    console.log('population: ' + (record.repos || []).length + ' repo(s)');
    for (const e of record.repos || []) {
        console.log('  ' + path.basename(e.repo) + (e.existed ? '  (had settings, will be restored)' : '  (no settings, will be removed)'));
    }
    console.log('');
    console.log('Restore with --on.');
}

if (has('--on')) turnOn();
else if (has('--status')) status();
else if (has('--off')) turnOff();
else { status(); console.log('\nUsage: --off | --on | --status'); }
