#!/usr/bin/env node
/**
 * brain-brief.js - regenerate the VOLATILE half of a handoff document.
 *
 * A handoff written when an overseer session ends mixes two kinds of content.
 * The DURABLE half - the role, the escalation rules, the traps - stays true for
 * weeks. The VOLATILE half - which PRs are open, which session holds which
 * branch, what is uncommitted - starts decaying the moment it is written and is
 * fiction within hours.
 *
 * A fresh session reading a decayed handoff fails two ways:
 *   STALE     it acts on a fact that changed.
 *   CONFUSED  it duplicates work another session already holds.
 *
 * This prints the volatile half AS IT IS RIGHT NOW, so the handoff never has to
 * be believed about anything that moves. It is a report, not a gate: it always
 * exits 0, and one broken section never stops the others.
 *
 * REUSE, NOT REIMPLEMENTATION. There is exactly one transcript parser on this
 * machine and it lives in fleet-status.js; this file calls scanFleet() from it.
 * Overlap scoring lives in fleet-overlap.js and is invoked as a child process
 * because that file has no exports and runs on import - shelling out costs one
 * extra fleet scan (~1.5s) and is still cheaper than a second scoring
 * implementation that can drift from the first.
 *
 * THE ONE REQUIREMENT THAT OUTRANKS THE FEATURES: silence must never read as
 * "nothing there". Every section prints the population it scanned, and every
 * section distinguishes "none found" from "could not check". A zero with no
 * denominator is indistinguishable from a probe that ran on nothing - which is
 * the failure this whole script exists to prevent.
 *
 * Usage:
 *   node brain-brief.js                     # everything, no arguments needed
 *   node brain-brief.js --days 3            # transcript window (default 2)
 *   node brain-brief.js --repo <path>       # add a repo, repeatable
 *   node brain-brief.js --handoff <path>    # point at a specific handoff doc
 *   node brain-brief.js --no-overlap        # skip the overlap child process
 *   node brain-brief.js --gh-timeout 30000  # widen the gh bound on a slow link
 *
 * Repos are never named in this file. claude-auto-dev is PUBLIC and some of the
 * repos on this machine are client work, so the set is discovered at runtime
 * from the fleet's own session cwds, from the current directory, and from a
 * machine-local config at ~/.claude/brain-brief.json:
 *
 *     { "repos": ["C:/path/to/repo", "C:/path/to/other"] }
 *
 * When that config is absent the script says so, with the path - an incomplete
 * repo set that announces itself beats a complete-looking one that is not.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const SCRIPTS = __dirname;
const CONFIG_PATH = path.join(HOME, '.claude', 'brain-brief.json');
const MEMORY_DIR = path.join(HOME, 'claude-memory');

// A handoff older than this cannot be trusted about anything that moves.
const HANDOFF_TRUST_HOURS = 4;

// Per-command ceilings. gh talks to the network and can hang on auth; git is
// local and should never need this long. A command that hits the ceiling is
// reported as a TIMEOUT, never as an empty result.
// --gh-timeout exists because a slow link needs a longer bound than a fast one,
// and because a timeout branch nobody can trigger is a branch nobody has tested.
const GIT_TIMEOUT_MS = 10000;
const OVERLAP_TIMEOUT_MS = 20000;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const many = (f) => argv.reduce((a, v, i) => (v === f && argv[i + 1] ? a.concat(argv[i + 1]) : a), []);

const DAYS = Number(val('--days', 2)) || 2;
const GH_TIMEOUT_MS = Number(val('--gh-timeout', 15000)) || 15000;
const LIVE_MINUTES = 60 * 24;   // matches fleet-overlap's definition of "live"

// Collapse a run of untitled, unaddressable rows in the OWNERSHIP section only
// once there are at least this many. Below it, printing them costs nothing and
// hides nothing; at 11, 13 and 21 per branch they bury the rows that matter.
// Never collapses a titled or addressable session - see the comment at the use.
const ANON_COLLAPSE_AT = 3;

if (has('--help') || has('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    process.exit(0);
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

const out = [];
const say = (s) => out.push(s === undefined ? '' : s);
const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/**
 * Run a command and NEVER reject. The caller gets one of three shapes, and the
 * distinction between them is the whole point of this file:
 *   { ok: true, stdout }                     it ran
 *   { ok: false, timedOut: true, reason }    it ran too long - not an empty result
 *   { ok: false, reason }                    it failed, with why
 *
 * A missing cwd is checked BEFORE spawning, because Node reports it as
 * `spawn git ENOENT` - which reads as "git is not installed" and would send a
 * reader chasing the wrong thing entirely.
 */
function run(cmd, args, opts) {
    const o = opts || {};
    const timeout = o.timeout || GIT_TIMEOUT_MS;
    return new Promise((resolve) => {
        if (o.cwd && !isDir(o.cwd)) {
            resolve({ ok: false, reason: 'directory does not exist: ' + o.cwd, stdout: '', stderr: '' });
            return;
        }
        const started = Date.now();
        execFile(cmd, args, {
            cwd: o.cwd, timeout, windowsHide: true, encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            const ms = Date.now() - started;
            if (!err) { resolve({ ok: true, stdout: stdout || '', stderr: stderr || '', ms }); return; }
            // execFile signals a timeout kill with killed/signal, not an exit code.
            if (err.killed || err.signal) {
                resolve({ ok: false, timedOut: true, ms, stdout: stdout || '', stderr: stderr || '',
                    reason: 'TIMED OUT after ' + timeout + 'ms (' + cmd + ' ' + args.slice(0, 2).join(' ') + ')' });
                return;
            }
            if (err.code === 'ENOENT') {
                resolve({ ok: false, ms, stdout: '', stderr: '', reason: "'" + cmd + "' not found on PATH" });
                return;
            }
            const first = String(stderr || err.message || '').split(/\r?\n/).find(Boolean) || ('exit ' + err.code);
            resolve({ ok: false, ms, stdout: stdout || '', stderr: stderr || '',
                reason: 'exit ' + err.code + ': ' + first.slice(0, 200) });
        });
    });
}

/** Bounded parallelism. Spawning 40 processes at once on Windows is slower than 12. */
async function pool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            try { results[i] = await fn(items[i], i); }
            catch (e) { results[i] = { error: e && e.message ? e.message : String(e) }; }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
}

