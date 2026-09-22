#!/usr/bin/env node
// Suite for hooks/context-depth-nudge.js.
//
// Drives the hook as a SUBPROCESS with real stdin, a real transcript file on
// disk, a real per-session state directory and real settings files, because
// every one of its decisions is a read of something outside itself. A test that
// handed it a parsed object would be testing this file's model of a transcript.
//
// The assertions that matter most are the SILENT ones. This hook BLOCKS a Stop,
// so speaking when it should not holds a turn open: once per band is a nudge,
// every turn is a loop. Each quiet path asserts ZERO BYTES on stdout AND stderr.
//
// The transcript rows are shaped like a real one: the original suite was
// written against a live transcript whose latest assistant row read
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

/**
 * A sandbox: its own state directory, an empty config dir (so the operator's
 * real ~/.claude/settings.json can never decide a case), and a project cwd.
 */
function sandbox() {
    const root = tmpDir('cdn-box-');
    const box = {
        root,
        state: path.join(root, 'state'),
        config: path.join(root, 'config'),
        cwd: path.join(root, 'proj'),
    };
    fs.mkdirSync(box.config, { recursive: true });
    fs.mkdirSync(box.cwd, { recursive: true });
    return box;
}

function stateOf(box, id) {
    try { return JSON.parse(fs.readFileSync(path.join(box.state, id + '.json'), 'utf8')); } catch { return null; }
}

/** Run the hook once. */
function run({ input, box, env }) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        cwd: box.cwd,
        env: Object.assign({}, process.env, {
            AUTODEV_CONTEXT_NUDGE_STATE_DIR: box.state,
            CLAUDE_CONFIG_DIR: box.config,
            AUTODEV_CONTEXT_NUDGE: '',
            AUTODEV_CONTEXT_SOFT_LINE: '',
            AUTODEV_CONTEXT_NUDGE_TOKENS: '',
            AUTODEV_CONTEXT_NUDGE_STEP: '',
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
            CLAUDE_PLUGIN_OPTION_CONTEXT_NUDGE: '',
        }, env || {}),
    });
    return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

/** A Stop payload for a session at a depth, in the sandbox's cwd. */
function stop(box, id, depth, extra) {
    return Object.assign({
        session_id: id,
        cwd: box.cwd,
        hook_event_name: 'Stop',
        stop_hook_active: false,
        transcript_path: transcript([userRow('hi'), assistantRow(depth)]),
    }, extra || {});
}

function silentOk(r) {
    return r.out.length === 0 && r.err.length === 0 && r.status === 0;
}

/** The parsed block, or null if the hook did not block in the expected shape. */
function blocked(r) {
    if (r.status !== 0 || r.err.length !== 0) return null;
    try {
        const j = JSON.parse(r.out);
        return j && j.decision === 'block' && typeof j.reason === 'string'
            && typeof j.systemMessage === 'string' ? j : null;
    } catch {
        return null;
    }
}

