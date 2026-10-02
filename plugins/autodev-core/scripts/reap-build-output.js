#!/usr/bin/env node
/**
 * reap-build-output.js - finds the `.next` build output that registered git
 * worktrees no longer use, and with --apply deletes it. A dry run is the
 * default: it lists every candidate with its size and the reason it is or is
 * not eligible, and deletes nothing.
 *
 * WHY. Every worktree of a Next.js product carries its own `.next`, often a
 * gigabyte or more, and a finished worktree keeps it until someone removes the
 * worktree. Deleting one under a running build or dev server turns that run red
 * with a missing-file error that reads like a product bug, so the reaper
 * deletes only what it can show nothing uses.
 *
 * A `.next` IS DELETED ONLY WHEN EVERY ONE OF THESE HOLDS:
 *   1. No lane lock or queued ticket of the machine's full gate names the
 *      worktree. A lock or ticket that does not say which worktree it is for,
 *      or cannot be read, names every worktree.
 *   2. No worktree lease (gate-records.js) covers it: a lease in any state but
 *      `released` covers it unless its execution is provably not running, and
 *      a lease file that cannot be read covers it.
 *   3. No running process has a command line or executable path containing the
 *      worktree's path. A process listing that cannot be read blocks every
 *      worktree. The reaper and the processes above it are left out, because
 *      their command lines carry the --repo paths.
 *   4. Nothing in a shallow scan of `.next` (the directory, its entries and
 *      theirs) was modified in the last 24 hours (--min-age-hours).
 *   5. `<worktree>/.next` is a real directory, not a junction or symlink, it
 *      resolves inside the worktree, and git tracks nothing under it.
 *   6. Holding the worktree's exclusion mutex (the one lease writers take),
 *      1 to 5 are checked again, and the rename of `.next` to a unique sibling
 *      succeeds. Windows refuses that rename while any file under it is open,
 *      so a failed rename means skip, never a delete in place.
 * Then the renamed sibling is deleted, outside the mutex. A sibling an earlier
 * run renamed aside but could not delete (`.next.reaped-*`) is deleted by the
 * next --apply. Nothing else is touched: never `node_modules`, never a `.next`
 * below the worktree's top level.
 *
 * FAILS OPEN. A check that cannot be answered skips the worktree and says why,
 * and an error in one worktree never stops the others. It is a command, not a
 * hook, so it always prints its summary.
 *
 *   node reap-build-output.js --repo <path> [--repo <path> ...] [--apply] [--json] [--min-age-hours N]
 *
 * Repositories come only from --repo; there is no default list. Each one's
 * registered worktrees come from `git worktree list --porcelain`.
 *
 * Exit: 0 the run completed (a dry run, or an --apply with no failed delete),
 * 1 an --apply where deleting a renamed-aside directory failed, 2 a usage
 * error or a run that could not start.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ident = require('./gate-identity.js');
const records = require('./gate-records.js');
const queue = require('./full-gate-queue.js');

const WIN = process.platform === 'win32';
const OUTPUT_DIRS = ['.next'];
const ASIDE_PREFIX = '.reaped-';
const DEFAULT_MIN_AGE_HOURS = 24;
const MAX_LANES = 8;
const TAG = '[reap-build-output]';

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const out = { repos: [], apply: false, json: false, help: false, minAgeHours: DEFAULT_MIN_AGE_HOURS, lock: null, error: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--repo' || a === '--lock' || a === '--min-age-hours') {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) { out.error = `${a} needs a value`; return out; }
            i++;
            if (a === '--repo') out.repos.push(v);
            else if (a === '--lock') out.lock = v;
            else {
                const n = Number(v);
                if (!Number.isFinite(n) || n < 1) { out.error = `--min-age-hours must be a number of hours, 1 or more (got ${v})`; return out; }
                out.minAgeHours = n;
            }
        } else if (a === '--apply') out.apply = true;
        else if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else { out.error = `unknown argument ${a}`; return out; }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Worktrees.
// ---------------------------------------------------------------------------

/** `git worktree list --porcelain` -> [{ path, bare, prunable }]. CRLF-safe. */
function parsePorcelain(text) {
    const out = [];
    let cur = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/\r$/, '');
        if (line.startsWith('worktree ')) { cur = { path: line.slice('worktree '.length), bare: false, prunable: false }; out.push(cur); }
        else if (cur && line === 'bare') cur.bare = true;
        else if (cur && (line === 'prunable' || line.startsWith('prunable '))) cur.prunable = true;
    }
    return out;
}

