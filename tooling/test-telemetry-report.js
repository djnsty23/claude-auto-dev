#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/telemetry-report.js - the summary of
// .claude/reports/telemetry-*.jsonl that a session reads to answer "what is
// this harness actually costing".
// Run: node tooling/test-telemetry-report.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS ONE NEEDS TESTING AT ALL.
//
// Its blast radius is small and its failure mode is not. Every number it prints
// comes out of one `JSON.parse` inside one `try`, and the `catch` counts the
// line as unparseable and moves on. So a change to the record shape upstream -
// a writer that starts emitting an array, a wrapper, a BOM, CRLF handling -
// does not error here. It turns every line malformed, and the script prints a
// zero. A zero from this script is quotable: "we made 0 tool calls today",
// "Read is 0 KB". The whole point of the assertions below is that a zero must
// arrive with the population that produced it.
//
// It is honest today, and this suite pins exactly that: on an all-garbage file
// the header reads `0 events across 1 file(s), 0 distinct tools, 3 unparseable
// line(s)`. The suffix is what separates "nothing happened" from "nothing
// parsed", and it is the one clause a parse regression would leave standing
// while the counts fell to zero. See the report at the bottom for the one line
// of that output that IS a bare zero.
//
// THE SEAM.
//
// telemetry-report.js has no exports. It reads a directory - `--dir=` or, by
// default, `<cwd>/.claude/reports` - and writes to stdout. So the seam is a
// fixture directory of .jsonl files this suite wrote, and every assertion runs
// the shipped CLI as a subprocess and reads its stdout, stderr or exit status.
// Nothing reads this machine's real `.claude/reports`, so the suite cannot pass
// on a quiet day for the wrong reason, and its numbers do not move when a
// session on this machine makes a tool call while it runs.
//
// Record shape is copied from the writer, plugins/autodev-core/hooks/
// telemetry.js: `ts` is an ISO string, `tool` is a string (`''`, never absent,
// when the tool name is missing), and both sizes are byte counts.
//
// TWO KINDS OF ASSERTION, DELIBERATELY PAIRED.
//
// Every "the suffix appears" assertion is paired with a clean run asserting it
// does NOT. An assertion that `unparseable` shows up on garbage says nothing
// about whether it is suppressed on good input - and a suffix that is always
// present is a different bug wearing the same output.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'telemetry-report.js');

let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  (' + detail + ')'}`);
}

function eq(label, actual, expected) {
    check(label, actual === expected,
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const clip = (s) => JSON.stringify(String(s).slice(0, 700));

// ---------------------------------------------------------------------------
// Fixture machine
// ---------------------------------------------------------------------------

// realpathSync because on macOS os.tmpdir() hands back /var/folders/... while
// the same directory resolves to /private/var/folders/... — they are one
// directory behind a symlink. The subject reports the path it resolved from its
// own cwd, so an unresolved fixture makes the expectation differ from the actual
// by a prefix and nothing else, which reads as a real assertion failure on macOS
// and passes everywhere else.
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-report-')));

/** Make a directory of telemetry files. `files` maps a date to its lines. */
function makeDir(name, files) {
    const dir = path.join(fixture, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, lines] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, file), lines.join('\n') + '\n');
    }
    return dir;
}

/** One record in the shape hooks/telemetry.js appends. */
const rec = (o) => JSON.stringify({
    ts: o.ts,
    session: 'sess-fixture',
    cwd: 'C:/code/fixture',
    tool: o.tool,
    input_size: o.in,
    output_size: o.out,
    duration_ms: 12,
    ok: o.ok !== false,
});

// The graded corpus. Sizes are chosen so every KB figure below is an exact
// division, never a rounding that would hide an off-by-one in the accumulator.
const GRADED = makeDir('graded', {
    // 2 events, one tool, no failures.
    'telemetry-2026-08-21.jsonl': [
        rec({ ts: '2026-08-21T08:00:00.000Z', tool: 'Grep', in: 512, out: 512 }),
        rec({ ts: '2026-08-21T08:01:00.000Z', tool: 'Grep', in: 1024, out: 0 }),
    ],
    // 4 events, three tools, one failure.
    'telemetry-2026-08-22.jsonl': [
        rec({ ts: '2026-08-22T09:00:00.000Z', tool: 'Read', in: 1000, out: 3096 }),
        rec({ ts: '2026-08-22T09:01:00.000Z', tool: 'Read', in: 2000, out: 2096 }),
        rec({ ts: '2026-08-22T09:02:00.000Z', tool: 'Bash', in: 500, out: 1548, ok: false }),
        rec({ ts: '2026-08-22T09:03:00.000Z', tool: 'Edit', in: 1024, out: 1024 }),
    ],
    // 3 events, three tools, one failure, plus blank lines that are not records
    // and must not be counted as unparseable either.
    'telemetry-2026-08-23.jsonl': [
        rec({ ts: '2026-08-23T10:00:00.000Z', tool: 'Bash', in: 1024, out: 2048 }),
        '',
        rec({ ts: '2026-08-23T10:01:00.000Z', tool: 'Edit', in: 4096, out: 0 }),
        '   ',
        rec({ ts: '2026-08-23T10:02:00.000Z', tool: 'Read', in: 0, out: 0, ok: false }),
    ],
});