function hours(ms) { return Math.round((ms / 3600000) * 10) / 10; }
function shortAge(min) {
    if (min < 60) return Math.round(min) + 'm';
    if (min < 1440) return (Math.round(min / 6) / 10) + 'h';
    return (Math.round(min / 144) / 10) + 'd';
}
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '?'; }

/**
 * Header for a section that could not run at all. Worded as a DEFICIENCY, not as
 * a category: "nothing to check" invites agreement, "NOT CHECKED" invites a fix.
 */
function cantCheck(what, why) {
    say('  !! COULD NOT CHECK - ' + what);
    say('     reason: ' + why);
}

// ---------------------------------------------------------------------------
// 0. freshness header
// ---------------------------------------------------------------------------

function resolveHandoff() {
    const explicit = val('--handoff', null);
    if (explicit) {
        if (isFile(explicit)) return { file: explicit, how: 'given on the command line' };
        return { file: null, missing: explicit, how: 'given on the command line', absent: true };
    }
    const today = new Date();
    const stamp = today.getFullYear() + '-' +
        String(today.getMonth() + 1).padStart(2, '0') + '-' +
        String(today.getDate()).padStart(2, '0');
    const todayFile = path.join(MEMORY_DIR, 'HANDOFF-' + stamp + '.md');
    if (isFile(todayFile)) return { file: todayFile, how: "today's dated handoff" };

    // No handoff for today. That is not the same as no handoff - fall back to the
    // newest one and say which, so an old document cannot masquerade as current.
    let entries;
    try { entries = fs.readdirSync(MEMORY_DIR); }
    catch (e) {
        return { file: null, error: 'cannot read ' + MEMORY_DIR + ' (' + e.code + ')' };
    }
    const candidates = entries
        .filter((f) => /^HANDOFF-.*\.md$/i.test(f))
        .map((f) => {
            const p = path.join(MEMORY_DIR, f);
            try { return { p, m: fs.statSync(p).mtimeMs }; } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.m - a.m);
    if (!candidates.length) {
        return { file: null, scanned: entries.length, none: true };
    }
    return { file: candidates[0].p, how: 'newest in ' + MEMORY_DIR + " (no handoff dated today)", scanned: candidates.length };
}

function freshnessHeader() {
    const now = new Date();
    say(RULE);
    say('BRAIN BRIEF - the volatile half, regenerated');
    say('  now: ' + now.toISOString() + '   (local ' + now.toLocaleString() + ')');
    say('  host: ' + os.hostname() + '   node ' + process.version);
    say(RULE);

    const h = resolveHandoff();
    if (h.error) {
        cantCheck('handoff document age', h.error);
        say('  Treat every volatile claim you carry in from anywhere as UNVERIFIED.');
        say('');
        return;
    }
    if (h.absent) {
        cantCheck('handoff document age', 'file not found: ' + h.missing);
        say('  A path was given and nothing is there. This is not "no handoff exists" -');
        say('  check the path before concluding either.');
        say('');
        return;
    }
    if (h.none) {
        say('  handoff: NONE FOUND - 0 files matching HANDOFF-*.md in ' + MEMORY_DIR);
        say('           (' + h.scanned + ' entries scanned, directory readable)');
        say('  So there is no durable half to pair with this. This output is the only');
        say('  current picture of the fleet.');
        say('');
        return;
    }

    let st;
    try { st = fs.statSync(h.file); }
    catch (e) { cantCheck('handoff document age', 'stat failed: ' + e.message); say(''); return; }

    const ageH = hours(Date.now() - st.mtimeMs);
    say('  handoff: ' + h.file);
    say('           ' + h.how + ', ' + (st.size / 1024).toFixed(1) + ' KB');
    const ageText = ageH > 48 ? ageH + 'h old (' + (ageH / 24).toFixed(1) + ' days)' : ageH + 'h old';
    say('           written ' + new Date(st.mtimeMs).toLocaleString() + '  ->  ' + ageText);
    say('');

    if (ageH > HANDOFF_TRUST_HOURS) {
        const w = 74;
        const box = (s) => say('  #  ' + s.padEnd(w - 6) + ' #');
        say('  ' + '#'.repeat(w));
        box('');
        box('THAT HANDOFF IS ' + ageH + 'h OLD. DO NOT TRUST ITS VOLATILE SECTIONS.');
        box('');
        box('Open PRs, session ownership, blocked panels and uncommitted work');
        box('decayed the moment it was written. THIS OUTPUT SUPERSEDES those');
        box('sections of that document.');
        box('');
        box('Its DURABLE half - the role, escalation rules, traps, decisions -');
        box('is still good. Read that there; read everything that moves here.');
        box('');
        say('  ' + '#'.repeat(w));
    } else {
        say('  Under the ' + HANDOFF_TRUST_HOURS + 'h trust window, so its volatile sections are probably');
        say('  still close. Where this output disagrees with it, THIS output wins -');
        say('  it was measured just now and the document was not.');
    }
    say('');
}

// ---------------------------------------------------------------------------
// 1. fleet
// ---------------------------------------------------------------------------

/** Load scanFleet from the one transcript parser. Returns null and explains why not. */
function loadFleet() {
    const mod = path.join(SCRIPTS, 'fleet-status.js');
    if (!isFile(mod)) return { error: 'fleet-status.js not found beside this script (' + mod + ')' };
    try {
        const { scanFleet } = require(mod);
        if (typeof scanFleet !== 'function') return { error: 'fleet-status.js exports no scanFleet()' };
        return { scanFleet };
    } catch (e) {
        return { error: 'require(fleet-status.js) threw: ' + (e && e.message ? e.message : String(e)) };
    }
}

function sectionFleet(fleet) {
    say(THIN);
    say('1. FLEET - who is alive, who is blocked');
    say(THIN);

    if (fleet.error) {
        cantCheck('the fleet (sessions, states, blocked panels)', fleet.error);
        say('     Sections 1 and 2 are BLIND. Do not read the absence of blocked');
        say('     sessions below as "nobody is blocked" - nothing was scanned.');
        say('');
        return;
    }

    const p = fleet.data.population;
    const all = fleet.data.sessions;
    const live = all.filter((s) => !s.isArchived && s.idleMinutes < LIVE_MINUTES);

    say('  population: ' + p.transcripts + ' transcripts in ' + p.dirs + ' project dirs (last ' + DAYS + 'd), ' +
        live.length + ' live (<24h), ' + (all.length - live.length) + ' cold');

    // A scan that found no transcripts AT ALL is a probe that ran on nothing, and
    // it prints identically to a genuinely quiet fleet. Say which this is, or the
    // rest of the section is an all-clear nobody earned.
    if (!p.dirs || !p.transcripts) {
        say('');
        cantCheck('the fleet - the scan found ' + p.dirs + ' project dirs and ' + p.transcripts + ' transcripts',
            'nothing was there to read. Either no session has run in ' + DAYS + 'd, or the ' +
            'transcript root is not where this script looked.');
        say('     Everything below in sections 1 and 2 is therefore VACUOUS, not reassuring.');
        say('');
        return;
    }
    say('              ' + p.blocked + ' blocked on an unanswered panel, ' +
        p.addressable + ' addressable, ' + p.withPanels + ' have ever raised a panel');

    // Auto-archive-after-PR-merge ends the session that merged, removes its
    // worktree and deletes its branch - including a Brain that merely merged
    // someone else's PR, which is ordinary Brain work. brain/SKILL.md says READ
    // THE SETTING, NEVER ASSUME IT, and nothing in this boot path did.
    //
    // It still does not, and this line says so rather than faking it. The
    // obvious test - a row that is archived beside a MERGED pr - CANNOT FIRE
    // here: `[measured 2026-09-02]` isArchived is false for all 152 sessions
    // scanFleet returns, and 0 of 12 local session records carry the key at
    // all, because archiving removes a session from the local store rather than
    // flagging it. A check that cannot fire would print a reassuring line
    // forever, which is worse than printing nothing.
    //
    // Same measurement explains why the three `!s.isArchived` filters in this
    // file exclude nothing today. They are correct and inert.
    const archivedSeen = all.filter((s) => s.isArchived).length;
    say('  auto-archive-after-merge: NOT DETERMINABLE from local records - ' + archivedSeen +
        ' of ' + all.length + ' scanned sessions carry the archived flag, because archiving ' +
        'removes a session from the local store rather than flagging it.');
    say('     Read it with list_sessions(include_archived: true) and look for isArchived beside');
    say('     a MERGED prState. If it is on, merging a PR ends the session that merged, so');
    say('     capture follow-up work BEFORE you merge. Do not read this line as "off".');

    const byState = new Map();
    for (const s of live) byState.set(s.state, (byState.get(s.state) || 0) + 1);
    const states = [...byState.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v);
    say('  live by state: ' + (states.length ? states.join(', ') : '(none)'));
    say('');

    const blocked = live.filter((s) => s.pending);
    if (!blocked.length) {
        say('  BLOCKED ON A PANEL: none, out of ' + live.length + ' live sessions scanned.');
    } else {
        say('  BLOCKED ON A PANEL: ' + blocked.length + ' of ' + live.length + ' live sessions.');
        say('  Each of these is stopped until somebody answers. They cost nothing while');
        say('  they wait and deliver nothing either.');
        say('');
        for (const s of blocked) {
            say('   * ' + (s.title || baseName(s.cwd)) + '   [' + shortAge(s.idleMinutes) + ' idle]');
            say('     repo/branch: ' + baseName(s.cwd) + (s.gitBranch ? ' @ ' + s.gitBranch : ' @ (no branch)'));
            say('     address:     ' + (s.addressableId || 'NOT ADDRESSABLE - cannot be messaged'));
            for (const q of s.pending.questions || []) {
                say('     ? ' + q.question);
                for (const o of q.options || []) say('         - ' + o.label);
            }
            say('');
        }
    }

    // Sessions that are running and quiet are the ones worth a glance - either a
    // long build or a session that died mid-task, and those look identical here.
    const stalled = live.filter((s) => s.state === 'stalled');
    say('  STALLED (running, addressable, quiet 15-240m): ' + stalled.length);
    for (const s of stalled) {
        say('     - ' + (s.title || baseName(s.cwd)) + '  [' + shortAge(s.idleMinutes) + ' idle, ' +
            (s.gitBranch || 'no branch') + ']  ' + (s.addressableId || ''));
    }
    say('');
}

// ---------------------------------------------------------------------------
// 2. ownership
// ---------------------------------------------------------------------------

/**
 * Which session holds which repo and branch. The reader's question is "may I
 * start on X" and the answer is a name, so the branch is grouped and every
 * holder is listed - a branch with two holders is the collision that matters.
 */
async function sectionOwnership(fleet, repoIndex) {
    say(THIN);
    say('2. OWNERSHIP - which session holds which repo and branch');
    say(THIN);

    if (fleet.error) {
        cantCheck('session ownership', 'the fleet scan failed (see section 1)');
        say('');
        return;
    }

    const live = fleet.data.sessions.filter((s) => !s.isArchived && s.idleMinutes < LIVE_MINUTES);
    const byRepo = new Map();
    let unattributed = 0;
    for (const s of live) {
        const cwd = s.originCwd || s.cwd || '';
        const root = repoIndex.get(cwd) || null;
        const key = root ? baseName(root) : (cwd ? baseName(cwd) + ' (root unresolved)' : '(no cwd)');
        if (!root) unattributed++;
        if (!byRepo.has(key)) byRepo.set(key, new Map());
        const branches = byRepo.get(key);
        const b = s.gitBranch || '(no branch / detached)';
        if (!branches.has(b)) branches.set(b, []);
        branches.get(b).push(s);
    }

    say('  population: ' + live.length + ' live sessions across ' + byRepo.size + ' repo(s), ' +
        unattributed + ' whose git root could not be resolved');
    if (!live.length) {
        cantCheck('ownership - 0 live sessions were available to attribute',
            'the fleet scan returned nothing live. Nobody is shown as holding a branch');
        say('     because nothing was read - do not take that as "every branch is free".');
    }
    if (unattributed) {
        say('  A "(root unresolved)" heading below means git could not name a repo for that');
        say('  cwd - usually because it is not a git working tree at all. See REPO SET for');
        say('  the per-directory reason. Those rows are grouped by folder name, not by repo.');
    }
    say('');

    const repos = [...byRepo.entries()].sort((a, b) => {
        const ca = [...a[1].values()].reduce((n, v) => n + v.length, 0);
        const cb = [...b[1].values()].reduce((n, v) => n + v.length, 0);
        return cb - ca;
    });
    for (const [repo, branches] of repos) {
        const total = [...branches.values()].reduce((n, v) => n + v.length, 0);
        say('  ' + repo + '  (' + total + ' session' + (total === 1 ? '' : 's') + ')');
        for (const [branch, sessions] of branches) {
            const clash = sessions.length > 1 ? '  <-- ' + sessions.length + ' SESSIONS ON ONE BRANCH' : '';
            say('    ' + branch + clash);

            // A row that is BOTH untitled and unaddressable tells a reader nothing
            // and cannot be acted on. `[measured 2026-09-01]` three branches carried
            // 11, 13 and 21 of them, so 45 such rows buried the 8 real sessions in
            // this section and a Brain read the section as a 53-session fleet.
            //
            // Collapsed to a count, never dropped: the number stays visible and
            // stays challengeable. An ADDRESSABLE session is never collapsed
            // whatever its title, because that is precisely the row someone may
            // need to message, and a titled one is never collapsed either, because
            // the title is the only thing identifying it. So the only rows this can
            // hide are rows carrying no identity and no address.
            const anon = sessions.filter((s) => !s.title && !s.addressableId);
            const shown = anon.length >= ANON_COLLAPSE_AT
                ? sessions.filter((s) => s.title || s.addressableId)
                : sessions;
            for (const s of shown) {
                say('      - ' + (s.title || '(untitled)') + '  [' + s.state + ', ' +
                    shortAge(s.idleMinutes) + ' idle]' + (s.addressableId ? '  ' + s.addressableId : '  (not addressable)'));
            }
            if (anon.length >= ANON_COLLAPSE_AT) {
                const idle = anon.map((s) => s.idleMinutes).sort((a, b) => a - b);
                say('      - [' + anon.length + ' more, all untitled and NOT addressable, idle ' +
                    shortAge(idle[0]) + ' to ' + shortAge(idle[idle.length - 1]) +
                    '] collapsed - none can be messaged');
            }
        }
        say('');
    }

    // Overlap scoring is fleet-overlap.js's job, not this file's. It has no
    // exports and prints on import, so it runs as a child process.
    if (has('--no-overlap')) {
        say('  overlap scoring: SKIPPED (--no-overlap)');
        say('');
        return;
    }
    const overlapPath = path.join(SCRIPTS, 'fleet-overlap.js');
    if (!isFile(overlapPath)) {
        cantCheck('overlap scoring (same branch / same repo / same topic)',
            'fleet-overlap.js not found beside this script (' + overlapPath + ')');
        say('');
        return;
    }
    const r = await run(process.execPath, [overlapPath], { timeout: OVERLAP_TIMEOUT_MS });
    if (!r.ok) {
        cantCheck('overlap scoring (same branch / same repo / same topic)', r.reason);
        say('     The branch listing above still stands - only the SCORING is missing.');
        say('');
        return;
    }
    say('  overlap scoring (from fleet-overlap.js, ' + r.ms + 'ms). This is a SECOND,');
    say('  independent scan taken moments after section 1, so its counts can differ');
    say('  from those above by however much the fleet moved in between:');
    for (const line of r.stdout.split(/\r?\n/)) say(line ? '    ' + line : '');
    say('');
}

// ---------------------------------------------------------------------------
// repo discovery - deliberately name-free, see the header
// ---------------------------------------------------------------------------

function readRepoConfig() {
    if (!isFile(CONFIG_PATH)) {
        return { repos: [], retired: [], note: 'no config at ' + CONFIG_PATH + ' - add {"repos":["<path>",...]} to cover repos with no live session' };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : (parsed.repos || []);
        const retired = Array.isArray(parsed) ? [] : (parsed.retired || []);
        const good = [], bad = [];
        for (const p of list) (isDir(p) ? good : bad).push(p);
        return {
            repos: good,
            retired,
            note: 'config ' + CONFIG_PATH + ': ' + list.length + ' listed, ' + good.length + ' present' +
                (bad.length ? ', MISSING: ' + bad.join(', ') : '') +
                (retired.length ? ', ' + retired.length + ' retired (named below, not a gap)' : ''),
        };
    } catch (e) {
        return { repos: [], retired: [], note: 'COULD NOT READ config ' + CONFIG_PATH + ': ' + e.message };
    }
}

/**
 * Resolve any directory - a worktree included - to the MAIN repo root.
 *
 * String-stripping ".claude/worktrees/<x>" gets the common case and silently
 * mis-files every other worktree layout, so ask git: --git-common-dir points at
 * the main checkout's .git from anywhere inside any linked worktree.
 */
async function resolveRoots(dirs) {
    const uniq = [...new Set(dirs.filter(Boolean))];
    const index = new Map();   // input dir -> main repo root, absent when unresolved
    const roots = new Map();   // root -> how it was found
    const results = await pool(uniq, 12, async (d) => {
        if (!isDir(d)) return { d, ok: false, reason: 'directory gone' };
        const r = await run('git', ['-C', d, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: d });
        if (!r.ok) return { d, ok: false, reason: r.reason };
        const gitDir = r.stdout.trim();
        if (!gitDir) return { d, ok: false, reason: 'empty --git-common-dir' };
        return { d, ok: true, root: path.normalize(path.dirname(gitDir)) };
    });
    const failures = [];
    for (const res of results) {
        if (!res || !res.ok) { failures.push({ dir: res ? res.d : '?', reason: (res && res.reason) || 'unknown' }); continue; }
        index.set(res.d, res.root);
        if (!roots.has(res.root)) roots.set(res.root, 'session cwd');
    }
    return { index, roots, tried: uniq.length, failed: failures.length, failures };
}

async function discoverRepos(fleet) {
    const cfg = readRepoConfig();

    // A retired repo is excluded ON PURPOSE, and it is named in the output for
    // that reason. Dropping it silently would leave a future session unable to
    // tell a deliberate retirement from a config someone edited by accident,
    // which is the shape where an absent check reads as a passing one.
    //
    // Resolve each retired path to its repo ROOT before excluding, so the
    // exclusion still holds for a repo reached through a worktree or a session
    // cwd rather than through the literal path in the config.
    const retiredRoots = new Set();
    const retiredNames = [];
    for (const rp of cfg.retired || []) {
        if (!isDir(rp)) { retiredNames.push(baseName(rp) + '   (path gone, nothing to exclude)'); continue; }
        const rr = await run('git', ['-C', rp, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: rp });
        if (!rr.ok) { retiredNames.push(baseName(rp) + '   (not a git tree, nothing to exclude)'); continue; }
        const rroot = path.normalize(path.dirname(rr.stdout.trim()));
        retiredRoots.add(rroot);
        retiredNames.push(baseName(rroot));
    }

    const sessionDirs = fleet.error ? [] : fleet.data.sessions
        .filter((s) => !s.isArchived && s.idleMinutes < LIVE_MINUTES)
        .map((s) => s.originCwd || s.cwd)
        .filter(Boolean);

    const { index, roots, tried, failed, failures } = await resolveRoots(sessionDirs);

    const explicit = many('--repo');
    const extra = [];
    for (const p of cfg.repos) extra.push([p, 'config']);
    for (const p of explicit) extra.push([p, '--repo flag']);
    extra.push([process.cwd(), 'current directory']);

    const missing = [];
    for (const [p, how] of extra) {
        if (!isDir(p)) { missing.push({ p, how }); continue; }
        const r = await run('git', ['-C', p, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: p });
        if (!r.ok) { missing.push({ p, how, reason: r.reason }); continue; }
        const root = path.normalize(path.dirname(r.stdout.trim()));
        if (!roots.has(root)) roots.set(root, how);
        index.set(p, root);
    }

    for (const root of [...roots.keys()]) if (retiredRoots.has(root)) roots.delete(root);

    // "Recently worked on" is a claim about commits, so read commits. The newest
    // commit on ANY ref beats a branch tip: work in flight usually sits on a
    // side branch, and last-fetch time measures the survey rather than the work.
    const list = [...roots.entries()].map(([root, how]) => ({ root, how, name: baseName(root), lastCommit: null }));
    await pool(list, 8, async (r) => {
        const out = await run('git', ['-C', r.root, 'log', '-1', '--format=%ct', '--all'], { cwd: r.root });
        const t = out.ok ? Number(String(out.stdout).trim()) : NaN;
        r.lastCommit = Number.isFinite(t) && t > 0 ? t : null;
        // --all reads REMOTE-TRACKING refs too, and those are only as fresh as the
        // last fetch. So lastCommit is not merely a number with a caveat: its
        // freshness is CAPPED by this one. Carried here so the sort can say so.
        r.fetchMs = fetchAgeMs(r.root);
    });
    // Newest first. A repo whose date could not be read sorts LAST, never first:
    // an unreadable date is not a fresh one, and the top of this list is what a
    // panel offers first.
    list.sort((a, b) => (b.lastCommit || 0) - (a.lastCommit || 0) || a.name.localeCompare(b.name));

    return {
        index,
        repos: list,
        retired: retiredNames,
        note: cfg.note,
        sessionDirsTried: tried,
        sessionDirsFailed: failed,
        sessionDirFailures: failures,
        missing,
    };
}

// ---------------------------------------------------------------------------
// 3. open PRs
// ---------------------------------------------------------------------------

function parseGitHubRemote(url) {
    const u = String(url || '').trim();
    let m = u.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (m) return m[1] + '/' + m[2];
    return null;
}

/**
 * Collapse a statusCheckRollup into counts.
 *
 * A state this function has never heard of counts as NOT PASSED, never as fine.
 * That polarity is the whole reason to write it out: `startup_failure` is a
 * completed, failed run that renders in the UI exactly like an ordinary red X,
 * and a rollup summariser that treats unrecognised values as benign will call a
 * repo-wide CI outage green.
 */
function rollup(nodes) {
    if (nodes == null) return { text: 'NO CHECKS REPORTED (null rollup - not the same as passing)', bad: true };
    if (!nodes.length) return { text: '0 checks reported (not the same as passing)', bad: true };
    const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
    const FAIL = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
    const PEND = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);
    let pass = 0, fail = 0, pend = 0; const unknown = [];
    for (const n of nodes) {
        const s = String(n.conclusion || n.state || n.status || '').toUpperCase();
        if (PASS.has(s)) pass++;
        else if (FAIL.has(s)) fail++;
        else if (PEND.has(s)) pend++;
        else { unknown.push(s || '(empty)'); }
    }
    const parts = [pass + ' pass'];
    if (fail) parts.push(fail + ' FAIL');
    if (pend) parts.push(pend + ' pending');
    if (unknown.length) parts.push(unknown.length + ' UNRECOGNISED (' + [...new Set(unknown)].join(',') + ') - counted as not-passed');
    return { text: parts.join(', '), bad: fail > 0 || unknown.length > 0, pending: pend > 0 };
}

