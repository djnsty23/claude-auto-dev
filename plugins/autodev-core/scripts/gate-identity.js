#!/usr/bin/env node
/**
 * gate-identity.js - who a gate is: its repository, its machine boot, and the
 * processes that carry its execution. A library for full-gate-queue.js and the
 * tooling gate wrapper; it prints nothing on import and nothing on a no-op.
 *
 * WHY. The full-gate lock used to name a bare pid, and a pid says little:
 *   - After a reboot the number is reused. A lock left by a gate that died with
 *     the machine then names some live process, and a waiter keeps waiting for
 *     a gate that no longer exists.
 *   - A gate's launcher can die while the chain it started runs on. Judging the
 *     launcher alone hands the lane to a second gate beside a live one.
 *   - A class written by the caller can be wrong. A harness gate that says
 *     `--class product` jumps every product gate and can take the last lane.
 * So a record carries the boot it was written in, the native pid AND its
 * creation time, an optional MSYS (Git Bash) pid, and the repository it came
 * from, and a judgement walks the process tree from the recorded execution.
 *
 * WHAT A JUDGEMENT SAYS. true (the execution is running), false (it provably is
 * not: a different boot, or a complete snapshot of this boot holds no process of
 * it), or null (unknown). Every caller treats null as alive. A probe that fails,
 * a record it cannot read, an MSYS mapping that names two processes: all null.
 * Snapshot polling cannot see an intermediate process that started and exited
 * between two observations, so a descendant whose whole ancestry went unobserved
 * is invisible, and a judgement never claims otherwise.
 *
 * WINDOWS PROBES. One hidden PowerShell call per snapshot, with -NoProfile
 * -NonInteractive -EncodedCommand (UTF-16LE), reads Win32_OperatingSystem's
 * LastBootUpTime and every Win32_Process's ProcessId, ParentProcessId and
 * CreationDate. Boot identity is the host name plus LastBootUpTime. With Fast
 * Startup a shutdown is not a new boot, so a lock from before such a shutdown is
 * judged by its processes, not by its boot. Git's `ps -W` maps MSYS pids to
 * native ones (its PID and WINPID columns).
 *
 * POSIX PROBES. `ps -A -o pid=,ppid=,lstart=` lists the processes, and
 * /proc/stat's btime or sysctl's kern.boottime gives the boot. Windows keeps a
 * process's ParentProcessId after that parent exits. POSIX does not: the kernel
 * hands an orphan to init or a subreaper, so a dead owner's children no longer
 * name it. Each POSIX snapshot therefore remembers, per boot, the process that
 * created each process it saw (pid and creation time) in a lineage file
 * (AUTODEV_GATE_LINEAGE_PATH, default `autodev-gate-lineage-<uid>.json` in the
 * temp directory). A later snapshot indexes a re-parented process under that
 * creator, as Windows would. A link is used only for its exact creator, so a
 * later process at a reused pid adopts nobody. A process re-parented before any
 * snapshot saw its creator stays invisible, like any unobserved ancestry.
 *
 *   node gate-identity.js --help
 *   node gate-identity.js snapshot   # prints this machine's boot and process count (POSIX also refreshes the lineage file)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const PROBE_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Time. Every creation time is an ISO string with seven fractional digits, the
// shape PowerShell's 'o' format writes, so two times compare as strings.
// ---------------------------------------------------------------------------

function iso7(ms) {
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().replace(/Z$/, '0000Z');
}

/** A creation time from any probe, as an iso7 string, or null. */
function normaliseTime(s) {
    if (typeof s !== 'string' || !s) return null;
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(s.trim());
    if (m) return `${m[1]}.${(m[2] || '').padEnd(7, '0').slice(0, 7)}Z`;
    return iso7(Date.parse(s));
}

// ---------------------------------------------------------------------------
// PowerShell, hidden and profile-free.
// ---------------------------------------------------------------------------