const ALL_GARBAGE = makeDir('garbage', {
    'telemetry-2026-08-24.jsonl': ['not json at all', '{"unterminated": ', '<html>error</html>'],
});

const HALF_GARBAGE = makeDir('half', {
    'telemetry-2026-08-24.jsonl': [
        rec({ ts: '2026-08-24T11:00:00.000Z', tool: 'Read', in: 1024, out: 1024 }),
        'truncated write, no closing brace',
        rec({ ts: '2026-08-24T11:01:00.000Z', tool: 'Read', in: 0, out: 0 }),
        '\u0000\u0000',
    ],
});

const CLEAN = makeDir('clean', {
    'telemetry-2026-08-24.jsonl': [
        rec({ ts: '2026-08-24T12:00:00.000Z', tool: 'Read', in: 1024, out: 1024 }),
        rec({ ts: '2026-08-24T12:01:00.000Z', tool: 'Read', in: 0, out: 0 }),
    ],
});

// Names that look close enough to be tempting and must not be read.
const NEIGHBOURS = makeDir('neighbours', {
    'telemetry-2026-08-24.jsonl': [rec({ ts: '2026-08-24T13:00:00.000Z', tool: 'Read', in: 1024, out: 0 })],
    'telemetry-2026-8-4.jsonl': [rec({ ts: '2026-08-04T13:00:00.000Z', tool: 'Nope', in: 9999, out: 9999 })],
    'telemetry-2026-08-24.json': [rec({ ts: '2026-08-24T13:00:00.000Z', tool: 'Nope', in: 9999, out: 9999 })],
    'telemetry-2026-08-24.jsonl.bak': [rec({ ts: '2026-08-24T13:00:00.000Z', tool: 'Nope', in: 9999, out: 9999 })],
    'notes.txt': ['Nope'],
});

// `ts` decides the day, and the filename is only the fallback. A record whose
// ts disagrees with its filename must be counted under its ts.
const DAYS = makeDir('days', {
    'telemetry-2026-08-19.jsonl': [
        rec({ ts: '2026-01-05T00:00:00.000Z', tool: 'Read', in: 0, out: 0 }),
        // No ts at all: the day must come from the filename, not from today.
        JSON.stringify({ tool: 'Read', input_size: 0, output_size: 0, ok: true }),
    ],
});

// A record the writer emits when tool_name is missing: `tool` is '', not absent.
const NAMELESS = makeDir('nameless', {
    'telemetry-2026-08-24.jsonl': [
        rec({ ts: '2026-08-24T14:00:00.000Z', tool: 'Read', in: 1024, out: 0 }),
        rec({ ts: '2026-08-24T14:01:00.000Z', tool: '', in: 2048, out: 0 }),
    ],
});

// 17 tools, calls 17 down to 1, one KB per call. Only 15 rows are printed.
const MANY = (() => {
    const lines = [];
    for (let i = 1; i <= 17; i++) {
        const tool = 'tool' + String(i).padStart(2, '0');
        for (let n = 0; n < 18 - i; n++) {
            lines.push(rec({ ts: '2026-08-24T15:00:00.000Z', tool, in: 1024, out: 0 }));
        }
    }
    return makeDir('many', { 'telemetry-2026-08-24.jsonl': lines });
})();

const EMPTY_DIR = makeDir('emptydir', {});
const WRONG_NAMES = makeDir('wrongnames', { 'readme.md': ['nothing here'] });

