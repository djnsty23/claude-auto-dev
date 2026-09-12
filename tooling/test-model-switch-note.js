#!/usr/bin/env node
// Suite for hooks/model-switch-note.js.
//
// Drives the hook as a SUBPROCESS with real stdin and, for the fallback path,
// a real transcript file, because a test handing it a parsed object would test
// this file's model of the harness rather than the hook.
//
// The fixture payload is the key set a real PreModelSwitch delivered
// [measured 2026-09-13, Claude Code 2.1.261, headless set_model haiku -> sonnet]:
// session_id, transcript_path, cwd, prompt_id, hook_event_name, from_model,
// to_model, requested_model, source, context_tokens, prompt_cache_warm,
// cache_ttl, estimated_cache_write_usd, pricing. That capture had
// context_tokens 0 (the child session could not authenticate, so no response
// preceded the switch), which is why the deep values below are fixtures.
//
// Two assertions matter most. Every quiet path emits ZERO BYTES on stdout AND
// stderr. And every speaking path emits `systemMessage` and nothing else: a
// `permissionDecision: allow` would skip the harness's own cache-miss confirm,
// so its absence is asserted on paths that DO speak, where it could appear.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'model-switch-note.js');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'msn-'));
const ABSENT = path.join(TMP, 'absent.jsonl');

function payload(over) {
    return Object.assign({
        session_id: '6b01fa16-0000-4000-8000-000000000000',
        transcript_path: ABSENT,
        cwd: TMP,
        prompt_id: '8c69895d-0000-4000-8000-000000000000',
        hook_event_name: 'PreModelSwitch',
        from_model: 'claude-opus-5',
        to_model: 'claude-sonnet-5',
        requested_model: 'sonnet',
        source: 'command',
        context_tokens: 412_345,
        prompt_cache_warm: true,
        cache_ttl: '1h',
        estimated_cache_write_usd: 0,
        pricing: 'catalog',
    }, over);
}

function without(obj, key) {
    const copy = Object.assign({}, obj);
    delete copy[key];
    return copy;
}

function run(input, env) {
    const base = Object.assign({}, process.env);
    for (const k of ['AUTODEV_MODEL_SWITCH_NOTE', 'AUTODEV_MODEL_SWITCH_NOTE_TOKENS',
        'CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE', 'CLAUDE_PLUGIN_OPTION_hooks_profile']) delete base[k];
    const r = spawnSync(process.execPath, [HOOK], {
        input: typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        env: Object.assign(base, env || {}),
    });
    return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

function silentOk(r) {
    return r.out.length === 0 && r.err.length === 0 && r.status === 0;
}

/** The parsed output when the hook spoke in exactly the advisory shape, else null. */
function spoke(r) {
    if (r.status !== 0 || r.err.length !== 0) return null;
    try {
        const j = JSON.parse(r.out);
        return j && typeof j.systemMessage === 'string' && j.systemMessage.length > 0 ? j : null;
    } catch {
        return null;
    }
}

function transcript(rows) {
    const p = path.join(fs.mkdtempSync(path.join(TMP, 'tx-')), 's.jsonl');
    fs.writeFileSync(p, rows.join('\n') + '\n');
    return p;
}

function assistantRow(depth) {
    const input = 32;
    const creation = 814;
    const output = 154;
    return JSON.stringify({
        type: 'assistant',
        message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
                input_tokens: input,
                cache_creation_input_tokens: creation,
                cache_read_input_tokens: Math.max(0, depth - input - creation - output),
                output_tokens: output,
            },
        },
    });
}