// --- inert paths ----------------------------------------------------------
{
    const box = sandbox();
    const tx = transcript([userRow('hi'), assistantRow(402_578)]);

    const bad = run({ input: 'not json at all', box });
    check('unparseable stdin: silent, exit 0 rather than a crash', silentOk(bad),
        `exit=${bad.status} err=${bad.err.length}B`);
    check('  and no state directory is created', !fs.existsSync(box.state));

    const noTx = run({ input: { session_id: 's1' }, box });
    check('no transcript_path: silent', silentOk(noTx), `out=${noTx.out.length}B`);

    const noSession = run({ input: { transcript_path: tx }, box });
    check('no session_id: silent (no state key to throttle on)', silentOk(noSession),
        `out=${noSession.out.length}B`);

    const missing = run({ input: { session_id: 's1', transcript_path: path.join(os.tmpdir(), 'cdn-absent.jsonl') }, box });
    check('transcript file absent: silent', silentOk(missing), `out=${missing.out.length}B`);

    const shallow = run({ input: stop(box, 's1', 120_000), box });
    check('depth 120k, below the 250k soft line: silent', silentOk(shallow), `out=${shallow.out.length}B`);

    const justUnder = run({ input: stop(box, 's1', 249_999), box });
    check('depth 249,999: silent (the line is inclusive at 250,000)', silentOk(justUnder),
        `out=${justUnder.out.length}B`);

    const noUsage = run({ input: { session_id: 's1', transcript_path: transcript([userRow('hi'), userRow('again')]) }, box });
    check('no assistant row with usage: silent', silentOk(noUsage), `out=${noUsage.out.length}B`);

    const off = run({ input: stop(box, 's1', 402_578), box, env: { AUTODEV_CONTEXT_NUDGE: 'off' } });
    check('AUTODEV_CONTEXT_NUDGE=off: silent even at 402k', silentOk(off), `out=${off.out.length}B`);

    const optOff = run({ input: stop(box, 's1', 402_578), box, env: { CLAUDE_PLUGIN_OPTION_CONTEXT_NUDGE: 'false' } });
    check('plugin option context_nudge=false: silent even at 402k', silentOk(optOff), `out=${optOff.out.length}B`);

    // THE LOOP GUARD. A blocked Stop comes back with stop_hook_active set.
    const active = run({ input: stop(box, 's-active', 402_578, { stop_hook_active: true }), box });
    check('stop_hook_active=true: silent at 402k, so a block can never loop', silentOk(active),
        `out=${active.out.length}B`);
    check('  and it records nothing, so the next ordinary Stop still speaks', stateOf(box, 's-active') === null);
}

