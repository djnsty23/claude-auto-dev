#!/usr/bin/env node
'use strict';
// Suite for fleet-brief.js and its injection through session-start.js.
//
// The brief lands in EVERY session's context on EVERY start, so the cases that
// matter are the ones where it must say NOTHING: absent, expired, undated,
// unparseable. A brief that outlives its window is the panel-deny incident again
// in a channel nobody can see — five denies stood 26 hours because nothing on
// disk said when they were meant to stop.
//
// CLAUDE_CONFIG_DIR is the seam. The developer's own fleet directory is never
// read or written.
//
// Run: node tooling/test-fleet-brief.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
const SUBJECT = path.join(PLUGIN_ROOT, 'scripts', 'fleet-brief.js');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'session-start.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-brief-'));
const CFG = path.join(ROOT, 'config');
const BRIEF = path.join(CFG, 'fleet', 'BRIEF.json');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 300) : ''));
}

function cli(argv) {
    return spawnSync(process.execPath, [SUBJECT].concat(argv), {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: CFG }),
    });
}

// liveBrief() must be asked in a CHILD: it resolves CLAUDE_CONFIG_DIR at require
// time, so requiring it here would pin this suite to the developer's real config.
function live() {
    const code = 'const m=require(' + JSON.stringify(SUBJECT) + ');'
        + 'process.stdout.write(JSON.stringify(m.liveBrief()));';
    const r = spawnSync(process.execPath, ['-e', code], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: CFG }),
    });
    try { return JSON.parse(r.stdout); } catch { return { __unparsed: r.stdout, __err: r.stderr }; }
}

function writeRaw(obj) {
    fs.mkdirSync(path.dirname(BRIEF), { recursive: true });
    fs.writeFileSync(BRIEF, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');
}

const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

// ------------------------------------------------------------ the refusals

check('no --hours is refused', cli(['--set', 'x', '--author', 'a']).status === 2);
check('no --author is refused', cli(['--set', 'x', '--hours', '1']).status === 2);
check('--hours over the 24h cap is refused', cli(['--set', 'x', '--hours', '25', '--author', 'a']).status === 2);
{
    const r = cli(['--set', 'x'.repeat(4001), '--hours', '1', '--author', 'a']);
    check('over the size cap is refused', r.status === 2, r.stderr);
    // The reason has to be in the message: this cap is a tax on every session,
    // and a reader who does not know that will just raise it.
    check('and it says why the cap exists', /EVERY session/.test(r.stderr || ''), r.stderr);
}
check('an unreadable --set-file is refused',
    cli(['--set-file', path.join(ROOT, 'nope.md'), '--hours', '1', '--author', 'a']).status === 2);

// -------------------------------------------------------- the live/dead axis

check('absent brief is null', live() === null);

{
    const r = cli(['--set', 'standing rules here', '--hours', '2', '--author', 'Brain (suite)']);
    check('a valid brief is accepted', r.status === 0, r.stderr);
    const b = live();
    check('and reads back live', b && b.text === 'standing rules here', JSON.stringify(b));
    check('carrying its author', b && b.author === 'Brain (suite)');
    check('and an expiry', b && typeof b.expiresAt === 'string');
}

// THE CASE THE EXPIRY EXISTS FOR. Everything above passes for a brief that never
// dies; only this separates the two.
writeRaw({ setAt: new Date().toISOString(), expiresAt: hoursFromNow(-1), author: 'a', text: 'stale' });
check('an EXPIRED brief is null, not returned', live() === null);

writeRaw({ setAt: new Date().toISOString(), author: 'a', text: 'undated' });
check('a brief with NO expiry is treated as expired', live() === null);

writeRaw('{ not json');
check('an unparseable brief is null rather than a crash', live() === null);

writeRaw({ expiresAt: hoursFromNow(1), author: 'a', text: '   ' });
check('a whitespace-only brief is null', live() === null);

// The known-positive control: without it, every assertion above passes against a
// liveBrief() that simply always returns null.
writeRaw({ setAt: new Date().toISOString(), expiresAt: hoursFromNow(1), author: 'a', text: 'real' });
check('CONTROL: a live brief is still returned after all the null cases',
    (live() || {}).text === 'real');

check('--clear removes it', cli(['--clear']).status === 0 && live() === null);

// ------------------------------------------------- injection via session-start

function hookContext() {
    const proj = fs.mkdtempSync(path.join(ROOT, 'proj-'));
    const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ cwd: proj, session_id: 's', hook_event_name: 'SessionStart' }),
        encoding: 'utf8',
        cwd: proj,
        env: Object.assign({}, process.env, {
            CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: CFG,
            HOME: ROOT, USERPROFILE: ROOT,
        }),
    });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* null */ }
    return { r, ctx: (out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '', out };
}

{
    cli(['--set', 'Do not idle. Reversible decisions are yours.', '--hours', '2', '--author', 'Brain (suite)']);
    const { ctx, r } = hookContext();
    check('session-start injects a live brief', /FLEET BRIEF/.test(ctx), ctx.slice(0, 200) + r.stderr);
    check('the injected text is the brief', /Reversible decisions are yours/.test(ctx));
    check('it is signed', /Brain \(suite\)/.test(ctx));
    // The single most important line in the whole feature: a session must be able
    // to tell a peer's judgement from the operator's instruction, or it will
    // treat the first as something it may not refuse.
    check('it is labelled as NOT the operator', /NOT the operator/.test(ctx), ctx.slice(0, 300));
    check('the hook still exits 0', r.status === 0);
}

{
    cli(['--clear']);
    const { out, r } = hookContext();
    check('with no brief the hook adds NO context block at all',
        out && !('hookSpecificOutput' in out), JSON.stringify(out));
    check('and still emits its banner', out && /^\[Auto-Dev v/.test(out.systemMessage || ''));
    check('and writes nothing to stderr', (r.stderr || '') === '', r.stderr);
}

{
    // Expired must be silent through the HOOK too, not merely through liveBrief.
    writeRaw({ setAt: new Date().toISOString(), expiresAt: hoursFromNow(-1), author: 'a', text: 'stale' });
    const { ctx } = hookContext();
    check('an expired brief is NOT injected', !/FLEET BRIEF|stale/.test(ctx), ctx.slice(0, 200));
}

// -------------------------------------------------------------------- report

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`fleet-brief: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`fleet-brief: ${passed}/${total} passed — refusals, the expiry axis, and injection through session-start`);
