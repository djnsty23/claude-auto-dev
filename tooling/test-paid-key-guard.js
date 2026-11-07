#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/paid-key-guard.js: refuse a launch whose
// environment would bill a paid API key. The launchers that call it have their own
// cases (test-headless-worker.js 34, test-unattended-queue.js, test-brain-judge.js,
// test-judge-panel.js) and the reviewer's are in test-cheap-review.js.
// Run: node tooling/test-paid-key-guard.js
// Exits 1 on any failure, 0 when all pass.
//
// The CLI runs as a subprocess with a minimal env, so the developer's own shell
// (which may hold a real key) never decides a verdict. In-process cases pass the env
// object explicitly; the one that reads process.env sets and removes its own name.

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'paid-key-guard.js');
const g = require(SUBJECT);

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`);
}

const CANARY = 'canary-value-must-never-print';
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ---- the list --------------------------------------------------------------
const EXPECTED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_BEARER_TOKEN_BEDROCK'];
check('PAID_KEYS is the exported list of the eight names', JSON.stringify([...g.PAID_KEYS].sort()) === JSON.stringify([...EXPECTED].sort()) && Object.isFrozen(g.PAID_KEYS));

// ---- paidKeysIn ------------------------------------------------------------
for (const n of EXPECTED) check(`paidKeysIn finds ${n}`, JSON.stringify(g.paidKeysIn({ [n]: 'x', PATH: 'p' })) === JSON.stringify([n]));
check('paidKeysIn is empty for a clean env, null and undefined', g.paidKeysIn({ PATH: 'p', HOME: 'h' }).length === 0 && g.paidKeysIn(null).length === 0 && g.paidKeysIn(undefined).length === 0);
check('an empty, blank or "0" value is not a key', g.paidKeysIn({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '   ', CLAUDE_CODE_USE_BEDROCK: '0', GEMINI_API_KEY: undefined, GOOGLE_API_KEY: 5 }).length === 0);
check('names compare case-insensitively and are returned as the env spells them', JSON.stringify(g.paidKeysIn({ Anthropic_Api_Key: 'x' })) === JSON.stringify(['Anthropic_Api_Key']));
check('paidKeysIn returns names sorted, never values', JSON.stringify(g.paidKeysIn({ OPENAI_API_KEY: CANARY, ANTHROPIC_API_KEY: CANARY })) === JSON.stringify(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']));
check('AUTODEV_PAID_KEY_NAMES in the env extends the list; a malformed name in it is ignored',
    JSON.stringify(g.paidKeysIn({ AUTODEV_PAID_KEY_NAMES: 'MY_SERVICE_KEY, bad name,1BAD', MY_SERVICE_KEY: 'x', OTHER: 'y' })) === JSON.stringify(['MY_SERVICE_KEY']));
{
    process.env.AUTODEV_PAID_KEY_NAMES = 'PROC_EXTENDED_KEY';
    const found = g.paidKeysIn({ PROC_EXTENDED_KEY: 'x' });
    delete process.env.AUTODEV_PAID_KEY_NAMES;
    check('AUTODEV_PAID_KEY_NAMES in this process extends the list for an env checked on its behalf', JSON.stringify(found) === JSON.stringify(['PROC_EXTENDED_KEY']));
    check('and the extension is gone once removed', g.paidKeysIn({ PROC_EXTENDED_KEY: 'x' }).length === 0);
}

// ---- assertSubscriptionEnv -------------------------------------------------
check('assertSubscriptionEnv passes a clean env', throws(() => g.assertSubscriptionEnv({ PATH: 'p' })) === null);
{
    const e = throws(() => g.assertSubscriptionEnv({ ANTHROPIC_API_KEY: CANARY, PATH: 'p' }));
    check('a paid key throws with publicCode paid-key-refused', e && e.publicCode === 'paid-key-refused', e && e.message);
    check('the message names the variable and the opt-in, and never the value', e && /ANTHROPIC_API_KEY/.test(e.message) && /AUTODEV_ALLOW_PAID_KEY=1/.test(e.message) && !e.message.includes(CANARY));
    const two = throws(() => g.assertSubscriptionEnv({ ANTHROPIC_API_KEY: CANARY, GEMINI_API_KEY: CANARY }));
    check('two keys are both named', two && /ANTHROPIC_API_KEY/.test(two.message) && /GEMINI_API_KEY/.test(two.message) && !two.message.includes(CANARY));
}
check('allow: true lets every paid name through', throws(() => g.assertSubscriptionEnv({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' }, { allow: true })) === null);
check('allow: an array allows only the names it lists',
    throws(() => g.assertSubscriptionEnv({ GEMINI_API_KEY: 'x' }, { allow: ['gemini_api_key'] })) === null
    && (throws(() => g.assertSubscriptionEnv({ GEMINI_API_KEY: 'x', OPENAI_API_KEY: 'y' }, { allow: ['GEMINI_API_KEY'] })) || {}).publicCode === 'paid-key-refused');
check('allow: a truthy non-true value (1, "1", "true") does not allow', ['1', 1, 'true', {}].every((a) => (throws(() => g.assertSubscriptionEnv({ ANTHROPIC_API_KEY: 'x' }, { allow: a })) || {}).publicCode === 'paid-key-refused'));
check('the default is to refuse', (throws(() => g.assertSubscriptionEnv({ CLAUDE_CODE_USE_VERTEX: '1' })) || {}).publicCode === 'paid-key-refused');

// ---- allowedByEnv and stripPaidKeys ---------------------------------------------
check('allowedByEnv is true only for exactly "1"', g.allowedByEnv({ AUTODEV_ALLOW_PAID_KEY: '1' }) === true
    && ['true', '0', '', 'yes', ' 1'].every((v) => g.allowedByEnv({ AUTODEV_ALLOW_PAID_KEY: v }) === false) && g.allowedByEnv({}) === false && g.allowedByEnv(null) === false);
{
    const src = { PATH: 'p', ANTHROPIC_API_KEY: CANARY, openai_api_key: CANARY, CLAUDE_CODE_USE_BEDROCK: '0', KEEP: 'k' };
    const out = g.stripPaidKeys(src);
    check('stripPaidKeys drops the paid names (any case) and keeps the rest', !('ANTHROPIC_API_KEY' in out) && !('openai_api_key' in out) && out.PATH === 'p' && out.KEEP === 'k' && out.CLAUDE_CODE_USE_BEDROCK === '0');
    check('stripPaidKeys returns a copy and leaves its input alone', src.ANTHROPIC_API_KEY === CANARY && out !== src);
}

// ---- the CLI, as a subprocess with a minimal env --------------------------------
function cli(args, extra = {}) {
    const env = { PATH: process.env.PATH || process.env.Path || '', SystemRoot: process.env.SystemRoot || '', ...extra };
    return spawnSync(process.execPath, [SUBJECT, ...args], { env, encoding: 'utf8', windowsHide: true });
}
{
    const clean = cli(['check']);
    check('CLI check: exit 0 and a quiet line for a clean env', clean.status === 0 && /no paid key/.test(clean.stdout) && clean.stderr === '', `exit ${clean.status} ${clean.stderr}`);
    const bad = cli(['check'], { ANTHROPIC_API_KEY: CANARY });
    check('CLI check: exit 1 naming the variable, the value never printed', bad.status === 1 && /ANTHROPIC_API_KEY/.test(bad.stderr) && !(bad.stdout + bad.stderr).includes(CANARY), `exit ${bad.status} ${bad.stderr}`);
    const ok = cli(['check'], { ANTHROPIC_API_KEY: CANARY, AUTODEV_ALLOW_PAID_KEY: '1' });
    check('CLI check: AUTODEV_ALLOW_PAID_KEY=1 exits 0 and still never prints the value', ok.status === 0 && /ANTHROPIC_API_KEY/.test(ok.stdout) && !(ok.stdout + ok.stderr).includes(CANARY));
    const not1 = cli(['check'], { ANTHROPIC_API_KEY: CANARY, AUTODEV_ALLOW_PAID_KEY: 'true' });
    check('CLI check: AUTODEV_ALLOW_PAID_KEY=true does not allow', not1.status === 1);
    const ext = cli(['check'], { AUTODEV_PAID_KEY_NAMES: 'MY_SERVICE_KEY', MY_SERVICE_KEY: CANARY });
    check('CLI check: an extension name is refused too', ext.status === 1 && /MY_SERVICE_KEY/.test(ext.stderr) && !ext.stderr.includes(CANARY));
    const help = cli(['--help']);
    check('CLI --help exits 0 and lists the names', help.status === 0 && EXPECTED.every((n) => help.stdout.includes(n)));
    const unk = cli(['frobnicate']);
    check('CLI: an unknown command exits 2', unk.status === 2 && /unknown command/.test(unk.stderr));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join('; ')); process.exitCode = 1; }
