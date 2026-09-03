#!/usr/bin/env node
'use strict';
// Suite for tooling/check-assertion-targets.js.
//
// THE THING THIS SUITE HAS TO PROVE is not that the runner reports KILLED. A
// runner that ALWAYS reports KILLED would pass any test that only ever plants a
// defect a suite catches, and it would be worthless - it exists to find the
// mutants that are NOT killed. So every case below plants a defect designed to
// produce one specific bad verdict, and asserts that verdict by name.
//
// Each fixture is a throwaway git repo under the OS temp dir with a two-function
// subject and a two-assertion suite. Nothing here touches this repository.
//
// Run: node tooling/test-assertion-targets.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUBJECT = path.resolve(ROOT, 'tooling', 'check-assertion-targets.js');
const T = require(SUBJECT);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail !== undefined ? '\n      -> ' + JSON.stringify(detail) : ''));
}

const scratch = [];
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-tgt-test-'));
    scratch.push(dir);
    fs.writeFileSync(path.join(dir, 'subject.js'), [
        'exports.add = (a, b) => a + b;',
        'exports.label = () => "hello";',
        'exports.unread = () => "nothing asserts this";',
        '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'suite.js'), [
        'const s = require("./subject.js");',
        'let passed = 0; const failures = [];',
        'const check = (n, c) => { if (c) { passed++; return; } failures.push(n); };',
        'check("addition is addition", s.add(2, 2) === 4);',
        'check("the label reads hello", s.label() === "hello");',
        'if (failures.length) {',
        '  console.error("FAIL  " + failures.length + " of " + (passed + failures.length));',
        '  for (const f of failures) console.error("    - " + f);',
        '  process.exit(1);',
        '}',
        'console.log("PASS  " + passed + " assertions");',
        '',
    ].join('\n'), 'utf8');
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: dir });
    return dir;
}

const mutant = (over) => Object.assign(
    { id: 'X', name: 'x', file: 'subject.js', from: 'a + b', to: 'a - b', expect: 'addition is addition' },
    over
);
const run = (dir, mutants) => T.runManifest({ suite: 'suite.js', mutants }, dir);

// ---------------------------------------------------- the five verdicts
//
// A runner that cannot distinguish these is a runner that always says KILLED.

{
    const dir = fixture();
    const r = run(dir, [mutant({ id: 'K' })]);
    check('a defect the named assertion catches reads KILLED',
        r.results && r.results[0].verdict === T.VERDICT.KILLED, r.results);
    check('and the run reports how many assertions objected', r.results[0].failed === 1, r.results[0]);
}
{
    // Red, but a DIFFERENT assertion objected. This is the verdict that makes
    // the whole script worth having: the suite went red and proved nothing
    // about the check under test.
    const dir = fixture();
    const r = run(dir, [mutant({ id: 'M', from: '"hello"', to: '"goodbye"' })]);
    check('a defect a DIFFERENT assertion catches reads MISTARGETED',
        r.results[0].verdict === T.VERDICT.MISTARGETED, r.results);
    check('and it names the assertion that actually objected',
        /the label reads hello/.test(r.results[0].detail), r.results[0].detail);
}
{
    const dir = fixture();
    const r = run(dir, [mutant({ id: 'S', from: '"nothing asserts this"', to: '"changed"' })]);
    check('a defect nothing asserts reads SURVIVED',
        r.results[0].verdict === T.VERDICT.SURVIVED, r.results);
}
{
    // A crash is not a kill. The suite exits non-zero with no assertion summary,
    // which to a naive parser counting failures reads as ZERO of them - the
    // exact misreading that produced this verdict in the first place.
    const dir = fixture();
    const r = run(dir, [mutant({ id: 'C', from: 'exports.add', to: 'throw new Error("boom"); exports.add' })]);
    check('a subject that crashes the suite reads CRASHED, not KILLED',
        r.results[0].verdict === T.VERDICT.CRASHED, r.results);
    check('and says a crash carries no diagnosis',
        /crash is not a diagnosis/.test(r.results[0].detail), r.results[0].detail);
}
{
    const dir = fixture();
    const r = run(dir, [mutant({ id: 'A', from: 'this text is nowhere in the subject' })]);
    check('a stale anchor reads ANCHOR-MISSING rather than SURVIVED',
        r.results[0].verdict === T.VERDICT.ANCHOR_MISSING, r.results);
}
{
    // An anchor matching twice would mutate only the first occurrence, so the
    // run would silently test something narrower than it claims.
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'subject.js'),
        fs.readFileSync(path.join(dir, 'subject.js'), 'utf8') + 'exports.again = (a, b) => a + b;\n', 'utf8');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'dup'], { cwd: dir });
    const r = run(dir, [mutant({ id: 'D' })]);
    check('an anchor that matches twice is refused, not silently narrowed',
        r.results[0].verdict === T.VERDICT.ANCHOR_MISSING
            && /more than once/.test(r.results[0].detail), r.results[0]);
}

// ------------------------------------------------------------- the guards

