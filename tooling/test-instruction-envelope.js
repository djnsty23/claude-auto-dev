#!/usr/bin/env node
// test-instruction-envelope.js - the effective instruction envelope (U15).
//
// Drives plugins/autodev-core/scripts/instruction-envelope.js and its SessionStart hook on
// fixture profiles in a temp dir. Four claims, one summary token each:
//
//   oversize_update     a staged change that pushes the always-on rules over budget is
//                       BLOCKED: preflight exits 1 and apply writes nothing. A change that
//                       fits, and a trim of an already-oversize set, pass (controls).
//   required_rules      a change that drops a required rule is BLOCKED and the rule stays.
//                       Moving it to paths-scoped keeps it discoverable and passes.
//   source_manifest     each loaded source is listed with its exact bytes, paths-scoped
//                       rules are skipped, and the budget defaults to 32000 and is configurable.
//   conflicting_styles  two sources matching the two sides of a declared pair are DETECTED,
//                       with one source matching both, fenced quotes and clean text as controls.
//
// ISOLATION. Nothing here may read or write the real profile. Every fs call this process
// makes is recorded and checked against the real config dir at the end, and every child
// gets HOME, USERPROFILE and CLAUDE_CONFIG_DIR inside the temp dir.
//
// The last line printed is the summary the acceptance names:
//   oversize_update=BLOCKED required_rules=RETAINED source_manifest=PASS conflicting_styles=DETECTED
//
// Run: node tooling/test-instruction-envelope.js

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const sb = require('./spawn-budget.js');

// Captured before any env override, as a path only: never opened.
const REAL_CONFIGS = [...new Set([
    path.resolve(path.join(os.homedir(), '.claude')),
    process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null,
].filter(Boolean))];

// ---------------------------------------------------------------- fs recorder
const touched = [];
for (const name of ['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'writeFileSync', 'mkdirSync', 'rmSync', 'openSync']) {
    const orig = fs[name];
    fs[name] = function recorded(p, ...rest) {
        if (typeof p === 'string' || Buffer.isBuffer(p)) touched.push(path.resolve(String(p)));
        return orig.call(this, p, ...rest);
    };
}

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'instruction-envelope.js');
const HOOK = path.join(ROOT, 'plugins', 'autodev-core', 'hooks', 'instruction-envelope.js');
const env = require(SCRIPT);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-test-')));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });

const groups = { oversize: [], required: [], manifest: [], styles: [], hook: [], isolation: [] };
const check = (group, label, ok, detail) => groups[group].push({ label, ok: Boolean(ok), detail, lost: sb.lostVerdict() });

// ---------------------------------------------------------------- fixtures
let seq = 0;
/** Text of exactly n UTF-8 bytes. */
const bytes = (n, head = '') => {
    const h = head ? head + '\n' : '';
    if (Buffer.byteLength(h) > n) throw new Error('head longer than size');
    return h + 'x'.repeat(n - Buffer.byteLength(h));
};
const scoped = (n) => bytes(n, '---\npaths:\n  - "**/*.tsx"\n---');