/** Runs a fixed script. { ok, stdout, why }. Never throws. */
function runPowerShell(script, timeoutMs = PROBE_TIMEOUT_MS) {
    try {
        const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
        if (r.error) return { ok: false, stdout: '', why: `powershell could not run (${r.error.code || r.error.message})` };
        if (r.status !== 0) return { ok: false, stdout: r.stdout || '', why: `powershell exited ${r.status}` };
        return { ok: true, stdout: r.stdout || '', why: null };
    } catch (e) {
        return { ok: false, stdout: '', why: `powershell threw (${e.message})` };
    }
}

const WIN_SNAPSHOT = [
    '$os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop',
    '$p = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {',
    "  [pscustomobject]@{ i = $_.ProcessId; p = $_.ParentProcessId; s = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } } })",
    "ConvertTo-Json -Compress -Depth 3 -InputObject @{ host = $env:COMPUTERNAME; boot = $os.LastBootUpTime.ToUniversalTime().ToString('o'); procs = $p }",
].join('\n');

// ---------------------------------------------------------------------------
// Snapshots: every process with its parent and creation time, and the boot.
// ---------------------------------------------------------------------------

function indexProcs(list) {
    const procs = new Map();
    const children = new Map();
    for (const p of list) {
        if (!Number.isInteger(p.pid) || p.pid <= 0) continue;
        procs.set(p.pid, p);
        if (!children.has(p.ppid)) children.set(p.ppid, []);
        children.get(p.ppid).push(p);
    }
    return { procs, children };
}

function windowsSnapshot() {
    const r = runPowerShell(WIN_SNAPSHOT);
    if (!r.ok) return { ok: false, why: r.why };
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { return { ok: false, why: 'the process snapshot was not JSON' }; }
    if (!parsed || !Array.isArray(parsed.procs) || !parsed.procs.length || typeof parsed.boot !== 'string') {
        return { ok: false, why: 'the process snapshot was empty or had no boot time' };
    }
    const list = parsed.procs.map((p) => ({ pid: Number(p.i), ppid: Number(p.p), startUtc: normaliseTime(p.s) }));
    const host = String(parsed.host || os.hostname()).toLowerCase();
    return { ok: true, boot: { id: `${host}|${normaliseTime(parsed.boot)}`, source: 'Win32_OperatingSystem.LastBootUpTime' }, ...indexProcs(list) };
}

// ---------------------------------------------------------------------------
// POSIX lineage: the process that created each process, remembered per boot,
// because the kernel re-parents an orphan to init or a subreaper.
// ---------------------------------------------------------------------------

const LINEAGE_SCHEMA = 1;
const LINEAGE_MAX_BYTES = 16 * 1024 * 1024;
const LINEAGE_KEY = /^\d+\|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/;

function lineagePath() {
    if (process.env.AUTODEV_GATE_LINEAGE_PATH) return process.env.AUTODEV_GATE_LINEAGE_PATH;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    return path.join(os.tmpdir(), `autodev-gate-lineage-${uid}.json`);
}

/**
 * The links remembered in `bootId`: Map('pid|startUtc' -> { ppid, ppidStartUtc }).
 * Only a regular file this user owns is read. Anything else is no memory.
 */
function readLineage(file, bootId) {
    const links = new Map();
    try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.size > LINEAGE_MAX_BYTES) return links;
        if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return links;
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!doc || doc.schema !== LINEAGE_SCHEMA || doc.bootId !== bootId || !doc.links || typeof doc.links !== 'object') return links;
        for (const [key, v] of Object.entries(doc.links)) {
            if (!LINEAGE_KEY.test(key) || !Array.isArray(v) || !Number.isInteger(v[0]) || v[0] <= 0 || !LINEAGE_KEY.test(`${v[0]}|${v[1]}`)) continue;
            links.set(key, { ppid: v[0], ppidStartUtc: v[1] });
        }
    } catch { /* absent or unreadable: no memory */ }
    return links;
}

function sameLinks(a, b) {
    if (a.size !== b.size) return false;
    for (const [key, v] of a) {
        const w = b.get(key);
        if (!w || w.ppid !== v.ppid || w.ppidStartUtc !== v.ppidStartUtc) return false;
    }
    return true;
}

