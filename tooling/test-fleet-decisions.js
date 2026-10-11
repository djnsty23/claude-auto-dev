#!/usr/bin/env node
'use strict';
// Suite for fleet-decisions.js.
//
// The case it exists for: a SECOND session recording on a subject a FIRST one
// already decided must be refused and shown the prior entry. A log that accepts
// both and lets a reader notice later is the per-repo DECISIONS.md failure again
// with extra steps — [measured 2026-08-28] two sessions wrote opposite pricing
// decisions into one file on two unpushed branches and neither saw the other.
//
// CLAUDE_CONFIG_DIR is the seam; the developer's own fleet log is never touched.
//
// Run: node tooling/test-fleet-decisions.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-decisions.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-decisions-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, name.startsWith('CONCURRENT:') ? 8192 : 300) : ''));
}

let n = 0;
function freshCfg() {
    const c = path.join(ROOT, 'cfg-' + (n++));
    fs.mkdirSync(c, { recursive: true });
    return c;
}

function run(cfg, argv) {
    return spawnSync(process.execPath, [SUBJECT].concat(argv), {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg }),
    });
}

const rec = (cfg, extra) => run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
    '--decision', 'd', '--author', 'a'].concat(extra || []));

// ------------------------------------------------------------- the refusals

{
    const cfg = freshCfg();
    check('--record without --repo refused',
        run(cfg, ['--record', '--subject', 's', '--decision', 'd', '--author', 'a']).status === 2);
    check('--record without --subject refused',
        run(cfg, ['--record', '--repo', 'r', '--decision', 'd', '--author', 'a']).status === 2);
    check('--record without --decision refused',
        run(cfg, ['--record', '--repo', 'r', '--subject', 's', '--author', 'a']).status === 2);
    // Author is the one that makes a decision arguable. Unsigned decisions are
    // what nobody can push back on, which is how a collision becomes permanent.
    const r = run(cfg, ['--record', '--repo', 'r', '--subject', 's', '--decision', 'd']);
    check('--record without --author refused', r.status === 2);
    check('and it says why an author matters', /argued with/.test(r.stderr || ''), r.stderr);
    check('--check without --subject refused', run(cfg, ['--check', '--repo', 'r']).status === 2);
    check('no verb at all is refused', run(cfg, []).status === 2);
}

// ------------------------------------------------- THE CASE THIS EXISTS FOR

{
    const cfg = freshCfg();
    check('first record succeeds', rec(cfg).status === 0);

    const r = run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
        '--decision', 'the opposite', '--author', 'other-session']);
    check('a SECOND author on the same subject is REFUSED', r.status === 3, 'status ' + r.status);
    check('and is shown the prior decision, not just told one exists',
        /by a\b/.test(r.stderr || '') && /\bd\b/.test(r.stderr || ''), r.stderr);
    // Whitespace-normalised: the message wraps, so "owns the product" spans a
    // newline and a line-oriented regex returns 0 against text that is plainly
    // there. This suite hit that on its first run; it is the same trap the brain
    // rules record for prose in rules files.
    const flat = (r.stderr || '').replace(/\s+/g, ' ');
    check('and is told not to settle it by writing a later line',
        /owns the product/.test(flat), flat);

    // The SAME author revising their own decision is not a collision.
    check('the same author may record again', rec(cfg).status === 0);

    // --force is the deliberate override, for a peer that agrees.
    const f = run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
        '--decision', 'agreeing', '--author', 'other-session', '--force']);
    check('--force lets a second author record deliberately', f.status === 0, f.stderr);
}

{
    // Scoping: a different REPO is not a collision, or every repo sharing a topic
    // name would block the others.
    const cfg = freshCfg();
    rec(cfg);
    const r = run(cfg, ['--record', '--repo', 'other-repo', '--subject', 'ai-pricing',
        '--decision', 'x', '--author', 'b']);
    check('the same subject in a DIFFERENT repo is not a collision', r.status === 0, r.stderr);
}