async function sectionPRs(repos) {
    say(THIN);
    say('3. OPEN PRs - what is waiting to merge');
    say(THIN);

    if (!repos.length) {
        cantCheck('open PRs', 'no repos were discovered at all (see the repo population above)');
        say('');
        return;
    }

    const ghProbe = await run('gh', ['--version'], { timeout: 8000 });
    if (!ghProbe.ok) {
        cantCheck('open PRs in all ' + repos.length + ' repo(s)', 'gh: ' + ghProbe.reason);
        say('     NOT "there are no open PRs". Nothing was asked.');
        say('');
        return;
    }

    const results = await pool(repos, 4, async (repo) => {
        const remote = await run('git', ['-C', repo.root, 'remote', 'get-url', 'origin'], { cwd: repo.root });
        if (!remote.ok) return { repo, error: 'origin remote: ' + remote.reason };
        const slug = parseGitHubRemote(remote.stdout);
        if (!slug) return { repo, error: 'origin is not a GitHub remote (' + remote.stdout.trim().slice(0, 80) + ')' };
        const r = await run('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '30', '--json',
            'number,title,headRefName,isDraft,mergeable,mergeStateStatus,updatedAt,url,author,statusCheckRollup'],
            { timeout: GH_TIMEOUT_MS });
        if (!r.ok) return { repo, slug, error: r.reason, timedOut: !!r.timedOut };
        let prs;
        try { prs = JSON.parse(r.stdout || '[]'); }
        catch (e) { return { repo, slug, error: 'gh returned unparseable JSON: ' + e.message }; }
        return { repo, slug, prs, ms: r.ms };
    });

    const okRepos = results.filter((r) => r && r.prs);
    const badRepos = results.filter((r) => r && r.error);
    const totalPRs = okRepos.reduce((n, r) => n + r.prs.length, 0);
    say('  population: ' + repos.length + ' repo(s) discovered, ' + okRepos.length + ' queried successfully, ' +
        badRepos.length + ' COULD NOT BE CHECKED, ' + totalPRs + ' open PR(s) found');
    say('  gh: ' + ghProbe.stdout.split(/\r?\n/)[0]);
    say('');

    for (const r of results) {
        if (!r) continue;
        if (r.error) {
            say('  ' + r.repo.name + (r.slug ? '  (' + r.slug + ')' : ''));
            cantCheck('open PRs for ' + r.repo.name, r.error);
            say('');
            continue;
        }
        say('  ' + r.repo.name + '  (' + r.slug + ')  - ' + r.prs.length + ' open, checked in ' + r.ms + 'ms');
        if (!r.prs.length) { say('    none open. This is a real zero: gh answered.'); say(''); continue; }
        const sorted = r.prs.slice().sort((a, b) => b.number - a.number);
        for (const pr of sorted) {
            const merge = pr.mergeable === 'MERGEABLE' ? 'MERGEABLE'
                : pr.mergeable === 'CONFLICTING' ? 'CONFLICTING'
                    : 'mergeable UNKNOWN (GitHub has not computed it)';
            const checks = rollup(pr.statusCheckRollup);
            const flag = pr.isDraft ? ' [DRAFT]' : '';
            say('    #' + pr.number + flag + '  ' + merge + (pr.mergeStateStatus ? ' / ' + pr.mergeStateStatus : ''));
            const title = String(pr.title || '');
            say('        ' + (title.length > 86 ? title.slice(0, 85) + '...' : title));
            say('        branch ' + pr.headRefName + '   updated ' + String(pr.updatedAt || '').replace('T', ' ').replace('Z', 'Z'));
            say('        checks: ' + checks.text);
            say('        ' + pr.url);
        }
        say('');
    }
}

