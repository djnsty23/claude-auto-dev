#!/usr/bin/env node
'use strict';
/**
 * test-model-tiers.js - the model tiers: worker-profiles.js TIERS and tierFor,
 * execution-budget.js per-tier ceilings, and work-cost.js --tier-line.
 *
 * What must hold:
 *   T1  TIERS names the reviewer command env var, sonnet for builder, opus for escalation/plan/ship
 *   T2  tierFor resolves a tier name and a profile kind, and refuses anything else (no default tier)
 *   T3  execution-budget's tier names are worker-profiles' tier names
 *   T4  EXISTING DEFAULTS ARE UNCHANGED: with no tier, ceilingsFor gives the literals below
 *   T5  a tier only tightens: per key the smaller of the kind's and the tier's ceiling
 *   T6  config overrides tiers; a bad tier value refuses every reservation; a tier cannot loosen a kind
 *   T7  reserve with a tier holds the tightened ceilings and records the tier; an unknown tier is refused
 *       and reserves nothing; no tier leaves the attempt record without a tier field
 *   T8  work-cost --tier-line prints ONE line per tier group, for a merged PR, for an open PR, and
 *       for every merged PR; an unknown PR is exit 2, never a zero; the reviewer figure comes from receipts
 *
 * Expected dollars are hand-computed from the published rates (Opus 5 $25 and Sonnet 5 $10 and
 * Haiku 4.5 $5 per MTok of output), not read from quota-burn.js.
 *
 * Run: node tooling/test-model-tiers.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const profiles = require(path.join(SCRIPTS, 'worker-profiles.js'));
const budget = require(path.join(SCRIPTS, 'execution-budget.js'));
const WORK_COST = path.join(SCRIPTS, 'work-cost.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tiers-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 400) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const MIB = 1024 * 1024;
const HOUR = 3600 * 1000;

try {
    // T1
    check('T1 the reviewer tier names AUTODEV_REVIEWER_CMD and no Claude model',
        eq(profiles.TIERS.reviewer, { cmdEnv: 'AUTODEV_REVIEWER_CMD' }), JSON.stringify(profiles.TIERS.reviewer));
    check('T1 builder is sonnet', eq(profiles.TIERS.builder, { model: 'sonnet' }));
    for (const t of ['escalation', 'plan', 'ship']) check(`T1 ${t} is opus`, eq(profiles.TIERS[t], { model: 'opus' }));
    check('T1 the tier list is exactly the five tiers', eq(Object.keys(profiles.TIERS).sort(), ['builder', 'escalation', 'plan', 'reviewer', 'ship']));
    check('T1 TIERS is frozen, entries too', Object.isFrozen(profiles.TIERS) && Object.isFrozen(profiles.TIERS.builder));

    // T2
    check('T2 a tier name resolves to itself', eq(profiles.tierFor('ship'), { tier: 'ship', model: 'opus', cmdEnv: null }));
    check('T2 reviewer resolves to the command env var', eq(profiles.tierFor('reviewer'), { tier: 'reviewer', model: null, cmdEnv: 'AUTODEV_REVIEWER_CMD' }));
    check('T2 the builder profile kind is the builder tier', profiles.tierFor('builder').tier === 'builder' && profiles.tierFor('builder').model === 'sonnet');
    check('T2 the in-house review profile is the escalation tier (opus), not the cheap reviewer', profiles.tierFor('review').tier === 'escalation');
    check('T2 judge is escalation, probe is builder', profiles.tierFor('judge').tier === 'escalation' && profiles.tierFor('probe').tier === 'builder');
    for (const bad of ['nope', '', undefined, null, 'constructor', '__proto__', 'toString', 'Builder']) {
        let code = null;
        try { profiles.tierFor(bad); } catch (e) { code = e.publicCode || e.message; }
        check(`T2 tierFor(${JSON.stringify(bad)}) throws usage`, code === 'usage', code);
    }

    // T3
    check('T3 execution-budget TIER_NAMES equals worker-profiles TIERS keys', eq(budget.TIER_NAMES, Object.keys(profiles.TIERS)), budget.TIER_NAMES.join(','));

    // T4: literals, never read from the module.
    const NO_CFG = { AUTODEV_BUDGET_CONFIG: path.join(ROOT, 'absent.json') };
    check('T4 worker defaults are unchanged', eq(budget.ceilingsFor('worker', NO_CFG), { maxTurns: 500, wallMs: 6 * HOUR, outputBytes: 64 * MIB, maxUsd: 40 }), JSON.stringify(budget.ceilingsFor('worker', NO_CFG)));
    check('T4 judge defaults are unchanged', eq(budget.ceilingsFor('judge', NO_CFG), { maxTurns: 4, wallMs: 120000, outputBytes: 16 * MIB, maxUsd: 0.5 }));
    check('T4 window defaults are unchanged', eq(budget.DEFAULTS.window, { ms: 24 * HOUR, billedUsd: 100, subscriptionTurns: 10000 }));
    check('T4 a null and an undefined tier are "no tier"', eq(budget.ceilingsFor('worker', NO_CFG, null), budget.ceilingsFor('worker', NO_CFG, undefined)) && budget.ceilingsFor('worker', NO_CFG, null).maxTurns === 500);

    // T5
    check('T5 worker + reviewer = the reviewer ceilings (all smaller)',
        eq(budget.ceilingsFor('worker', NO_CFG, 'reviewer'), { maxTurns: 30, wallMs: 15 * 60000, outputBytes: 16 * MIB, maxUsd: 2 }), JSON.stringify(budget.ceilingsFor('worker', NO_CFG, 'reviewer')));
    check('T5 worker + builder = the worker ceilings', eq(budget.ceilingsFor('worker', NO_CFG, 'builder'), budget.ceilingsFor('worker', NO_CFG)));
    check('T5 worker + escalation', eq(budget.ceilingsFor('worker', NO_CFG, 'escalation'), { maxTurns: 120, wallMs: HOUR, outputBytes: 32 * MIB, maxUsd: 10 }));
    check('T5 judge + ship never loosens the judge (4 turns, 120 s, 16 MiB, $0.5)', eq(budget.ceilingsFor('judge', NO_CFG, 'ship'), { maxTurns: 4, wallMs: 120000, outputBytes: 16 * MIB, maxUsd: 0.5 }));
    let unknownThrew = false;
    try { budget.ceilingsFor('worker', NO_CFG, 'no-such-tier'); } catch { unknownThrew = true; }
    check('T5 an unknown tier throws', unknownThrew);
    check('T5 tierCeilingsFor gives the tier on its own', eq(budget.tierCeilingsFor('plan', NO_CFG), { maxTurns: 80, wallMs: 45 * 60000, outputBytes: 32 * MIB, maxUsd: 8 }));

    // T6
    const cfg = (name, body) => { const f = path.join(ROOT, name); fs.writeFileSync(f, JSON.stringify(body)); return { AUTODEV_BUDGET_CONFIG: f, AUTODEV_BUDGET_LEDGER: path.join(ROOT, name + '.ledger.json') }; };
    const tight = cfg('tight.json', { tiers: { reviewer: { maxTurns: 7, maxUsd: 0.25 } } });
    check('T6 a config overrides one tier key and leaves the others', eq(budget.ceilingsFor('worker', tight, 'reviewer'), { maxTurns: 7, wallMs: 15 * 60000, outputBytes: 16 * MIB, maxUsd: 0.25 }));
    const loose = cfg('loose.json', { tiers: { reviewer: { maxTurns: 99999 } } });
    check('T6 a tier config above the kind ceiling cannot loosen it', budget.ceilingsFor('worker', loose, 'reviewer').maxTurns === 500 && budget.ceilingsFor('judge', loose, 'reviewer').maxTurns === 4);
    const bad = cfg('bad.json', { tiers: { ship: { wallMs: 'soon' } } });
    check('T6 a bad tier value makes the config unreadable', budget.loadConfig(bad).config === null && /tiers\.ship\.wallMs/.test(budget.loadConfig(bad).why), budget.loadConfig(bad).why);
    const refused = budget.reserve({ attemptId: 'T6-bad', kind: 'worker' }, { env: bad, ledger: bad.AUTODEV_BUDGET_LEDGER });
    check('T6 a bad tier config refuses every reservation, tiered or not', refused.ok === false && refused.code === 'config-unreadable', JSON.stringify(refused));
    check('T6 the default config carries all five tiers', eq(Object.keys(budget.loadConfig(NO_CFG).config.tiers).sort(), ['builder', 'escalation', 'plan', 'reviewer', 'ship']));

    // T7
    {
        const env = cfg('t7.json', {});
        const ledger = env.AUTODEV_BUDGET_LEDGER;
        const r = budget.reserve({ attemptId: 'T7-reviewer', kind: 'worker', tier: 'reviewer' }, { env, ledger });
        check('T7 a tiered reservation is granted', r.ok === true, JSON.stringify(r));
        check('T7 it holds the tightened ceilings and reserves the tier turns', eq(r.attempt.ceilings, { maxTurns: 30, wallMs: 15 * 60000, outputBytes: 16 * MIB, maxUsd: 2 }) && r.attempt.reserved.turns === 30, JSON.stringify(r.attempt));
        check('T7 the attempt records its tier', r.attempt.tier === 'reviewer');
        const plain = budget.reserve({ attemptId: 'T7-plain', kind: 'worker' }, { env, ledger });
        check('T7 an attempt with no tier keeps the worker ceilings and has no tier field', plain.ok && plain.attempt.ceilings.maxTurns === 500 && plain.attempt.reserved.turns === 500 && !('tier' in plain.attempt), JSON.stringify(plain.attempt));
        const before = fs.readFileSync(ledger, 'utf8');
        const unknown = budget.reserve({ attemptId: 'T7-unknown', kind: 'worker', tier: 'no-such-tier' }, { env, ledger });
        check('T7 an unknown tier is a usage refusal', unknown.ok === false && unknown.code === 'usage' && /no-such-tier/.test(unknown.why), JSON.stringify(unknown));
        check('T7 and it reserved nothing', fs.readFileSync(ledger, 'utf8') === before && !before.includes('T7-unknown'));
        check('T7 the same attempt id is still refused as a restart', budget.reserve({ attemptId: 'T7-reviewer', kind: 'worker', tier: 'reviewer' }, { env, ledger }).code === 'attempt-restart');
        // The smaller reservation is what the window is charged.
        const small = cfg('t7b.json', { window: { subscriptionTurns: 100 } });
        const a = budget.reserve({ attemptId: 'T7b-1', kind: 'worker', tier: 'reviewer' }, { env: small, ledger: small.AUTODEV_BUDGET_LEDGER });
        const b = budget.reserve({ attemptId: 'T7b-2', kind: 'worker', tier: 'reviewer' }, { env: small, ledger: small.AUTODEV_BUDGET_LEDGER });
        const c = budget.reserve({ attemptId: 'T7b-3', kind: 'worker' }, { env: small, ledger: small.AUTODEV_BUDGET_LEDGER });
        check('T7 two reviewer attempts (30 turns each) fit a 100-turn window, a 500-turn worker does not', a.ok && b.ok && c.ok === false && c.code === 'window-exhausted', JSON.stringify([a.ok, b.ok, c]));
    }

    // T8
    {
        const repoDir = path.join(ROOT, 'widgets');
        fs.mkdirSync(repoDir, { recursive: true });
        const git = (args) => spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
        git(['init', '-q']);
        git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
        const ghStub = path.join(ROOT, 'gh-stub.js');
        const ghData = { 'acme/widgets': [{ number: 11, headRefName: 'feat/a', mergedAt: new Date(Date.now() - 5 * HOUR).toISOString(), title: 'feat: a', url: 'https://github.com/acme/widgets/pull/11' }] };
        fs.writeFileSync(ghStub, `process.stdout.write(${JSON.stringify(JSON.stringify(ghData['acme/widgets']))});`);
        const at = new Date(Date.now() - 2 * HOUR).toISOString();
        const usage = (session, id, model, out) => ({ type: 'assistant', sessionId: session, cwd: repoDir, timestamp: at, requestId: 'r' + id, message: { id, model, role: 'assistant', usage: { output_tokens: out }, content: [{ type: 'text', text: 'x' }] } });
        const bash = (session, tool, command) => ({ type: 'assistant', sessionId: session, cwd: repoDir, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command } }] } });
        const res = (session, tool, text) => ({ type: 'user', sessionId: session, cwd: repoDir, timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: text }] } });
        const cfgDir = path.join(ROOT, 'cfg');
        const rows = {
            'proj/S1.jsonl': [
                bash('S1', 'c1', 'gh pr create --title a'), res('S1', 'c1', 'https://github.com/acme/widgets/pull/11\n'),
                usage('S1', 'a', 'claude-sonnet-5', 100000), usage('S1', 'b', 'claude-opus-5', 100000), usage('S1', 'c', 'claude-haiku-4-5', 100000),
            ],
            // An OPEN pull request: created by a session, absent from the merged list.
            'proj/S2.jsonl': [
                bash('S2', 'c2', 'gh pr create --title b'), res('S2', 'c2', 'https://github.com/acme/widgets/pull/99\n'),
                usage('S2', 'd', 'claude-opus-5', 40000),
            ],
        };
        for (const [rel, list] of Object.entries(rows)) {
            const f = path.join(cfgDir, 'projects', rel);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, list.map((r) => JSON.stringify(r)).join('\n') + '\n');
        }
        const receipts = path.join(ROOT, 'receipts');
        fs.mkdirSync(receipts);
        const rec = (name, o) => fs.writeFileSync(path.join(receipts, name), JSON.stringify({ schema: 1, verdict: 'approve', ...o }));
        rec('a.json', { repo: 'acme/widgets', pr: 11, est_cost: 0.04 });
        rec('b.json', { repo: 'Acme/Widgets', pr: 11, est_cost: 0.02 });
        rec('c.json', { repo: 'acme/widgets', pr: 99, est_cost: null });
        rec('d.json', { repo: 'acme/other', pr: 11, est_cost: 5 });
        fs.writeFileSync(path.join(receipts, 'e.json'), JSON.stringify({ unrelated: true, est_cost: 100 }));
        fs.writeFileSync(path.join(receipts, 'f.json'), 'not json');

        const run = (args) => spawnSync(process.execPath, [WORK_COST, ...args, '--sessions-dir', path.join(ROOT, 'no-sessions')], {
            encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir, WORK_COST_GH: ghStub },
        });
        let r = run(['--tier-line', '--pr', 'acme/widgets#11', '--receipts', receipts]);
        const want = 'Cost by tier (list-price equivalent, not a bill; acme/widgets#11, 1 session(s)): builder (sonnet) $1.00, escalation/plan/ship (opus) $2.50, other models $0.50, reviewer (external) $0.06 over 2 review(s)';
        check('T8 a merged PR: one line, each tier group priced', r.status === 0 && r.stdout.trim() === want, JSON.stringify([r.status, r.stdout, r.stderr]));
        check('T8 it is ONE line', r.stdout.trim().split('\n').length === 1);
        r = run(['--tier-line', '--pr', 'acme/widgets#99', '--receipts', receipts]);
        check('T8 an open PR is priced from its linked session, and its receipt without a cost reads n/a', r.status === 0
            && /acme\/widgets#99, 1 session\(s\)\)/.test(r.stdout) && /builder \(sonnet\) \$0\.00/.test(r.stdout) && /escalation\/plan\/ship \(opus\) \$1\.00/.test(r.stdout)
            && /reviewer \(external\) n\/a \(1 receipt\(s\), none with a cost\)/.test(r.stdout), r.stdout + r.stderr);
        r = run(['--tier-line', '--pr', 'acme/widgets#11']);
        check('T8 without --receipts the reviewer figure says nothing was read', /reviewer \(external\) n\/a \(no receipts read\)/.test(r.stdout), r.stdout);
        r = run(['--tier-line', '--pr', 'acme/widgets#12345']);
        check('T8 a PR no session is linked to is exit 2, never a $0 line', r.status === 2 && r.stdout === '' && /no session is linked/.test(r.stderr), JSON.stringify([r.status, r.stdout, r.stderr]));
        r = run(['--tier-line', '--pr', 'not-a-key']);
        check('T8 a malformed --pr is exit 2', r.status === 2, r.status);
        r = run(['--tier-line']);
        check('T8 with no --pr it sums the merged PRs in the span', r.status === 0 && /1 merged PR\(s\), last 7 day\(s\)\): builder \(sonnet\) \$1\.00, escalation\/plan\/ship \(opus\) \$2\.50, other models \$0\.50/.test(r.stdout), r.stdout + r.stderr);
        r = run(['--json']);
        let j = null; try { j = JSON.parse(r.stdout); } catch { /* null */ }
        check('T8 the JSON carries the groups, and the PR carries byTier', j && j.tiers && eq(j.tiers.groups.map((g) => g.id), ['sonnet', 'opus']) && j.prs.find((p) => p.number === 11).byTier.opus === 2.5, r.stdout.slice(0, 300));
    }
} catch (e) {
    failures.push('suite crashed: ' + (e && e.stack || e));
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
for (const f of failures) console.log('FAIL ' + f);
console.log(`test-model-tiers: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
