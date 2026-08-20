#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/analyze-session-patterns.js.
//
// The property that carries the weight is WINDOWING. The first version of this
// tool filtered by file mtime and then counted every event inside the file, so a
// long-lived transcript — they are appended to for months under one name —
// contributed five-week-old failures to a "last 1 day" report. It reported a
// runaway session that did not exist. The fixture below plants an event far
// outside the window in a file whose mtime is NOW, which is the exact shape that
// fooled it; nothing but a per-event timestamp check can pass that case.
//
// Second: the DENOMINATOR. It counted tool results only on lines that had
// already matched the error filter, so it reported "783 of 783 errored" — a
// share of itself. The fixture carries successful tool results too, and the
// error rate is asserted to be strictly between 0 and 100%.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'analyze-session-patterns.js');
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
    if (ok) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86400_000;

// A transcript line as the CLI really writes one: the tool result lives in
// message.content[], and the event's own time is the top-level `timestamp`.
function line(ts, { error = null, ok = false } = {}) {
    const block = error === null
        ? { type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'fine' }
        : { type: 'tool_result', tool_use_id: 't1', is_error: true, content: error };
    return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [block] } });
}

// A tool_use carrying its own timestamp. Pricing a failure needs the pair:
// the request time and the result time, matched by tool_use_id.
function useLine(ts, id) {
    return JSON.stringify({ type: 'assistant', timestamp: ts,
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } });
}

function resultLine(ts, id, error) {
    return JSON.stringify({ type: 'user', timestamp: ts,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: error }] } });
}

function fixture(lines) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sesspat-'));
    const proj = path.join(root, 'C--Users-x-code-demo');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), lines.join('\n') + '\n');
    // mtime is NOW by construction — that is the whole point of the window case.
    return root;
}