function git(dir, args) {
    try {
        const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        if (r.error) return { ok: false, out: '', why: `git could not run (${r.error.code || r.error.message})` };
        if (r.status !== 0) return { ok: false, out: r.stdout || '', why: `git ${args[0]} exited ${r.status}: ${String(r.stderr || '').trim().split(/\r?\n/)[0]}` };
        return { ok: true, out: r.stdout || '', why: null };
    } catch (e) { return { ok: false, out: '', why: `git threw (${e.message})` }; }
}

/** Every registered worktree of `repo`: { worktrees: [{ dir, canonical }], why }. */
function listWorktrees(repo) {
    if (!fs.existsSync(repo)) return { worktrees: [], why: `${repo} does not exist` };
    const r = git(repo, ['worktree', 'list', '--porcelain']);
    if (!r.ok) return { worktrees: [], why: r.why };
    const worktrees = [];
    for (const w of parsePorcelain(r.out)) {
        if (w.bare || w.prunable) continue;
        const dir = path.resolve(w.path);
        if (!fs.existsSync(dir)) continue;
        worktrees.push({ dir, canonical: ident.canonicalPath(dir) });
    }
    return { worktrees, why: null };
}

// ---------------------------------------------------------------------------
// The gate's records: lane locks, tickets, leases.
// ---------------------------------------------------------------------------

/**
 * Which worktrees the gate's locks and tickets name: { named: Set(canonical),
 * basenames: Set(lower-case name), blockAll: why|null, count }. A record with
 * a meta line names its repo's canonical worktree. A legacy record names a
 * basename through its description ("..., worktree NAME, ..."). A record that
 * says neither, or cannot be read, names every worktree.
 */
function gateClaims(base) {
    const out = { named: new Set(), basenames: new Set(), blockAll: null, count: 0 };
    const block = (why) => { out.blockAll = out.blockAll || why; };
    for (let k = 1; k <= MAX_LANES; k++) {
        const lockPath = queue.lanePath(base, k);
        const recs = [];
        try { const lock = records.readLaneLock(lockPath); if (lock) recs.push([lock, `lane ${k}'s lock`]); } catch (e) { block(`lane ${k}'s lock cannot be read (${e.code || e.message})`); }
        const qdir = queue.queueDirFor(lockPath);
        if (fs.existsSync(qdir)) {
            let names = [];
            try { names = fs.readdirSync(qdir).filter((n) => /\.ticket$/.test(n)); } catch (e) { block(`lane ${k}'s queue cannot be listed (${e.code || e.message})`); }
            const tickets = records.readTicketRecords(qdir);
            if (names.length > tickets.length) block(`lane ${k} has a ticket that cannot be read`);
            for (const t of tickets) recs.push([t, `ticket ${path.basename(t.file)}`]);
        }
        for (const [rec, label] of recs) {
            out.count++;
            if (rec.malformed) { block(`${label} has a meta line that cannot be read`); continue; }
            const wt = rec.meta && rec.meta.repo && typeof rec.meta.repo.worktree === 'string' ? rec.meta.repo.worktree : null;
            if (wt) { out.named.add(ident.canonicalPath(wt)); continue; }
            const m = /(?:^|,\s*)worktree ([^,]+)/.exec(rec.what || '');
            if (m) { out.basenames.add(m[1].trim().toLowerCase()); continue; }
            block(`${label} does not say which worktree it is for`);
        }
    }
    return out;
}

function claimedBy(claims, wt) {
    if (claims.blockAll) return claims.blockAll;
    if (claims.named.has(wt.canonical)) return 'a lane lock or ticket of the full gate names this worktree';
    if (claims.basenames.has(path.basename(wt.canonical).toLowerCase())) return 'a lane lock or ticket of the full gate names a worktree of this name';
    return null;
}

