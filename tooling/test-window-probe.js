#!/usr/bin/env node
'use strict';
// test-window-probe.js: every scorecard window probe fails on a gap day, fails on a bad
// record or a short total, and passes only on 14 complete days.
//
// Each case builds a config dir by hand in the OS temp dir (never derived from the specs
// under test), spawns the real CLI, and reads the exit status and the exact line that
// should carry the verdict: `gap <day>` for the planted day, `violation ...` for the
// planted record, `short ...` for the planted total. A red exit alone proves nothing.
// The clean control of each spec is matched with the manifest's own expect pattern, so
// the wiring in docs/scorecard-criteria.json is graded too.
//
// Prints one summary line:
//   specs=17 gap_planted=FAIL bad_record=FAIL clean_pass=9 no_writer=8 unreadable=EXIT2
// and sets a nonzero exitCode when any case fails.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(__dirname, 'window-probe.js');
const NOW = '2026-11-20T12:00:00Z';
// The 14 complete days before NOW, written out by hand rather than computed by the engine.
const DAYS = ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12',
    '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'];
// The shipped modules that require ledger-lock.js, by hand. The spec's own list and a grep of
// the plugins must both equal it.
const LOCK_INVENTORY = ['hooks~peer-send-ledger.js', 'scripts~ask-queue.js', 'scripts~brain-clock.js', 'scripts~execution-budget.js',
    'scripts~production-signals.js', 'scripts~radar-learning.js', 'scripts~watch-panels.js', 'scripts~worker-reconcile.js'];
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scorecard-criteria.json'), 'utf8'));
const expectOf = (id) => new RegExp(manifest.aspects.flatMap((a) => a.criteria).find((c) => c.id === id).expect, 'm');

let ran = 0;
let failed = 0;
function check(name, cond, detail) {
    ran++;
    if (cond) { console.log(`ok ${name}`); return; }
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${String(detail).slice(-900)}` : ''}`);
}

const GIB = 1024 * 1024 * 1024;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'window-probe-'));
let seq = 0;
function home() { const h = path.join(tmpRoot, `h${seq++}`); fs.mkdirSync(path.join(h, 'autodev'), { recursive: true }); return h; }
function write(h, rel, body) { const f = path.join(h, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
function clock(h, skip = []) {
    const rows = [];
    for (const d of [...DAYS, '2026-11-20']) {
        if (skip.includes(d)) continue;
        for (let m = 0; m < 24 * 60; m += 5) rows.push({ at: new Date(Date.parse(`${d}T00:00:00Z`) + m * 60000).toISOString(), status: 'ok' });
    }
    write(h, 'autodev/brain-clock/passes.jsonl', jsonl(rows));
}
function probe(id, h, repo = ROOT) {
    const r = spawnSync(process.execPath, [PROBE, id, '--home', h, '--repo', repo, '--now', NOW], { encoding: 'utf8', windowsHide: true });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// ---------------------------------------------------------------------------
// Fixtures, one builder per spec. opts: { gap: day, bad: day }.
// ---------------------------------------------------------------------------

function gitRepo() {
    const repo = path.join(tmpRoot, 'repo');
    const g = (args, env = {}) => {
        const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
    };
    fs.mkdirSync(repo, { recursive: true });
    g(['init', '-q']);
    g(['config', 'user.email', 'fixture@example.invalid']);
    g(['config', 'user.name', 'fixture']);
    g(['config', 'commit.gpgsign', 'false']);
    const heads = {};
    for (const d of DAYS) {
        fs.writeFileSync(path.join(repo, 'day.txt'), d);
        g(['add', 'day.txt']);
        const when = `${d}T10:00:00Z`;
        g(['commit', '-q', '-m', d], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
        heads[d] = g(['rev-parse', 'HEAD']);
    }
    g(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    return { repo, heads };
}
let REPO = null;

const STEPS = 13;
function evidence({ red = 0, tail = true } = {}) {
    return Array.from({ length: STEPS }, (_, i) => {
        const index = i + 1;
        const status = !red || index < red ? 'pass' : index === red ? 'fail' : 'not-run';
        return { index, of: STEPS, step: `step ${index}`, status, exit: status === 'fail' ? 1 : status === 'pass' ? 0 : null, signal: null,
            tail: status === 'fail' && tail ? { text: 'the failing output', bytes: 18, truncated: false } : null };
    });
}
function gateRun(h, day, n, rec) {
    const runId = `${day.replace(/-/g, '')}T1100${String(n).padStart(2, '0')}000Z-1-x${n}`;
    write(h, `autodev/locks/full-gate.runs/${runId}.json`, JSON.stringify({ schema: 1, runId, attempts: [{ attempt: 1, exit: rec.exit, finished: true, record: { runId, startUtc: `${day}T11:00:00.000Z`, endUtc: `${day}T11:30:00.000Z`, ...rec } }] }));
}

// `lifecycle.js snapshot` run once against an empty root in the temp dir, and its row read back.
let snapshotRow = null;
function realSnapshot() {
    if (snapshotRow) return snapshotRow;
    const dir = path.join(tmpRoot, 'lifecycle-real');
    fs.mkdirSync(path.join(dir, 'root'), { recursive: true });
    const cfgFile = path.join(dir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ stateDir: path.join(dir, 'state'), roots: [path.join(dir, 'root')], reportPaths: [] }));
    // The volume comes through the writer's own seam, so the trend reads fixed numbers, not this machine's disk.
    const vol = path.join(dir, 'volume.json');
    fs.writeFileSync(vol, JSON.stringify({ usedBytes: 400 * GIB, totalBytes: 1000 * GIB }));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'lifecycle.js'), 'snapshot', '--config', cfgFile],
        { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, AUTODEV_LIFECYCLE_PAGEFILE_BYTES: '0', AUTODEV_LIFECYCLE_VOLUME_FILE: vol } });
    const rows = fs.readFileSync(path.join(dir, 'state', 'snapshots.jsonl'), 'utf8').split('\n').filter(Boolean);
    if (r.status !== 0 || rows.length !== 1) throw new Error(`lifecycle.js snapshot wrote ${rows.length} rows, exit ${r.status}: ${r.stderr}`);
    snapshotRow = JSON.parse(rows[0]);
    return snapshotRow;
}
// One row from the real `capacity.js observe`, nothing reserved, for the observe log's field names.
let observeRow = null;
function realObserve() {
    if (observeRow) return observeRow;
    const dir = path.join(tmpRoot, 'capacity-real');
    fs.mkdirSync(dir, { recursive: true });
    const probeFile = path.join(dir, 'probe.json');
    fs.writeFileSync(probeFile, JSON.stringify({ diskFreeBytes: 600 * GIB, diskTotalBytes: 1000 * GIB, commitFreeBytes: 40 * GIB }));
    const env = { ...process.env, AUTODEV_GATE_LOCK_PATH: path.join(dir, 'full-gate.lock'), AUTODEV_CAPACITY_PROBE_FILE: probeFile };
    delete env.AUTODEV_CAPACITY_CONFIG;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'capacity.js'), 'observe'], { encoding: 'utf8', windowsHide: true, timeout: 60000, env });
    const rows = fs.readFileSync(path.join(dir, 'full-gate.capacity-observe.jsonl'), 'utf8').split('\n').filter(Boolean);
    if (r.status !== 0 || rows.length !== 1) throw new Error(`capacity.js observe wrote ${rows.length} rows, exit ${r.status}: ${r.stderr}`);
    observeRow = JSON.parse(rows[0]);
    return observeRow;
}

