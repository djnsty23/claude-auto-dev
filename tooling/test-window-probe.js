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
//   specs=17 gap_planted=FAIL bad_record=FAIL clean_pass=5 no_writer=12 unreadable=EXIT2
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
    'instruction-window': (h, o) => write(h, 'logs/instructions-loaded.jsonl', jsonl(DAYS.filter((d) => d !== o.gap).map((d) => ({
        at: `${d}T09:00:00Z`, file: 'CLAUDE.md', reason: 'session_start', bytes: d === o.bad ? 0 : 4096 })))),
    'skill-window': (h, o) => write(h, 'autodev/frontier/runs.jsonl', jsonl(DAYS.filter((d) => d !== o.gap).map((d) => ({
        run: `r-${d}`, startedAt: `${d}T09:00:00Z`, finishedAt: `${d}T09:10:00Z`, routedTo: 'audit', pass: d !== o.bad })))),
    'cost-window': (h, o) => write(h, 'autodev/delivery/outcomes.jsonl', jsonl(DAYS.filter((d) => d !== o.gap).map((d) => ({
        at: `${d}T09:00:00Z`, taskId: `t-${d}`, accepted: true, costUsd: d === o.bad ? null : 4.5 })))),
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
    'locking-window': (h, o) => clock(h, o.gap ? [o.gap] : []),
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
        write(h, 'autodev/lifecycle/snapshots.jsonl', jsonl(DAYS.filter((d) => d !== o.gap).map((d) => ({ utc: `${d}T09:00:00Z` }))));
        write(h, 'autodev/lifecycle/journal.jsonl', jsonl(o.bad ? [{ utc: `${o.bad}T09:00:00Z`, op: 'remove', state: 'done', path: path.join(os.homedir(), '.claude', 'projects', 'x') }] : []));
    },
    'owner-window': (h, o) => {
        clock(h, o.gap ? [o.gap] : []);
        write(h, 'autodev/owner-asks/ledger.jsonl', jsonl(DAYS.map((d) => ({ at: `${d}T09:00:00Z`, type: 'owner-time-start' }))));
    },
    'recovery-window': (h, o) => clock(h, o.gap ? [o.gap] : []),
};

// The specs that can pass on records the harness writes today, and those that must fail
// by name until a writer exists. Written by hand, so narrowing a spec moves a case red.
const PASSABLE = ['gate-window', 'release-window', 'worker-window', 'visibility-window', 'delivery-window'];
const NO_WRITER = ['authority-window', 'hook-window', 'instruction-window', 'skill-window', 'cost-window', 'acceptance-window',
    'queue-window', 'locking-window', 'learning-window', 'capacity-window', 'owner-window', 'recovery-window'];
// The records a planted bad day must produce, by the line that names it.
const BAD_LINE = {
    'gate-window': /^violation 2026-11-09T11:00:00.000Z .*failed step 4 \(step 4\) has no output tail$/m,
    'release-window': /^violation 2026-11-09T06:00:00Z direct_write=ALLOWED/m,
    'authority-window': /^violation 2026-11-09T09:00:00Z w-2026-11-09: ran bypassPermissions/m,
    'hook-window': /^violation 2026-11-09T09:00:00Z PreToolUse p95 400 ms, budget 100 ms$/m,
    'worker-window': /^violation 2026-11-09T08:00:00.000Z a-2026-11-09: settled 30 min after it exited/m,
    'instruction-window': /^violation 2026-11-09T09:00:00Z .*CLAUDE\.md loaded with bytes 0/m,
    'skill-window': /^violation 2026-11-09T09:10:00Z r-2026-11-09: routed audit, pass false$/m,
    'cost-window': /^violation 2026-11-09T09:00:00Z t-2026-11-09: no cost$/m,
    'acceptance-window': /^violation 2026-11-09T09:00:00Z t-2026-11-09: an accept that did not apply/m,
    'queue-window': /^violation 2026-11-09T09:00:00Z t-2026-11-09: UNKNOWN/m,
    'visibility-window': /^violation 2026-11-09T09:00:01Z k-2026-11-09: delivery via toast exited 1$/m,
    'learning-window': /^violation 2026-11-09T00:00:00Z r-2026-11-09-0: exit 1$/m,
    'capacity-window': /^violation 2026-11-09T09:00:00Z removed .*protected class/m,
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
    check('acceptance-window: a day without ticks is short of 99.5% host ticks', /^short host ticks 3744 of 4032 \(92\.9%\), needs 99\.5%$/m.test(tr.out), tr.out);
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
    check('every spec ran its gap plant', counts.gap === 17, counts.gap);
} finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`specs=17 gap_planted=${counts.gap === 17 ? 'FAIL' : 'MISSED'} bad_record=${counts.bad === Object.keys(BAD_LINE).length ? 'FAIL' : 'MISSED'} clean_pass=${counts.clean} no_writer=${counts.noWriter} unreadable=EXIT2`);
console.log(`${ran} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
