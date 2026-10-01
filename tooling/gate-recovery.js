#!/usr/bin/env node
/**
 * gate-recovery.js - what a failed full-gate attempt says about the MACHINE,
 * as opposed to the code, and whether the gate may queue again by itself.
 * A library for tooling/gate-lock.js; it prints nothing on import.
 *
 * WHY. A red full gate is a verdict on the tree only when the machine was
 * healthy while it ran. `[measured 2026-09-30]` gates died at commit exhaustion
 * with exit 134 or 0xC0000409 and no stack, and read as code failures. The
 * opposite mistake is worse: calling a real red "the machine" turns a bug
 * green on a retry. So every infrastructure verdict needs EVIDENCE the code
 * could not have produced, and an exit code alone is never evidence:
 *   - MEMORY: a crash exit (134, 0xC0000409, 0x80000003, 0xC0000005,
 *     0xC0000017) AND a Resource-Exhaustion-Detector event 2004 in the System
 *     log inside the attempt's window (start to end plus 10 s). "No event" and
 *     "the log could not be read" are different answers, and neither is
 *     evidence.
 *   - DISK: the output said ENOSPC AND the gate's volume is below the free-space
 *     floor (default 1 GiB) after the attempt.
 *   - PORT: the output said EADDRINUSE with a port AND that port still cannot be
 *     bound after the attempt.
 * An attempt with evidence is INDETERMINATE (exit 2). Without, its exit stands.
 *
 * RE-ADMISSION is off unless a recovery config exists (`full-gate.recovery.json`
 * beside lane 1's lock, or the file AUTODEV_GATE_RECOVERY names). It holds
 * every threshold explicitly:
 *   { "diskFloorBytes": N, "memoryHeadroomBytes": N, "sampleIntervalMs": N,
 *     "clearanceTimeoutMs": N, "maxReadmissions": 0..2 }
 * An attempt with evidence queues again only after its descendants exited and
 * two healthy samples in a row (sampleIntervalMs apart) show the cause gone:
 * free space at or over the floor, the port bindable, or commit headroom at or
 * over memoryHeadroomBytes with no new event 2004 between the samples. At most
 * maxReadmissions times per worktree and head, counted in a file that outlives
 * the process. The re-queued ticket keeps the run's original arrival.
 *
 * TEST SEAM. AUTODEV_GATE_EVENTS_FIXTURE names a JSON file of events
 * ({ "times": [iso...] } or { "status": "failed" }) read in place of the event
 * log; the window filter still applies.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const WIN = process.platform === 'win32';
const CRASH_EXITS = new Set([134, 0xC0000409, 0x80000003, 0xC0000005, 0xC0000017]);
const DEFAULT_DISK_FLOOR = 1024 * 1024 * 1024;
const EVENT_SLACK_MS = 10000;

// ---------------------------------------------------------------------------
// Scanning the chain's output.
// ---------------------------------------------------------------------------

/**
 * A line scanner for the chain's output. Each hit names the npm step whose
 * output it was in: the last `> name@version script` header npm printed.
 */
function createScanner() {
    let step = null;
    let partial = '';
    const hits = [];
    const add = (hit) => {
        if (hits.length >= 20) return;
        if (hits.some((h) => h.kind === hit.kind && h.step === hit.step && h.port === hit.port)) return;
        hits.push(hit);
    };
    const line = (l) => {
        const header = /^> \S+@\S+ (\S+)\s*$/.exec(l);
        if (header) { step = header[1]; return; }
        if (/\bENOSPC\b/.test(l)) add({ kind: 'ENOSPC', step });
        if (/\bEADDRINUSE\b/.test(l)) {
            const m = /:(\d{2,5})(?!.*:\d)/.exec(l.slice(l.indexOf('EADDRINUSE')));
            add({ kind: 'EADDRINUSE', step, port: m ? Number(m[1]) : null });
        }
    };
    return {
        feed(buf) {
            const text = partial + buf.toString('utf8');
            const lines = text.split(/\r?\n/);
            partial = lines.pop();
            if (partial.length > 65536) partial = partial.slice(-65536);
            for (const l of lines) line(l);
        },
        hits() { if (partial) { line(partial); partial = ''; } return hits.slice(); },
    };
}