// One row from the real restore-drill.js, on a stand-in profile holding two clock state files.
let drillRow = null;
function realDrill() {
    if (drillRow) return drillRow;
    const claude = path.join(tmpRoot, 'drill-real', 'claude');
    fs.mkdirSync(path.join(claude, 'autodev', 'brain-clock'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'autodev', 'brain-clock', 'state-meta.json'), JSON.stringify({ schema: 1 }));
    fs.writeFileSync(path.join(claude, 'autodev', 'brain-clock', 'last.json'), '{}');
    const env = { ...process.env, BRAIN_CLOCK_CLAUDE_DIR: claude };
    for (const k of ['AUTODEV_RUNTIME_DIR', 'ASK_QUEUE_DIR', 'ASK_QUEUE_BOARD']) delete env[k];
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'restore-drill.js')], { encoding: 'utf8', windowsHide: true, timeout: 120000, env });
    const rows = fs.readFileSync(path.join(claude, 'autodev', 'windows', 'restore-drills.jsonl'), 'utf8').split('\n').filter(Boolean);
    if (r.status !== 0 || rows.length !== 1) throw new Error(`restore-drill.js wrote ${rows.length} rows, exit ${r.status}: ${r.stdout}${r.stderr}`);
    drillRow = JSON.parse(rows[0]);
    return drillRow;
}

// One day file from the real host-uptime.js, on an empty event log, for its field names.
let hostUpRow = null;
function realHostUp() {
    if (hostUpRow) return hostUpRow;
    const claude = path.join(tmpRoot, 'host-up-real', 'claude');
    const events = path.join(tmpRoot, 'host-up-real', 'events.xml');
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(events, '');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'host-uptime.js'), '--json'], { encoding: 'utf8', windowsHide: true, timeout: 60000,
        env: { ...process.env, BRAIN_CLOCK_CLAUDE_DIR: claude, AUTODEV_HOST_EVENTS_FILE: events } });
    const rows = JSON.parse(r.stdout);
    if (r.status !== 0 || rows.length !== 15) throw new Error(`host-uptime.js wrote ${rows.length} days, exit ${r.status}: ${r.stderr}`);
    hostUpRow = rows[0];
    return hostUpRow;
}
const hostUp = (h, upOf) => { const real = realHostUp(); for (const d of DAYS) write(h, `autodev/windows/host-up/${d}.json`, JSON.stringify({ ...real, day: d, upMs: upOf(d), downMs: 86400000 - upOf(d) })); };

