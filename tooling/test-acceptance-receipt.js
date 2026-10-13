#!/usr/bin/env node
'use strict';

// Capacity admission (capacity.js) would probe this machine and write its
// machine-wide ledger. Its behaviour is test-capacity-admission.js's subject.
process.env.AUTODEV_CAPACITY = 'off';
// Suite for plugins/autodev-core/scripts/acceptance-receipt.js and the accept gate
// it puts on plugins/autodev-core/scripts/unattended-worker.js `verdict`.
//
// WHY. A worker's run was accepted on what the worker wrote. This suite proves an
// accept now needs a receipt the verifier made itself, for this attempt and this
// result tree, from the brief the ledger bound, and that nothing the worker can
// write stands in for one. Real git repos in a temp dir, the real CLIs as
// subprocesses, HOME pointed at the temp dir so no real state is touched.
//
// It prints one line per case and exactly one summary line:
//   missing_or_changed=REJECT forged_receipt=REJECT verified_complete=ACCEPT
// A group whose cases do not all come out as expected prints MISMATCH instead,
// and the exit code is 1.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'acceptance-receipt.js');
const UW = path.join(SCRIPTS, 'unattended-worker.js');
const ar = require(SUBJECT);

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-receipt-')));
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: '0', AUTODEV_LEDGER_LOCK_WAIT_MS: '300', AUTODEV_CAPACITY: 'off' };
delete env.CLAUDE_CONFIG_DIR;
delete env.AUTODEV_HEADLESS;
const autodev = path.join(home, '.claude', 'autodev');
const ledger = path.join(autodev, 'unattended-workers.json');
const store = path.join(autodev, 'acceptance');

const groups = { missing_or_changed: [], forged_receipt: [], verified_complete: [] };
function record(group, name, ok, observed) {
    groups[group].push(ok);
    console.log(`${ok ? 'ok ' : 'BAD'}  ${group}  ${name}  (${observed})`);
}

function cli(script, args, extra = {}) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* a crash */ }
    return { status: r.status, json, value: json && json.ok ? json.value : null, code: json && json.error ? json.error.code : null,
        detail: (r.stdout || '').slice(0, 400) + (r.stderr || '').slice(0, 300) };
}
const verify = (taskId, extra) => cli(SUBJECT, ['verify', '--task-id', taskId, '--ledger', ledger], extra);
const gateCheck = (taskId) => cli(SUBJECT, ['check', '--task-id', taskId, '--ledger', ledger]);
const accept = (taskId, more = []) => cli(UW, ['verdict', '--task-id', taskId, '--decision', 'accept', '--reason', 'the report reads done', '--ledger', ledger, ...more]);
const said = (r) => r.code || (r.status === 0 ? 'ACCEPT' : `exit ${r.status}`);

