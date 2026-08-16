#!/usr/bin/env node
// Tests for autodev-core's SessionStart hook.
//
// The hook previously emitted plain stdout and did two things that could not
// work: it parsed .env.local into process.env (a hook cannot set environment
// variables for the session — the values died with the hook process, while it
// still printed "[Env] .env.local loaded"), and it rewrote the version number
// inside the user's own MEMORY.md. Both are asserted gone here.
//
// Run: node tooling/test-session-start-hook.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'session-start.js');
// Comments are stripped before the "no longer present" source assertions below:
// the hook deliberately documents what was removed and why, and a naive
// substring search would match that prose forever.
const HOOK_CODE = fs.readFileSync(HOOK, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstart-test-')));
const PROJ = path.join(TMP, 'proj');
fs.mkdirSync(PROJ, { recursive: true });

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

function run(payload, cwd = PROJ) {
    return spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HOME: TMP, USERPROFILE: TMP },
    });
}

function parse(r) {
    try { return JSON.parse(r.stdout); } catch { return null; }
}

// 1. No prd.json — banner only, still valid JSON.
let r = run({ cwd: PROJ, session_id: 's1', hook_event_name: 'SessionStart' });
let out = parse(r);
check('exits 0 with no prd.json', r.status === 0);
check('emits valid JSON', out !== null);
check('emits a version banner as systemMessage', /^\[Auto-Dev v/.test(out?.systemMessage || ''));
check('reports the real version, not a hardcoded fallback', !/v\?\]/.test(out?.systemMessage || ''));

// 2. With prd.json — sprint state goes to additionalContext, where Claude reads it.
fs.writeFileSync(path.join(PROJ, 'prd.json'), JSON.stringify({
    sprint: 'S3',
    stories: {
        'S3-001': { title: 'ship the thing', passes: true },
        'S3-002': { title: 'fix the bug', passes: null },
        'S3-003': { title: 'later', passes: 'deferred' },
    },
}));
r = run({ cwd: PROJ, session_id: 's2', hook_event_name: 'SessionStart' });
out = parse(r);
const ctx = out?.hookSpecificOutput?.additionalContext || '';
check('exits 0 with prd.json', r.status === 0);
check('additionalContext is used for sprint state', ctx.includes('Sprint S3'));
check('counts done correctly', ctx.includes('1 done'));
check('counts pending correctly', ctx.includes('1 pending'));
check('counts deferred separately from pending', ctx.includes('1 deferred'));
check('names the next pending story', ctx.includes('S3-002'));
check('banner still summarises for the user', (out?.systemMessage || '').includes('Sprint S3'));

// 3. Malformed prd.json is surfaced, not swallowed.
fs.writeFileSync(path.join(PROJ, 'prd.json'), '{ not valid json');
r = run({ cwd: PROJ, session_id: 's3', hook_event_name: 'SessionStart' });
out = parse(r);
check('exits 0 on malformed prd.json', r.status === 0);
check('reports the parse failure in context',
    (out?.hookSpecificOutput?.additionalContext || '').includes('failed to parse'));
fs.rmSync(path.join(PROJ, 'prd.json'));

// 4. The hook honours payload cwd over its own process cwd.
const OTHER = path.join(TMP, 'other');
fs.mkdirSync(OTHER, { recursive: true });
fs.writeFileSync(path.join(OTHER, 'prd.json'), JSON.stringify({ sprint: 'S9', stories: {} }));
r = run({ cwd: OTHER, session_id: 's4', hook_event_name: 'SessionStart' }, PROJ);
check('uses payload cwd, not process cwd', (parse(r)?.systemMessage || '').includes('Sprint S9'));

// 5. Regression: .env.local must not be read at all.
fs.writeFileSync(path.join(PROJ, '.env.local'), 'SECRET_TOKEN=sk_live_should_never_be_touched\n');
r = run({ cwd: PROJ, session_id: 's5', hook_event_name: 'SessionStart' });
const whole = (r.stdout || '') + (r.stderr || '');
check('does not claim to have loaded .env.local', !whole.includes('.env.local loaded'));
check('does not echo secrets from .env.local', !whole.includes('sk_live_should_never_be_touched'));
check('no .env.local parsing remains in the source', !HOOK_CODE.includes('.env.local'));

// 6. Regression: the user's MEMORY.md must not be rewritten.
const memDir = path.join(TMP, '.claude', 'projects', 'encoded-proj', 'memory');
fs.mkdirSync(memDir, { recursive: true });
const memFile = path.join(memDir, 'MEMORY.md');
const memBefore = '## Project: demo (v1.0)\n\nnotes\n';
fs.writeFileSync(memFile, memBefore);
run({ cwd: PROJ, session_id: 's6', hook_event_name: 'SessionStart' });
check('leaves MEMORY.md untouched', fs.readFileSync(memFile, 'utf8') === memBefore);
check('no MEMORY.md writing remains in the source', !HOOK_CODE.includes('MEMORY.md'));

