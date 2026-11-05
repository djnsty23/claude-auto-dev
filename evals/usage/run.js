#!/usr/bin/env node
'use strict';
// evals/usage/run.js: replay the failure classes mined from our own transcripts
// against a tree of this repo, and say pass or fail by code.
//
// Each case in cases.json names a usage-mine class, the evidence that ranked it
// (counts only, never transcript text), a paraphrased minimal prompt and
// context, and a checker. Two checker kinds:
//   harness  a node module that drives the real script, hook or launcher of the
//            tree under test in a scratch HOME. No model, no tokens, run by
//            default.
//   replay   runs the paraphrased prompt through headless `claude -p` in a
//            scratch directory and grades the stream with usage-mine's own
//            extractor: pass when the case's class does not occur and the
//            case's done-marker does. Costs tokens, so it runs only with
//            --replay, on the model named by --model.
//
//   node evals/usage/run.js [--repo <tree>] [--case <id>] [--json] [--expect-red <id,...>]
//   node evals/usage/run.js --replay [--model claude-haiku-5-5] [--case <id>]
//   node evals/usage/run.js --list
//   node evals/usage/run.js --ignore-known-red     (grade a known-red case as an ordinary one)
//
// --repo defaults to the tree this file sits in. Exit 0 every case run passed,
// 1 a case failed, 2 a case could not run or nothing ran. --expect-red names
// cases that must FAIL (a planted defect, or the old tree in a before/after),
// and inverts their verdict, so a before/after pair is one command each.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const MANIFEST = path.join(HERE, 'cases.json');

function parseArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const [k, v] = a.slice(2).split('=');
        if (v !== undefined) o[k] = v;
        else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
        else o[k] = true;
    }
    return o;
}

function loadCases() {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (!Array.isArray(m.cases) || !m.cases.length) throw new Error('cases.json has no cases');
    return m.cases;
}

/** Grade a replay stream with the miner's extractor: the class must not occur, the done-marker must. */
async function gradeReplay(logFile, c, repo) {
    const { extractFile } = require(path.join(repo, 'plugins', 'autodev-core', 'scripts', 'usage-mine.js'));
    const r = await extractFile(logFile, { dirName: 'replay' });
    const hit = r.events.filter((e) => e.c === c.class || (c.classPrefix && e.c.startsWith(c.classPrefix)));
    const text = fs.readFileSync(logFile, 'utf8');
    const done = c.replay.doneMarker ? new RegExp(c.replay.doneMarker).test(text) : true;
    if (!r.session.results) return { pass: false, indeterminate: true, detail: 'the replay made no tool call, so the class had no chance to occur' };
    // A headless run cannot answer a permission prompt, so a refusal is the environment failing the
    // replay, not the model: grade it could-not-run rather than as the case's verdict.
    const refused = r.events.filter((e) => e.c.startsWith('permission-denied/') && e.c !== c.class);
    if (refused.length && !done) return { pass: false, indeterminate: true, detail: `${refused.length} permission refusal(s) (${refused[0].c}) stopped the replay before its done-marker` };
    // maxEvents allows a class that is legitimate once (a first red test run) and a failure past it.
    const allowed = Number(c.replay.maxEvents || 0);
    if (hit.length > allowed) return { pass: false, detail: `${hit.length} ${c.class} event(s) in the replay, ${allowed} allowed` };
    if (!done) return { pass: false, detail: 'no class event, but the done-marker never appeared: the task was not done' };
    return { pass: true, detail: `0 ${c.class} events over ${r.session.results} tool results, done-marker present` };
}

/** The claude executable. On Windows an npm install is a .cmd shim around an .exe: run the .exe, so no shell sits between. */
function claudeBin() {
    if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
    if (process.platform !== 'win32') return 'claude';
    const where = spawnSync('where', ['claude.cmd'], { encoding: 'utf8', windowsHide: true });
    const shim = (where.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (shim) {
        try {
            const m = /"%dp0%\\([^"]+\.exe)"/i.exec(fs.readFileSync(shim, 'utf8'));
            const exe = m && path.join(path.dirname(shim), m[1]);
            if (exe && fs.existsSync(exe)) return exe;
        } catch { /* fall through to the shim */ }
        return shim;
    }
    return 'claude';
}