function profile({ rules = {}, claude = null, settings = null, config = null, styles = {}, project = null } = {}) {
    const dir = path.join(TMP, `p${++seq}`);
    const cfg = path.join(dir, 'config');
    fs.mkdirSync(path.join(cfg, 'rules'), { recursive: true });
    for (const [n, t] of Object.entries(rules)) fs.writeFileSync(path.join(cfg, 'rules', n), t);
    if (claude !== null) fs.writeFileSync(path.join(cfg, 'CLAUDE.md'), claude);
    if (settings) fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(settings));
    if (config !== null) fs.writeFileSync(path.join(cfg, 'instruction-envelope.json'), typeof config === 'string' ? config : JSON.stringify(config));
    if (Object.keys(styles).length) {
        fs.mkdirSync(path.join(cfg, 'output-styles'));
        for (const [n, t] of Object.entries(styles)) fs.writeFileSync(path.join(cfg, 'output-styles', n), t);
    }
    const proj = path.join(dir, 'project');
    fs.mkdirSync(proj);
    if (project !== null) fs.writeFileSync(path.join(proj, 'CLAUDE.md'), project);
    return { dir, cfg, proj };
}
function incoming(files) {
    const d = path.join(TMP, `in${++seq}`);
    fs.mkdirSync(path.join(d, 'rules'), { recursive: true });
    for (const [rel, t] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), t);
    return d;
}
function snapshot(cfg) {
    const out = {};
    const walk = (d) => {
        for (const n of fs.readdirSync(d)) {
            const p = path.join(d, n);
            if (fs.statSync(p).isDirectory()) walk(p);
            else out[path.relative(cfg, p)] = fs.readFileSync(p).toString('base64');
        }
    };
    walk(cfg);
    return JSON.stringify(out);
}
function childEnv(extra = {}) {
    return { ...process.env, HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), ...extra };
}
// expect: 'exit2' only where the case drives a usage error on purpose.
function cli(args, extraEnv = {}, expect) {
    return sb.runVerdict(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: childEnv(extraEnv), cwd: TMP, timeout: 30000, expect });
}
function hook(extraEnv) {
    return sb.runVerdict(process.execPath, [HOOK], { encoding: 'utf8', input: '{}', env: childEnv(extraEnv), cwd: TMP, timeout: 30000 });
}
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---------------------------------------------------------------- source_manifest
{
    const p = profile({
        rules: { 'a.md': bytes(1000), 'b.md': bytes(2000), 'c.md': bytes(3000, 'body text\npaths: not frontmatter'), 'scoped.md': scoped(5000), 'notes.txt': bytes(9000) },
        claude: bytes(500),
        project: bytes(700),
    });
    const r = env.measureEnvelope({ configDir: p.cfg, projectDir: p.proj });
    const row = (s) => r.manifest.find((m) => m.source === s);
    check('manifest', 'each always-on rule is listed with its exact bytes',
        row('rules/a.md')?.bytes === 1000 && row('rules/b.md')?.bytes === 2000 && row('rules/c.md')?.bytes === 3000, r.manifest);
    check('manifest', '`paths:` in the body, not frontmatter, still loads always-on', row('rules/c.md')?.kind === 'rule');
    check('manifest', 'a paths-scoped rule is skipped, never listed as loaded',
        !row('rules/scoped.md') && JSON.stringify(r.pathsScopedSkipped) === '["rules/scoped.md"]', r.pathsScopedSkipped);
    check('manifest', 'a non-.md file in rules/ is not a source', !r.manifest.some((m) => m.source.includes('notes')));
    check('manifest', 'the user CLAUDE.md and project CLAUDE.md are listed with their bytes',
        row('CLAUDE.md')?.kind === 'user-claude-md' && row('CLAUDE.md')?.bytes === 500 && row('project CLAUDE.md')?.bytes === 700);
    check('manifest', 'the rules set is rules plus user CLAUDE.md (6500), the envelope adds the project (7200)',
        r.rulesTotal === 6500 && r.envelopeTotal === 7200, { rulesTotal: r.rulesTotal, envelopeTotal: r.envelopeTotal });
    check('manifest', 'the budget defaults to 32000', env.DEFAULT_BUDGET === 32000 && r.budget === 32000 && r.over === false);

    const c = cli(['--config-dir', p.cfg, '--project', p.proj, '--json']);
    const j = json(c.stdout);
    check('manifest', 'CLI --json: exit 0 and the same manifest',
        c.status === 0 && j && JSON.stringify(j.manifest) === JSON.stringify(r.manifest), { status: c.status, stderr: c.stderr });
    check('manifest', 'CLI --json carries no file text', j && !c.stdout.includes('xxxxxxxxxx'));
    const t = cli(['--config-dir', p.cfg, '--project', p.proj]);
    check('manifest', 'CLI text names the population', t.status === 0 && /5 sources loaded, 1 paths-scoped skipped, envelope 7200 bytes/.test(t.stdout), t.stdout);

    // Today's measured set: 32,264 bytes against 32,000.
    const over = profile({ rules: { 'big.md': bytes(28228) }, claude: bytes(4036) });
    const ro = env.measureEnvelope({ configDir: over.cfg });
    check('manifest', 'a 32,264-byte set is over the default budget', ro.rulesTotal === 32264 && ro.over === true, ro.rulesTotal);
    check('manifest', 'CLI exits 1 over budget', cli(['--config-dir', over.cfg]).status === 1);
    check('manifest', '--budget 40000 makes it fit (exit 0)', cli(['--config-dir', over.cfg, '--budget', '40000']).status === 0);
    fs.writeFileSync(path.join(over.cfg, 'instruction-envelope.json'), JSON.stringify({ budget: 40000 }));
    check('manifest', 'the config file budget is honoured', env.measureEnvelope({ configDir: over.cfg }).over === false);
    fs.rmSync(path.join(over.cfg, 'instruction-envelope.json'));
    const bigProject = profile({ rules: { 'a.md': bytes(100) }, project: bytes(9000) });
    check('manifest', 'a project CLAUDE.md over its 8192 budget exits 1', cli(['--config-dir', bigProject.cfg, '--project', bigProject.proj]).status === 1);
    check('manifest', 'bad --budget is a usage error (exit 2), not a pass', cli(['--config-dir', p.cfg, '--budget', 'zero'], {}, 'exit2').status === 2);
}