// ---------------------------------------------------------------------------
// Probes. Each answers { status, ... } and never throws.
// ---------------------------------------------------------------------------

function runPowerShell(script) {
    // Loaded lazily: the identity library is the one place that spawns it.
    const ident = require(path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'gate-identity.js'));
    return ident.runPowerShell(script);
}

/** Resource-Exhaustion-Detector 2004 events in [fromIso, toIso]: { status: found|none|failed|unsupported, times, why }. */
function memoryEvents(fromIso, toIso, env = process.env) {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return { status: 'failed', times: [], why: 'no attempt window' };
    if (env.AUTODEV_GATE_EVENTS_FIXTURE) {
        let fx;
        try { fx = JSON.parse(fs.readFileSync(env.AUTODEV_GATE_EVENTS_FIXTURE, 'utf8')); } catch (e) {
            return { status: 'failed', times: [], why: `the events fixture is unreadable (${e.code || e.message})` };
        }
        if (fx && fx.status === 'failed') return { status: 'failed', times: [], why: 'the events fixture says the query failed' };
        const times = (Array.isArray(fx && fx.times) ? fx.times : []).filter((t) => { const ms = Date.parse(t); return ms >= from && ms <= to; });
        return { status: times.length ? 'found' : 'none', times, why: 'events fixture' };
    }
    if (!WIN) return { status: 'unsupported', times: [], why: 'no Windows event log here' };
    const iso = (ms) => new Date(ms).toISOString();
    const script = [
        `$s = [datetime]::Parse('${iso(from)}', $null, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()`,
        `$t = [datetime]::Parse('${iso(to)}', $null, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()`,
        'try {',
        "  $e = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Resource-Exhaustion-Detector'; Id = 2004; StartTime = $s; EndTime = $t } -ErrorAction Stop)",
        "  ConvertTo-Json -Compress -InputObject @{ status = 'found'; times = @($e | ForEach-Object { $_.TimeCreated.ToUniversalTime().ToString('o') }) }",
        '} catch {',
        "  if ($_.FullyQualifiedErrorId -match 'NoMatchingEventsFound') { '{\"status\":\"none\",\"times\":[]}' }",
        "  else { ConvertTo-Json -Compress -InputObject @{ status = 'failed'; why = $_.Exception.Message } }",
        '}',
    ].join('\n');
    const r = runPowerShell(script);
    if (!r.ok) return { status: 'failed', times: [], why: r.why };
    try {
        const j = JSON.parse(r.stdout.trim());
        return { status: j.status, times: Array.isArray(j.times) ? j.times : [], why: j.why || null };
    } catch { return { status: 'failed', times: [], why: 'the event query printed no JSON' }; }
}

/** Commit headroom (CommitLimit - CommittedBytes): { status: ok|failed|unsupported, headroomBytes }. */
function commitHeadroom() {
    if (!WIN) return { status: 'unsupported', headroomBytes: null, why: 'no commit counters here' };
    const r = runPowerShell("$m = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop\nConvertTo-Json -Compress -InputObject @{ c = [double]$m.CommittedBytes; l = [double]$m.CommitLimit }");
    if (!r.ok) return { status: 'failed', headroomBytes: null, why: r.why };
    try {
        const j = JSON.parse(r.stdout.trim());
        if (!(j.l > 0)) return { status: 'failed', headroomBytes: null, why: 'CommitLimit read as zero' };
        return { status: 'ok', headroomBytes: j.l - j.c, why: null };
    } catch { return { status: 'failed', headroomBytes: null, why: 'the memory query printed no JSON' }; }
}

/** Free bytes on the volume holding `dir`: { status, freeBytes }. */
function diskFree(dir) {
    try {
        const s = fs.statfsSync(dir);
        return { status: 'ok', freeBytes: Number(s.bavail) * Number(s.bsize) };
    } catch (e) { return { status: 'failed', freeBytes: null, why: e.code || e.message }; }
}