const FIX = {
    'gate-window': (h, o) => {
        DAYS.forEach((d, i) => { if (d !== o.gap) gateRun(h, d, i, { exit: 0, evidence: evidence(), head: REPO.heads[d] }); });
        if (o.bad) gateRun(h, o.bad, 90, { exit: 1, evidence: evidence({ red: 4, tail: false }), head: REPO.heads[o.bad] });
        if (o.control) gateRun(h, o.control, 91, { exit: 1, evidence: evidence({ red: 4, tail: true }), head: REPO.heads[o.control] });
    },
    'release-window': (h, o) => write(h, 'autodev/windows/release-protection.jsonl', jsonl(DAYS.filter((d) => d !== o.gap).map((d) => ({
        at: `${d}T06:00:00Z`, repo: 'owner/name', error: null,
        fields: { direct_write: d === o.bad ? 'ALLOWED' : 'DENIED', tag_replace: 'DENIED', tag_delete: 'DENIED', authorized_publish: 'PASS' } })))),
    'authority-window': (h, o) => write(h, 'autodev/headless-workers.json', JSON.stringify({ version: 1, records: DAYS.filter((d) => d !== o.gap).map((d) => ({
        code: `w-${d}`, startedAt: `${d}T09:00:00Z`, permissionMode: d === o.bad ? 'bypassPermissions' : 'dontAsk', profile: 'builder' })) })),
    'hook-window': (h, o) => write(h, 'autodev/windows/hook-wall.jsonl', jsonl(DAYS.filter((d) => d !== o.gap).map((d) => ({
        at: `${d}T09:00:00Z`, event: 'PreToolUse', p95Ms: d === o.bad ? 400 : 40, budgetMs: 100 })))),
    'worker-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        write(h, 'autodev/execution-budget.json', JSON.stringify({ schema: 1, attempts: Object.fromEntries(DAYS.filter((d) => d !== o.gap).map((d) => [d, {
            attemptId: `a-${d}`, kind: 'worker', state: 'settled', reservedAt: `${d}T08:00:00.000Z`, startedAt: `${d}T08:00:00.000Z`,
            wallMs: 3600000, settledAt: d === o.bad ? `${d}T09:30:00.000Z` : `${d}T09:02:00.000Z`, ceilings: { wallMs: 21600000 } }])) }));
    },
    // The gap day holds only a resumed start, which must not count as a fresh session.
    'instruction-window': (h, o) => write(h, 'logs/instruction-envelope.jsonl', jsonl(DAYS.map((d) => ({
        at: `${d}T09:00:00Z`, sessionId: `s-${d}`, source: d === o.gap ? 'resume' : 'startup', inside: d !== o.bad,
        rulesTotal: d === o.bad ? 33000 : 30000, budget: 32000, envelopeTotal: 38000, missing: 0, conflicts: 0 })))),
    'skill-window': (h, o) => write(h, 'autodev/frontier/runs.jsonl', jsonl(DAYS.filter((d) => d !== o.gap).map((d) => ({
        run: `r-${d}`, startedAt: `${d}T09:00:00Z`, finishedAt: `${d}T09:10:00Z`, routedTo: 'audit', pass: d !== o.bad })))),
    // The real row shape: sync stamps `at` the next morning, the task's day is its last attempt.
    'cost-window': (h, o) => write(h, 'autodev/delivery/outcomes.jsonl', jsonl(DAYS.filter((d) => d !== o.gap).flatMap((d) => [
        { type: 'attempt', at: `${d}T23:30:00Z`, key: `t-${d}@1`, taskId: `t-${d}`, costUsd: null },
        { type: 'outcome', at: `${d}T23:30:00Z`, taskId: `t-${d}`, lastAttemptAt: `${d}T09:00:00Z`, accepted: true, costUsd: d === o.bad ? null : 4.5 },
    ]))),
    'acceptance-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        write(h, 'autodev/brain-judge/judgements.jsonl', jsonl(DAYS.map((d) => ({ at: `${d}T09:00:00Z`, taskId: `t-${d}`, mode: 'live', decision: 'accept', applied: d !== o.bad }))));
    },
    'queue-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        write(h, 'autodev/worker-reconcile/events.jsonl', jsonl(DAYS.map((d) => ({ at: `${d}T09:00:00Z`, taskId: `t-${d}`, outcome: d === o.bad ? 'UNKNOWN' : 'SETTLED' }))));
    },
    'visibility-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        write(h, 'autodev/owner-asks/ledger.jsonl', jsonl(DAYS.flatMap((d) => [
            { at: `${d}T09:00:00Z`, type: 'raised', key: `k-${d}` },
            { at: `${d}T09:00:01Z`, type: 'os-submitted', key: `k-${d}`, via: 'toast', exit: d === o.bad ? 1 : 0 },
            ...(o.noAck ? [] : [{ at: `${d}T10:00:00Z`, type: 'receipt', key: `k-${d}`, by: 'owner', how: 'clicked' }]),
        ])));
    },
    // Every inventoried writer marks every day. The bad day adds a writer the inventory lacks.
    'locking-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        for (const d of DAYS) for (const w of LOCK_INVENTORY) write(h, `autodev/windows/lock-writers/${d}/${w}@9.0.0`, '');
        if (o.bad) write(h, `autodev/windows/lock-writers/${o.bad}/scripts~rogue.js@9.0.0`, '');
    },
    'learning-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        write(h, 'autodev/frontier/runs.jsonl', jsonl(DAYS.flatMap((d) => Array.from({ length: 8 }, (_, i) => ({
            run: `r-${d}-${i}`, startedAt: `${d}T0${i}:00:00Z`, arm: 'A', exit: d === o.bad && i === 0 ? 1 : 0 })))));
    },
    'delivery-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        const tasks = DAYS.flatMap((d) => [0, 1, 2].map((i) => ({ taskId: `t-${d}-${i}`, startedAt: `${d}T0${i + 1}:00:00Z` })));
        const kept = o.short ? tasks.slice(0, 29) : tasks;
        write(h, 'autodev/unattended-workers.json', JSON.stringify({ version: 1, records: kept }));
        write(h, 'autodev/brain-judge/judgements.jsonl', jsonl(kept.map((t) => ({ at: t.startedAt.replace(/T0/, 'T1'), taskId: t.taskId, mode: 'live', decision: 'accept', applied: true }))));
    },
    'capacity-window': (h, o) => {
        // One row from the real writer, re-dated per day, so the fixture has the writer's field names.
        const real = realSnapshot();
        const growth = o.growth || 0;
        write(h, 'autodev/lifecycle/snapshots.jsonl', jsonl(DAYS.filter((d) => d !== o.gap).map((d, i) => ({ ...real, takenUtc: `${d}T09:00:00.000Z`,
            volume: { ...real.volume, usedBytes: real.volume.usedBytes + i * growth } }))));
        const obs = realObserve();
        write(h, 'autodev/locks/full-gate.capacity-observe.jsonl', jsonl(DAYS.map((d) => ({ ...obs, at: `${d}T10:00:00.000Z`,
            ...(d === o.breach ? { reservations: 1, classes: ['gate'], breach: true, why: 'disk at X 5.0 GiB free, under the 64.0 GiB reserve' } : {}),
            ...(d === o.unknown ? { unknown: 'disk at X (the disk probe threw)' } : {}) }))));
        write(h, 'autodev/lifecycle/journal.jsonl', jsonl(o.bad ? [{ utc: `${o.bad}T09:00:00Z`, op: 'remove', state: 'done', path: path.join(os.homedir(), '.claude', 'projects', 'x') }] : []));
    },
    'owner-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        write(h, 'autodev/owner-asks/ledger.jsonl', jsonl(DAYS.map((d) => ({ at: `${d}T09:00:00Z`, type: 'owner-time-start' }))));
    },
    'recovery-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        const real = realDrill();
        write(h, 'autodev/windows/restore-drills.jsonl', jsonl(o.noDrill ? [] : DAYS.map((d) => ({ ...real, at: `${d}T03:00:00.000Z`,
            ...(d === o.bad ? { ok: false, why: '1 delivered intent(s) were no longer delivered (ask-1)' } : {}),
            ...(d === o.liar ? { intentsKept: 0, intentsDelivered: 1 } : {}) }))));
    },
};