/** Best-effort: without the memory a re-parented process is judged as it was before. */
function writeLineage(file, bootId, links) {
    let tmp = null;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const out = {};
        for (const [key, v] of links) out[key] = [v.ppid, v.ppidStartUtc];
        const name = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        fs.writeFileSync(name, `${JSON.stringify({ schema: LINEAGE_SCHEMA, bootId, links: out })}\n`, { flag: 'wx', mode: 0o600 });
        tmp = name;
        fs.renameSync(tmp, file);
        tmp = null;
    } catch { /* the next snapshot writes it again */ } finally {
        if (tmp) { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
    }
}

/**
 * Applies the remembered `links` to one listing and refreshes them. A process
 * whose remembered creator is not its parent now was re-parented after that
 * creator exited: it is listed under the creator, with `parentStartUtc` saying
 * which process at that pid it was. Returns { list, links }, the links pruned
 * to processes in this listing. Pure.
 */
function rememberLineage(list, links) {
    const byPid = new Map(list.map((p) => [p.pid, p]));
    const out = [];
    const kept = new Map();
    for (const p of list) {
        const key = p.startUtc ? `${p.pid}|${p.startUtc}` : null;
        const was = key ? links.get(key) : null;
        const parent = byPid.get(p.ppid);
        const parentStart = parent ? parent.startUtc : null;
        if (was && !(was.ppid === p.ppid && was.ppidStartUtc === parentStart)) {
            out.push({ ...p, ppid: was.ppid, parentStartUtc: was.ppidStartUtc });
            kept.set(key, was);
            continue;
        }
        out.push(p);
        if (key && p.ppid > 1 && parentStart) kept.set(key, { ppid: p.ppid, ppidStartUtc: parentStart });
    }
    return { list: out, links: kept };
}

/** Applies the lineage memory in `file` to one listing and keeps it current. Returns the listing. */
function refreshLineage(list, bootId, file = lineagePath()) {
    const before = readLineage(file, bootId);
    const lineage = rememberLineage(list, before);
    if (!sameLinks(before, lineage.links)) writeLineage(file, bootId, lineage.links);
    return lineage.list;
}

function posixBoot() {
    try {
        const stat = fs.readFileSync('/proc/stat', 'utf8');
        const m = /^btime (\d+)$/m.exec(stat);
        if (m) return { id: `${os.hostname().toLowerCase()}|${iso7(Number(m[1]) * 1000)}`, source: '/proc/stat btime' };
    } catch { /* not Linux */ }
    try {
        const r = spawnSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 5000 });
        const m = !r.error && r.status === 0 ? /sec = (\d+)/.exec(r.stdout || '') : null;
        if (m) return { id: `${os.hostname().toLowerCase()}|${iso7(Number(m[1]) * 1000)}`, source: 'sysctl kern.boottime' };
    } catch { /* no sysctl */ }
    return null;
}

function posixSnapshot() {
    const boot = posixBoot();
    if (!boot) return { ok: false, why: 'no boot time source answered' };
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='],
        { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) return { ok: false, why: `ps could not run (${r.error ? r.error.code : `exit ${r.status}`})` };
    const list = [];
    for (const line of (r.stdout || '').split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), startUtc: iso7(Date.parse(m[3])) });
    }
    if (!list.length) return { ok: false, why: 'ps listed no process' };
    return { ok: true, boot, ...indexProcs(refreshLineage(list, boot.id)) };
}

let cachedSnapshot = null;

/**
 * The machine's processes and boot. A snapshot younger than `maxAgeMs` is
 * reused; pass 0 for a fresh one. { ok, takenMs, boot, procs, children } or
 * { ok: false, why }. Never throws.
 */
function snapshot({ maxAgeMs = 0 } = {}) {
    if (cachedSnapshot && maxAgeMs > 0 && Date.now() - cachedSnapshot.takenMs <= maxAgeMs) return cachedSnapshot;
    let s;
    try { s = WIN ? windowsSnapshot() : posixSnapshot(); } catch (e) { s = { ok: false, why: `snapshot threw (${e.message})` }; }
    s.takenMs = Date.now();
    if (s.ok) cachedSnapshot = s;
    return s;
}

