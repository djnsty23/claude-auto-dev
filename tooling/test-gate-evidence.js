#!/usr/bin/env node
/**
 * test-gate-evidence.js - a red gate leaves complete evidence, and the gate's
 * semantic guards are each killed, for the right reason, by a planted defect.
 *
 * THE GATE IS THIRTEEN STEPS CHAINED WITH `&&`, so a red step means every later
 * step never ran. Two things have to hold for that red to be read correctly:
 * the record has to name the step, its exit and the end of its output, and
 * every later step has to read NOT RUN, never green and never absent.
 *
 * PART 1, failure_steps and evidence. The chain is read from package.json
 * (gate-lock.js readGateChain, gate-steps.js splitChain) and compared with the
 * thirteen steps written out by hand below, so a step added or dropped is a
 * red here rather than a quietly smaller population. Then, for each position
 * k, the REAL runner (`gate-lock.js --run-chain`) runs a synthetic thirteen-step
 * chain whose k-th step fails with a distinct exit and a marker on stderr.
 * failure_steps counts positions where the runner exited with that code and
 * named step k. evidence counts positions where the runner's record, its
 * printed ledger and the step records on disk all say: steps before k pass,
 * step k FAIL with its exit and the marker in its output tail, every step
 * after k NOT RUN.
 *
 * PART 2, degraded logging. The same runner with the step records on a path
 * that cannot exist (a missing log), with every record after the sixth failing
 * ENOSPC (AUTODEV_GATE_TEST_RECORD_FAULT), killed mid-step (interrupted: only
 * the records on disk remain), with a step that prints 300 KB and a partial
 * last line (truncated output), with a step that prints nothing, and over a
 * torn record file. None may lose the failed step or turn a step green.
 *
 * PART 3, critical mutants (tooling/fixtures/gate-evidence/critical-mutants.json).
 * Each mutant rewrites ONE anchor in a sandbox copy of its file, never the
 * tree, and this file is spawned against the sandbox as `--probe <group>
 * --root <sandbox>`. KILLED means the probe exited 1 with its summary line and
 * every failing assertion is one the manifest names for that mutant. A crash
 * (no summary) or a red on any other assertion is WRONG REASON. The probes run
 * unmutated against the sandbox first: a probe red on the control is no
 * evidence about any mutant.
 *
 * It prints exactly one summary line,
 *   failure_steps=13/13 evidence=13/13 critical_mutants=K/E wrong_reason=0
 * and exits 1 unless every count is full and every other check passed.
 *
 *   node tooling/test-gate-evidence.js
 *   node tooling/test-gate-evidence.js --probe <group> --root DIR   (internal)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WIN = process.platform === 'win32';
const MANIFEST = path.join(__dirname, 'fixtures', 'gate-evidence', 'critical-mutants.json');

// The gate, step by step, written out by hand: a different provenance from
// package.json, so the population cannot move with the thing it checks.
const EXPECTED_CHAIN = [
    'npm test', 'npm run check:suites', 'npm run check:probe-shapes', 'npm run check:population',
    'npm run check:entrypoints', 'npm run check:skill-tools', 'npm run check:skill-plugin-root',
    'npm run check:agents-md', 'npm run check:decisions', 'npm run check:claude-md',
    'npm run check:hook-parse', 'npm run check:conflict-markers', 'npm run check:coverage',
];

const temps = [];
const mkTemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The probes: one group per guarded behaviour, each loading its subject from
// `root`, so the same code grades the tree and a mutated sandbox.
// ---------------------------------------------------------------------------

const S = (root, ...p) => path.join(root, 'plugins', 'autodev-core', 'scripts', ...p);
const T = (root, ...p) => path.join(root, 'tooling', ...p);

function sleeper() {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
    return c;
}

/** One step of a synthetic chain: prints, optionally fails, sleeps or floods. */
const STEP = `'use strict';
const fs = require('fs');
const [name, code, mode] = [process.argv[2], Number(process.argv[3] || 0), process.argv[4] || ''];
fs.writeFileSync('step-' + name + '.pid', String(process.pid));
if (mode === 'silent') { process.exitCode = code; return; }
for (let i = 1; i <= 3; i++) console.log('step ' + name + ' line ' + i);
if (mode === 'flood') {
    process.stdout.write('x'.repeat(1023) + '\\n');
    for (let i = 0; i < 300; i++) process.stdout.write(('flood ' + i + ' ').padEnd(1023, '.') + '\\n');
    process.stdout.write('TAIL-END-MARK');
}
if (code !== 0) console.error('EVIDENCE-MARK ' + name + ' failing with ' + code);
if (mode === 'sleep') setTimeout(() => { process.exitCode = code; }, 120000);
else process.exitCode = code;
`;

function chainFixture(steps) {
    const dir = mkTemp('gate-ev-');
    fs.writeFileSync(path.join(dir, 'step.js'), STEP);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'gate-evidence-fixture', version: '1.0.0', private: true, scripts: { 'gate:chain': steps.join(' && ') },
    }, null, 2));
    return dir;
}

