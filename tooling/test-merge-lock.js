#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/merge-lock.js: one merger per repo,
// a proved head, an unmoved base and a merged tree read back.
// Run: node tooling/test-merge-lock.js
// Exits 1 on any failure, 0 when all pass.
//
// THE SUBJECT RUNS AS A SUBPROCESS against a gh stub. The stub is a node
// script written into the fixture and named by AUTODEV_GH_BIN, because a .cmd
// shim is not found without a shell. It answers the five gh calls merge-lock
// makes from a JSON state file, logs every call with a timestamp and the
// caller's label, and on `pr merge` moves the base branch to the state's
// `afterMerge` commit. HOME and USERPROFILE point at the fixture, so the lock
// lands under a scratch home and never under the real one.
//
// THE LIVENESS CASES USE REAL PIDS. A dead holder is the pid of a node child
// that has exited. On Windows, a live MSYS-only holder is the MSYS pid of a
// Git Bash shell, which tasklist cannot see; that case is skipped, and says
// so, on a host without Git's bash.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'merge-lock.js');
const ml = require(SUBJECT);

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mlock'));
const HOME = path.join(root, 'home');
fs.mkdirSync(HOME, { recursive: true });
const REPO = 'Acme/Widget';
const LOCK = ml.lockPathFor(REPO, HOME);
const sha = (c) => c.repeat(40);
const HEAD = sha('a');
const BASE0 = sha('b');
const MERGED = sha('c');
const TREE = sha('d');

const STUB = path.join(root, 'gh-stub.js');
fs.writeFileSync(STUB, `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const stateFile = process.env.MLOCK_STUB_STATE;
const logFile = process.env.MLOCK_STUB_LOG;
const who = process.env.MLOCK_STUB_WHO || '?';
const log = (what) => fs.appendFileSync(logFile, Date.now() + ' ' + who + ' ' + what + '\\n');
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
log(args.join(' '));
if (st.down) { process.stderr.write('error connecting to api.github.com\\n'); process.exitCode = 1; return; }
const out = (o) => process.stdout.write(JSON.stringify(o));
const prOf = (n) => (st.prs && st.prs[n]) || st.pr;
if (args[0] === 'pr' && args[1] === 'view') { out(prOf(args[2])); return; }
if (args[0] === 'api') {
    const p = args[1];
    let m;
    if ((m = /^repos\\/[^/]+\\/[^/]+\\/branches\\/(.+)$/.exec(p))) {
        const b = st.branches[m[1]];
        out({ name: m[1], commit: { sha: b.sha, commit: { tree: { sha: b.tree } } } });
        return;
    }
    if ((m = /\\/compare\\/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$/.exec(p))) {
        const behind = st.contains ? (st.contains[m[2]] === m[1] ? 0 : 1) : st.behindBy;
        out({ behind_by: behind, ahead_by: 1, files: st.files });
        return;
    }
    if ((m = /\\/contents\\/package\\.json\\?ref=([0-9a-f]{40})$/.exec(p))) {
        if (typeof st.basePkg !== 'string') { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exitCode = 1; return; }
        out({ encoding: 'base64', content: Buffer.from(st.basePkg).toString('base64') });
        return;
    }
    if ((m = /\\/commits\\/([0-9a-f]{40})$/.exec(p))) { out({ sha: m[1], commit: { tree: { sha: st.trees[m[1]] } } }); return; }
}
if (args[0] === 'pr' && args[1] === 'merge') {
    log('merge-start');
    if (st.mergeDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, st.mergeDelayMs);
    const pr = prOf(args[2]);
    if (st.mergeExit) {
        if (st.baseMovesAnyway) { st.branches[pr.baseRefName] = st.baseMovesAnyway; fs.writeFileSync(stateFile, JSON.stringify(st)); }
        process.stderr.write('GraphQL: Head branch was modified\\n');
        process.exitCode = st.mergeExit;
        return;
    }
    const lands = pr.afterMerge || st.afterMerge;
    st.branches[pr.baseRefName] = st.otherWriter || lands;
    st.trees[lands.sha] = lands.tree;
    pr.state = 'MERGED';
    pr.mergeCommit = { oid: lands.sha };
    fs.writeFileSync(stateFile, JSON.stringify(st));
    log('merge-end');
    if (st.exitAfterLanding) { process.stderr.write('Post "https://api.github.com/graphql": net/http: timeout\\n'); process.exitCode = st.exitAfterLanding; }
    return;
}
process.stderr.write('stub: unhandled ' + args.join(' ') + '\\n');
process.exitCode = 1;
`);

const LOG = path.join(root, 'calls.log');
let caseNo = 0;

/** A fresh stub state. `over` replaces top-level keys. */
function writeState(over = {}) {
    const st = {
        pr: { headRefOid: HEAD, baseRefName: 'main', state: 'OPEN' },
        branches: { main: { sha: BASE0, tree: sha('e') } },
        behindBy: 0,
        trees: { [HEAD]: TREE },
        afterMerge: { sha: MERGED, tree: TREE },
        mergeExit: 0,
        mergeDelayMs: 0,
        ...over,
    };
    const file = path.join(root, `state-${++caseNo}.json`);
    fs.writeFileSync(file, JSON.stringify(st));
    return file;
}

