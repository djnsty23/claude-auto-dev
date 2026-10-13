#!/usr/bin/env node
/**
 * lifecycle.js - capacity lifecycle and working retention: what a machine's
 * disk holds, what may go, and proof that the daily pass ran. `plan` (the
 * default) is a dry run that removes nothing. `apply` does what the plan says.
 *
 *   node lifecycle.js plan     [--config FILE] [--json]
 *   node lifecycle.js apply    [--config FILE] [--json]
 *   node lifecycle.js snapshot [--config FILE] [--json]
 *   node lifecycle.js record   --worktree DIR --owner WHO --task WHAT [--lease-hours N] [--config FILE]
 *   node lifecycle.js touch    --worktree DIR [--config FILE]
 *   node lifecycle.js restore  --worktree DIR [--config FILE]
 *   node lifecycle.js check-receipt [--max-age-hours N] [--config FILE] [--json]
 *
 * WHY. Disk filled while every cleanup reported success. [measured 2026-10-13]
 * one machine lost its free space to a 32 GB GPU crash dump in the kernel
 * report directory and about 24 GB of driver shader cache. A cleanup that
 * deletes whatever is big would have deleted the dump (evidence) and a cache
 * the driver rebuilds at once. A cleanup that sums sizes would have reported
 * the wrong cause, because pagefile growth and hardlinked installs move the
 * volume without moving any folder's logical size.
 *
 * SNAPSHOTS. Each configured root is walked with a time and entry budget and
 * recorded as: logical bytes, allocated bytes (where the platform reports
 * blocks), hardlink duplication (bytes reached through a second link to an
 * inode already counted), links not followed, and scan coverage. A root
 * nested in another root is skipped by the parent's walk, so no byte is
 * counted twice and the total is a plain sum. Logical and allocated are never
 * substituted for each other: attribution is on logical bytes, and says so.
 * Each snapshot also records volume usage and the pagefile size, and
 * `reconcile` splits a volume change into the part the roots explain, the
 * pagefile's part, and the residual nothing measured explains.
 *
 * SCRATCH RETENTION. Each top-level entry of a configured scratch root is one
 * unit. A unit whose newest write is older than 7 days is eligible and is
 * removed by `apply`. A unit is KEPT when it holds a protected class, when its
 * scan was incomplete, or when it is newer than the window. A unit holding
 * UNRESOLVED evidence (a `.autodev-evidence.json` whose `resolved` is not
 * true) is never silently discarded: `apply` archives it first, under capacity
 * admission, reads the archive back, and only then removes the source. When
 * admission refuses, it stays. Eligible scratch over 8 GiB in total sets an
 * overflow flag with bounded diagnostics (the ten largest units), and
 * `scratchAdmission()` refuses new producers until a pass brings the total
 * back under the cap. `capStream()` holds one attempt's streamed output to
 * 128 MiB and stops the producer at the cap, keeping a bounded tail.
 *
 * NEVER DELETED, whatever their age or size: the pagefile, swapfile and
 * hibernation file, kernel crash reports and dumps, GPU shader caches,
 * session transcripts, active vendor caches (browser builds, package stores)
 * and the system directory. They are measured and reported. The one deletion
 * function, `removeUnit()`, refuses them even when the plan is wrong.
 *
 * WORKTREES. A worktree carries a record: owner, lease, task, branch and last
 * use (`record`, `touch`). It is removed only when worktree-reap.js finds its
 * work landed, its tree clean and nobody using it, AND its record exists,
 * names the same branch, has no live lease and no use inside the idle window,
 * AND it holds no junction or symlink, no hardlinked file and no shared
 * install, AND its branch still points at its HEAD so `restore` can bring it
 * back. Every removal writes an intent to a journal first. An intent with no
 * outcome (an interrupted pass) is resolved at the start of the next pass:
 * an absent target is recorded as done, a present one is judged afresh.
 *
 * RECEIPT. `apply` writes a daily receipt. `check-receipt` exits 1 when it is
 * missing, unreadable or older than 26 hours. It reads one file and nothing
 * else, so any hook or session can run it without a coordinator. This script
 * installs no scheduled task: the operator schedules `lifecycle.js apply`.
 *
 * CONFIG (JSON, from --config, AUTODEV_LIFECYCLE_CONFIG, or
 * <home>/.claude/autodev/lifecycle/config.json; every key optional):
 *   { "stateDir", "roots": [dir], "scratchRoots": [dir], "repos": [main checkout],
 *     "archiveDir", "reportPaths": [path], "retentionDays", "scratchCapBytes",
 *     "streamCapBytes", "idleHours", "receiptMaxAgeHours", "fetch": bool,
 *     "scanBudgetMs", "scanMaxEntries" }
 * TEST SEAMS: AUTODEV_LIFECYCLE_VOLUME_FILE (JSON { usedBytes, totalBytes }),
 * AUTODEV_LIFECYCLE_PAGEFILE_BYTES (a number, or "unknown").
 *
 * Exit: 0 done, 1 a removal failed or the receipt is overdue, 2 a usage error.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const DAY_MS = 24 * 3600000;
const RETENTION_DAYS = 7;
const SCRATCH_CAP_BYTES = 8 * GIB;
const STREAM_CAP_BYTES = 128 * MIB;
const IDLE_HOURS = 24;
const RECEIPT_MAX_AGE_HOURS = 26;
const SCAN_BUDGET_MS = 20000;
const SCAN_MAX_ENTRIES = 400000;
const SNAPSHOTS_KEPT = 60;
const JOURNAL_KEPT = 500;
const DIAG_TAIL_BYTES = 4096;
const EVIDENCE_MARKER = '.autodev-evidence.json';
const TAG = '[lifecycle]';

// ---------------------------------------------------------------------------
// Protected classes. Matched on the path with forward slashes, lower case.
// ---------------------------------------------------------------------------

const PROTECTED = [
    ['pagefile', /(^|\/)(pagefile|swapfile|hiberfil)\.sys$/],
    ['kernel-dumps', /(^|\/)(livekernelreports|minidump)(\/|$)/],
    ['kernel-dumps', /(^|\/)memory\.dmp$/],
    ['shader-cache', /(^|\/)nvidia\/(dxcache|glcache|computecache|nv_cache)(\/|$)/],
    ['shader-cache', /(^|\/)amd\/(dxcache|dxccache|glcache|vkcache)(\/|$)/],
    ['shader-cache', /(^|\/)(d3dscache|nv_cache)(\/|$)/],
    ['shader-cache', /(^|\/)shadercache(\/|$)/],
    ['transcripts', /(^|\/)\.claude[^/]*\/projects(\/|$)/],
    ['vendor-cache', /(^|\/)(ms-playwright|npm-cache|\.pnpm-store|puppeteer)(\/|$)/],
    ['vendor-cache', /(^|\/)pnpm\/store(\/|$)/],
    ['vendor-cache', /(^|\/)yarn\/(berry\/)?cache(\/|$)/],
    ['system', /^[a-z]:\/windows(\/|$)/],
];

const slash = (p) => String(p).replace(/\\/g, '/').toLowerCase();

/** The protected class a path belongs to, or null. */
function protectedClass(p) {
    const s = slash(path.resolve(p));
    for (const [cls, re] of PROTECTED) if (re.test(s)) return cls;
    return null;
}