/**
 * Does a lease cover the worktree? A reason string when it does, else null.
 * A `released` lease covers nothing. Any other state covers it unless its
 * execution is provably not running.
 */
function leaseCovers(base, wt, judge) {
    const key = ident.pathKey(wt.canonical);
    const l = records.readLease(base, key);
    if (l.state === 'absent') return null;
    if (l.state !== 'ok') return `its lease ${key} cannot be read (${l.error})`;
    const v = l.value;
    if (v.state === 'released') return null;
    const fault = leaseFault(v);
    if (fault) return `its lease ${key} cannot be judged (${fault})`;
    const alive = judge(v);
    if (alive === false) return null;
    return `run ${v.runId} holds a lease on it (${v.state}, ${alive === true ? 'running' : 'not provably finished'})`;
}

const ISO7 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/;

/**
 * Why a lease's fields cannot be judged, or null. A creation time or boot id
 * of the wrong shape would otherwise read as "an earlier boot" or "a reused
 * pid", and a live owner would be judged finished.
 */
function leaseFault(v) {
    if (typeof v.state !== 'string') return 'its state is not a string';
    if (v.runId !== undefined && v.runId !== null && typeof v.runId !== 'string') return 'its run id is not a string';
    const o = v.owner;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return 'it names no owner';
    if (!Number.isInteger(o.pid) || o.pid <= 0) return 'its owner pid is not a pid';
    if (o.startUtc !== null && o.startUtc !== undefined && !(typeof o.startUtc === 'string' && ISO7.test(o.startUtc))) return 'its owner creation time is malformed';
    if (o.bootId !== null && o.bootId !== undefined && !(typeof o.bootId === 'string' && /^[^|]+\|\d{4}-\d\d-\d\dT\S+Z$/.test(o.bootId))) return 'its owner boot id is malformed';
    for (const k of ['msysPid', 'msysWinpid']) if (o[k] !== undefined && o[k] !== null && !(Number.isInteger(o[k]) && o[k] > 0)) return `its owner ${k} is not a pid`;
    return null;
}

/** A lease judge that takes a process snapshot only when a lease needs one. */
function leaseJudge(base, fresh) {
    let snap = null;
    return (v) => {
        if (!v || !v.owner || typeof v.owner !== 'object') return null;
        if (!snap) {
            if (fresh) { ident.forgetSnapshot(); ident.forgetMsys(); }
            snap = ident.snapshot({ maxAgeMs: fresh ? 0 : 30000 });
        }
        let execution = null;
        let journalUnreadable = false;
        if (v.runId) {
            const r = records.readRun(base, v.runId);
            if (r.state === 'ok') execution = r.value;
            else if (r.state === 'malformed') journalUnreadable = true;
        }
        try {
            return ident.judgeExecution({ owner: v.owner, execution, journalUnreadable, snap, boot: snap.ok ? snap.boot : null,
                msys: ident.msysTable(), legacyAlive: queue.isAlive }).alive;
        } catch { return null; }
    };
}

// ---------------------------------------------------------------------------
// Processes: which command lines name a worktree.
// ---------------------------------------------------------------------------

const WIN_PROCS = [
    '$p = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {',
    '  [pscustomobject]@{ i = $_.ProcessId; p = $_.ParentProcessId; c = $_.CommandLine; e = $_.ExecutablePath } })',
    'ConvertTo-Json -Compress -Depth 3 -InputObject $p',
].join('\n');

/**
 * Every process with its command line: { ok, procs: [{ pid, ppid, text }], why }.
 * AUTODEV_REAP_TEST_PROCS names a JSON file that replaces the probe: a list
 * of { pid, ppid, commandLine, executablePath }, or { unreadable: why }.
 */