const RECEIPT = path.join(root, 'receipt.log');
fs.writeFileSync(RECEIPT, `${HEAD}\n> gate\ngate-lock: lock taken\ngate-lock: verdict PASS (exit 0), the chain finished: the chain exited 0\n`);

function env(stateFile, who, extra = {}) {
    return {
        ...process.env,
        HOME, USERPROFILE: HOME,
        AUTODEV_GH_BIN: STUB,
        AUTODEV_MERGE_LOCK_POLL_MS: '100',
        AUTODEV_MERGE_LOCK_READBACK_MS: '1500',
        MLOCK_STUB_STATE: stateFile,
        MLOCK_STUB_LOG: LOG,
        MLOCK_STUB_WHO: who,
        ...extra,
    };
}

function mergeArgs(extra = []) {
    return [SUBJECT, 'merge', '--repo', REPO, '--pr', '7', '--head', HEAD, '--gate-receipt', RECEIPT, ...extra];
}

function runSync(stateFile, who, extra = [], envExtra = {}) {
    const r = spawnSync(process.execPath, mergeArgs(extra), { encoding: 'utf8', env: env(stateFile, who, envExtra), timeout: 120000, windowsHide: true });
    return { exit: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function calls(who) {
    let text = '';
    try { text = fs.readFileSync(LOG, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).map((l) => {
        const [t, w, ...rest] = l.split(' ');
        return { t: Number(t), who: w, what: rest.join(' ') };
    }).filter((c) => !who || c.who === who);
}

const lockGone = () => !fs.existsSync(LOCK);
const asides = (kind) => fs.readdirSync(path.dirname(LOCK)).filter((n) => n.startsWith(path.basename(LOCK) + `.${kind}-`));
const detail = (r) => `exit ${r.exit}; ${(r.err || r.out).trim().split('\n').slice(-1)[0].slice(0, 160)}`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function main() {
    // -----------------------------------------------------------------------
    // A. In-process: the pieces with no gh.
    // -----------------------------------------------------------------------
    check('A1. the lock path is per repo and case-insensitive',
        ml.lockPathFor('Acme/Widget', HOME) === ml.lockPathFor('acme/widget', HOME)
        && path.basename(LOCK) === 'merge-acme__widget.lock'
        && ml.lockPathFor('acme/other', HOME) !== LOCK, path.basename(LOCK));
    check('A2. a .js AUTODEV_GH_BIN runs under this node; a plain name runs as is',
        ml.ghCommand({ AUTODEV_GH_BIN: STUB }).file === process.execPath
        && ml.ghCommand({}).file === 'gh');
    {
        const f = (name, text, enc = 'utf8') => { const p = path.join(root, name); fs.writeFileSync(p, text, enc); return p; };
        const pass1 = ml.receiptProblem(RECEIPT, HEAD) === null;
        const crlf = ml.receiptProblem(f('r-crlf.log', `${HEAD}\r\ngate-lock: verdict PASS (exit 0), x\r\n`), HEAD) === null;
        const u16 = ml.receiptProblem(f('r-u16.log', Buffer.concat([Buffer.from([0xff, 0xfe]),
            Buffer.from(`${HEAD}\r\ngate-lock: verdict PASS (exit 0)\r\n`, 'utf16le')])), HEAD) === null;
        const wrongHead = /does not name head/.test(ml.receiptProblem(f('r-head.log', `${sha('9')}\ngate-lock: verdict PASS (exit 0)\n`), HEAD) || '');
        const red = /ends with "gate-lock: verdict FAIL \(exit 1\)"/.test(ml.receiptProblem(
            f('r-red.log', `${HEAD}\ngate-lock: verdict PASS (exit 0)\ngate-lock: verdict FAIL (exit 1)\n`), HEAD) || '');
        const unfinished = /no "gate-lock: verdict" line/.test(ml.receiptProblem(f('r-none.log', `${HEAD}\nnpm test\n`), HEAD) || '');
        const missing = /no --gate-receipt/.test(ml.receiptProblem(null, HEAD) || '');
        const OLD = sha('8');
        const laterUnfinished = /goes on after its last verdict/.test(ml.receiptProblem(f('r-cat1.log',
            `${OLD}\ngate-lock: verdict PASS (exit 0)\n${HEAD}\ngate-lock: lock taken\n`), HEAD) || '');
        const earlierRun = /only outside the run that printed the last PASS/.test(ml.receiptProblem(f('r-cat2.log',
            `${HEAD}\ngate-lock: verdict FAIL (exit 1)\n${OLD}\ngate-lock: verdict PASS (exit 0)\n`), HEAD) || '');
        const retryPassed = ml.receiptProblem(f('r-cat3.log',
            `${OLD}\ngate-lock: verdict FAIL (exit 1)\n${HEAD}\ngate-lock: verdict PASS (exit 0)\n`), HEAD) === null;
        check('A4b. in a log of several runs the PASS counts only for the head of the run it ended',
            laterUnfinished && earlierRun && retryPassed,
            `later unfinished run refused ${laterUnfinished}, head only in an earlier run refused ${earlierRun}, retry that passed accepted ${retryPassed}`);
        check('A3. the receipt passes on the PASS line in UTF-8, CRLF and UTF-16LE', pass1 && crlf && u16, `utf8 ${pass1}, crlf ${crlf}, utf16 ${u16}`);
        check('A4. the receipt refuses another head, a last verdict that is not PASS, no verdict and no file',
            wrongHead && red && unfinished && missing, `head ${wrongHead}, red ${red}, unfinished ${unfinished}, missing ${missing}`);

        // A product gate under the wrapper: its own summary table, a status
        // line naming another sha, and the wrapper's closing exit line.
        const table = (exit) => `gate: status base ${OLD} clean\nlint exit 0 12.3\ntest exit ${exit} 88.1\nbuild exit 0 41.0\n`;
        const wrap = (h, exit, closing = `gate-receipt: exit ${exit}`) => `${h}\n${table(exit)}${closing}\n`;
        const why = (name, text) => ml.receiptProblem(f(name, text), HEAD) || '';
        const prodPass = ml.receiptProblem(f('w-pass.log', wrap(HEAD, 0)), HEAD) === null;
        const prodU16 = ml.receiptProblem(f('w-u16.log', Buffer.concat([Buffer.from([0xff, 0xfe]),
            Buffer.from(wrap(HEAD, 0).replace(/\n/g, '\r\n'), 'utf16le')])), HEAD) === null;
        const harnessWrapped = ml.receiptProblem(f('w-harness.log',
            `${HEAD}\n> gate\ngate-lock: verdict PASS (exit 0), the chain finished\n${ml.EXIT_PASS}\n`), HEAD) === null;
        const prodRetry = ml.receiptProblem(f('w-retry.log', wrap(OLD, 1) + wrap(HEAD, 0)), HEAD) === null;
        check('A4c. a wrapper receipt passes for a product gate (UTF-8, UTF-16LE CRLF), a wrapped harness gate and a retry that passed',
            prodPass && prodU16 && harnessWrapped && prodRetry,
            `product ${prodPass}, utf16 ${prodU16}, harness wrapped ${harnessWrapped}, retry ${prodRetry}`);

        // Planted failures, one per refusal the wrapper keeps.
        const otherHead = /does not name head/.test(why('w-other.log', wrap(OLD, 0)));
        const firstShaOther = /starts with 8{40}, not a{40}/.test(why('w-first.log', `${OLD}\nHEAD is ${HEAD}\n${table(0)}${ml.EXIT_PASS}\n`));
        const headEarlierRun = /starts with 8{40}/.test(why('w-earlier.log', wrap(HEAD, 1) + wrap(OLD, 0)));
        const redFinal = /ends with "gate-receipt: exit 1", not "gate-receipt: exit 0"/.test(why('w-red.log', wrap(HEAD, 1)));
        const crashFinal = /ends with "gate-receipt: exit -1073740791"/.test(why('w-crash.log', wrap(HEAD, 0, 'gate-receipt: exit -1073740791')));
        const emptyExit = /ends with "gate-receipt: exit"/.test(why('w-empty.log', wrap(HEAD, 0, 'gate-receipt: exit ')));
        const redAfterPass = /ends with "gate-receipt: exit 1"/.test(why('w-redafter.log', wrap(HEAD, 0) + wrap(HEAD, 1)));
        const trailingRun = /goes on after its last verdict/.test(why('w-trail.log', `${wrap(HEAD, 0)}${HEAD}\nlint exit 0 12.3\n`));
        const trailingLock = /goes on after its last verdict/.test(why('w-trail2.log', `${wrap(HEAD, 0)}gate-lock: lock taken\n`));
        const pipedExit = /also printed "gate-lock: verdict FAIL \(exit 1\)"/.test(why('w-pipe.log',
            `${HEAD}\ngate-lock: verdict FAIL (exit 1)\n${ml.EXIT_PASS}\n`));
        const quoted = /no "gate-receipt:" line/.test(why('w-quoted.log', `${HEAD}\necho "gate-receipt: exit 0"\n`));
        check('A4d. a wrapper receipt refuses another head, another first sha, a head only in an earlier run, a red, crashed or empty exit, a later red run, a trailing unfinished run, a red verdict under exit 0 and a quoted exit line',
            otherHead && firstShaOther && headEarlierRun && redFinal && crashFinal && emptyExit && redAfterPass
            && trailingRun && trailingLock && pipedExit && quoted,
            `other head ${otherHead}, first sha ${firstShaOther}, earlier run ${headEarlierRun}, red ${redFinal}, crash ${crashFinal}, `
            + `empty ${emptyExit}, red after pass ${redAfterPass}, trailing run ${trailingRun}, trailing lock ${trailingLock}, `
            + `piped ${pipedExit}, quoted ${quoted}`);
    }

    {
        // In process, because a Windows child cannot be sent a signal its
        // handler sees: child.kill() there is TerminateProcess.
        const qdir = LOCK.replace(/\.lock$/, '.queue');
        fs.mkdirSync(qdir, { recursive: true });
        const ticket = path.join(qdir, `20261002T000000000Z-${String(process.pid).padStart(10, '0')}.ticket`);
        fs.writeFileSync(ticket, `${process.pid}\nwaiting\n`);
        const exits = [];
        const said = [];
        // A lock that names this process, as a handover in the instant before
        // the signal would leave it.
        fs.writeFileSync(LOCK, `${process.pid}\nhanded over by the queue\n`);
        const holding = { stopped: null, held: true };
        ml.signalHandler({ lockPath: LOCK, state: holding, exit: (c) => exits.push(c), err: (l) => said.push(l) })('SIGINT');
        const keptByHolder = fs.existsSync(LOCK);
        const waiting = { stopped: null, held: false };
        ml.signalHandler({ lockPath: LOCK, state: waiting, exit: (c) => exits.push(c), err: (l) => said.push(l) })('SIGTERM');
        check('A5. the signal handler: a waiter leaves its ticket, releases a lock handed to it and exits 2; a holder only records the signal',
            exits.join(',') === '2' && !fs.existsSync(ticket) && waiting.stopped === 'SIGTERM' && holding.stopped === 'SIGINT'
            && keptByHolder && lockGone() && /INDETERMINATE: stopped by SIGTERM/.test(said[said.length - 1]),
            `exits [${exits}], ticket left ${fs.existsSync(ticket)}, holder kept the lock ${keptByHolder}, waiter released it ${lockGone()}`);
        fs.rmSync(qdir, { recursive: true, force: true });

        // main() passes no exit or err, so the real run uses the defaults: a
        // stderr line and process.exit(2). Called directly in a child, since
        // the default exit ends the process that runs it.
        const otherLock = path.join(root, 'defaults', 'other.lock');
        fs.mkdirSync(path.dirname(otherLock), { recursive: true });
        const probe = [
            `const ml = require(${JSON.stringify(SUBJECT)});`,
            `ml.signalHandler({ lockPath: ${JSON.stringify(otherLock)}, state: { stopped: null, held: false } })('SIGINT');`,
            "console.log('NOT-REACHED');",
        ].join('\n');
        const d = spawnSync(process.execPath, ['-e', probe], {
            encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, HOME, USERPROFILE: HOME },
        });
        check('A5b. with the defaults main() uses, a waiter\'s handler says INDETERMINATE on stderr and exits the process 2',
            d.status === 2 && /INDETERMINATE: stopped by SIGINT while waiting; lock NOT taken/.test(d.stderr || '')
            && !/NOT-REACHED/.test(d.stdout || ''),
            `exit ${d.status}, stderr ${JSON.stringify(String(d.stderr || '').slice(0, 200))}, stdout ${JSON.stringify(String(d.stdout || '').slice(0, 80))}`);
    }

    {
        // A timeout in the instant a holder hands the lock over: takeTurn said
        // "queued", and by the time this waiter leaves, the lock names it.
        fs.writeFileSync(LOCK, `${process.pid}\nhanded over by the queue\n`);
        const fake = { ...require(path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'full-gate-queue.js')),
            takeTurn: () => ({ acquired: false, position: 1, of: 1, holder: null }) };
        const lines = [];
        const got = await ml.acquire({ lockPath: LOCK, what: 'test', timeoutMs: 0, pollMs: 10, log: (l) => lines.push(l), isStopped: () => false, q: fake });
        check('A6. a waiter that times out as the lock is handed to it releases that lock, not leaves it naming itself',
            got === false && lockGone() && lines.some((l) => /handed over while leaving; released it/.test(l)),
            `acquired ${got}, lock present ${!lockGone()}`);
    }

    // -----------------------------------------------------------------------
    // B. Subprocess: one merger.
    // -----------------------------------------------------------------------
    {
        const r = runSync(writeState(), 'ok');
        const merges = calls('ok').filter((c) => c.what.startsWith('pr merge'));
        const argsOk = merges.length === 1 && merges[0].what === `pr merge 7 --repo ${REPO} --rebase --match-head-commit ${HEAD}`;
        check('B1. a proved, current head merges with --rebase --match-head-commit and exits 0', r.exit === 0 && argsOk
            && /matches the proved tree/.test(r.out), detail(r));
        check('B2. the lock is released after the merge (renamed aside, not left held)', lockGone() && asides('released').length >= 1,
            `lock present ${!lockGone()}, released records ${asides('released').length}`);
    }
    {
        const r = runSync(writeState({ pr: { headRefOid: sha('f'), baseRefName: 'main', state: 'OPEN' } }), 'headmm');
        const merged = calls('headmm').some((c) => c.what.startsWith('pr merge'));
        check('B3. a PR head that is not --head is refused before any merge', r.exit === 1 && !merged
            && /not the proved head/.test(r.err) && lockGone(), detail(r));
    }
    {
        const r = runSync(writeState({ behindBy: 2 }), 'moved');
        const merged = calls('moved').some((c) => c.what.startsWith('pr merge'));
        check('B4. a head behind its moved base is refused, naming the rebase', r.exit === 1 && !merged
            && /Rebase onto origin\/main and gate that tree again/.test(r.err) && lockGone(), detail(r));
    }
    {
        const r = runSync(writeState({ afterMerge: { sha: MERGED, tree: sha('9') } }), 'treemm');
        check('B5. a merged tree that differs from the proved tree exits 1 loudly', r.exit === 1
            && /MERGED TREE DIFFERS FROM THE PROVED TREE/.test(r.err) && lockGone(), detail(r));
    }
    {
        const r = runSync(writeState({ down: true }), 'down');
        check('B6. gh unreachable is INDETERMINATE (exit 2), not a refusal', r.exit === 2 && /INDETERMINATE/.test(r.err) && lockGone(), detail(r));
    }
    {
        const r = runSync(writeState({ mergeExit: 1 }), 'ghrefused');
        check('B7. GitHub refusing the merge, base unmoved, is a refusal (exit 1)', r.exit === 1 && /GitHub refused the merge/.test(r.err), detail(r));
    }
    {
        const r = runSync(writeState({ exitAfterLanding: 1 }), 'landed');
        check('B10. gh failing after GitHub accepted the merge is judged by the PR: MERGED with the proved tree exits 0',
            r.exit === 0 && /exited 1, but Acme\/Widget#7 is MERGED/.test(r.out) && /matches the proved tree/.test(r.out) && lockGone(), detail(r));
    }
    {
        const r = runSync(writeState({ otherWriter: { sha: sha('5'), tree: sha('4') } }), 'other');
        check('B11. another writer moving the base after this merge is reported, not read as this merge\'s tree',
            r.exit === 0 && new RegExp(`merged ${REPO}#7 as ${MERGED}`).test(r.out) && /has since moved to 5{40}/.test(r.out), detail(r));
    }
    {
        const r = runSync(writeState({ mergeExit: 1, baseMovesAnyway: { sha: sha('5'), tree: TREE } }), 'notours');
        check('B12. a refused merge is a refusal even when the base moves to the proved tree by another hand',
            r.exit === 1 && /GitHub refused the merge/.test(r.err) && /is OPEN/.test(r.err), detail(r));
    }
    {
        const r = runSync(writeState({ pr: { headRefOid: HEAD, baseRefName: 'main', state: 'MERGED' } }), 'closed');
        check('B8. a PR that is not OPEN is refused', r.exit === 1 && /not OPEN/.test(r.err), detail(r));
    }
    {
        const r = spawnSync(process.execPath, [SUBJECT, 'merge', '--repo', REPO, '--pr', '7', '--head', HEAD],
            { encoding: 'utf8', env: env(writeState(), 'noreceipt'), timeout: 60000, windowsHide: true });
        const touched = calls('noreceipt').length;
        check('B9. no --gate-receipt is refused before gh or the lock is touched', r.status === 1 && touched === 0
            && /no --gate-receipt/.test(r.stderr) && lockGone(), `exit ${r.status}, gh calls ${touched}`);
    }
    {
        // The product receipt as PowerShell's *> writes it: UTF-16LE, CRLF.
        const u16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\n/g, '\r\n'), 'utf16le')]);
        const pass = path.join(root, 'product-pass.log');
        const red = path.join(root, 'product-red.log');
        fs.writeFileSync(pass, u16(`${HEAD}\nlint exit 0 12.3\ntest exit 0 88.1\ngate-receipt: exit 0\n`));
        fs.writeFileSync(red, u16(`${HEAD}\nlint exit 0 12.3\ntest exit 1 88.1\ngate-receipt: exit 1\n`));
        const run = (file, who) => {
            const r = spawnSync(process.execPath, [SUBJECT, 'merge', '--repo', REPO, '--pr', '7', '--head', HEAD, '--gate-receipt', file],
                { encoding: 'utf8', env: env(writeState(), who), timeout: 120000, windowsHide: true });
            return { exit: r.status, out: r.stdout || '', err: r.stderr || '' };
        };
        const ok = run(pass, 'product');
        const merged = calls('product').filter((c) => c.what.startsWith('pr merge')).length;
        check('B13. a product gate\'s wrapper receipt merges through the lock like a harness receipt',
            ok.exit === 0 && merged === 1 && /matches the proved tree/.test(ok.out) && lockGone(), detail(ok));
        const no = run(red, 'productred');
        const touched = calls('productred').length;
        check('B14. a product gate\'s red wrapper receipt is refused before gh or the lock is touched',
            no.exit === 1 && touched === 0 && /ends with "gate-receipt: exit 1"/.test(no.err) && lockGone(), detail(no));
    }

    {
        // F. The fast-lane receipt. Each receipt and file list is written by
        // hand here, not by fast-lane.js, so a change to its writer or its
        // classifier cannot move these fixtures with it.
        const green = {
            kind: 'autodev-fast-lane-receipt', version: 1, head: HEAD, tree: TREE,
            base: { ref: 'origin/main', sha: BASE0 },
            classifier: { eligible: true, changedLines: 12, maxLines: 100, files: 2, reasons: [] },
            steps: [
                { step: 'lint', script: 'lint', command: 'npm run lint', exit: 0, ms: 5 },
                { step: 'typecheck', script: 'typecheck', command: 'npm run typecheck', exit: 0, ms: 5 },
                { step: 'test', script: 'test', command: 'npm run test', exit: 0, ms: 5 },
                { step: 'build', script: 'build', command: 'npm run build', exit: 0, ms: 5 },
            ],
            exit: 0, finishedAt: '2026-10-07T00:00:00.000Z',
        };
        const smallFiles = [
            { filename: 'src/components/Footer.tsx', status: 'modified', additions: 8, deletions: 2, changes: 10, patch: '@@' },
            { filename: 'README.md', status: 'modified', additions: 2, deletions: 0, changes: 2, patch: '@@' },
        ];
        let n = 0;
        const receipt = (over) => {
            const file = path.join(root, `fast-${++n}.json`);
            fs.writeFileSync(file, JSON.stringify({ ...green, ...over }));
            return file;
        };
        const runFast = (file, who, state = {}, extra = []) => {
            const r = spawnSync(process.execPath, [SUBJECT, 'merge', '--repo', REPO, '--pr', '7', '--head', HEAD, '--fast-lane-receipt', file, ...extra],
                { encoding: 'utf8', env: env(writeState({ files: smallFiles, ...state }), who), timeout: 120000, windowsHide: true });
            return { exit: r.status, out: r.stdout || '', err: r.stderr || '' };
        };
        const merges = (who) => calls(who).filter((c) => c.what.startsWith('pr merge')).length;

        const ok = runFast(receipt({}), 'fl-green');
        check('F1. a green fast-lane receipt on an eligible GitHub diff merges through the lock',
            ok.exit === 0 && merges('fl-green') === 1 && /fast lane: 12 changed lines in 2 file\(s\)/.test(ok.out)
            && /matches the proved tree/.test(ok.out) && lockGone(), detail(ok));

        const redSteps = green.steps.map((s) => (s.step === 'test' ? { ...s, exit: 1 } : s));
        const pre = [
            ['a red test step', receipt({ steps: redSteps }), /test exited 1/],
            ['a missing build step', receipt({ steps: green.steps.slice(0, 3) }), /has no build step/],
            ['an ineligible verdict', receipt({ classifier: { eligible: false, reasons: ['src/auth/x.ts matches the sensitive pattern auth'] } }), /classifier said ineligible \(src\/auth/],
            ['another head', receipt({ head: sha('f') }), /proves f{40}, not head/],
            ['a red run exit', receipt({ exit: 1 }), /the run exited 1/],
            ['a gate log in place of JSON', RECEIPT, /as JSON/],
        ];
        const preOut = pre.map(([label, file, re], i) => {
            const r = runFast(file, `fl-pre${i}`);
            return { label, ok: r.exit === 1 && calls(`fl-pre${i}`).length === 0 && re.test(r.err) && lockGone(), r };
        });
        check('F2. a fast-lane receipt with a red step, a missing step, an ineligible verdict, another head, a red exit or no JSON is refused before gh or the lock',
            preOut.every((x) => x.ok), preOut.filter((x) => !x.ok).map((x) => `${x.label}: ${detail(x.r)}`).join(' | '));

        const both = runFast(receipt({}), 'fl-both', {}, ['--gate-receipt', RECEIPT]);
        check('F3. --gate-receipt and --fast-lane-receipt together are refused before gh',
            both.exit === 1 && calls('fl-both').length === 0 && /not both/.test(both.err), detail(both));

        const tree = runFast(receipt({ tree: sha('9') }), 'fl-tree');
        check('F4. a receipt for another tree is refused under the lock, before any merge',
            tree.exit === 1 && merges('fl-tree') === 0 && /proves tree 9{40}, but/.test(tree.err) && lockGone(), detail(tree));

        // GitHub's diff decides, whatever the receipt's classifier said.
        const gh = [
            ['an auth path', [{ filename: 'app/api/auth/callback.ts', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '@@' }], /matches the sensitive pattern auth/],
            ['101 lines', [{ filename: 'src/a.ts', status: 'modified', additions: 100, deletions: 1, changes: 101, patch: '@@' }], /101 changed lines, over the 100-line limit/],
            ['a migration', [{ filename: 'supabase/migrations/0042_add.sql', status: 'added', additions: 4, deletions: 0, changes: 4, patch: '@@' }], /matches the sensitive pattern migration/],
            ['a binary file', [{ filename: 'public/logo.png', status: 'modified', additions: 0, deletions: 0, changes: 0 }], /has no line count/],
            ['a rename out of billing', [{ filename: 'src/lib/money.ts', previous_filename: 'src/billing/money.ts', status: 'renamed', additions: 0, deletions: 0, changes: 0 }], /billing\/money\.ts matches the sensitive pattern billing/],
            ['no file list', undefined, /the diff could not be read/],
        ];
        const ghOut = gh.map(([label, files, re], i) => {
            const r = runFast(receipt({}), `fl-gh${i}`, { files });
            return { label, ok: r.exit === 1 && merges(`fl-gh${i}`) === 0 && re.test(r.err) && lockGone(), r };
        });
        check('F5. an eligible receipt is refused when GitHub\'s own diff has an auth path, 101 lines, a migration, a binary, a rename out of billing or no file list',
            ghOut.every((x) => x.ok), ghOut.filter((x) => !x.ok).map((x) => `${x.label}: ${detail(x.r)}`).join(' | '));

        const strict = runFast(receipt({}), 'fl-cfg', { basePkg: JSON.stringify({ autodevFastLane: { maxLines: 5, sensitive: ['^readme'] } }) });
        check('F6. the base package.json config is read through GitHub: a 5-line limit and an extra pattern refuse a 12-line diff touching README.md',
            strict.exit === 1 && merges('fl-cfg') === 0 && /12 changed lines, over the 5-line limit/.test(strict.err)
            && /README\.md matches the sensitive pattern autodevFastLane\.sensitive \^readme/.test(strict.err), detail(strict));
        const broken = runFast(receipt({}), 'fl-cfgbad', { basePkg: '{ not json' });
        check('F7. an unreadable base package.json refuses the fast lane rather than reading as no config',
            broken.exit === 1 && merges('fl-cfgbad') === 0 && /config at main .* is unreadable/.test(broken.err), detail(broken));
    }

    // -----------------------------------------------------------------------
    // C. Two mergers on one repo: the second waits for the first.
    // -----------------------------------------------------------------------
    {
        const sa = writeState({ mergeDelayMs: 2500 });
        const sb = writeState();
        const start = (who, st) => {
            const c = spawn(process.execPath, mergeArgs(), { env: env(st, who), windowsHide: true });
            const o = { out: '', err: '', exit: null, child: c };
            c.stdout.on('data', (d) => { o.out += d; });
            c.stderr.on('data', (d) => { o.err += d; });
            o.done = new Promise((res) => c.on('close', (code) => { o.exit = code; res(); }));
            return o;
        };
        const a = start('A', sa);
        for (let i = 0; i < 200 && !/lock taken/.test(a.out); i++) await sleep(50);
        const b = start('B', sb);
        await Promise.all([a.done, b.done]);
        const aEnd = calls('A').filter((c) => c.what === 'merge-end').map((c) => c.t)[0];
        const bFirst = calls('B').map((c) => c.t)[0];
        const waited = new RegExp(`waiting for merge-acme__widget\\.lock: place 1 of 1\\. Held by pid ${a.child.pid}: merge-lock\\.js merge ${REPO}#7`).test(b.out);
        check('C1. a second merger waits, naming the holder, and starts only after the first merge ended',
            a.exit === 0 && b.exit === 0 && waited && aEnd !== undefined && bFirst !== undefined && bFirst >= aEnd,
            `A exit ${a.exit}, B exit ${b.exit}, B printed the holder ${waited}, B's first gh call ${bFirst - aEnd} ms after A's merge ended`);
        check('C2. both locks were released', lockGone(), `lock present ${!lockGone()}`);
    }

    {
        // One shared remote: A's merge moves main, so B's candidate, gated on
        // the old main, is now behind and must be refused.
        const HEAD2 = sha('3');
        const R2 = path.join(root, 'receipt2.log');
        fs.writeFileSync(R2, `${HEAD2}\ngate-lock: verdict PASS (exit 0)\n`);
        const shared = writeState({
            mergeDelayMs: 1500,
            prs: {
                7: { headRefOid: HEAD, baseRefName: 'main', state: 'OPEN', afterMerge: { sha: MERGED, tree: TREE } },
                8: { headRefOid: HEAD2, baseRefName: 'main', state: 'OPEN', afterMerge: { sha: sha('2'), tree: sha('1') } },
            },
            contains: { [HEAD]: BASE0, [HEAD2]: BASE0 },
            trees: { [HEAD]: TREE, [HEAD2]: sha('1') },
        });
        const go = (who, args) => {
            const c = spawn(process.execPath, args, { env: env(shared, who), windowsHide: true });
            const o = { out: '', err: '', exit: null };
            c.stdout.on('data', (d) => { o.out += d; });
            c.stderr.on('data', (d) => { o.err += d; });
            o.done = new Promise((res) => c.on('close', (code) => { o.exit = code; res(); }));
            return o;
        };
        const a = go('S7', mergeArgs());
        for (let i = 0; i < 200 && !/lock taken/.test(a.out); i++) await sleep(50);
        const b = go('S8', [SUBJECT, 'merge', '--repo', REPO, '--pr', '8', '--head', HEAD2, '--gate-receipt', R2]);
        await Promise.all([a.done, b.done]);
        const bMerged = calls('S8').some((c) => c.what.startsWith('pr merge'));
        check('C3. two PRs on one base: after the first merges, the second, gated on the old base, is refused as behind',
            a.exit === 0 && b.exit === 1 && !bMerged && new RegExp(`behind main at ${MERGED}`).test(b.err) && lockGone(),
            `A exit ${a.exit}, B exit ${b.exit}, B merged ${bMerged}; ${b.err.trim().slice(0, 120)}`);
    }

    // -----------------------------------------------------------------------
    // D. Liveness: a dead holder is reclaimed, a live holder is not.
    // -----------------------------------------------------------------------
    {
        const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
        fs.mkdirSync(path.dirname(LOCK), { recursive: true });
        fs.writeFileSync(LOCK, `${dead}\nmerge-lock.js merge ${REPO}#6 head x, started earlier\n`);
        const before = asides('stale').length;
        const r = runSync(writeState(), 'dead', ['--wait-timeout-ms', '20000']);
        check('D1. a dead holder\'s lock is moved aside to .stale-HHMM and the merge proceeds',
            r.exit === 0 && asides('stale').length === before + 1 && /is not running; moved its lock aside/.test(r.out), detail(r));
    }
    if (process.platform !== 'win32') {
        // POSIX has one pid table, so "live by ps only" cannot happen; a live
        // holder is any running process.
        const live = spawn('sleep', ['30']);
        fs.writeFileSync(LOCK, `${live.pid}\nmerge-lock.js merge ${REPO}#5 head y, started earlier\n`);
        const r = runSync(writeState(), 'live', ['--wait-timeout-ms', '1500']);
        const still = fs.existsSync(LOCK) && fs.readFileSync(LOCK, 'utf8').startsWith(`${live.pid}\n`);
        live.kill();
        check('D2. a live holder is not reclaimed: the waiter times out INDETERMINATE and the lock is untouched',
            r.exit === 2 && still && /Held by pid/.test(r.out), detail(r));
        try { fs.unlinkSync(LOCK); } catch { /* gone */ }
    } else {
        const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
        const bashExe = !ex.error && ex.status === 0 ? path.resolve(ex.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'bash.exe') : null;
        if (!bashExe || !fs.existsSync(bashExe)) {
            skipped++;
            console.log('SKIP  D2. live MSYS-only holder: no Git bash.exe on this host');
        } else {
            let shell = null;
            let msysPid = null;
            for (let tries = 0; tries < 3 && msysPid === null; tries++) {
                shell = spawn(bashExe, ['-c', 'echo $$; sleep 25'], { windowsHide: true });
                const got = await new Promise((res) => {
                    let buf = '';
                    shell.stdout.on('data', (d) => { buf += d; const m = /^(\d+)\s/.exec(buf); if (m) res(Number(m[1])); });
                    setTimeout(() => res(null), 10000);
                });
                const t = spawnSync('tasklist', ['/FI', `PID eq ${got}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
                if (got && !new RegExp(`"${got}"`).test(t.stdout || '')) msysPid = got;
                else shell.kill();
            }
            if (msysPid === null) {
                fail++; failures.push('D2 setup');
                console.log('FAIL  D2. could not get an MSYS pid that tasklist does not list (3 tries)');
            } else {
                fs.writeFileSync(LOCK, `${msysPid}\nmerge-lock.js merge ${REPO}#5 head y, started earlier\n`);
                const r = runSync(writeState(), 'msys', ['--wait-timeout-ms', '1500']);
                const still = fs.existsSync(LOCK) && fs.readFileSync(LOCK, 'utf8').startsWith(`${msysPid}\n`);
                shell.kill();
                check('D2. a live holder seen only by ps (an MSYS pid tasklist cannot list) is not reclaimed',
                    r.exit === 2 && still && /Held by pid/.test(r.out) && !calls('msys').length,
                    `MSYS pid ${msysPid}, Windows pid ${shell.pid}; ${detail(r)}`);
                try { fs.unlinkSync(LOCK); } catch { /* gone */ }
            }
        }
    }

    // -----------------------------------------------------------------------
    // E. The other entry points: --help returns, status reads the lock, and a
    //    bad argument is refused before anything is touched.
    // -----------------------------------------------------------------------
    {
        const h = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8', env: env(writeState(), 'help'), timeout: 30000, windowsHide: true });
        check('E1. --help prints usage and exits 0 without calling gh', h.status === 0 && /^usage: node merge-lock\.js merge/.test(h.stdout)
            && !calls('help').length, `exit ${h.status}`);
        fs.mkdirSync(path.dirname(LOCK), { recursive: true });
        fs.writeFileSync(LOCK, `${process.pid}\nmerge-lock.js merge ${REPO}#4 head z, started earlier\n`);
        const st = spawnSync(process.execPath, [SUBJECT, 'status', '--repo', REPO], { encoding: 'utf8', env: env(writeState(), 'status'), timeout: 30000, windowsHide: true });
        fs.unlinkSync(LOCK);
        const free = spawnSync(process.execPath, [SUBJECT, 'status', '--repo', 'acme/widget'], { encoding: 'utf8', env: env(writeState(), 'status'), timeout: 30000, windowsHide: true });
        check('E2. status names the holder, and says free when nobody holds it', st.status === 0
            && new RegExp(`pid ${process.pid}: merge-lock\\.js merge ${REPO}#4`).test(st.stdout) && free.status === 0 && /: free; 0 queued/.test(free.stdout),
            `held: ${st.stdout.trim().slice(-80)}; free: ${free.stdout.trim().slice(-40)}`);
        const bad = [
            ['merge', '--repo', 'not-a-repo', '--pr', '7', '--head', HEAD, '--gate-receipt', RECEIPT],
            ['merge', '--repo', REPO, '--pr', 'x', '--head', HEAD, '--gate-receipt', RECEIPT],
            ['merge', '--repo', REPO, '--pr', '7', '--head', 'abc123', '--gate-receipt', RECEIPT],
            ['merge', '--repo', REPO, '--pr', '7', '--head', HEAD, '--gate-receipt', RECEIPT, '--wait-timeout-ms', 'soon'],
            ['merge', '--repo'],
            ['frobnicate', '--repo', REPO],
        ].map((a) => spawnSync(process.execPath, [SUBJECT, ...a], { encoding: 'utf8', env: env(writeState(), 'bad'), timeout: 30000, windowsHide: true }));
        check('E3. a malformed repo, PR, head, timeout, a missing value and an unknown command are refused before gh',
            bad.every((r) => r.status === 1 && /REFUSED/.test(r.stderr)) && !calls('bad').length && lockGone(),
            bad.map((r) => r.status).join(','));
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
    console.log(`subject: plugins/autodev-core/scripts/merge-lock.js, driven ${caseNo} times as a subprocess against a gh stub `
        + 'under a scratch HOME, plus its exported receipt and path helpers in process.');
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
    console.error(`test-merge-lock: ${e && e.stack ? e.stack : e}`);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exitCode = 2;
});