// 7. Malformed stdin must never block a session from starting.
r = spawnSync(process.execPath, [HOOK], {
    input: 'not json', encoding: 'utf8', cwd: PROJ,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HOME: TMP, USERPROFILE: TMP },
});
check('malformed stdin → exit 0', r.status === 0);
check('malformed stdin → still valid JSON out', parse(r) !== null);

// ------------------------------------------------- gaps found by check:vacuity
//
// This hook runs at the start of every session and had the second-worst mutant
// survival rate in the repo (10/18 caught). Each case below is named with the
// line whose mutant survived.

// line 103 — `if (context.length > 0)`. Forced to `true`, the hook attaches a
// hookSpecificOutput carrying an EMPTY additionalContext. Every assertion still
// passed, because they all check what the context SAYS, never whether it should
// be there at all. An empty context block on every session is noise Claude has
// to read past.
{
    const bare = path.join(TMP, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    const out = parse(run({ cwd: bare, session_id: 'b', hook_event_name: 'SessionStart' }, bare));
    check('no context to give: no hookSpecificOutput at all',
        out !== null && out.hookSpecificOutput === undefined);
    check('  but the banner is still emitted', typeof out?.systemMessage === 'string');
}

// line 48 — `if (fs.existsSync(prdPath))`. Forced to `true` on a project with no
// prd.json, the hook falls into the parse branch and reports "prd.json exists
// but failed to parse" for a file that does not exist — telling the user to fix
// something that is not there.
{
    const bare2 = path.join(TMP, 'bare2');
    fs.mkdirSync(bare2, { recursive: true });
    const out = parse(run({ cwd: bare2, session_id: 'b2', hook_event_name: 'SessionStart' }, bare2));
    const ctx = out?.hookSpecificOutput?.additionalContext || '';
    check('no prd.json: says nothing about prd.json', !/prd\.json/.test(ctx));
}

// lines 62/63 — the "next pending stories" line, and the untitled fallback.
{
    const proj = path.join(TMP, 'stories');
    fs.mkdirSync(proj, { recursive: true });

    // All done: there is no next story, so the line must be absent entirely.
    fs.writeFileSync(path.join(proj, 'prd.json'), JSON.stringify({
        sprint: '1', stories: { 'S1-001': { title: 'a', passes: true } },
    }));
    let ctx = parse(run({ cwd: proj, session_id: 'x', hook_event_name: 'SessionStart' }, proj))
        ?.hookSpecificOutput?.additionalContext || '';
    check('nothing pending: no "next pending stories" line', !/Next pending stories/.test(ctx));

    // A pending story with no title must read "untitled"; one with a title must
    // read its title. `s.title || 'untitled'` flipped to `&&` inverts both, and
    // testing only one of them cannot see it.
    fs.writeFileSync(path.join(proj, 'prd.json'), JSON.stringify({
        sprint: '1',
        stories: {
            'S1-001': { title: 'has a title', passes: null },
            'S1-002': { passes: null },
        },
    }));
    ctx = parse(run({ cwd: proj, session_id: 'y', hook_event_name: 'SessionStart' }, proj))
        ?.hookSpecificOutput?.additionalContext || '';
    check('a titled story shows its title', /S1-001 \(has a title\)/.test(ctx));
    check('an untitled story shows "untitled"', /S1-002 \(untitled\)/.test(ctx));
}

// lines 79/81 — the uncommitted-changes line. Both directions of the `if` and
// the singular/plural choice survived: the whole git branch was untested,
// because every fixture directory happened not to be a git repo.
{
    const repo = path.join(TMP, 'gitrepo');
    fs.mkdirSync(repo, { recursive: true });
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');

    // Clean tree → the line must be absent.
    let ctx = parse(run({ cwd: repo, session_id: 'g0', hook_event_name: 'SessionStart' }, repo))
        ?.hookSpecificOutput?.additionalContext || '';
    check('clean tree: no uncommitted-changes line', !/uncommitted change/.test(ctx));

    // Exactly one change → singular.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    ctx = parse(run({ cwd: repo, session_id: 'g1', hook_event_name: 'SessionStart' }, repo))
        ?.hookSpecificOutput?.additionalContext || '';
    check('one change: reports it, in the singular', /1 uncommitted change at/.test(ctx));

    // Two changes → plural. Without both cases the `changes === 1` ternary can be
    // inverted without any assertion noticing.
    fs.writeFileSync(path.join(repo, 'b.txt'), 'y');
    ctx = parse(run({ cwd: repo, session_id: 'g2', hook_event_name: 'SessionStart' }, repo))
        ?.hookSpecificOutput?.additionalContext || '';
    check('two changes: reports them, in the plural', /2 uncommitted changes at/.test(ctx));
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