// ---------------------------------------------------------------------------
// Config and state.
// ---------------------------------------------------------------------------

function defaultStateDir(env = process.env) {
    return path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude', 'autodev', 'lifecycle');
}

/** Paths reported (never deleted) when the config names none: the platform's known heavy, protected places. */
function defaultReportPaths(env = process.env, platform = process.platform) {
    if (platform !== 'win32') return [];
    const out = [];
    const sys = env.SystemRoot || env.windir;
    if (sys) out.push(path.join(sys, 'LiveKernelReports'), path.join(sys, 'Minidump'));
    const local = env.LOCALAPPDATA;
    if (local) {
        for (const p of [['NVIDIA', 'DXCache'], ['NVIDIA', 'GLCache'], ['D3DSCache'], ['AMD', 'DxCache'], ['ms-playwright'], ['npm-cache']]) out.push(path.join(local, ...p));
    }
    return out;
}

/** { config, why }. A config that exists and does not parse is a usage error, never a default. */
function loadConfig(file, env = process.env) {
    const f = file || env.AUTODEV_LIFECYCLE_CONFIG || path.join(defaultStateDir(env), 'config.json');
    let c = {};
    try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT' || file || env.AUTODEV_LIFECYCLE_CONFIG) return { config: null, why: `the config ${f} cannot be read (${e.code || e.message})` };
    }
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { config: null, why: `the config ${f} is not an object` };
    const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).map((x) => path.resolve(x)) : []);
    const stateDir = path.resolve(c.stateDir || defaultStateDir(env));
    return {
        why: null,
        config: {
            file: f, stateDir,
            roots: list(c.roots), scratchRoots: list(c.scratchRoots), repos: list(c.repos),
            archiveDir: path.resolve(c.archiveDir || path.join(stateDir, 'archives')),
            reportPaths: Array.isArray(c.reportPaths) ? list(c.reportPaths) : defaultReportPaths(env),
            retentionDays: n(c.retentionDays, RETENTION_DAYS),
            scratchCapBytes: n(c.scratchCapBytes, SCRATCH_CAP_BYTES),
            streamCapBytes: n(c.streamCapBytes, STREAM_CAP_BYTES),
            idleHours: n(c.idleHours, IDLE_HOURS),
            receiptMaxAgeHours: n(c.receiptMaxAgeHours, RECEIPT_MAX_AGE_HOURS),
            fetch: c.fetch !== false,
            scanBudgetMs: n(c.scanBudgetMs, SCAN_BUDGET_MS),
            scanMaxEntries: n(c.scanMaxEntries, SCAN_MAX_ENTRIES),
        },
    };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function writeJson(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

/** Appends JSON lines and keeps only the newest `keep`. */
function appendBounded(file, items, keep) {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { /* first write */ }
    lines.push(...items.map((x) => JSON.stringify(x)));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.slice(-keep).join('\n') + '\n');
}

function readLines(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const l of text.split('\n').filter(Boolean)) { try { out.push(JSON.parse(l)); } catch { /* a torn line */ } }
    return out;
}

const canon = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* absent: the resolved spelling */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
};

// ---------------------------------------------------------------------------
// The bounded walk. Never follows a link. Never throws.
// ---------------------------------------------------------------------------

function finish(m) { if (!m.allocatedMeasurable) m.allocatedBytes = null; return m; }

/**
 * Walks `root`, skipping every path in `skip` (canonical) and every entry
 * named in `skipNames`. Returns { logicalBytes, allocatedBytes,
 * allocatedMeasurable, duplicateBytes, files, links, linkPaths, hardlinked,
 * newestMs, protectedHits, coverage: { entries, unreadable, truncated, complete } }.
 * `seenInodes` is shared across calls so a hardlink reached from two roots counts once.
 */