// --- the firing path, no window configured: the chip fallback -----------------
{
    const box = sandbox();
    const r = run({ input: stop(box, 's-fire-0001', 402_578), box });
    const j = blocked(r);
    check('depth 402,578 past the 250k line: blocks the Stop', !!j,
        `exit=${r.status} out=${r.out.slice(0, 80)}`);
    if (j) {
        const why = j.reason;
        check('the reason carries the exact depth', why.includes('402,578'), why.slice(0, 60));
        check('the reason names the 250k soft line', why.includes('250k SOFT LINE'), why.slice(0, 120));
        // The six RESUME fields, spelled HERE rather than read out of the hook,
        // because this list is the contract: a hook that silently drops one must go
        // red. session-exit.js renders the same six, pinned by test-session-exit.js.
        const FIELDS = ['goal', 'current state', 'files in flight', 'changes made',
            'failed attempts', 'next steps'];
        const lower = why.toLowerCase();
        for (const field of FIELDS) {
            check('the reason names the handoff field "' + field + '"',
                lower.includes(field), why.slice(0, 400));
        }
        const fieldsFrom = lower.indexOf('the six fields are');
        const at = FIELDS.map((f) => lower.indexOf(f, fieldsFrom));
        check('  and names them in the order session-exit.js renders them',
            fieldsFrom !== -1 && at.every((v, i) => v !== -1 && (i === 0 || v > at[i - 1])), JSON.stringify(at));
        check('  failed attempts must carry why each failed',
            /failed attempts, each with why it failed/.test(lower), why.slice(0, 400));
        check('  changes made must carry the command that verified each',
            /changes made, each with the command that verified it/.test(lower), why.slice(0, 400));
        // Finish first, then save, then stop: the order is the whole point of
        // saving at a natural break rather than mid-work.
        const finishAt = why.indexOf('Finish the unit of work');
        const saveAt = why.indexOf('session-exit.js" --out');
        check('the reason says finish the unit, then run session-exit.js --out',
            finishAt !== -1 && saveAt > finishAt, JSON.stringify({ finishAt, saveAt }));
        const handoff = path.join(box.cwd, '.claude', 'handoffs', 'RESUME-s-fire-0.md');
        check('  --out names this session\'s handoff under .claude/handoffs/ by absolute path',
            why.includes('--out "' + handoff + '"'), why.slice(saveAt - 20, saveAt + 200));
        check('  and says the path must be one git ignores', /git check-ignore/.test(why));
        // [stated 2026-09-21] With nothing to compact the context, the chip is
        // still the only way it gets shed.
        const chipAt = why.indexOf('spawn_task');
        const endAt = why.indexOf('end the turn');
        check('with no window configured, the reason orders a spawn_task continuation chip',
            chipAt !== -1 && /No auto-compact window is configured/.test(why), why.slice(0, 600));
        check('  before it says end the turn', chipAt !== -1 && endAt > chipAt, JSON.stringify({ chipAt, endAt }));
        check('  naming the handoff by ABSOLUTE path, since a fresh worktree lacks it',
            /names the handoff by ABSOLUTE path/.test(why));
        check('  and ending with the rule so the chain continues', /ends with this same rule/.test(why));
        check('no hookSpecificOutput: a Stop block speaks through reason', !('hookSpecificOutput' in j),
            Object.keys(j).join(','));
        check('the operator line is short and carries the depth',
            j.systemMessage.includes('403k') && j.systemMessage.length < 160, j.systemMessage);
        const st = stateOf(box, 's-fire-0001');
        // 402,578 - 250,000 = 152,578, three whole 50k bands past the line: bucket 3.
        check('the state file records bucket 3 (three 50k bands past the line)',
            st && st.bucket === 3 && st.depth === 402_578, JSON.stringify(st));
        const leftovers = fs.readdirSync(box.state).filter((n) => n.endsWith('.tmp'));
        check('  written by rename: no temp file is left behind', leftovers.length === 0, leftovers.join(','));
        check('  one file per session, named for the session',
            fs.readdirSync(box.state).join(',') === 's-fire-0001.json', fs.readdirSync(box.state).join(','));
    }

    const again = run({ input: stop(box, 's-fire-0001', 402_578), box });
    check('same session, same band: silent (blocked once, not every turn)', silentOk(again),
        `out=${again.out.length}B`);

    // Band 3 spans 400,000..449,999.
    const deeper = run({ input: stop(box, 's-fire-0001', 449_000), box });
    check('449k, still band 3: silent', silentOk(deeper), `out=${deeper.out.length}B`);

    const next = run({ input: stop(box, 's-fire-0001', 451_000), box });
    check('451k crosses into band 4: blocks again', !!blocked(next), `out=${next.out.slice(0, 60)}`);

    const other = run({ input: stop(box, 's-other', 402_578), box });
    check('another session in the same state directory: blocks on its own first crossing', !!blocked(other),
        `out=${other.out.slice(0, 60)}`);
    check('  and leaves the first session\'s state untouched',
        (stateOf(box, 's-fire-0001') || {}).bucket === 4, JSON.stringify(stateOf(box, 's-fire-0001')));
}

// --- the band re-arms after a compaction -------------------------------------
{
    const box = sandbox();
    const first = run({ input: stop(box, 's-cycle', 260_000), box });
    check('260k: blocks in band 0', !!blocked(first));
    const same = run({ input: stop(box, 's-cycle', 270_000), box });
    check('270k: silent, band 0 already spoken', silentOk(same));
    const compacted = run({ input: stop(box, 's-cycle', 40_000), box });
    check('40k after a compaction: silent', silentOk(compacted), `out=${compacted.out.length}B`);
    check('  and the state file is gone, so the next climb re-arms', stateOf(box, 's-cycle') === null);
    const climbed = run({ input: stop(box, 's-cycle', 262_000), box });
    check('262k on the next climb: blocks again, though band 0 was spoken before', !!blocked(climbed),
        `out=${climbed.out.slice(0, 60)}`);
}

