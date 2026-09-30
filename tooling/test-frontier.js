#!/usr/bin/env node
'use strict';
/**
 * test-frontier.js: the frontier runner, driven end to end without a model token.
 *
 * A fixture source repo carries a release tag, a buggy parent, a fix with a
 * held-out test and a distinctive token, and a second "fix" whose held-out test
 * is green on the unfixed tree. A fake claude (the `.js` --claude-bin
 * convention headless-worker uses) prints the stream-json a real run prints and
 * does what FAKE_MODE says: fix, noop, cheat, hang, answer, leak. Every run goes
 * through run.js as a subprocess, then headless-worker start, its detached
 * supervisor and the fake, so exit codes and the env a worker sees are real.
 *
 * What it proves: the plant check drops a task that measures nothing; the
 * contamination check refuses a run and names the file; a missing token starts
 * nothing; the worker env holds one token under the name claude reads and no
 * other credential; held-out files beat a worker that edits the test; a billed
 * API key is a billed-api row; a timeout kills the tree; finish is idempotent;
 * locate and review grading; the budget guard stops a batch; a row records the
 * machine load it ran under; and the frontier's Pareto sets, with wall time
 * read from quiet rows only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RUN = path.resolve(__dirname, 'frontier', 'run.js');
const FRONTIER = path.resolve(__dirname, 'frontier', 'frontier.js');
const R = require(RUN);
const F = require(FRONTIER);

// Real path: on macOS the tmpdir is /var/folders, a worker's process.cwd() reads
// /private/var/folders, and case 42 compares the two.
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'frontier test-')));
const SRC = path.join(ROOT, 'src');
const TASKS = path.join(ROOT, 'tasks');
const DATA = path.join(ROOT, 'data');
const WORK = path.join(ROOT, 'work');
const HOME = path.join(ROOT, 'claude home');
const FAKE = path.join(ROOT, 'fake claude.js');
const OUT = path.join(ROOT, 'out');
const TOKEN = 'tok-fixture-value-7731';
// Process tables for the load record: a real read costs a PowerShell start per
// sample, and the rows need a known answer.
const QUIET_PS = path.join(ROOT, 'ps quiet.tsv');
const LOADED_PS = path.join(ROOT, 'ps loaded.tsv');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; process.stdout.write(`  ok   ${label}\n`); }
    else { fail++; process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : `\n       ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}`}\n`); }
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const git = (args, cwd = SRC) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
};

// ---------------------------------------------------------------- fixtures
function buildSource() {
    fs.mkdirSync(SRC, { recursive: true });
    git(['init', '-q']);
    git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.autocrlf', 'false']);
    write(path.join(SRC, 'CLAUDE.md'), '# fixture repo\n');
    write(path.join(SRC, 'plugins/autodev-core/.claude-plugin/plugin.json'), JSON.stringify({ name: 'autodev-core', version: '1.0.0' }) + '\n');
    write(path.join(SRC, 'plugins/autodev-core/scripts/hello.js'), "console.log('hello');\n");
    write(path.join(SRC, 'plugins/autodev-memory/.claude-plugin/plugin.json'), JSON.stringify({ name: 'autodev-memory', version: '1.0.0' }) + '\n');
    write(path.join(SRC, 'lib/add.js'), 'module.exports = (a, b) => a - b;\n');
    write(path.join(SRC, 'tooling/test-other.js'), 'process.exitCode = 0;\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'release']); git(['tag', 'v1.0.0']);
    write(path.join(SRC, 'README.md'), 'readme\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'parent']);
    const parent = git(['rev-parse', 'HEAD']);
    write(path.join(SRC, 'lib/add.js'), 'const SAFE_SUM_GUARD = true;\nmodule.exports = (a, b) => (SAFE_SUM_GUARD ? a + b : 0);\n');
    write(path.join(SRC, 'tooling/test-add.js'), "const add = require('../lib/add');\nprocess.exitCode = add(2, 2) === 4 ? 0 : 1;\n");
    git(['add', '-A']); git(['commit', '-q', '-m', 'fix']);
    const fix = git(['rev-parse', 'HEAD']);
    write(path.join(SRC, 'tooling/test-trivial.js'), 'process.exitCode = 0; // TRIVIAL_MARKER_OK\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'green fix']);
    const greenFix = git(['rev-parse', 'HEAD']);
    return { parent, fix, greenFix };
}

function buildTasks(s) {
    const fixTask = (id, extra) => write(path.join(TASKS, `${id}.json`), JSON.stringify(Object.assign({
        id, lane: 'fix', size: 'S', parent: s.parent, fix: s.fix, brief: 'TX.md', heldOut: ['tooling/test-add.js'],
        checks: [['node', 'tooling/test-add.js']], passToPass: [['node', 'tooling/test-other.js']], disclosed: [], timeoutMin: 2,
    }, extra), null, 2));
    write(path.join(TASKS, 'TX.md'), 'add(2, 2) returns 0. It should return 4. The subject is lib/add.js.\n');
    fixTask('TX', {});
    fixTask('TH', { timeoutMin: 0.05 });
    fixTask('TG', { fix: s.greenFix, heldOut: ['tooling/test-trivial.js'], checks: [['node', 'tooling/test-trivial.js']] });
    write(path.join(TASKS, 'TL.md'), 'List the files. Write frontier-answer.json.\n');
    write(path.join(TASKS, 'TL.json'), JSON.stringify({ id: 'TL', lane: 'locate', size: 'S', parent: s.parent, brief: 'TL.md', answerFile: 'frontier-answer.json', expected: 'TL.answers.json', threshold: 0.8, timeoutMin: 2 }));
    write(path.join(TASKS, 'TL.answers.json'), JSON.stringify({ items: [{ path: 'lib/add.js' }, { path: 'tooling/test-other.js' }] }));
    write(path.join(TASKS, 'TR.md'), 'Review PLAN.md. Write frontier-answer.json.\n');
    write(path.join(TASKS, 'TR-plan.md'), '# plan\n## S1\nfine\n## S2\ntwo writers\n## S3\nmissing file\n');
    write(path.join(TASKS, 'TR.json'), JSON.stringify({ id: 'TR', lane: 'review', size: 'S', parent: s.parent, brief: 'TR.md', answerFile: 'frontier-answer.json', expected: 'TR.answers.json', support: [{ from: 'TR-plan.md', to: 'PLAN.md' }], timeoutMin: 2 }));
    const decideKey = (wrongChoice, extraAccept) => ({ questions: [
        { id: 'q1', kind: 'choice', accept: ['B'].concat(extraAccept || []), example: { choice: 'B' }, wrong: { choice: wrongChoice } },
        { id: 'q2', kind: 'order', items: ['#11', '#12', '#13'], before: [['#11', '#13']], example: { order: ['#12', '#11', '#13'] }, wrong: { order: ['#13', '#12', '#11'] } },
    ] });
    write(path.join(TASKS, 'TD.md'), 'Options: A merge now, B gate first, C ask. Order PRs #11, #12 and #13. Write frontier-answer.json.\n');
    for (const [id, key] of [['TD', decideKey('A')], ['TDW', decideKey('A', ['A'])], ['TDN', decideKey('Z')]]) {
        write(path.join(TASKS, `${id}.json`), JSON.stringify({ id, lane: 'decide', size: 'S', parent: s.parent, brief: 'TD.md', answerFile: 'frontier-answer.json', expected: `${id}.answers.json`, timeoutMin: 2 }));
        write(path.join(TASKS, `${id}.answers.json`), JSON.stringify(key));
    }
    // TM: the fix of TX under a brief that names its endpoint, so it routes mechanical.
    write(path.join(TASKS, 'TM.md'), 'Fix lib/add.js so that `node tooling/test-add.js` exits 0.\n');
    fixTask('TM', { brief: 'TM.md' });
    // TDG: a diagnosis of the same defect. TDL leaks a keyword group in its brief.
    const diagKey = { cause: { files: ['lib/add.js'], groups: [
        { id: 'op', match: ['subtract|minus|a - b'] }, { id: 'should', match: ['\\bplus\\b|addition|a \\+ b'] }] },
    examples: [
        { cause: { file: 'lib/add.js', mechanism: 'It returns a - b, a subtraction, where it should return a + b.' } },
        { cause: { file: './lib/add.js', mechanism: 'The function subtracts its second argument: minus where plus is meant.' } }],
    decoys: [
        { id: 'wrong-file', answer: { cause: { file: 'tooling/test-other.js', mechanism: 'It returns a - b, a subtraction, where it should return a + b.' } } },
        { id: 'wrong-mechanism', answer: { cause: { file: 'lib/add.js', mechanism: 'The arguments arrive as strings, so they are concatenated.' } } },
        { id: 'hedged', answer: { cause: { file: 'lib/add.js', mechanism: 'It returns a - b where it should return a + b, or perhaps the caller swaps the arguments.' } } }] };
    write(path.join(TASKS, 'TDG.answers.json'), JSON.stringify(diagKey));
    write(path.join(TASKS, 'TDG.md'), 'add(2, 2) returns 0 instead of 4. Find the cause. Do not fix it. Write frontier-answer.json.\n');
    write(path.join(TASKS, 'TDL.md'), 'add(2, 2) returns 0 because it computes a - b. Find the cause. Write frontier-answer.json.\n');
    for (const [id, brief] of [['TDG', 'TDG.md'], ['TDL', 'TDL.md']]) {
        write(path.join(TASKS, `${id}.json`), JSON.stringify({ id, lane: 'diagnose', size: 'S', parent: s.parent, fix: s.fix, brief, answerFile: 'frontier-answer.json', expected: 'TDG.answers.json', leakTerms: ['SIGNFLIP'], timeoutMin: 2 }));
    }
    // TP: a plan. TPT has a trap whose example trips nothing, so its key is refused.
    const planKey = (x2Example) => ({ threshold: 2, requirements: [
        { id: 'R1', text: ['held[- ]out'] }, { id: 'R2', text: ['git archive|one[- ]commit'] }, { id: 'R3', path: ['^tooling/'] }],
    traps: [{ id: 'X1', creates: '^plugins/' }, { id: 'X2', step: { all: ['worktree', 'parent'], none: ['git archive'] } }],
    examples: {
        right: [{ steps: [{ do: 'Build each task repo with git archive of the parent. Keep the tests held out.', creates: ['tooling/eval.js'] }] }],
        careless: { steps: [{ do: 'Open a worktree at the parent and run the model there.' }] },
        traps: {
            X1: { steps: [{ do: 'Build each task repo with git archive. Keep the tests held out.', creates: ['plugins/autodev-core/scripts/eval.js'] }] },
            X2: x2Example,
        } } });
    write(path.join(TASKS, 'TP.md'), 'Can the cheaper model do the work? Plan how to find out. Write frontier-answer.json.\n');
    write(path.join(TASKS, 'TP.answers.json'), JSON.stringify(planKey({ steps: [{ do: 'Open a worktree at the parent. Keep the tests held out.' }, { do: 'Run it.', creates: ['tooling/eval.js'] }] })));
    write(path.join(TASKS, 'TPT.answers.json'), JSON.stringify(planKey({ steps: [{ do: 'Build each repo with git archive of the parent in a worktree. Keep the tests held out.', creates: ['tooling/eval.js'] }] })));
    for (const id of ['TP', 'TPT']) {
        write(path.join(TASKS, `${id}.json`), JSON.stringify({ id, lane: 'plan', size: 'S', parent: s.parent, brief: 'TP.md', answerFile: 'frontier-answer.json', expected: `${id}.answers.json`, timeoutMin: 2 }));
    }
    // One broken key per refusal of the open-lane plant checks. Each must be
    // refused for exactly its own reason, so a removed check shows as a pass.
    const brokenDiag = {
        TDX1: [{ decoys: diagKey.decoys.concat([{ id: 'same', answer: diagKey.examples[0] }]) }, {}],
        TDX2: [{ examples: diagKey.examples.concat([{ cause: { file: 'lib/other.js', mechanism: diagKey.examples[0].cause.mechanism } }]) }, {}],
        TDX3: [{ decoys: diagKey.decoys.concat([{ id: 'gone', answer: { cause: { file: 'lib/missing.js', mechanism: 'It is missing.' } } }]) }, {}],
        TDX4: [{}, { leakTerms: ['module.exports'] }],
        TDX5: [{}, { leakTerms: undefined }],
        TDX6: [{ examples: diagKey.examples.slice(0, 1), decoys: diagKey.decoys.slice(0, 1) }, {}],
    };
    for (const [id, [keyPatch, taskPatch]] of Object.entries(brokenDiag)) {
        write(path.join(TASKS, `${id}.answers.json`), JSON.stringify(Object.assign({}, diagKey, keyPatch)));
        write(path.join(TASKS, `${id}.json`), JSON.stringify(Object.assign({ id, lane: 'diagnose', size: 'S', parent: s.parent, brief: 'TDG.md', answerFile: 'frontier-answer.json', expected: `${id}.answers.json`, leakTerms: ['SIGNFLIP'], timeoutMin: 2 }, taskPatch)));
    }
    const base = planKey({ steps: [{ do: 'Open a worktree at the parent. Keep the tests held out.' }, { do: 'Run it.', creates: ['tooling/eval.js'] }] });
    write(path.join(TASKS, 'TPX5.md'), 'Plan it with git archive. Write frontier-answer.json.\n');
    const brokenPlan = {
        TPX1: [{ threshold: 0 }, {}],
        TPX2: [{ examples: Object.assign({}, base.examples, { right: [base.examples.careless] }) }, {}],
        TPX3: [{ examples: Object.assign({}, base.examples, { careless: base.examples.right[0] }) }, {}],
        TPX4: [{ traps: [], examples: Object.assign({}, base.examples, { traps: {} }) }, {}],
        TPX5: [{}, { brief: 'TPX5.md' }],
        TPX6: [{}, { leakTerms: ['module.exports'] }],
        TPX7: [{ examples: Object.assign({}, base.examples, { right: [] }) }, {}],
        TPX8: [{ examples: { right: base.examples.right, traps: base.examples.traps } }, {}],
    };
    for (const [id, [keyPatch, taskPatch]] of Object.entries(brokenPlan)) {
        write(path.join(TASKS, `${id}.answers.json`), JSON.stringify(Object.assign({}, base, keyPatch)));
        write(path.join(TASKS, `${id}.json`), JSON.stringify(Object.assign({ id, lane: 'plan', size: 'S', parent: s.parent, brief: 'TP.md', answerFile: 'frontier-answer.json', expected: `${id}.answers.json`, timeoutMin: 2 }, taskPatch)));
    }
    write(path.join(TASKS, 'TR.answers.json'), JSON.stringify({ planted: [
        { id: 'race', section: 'S2', match: ['\\brace\\b', 'concurrent write'], example: 'Two writers race on the ledger with no lock.' },
        { id: 'open', section: 'S3', match: ['fails? open', 'missing file .*(pass|proceed)'], example: 'The check fails open when the file is missing.' },
    ] }));
}

function buildHome() {
    write(QUIET_PS, '1\t0\tSystem\n2\t1\tnode server.js\n');
    write(LOADED_PS, '1\t0\tSystem\n500\t1\tnode C:/code/peer-wt/tooling/test-all.js\n');
    write(path.join(HOME, 'CLAUDE.md'), '# global rules\n');
    write(path.join(HOME, 'rules/style.md'), 'Write plainly.\n');
    write(path.join(HOME, 'agents/scout.md'), '---\nname: scout\n---\n');
    write(path.join(HOME, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [] }, statusLine: { type: 'command' }, env: { X: '1' }, permissions: { allow: [] }, outputStyle: 'Concise', enabledPlugins: { a: true } }));
}

function buildFake() {
    write(FAKE, `'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const model = val('--model') || 'unset';
const byModel = process.env.FAKE_MODE_BY_MODEL ? JSON.parse(process.env.FAKE_MODE_BY_MODEL) : {};
const mode = byModel[model] || process.env.FAKE_MODE || 'noop';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const pdir = val('--plugin-dir');
let plugins = [];
try { plugins = fs.readdirSync(pdir).map((n) => ({ name: n, version: JSON.parse(fs.readFileSync(path.join(pdir, n, '.claude-plugin', 'plugin.json'), 'utf8')).version })); } catch {}
if (process.env.FAKE_OUT) {
    fs.mkdirSync(process.env.FAKE_OUT, { recursive: true });
    fs.writeFileSync(path.join(process.env.FAKE_OUT, 'seen-' + mode + '.json'), JSON.stringify({
        names: Object.keys(process.env).sort(), tokenDigest: process.env.CLAUDE_CODE_OAUTH_TOKEN ? require('crypto').createHash('sha256').update(process.env.CLAUDE_CODE_OAUTH_TOKEN).digest('hex') : null,
        configDir: process.env.CLAUDE_CONFIG_DIR || null, cwd: process.cwd(), argv: argv.filter((a, i) => argv[i - 1] !== '-p'), pid: process.pid }));
}
out({ type: 'system', subtype: 'init', model, apiKeySource: process.env.FAKE_API || 'none', claude_code_version: '9.9.9', permissionMode: val('--permission-mode'), plugins, tools: ['Read', 'Edit'], mcp_servers: [], output_style: 'default' });
out({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.05 }, seven_day: { utilization: Number(process.env.FAKE_7D || 0.1) } } } });
if (mode === 'fix') fs.writeFileSync('lib/add.js', 'module.exports = (a, b) => a + b;\\n');
if (mode === 'cheat') { fs.mkdirSync('tooling', { recursive: true }); fs.writeFileSync('tooling/test-add.js', 'process.exitCode = 0;\\n'); }
if (mode === 'answer') fs.writeFileSync('frontier-answer.json', process.env.FAKE_ANSWER || '');
if (mode === 'leak') out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:/Users/someone/.claude/memory/notes.md' } }] } });
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
out({ type: 'result', subtype: 'success', duration_ms: 1234, duration_api_ms: 1000, num_turns: 3, total_cost_usd: 0.5,
    modelUsage: { [model]: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, thinkingTokens: 5, costUSD: 0.5 } } });
`);
}

// ---------------------------------------------------------------- the runner as a subprocess
function envFor(extra = {}) {
    return Object.assign({}, process.env, {
        FRONTIER_SRC: SRC, FRONTIER_TASKS: TASKS, FRONTIER_DATA: DATA, FRONTIER_WORK: WORK, FRONTIER_CLAUDE_HOME: HOME, FRONTIER_CLAUDE_BIN: FAKE,
        FRONTIER_POLL_MS: '300', FAKE_OUT: OUT, FRONTIER_PROCESS_LIST: QUIET_PS, FRONTIER_MEMORY_STOP: ROOT,
        CLAUDE_CODE_OAUTH_TOKEN_TESTACCT: TOKEN, CLAUDE_CODE_OAUTH_TOKEN_OTHER: 'other-account-value', ANTHROPIC_API_KEY: 'must-not-reach-the-worker',
        ANTHROPIC_AUTH_TOKEN: 'nor-this', SOME_SECRET: 'nor-this-one', DOPPLER_PROJECT: 'accounts',
    }, extra);
}
function run(args, extra = {}, timeout = 120000) {
    const r = spawnSync(process.execPath, [RUN, ...args], { env: envFor(extra), encoding: 'utf8', windowsHide: true, timeout });
    let json = null;
    try { json = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { json = null; }
    return { exit: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
function startAndFinish(task, variant, mode, extra = {}, waitSec = 60) {
    const s = run(['run', '--task', task, '--variant', variant, '--account', 'testacct'], Object.assign({ FAKE_MODE: mode }, extra));
    if (!s.json || !s.json.ok) return { start: s, row: null };
    const f = run(['finish', '--run', s.json.value.run, '--wait-sec', String(waitSec)], extra, (waitSec + 60) * 1000);
    return { start: s, row: f.json && f.json.ok ? f.json.value : null, finish: f };
}
function rows() {
    try { return fs.readFileSync(path.join(DATA, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function pidAlive(pid) {
    if (process.platform === 'win32') {
        const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        return new RegExp(`"${pid}"`).test(r.stdout || '');
    }
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------------------------------------------------------------- cases
function unitCases() {
    process.stdout.write('units\n');
    check('1. CODEY keeps code-shaped tokens', ['SAFE_SUM_GUARD', 'raceState', 'not-lost', 'LIGHTWEIGHT', 'gitFailure2'].every(R.CODEY), ['SAFE_SUM_GUARD', 'raceState', 'not-lost', 'LIGHTWEIGHT'].map(R.CODEY));
    check('2. CODEY drops plain words', !['localises', 'Measured', 'settle'].some(R.CODEY));
    check('3. SCRUB_RE removes every credential shape and keeps ordinary names',
        ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN_PERSONAL', 'GITHUB_PAT', 'SOME_SECRET', 'DB_PASSWORD', 'DOPPLER_TOKEN', 'OPENAI_API_KEY', 'VERCEL_TOKEN'].every((n) => R.SCRUB_RE.test(n))
        && !['PATH', 'Path', 'HOME', 'USERPROFILE', 'TEMP', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR'].some((n) => R.SCRUB_RE.test(n)));
    const env = R.workerEnv({ PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN_PERSONAL: 'a', CLAUDE_CODE_OAUTH_TOKEN_WORK: 'b', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'stale' }, 'personal');
    check('4. workerEnv maps the account token to CLAUDE_CODE_OAUTH_TOKEN and drops the rest',
        env.CLAUDE_CODE_OAUTH_TOKEN === 'a' && !('CLAUDE_CODE_OAUTH_TOKEN_WORK' in env) && !('CLAUDE_CODE_OAUTH_TOKEN_PERSONAL' in env) && !('ANTHROPIC_API_KEY' in env) && env.AUTODEV_GATE_LOCK === '0' && env.PATH === 'p', Object.keys(env));
    let code = null;
    try { R.workerEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, 'personal'); } catch (e) { code = e.publicCode; }
    check('5. workerEnv refuses when the account variable is absent, even with a bare token present', code === 'token-missing', code);
    const t = R.tokensOf({ usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }, total_cost_usd: 0.1 });
    check('6. tokensOf falls back to usage when modelUsage is absent', t.total === 10 && t.costUsd === 0.1, t);
    const t2 = R.tokensOf({ modelUsage: { a: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, costUSD: 1 }, b: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, costUSD: 2 } } });
    check('7. tokensOf sums every model, subagents included', t2.total === 8 && t2.costUsd === 3 && Object.keys(t2.perModel).length === 2, t2);
    const own = 'F-29120000-T1-V0-1';
    const leaks = R.leakHits([
        JSON.stringify({ command: 'cat C:/Users/x/autodev-frontier/wt/F-29120000-T1-V0-1/lib/a.js' }),
        JSON.stringify({ command: 'cat C:/Users/x/autodev-frontier/wt/F-29120000-T1-V1-1/lib/a.js' }),
        JSON.stringify({ file_path: 'C:\\Users\\x\\.claude\\rules\\a.md' }),
        JSON.stringify({ command: 'ls ~/.claude-b/memory' }),
        JSON.stringify({ command: 'git -C C:/code/claude-auto-dev log' }),
        JSON.stringify({ file_path: 'C:/Users/x/autodev-frontier/wt/F-29120000-T1-V0-1/.claude/settings.json' }),
    ], own);
    check('8. leakHits flags another run, the live config and the source checkout, not the own run or its repo .claude dir', leaks.length === 4, leaks);
    const exp = { items: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }] };
    const g1 = R.gradeLocate({ items: [{ path: './a.js' }, { path: 'b.js' }, { path: 'c.js' }] }, exp, 0.8);
    const g2 = R.gradeLocate({ items: [{ path: 'a.js' }, { path: 'x.js' }] }, exp, 0.8);
    const g3 = R.gradeLocate({ items: [] }, exp, 0.8);
    check('9. gradeLocate: exact list F1 1 passes, half list fails, empty list F1 0', g1.f1 === 1 && g1.pass && g2.f1 === 0.4 && !g2.pass && g3.f1 === 0 && !g3.pass, [g1.f1, g2.f1, g3.f1]);
    const key = readJson(path.join(TASKS, 'TR.answers.json'));
    const perfect = R.gradeReview({ findings: R.plantedFindings(key) }, key);
    const oneShort = R.gradeReview({ findings: R.plantedFindings(key).slice(1) }, key);
    const invented = R.gradeReview({ findings: R.plantedFindings(key).concat([{ section: 'S1', severity: 'blocker', claim: 'The naming is inconsistent.' }]) }, key);
    const wrongSection = R.gradeReview({ findings: [{ section: 'S1', severity: 'blocker', claim: 'Two writers race on the ledger.' }, R.plantedFindings(key)[1]] }, key);
    const minor = R.gradeReview({ findings: R.plantedFindings(key).map((f) => Object.assign({}, f, { severity: 'minor' })) }, key);
    check('10. gradeReview: the examples pass, one missing fails, an invented blocker fails', perfect.pass && !oneShort.pass && invented.invented === 1 && !invented.pass, [perfect, oneShort.named, invented.invented]);
    check('11. gradeReview: the right claim in the wrong section is not named, and not invented either', !wrongSection.pass && wrongSection.named === 1 && wrongSection.invented === 0, wrongSection);
    check('12. gradeReview: a planted defect called minor is not named', minor.named === 0 && !minor.pass, minor.named);
    const dk = readJson(path.join(TASKS, 'TD.answers.json'));
    const dRight = R.gradeDecide({ answers: [{ id: 'q1', choice: 'B' }, { id: 'q2', order: ['#11', '#12', '#13'] }] }, dk);
    const dOrder = R.gradeDecide({ answers: [{ id: 'q1', choice: 'B' }, { id: 'q2', order: ['#13', '#11', '#12'] }] }, dk);
    const dDup = R.gradeDecide({ answers: [{ id: 'q1', choice: 'B' }, { id: 'q2', order: ['#11', '#11', '#13'] }] }, dk);
    const dMissing = R.gradeDecide({ answers: [{ id: 'q2', order: ['#11', '#12', '#13'] }] }, dk);
    check('12b. gradeDecide: an accepted choice and a legal order pass, a broken pair, a repeat or a missing answer fail',
        dRight.pass && dRight.right === 2 && !dOrder.pass && /#11 before #13/.test(dOrder.results[1].why) && !dDup.pass && !dMissing.pass && dMissing.right === 1,
        [dRight, dOrder.results, dDup.results, dMissing.results]);
    const pr = R.composePrompt({ id: 'T9', lane: 'review', answerFile: 'frontier-answer.json' }, 'Review PLAN.md.\n', 'C:\\w\\repo');
    check('13. the prompt frame names the repo with forward slashes and the answer file', pr.includes('C:/w/repo') && pr.includes('`frontier-answer.json`') && pr.includes('Review PLAN.md.'), pr);
    const s = F.summarise([
        { run: 'a', task: 'T1', lane: 'fix', variant: 'V0', verdict: 'pass', pass: true, costUsd: 4, wallMs: 100, tokens: { total: 10 }, load: { class: 'quiet' } },
        { run: 'b', task: 'T1', lane: 'fix', variant: 'V1', verdict: 'pass', pass: true, costUsd: 1, wallMs: 200, tokens: { total: 10 }, load: { class: 'quiet' } },
        { run: 'c', task: 'T2', lane: 'fix', variant: 'V0', verdict: 'pass', pass: true, costUsd: 4, wallMs: 100, tokens: { total: 10 }, load: { class: 'quiet' } },
        { run: 'd', task: 'T2', lane: 'fix', variant: 'V1', verdict: 'timeout', pass: false, costUsd: null, wallMs: 900, tokens: null, load: { class: 'quiet' } },
        { run: 'e', task: 'T2', lane: 'fix', variant: 'V2', verdict: 'billed-api', pass: null, costUsd: 9, wallMs: 1, tokens: null },
    ]);
    check('14. frontier: a timeout counts as a fail, billed-api is excluded and reported', s.variants.V1.n === 2 && s.variants.V1.passRate === 0.5 && !s.variants.V2 && s.excluded['billed-api'] === 1, s.variants);
    check('15. frontier: Pareto on cost keeps both ends, on wall time only the dominant one', s.pareto.cost.join() === 'V0,V1' && s.pareto.wall.join() === 'V0', s.pareto);
    check('16. frontier: the disagreeing task is the k = 3 candidate', s.disagreements.join() === 'T2', s.disagreements);
    check('17. frontier: a null cost stays out of the median', s.variants.V1.medianCostUsd === 1, s.variants.V1);
    const s2 = F.summarise([
        { run: 'f', task: 'T1', lane: 'fix', variant: 'V0', verdict: 'pass', pass: true, costUsd: 1, wallMs: 100, durationApiMs: 50, tokens: { total: 1 }, load: { class: 'quiet' } },
        { run: 'g', task: 'T1', lane: 'fix', variant: 'V1', verdict: 'pass', pass: true, costUsd: 1, wallMs: 50, durationApiMs: 20, tokens: { total: 1 }, load: { class: 'loaded' } },
        { run: 'h', task: 'T2', lane: 'fix', variant: 'V1', verdict: 'pass', pass: true, costUsd: 1, wallMs: 80, durationApiMs: 30, tokens: { total: 1 } },
    ]);
    check('17b. frontier: wall time reads quiet rows only, API time reads every row, a row with no record is unknown',
        s2.variants.V0.medianWallQuietMs === 100 && s2.variants.V1.medianWallQuietMs === null && s2.variants.V1.medianWallAnyLoadMs === 65
        && s2.variants.V1.medianApiMs === 25 && s2.variants.V1.load.loaded === 1 && s2.variants.V1.load.unknown === 1, s2.variants);
    check('17c. frontier: a variant with no quiet row is off the wall Pareto set, and API time still ranks it', s2.pareto.wall.join() === 'V0' && s2.pareto.api.join() === 'V1', s2.pareto);
    const procs = [
        { pid: 10, ppid: 1, cmd: 'node headless-worker.js supervise' },
        { pid: 11, ppid: 10, cmd: 'claude -p' },
        { pid: 12, ppid: 11, cmd: 'node tooling/test-all.js' },
        { pid: 20, ppid: 1, cmd: 'node C:\\code\\wt\\peer\\tooling\\find-untested-functions.js --gate' },
        { pid: 21, ppid: 1, cmd: 'node C:/Users/x/autodev-frontier/wt/F-1-T1-V0-1/tooling/test-all.js' },
        { pid: 22, ppid: 1, cmd: 'node server.js' },
        { pid: 23, ppid: 1, cmd: 'npm run gate' },
    ];
    const hj = R.heavyJobs(procs, 10, 'C:\\Users\\x\\autodev-frontier\\wt\\F-1-T1-V0-1');
    const hjAll = R.heavyJobs(procs, null, null);
    check('17d. heavyJobs drops the own tree and repo, keeps a peer gate and names it',
        hj.length === 2 && hj.includes('find-untested-functions.js@peer') && hj.includes('run gate') && hjAll.length === 4 && R.heavyJobs(null, 1, '') === null, [hj, hjAll]);
    const at0 = '2026-09-30T00:00:00.000Z';
    const at1 = '2026-09-30T00:01:40.000Z';
    const a0 = { at: at0, cpu: { idle: 0, total: 0 }, heavy: [] };
    const a1 = { at: at1, cpu: { idle: 300, total: 1000 }, heavy: [] };
    const polls = R.noteLoad(R.noteLoad(null, []), ['test-all.js@peer']);
    const quiet = R.loadRecord(a0, a1, R.noteLoad(null, []));
    const mid = R.loadRecord(a0, a1, polls);
    const blind = R.loadRecord(a0, Object.assign({}, a1, { heavy: null }), null);
    const none = R.loadRecord(undefined, a1, null);
    check('17e. loadRecord: quiet with no heavy reading, loaded when one mid-run poll saw a peer, unknown when a reading failed or the start is missing',
        quiet.class === 'quiet' && quiet.cpuBusy === 0.7 && quiet.windowSec === 100 && quiet.samples === 3
        && mid.class === 'loaded' && mid.heavyMax === 1 && mid.jobs.join() === 'test-all.js@peer' && mid.heavyStart === 0 && polls.n === 2
        && blind.class === 'unknown' && none.class === 'unknown', [quiet, mid, blind, none]);
    const pl = R.processList({});
    check('17f. processList reads the real table, and it holds this process under its parent',
        Array.isArray(pl) && pl.length > 5 && pl.some((p) => p.pid === process.pid && p.ppid === process.ppid), pl && pl.length);
    const forced = R.loadRecord(a0, a1, R.noteLoad(null, []), { waitedSec: 600, timedOut: true, jobs: ['test-all.js@peer'] });
    const waited = R.loadRecord(a0, a1, R.noteLoad(null, []), { waitedSec: 40, timedOut: false, jobs: [] });
    check('17g. a run started after its quiet wait timed out is loaded on quiet samples, and one that got quiet stays quiet',
        forced.class === 'loaded' && forced.quietWait.waitedSec === 600 && waited.class === 'quiet' && waited.quietWait.timedOut === false, [forced, waited]);
    // A real heavy job on the real process table: the planted suite is a sleeping node process.
    const peerSuite = path.join(ROOT, 'plantedpeer', 'tooling', 'test-all.js');
    write(peerSuite, 'setInterval(() => {}, 1000);\n');
    const planted = spawn(process.execPath, [peerSuite], { stdio: 'ignore', windowsHide: true });
    try {
        let seen = null;
        for (let i = 0; i < 20 && !(seen && seen.includes('test-all.js@plantedpeer')); i++) { seen = R.heavyJobs(R.processList({}), null, null); if (i) sleep(250); }
        const gb = { quietWaitMin: 10 };
        const held = R.quietGate({}, gb);
        check('17h. a planted peer suite on the real table is a heavy job, and the quiet gate holds on it and names it',
            seen && seen.includes('test-all.js@plantedpeer') && held && held.hold === true && gb.waitingOn.includes('test-all.js@plantedpeer') && !!gb.waitingSince,
            [seen, held, gb]);
        const off = R.quietGate({}, { quietWaitMin: 0 });
        const late = { quietWaitMin: 1, waitingSince: new Date(Date.now() - 61000).toISOString() };
        const gone = R.quietGate({}, late);
        check('17i. the gate is off at 0 minutes, and past its limit it releases the item as timed out, naming the job',
            off === null && gone && gone.record && gone.record.timedOut === true && gone.record.waitedSec >= 61 && gone.record.jobs.includes('test-all.js@plantedpeer') && !late.waitingSince,
            [off, gone, late]);
        // A loop that died mid-wait leaves waitingSince behind. Resumed hours later, the old
        // stamp is past every limit, so without the reset the item starts loaded at once.
        const rc = { data: path.join(ROOT, 'resume-data') };
        const staleSince = new Date(Date.now() - 14 * 3600 * 1000).toISOString();
        const bf = path.join(rc.data, 'batches', 'B-resume.json');
        write(bf, JSON.stringify({ id: 'B-resume', state: 'running', loopPid: null, quietWaitMin: 10, items: [], waitingSince: staleSince, waitingOn: ['run gate'] }));
        let spawned = null;
        const resumed = R.resumeBatch(rc, 'B-resume', {}, (_c, id) => { spawned = id; return 4242; });
        const after = JSON.parse(fs.readFileSync(bf, 'utf8'));
        // Read the stamps before quietGate runs: it writes a fresh waitingSince onto the batch it is given.
        const cleared = !('waitingSince' in after) && !('waitingOn' in after);
        const heldAgain = R.quietGate({}, after);
        check('17j. batch-resume closes a wait the dead loop left open, so the resumed item waits afresh on a busy machine',
            resumed.loopPid === 4242 && spawned === 'B-resume' && resumed.clearedWaitSince === staleSince
                && cleared && heldAgain && heldAgain.hold === true,
            [resumed, cleared, heldAgain]);
    } finally {
        try { planted.kill(); } catch { /* already gone */ }
    }
    openLaneCases();
    routeCases();
    derivedCases();
    realKeyCases();
}