/** The runner on `dir`: { status, stdout, stderr, rec, base, runId }. */
function runRunner(root, dir, { runId, env = {}, records = true, base = null } = {}) {
    const sentinel = path.join(dir, 'attempt.exit');
    const recBase = base || path.join(dir, 'locks', 'full-gate.lock');
    const args = [T(root, 'gate-lock.js'), '--run-chain', '--root', dir, '--sentinel', sentinel, '--run-id', runId, '--token', '7'];
    if (records) args.push('--records', recBase);
    const e = { ...process.env, ...env };
    if (!('AUTODEV_GATE_TEST_RECORD_FAULT' in env)) delete e.AUTODEV_GATE_TEST_RECORD_FAULT;
    const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000, env: e, maxBuffer: 64 * 1024 * 1024 });
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(sentinel, 'utf8')); } catch { rec = null; }
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.message : null, rec, base: recBase, runId };
}

function probeAcceptance(root, row) {
    const bj = require(S(root, 'brain-judge.js'));
    const gl = require(T(root, 'gate-lock.js'));
    const doc = JSON.stringify({ type: 'result', is_error: false, num_turns: 2, structured_output: { decision: 'accept', reason: 'the work is done', evidence: [] } });
    const p = (r) => { try { return bj.parseJudgeOutput(r); } catch (e) { return { ok: 'threw', error: e.message }; } };
    const ok0 = p({ status: 0, signal: null, stdout: doc });
    row('acceptance control: a judge verdict from a process that exited 0 is accepted', ok0.ok === true, ok0);
    const e1 = p({ status: 1, signal: null, stdout: doc });
    row('acceptance: a judge verdict from a process that exited 1 is refused', e1.ok === false, e1);
    const none = p({ stdout: doc });
    row('acceptance: a judge verdict with no exit status is refused', none.ok === false, none);
    const killed = p({ status: null, signal: 'SIGKILL', stdout: doc });
    row('acceptance: a judge verdict from a killed process is refused', killed.ok === false, killed);
    const v = (o) => gl.verdict(o);
    row('acceptance control: a chain exit the runner recorded is the verdict', v({ code: 1, recorded: 1 }).exit === 1 && v({ code: 0, recorded: 0 }).exit === 0, [v({ code: 1, recorded: 1 }), v({ code: 0, recorded: 0 })]);
    row('acceptance: a chain exit with no runner record is INDETERMINATE', v({ code: 0, recorded: null }).exit === 2 && v({ code: 1, recorded: null }).exit === 2, v({ code: 0, recorded: null }));
    row('acceptance: a runner record that disagrees with the chain exit is INDETERMINATE', v({ code: 0, recorded: 1 }).exit === 2, v({ code: 0, recorded: 1 }));
    row('acceptance: a chain killed by a signal is INDETERMINATE', v({ code: 0, signal: 'SIGTERM', recorded: 0 }).exit === 2, v({ code: 0, signal: 'SIGTERM', recorded: 0 }));
}

function takeFresh(q, runId) {
    const dir = mkTemp('gate-ev-lock-');
    const lockPath = path.join(dir, 'full-gate.lock');
    const t = q.takeTurn({ lockPath, pid: process.pid, what: 'gate-evidence probe', cls: q.HARNESS, staleMs: 600000, log: () => {}, runId });
    return { lockPath, t };
}

function probeLocking(root, row) {
    const q = require(S(root, 'full-gate-queue.js'));
    const rel = (lockPath, runId, token) => q.releaseLock({ lockPath, pid: process.pid, staleMs: 600000, log: () => {}, runId, token });
    {
        const { lockPath, t } = takeFresh(q, 'run-ev-lock-a');
        const r = rel(lockPath, 'run-ev-lock-a', t.token - 1);
        const held = q.readLock(lockPath);
        row('locking: a release carrying a stale fencing token frees nothing', t.acquired && r.released === false && Boolean(held) && held.meta.token === t.token, { t, r });
    }
    {
        const { lockPath, t } = takeFresh(q, 'run-ev-lock-b');
        const r = rel(lockPath, 'run-ev-lock-other', null);
        row('locking: a release naming another run frees nothing', t.acquired && r.released === false && Boolean(q.readLock(lockPath)), { t, r });
    }
    {
        const { lockPath, t } = takeFresh(q, 'run-ev-lock-c');
        const r = rel(lockPath, 'run-ev-lock-c', t.token);
        row('locking control: the holder\'s own run and token release the lane', t.acquired && r.released === true && !fs.existsSync(lockPath), { t, r });
    }
}

function probeAuthority(root, row) {
    const q = require(S(root, 'full-gate-queue.js'));
    const { lockPath, t } = takeFresh(q, 'run-ev-auth');
    const own = q.confirmOwnership({ lockPath, pid: process.pid, runId: 'run-ev-auth' });
    row('authority control: the lock this run took confirms its ownership', t.acquired && own.ok === true && own.adopted === false, own);
    const other = q.confirmOwnership({ lockPath, pid: process.pid, runId: 'run-ev-someone-else' });
    row('authority: a lock carrying another run id confers no ownership', other.ok === false, other);
    const pid = q.confirmOwnership({ lockPath, pid: process.pid + 1, runId: 'run-ev-auth' });
    row('authority: a lock naming another pid confers no ownership', pid.ok === false, pid);
}

