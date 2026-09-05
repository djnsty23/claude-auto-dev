'use strict';
// Suite for plugins/autodev-core/hooks/peer-message-budget.js.
//
// The hook refuses the fourth peer message to one session inside an hour. It
// exists because that rule was written twice and broken twice: nine messages
// to one session on 2026-08-25, ten on 2026-09-05, by coordinators that had
// the rule in context. Prose does not enforce.
//
// Driven as a subprocess, the way the hook actually runs, against a synthetic
// transcript whose timestamps this suite controls. The limit and window are
// read OUT OF THE SUBJECT so the suite cannot drift from the thing it grades.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'peer-message-budget.js');
const { LIMIT, WINDOW_MIN, TOOL } = require(HOOK);

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

const TARGET = 'local_target-session-0000';
const OTHER = 'local_other-session-9999';

/** One transcript row holding one send_message tool_use, at `minutesAgo`. */
function sendRow(to, minutesAgo, text) {
    return JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.now() - minutesAgo * 60000).toISOString(),
        message: { content: [{ type: 'tool_use', name: TOOL, input: { session_id: to, message: text || 'x' } }] },
    });
}

function writeTranscript(rows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-budget-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, rows.join('\n') + '\n', 'utf8');
    return { dir, file };
}

function run(payload, env) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload), encoding: 'utf8',
        env: Object.assign({}, process.env, { AUTODEV_PEER_BUDGET: '' }, env || {}),
    });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function payloadFor(file, to, message) {
    return { tool_name: TOOL, tool_input: { session_id: to, message: message || 'hello' }, transcript_path: file };
}