/**
 * The shipped T10-T12 keys, graded against answers written here by hand, not
 * read from the keys: a key that loses an example or a decoy cannot shrink
 * these. The paraphrases are the ones a review passed through the first keys.
 */
function realKeyCases() {
    const REAL = path.resolve(__dirname, 'frontier', 'tasks');
    const key = (id) => readJson(path.join(REAL, `${id}.answers.json`));
    const k10 = key('T10'); const k11 = key('T11'); const k12 = key('T12');
    const d = (k, file, mechanism) => R.gradeDiagnose({ cause: { file, mechanism } }, k);
    const t10 = 'tooling/test-headless-worker.js'; const t12 = 'tooling/test-inbox.js';

    const hedges = [
        ['Or the supervisor might be racing the write', true],
        ['A supervisor race is another candidate', true],
        ['Alternatively the supervisor may be racing the write', true],
        ['Possibly the runner is also just noisy', true],
        ['the ledger ends on its original inode, or perhaps the stat is cached', true],
        ['Either ext4 reuses the inode, or the supervisor races the write', true],
        ['Either it returns a - b, or the caller swaps them', true],
        ['ext4 hands it to whichever file is created next, either the second .tmp or the supervisor\'s log', false],
        ['one ordinary stall, maybe a GC pause, exceeds it', false],
        ['It returns a - b on either call', false],
        ['the second .tmp might get the same inode number', false],
    ];
    const hedgeWrong = hedges.filter(([s, want]) => R.hedgedSentence(s) !== want).map(([s]) => s);
    const split = R.sentencesOf('The first .tmp in test-inbox.js lands; the second does not. Done');
    check('73a. hedges: a second cause is hedged, and a qualifier, two file names or a modal on the one cause are not; a dot inside a name ends no sentence',
        hedges.length === 11 && hedgeWrong.length === 0 && split.length === 3 && split[0] === 'The first .tmp in test-inbox.js lands', { hedgeWrong, split });

    const right10 = [
        "A start writes the ledger twice, each write renames a fresh .tmp over the file, and the case compared the ledger's dev:ino before and after the whole start. The first rename frees the old inode, and ext4 hands a just-freed number to the next file created, so the second .tmp gets the number the ledger started with and a file replaced twice reads as never replaced.",
        "The first rename frees the ledger's inode and ext4 hands it to whichever file is created next, either the second .tmp or the supervisor's log; when the .tmp wins, the ledger ends on its original inode and reads as not replaced.",
        "ext4 allocates the lowest available inode, so the second .tmp takes the ledger's former inode number and the dev:ino comparison sees equal values: a replaced file looks untouched.",
    ].map((m) => d(k10, t10, m));
    const race = d(k10, t10, 'The case stats the ledger before the supervisor has released its handle on the inode, so on slow Ubuntu runners the after reading shows the same inode and reads as not replaced.');
    const split10 = d(k10, t10, 'The supervisor reuses a stale handle on slow runners. The after reading shows the same inode number and reads as not replaced.');
    const might = d(k10, t10, 'ext4 reuses the just-freed inode number for the next .tmp, so the ledger ends with its original inode and reads as not replaced. Or the supervisor might be racing the write.');
    check('73b. T10 key: three right paraphrases pass, a timing race in the right words fails on reuse, reuse words split from the inode fail, and a trailing "might" fails as hedged',
        right10.every((g) => g.pass) && !race.pass && race.groups.find((g) => g.id === 'reuse').hit === false
            && !split10.pass && !might.pass && might.hedged && might.groups.every((g) => g.hit),
        { right: right10.map((g) => g.pass), race: race.groups, split10: split10.groups, might: might.hedged });

    const right12 = [
        "The predicate fullMs < emptyMs * 2 + 25 budgets a fixed I/O cost as a multiple of an unrelated spawn baseline. A faster machine measures a smaller empty time and therefore gets a TIGHTER absolute allowance, while a slow box's baseline makes the budget generous.",
        "The predicate fullMs < emptyMs * 2 + 25 lets the 25 files cost only emptyMs + 25: the CI Mac spawns in 38ms so the files get 63ms and one 113ms stall fails it, while the dev Mac's 200ms empty time allows 225ms.",
        'The budget is emptyMs * 2 + 25, a multiple of the spawn baseline, so the fast CI Mac at 38ms gets a tight 63ms allowance that one ordinary stall, maybe a GC pause, exceeds.',
    ].map((m) => d(k12, t12, m));
    const oneMachine = d(k12, t12, 'The budget is emptyMs * 2 + 25, and the CI Mac at 38ms gets 63ms for the files, which a 113ms APFS stat stall exceeds.');
    check('73c. T12 key: a right answer in adjectives, in numbers, and with "maybe" on the stall passes, and one machine\'s numbers fail on faster',
        right12.every((g) => g.pass) && !oneMachine.pass && oneMachine.groups.find((g) => g.id === 'faster').hit === false,
        { right: right12.map((g) => [g.pass, g.groups, g.hedged]), oneMachine: oneMachine.groups });

    const risks = ['held-out tests could be read', 'contamination through memory', 'noise from one run'];
    const tools = ['tooling/sonnet-eval.js', 'tooling/test-sonnet-eval.js'];
    const oneCommit = R.gradePlan({ steps: [
        { do: 'Pick ten recent fixes from git history.' },
        { do: 'For each, git worktree add at the commit one commit before the fix, and run Sonnet and Opus there on the same tasks.', creates: tools },
        { do: 'The script runs the tests after the worker finishes and compares pass rates and cost.' }], risks }, k11);
    const reset = R.gradePlan({ steps: [
        { do: 'Pick ten recent fixes from git history.' },
        { do: 'git clone the repo for each task.' },
        { do: 'git reset --hard to the parent of the fix, and run Sonnet and Opus there on the same tasks.', creates: tools },
        { do: 'The script runs the tests and compares pass rates and cost.' }], risks }, k11);
    const edits = R.gradePlan({ steps: [
        { do: 'Pick ten recent fixes from git history. Build each task repo with git archive of the parent.' },
        { do: 'Add the harness and tooling/test-sonnet-eval.js.', edits: ['plugins/autodev-core/scripts/sonnet-eval.js'] },
        { do: 'The script runs the held-out tests after the worker finishes, on the same tasks, and records cost.' }], risks }, k11);
    check('73d. T11 key: a worktree "one commit before the fix" and a clone reset to the parent trip X2, and a harness edited under plugins/ trips X1',
        oneCommit.traps.includes('X2') && reset.traps.includes('X2') && edits.traps.includes('X1') && !oneCommit.pass && !reset.pass && !edits.pass,
        { oneCommit: oneCommit.traps, reset: reset.traps, edits: edits.traps });
    const withRisks = R.gradePlan({ steps: [{ do: 'Pick recent fixes from git history.' }], risks: ['held-out tests', 'CLAUDE_CONFIG_DIR', 'noise'] }, k11);
    const inSteps = R.gradePlan({ steps: [{ do: 'Pick recent fixes from git history. Keep the tests held-out, run in a fresh CLAUDE_CONFIG_DIR, and repeat for noise.' }] }, k11);
    const ids = (g) => g.requirements.filter((r) => r.met).map((r) => r.id).join();
    check('73e. T11 key: a danger named under risks meets no requirement, and the same words in a step meet R2, R5 and R7',
        ids(withRisks) === 'R1' && ['R1', 'R2', 'R5', 'R7'].every((id) => ids(inSteps).split(',').includes(id)), [ids(withRisks), ids(inSteps)]);

    const ex10 = k10.examples.map((a) => R.gradeDiagnose(a, k10).pass);
    const ex12 = k12.examples.map((a) => R.gradeDiagnose(a, k12).pass);
    const dec = [...k10.decoys.map((x) => R.gradeDiagnose(x.answer, k10)), ...k12.decoys.map((x) => R.gradeDiagnose(x.answer, k12))];
    const x11 = ['X1', 'X2'].map((t) => R.gradePlan(k11.examples.traps[t], k11));
    check('73f. shipped keys: every T10 and T12 example passes, every decoy fails, each T11 trap example trips its trap at the threshold, and T11 leak terms carry the config phrases',
        ex10.length >= 7 && ex12.length >= 7 && dec.length >= 17 && ex10.every(Boolean) && ex12.every(Boolean) && dec.every((g) => !g.pass)
            && x11.every((g, i) => g.traps.join() === ['X1', 'X2'][i] && g.met >= g.threshold) && R.gradePlan(k11.examples.right[0], k11).pass
            && ['held-out test never goes red', 'Sonnet medium 0/4'].every((t) => readJson(path.join(REAL, 'T11.json')).leakTerms.includes(t)),
        { ex10, ex12, decoys: dec.length, x11: x11.map((g) => [g.traps, g.met]) });

    const base = { task: 'T1', variant: 'V0', verdict: 'pass', pass: true, costUsd: 1, wallMs: 10, durationApiMs: 5, tokens: { total: 1 }, load: { class: 'quiet' } };
    const s = F.summarise([base, Object.assign({}, base, { run: 'b', leak: { suspect: true, hits: ['x'] } }),
        Object.assign({}, base, { run: 'c', variant: 'V4', stage: 1, verdict: 'fail', pass: false }),
        Object.assign({}, base, { run: 'd', variant: 'V4', stage: 2, escalatedFrom: 'c', leak: { suspect: true } })]);
    check('74a. frontier: a leak-suspect row counts nowhere, and an escalation whose second run leaked is excluded as a pair',
        s.counted === 1 && s.excluded['leak-suspect'] === 2 && !s.variants.V4 && s.variants.V0 && s.variants.V0.n === 1, { counted: s.counted, excluded: s.excluded });

    const row = (run, extra) => Object.assign({}, base, { run }, extra);
    const s2 = F.summarise([
        row('A', { task: 'T1', lane: 'fix', taskHash: 'h1' }),
        row('B', { task: 'T1', lane: 'fix', taskHash: 'old' }),
        row('C', { task: 'T2', lane: 'diagnose' }),
        row('D', { task: 'T2', lane: 'diagnose', ancestorMemory: 0 }),
        row('E', { task: 'T2', lane: 'diagnose', ancestorMemory: 3 }),
        row('F', { task: 'T2', lane: 'diagnose', variant: 'V4', stage: 1, verdict: 'fail', pass: false, ancestorMemory: 0 }),
        row('G', { task: 'T2', lane: 'diagnose', variant: 'V4', stage: 2, escalatedFrom: 'F' }),
        row('H', { task: 'T3', lane: 'plan', taskHash: 'x', ancestorMemory: 0 }),
    ], { hashes: { T1: 'h1', T2: 'h2' } });
    check('74b. frontier: a row under an older task hash is superseded, an open-lane row without ancestorMemory 0 is home-memory (an escalation pair included), and a fix-lane row stands without it',
        s2.counted === 3 && s2.excluded.superseded === 1 && s2.excluded['home-memory'] === 3 && !s2.variants.V4 && s2.variants.V0.n === 3,
        { counted: s2.counted, excluded: s2.excluded });
}