function forgetSnapshot() { cachedSnapshot = null; }

/**
 * This boot's identity, without a process listing when it can. The machine's
 * uptime gives an approximate boot time for free; a cache file maps that
 * approximation to the exact identity, so the probe runs once per boot. Null
 * when no probe answered.
 */
function bootIdentity({ cacheFile = null } = {}) {
    const approx = Date.now() - os.uptime() * 1000;
    if (cacheFile) {
        try {
            const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (c && typeof c.id === 'string' && Math.abs(Number(c.approxBootMs) - approx) < 120000) return { id: c.id, source: `${c.source} (cached)` };
        } catch { /* absent or unreadable: probe */ }
    }
    const s = snapshot({ maxAgeMs: 600000 });
    const boot = s.ok ? s.boot : (WIN ? null : posixBoot());
    if (!boot) return null;
    if (cacheFile) {
        try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            const tmp = `${cacheFile}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, `${JSON.stringify({ id: boot.id, source: boot.source, approxBootMs: approx })}\n`);
            fs.renameSync(tmp, cacheFile);
        } catch { /* the cache is a convenience */ }
    }
    return boot;
}

// ---------------------------------------------------------------------------
// MSYS pids. Git's `ps -W` lists every process with its MSYS PID and its
// native WINPID. Only a header it can read is trusted.
// ---------------------------------------------------------------------------

let psCommand;

function resolvePs() {
    if (psCommand !== undefined) return psCommand;
    psCommand = null;
    try {
        const probe = spawnSync('ps', ['-W'], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
        if (!probe.error && /\bWINPID\b/.test(probe.stdout || '')) { psCommand = 'ps'; return psCommand; }
        const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        if (!ex.error && ex.status === 0) {
            const candidate = path.resolve(ex.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'ps.exe');
            if (fs.existsSync(candidate)) psCommand = candidate;
        }
    } catch { /* no ps */ }
    return psCommand;
}

/**
 * Parses `ps -W` output. { ok, byMsys: Map(msysPid -> winpid), ambiguous: Set }.
 * A row may start with a one-letter status flag before PID; the header names
 * the columns. A pid listed twice with different native pids is ambiguous.
 */
function parsePsW(text) {
    const lines = String(text || '').split(/\r?\n/);
    const headerIdx = lines.findIndex((l) => /\bPID\b/.test(l) && /\bWINPID\b/.test(l));
    if (headerIdx < 0) return { ok: false, why: 'ps -W printed no PID/WINPID header', byMsys: new Map(), ambiguous: new Set() };
    const cols = lines[headerIdx].trim().split(/\s+/);
    const iPid = cols.indexOf('PID');
    const iWin = cols.indexOf('WINPID');
    const byMsys = new Map();
    const ambiguous = new Set();
    for (const line of lines.slice(headerIdx + 1)) {
        let t = line.trim().split(/\s+/);
        if (t.length && /^[A-Za-z]$/.test(t[0])) t = t.slice(1);
        if (t.length <= Math.max(iPid, iWin)) continue;
        if (!/^\d+$/.test(t[iPid]) || !/^\d+$/.test(t[iWin])) continue;
        const msys = Number(t[iPid]);
        const win = Number(t[iWin]);
        if (byMsys.has(msys) && byMsys.get(msys) !== win) ambiguous.add(msys);
        else byMsys.set(msys, win);
    }
    return { ok: true, why: null, byMsys, ambiguous };
}

let cachedMsys;

/** The MSYS table, once per reset. On POSIX it is not applicable, never a failure. */
function msysTable() {
    if (cachedMsys !== undefined) return cachedMsys;
    const empty = { byMsys: new Map(), ambiguous: new Set() };
    if (!WIN) { cachedMsys = { ok: true, applicable: false, why: null, ...empty }; return cachedMsys; }
    const ps = resolvePs();
    if (!ps) { cachedMsys = { ok: false, applicable: true, why: 'Git ps not found', ...empty }; return cachedMsys; }
    try {
        const r = spawnSync(ps, ['-W'], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
        if (r.error || r.status !== 0) cachedMsys = { ok: false, applicable: true, why: 'ps -W failed', ...empty };
        else cachedMsys = { applicable: true, ...parsePsW(r.stdout) };
    } catch (e) {
        cachedMsys = { ok: false, applicable: true, why: `ps -W threw (${e.message})`, ...empty };
    }
    return cachedMsys;
}

function forgetMsys() { cachedMsys = undefined; }

// ---------------------------------------------------------------------------
// Recording and judging an execution.
// ---------------------------------------------------------------------------

/**
 * The identity to record for `pid`: { pid, startUtc, bootId, msysPid?,
 * msysWinpid?, ambiguous? }. A pid that is an MSYS pid is recorded with the
 * native pid it maps to. Fields a probe could not fill are null, never guessed.
 */
function identityOf(pid, { snap = null, boot = null } = {}) {
    const s = snap || snapshot({ maxAgeMs: 5000 });
    const out = { pid, startUtc: null, bootId: boot ? boot.id : (s.ok ? s.boot.id : null) };
    const native = s.ok ? s.procs.get(pid) : null;
    if (native) out.startUtc = native.startUtc;
    const msys = msysTable();
    if (msys.ok && msys.applicable && msys.byMsys.has(pid)) {
        const win = msys.byMsys.get(pid);
        if (win !== pid) {
            out.msysPid = pid;
            out.msysWinpid = win;
            if (native || msys.ambiguous.has(pid)) out.ambiguous = true;
            else if (s.ok && s.procs.get(win)) { out.pid = win; out.startUtc = s.procs.get(win).startUtc; }
        }
    }
    return out;
}

/**
 * Every live process descending from the recorded processes. `roots` are
 * { pid, startUtc } records (the owner, the chain root, journaled
 * descendants), alive or not: a dead parent's pid still names its orphans. A
 * child counts only when it was created no earlier than the parent recorded at
 * that pid. When that pid now belongs to a later process, a child created
 * after that process started is the later process's own, so a reused parent
 * pid adopts nobody: not even the console host every new process gets. A
 * record carrying goneBy (gate-records.js mergeDescendants) adopts nobody
 * created after that time either, which covers a later holder that has
 * exited in turn and left an orphan of its own. A child listed with `parentStartUtc` (POSIX lineage) names its creator
 * exactly, and counts only for that creator.
 */
function liveDescendants(roots, snap) {
    const found = new Map();
    const queue = roots.filter((r) => r && Number.isInteger(r.pid) && r.startUtc);
    const seen = new Set();
    while (queue.length) {
        const r = queue.shift();
        const key = `${r.pid}|${r.startUtc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const now = snap.procs.get(r.pid);
        const reusedAt = now && now.startUtc && now.startUtc !== r.startUtc ? now.startUtc : null;
        const goneMs = r.goneBy ? Date.parse(r.goneBy) : NaN;
        for (const c of snap.children.get(r.pid) || []) {
            if (!c.startUtc || c.startUtc < r.startUtc || c.pid === r.pid) continue;
            if (c.parentStartUtc && c.parentStartUtc !== r.startUtc) continue;
            if (reusedAt && c.startUtc >= reusedAt) continue;
            // Created after a snapshot already showed the parent gone: the pid's later
            // holder made it, and that holder has exited too, so reusedAt cannot tell.
            if (Number.isFinite(goneMs) && Date.parse(c.startUtc) >= goneMs) continue;
            if (!found.has(c.pid)) found.set(c.pid, c);
            queue.push(c);
        }
    }
    return [...found.values()];
}

/** True when `rec` names a live process: the same pid created at the same time. */
function recordLive(rec, snap) {
    if (!rec || !Number.isInteger(rec.pid) || !rec.startUtc) return false;
    const p = snap.procs.get(rec.pid);
    return Boolean(p && p.startUtc === rec.startUtc);
}

/**
 * True when `rec`'s pid is in the snapshot but the probe could not read that
 * process's creation time (an elevated or protected process): it may be the
 * recorded process, so nothing about it is proven.
 */
function recordUnreadable(rec, snap) {
    if (!rec || !Number.isInteger(rec.pid)) return false;
    const p = snap.procs.get(rec.pid);
    return Boolean(p && !p.startUtc);
}

/**
 * Is the execution `owner` started (with `execution`, a run journal's
 * { chainRoot, descendants }) still running? { alive: true|false|null, why }.
 * `legacyAlive(pid)` answers when the snapshot is unavailable.
 */
function judgeExecution({ owner, execution = null, journalUnreadable = false, snap, boot, msys, legacyAlive = null }) {
    if (!owner || typeof owner !== 'object' || !Number.isInteger(owner.pid)) return { alive: null, why: 'the record names no owner' };
    if (owner.bootId && boot && boot.id && owner.bootId !== boot.id) {
        return { alive: false, why: `it was written in an earlier boot (${owner.bootId.split('|')[1] || owner.bootId})` };
    }
    if (!snap || !snap.ok) {
        const l = legacyAlive ? legacyAlive(owner.pid) : null;
        return l === true ? { alive: true, why: `pid ${owner.pid} answers a liveness probe` }
            : { alive: null, why: `no process snapshot (${snap ? snap.why : 'none taken'})` };
    }
    let unknown = null;
    if (owner.startUtc) {
        if (recordLive(owner, snap)) return { alive: true, why: `pid ${owner.pid} is running, created ${owner.startUtc}` };
        if (recordUnreadable(owner, snap)) unknown = `pid ${owner.pid} is running, but its creation time could not be read`;
    } else if (snap.procs.has(owner.pid)) {
        unknown = `pid ${owner.pid} is running, but the record has no creation time to compare`;
    }
    if (owner.msysPid) {
        if (!msys || !msys.ok) unknown = unknown || `MSYS pid ${owner.msysPid} cannot be checked (${msys ? msys.why : 'no table'})`;
        else if (msys.ambiguous.has(owner.msysPid)) unknown = unknown || `MSYS pid ${owner.msysPid} maps to more than one process`;
        else if (msys.byMsys.has(owner.msysPid) && (!owner.msysWinpid || msys.byMsys.get(owner.msysPid) === owner.msysWinpid)) {
            return { alive: true, why: `MSYS pid ${owner.msysPid} is running` };
        }
    }
    const recorded = [owner];
    if (execution && execution.chainRoot) recorded.push(execution.chainRoot);
    if (execution && Array.isArray(execution.descendants)) recorded.push(...execution.descendants);
    for (const r of recorded.slice(1)) {
        if (recordLive(r, snap)) return { alive: true, why: `pid ${r.pid} of its execution is running` };
        if (!unknown && recordUnreadable(r, snap)) unknown = `pid ${r.pid} of its execution is running with a creation time that could not be read`;
    }
    const live = liveDescendants(recorded, snap);
    if (live.length) return { alive: true, why: `pid ${live[0].pid}, a descendant of its execution, is running` };
    if (journalUnreadable) return { alive: null, why: 'its execution journal cannot be read' };
    if (unknown) return { alive: null, why: unknown };
    const reused = snap.procs.get(owner.pid);
    return { alive: false, why: reused ? `pid ${owner.pid} now belongs to a process created ${reused.startUtc}, and no process of its execution remains`
        : `pid ${owner.pid} is not running, and no process of its execution remains` };
}

// ---------------------------------------------------------------------------
// Repository identity: the class comes from the caller's checkout, never from
// a flag. A tree that carries this marketplace's markers is the harness.
// ---------------------------------------------------------------------------

/** realpath with 8.3 aliases expanded; on Windows lower-cased with backslashes, for comparison. */
function canonicalPath(p) {
    let real = path.resolve(p);
    try { real = fs.realpathSync.native(real); } catch { /* keep the resolved spelling */ }
    return WIN ? real.split('/').join('\\').toLowerCase() : real;
}

function gitIn(dir, args) {
    try {
        const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        return !r.error && r.status === 0 ? r.stdout.trim() : null;
    } catch { return null; }
}

/** `git@github.com:o/r.git`, `https://u@github.com/o/r` -> `github.com/o/r`. */
function normaliseOrigin(url) {
    if (!url) return null;
    let s = String(url).trim().replace(/\.git$/i, '').replace(/\/+$/, '');
    s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
    s = s.replace(/^([^/:]+):(?!\d)/, '$1/');
    return s.toLowerCase();
}

const HARNESS_PACKAGE = 'claude-auto-dev';

function harnessMarkers(top) {
    const hits = [];
    try {
        const mk = JSON.parse(fs.readFileSync(path.join(top, '.claude-plugin', 'marketplace.json'), 'utf8'));
        const names = Array.isArray(mk && mk.plugins) ? mk.plugins.map((p) => p && p.name) : [];
        if (names.includes('autodev-core')) hits.push('.claude-plugin/marketplace.json lists autodev-core');
    } catch { /* not a marketplace */ }
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8'));
        if (pkg && pkg.name === HARNESS_PACKAGE) hits.push(`package.json name is ${HARNESS_PACKAGE}`);
    } catch { /* no package */ }
    return hits;
}