function measure(root, { deadline = Date.now() + SCAN_BUDGET_MS, maxEntries = SCAN_MAX_ENTRIES, skip = new Set(), seenInodes = new Map(), skipNames = new Set() } = {}) {
    const m = { logicalBytes: 0, allocatedBytes: 0, allocatedMeasurable: true, duplicateBytes: 0, files: 0, links: 0, linkPaths: [], hardlinked: [],
        newestMs: 0, protectedHits: [], coverage: { entries: 0, unreadable: 0, truncated: null, complete: false } };
    let st;
    try { st = fs.lstatSync(root, { bigint: true }); } catch (e) { m.coverage.truncated = `unreadable root (${e.code || e.message})`; m.coverage.unreadable++; return finish(m); }
    const visit = (full, s) => {
        m.coverage.entries++;
        const mt = Number(s.mtimeMs);
        if (mt > m.newestMs) m.newestMs = mt;
        const cls = protectedClass(full);
        if (cls && !m.protectedHits.some((h) => h.cls === cls)) m.protectedHits.push({ cls, path: full });
        if (s.isSymbolicLink()) { m.links++; if (m.linkPaths.length < 20) m.linkPaths.push(full); return false; }
        if (s.isDirectory()) return true;
        m.files++;
        const size = Number(s.size);
        if (s.nlink > 1n) {
            const key = `${s.dev}:${s.ino}`;
            if (m.hardlinked.length < 20) m.hardlinked.push(full);
            if (seenInodes.has(key)) { m.duplicateBytes += size; m.logicalBytes += size; return false; }
            seenInodes.set(key, true);
        }
        m.logicalBytes += size;
        if (s.blocks === undefined || s.blocks === null) m.allocatedMeasurable = false;
        else m.allocatedBytes += Number(s.blocks) * 512;
        return false;
    };
    if (!visit(root, st)) { m.coverage.complete = true; return finish(m); }
    const stack = [root];
    while (stack.length) {
        if (Date.now() > deadline) { m.coverage.truncated = 'time budget reached'; break; }
        if (m.coverage.entries > maxEntries) { m.coverage.truncated = 'entry cap reached'; break; }
        const dir = stack.pop();
        let names;
        try { names = fs.readdirSync(dir); } catch { m.coverage.unreadable++; continue; }
        for (const name of names) {
            if (skipNames.has(name)) continue;
            const full = path.join(dir, name);
            if (skip.size && skip.has(canon(full))) continue;
            let s;
            try { s = fs.lstatSync(full, { bigint: true }); } catch { m.coverage.unreadable++; continue; }
            if (visit(full, s)) stack.push(full);
        }
    }
    m.coverage.complete = !m.coverage.truncated && m.coverage.unreadable === 0;
    return finish(m);
}

// ---------------------------------------------------------------------------
// Snapshots.
// ---------------------------------------------------------------------------

function probeVolume(dir, env = process.env) {
    if (env.AUTODEV_LIFECYCLE_VOLUME_FILE) {
        const v = readJson(env.AUTODEV_LIFECYCLE_VOLUME_FILE);
        return v && Number.isFinite(v.usedBytes) ? { usedBytes: v.usedBytes, totalBytes: v.totalBytes ?? null, why: null } : { usedBytes: null, totalBytes: null, why: 'the volume fixture is unreadable' };
    }
    try {
        let d = path.resolve(dir);
        while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
        const s = fs.statfsSync(d);
        const total = Number(s.blocks) * Number(s.bsize);
        return { usedBytes: total - Number(s.bfree) * Number(s.bsize), totalBytes: total, why: null };
    } catch (e) { return { usedBytes: null, totalBytes: null, why: `statfs failed (${e.code || e.message})` }; }
}

/** The pagefile's allocated size in bytes, or null with a reason. Windows only; elsewhere it is not measured. */
function probePagefile(env = process.env, platform = process.platform) {
    if (env.AUTODEV_LIFECYCLE_PAGEFILE_BYTES !== undefined) {
        const n = Number(env.AUTODEV_LIFECYCLE_PAGEFILE_BYTES);
        return env.AUTODEV_LIFECYCLE_PAGEFILE_BYTES !== '' && Number.isFinite(n) && n >= 0 ? { bytes: n, why: null } : { bytes: null, why: 'the pagefile fixture says unknown' };
    }
    if (platform !== 'win32') return { bytes: null, why: 'no pagefile probe on this platform' };
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance -ClassName Win32_PageFileUsage -ErrorAction Stop | Measure-Object -Property AllocatedBaseSize -Sum).Sum'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const s = String(r.stdout || '').trim();
    if (r.error || r.status !== 0 || !/^\d+$/.test(s)) return { bytes: null, why: `Win32_PageFileUsage could not be read (${r.error ? r.error.code : `exit ${r.status}`})` };
    return { bytes: Number(s) * MIB, why: null };
}

/** One bounded snapshot of every root. A nested root is skipped by its parent, so the total is a plain sum. */
function snapshot(config, { env = process.env, now = Date.now } = {}) {
    const roots = [...new Set(config.roots)];
    const canonRoots = roots.map(canon);
    const deadline = now() + config.scanBudgetMs;
    const seenInodes = new Map();
    const out = { takenUtc: new Date(now()).toISOString(), roots: [], totals: null, volume: null, pagefile: null, complete: true };
    roots.forEach((root, i) => {
        const nested = canonRoots.filter((c, j) => j !== i && c.startsWith(canonRoots[i] + path.sep));
        const parent = roots.find((r, j) => j !== i && canonRoots[i].startsWith(canonRoots[j] + path.sep)) || null;
        const m = measure(root, { deadline, maxEntries: config.scanMaxEntries, skip: new Set(nested), seenInodes });
        out.roots.push({ root, nestedIn: parent, skippedNested: nested.length, logicalBytes: m.logicalBytes, allocatedBytes: m.allocatedBytes,
            duplicateBytes: m.duplicateBytes, files: m.files, linksNotFollowed: m.links, protected: m.protectedHits.map((h) => h.cls), coverage: m.coverage });
        if (!m.coverage.complete) out.complete = false;
    });
    const sum = (k) => out.roots.reduce((s, r) => s + (r[k] || 0), 0);
    out.totals = { logicalBytes: sum('logicalBytes'), uniqueLogicalBytes: sum('logicalBytes') - sum('duplicateBytes'),
        allocatedBytes: out.roots.every((r) => r.allocatedBytes !== null) ? sum('allocatedBytes') : null, duplicateBytes: sum('duplicateBytes'),
        basis: 'logical bytes; allocated is reported beside it and never substituted' };
    out.volume = probeVolume(roots[0] || config.stateDir, env);
    out.pagefile = probePagefile(env);
    return out;
}

/**
 * Splits the volume change between two snapshots: what the roots explain (on
 * unique logical bytes), what the pagefile explains, and the residual nothing
 * measured explains. A root present in only one snapshot is not attributed.
 */