async function probeAdmission(root, row) {
    const q = require(S(root, 'full-gate-queue.js'));
    const kids = [];
    const live = () => { const c = sleeper(); kids.push(c); return c.pid; };
    try {
        const lanes = () => {
            const dir = mkTemp('gate-ev-lanes-');
            fs.writeFileSync(path.join(dir, 'full-gate.lanes'), '2\n');
            const base = path.join(dir, 'full-gate.lock');
            const lockPaths = q.lanePaths(base, 2);
            fs.writeFileSync(lockPaths[0], `${live()}\nharness gate on lane 1\nclass harness\n`);
            return lockPaths;
        };
        await sleep(300);
        const opts = { staleMs: 600000, log: () => {} };
        {
            const lockPaths = lanes();
            await sleep(200);
            const r = q.takeTurn({ lockPath: lockPaths[1], lockPaths, pid: process.pid, what: 'harness probe', cls: q.HARNESS, runId: 'run-ev-adm-a', ...opts });
            row('admission control: with no product waiting a harness gate borrows the free lane', r.acquired === true && fs.existsSync(lockPaths[1]), r);
        }
        {
            const lockPaths = lanes();
            const p = live();
            await sleep(200);
            const pr = q.takeTurn({ lockPath: lockPaths[0], lockPaths, pid: p, what: 'product probe', cls: q.PRODUCT, runId: 'run-ev-adm-p', ...opts });
            const r = q.takeTurn({ lockPath: lockPaths[1], lockPaths, pid: process.pid, what: 'harness probe', cls: q.HARNESS, runId: 'run-ev-adm-b', ...opts });
            row('admission: a harness gate is refused the last free lane while a product gate waits',
                pr.acquired === false && r.acquired === false && Boolean(r.reserved) && !fs.existsSync(lockPaths[1]), { product: pr, harness: r });
        }
    } finally {
        for (const c of kids) { try { c.kill(); } catch { /* gone */ } }
    }
}

function probeBinding(root, row) {
    const ml = require(S(root, 'merge-lock.js'));
    const fl = require(S(root, 'fast-lane.js'));
    const H = '1'.repeat(40);
    const O = '2'.repeat(40);
    const dir = mkTemp('gate-ev-receipt-');
    const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
    const okVerdict = ml.receiptProblem(file('v-ok.log', `${H}\nchain output\n${ml.PASS_LINE}\n`), H);
    row('release binding control: a gate receipt whose PASS run names HEAD is accepted', okVerdict === null, okVerdict);
    const otherVerdict = ml.receiptProblem(file('v-other.log', `${H}\ngate-lock: verdict FAIL (exit 1)\n${O}\nchain output\n${ml.PASS_LINE}\n`), H);
    row('release binding: a gate receipt whose PASS run names another head is refused', typeof otherVerdict === 'string', otherVerdict);
    const okWrap = ml.receiptProblem(file('w-ok.log', `${H}\nchain output\n${ml.EXIT_PASS}\n`), H);
    row('release binding control: a wrapper receipt whose run starts with HEAD is accepted', okWrap === null, okWrap);
    const otherWrap = ml.receiptProblem(file('w-other.log', `${H}\nnot this run\ngate-receipt: exit 1\n${O}\nchain output\n${ml.EXIT_PASS}\n`), H);
    row('release binding: a wrapper receipt whose run starts with another head is refused', typeof otherWrap === 'string', otherWrap);
    const fast = (head) => JSON.stringify({ kind: fl.KIND, version: 1, head, tree: '3'.repeat(40), classifier: { eligible: true, reasons: [] },
        steps: fl.STEPS.map((step) => ({ step, script: step, command: `npm run ${step}`, exit: 0, ms: 1 })), exit: 0 });
    const okFast = fl.receiptProblem(file('f-ok.json', fast(H)), H);
    row('release binding control: a fast-lane receipt for HEAD is accepted', Boolean(okFast.receipt) && !okFast.problem, okFast);
    const otherFast = fl.receiptProblem(file('f-other.json', fast(O)), H);
    row('release binding: a fast-lane receipt for another head is refused', Boolean(otherFast.problem), otherFast);
}