{
    // Normalisation. A key that is easy to miss by punctuation detects nothing —
    // two sessions will never type the same casing.
    const cfg = freshCfg();
    run(cfg, ['--record', '--repo', 'qr', '--subject', 'AI Pricing', '--decision', 'd', '--author', 'a']);
    const r = run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
        '--decision', 'opposite', '--author', 'b']);
    check('"AI Pricing" and "ai-pricing" collide', r.status === 3, r.stderr);
    const c = run(cfg, ['--check', '--repo', 'qr', '--subject', 'ai   pricing']);
    check('and --check normalises the same way', /1 prior decision/.test(c.stdout || ''), c.stdout);
}

// ------------------------------------------------------- check / list / absence

{
    const cfg = freshCfg();
    const r = run(cfg, ['--check', '--repo', 'qr', '--subject', 'anything']);
    check('--check on an empty log exits 0', r.status === 0);
    check('--check says the absence is real, not an unread file',
        /real absence/.test(r.stdout || ''), r.stdout);
}

{
    const cfg = freshCfg();
    rec(cfg);
    const r = run(cfg, ['--check', '--repo', 'qr', '--subject', 'something-else']);
    // The honest caveat: this only knows what was RECORDED. Absence here is
    // weaker evidence than presence, and saying so stops a reader treating a
    // clean --check as proof nobody is working on it.
    check('--check on an unseen subject warns that absence is weak evidence',
        /weaker evidence/.test(r.stdout || ''), r.stdout);
}

{
    // --list must surface contested subjects rather than leave them to be spotted
    // in a wall of entries. That surfacing IS the product.
    const cfg = freshCfg();
    rec(cfg);
    run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing', '--decision', 'z', '--author', 'b', '--force']);
    run(cfg, ['--record', '--repo', 'qr', '--subject', 'quiet-topic', '--decision', 'q', '--author', 'a']);
    const r = run(cfg, ['--list']);
    check('--list flags subjects with more than one author',
        /decided by MORE THAN ONE session/.test(r.stdout || ''), r.stdout);
    check('--list names the contested subject', /qr\/ai-pricing/.test(r.stdout || ''), r.stdout);
    check('--list does NOT flag the single-author subject as contested',
        !/quiet-topic\s+\(\d+ authors\)/.test(r.stdout || ''), r.stdout);
    check('--list prints the population it scanned', /population: 3/.test(r.stdout || ''), r.stdout);
}

{
    // One malformed line must not blind the rest — a log is append-only from
    // several writers, so a torn write is a question of when, not if.
    const cfg = freshCfg();
    rec(cfg);
    const log = path.join(cfg, 'fleet', 'DECISIONS.jsonl');
    fs.appendFileSync(log, '{ torn write\n', 'utf8');
    run(cfg, ['--record', '--repo', 'qr', '--subject', 'later', '--decision', 'l', '--author', 'a']);
    const r = run(cfg, ['--list']);
    check('a torn line is skipped and the rest still read',
        /population: 2/.test(r.stdout || ''), r.stdout);
    check('and the collision check still works past it',
        run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
            '--decision', 'x', '--author', 'zz']).status === 3);
}

// ------------------------------------------------- number reservation (--next)
//
// [measured 2026-08-28] FOUR numbering collisions in one repo in one day. Two
// branches allocated D18 for different decisions; later two allocated D22
// simultaneously, "from a namespace neither could see" — each read the next
// number off its own unpushed DECISIONS.md while origin/main sat behind both.
//
// The contradiction check cannot help: the numbers are not in conflict, they are
// identical, and each file is internally consistent. The NAMESPACE is the shared
// resource, and it was being allocated from private copies.

{
    const cfg = freshCfg();
    const a = run(cfg, ['--next', '--repo', 'qr', '--author', 'session-a', '--floor', '23']);
    check('--next prints just the id on stdout, so it can be captured',
        a.stdout.trim() === 'D24', JSON.stringify(a.stdout));
    check('and exits 0', a.status === 0, a.stderr);
    // THE ASSERTION THIS EXISTS FOR: a different session must never get the same
    // number, without either of them fetching anything.
    const b = run(cfg, ['--next', '--repo', 'qr', '--author', 'session-b']);
    check('a SECOND session gets the next number, not the same one',
        b.stdout.trim() === 'D25', JSON.stringify(b.stdout));
    const c = run(cfg, ['--next', '--repo', 'qr', '--author', 'session-c']);
    check('and a third continues the sequence', c.stdout.trim() === 'D26', JSON.stringify(c.stdout));
}

