#!/usr/bin/env node
// Tests for autodev-core's PostToolUse hook: hooks/post-tool-typecheck.js.
//
// It had NO tests. 108 lines that run after every Write and Edit, shell out to
// `npm run typecheck` and a linter, and print their failures into Claude's
// context. Found by tooling/find-untested-hooks.js, which was itself written
// after a silence sweep tripped over the gap by accident.
//
// The properties that matter here are mostly about RESTRAINT. This hook fires
// constantly, so the expensive mistakes are running when it should not, and
// speaking when it has nothing to say — not failing to catch a type error.
//
// Everything below drives the real hook as a subprocess in a throwaway project
// directory, because the hook resolves package.json, lockfiles and its debounce
// stamp relative to cwd.
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
/** A throwaway project. `scripts` goes straight into package.json. */
function project({ scripts, lockfile, extraFiles = {} } = {}) {
    const dir = path.join(TMP, 'p' + ++n);
    fs.mkdirSync(dir, { recursive: true });
    if (scripts !== undefined) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts }));
    }
    if (lockfile) fs.writeFileSync(path.join(dir, lockfile), '');
    for (const [rel, body] of Object.entries(extraFiles)) {
        fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
}

function run(dir, filePath = 'src/app.ts', input) {
    const payload = input !== undefined ? input : JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
        hook_event_name: 'PostToolUse',
    });
    const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8', cwd: dir });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const stamped = (dir) => fs.existsSync(path.join(dir, '.claude', '.typecheck-stamp'));

// A script that always fails, printing a known marker. Uses this same node
// binary so the test does not depend on a shell.
const FAILING = 'node -e "console.log(\'TYPE_ERROR_MARKER\'); process.exit(1)"';
const PASSING = 'node -e "process.exit(0)"';

// ---------------------------------------------------------------- restraint

// A PostToolUse hook informs; it must never turn a tool call into a failure.
{
    const dir = project({ scripts: { typecheck: FAILING } });
    const r = run(dir);
    check('exits 0 even when typecheck fails', r.status === 0);
}

// Editing something that is not TypeScript or JavaScript must not shell out.
{
    const dir = project({ scripts: { typecheck: FAILING } });
    const r = run(dir, 'README.md');
    check('a non-TS/JS file is ignored entirely', r.stdout === '' && !stamped(dir));
}

// No package.json at all — nothing to run. STDERR is asserted too: the guard
// forced to `true` falls through to reading a file that is not there, and the
// parse-error branch writes "[Typecheck] package.json parse error" to stderr
// while stdout stays empty. Asserting stdout alone cannot see it.
{
    const dir = project({});
    const r = run(dir);
    check('no package.json: silent', r.stdout === '');
    check('  on stderr too', r.stderr === '');
}

// NOT TESTED, and the attempt is worth recording. Both `if (output.trim())`
// guards protect against a command that fails while printing nothing, and
// mutation shows both mutants surviving. Two tests were written for them and
// both FAILED — because the guard cannot be reached through this runner: the
// hook invokes `npm run <script>`, and npm writes its own "npm ERR!" block to
// stderr on any non-zero exit, so `output` is never empty. The guards are
// unreachable via npm rather than untested, and the tests were wrong, not the
// hook. Removed instead of weakened into something that passes.

// A project with no typecheck script must be left alone. "Zero config, zero
// noise" is the stated design, and the stamp file is the tell: writing one would
// mean the hook decided it had work to do.
{
    const dir = project({ scripts: { build: PASSING } });
    const r = run(dir);
    check('no typecheck script: silent', r.stdout === '');
    check('  and no debounce stamp is written', !stamped(dir));
}

// The case that fires on nearly every edit in a healthy repo: everything passes,
// so the hook must say NOTHING. Asserting "no failure banner" is not enough —
// any output at all is context Claude pays for on every single edit.
{
    const dir = project({ scripts: { typecheck: PASSING } });
    const r = run(dir);
    check('typecheck passes: writes nothing at all', r.stdout === '');
    check('  but it did run (stamp written)', stamped(dir));
}

// Malformed stdin must not crash a hook that runs after every tool call.
{
    const dir = project({ scripts: { typecheck: FAILING } });
    const r = run(dir, 'src/app.ts', 'not json');
    check('malformed stdin: exits 0', r.status === 0);
    check('  and is silent', r.stdout === '');
}

// ---------------------------------------------------------------- reporting

{
    const dir = project({ scripts: { typecheck: FAILING } });
    const r = run(dir);
    check('typecheck failure is announced', /\[TYPECHECK FAILED\]/.test(r.stdout));
    check('  and the actual error text is included', /TYPE_ERROR_MARKER/.test(r.stdout));
}

// Lint runs after typecheck and reports separately.
{
    const dir = project({ scripts: { typecheck: PASSING, lint: FAILING } });
    const r = run(dir);
    check('lint failure is announced separately', /\[LINT FAILED\]/.test(r.stdout));
    check('  and typecheck is not blamed for it', !/\[TYPECHECK FAILED\]/.test(r.stdout));
}

// Long lint output is trimmed, or one noisy lint run floods the context it is
// supposed to be helping.
{
    const many = 'node -e "for (let i=0;i<50;i++) console.log(\'lint-line-\'+i); process.exit(1)"';
    const dir = project({ scripts: { typecheck: PASSING, lint: many } });
    const r = run(dir);
    check('long lint output is trimmed', /and 2\d more lines/.test(r.stdout));
    check('  and the first lines survive', /lint-line-0/.test(r.stdout));
    check('  and the last lines do not', !/lint-line-49/.test(r.stdout));
}

// ---------------------------------------------------------------- debounce

// Two edits in quick succession must not run typecheck twice. Without this the
// hook shells out on every keystroke-sized edit.
{
    const dir = project({ scripts: { typecheck: FAILING } });
    const first = run(dir);
    const second = run(dir);
    check('first run reports', /\[TYPECHECK FAILED\]/.test(first.stdout));
    check('second run within 10s is debounced (silent)', second.stdout === '');
}

// An expired stamp must let it run again, or one early edit silences the hook
// for the rest of the session.
{
    const dir = project({ scripts: { typecheck: FAILING } });
    run(dir);
    const stamp = path.join(dir, '.claude', '.typecheck-stamp');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(stamp, old, old);
    const again = run(dir);
    check('an expired debounce stamp lets it run again', /\[TYPECHECK FAILED\]/.test(again.stdout));
}

// ------------------------------------------------------- deliberately untested
//
// The Biome/ESLint DETECTION branches (hasBiome, hasEslint, and the two
// `if (!lintCmd && ...)` fallbacks) have no test here, and mutation confirms it:
// six mutants on those lines survive.
//
// Exercising them means letting the hook run `npx biome check .` or
// `npx eslint .` with neither installed, which makes a network install happen
// inside the test suite. That is a worse property for this repo than the gap
// itself. Testing the decision without the execution needs the lint command to
// be injectable — the same shape as the backoff parameter added to a vendor
// retry helper elsewhere today — which is a change to the hook, not the test.
//
// Recorded rather than faked, and rather than left as an unexplained survivor
// count for the next reader to re-derive.

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