async function runReplay(c, repo, model) {
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `usage-replay-${c.id}-`)));
    try {
        for (const [rel, body] of Object.entries(c.replay.files || {})) {
            fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
            fs.writeFileSync(path.join(scratch, rel), body);
        }
        const log = path.join(scratch, 'replay.log');
        // The prompt goes on stdin, never argv: a .cmd shim needs a shell, and cmd reads `<value>` in a prompt as a redirect.
        const args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--max-turns', String(c.replay.maxTurns || 8),
            '--permission-mode', c.replay.permissionMode || 'acceptEdits', '--strict-mcp-config', ...(c.replay.tools ? ['--tools', c.replay.tools.join(',')] : [])];
        const bin = claudeBin();
        const r = spawnSync(bin, args, { cwd: scratch, input: c.prompt, encoding: 'utf8', timeout: 300000, windowsHide: true, shell: /\.(?:cmd|bat)$/i.test(bin) || bin === 'claude' && process.platform === 'win32' });
        fs.writeFileSync(log, r.stdout || '');
        if (r.error || !r.stdout) return { pass: false, indeterminate: true, detail: `claude -p did not run: ${(r.error && r.error.message) || (r.stderr || '').slice(0, 200)}` };
        return await gradeReplay(log, c, repo);
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const cases = loadCases();
    if (o.list) {
        for (const c of cases) console.log(`${c.id.padEnd(28)} ${c.kind.padEnd(8)} ${c.class}`);
        return 0;
    }
    const repo = path.resolve(o.repo || path.join(HERE, '..', '..'));
    const only = typeof o.case === 'string' ? new Set(o.case.split(',')) : null;
    const expectRed = new Set(typeof o['expect-red'] === 'string' ? o['expect-red'].split(',') : []);
    const model = typeof o.model === 'string' ? o.model : 'claude-haiku-5-5';
    const results = [];
    for (const c of cases) {
        if (only && !only.has(c.id)) continue;
        if (c.kind === 'replay' && !o.replay) { results.push({ id: c.id, kind: c.kind, skipped: 'replay: pass --replay to spend tokens on it' }); continue; }
        if (c.kind === 'harness' && o.replay && !only) { results.push({ id: c.id, kind: c.kind, skipped: 'harness case: run without --replay' }); continue; }
        let r;
        try {
            r = c.kind === 'harness' ? await require(path.join(HERE, c.checker)).check({ repo, c }) : await runReplay(c, repo, model);
        } catch (e) {
            r = { pass: false, indeterminate: true, detail: `checker threw: ${String(e && e.message || e).slice(0, 300)}` };
        }
        // A known-red case names the open work that fixes it. It must stay red until that lands, and
        // going green is a failure too: the excuse is stale, so delete knownRed in the same change.
        const want = expectRed.has(c.id) || (c.knownRed && !o['ignore-known-red']) ? 'red' : 'green';
        const ok = !r.indeterminate && (want === 'green' ? r.pass : !r.pass);
        const stale = c.knownRed && want === 'red' && r.pass && !expectRed.has(c.id) ? ` knownRed (${c.knownRed.until}) is stale: delete it from cases.json` : '';
        results.push({ id: c.id, kind: c.kind, class: c.class, want, pass: r.pass, ok, indeterminate: !!r.indeterminate, detail: (r.detail || '') + stale });
    }
    const ran = results.filter((r) => !r.skipped);
    for (const id of expectRed) if (!results.some((r) => r.id === id)) ran.push({ id, ok: false, indeterminate: true, detail: '--expect-red names a case that does not exist' });
    if (o.json) console.log(JSON.stringify({ repo, results }, null, 2));
    else {
        console.log(`usage evals against ${repo}`);
        for (const r of results) {
            if (r.skipped) { console.log(`SKIP  ${r.id}  (${r.skipped})`); continue; }
            const tag = r.indeterminate ? 'COULD NOT RUN' : r.ok ? (r.want === 'red' ? 'RED AS EXPECTED' : 'PASS') : (r.want === 'red' ? 'GREEN, EXPECTED RED' : 'FAIL');
            console.log(`${tag.padEnd(20)} ${r.id}  ${r.detail || ''}`);
        }
        console.log(`${ran.length} ran, ${ran.filter((r) => r.ok).length} as expected, ${ran.filter((r) => !r.ok && !r.indeterminate).length} not, ${ran.filter((r) => r.indeterminate).length} could not run, ${results.length - ran.length} skipped`);
    }
    if (!ran.length || ran.some((r) => r.indeterminate)) return 2;
    return ran.every((r) => r.ok) ? 0 : 1;
}

module.exports = { gradeReplay, loadCases };

if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.error(String(e && e.stack || e)); process.exitCode = 2; });