{
    // Scoped per repo, or every project would share one counter.
    const cfg = freshCfg();
    run(cfg, ['--next', '--repo', 'qr', '--author', 'a', '--floor', '40']);
    const other = run(cfg, ['--next', '--repo', 'other', '--author', 'a']);
    check('a different repo has its own namespace', other.stdout.trim() === 'D1', other.stdout);
}

{
    // The floor exists so the first reservation in a repo that already has 23
    // entries on disk does not restart at 1 and collide with all of them.
    const cfg = freshCfg();
    const r = run(cfg, ['--next', '--repo', 'qr', '--author', 'a', '--floor', '99']);
    check('--floor lifts the first reservation above what is already on disk',
        r.stdout.trim() === 'D100', r.stdout);
    // ...and does NOT lower a sequence that has already passed it.
    const r2 = run(cfg, ['--next', '--repo', 'qr', '--author', 'b', '--floor', '2']);
    check('a lower --floor cannot rewind the sequence', r2.stdout.trim() === 'D101', r2.stdout);
}

{
    const cfg = freshCfg();
    const r = run(cfg, ['--next', '--repo', 'qr', '--author', 'a', '--prefix', 'ADR']);
    check('--prefix is honoured', r.stdout.trim() === 'ADR1', r.stdout);
    // Prefixes are separate namespaces: D and ADR must not share a counter.
    const d = run(cfg, ['--next', '--repo', 'qr', '--author', 'a']);
    check('and a different prefix has its own counter', d.stdout.trim() === 'D1', d.stdout);
}

{
    const cfg = freshCfg();
    check('--next without --author is refused',
        run(cfg, ['--next', '--repo', 'qr']).status === 2);
    check('--next without --repo is refused',
        run(cfg, ['--next', '--author', 'a']).status === 2);
}

{
    // A reservation is visible to --list, because it lives in the same log. If it
    // were stored separately it could be lost independently of the decisions,
    // which is the failure mode the sibling-record incident already demonstrated.
    const cfg = freshCfg();
    run(cfg, ['--next', '--repo', 'qr', '--author', 'a', '--floor', '5']);
    const l = run(cfg, ['--list', '--repo', 'qr']);
    check('a reservation appears in --list', /reserved D6/.test(l.stdout || ''), l.stdout);
}

function releaseSafetyChecks() {
    const preload = path.join(ROOT, 'release-safety.js');
    fs.writeFileSync(preload, `const fs = require('fs'), path = require('path');
const log = path.join(process.env.CLAUDE_CONFIG_DIR, 'fleet', 'DECISIONS.jsonl');
const open = fs.openSync;
let lockFd;
fs.openSync = function(p, ...args) {
  const fd = open.call(this, p, ...args);
  if (String(p) === log + '.lock') lockFd = fd;
  return fd;
};
const append = fs.appendFileSync;
fs.appendFileSync = function(p, ...args) {
  if (String(p) === log && process.env.FLEET_TEST_SAFETY === 'append-failure')
    throw new Error('fixture append failure');
  const result = append.call(this, p, ...args);
  if (String(p) === log && process.env.FLEET_TEST_SAFETY === 'replacement') {
    fs.renameSync(log + '.lock', log + '.retired-lock');
    fs.writeFileSync(log + '.lock', 'foreign replacement');
  }
  return result;
};
if (process.env.FLEET_TEST_SAFETY === 'descriptor') {
  const logOutput = console.log;
  console.log = function(...args) {
    if (/^D\\d+$/.test(String(args[0]))) {
      const fd = fs.openSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'witness'), 'w');
      process.once('exit', () => {
        fs.writeSync(fd, JSON.stringify({ lockFd, witnessFd: fd, remainsOwned: true }));
        fs.closeSync(fd);
      });
    }
    return logOutput.apply(this, args);
  };
}`);
    for (const mode of ['replacement', 'descriptor', 'append-failure']) {
        const cfg = freshCfg();
        fs.mkdirSync(path.join(cfg, 'fleet'));
        const log = path.join(cfg, 'fleet', 'DECISIONS.jsonl');
        fs.writeFileSync(log, '');
        const result = spawnSync(process.execPath, ['--require', preload, SUBJECT,
            '--next', '--repo', 'safety', '--author', 'fixture'], {
            encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, FLEET_TEST_SAFETY: mode },
        });
        if (mode === 'replacement') {
            check('release: never removes a different lock identity',
                result.status === 0 && fs.existsSync(log + '.lock') &&
                fs.readFileSync(log + '.lock', 'utf8') === 'foreign replacement', result.stderr);
        } else if (mode === 'descriptor') {
            const witness = fs.existsSync(path.join(cfg, 'witness')) &&
                fs.readFileSync(path.join(cfg, 'witness'), 'utf8');
            const identity = witness && JSON.parse(witness);
            check('release: exit fallback cannot close a subsequently owned descriptor',
                result.status === 0 && identity && identity.remainsOwned === true &&
                Number.isInteger(identity.lockFd) && identity.witnessFd === identity.lockFd,
                JSON.stringify({ witness: identity, stderr: result.stderr }));
        } else {
            check('release: failed append stays failed and releases only its owned lock',
                result.status !== 0 && /fixture append failure/.test(result.stderr || '') &&
                !fs.existsSync(log + '.lock') && fs.readFileSync(log, 'utf8') === '', result.stderr);
        }
    }
}

