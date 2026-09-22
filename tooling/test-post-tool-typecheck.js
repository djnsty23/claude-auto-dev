#!/usr/bin/env node
// Tests for autodev-core's PostToolUse hook: hooks/post-tool-typecheck.js.
//
// Since 2026-09-07 this hook is the ACCUMULATOR half of a pair: it records
// which JS/TS files a response edited, and hooks/stop-typecheck.js (tested by
// tooling/test-stop-typecheck.js) runs the project's typecheck and lint once
// over that list at Stop. Before that it ran both itself after every edit; the
// measurements behind the split are in docs/evidence-ecc-comparison-2026-09-07.md.
//
// The properties that matter here are about RESTRAINT and about the list being
// right. This hook fires after every Write and Edit, so the expensive mistakes
// are writing when it should not, speaking at all, and recording a path the
// Stop hook would then check for nothing.
//
// Everything below drives the real hook as a subprocess in a throwaway project
// directory, because the hook resolves package.json and its pending list
// relative to cwd.
//
// Run: node tooling/test-post-tool-typecheck.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'post-tool-typecheck.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-test-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let n = 0;
/** A throwaway project. `withPackage: false` leaves package.json out. */
function project({ withPackage = true } = {}) {
    const dir = path.join(TMP, 'p' + ++n);
    fs.mkdirSync(dir, { recursive: true });
    if (withPackage) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: {} }));
    return dir;
}

function run(dir, toolInput, { tool = 'Edit', input, env } = {}) {
    const payload = input !== undefined ? input : JSON.stringify({
        tool_name: tool,
        tool_input: toolInput,
        hook_event_name: 'PostToolUse',
    });
    const r = spawnSync(process.execPath, [HOOK], {
        input: payload, encoding: 'utf8', cwd: dir, env: { ...process.env, ...env },
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const PENDING = (dir) => path.join(dir, '.claude', '.typecheck-pending');
const pending = (dir) => {
    try { return fs.readFileSync(PENDING(dir), 'utf8').split('\n').filter(Boolean); } catch { return null; }
};
const silent = (r) => r.status === 0 && r.stdout === '' && r.stderr === '';

// ---------------------------------------------------------------- recording

{
    const dir = project();
    const r = run(dir, { file_path: 'src/app.ts' });
    check('a TS edit is recorded', silent(r) && pending(dir) !== null);
    check('  as an absolute path', (pending(dir) || [])[0] === path.join(dir, 'src', 'app.ts'));
    check('  and the hook says nothing on either stream', r.stdout === '' && r.stderr === '');
}

{
    const dir = project();
    const r = run(dir, { file_path: path.join(dir, 'lib', 'x.mjs') }, { tool: 'Write' });
    check('a Write counts the same as an Edit', silent(r) && (pending(dir) || [])[0] === path.join(dir, 'lib', 'x.mjs'));
}

// Two edits in one response are two lines. Deduplication is the Stop hook's
// job, so a path edited twice appears twice here, and the Stop suite asserts
// it is checked once.
{
    const dir = project();
    run(dir, { file_path: 'a.ts' });
    run(dir, { file_path: 'b.tsx' });
    run(dir, { file_path: 'a.ts' });
    const list = pending(dir) || [];
    check('every edit appends a line', list.length === 3);
    check('  in order, duplicates included', list[0].endsWith('a.ts') && list[1].endsWith('b.tsx') && list[2].endsWith('a.ts'));
}

// MultiEdit-shaped input: several files in one payload.
{
    const dir = project();
    const r = run(dir, { edits: [{ file_path: 'one.js' }, { file_path: 'two.jsx' }, { file_path: 'notes.md' }] });
    const list = pending(dir) || [];
    check('a MultiEdit payload records each JS/TS file', silent(r) && list.length === 2);
    check('  and skips the non-JS file inside it', !list.some((p) => p.endsWith('notes.md')));
}

// ---------------------------------------------------------------- restraint

{
    const dir = project();
    const r = run(dir, { file_path: 'README.md' });
    check('a non-TS/JS file is ignored entirely', silent(r) && pending(dir) === null);
    check('  and no .claude/ directory is created for it', !fs.existsSync(path.join(dir, '.claude')));
}

// A cwd with no package.json is not a project the Stop check can run in, and
// recording there would grow a .claude/ directory in every folder a JS file
// was ever edited from.
{
    const dir = project({ withPackage: false });
    const r = run(dir, { file_path: 'script.js' });
    check('no package.json: nothing recorded', silent(r) && pending(dir) === null);
    check('  and no .claude/ directory is created', !fs.existsSync(path.join(dir, '.claude')));
}

{
    const dir = project();
    const r = run(dir, null, { input: 'not json' });
    check('malformed stdin: exits 0 and silent', silent(r));
    check('  and records nothing', pending(dir) === null);
}

{
    const dir = project();
    const r = run(dir, { file_path: 42 });
    check('a non-string file_path is ignored, not thrown on', silent(r) && pending(dir) === null);
}

// ---------------------------------------------------------------- profile

// The `typecheck` switch set to false turns this hook off. The control is the
// same edit with the switch on, in a fresh project, so the case cannot pass on
// a hook that records nothing at all.
{
    const off = project();
    const r = run(off, { file_path: 'src/app.ts' }, { env: { CLAUDE_PLUGIN_OPTION_TYPECHECK: 'false' } });
    check('typecheck=false records nothing', silent(r) && pending(off) === null);
    const on = project();
    run(on, { file_path: 'src/app.ts' }, { env: { CLAUDE_PLUGIN_OPTION_TYPECHECK: 'true' } });
    check('  control: typecheck=true records', pending(on) !== null);
}

// ------------------------------------------------ F16: claiming the auto flag
//
// The model writes .claude/auto-active; this hook renames it to this session's
// key inside the same tool call, so a peer's Stop in the same directory can
// never see it first. It runs even with typecheck switched off.
{
    const claimRun = (dir, file, env) => spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
            tool_name: 'Write', hook_event_name: 'PostToolUse', session_id: 'sess-w', cwd: dir,
            tool_input: { file_path: path.join(dir, '.claude', file), content: '{}' },
        }),
        encoding: 'utf8', cwd: dir, env: { ...process.env, ...env },
    });
    for (const [label, env] of [['typecheck on', {}], ['typecheck=false', { CLAUDE_PLUGIN_OPTION_TYPECHECK: 'false' }]]) {
        const dir = project();
        fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.claude', 'auto-active'), '{}');
        const r = claimRun(dir, 'auto-active', env);
        check(`F16 (${label}): a written auto-active is claimed for the writing session`,
            fs.existsSync(path.join(dir, '.claude', 'auto-active.sess-w'))
            && !fs.existsSync(path.join(dir, '.claude', 'auto-active')));
        check(`  and the claim is silent`, r.status === 0 && (r.stdout || '') === '' && (r.stderr || '') === '');
    }
    const dir = project();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'auto-exit'), '');
    claimRun(dir, 'auto-exit', {});
    check('F16: a written auto-exit is claimed too', fs.existsSync(path.join(dir, '.claude', 'auto-exit.sess-w')));
    // Control: any other file under .claude is left exactly where it is.
    fs.writeFileSync(path.join(dir, '.claude', 'notes'), 'x');
    claimRun(dir, 'notes', {});
    check('  control: an unrelated .claude file is not renamed', fs.existsSync(path.join(dir, '.claude', 'notes')));
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