function run(root, extra = []) {
    const r = spawnSync(process.execPath, [TOOL, '--root', root, ...extra], { encoding: 'utf8' });
    return { ...r, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('test-session-patterns');

// ---- windowing: the regression this suite exists for ----
// The old event is dated 10 days back while the tool is run with --days 1. The
// gap is derived from the flag, not from a hand-picked date, so it cannot decay
// into a false pass if the fixture is edited later.
const mixed = fixture([
    line(iso(10 * DAY), { error: '<tool_use_error>File has not been read yet. Read it first.</tool_use_error>' }),
    line(iso(10 * DAY), { error: '<tool_use_error>File has not been read yet. Read it first.</tool_use_error>' }),
    line(iso(1 * 3600_000), { error: '<tool_use_error>String to replace not found in file.</tool_use_error>' }),
    line(iso(2 * 3600_000)),
    line(iso(3 * 3600_000)),
    line(iso(4 * 3600_000)),
]);

const win = run(mixed, ['--days', '1', '--no-examples']);
check('exits 0 on a populated tree', win.status === 0, 'exit ' + win.status);
check('an event older than the window is EXCLUDED even though the file is fresh',
    !/edit-before-read/.test(win.out), win.out.slice(0, 400));
check('  and an in-window event of a different class IS counted',
    /edit-anchor-missing/.test(win.out), win.out.slice(0, 400));
check('  and the skipped older lines are reported, not silently dropped',
    /older than the window, skipped/.test(win.out) && /2 older/.test(win.out.replace(/\((\d+) older/, '$1 older')),
    (win.out.match(/\(.*skipped\)/) || [''])[0]);

// Paired positive: the same fixture with a window wide enough MUST show the
// class the case above asserts is absent. Without this, that assertion would
// also pass if the tool simply never classified anything.
const wide = run(mixed, ['--days', '30', '--no-examples']);
check('  the same old event IS counted when the window covers it',
    /edit-before-read/.test(wide.out), wide.out.slice(0, 400));

// ---- denominator ----
const m = win.out.match(/(\d+) tool results IN WINDOW, (\d+) errored \(([\d.]+)%\)/);
check('reports tool results and errors as separate populations', Boolean(m), win.out.slice(0, 300));
if (m) {
    const [, total, errs, pct] = m;
    check('  the denominator includes SUCCESSFUL tool results', Number(total) > Number(errs),
        `${errs}/${total}`);
    check('  so the error rate is not a share of itself', Number(pct) > 0 && Number(pct) < 100, pct + '%');
}

// ---- classification is on the head, not the whole blob ----
const deep = fixture([
    line(iso(3600_000), { error: 'Exit code 0 ' + 'x'.repeat(900) + ' ENOENT appears way down here' }),
]);
const deepOut = run(deep, ['--days', '1', '--no-examples']);
check('a long output that merely MENTIONS ENOENT is not called a missing file',
    !/file-missing/.test(deepOut.out), deepOut.out.slice(0, 300));

// ---- the shell three-way split ----
// The catch-all used to hold 28% of all errors with the advice "check whether
// the exit code IS the answer", which is a shrug rather than a class. These
// three cases pin the split. They also exist because the first implementation
// was broken in a way no probe caught: a word-boundary escape (backslash-b) in
// both regexes collapsed into a literal BACKSPACE byte during a scripted patch,
// so the patterns silently matched nothing and everything fell through to the
// catch-all. A control character renders as empty in a terminal, so the source
// LOOKED right in every dump — only classifying known input revealed it.
const shell = fixture([
    line(iso(3600_000), { error: 'Exit code 2 === branch === abc123 some real output' }),
    line(iso(3600_000), { error: 'Exit code 127 nope: command not found' }),
    line(iso(3600_000), { error: 'Exit code 1 Traceback (most recent call last): boom' }),
]);
const shellOut = run(shell, ['--days', '1', '--no-examples']);
check('a non-zero exit with real output and no error marker is not called a fault',
    /shell-exit-may-be-the-answer/.test(shellOut.out), shellOut.out.slice(0, 400));
check('  exit 127 is its own class, never "maybe the answer"',
    /command-not-found/.test(shellOut.out), shellOut.out.slice(0, 400));
check('  an exit carrying a Traceback IS a fault',
    /shell-fault/.test(shellOut.out), shellOut.out.slice(0, 400));

// ---- wall-clock cost ----
// Breadth and cost disagree, which is the whole reason this view exists: on
// real data the top cost class was sixth by breadth. The fixture makes the
// cheap class MORE frequent than the expensive one, so a ranking that
// secretly sorts by count cannot pass.
const cost = fixture([
    useLine(iso(3600000), 'slow1'),
    resultLine(iso(3600000 - 120000), 'slow1', 'Error: Exit code 143 Command timed out after 2m 0s'),
    useLine(iso(3000000), 'fast1'),
    resultLine(iso(3000000 - 1000), 'fast1', 'Error: Cannot find module ' + String.fromCharCode(39) + '/tmp/a.json' + String.fromCharCode(39)),
    useLine(iso(2900000), 'fast2'),
    resultLine(iso(2900000 - 1000), 'fast2', 'Error: Cannot find module ' + String.fromCharCode(39) + '/tmp/b.json' + String.fromCharCode(39)),
]);
const costOut = run(cost, ['--days', '1', '--no-examples', '--by-cost']);
check('prices failures in wall clock and says how many it could price',
    /could be priced in wall clock/.test(costOut.out), costOut.out.slice(0, 300));
const costBlock = costOut.out.slice(costOut.out.indexOf('WALL-CLOCK COST'));
const slowAt = costBlock.indexOf('command-timeout');
const fastAt = costBlock.indexOf('tmp-path-split');
check('  the slow class outranks the more FREQUENT cheap one',
    slowAt !== -1 && fastAt !== -1 && slowAt < fastAt, costBlock.slice(0, 260));
check('  and the cost view is opt-in, absent without the flag',
    !/WALL-CLOCK COST/.test(run(cost, ['--days', '1', '--no-examples']).out));

// ---- privacy ----
const SECRET = 'sk-live-CANARY-51N3z9';
const leaky = fixture([
    line(iso(3600_000), { error: `Error: request failed with Authorization: Bearer ${SECRET}` }),
]);
const leakOut = run(leaky, ['--days', '1']);
check('a token-shaped secret in an error message is redacted from the report',
    !leakOut.out.includes(SECRET), leakOut.out.slice(0, 300));
check('  but the call is still reported', /1 errored/.test(leakOut.out), leakOut.out.slice(0, 200));

// ---- machine-readable ----
const jsonOut = run(mixed, ['--days', '1', '--json']);
let parsed = null;
try { parsed = JSON.parse(jsonOut.stdout); } catch { /* reported below */ }
check('--json emits valid JSON', parsed !== null);
check('  carrying the population, so a consumer can tell empty from broken',
    parsed && parsed.population && typeof parsed.population.toolResults === 'number');

// ---- an empty root must announce itself, not report "no problems" ----
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sesspat-empty-'));
const emptyOut = run(empty, ['--days', '1']);
check('an empty root reports PROBE BLIND rather than a clean bill of health',
    /PROBE BLIND/.test(emptyOut.out), emptyOut.out.slice(0, 200));
check('  and exits non-zero so a caller cannot mistake it for success',
    emptyOut.status === 2, 'exit ' + emptyOut.status);

// ---- read-only ----
const before = fs.readdirSync(path.join(mixed, 'C--Users-x-code-demo')).sort().join(',');
run(mixed, ['--days', '1']);
const after = fs.readdirSync(path.join(mixed, 'C--Users-x-code-demo')).sort().join(',');
check('the tool writes nothing into the tree it reads', before === after);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