function openLaneCases() {
    const dk = readJson(path.join(TASKS, 'TDG.answers.json'));
    const right = dk.examples.map((a) => R.gradeDiagnose(a, dk));
    check('66a. gradeDiagnose: both right examples pass, ./lib/add.js normalised', right.every((g) => g.pass) && right[1].file === 'lib/add.js', right);
    const wrongFile = R.gradeDiagnose(dk.decoys[0].answer, dk);
    check('66b. gradeDiagnose: the right mechanism in the wrong file fails on the file alone', !wrongFile.pass && !wrongFile.fileOk && wrongFile.groups.every((g) => g.hit) && !wrongFile.hedged, wrongFile);
    const wrongMech = R.gradeDiagnose(dk.decoys[1].answer, dk);
    check('66c. gradeDiagnose: the right file with the wrong mechanism fails on its groups', !wrongMech.pass && wrongMech.fileOk && wrongMech.groups.some((g) => !g.hit), wrongMech);
    const hedged = R.gradeDiagnose(dk.decoys[2].answer, dk);
    check('66d. gradeDiagnose: a hedged right answer fails on the hedge alone', !hedged.pass && hedged.fileOk && hedged.groups.every((g) => g.hit) && hedged.hedged, hedged);
    const long = R.gradeDiagnose({ cause: { file: 'lib/add.js', mechanism: `${dk.examples[0].cause.mechanism} ${'x'.repeat(600)}` } }, dk);
    const empty = R.gradeDiagnose({}, dk);
    check('66e. gradeDiagnose: a mechanism past maxMechanism fails, and an empty answer fails', !long.pass && long.tooLong && long.fileOk && !empty.pass, [long.tooLong, empty]);
    const plainEither = R.gradeDiagnose({ cause: { file: 'lib/add.js', mechanism: 'It returns a - b on either call, where it should return a + b.' } }, dk);
    const eitherOr = R.gradeDiagnose({ cause: { file: 'lib/add.js', mechanism: 'Either it returns a - b where it should return a + b, or the caller swaps them.' } }, dk);
    check('66f. gradeDiagnose: "on either call" is not a hedge, and "either this or that" is', plainEither.pass && !plainEither.hedged && eitherOr.hedged && !eitherOr.pass, [plainEither.hedged, eitherOr.hedged]);

    const pk = readJson(path.join(TASKS, 'TP.answers.json'));
    const pRight = R.gradePlan(pk.examples.right[0], pk);
    check('67a. gradePlan: the right plan meets every requirement and trips nothing', pRight.pass && pRight.met === 3 && pRight.traps.length === 0, pRight);
    const careless = R.gradePlan(pk.examples.careless, pk);
    check('67b. gradePlan: the careless plan fails the threshold and trips the history trap', !careless.pass && careless.met < careless.threshold && careless.traps.join() === 'X2', careless);
    const x1 = R.gradePlan(pk.examples.traps.X1, pk);
    check('67c. gradePlan: a plan that meets the threshold but creates under plugins/ fails on X1', !x1.pass && x1.met >= x1.threshold && x1.traps.join() === 'X1', x1);
    const x2 = R.gradePlan(pk.examples.traps.X2, pk);
    check('67d. gradePlan: a plan that meets the threshold but opens a worktree at the parent fails on X2', !x2.pass && x2.met >= x2.threshold && x2.traps.join() === 'X2', x2);
    // The carve-out can only remove a trip, so prove it removes one: the same
    // step matches every `all` pattern, and only the git archive words save it.
    const step = 'Build each repo with git archive of the parent in a worktree. Keep the tests held out.';
    const carved = R.gradePlan({ steps: [{ do: step, creates: ['tooling/eval.js'] }] }, pk);
    const bare = R.gradePlan({ steps: [{ do: step.replace('with git archive ', ''), creates: ['tooling/eval.js'] }] }, pk);
    const allMatch = pk.traps[1].step.all.every((m) => new RegExp(m, 'i').test(step));
    check('67e. gradePlan: the none words of a step trap remove a trip the all words make', allMatch && carved.traps.length === 0 && carved.pass && bare.traps.join() === 'X2' && !bare.pass, [allMatch, carved.traps, bare.traps]);
    const huge = R.gradePlan({ steps: [{ do: `${'Keep the tests held out. '.repeat(400)}git archive`, creates: ['tooling/eval.js'] }] }, pk);
    check('67f. gradePlan: an empty plan fails, and one past maxChars fails', !R.gradePlan({}, pk).pass && huge.tooLong && !huge.pass && huge.met === 3, [huge.tooLong, huge.met]);
    // Every pattern of an empty list matches, so a step trap with no `all`
    // words would trip on every step. It must trip on none.
    const noAll = Object.assign({}, pk, { traps: [{ id: 'X9', step: { all: [], none: [] } }] });
    const openAll = R.gradePlan(pk.examples.right[0], noAll);
    check('67g. gradePlan: a step trap with no all words trips nothing', openAll.traps.length === 0 && openAll.pass, openAll.traps);
}