function readProcesses(env = process.env) {
    try {
        let list;
        if (env.AUTODEV_REAP_TEST_PROCS) {
            const v = JSON.parse(fs.readFileSync(env.AUTODEV_REAP_TEST_PROCS, 'utf8'));
            if (!Array.isArray(v)) return { ok: false, procs: [], why: String((v && v.unreadable) || 'the planted process list is not a list') };
            list = v.map((p) => ({ pid: Number(p.pid), ppid: Number(p.ppid), text: `${p.commandLine || ''}\n${p.executablePath || ''}` }));
        } else if (WIN) {
            const r = ident.runPowerShell(WIN_PROCS);
            if (!r.ok) return { ok: false, procs: [], why: r.why };
            const parsed = JSON.parse(r.stdout);
            list = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: Number(p.i), ppid: Number(p.p), text: `${p.c || ''}\n${p.e || ''}` }));
        } else {
            const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
            if (r.error || r.status !== 0) return { ok: false, procs: [], why: `ps could not run (${r.error ? r.error.code : `exit ${r.status}`})` };
            list = [];
            for (const line of (r.stdout || '').split(/\r?\n/)) {
                const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
                if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), text: m[3] });
            }
        }
        if (!list.length) return { ok: false, procs: [], why: 'the process listing was empty' };
        return { ok: true, procs: list, why: null };
    } catch (e) {
        return { ok: false, procs: [], why: `the process listing could not be read (${e.message})` };
    }
}