function g(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=' + path.join(scratch, 'no-hooks'), ...args],
        { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The fixture repo: a quick check, and a long one whose decisive line sits in the
// middle of its output, past the stored head and before the stored tail.
const repo = path.join(scratch, 'repo');
g(scratch, 'init', repo);
fs.writeFileSync(path.join(repo, 'sum.js'), "console.log('adding');\nconsole.log(1 + 2 === 3 ? 'sum ok' : 'sum wrong');\n");
fs.writeFileSync(path.join(repo, 'big.js'), [
    "const noise = (n, tag) => { const out = []; for (let i = 0; i < n; i++) out.push(tag + ' line ' + i + ' of filler output'); return out.join('\\n') + '\\n'; };",
    "process.stdout.write(noise(4000, 'before'));",
    "process.stdout.write('DECISIVE: all 7 passed\\n');",
    "process.stdout.write(noise(4000, 'after'));",
].join('\n') + '\n');
g(repo, 'add', '.');
g(repo, 'commit', '-q', '-m', 'init');

const BRIEF = [
    'MISSION. Make the fixture pass.',
    '',
    '## Acceptance criteria',
    '- AC1: the sum prints ok',
    '  check: node sum.js',
    '  expect: /^sum ok$/',
    '- AC2: the long run reports its decisive line',
    '  check: node big.js',
    '  expect: /^DECISIVE: all 7 passed$/',
    '',
    '## Notes',
    '- N1: not a criterion, outside the section',
    '',
].join('\n');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const readLedger = () => (fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : { version: 1, records: [] });
const writeLedger = (l) => { fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, JSON.stringify(l, null, 2)); };
const recOf = (id) => readLedger().records.find((r) => r.taskId === id);
function patchRecord(id, fields) { const l = readLedger(); Object.assign(l.records.find((r) => r.taskId === id), fields); writeLedger(l); }

/**
 * A finished headless task: its brief bound by hash, a report in the worker's
 * scratch, and a branch claude/<slug> with one commit of work.
 */
function task(slug, { brief = BRIEF, report = 'did the work\nRESULT ' + slug + ' done: x\n', briefFile } = {}) {
    const taskId = `worker-${slug}`;
    const workerScratch = path.join(autodev, 'reports', taskId);
    fs.mkdirSync(workerScratch, { recursive: true });
    const bf = briefFile || path.join(workerScratch, 'BRIEF.md');
    if (!briefFile) fs.writeFileSync(bf, brief);
    const rp = path.join(workerScratch, 'REPORT.md');
    fs.writeFileSync(rp, report);
    const wt = path.join(scratch, 'wt-' + slug);
    g(repo, 'worktree', 'add', '-q', wt, '-b', `claude/${slug}`, 'main');
    fs.writeFileSync(path.join(wt, `work-${slug}.txt`), 'work\n');
    g(wt, 'add', '.');
    g(wt, 'commit', '-q', '-m', 'work');
    const l = readLedger();
    l.records.push({
        taskId, repo, slug, branch: `claude/${slug}`, state: 'closed', channel: 'headless', runStatus: 'succeeded',
        startedAt: new Date().toISOString(), attemptId: crypto.randomUUID(), briefFile: bf, briefSha256: sha(brief), report: rp,
        launch: { model: null, effort: null, permissionMode: 'bypassPermissions', configDir: null }, headless: { code: slug, version: 'test', keepTools: [] },
    });
    writeLedger(l);
    return { taskId, wt, workerScratch, briefFile: bf, report: rp };
}

try {
    // ===================================================== verified_complete
    const ok = task('complete');
    const v = verify(ok.taskId);
    const vv = v.value || {};
    record('verified_complete', 'verify runs every criterion in a clean checkout and records a complete receipt',
        v.status === 0 && vv.complete === true && vv.criteria.length === 2 && vv.criteria.every((c) => c.pass && c.exit === 0), v.code || `complete=${vv.complete}`);
    const receiptFile = vv.file || '';
    const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : {};
    const ac2 = (receipt.criteria || []).find((c) => c.id === 'AC2') || { evidence: {} };
    const e2 = ac2.evidence;
    record('verified_complete', 'oversized output is stored as head and tail with counts and marked truncated, never silently cut',
        e2.truncated === true && e2.bytes > ar.HEAD_BYTES + ar.TAIL_BYTES && e2.lines === 8001 && e2.omittedBytes === e2.bytes - ar.HEAD_BYTES - ar.TAIL_BYTES
        && Buffer.byteLength(e2.head) <= ar.HEAD_BYTES && Buffer.byteLength(e2.tail) <= ar.TAIL_BYTES && /^[0-9a-f]{64}$/.test(e2.sha256 || ''),
        `bytes=${e2.bytes} lines=${e2.lines} truncated=${e2.truncated}`);
    record('verified_complete', 'the decisive line past the truncation point is matched on the full stream',
        e2.expect && e2.expect.matched === true && e2.expect.lineNo === 4001 && !e2.head.includes('DECISIVE') && !e2.tail.includes('DECISIVE'),
        JSON.stringify(e2.expect || null));
    record('verified_complete', 'the receipt binds task, attempt, tree, brief, report, criteria, rubric and authority',
        receipt.taskId === ok.taskId && receipt.attemptId === recOf(ok.taskId).attemptId && receipt.candidate && receipt.candidate.tree === g(repo, 'rev-parse', 'claude/complete^{tree}')
        && receipt.briefSha256 === sha(BRIEF) && receipt.reportSha256 === sha(fs.readFileSync(ok.report)) && receipt.rubricVersion === ar.RUBRIC_VERSION
        && receipt.authority && /^[0-9a-f]{64}$/.test(receipt.authority.sha256) && receipt.criteria.map((c) => c.id).join() === 'AC1,AC2', receiptFile);
    const wts = g(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
    record('verified_complete', 'the clean checkout is removed afterwards', wts === 2, `${wts} worktrees registered`);
    record('verified_complete', 'the receipt is in the append-only index under its own hash',
        (ar.readIndex(store).rows || []).some((r) => r.receiptSha256 === vv.receipt && r.taskId === ok.taskId), vv.receipt);
    const ck = gateCheck(ok.taskId);
    record('verified_complete', 'check passes on the verified record', ck.status === 0 && ck.value.ok === true, said(ck));
    const a = accept(ok.taskId);
    const va = (recOf(ok.taskId) || {}).verdict || {};
    record('verified_complete', 'accept is recorded on the verified receipt, which the verdict names',
        a.status === 0 && va.decision === 'accept' && va.receipt && va.receipt.sha256 === vv.receipt, said(a));

    // ===================================================== missing_or_changed
    const nb = task('no-brief', { briefFile: path.join(scratch, 'nowhere', 'BRIEF.md') });
    let r = verify(nb.taskId); const r2 = accept(nb.taskId);
    record('missing_or_changed', 'a missing brief is refused by verify and by accept', r.code === 'brief-missing' && r2.code === 'brief-missing', `${said(r)} / ${said(r2)}`);

    const om = task('omitted', { brief: BRIEF.replace('## Notes', '- AC3: the docs mention it\n\n## Notes') });
    r = verify(om.taskId); const r3 = accept(om.taskId);
    record('missing_or_changed', 'a criterion with no check is refused by name', r.code === 'criterion-without-check' && r3.code === 'criterion-without-check'
        && /AC3/.test(r3.json && r3.json.error.message), `${said(r)} / ${said(r3)}`);

    const nc = task('no-criteria', { brief: 'MISSION. Do it.\nACCEPTANCE. it works.\n' });
    r = accept(nc.taskId);
    record('missing_or_changed', 'a brief with no criteria is refused', r.code === 'no-criteria', said(r));

    const tc = task('tree-moves');
    r = verify(tc.taskId);
    fs.writeFileSync(path.join(tc.wt, 'late.txt'), 'changed after verification\n');
    g(tc.wt, 'add', '.');
    g(tc.wt, 'commit', '-q', '-m', 'late');
    const r4 = accept(tc.taskId);
    record('missing_or_changed', 'a tree changed after verification is refused', r.status === 0 && r4.code === 'tree-changed', `${said(r)} / ${said(r4)}`);

    const bc = task('brief-moves');
    r = verify(bc.taskId);
    fs.appendFileSync(bc.briefFile, '- AC9: one more ask\n  check: node -v\n');
    const r5 = accept(bc.taskId);
    record('missing_or_changed', 'a brief changed after verification is refused', r.status === 0 && r5.code === 'brief-changed', `${said(r)} / ${said(r5)}`);

    const at = task('relaunched');
    r = verify(at.taskId);
    patchRecord(at.taskId, { attemptId: crypto.randomUUID(), startedAt: new Date().toISOString() });
    const r6 = accept(at.taskId);
    record('missing_or_changed', 'a receipt from another attempt is refused', r.status === 0 && r6.code === 'receipt-other-attempt', `${said(r)} / ${said(r6)}`);

    const fl = task('fails', { brief: BRIEF.replace('/^sum ok$/', '/^sum perfect$/') });
    r = verify(fl.taskId); const r7 = accept(fl.taskId);
    record('missing_or_changed', 'a receipt with a failed criterion is refused, naming it', r.status === 0 && r.value.complete === false && r7.code === 'criterion-failed'
        && /AC1/.test(r7.json && r7.json.error.message), `${said(r)} / ${said(r7)}`);

    const ov = task('override');
    r = accept(ov.taskId, ['--accept-without-receipt', 'reviewed the diff by hand']);
    const vo = (recOf(ov.taskId) || {}).verdict || {};
    record('missing_or_changed', 'a Brain override stores the refusal it overrode', r.status === 0 && vo.receiptCheck && vo.receiptCheck.code === 'receipt-missing'
        && vo.acceptWithoutReceipt === 'reviewed the diff by hand', said(r));

    // ===================================================== forged_receipt
    const pr = task('claims-pass', { report: 'AC1 PASS\nAC2 PASS\nall acceptance criteria PASS, verified\nRESULT claims-pass done: verified\n' });
    r = accept(pr.taskId);
    record('forged_receipt', 'a report claiming PASS with no receipt is refused', r.code === 'receipt-missing', said(r));

    const fg = task('forged');
    const forged = JSON.parse(JSON.stringify(receipt));
    Object.assign(forged, { taskId: fg.taskId, attemptId: recOf(fg.taskId).attemptId, briefSha256: sha(BRIEF), reportSha256: sha(fs.readFileSync(fg.report)) });
    forged.candidate.tree = g(repo, 'rev-parse', 'claude/forged^{tree}');
    fs.writeFileSync(path.join(fg.workerScratch, 'acceptance-receipt.json'), JSON.stringify(forged, null, 2));
    fs.writeFileSync(path.join(fg.wt, 'acceptance-receipt.json'), JSON.stringify(forged, null, 2));
    r = accept(fg.taskId);
    record('forged_receipt', 'a forged receipt in the worker\'s scratch or worktree is never read', r.code === 'receipt-missing', said(r));

    const jd = task('judge-override');
    r = accept(jd.taskId, ['--by', 'judge', '--accept-without-receipt', 'the report reads done']);
    const r8 = accept(jd.taskId, ['--by', 'judge']);
    record('forged_receipt', 'a judge can neither override nor accept without a receipt', r.code === 'usage' && r8.code === 'receipt-missing' && !(recOf(jd.taskId) || {}).verdict, `${said(r)} / ${said(r8)}`);

    const hw = task('in-worker');
    r = verify(hw.taskId, { AUTODEV_HEADLESS: '1' });
    record('forged_receipt', 'verify refuses to run inside a headless worker', r.code === 'verifier-in-worker', said(r));

    // The failed receipt, rewritten in place to read as a pass.
    const failedRow = (ar.readIndex(store).rows || []).filter((x) => x.taskId === fl.taskId).pop();
    const failedFile = failedRow ? path.join(store, failedRow.file) : '';
    if (failedFile && fs.existsSync(failedFile)) {
        const doc = JSON.parse(fs.readFileSync(failedFile, 'utf8'));
        doc.complete = true; doc.failed = [];
        for (const c of doc.criteria) c.pass = true;
        fs.writeFileSync(failedFile, JSON.stringify(doc, null, 2) + '\n');
    }
    r = accept(fl.taskId);
    record('forged_receipt', 'a receipt rewritten in the store is refused as tampered', r.code === 'receipt-tampered', said(r));

    // Without --ledger the CLI reads the ledger under the config dir: a known task answers as with it.
    const viaFlag = gateCheck(fl.taskId);
    r = cli(SUBJECT, ['check', '--task-id', fl.taskId]);
    record('missing_or_changed', 'the default ledger is the one under the config dir', r.code !== 'unknown-task' && r.code === viaFlag.code && r.status === viaFlag.status, `${said(r)} vs ${said(viaFlag)}`);

    // Last, because it breaks the chain for every later read: an index line appended out of chain.
    const cr = task('chain');
    const row = { seq: 999, at: new Date().toISOString(), taskId: cr.taskId, attemptId: recOf(cr.taskId).attemptId, tree: g(repo, 'rev-parse', 'claude/chain^{tree}'),
        complete: true, receiptSha256: vv.receipt, file: path.relative(store, receiptFile).replace(/\\/g, '/'), prev: 'genesis' };
    fs.appendFileSync(path.join(store, 'index.jsonl'), JSON.stringify(row) + '\n');
    r = accept(cr.taskId);
    record('forged_receipt', 'an index line appended out of chain is refused', r.code === 'receipt-index-broken', said(r));
} catch (e) {
    record('verified_complete', 'the suite ran to the end', false, e.stack.split('\n').slice(0, 3).join(' | '));
} finally {
    try { g(repo, 'worktree', 'prune'); } catch { /* the scratch goes anyway */ }
    fs.rmSync(scratch, { recursive: true, force: true });
}

const word = (name, expected) => (groups[name].length && groups[name].every(Boolean) ? expected : 'MISMATCH');
const summary = `missing_or_changed=${word('missing_or_changed', 'REJECT')} forged_receipt=${word('forged_receipt', 'REJECT')} verified_complete=${word('verified_complete', 'ACCEPT')}`;
console.log(summary);
process.exitCode = summary === 'missing_or_changed=REJECT forged_receipt=REJECT verified_complete=ACCEPT' ? 0 : 1;