// ---------------------------------------------------------------- oversize_update
{
    const base = profile({ rules: { 'a.md': bytes(15000), 'b.md': bytes(15000) }, claude: bytes(1000) });
    const before = snapshot(base.cfg);
    const grow = incoming({ 'rules/new.md': bytes(2000) });
    const pf = env.preflight({ configDir: base.cfg, incomingDir: grow });
    check('oversize', 'a staged rule that takes 31000 to 33000 bytes is BLOCKED', pf.verdict === 'BLOCKED' && pf.after.rulesTotal === 33000, pf);
    const c = cli(['preflight', '--config-dir', base.cfg, '--incoming', grow]);
    check('oversize', 'CLI preflight exits 1 and says BLOCKED on stderr', c.status === 1 && /BLOCKED: rules set would be 33000 bytes/.test(c.stderr), { status: c.status, stderr: c.stderr });
    const a = cli(['apply', '--config-dir', base.cfg, '--incoming', grow]);
    check('oversize', 'CLI apply exits 1 and writes nothing', a.status === 1 && /nothing written/.test(a.stdout) && snapshot(base.cfg) === before, { status: a.status, stdout: a.stdout });
    const ia = env.apply({ configDir: base.cfg, incomingDir: grow });
    check('oversize', 'apply() refuses in-process too', ia.applied === false && snapshot(base.cfg) === before);

    const fit = incoming({ 'rules/small.md': bytes(500) });
    const okc = cli(['apply', '--config-dir', base.cfg, '--incoming', fit]);
    check('oversize', 'control: a change that fits passes and is applied',
        okc.status === 0 && /PASS/.test(okc.stdout) && fs.existsSync(path.join(base.cfg, 'rules', 'small.md')), { status: okc.status, stdout: okc.stdout, stderr: okc.stderr });

    const over = profile({ rules: { 'a.md': bytes(20000), 'b.md': bytes(12264) } });
    const trim = incoming({ 'rules/b.md': bytes(8000) });
    check('oversize', 'control: a trim of an already-oversize set is not blocked', env.preflight({ configDir: over.cfg, incomingDir: trim }).verdict === 'PASS');
    const growOver = incoming({ 'rules/b.md': bytes(12300) });
    check('oversize', 'growing an already-oversize set is BLOCKED', env.preflight({ configDir: over.cfg, incomingDir: growOver }).verdict === 'BLOCKED');
    check('oversize', 'preflight with nothing staged is a usage error (exit 2)', cli(['preflight', '--config-dir', base.cfg], {}, 'exit2').status === 2);
}

