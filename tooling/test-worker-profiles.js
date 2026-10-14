#!/usr/bin/env node
'use strict';
/**
 * test-worker-profiles.js - the tool profiles (worker-profiles.js) as the real
 * launchers apply them, graded on the tool list a stub CLI actually started with.
 *
 * Prints one `ok <check>` or `FAIL <check>` line per check, then the verdict:
 *   required_tools=PASS discovery=PASS actual_init_manifest=PASS hidden_expansion=0
 * A field that did not hold prints FAIL(<what>) or the count. Exit 0 green,
 * 1 red (a crash of the suite included), 2 only when a child could not be
 * spawned or did not end in time.
 *
 * THE STUB CLI. Never the real claude. A `.js` file the launchers run through
 * node. It holds a literal built-in universe, applies --tools and
 * --disallowedTools the way claude 2.1.299 --help documents them (no flag: all,
 * --tools "": none, --tools default: all, --tools <list>: exactly the known names
 * listed, --disallowedTools <list>: all but those), and prints a stream-json
 * system/init line. When ToolSearch is in the set, the deferrable tools in the
 * set are listed as deferred_tools, not loaded. AUTODEV_STUB_SEARCH=<query> prints a
 * tool_search line with the deferred tools matching it. AUTODEV_STUB_HIDE=<name> drops a
 * tool from the init line only: the control that proves the suite reads the
 * init line and not the profile config.
 *
 * required_tools        every kind keeps the tools its task needs. The lists
 *                       below are literals, never read from worker-profiles.js.
 * discovery             a deferred tool is absent from the boot list and still found
 *                       through ToolSearch.
 * actual_init_manifest  every run's manifest came from the stub's own output, and
 *                       it equals the profile exactly.
 * hidden_expansion      tools in the started manifests that no profile named.
 *                       The old --disallowedTools argv is run as a control that
 *                       must show expansion, so a zero means something.
 */
process.env.AUTODEV_CAPACITY = 'off';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const HW = path.join(SCRIPTS, 'headless-worker.js');
const profiles = require(path.join(SCRIPTS, 'worker-profiles.js'));
const bj = require(path.join(SCRIPTS, 'brain-judge.js'));
const hw = require(HW);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles test-'));
const HOME = path.join(ROOT, 'home');
const STUB = path.join(ROOT, 'stub claude.js');

// The stub's universe. LOADED tools are always at boot; DEFERRABLE ones defer when ToolSearch is on.
const LOADED = ['Agent', 'Artifact', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'Read', 'Skill', 'TodoWrite', 'ToolSearch', 'Workflow', 'Write'];
const DEFERRABLE = ['ArtifactComments', 'ArtifactData', 'CronCreate', 'EnterWorktree', 'ExitWorktree', 'Monitor', 'NotebookEdit', 'TaskStop', 'WebFetch', 'WebSearch'];
// What each kind's task cannot do without. Literals on purpose.
const REQUIRED = {
    builder: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'ToolSearch', 'Write'],
    judge: [],
    probe: [],
};

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); };
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

fs.mkdirSync(HOME, { recursive: true });
write(STUB, [
    "'use strict';",
    'setTimeout(() => process.exit(97), 15000);',
    `const LOADED = ${JSON.stringify(LOADED)};`,
    `const DEFERRABLE = ${JSON.stringify(DEFERRABLE)};`,
    'const ALL = [...LOADED, ...DEFERRABLE];',
    'const argv = process.argv.slice(2);',
    'const after = (f) => { const i = argv.indexOf(f); return i < 0 ? null : argv[i + 1]; };',
    'const list = (v) => String(v).split(/[\\s,]+/).filter(Boolean);',
    "let set = ALL.slice();",
    "const tools = after('--tools');",
    "if (tools !== null) set = tools === '' ? [] : tools === 'default' ? ALL.slice() : ALL.filter((t) => list(tools).includes(t));",
    "const denied = after('--disallowedTools');",
    'if (denied !== null) set = set.filter((t) => !list(denied).includes(t));',
    "const search = set.includes('ToolSearch');",
    'let loaded = set.filter((t) => !search || !DEFERRABLE.includes(t));',
    'const deferred = search ? set.filter((t) => DEFERRABLE.includes(t)) : [];',
    'if (process.env.AUTODEV_STUB_HIDE) loaded = loaded.filter((t) => t !== process.env.AUTODEV_STUB_HIDE);',
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', tools: loaded, deferred_tools: deferred }) + '\\n');",
    'if (process.env.AUTODEV_STUB_SEARCH) {',
    '    const q = process.env.AUTODEV_STUB_SEARCH.toLowerCase();',
    "    process.stdout.write(JSON.stringify({ type: 'tool_search', query: q, matches: search ? deferred.filter((t) => t.toLowerCase().includes(q)) : [] }) + '\\n');",
    '}',
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0 }) + '\\n');",
    'process.exit(0);',
].join('\n') + '\n');