const cleanups = [];
try {
    // ---- the limit itself, read from the subject ---------------------------
    check('LIMIT is a small positive integer read from the subject', Number.isInteger(LIMIT) && LIMIT >= 1 && LIMIT <= 10, String(LIMIT));
    check('WINDOW_MIN is read from the subject', Number.isInteger(WINDOW_MIN) && WINDOW_MIN > 0, String(WINDOW_MIN));

    // ---- at the limit: blocked -------------------------------------------
    {
        const rows = []; for (let i = 0; i < LIMIT; i++) rows.push(sendRow(TARGET, 5 + i));
        const t = writeTranscript(rows); cleanups.push(t.dir);
        const r = run(payloadFor(t.file, TARGET));
        check('the (LIMIT+1)th message to one session inside the window is BLOCKED', r.code === 2, 'exit ' + r.code);
        check('the block names the recipient', r.err.indexOf(TARGET) !== -1);
        check('the block names the count it measured', new RegExp('number ' + (LIMIT + 1) + ' ').test(r.err), r.err.slice(0, 80));
        check('the block prints the population it scanned', /population: \d+ peer message/.test(r.err));
        check('the block offers the repo as the alternative channel', /REPO/.test(r.err));
    }

    // ---- one under the limit: allowed, and SILENT ------------------------
    {
        const rows = []; for (let i = 0; i < LIMIT - 1; i++) rows.push(sendRow(TARGET, 5 + i));
        const t = writeTranscript(rows); cleanups.push(t.dir);
        const r = run(payloadFor(t.file, TARGET));
        check('one under the limit is allowed', r.code === 0, 'exit ' + r.code);
        check('an allowed send emits ZERO bytes on stdout', r.out === '', JSON.stringify(r.out.slice(0, 40)));
        check('an allowed send emits ZERO bytes on stderr', r.err === '', JSON.stringify(r.err.slice(0, 40)));
    }

    // ---- the window is real: old sends do not count -----------------------
    {
        const rows = []; for (let i = 0; i < LIMIT + 2; i++) rows.push(sendRow(TARGET, WINDOW_MIN + 5 + i));
        const t = writeTranscript(rows); cleanups.push(t.dir);
        const r = run(payloadFor(t.file, TARGET));
        check('sends older than the window are not counted', r.code === 0, 'exit ' + r.code);
    }

    // ---- per RECIPIENT, not global: a broadcast is not a relay -------------
    {
        const rows = []; for (let i = 0; i < LIMIT + 3; i++) rows.push(sendRow(OTHER, 2 + i));
        const t = writeTranscript(rows); cleanups.push(t.dir);
        const r = run(payloadFor(t.file, TARGET));
        check('many sends to a DIFFERENT session do not block this one', r.code === 0,
            'a broadcast to many is the half of coordination that measured well; exit ' + r.code);
    }

    // ---- the deliberate override --------------------------------------------
    {
        const rows = []; for (let i = 0; i < LIMIT; i++) rows.push(sendRow(TARGET, 3 + i));
        const t = writeTranscript(rows); cleanups.push(t.dir);
        const r = run(payloadFor(t.file, TARGET, 'urgent, OVERRIDE-BUDGET, one direction change'));
        check('OVERRIDE-BUDGET in the message allows the send', r.code === 0, 'exit ' + r.code);
    }

    // ---- fail OPEN, in every way the world can be surprising ---------------
    {
        const r = run(payloadFor('C:/definitely/not/a/transcript.jsonl', TARGET));
        check('an unreadable transcript allows the send (fails open)', r.code === 0, 'exit ' + r.code);
        check('and says nothing about it', r.out === '' && r.err === '');
    }
    {
        const rows = []; for (let i = 0; i < LIMIT; i++) rows.push(sendRow(TARGET, 3 + i));
        const t = writeTranscript(rows); cleanups.push(t.dir);
        const r = run({ tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: t.file });
        check('a different tool is ignored with zero output', r.code === 0 && r.out === '' && r.err === '');
        const r2 = run(payloadFor(t.file, TARGET), { AUTODEV_PEER_BUDGET: 'off' });
        check('AUTODEV_PEER_BUDGET=off disables the check', r2.code === 0, 'exit ' + r2.code);
        const r3 = spawnSync('node', [HOOK], { input: 'not json at all', encoding: 'utf8' });
        check('garbage stdin allows the send', r3.status === 0 && (r3.stderr || '') === '');
        const r4 = run({ tool_name: TOOL, tool_input: { message: 'no session id' }, transcript_path: t.file });
        check('a payload with no session_id is allowed', r4.code === 0);
    }

    // ---- a transcript with garbage lines still counts the good ones ------
    {
        const rows = [ 'this is not json', sendRow(TARGET, 4), '{"half":', sendRow(TARGET, 3), sendRow(TARGET, 2) ];
        const t = writeTranscript(rows); cleanups.push(t.dir);
        const r = run(payloadFor(t.file, TARGET));
        check('unparseable lines are skipped, parseable sends still count',
            LIMIT === 3 ? r.code === 2 : true, 'exit ' + r.code + ' with LIMIT=' + LIMIT);
    }

    // ---- the tool name is exact, proved BEHAVIOURALLY ----------------------
    //
    // A source-text assertion here was vacuous: it read the constant's
    // definition, and a mutant that loosened the COMPARISON to a substring
    // survived it. So plant LIMIT sends from a different tool whose name
    // contains the same substring, and assert they do not count. Slack, email
    // and other message tools share the word and are not peer messages.
    {
        const rows = [];
        for (let i = 0; i < LIMIT + 1; i++) {
            rows.push(JSON.stringify({
                type: 'assistant',
                timestamp: new Date(Date.now() - (2 + i) * 60000).toISOString(),
                message: { content: [{ type: 'tool_use', name: 'mcp__slack__send_message', input: { session_id: TARGET, message: 'not a peer message' } }] },
            }));
        }
        const t = writeTranscript(rows); cleanups.push(t.dir);
        const r = run(payloadFor(t.file, TARGET));
        check('sends from a DIFFERENT tool sharing the substring do not count', r.code === 0,
            'a substring match would count Slack or email sends as peer messages; exit ' + r.code);
    }
    const src = fs.readFileSync(HOOK, 'utf8');
    check('the hook fails open on any thrown error', /catch \{ code = 0; \}/.test(src) || /catch\s*\{\s*code\s*=\s*0/.test(src));
} finally {
    for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