const LAUNCHER_RE = /(?:^|[\s"'\\/])reap-build-output\.js(?:$|[\s"'])/i;

/**
 * The reaper, and the processes directly above it that are only launching it
 * (a shell running this script): their command lines carry the --repo paths.
 * The walk stops at the first ancestor that is anything else, so a dev server
 * that starts the reaper still protects its worktree.
 */
function selfAndLaunchers(procs) {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const out = new Set([process.pid]);
    let pid = process.ppid;
    while (Number.isInteger(pid) && pid > 0 && !out.has(pid)) {
        const p = byPid.get(pid);
        if (!p || !LAUNCHER_RE.test(p.text)) break;
        out.add(pid);
        pid = p.ppid;
    }
    return out;
}

/**
 * A command line can name a path by its 8.3 alias (C:\PROGRA~1\...), which no
 * spelling of the canonical path contains. Each path-like token holding `~N`
 * is cut back to its longest existing prefix and expanded; the expansions are
 * appended to the text that is searched.
 */
function expandShortPaths(text) {
    const out = [];
    for (const m of text.match(/[a-z]:[\\/][^"'\s]*~\d[^"'\s]*/gi) || []) {
        let p = m;
        for (;;) {
            if (fs.existsSync(p)) { out.push(ident.canonicalPath(p)); break; }
            const up = path.dirname(p);
            if (up === p) break;
            p = up;
        }
    }
    return out.length ? `${text}\n${out.join('\n')}` : text;
}

/** The spellings a command line may use for a canonical path, lower-cased on Windows. */
function pathSpellings(canonical) {
    if (!WIN) return [canonical];
    const back = canonical.toLowerCase();
    const fwd = back.split('\\').join('/');
    const out = [back, fwd];
    const m = /^([a-z]):\/(.*)$/.exec(fwd);
    if (m) out.push(`/${m[1]}/${m[2]}`);
    return out;
}

/** A reason string when a process names the worktree, else null. */
function processUses(procs, wt) {
    if (!procs.ok) return `running processes cannot be listed (${procs.why})`;
    const spellings = pathSpellings(wt.canonical);
    for (const p of procs.procs) {
        if (procs.exclude && procs.exclude.has(p.pid)) continue;
        if (WIN && p.hay === undefined) p.hay = (p.text.includes('~') ? expandShortPaths(p.text) : p.text).toLowerCase();
        const hay = WIN ? p.hay : p.text;
        if (spellings.some((s) => hay.includes(s))) return `pid ${p.pid} runs with this worktree's path in its command line`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// The directory itself.
// ---------------------------------------------------------------------------

/** Logical bytes and file count under `dir`, never following a link. */
function measure(dir) {
    let bytes = 0;
    let files = 0;
    try { if (fs.lstatSync(dir).isSymbolicLink()) return { bytes, files }; } catch { return { bytes, files }; }
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            try { bytes += fs.lstatSync(p).size; files++; } catch { /* gone */ }
        }
    }
    return { bytes, files };
}

/** The newest mtime in `dir`, its entries and theirs: { newestMs, why }. */
function newestShallow(dir) {
    let newest = 0;
    const visit = (p, depth) => {
        const st = fs.lstatSync(p);
        newest = Math.max(newest, st.mtimeMs);
        if (depth >= 2 || !st.isDirectory()) return;
        for (const name of fs.readdirSync(p)) visit(path.join(p, name), depth + 1);
    };
    try { visit(dir, 0); } catch (e) { return { newestMs: null, why: `its modification times cannot be read (${e.code || e.message})` }; }
    return { newestMs: newest, why: null };
}

/** Why `<worktree>/<name>` is not a real, untracked directory of the worktree, or null. */
function shapeFault(wt, target, name) {
    let st;
    try { st = fs.lstatSync(target); } catch (e) { return e.code === 'ENOENT' ? 'it is gone' : `it cannot be read (${e.code})`; }
    if (st.isSymbolicLink()) return 'it is a junction or symlink, not a directory of this worktree';
    if (!st.isDirectory()) return 'it is not a directory';
    // Compared with the worktree's canonical path taken when git listed it, not
    // with a second resolution of the same path: a worktree directory swapped
    // for a junction since then resolves both sides to the same elsewhere.
    let real;
    try { real = ident.canonicalPath(fs.realpathSync.native(target)); } catch (e) { return `its real path cannot be read (${e.code})`; }
    if (real !== path.join(wt.canonical, WIN ? name.toLowerCase() : name)) return `it resolves outside the worktree (${real})`;
    const tracked = git(wt.dir, ['ls-files', '-z', '--', name]);
    if (!tracked.ok) return `git cannot say whether it is tracked (${tracked.why})`;
    if (tracked.out.length) return 'git tracks files under it';
    return null;
}

// ---------------------------------------------------------------------------
// Assessment.
// ---------------------------------------------------------------------------

/** Every reason the candidate is not eligible now; empty when it is. */
function blockers(ctx, wt, c) {
    const out = [];
    const shape = shapeFault(wt, c.path, c.name);
    if (shape) out.push(shape);
    if (c.kind === 'leftover') return out;
    const claim = claimedBy(ctx.claims, wt);
    if (claim) out.push(claim);
    const lease = leaseCovers(ctx.base, wt, ctx.judge);
    if (lease) out.push(lease);
    const proc = processUses(ctx.procs, wt);
    if (proc) out.push(proc);
    if (!shape) {
        const n = newestShallow(c.path);
        if (n.why) out.push(n.why);
        else if (n.newestMs > ctx.nowMs - ctx.minAgeMs) out.push(`something in it was modified ${new Date(n.newestMs).toISOString()}, within the last ${ctx.minAgeHours} hours`);
    }
    return out;
}

/** The candidates in one worktree: each output directory, and siblings a failed delete left. */
function candidatesIn(wt) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(wt.dir); } catch { return out; }
    for (const name of OUTPUT_DIRS) {
        if (names.includes(name)) out.push({ kind: 'output', name, path: path.join(wt.dir, name) });
        // Only the exact name renameAside writes counts as left by this script:
        // a `.next.reaped-backup` someone made by hand is not ours to delete.
        const ours = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${ASIDE_PREFIX}\\d{8}T\\d{9}Z-\\d+-[a-z0-9]{1,6}$`);
        for (const n of names) if (ours.test(n)) out.push({ kind: 'leftover', name: n, path: path.join(wt.dir, n) });
    }
    return out;
}

function context(base, minAgeHours, env, fresh) {
    const procs = readProcesses(env);
    if (procs.ok) procs.exclude = selfAndLaunchers(procs.procs);
    return { base, claims: gateClaims(base), judge: leaseJudge(base, fresh), procs, nowMs: Date.now(), minAgeMs: minAgeHours * 3600000, minAgeHours };
}

function assess({ repos, base, minAgeHours = DEFAULT_MIN_AGE_HOURS, env = process.env }) {
    const ctx = context(base, minAgeHours, env, false);
    const report = { repos: [], candidates: [] };
    const seen = new Set();
    for (const repo of repos) {
        const l = listWorktrees(path.resolve(repo));
        report.repos.push({ repo, worktrees: l.worktrees.length, why: l.why });
        for (const wt of l.worktrees) {
            if (seen.has(wt.canonical)) continue;
            seen.add(wt.canonical);
            for (const c of candidatesIn(wt)) {
                const size = measure(c.path);
                let reasons;
                try { reasons = blockers(ctx, wt, c); } catch (e) { reasons = [`the checks threw (${e.message})`]; }
                report.candidates.push({ repo, worktree: wt.dir, canonical: wt.canonical, kind: c.kind, name: c.name, path: c.path,
                    bytes: size.bytes, files: size.files, eligible: reasons.length === 0, reasons });
            }
        }
    }
    return report;
}

// ---------------------------------------------------------------------------
// Applying.
// ---------------------------------------------------------------------------

function freeBytes(dir) {
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

/** The test seam's pause between assessing and applying: writes `assessed`, waits for `go`. */
function handshake(env) {
    const dir = env.AUTODEV_REAP_TEST_HANDSHAKE;
    if (!dir) return;
    fs.writeFileSync(path.join(dir, 'assessed'), `${process.pid}\n`);
    const until = Date.now() + 30000;
    while (!fs.existsSync(path.join(dir, 'go')) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}

/**
 * Renames one eligible output directory aside inside the worktree's mutex,
 * after checking every condition again with fresh probes. { aside, why }.
 */
function renameAside(base, cand, env, minAgeHours) {
    const wt = { dir: cand.worktree, canonical: cand.canonical };
    const key = ident.pathKey(wt.canonical);
    const timeoutMs = Number(env.AUTODEV_REAP_MUTEX_TIMEOUT_MS) > 0 ? Number(env.AUTODEV_REAP_MUTEX_TIMEOUT_MS) : 10000;
    try {
        return records.withWorktreeMutex(base, key, () => {
            const again = blockers(context(base, minAgeHours, env, true), wt, cand);
            if (again.length) return { aside: null, why: `no longer eligible: ${again.join('; ')}` };
            const stamp = new Date().toISOString().replace(/[-:.]/g, '');
            const aside = path.join(wt.dir, `${cand.name}${ASIDE_PREFIX}${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
            try { fs.renameSync(cand.path, aside); } catch (e) {
                return { aside: null, why: `the rename aside failed (${e.code || e.message}), so something may have it open; skipped` };
            }
            return { aside, why: null };
        }, { timeoutMs, isDead: (p) => queue.isAlive(p) === false });
    } catch (e) {
        return { aside: null, why: `the worktree mutex could not be taken (${e.message}); skipped` };
    }
}

/** Deletes a renamed-aside directory. { removedBytes, why }. */
function deleteAside(aside, env) {
    const before = measure(aside).bytes;
    try {
        if (env.AUTODEV_REAP_TEST_FAIL_DELETE) {
            // The test seam: a delete that removes one file, then fails.
            const stack = [aside];
            while (stack.length) {
                const d = stack.pop();
                const ents = fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1));
                const file = ents.find((e) => !e.isDirectory());
                if (file) { fs.unlinkSync(path.join(d, file.name)); break; }
                for (const e of ents) stack.push(path.join(d, e.name));
            }
            throw Object.assign(new Error('a planted delete failure'), { code: 'EPLANTED' });
        }
        fs.rmSync(aside, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        return { removedBytes: before, why: null };
    } catch (e) {
        const left = fs.existsSync(aside) ? measure(aside).bytes : 0;
        return { removedBytes: Math.max(0, before - left), why: `the delete of ${aside} failed (${e.code || e.message}); ${left} bytes remain there` };
    }
}