let failed = 0;
let infra = 0;
const started = [];
function check(name, ok, detail) {
    if (!ok) failed++;
    console.log(`${ok ? 'ok' : 'FAIL'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
    return Boolean(ok);
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const env = (extra = {}) => ({ ...process.env, HOME, USERPROFILE: HOME, AUTODEV_CAPACITY: 'off',
    AUTODEV_BUDGET_LEDGER: path.join(ROOT, 'budget.json'), AUTODEV_BUDGET_CONFIG: path.join(ROOT, 'no-config.json'), ...extra });

/** A builder through `headless-worker start --dev`, waited to its exit line. Returns the log text. */
function builderRun(code, promptText, extraArgs = [], extraEnv = {}) {
    const dir = path.join(ROOT, code);
    const prompt = path.join(dir, 'prompt.md');
    const log = path.join(dir, `${code}.log`);
    write(prompt, promptText);
    const r = spawnSync(process.execPath, [HW, 'start', '--code', code, '--prompt-file', prompt, '--log', log, '--claude-bin', STUB,
        '--ledger', path.join(dir, 'workers.json'), '--dev', ...extraArgs], { encoding: 'utf8', cwd: ROOT, env: env(extraEnv), timeout: 60000, windowsHide: true });
    if (r.error) { infra++; console.error(`infrastructure: start ${code} produced no verdict (${r.error.code})`); return { text: '', argv: [] }; }
    let value = null;
    try { value = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()).value; } catch { value = null; }
    if (!value || !value.supervisorPid) { check(`${code}: start spawned a supervisor`, false, String(r.stdout).slice(0, 300)); return { text: '', argv: [] }; }
    started.push(value.supervisorPid);
    const deadline = Date.now() + 20000;
    for (;;) {
        const text = read(log);
        if (text !== null && /^CLAUDE_EXIT=-?\d+\s*$/m.test(text)) return { text, argv: value.record.argv || [] };
        if (Date.now() > deadline) { infra++; console.error(`infrastructure: ${code} did not end within 20 s`); return { text: text || '', argv: [] }; }
        sleep(50);
    }
}
/** A judge or probe argv run through the stub. Returns its stdout. */
function argvRun(label, argv, extraEnv = {}) {
    const plan = hw.spawnPlan(argv);
    const r = spawnSync(plan.command, plan.args, { encoding: 'utf8', cwd: ROOT, env: env(extraEnv), input: 'judge this', timeout: 30000, windowsHide: true });
    if (r.error) { infra++; console.error(`infrastructure: ${label} produced no verdict (${r.error.code})`); return ''; }
    return r.stdout || '';
}
const searchOf = (text) => {
    for (const line of String(text).split(/\r?\n/)) { try { const j = JSON.parse(line); if (j.type === 'tool_search') return j.matches; } catch { /* not JSON */ } }
    return null;
};

function main() {
    const fields = { required_tools: 'PASS', discovery: 'PASS', actual_init_manifest: 'PASS', hidden_expansion: 0 };
    const reqFail = [];
    const discFail = [];
    const manFail = [];
    let hidden = 0;

    const runs = [
        { label: 'builder', kind: 'builder', prompt: 'Read the brief in brief.md and do what it says.\n', keep: [], family: [] },
        { label: 'builder+Artifact', kind: 'builder', prompt: 'Update the board with ArtifactData, then report.\n', keep: [], family: ['Artifact', 'ArtifactComments', 'ArtifactData'] },
        { label: 'builder+Workflow', kind: 'builder', prompt: 'Run the review as a Workflow with two agents.\n', keep: [], family: ['Workflow'] },
        { label: 'builder keep all', kind: 'builder', prompt: 'Follow the usual workflow and ship it.\n', keep: ['all'], family: ['Artifact', 'ArtifactComments', 'ArtifactData', 'Workflow'] },
        { label: 'judge', kind: 'judge' },
        { label: 'probe', kind: 'probe' },
    ];
    for (const run of runs) {
        let text;
        let resolved;
        if (run.kind === 'builder') {
            const keepArgs = run.keep.length ? ['--keep-tools', run.keep.join(',')] : [];
            const out = builderRun(`P-${run.label.replace(/[^A-Za-z]+/g, '-')}`, run.prompt, keepArgs, { AUTODEV_STUB_SEARCH: 'web' });
            text = out.text;
            resolved = profiles.resolve('builder', { prompt: run.prompt, keep: run.keep.includes('all') ? Object.keys(profiles.FAMILIES) : run.keep });
        } else {
            const argv = run.kind === 'judge' ? bj.judgeArgv(STUB, 'claude-opus-4-5') : bj.probeArgv(STUB);
            text = argvRun(run.label, argv);
            resolved = profiles.resolve(run.kind);
        }
        const m = profiles.initManifest(text);
        const g = profiles.grade(m, resolved);
        const need = [...REQUIRED[run.kind], ...(run.family || [])];
        const missing = need.filter((t) => !m.all.includes(t));
        if (!check(`required ${run.label}: the started manifest holds ${need.length ? need.join(', ') : 'nothing required'}`, m.found && missing.length === 0,
            `missing ${missing.join(',')}; manifest ${m.all.join(',')}`)) reqFail.push(run.label);
        if (run.kind !== 'builder' && !check(`required ${run.label}: the run started with no tool at all`, m.found && m.all.length === 0, m.all.join(','))) reqFail.push(run.label);
        if (!check(`manifest ${run.label}: an init line was read from the run's own output and equals the profile exactly`, m.found && g.exact,
            `found=${m.found} hidden=${g.hidden.join(',')} manifest=${m.all.join(',')} profile=${resolved.allowed.join(',')}`)) manFail.push(run.label);
        hidden += g.hidden.length;
        check(`hidden ${run.label}: no tool in the manifest that the profile did not name`, g.hidden.length === 0, g.hidden.join(','));
        if (run.kind === 'builder') {
            const matches = searchOf(text) || [];
            const ok = m.deferred.includes('WebFetch') && !m.tools.includes('WebFetch') && matches.includes('WebFetch') && matches.includes('WebSearch');
            if (!check(`discovery ${run.label}: WebFetch is deferred, not loaded at boot, and ToolSearch finds WebFetch and WebSearch`, ok,
                `loaded=${m.tools.join(',')} deferred=${m.deferred.join(',')} matches=${JSON.stringify(matches)}`)) discFail.push(run.label);
        }
        if (run.label === 'builder+Artifact') {
            // The Artifact family's own deferred member is found the same way.
            const out = builderRun('P-artifact-search', run.prompt, [], { AUTODEV_STUB_SEARCH: 'artifactdata' });
            const matches = searchOf(out.text) || [];
            if (!check('discovery builder+Artifact: ArtifactData is deferred and ToolSearch finds it', matches.includes('ArtifactData'), JSON.stringify(matches))) discFail.push('artifact');
        }
    }

    // Control: the suite grades the init line, not the config. A stub that hides Bash
    // from its init line must turn the builder's required check red.
    {
        const out = builderRun('P-hide-bash', 'Read the brief in brief.md and do what it says.\n', [], { AUTODEV_STUB_HIDE: 'Bash' });
        const m = profiles.initManifest(out.text);
        const g = profiles.grade(m, profiles.resolve('builder'));
        if (!check('control: a stub hiding Bash from its init line reads as Bash missing, so the grade reads the run and not the config',
            m.found && !m.all.includes('Bash') && g.missingRequired.includes('Bash') && !g.exact, JSON.stringify(g))) manFail.push('control-hide');
    }
    // Control: no init line is not a manifest.
    check('control: output with no init line reads as found false', profiles.initManifest('{"type":"result"}\nplain text\n').found === false);
    // Control: the old exclusion argv gets every tool the CLI adds, so the probe can see expansion.
    {
        const old = [STUB, '-p', '--output-format', 'stream-json', '--verbose', '--disallowedTools', 'Artifact,ArtifactComments,ArtifactData,Workflow'];
        const m = profiles.initManifest(argvRun('old exclusion argv', old));
        const g = profiles.grade(m, profiles.resolve('builder'));
        if (!check('control: the old --disallowedTools argv starts with tools no profile named (CronCreate, NotebookEdit and others)',
            m.found && g.hidden.includes('CronCreate') && g.hidden.includes('NotebookEdit') && g.hidden.length >= 5, g.hidden.join(','))) manFail.push('control-expansion');
    }
    // The launchers apply a profile as exactly one --tools and never an exclusion.
    {
        const argv = hw.buildArgv({ claudeBin: STUB, prompt: 'x', model: null, effort: null, permissionMode: 'default', pluginDir: null, keepTools: [], profile: 'builder' });
        const j = bj.judgeArgv(STUB, 'm');
        const p = bj.probeArgv(STUB);
        const one = (a) => a.filter((x) => x === '--tools').length === 1 && !a.includes('--disallowedTools') && !a.includes('--allowedTools');
        if (!check('argv: builder, judge and probe each carry exactly one --tools and no --disallowedTools or --allowedTools', one(argv) && one(j) && one(p),
            JSON.stringify([argv.slice(-4), j.slice(0, 8), p.slice(0, 8)]))) manFail.push('argv');
    }

    if (reqFail.length) fields.required_tools = `FAIL(${[...new Set(reqFail)].join(',')})`;
    if (discFail.length) fields.discovery = `FAIL(${[...new Set(discFail)].join(',')})`;
    if (manFail.length) fields.actual_init_manifest = `FAIL(${[...new Set(manFail)].join(',')})`;
    fields.hidden_expansion = hidden;
    return fields;
}

function cleanup() {
    for (const pid of [...new Set(started)]) {
        if (!pidAlive(pid)) continue;
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a temp dir left behind is not a verdict */ }
}

try {
    const f = main();
    console.log(`required_tools=${f.required_tools} discovery=${f.discovery} actual_init_manifest=${f.actual_init_manifest} hidden_expansion=${f.hidden_expansion}`);
    process.exitCode = infra ? 2 : failed ? 1 : 0;
} catch (e) {
    // A throw here comes from the subject (a missing or broken export), so it is a red verdict, not infrastructure.
    console.error(`test-worker-profiles: ${e.stack || e.message}`);
    console.log('required_tools=ERROR discovery=ERROR actual_init_manifest=ERROR hidden_expansion=ERROR');
    process.exitCode = 1;
} finally {
    cleanup();
}
