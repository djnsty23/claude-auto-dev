#!/usr/bin/env node
// Suite for hooks/context-depth-nudge.js.
//
// Drives the hook as a SUBPROCESS with real stdin, a real transcript file on
// disk, and a real ledger file, because every one of its decisions is a read
// of something outside itself. A test that handed it a parsed object would be
// testing this file's model of a transcript.
//
// The assertions that matter most are the SILENT ones. This hook speaks into
// the model's context, so speaking when it should not is the failure: a nudge
// on every turn is a nudge that gets ignored, and then the one that matters is
// ignored with it. Each quiet path asserts ZERO BYTES on stdout AND stderr.
//
// The transcript rows are shaped like a real one: this suite was written
// against a live transcript whose latest assistant row read
// input 32 + cache_read 401,732 + cache_creation 814 = 402,578.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'context-depth-nudge.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
    if (ok) {
        pass++;
        console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
    } else {
        fail++;
        failures.push(name);
        console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
    }
}

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A transcript row shaped like Claude Code's, for an assistant call at the given depth. */
function assistantRow(depth, { input = 32, creation = 814 } = {}) {
    const read = Math.max(0, depth - input - creation);
    return JSON.stringify({
        type: 'assistant',
        uuid: 'a-' + depth,
        message: {
            role: 'assistant',
            model: 'claude-fable-5-1',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
                input_tokens: input,
                cache_creation_input_tokens: creation,
                cache_read_input_tokens: read,
                output_tokens: 12,
            },
        },
    });
}

function userRow(text) {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

/** Writes rows to a transcript file; returns its path. */
function transcript(rows, name = 's.jsonl') {
    const p = path.join(tmpDir('cdn-tx-'), name);
    fs.writeFileSync(p, rows.join('\n') + '\n');
    return p;
}

function ledgerFile() {
    return path.join(tmpDir('cdn-ledger-'), 'state.json');
}

/** Run the hook once. */
function run({ input, ledger, env }) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
            AUTODEV_CONTEXT_NUDGE_STATE: ledger,
            AUTODEV_CONTEXT_NUDGE: '',
            AUTODEV_CONTEXT_NUDGE_TOKENS: '',
            AUTODEV_CONTEXT_NUDGE_STEP: '',
        }, env || {}),
    });
    return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

function silentOk(r) {
    return r.out.length === 0 && r.err.length === 0 && r.status === 0;
}

/** The parsed nudge, or null if the hook did not speak in the expected shape. */
function spoke(r) {
    if (r.status !== 0 || r.err.length !== 0) return null;
    try {
        const j = JSON.parse(r.out);
        const ctx = j && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext;
        return typeof ctx === 'string' && typeof j.systemMessage === 'string' ? j : null;
    } catch {
        return null;
    }
}

// --- inert paths ----------------------------------------------------------
{
    const ledger = ledgerFile();
    const tx = transcript([userRow('hi'), assistantRow(402_578)]);

    const bad = run({ input: 'not json at all', ledger });
    check('unparseable stdin: silent, exit 0 rather than a crash', silentOk(bad),
        `exit=${bad.status} err=${bad.err.length}B`);

    const noTx = run({ input: { session_id: 's1' }, ledger });
    check('no transcript_path: silent', silentOk(noTx), `out=${noTx.out.length}B`);

    const noSession = run({ input: { transcript_path: tx }, ledger });
    check('no session_id: silent (no ledger key to throttle on)', silentOk(noSession),
        `out=${noSession.out.length}B`);

    const missing = run({ input: { session_id: 's1', transcript_path: path.join(os.tmpdir(), 'cdn-absent.jsonl') }, ledger });
    check('transcript file absent: silent', silentOk(missing), `out=${missing.out.length}B`);

    const shallow = run({ input: { session_id: 's1', transcript_path: transcript([userRow('hi'), assistantRow(120_000)]) }, ledger });
    check('depth 120k, below the 300k line: silent', silentOk(shallow), `out=${shallow.out.length}B`);

    const justUnder = run({ input: { session_id: 's1', transcript_path: transcript([userRow('hi'), assistantRow(299_999)]) }, ledger });
    check('depth 299,999: silent (the line is inclusive at 300,000)', silentOk(justUnder),
        `out=${justUnder.out.length}B`);

    const noUsage = run({ input: { session_id: 's1', transcript_path: transcript([userRow('hi'), userRow('again')]) }, ledger });
    check('no assistant row with usage: silent', silentOk(noUsage), `out=${noUsage.out.length}B`);

    const off = run({ input: { session_id: 's1', transcript_path: tx }, ledger, env: { AUTODEV_CONTEXT_NUDGE: 'off' } });
    check('AUTODEV_CONTEXT_NUDGE=off: silent even at 402k', silentOk(off), `out=${off.out.length}B`);
}

