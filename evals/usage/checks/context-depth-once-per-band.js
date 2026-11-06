'use strict';
// Case context-depth-once-per-band: the context-depth Stop hook costs one
// blocked Stop per 50k band, never one per turn.
//
// The class (usage-mine hook-block/checking-context-depth, 148 sessions and 397
// events since 2026-10-08, 2.7 per session) is by design: past the soft line the
// hook blocks once so the session saves its state before compaction. What a
// change must not do is make it block on every Stop, which turns a nudge into a
// tax on every turn of a deep session. This pins that cost.
//
// Drives the REAL context-depth-nudge.js of the tree under test with a scratch
// state dir and hand-written transcripts: Stop at 251k, Stop again at 251k, Stop
// at 301k, Stop at 120k (below the line).
//
// PASS: exactly the first and third Stops block.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function row(depth) {
    return JSON.stringify({ type: 'assistant', message: { id: `m${depth}`, role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: depth - 1100, output_tokens: 100 } } });
}

function check({ repo }) {
    const hook = path.join(repo, 'plugins', 'autodev-core', 'hooks', 'context-depth-nudge.js');
    if (!fs.existsSync(hook)) return { pass: false, indeterminate: true, detail: `no context-depth-nudge.js under ${repo}` };
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-eval-depth-')));
    try {
        const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, CLAUDE_CONFIG_DIR: path.join(scratch, '.claude'),
            AUTODEV_CONTEXT_NUDGE_STATE_DIR: path.join(scratch, 'state'), CLAUDE_CODE_AUTO_COMPACT_WINDOW: '320000' };
        for (const k of ['AUTODEV_CONTEXT_NUDGE', 'AUTODEV_CONTEXT_SOFT_LINE', 'AUTODEV_CONTEXT_NUDGE_TOKENS', 'AUTODEV_CONTEXT_NUDGE_STEP']) delete env[k];
        const transcript = path.join(scratch, 't.jsonl');
        const stop = (depth) => {
            fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }) + '\n' + row(depth) + '\n');
            const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ session_id: 'eval-depth', transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false, cwd: scratch }),
                encoding: 'utf8', env, timeout: 15000, windowsHide: true });
            return r.status === 2 || /"decision"\s*:\s*"block"/.test(r.stdout || '');
        };
        const got = [stop(251000), stop(251000), stop(301000), stop(120000)];
        const want = [true, false, true, false];
        if (!got[0] && !got[2]) return { pass: false, indeterminate: true, detail: 'the hook never blocked, not even at 251k: the fixture did not reach it (settings, env or payload)' };
        const same = got.every((g, i) => g === want[i]);
        return same
            ? { pass: true, detail: 'blocked at 251k, silent on the repeat, blocked at 301k, silent below the line' }
            : { pass: false, detail: `blocks per Stop were [${got.join(', ')}], want [${want.join(', ')}]` };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

module.exports = { check };