// ---------------------------------------------------------------- required_rules
{
    const p = profile({
        rules: { 'security.md': bytes(1000), 'windows.md': bytes(1000), 'extra.md': bytes(1000) },
        config: { required: ['security.md', 'rules/windows.md'] },
    });
    const before = snapshot(p.cfg);
    const r = env.measureEnvelope({ configDir: p.cfg });
    check('required', 'both declared required rules are present', r.required.declared === 2 && r.required.missing.length === 0, r.required);
    const pf = env.preflight({ configDir: p.cfg, remove: ['rules/security.md'] });
    check('required', 'a trim that drops security.md is BLOCKED by name', pf.verdict === 'BLOCKED' && pf.reasons.some((x) => x.includes('security.md')), pf.reasons);
    const a = cli(['apply', '--config-dir', p.cfg, '--remove', 'rules/security.md']);
    check('required', 'CLI apply exits 1 and the rule stays on disk', a.status === 1 && snapshot(p.cfg) === before, { status: a.status, stderr: a.stderr });
    const moved = incoming({ 'rules/windows.md': scoped(800) });
    check('required', 'control: moving a required rule to paths-scoped keeps it discoverable', env.preflight({ configDir: p.cfg, incomingDir: moved }).verdict === 'PASS');
    check('required', 'control: dropping a rule nobody requires passes', env.preflight({ configDir: p.cfg, remove: ['rules/extra.md'] }).verdict === 'PASS');
    // Its own profile, so a red above cannot leave this control a changed tree to read.
    const q = profile({ rules: { 'security.md': bytes(1000), 'extra.md': bytes(1000) }, config: { required: ['security.md'] } });
    const rm = cli(['apply', '--config-dir', q.cfg, '--remove', 'rules/extra.md']);
    check('required', 'control: CLI apply --remove of an unrequired rule removes it', rm.status === 0
        && !fs.existsSync(path.join(q.cfg, 'rules', 'extra.md')) && fs.existsSync(path.join(q.cfg, 'rules', 'security.md')), { status: rm.status, stderr: rm.stderr });

    const gone = profile({ rules: { 'windows.md': bytes(100) }, config: { required: ['security.md'] } });
    const m = cli(['--config-dir', gone.cfg, '--project', gone.proj]);
    check('required', 'measure exits 1 and names a missing required rule', m.status === 1 && /1 missing \(security\.md\)/.test(m.stdout), m.stdout);
    const h = hook({ CLAUDE_CONFIG_DIR: gone.cfg });
    check('required', 'the hook names the missing rule', h.status === 0 && /required rule missing: security\.md/.test(json(h.stdout)?.systemMessage || ''), h.stdout);
}

// ---------------------------------------------------------------- conflicting_styles
{
    const p = profile({
        rules: { 'explain.md': 'Rules\nAlways give detailed explanations of every change.\n' },
        settings: { outputStyle: 'Concise' },
    });
    const before = snapshot(p.cfg);
    const r = env.measureEnvelope({ configDir: p.cfg });
    const c = r.conflicts.find((x) => x.id === 'brevity-vs-length');
    check('styles', 'a Concise output style beside a long-explanations rule is DETECTED',
        c && c.a.source === 'settings.json outputStyle' && c.b.source === 'rules/explain.md' && c.b.line === 2, r.conflicts);
    const m = cli(['--config-dir', p.cfg, '--project', p.proj]);
    check('styles', 'detection only: measure exit stays 0 and prints DETECTED', m.status === 0 && /1 of 4 declared pairs DETECTED/.test(m.stdout), m.stdout);
    check('styles', 'detection only: no source is modified', snapshot(p.cfg) === before);

    const f = profile({
        rules: { 'explain.md': 'Explain everything in detail.\n' },
        settings: { outputStyle: 'Terse' },
        styles: { 'terse.md': '---\nname: Terse\n---\nBe brief.\n' },
    });
    const rf = env.measureEnvelope({ configDir: f.cfg });
    check('styles', 'an output-style file is a source with its bytes', rf.conflicts[0]?.a.source === 'output-styles/terse.md'
        && rf.manifest.some((x) => x.kind === 'output-style' && x.bytes > 0), rf.conflicts);

    const same = profile({ claude: 'Be concise.\nGive detailed explanations when asked.\n' });
    check('styles', 'control: one source holding both sides is not a two-source conflict', env.measureEnvelope({ configDir: same.cfg }).conflicts.length === 0);
    const fenced = profile({ rules: { 'q.md': 'Banned forms:\n```\nalways use emoji\n```\n' }, claude: 'Never use emoji.\n' });
    check('styles', 'control: a directive inside a code fence is a quote, not a directive', env.measureEnvelope({ configDir: fenced.cfg }).conflicts.length === 0);
    const clean = profile({ rules: { 'w.md': 'One idea per sentence.\n' }, settings: { outputStyle: 'Concise' } });
    check('styles', 'control: clean text beside Concise is clear', env.measureEnvelope({ configDir: clean.cfg }).conflicts.length === 0);

    const samples = {
        'brevity-vs-length': ['Keep responses short.', 'Write lengthy answers.'],
        'prose-vs-lists': ['No bullet points.', 'Always use bullet points.'],
        headings: ['Never use headings.', 'Always use markdown headings.'],
        emoji: ['No emoji.', 'Always add emoji.'],
    };
    for (const pair of env.STYLE_CONFLICTS) {
        const [a, b] = samples[pair.id] || ['', ''];
        const found = env.detectConflicts([{ source: 'x', text: a }, { source: 'y', text: b }]);
        check('styles', `declared pair ${pair.id} fires on its fixture`, found.some((x) => x.id === pair.id), found);
    }
    const h = hook({ CLAUDE_CONFIG_DIR: p.cfg });
    check('styles', 'the hook names the conflict without blocking', h.status === 0 && /conflicting styles/.test(json(h.stdout)?.systemMessage || ''), h.stdout);
}