// --- the firing path ------------------------------------------------------
{
    const ledger = ledgerFile();
    const tx = transcript([userRow('hi'), assistantRow(402_578)]);
    const r = run({ input: { session_id: 's-fire', transcript_path: tx }, ledger });
    const j = spoke(r);
    check('depth 402,578 past the 300k line: speaks in the Stop shape', !!j,
        `exit=${r.status} out=${r.out.slice(0, 80)}`);
    if (j) {
        const ctx = j.hookSpecificOutput.additionalContext;
        check('the model line carries the exact depth', ctx.includes('402,578'), ctx.slice(0, 60));
        check('the model line names RESUME.md and the 300k line',
            ctx.includes('RESUME.md') && ctx.includes('300k'), ctx.slice(0, 120));
        check('hookEventName is Stop', j.hookSpecificOutput.hookEventName === 'Stop');
        check('no decision key: it cannot fight stop-auto-check', !('decision' in j), Object.keys(j).join(','));
        check('the operator line is short and carries the depth',
            j.systemMessage.includes('403k') && j.systemMessage.length < 160, j.systemMessage);
        const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
        // 402,578 - 300,000 = 102,578, one whole 100k step past the line: bucket 1.
        check('the ledger records bucket 1 (one 100k step past the line) for this session',
            led['s-fire'] && led['s-fire'].bucket === 1 && led['s-fire'].depth === 402_578,
            JSON.stringify(led['s-fire']));
    }

    // Exactly the same depth again: the line was already announced.
    const again = run({ input: { session_id: 's-fire', transcript_path: tx }, ledger });
    check('same session, same bucket: silent (spoke once, not every turn)', silentOk(again),
        `out=${again.out.length}B`);

    // Deeper but inside the same 100k step (bucket 1 spans 400,000..499,999): silent.
    const deeper = run({ input: { session_id: 's-fire', transcript_path: transcript([userRow('x'), assistantRow(450_000)]) }, ledger });
    check('450k, still bucket 1: silent', silentOk(deeper), `out=${deeper.out.length}B`);

    // Shallower than the announced step (a compaction): silent, never re-announced.
    const shallower = run({ input: { session_id: 's-fire', transcript_path: transcript([userRow('x'), assistantRow(399_000)]) }, ledger });
    check('399k after announcing bucket 1: silent, a fall-back is not a crossing', silentOk(shallower), `out=${shallower.out.length}B`);

    // Cross the next step: speaks again, once.
    const next = run({ input: { session_id: 's-fire', transcript_path: transcript([userRow('x'), assistantRow(505_000)]) }, ledger });
    check('505k crosses into bucket 2: speaks again', !!spoke(next), `out=${next.out.slice(0, 60)}`);
    const nextAgain = run({ input: { session_id: 's-fire', transcript_path: transcript([userRow('x'), assistantRow(580_000)]) }, ledger });
    check('580k, same bucket as 505k: silent', silentOk(nextAgain), `out=${nextAgain.out.length}B`);

    // A different session sharing the ledger has its own memory.
    const other = run({ input: { session_id: 's-other', transcript_path: tx }, ledger });
    check('another session_id in the same ledger: speaks on its own first crossing', !!spoke(other),
        `out=${other.out.slice(0, 60)}`);
}