{
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'subject.js'), 'exports.add = () => 0;\n', 'utf8');
    const r = run(dir, [mutant({ id: 'G' })]);
    check('a dirty subject is refused BEFORE anything is rewritten',
        /uncommitted changes/.test(r.error || ''), r.error);
    check('and the dirty file is left exactly as it was',
        fs.readFileSync(path.join(dir, 'subject.js'), 'utf8') === 'exports.add = () => 0;\n');
}
{
    const dir = fixture();
    // NOT `a * b`: the fixture asserts add(2, 2) === 4 and 2 * 2 is also 4, so
    // that mutation leaves the suite green and this case would measure nothing.
    fs.writeFileSync(path.join(dir, 'subject.js'),
        fs.readFileSync(path.join(dir, 'subject.js'), 'utf8').replace('a + b', 'a - b'), 'utf8');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'break'], { cwd: dir });
    const r = run(dir, [mutant({ id: 'R', from: '"hello"', to: '"bye"' })]);
    check('a RED baseline is refused rather than measured', /RED baseline/.test(r.error || ''), r.error);
    check('because verdicts against an already-failing suite mean nothing', !r.results);
}
{
    const dir = fixture();
    const r = run(dir, [mutant({ id: 'P' }), mutant({ id: 'Q', from: '"hello"', to: '"bye"', expect: 'the label reads hello' })]);
    check('two mutants both run', r.results.length === 2, r.results);
    check('and the tree is restored afterwards', r.restored === true, r.dirtyAfter);
    // Read the file rather than trusting the write, because a restore that
    // failed silently is the one outcome that damages the caller's repo.
    const src = fs.readFileSync(path.join(dir, 'subject.js'), 'utf8');
    check('verified by reading the subject back', src.includes('a + b') && src.includes('"hello"'), src);
    check('mutants are applied ONE at a time, never stacked',
        r.results[0].verdict === T.VERDICT.KILLED && r.results[1].verdict === T.VERDICT.KILLED, r.results);
}
{
    const dir = fixture();
    const r = run(dir, [mutant({ id: 'N', file: 'no-such-file.js' })]);
    check('a manifest naming a missing file errors rather than reporting verdicts',
        /missing file/.test(r.error || ''), r.error);
}

// ------------------------------------------------------- manifest validation

{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-tgt-man-'));
    scratch.push(dir);
    const write = (name, obj) => {
        const f = path.join(dir, name);
        fs.writeFileSync(f, JSON.stringify(obj), 'utf8');
        return f;
    };
    const throws = (f) => { try { T.loadManifest(f); return false; } catch { return true; } };
    check('a manifest with no suite is rejected', throws(write('a.json', { mutants: [] })));
    check('a manifest with no mutants array is rejected', throws(write('b.json', { suite: 's.js' })));
    check('a mutant missing "expect" is rejected',
        throws(write('c.json', { suite: 's.js', mutants: [{ id: 'x', name: 'n', file: 'f', from: 'a', to: 'b' }] })));
    // "" is a legitimate replacement - it deletes the line - so it must not be
    // rejected as missing, and a MISSING `to` must not be read as "".
    check('a mutant deleting its anchor with "" is accepted',
        !throws(write('d.json', { suite: 's.js', mutants: [{ id: 'x', name: 'n', file: 'f', from: 'a', to: '', expect: 'e' }] })));
    check('a mutant with no "to" at all is rejected',
        throws(write('e.json', { suite: 's.js', mutants: [{ id: 'x', name: 'n', file: 'f', from: 'a', expect: 'e' }] })));
}

// ------------------------------------------- the shipped manifest is honest

{
    const dir = path.join(ROOT, 'tooling', 'mutants');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    check('at least one manifest ships, so the script is not an orphan', files.length > 0, files);
    for (const f of files) {
        let m = null;
        check(`${f} parses and validates`, (() => { try { m = T.loadManifest(path.join(dir, f)); return true; } catch { return false; } })());
        if (!m) continue;
        check(`${f}: its suite exists`, fs.existsSync(path.resolve(ROOT, m.suite)), m.suite);
        const ids = m.mutants.map((x) => x.id);
        check(`${f}: mutant ids are unique`, new Set(ids).size === ids.length, ids);
        for (const x of m.mutants) {
            check(`${f}: ${x.id} targets a file that exists`, fs.existsSync(path.resolve(ROOT, x.file)), x.file);
            // A stale anchor is reported at runtime, but catching it here means
            // the manifest cannot rot quietly between full runs.
            const src = fs.readFileSync(path.resolve(ROOT, x.file), 'utf8');
            const hits = src.split(x.from).length - 1;
            check(`${f}: ${x.id} anchor occurs exactly once`, hits === 1, { anchor: x.from.slice(0, 60), hits });
            check(`${f}: ${x.id} expect is a valid regex`,
                (() => { try { new RegExp(x.expect); return true; } catch { return false; } })(), x.expect);
            check(`${f}: ${x.id} actually changes something`, x.from !== x.to, x.id);
        }
    }
}

// --------------------------------------------------------------- the CLI

{
    const r = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8', stdio: 'pipe' });
    check('--help returns rather than running anything', r.status === 0);
    check('--help names every verdict it can emit',
        Object.values(T.VERDICT).every((v) => r.stdout.includes(v)), r.stdout.slice(0, 200));

    const self = spawnSync(process.execPath, [SUBJECT, '--selftest'], { encoding: 'utf8', stdio: 'pipe' });
    check('the selftest passes', self.status === 0, self.stdout + self.stderr);
    check('and it exercises every verdict, not just KILLED',
        /MISTARGETED/.test(self.stdout) && /SURVIVED/.test(self.stdout)
        && /CRASHED/.test(self.stdout) && /ANCHOR-MISSING/.test(self.stdout), self.stdout);
    check('the selftest prints its population', /case\(s\) over \d+ planted mutants/.test(self.stdout), self.stdout);
}

// ---------------------------------------------------------------- cleanup

for (const d of scratch) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

if (failures.length) {
    console.error(`\nFAIL  ${failures.length} of ${passed + failures.length}`);
    for (const f of failures) console.error('    - ' + f);
    process.exit(1);
}
console.log(`PASS  ${passed} assertions; every verdict the runner can emit is planted and named, `
    + `and the shipped manifest is validated anchor by anchor.`);
