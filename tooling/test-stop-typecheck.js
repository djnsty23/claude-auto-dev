#!/usr/bin/env node
// Tests for autodev-core's Stop hook: hooks/stop-typecheck.js.
//
// The consumer half of the pair started by hooks/post-tool-typecheck.js. It
// reads .claude/.typecheck-pending, runs the project's typecheck and lint once,
// and blocks the stop with the errors when either fails. The properties here:
// it is silent when there is nothing to do, it blocks EXACTLY once (a retry
// that still fails is reported, not re-blocked), and the list is consumed
// whatever happens.
//
// Everything drives the real hook as a subprocess in a throwaway project, with
// `node -e` scripts standing in for typecheck and lint so no toolchain is
// needed and the failure text is known.
//
// Run: node tooling/test-stop-typecheck.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'stop-typecheck.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stc-test-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let n = 0;
function project({ scripts, pending, extraFiles = {}, modules = true } = {}) {
    const dir = path.join(TMP, 'p' + ++n);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    // An installed project: the hook stays silent in a tree with no node_modules.
    if (modules) fs.mkdirSync(path.join(dir, 'node_modules'));
    if (scripts !== undefined) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts }));
    }
    if (pending !== undefined) {
        fs.writeFileSync(path.join(dir, '.claude', '.typecheck-pending'),
            pending.map((p) => path.join(dir, p)).join('\n') + '\n');
    }
    for (const [rel, body] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, rel), body);
    return dir;
}