function routeCases() {
    const route = (b) => R.routeFor(b).route;
    const mech = [
        'Fix the parser so that tooling/test-parse.js passes.',
        'Make npm test pass.',
        'Make the gate green.',
        'The report counts a row twice.\n\nCorrect behaviour: each row once.\n\n## Interface the checks use\n`summarise(rows)` returns one entry per row.',
    ];
    check('68a. routeFor: a change whose brief names a test file, an npm script, the gate or the checks routes mechanical',
        mech.every((b) => route(b) === 'mechanical'), mech.map(route));
    const open = [
        'Decide: A merge now, B run npm run gate first, C ask. Write frontier-answer.json.',
        'tooling/test-inbox.js fails on macOS. Find the cause.',
        'Plan how to find out whether the tests pass. Do not build anything.',
        'Review PLAN.md. The suite must pass after it lands.',
        'List every hook that exits 1 on a no-op path.',
        'The fix PR #12 is green on npm test. Decide whether to merge it.',
        '',
    ];
    check('68b. routeFor: a decision, a diagnosis, a plan, a review, a list and an empty brief route open, even when they name a test or a gate',
        open.every((b) => route(b) === 'open'), open.map(route));
    const handsOff = R.routeFor('tooling/test-add.js exits 1. Do not fix it.');
    const handsOn = R.routeFor('tooling/test-add.js exits 1. Fix it.');
    check('68c. routeFor: hands-off turns an endpoint with no judgement open, and the same brief ordering the fix routes mechanical',
        handsOff.route === 'open' && handsOff.signals.endpoint.length > 0 && handsOff.signals.judgement.length === 0 && handsOff.signals.handsOff.length > 0
        && handsOn.route === 'mechanical', [handsOff, handsOn]);
    const both = R.routeFor('Fix lib/add.js so that tooling/test-add.js passes. Pick one of the two approaches in NOTES.md.');
    check('68d. routeFor: a change order with an endpoint stays mechanical when it also asks for a choice',
        both.route === 'mechanical' && both.signals.judgement.length > 0 && both.signals.change.length > 0, both);
}