function probeCompleteness(root, row) {
    const cr = require(T(root, 'coverage-receipt.js'));
    const fx = mkTemp('gate-ev-cov-');
    fs.mkdirSync(path.join(fx, 'tooling'));
    fs.mkdirSync(path.join(fx, 'plugins', 'fx'), { recursive: true });
    for (const s of ['test-alpha.js', 'test-beta.js']) fs.writeFileSync(path.join(fx, 'tooling', s), 'process.exitCode = 0;\n');
    fs.writeFileSync(path.join(fx, 'plugins', 'fx', 'thing.js'), 'module.exports = 1;\n');
    spawnSync('git', ['init', '-q'], { cwd: fx, windowsHide: true });
    const store = mkTemp('gate-ev-store-');
    const env = { AUTODEV_COVERAGE_STORE: store };
    const runDir = path.join(store, 'runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    const labels = cr.expectedLabels(path.join(fx, 'tooling'));
    const dumps = labels.map((label) => {
        const buf = Buffer.from(JSON.stringify({ files: {} }));
        fs.writeFileSync(path.join(runDir, `${label}.json`), buf);
        return { label, file: `${label}.json`, sha256: cr.sha256(buf), rawDumps: 1 };
    });
    const src = cr.sourceHashes(fx);
    const good = {
        schema: cr.SCHEMA, runId: 'r1', root: cr.canonicalRoot(fx), runDir, node: cr.nodeIdentity(), verdict: 'pass',
        outcomes: labels.map((label) => ({ label, state: 'pass' })), treeInert: { state: 'pass' },
        tree: { after: cr.treeIdentity(fx) }, sources: { start: src.digest, end: src.digest, files: src.files },
        expectedSuites: labels, executedSuites: labels, dumps,
    };
    const grade = (r) => { fs.writeFileSync(path.join(store, cr.RECEIPT), JSON.stringify(r)); try { return cr.check(fx, env); } catch (e) { return { ok: 'threw', problem: e.message }; } };
    const control = grade(good);
    row('completeness control: a complete passing receipt is accepted', control.ok === true && labels.length === 3, { labels, problem: control.problem });
    const drop = labels[1];
    const skipped = grade({ ...good, executedSuites: labels.filter((l) => l !== drop) });
    row('completeness: a receipt whose run never ran an expected suite is refused', skipped.ok === false, skipped.problem);
    const noOutcome = grade({ ...good, outcomes: good.outcomes.filter((o) => o.label !== drop) });
    row('completeness: a receipt with no outcome for an expected suite is refused', noOutcome.ok === false, noOutcome.problem);
    const overFail = grade({ ...good, outcomes: good.outcomes.map((o) => (o.label === drop ? { ...o, state: 'fail' } : o)) });
    row('completeness: a receipt saying pass over a failed outcome is refused', overFail.ok === false, overFail.problem);
    const noDump = grade({ ...good, dumps: dumps.map((d) => (d.label === drop ? { ...d, rawDumps: 0 } : d)) });
    row('completeness: a suite that left no coverage dump is refused', noDump.ok === false, noDump.problem);
}

async function probeEvidence(root, row) {
    const gs = require(T(root, 'gate-steps.js'));
    const dir = chainFixture(['node step.js a 0']);
    const st = (name, code, mode = '') => `node step.js ${name} ${code}${mode ? ` ${mode}` : ''}`;
    {
        const steps = [st('one', 0), st('two', 3), st('three', 0), st('four', 0)];
        const r = await gs.runSteps({ root: dir, steps }).done;
        const ev = r.evidence || [];
        row('evidence control: the steps before the failed one read pass', ev.length === 4 && ev[0].status === 'pass', ev);
        row('evidence: the failed step carries its exit and output tail',
            ev[1] && ev[1].status === 'fail' && ev[1].exit === 3 && Boolean(ev[1].tail) && /EVIDENCE-MARK two/.test(ev[1].tail.text), ev[1]);
        row('evidence: steps after the failed one read NOT RUN', ev.length === 4 && ev[2].status === 'not-run' && ev[3].status === 'not-run', ev.slice(2));
    }
    {
        const r = await gs.runSteps({ root: dir, steps: [st('flood', 9, 'flood')] }).done;
        const t = r.evidence && r.evidence[0] && r.evidence[0].tail;
        row('evidence: a step\'s output tail is bounded and marked truncated',
            Boolean(t) && Buffer.byteLength(t.text) <= 4096 && t.truncated === true && t.bytes > 300000 && t.text.includes('TAIL-END-MARK'),
            t ? { kept: Buffer.byteLength(t.text), bytes: t.bytes, truncated: t.truncated, end: t.text.slice(-20) } : r.evidence);
    }
    {
        let uncaught = null;
        const onUncaught = (e) => { uncaught = e; };
        process.on('uncaughtException', onUncaught);
        let faults = 0;
        const full = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
        let r = null;
        try {
            r = await gs.runSteps({ root: dir, steps: [st('one', 0), st('full', 5), st('three', 0)], onData: full, onDataError: () => { faults++; } }).done;
        } catch (e) { uncaught = uncaught || e; }
        await sleep(50);
        process.removeListener('uncaughtException', onUncaught);
        const ev = (r && r.evidence) || [];
        row('evidence: an output sink failing with ENOSPC keeps the step\'s evidence',
            !uncaught && faults > 0 && ev.length === 3 && ev[1].status === 'fail' && ev[1].exit === 5 && Boolean(ev[1].tail) && /EVIDENCE-MARK full/.test(ev[1].tail.text),
            { uncaught: uncaught && uncaught.message, faults, ev });
    }
    {
        const steps = ['s1', 's2', 's3', 's4'];
        const missing = gs.ledgerFromRecords({ state: 'absent', steps: [], bad: 0 }, steps);
        row('evidence: missing step records read UNKNOWN, never pass', missing.length === 4 && missing.every((x) => x.status === 'unknown'), missing);
        const lost = gs.ledgerFromRecords({ state: 'ok', bad: 1, steps: [{ index: 1, ended: true, exit: 0 }, { index: 2, ended: false, exit: null, pid: 42 }] }, steps);
        row('evidence: a step started with no end on disk reads LOST and later steps NOT RUN',
            lost[0].status === 'pass' && lost[1].status === 'lost' && lost[2].status === 'not-run' && lost[3].status === 'not-run', lost);
    }
    {
        const fx = chainFixture([st('r1', 0), st('r2', 6), st('r3', 0)]);
        const r = runRunner(root, fx, { runId: 'run-ev-probe-rec' });
        const ev = r.rec && r.rec.evidence;
        row('evidence: the runner\'s record carries the ledger of every step',
            r.status === 6 && Array.isArray(ev) && ev.map((x) => x.status).join(',') === 'pass,fail,not-run', { status: r.status, ev, stderr: r.stderr.slice(-600) });
    }
}

const PROBES = {
    acceptance: probeAcceptance, locking: probeLocking, authority: probeAuthority, admission: probeAdmission,
    binding: probeBinding, completeness: probeCompleteness, evidence: probeEvidence,
};

/** Probe mode: run one group (or all) against `root`; print each row and one summary line. */
async function probeMain(group, root) {
    const failedNames = [];
    let n = 0;
    const row = (name, ok, detail) => {
        n++;
        if (ok) { console.log(`PROBE ok ${name}`); return; }
        failedNames.push(name);
        let d = '';
        try { d = JSON.stringify(detail); } catch { d = String(detail); }
        console.log(`PROBE FAIL ${name} :: ${String(d).slice(0, 600)}`);
    };
    const groups = group === 'all' ? Object.keys(PROBES) : [group];
    for (const g of groups) {
        if (!PROBES[g]) { console.log(`PROBE FAIL no probe group named ${g}`); process.exitCode = 2; return; }
        await PROBES[g](root, row);
    }
    console.log(`PROBE-DONE rows=${n} failed=${failedNames.length}`);
    process.exitCode = failedNames.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
    if (ok) { passed++; console.log(`PASS  ${name}`); return true; }
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail !== undefined) {
        let d = detail;
        if (typeof d !== 'string') { try { d = JSON.stringify(d, null, 1); } catch { d = String(d); } }
        console.log(String(d).slice(0, 2000).split('\n').map((l) => '      ' + l).join('\n'));
    }
    return false;
}