function run(dir, { stopHookActive = false, input, env } = {}) {
    const payload = input !== undefined ? input : JSON.stringify({
        hook_event_name: 'Stop', session_id: 'x', cwd: dir, stop_hook_active: stopHookActive,
    });
    const r = spawnSync(process.execPath, [HOOK], {
        input: payload, encoding: 'utf8', cwd: dir, env: { ...process.env, ...env },
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

const silent = (r) => r.status === 0 && r.stdout === '' && r.stderr === '';
const consumed = (dir) => !fs.existsSync(path.join(dir, '.claude', '.typecheck-pending'));
const blocked = (r) => r.status === 0 && r.json && r.json.decision === 'block' && typeof r.json.reason === 'string';

const FAILING = 'node -e "console.log(\'TYPE_ERROR_MARKER\'); process.exit(1)"';
const PASSING = 'node -e "process.exit(0)"';

// Both halves must select the package, even from a nested cwd in a worktree.
{
    const root = project({ scripts: {} });
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: fixture\n');
    const pkg = path.join(root, 'packages', 'web');
    const sub = path.join(pkg, 'src');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(path.join(pkg, 'node_modules'));
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'web', scripts: { typecheck: FAILING } }));
    const post = path.join(path.dirname(HOOK), 'post-tool-typecheck.js');
    const r = spawnSync(process.execPath, [post], { cwd: root, encoding: 'utf8', input: JSON.stringify({
        cwd: sub, tool_input: { file_path: path.join(sub, 'app.ts') },
    }) });
    check('monorepo: PostToolUse records the edit in the nearest package', r.status === 0 &&
        fs.existsSync(path.join(pkg, '.claude', '.typecheck-pending')) && consumed(root));
    // Plant independently so Stop is tested even if the producer is broken.
    fs.mkdirSync(path.join(pkg, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(pkg, '.claude', '.typecheck-pending'), path.join(sub, 'app.ts') + '\n');
    const stop = run(sub);
    check('monorepo: Stop blocks on the package type error', blocked(stop) && /TYPE_ERROR_MARKER/.test(stop.json.reason));
    check('monorepo: Stop consumes the package pending list', consumed(pkg));
}

// ---------------------------------------------------------------- one root for both halves
// The two hooks share no module, so each carries a copy of the root resolver between
// `// <project-root>` sentinels. The copies must be the same text and must agree on every
// layout: a root that differs means Post records a list that Stop never reads.
const POST_HOOK = path.join(path.dirname(HOOK), 'post-tool-typecheck.js');
function resolverOf(file) {
    const m = /\/\/ <project-root>\r?\n([\s\S]*?)\r?\n\/\/ <\/project-root>/.exec(fs.readFileSync(file, 'utf8'));
    if (!m) return null;
    return { text: m[1], fns: new Function('fs', 'path', `${m[1]}\nreturn { projectRoot, gitBoundary };`)(fs, path) };
}
{
    const L = path.join(TMP, 'layouts');
    const mk = (rel, file, body) => { fs.mkdirSync(path.join(L, rel), { recursive: true }); if (file) fs.writeFileSync(path.join(L, rel, file), body); };
    mk('mono', 'package.json', '{"name":"mono","private":true}');
    mk('mono/.git');
    mk('mono/packages/web', 'package.json', '{"name":"web"}');
    mk('mono/packages/web/src');
    mk('outer', 'package.json', '{"name":"outer"}');
    mk('outer/wt', '.git', 'gitdir: fixture\n');
    mk('outer/wt', 'package.json', '{"name":"wt"}');
    mk('outer/wt/src');
    mk('loose', 'package.json', '{"name":"unrelated-ancestor"}');
    mk('loose/sub/dir');
    const layouts = [
        ['monorepo root cwd', 'mono', 'mono'],
        ['package cwd inside a monorepo', 'mono/packages/web/src', 'mono/packages/web'],
        ['worktree with a .git FILE', 'outer/wt/src', 'outer/wt'],
        ['no .git, unrelated ancestor package.json', 'loose/sub/dir', 'loose/sub/dir'],
    ];
    const post = resolverOf(POST_HOOK);
    const stop = resolverOf(HOOK);
    check('root parity: both hooks carry the <project-root> resolver', !!post && !!stop);
    check('root parity: the two copies are the same text', !!post && !!stop && post.text === stop.text);
    for (const [label, cwd, want] of layouts) {
        const a = post && post.fns.projectRoot(path.join(L, cwd));
        const b = stop && stop.fns.projectRoot(path.join(L, cwd));
        check(`root parity: ${label}: both resolve ${want}`, a === path.join(L, want) && b === a);
    }
    // The same no-.git case through the real hooks: Post records nothing, Stop reads only the cwd's list.
    const loose = path.join(L, 'loose', 'sub', 'dir');
    const pr = spawnSync(process.execPath, [POST_HOOK], { cwd: loose, encoding: 'utf8', input: JSON.stringify({
        cwd: loose, tool_input: { file_path: path.join(loose, 'app.ts') } }) });
    check('no .git: Post is silent and records nothing in an unrelated ancestor package',
        pr.status === 0 && !pr.stdout && !pr.stderr && !fs.existsSync(path.join(L, 'loose', '.claude', '.typecheck-pending')));
}

// ---------------------------------------------------------------- a hoisted workspace
// npm, pnpm and yarn workspaces install into the repo root. The package has no node_modules
// and no lockfile of its own, so both are looked for up to the `.git` boundary.
{
    const repo = path.join(TMP, 'hoisted');
    const web = path.join(repo, 'packages', 'web');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.mkdirSync(path.join(web, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'repo', private: true, workspaces: ['packages/*'] }));
    fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'web', scripts: { typecheck: FAILING } }));
    // A pnpm shim on PATH that names itself, so the block proves the root lockfile chose the manager.
    const bin = path.join(TMP, 'shim-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'pnpm.cmd'), '@echo PNPM_SHIM %*\r\n@exit /b 1\r\n');
    fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\necho PNPM_SHIM "$@"\nexit 1\n', { mode: 0o755 });
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const post = spawnSync(process.execPath, [POST_HOOK], { cwd: web, encoding: 'utf8', input: JSON.stringify({
        cwd: web, tool_input: { file_path: path.join(web, 'src', 'app.ts') } }) });
    check('hoisted: Post records the edit in the package', post.status === 0 && fs.existsSync(path.join(web, '.claude', '.typecheck-pending')));
    const stop = run(web, { env: { [pathKey]: bin + path.delimiter + process.env[pathKey] } });
    check('hoisted: Stop is not silent when node_modules sits at the repo root', !silent(stop));
    check('hoisted: Stop blocks, running the package script with the root lockfile manager',
        blocked(stop) && /PNPM_SHIM run typecheck/.test(stop.json.reason));
    check('hoisted: Stop consumes the package pending list', consumed(web));
}

// ---------------------------------------------------------------- silence

{
    const dir = project({ scripts: { typecheck: FAILING } });
    const r = run(dir);
    check('no pending list: zero bytes on both streams', silent(r));
}

{
    const dir = project({ scripts: { typecheck: PASSING }, pending: ['src/app.ts'] });
    const r = run(dir);
    check('a green typecheck: zero bytes on both streams', silent(r));
    check('  and the list is consumed', consumed(dir));
}

{
    const dir = project({ scripts: { build: PASSING }, pending: ['src/app.ts'] });
    const r = run(dir);
    check('no typecheck or lint script: silent', silent(r));
    check('  and the list is still consumed', consumed(dir));
}

{
    const dir = project({ pending: ['src/app.ts'] });
    const r = run(dir);
    check('pending but no package.json: silent', silent(r));
    check('  and the list is consumed', consumed(dir));
}