// ---------------------------------------------------------------------------
// 4. uncommitted and unpushed
// ---------------------------------------------------------------------------

/** Parse `git status --porcelain=v1 --branch` into something a reader can act on. */
function parseStatus(text) {
    const lines = String(text).split(/\r?\n/).filter((l) => l.length);
    let branch = null, upstream = null, ahead = 0, behind = 0, detached = false;
    let staged = 0, modified = 0, untracked = 0, conflicted = 0;
    for (const l of lines) {
        if (l.startsWith('## ')) {
            const b = l.slice(3);
            if (/^HEAD \(no branch\)/.test(b)) { detached = true; branch = 'HEAD (detached)'; continue; }
            const m = b.match(/^([^.]+(?:\.[^.]+)*?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/);
            if (m) {
                branch = m[1];
                upstream = m[2] || null;
                const box = m[3] || '';
                const a = box.match(/ahead (\d+)/); if (a) ahead = Number(a[1]);
                const be = box.match(/behind (\d+)/); if (be) behind = Number(be[1]);
            } else { branch = b; }
            continue;
        }
        if (l.startsWith('??')) { untracked++; continue; }
        const x = l[0], y = l[1];
        if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { conflicted++; continue; }
        if (x !== ' ' && x !== '?') staged++;
        if (y !== ' ' && y !== '?') modified++;
    }
    return { branch, upstream, ahead, behind, detached, staged, modified, untracked, conflicted,
        dirty: staged + modified + untracked + conflicted };
}

/**
 * The paths `git status --porcelain=v1` is talking about.
 *
 * Two shapes bite a naive slice(3), and both fail SILENTLY - you stat a path
 * that does not exist, get nothing, and report "0 files read" rather than an
 * error. Quoted paths (a space or a non-ASCII byte anywhere in the name) arrive
 * wrapped in double quotes with C-style escapes, and a rename arrives as
 * `old -> new` where only the second half is on disk.
 */
function dirtyPaths(text) {
    const out = [];
    for (const l of String(text).split(/\r?\n/)) {
        if (!l.length || l.startsWith('## ')) continue;
        let rest = l.slice(3);
        // A rename or copy names both sides; only the destination exists now.
        const arrow = rest.indexOf(' -> ');
        if (arrow !== -1 && (l[0] === 'R' || l[0] === 'C')) rest = rest.slice(arrow + 4);
        if (rest.startsWith('"') && rest.endsWith('"') && rest.length > 1) {
            try { rest = JSON.parse(rest); } catch { rest = rest.slice(1, -1); }
        }
        if (rest.length) out.push(rest);
    }
    return out;
}

/**
 * When was this worktree last actually TOUCHED?
 *
 * `git status` prints "modified" identically for an edit made thirty seconds ago
 * and one abandoned in June, so a dirty count cannot separate live work from a
 * derelict tree. [measured 2026-08-27] one worktree reported 11 modified files
 * whose mtimes were all 87 days old, on a branch tip 190 commits behind and
 * never merged. It was reported upward as the only live uncommitted work in the
 * fleet, and it was abandoned - and by then it had become a merge hazard,
 * because two of those files had since been changed on the trunk.
 *
 * Returns the NEWEST mtime across the dirty paths, plus how many were readable,
 * so a small "read" count is visible as thin evidence rather than passing for a
 * confident answer. Directories are stat'd as themselves: an untracked entry can
 * be a directory, and its own mtime is a fair proxy for when it last changed.
 */
function newestDirtyMtime(wt, paths) {
    let newest = 0, read = 0;
    for (const rel of paths) {
        try {
            const st = fs.statSync(path.join(wt, rel));
            read++;
            if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch { /* raced, permission-denied, or a path git names and disk does not */ }
    }
    return { newestMs: newest || null, read, total: paths.length };
}

/** Days-and-hours, in the same register as the rest of this report. */
function ageLabel(ms) {
    const h = (Date.now() - ms) / 3600000;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
    if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h';
    return Math.round(h / 24) + 'd';
}

/** Past this, a dirty tree is more likely derelict than in flight. */
const STALE_EDIT_DAYS = 30;

/**
 * How long since this clone last heard from the remote.
 *
 * Everything below is measured against origin refs AS LAST FETCHED. A clone that
 * has not fetched for a week will report commits as unpushed that somebody else
 * pushed days ago, so the number is only as current as this timestamp - which is
 * why it is printed beside it rather than left implicit.
 */
function fetchAgeMs(root) {
    for (const p of [path.join(root, '.git', 'FETCH_HEAD'), path.join(root, '.git')]) {
        try {
            const st = fs.statSync(p);
            if (st.isFile() && p.endsWith('FETCH_HEAD')) return Date.now() - st.mtimeMs;
        } catch { /* fall through */ }
    }
    return null;
}

function fetchAge(root) {
    const ms = fetchAgeMs(root);
    return ms === null ? 'UNKNOWN (no FETCH_HEAD)' : hours(ms) + 'h ago';
}

async function sectionWork(repos) {
    say(THIN);
    say('4. UNCOMMITTED AND UNPUSHED - what actually gets lost');
    say(THIN);

    if (!repos.length) {
        cantCheck('uncommitted work', 'no repos were discovered at all');
        say('');
        return;
    }

    const perRepo = await pool(repos, 4, async (repo) => {
        const wtOut = await run('git', ['-C', repo.root, 'worktree', 'list', '--porcelain'], { cwd: repo.root });
        if (!wtOut.ok) return { repo, error: 'worktree list: ' + wtOut.reason };
        const worktrees = [];
        for (const line of wtOut.stdout.split(/\r?\n/)) {
            if (line.startsWith('worktree ')) worktrees.push(path.normalize(line.slice(9).trim()));
        }
        if (!worktrees.length) worktrees.push(repo.root);

        const checked = await pool(worktrees, 8, async (wt) => {
            if (!isDir(wt)) return { wt, error: 'directory listed by git but not present on disk (pruned?)' };
            const st = await run('git', ['-C', wt, 'status', '--porcelain=v1', '--branch'], { cwd: wt });
            if (!st.ok) return { wt, error: st.reason };
            const s = parseStatus(st.stdout);

            // "ahead N" is ahead OF ITS UPSTREAM, and it is silent in the two cases
            // that lose work: a branch with no upstream at all, and a branch whose
            // upstream is not where the work belongs.
            //
            // Do not fix that by picking a base branch - measured on this machine,
            // one repo's origin/HEAD points at a feature branch, which turned "0
            // commits at risk" into "7" in one worktree and "2518" in another. Both
            // numbers were real and neither answered the question.
            //
            // ORIGIN REFS ARE THE ANSWER. A commit reachable from no origin ref
            // exists only here, and that is exactly what gets lost.
            const risk = await run('git', ['-C', wt, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], { cwd: wt });
            if (risk.ok) s.onlyLocal = Number(risk.stdout.trim());
            else { s.onlyLocal = null; s.riskNote = 'commits-at-risk count UNKNOWN: ' + risk.reason; }

            // A dirty count says nothing about WHEN. Stat the dirty paths so an
            // abandoned tree is distinguishable from one somebody is typing in.
            if (s.dirty > 0) s.edit = newestDirtyMtime(wt, dirtyPaths(st.stdout));

            return { wt, status: s };
        });
        return { repo, fetched: fetchAge(repo.root), checked };
    });

    let totalWt = 0, unreadable = 0, clean = 0, interesting = 0, repoErrors = 0, staleEdits = 0;
    const rendered = [];
    for (const r of perRepo) {
        if (!r) continue;
        if (r.error) { repoErrors++; rendered.push({ repo: r.repo, error: r.error }); continue; }
        const rows = [];
        for (const c of r.checked) {
            if (!c) continue;
            totalWt++;
            if (c.error) { unreadable++; rows.push({ wt: c.wt, error: c.error }); continue; }
            const s = c.status;
            const noteworthy = s.dirty > 0 || s.ahead > 0 || (s.onlyLocal || 0) > 0 || s.riskNote || s.conflicted > 0;
            if (noteworthy) {
                interesting++;
                if (s.edit && s.edit.newestMs !== null
                    && (Date.now() - s.edit.newestMs) / 86400000 >= STALE_EDIT_DAYS) staleEdits++;
                rows.push({ wt: c.wt, status: s });
            }
            else clean++;
        }
        rendered.push({ repo: r.repo, fetched: r.fetched, rows });
    }

    say('  population: ' + repos.length + ' repo(s), ' + repoErrors + ' whose worktree list failed, ' +
        totalWt + ' worktree(s) checked');
    say('              ' + interesting + ' carrying uncommitted or unpushed work, ' + clean +
        ' clean and pushed, ' + unreadable + ' UNREADABLE');
    say('              of those, ' + staleEdits + ' last edited over ' + STALE_EDIT_DAYS +
        'd ago - derelict rather than in flight');
    say('  "unreachable" = no origin ref holds this commit BY SHA, as of this');
    say('  last fetch of this clone. A stale fetch inflates it, so each repo prints its age.');
    say('');
    say('  THAT IS AN ANCESTRY CLAIM, NOT A CONTENT ONE, AND THE TWO DIVERGE HARD.');
    say('  After any history rewrite - a rebase, a squash-merge, a filter - the same');
    say('  diffs sit on origin under new SHAs, and every one of them is counted here.');
    say('  [measured 2026-08-24] a worktree reported 2518. 2378 of its non-merge');
    say('  commits were patch-id identical to commits already on the live trunk, and');
    say('  10 were genuinely stranded. The number was real and 250x the real answer.');
    say('');
    say('  Before treating a count here as lost work, ask git about CONTENT:');
    say('    git -C <worktree> cherry -v origin/HEAD HEAD');
    say('  Lines starting + are absent upstream. Lines starting - are the same change');
    say('  already up there under another SHA. Resolve origin/HEAD rather than assuming');
    say('  origin/main: one repo here has a main two months behind its real trunk.');
    say('');

    for (const r of rendered) {
        if (r.error) {
            say('  ' + r.repo.name);
            cantCheck('worktrees for ' + r.repo.name, r.error);
            say('');
            continue;
        }
        const dirtyRows = r.rows.filter((x) => x.status || x.error);
        say('  ' + r.repo.name + '   last fetch ' + r.fetched +
            '   ' + dirtyRows.length + ' worktree(s) needing attention');
        if (!dirtyRows.length) { say('    all clean and pushed. A real zero: every worktree was read.'); say(''); continue; }
        for (const row of dirtyRows) {
            const label = row.wt === r.repo.root ? '(main checkout)' : baseName(row.wt);
            if (row.error) {
                say('    ' + label);
                cantCheck('worktree ' + row.wt, row.error);
                continue;
            }
            const s = row.status;
            const bits = [];
            if (s.staged) bits.push(s.staged + ' staged');
            if (s.modified) bits.push(s.modified + ' modified');
            if (s.untracked) bits.push(s.untracked + ' untracked');
            if (s.conflicted) bits.push(s.conflicted + ' CONFLICTED');
            if (s.ahead) bits.push(s.ahead + ' ahead of upstream');
            if (s.behind) bits.push(s.behind + ' behind upstream');
            if (s.onlyLocal) bits.push(s.onlyLocal + ' commit(s) unreachable from any origin ref (CONTENT NOT CHECKED)');
            if (s.riskNote) bits.push(s.riskNote);
            if (s.edit) {
                if (s.edit.newestMs === null) {
                    bits.push('last edit UNKNOWN: 0 of ' + s.edit.total + ' dirty path(s) could be read');
                } else {
                    const days = (Date.now() - s.edit.newestMs) / 86400000;
                    const evidence = s.edit.read + ' of ' + s.edit.total + ' read';
                    bits.push('last edited ' + ageLabel(s.edit.newestMs) + ' ago (' + evidence + ')'
                        + (days >= STALE_EDIT_DAYS ? ' - LIKELY ABANDONED, not in flight' : ''));
                }
            }
            say('    ' + label + '  [' + (s.branch || '?') + (s.upstream ? ' -> ' + s.upstream : ' -> no upstream') + ']');
            say('        ' + (bits.length ? bits.join(', ') : 'nothing') + '');
            say('        ' + row.wt);
        }
        say('');
    }
}

// ---------------------------------------------------------------------------

async function main() {
    const started = Date.now();

    freshnessHeader();

    // scanFleet is synchronous and reads every recent transcript. Run it first so
    // the child processes below are not competing with it for the event loop.
    const loaded = loadFleet();
    const fleet = loaded.error ? { error: loaded.error } : (() => {
        try { return { data: loaded.scanFleet(DAYS) }; }
        catch (e) { return { error: 'scanFleet() threw: ' + (e && e.message ? e.message : String(e)) }; }
    })();

    const disco = await discoverRepos(fleet);

    sectionFleet(fleet);
    await sectionOwnership(fleet, disco.index);

    say(THIN);
    say('REPO SET - what sections 3 and 4 are about to cover');
    say(THIN);
    say('  population: ' + disco.repos.length + ' repo(s) discovered');
    say('  ' + disco.note);
    say('  session cwds resolved to a git root: ' + (disco.sessionDirsTried - disco.sessionDirsFailed) +
        ' of ' + disco.sessionDirsTried + (disco.sessionDirsFailed ? '  (' + disco.sessionDirsFailed + ' FAILED)' : ''));
    for (const f of disco.sessionDirFailures || []) say('     ? ' + f.dir + '  ->  ' + f.reason);
    say('  sorted: most recently worked on first, by newest commit on any ref');
    // THE SORT KEY IS CAPPED BY THE FETCH, AND THIS LIST IS A MENU.
    //
    // Section 4 already prints fetch age beside its counts, where a stale fetch
    // only INFLATES a number - and an inflated number invites a check. The same
    // staleness silently REORDERS these rows, which a reader clicks rather than
    // checks, so the identical measurement is far more dangerous here and was
    // printed only there.
    //
    // [measured 2026-08-29] a boot whose clones had not fetched for 45-69h
    // ordered four repos wrong. Project A was shown as 1.9d idle and had
    // committed 68 minutes earlier; Project B showed 1.9d against a real 9h.
    // The operator picks projects off this order.
    let anyStale = false;
    for (const r of disco.repos) {
        const age = r.lastCommit
            ? shortAge((Date.now() / 1000 - r.lastCommit) / 60) + ' since last commit'
            : 'last commit UNREADABLE';
        // Unsafe exactly when the clone has not heard from origin more recently
        // than the newest commit it can see: anything pushed inside that window
        // is invisible, so another repo could outrank this one and not show it.
        // An unknown fetch time is treated as the dangerous case, never as fine.
        const commitMs = r.lastCommit ? Date.now() - r.lastCommit * 1000 : null;
        const stale = r.fetchMs === null || commitMs === null || r.fetchMs > commitMs;
        if (stale) anyStale = true;
        const fetched = r.fetchMs === null
            ? 'fetch UNKNOWN'
            : 'fetched ' + shortAge(r.fetchMs / 60000) + ' ago';
        say('   - ' + r.name.padEnd(20) + ' ' + age.padEnd(28) +
            (stale ? '!! ' : '   ') + fetched.padEnd(20) + ' [' + r.how + ']   ' + r.root);
    }
    if (anyStale) {
        say('  !! ROWS MARKED !! ARE SORTED ON A STALE READ. The clone has not');
        say('     heard from origin since before the newest commit it can see, so');
        say('     work pushed inside that window is invisible and THIS ORDER MAY');
        say('     BE WRONG. Run `git fetch` in those clones and re-run before');
        say('     treating this list as a ranking or offering it as a choice.');
    }
    if ((disco.retired || []).length) {
        say('  RETIRED - excluded on purpose by config. This is a decision, not a gap:');
        for (const n of disco.retired) say('     ~ ' + n);
    }
    if (disco.missing.length) {
        say('  NOT COVERED - asked for but unusable:');
        for (const m of disco.missing) say('   ! ' + m.p + '   [' + m.how + ']  ' + (m.reason || 'not a directory'));
    }
    say('');

    await sectionPRs(disco.repos);
    await sectionWork(disco.repos);

    say(RULE);
    say('generated in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
    say('Every section above prints the population it scanned. Where one says COULD NOT');
    say('CHECK, that is not a zero - go and look before you act on its absence.');
    say(RULE);

    process.stdout.write(out.join('\n') + '\n');
}

main().then(() => process.exit(0), (e) => {
    // Reaching here means the harness itself broke, not a section. Say so loudly
    // rather than exiting quietly with a half-written report.
    process.stdout.write(out.join('\n') + '\n');
    process.stdout.write('\n!! brain-brief.js ABORTED: ' + (e && e.stack ? e.stack : String(e)) + '\n');
    process.stdout.write('!! Everything above may be incomplete. Treat it as unmeasured.\n');
    process.exit(0);
});