function reconcile(prev, cur) {
    const out = { volumeDeltaBytes: null, attributedBytes: 0, pagefileDeltaBytes: null, residualBytes: null, perRoot: [], basis: 'logical', complete: Boolean(prev.complete && cur.complete), why: [] };
    for (const r of cur.roots) {
        const p = prev.roots.find((x) => x.root === r.root);
        if (!p) { out.why.push(`${r.root} is new in this snapshot`); continue; }
        const d = (r.logicalBytes - r.duplicateBytes) - (p.logicalBytes - p.duplicateBytes);
        out.perRoot.push({ root: r.root, deltaBytes: d });
        out.attributedBytes += d;
    }
    if (prev.pagefile && cur.pagefile && prev.pagefile.bytes !== null && cur.pagefile.bytes !== null) out.pagefileDeltaBytes = cur.pagefile.bytes - prev.pagefile.bytes;
    else out.why.push('the pagefile size is unmeasured in one snapshot');
    if (prev.volume && cur.volume && prev.volume.usedBytes !== null && cur.volume.usedBytes !== null) {
        out.volumeDeltaBytes = cur.volume.usedBytes - prev.volume.usedBytes;
        out.residualBytes = out.volumeDeltaBytes - out.attributedBytes - (out.pagefileDeltaBytes || 0);
    } else out.why.push('the volume usage is unmeasured in one snapshot');
    return out;
}

// ---------------------------------------------------------------------------
// Journal: an intent before every removal, an outcome after.
// ---------------------------------------------------------------------------

const journalPath = (c) => path.join(c.stateDir, 'journal.jsonl');

function journal(config, entry) { appendBounded(journalPath(config), [{ ...entry, utc: new Date().toISOString() }], JOURNAL_KEPT); }

/** Intents with no outcome, from an interrupted pass. Absent targets become done; present ones are judged afresh. */
function recoverJournal(config) {
    const open = new Map();
    for (const l of readLines(journalPath(config))) {
        if (l.state === 'intent') open.set(l.id, l);
        else open.delete(l.id);
    }
    const resolved = [];
    const rejudge = [];
    for (const l of open.values()) {
        if (!fs.existsSync(l.path)) { journal(config, { ...l, state: 'done', why: 'the interrupted pass had already removed it' }); resolved.push(l.path); }
        else { journal(config, { ...l, state: 'abandoned', why: 'the interrupted pass left it; judged afresh' }); rejudge.push(l.path); }
    }
    return { resolved, rejudge };
}