// A tree with no node_modules fails every import, and that is noise about the
// install, not about the edit. tooling/test-typecheck-worktree-root.js drives
// the real case: a worktree launched from a main checkout without them.
{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'], modules: false });
    const r = run(dir);
    check('no node_modules: silent even though typecheck would fail', silent(r));
    check('  and the list is consumed', consumed(dir));
}

{
    const dir = project({ scripts: { typecheck: FAILING }, pending: [] });
    fs.writeFileSync(path.join(dir, '.claude', '.typecheck-pending'), '\n\n');
    const r = run(dir);
    check('an empty list is silent', silent(r));
}

// ---------------------------------------------------------------- blocking

{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir);
    check('a failing typecheck blocks the stop', blocked(r));
    check('  and the reason is labelled', /\[TYPECHECK FAILED\]/.test(r.json && r.json.reason));
    check('  and carries the actual error text', /TYPE_ERROR_MARKER/.test(r.json && r.json.reason));
    check('  and names the edited file', /app\.ts/.test(r.json && r.json.reason));
    check('  and the list is consumed', consumed(dir));
    check('  and stderr stays empty', r.stderr === '');
}

// The stop hook exits 0 even when it blocks: the decision is the JSON, and a
// non-zero exit from a Stop hook is a different, cruder signal.
{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir);
    check('a block is exit 0 with a JSON decision, not a non-zero exit', r.status === 0 && blocked(r));
}

