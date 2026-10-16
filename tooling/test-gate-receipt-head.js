#!/usr/bin/env node
// Tests that a plain `npm run gate > log 2>&1` is a gate receipt merge-lock.js
// accepts for the gated head and refuses for any other.
// Run: node tooling/test-gate-receipt-head.js
// Exits 1 on any failure, 0 when all pass.
//
// THE SUBJECTS RUN AS SUBPROCESSES. tooling/gate-lock.js gates a throwaway git
// repo (--root) whose gate:chain is a probe, with the lock skipped
// (AUTODEV_GATE_LOCK=0), and its stdout and stderr share one file descriptor,
// exactly as `> log 2>&1` does. merge-lock.js then reads that log through its
// CLI. Its gh is a stub that answers `pr view` with a CLOSED PR, so a receipt
// merge-lock accepts ends in "is CLOSED, not OPEN" and nothing is merged.
// HOME and USERPROFILE point at the fixture, so the merge lock lands there.

'use strict';

process.env.AUTODEV_CAPACITY = 'off';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GATE_LOCK = path.resolve(__dirname, 'gate-lock.js');
const MERGE_LOCK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'merge-lock.js');
const ml = require(MERGE_LOCK);

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grhead'));
const HOME = path.join(root, 'home');
fs.mkdirSync(HOME, { recursive: true });
const STUB = path.join(root, 'gh-stub.js');
fs.writeFileSync(STUB, `'use strict';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
    process.stdout.write(JSON.stringify({ headRefOid: '0'.repeat(40), baseRefName: 'main', state: 'CLOSED' }));
    return;
}
process.stderr.write('gh stub: unexpected call ' + args.join(' ') + '\\n');
process.exitCode = 1;
`);

function cleanEnv(extra = {}) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^AUTODEV_(GATE|MERGE_LOCK|GH_BIN)/.test(k) || k.startsWith('npm_')) delete env[k];
    return { ...env, AUTODEV_CAPACITY: 'off', ...extra };
}

function git(dir, args) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
}

/** A committed repo whose gate:chain is `chain`; returns its dir and head. */
function fixture(name, chain) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { 'gate:chain': chain } }, null, 2));
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'fixture@example.invalid']);
    git(dir, ['config', 'user.name', 'fixture']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
    git(dir, ['add', 'package.json']);
    git(dir, ['commit', '-q', '-m', 'fixture']);
    return { dir, head: git(dir, ['rev-parse', 'HEAD']) };
}

/** `node gate-lock.js --root dir > log 2>&1`: one fd for both streams. */
function gate(fx) {
    const log = path.join(fx.dir, '..', `${path.basename(fx.dir)}.log`);
    const fd = fs.openSync(log, 'w');
    let r;
    try {
        r = spawnSync(process.execPath, [GATE_LOCK, '--root', fx.dir], {
            cwd: fx.dir, stdio: ['ignore', fd, fd], windowsHide: true, timeout: 120000,
            env: cleanEnv({ AUTODEV_GATE_LOCK: '0' }),
        });
    } finally { fs.closeSync(fd); }
    const text = fs.readFileSync(log, 'utf8');
    return { code: r.status, log, text, lines: text.split(/\r?\n/).filter((l) => l.trim()) };
}