// --- the latest row wins, and the tail read survives a big row -------------
{
    const ledger = ledgerFile();
    // Deep earlier, shallow now (a compaction happened): the LATEST row decides.
    const compacted = transcript([userRow('hi'), assistantRow(402_578), userRow('more'), assistantRow(90_000)]);
    const r1 = run({ input: { session_id: 's-latest', transcript_path: compacted }, ledger });
    check('latest assistant row is 90k after an earlier 402k row: silent', silentOk(r1), `out=${r1.out.length}B`);

    // A 700KB attachment row AFTER the last assistant row, larger than one
    // 256KB read chunk: the backward scan must reach past it.
    const bigRow = JSON.stringify({ type: 'attachment', attachment: { type: 'tool_result', content: 'x'.repeat(700 * 1024) } });
    const withBig = transcript([userRow('hi'), assistantRow(402_578), bigRow, userRow('after')]);
    const r2 = run({ input: { session_id: 's-big', transcript_path: withBig }, ledger });
    check('usage row sits behind a 700KB row past the first chunk: still found, speaks', !!spoke(r2),
        `size=${fs.statSync(withBig).size}B out=${r2.out.slice(0, 40)}`);

    // A truncated last line (a crash mid-write) must not hide the row before it.
    const truncated = transcript([userRow('hi'), assistantRow(402_578), '{"type":"assistant","message":{"usage":{"input_tokens":1']);
    const r3 = run({ input: { session_id: 's-trunc', transcript_path: truncated }, ledger });
    check('truncated final line: the previous usage row still decides, speaks', !!spoke(r3),
        `out=${r3.out.slice(0, 40)}`);

    // A row that MENTIONS "usage" but is not an assistant row is skipped.
    const decoy = transcript([userRow('hi'), assistantRow(402_578), userRow('please check "usage" of the api')]);
    const r4 = run({ input: { session_id: 's-decoy', transcript_path: decoy }, ledger });
    check('a user row containing the word usage is not a depth reading', !!spoke(r4), `out=${r4.out.slice(0, 40)}`);
}

// --- the line is configurable, and a bad value falls back --------------------
{
    const ledger = ledgerFile();
    const tx = transcript([userRow('hi'), assistantRow(150_000)]);
    const lowLine = run({ input: { session_id: 's-cfg', transcript_path: tx }, ledger, env: { AUTODEV_CONTEXT_NUDGE_TOKENS: '100000' } });
    check('AUTODEV_CONTEXT_NUDGE_TOKENS=100000: 150k speaks', !!spoke(lowLine), `out=${lowLine.out.slice(0, 40)}`);
    const badLine = run({ input: { session_id: 's-cfg2', transcript_path: tx }, ledger, env: { AUTODEV_CONTEXT_NUDGE_TOKENS: 'lots' } });
    check('a non-numeric line falls back to 300k: 150k silent', silentOk(badLine), `out=${badLine.out.length}B`);
}

// --- a broken ledger must not break a turn -----------------------------------
{
    const ledger = ledgerFile();
    fs.writeFileSync(ledger, '{ this is not json');
    const tx = transcript([userRow('hi'), assistantRow(402_578)]);
    const r = run({ input: { session_id: 's-corrupt', transcript_path: tx }, ledger });
    check('corrupt ledger: treated as a first crossing, speaks, never a crash', !!spoke(r),
        `exit=${r.status} err=${r.err.length}B`);
    let rewritten = null;
    try { rewritten = JSON.parse(fs.readFileSync(ledger, 'utf8')); } catch { /* left corrupt */ }
    check('the corrupt ledger is rewritten as valid JSON', !!rewritten && !!rewritten['s-corrupt']);
}

// --- help ------------------------------------------------------------------
{
    const r = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8' });
    check('--help prints the contract and exits 0', r.status === 0 && /RESUME\.md/.test(r.stdout));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
console.log('subject: plugins/autodev-core/hooks/context-depth-nudge.js; '
    + (pass + fail) + ' cases over 8 inert paths, the firing path with a 3-step throttle '
    + 'and a second session in the same ledger, latest-row-wins after a compaction, a '
    + '700KB row past the first read chunk, a truncated final line, a decoy user row, '
    + 'a configurable line with a bad-value fallback, and a corrupt ledger. Every quiet '
    + 'case asserts zero bytes on BOTH streams.');
if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exit(1);
}