const mintId = () => `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------
// Scratch retention.
// ---------------------------------------------------------------------------

function unresolvedEvidence(dir) {
    const f = path.join(dir, EVIDENCE_MARKER);
    if (!fs.existsSync(f)) return null;
    const v = readJson(f);
    if (v && v.resolved === true) return null;
    return v && v.what ? String(v.what).slice(0, 200) : 'an evidence marker that is unreadable or unresolved';
}

/** Every unit of every scratch root, judged: [{ path, root, bytes, newestMs, verdict, why, evidence }]. */
function planScratch(config, { now = Date.now() } = {}) {
    const units = [];
    const cut = now - config.retentionDays * DAY_MS;
    for (const root of config.scratchRoots) {
        let names = [];
        try { names = fs.readdirSync(root); } catch (e) { units.push({ path: root, root, bytes: 0, verdict: 'keep', why: `the scratch root cannot be listed (${e.code || e.message})` }); continue; }
        for (const name of names) {
            const p = path.join(root, name);
            const m = measure(p, { deadline: Date.now() + Math.min(config.scanBudgetMs, 10000), maxEntries: config.scanMaxEntries });
            const u = { path: p, root, bytes: m.logicalBytes, allocatedBytes: m.allocatedBytes, newestMs: m.newestMs, verdict: 'keep', why: null, evidence: null };
            const cls = protectedClass(p) || (m.protectedHits[0] && m.protectedHits[0].cls);
            let isDir = false;
            try { isDir = fs.lstatSync(p).isDirectory(); } catch { /* vanished */ }
            if (cls) u.why = `holds a protected class (${cls}): reported, never deleted`;
            else if (!m.coverage.complete) u.why = `its scan is incomplete (${m.coverage.truncated || `${m.coverage.unreadable} unreadable`})`;
            else if (m.newestMs >= cut) u.why = `written ${Math.round((now - m.newestMs) / 3600000)} h ago, inside the ${config.retentionDays}-day window`;
            else if (isDir && (u.evidence = unresolvedEvidence(p))) { u.verdict = 'archive'; u.why = `expired, holds unresolved evidence (${u.evidence}): archived before removal`; }
            else { u.verdict = 'remove'; u.why = `newest write ${Math.round((now - m.newestMs) / DAY_MS)} days ago, past the ${config.retentionDays}-day window`; }
            units.push(u);
        }
    }
    return units;
}

/** The one deletion. Refuses a protected path and anything outside a scratch root, whatever the plan said. */
function removeUnit(config, p) {
    const cls = protectedClass(p);
    if (cls) return { removed: false, why: `refused: ${p} is protected (${cls})` };
    const inside = config.scratchRoots.some((r) => canon(p).startsWith(canon(r) + path.sep));
    if (!inside) return { removed: false, why: `refused: ${p} is not inside a scratch root` };
    const m = measure(p, { deadline: Date.now() + 10000 });
    if (m.protectedHits.length) return { removed: false, why: `refused: ${p} holds a protected class (${m.protectedHits[0].cls})` };
    const id = mintId();
    journal(config, { id, op: 'remove', path: p, bytes: m.logicalBytes, state: 'intent' });
    try {
        // rmSync unlinks a junction or symlink without following it.
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
        journal(config, { id, op: 'remove', path: p, state: 'failed', why: e.code || e.message });
        return { removed: false, why: `removal failed (${e.code || e.message})` };
    }
    journal(config, { id, op: 'remove', path: p, state: 'done' });
    return { removed: true, why: null };
}

const runTar = (args, cwd) => spawnSync('tar', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30 * 60000, maxBuffer: 256 * MIB });

/**
 * Archives `src` into config.archiveDir under capacity admission (class
 * `archive`). The archive is read back before it counts. { archived, file, why }.
 */
function archiveUnit(config, src, { env = process.env } = {}) {
    const capacity = require(path.join(__dirname, 'capacity.js'));
    const m = measure(src, { deadline: Date.now() + 10000 });
    if (!m.coverage.complete) return { archived: false, why: 'the source scan is incomplete, so the archive size is unknown' };
    const adm = capacity.admit({ cls: 'archive', path: config.archiveDir, diskBytes: m.logicalBytes + MIB, note: `archive ${path.basename(src)}` }, { env });
    if (!adm.admitted) return { archived: false, why: `capacity admission refused the archive: ${adm.why}` };
    try {
        fs.mkdirSync(config.archiveDir, { recursive: true });
        const name = `${path.basename(src)}-${new Date().toISOString().replace(/[-:.]/g, '')}.tar`;
        // A relative archive name, run from the archive directory: GNU tar reads a drive colon as a remote host.
        const mk = runTar(['-cf', name, '-C', path.dirname(src), path.basename(src)], config.archiveDir);
        if (mk.error || mk.status !== 0) return { archived: false, why: `tar failed (${mk.error ? mk.error.code : String(mk.stderr).trim().split('\n')[0]})` };
        const ls = runTar(['-tf', name], config.archiveDir);
        const listed = String(ls.stdout || '').split(/\r?\n/).filter((l) => l && !l.endsWith('/')).length;
        if (ls.status !== 0 || listed < m.files) return { archived: false, why: `the archive read back ${listed} files for ${m.files}` };
        return { archived: true, file: path.join(config.archiveDir, name), why: null };
    } finally {
        if (adm.id) capacity.release(adm.id, { env });
    }
}

const overflowPath = (c) => path.join(c.stateDir, 'scratch-overflow.json');

/** Sets or clears the overflow flag from the scratch that remains. Diagnostics are the ten largest units. */
function settleOverflow(config, remaining, now = Date.now()) {
    const total = remaining.reduce((s, u) => s + (u.bytes || 0), 0);
    const over = total > config.scratchCapBytes;
    if (over) {
        writeJson(overflowPath(config), { sinceUtc: (readJson(overflowPath(config)) || {}).sinceUtc || new Date(now).toISOString(), totalBytes: total,
            capBytes: config.scratchCapBytes, largest: [...remaining].sort((a, b) => b.bytes - a.bytes).slice(0, 10).map((u) => ({ path: u.path, bytes: u.bytes, why: u.why })) });
    } else { try { fs.unlinkSync(overflowPath(config)); } catch { /* not set */ } }
    return { overflow: over, totalBytes: total, capBytes: config.scratchCapBytes };
}

/** May a producer write scratch now? Refused while the overflow flag is set. */
function scratchAdmission(config) {
    const f = readJson(overflowPath(config));
    if (!f) return { ok: true, why: null };
    return { ok: false, why: `eligible scratch is ${(f.totalBytes / GIB).toFixed(2)} GiB, over the ${(f.capBytes / GIB).toFixed(2)} GiB cap since ${f.sinceUtc}; producers stop until a lifecycle pass clears it` };
}

/**
 * Streams `stream` (a producer's stdout) into `file`, at most `capBytes`. At the
 * cap it writes nothing more, calls `stop()` (which should end the producer),
 * and writes `<file>.overflow.json` with the last DIAG_TAIL_BYTES before the cut.
 * Resolves { overflowed, bytesWritten, bytesSeen }.
 */
function capStream({ stream, file, capBytes = STREAM_CAP_BYTES, stop }) {
    return new Promise((resolve) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = fs.openSync(file, 'w');
        let written = 0;
        let seen = 0;
        let overflowed = false;
        let settled = false;
        let tail = Buffer.alloc(0);
        const done = () => {
            if (settled) return;
            settled = true;
            try { fs.closeSync(fd); } catch { /* closed */ }
            if (overflowed) writeJson(`${file}.overflow.json`, { capBytes, bytesWritten: written, bytesSeenBeforeStop: seen, tail: tail.toString('utf8') });
            resolve({ overflowed, bytesWritten: written, bytesSeen: seen });
        };
        stream.on('data', (chunk) => {
            seen += chunk.length;
            if (overflowed) return;
            const room = capBytes - written;
            const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
            if (part.length) { fs.writeSync(fd, part); written += part.length; tail = Buffer.concat([tail, part]).subarray(-DIAG_TAIL_BYTES); }
            if (chunk.length > room) {
                overflowed = true;
                try { if (stop) stop(); } catch { /* the producer is already gone */ }
            }
        });
        stream.on('end', done);
        stream.on('close', done);
        stream.on('error', done);
    });
}

// ---------------------------------------------------------------------------
// Worktree records and lifecycle.
// ---------------------------------------------------------------------------

const recordsPath = (c) => path.join(c.stateDir, 'worktrees.json');
function readRecords(config) { const r = readJson(recordsPath(config)); return r && r.worktrees && typeof r.worktrees === 'object' ? r : { schema: 1, worktrees: {} }; }

function gitOut(dir, args) {
    const r = spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return r.status === 0 ? String(r.stdout).trim() : null;
}

/** Writes or refreshes a worktree's record: owner, lease, task, branch, last use. */
function recordWorktree(config, { worktree, owner, task, leaseHours = 0, now = Date.now() }) {
    if (!worktree || !owner || !task) return { ok: false, why: 'record needs --worktree, --owner and --task' };
    const branch = gitOut(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) return { ok: false, why: `${worktree} is not on a branch, so it has nothing to be restored from` };
    const recs = readRecords(config);
    const key = canon(worktree);
    const was = recs.worktrees[key] || {};
    recs.worktrees[key] = { path: path.resolve(worktree), owner: String(owner), task: String(task), branch,
        leaseUntilUtc: leaseHours > 0 ? new Date(now + leaseHours * 3600000).toISOString() : null,
        createdUtc: was.createdUtc || new Date(now).toISOString(), lastUseUtc: new Date(now).toISOString() };
    writeJson(recordsPath(config), recs);
    return { ok: true, record: recs.worktrees[key] };
}

function touchWorktree(config, { worktree, now = Date.now() }) {
    const recs = readRecords(config);
    const r = recs.worktrees[canon(worktree)];
    if (!r) return { ok: false, why: `${worktree} has no record; run record first` };
    r.lastUseUtc = new Date(now).toISOString();
    writeJson(recordsPath(config), recs);
    return { ok: true, record: r };
}

/** Physical reasons to keep a worktree: links, hardlinks, a shared install, an incomplete scan. */
function physicalReasons(dir, config) {
    const shared = require(path.join(__dirname, 'shared-install.js'));
    const out = [];
    const m = measure(dir, { deadline: Date.now() + Math.min(config.scanBudgetMs, 15000), maxEntries: config.scanMaxEntries, skipNames: new Set(['.git']) });
    const sharedRoots = [];
    const look = (d, depth) => {
        if (depth > 3) return;
        let names = [];
        try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of names) {
            if (!e.isDirectory() || e.name === '.git') continue;
            const full = path.join(d, e.name);
            if (e.name === 'node_modules') { if (fs.existsSync(path.join(full, shared.MARKER))) sharedRoots.push(full); continue; }
            look(full, depth + 1);
        }
    };
    look(dir, 0);
    if (sharedRoots.length) out.push(`it holds a shared install (${path.relative(dir, sharedRoots[0])}), whose files are hardlinks of the main checkout's`);
    if (m.links) out.push(`it holds ${m.links} junction or symlink${m.links === 1 ? '' : 's'} (${path.relative(dir, m.linkPaths[0])}), never followed and never removed by this pass`);
    if (m.hardlinked.length) out.push(`it holds hardlinked files (${path.relative(dir, m.hardlinked[0])}): removing them frees nothing and their other names are not judged`);
    if (!m.coverage.complete) out.push(`its scan is incomplete (${m.coverage.truncated || `${m.coverage.unreadable} unreadable`})`);
    return out;
}