function apply(report, { base, minAgeHours = DEFAULT_MIN_AGE_HOURS, env = process.env }) {
    const result = { completed: [], skipped: [], failures: [], removedBytes: 0, volumes: {} };
    const eligible = report.candidates.filter((c) => c.eligible);
    for (const c of eligible) {
        const v = WIN ? path.parse(c.worktree).root.toLowerCase() : c.worktree;
        if (!(v in result.volumes)) result.volumes[v] = { before: freeBytes(c.worktree), after: null, probe: c.worktree };
    }
    handshake(env);
    for (const c of eligible) {
        let aside = c.path;
        if (c.kind === 'output') {
            const r = renameAside(base, c, env, minAgeHours);
            if (!r.aside) { result.skipped.push({ path: c.path, why: r.why }); continue; }
            aside = r.aside;
        }
        const d = deleteAside(aside, env);
        result.removedBytes += d.removedBytes;
        if (d.why) result.failures.push({ path: c.path, aside, removedBytes: d.removedBytes, why: d.why });
        else result.completed.push({ path: c.path, aside, removedBytes: d.removedBytes });
    }
    for (const v of Object.values(result.volumes)) v.after = freeBytes(v.probe);
    return result;
}

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

function human(n) {
    if (!Number.isFinite(n)) return 'unknown';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

const USAGE = [
    'usage: node reap-build-output.js --repo <path> [--repo <path> ...] [--apply] [--json] [--min-age-hours N] [--lock <full-gate.lock>]',
    '',
    'Lists the .next directory of every registered worktree of each repo, with its',
    'size and why it is or is not safe to delete. A dry run by default; --apply',
    'renames each eligible one aside and deletes it. Never node_modules.',
    'Exit 0 done, 1 an --apply delete failed, 2 usage or could not start.',
].join('\n');

function main(argv = process.argv.slice(2), env = process.env) {
    const args = parseArgs(argv);
    if (args.help) { console.log(USAGE); return; }
    if (args.error || !args.repos.length) {
        console.error(`${TAG} ${args.error || 'no --repo given; there is no default list'}`);
        console.error(USAGE);
        process.exitCode = 2;
        return;
    }
    const base = path.resolve(args.lock || env.AUTODEV_GATE_LOCK_PATH || queue.defaultLockPath());
    const report = assess({ repos: args.repos, base, minAgeHours: args.minAgeHours, env });
    const result = args.apply ? apply(report, { base, minAgeHours: args.minAgeHours, env }) : null;
    const eligible = report.candidates.filter((c) => c.eligible);
    const summary = {
        mode: args.apply ? 'apply' : 'dry-run',
        repos: report.repos,
        candidates: report.candidates.length,
        eligible: eligible.length,
        eligibleBytes: eligible.reduce((s, c) => s + c.bytes, 0),
        completed: result ? result.completed.length : 0,
        removedBytes: result ? result.removedBytes : 0,
        skippedAtApply: result ? result.skipped : [],
        failures: result ? result.failures : [],
        volumes: result ? result.volumes : {},
    };
    if (args.json) console.log(JSON.stringify({ summary, candidates: report.candidates, completed: result ? result.completed : [] }, null, 2));
    else {
        for (const r of report.repos) console.log(`${TAG} repo ${r.repo}: ${r.why ? `not read (${r.why})` : `${r.worktrees} worktree(s)`}`);
        for (const c of report.candidates) {
            console.log(`${TAG} ${c.eligible ? 'ELIGIBLE' : 'keep    '} ${human(c.bytes).padStart(9)}  ${c.path}${c.kind === 'leftover' ? ' (renamed aside by an earlier run)' : ''}`);
            for (const why of c.reasons) console.log(`${TAG}            ${why}`);
        }
        console.log(`${TAG} ${summary.mode}: ${summary.candidates} candidate(s), ${summary.eligible} eligible, ${human(summary.eligibleBytes)} logical`);
        if (result) {
            console.log(`${TAG} deleted ${summary.completed}, logical bytes removed ${summary.removedBytes} (${human(summary.removedBytes)})`);
            for (const s of result.skipped) console.log(`${TAG} skipped at apply: ${s.path}: ${s.why}`);
            for (const f of result.failures) console.log(`${TAG} FAILED: ${f.path}: ${f.why}`);
            for (const [v, b] of Object.entries(result.volumes)) console.log(`${TAG} volume ${v}: free ${human(b.before)} before, ${human(b.after)} after`);
        } else console.log(`${TAG} dry run: nothing deleted; --apply deletes the eligible ones`);
    }
    if (result && result.failures.length) process.exitCode = 1;
}

module.exports = {
    parseArgs, parsePorcelain, listWorktrees, gateClaims, leaseCovers, readProcesses, processUses, pathSpellings,
    newestShallow, shapeFault, measure, assess, apply, main, leaseFault, expandShortPaths,
};

if (require.main === module) {
    try { main(); } catch (e) {
        console.error(`${TAG} could not run: ${e.message}; nothing further was deleted`);
        process.exitCode = 2;
    }
}
