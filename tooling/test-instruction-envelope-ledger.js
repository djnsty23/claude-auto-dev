#!/usr/bin/env node
'use strict';
// test-instruction-envelope-ledger.js: drives hooks/instruction-envelope.js as a subprocess
// against a fake config dir and reads back logs/instruction-envelope.jsonl.
//
// The scorecard's instruction-window grades fresh sessions on every profile from this ledger,
// so the row must carry the session id and the start's source, and its `inside` must follow
// the measured envelope. The hook stays silent when the profile is healthy, writes nothing
// for a payload with no session id, and rotates the live log into one `.1` segment.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(__dirname, '../plugins/autodev-core/hooks/instruction-envelope.js');
let ran = 0;
let failed = 0;
function check(name, cond, detail) {
    ran++;
    if (cond) { console.log(`ok ${name}`); return; }
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${String(detail).slice(0, 600)}` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-ledger-'));
const cfg = path.join(root, 'claude');
const log = path.join(cfg, 'logs', 'instruction-envelope.jsonl');
fs.mkdirSync(path.join(cfg, 'rules'), { recursive: true });
fs.writeFileSync(path.join(cfg, 'CLAUDE.md'), '# user\n');
fs.writeFileSync(path.join(cfg, 'rules', 'small.md'), 'one small rule\n');
const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: cfg };
delete env.CLAUDE_PLUGIN_ROOT;
delete env.CLAUDE_PLUGIN_OPTION_INSTRUCTION_ENVELOPE;
const run = (payload) => spawnSync(process.execPath, [HOOK], { env, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 30000 });
const rows = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

try {
    let r = run({ session_id: 'sess-fresh-1', source: 'startup', hook_event_name: 'SessionStart' });
    let rs = rows();
    check('a healthy fresh start exits 0 with zero stdout and stderr', r.status === 0 && r.stdout === '' && r.stderr === '', JSON.stringify(r));
    check('it appends one row naming the session, the source and an inside envelope',
        rs.length === 1 && rs[0].sessionId === 'sess-fresh-1' && rs[0].source === 'startup' && rs[0].inside === true
        && rs[0].budget === 32000 && rs[0].missing === 0 && rs[0].conflicts === 0 && Number.isFinite(Date.parse(rs[0].at)), JSON.stringify(rs));

    run({ session_id: 'sess-fresh-1', source: 'resume' });
    rs = rows();
    check('a resume is a row with source resume, so the reader can exclude it', rs.length === 2 && rs[1].source === 'resume', JSON.stringify(rs));

    r = run({ source: 'startup' });
    check('a payload with no session id writes no row', r.status === 0 && rows().length === 2, JSON.stringify(rows()));
    r = run('not json');
    check('an unparseable payload writes no row and stays silent', r.status === 0 && r.stdout === '' && rows().length === 2, r.stdout);

    // Push the rules over the 32000-byte default budget: the row must say outside, and the hook speaks.
    fs.writeFileSync(path.join(cfg, 'rules', 'big.md'), 'x'.repeat(33000));
    r = run({ session_id: 'sess-over', source: 'startup' });
    rs = rows();
    const last = rs[rs.length - 1];
    check('an over-budget profile records inside false with its rule bytes', last && last.sessionId === 'sess-over' && last.inside === false && last.rulesTotal > 32000, JSON.stringify(last));
    check('and the hook still reports the overrun as its one system message', /over the 32000 budget/.test(r.stdout), r.stdout);
    fs.rmSync(path.join(cfg, 'rules', 'big.md'));

    // A live log at the cap becomes the .1 segment, and the next start opens a fresh live log.
    fs.writeFileSync(log, fs.readFileSync(log, 'utf8') + `${JSON.stringify({ pad: 'y'.repeat(1024 * 1024) })}\n`);
    run({ session_id: 'sess-rotate', source: 'startup' });
    const seg = `${log}.1`;
    const segRows = fs.existsSync(seg) ? fs.readFileSync(seg, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    check('the start that crosses the cap rotates the log, keeping its own row in the segment',
        segRows.some((x) => x.sessionId === 'sess-rotate') && segRows.some((x) => x.sessionId === 'sess-fresh-1') && !fs.existsSync(log), `${segRows.length} rows, live ${fs.existsSync(log)}`);
    run({ session_id: 'sess-after', source: 'clear' });
    check('the next start writes a fresh live log', rows().length === 1 && rows()[0].sessionId === 'sess-after', JSON.stringify(rows()));

    const off = spawnSync(process.execPath, [HOOK], { env: { ...env, CLAUDE_PLUGIN_OPTION_INSTRUCTION_ENVELOPE: 'false' }, input: JSON.stringify({ session_id: 'sess-off', source: 'startup' }), encoding: 'utf8' });
    check('the instruction_envelope switch off writes nothing', off.status === 0 && !rows().some((x) => x.sessionId === 'sess-off'), JSON.stringify(rows()));
} catch (e) {
    failed++;
    console.log(`FAIL the suite crashed: ${e.stack || e}`);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\ninstruction-envelope ledger: ${ran - failed}/${ran} checks passed`);
process.exitCode = failed ? 1 : 0;