// The specs that can pass on records the harness writes today, and those that must fail
// by name until a writer exists. Written by hand, so narrowing a spec moves a case red.
const PASSABLE = ['gate-window', 'release-window', 'worker-window', 'instruction-window', 'visibility-window', 'locking-window', 'delivery-window',
    'capacity-window', 'recovery-window'];
const NO_WRITER = ['authority-window', 'hook-window', 'skill-window', 'cost-window', 'acceptance-window',
    'queue-window', 'learning-window', 'owner-window'];
// The records a planted bad day must produce, by the line that names it.
const BAD_LINE = {
    'gate-window': /^violation 2026-11-09T11:00:00.000Z .*failed step 4 \(step 4\) has no output tail$/m,
    'release-window': /^violation 2026-11-09T06:00:00Z direct_write=ALLOWED/m,
    'authority-window': /^violation 2026-11-09T09:00:00Z w-2026-11-09: ran bypassPermissions/m,
    'hook-window': /^violation 2026-11-09T09:00:00Z PreToolUse p95 400 ms, budget 100 ms$/m,
    'worker-window': /^violation 2026-11-09T08:00:00.000Z a-2026-11-09: settled 30 min after it exited/m,
    'instruction-window': /^violation 2026-11-09T09:00:00Z .*session s-2026-1 started outside the envelope \(rules 33000 of 32000, 0 missing, 0 conflicts\)$/m,
    'skill-window': /^violation 2026-11-09T09:10:00Z r-2026-11-09: routed audit, pass false$/m,
    'cost-window': /^violation 2026-11-09T09:00:00Z t-2026-11-09: no cost$/m,
    'acceptance-window': /^violation 2026-11-09T09:00:00Z t-2026-11-09: an accept that did not apply/m,
    'queue-window': /^violation 2026-11-09T09:00:00Z t-2026-11-09: UNKNOWN/m,
    'visibility-window': /^violation 2026-11-09T09:00:01Z k-2026-11-09: delivery via toast exited 1$/m,
    'learning-window': /^violation 2026-11-09T00:00:00Z r-2026-11-09-0: exit 1$/m,
    'locking-window': /^violation 2026-11-09T00:00:00Z scripts~rogue\.js@9\.0\.0 took a lock but is not in the inventory$/m,
    'capacity-window': /^violation 2026-11-09T09:00:00Z removed .*protected class/m,
    'recovery-window': /^violation 2026-11-09T03:00:00.000Z restore drill failed: 1 delivered intent\(s\) were no longer delivered \(ask-1\)$/m,
};
const GAP = '2026-11-12';
const BAD = '2026-11-09';