/**
 * The repository `dir` belongs to: { resolved, worktree, commonDir, origin,
 * packageName, harness, why }. `resolved` is false when git could not say,
 * which callers treat as a harness gate: the conservative class.
 */
function repoIdentity(dir) {
    const top = gitIn(dir, ['rev-parse', '--show-toplevel']);
    if (!top) {
        return { resolved: false, worktree: canonicalPath(dir), commonDir: null, origin: null, packageName: null, harness: true,
                 why: 'git cannot name the repository of this directory' };
    }
    const common = gitIn(dir, ['rev-parse', '--git-common-dir']);
    if (!common) {
        // git named the top level but not the repository behind it: a partial
        // answer is not an identity, so it is the conservative class.
        return { resolved: false, worktree: canonicalPath(top), commonDir: null, origin: null, packageName: null, harness: true,
                 why: 'git named the checkout but not its repository (git-common-dir failed)' };
    }
    const origin = normaliseOrigin(gitIn(dir, ['config', '--get', 'remote.origin.url']));
    let packageName = null;
    try { packageName = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8')).name || null; } catch { /* none */ }
    const markers = harnessMarkers(top);
    if (origin && /\/claude-auto-dev$/.test(origin)) markers.push(`origin is ${origin}`);
    return {
        resolved: true, worktree: canonicalPath(top), commonDir: common ? canonicalPath(path.resolve(dir, common)) : null,
        origin, packageName, harness: markers.length > 0,
        why: markers.length ? markers.join('; ') : 'no harness marker in the checkout',
    };
}

/** A short stable key for a canonical path, for file names. */
function pathKey(canonical) {
    return crypto.createHash('sha256').update(String(canonical)).digest('hex').slice(0, 16);
}

module.exports = {
    runPowerShell, snapshot, forgetSnapshot, bootIdentity, parsePsW, msysTable, forgetMsys, identityOf,
    liveDescendants, recordLive, recordUnreadable, judgeExecution, canonicalPath, repoIdentity, normaliseOrigin, pathKey,
    normaliseTime, iso7, posixBoot, posixSnapshot, lineagePath, readLineage, rememberLineage, refreshLineage,
};

if (require.main === module) {
    if (process.argv[2] === 'snapshot') {
        const s = snapshot();
        if (!s.ok) { console.error(`gate-identity: no snapshot: ${s.why}`); process.exitCode = 2; }
        else console.log(`gate-identity: boot ${s.boot.id.split('|')[1]} (${s.boot.source}), ${s.procs.size} processes`);
    } else {
        console.log('usage: node gate-identity.js [snapshot]\n\nA library for full-gate-queue.js and tooling/gate-lock.js: boot identity,\nprocess snapshots, MSYS pid mapping and repository identity. "snapshot"\nprints the boot time and the process count. On POSIX it also refreshes\nthe lineage file (AUTODEV_GATE_LINEAGE_PATH).');
    }
}