releaseSafetyChecks();

// A completed transaction must not retain the lock for unrelated output or
// earlier exit listeners (the dependency tracer also writes on exit). A parent
// completion barrier, rather than a timing assertion, keeps the first CLI alive
// until the contender returns. Only private fixture logs are used.
async function transactionLifetimeChecks() {
    const preload = path.join(ROOT, 'post-transaction.js');
    fs.writeFileSync(preload, `const fs = require('fs');
if (process.env.FLEET_TEST_MARKER) {
  const pause = () => {
    fs.writeFileSync(process.env.FLEET_TEST_MARKER, 'ready');
    for (let n = 0; n < 1500; n++) {
      if (fs.existsSync(process.env.FLEET_TEST_MARKER + '.release')) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    throw new Error('post-transaction fixture barrier expired');
  };
  if (process.env.FLEET_TEST_MODE === 'exit') process.once('exit', pause);
  else {
    const log = console.log;
    console.log = function(...args) {
      if (/^D\\d+$/.test(String(args[0]))) pause();
      return log.apply(this, args);
    };
  }
}`);
    const launch = (cfg, author, mode, marker) => new Promise((resolve, reject) => {
        const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
        delete env.FLEET_TEST_MARKER;
        delete env.FLEET_TEST_MODE;
        if (marker) { env.FLEET_TEST_MARKER = marker; env.FLEET_TEST_MODE = mode; }
        const child = spawn(process.execPath, ['--require', preload, SUBJECT,
            '--next', '--repo', 'lifetime', '--author', author], { env });
        let stdout = '', stderr = '';
        child.stdout.on('data', (s) => { stdout += s; });
        child.stderr.on('data', (s) => { stderr += s; });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    for (const mode of ['exit', 'output']) {
        const cfg = freshCfg();
        fs.mkdirSync(path.join(cfg, 'fleet'));
        const log = path.join(cfg, 'fleet', 'DECISIONS.jsonl');
        fs.writeFileSync(log, '');
        const marker = path.join(cfg, 'ready');
        const first = launch(cfg, 'first', mode, marker);
        let ready = false, second;
        try {
            for (let n = 0; n < 1500; n++) {
                if (fs.existsSync(marker)) { ready = true; break; }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            if (ready) second = await launch(cfg, 'second');
        } finally {
            fs.writeFileSync(marker + '.release', 'release');
        }
        const results = [await first, second];
        check('CONCURRENT: completed transaction releases before ' + mode + ' work',
            ready && results.every((r) => r && r.status === 0) &&
            results[0].stdout.trim() === 'D1' && results[1].stdout.trim() === 'D2',
            JSON.stringify({ ready, results }));
        const records = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        check('CONCURRENT: ' + mode + ' completion barrier preserves both durable reservations',
            records.length === 2 && records[0].reserved === '1' && records[1].reserved === '2',
            JSON.stringify(records));
    }
}

// Actual simultaneous CLIs, with a read delay to expose the check/append gap.
// The implementation is unmodified; delaying a filesystem read is an execution
// interleaving, not a replacement of the allocator or contradiction checker.
async function concurrentChecks() {
    const preload = path.join(ROOT, 'slow-read.js');
    fs.writeFileSync(preload, `const fs = require('fs'); const read = fs.readFileSync;
fs.readFileSync = function(p, ...args) {
  const value = read.call(fs, p, ...args);
  if (String(p).endsWith('DECISIONS.jsonl')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
  return value;
};`);
    const parallelRun = (cfg, args) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--require', preload, SUBJECT, ...args], {
            env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (s) => { stdout += s; });
        child.stderr.on('data', (s) => { stderr += s; });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const emptyLog = () => {
        const cfg = freshCfg();
        fs.mkdirSync(path.join(cfg, 'fleet'));
        fs.writeFileSync(path.join(cfg, 'fleet', 'DECISIONS.jsonl'), '');
        return cfg;
    };
    const reserveCfg = emptyLog();
    const reservations = await Promise.all(Array.from({ length: 4 }, (_, i) =>
        parallelRun(reserveCfg, ['--next', '--repo', 'race', '--author', 'worker-' + i])));
    check('CONCURRENT: all four reservations succeed with distinct ids',
        reservations.every((r) => r.status === 0) && new Set(reservations.map((r) => r.stdout.trim())).size === 4,
        JSON.stringify(reservations));
    const decisionCfg = emptyLog();
    const decisions = await Promise.all(['free', 'paid'].map((choice) =>
        parallelRun(decisionCfg, ['--record', '--repo', 'race', '--subject', 'pricing', '--author', choice, '--decision', choice])));
    check('CONCURRENT: opposing decisions produce exactly one success and one refusal',
        decisions.filter((r) => r.status === 0).length === 1 && decisions.filter((r) => r.status === 3).length === 1,
        JSON.stringify(decisions));
    check('CONCURRENT: only one opposing decision reaches the durable log',
        fs.readFileSync(path.join(decisionCfg, 'fleet', 'DECISIONS.jsonl'), 'utf8').trim().split('\n').length === 1);

    for (const [kind, owner] of [['live', { pid: process.pid }], ['unreadable', 'partial lock']]) {
        const cfg = emptyLog();
        const lock = path.join(cfg, 'fleet', 'DECISIONS.jsonl.lock');
        const contents = JSON.stringify(owner);
        fs.writeFileSync(lock, contents);
        const start = Date.now();
        const r = run(cfg, ['--next', '--repo', 'race', '--author', 'contender']);
        const elapsed = Date.now() - start;
        // BOUNDED means "refuses instead of waiting forever": the subject gives up
        // after 100 x 20 ms. The wall-clock ceiling here only has to sit far below
        // the suite's own timeout to prove that; it must not encode this machine's
        // speed. [measured 2026-09-09] a 6000 ms ceiling failed 3 of 4 macOS CI
        // runs on two heads, with status 4 and the complete refusal text present,
        // on a three-core runner right after the parallel cases above; the same
        // file passed 44/44 here every time. The elapsed time is now in the detail.
        check(kind + ' lock: bounded refusal names the lock and recovery requirement',
            r.status === 4 && elapsed < 30000 && r.stderr.includes(lock) && /owner|process/i.test(r.stderr),
            'status=' + r.status + ' elapsed=' + elapsed + 'ms\n' + r.stderr);
        check(kind + ' lock: never steals the lock or appends to the log',
            fs.readFileSync(lock, 'utf8') === contents && fs.readFileSync(path.join(cfg, 'fleet', 'DECISIONS.jsonl'), 'utf8') === '');
    }
}

function report() {

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`fleet-decisions: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`fleet-decisions: ${passed}/${total} passed — the collision refusal, scoping, normalisation, and a torn log`);
}
transactionLifetimeChecks().then(concurrentChecks).then(report).catch((err) => {
    failures.push('concurrent CLI harness failed: ' + err.stack);
    report();
});
