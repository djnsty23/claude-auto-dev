#!/usr/bin/env node
// Acceptance tests for skill-census.js.
//
// The thing worth testing is not "does it print a table". It is that the two
// READERS cannot go blind while still printing a confident table, because both
// of them have already done exactly that during development:
//
//   1. The invocation reader returns zero for every skill if the transcript
//      field name changes. A zero table reads as "your skills are unreachable"
//      and is actually "this script cannot see".
//
//   2. The listing reader returns zero for every skill if it splits the block
//      on a newline. The listing reaches a transcript inside a JSON string, so
//      its line breaks are stored ESCAPED, as a backslash and an `n`. The first
//      version of that reader split on a real newline and printed 25 rows of
//      zeroes, which reads as a dramatic finding about the corpus.
//
// So the mutants below are not invented failure modes. Each one is a bug this
// script actually had, re-planted, with the subject asserted to go red.
//
// The copy lives in tooling/ on purpose: the subject resolves its corpus as
// `__dirname/../plugins`, so a copy anywhere else audits an empty population and
// every assertion here would pass against nothing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUBJECT = path.join(ROOT, 'tooling', 'skill-census.js');

const cases = [];
const check = (label, ok, why) => cases.push([label, ok, why]);
const run = (file, args) =>
    spawnSync(process.execPath, [file].concat(args || []), {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
    });

/** Write a mutated copy beside the subject, run it, always clean up. */
function withMutant(from, to, fn) {
    const src = fs.readFileSync(SUBJECT, 'utf8');
    if (src.indexOf(from) < 0) {
        throw new Error('mutation anchor absent, the subject changed: ' + from);
    }
    const file = path.join(ROOT, 'tooling', '_mutant-census-' + process.pid + '.js');
    fs.writeFileSync(file, src.replace(from, to), 'utf8');
    try { return fn(file); } finally { fs.rmSync(file, { force: true }); }
}