function lockBase(env) {
    const queue = require(path.join(__dirname, 'full-gate-queue.js'));
    return path.resolve(env.AUTODEV_GATE_LOCK_PATH || queue.defaultLockPath());
}

/** worktree-reap's verdict plus the lifecycle's own: { report, rows }. */
function planWorktrees(config, { env = process.env, now = Date.now() } = {}) {
    if (!config.repos.length) return { report: null, rows: [] };
    const reaper = require(path.join(__dirname, 'worktree-reap.js'));
    const report = reaper.assess({ repos: config.repos, base: lockBase(env), opts: { fetch: config.fetch, idleHours: config.idleHours }, env });
    const recs = readRecords(config);
    const rows = report.worktrees.map((row) => {
        const reasons = [...row.reasons];
        const rec = recs.worktrees[canon(row.path)];
        if (!rec) reasons.push('it has no owner record, so nobody vouches that it is finished');
        else {
            if (rec.branch !== row.branch) reasons.push(`its record names branch ${rec.branch}, but it is on ${row.branch}`);
            if (rec.leaseUntilUtc && Date.parse(rec.leaseUntilUtc) > now) reasons.push(`${rec.owner} holds a lease until ${rec.leaseUntilUtc}`);
            const last = Date.parse(rec.lastUseUtc);
            if (!Number.isFinite(last) || last > now - config.idleHours * 3600000) reasons.push(`its record shows use at ${rec.lastUseUtc}, inside the ${config.idleHours} h idle window`);
        }
        if (!reasons.length) reasons.push(...physicalReasons(row.path, config));
        if (!reasons.length && gitOut(row.main, ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`]) !== row.head) {
            reasons.push(`its branch ${row.branch} does not point at its HEAD, so it could not be restored`);
        }
        row.eligible = reasons.length === 0;
        row.reasons = reasons;
        return { path: row.path, main: row.main, branch: row.branch, head: row.head, owner: rec ? rec.owner : null, task: rec ? rec.task : null,
            verdict: row.eligible ? 'remove' : 'keep', why: row.eligible ? row.evidence : reasons.join('; ') };
    });
    return { report, rows };
}

function applyWorktrees(config, planned, { env = process.env } = {}) {
    if (!planned.report) return [];
    const reaper = require(path.join(__dirname, 'worktree-reap.js'));
    const intents = new Map();
    for (const row of planned.report.worktrees.filter((r) => r.eligible)) {
        const id = mintId();
        intents.set(row.path, id);
        journal(config, { id, op: 'reap-worktree', path: row.path, main: row.main, branch: row.branch, head: row.head, state: 'intent' });
    }
    const results = reaper.apply(planned.report, lockBase(env), { idleHours: config.idleHours }, env);
    for (const r of results) {
        const row = planned.report.worktrees.find((x) => x.path === r.path);
        journal(config, { id: intents.get(r.path), op: 'reap-worktree', path: r.path, main: row.main, branch: row.branch, head: row.head,
            state: r.outcome === 'removed' ? 'done' : r.outcome, why: r.why });
    }
    return results;
}

/** Adds a removed worktree back from its branch, from the journal, and checks it is at the recorded HEAD. */
function restoreWorktree(config, worktree) {
    const want = canon(worktree);
    const entry = readLines(journalPath(config)).filter((l) => l.op === 'reap-worktree' && l.state === 'done' && canon(l.path) === want).pop();
    if (!entry) return { ok: false, why: `the journal has no completed removal of ${worktree}` };
    if (fs.existsSync(entry.path)) return { ok: false, why: `${entry.path} exists already` };
    const r = spawnSync('git', ['-C', entry.main, 'worktree', 'add', entry.path, entry.branch], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
    if (r.status !== 0) return { ok: false, why: `git worktree add failed: ${String(r.stderr).trim().split('\n')[0]}` };
    const head = gitOut(entry.path, ['rev-parse', 'HEAD']);
    return head === entry.head ? { ok: true, path: entry.path, head } : { ok: false, why: `restored at ${head}, not the recorded ${entry.head}` };
}

// ---------------------------------------------------------------------------
// Reported, never deleted.
// ---------------------------------------------------------------------------

function reportProtected(config) {
    return config.reportPaths.filter((p) => fs.existsSync(p)).map((p) => {
        const m = measure(p, { deadline: Date.now() + 5000, maxEntries: 50000 });
        return { path: p, cls: protectedClass(p) || 'unclassified', logicalBytes: m.logicalBytes, allocatedBytes: m.allocatedBytes, complete: m.coverage.complete, verdict: 'report' };
    });
}

// ---------------------------------------------------------------------------
// Receipt.
// ---------------------------------------------------------------------------

const receiptPath = (c) => path.join(c.stateDir, 'receipts', 'lifecycle-daily.json');

function writeReceipt(config, summary, now = Date.now()) {
    const r = { job: 'lifecycle-daily', completedUtc: new Date(now).toISOString(), host: os.hostname(), ...summary };
    writeJson(receiptPath(config), r);
    return r;
}

/** Is the daily pass overdue? { overdue, why, ageHours }. Reads one file and nothing else. */
function receiptStatus(config, { now = Date.now(), maxAgeHours = config.receiptMaxAgeHours } = {}) {
    const f = receiptPath(config);
    let r;
    try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
        return { overdue: true, ageHours: null, why: e.code === 'ENOENT' ? `no lifecycle receipt at ${f}: the daily pass has never completed here` : `the lifecycle receipt ${f} is unreadable (${e.code || e.message})` };
    }
    const t = Date.parse(r && r.completedUtc);
    if (!Number.isFinite(t)) return { overdue: true, ageHours: null, why: 'the lifecycle receipt has no completion time' };
    const ageMs = now - t;
    const ageHours = Math.round(ageMs / 360000) / 10;
    const overdue = ageMs > maxAgeHours * 3600000;
    return { overdue, ageHours, why: overdue ? `the last lifecycle pass completed ${ageHours} h ago, over the ${maxAgeHours} h limit` : null };
}

// ---------------------------------------------------------------------------
// plan and apply.
// ---------------------------------------------------------------------------

function plan(config, opts = {}) {
    const now = opts.now || Date.now();
    const recovered = opts.recover ? recoverJournal(config) : { resolved: [], rejudge: [] };
    const scratch = planScratch(config, { now });
    const worktrees = planWorktrees(config, { env: opts.env || process.env, now });
    const reported = reportProtected(config);
    return { recovered, scratch, worktrees, reported, admission: scratchAdmission(config) };
}

function apply(config, opts = {}) {
    const env = opts.env || process.env;
    const now = opts.now || Date.now();
    const p = plan(config, { ...opts, recover: true });
    for (const u of p.scratch) {
        if (u.verdict === 'remove') { const r = removeUnit(config, u.path); u.outcome = r.removed ? 'removed' : 'failed'; u.outcomeWhy = r.why; }
        else if (u.verdict === 'archive') {
            const a = archiveUnit(config, u.path, { env });
            if (!a.archived) { u.outcome = 'kept'; u.outcomeWhy = a.why; continue; }
            const r = removeUnit(config, u.path);
            u.outcome = r.removed ? 'archived' : 'failed';
            u.outcomeWhy = r.removed ? `archived to ${a.file}` : r.why;
        }
    }
    const remaining = p.scratch.filter((u) => !['removed', 'archived'].includes(u.outcome));
    const overflow = settleOverflow(config, remaining, now);
    const wt = applyWorktrees(config, p.worktrees, { env });
    for (const r of wt) { const row = p.worktrees.rows.find((x) => x.path === r.path); if (row) { row.outcome = r.outcome; row.outcomeWhy = r.why; } }
    const failed = p.scratch.filter((u) => u.outcome === 'failed').length + wt.filter((r) => r.outcome === 'failed').length;
    const receipt = writeReceipt(config, {
        scratchUnits: p.scratch.length, removed: p.scratch.filter((u) => u.outcome === 'removed').length, archived: p.scratch.filter((u) => u.outcome === 'archived').length,
        worktreesRemoved: wt.filter((r) => r.outcome === 'removed').length, failed, overflow: overflow.overflow, scratchBytes: overflow.totalBytes,
    });
    return { ...p, admission: scratchAdmission(config), overflow, failed, receipt };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const VERBS = ['plan', 'apply', 'snapshot', 'record', 'touch', 'restore', 'check-receipt'];

function parseArgs(argv) {
    const out = { cmd: 'plan', json: false, help: false, config: null, worktree: null, owner: null, task: null, leaseHours: 0, maxAgeHours: null, error: null };
    let i = 0;
    if (argv[0] && !argv[0].startsWith('-')) {
        out.cmd = argv[0];
        i = 1;
        if (!VERBS.includes(out.cmd)) { out.error = `unknown verb ${out.cmd}; one of ${VERBS.join(', ')}`; return out; }
    }
    for (; i < argv.length; i++) {
        const a = argv[i];
        const val = () => { const v = argv[++i]; if (v === undefined) out.error = `${a} needs a value`; return v; };
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--json') out.json = true;
        else if (a === '--config') out.config = val();
        else if (a === '--worktree') out.worktree = val();
        else if (a === '--owner') out.owner = val();
        else if (a === '--task') out.task = val();
        else if (a === '--lease-hours') out.leaseHours = Number(val());
        else if (a === '--max-age-hours') out.maxAgeHours = Number(val());
        else { out.error = `unknown argument ${a}`; return out; }
        if (out.error) return out;
    }
    return out;
}

const gib = (b) => (b === null || b === undefined ? 'unmeasured' : `${(b / GIB).toFixed(2)} GiB`);

function printPlan(r, verb) {
    const lines = [];
    if (r.recovered.resolved.length || r.recovered.rejudge.length) lines.push(`${TAG} interrupted pass: ${r.recovered.resolved.length} intent(s) already done, ${r.recovered.rejudge.length} judged afresh`);
    const elig = r.scratch.filter((u) => u.verdict !== 'keep');
    lines.push(`${TAG} scratch: ${r.scratch.length} unit(s) in ${new Set(r.scratch.map((u) => u.root)).size} root(s), ${elig.length} past retention`);
    for (const u of r.scratch) lines.push(`  ${(u.outcome || (u.verdict === 'keep' ? 'keep' : verb === 'apply' ? u.verdict : `would ${u.verdict}`)).padEnd(14)} ${gib(u.bytes).padStart(11)}  ${u.path}  ${u.outcomeWhy || u.why}`);
    lines.push(`${TAG} worktrees: ${r.worktrees.rows.length} linked, ${r.worktrees.rows.filter((x) => x.verdict === 'remove').length} eligible`);
    for (const w of r.worktrees.rows) lines.push(`  ${(w.outcome || (w.verdict === 'keep' ? 'keep' : verb === 'apply' ? 'remove' : 'would remove')).padEnd(14)} ${w.path} [${w.branch || 'detached'}] ${w.outcomeWhy || w.why}`);
    lines.push(`${TAG} reported, never deleted: ${r.reported.length} path(s)`);
    for (const p of r.reported) lines.push(`  report         ${gib(p.logicalBytes).padStart(11)}  ${p.path} (${p.cls}${p.complete ? '' : ', partial: a floor'})`);
    if (r.overflow) lines.push(`${TAG} eligible scratch ${gib(r.overflow.totalBytes)} of a ${gib(r.overflow.capBytes)} cap${r.overflow.overflow ? ': OVERFLOW, producers stop' : ''}`);
    else if (!r.admission.ok) lines.push(`${TAG} ${r.admission.why}`);
    lines.push(r.receipt ? `${TAG} receipt written at ${r.receipt.completedUtc}` : `${TAG} dry run: nothing removed. Run apply to act.`);
    return lines.join('\n');
}

function helpText() {
    const lines = fs.readFileSync(__filename, 'utf8').split('\n');
    const end = lines.findIndex((l) => l.trim() === '*/');
    return lines.slice(2, end).map((l) => l.replace(/^ \* ?/, '')).join('\n');
}

const stripReport = (r) => ({ ...r, worktrees: r.worktrees.rows });

function main(argv = process.argv.slice(2), env = process.env) {
    const a = parseArgs(argv);
    if (a.help) { process.stdout.write(helpText() + '\n'); return 0; }
    if (a.error) { process.stderr.write(`${TAG} ${a.error}\n`); return 2; }
    const c = loadConfig(a.config, env);
    if (!c.config) { process.stderr.write(`${TAG} ${c.why}\n`); return 2; }
    const config = c.config;
    const emit = (obj, text) => process.stdout.write((a.json ? JSON.stringify(obj, null, 2) : text) + '\n');
    if (a.cmd === 'check-receipt') {
        const s = receiptStatus(config, a.maxAgeHours > 0 ? { maxAgeHours: a.maxAgeHours } : {});
        emit(s, s.overdue ? `${TAG} OVERDUE: ${s.why}` : `${TAG} receipt fresh: the last pass completed ${s.ageHours} h ago`);
        return s.overdue ? 1 : 0;
    }
    if (a.cmd === 'record' || a.cmd === 'touch') {
        const r = a.cmd === 'record' ? recordWorktree(config, { worktree: a.worktree, owner: a.owner, task: a.task, leaseHours: a.leaseHours }) : touchWorktree(config, { worktree: a.worktree || '' });
        if (!r.ok) { process.stderr.write(`${TAG} ${r.why}\n`); return 2; }
        emit(r.record, `${TAG} ${a.cmd === 'record' ? 'recorded' : 'touched'} ${r.record.path} [${r.record.branch}] owner ${r.record.owner}, task ${r.record.task}`);
        return 0;
    }
    if (a.cmd === 'restore') {
        const r = restoreWorktree(config, a.worktree || '');
        emit(r, r.ok ? `${TAG} restored ${r.path} at ${r.head}` : `${TAG} not restored: ${r.why}`);
        return r.ok ? 0 : 1;
    }
    if (a.cmd === 'snapshot') {
        const file = path.join(config.stateDir, 'snapshots.jsonl');
        const s = snapshot(config, { env });
        const prev = readLines(file).pop() || null;
        appendBounded(file, [s], SNAPSHOTS_KEPT);
        const rec = prev ? reconcile(prev, s) : null;
        emit({ snapshot: s, reconcile: rec }, [
            `${TAG} snapshot of ${s.roots.length} root(s): ${gib(s.totals.uniqueLogicalBytes)} unique logical, ${gib(s.totals.allocatedBytes)} allocated, ${gib(s.totals.duplicateBytes)} hardlink duplication${s.complete ? '' : ' (partial: a floor)'}`,
            ...s.roots.map((r) => `  ${gib(r.logicalBytes).padStart(11)}  ${r.root}${r.nestedIn ? ` (inside ${r.nestedIn}, not counted there)` : ''}${r.coverage.complete ? '' : ` [partial: ${r.coverage.truncated || 'unreadable entries'}]`}`),
            `  volume used ${gib(s.volume.usedBytes)}, pagefile ${gib(s.pagefile.bytes)}`,
            rec ? `${TAG} since the last snapshot: volume ${gib(rec.volumeDeltaBytes)}, roots ${gib(rec.attributedBytes)}, pagefile ${gib(rec.pagefileDeltaBytes)}, residual ${gib(rec.residualBytes)}` : `${TAG} first snapshot: nothing to reconcile`,
        ].join('\n'));
        return 0;
    }
    if (a.cmd === 'apply') {
        const r = apply(config, { env });
        emit(stripReport(r), printPlan(r, 'apply'));
        return r.failed ? 1 : 0;
    }
    const r = plan(config, { env });
    emit(stripReport(r), printPlan(r, 'plan'));
    return 0;
}

module.exports = {
    GIB, MIB, RETENTION_DAYS, SCRATCH_CAP_BYTES, STREAM_CAP_BYTES, RECEIPT_MAX_AGE_HOURS, EVIDENCE_MARKER, PROTECTED,
    protectedClass, defaultStateDir, defaultReportPaths, loadConfig, measure, probeVolume, probePagefile, snapshot, reconcile,
    recoverJournal, planScratch, removeUnit, archiveUnit, settleOverflow, scratchAdmission, capStream,
    recordWorktree, touchWorktree, physicalReasons, planWorktrees, applyWorktrees, restoreWorktree, reportProtected,
    writeReceipt, receiptStatus, receiptPath, journalPath, plan, apply, parseArgs, main,
};

if (require.main === module) process.exitCode = main();