function derivedCases() {
    const row = (task, variant, pass, costUsd, extra = {}) => Object.assign({ run: `${task}-${variant}`, task, lane: 'fix', variant, verdict: pass ? 'pass' : 'fail', pass,
        costUsd, wallMs: 100, durationApiMs: 10, tokens: { total: 1 }, load: { class: 'quiet' } }, extra);
    const rs = [
        row('T1', 'V0', true, 4), row('T1', 'V1', false, 1),
        row('T2', 'V0', false, 4), row('T2', 'V1', true, 1),
        row('T3', 'V0', true, 4, { route: 'mechanical' }),
        row('T4', 'V1', true, 1),
    ];
    const opts = { routes: { T1: 'open', T2: 'mechanical' }, routed: { V3: { mechanical: 'V1', open: 'V0' } } };
    const s = F.summarise(rs, opts);
    const d = s.variants['V3*'];
    check('69a. frontier: the derived V3* takes, per task, the rows of the variant its route picks, and beats both measured variants',
        d && d.derived === true && d.n === 2 && d.passRate === 1 && d.from.T1 === 'V0' && d.from.T2 === 'V1' && s.variants.V0.passRate < 1 && s.variants.V1.passRate < 1, d);
    check('69b. frontier: a task with no brief route takes its row\'s route and is listed missing when the pick has no rows, and a task with neither is unrouted',
        d && d.from.T3 === 'V1' && d.missing.join() === 'T3' && d.unrouted.join() === 'T4', d && [d.from, d.missing, d.unrouted]);
    const override = F.summarise(rs, { routes: Object.assign({}, opts.routes, { T3: 'open' }), routed: opts.routed })['variants']['V3*'];
    check('69c. frontier: the brief\'s route wins over the row\'s', override && override.from.T3 === 'V0' && override.n === 3 && override.missing.length === 0, override && [override.from, override.n]);
    const inMatrix = Object.values(s.matrix).some((cells) => 'V3*' in cells);
    check('69d. frontier: V3* sits out of the matrix and the disagreements, and joins the Pareto sets',
        !inMatrix && s.disagreements.join() === 'T1,T2' && s.pareto.cost.join() === 'V1,V3*', [inMatrix, s.disagreements, s.pareto.cost]);
    const real = F.summarise(rs.concat([row('T1', 'V3', true, 2, { route: 'open', routedTo: 'V0' })]), opts);
    const plain = F.summarise(rs);
    check('69e. frontier: real V3 rows report as a plain V3 beside the derived V3*, and no route map derives nothing',
        real.variants.V3 && !real.variants.V3.derived && real.variants.V3.n === 1 && (real.variants['V3*'] || {}).n === 2 && !plain.variants['V3*'], [real.variants.V3, Object.keys(plain.variants)]);
    // A brief edited between runs leaves rows with two routes: the latest decides.
    const moved = F.summarise([
        row('T5', 'V1', false, 1, { route: 'mechanical', finishedAt: '2026-02-01T00:00:00Z' }),
        row('T5', 'V0', true, 4, { route: 'open', finishedAt: '2026-01-01T00:00:00Z' }),
    ], { routed: opts.routed }).variants['V3*'];
    check('69f. frontier: with no brief route, the latest row\'s route decides the pick', moved && moved.from.T5 === 'V1' && moved.n === 1, moved && moved.from);
    escalationCases(row);
}

function escalationCases(row) {
    const v4 = (task, run, stage, pass, costUsd, extra = {}) => row(task, 'V4', pass, costUsd, Object.assign({ run, stage }, extra));
    const rs = [
        v4('T1', 'a1', 1, true, 1),
        v4('T2', 'b1', 1, false, 1), v4('T2', 'b2', 2, true, 4, { escalatedFrom: 'b1', load: { class: 'loaded' } }),
        v4('T3', 'c1', 1, false, 1, { verdict: 'timeout' }), v4('T3', 'c2', 2, false, 4, { escalatedFrom: 'c1' }),
        v4('T4', 'd1', 1, false, 1),
        v4('T5', 'e2', 2, true, 4, { escalatedFrom: 'gone' }),
    ];
    const s = F.summarise(rs);
    const v = s.variants.V4;
    check('70a. frontier: an escalated V4 pair is one attempt with the stage-2 verdict and both costs summed, and a stage-1 pass stands alone',
        v && v.n === 3 && v.passes === 2 && v.escalated === 2 && v.medianCostUsd === 5 && s.matrix.T2.V4.passes === 1 && s.matrix.T3.V4.passes === 0 && s.matrix.T1.V4.passes === 1,
        [v, s.matrix]);
    check('70b. frontier: a red stage 1 with no stage 2 and a stage 2 with no stage 1 are excluded and named, not counted',
        s.excluded['escalation-missing'] === 1 && s.excluded['escalation-orphan'] === 1 && s.rows === 7 && s.counted === 3 && !s.matrix.T4 && !s.matrix.T5, [s.excluded, s.rows, s.counted]);
    const pair = F.collapseEscalations(rs).find((r) => r.run === 'b1');
    check('70c. frontier: the collapsed pair keeps the first run id, names the second, and is loaded when either run was',
        pair && pair.escalatedRun === 'b2' && pair.pass === true && pair.load.class === 'loaded' && pair.wallMs === 200 && pair.tokens.total === 2 && pair.durationApiMs === 20, pair);

    // What stage 2 is told: the red checks only, a timeout as such, and an answer lane's verdict without its key.
    const fr = { data: path.join(ROOT, 'fo-data'), work: path.join(ROOT, 'fo-work'), tasks: TASKS };
    const dir = path.join(fr.work, 'runs', 'F-30000000-TX-V4-1');
    write(path.join(dir, 'checks.log'), '\n=== check: node tooling/test-add.js -> exit 1 in 40 ms\nnot ok add(2, 2) returned 0\n\n\n=== pass-to-pass: node tooling/test-other.js -> exit 0 in 30 ms\nall fine GREENLINE\n\n');
    const fix = R.failingOutput(fr, { run: 'F-30000000-TX-V4-1', lane: 'fix', task: 'TX', verdict: 'fail' });
    const out = R.failingOutput(fr, { run: 'x', lane: 'fix', task: 'TX', verdict: 'timeout' });
    const ans = R.failingOutput(fr, { run: 'y', lane: 'locate', task: 'TL', verdict: 'fail', grade: { pass: false, missed: ['lib/add.js'], extra: [] } });
    check('70d. failingOutput: a fix run hands on its red checks and not its green ones, a timeout says so, and an answer lane gets its verdict without the key',
        fix.source === 'checks' && /exit 1/.test(fix.output) && /returned 0/.test(fix.output) && !/GREENLINE/.test(fix.output)
        && out.source === 'timeout' && ans.source === 'verdict' && /frontier-answer\.json was graded wrong/.test(ans.output) && !/lib\/add/.test(ans.output),
        [fix, out, ans]);
}

