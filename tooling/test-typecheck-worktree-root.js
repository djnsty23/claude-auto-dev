#!/usr/bin/env node
// Tests for the typecheck pair (hooks/post-tool-typecheck.js and
// hooks/stop-typecheck.js) when the session works in a git WORKTREE.
//
// A worker session is launched in a product's main checkout and edits files in
// a worktree of it. The main checkout has no node_modules; the worktree does.
// Both hooks resolved their project from process.cwd(), which is the main
// checkout, so the Stop check ran `npm run typecheck` there and blocked every
// turn on "Cannot find module" errors that do not exist where the edit was made.
//
// The fixture is a real git repo with a real worktree under
// .claude/worktrees/, and the "typecheck" is a script that require()s a
// dependency present only in the worktree's node_modules. So the wrong root
// produces a genuine module-not-found error, not a simulated one.
//
// Run: node tooling/test-typecheck-worktree-root.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOKS = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks');
const POST = path.join(HOOKS, 'post-tool-typecheck.js');
const STOP = path.join(HOOKS, 'stop-typecheck.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tcw-test-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

function git(cwd, ...args) {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
}

// The "typecheck": needs fixture-dep from node_modules, then fails on a planted
// error in src/app.ts the way tsc would.
const CHECK_JS = [
    "require('fixture-dep');",
    "const src = require('fs').readFileSync('src/app.ts', 'utf8');",
    "if (src.includes('PLANTED')) {",
    "  console.log(\"src/app.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'. PLANTED\");",
    '  process.exit(1);',
    '}',
].join('\n') + '\n';

let n = 0;
/** A main checkout without node_modules and a worktree of it, optionally with them. */
function fixture({ worktreeModules = true } = {}) {
    const main = path.join(TMP, 'repo' + ++n);
    fs.mkdirSync(path.join(main, 'src'), { recursive: true });
    fs.writeFileSync(path.join(main, 'package.json'),
        JSON.stringify({ name: 'fx', scripts: { typecheck: 'node check.js' } }));
    fs.writeFileSync(path.join(main, 'check.js'), CHECK_JS);
    fs.writeFileSync(path.join(main, 'src', 'app.ts'), 'export const a: number = 1;\n');
    fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules/\n.claude/\n');
    git(main, 'init', '-q');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    const wt = path.join(main, '.claude', 'worktrees', 'w');
    git(main, 'worktree', 'add', '-q', '-b', 'w', wt);
    if (worktreeModules) {
        const dep = path.join(wt, 'node_modules', 'fixture-dep');
        fs.mkdirSync(dep, { recursive: true });
        fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports = 1;\n');
    }
    return { main, wt };
}

/** Run a hook the way the harness does: process cwd is the launch checkout, payload cwd is the worktree. */
function run(hook, processCwd, payload) {
    const r = spawnSync(process.execPath, [hook], {
        input: JSON.stringify(payload), encoding: 'utf8', cwd: processCwd,
        env: { ...process.env, CLAUDE_PLUGIN_OPTION_TYPECHECK: '' },
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

/** One response: an edit of src/app.ts in the worktree, then Stop. */
function turn({ main, wt }, sid) {
    const file = path.join(wt, 'src', 'app.ts');
    const post = run(POST, main, {
        hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: sid, cwd: wt, tool_input: { file_path: file },
    });
    const listed = {
        wt: fs.existsSync(path.join(wt, '.claude', '.typecheck-pending')),
        main: fs.existsSync(path.join(main, '.claude', '.typecheck-pending')),
    };
    const stop = run(STOP, main, { hook_event_name: 'Stop', session_id: sid, cwd: wt, stop_hook_active: false });
    return { post, listed, stop };
}

const silent = (r) => r.status === 0 && r.stdout === '' && r.stderr === '';
const blocked = (r) => r.status === 0 && !!r.json && r.json.decision === 'block' && typeof r.json.reason === 'string';

// ---------------------------------------------------------------- the defect

{
    const fx = fixture();
    const { post, listed, stop } = turn(fx, 'clean');
    check('worktree with node_modules, clean code: the edit is recorded silently', silent(post));
    check('  in the worktree pending list, not the main checkout one', listed.wt && !listed.main);
    check('  and the Stop is silent (no module noise from the main checkout)', silent(stop));
    check('  and no Cannot-find-module text reaches the model', !/Cannot find module/.test(stop.stdout));
}

// ---------------------------------------------------------------- a real error still lands

{
    const fx = fixture();
    fs.writeFileSync(path.join(fx.wt, 'src', 'app.ts'), "export const a: number = 'PLANTED';\n");
    const { stop } = turn(fx, 'planted');
    check('a planted type error in the worktree blocks the stop', blocked(stop));
    check('  with the real error text', blocked(stop) && /TS2322/.test(stop.json.reason) && /PLANTED/.test(stop.json.reason));
    check('  and not module noise', blocked(stop) && !/Cannot find module/.test(stop.json.reason));
}

// ---------------------------------------------------------------- no node_modules: silence, not noise

{
    const fx = fixture({ worktreeModules: false });
    const { post, stop } = turn(fx, 'bare');
    check('worktree without node_modules: the edit is recorded silently', silent(post));
    check('  and the Stop says nothing rather than report missing modules', silent(stop));
    check('  and the list is consumed',
        !fs.existsSync(path.join(fx.wt, '.claude', '.typecheck-pending'))
        && !fs.existsSync(path.join(fx.main, '.claude', '.typecheck-pending')));
}

// ---------------------------------------------------------------- a subdirectory cwd

{
    const fx = fixture();
    fs.writeFileSync(path.join(fx.wt, 'src', 'app.ts'), "export const a: number = 'PLANTED';\n");
    const file = path.join(fx.wt, 'src', 'app.ts');
    const sub = path.join(fx.wt, 'src');
    run(POST, fx.main, { hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 's', cwd: sub, tool_input: { file_path: file } });
    const stop = run(STOP, fx.main, { hook_event_name: 'Stop', session_id: 's', cwd: sub, stop_hook_active: false });
    check('a cwd below the worktree root resolves to the worktree root', blocked(stop) && /PLANTED/.test(stop.json.reason));
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = fail > 0 ? 1 : 0;