/** Can `port` be bound on 127.0.0.1 now? { status: free|busy|failed }. */
function portState(port) {
    return new Promise((resolve) => {
        if (!Number.isInteger(port) || port <= 0 || port > 65535) { resolve({ status: 'failed', why: 'no port' }); return; }
        const srv = net.createServer();
        const done = (v) => { try { srv.close(); } catch { /* not listening */ } resolve(v); };
        srv.once('error', (e) => done(e.code === 'EADDRINUSE' || e.code === 'EACCES' ? { status: 'busy', why: e.code } : { status: 'failed', why: e.code || e.message }));
        srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => done({ status: 'free' }));
    });
}

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

/**
 * The recovery config, or { config: null, why } when absent or invalid. Every
 * field is required: a threshold nobody wrote down is not a threshold.
 */
function readRecoveryConfig(base, env = process.env) {
    const file = env.AUTODEV_GATE_RECOVERY || (/\.lock$/.test(base) ? base.replace(/\.lock$/, '.recovery.json') : `${base}.recovery.json`);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
        return { config: null, file, why: e.code === 'ENOENT' ? 'no recovery config, so no automatic re-admission' : `the recovery config is unreadable (${e.code})` };
    }
    let j;
    try { j = JSON.parse(raw); } catch { return { config: null, file, why: 'the recovery config is not JSON' }; }
    const need = ['diskFloorBytes', 'memoryHeadroomBytes', 'sampleIntervalMs', 'clearanceTimeoutMs', 'maxReadmissions'];
    const bad = need.filter((k) => !(typeof j[k] === 'number' && Number.isFinite(j[k]) && j[k] >= 0));
    if (bad.length) return { config: null, file, why: `the recovery config lacks a non-negative number for ${bad.join(', ')}` };
    return {
        config: {
            diskFloorBytes: j.diskFloorBytes, memoryHeadroomBytes: j.memoryHeadroomBytes,
            sampleIntervalMs: Math.max(50, j.sampleIntervalMs), clearanceTimeoutMs: j.clearanceTimeoutMs,
            maxReadmissions: Math.min(2, Math.floor(j.maxReadmissions)),
        },
        file, why: null,
    };
}

// ---------------------------------------------------------------------------
// Classifying one attempt.
// ---------------------------------------------------------------------------

/**
 * `v` is gate-lock's verdict for the attempt; `rec` the runner's record.
 * Returns { exit, finished, why, cause: null | { kind, evidence, port? } }.
 * Only a finished red attempt is examined; green, 2 and unfinished stand.
 */
async function classify({ v, rec, root, diskFloorBytes = DEFAULT_DISK_FLOOR, env = process.env }) {
    if (!v.finished || v.exit === 0 || v.exit === 2 || !rec) return { ...v, cause: null };
    if (CRASH_EXITS.has(v.exit)) {
        const end = new Date(Date.parse(rec.endUtc) + EVENT_SLACK_MS).toISOString();
        const ev = memoryEvents(rec.startUtc, end, env);
        const memoryConfirmed = ev.status === 'found';
        if (memoryConfirmed) {
            return { exit: 2, finished: true, cause: { kind: 'memory', evidence: `event 2004 at ${ev.times[0]}` },
                     why: `the chain exited ${v.exit} and the Resource-Exhaustion-Detector logged event 2004 at ${ev.times[0]}, inside the attempt` };
        }
        const said = ev.status === 'none' ? 'no event 2004 inside the attempt' : `the event log could not answer (${ev.why})`;
        return { ...v, cause: null, why: `${v.why}, a crash exit with ${said}, so it stands as a failure` };
    }
    const hits = Array.isArray(rec.infra) ? rec.infra : [];
    if (hits.some((h) => h.kind === 'ENOSPC')) {
        const d = diskFree(root);
        if (d.status === 'ok' && d.freeBytes < diskFloorBytes) {
            const step = hits.find((h) => h.kind === 'ENOSPC').step;
            return { exit: 2, finished: true, cause: { kind: 'disk', evidence: `${d.freeBytes} bytes free, under the ${diskFloorBytes} floor` },
                     why: `the chain exited ${v.exit} with ENOSPC${step ? ` in ${step}` : ''}, and ${d.freeBytes} bytes are free, under the ${diskFloorBytes}-byte floor` };
        }
    }
    for (const h of hits.filter((x) => x.kind === 'EADDRINUSE' && x.port)) {
        const p = await portState(h.port);
        if (p.status === 'busy') {
            return { exit: 2, finished: true, cause: { kind: 'port', port: h.port, evidence: `port ${h.port} still cannot be bound` },
                     why: `the chain exited ${v.exit} with EADDRINUSE on port ${h.port}${h.step ? ` in ${h.step}` : ''}, and the port is still taken` };
        }
    }
    return { ...v, cause: null };
}