function cliCases(shas) {
    process.stdout.write('cli\n');
    const help = run(['--help']);
    check('18. --help exits 0 with a usage line', help.exit === 0 && /Usage:/.test(help.stdout), help.stdout.slice(0, 80));
    const fh = spawnSync(process.execPath, [FRONTIER, '--help'], { encoding: 'utf8' });
    check('19. frontier.js --help exits 0 with a usage line', fh.status === 0 && /Usage:/.test(fh.stdout));
    const hf = spawnSync(process.execPath, [path.join(__dirname, 'frontier', 'checks', 'help-fast.js'), '--help'], { encoding: 'utf8' });
    check('20. help-fast.js --help exits 0 with a usage line', hf.status === 0 && /Usage:/.test(hf.stdout));
    const quiet = path.join(ROOT, 'quiet.js');
    const slow = path.join(ROOT, 'slow.js');
    write(quiet, "if (process.argv.includes('--help')) console.log('Usage: quiet');\n");
    write(slow, 'setTimeout(() => {}, 3000);\n');
    const hf2 = spawnSync(process.execPath, [path.join(__dirname, 'frontier', 'checks', 'help-fast.js'), quiet, slow, '--budget-ms', '1000'], { encoding: 'utf8' });
    check('21. help-fast passes a script with a usage line and fails one that runs its real work', hf2.status === 1 && /^ok .*quiet\.js exit 0/m.test(hf2.stdout) && /^FAIL .*slow\.js/m.test(hf2.stdout), hf2.stdout);

    const noSnap = run(['prepare', '--task', 'TX', '--variant', 'V0']);
    check('22. prepare before the plant check is refused as not-planted', noSnap.exit === 1 && noSnap.json && noSnap.json.error.code === 'not-planted', noSnap.json);

    const plant = run(['plant']);
    const p = plant.json && plant.json.value;
    check('23. plant: the real fix is red unfixed, green fixed, neighbours green, contamination fires',
        p && p.TX.ok && p.TX.unfixed[0] === 1 && p.TX.fixed[0] === 0 && p.TX.contaminationTokens >= 1 && p.TX.contaminationFired, p && p.TX);
    check('24. plant: a task whose held-out test is green unfixed is dropped as measuring nothing', p && !p.TG.ok && /measures nothing/.test(p.TG.reason), p && p.TG);
    check('25. plant: the locate and review keys grade themselves pass and an empty answer fail', p && p.TL.ok && p.TR.ok, p && [p.TL, p.TR]);
    check('25b. plant: a decide key passes when its examples pass and each wrong answer fails', p && p.TD.ok, p && p.TD);
    check('25c. plant: a decide key that accepts its own wrong answer is refused, naming the question', p && !p.TDW.ok && /wrong not failing \[q1\]/.test(p.TDW.reason), p && p.TDW);
    check('25d. plant: a decide key grading an option the brief never names is refused', p && !p.TDN.ok && /not in the brief \[q1:Z\]/.test(p.TDN.reason), p && p.TDN);
    check('25e. plant: a diagnose key passes its examples, fails its decoys, and the fix files fire the contamination check',
        p && p.TDG.ok && p.TDG.examples === 2 && p.TDG.decoys === 3 && p.TDG.contaminationTokens >= 1 && p.TDG.contaminationFired === true && p.TDG.leakTerms === 1, p && p.TDG);
    check('25f. plant: a diagnose brief that matches a keyword group is refused for that alone', p && !p.TDL.ok && p.TDL.reason === 'the brief already matches groups [op]', p && p.TDL);
    check('25g. plant: a plan key passes, and one whose trap example trips nothing is refused naming the trap',
        p && p.TP.ok && p.TP.traps === 2 && !p.TPT.ok && p.TPT.reason === 'traps whose example does not fail on the trap alone [X2]', p && [p.TP, p.TPT]);
    check('25h. plant: a routable fix task plants like any other', p && p.TM.ok && p.TM.unfixed[0] === 1 && p.TM.fixed[0] === 0, p && p.TM);
    const refusals = [
        ['TDX1', 'a diagnose decoy that passes', 'decoys that pass [same]'],
        ['TDX2', 'a diagnose example that fails', 'examples that fail [2]'],
        ['TDX3', 'a diagnose key naming a file the parent lacks', 'files not in the parent tree [lib/missing.js]'],
        ['TDX4', 'a diagnose leak term already in the parent tree', 'leak terms already in the brief or the parent tree [module.exports]'],
        ['TDX5', 'a diagnose task with no fix and no leak terms', 'nothing to search the room for: name the fix or leakTerms'],
        ['TDX6', 'a diagnose key with one example and one decoy', '1 examples, needs 2 or more; 1 decoys, needs 2 or more'],
        ['TPX1', 'a plan threshold of 0, which lets an empty plan pass', 'threshold 0 is not between 1 and 3; an empty plan passes'],
        ['TPX2', 'a plan right example that fails', 'right examples that fail [0]'],
        ['TPX3', 'a plan careless example that passes', 'the careless example passes'],
        ['TPX4', 'a plan key with no trap', 'no trap'],
        ['TPX5', 'a plan brief that already meets a requirement', 'the brief already meets [R2]'],
        ['TPX6', 'a plan leak term already in the parent tree', 'leak terms already in the brief or the parent tree [module.exports]'],
        ['TPX7', 'a plan key with no right example', 'no right example'],
        ['TPX8', 'a plan key with no careless example', 'no careless example'],
    ];
    for (const [id, what, reason] of refusals) {
        check(`25i. plant refuses ${what}, for that reason alone (${id})`, p && p[id] && !p[id].ok && p[id].reason === reason, p && p[id]);
    }

    const pre = run(['prepare', '--task', 'TX', '--variant', 'V0']);
    check('26. prepare without a snapshot is refused as snapshot-missing', pre.json && !pre.json.ok && pre.json.error.code === 'snapshot-missing', pre.json);
    const snap = run(['snapshot']);
    const sv = snap.json && snap.json.value;
    check('27. snapshot keeps env, permissions and the output style, and drops hooks, model, status line and plugins',
        sv && ['env', 'permissions', 'outputStyle'].every((k) => sv.settingsKept.includes(k)) && ['hooks', 'model', 'statusLine', 'enabledPlugins'].every((k) => sv.settingsDropped.includes(k)), sv);

    const prep = run(['prepare', '--task', 'TX', '--variant', 'V1']);
    const m = prep.json && prep.json.value;
    const repoCommits = m ? git(['rev-list', '--count', 'HEAD'], m.repo) : null;
    check('28. prepare builds a one-commit repo at the parent, without the held-out test', m && repoCommits === '1' && !fs.existsSync(path.join(m.repo, 'tooling', 'test-add.js'))
        && /a - b/.test(fs.readFileSync(path.join(m.repo, 'lib', 'add.js'), 'utf8')), { repoCommits, m });
    const cfgSettings = m && readJson(path.join(m.cfg, 'settings.json'));
    check('29. the config dir carries the frozen rules and settings without hooks, and an onboarding file', m && fs.existsSync(path.join(m.cfg, 'rules', 'style.md')) && cfgSettings && !cfgSettings.hooks && !cfgSettings.model
        && fs.existsSync(path.join(m.cfg, '.claude.json')), cfgSettings);
    check('30. the pin is the release tag before the parent, without autodev-memory', m && m.pin.tag === 'v1.0.0' && m.pin.plugins.join() === 'autodev-core', m && m.pin);

    const noTok = run(['run', '--task', 'TX', '--variant', 'V0', '--account', 'nobody']);
    const runsBefore = fs.readdirSync(path.join(WORK, 'runs')).length;
    check('31. a run whose account token is absent is refused as token-missing', noTok.json && noTok.json.error.code === 'token-missing', noTok.json);
    const noTok2 = run(['run', '--task', 'TX', '--variant', 'V0', '--account', 'nobody']);
    check('32. and it creates no run directory', noTok2.json && !noTok2.json.ok && fs.readdirSync(path.join(WORK, 'runs')).length === runsBefore);
    const green = run(['run', '--task', 'TG', '--variant', 'V0', '--account', 'testacct']);
    check('33. a run of a task that failed its plant check is refused', green.json && green.json.error.code === 'plant-failed', green.json);

    // contamination: the answer planted in the live rules, snapshotted, refused
    write(path.join(HOME, 'rules', 'lesson.md'), 'Remember SAFE_SUM_GUARD.\n');
    run(['snapshot']);
    const cont = run(['run', '--task', 'TX', '--variant', 'V0', '--account', 'testacct']);
    check('34. a fix token in the config dir refuses the run as contaminated and names the file',
        cont.json && cont.json.error.code === 'contaminated' && /SAFE_SUM_GUARD in .*lesson\.md/.test(cont.json.error.message), cont.json);
    check('35. and a contaminated row is written, with no pass value', rows().some((r) => r.verdict === 'contaminated' && r.pass === null && r.task === 'TX'));
    fs.unlinkSync(path.join(HOME, 'rules', 'lesson.md'));
    run(['snapshot']);

    // memory above the task repo: claude loads it as project memory, so any
    // file there refuses the run, whatever it holds
    const upMemory = path.join(WORK, '.claude', 'CLAUDE.md');
    write(upMemory, 'Nothing about the task.\n');
    const up = run(['run', '--task', 'TX', '--variant', 'V0', '--account', 'testacct']);
    check('35a. a CLAUDE.md above the task repo refuses the run as contaminated and names the file',
        up.json && up.json.error && up.json.error.code === 'contaminated' && up.json.error.message.includes(`ancestor memory in ${upMemory}`), up.json);
    fs.unlinkSync(upMemory);
    const clean = run(['prepare', '--task', 'TX', '--variant', 'V0']);
    const cl = clean.json && clean.json.value;
    check('35b. with the file gone the run is prepared, and its meta records no memory above it and the stop',
        cl && cl.state === 'prepared' && Array.isArray(cl.contamination.ancestors) && cl.contamination.ancestors.length === 0 && cl.contamination.memoryStop === ROOT, cl && cl.contamination);
    const am = path.join(ROOT, 'am');
    write(path.join(am, 'CLAUDE.local.md'), 'x');
    write(path.join(am, 'a', '.claude', 'rules', 'r.md'), 'x');
    write(path.join(am, 'a', '.claude', 'rules', 'notes.txt'), 'x');
    write(path.join(am, 'a', 'b', 'repo', 'CLAUDE.md'), 'the task repo own memory');
    fs.mkdirSync(path.join(am, 'a', 'b', '.claude', 'rules'), { recursive: true });
    const rel = (list) => list.map((f) => path.relative(am, f).replace(/\\/g, '/')).sort().join();
    const found = R.ancestorMemory(path.join(am, 'a', 'b', 'repo'), am);
    check('35c. ancestorMemory lists CLAUDE.local.md and .claude/rules/*.md above the repo, not the repo own CLAUDE.md or a non-md rule',
        rel(found) === ['CLAUDE.local.md', 'a/.claude/rules/r.md'].join(), rel(found));
    const stopped = R.ancestorMemory(path.join(am, 'a', 'b', 'repo'), path.join(am, 'a'));
    check('35d. the walk ends at its stop directory: a file above the stop is not listed, one in it is',
        rel(stopped) === 'a/.claude/rules/r.md', rel(stopped));

    const fixed = startAndFinish('TX', 'V0', 'fix');
    const row = fixed.row;
    check('36. a worker that fixes the bug passes, graded by the held-out test and the neighbour', row && row.verdict === 'pass' && row.grade.checks[0].exit === 0 && row.grade.passToPass[0].exit === 0, row || fixed.start.json);
    check('37. the row carries tokens by class and the notional cost from the result event', row && row.tokens.total === 370 && row.tokens.cacheRead === 300 && row.tokens.thinking === 5 && row.costUsd === 0.5 && row.turns === 3, row && row.tokens);
    check('38. the fingerprint names the model, the pin, the loaded plugins and apiKeySource none',
        row && row.fingerprint.model === 'claude-opus-5-5' && row.fingerprint.pin === 'v1.0.0' && row.fingerprint.loadedPlugins.join() === 'autodev-core@1.0.0' && row.apiKeySource === 'none', row && row.fingerprint);
    check('39. the budget reading comes from the rate_limit_event, and no leak is flagged', row && row.budget && row.budget.sevenDay === 0.1 && row.leak.suspect === false && row.ancestorMemory === 0, row && [row.budget, row.leak, row.ancestorMemory]);
    const seen = readJson(path.join(OUT, 'seen-fix.json'));
    check('40. the worker saw its token under CLAUDE_CODE_OAUTH_TOKEN', seen && seen.tokenDigest === require('crypto').createHash('sha256').update(TOKEN).digest('hex') && seen.names.includes('CLAUDE_CODE_OAUTH_TOKEN'), seen && seen.names);
    const banned = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_TESTACCT', 'CLAUDE_CODE_OAUTH_TOKEN_OTHER', 'SOME_SECRET', 'DOPPLER_PROJECT'];
    check('41. and no other credential reached it', seen && banned.every((n) => !seen.names.includes(n)), seen && seen.names.filter((n) => banned.includes(n)));
    check('42. it ran in its task repo on its own config dir with the pin, model and effort in argv',
        seen && row && path.resolve(seen.cwd) === path.resolve(path.join(WORK, 'wt', row.run)) && path.resolve(seen.configDir) === path.resolve(path.join(WORK, 'cfg', row.run))
        && seen.argv.includes('--plugin-dir') && seen.argv.includes('claude-opus-5-5') && seen.argv[seen.argv.indexOf('--effort') + 1] === 'medium' && seen.argv.includes('bypassPermissions'), seen);
    const again = run(['finish', '--run', row ? row.run : 'x']);
    check('43. finish is idempotent: the same row back and one row in the file', again.json && row && again.json.value.finishedAt === row.finishedAt && rows().filter((r) => r.run === row.run).length === 1);

    const noop = startAndFinish('TX', 'V1', 'noop');
    check('44. a worker that does nothing fails on the held-out test', noop.row && noop.row.verdict === 'fail' && noop.row.grade.checks[0].exit === 1, noop.row || noop.start.json);
    const cheat = startAndFinish('TX', 'V1', 'cheat');
    check('45. a worker that rewrites the test instead of the code fails: the held-out file wins', cheat.row && cheat.row.verdict === 'fail', cheat.row || cheat.start.json);
    const api = startAndFinish('TX', 'V1', 'fix', { FAKE_API: 'ANTHROPIC_API_KEY' });
    check('46. an API-billed init is a billed-api row with no pass value, and it is not graded', api.row && api.row.verdict === 'billed-api' && api.row.pass === null && !api.row.grade, api.row || api.start.json);
    const leak = startAndFinish('TX', 'V1', 'leak');
    check('47. a tool call into the live config is flagged as a leak suspect', leak.row && leak.row.leak.suspect === true, leak.row && leak.row.leak);

    const hang = startAndFinish('TH', 'V1', 'hang', {}, 30);
    const hangSeen = readJson(path.join(OUT, 'seen-hang.json'));
    check('48. a worker past its budget is graded timeout and fails', hang.row && hang.row.verdict === 'timeout' && hang.row.pass === false, hang.row || hang.start.json);
    let alive = hangSeen ? pidAlive(hangSeen.pid) : true;
    for (let i = 0; i < 20 && alive; i++) { sleep(250); alive = pidAlive(hangSeen.pid); }
    check('49. and its process tree is killed', hangSeen && !alive, hangSeen && hangSeen.pid);

    const locate = startAndFinish('TL', 'H0', 'answer', { FAKE_ANSWER: JSON.stringify({ items: [{ path: 'lib/add.js' }, { path: './tooling/test-other.js' }] }) });
    check('50. a locate answer is graded by F1 from the answer file', locate.row && locate.row.verdict === 'pass' && locate.row.grade.f1 === 1, locate.row || locate.start.json);
    const badJson = startAndFinish('TL', 'H0', 'answer', { FAKE_ANSWER: '{not json' });
    check('51. an unreadable answer file fails with the reason', badJson.row && badJson.row.verdict === 'fail' && /no readable/.test(badJson.row.grade.reason), badJson.row && badJson.row.grade);
    const lane = run(['run', '--task', 'TX', '--variant', 'H0', '--account', 'testacct']);
    check('52. a locate-only variant is refused on a fix task', lane.json && lane.json.error.code === 'lane-mismatch', lane.json);
    const review = startAndFinish('TR', 'V1', 'answer', { FAKE_ANSWER: JSON.stringify({ findings: [
        { section: 'S2', severity: 'blocker', claim: 'Two sessions race on the file.' }, { section: 'S3', severity: 'major', claim: 'It fails open on a missing file.' }] }) });
    check('53. a review answer names both planted defects and passes', review.row && review.row.verdict === 'pass' && review.row.grade.named === 2, review.row || review.start.json);
    const planFile = review.row ? path.join(WORK, 'wt', review.row.run, 'PLAN.md') : null;
    check('54. the review task repo carries its support file', planFile && fs.existsSync(planFile));

    const good = startAndFinish('TD', 'V1', 'answer', { FAKE_ANSWER: JSON.stringify({ answers: [{ id: 'q1', choice: 'B', why: 'policy' }, { id: 'q2', order: ['#11', '#12', '#13'] }] }) });
    const bad = startAndFinish('TD', 'V1', 'answer', { FAKE_ANSWER: JSON.stringify({ answers: [{ id: 'q1', choice: 'A' }, { id: 'q2', order: ['#11', '#12', '#13'] }] }) });
    check('54b. a decide answer is graded from the answer file: right passes, one wrong choice fails',
        good.row && good.row.verdict === 'pass' && good.row.grade.right === 2 && bad.row && bad.row.verdict === 'fail' && bad.row.grade.right === 1, [good.row && good.row.grade, bad.row && bad.row.grade]);
    const briefPath = path.join(TASKS, 'TD.md');
    const briefText = fs.readFileSync(briefPath, 'utf8');
    fs.appendFileSync(briefPath, 'An edit.\n');
    const stale = run(['run', '--task', 'TD', '--variant', 'V1', '--account', 'testacct']);
    fs.writeFileSync(briefPath, briefText);
    check('54c. editing a task brief after its plant check makes the run refuse as plant-stale', stale.json && stale.json.error && stale.json.error.code === 'plant-stale', stale.json);

    // V3 routes at prepare time: a mechanical brief runs V1, an open one V0.
    const pm = run(['prepare', '--task', 'TM', '--variant', 'V3']);
    const mm = pm.json && pm.json.value;
    check('54d. prepare V3 on a brief that names its endpoint runs V1: sonnet at medium, route mechanical, routedTo V1',
        mm && mm.variant === 'V3' && mm.model === 'claude-sonnet-5-5' && mm.effort === 'medium' && mm.route === 'mechanical' && mm.routedTo === 'V1', mm || pm.json);
    const po = run(['prepare', '--task', 'TX', '--variant', 'V3']);
    const mo = po.json && po.json.value;
    check('54e. prepare V3 on a brief with no endpoint runs V0: opus, route open, routedTo V0',
        mo && mo.variant === 'V3' && mo.model === 'claude-opus-5-5' && mo.route === 'open' && mo.routedTo === 'V0', mo || po.json);
    const routedRun = startAndFinish('TM', 'V3', 'fix');
    const rr = routedRun.row;
    const seenRouted = readJson(path.join(OUT, 'seen-fix.json'));
    check('54f. a V3 run records its route and target on the row and starts the target model',
        rr && rr.verdict === 'pass' && rr.variant === 'V3' && rr.route === 'mechanical' && rr.routedTo === 'V1' && rr.fingerprint.requestedModel === 'claude-sonnet-5-5'
        && seenRouted && seenRouted.argv.includes('claude-sonnet-5-5'), [rr || routedRun.start.json, seenRouted && seenRouted.argv]);

    // The open lanes, graded through finish from the answer file.
    const dkey = readJson(path.join(TASKS, 'TDG.answers.json'));
    const dRight = startAndFinish('TDG', 'V0', 'answer', { FAKE_ANSWER: JSON.stringify(dkey.examples[0]) });
    const dDecoy = startAndFinish('TDG', 'V0', 'answer', { FAKE_ANSWER: JSON.stringify(dkey.decoys[0].answer) });
    check('54g. a diagnose answer is graded from the answer file: the right cause passes, the wrong file fails',
        dRight.row && dRight.row.verdict === 'pass' && dRight.row.route === 'open' && dDecoy.row && dDecoy.row.verdict === 'fail' && dDecoy.row.grade.fileOk === false,
        [dRight.row ? dRight.row.grade : dRight.start.json, dDecoy.row && dDecoy.row.grade]);
    const pkey = readJson(path.join(TASKS, 'TP.answers.json'));
    const pRight = startAndFinish('TP', 'V0', 'answer', { FAKE_ANSWER: JSON.stringify(pkey.examples.right[0]) });
    const pTrap = startAndFinish('TP', 'V0', 'answer', { FAKE_ANSWER: JSON.stringify(pkey.examples.traps.X1) });
    check('54h. a plan answer is graded from the answer file: the right plan passes, the plugins/ plan fails on X1',
        pRight.row && pRight.row.verdict === 'pass' && pRight.row.grade.met === 3 && pTrap.row && pTrap.row.verdict === 'fail' && pTrap.row.grade.traps.join() === 'X1',
        [pRight.row ? pRight.row.grade : pRight.start.json, pTrap.row && pTrap.row.grade]);

    // A leak term in the live rules: prose that would carry the diagnosis refuses the run.
    write(path.join(HOME, 'rules', 'lesson-leak.md'), 'The add bug is a SIGNFLIP.\n');
    run(['snapshot']);
    const leakPrep = run(['prepare', '--task', 'TDG', '--variant', 'V0']);
    const lp = leakPrep.json && leakPrep.json.value;
    fs.unlinkSync(path.join(HOME, 'rules', 'lesson-leak.md'));
    run(['snapshot']);
    const cleanPrep = run(['prepare', '--task', 'TDG', '--variant', 'V0']);
    const cp = cleanPrep.json && cleanPrep.json.value;
    check('54i. a leak term in the config dir marks the diagnose run contaminated and names the file, and a clean config does not',
        lp && lp.state === 'contaminated' && lp.contamination.hits.some((h) => h.token === 'SIGNFLIP' && /lesson-leak\.md$/.test(h.file))
        && cp && cp.state === 'prepared', [lp && lp.contamination || leakPrep.json, cp ? cp.state : cleanPrep.json]);

    // frontier.js derives V3* from the rows already measured, routed by the fixture briefs.
    const fd = spawnSync(process.execPath, [FRONTIER, '--data', DATA, '--tasks', TASKS, '--json'], { encoding: 'utf8' });
    const fdj = (() => { try { return JSON.parse(fd.stdout); } catch { return null; } })();
    const v3d = fdj && fdj.variants['V3*'];
    const picks = { TX: 'V0', TDG: 'V0', TP: 'V0' };
    const counted = rows().filter((r) => ['pass', 'fail', 'timeout'].includes(r.verdict) && picks[r.task] === r.variant);
    check('54j. frontier.js --tasks derives V3* from the rows its routes pick, lists the tasks with none, and counts what the rows hold',
        fd.status === 0 && v3d && v3d.derived === true && v3d.from.TX === 'V0' && v3d.from.TM === 'V1' && v3d.missing.includes('TM') && v3d.missing.includes('TL')
        && v3d.n === counted.length && v3d.passes === counted.filter((r) => r.pass).length && fdj.variants.V3 && !fdj.variants.V3.derived,
        [v3d, counted.length, fd.stderr]);
    const fdt = spawnSync(process.execPath, [FRONTIER, '--data', DATA, '--tasks', TASKS], { encoding: 'utf8' });
    check('54k. the table labels V3* as derived and names the tasks it could not fill', fdt.status === 0 && /^V3\* is derived, not run: .*TX=V0.*no rows of the pick for .*TM/m.test(fdt.stdout), fdt.stdout);

    // the budget guard: a reading at 0.95 stops a batch before it starts anything
    const hot = startAndFinish('TX', 'V0', 'fix', { FAKE_7D: '0.95' });
    check('55. a run reporting 95% of the week records it', hot.row && hot.row.budget.sevenDay === 0.95, hot.row && hot.row.budget);
    const b = run(['batch', '--tasks', 'TX', '--variants', 'V0,V1', '--account', 'testacct']);
    const bid = b.json && b.json.value && b.json.value.batch;
    let bf = null;
    for (let i = 0; i < 80; i++) { bf = readJson(path.join(DATA, 'batches', `${bid}.json`)); if (bf && bf.state !== 'running') break; sleep(250); }
    check('56. a batch over the budget stop starts nothing and says stopped-budget', bf && bf.state === 'stopped-budget' && bf.items.every((i) => i.state === 'queued'), bf || b.json || b.stderr);

    // a batch under budget runs both items, two at a time, and records both rows
    const cool = startAndFinish('TX', 'V0', 'fix', { FAKE_7D: '0.2' });
    check('57. a cooler reading replaces it', cool.row && cool.row.budget.sevenDay === 0.2);
    const before = rows().length;
    const b2 = run(['batch', '--tasks', 'TX', '--variants', 'V0,V1', '--account', 'testacct'], { FAKE_MODE: 'fix' });
    const bid2 = b2.json && b2.json.value && b2.json.value.batch;
    let bf2 = null;
    for (let i = 0; i < 240; i++) { bf2 = readJson(path.join(DATA, 'batches', `${bid2}.json`)); if (bf2 && bf2.state !== 'running') break; sleep(250); }
    check('58. a detached batch runs to done and writes a row per item', bf2 && bf2.state === 'done' && bf2.items.every((i) => i.verdict === 'pass') && rows().length === before + 2, bf2 || b2.json || b2.stderr);
    const st = run(['status']);
    check('59. status lists the batches and the row count', st.json && st.json.ok && st.json.value.batches.length === 2 && st.json.value.rows === rows().length, st.json && st.json.value);
    const fr = spawnSync(process.execPath, [FRONTIER, '--data', DATA, '--json', '--write'], { encoding: 'utf8' });
    const fj = (() => { try { return JSON.parse(fr.stdout); } catch { return null; } })();
    check('60. frontier.js reads the rows and writes frontier.json', fr.status === 0 && fj && fj.variants.V0 && fs.existsSync(path.join(DATA, 'frontier.json')) && fj.excluded['billed-api'] === 1 && fj.excluded.contaminated === 2, fj && [fj.excluded, Object.keys(fj.variants)]);
    const loaded = startAndFinish('TX', 'V1', 'fix', { FRONTIER_PROCESS_LIST: LOADED_PS });
    const batchRows = rows().filter((r) => bf2 && bf2.items.some((i) => i.run === r.run));
    check('61. a row records its load: quiet under a quiet table, loaded when a peer suite runs at start and end, and a batch row carries its polls',
        cool.row && cool.row.load && cool.row.load.class === 'quiet' && loaded.row && loaded.row.load.class === 'loaded'
        && loaded.row.load.heavyStart === 1 && loaded.row.load.heavyEnd === 1 && loaded.row.load.jobs.join() === 'test-all.js@peer-wt'
        && batchRows.length === 2 && batchRows.every((r) => r.load.class === 'quiet' && r.load.samples >= 3),
        [cool.row && cool.row.load, loaded.row && loaded.row.load, batchRows.map((r) => r.load)]);

    // --quiet-wait: a batch holds its item while a peer suite runs, then starts it anyway at the limit
    const batchDone = (id, polls) => {
        let f = null;
        for (let i = 0; i < polls; i++) { f = readJson(path.join(DATA, 'batches', `${id}.json`)); if (f && f.state !== 'running') break; sleep(250); }
        return f;
    };
    const rowOf = (f) => f && f.items[0] && rows().find((r) => r.run === f.items[0].run);
    const bt = run(['batch', '--tasks', 'TX', '--variants', 'V1', '--account', 'testacct', '--quiet-wait', '0.02'], { FAKE_MODE: 'fix', FRONTIER_PROCESS_LIST: LOADED_PS });
    const bft = batchDone(bt.json && bt.json.value && bt.json.value.batch, 240);
    const rt = rowOf(bft);
    check('62. under a peer suite, --quiet-wait 0.02 holds past its limit, starts anyway and records the row as loaded, timed out and naming the job',
        bft && bft.state === 'done' && bft.quietWaitMin === 0.02 && rt && rt.load.class === 'loaded' && rt.load.quietWait
        && rt.load.quietWait.timedOut === true && rt.load.quietWait.waitedSec >= 1 && rt.load.quietWait.jobs.join() === 'test-all.js@peer-wt',
        [bft && bft.state, rt && rt.load, bt.json || bt.stderr]);

    const DYN_PS = path.join(ROOT, 'ps dynamic.tsv');
    fs.copyFileSync(LOADED_PS, DYN_PS);
    const bq = run(['batch', '--tasks', 'TX', '--variants', 'V1', '--account', 'testacct', '--quiet-wait', '5'], { FAKE_MODE: 'fix', FRONTIER_PROCESS_LIST: DYN_PS });
    const bqid = bq.json && bq.json.value && bq.json.value.batch;
    let held = null;
    for (let i = 0; i < 80 && !(held && held.waitingOn); i++) { held = readJson(path.join(DATA, 'batches', `${bqid}.json`)); sleep(250); }
    const stq = run(['status']);
    const stBatch = stq.json && stq.json.ok && stq.json.value.batches.find((x) => x.id === bqid);
    sleep(1200);
    fs.copyFileSync(QUIET_PS, DYN_PS);
    const bfq = batchDone(bqid, 240);
    const rq = rowOf(bfq);
    check('63. while a peer suite runs the batch holds its item and says what it waits on, in the batch file and in status',
        held && held.waitingOn && held.waitingOn.join() === 'test-all.js@peer-wt' && held.items[0].state === 'queued'
        && stBatch && stBatch.waiting && stBatch.waiting.on.join() === 'test-all.js@peer-wt', [held, stBatch]);
    check('64. and once the peer ends it starts the item as quiet, with the time it waited and no timeout',
        bfq && bfq.state === 'done' && !bfq.waitingOn && rq && rq.load.class === 'quiet' && rq.load.quietWait
        && rq.load.quietWait.timedOut === false && rq.load.quietWait.waitedSec >= 1, [bfq && bfq.state, rq && rq.load]);

    const bare = run(['batch', '--tasks', 'TX', '--variants', 'V1', '--account', 'testacct', '--quiet-wait'], { FAKE_MODE: 'fix' });
    const bfb = batchDone(bare.json && bare.json.value && bare.json.value.batch, 240);
    const rb = rowOf(bfb);
    const junk = run(['batch', '--tasks', 'TX', '--variants', 'V1', '--account', 'testacct', '--quiet-wait', 'soon']);
    check('65. a bare --quiet-wait means 10 minutes and a quiet machine starts at once, and a non-number is a usage error',
        bfb && bfb.quietWaitMin === 10 && rb && rb.load.quietWait && rb.load.quietWait.waitedSec === 0 && rb.load.class === 'quiet'
        && junk.json && junk.json.error && junk.json.error.code === 'usage', [bfb && bfb.quietWaitMin, rb && rb.load, junk.json]);

    // V4: Sonnet goes red, so the batch queues a stage-2 Opus run on a fresh repo, told what failed.
    const byModel = JSON.stringify({ 'claude-sonnet-5-5': 'noop', 'claude-opus-5-5': 'fix' });
    const be = run(['batch', '--tasks', 'TX', '--variants', 'V4', '--account', 'testacct'], { FAKE_MODE_BY_MODEL: byModel });
    const bfe = batchDone(be.json && be.json.value && be.json.value.batch, 240);
    const er = bfe ? bfe.items.map((i) => rows().find((r) => r.run === i.run)) : [];
    const [e1, e2] = er;
    const prompt2 = e2 ? fs.readFileSync(path.join(WORK, 'runs', e2.run, 'prompt.md'), 'utf8') : '';
    const prompt1 = e1 ? fs.readFileSync(path.join(WORK, 'runs', e1.run, 'prompt.md'), 'utf8') : '';
    check('71. a red V4 stage 1 queues a stage-2 V0 run in the same batch, which starts from a fresh repo told what the checks printed',
        bfe && bfe.state === 'done' && bfe.items.length === 2 && e1 && e2
        && e1.stage === 1 && e1.verdict === 'fail' && e1.fingerprint.requestedModel === 'claude-sonnet-5-5'
        && e2.stage === 2 && e2.escalatedFrom === e1.run && e2.verdict === 'pass' && e2.fingerprint.requestedModel === 'claude-opus-5-5' && e2.variant === 'V4'
        && e2.escalation && e2.escalation.source === 'checks' && /## A previous attempt failed/.test(prompt2) && /test-add\.js -> exit 1/.test(prompt2)
        && !/previous attempt/.test(prompt1),
        [bfe && bfe.items, e1 && [e1.stage, e1.verdict], e2 && [e2.stage, e2.verdict, e2.escalation]]);
    const bgreen = run(['batch', '--tasks', 'TX', '--variants', 'V4', '--account', 'testacct'], { FAKE_MODE: 'fix' });
    const bfg = batchDone(bgreen.json && bgreen.json.value && bgreen.json.value.batch, 240);
    const summary = F.summarise(rows().filter((r) => r.variant === 'V4'));
    check('72. a green V4 stage 1 queues nothing, and the frontier reads the two V4 attempts as 2 of 2 with one escalated',
        bfg && bfg.state === 'done' && bfg.items.length === 1 && bfg.items[0].verdict === 'pass'
        && summary.variants.V4 && summary.variants.V4.n === 2 && summary.variants.V4.passes === 2 && summary.variants.V4.escalated === 1,
        [bfg && bfg.items, summary.variants.V4]);
}

// ---------------------------------------------------------------- main
let shas;
try {
    process.stdout.write(`test-frontier: fixtures under ${ROOT}\n`);
    shas = buildSource();
    buildTasks(shas);
    buildHome();
    buildFake();
    unitCases();
    cliCases(shas);
} catch (e) {
    fail++;
    process.stdout.write(`  FAIL the suite threw: ${e.stack}\n`);
} finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* a handle may still be closing */ }
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
