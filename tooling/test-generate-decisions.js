#!/usr/bin/env node
'use strict';
// Tests for tooling/generate-decisions.js.
// Run: node tooling/test-generate-decisions.js
// Exits 1 on any failure; 0 if all pass.
//
// The subject is driven as a SUBPROCESS wherever the assertion is about an exit
// code, because that is how the gate consumes it and no in-process call can see
// an exit status (rule-gate-integrity 5). The unit-level assertions import it.
//
// Two assertions here exist because of a mistake made while writing the subject,
// and they are the ones to keep if anything is ever trimmed:
//
//  * `WELDED_HEADING matches the real corrupted line` — the first version of that
//    regex required whitespace after the date, and the whole corpus writes
//    `## 2026-09-08: title`. It matched nothing. The lint still went RED on the
//    real PR, on the empty-body finding, and reading the exit code instead of the
//    finding would have banked a broken regex as proven. So the regex is asserted
//    against the literal line, positively AND negatively.
//
//  * `--print is not truncated through a pipe` — asserted on a fixture built to
//    EXCEED 65536 bytes, and the assertion checks that first. On darwin
//    process.stdout to a pipe is async, so process.exit() after a large write
//    delivers exactly one 64 KiB buffer and still exits 0. docs/decisions.md is
//    already 47 KB, so this is a live concern, not a hypothetical one; a fixture
//    under the buffer would pass by construction and prove nothing.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(__dirname, 'generate-decisions.js');
const ROOT = path.resolve(__dirname, '..');
const REAL_DOC = path.join(ROOT, 'docs', 'decisions.md');
const mod = require('./generate-decisions.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; console.log(`FAIL  ${label}${detail ? `  (${detail})` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-generate-decisions-'));
const fixtures = [];
function fixture(name) {
    const d = path.join(tmp, name);
    fs.mkdirSync(path.join(d, 'decisions'), { recursive: true });
    fixtures.push(d);
    return { dir: path.join(d, 'decisions'), out: path.join(d, 'decisions.md') };
}
function run(fx, ...args) {
    const r = spawnSync('node', [SUBJECT, '--dir', fx.dir, '--out', fx.out, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const entry = (date, title, body) => `## ${date}: ${title}\n\n${body || 'Body of the decision.'}\n`;

function seed(fx, entries) {
    for (const [date, slug, title, body] of entries) fs.writeFileSync(path.join(fx.dir, `${date}-${slug}.md`), entry(date, title, body));
    fs.writeFileSync(fx.out, '# Decisions\n\nPreamble kept verbatim.\n');
    return run(fx, '--write');
}

// ---------------------------------------------------------------------------
// 1. The real corpus round-trips byte-for-byte. This is the migration's
//    losslessness property, graded against the committed document rather than a
//    fixture, because a fixture cannot be the thing that gets migrated.
// ---------------------------------------------------------------------------
{
    const original = fs.readFileSync(REAL_DOC, 'utf8').replace(/\r\n/g, '\n');
    const { preamble, entries } = mod.splitDocument(original, 'docs/decisions.md');
    check('the real docs/decisions.md exists and is non-trivial', Buffer.byteLength(original) > 10000, `${Buffer.byteLength(original)} bytes`);
    check('splitDocument finds a plausible population in it', entries.length >= 10, `${entries.length} entries`);
    const rebuilt = [preamble.replace(/\s+$/, ''), ...entries.map((e) => e.text.replace(/\s+$/, ''))].join('\n\n') + '\n';
    check('reassembling the real corpus in file order is BYTE-IDENTICAL', rebuilt === original,
        `${Buffer.byteLength(rebuilt)} vs ${Buffer.byteLength(original)} bytes`);
    const r = spawnSync('node', [SUBJECT, '--verify-split'], { encoding: 'utf8', cwd: ROOT });
    check('--verify-split exits 0 on the real corpus', r.status === 0, `exit ${r.status}`);
    check('--verify-split says byte-identical: YES', /byte-identical: YES/.test(r.stdout || ''), JSON.stringify((r.stdout || '').slice(0, 120)));
}

// ---------------------------------------------------------------------------
// 2. Drift. Green first, so that every red below is a change from a known green.
// ---------------------------------------------------------------------------
{
    const fx = fixture('drift');
    seed(fx, [['2026-09-08', 'alpha', 'alpha decision'], ['2026-09-07', 'beta', 'beta decision']]);
    let r = run(fx, '--check');
    check('--check is green on a freshly generated aggregate', r.code === 0 && /check:decisions OK/.test(r.out), `exit ${r.code}`);
    check('the green line names the population it read', /2 entries/.test(r.out), JSON.stringify(r.out.slice(0, 120)));

    // A new decision file, not regenerated: the case the gate exists for.
    const added = path.join(fx.dir, '2026-09-09-gamma.md');
    fs.writeFileSync(added, entry('2026-09-09', 'gamma decision'));
    check('the mutation target exists before the mutation is graded', fs.existsSync(added));
    r = run(fx, '--check');
    check('--check is RED when an entry file is added without regenerating', r.code === 1 && /check:decisions STALE/.test(r.err), `exit ${r.code}`);
    check('the red names the first differing line', /first difference at line \d+/.test(r.err), JSON.stringify(r.err.slice(0, 160)));
    check('the red names the fix', /--write/.test(r.err));

    // And green again, so the red above is attributable to the added file alone.
    run(fx, '--write');
    r = run(fx, '--check');
    check('--check returns to green after --write', r.code === 0 && /3 entries/.test(r.out), `exit ${r.code}`);

    // A hand-edited aggregate: what a botched conflict resolution looks like.
    fs.appendFileSync(fx.out, '\n## 2026-09-10: pasted in by hand\n\nFrom no source file.\n');
    r = run(fx, '--check');
    check('--check is RED when the aggregate is edited by hand', r.code === 1 && /STALE/.test(r.err), `exit ${r.code}`);
}

// ---------------------------------------------------------------------------
// 3. The population floor, asserted separately from the comparison. Zero must
//    never read as green (rule-gate-integrity 2).
// ---------------------------------------------------------------------------
{
    const fx = fixture('floor');
    fs.writeFileSync(fx.out, '# Decisions\n\nPreamble.\n');
    let r = run(fx, '--check');
    check('--check on an EMPTY source dir is INERT, not green', r.code === 2 && /INERT/.test(r.err), `exit ${r.code}`);
    check('the inert report says nothing was checked', /nothing was checked/.test(r.err));
    check('an inert run prints nothing to stdout', r.out === '', JSON.stringify(r.out.slice(0, 80)));

    const missing = { dir: path.join(tmp, 'floor', 'no-such-dir'), out: fx.out };
    r = run(missing, '--check');
    check('--check on a MISSING source dir is INERT and says the migration has not run',
        r.code === 2 && /does not exist/.test(r.err) && /migration has not been run/.test(r.err), `exit ${r.code}`);
}

// ---------------------------------------------------------------------------
// 4. Naming. This is the half that prevented the 48 KB weld: a date is not a
//    name, so a date-only filename must not parse.
// ---------------------------------------------------------------------------
{
    const fx = fixture('naming');
    seed(fx, [['2026-09-08', 'alpha', 'alpha decision']]);

    fs.writeFileSync(path.join(fx.dir, '2026-09-09.md'), entry('2026-09-09', 'dated only'));
    let r = run(fx, '--check');
    check('a date-only filename is REJECTED', r.code === 1 && /a date is not a name/.test(r.err), `exit ${r.code}`);
    // Anchored on "Rename to", not on `<date>-<topic>.md`: that literal also
    // appears in the generator's own `Source:` header line, so a stale-diff
    // report satisfies it and the assertion passes without a rejection having
    // happened. Found by predicting which assertions a mutation should turn red
    // and noticing this one stayed green.
    check('the rejection says how to fix it', /Rename to <date>-<topic>\.md/.test(r.err), JSON.stringify(r.err.slice(0, 120)));
    fs.rmSync(path.join(fx.dir, '2026-09-09.md'));

    fs.writeFileSync(path.join(fx.dir, '2026-09-09-Mixed_Case.md'), entry('2026-09-09', 'mixed case'));
    r = run(fx, '--check');
    check('an upper-case or underscored topic is REJECTED', r.code === 1 && /must be <YYYY-MM-DD>-<topic>\.md/.test(r.err), `exit ${r.code}`);
    fs.rmSync(path.join(fx.dir, '2026-09-09-Mixed_Case.md'));

    fs.writeFileSync(path.join(fx.dir, '2026-09-10-mismatch.md'), entry('2026-09-09', 'heading says a different day'));
    r = run(fx, '--check');
    check('a heading date disagreeing with the filename date is REJECTED',
        r.code === 1 && /heading date 2026-09-09 disagrees with the filename date 2026-09-10/.test(r.err), `exit ${r.code}`);
    fs.rmSync(path.join(fx.dir, '2026-09-10-mismatch.md'));

    fs.writeFileSync(path.join(fx.dir, '2026-09-09-two.md'),
        entry('2026-09-09', 'first') + '\n' + entry('2026-09-09', 'second'));
    r = run(fx, '--check');
    check('two entry headings in one file is REJECTED', r.code === 1 && /more than one entry heading/.test(r.err), `exit ${r.code}`);
    fs.rmSync(path.join(fx.dir, '2026-09-09-two.md'));

    fs.writeFileSync(path.join(fx.dir, '2026-09-09-noheading.md'), 'Just prose, no heading.\n');
    r = run(fx, '--check');
    check('a file whose first line is not an entry heading is REJECTED', r.code === 1 && /first line must be/.test(r.err), `exit ${r.code}`);
    fs.rmSync(path.join(fx.dir, '2026-09-09-noheading.md'));

    r = run(fx, '--check');
    check('--check is green again once every rejected file is gone', r.code === 0, `exit ${r.code}`);
}

// ---------------------------------------------------------------------------
// 5. Order is (date DESC, slug ASC), total and derived only from per-file data.
// ---------------------------------------------------------------------------
{
    const rows = [
        { date: '2026-01-01', slug: 'b' }, { date: '2026-02-01', slug: 'z' },
        { date: '2026-01-01', slug: 'a' }, { date: '2026-02-01', slug: 'a' },
    ];
    const got = mod.sortEntries(rows).map((r) => `${r.date}/${r.slug}`).join(' ');
    check('sortEntries is date DESC then slug ASC', got === '2026-02-01/a 2026-02-01/z 2026-01-01/a 2026-01-01/b', got);
}

// ---------------------------------------------------------------------------
// 6. The lint, in both directions. It was written against a real defect, so the
//    positive case uses the real corrupted line verbatim.
// ---------------------------------------------------------------------------
const REAL_WELD = '7,480 rows removed with a verified backup first.## 2026-09-08: the quota wall — detect it, name the resume, do not add a cap';
{
    check('WELDED_HEADING matches the real corrupted line', mod.WELDED_HEADING.test(REAL_WELD), JSON.stringify(REAL_WELD.slice(0, 60)));
    check('WELDED_HEADING does NOT match a well-formed entry heading', !mod.WELDED_HEADING.test('## 2026-09-08: the quota wall — detect it'));
    check('WELDED_HEADING does NOT match an ### subheading whose title starts with a date', !mod.WELDED_HEADING.test('### 2026-09-08 a subheading'));
    check('WELDED_HEADING does NOT match a heading with the em-dash form', !mod.WELDED_HEADING.test('## 2026-08-19 — a remote\'s HEAD is filtered by shape'));

    const fx = fixture('lint');
    const clean = `# Decisions\n\nPreamble.\n\n## 2026-09-08: first\n\nSome prose.\n\n## 2026-09-07: second\n\nMore prose.\n`;
    fs.writeFileSync(fx.out, clean);
    let r = run(fx, '--lint');
    check('--lint is green on a well-formed document', r.code === 0 && /lint:decisions OK/.test(r.out), `exit ${r.code}`);
    check('the green lint line names what it read', /2 entries/.test(r.out), JSON.stringify(r.out.slice(0, 120)));

    fs.writeFileSync(fx.out, clean.replace('Some prose.', REAL_WELD));
    r = run(fx, '--lint');
    check('--lint is RED on the real welded line', r.code === 1 && /welded into a paragraph/.test(r.err), `exit ${r.code}`);
    // Line 7 of the fixture: `# Decisions` / blank / preamble / blank / heading /
    // blank / the prose that the weld replaces.
    check('the welded finding names the line number', /decisions\.md:7:/.test(r.err), JSON.stringify(r.err.slice(0, 160)));

    fs.writeFileSync(fx.out, `# Decisions\n\nPreamble.\n\n## 2026-09-08: heading with nothing under it\n\n## 2026-09-07: second\n\nProse.\n`);
    r = run(fx, '--lint');
    check('--lint is RED on an entry with no body', r.code === 1 && /has a heading and no body/.test(r.err), `exit ${r.code}`);

    fs.writeFileSync(fx.out, `# Decisions\n\nPreamble.\n\n## 2026-09-08: same\n\nOne.\n\n## 2026-09-08: same\n\nTwo.\n`);
    r = run(fx, '--lint');
    check('--lint is RED on the same decision recorded twice', r.code === 1 && /appears more than once/.test(r.err), `exit ${r.code}`);

    fs.writeFileSync(fx.out, `# Decisions\n\nPreamble.\n\n## 2026-09-08: fenced\n\n\`\`\`\nnot a weld: prose.## 2026-09-08: inside a fence\n\`\`\`\n`);
    r = run(fx, '--lint');
    check('--lint does not flag a welded-looking line inside a code fence', r.code === 0, `exit ${r.code}: ${r.err.slice(0, 120)}`);

    // The shipped corpus itself, so a false positive on real content is a red.
    const real = spawnSync('node', [SUBJECT, '--lint'], { encoding: 'utf8', cwd: ROOT });
    check('--lint is green on the committed docs/decisions.md', real.status === 0, `exit ${real.status}: ${(real.stderr || '').slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// 7. --split writes files, reads them back, and does not rewrite its own input
//    (rule-gate-integrity 6).
// ---------------------------------------------------------------------------
{
    const fx = fixture('split');
    const doc = `# Decisions\n\nPreamble.\n\n## 2026-09-08: the first decision\n\nProse one.\n\n## 2026-09-07: the second decision\n\nProse two.\n`;
    fs.writeFileSync(fx.out, doc);
    const before = fs.readFileSync(fx.out);
    let r = run(fx, '--split');
    check('--split exits 0 on a well-formed document', r.code === 0, `exit ${r.code}: ${r.err.slice(0, 200)}`);
    check('--split does not rewrite the document it read', fs.readFileSync(fx.out).equals(before));
    const written = fs.readdirSync(fx.dir).sort();
    check('--split wrote one file per entry, each <date>-<topic>.md', written.length === 2 && written.every((n) => mod.NAME_RE.test(n)), written.join(' '));
    check('--split says it read the files back', /read back byte-identical/.test(r.out), JSON.stringify(r.out.slice(0, 160)));

    r = run(fx, '--split');
    check('--split REFUSES to overwrite without --force', r.code === 1 && /already exist/.test(r.err), `exit ${r.code}`);
    r = run(fx, '--split', '--force');
    check('--split --force overwrites', r.code === 0, `exit ${r.code}`);

    r = run(fx, '--write');
    check('the aggregate regenerated from the split files is green under --check', r.code === 0 && run(fx, '--check').code === 0);
}

// ---------------------------------------------------------------------------
// 8. Bare invocation declares how it wants to be driven and writes nothing.
// ---------------------------------------------------------------------------
{
    const fx = fixture('bare');
    seed(fx, [['2026-09-08', 'alpha', 'alpha decision']]);
    const before = fs.readFileSync(fx.out);
    const r = spawnSync('node', [SUBJECT, '--dir', fx.dir, '--out', fx.out], { encoding: 'utf8' });
    check('bare invocation exits 2 with usage', r.status === 2 && /usage:/.test(r.stderr || ''), `exit ${r.status}`);
    check('bare invocation writes nothing', fs.readFileSync(fx.out).equals(before));
    const two = spawnSync('node', [SUBJECT, '--dir', fx.dir, '--out', fx.out, '--check', '--write'], { encoding: 'utf8' });
    check('two modes at once exits 2 rather than picking one', two.status === 2, `exit ${two.status}`);
}

// ---------------------------------------------------------------------------
// 9. --print through a PIPE is not truncated. On darwin process.stdout to a pipe
//    is async; process.exit() after a large write delivers exactly 65536 bytes
//    and exits 0. The fixture is asserted to EXCEED one buffer first, or the
//    comparison passes by construction.
// ---------------------------------------------------------------------------
{
    const fx = fixture('pipe');
    const filler = ('Prose that exists only to push this document past one 64 KiB pipe buffer, '
        + 'because a fixture under the buffer would make the comparison below vacuous. ').repeat(12);
    for (let i = 0; i < 40; i++) {
        const d = `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`;
        fs.writeFileSync(path.join(fx.dir, `${d}-filler-entry-${i}.md`), entry(d, `filler entry ${i}`, filler));
    }
    fs.writeFileSync(fx.out, '# Decisions\n\nPreamble.\n');
    run(fx, '--write');
    const viaFile = fs.readFileSync(fx.out);
    check('the pipe fixture EXCEEDS one 64 KiB buffer', viaFile.length > 65536, `${viaFile.length} bytes`);
    const piped = spawnSync('/bin/sh', ['-c',
        `node ${JSON.stringify(SUBJECT)} --dir ${JSON.stringify(fx.dir)} --out ${JSON.stringify(fx.out)} --print | cat`],
        { encoding: 'buffer', maxBuffer: 1 << 26 });
    const pipedOut = piped.stdout || Buffer.alloc(0);
    check('--print through a pipe is not truncated at 65536 bytes', pipedOut.length !== 65536, `${pipedOut.length} bytes`);
    check('--print through a pipe delivers the whole document', pipedOut.equals(viaFile), `${pipedOut.length} piped vs ${viaFile.length} written`);
}

// The suite must leave the tree, and its fixtures, unchanged.
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
