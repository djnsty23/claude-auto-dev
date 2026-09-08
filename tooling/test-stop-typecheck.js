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
function project({ scripts, pending, extraFiles = {} } = {}) {
    const dir = path.join(TMP, 'p' + ++n);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
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

// The block makes the model continue; its next Stop carries stop_hook_active.
// A check that STILL fails then is reported to the operator and let through,
// or a type error the model cannot fix would hold the turn forever.
{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir, { stopHookActive: true });
    check('a failure under stop_hook_active does not block again', r.status === 0 && r.json && r.json.decision === undefined);
    check('  but the operator is told', typeof r.json.systemMessage === 'string' && /still failing/.test(r.json.systemMessage));
    check('  in one line, not the whole error dump', !/TYPE_ERROR_MARKER/.test(r.json.systemMessage));
    check('  and the list is consumed', consumed(dir));
}

// Malformed stdin must not lose the check: the pending list is the evidence,
// the payload is only the retry flag.
{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir, { input: 'not json' });
    check('malformed stdin still runs the check and blocks', blocked(r));
}

// ---------------------------------------------------------------- profile

{
    const dir = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    const r = run(dir, { env: { CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE: 'minimal' } });
    check('hooks_profile=minimal: silent', silent(r));
    const on = project({ scripts: { typecheck: FAILING }, pending: ['src/app.ts'] });
    check('  control: hooks_profile=full blocks', blocked(run(on, { env: { CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE: 'full' } })));
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