const slug = (step) => step.replace(/^npm run /, '').replace(/^npm /, 'npm-').replace(/[^a-z0-9-]/gi, '-');
const statuses = (ledger) => (Array.isArray(ledger) ? ledger.map((r) => r.status).join(',') : String(ledger));

/** Part 1: each of the thirteen positions fails, and leaves complete evidence. */
function partSteps(gs, records, chain) {
    let failureSteps = 0;
    let evidence = 0;
    console.log(`\npopulation, part 1: ${chain.length} gate steps, each failed in turn:`);
    chain.forEach((s, i) => console.log(`  step ${i + 1}: ${s}`));
    for (let k = 1; k <= chain.length; k++) {
        const code = 20 + k;
        const steps = chain.map((s, i) => `node step.js s${i + 1}-${slug(s)} ${i + 1 === k ? code : 0}`);
        const dir = chainFixture(steps);
        const runId = `run-ev-step-${k}`;
        const r = runRunner(ROOT, dir, { runId });
        const name = `s${k}-${slug(chain[k - 1])}`;
        const failOk = r.status === code && r.rec && r.rec.exit === code && r.rec.failedStep && r.rec.failedStep.index === k;
        if (check(`step ${k} of ${chain.length} (${chain[k - 1]}) fails: the runner exits ${code} and names step ${k}`, failOk,
            { status: r.status, rec: r.rec && { exit: r.rec.exit, failedStep: r.rec.failedStep }, stderr: r.stderr.slice(-800), error: r.error })) failureSteps++;
        const ev = r.rec && r.rec.evidence;
        const want = chain.map((_, i) => (i + 1 < k ? 'pass' : i + 1 === k ? 'fail' : 'not-run')).join(',');
        const row = Array.isArray(ev) ? ev[k - 1] : null;
        const disk = gs.ledgerFromRecords(records.readSteps(r.base, runId), steps);
        const notRunLines = (r.stderr.match(/^gate-lock:\s+step \d+ of 13 NOT RUN/gm) || []).length;
        const recordOk = Array.isArray(ev) && ev.length === chain.length && statuses(ev) === want;
        const rowOk = Boolean(row) && row.exit === code && Boolean(row.tail) && row.tail.text.includes(`EVIDENCE-MARK ${name}`);
        const printedOk = new RegExp(`^gate-lock:\\s+step ${k} of 13 FAIL \\(exit ${code}\\)`, 'm').test(r.stderr) && notRunLines === chain.length - k
            && r.stderr.includes(`EVIDENCE-MARK ${name}`);
        const diskOk = statuses(disk) === want && Boolean(disk[k - 1].tail) && disk[k - 1].tail.text.includes(`EVIDENCE-MARK ${name}`);
        if (check(`step ${k}: evidence complete: record ${recordOk ? 'ok' : 'BAD'}, failed row ${rowOk ? 'ok' : 'BAD'}, printed ledger ${printedOk ? 'ok' : 'BAD'}, disk records ${diskOk ? 'ok' : 'BAD'}; ${chain.length - k} later step(s) NOT RUN`,
            recordOk && rowOk && printedOk && diskOk,
            { want, record: statuses(ev), disk: statuses(disk), row, notRunLines, stderr: r.stderr.slice(-1500) })) evidence++;
    }
    return { failureSteps, evidence };
}