// Lint runs after typecheck and reports separately.
{
    const dir = project({ scripts: { typecheck: PASSING, lint: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir);
    check('a lint failure blocks on its own', blocked(r) && /\[LINT FAILED\]/.test(r.json.reason));
    check('  and typecheck is not blamed for it', !/\[TYPECHECK FAILED\]/.test(r.json.reason));
}

{
    const dir = project({ scripts: { lint: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir);
    check('lint runs even when there is no typecheck script', blocked(r) && /\[LINT FAILED\]/.test(r.json.reason));
}

// Long output is trimmed, or one noisy run floods the context it is meant to help.
{
    const many = 'node -e "for (let i=0;i<50;i++) console.log(\'lint-line-\'+i); process.exit(1)"';
    const dir = project({ scripts: { typecheck: PASSING, lint: many }, pending: ['src/app.ts'] });
    const r = run(dir);
    check('long lint output is trimmed', blocked(r) && /and 2\d more lines/.test(r.json.reason));
    check('  and the first lines survive', /lint-line-0\b/.test(r.json.reason));
    check('  and the last lines do not', !/lint-line-49/.test(r.json.reason));
}

{
    const many = 'node -e "for (let i=0;i<100;i++) console.log(\'tc-line-\'+i); process.exit(1)"';
    const dir = project({ scripts: { typecheck: many }, pending: ['src/app.ts'] });
    const r = run(dir);
    // npm's own "> p@ typecheck" preamble lines count toward the budget, so the
    // cut lands a few lines short of 80: assert a line lint would have cut and
    // the tail that neither budget keeps.
    check('long typecheck output is trimmed at a larger budget than lint', blocked(r) && /and \d+ more lines/.test(r.json.reason));
    check('  and line 60 survives where lint would have cut at 30', /tc-line-60\b/.test(r.json.reason));
    check('  and line 99 does not', !/tc-line-99\b/.test(r.json.reason));
}

// The list is deduplicated: a file edited three times is one file, and the
// check runs once, which is the entire point of batching.
{
    const counter = path.join(TMP, 'runs-' + (n + 1));
    // Single quotes around the path: the script itself sits inside the double
    // quotes of `node -e "..."` in package.json, which the shell reads first.
    // Forward slashes: on Windows the tmpdir path carries backslashes, which a
    // single-quoted JS string reads as escapes, and the counter file was then
    // written nowhere. `[measured 2026-09-08]` CI windows-latest: this one case
    // failed, the hook checker treated the failing suite as INDETERMINATE and
    // exited 2, and two more suites went red on that exit code.
    const counting = `node -e "require('fs').appendFileSync('${counter.replace(/\\/g, '/')}', 'x'); console.log('TYPE_ERROR_MARKER'); process.exit(1)"`;
    const dir = project({ scripts: { typecheck: counting }, pending: ['src/app.ts', 'src/app.ts', 'src/app.ts'] });
    const r = run(dir);
    check('three edits of one file are one file', blocked(r) && /\b1 file\(s\) edited/.test(r.json.reason));
    check('  and typecheck ran exactly once', fs.existsSync(counter) && fs.readFileSync(counter, 'utf8') === 'x');
}

// ---------------------------------------------------------------- one retry

// The block makes the model continue. A check that STILL fails on the next Stop
// is reported to the operator and let through, or a type error the model cannot
// fix would hold the turn forever. "This is the retry" is THIS hook's own
// per-session marker, not `stop_hook_active`: that bit is shared by every Stop
// hook, and stop-auto-check sets it on every auto turn, so reading it meant a
// FIRST failure during auto never blocked at all.
const repend = (dir) => fs.writeFileSync(path.join(dir, '.claude', '.typecheck-pending'), path.join(dir, 'src/app.ts') + '\n');
{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    check('the first failure blocks', blocked(run(dir)));
    repend(dir);
    const r = run(dir, { stopHookActive: true });
    check('the retry after our own block does not block again', r.status === 0 && r.json && r.json.decision === undefined);
    check('  but the operator is told', !!r.json && typeof r.json.systemMessage === 'string' && /still failing/.test(r.json.systemMessage));
    check('  in one line, not the whole error dump', !!r.json && !/TYPE_ERROR_MARKER/.test(r.json.systemMessage));
    check('  and the list is consumed', consumed(dir));
    repend(dir);
    check('  and the episode is over: the next failure blocks again', blocked(run(dir)));
}

// F11: another hook's block sets stop_hook_active. That is not our retry.
{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir, { stopHookActive: true });
    check('a FIRST failure under stop_hook_active (set by auto) still blocks', blocked(r));
}

// The marker is per session: a peer's block in the same directory is not ours.
{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    const payload = (sid) => JSON.stringify({ hook_event_name: 'Stop', session_id: sid, cwd: dir, stop_hook_active: false });
    check('session A blocks', blocked(run(dir, { input: payload('sess-a') })));
    repend(dir);
    check('session B, same directory, first failure: still blocks', blocked(run(dir, { input: payload('sess-b') })));
}

// A retry turn that edited nothing ends the episode, so a later failure blocks.
{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    check('blocks once', blocked(run(dir)));
    check('a retry Stop with nothing pending is silent', silent(run(dir, { stopHookActive: true })));
    repend(dir);
    check('  and the next failure blocks rather than reading as a retry', blocked(run(dir)));
}

// Malformed stdin must not lose the check: the pending list is the evidence,
// the payload is only the retry flag.
{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir, { input: 'not json' });
    check('malformed stdin still runs the check and blocks', blocked(r));
}

// ---------------------------------------------------------------- a peer's edit mid-consume
//
// The pending list is per directory, so every session in one checkout appends
// to it. A Stop that read the list and then deleted it also deleted any path a
// peer's PostToolUse appended in between, and that edit was never checked. The
// preload appends the peer's path right after the hook's own read, every run.
{
    const race = require('./race-interleave.js');
    const PRELOAD = race.preloadPath();
    const dir = project({ pending: ['src/app.ts'] });
    const shared = path.join(dir, '.claude', '.typecheck-pending');
    const record = path.join(TMP, 'planted-' + n + '.txt');
    const peer = path.join(dir, 'src', 'peer.ts');
    const r = spawnSync(process.execPath, ['--require', PRELOAD, HOOK], {
        input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'x', cwd: dir, stop_hook_active: false }),
        encoding: 'utf8', cwd: dir,
        env: { ...process.env, RACE_SPEC: race.spec([{ op: 'readFileSync', basename: '.typecheck-pending', prefix: true,
            appendTo: shared, text: peer + '\n', times: 1 }], record) },
    });
    const left = fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8').split('\n') : [];
    check('race: the Stop is silent (no package.json, so it only consumes)', r.status === 0 && !r.stdout && !r.stderr);
    check('race: the probe planted one peer edit', race.planted(record).length === 1);
    check('race: the peer edit appended mid-consume is still pending for the next Stop', left.includes(peer));
    check('race: this Stop consumed its own list', !left.includes(path.join(dir, 'src', 'app.ts')));
    check('race: no claim file is left behind',
        fs.readdirSync(path.join(dir, '.claude')).filter((f) => f.startsWith('.typecheck-pending.')).length === 0);
    try { fs.rmSync(path.dirname(PRELOAD), { recursive: true, force: true }); } catch { /* tmp */ }
}

// ---------------------------------------------------------------- profile

{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir, { env: { CLAUDE_PLUGIN_OPTION_TYPECHECK: 'false' } });
    check('typecheck=false: silent', silent(r));
    const on = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    check('  control: typecheck=true blocks', blocked(run(on, { env: { CLAUDE_PLUGIN_OPTION_TYPECHECK: 'true' } })));
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