// --- an auto-compact window changes the instruction ---------------------------
{
    const noChip = (j) => j && !j.reason.includes('spawn_task') && /Do not spawn a continuation chip/.test(j.reason);

    const box = sandbox();
    fs.writeFileSync(path.join(box.config, 'settings.json'), JSON.stringify({ autoCompactWindow: 320000 }));
    const r = run({ input: stop(box, 's-win', 262_000), box });
    const j = blocked(r);
    check('user settings autoCompactWindow 320000, depth 262k: blocks', !!j, r.out.slice(0, 80));
    check('  and orders NO chip, because compaction follows', noChip(j), j && j.reason.slice(-300));
    check('  it still says finish, save, then end the turn',
        !!j && /Finish the unit of work/.test(j.reason) && /Then end the turn/.test(j.reason));
    check('  the reason and the operator line name the 320k window',
        !!j && j.reason.includes('320k window') && j.systemMessage.includes('320k'), j && j.systemMessage);

    const envBox = sandbox();
    const e = blocked(run({ input: stop(envBox, 's-env', 262_000), box: envBox, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '320000' } }));
    check('CLAUDE_CODE_AUTO_COMPACT_WINDOW=320000 in the environment: no chip', noChip(e));

    const projBox = sandbox();
    fs.mkdirSync(path.join(projBox.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projBox.cwd, '.claude', 'settings.json'),
        JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '320000' } }));
    const p = blocked(run({ input: stop(projBox, 's-proj', 262_000), box: projBox }));
    check('project settings env.CLAUDE_CODE_AUTO_COMPACT_WINDOW: no chip', noChip(p));

    // A window the session is already past did not compact it: fall back.
    const pastBox = sandbox();
    fs.writeFileSync(path.join(pastBox.config, 'settings.json'), JSON.stringify({ autoCompactWindow: 320000 }));
    const past = blocked(run({ input: stop(pastBox, 's-past', 402_578), box: pastBox }));
    check('402k against a 320k window: compaction did not come, so the chip returns',
        !!past && past.reason.includes('spawn_task') && /already exceeded/.test(past.reason), past && past.reason.slice(-400));

    const junkBox = sandbox();
    fs.writeFileSync(path.join(junkBox.config, 'settings.json'), '{ not json');
    const junk = blocked(run({ input: stop(junkBox, 's-junk', 262_000), box: junkBox }));
    check('unparseable settings read as no window: the chip fallback, never a crash',
        !!junk && junk.reason.includes('spawn_task'));
}

// --- state it cannot trust means silence, and it is never overwritten ------------
{
    const box = sandbox();
    fs.mkdirSync(box.state, { recursive: true });
    const corrupt = path.join(box.state, 's-corrupt.json');
    fs.writeFileSync(corrupt, '{ this is not json');
    const r = run({ input: stop(box, 's-corrupt', 402_578), box });
    check('corrupt state file: silent, a block it cannot remember would repeat every turn', silentOk(r),
        `exit=${r.status} out=${r.out.length}B err=${r.err.length}B`);
    check('  and the corrupt file is left exactly as it was',
        fs.readFileSync(corrupt, 'utf8') === '{ this is not json');

    // The state directory is a FILE: the write fails, so the hook must not block.
    const blockedDir = sandbox();
    fs.writeFileSync(blockedDir.state, 'a file where the directory should be');
    const w = run({ input: stop(blockedDir, 's-nowrite', 402_578), box: blockedDir });
    check('state that cannot be written: silent rather than an unrememberable block', silentOk(w),
        `out=${w.out.length}B err=${w.err.length}B`);

    // A week-old file from another session is pruned on the next write.
    const pruneBox = sandbox();
    fs.mkdirSync(pruneBox.state, { recursive: true });
    const old = path.join(pruneBox.state, 's-old.json');
    fs.writeFileSync(old, JSON.stringify({ bucket: 0 }));
    const eightDays = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(old, eightDays, eightDays);
    const fresh = path.join(pruneBox.state, 's-fresh.json');
    fs.writeFileSync(fresh, JSON.stringify({ bucket: 0 }));
    run({ input: stop(pruneBox, 's-writer', 402_578), box: pruneBox });
    check('a state file older than a week is pruned on write', !fs.existsSync(old));
    check('  and a recent one from another session is kept', fs.existsSync(fresh));
}