/** Part 2: a log that is missing, fills up, is cut off mid-step, is truncated, is empty, is torn. */
async function partDegraded(gs, records, recovery, chain) {
    const steps = (k, code, mode = '', modeAt = k) => chain.map((s, i) => `node step.js d${i + 1} ${i + 1 === k ? code : 0}${i + 1 === modeAt && mode ? ` ${mode}` : ''}`);
    const ofLedger = (k) => chain.map((_, i) => (i + 1 < k ? 'pass' : i + 1 === k ? 'fail' : 'not-run')).join(',');
    console.log('\npopulation, part 2: missing log, ENOSPC mid-log, interrupted step, truncated output, silent step, torn records');

    {   // A missing log: the records path runs through a file, so no record can be written.
        const dir = chainFixture(steps(5, 35));
        const blocker = path.join(dir, 'not-a-dir');
        fs.writeFileSync(blocker, 'a file where the records directory should be\n');
        const base = path.join(blocker, 'locks', 'full-gate.lock');
        const r = runRunner(ROOT, dir, { runId: 'run-ev-missing', base });
        const disk = gs.ledgerFromRecords(records.readSteps(base, 'run-ev-missing'), steps(5, 35));
        check('missing log: the runner still exits 35, says the step records were not written, and its record has the full ledger',
            r.status === 35 && /step records not written/.test(r.stderr) && statuses(r.rec && r.rec.evidence) === ofLedger(5)
            && /EVIDENCE-MARK d5/.test((r.rec.evidence[4].tail || {}).text || ''), { status: r.status, ev: statuses(r.rec && r.rec.evidence), stderr: r.stderr.slice(-800) });
        check('missing log: the records on disk read UNKNOWN for every step, never pass', disk.every((x) => x.status === 'unknown'), statuses(disk));
    }
    {   // ENOSPC while writing the log: records 1-6 land (steps 1-3), then every write fails.
        const dir = chainFixture(steps(8, 38));
        const r = runRunner(ROOT, dir, { runId: 'run-ev-enospc', env: { AUTODEV_GATE_TEST_RECORD_FAULT: 'ENOSPC:6' } });
        const disk = gs.ledgerFromRecords(records.readSteps(r.base, 'run-ev-enospc'), steps(8, 38));
        check('ENOSPC on the log: the runner exits 38, names ENOSPC once, and its record has the full ledger with the failed step\'s tail',
            r.status === 38 && (r.stderr.match(/step records not written \(ENOSPC\)/g) || []).length === 1 && statuses(r.rec && r.rec.evidence) === ofLedger(8)
            && /EVIDENCE-MARK d8/.test((r.rec.evidence[7].tail || {}).text || ''), { status: r.status, ev: statuses(r.rec && r.rec.evidence), stderr: r.stderr.slice(-800) });
        const want = chain.map((_, i) => (i < 3 ? 'pass' : 'unknown')).join(',');
        check('ENOSPC on the log: the records on disk keep steps 1-3 as pass and every later step UNKNOWN, none pass or NOT RUN by guess',
            statuses(disk) === want, { want, got: statuses(disk) });
    }
    {   // Interrupted: the runner is killed outright mid step 3; only the records on disk remain.
        const st = steps(3, 0, 'sleep', 3);
        const dir = chainFixture(st);
        const base = path.join(dir, 'locks', 'full-gate.lock');
        const sentinel = path.join(dir, 'attempt.exit');
        const env = { ...process.env };
        delete env.AUTODEV_GATE_TEST_RECORD_FAULT;
        const runner = spawn(process.execPath, [T(ROOT, 'gate-lock.js'), '--run-chain', '--root', dir, '--sentinel', sentinel,
            '--run-id', 'run-ev-killed', '--token', '7', '--records', base], { cwd: dir, stdio: 'ignore', windowsHide: true, env });
        const pidFile = path.join(dir, 'step-d3.pid');
        for (let i = 0; i < 300 && !fs.existsSync(pidFile); i++) await sleep(100);
        await sleep(200);
        const closed = new Promise((res) => runner.on('close', res));
        runner.kill('SIGKILL');
        await closed;
        let stepPid = null;
        try { stepPid = Number(fs.readFileSync(pidFile, 'utf8')); process.kill(stepPid); } catch { /* already gone */ }
        const read = records.readSteps(base, 'run-ev-killed');
        const disk = gs.ledgerFromRecords(read, st);
        const want = chain.map((_, i) => (i < 2 ? 'pass' : i === 2 ? 'lost' : 'not-run')).join(',');
        const lost = recovery.lostStep(read);
        check('interrupted: a runner killed mid step 3 leaves no record, and the disk ledger reads 1-2 pass, 3 LOST, 4-13 NOT RUN',
            !fs.existsSync(sentinel) && statuses(disk) === want && Boolean(lost) && lost.index === 3,
            { want, got: statuses(disk), lost, stepPid });
        check('interrupted: the summary names the lost step and the steps that did not run',
            /^step 3 of 13 \(node step\.js d3 0 sleep\) LOST: started and recorded no end; steps 4-13 of 13 NOT RUN$/.test(gs.summarizeLedger(disk) || ''), gs.summarizeLedger(disk));
    }
    {   // Interrupted in process: kill() forwarded to the running step.
        const dir = chainFixture(['node step.js i1 0']);
        const run = gs.runSteps({ root: dir, steps: ['node step.js i1 0', 'node step.js i2 0 sleep', 'node step.js i3 0'] });
        for (let i = 0; i < 300 && !fs.existsSync(path.join(dir, 'step-i2.pid')); i++) await sleep(100);
        await sleep(200);
        run.kill('SIGTERM');
        const r = await run.done;
        try { process.kill(Number(fs.readFileSync(path.join(dir, 'step-i2.pid'), 'utf8'))); } catch { /* gone */ }
        check('interrupted in process: the step the signal reached reads FAIL, and the step after it NOT RUN',
            r.interrupted === 'SIGTERM' && statuses(r.evidence) === 'pass,fail,not-run', { interrupted: r.interrupted, ev: r.evidence });
    }
    {   // Truncated output: step 4 prints 300 KB and a last line with no newline.
        const dir = chainFixture(steps(4, 9, 'flood', 4));
        const r = runRunner(ROOT, dir, { runId: 'run-ev-flood' });
        const t = r.rec && r.rec.evidence && r.rec.evidence[3] && r.rec.evidence[3].tail;
        check('truncated output: the tail keeps the last 4096 bytes, says TRUNCATED, and keeps the partial last line',
            r.status === 9 && Boolean(t) && Buffer.byteLength(t.text) <= gs.TAIL_BYTES && t.truncated && t.bytes > 300000
            && t.text.includes('TAIL-END-MARK') && /TRUNCATED/.test(r.stderr) && statuses(r.rec.evidence) === ofLedger(4),
            t ? { status: r.status, kept: Buffer.byteLength(t.text), bytes: t.bytes, truncated: t.truncated, end: t.text.slice(-60) } : { status: r.status, stderr: r.stderr.slice(-600) });
    }
    {   // A step that prints nothing still leaves its exit and says it printed nothing.
        const dir = chainFixture(steps(2, 4, 'silent', 2));
        const r = runRunner(ROOT, dir, { runId: 'run-ev-silent' });
        const row = r.rec && r.rec.evidence && r.rec.evidence[1];
        check('silent step: exit 4 recorded, an empty tail, and the ledger says it printed nothing',
            r.status === 4 && row && row.status === 'fail' && row.exit === 4 && row.tail && row.tail.bytes === 0 && /it printed nothing/.test(r.stderr),
            { status: r.status, row, stderr: r.stderr.slice(-600) });
    }
    {   // A torn record file: the writer died mid line.
        const dir = mkTemp('gate-ev-torn-');
        const base = path.join(dir, 'full-gate.lock');
        const file = records.stepsPath(base, 'run-ev-torn');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const L = (o) => JSON.stringify({ schema: 1, runId: 'run-ev-torn', ...o });
        fs.writeFileSync(file, [L({ event: 'start', index: 1, of: 13, step: chain[0] }), L({ event: 'end', index: 1, of: 13, step: chain[0], exit: 0 }),
            L({ event: 'start', index: 2, of: 13, step: chain[1] }), '{"schema":1,"runId":"run-ev-torn","ev'].join('\n'));
        const read = records.readSteps(base, 'run-ev-torn');
        const disk = gs.ledgerFromRecords(read, chain);
        check('torn records: the torn line is counted, step 2 reads LOST, 3-13 NOT RUN, none pass but step 1',
            read.bad === 1 && statuses(disk) === ['pass', 'lost', ...Array(11).fill('not-run')].join(','), { bad: read.bad, got: statuses(disk) });
    }
}

