#!/usr/bin/env node
// find-vacuous-assertions.js — per-ASSERTION vacuity via operator mutation.
//
// check-suites-can-fail.js replaces the whole subject file with a canary stub.
// That proves a suite depends on its subject; it cannot prove any GIVEN
// assertion is live, because one guard in a code path can mask another. This is
// the finer version: mutate one decision at a time and see whether the suite
// notices. A mutant the suite does not notice is a CANDIDATE vacuity.
//
// THIS IS ADVISORY, NOT A GATE. Do not wire it into validate or CI, and do not
// report its survivor count as a defect count. Measured on this repo's own
// pre-tool-filter.js the first time it ran:
//
//   hooks/pre-tool-filter.js   59 mutants · 42 caught · 16 survived
//     of the 16: ~10 real coverage gaps, ~6 equivalent mutants
//   hooks/stop-auto-check.js   27 mutants · 21 caught ·  6 survived
//     of the 6: 5 real coverage gaps, 1 masked by a surrounding try/catch,
//     0 equivalent
//
// The first of those measurements was written up here as "roughly a third of
// survivors are noise". The second subject came back 0/6 noise, so that ratio
// was an over-generalisation from n=1 and is withdrawn. **The noise rate varies
// by subject and cannot be predicted from another one.** Which is only a
// restatement of the rule that matters: EVERY SURVIVOR MUST BE READ, and a
// survivor count on its own means nothing.
//
// The equivalent mutants seen so far are all of one kind — behaviour that is
// genuinely unobservable, like a platform-gated branch on the wrong platform, or
// a condition whose operands are empty in every reachable input.
//
// What it found on its first real run, all confirmed by hand afterwards:
//   - the fail-closed "input did not parse" branch was unreachable from the
//     suite, so flipping its exit(2) to exit(0) went unnoticed
//   - the win32 dangerous-command patterns have no test on any other platform
//   - `if (hit)` -> `if (true)` survived because the surrounding fail-OPEN
//     catch swallowed the resulting TypeError — one guard masking another,
//     which is exactly the case check-suites-can-fail structurally cannot see
//
// COST, and why there is no sweep-the-whole-repo mode. One suite run per mutant,
// so the bill is (mutants x suite runtime) and the suite runtime dominates:
//
//   subject                 lines  suite runtime  mutants  total
//   hooks/pre-tool-filter.js  240          1.3s        60   ~80s
//   scripts/drift-audit.js    409         13.1s      ~100   ~22min
//
// A sweep over all 14 pairs was attempted and abandoned on that basis — an
// estimate of "20 minutes" made from the fast pair was out by an order of
// magnitude, because the second subject's suite is 10x slower. Point this at one
// pair at a time, and check the suite's runtime before starting.
//
// Usage: node tooling/find-vacuous-assertions.js <subject.js> <suite.js>

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [subject, suite] = process.argv.slice(2);
recoverStaleBackup(subject);

// Refuse to mutate a subject that has uncommitted changes — the same guard
// check-suites-can-fail.js already carries, and for a sharper reason here.
//
// This was not theoretical. A killed run left a mutant in the tree, a later
// `git add -A` swept it into a commit, and it was PUSHED to a public repo: an
// `if (!installed.plugins[...])` shipped as `if (true)`. Nothing caught it.
// `validate` passed and the pre-push hook passed, because a mutation that
// survives its suite is by definition one the suite cannot see — which is the
// entire premise of this tool.
//
// With this guard, git always holds a clean copy of the subject, so the worst a
// crash can do is leave a dirty file that `git checkout --` fixes.
{
    // Absolute path, and cwd set to the file's directory so git finds the repo.
    // A relative `subject` with cwd pointed at its own directory made git resolve
    // the path against the wrong base, so the guard silently matched nothing and
    // the run proceeded on a dirty file — the exact failure it exists to stop.
    const abs = path.resolve(subject);
    const st = spawnSync('git', ['status', '--porcelain', '--', abs],
        { encoding: 'utf8', cwd: path.dirname(abs) });
    if (st.status === 0 && (st.stdout || '').trim()) {
        console.error(`\nRefusing to run: ${path.basename(subject)} has uncommitted changes.\n`);
        console.error('This script overwrites the subject with mutants. If it dies mid-run, git is');
        console.error('what restores it — so the subject has to be committed first. A mutant that');
        console.error('survives its suite will also survive validate and the pre-push hook, and can');
        console.error('be committed without anything noticing. Commit or stash, then re-run.\n');
        process.exit(1);
    }
}