let tmp = null;
try {
    // ---------------------------------------------------------------- surface
    const started = Date.now();
    const help = run(SUBJECT, ['--help']);
    const helpMs = Date.now() - started;
    check('--help returns 0', help.status === 0, 'status=' + help.status);
    check('  and names every mode, so the flags are discoverable',
        /--rendered/.test(help.stdout) && /--selftest/.test(help.stdout) && /--json/.test(help.stdout),
        help.stdout.slice(0, 300));
    check('  and is INERT, not merely fast: it censuses nothing',
        !/population:/.test(help.stdout) && helpMs < 5000,
        helpMs + 'ms, stdout=' + help.stdout.slice(0, 120));

    const self = run(SUBJECT, ['--selftest']);
    check('--selftest passes', self.status === 0 && /0 failed/.test(self.stdout), self.stdout.slice(-300));
    const n = /selftest: (\d+) assertion/.exec(self.stdout);
    check('  and reports how many assertions it ran',
        Boolean(n) && Number(n[1]) >= 20, n ? n[1] + ' assertions' : 'no count line');

    // ------------------------------------------------- the two blindness modes
    //
    // MUTANT 1: the invocation field is renamed. The model channel must collapse
    // to zero AND the script must say the probe is broken rather than reporting a
    // corpus finding. Exit 2, distinct from the exit 0 of a working run.
    //
    // DRIVEN BY A FIXTURE, NOT BY THIS MACHINE. The first version pointed the
    // mutant at the real transcript corpus with `--days 2`, and the guard needs
    // the surviving channel to carry at least LOPSIDED_MIN hits before it will
    // call an asymmetry broken. `[measured 2026-09-18]` that window held 19 typed
    // invocations against a threshold of 20, so the assertion passed when it was
    // written and failed 50 minutes later with nothing changed: the window had
    // slid. A suite whose verdict depends on how many slash commands somebody
    // typed this morning is a clock, not a test.
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'census-lopsided-'));
    const typedLine = '{"timestamp":"2026-09-17T09:00:00.000Z","text":'
        + '"<command-name>/design</command-name>"}';
    fs.writeFileSync(path.join(fixture, 'f.jsonl'),
        new Array(25).fill(typedLine).join('\n')
            + '\n{"timestamp":"2026-09-17T09:30:00.000Z","tool":{"skill":"autodev-core:design"}}\n',
        'utf8');

    const healthy = run(SUBJECT, ['--dir', fixture, '--days', '3650']);
    check('the fixture is lopsided ENOUGH to arm the guard, and clean before mutation',
        healthy.status === 0 && /25 typed/.test(healthy.stdout),
        'status=' + healthy.status + ' ' + healthy.stdout.slice(0, 300));

    const blindHits = withMutant(
        'const model = /"skill"\\s*:\\s*"([a-zA-Z0-9:_-]+)"/g;',
        'const model = /"skiII"\\s*:\\s*"([a-zA-Z0-9:_-]+)"/g;',
        (f) => run(f, ['--dir', fixture, '--days', '3650']),
    );
    fs.rmSync(fixture, { recursive: true, force: true });
    check('renaming the invocation field makes the probe declare itself BROKEN',
        blindHits.status === 2 || /PROBE BROKEN/.test(blindHits.stderr + blindHits.stdout),
        'status=' + blindHits.status + ' stderr=' + blindHits.stderr.slice(0, 200));
    check('  and it does NOT report the zero as a finding about the corpus',
        /PROBE BROKEN/.test(blindHits.stderr + blindHits.stdout),
        (blindHits.stderr + blindHits.stdout).slice(-200));

    // MUTANT 2: the listing separator becomes a real newline, the exact bug the
    // first version of the reader shipped with. The selftest must go red.
    const q = String.fromCharCode(39);
    const bs = String.fromCharCode(92);
    const blindListing = withMutant(
        'const LISTING_SEP = ' + q + bs + bs + 'n' + q + ';',
        'const LISTING_SEP = ' + q + bs + 'n' + q + ';',
        (f) => run(f, ['--selftest']),
    );
    check('splitting the listing on a real newline makes the SELFTEST fail',
        blindListing.status === 1 && /[1-9]\d* failed/.test(blindListing.stdout),
        'status=' + blindListing.status + ' ' + blindListing.stdout.slice(-300));
    check('  and it fails on the listing assertions specifically',
        /FAIL the listing reader survives JSON-escaped line breaks/.test(blindListing.stdout),
        blindListing.stdout.slice(-400));

    // MUTANT 3: drop the per-listing dedupe. A skill listed twice in one listing
    // would score two, producing a count larger than its own denominator.
    const noDedupe = withMutant(
        'if (!shownHere.has(n)) { shownHere.add(n); slots.set(n, (slots.get(n) || 0) + 1); }',
        'slots.set(n, (slots.get(n) || 0) + 1);',
        (f) => run(f, ['--selftest']),
    );
    check('removing the per-listing dedupe makes the SELFTEST fail',
        noDedupe.status === 1 && /FAIL a bare name listed twice/.test(noDedupe.stdout),
        'status=' + noDedupe.status + ' ' + noDedupe.stdout.slice(-300));

    // --------------------------------------------------------- real behaviour
    //
    // Run against a synthetic corpus rather than the machine's transcripts: a
    // suite whose result depends on how many sessions this box happened to run
    // is not a test, and on a fresh clone it would report an empty world.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-suite-'));
    const L = '\\n';
    fs.writeFileSync(path.join(tmp, 't.jsonl'), [
        '{"timestamp":"2026-09-17T09:00:00.000Z","tool":{"skill":"autodev-core:design"}}',
        '{"timestamp":"2026-09-17T10:00:00.000Z","content":"'
            + 'The following skills are available for use with the Skill tool:' + L + L
            + '- autodev-core:design: Creates distinctive UI.' + L
            + '- autodev-core:a11y' + L + L + 'end"}',
    ].join('\n'), 'utf8');

    const real = run(SUBJECT, ['--dir', tmp, '--days', '3650', '--rendered', '--plugin', 'autodev-core', '--json']);
    check('a run over a synthetic corpus exits 0', real.status === 0,
        'status=' + real.status + ' ' + (real.stderr || '').slice(0, 200));
    let parsed = null;
    try { parsed = JSON.parse(real.stdout); } catch (e) { /* asserted next */ }
    check('--json emits parseable JSON', parsed !== null, real.stdout.slice(0, 200));
    check('  carrying the population it read, not just the answer',
        parsed && parsed.transcripts === 1 && parsed.render && parsed.render.listings === 1,
        parsed ? 'transcripts=' + parsed.transcripts + ' listings='
            + (parsed.render && parsed.render.listings) : 'unparsed');

    const rowOf = (nm) => parsed && parsed.rows.filter((r) => r.name === nm)[0];
    check('the skill that fired is counted and dated from its own line',
        rowOf('design') && rowOf('design').model === 1
            && rowOf('design').lastFired === '2026-09-17T09:00:00.000Z',
        JSON.stringify(rowOf('design') && {
            model: rowOf('design').model, lastFired: rowOf('design').lastFired,
        }));
    check('the skill shown WITH a description holds a slot',
        rowOf('design') && rowOf('design').slots === 1, 'slots=' + (rowOf('design') || {}).slots);
    check('the skill shown as a BARE NAME holds none, though it was listed',
        rowOf('a11y') && rowOf('a11y').slots === 0 && rowOf('a11y').listedIn === 1,
        JSON.stringify(rowOf('a11y') && { slots: rowOf('a11y').slots, listedIn: rowOf('a11y').listedIn }));
    check('a skill in neither the listing nor the transcript stays at zero',
        rowOf('refactor') && rowOf('refactor').model === 0 && rowOf('refactor').slots === 0,
        JSON.stringify(rowOf('refactor') && { model: rowOf('refactor').model, slots: rowOf('refactor').slots }));

    // A corpus with no transcripts at all: PROBE BROKEN, not "nothing fires".
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'census-empty-'));
    const none = run(SUBJECT, ['--dir', empty, '--days', '3650']);
    check('an empty transcript corpus exits 2 rather than reporting a dead plugin',
        none.status === 2, 'status=' + none.status);
    fs.rmSync(empty, { recursive: true, force: true });
} catch (e) {
    check('the suite itself ran to completion', false, e && e.stack ? e.stack : String(e));
} finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ } }
}

let failed = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !why ? '' : '\n       ' + why));
    if (!ok) failed++;
}
console.log('');
console.log('test-skill-census: ' + cases.length + ' assertion(s), ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