/** Part 3: each critical mutant, in a sandbox, killed by its own assertion. */
function partMutants() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const mutants = manifest.mutants;
    console.log(`\npopulation, part 3: ${mutants.length} critical mutant(s) eligible, ${(manifest.excluded || []).length} excluded`);
    for (const m of mutants) console.log(`  ${m.id}  [${m.area}] ${m.name}  (${m.file}, probe ${m.probe})`);
    for (const x of manifest.excluded || []) console.log(`  ${x.id}  EXCLUDED [${x.area}] ${x.name}: ${x.why}`);
    const areas = new Set(mutants.map((m) => m.area));
    for (const a of ['acceptance', 'locking', 'authority', 'admission', 'release binding', 'receipt completeness', 'failure evidence']) {
        check(`the manifest has at least one mutant for ${a}`, areas.has(a), [...areas]);
    }

    // The sandbox: the scripts and tooling files the probes load, copied once.
    const sb = mkTemp('gate-ev-sandbox-');
    fs.cpSync(S(ROOT), S(sb), { recursive: true, filter: (p) => !/node_modules/.test(p) });
    fs.mkdirSync(T(sb), { recursive: true });
    for (const f of ['gate-lock.js', 'gate-steps.js', 'gate-recovery.js', 'coverage-receipt.js']) fs.copyFileSync(T(ROOT, f), T(sb, f));
    const probe = (group) => {
        const r = spawnSync(process.execPath, [__filename, '--probe', group, '--root', sb], { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
        const out = (r.stdout || '') + (r.stderr || '');
        const done = /^PROBE-DONE rows=(\d+) failed=(\d+)$/m.exec(out);
        const failedNames = [...out.matchAll(/^PROBE FAIL (.+?)(?: :: .*)?$/gm)].map((x) => x[1]);
        return { status: r.status, out, done, failedNames, error: r.error ? r.error.message : null };
    };

    const control = probe('all');
    check(`control: every probe passes against the unmutated sandbox (${control.done ? control.done[1] : '?'} rows)`,
        control.status === 0 && Boolean(control.done) && control.failedNames.length === 0,
        control.out.split('\n').filter((l) => !l.startsWith('PROBE ok ')).join('\n').slice(-3000));
    if (control.status !== 0) return { killed: 0, eligible: mutants.length, wrongReason: 0, controlRed: true };

    let killed = 0;
    let wrongReason = 0;
    for (const m of mutants) {
        const file = path.join(sb, m.file);
        const src = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
        const eol = src.includes('\r\n') ? (s) => s.replace(/\r?\n/g, '\r\n') : (s) => s;
        const from = eol(m.from);
        const count = src.split(from).length - 1;
        if (count !== 1) {
            check(`${m.id} ${m.name}: its anchor matches exactly once in ${m.file} (found ${count})`, false, m.from);
            continue;
        }
        fs.writeFileSync(file, src.replace(from, () => eol(m.to)));
        let r;
        try { r = probe(m.probe); } finally { fs.writeFileSync(file, src); }
        const unexpected = r.failedNames.filter((n) => !m.expect.includes(n));
        let verdict;
        if (r.status === 0) verdict = 'SURVIVED';
        else if (!r.done || r.status !== 1 || !r.failedNames.length) { verdict = 'WRONG-REASON (crash, no assertion summary)'; wrongReason++; }
        else if (unexpected.length) { verdict = `WRONG-REASON (also failed: ${unexpected.join(' | ')})`; wrongReason++; }
        else { verdict = 'KILLED'; killed++; }
        check(`${m.id} [${m.area}] ${m.name}: ${verdict}${verdict === 'KILLED' ? ` by test-gate-evidence.js "${r.failedNames.join('" and "')}"` : ''}`,
            verdict === 'KILLED', { expect: m.expect, failed: r.failedNames, status: r.status, out: r.out.slice(-1500) });
    }
    const restored = mutants.every((m) => fs.readFileSync(path.join(sb, m.file), 'utf8') === fs.readFileSync(path.join(ROOT, m.file), 'utf8'));
    check('every sandbox file is restored byte for byte after its mutant', restored);
    return { killed, eligible: mutants.length, wrongReason };
}

async function main() {
    const gs = require('./gate-steps.js');
    const gl = require('./gate-lock.js');
    const records = require(S(ROOT, 'gate-records.js'));
    const recovery = require('./gate-recovery.js');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const chain = gs.splitChain(gl.readGateChain(pkg));
    check(`the gate chain in package.json splits into the ${EXPECTED_CHAIN.length} steps written out here`,
        Array.isArray(chain) && JSON.stringify(chain) === JSON.stringify(EXPECTED_CHAIN), { got: chain, want: EXPECTED_CHAIN });
    const steps = Array.isArray(chain) && chain.length ? chain : EXPECTED_CHAIN;

    const p1 = partSteps(gs, records, steps);
    await partDegraded(gs, records, recovery, steps);
    const p3 = partMutants();

    const full = p1.failureSteps === 13 && p1.evidence === 13 && steps.length === 13 && p3.killed === p3.eligible && p3.eligible > 0 && p3.wrongReason === 0;
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log(`failure_steps=${p1.failureSteps}/${steps.length} evidence=${p1.evidence}/${steps.length} critical_mutants=${p3.killed}/${p3.eligible} wrong_reason=${p3.wrongReason}`);
    process.exitCode = full && failed === 0 ? 0 : 1;
}

function cleanup() {
    for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } }
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    const at = argv.indexOf('--probe');
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('usage: node tooling/test-gate-evidence.js   (failure evidence for all 13 gate steps, and the critical mutants)');
    } else if (at >= 0) {
        const r = argv.indexOf('--root');
        probeMain(argv[at + 1] || 'all', path.resolve(r >= 0 ? argv[r + 1] : ROOT))
            .catch((e) => { console.log(`PROBE crashed: ${e && e.stack ? e.stack : e}`); process.exitCode = 2; })
            .finally(cleanup);
    } else {
        main()
            .catch((e) => { failed++; console.log(`FAIL  the suite threw: ${e && e.stack ? e.stack : e}`); console.log('failure_steps=0/13 evidence=0/13 critical_mutants=0/0 wrong_reason=0'); process.exitCode = 1; })
            .finally(cleanup);
    }
}