const original = fs.readFileSync(subject, 'utf8');
fs.writeFileSync(backupPath(subject), original);
const lines = original.split('\n');

// This script OVERWRITES the subject with mutants. The normal path restores
// after every one, but killing a sweep mid-run left two plugin sources sitting
// mutated in the working tree — worse than the run not finishing.
//
// A SIGTERM/SIGINT handler was tried first and MEASURED NOT TO WORK: this script
// is entirely synchronous (spawnSync in a loop), so the event loop is blocked
// for essentially its whole life and a JS signal handler never gets scheduled.
// Verified by killing a real run — the subject was still mutated afterwards.
// No handler can fix that; the fix has to survive the process dying outright.
//
// So: crash recovery instead of signal handling. A backup is written before the
// first mutation and removed on clean exit. Any run that finds a stale backup
// restores from it first. This works no matter how the previous run died.
function backupPath(file) { return file + '.vacuity-backup'; }

function recoverStaleBackup(file) {
    const bak = backupPath(file);
    if (!fs.existsSync(bak)) return false;
    fs.writeFileSync(file, fs.readFileSync(bak));
    fs.unlinkSync(bak);
    console.log(`\nRecovered ${path.basename(file)} from a previous run that did not finish.`);
    return true;
}

const isCode = (l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l);

// Mutation operators. Each returns a mutated line, or null if inapplicable.
const OPS = [
    ['=== -> !==', (l) => (l.includes('===') ? l.replace('===', '!==') : null)],
    ['!== -> ===', (l) => (l.includes('!==') ? l.replace('!==', '===') : null)],
    ['&& -> ||', (l) => (l.includes('&&') ? l.replace('&&', '||') : null)],
    ['|| -> &&', (l) => (l.includes('||') ? l.replace('||', '&&') : null)],
    ['if(x) -> if(true)', (l) => (/^\s*if \(/.test(l) ? l.replace(/if \((.*)\) \{/, 'if (true) {') : null)],
    ['if(x) -> if(false)', (l) => (/^\s*if \(/.test(l) ? l.replace(/if \((.*)\) \{/, 'if (false) {') : null)],
    ['drop negation', (l) => (/[^=!]!\w/.test(l) ? l.replace(/([^=!])!(\w)/, '$1$2') : null)],
    ['exit(2) -> exit(0)', (l) => (l.includes('process.exit(2)') ? l.replace('process.exit(2)', 'process.exit(0)') : null)],
];

function suiteIsRed() {
    const r = spawnSync('node', [suite], { encoding: 'utf8', timeout: 60000 });
    return { red: r.status !== 0, out: r.stdout || '' };
}

const base = suiteIsRed();
if (base.red) { console.error('Baseline suite is already red — fix that first.'); process.exit(1); }

const results = { caught: 0, survived: [], invalid: 0 };
let n = 0;

for (let i = 0; i < lines.length; i++) {
    if (!isCode(lines[i])) continue;
    for (const [opName, op] of OPS) {
        const mutatedLine = op(lines[i]);
        if (mutatedLine === null || mutatedLine === lines[i]) continue;
        n++;
        const copy = [...lines];
        copy[i] = mutatedLine;
        fs.writeFileSync(subject, copy.join('\n'));

        // A mutant that does not parse tests nothing — discard, do not score.
        const parses = spawnSync('node', ['--check', subject], { encoding: 'utf8' }).status === 0;
        if (!parses) { results.invalid++; fs.writeFileSync(subject, original); continue; }

        const r = suiteIsRed();
        fs.writeFileSync(subject, original);
        if (r.red) results.caught++;
        else results.survived.push({ line: i + 1, op: opName, was: lines[i].trim(), now: mutatedLine.trim() });
    }
}

fs.writeFileSync(subject, original);
const restored = fs.readFileSync(subject, 'utf8') === original;
// Only now is the backup redundant. Removing it earlier would reopen the window.
if (restored) fs.unlinkSync(backupPath(subject));

console.log(`\nsubject: ${subject}`);
console.log(`suite:   ${suite}`);
console.log(`\n${n} mutant(s) generated · ${results.invalid} did not parse (discarded) · `
    + `${results.caught} caught · ${results.survived.length} SURVIVED`);
console.log(`subject restored: ${restored}\n`);

if (results.survived.length) {
    console.log('Survivors — every one must be read before this number means anything:\n');
    for (const s of results.survived) {
        console.log(`  line ${String(s.line).padStart(3)}  [${s.op}]`);
        console.log(`      was: ${s.was.slice(0, 110)}`);
        console.log(`      now: ${s.now.slice(0, 110)}`);
    }
    console.log();
}