// --- the latest row wins, and the tail read survives a big row -------------
{
    const box = sandbox();
    const compacted = transcript([userRow('hi'), assistantRow(402_578), userRow('more'), assistantRow(90_000)]);
    const r1 = run({ input: { session_id: 's-latest', cwd: box.cwd, transcript_path: compacted }, box });
    check('latest assistant row is 90k after an earlier 402k row: silent', silentOk(r1), `out=${r1.out.length}B`);

    // A 700KB attachment row AFTER the last assistant row, larger than one
    // 256KB read chunk: the backward scan must reach past it.
    const bigRow = JSON.stringify({ type: 'attachment', attachment: { type: 'tool_result', content: 'x'.repeat(700 * 1024) } });
    const withBig = transcript([userRow('hi'), assistantRow(402_578), bigRow, userRow('after')]);
    const r2 = run({ input: { session_id: 's-big', cwd: box.cwd, transcript_path: withBig }, box });
    check('usage row sits behind a 700KB row past the first chunk: still found, blocks', !!blocked(r2),
        `size=${fs.statSync(withBig).size}B out=${r2.out.slice(0, 40)}`);

    const truncated = transcript([userRow('hi'), assistantRow(402_578), '{"type":"assistant","message":{"usage":{"input_tokens":1']);
    const r3 = run({ input: { session_id: 's-trunc', cwd: box.cwd, transcript_path: truncated }, box });
    check('truncated final line: the previous usage row still decides, blocks', !!blocked(r3),
        `out=${r3.out.slice(0, 40)}`);

    const decoy = transcript([userRow('hi'), assistantRow(402_578), userRow('please check "usage" of the api')]);
    const r4 = run({ input: { session_id: 's-decoy', cwd: box.cwd, transcript_path: decoy }, box });
    check('a user row containing the word usage is not a depth reading', !!blocked(r4), `out=${r4.out.slice(0, 40)}`);
}

// --- the line is configurable, and a bad value falls back --------------------
{
    const box = sandbox();
    const lowLine = run({ input: stop(box, 's-cfg', 150_000), box, env: { AUTODEV_CONTEXT_SOFT_LINE: '100000' } });
    check('AUTODEV_CONTEXT_SOFT_LINE=100000: 150k blocks', !!blocked(lowLine), `out=${lowLine.out.slice(0, 40)}`);
    const legacy = run({ input: stop(box, 's-legacy', 150_000), box, env: { AUTODEV_CONTEXT_NUDGE_TOKENS: '100000' } });
    check('the legacy AUTODEV_CONTEXT_NUDGE_TOKENS is still read when the soft line is unset', !!blocked(legacy));
    const both = run({ input: stop(box, 's-both', 150_000), box,
        env: { AUTODEV_CONTEXT_SOFT_LINE: '200000', AUTODEV_CONTEXT_NUDGE_TOKENS: '100000' } });
    check('  and the soft line wins over it: 150k under a 200k line is silent', silentOk(both));
    const badLine = run({ input: stop(box, 's-cfg2', 150_000), box, env: { AUTODEV_CONTEXT_SOFT_LINE: 'lots' } });
    check('a non-numeric line falls back to 250k: 150k silent', silentOk(badLine), `out=${badLine.out.length}B`);
    const badFallback = run({ input: stop(box, 's-cfg3', 260_000), box, env: { AUTODEV_CONTEXT_SOFT_LINE: 'lots' } });
    check('  and 260k under that fallback blocks', !!blocked(badFallback));
}

// --- help ------------------------------------------------------------------
{
    const r = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8' });
    check('--help prints the contract and exits 0',
        r.status === 0 && /session-exit\.js --out/.test(r.stdout) && /AUTODEV_CONTEXT_SOFT_LINE/.test(r.stdout));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
console.log('subject: plugins/autodev-core/hooks/context-depth-nudge.js; '
    + (pass + fail) + ' cases over 10 inert paths including the stop_hook_active loop guard, '
    + 'the blocking path with a band throttle and a second session, re-arming after a '
    + 'compaction, the window-configured instruction from user, env and project settings, '
    + 'a window already exceeded, corrupt and unwritable state, pruning, latest-row-wins, '
    + 'a 700KB row past the first read chunk, a truncated final line, a decoy user row, '
    + 'and the configurable line. Every quiet case asserts zero bytes on BOTH streams.');
if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exit(1);
}