function userRow(text) {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

// --- quiet paths --------------------------------------------------------------
{
    const bad = run('not json at all');
    check('unparseable stdin: silent, exit 0', silentOk(bad), `exit=${bad.status} err=${bad.err.length}B`);

    const empty = run({});
    check('empty object: silent', silentOk(empty), `out=${empty.out.length}B`);

    const same = run(payload({ to_model: 'claude-opus-5' }));
    check('from_model equals to_model at 412k: silent', silentOk(same), `out=${same.out.length}B`);

    const noTo = run(without(payload(), 'to_model'));
    check('to_model absent: silent', silentOk(noTo), `out=${noTo.out.length}B`);

    const under = run(payload({ context_tokens: 99_999 }));
    check('context_tokens 99,999, under the 100k line: silent', silentOk(under), `out=${under.out.length}B`);

    const first = run(payload({ from_model: 'claude-fable-5-1', context_tokens: 0 }));
    check('context_tokens 0 (no response yet), leaving Fable 5.1: silent', silentOk(first), `out=${first.out.length}B`);

    const cold = run(payload({ prompt_cache_warm: false }));
    check('cold cache, no Fable involved, 412k: silent (a cold cache loses nothing)', silentOk(cold),
        `out=${cold.out.length}B`);

    const post = run(payload({ hook_event_name: 'PostModelSwitch' }));
    check('hook_event_name PostModelSwitch: silent (the switch already happened)', silentOk(post),
        `out=${post.out.length}B`);

    const off = run(payload(), { AUTODEV_MODEL_SWITCH_NOTE: 'off' });
    check('AUTODEV_MODEL_SWITCH_NOTE=off: silent at 412k', silentOk(off), `out=${off.out.length}B`);

    const minimal = run(payload(), { CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE: 'minimal' });
    check('hooks_profile minimal: silent at 412k', silentOk(minimal), `out=${minimal.out.length}B`);

    const noDepth = run(without(payload(), 'context_tokens'));
    check('no context_tokens and the transcript is absent: silent', silentOk(noDepth), `out=${noDepth.out.length}B`);

    const stringy = run(payload({ context_tokens: '412345' }));
    check('non-numeric context_tokens and no transcript: silent', silentOk(stringy), `out=${stringy.out.length}B`);

    const deepTx = transcript([userRow('hi'), assistantRow(500_000)]);
    const payloadWins = run(payload({ context_tokens: 50_000, transcript_path: deepTx }));
    check('context_tokens 50k beside a 500k transcript: the payload wins, silent', silentOk(payloadWins),
        `out=${payloadWins.out.length}B`);
}

// --- speaking paths -----------------------------------------------------------
{
    const r = run(payload());
    const j = spoke(r);
    check('opus to sonnet at 412,345, warm: speaks', !!j, `exit=${r.status} out=${r.out.slice(0, 80)}`);
    if (j) {
        check('  the output carries systemMessage and no other key', Object.keys(j).join(',') === 'systemMessage',
            Object.keys(j).join(','));
        check('  no permissionDecision anywhere (allow would skip the harness cache-miss confirm)',
            !r.out.includes('permissionDecision'));
        check('  no hookSpecificOutput (additionalContext is not in PreModelSwitch output schema)',
            !r.out.includes('hookSpecificOutput'));
        check('  names the depth and both models', /~412k/.test(j.systemMessage)
            && j.systemMessage.includes('claude-opus-5') && j.systemMessage.includes('claude-sonnet-5'), j.systemMessage);
        check('  says the new model re-reads it uncached', /uncached/.test(j.systemMessage), j.systemMessage);
        check('  says nothing about thinking blocks when Fable is not involved', !/thinking/i.test(j.systemMessage));
        check('  quotes no price', !/\$|usd/i.test(j.systemMessage), j.systemMessage);
        check('  is one line', r.out.trim().split('\n').length === 1);
    }

    const atLine = run(payload({ context_tokens: 100_000 }));
    check('context_tokens exactly 100,000: speaks (the line is inclusive)', !!spoke(atLine), `out=${atLine.out.slice(0, 60)}`);

    const leaveFable = spoke(run(payload({ from_model: 'claude-fable-5-1', to_model: 'claude-opus-5', context_tokens: 250_000 })));
    check('leaving Fable 5.1 at 250k, warm: names both the cache and the thinking blocks',
        !!leaveFable && /uncached/.test(leaveFable.systemMessage) && /thinking blocks are dropped/.test(leaveFable.systemMessage),
        leaveFable && leaveFable.systemMessage);

    const fableCold = spoke(run(payload({ from_model: 'claude-fable-5-1', to_model: 'claude-sonnet-5', prompt_cache_warm: false })));
    check('leaving Fable 5.1 with a cold cache: speaks about thinking only',
        !!fableCold && /thinking/.test(fableCold.systemMessage) && !/uncached/.test(fableCold.systemMessage),
        fableCold && fableCold.systemMessage);

    const fableVariant = spoke(run(payload({ from_model: 'claude-fable-5-1', to_model: 'claude-fable-5-1[1m]' })));
    check('Fable 5.1 to its [1m] variant: cache note, no thinking note',
        !!fableVariant && /uncached/.test(fableVariant.systemMessage) && !/thinking/.test(fableVariant.systemMessage),
        fableVariant && fableVariant.systemMessage);

    const toFable = spoke(run(payload({ from_model: 'claude-sonnet-5', to_model: 'claude-fable-5-1' })));
    check('switching TO Fable 5.1: cache note, no thinking note (nothing is dropped)',
        !!toFable && !/thinking/.test(toFable.systemMessage), toFable && toFable.systemMessage);

    const warmUnknown = spoke(run(without(payload(), 'prompt_cache_warm')));
    check('prompt_cache_warm absent: treated as warm, names the uncached re-read',
        !!warmUnknown && /uncached/.test(warmUnknown.systemMessage), warmUnknown && warmUnknown.systemMessage);
}

// --- transcript fallback, for a build that sends no context_tokens -------------
{
    const tx = transcript([userRow('hi'), assistantRow(250_000)]);
    const fb = spoke(run(without(payload({ transcript_path: tx }), 'context_tokens')));
    check('no context_tokens: depth read from the transcript, 250k speaks',
        !!fb && /~250k/.test(fb.systemMessage), fb && fb.systemMessage);

    const compacted = transcript([userRow('hi'), assistantRow(402_578), userRow('more'), assistantRow(60_000)]);
    const latest = run(without(payload({ transcript_path: compacted }), 'context_tokens'));
    check('transcript: the latest usage row (60k) wins over an earlier 402k: silent', silentOk(latest),
        `out=${latest.out.length}B`);

    const bigRow = JSON.stringify({ type: 'attachment', attachment: { type: 'tool_result', content: 'x'.repeat(700 * 1024) } });
    const big = transcript([userRow('hi'), assistantRow(250_000), bigRow, userRow('after')]);
    const past = spoke(run(without(payload({ transcript_path: big }), 'context_tokens')));
    check('transcript: a usage row behind a 700KB row past the first read chunk is still found',
        !!past, `size=${fs.statSync(big).size}B`);
}

// --- the line is configurable ---------------------------------------------------
{
    const high = run(payload({ context_tokens: 250_000 }), { AUTODEV_MODEL_SWITCH_NOTE_TOKENS: '300000' });
    check('AUTODEV_MODEL_SWITCH_NOTE_TOKENS=300000: 250k silent', silentOk(high), `out=${high.out.length}B`);
    const bad = run(payload({ context_tokens: 250_000 }), { AUTODEV_MODEL_SWITCH_NOTE_TOKENS: 'lots' });
    check('a non-numeric line falls back to 100k: 250k speaks', !!spoke(bad), `out=${bad.out.slice(0, 60)}`);
}

// --- help -------------------------------------------------------------------------
{
    const r = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8' });
    check('--help prints the contract and exits 0', r.status === 0 && /permissionDecision/.test(r.stdout));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup only */ }

console.log('');
console.log(`${pass} passed, ${fail} failed`);
console.log('subject: plugins/autodev-core/hooks/model-switch-note.js; ' + (pass + fail)
    + ' cases over 13 quiet paths (each asserting zero bytes on BOTH streams), the speaking '
    + 'shape with no permissionDecision and no hookSpecificOutput, the inclusive line, four '
    + 'Fable 5.1 direction cases, an absent cache flag, the transcript fallback with '
    + 'latest-row-wins and a 700KB row, a configurable line, and --help.');
if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exitCode = 1;
}