function mergeLock(receipt, head) {
    const r = spawnSync(process.execPath, [MERGE_LOCK, 'merge', '--repo', 'Acme/Widget', '--pr', '7', '--head', head,
        '--gate-receipt', receipt, '--wait-timeout-ms', '5000'], {
        encoding: 'utf8', windowsHide: true, timeout: 60000,
        env: cleanEnv({ HOME, USERPROFILE: HOME, AUTODEV_GH_BIN: STUB, AUTODEV_MERGE_LOCK_READBACK_MS: '0' }),
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const accepted = (m) => /is CLOSED, not OPEN/.test(m.out) && !/gate-receipt/.test(m.out);
const refusedNoHead = (m, head) => m.code === 1 && m.out.includes(`does not name head ${head}`);

/** Another full sha, derived from `sha` so it can never equal it. */
function otherSha(sha) {
    return (sha[0] === 'f' ? 'e' : 'f') + sha.slice(1);
}

function writePlant(name, text) {
    const p = path.join(root, name);
    fs.writeFileSync(p, text);
    return p;
}

try {
    // -- 1. A green chain: the plain log is a receipt for its head only ---------
    {
        const fx = fixture('green', 'node -e "console.log(\'chain ran\')"');
        const g = gate(fx);
        const headLine = `gate-lock: head ${fx.head}`;
        const verdictAt = g.lines.findIndex((l) => l.startsWith('gate-lock: verdict '));
        check('green: the gate exits 0', g.code === 0, `exit=${g.code}\n${g.text}`);
        check('green: the first line names the full head', g.lines[0] === headLine, g.lines[0]);
        check('green: the line before the verdict names the full head', verdictAt > 0 && g.lines[verdictAt - 1] === headLine, g.text);
        check('green: the verdict is the last line and says PASS (exit 0)',
            verdictAt === g.lines.length - 1 && g.lines[verdictAt].startsWith(ml.PASS_LINE), g.text);
        check('green: the chain ran inside the log', g.text.includes('chain ran'), g.text);

        const ok = mergeLock(g.log, fx.head);
        check('green: merge-lock accepts the plain log for the gated head', accepted(ok), `exit=${ok.code}\n${ok.out}`);
        const other = otherSha(fx.head);
        const no = mergeLock(g.log, other);
        check('green: merge-lock refuses the same log for another head', refusedNoHead(no, other), `exit=${no.code}\n${no.out}`);

        // The plant: the real log with every mention of the head swapped for
        // another sha. It is still a valid receipt, for that other sha.
        const plant = writePlant('planted-wrong-sha.log', g.text.split(fx.head).join(other));
        check('plant: the planted log is a receipt for the sha it names', ml.receiptProblem(plant, other) === null,
            ml.receiptProblem(plant, other));
        const p = mergeLock(plant, fx.head);
        check('plant: merge-lock refuses a log whose sha is not the head', refusedNoHead(p, fx.head), `exit=${p.code}\n${p.out}`);
    }

    // -- 2. A chain that prints a nested verdict: the line before the final
    //       verdict is what keeps the receipt valid -------------------------------
    {
        const fx = fixture('nested', 'node -e "console.log(\'gate-lock: verdict PASS (exit 0), a nested gate\')"');
        const g = gate(fx);
        check('nested: the gate exits 0', g.code === 0, `exit=${g.code}\n${g.text}`);
        const ok = mergeLock(g.log, fx.head);
        check('nested: merge-lock accepts it for the gated head', accepted(ok), `exit=${ok.code}\n${ok.out}`);
        const lines = g.text.split('\n');
        const last = lines.map((l) => l.replace(/\r$/, '')).lastIndexOf(`gate-lock: head ${fx.head}`);
        const plant = writePlant('planted-no-final-head.log', lines.filter((_, i) => i !== last).join('\n'));
        const why = ml.receiptProblem(plant, fx.head) || '';
        check('nested: without the line before the verdict, the receipt is refused',
            /only outside the run that printed the last PASS/.test(why), why);
    }

    // -- 3. A red chain: the head is named, the receipt is still refused --------
    {
        const fx = fixture('red', 'node -e "process.exit(1)"');
        const g = gate(fx);
        check('red: the gate exits 1', g.code === 1, `exit=${g.code}\n${g.text}`);
        check('red: the log names the head', g.text.includes(`gate-lock: head ${fx.head}`), g.text);
        const m = mergeLock(g.log, fx.head);
        check('red: merge-lock refuses it', m.code === 1 && /verdict FAIL \(exit 1\)/.test(m.out), `exit=${m.code}\n${m.out}`);
    }

    // -- 4. HEAD moved during the chain: no single head, so INDETERMINATE -------
    {
        const fx = fixture('moved', 'git commit --allow-empty -q -m moved');
        const g = gate(fx);
        const moved = git(fx.dir, ['rev-parse', 'HEAD']);
        check('moved: the chain did move HEAD', moved !== fx.head, moved);
        check('moved: the gate exits 2, not 0', g.code === 2, `exit=${g.code}\n${g.text}`);
        check('moved: the verdict says why', g.text.includes(`HEAD moved during the gate, from ${fx.head} to ${moved}`), g.text);
        const a = mergeLock(g.log, fx.head);
        const b = mergeLock(g.log, moved);
        const onVerdict = /ends with "gate-lock: verdict INDETERMINATE \(exit 2\)"/;
        check('moved: merge-lock refuses it for the start head', a.code === 1 && onVerdict.test(a.out), a.out);
        check('moved: merge-lock refuses it for the end head', b.code === 1 && onVerdict.test(b.out), b.out);
    }
} finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
}
