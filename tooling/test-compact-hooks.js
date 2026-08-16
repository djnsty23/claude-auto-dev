#!/usr/bin/env node
// Tests for the compaction pair: hooks/pre-compact.js and hooks/post-compact.js.
//
// Neither had any test. They are small — 18 and 38 lines — but they are the only
// thing carrying sprint state across a context compaction, and a compaction is
// precisely the moment nobody is watching. If pre-compact silently fails to save,
// post-compact happily points at a snapshot that is not there.
//
// Both resolve paths relative to cwd, so every case runs in a throwaway project.
//
// Run: node tooling/test-compact-hooks.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOKS = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks');
const PRE = path.join(HOOKS, 'pre-compact.js');
const POST = path.join(HOOKS, 'post-compact.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let n = 0;
function project(files = {}) {
    const dir = path.join(TMP, 'p' + ++n);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    return dir;
}

const run = (hook, dir) => {
    const r = spawnSync(process.execPath, [hook], {
        input: JSON.stringify({ hook_event_name: 'Compact', cwd: dir }),
        encoding: 'utf8',
        cwd: dir,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};

const SNAPSHOT = path.join('.claude', 'pre-compact-state.json');

// ---------------------------------------------------------------- pre-compact

// The whole point: the snapshot must exist afterwards, with the same content.
{
    const prd = JSON.stringify({ sprint: '3', stories: { 'S3-001': { passes: null } } });
    const dir = project({ 'prd.json': prd });
    const r = run(PRE, dir);
    const saved = path.join(dir, SNAPSHOT);
    check('pre-compact: exits 0', r.status === 0);
    check('pre-compact: writes the snapshot', fs.existsSync(saved));
    check('  with the prd.json content, byte for byte',
        fs.existsSync(saved) && fs.readFileSync(saved, 'utf8') === prd);
    check('  and says where it went', /pre-compact-state\.json/.test(r.stdout));
}

// No prd.json — nothing to save, and nothing to announce. A message claiming a
// save that did not happen is worse than silence, because post-compact's whole
// job is to trust it.
{
    const dir = project({});
    const r = run(PRE, dir);
    check('pre-compact: no prd.json — exits 0', r.status === 0);
    check('  writes no snapshot', !fs.existsSync(path.join(dir, SNAPSHOT)));
    // STDERR too. Forcing the existsSync guard to `true` sends copyFileSync at a
    // file that is not there; it throws ENOENT, the catch writes "pre-compact
    // error: ..." to stderr, and stdout stays empty either way. This is the third
    // place today where asserting stdout alone missed a mutant — the pattern is
    // general enough to assume rather than rediscover.
    check('  and stays silent', r.stdout === '' && r.stderr === '');
}

// It must overwrite a stale snapshot from an earlier compaction, or the second
// compaction of a session restores the first one's state.
{
    const dir = project({ 'prd.json': '{"sprint":"new"}', [SNAPSHOT]: '{"sprint":"old"}' });
    run(PRE, dir);
    check('pre-compact: overwrites a stale snapshot',
        fs.readFileSync(path.join(dir, SNAPSHOT), 'utf8') === '{"sprint":"new"}');
}

// --------------------------------------------------------------- post-compact

// With a snapshot present, it must point at the snapshot specifically.
{
    const dir = project({ 'prd.json': '{}', [SNAPSHOT]: '{}' });
    const r = run(POST, dir);
    check('post-compact: exits 0', r.status === 0);
    check('post-compact: points at the snapshot when one exists',
        /pre-compact-state\.json/.test(r.stdout));
    check('  and tells Claude what to look for in it', /passes: null/.test(r.stdout));
}

// With prd.json but NO snapshot — pre-compact never ran, or failed. It must fall
// back to prd.json rather than sending Claude to a file that is not there.
{
    const dir = project({ 'prd.json': '{}' });
    const r = run(POST, dir);
    check('post-compact: falls back to prd.json with no snapshot',
        /Re-read prd\.json/.test(r.stdout));
    check('  and does NOT point at a snapshot that does not exist',
        !/pre-compact-state\.json/.test(r.stdout));
}

// Neither file — say so plainly and ask, rather than inventing a next step.
{
    const dir = project({});
    const r = run(POST, dir);
    check('post-compact: no prd.json at all — asks the user',
        /No prd\.json in this directory/.test(r.stdout));
}

// Agent memory is mentioned only when it is actually there.
{
    const withMem = project({ 'prd.json': '{}', '.claude/agent-memory/notes.md': 'x' });
    const without = project({ 'prd.json': '{}' });
    check('post-compact: mentions agent-memory when present',
        /agent-memory/.test(run(POST, withMem).stdout));
    check('  and does not when absent',
        !/agent-memory/.test(run(POST, without).stdout));
}

// It always says something — this hook exists to re-orient after context loss,
// so silence is the one unacceptable outcome.
{
    const dir = project({});
    check('post-compact: always emits the header', /\[PostCompact\]/.test(run(POST, dir).stdout));
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