const counts = { gap: 0, bad: 0, clean: 0, noWriter: 0 };
try {
    REPO = gitRepo();
    const specs = require('./window-specs.js').SPECS.map((s) => s.id);
    check('every manifest window criterion has a spec and a fixture',
        manifest.aspects.flatMap((a) => a.criteria).filter((c) => c.kind === 'operational').every((c) => specs.includes(c.id) && FIX[c.id]),
        specs.join(','));
    check('the hand-written lists cover all 17 specs, once each',
        [...PASSABLE, ...NO_WRITER].sort().join() === specs.slice().sort().join() && specs.length === 17, specs.length);

    for (const id of specs) {
        // Clean control.
        const clean = home();
        FIX[id](clean, {});
        const c = probe(id, clean, REPO.repo);
        if (PASSABLE.includes(id)) {
            const okClean = c.status === 0 && expectOf(id).test(c.out) && !/^gap /m.test(c.out);
            check(`${id}: 14 complete clean days pass and match the manifest expect`, okClean, c.out);
            if (okClean) counts.clean++;
        } else {
            const okNo = c.status === 1 && /^short no writer records /m.test(c.out) && !expectOf(id).test(c.out);
            check(`${id}: clean days still fail by name, because no writer records what the needs asks`, okNo, c.out);
            if (okNo) counts.noWriter++;
        }
        check(`${id}: the clean control names no gap and no violation`, !/^gap |^violation /m.test(c.out), c.out);

        // Planted gap day: the exact day is named, and the window does not match its expect.
        const g = home();
        FIX[id](g, { gap: GAP });
        const gr = probe(id, g, REPO.repo);
        const okGap = gr.status === 1 && new RegExp(`^gap ${GAP}$`, 'm').test(gr.out) && !expectOf(id).test(gr.out);
        check(`${id}: a planted gap day ${GAP} is named and fails the window`, okGap, gr.out);
        if (okGap) counts.gap++;

        // Planted bad record.
        if (BAD_LINE[id]) {
            const b = home();
            FIX[id](b, { bad: BAD });
            const br = probe(id, b, REPO.repo);
            const okBad = br.status === 1 && BAD_LINE[id].test(br.out) && !expectOf(id).test(br.out);
            check(`${id}: a planted bad record on ${BAD} is named and fails the window`, okBad, br.out);
            if (okBad) counts.bad++;
        }
    }

    // A1: a red run WITH complete evidence is not a violation (the control for the tail plant).
    const ctl = home();
    FIX['gate-window'](ctl, { control: BAD });
    const cr = probe('gate-window', ctl, REPO.repo);
    check('gate-window control: a red step that carries its exit and tail is complete evidence', cr.status === 0 && !/^violation /m.test(cr.out), cr.out);
    // A1: a merge day whose only gate ran on another tree is a gap, not covered.
    const other = home();
    FIX['gate-window'](other, { gap: GAP });
    gateRun(other, GAP, 77, { exit: 0, evidence: evidence(), head: REPO.heads[DAYS[0]] });
    const orr = probe('gate-window', other, REPO.repo);
    check('gate-window: a gate on a tree origin/main did not take that day leaves the merge day a gap', orr.status === 1 && new RegExp(`^gap ${GAP}$`, 'm').test(orr.out), orr.out);
    // A1: a gate-fast run record. Clean and complete covers the merge day; dirty never does;
    // a failed touched suite with no tail is incomplete evidence.
    const fastRun = (h, day, n, over = {}) => write(h, `autodev/locks/fast-gate.runs/${day.replace(/-/g, '')}T1200${n}-1.json`, JSON.stringify({
        kind: 'gate-fast', runId: `${day}-${n}`, head: REPO.heads[day], dirty: false, startUtc: `${day}T12:00:00.000Z`, endUtc: `${day}T12:05:00.000Z`, exit: 0,
        evidence: [{ index: 1, of: 1, step: 'check:agents-md', status: 'pass', exit: 0, signal: null, ms: 900, tail: { text: '' } }],
        deferred: ['test'],
        touched: { base: 'b'.repeat(40), files: 1, suites: 1, selected: [{ suite: 'tooling/test-x.js', because: ['x.js'] }],
            evidence: [{ index: 1, of: 1, step: 'tooling/test-x.js', status: 'pass', exit: 0, signal: null, ms: 900, tail: { text: '' } }] },
        ...over }));
    const fh = home();
    FIX['gate-window'](fh, { gap: GAP });
    fastRun(fh, GAP, 1);
    const fr = probe('gate-window', fh, REPO.repo);
    check('gate-window: a clean gate-fast record on the landed tree covers the merge day', fr.status === 0 && expectOf('gate-window').test(fr.out) && !/^gap /m.test(fr.out), fr.out);
    const dh = home();
    FIX['gate-window'](dh, { gap: GAP });
    fastRun(dh, GAP, 1, { dirty: true });
    const dr = probe('gate-window', dh, REPO.repo);
    check('gate-window: a dirty gate-fast record never covers the merge day', dr.status === 1 && new RegExp(`^gap ${GAP}$`, 'm').test(dr.out), dr.out);
    const th = home();
    FIX['gate-window'](th, {});
    fastRun(th, BAD, 2, { exit: 1, touched: { base: 'b'.repeat(40), files: 1, suites: 1, selected: [{ suite: 'tooling/test-x.js', because: ['x.js'] }],
        evidence: [{ index: 1, of: 1, step: 'tooling/test-x.js', status: 'fail', exit: 1, signal: null, ms: 900, tail: null }] } });
    const ftr = probe('gate-window', th, REPO.repo);
    check('gate-window: a failed touched suite with no tail is a violation', ftr.status === 1 && new RegExp(`^violation ${BAD}T12:00:00.000Z fast ${BAD}-2: tooling/test-x\\.js failed with no output tail$`, 'm').test(ftr.out), ftr.out);
    // A6: a sibling profile must start a fresh session every day until it is retired by a dated
    // marker with a reason. A marker it outlives (a fresh session on or after retiredAt) is void.
    const sibling = (h, days, marker) => {
        const b = `${h}-b`;
        write(b, 'logs/instruction-envelope.jsonl', jsonl(days.map((d) => ({ at: `${d}T10:00:00Z`, sessionId: `b-${d}`, source: 'startup',
            inside: true, rulesTotal: 30000, budget: 32000, envelopeTotal: 38000, missing: 0, conflicts: 0 }))));
        if (marker) write(b, 'logs/instruction-envelope.retired.json', JSON.stringify(marker));
    };
    const retireCase = (days, marker) => { const h = home(); FIX['instruction-window'](h, {}); sibling(h, days, marker); return probe('instruction-window', h, REPO.repo); };
    const bDays = DAYS.slice(0, 3);
    const unretired = retireCase(bDays);
    check('instruction-window: a sibling profile that stops starting sessions leaves its days a gap',
        unretired.status === 1 && new RegExp(`^gap ${DAYS[3]}$`, 'm').test(unretired.out), unretired.out);
    const retired = retireCase(bDays, { retiredAt: DAYS[3], reason: 'login expired' });
    check('instruction-window: a sibling retired from the day after its last session is not required from then',
        retired.status === 0 && expectOf('instruction-window').test(retired.out) && !/^gap /m.test(retired.out), retired.out);
    const lateRetire = retireCase(bDays, { retiredAt: DAYS[5], reason: 'login expired' });
    check('instruction-window: days before retiredAt are still required of the sibling',
        lateRetire.status === 1 && new RegExp(`^gap ${DAYS[3]}$`, 'm').test(lateRetire.out) && !new RegExp(`^gap ${DAYS[5]}$`, 'm').test(lateRetire.out), lateRetire.out);
    const outlived = retireCase([...bDays, DAYS[8]], { retiredAt: DAYS[3], reason: 'login expired' });
    check('instruction-window: a marker the sibling outlives is void, so its missing days stay gaps',
        outlived.status === 1 && new RegExp(`^gap ${DAYS[3]}$`, 'm').test(outlived.out), outlived.out);
    const noReason = retireCase(bDays, { retiredAt: DAYS[3] });
    check('instruction-window: a marker with no reason is ignored',
        noReason.status === 1 && new RegExp(`^gap ${DAYS[3]}$`, 'm').test(noReason.out), noReason.out);
    // A12: the inventory matches a grep of the plugins, and a writer never seen is a short total.
    const plugins = path.join(ROOT, 'plugins');
    const requirers = [];
    for (const p of fs.readdirSync(plugins)) for (const dir of ['scripts', 'hooks']) {
        let names = [];
        try { names = fs.readdirSync(path.join(plugins, p, dir)); } catch { continue; }
        for (const n of names) if (n.endsWith('.js') && n !== 'ledger-lock.js'
            && /require\(['"]\.{1,2}\/(?:scripts\/)?ledger-lock\.js['"]\)/.test(fs.readFileSync(path.join(plugins, p, dir, n), 'utf8'))) requirers.push(`${dir}~${n}`);
    }
    const specList = require('./window-specs.js').LOCK_WRITERS;
    check('locking-window: the inventory equals every shipped module that requires ledger-lock.js',
        requirers.sort().join() === LOCK_INVENTORY.slice().sort().join() && specList.slice().sort().join() === LOCK_INVENTORY.slice().sort().join(), `grep ${requirers.join(',')} spec ${specList.join(',')}`);
    const lw = home();
    clock(lw, []);
    for (const d of DAYS) for (const w of LOCK_INVENTORY.filter((x) => x !== 'scripts~radar-learning.js')) write(lw, `autodev/windows/lock-writers/${d}/${w}@9.0.0`, '');
    write(lw, `autodev/windows/lock-writers/${DAYS[2]}/scripts~radar-learning.js@unknown`, '');
    const lr = probe('locking-window', lw, REPO.repo);
    check('locking-window: a writer seen only with no version is short by name', lr.status === 1
        && /^short 7 of 8 inventoried writers took a lock on the installed layer, not scripts~radar-learning\.js$/m.test(lr.out)
        && /^violation 2026-11-08T00:00:00Z scripts~radar-learning\.js@unknown took a lock with no plugin version$/m.test(lr.out), lr.out);
    // A15: the writers' field names, a breach, an unknown probe day, and the trend.
    const ro = realObserve();
    check('capacity-window: the real observe row carries the fields the spec reads', ['at', 'breach', 'unknown', 'reservations', 'why'].every((k) => k in ro) && ro.breach === false && ro.unknown === null
        && Number.isFinite(realSnapshot().volume.usedBytes) && Number.isFinite(realSnapshot().volume.totalBytes), JSON.stringify(ro));
    const cb = home();
    FIX['capacity-window'](cb, { breach: BAD });
    const cbr = probe('capacity-window', cb, REPO.repo);
    check('capacity-window: an admission breach is a violation naming its numbers', cbr.status === 1
        && /^violation 2026-11-09T10:00:00.000Z admission breach with 1 reservation\(s\): disk at X 5\.0 GiB free, under the 64\.0 GiB reserve$/m.test(cbr.out), cbr.out);
    const cu = home();
    FIX['capacity-window'](cu, { unknown: GAP });
    const cur = probe('capacity-window', cu, REPO.repo);
    check('capacity-window: a day whose only observation is unknown is a gap, not covered', cur.status === 1 && new RegExp(`^gap ${GAP}$`, 'm').test(cur.out) && !/^violation /m.test(cur.out), cur.out);
    const ct = home();
    FIX['capacity-window'](ct, { growth: 30 * GIB });
    const ctr = probe('capacity-window', ct, REPO.repo);
    check('capacity-window: a volume filling 30 GiB a day is a short trend total, with no violation', ctr.status === 1
        && /^short volume \+30\.0 GiB\/day over 14 days leaves -210\.0 GiB free in 14 days, under the 64\.0 GiB reserve$/m.test(ctr.out) && !/^violation /m.test(ctr.out), ctr.out);
    const cs = home();
    FIX['capacity-window'](cs, { growth: 5 * GIB });
    const csr = probe('capacity-window', cs, REPO.repo);
    check('capacity-window: 5 GiB a day on 600 GiB free stays inside the reserve', csr.status === 0 && /^window=capacity-window covered=14\/14 violations=0 /m.test(csr.out), csr.out);
    // A17: the real drill row, a window with no drill, and a row marked passed against its own numbers.
    const rd = realDrill();
    check('recovery-window: the real drill row passes with the fields the spec reads', rd.ok === true && rd.files === 2 && rd.intentsDelivered === 0 && rd.intentsKept === 0
        && Number.isFinite(rd.durationMs) && rd.why === null, JSON.stringify(rd));
    const rn = home();
    FIX['recovery-window'](rn, { noDrill: true });
    const rnr = probe('recovery-window', rn, REPO.repo);
    check('recovery-window: no drill in the window is a short total', rnr.status === 1 && /^short 0 passing restore drill\(s\) in the window, needs 1$/m.test(rnr.out), rnr.out);
    const rl = home();
    FIX['recovery-window'](rl, { liar: BAD });
    const rlr = probe('recovery-window', rl, REPO.repo);
    check('recovery-window: a row marked passed that lost an intent is a violation', rlr.status === 1
        && /^violation 2026-11-09T03:00:00.000Z restore drill failed: marked passed with 0 of 1 intents kept in \d+ ms$/m.test(rlr.out), rlr.out);
    // A11 and A14 totals.
    const na = home();
    FIX['visibility-window'](na, { noAck: true });
    const nr = probe('visibility-window', na, REPO.repo);
    check('visibility-window: no owner receipt in the window is a short total', nr.status === 1 && /^short 0 owner acknowledgments/m.test(nr.out), nr.out);
    const sh = home();
    FIX['delivery-window'](sh, { short: true });
    const sr = probe('delivery-window', sh, REPO.repo);
    check('delivery-window: 29 tasks is short of 30', sr.status === 1 && /^short 29 real tasks, needs 30$/m.test(sr.out), sr.out);
    // A9: one missing day of ticks takes the share under 99.5%.
    const tk = home();
    FIX['acceptance-window'](tk, { gap: GAP });
    const tr = probe('acceptance-window', tk, REPO.repo);
    check('acceptance-window: a day without ticks is short of 99.5% host ticks', /^short host ticks 3744 of 4032 \(92\.9%\), needs 99\.5%, host up time known for 0 of 14 days$/m.test(tr.out), tr.out);
    // A9: host-uptime.js day files set the denominator. The host off all of the gap day takes it out.
    const hu = home();
    FIX['acceptance-window'](hu, { gap: GAP });
    hostUp(hu, (d) => (d === GAP ? 0 : 86400000));
    const hur = probe('acceptance-window', hu, REPO.repo);
    check('acceptance-window: a day the event log shows the host off leaves the denominator, so the share holds', hur.status === 1 && !/^short host ticks/m.test(hur.out)
        && /^short no writer records an accept later found wrong/m.test(hur.out), hur.out);
    const hl = home();
    FIX['acceptance-window'](hl, { gap: GAP });
    hostUp(hl, () => 86400000);
    write(hl, `autodev/windows/host-up/${DAYS[0]}.json`, JSON.stringify({ ...realHostUp(), day: DAYS[0], upMs: 90000000 }));
    const hlr = probe('acceptance-window', hl, REPO.repo);
    check('acceptance-window: a host up all day with no ticks is still short, and an impossible day file counts as unknown',
        /^short host ticks 3744 of 4032 \(92\.9%\), needs 99\.5%, host up time known for 13 of 14 days$/m.test(hlr.out), hlr.out);
    // A9: the recovery drill total reads restore-drill.js rows, the same rows as A17.
    const ad = home();
    FIX['acceptance-window'](ad, {});
    const adr = probe('acceptance-window', ad, REPO.repo);
    check('acceptance-window: no drill in the window is a short total', /^short 0 passing restore drill\(s\) in the window, needs 1$/m.test(adr.out), adr.out);
    write(ad, 'autodev/windows/restore-drills.jsonl', jsonl([{ ...realDrill(), at: `${DAYS[3]}T03:00:00.000Z` }]));
    const adr2 = probe('acceptance-window', ad, REPO.repo);
    check('acceptance-window: one passing drill meets the drill total', !/restore drill/m.test(adr2.out) && /^short no writer records an accept later found wrong/m.test(adr2.out), adr2.out);
    // A record before admissibleFrom never counts: the same clean release fixture moved before 10-19.
    const early = home();
    write(early, 'autodev/windows/release-protection.jsonl', jsonl(['2026-10-10', '2026-10-11'].map((d) => ({ at: `${d}T06:00:00Z`, error: null,
        fields: { direct_write: 'DENIED', tag_replace: 'DENIED', tag_delete: 'DENIED', authorized_publish: 'PASS' } }))));
    const er = spawnSync(process.execPath, [PROBE, 'release-window', '--home', early, '--now', '2026-10-20T12:00:00Z'], { encoding: 'utf8', windowsHide: true });
    check('release-window: records before admissibleFrom are not counted', er.status === 1 && /records=0$/m.test(er.stdout) && /^gap 2026-10-10 \(before the writer/m.test(er.stdout), er.stdout);

    // COULD NOT READ: no autodev dir is exit 2, never a zero.
    const empty = path.join(tmpRoot, 'empty');
    fs.mkdirSync(empty);
    const u = spawnSync(process.execPath, [PROBE, 'release-window', '--home', empty, '--now', NOW], { encoding: 'utf8', windowsHide: true });
    const u2 = spawnSync(process.execPath, [PROBE, 'worker-window', '--home', empty, '--now', NOW], { encoding: 'utf8', windowsHide: true });
    check('a missing source exits 2 COULD NOT READ', u.status === 2 && /COULD NOT READ/.test(u.stdout) && u2.status === 2, `${u.status} ${u.stdout} ${u2.status}`);
    // worker-window times an exit from launchedAt, after the capacity wait, and a cancel that never
    // launched has no exit to time. A late settle measured from launchedAt is still a violation.
    const wq = home();
    clock(wq);
    const wqAttempt = (id, extra) => [id, { attemptId: id, kind: 'worker', reservedAt: `${DAYS[4]}T08:00:00.000Z`,
        startedAt: `${DAYS[4]}T08:00:00.000Z`, ceilings: { wallMs: 21600000 }, ...extra }];
    write(wq, 'autodev/execution-budget.json', JSON.stringify({ schema: 1, attempts: Object.fromEntries([
        wqAttempt('queued', { state: 'settled', launchedAt: `${DAYS[4]}T08:20:00.000Z`, wallMs: 60000, exit: 0, settledAt: `${DAYS[4]}T08:21:00.000Z` }),
        wqAttempt('unlaunched', { state: 'cancelled', wallMs: null, exit: null, settledAt: `${DAYS[4]}T08:30:00.000Z`, reason: 'CAPACITY_DEFERRED' }),
        wqAttempt('late', { state: 'settled', launchedAt: `${DAYS[4]}T08:20:00.000Z`, wallMs: 60000, exit: 0, settledAt: `${DAYS[4]}T08:50:00.000Z` }),
        wqAttempt('crashed', { state: 'settled', wallMs: null, exit: 1, settledAt: `${DAYS[4]}T08:30:00.000Z` }),
    ]) }));
    const wqr = probe('worker-window', wq);
    check('worker-window: a capacity-queued launch and an unlaunched cancel are not violations',
        !/^violation .*(queued|unlaunched):/m.test(wqr.out), wqr.out);
    check('worker-window: a settle late from launchedAt and a settle with no wall time still are',
        /^violation .*late: settled 29 min after it exited/m.test(wqr.out) && /^violation .*crashed: settled with no wall time/m.test(wqr.out), wqr.out);
    // cost-window grades each task once, on its newest outcome row, on the day of its last attempt.
    const cw = home();
    FIX['cost-window'](cw, {});
    fs.appendFileSync(path.join(cw, 'autodev/delivery/outcomes.jsonl'), jsonl([
        { type: 'outcome', at: `${DAYS[2]}T23:30:00Z`, taskId: 'redo', lastAttemptAt: `${DAYS[2]}T09:00:00Z`, accepted: true, costUsd: null },
        { type: 'outcome', at: `${DAYS[3]}T23:30:00Z`, taskId: 'redo', lastAttemptAt: `${DAYS[2]}T09:00:00Z`, accepted: true, costUsd: 3 },
        { type: 'outcome', at: `${DAYS[5]}T23:30:00Z`, taskId: 'old', lastAttemptAt: '2026-10-01T09:00:00Z', accepted: true, costUsd: null },
    ]));
    const cwr = probe('cost-window', cw, REPO.repo);
    check('cost-window: a superseded outcome row and a task last attempted before the window are not violations',
        !/^violation /m.test(cwr.out) && /records=15$/m.test(cwr.out), cwr.out);
    const costTot = home();
    write(costTot, 'autodev/delivery/outcomes.jsonl', jsonl([
        { type: 'outcome', at: `${DAYS[1]}T23:30:00Z`, taskId: 'old-accept', lastAttemptAt: '2026-10-01T09:00:00Z', accepted: true, costUsd: 9 },
        ...DAYS.map((d) => ({ type: 'outcome', at: `${d}T23:30:00Z`, taskId: `t-${d}`, lastAttemptAt: `${d}T09:00:00Z`, accepted: false, costUsd: 2 })),
    ]));
    const costTotR = probe('cost-window', costTot, REPO.repo);
    check('cost-window: an accepted task from before the window does not meet the accepted-cost total',
        /^short 0 accepted tasks carry a cost$/m.test(costTotR.out), costTotR.out);

    // A git read that fails says why. --repo is a directory outside any work tree, confirmed first.
    const noRepo = path.join(tmpRoot, 'not-a-repo');
    fs.mkdirSync(noRepo);
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: noRepo, encoding: 'utf8', windowsHide: true });
    const gh = home();
    FIX['gate-window'](gh, {});
    const gr = probe('gate-window', gh, noRepo);
    check('gate-window: a failed git log exits 2 and names git\'s own cause', top.status !== 0 && gr.status === 2
        && /^COULD NOT READ .*git log origin\/main failed \(git log in .*not-a-repo: exit \d+, .*not a git repository/m.test(gr.out), `${top.status} ${gr.status} ${gr.out}`);
    check('every spec ran its gap plant', counts.gap === 17, counts.gap);
} finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`specs=17 gap_planted=${counts.gap === 17 ? 'FAIL' : 'MISSED'} bad_record=${counts.bad === Object.keys(BAD_LINE).length ? 'FAIL' : 'MISSED'} clean_pass=${counts.clean} no_writer=${counts.noWriter} unreadable=EXIT2`);
console.log(`${ran} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