// A project laid out the way the writer lays one out, for the default path.
const PROJECT = path.join(fixture, 'project');
fs.mkdirSync(path.join(PROJECT, '.claude', 'reports'), { recursive: true });
fs.writeFileSync(path.join(PROJECT, '.claude', 'reports', 'telemetry-2026-08-24.jsonl'),
    rec({ ts: '2026-08-24T16:00:00.000Z', tool: 'Write', in: 3072, out: 1024 }) + '\n');
const BARE_PROJECT = path.join(fixture, 'bare-project');
fs.mkdirSync(BARE_PROJECT, { recursive: true });

// ---------------------------------------------------------------------------
// Subprocess helpers. Nothing here requires the subject in-process.
// ---------------------------------------------------------------------------

function run(args, cwd) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], {
        encoding: 'utf8',
        cwd: cwd || fixture,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const onDir = (dir, extra) => run([`--dir=${dir}`, ...(extra || [])]);

const headline = (out) => (out.split('\n')[0] || '');
const num = (out, re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
const events = (out) => num(out, /^(\d+) events across/m);
const fileCount = (out) => num(out, /^\d+ events across (\d+) file\(s\)/m);
const tools = (out) => num(out, /(\d+) distinct tools/);
const unparseable = (out) => num(out, /(\d+) unparseable line\(s\)/);
const failedCalls = (out) => num(out, /(\d+) failed call\(s\)/);
const totalKb = (out) => num(out, /^Total payload: (\d+) KB\./m);

// Rebuild a by-tool row exactly as the subject formats it, so an assertion is
// on the VALUE in the column rather than on the tool name being present.
const toolRow = (tool, calls, kb, failed) =>
    `  ${tool.padEnd(16)} ${String(calls).padStart(6)} calls  ${String(kb).padStart(7)} KB`
    + (failed ? `  ${failed} failed` : '');

const dayRow = (day, n) => `  ${day}  ${String(n).padStart(6)} events`;

// ---------------------------------------------------------------------------

try {
    // -----------------------------------------------------------------------
    // A known corpus produces known numbers. Every figure here was computed
    // from the fixture by hand, not read back off a first run.
    // -----------------------------------------------------------------------
    {
        const r = onDir(GRADED, ['--days=0']);
        eq('a full read exits 0', r.status, 0);
        eq('a clean run writes nothing to stderr', r.stderr, '');

        eq('the headline is the population, on the first line', headline(r.stdout),
            '9 events across 3 file(s), 4 distinct tools, 2 failed call(s)');
        eq('every parseable record is counted once', events(r.stdout), 9);
        eq('...across every file it read', fileCount(r.stdout), 3);
        eq('...under the tools that made them', tools(r.stdout), 4);
        eq('...with the failures called out separately', failedCalls(r.stdout), 2);
        check('...and no unparseable clause, because there were none',
            !r.stdout.includes('unparseable'), clip(r.stdout));

        // Blank and whitespace-only lines are skipped BEFORE the parse, so they
        // are neither events nor unparseable. Both halves matter: counting them
        // as malformed would invent a data-quality problem out of formatting.
        eq('blank lines are not events', events(r.stdout), 9);
        eq('...and are not unparseable either', unparseable(r.stdout), null);

        check('events are attributed to the day their ts names',
            r.stdout.includes(dayRow('2026-08-21', 2))
            && r.stdout.includes(dayRow('2026-08-22', 4))
            && r.stdout.includes(dayRow('2026-08-23', 3)),
            clip(r.stdout));

        // Read: 4096 + 4096 + 0 = 8192 bytes over 3 calls, one of them failed.
        check('a tool row carries its calls, its kilobytes and its failures',
            r.stdout.includes(toolRow('Read', 3, 8, 1)), clip(r.stdout));
        // Bash: 2048 + 3072 = 5120 bytes over 2 calls, one failed.
        check('...for a tool whose calls span two files',
            r.stdout.includes(toolRow('Bash', 2, 5, 1)), clip(r.stdout));
        // Edit: 2048 + 4096 = 6144 bytes over 2 calls, none failed.
        check('...and a tool with no failures carries no failure column',
            r.stdout.includes(toolRow('Edit', 2, 6, 0)), clip(r.stdout));
        check('...while a tool confined to one day is still summed',
            r.stdout.includes(toolRow('Grep', 2, 2, 0)), clip(r.stdout));

        // 8192 + 5120 + 6144 + 2048 = 21504 bytes.
        eq('the total is the sum of every tool, not of the top rows', totalKb(r.stdout), 21);

        // Rows are ordered by calls, and the tie between Bash, Edit and Grep at
        // 2 resolves to first-seen. Grep is first because 08-21 is read first.
        const order = ['Read', 'Grep', 'Bash', 'Edit'].map((t) => r.stdout.indexOf(toolRow(t, 0, 0, 0).slice(0, 18)));
        check('tools are ranked by call count, busiest first',
            order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
            `offsets ${JSON.stringify(order)} in ${clip(r.stdout)}`);
    }

    // -----------------------------------------------------------------------
    // THE ONE THAT MATTERS. Garbage in must not read as a quiet, quotable zero.
    // -----------------------------------------------------------------------
    {
        const r = onDir(ALL_GARBAGE);
        eq('a file of nothing but garbage still exits 0', r.status, 0);
        eq('...and reports zero events', events(r.stdout), 0);
        eq('...and zero tools', tools(r.stdout), 0);
        // The clause that makes that zero legible. Lose it and the output is
        // indistinguishable from a harness that made no tool calls today.
        eq('...but names every line it could not parse', unparseable(r.stdout), 3);
        eq('the whole population is on the first line', headline(r.stdout),
            '0 events across 1 file(s), 0 distinct tools, 3 unparseable line(s)');
        check('...and no by-tool table is drawn over an empty parse',
            !r.stdout.includes('By tool:'), clip(r.stdout));
        check('...nor a total payload a reader could quote',
            !r.stdout.includes('Total payload'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // The adjacent case: a PARTIAL parse failure, which is what a record-shape
    // change actually looks like on the day it lands. The counts must disagree.
    // -----------------------------------------------------------------------
    {
        const r = onDir(HALF_GARBAGE);
        eq('a half-parsed file reports the records it read', events(r.stdout), 2);
        eq('...and, separately, the lines it did not', unparseable(r.stdout), 2);
        eq('the two counts are carried side by side', headline(r.stdout),
            '2 events across 1 file(s), 1 distinct tools, 2 unparseable line(s)');
        // 1024 + 1024 + 0 + 0 = 2048 bytes over the two records that parsed.
        check('...and the table is still drawn for what did parse',
            r.stdout.includes(toolRow('Read', 2, 2, 0)), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // ...and the same clause must be absent when nothing was malformed, or it
    // is decoration rather than a signal.
    // -----------------------------------------------------------------------
    {
        const r = onDir(CLEAN);
        eq('a clean file reports no unparseable clause at all',
            unparseable(r.stdout), null);
        eq('...and no failure clause either', failedCalls(r.stdout), null);
        eq('the headline carries the population and nothing more', headline(r.stdout),
            '2 events across 1 file(s), 1 distinct tools');
    }

    // -----------------------------------------------------------------------
    // Which files count as telemetry. A loosened filename test silently widens
    // the population, which moves every number above without warning.
    // -----------------------------------------------------------------------
    {
        const r = onDir(NEIGHBOURS, ['--days=0']);
        eq('only the strict telemetry-YYYY-MM-DD.jsonl name is read',
            fileCount(r.stdout), 1);
        eq('...so a single-digit month, a .json, a .bak and a .txt are all skipped',
            events(r.stdout), 1);
        check('...and no tool from those files reaches the table',
            !r.stdout.includes('Nope'), clip(r.stdout));
        eq('...leaving a total drawn from the one file that qualified',
            totalKb(r.stdout), 1);
    }

    // -----------------------------------------------------------------------
    // The --days window. The report names a file count but never a date range,
    // so a window silently reverting to its default is invisible in the output.
    // -----------------------------------------------------------------------
    {
        const one = onDir(GRADED);                 // default
        eq('the default window is the newest file only', fileCount(one.stdout), 1);
        eq('...which is the LAST file by date, not the first', events(one.stdout), 3);
        check('...and the day it reports is the newest one',
            one.stdout.includes(dayRow('2026-08-23', 3))
            && !one.stdout.includes('2026-08-21'), clip(one.stdout));

        const explicit = onDir(GRADED, ['--days=1']);
        eq('--days=1 is the same as the default', events(explicit.stdout), 3);

        const two = onDir(GRADED, ['--days=2']);
        eq('--days=2 takes the two newest files', fileCount(two.stdout), 2);
        eq('...and their events together', events(two.stdout), 7);

        const zero = onDir(GRADED, ['--days=0']);
        eq('--days=0 means every file, not none', fileCount(zero.stdout), 3);
        eq('...and every event', events(zero.stdout), 9);

        const wide = onDir(GRADED, ['--days=99']);
        eq('a window wider than the corpus is clamped by what exists',
            fileCount(wide.stdout), 3);

        // A non-numeric window is NaN, and `NaN > 0` is false, so it takes the
        // same branch as --days=0 and reports EVERYTHING. Pinned because the
        // failure is silent and the number it produces is quotable.
        const junk = onDir(GRADED, ['--days=week']);
        eq('a non-numeric window silently widens to the whole corpus, not none',
            events(junk.stdout), 9);
    }

    // -----------------------------------------------------------------------
    // Which day an event belongs to. The record's own ts wins; the filename is
    // only the fallback, and neither is today's date.
    // -----------------------------------------------------------------------
    {
        const r = onDir(DAYS);
        eq('both records are counted', events(r.stdout), 2);
        check('a record is filed under its own ts, even against its filename',
            r.stdout.includes(dayRow('2026-01-05', 1)), clip(r.stdout));
        check('...and a record with no ts falls back to the filename date',
            r.stdout.includes(dayRow('2026-08-19', 1)), clip(r.stdout));
        check('...so no event is filed under the day the report was run',
            !r.stdout.includes(new Date().toISOString().slice(0, 10)), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // A record the writer emits with an empty tool name. It is counted, and it
    // is counted as a DISTINCT tool - so "2 distinct tools" here means one real
    // tool and one nameless row, which a reader can only know if it is shown.
    // -----------------------------------------------------------------------
    {
        const r = onDir(NAMELESS);
        eq('a record with an empty tool name is still an event', events(r.stdout), 2);
        eq('...and counts toward the distinct-tool population', tools(r.stdout), 2);
        check('...appearing as a nameless row rather than being dropped',
            r.stdout.includes(toolRow('', 1, 2, 0)), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // The table is capped at 15 rows while the headline counts every tool. That
    // gap is the reason the headline exists, so both halves are pinned.
    // -----------------------------------------------------------------------
    {
        const r = onDir(MANY);
        eq('every event is counted', events(r.stdout), 153);
        eq('...and every distinct tool, beyond what the table can show',
            tools(r.stdout), 17);
        check('the busiest tool leads the table',
            r.stdout.includes(toolRow('tool01', 17, 17, 0)), clip(r.stdout));
        check('...the fifteenth row is the last one drawn',
            r.stdout.includes(toolRow('tool15', 3, 3, 0)), clip(r.stdout));
        check('...and the sixteenth and seventeenth are not drawn at all',
            !r.stdout.includes('tool16') && !r.stdout.includes('tool17'), clip(r.stdout));
        // The total is summed over byTool, not over the printed rows: dropping
        // the two hidden tools would make it 150.
        eq('the total payload still includes the tools the table omitted',
            totalKb(r.stdout), 153);
    }

    // -----------------------------------------------------------------------
    // Nothing to report. Two different absences, two different sentences - and
    // neither of them is a table of zeroes.
    // -----------------------------------------------------------------------
    {
        const missing = path.join(fixture, 'no-such-dir');
        const r = onDir(missing);
        eq('a missing directory exits 0', r.status, 0);
        eq('...saying where it looked and who creates it', r.stdout,
            `No telemetry directory at ${missing}. The hook writes one on the first tool call.\n`);
    }
    {
        const r = onDir(EMPTY_DIR);
        eq('an empty directory exits 0', r.status, 0);
        eq('...and is reported as empty, naming the directory', r.stdout,
            `No telemetry files in ${EMPTY_DIR}.\n`);
    }
    {
        const r = onDir(WRONG_NAMES);
        eq('a directory holding only non-telemetry files reads as empty', r.stdout,
            `No telemetry files in ${WRONG_NAMES}.\n`);
    }

    // -----------------------------------------------------------------------
    // The default directory. This is how the script is actually invoked, and
    // --dir= is the seam every assertion above rides on - so the default has to
    // be exercised too or the whole suite could be testing an unused path.
    // -----------------------------------------------------------------------
    {
        const r = run([], PROJECT);
        eq('with no --dir it reads <cwd>/.claude/reports', events(r.stdout), 1);
        check('...summarising what it found there',
            r.stdout.includes(toolRow('Write', 1, 4, 0)), clip(r.stdout));

        const bare = run([], BARE_PROJECT);
        eq('...and names that same default path when it is absent', bare.stdout,
            `No telemetry directory at ${path.join(BARE_PROJECT, '.claude', 'reports')}`
            + '. The hook writes one on the first tool call.\n');
    }

} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