/** One clearance sample for `cause`: { healthy, why }. */
async function sample(cause, cfg, root, sinceIso, env = process.env) {
    if (cause.kind === 'disk') {
        const d = diskFree(root);
        return { healthy: d.status === 'ok' && d.freeBytes >= cfg.diskFloorBytes, why: d.status === 'ok' ? `${d.freeBytes} bytes free` : d.why };
    }
    if (cause.kind === 'port') {
        const p = await portState(cause.port);
        return { healthy: p.status === 'free', why: `port ${cause.port} ${p.status}` };
    }
    if (cause.kind === 'memory') {
        const h = commitHeadroom();
        const ev = memoryEvents(sinceIso, new Date().toISOString(), env);
        const room = h.status === 'ok' ? h.headroomBytes >= cfg.memoryHeadroomBytes : false;
        return { healthy: room && ev.status === 'none', why: `headroom ${h.status === 'ok' ? h.headroomBytes : h.why}, events ${ev.status}` };
    }
    return { healthy: false, why: `no probe for ${cause.kind}` };
}

/**
 * Waits for two healthy samples in a row, sampleIntervalMs apart, within
 * clearanceTimeoutMs. { cleared, samples, why }.
 */
async function awaitClearance(cause, cfg, root, sinceIso, { env = process.env, log = () => {} } = {}) {
    const until = Date.now() + cfg.clearanceTimeoutMs;
    let healthy = 0;
    let since = sinceIso;
    const samples = [];
    for (;;) {
        const at = new Date().toISOString();
        const s = await sample(cause, cfg, root, since, env);
        samples.push({ at, ...s });
        since = at;
        healthy = s.healthy ? healthy + 1 : 0;
        if (healthy >= 2) return { cleared: true, samples, why: `two healthy samples (${s.why})` };
        if (Date.now() + cfg.sampleIntervalMs > until) return { cleared: false, samples, why: `not clear within ${cfg.clearanceTimeoutMs} ms (last: ${s.why})` };
        log(`gate-lock: waiting for clearance (${cause.kind}): ${s.why}`);
        await new Promise((r) => setTimeout(r, cfg.sampleIntervalMs));
    }
}

// ---------------------------------------------------------------------------
// The re-admission counter, per worktree and head, outliving the process.
// ---------------------------------------------------------------------------

function counterFile(runsDir, worktree, head) {
    const key = crypto.createHash('sha256').update(`${worktree}|${head}`).digest('hex').slice(0, 16);
    return path.join(runsDir, `readmit-${key}.json`);
}

/** The re-admissions already spent: a malformed counter reads as the limit, never as zero. */
function readmissionsSpent(file) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Number.isInteger(j.count) && j.count >= 0 ? j.count : Infinity;
    } catch (e) { return e.code === 'ENOENT' ? 0 : Infinity; }
}

function spendReadmission(file, worktree, head) {
    const n = readmissionsSpent(file);
    const next = (Number.isFinite(n) ? n : 0) + 1;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ count: next, worktree, head, lastUtc: new Date().toISOString() })}\n`);
    fs.renameSync(tmp, file);
    return next;
}

module.exports = {
    CRASH_EXITS, DEFAULT_DISK_FLOOR, createScanner, memoryEvents, commitHeadroom, diskFree, portState,
    readRecoveryConfig, classify, sample, awaitClearance, counterFile, readmissionsSpent, spendReadmission,
};

if (require.main === module) {
    console.log('usage: node tooling/gate-recovery.js --help\n\nA library for tooling/gate-lock.js: classifies a failed full-gate attempt as\nthe code or the machine (memory, disk, port) from evidence, and decides when\nthe gate may queue again. Re-admission needs full-gate.recovery.json.');
}