// ---------------------------------------------------------------- the hook
{
    const healthy = profile({ rules: { 'a.md': bytes(1000) }, claude: bytes(100) });
    const h = hook({ CLAUDE_CONFIG_DIR: healthy.cfg });
    check('hook', 'healthy: zero bytes on stdout and stderr, exit 0', h.status === 0 && h.stdout === '' && h.stderr === '', { stdout: h.stdout, stderr: h.stderr });
    const over = profile({ rules: { 'big.md': bytes(33000) } });
    const o = hook({ CLAUDE_CONFIG_DIR: over.cfg });
    const msg = json(o.stdout)?.systemMessage || '';
    check('hook', 'over budget: one systemMessage, exit 0', o.status === 0 && /33000 bytes, over the 32000 budget/.test(msg) && o.stderr === '', o.stdout);
    const off = hook({ CLAUDE_CONFIG_DIR: over.cfg, CLAUDE_PLUGIN_OPTION_INSTRUCTION_ENVELOPE: 'false' });
    check('hook', 'switched off: silent even when over', off.status === 0 && off.stdout === '' && off.stderr === '');
    const broken = profile({ rules: { 'big.md': bytes(33000) }, config: '{not json' });
    const b = hook({ CLAUDE_CONFIG_DIR: broken.cfg });
    check('hook', 'an unreadable config: exit 0, nothing on stderr', b.status === 0 && b.stderr === '', b.stderr);
    const cliHook = cli(['--hook'], { CLAUDE_CONFIG_DIR: healthy.cfg });
    check('hook', 'CLI --hook is silent on a healthy profile', cliHook.status === 0 && cliHook.stdout === '' && cliHook.stderr === '');
}

// ---------------------------------------------------------------- isolation
{
    const c = cli(['--json'], { CLAUDE_CONFIG_DIR: path.join(HOME, '.claude') });
    const j = json(c.stdout);
    check('isolation', 'a child with no --config-dir resolves the temp profile, not the real one',
        j && path.resolve(j.configDir).startsWith(TMP), j && j.configDir);
    const inside = (p, root) => p === root || p.startsWith(root + path.sep);
    const leaks = touched.filter((p) => REAL_CONFIGS.some((r) => inside(p, r)));
    check('isolation', `no fs call in this process touched the real profile (${touched.length} calls recorded)`,
        touched.length > 50 && leaks.length === 0, leaks.slice(0, 5));
    check('isolation', 'every fixture path lives in the temp dir', !REAL_CONFIGS.some((r) => inside(TMP, r)));
}

// ---------------------------------------------------------------- verdict
let pass = 0;
let fail = 0;
let skipped = 0;
const groupOk = {};
for (const [g, cases] of Object.entries(groups)) {
    groupOk[g] = cases.length > 0;
    for (const c of cases) {
        if (c.lost) { skipped++; groupOk[g] = false; console.log(`SKIP  [${g}] ${c.label}  (not graded: ${c.lost})`); continue; }
        console.log(`${c.ok ? 'PASS' : 'FAIL'}  [${g}] ${c.label}${c.ok || c.detail === undefined ? '' : '  ' + JSON.stringify(c.detail).slice(0, 400)}`);
        if (c.ok) pass++; else { fail++; groupOk[g] = false; }
    }
}
const lost = sb.lostVerdict();
console.log(`\n${sb.tally(pass, fail, lost ? 1 : 0)}`);
if (lost) console.log(`INDETERMINATE: ${lost}. The ${skipped} cases after it were not graded.`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* suite-tmp removes the sandbox */ }
// The hook and isolation groups gate every token: a token is only as good as its harness.
const base = groupOk.hook && groupOk.isolation;
console.log([
    `oversize_update=${base && groupOk.oversize ? 'BLOCKED' : 'NOT_BLOCKED'}`,
    `required_rules=${base && groupOk.required ? 'RETAINED' : 'FAIL'}`,
    `source_manifest=${base && groupOk.manifest ? 'PASS' : 'FAIL'}`,
    `conflicting_styles=${base && groupOk.styles ? 'DETECTED' : 'MISSED'}`,
].join(' '));
process.exitCode = sb.exitCode(fail, lost ? 1 : 0);
