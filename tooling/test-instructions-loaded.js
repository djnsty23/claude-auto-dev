#!/usr/bin/env node
// Tests for hooks/instructions-loaded.js and scripts/check-rules-reachable.js
// Run: node tooling/test-instructions-loaded.js
// Exits 1 on any failure; 0 if all pass.
//
// The hook is driven as a subprocess, because that is how it runs and because
// the property that matters most about it cannot be tested any other way: it
// must emit ZERO BYTES on stdout AND stderr. It fires once per instruction file
// per session, so a hook that says anything at all says it many times before
// the user has typed a word, and a noisy hook gets disabled. Mutants have
// survived in this repo by a test checking only one stream, so both are checked
// on every case.
//
// The check's own analysis is unit-tested through its export rather than by
// writing a real log, so a developer's actual ~/.claude/logs is never touched.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'instructions-loaded.js');
const CHECK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-rules-reachable.js');
const { analyse } = require(CHECK);

let failures = 0;
function check(name, cond) {
    if (cond) { console.log('  ok   ' + name); return; }
    console.log('  FAIL ' + name);
    failures += 1;
}

// Point the hook at a scratch config dir so a test never writes to real logs.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'il-'));
const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: sandbox });
const LOG = path.join(sandbox, 'logs', 'instructions-loaded.jsonl');

function run(payload) {
    return spawnSync('node', [HOOK], {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
        env,
    });
}

console.log('instructions-loaded (hook)');

let r = run({ file_path: 'C:/p/CLAUDE.md', load_reason: 'session_start', file_content: '# x', cwd: 'C:/p' });
check('exits 0 on a normal load', r.status === 0);
check('emits zero bytes on stdout', (r.stdout || '') === '');
check('emits zero bytes on stderr', (r.stderr || '') === '');
check('wrote a log line', fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').trim().split('\n').length === 1);

let row = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n')[0]);
check('records the file path', row.file === 'C:/p/CLAUDE.md');
check('records the load reason', row.reason === 'session_start');
check('classifies an unscoped file as unscoped', row.scoped === false);

// The scoped flag is captured AT LOAD TIME on purpose: by the time the check
// runs the file may have changed, and a claim about what loaded has to describe
// the thing that loaded rather than its successor.
run({ file_path: 'C:/p/.claude/rules/api.md', load_reason: 'path_glob_match',
      file_content: '---\npaths:\n  - "src/**/*.ts"\n---\n# api', cwd: 'C:/p' });
row = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n')[1]);
check('detects paths: frontmatter as scoped', row.scoped === true);

// Failure modes. Each must be silent and non-fatal: this hook runs before the
// user can react to anything going wrong, so it must never break a turn.
for (const [label, payload] of [
    ['no stdin at all', ''],
    ['whitespace only', '   \n'],
    ['unparseable JSON', '{not json'],
    ['valid JSON, no file_path', '{"load_reason":"session_start"}'],
    ['file_path of the wrong type', '{"file_path":42}'],
    ['null content', '{"file_path":"C:/p/x.md","file_content":null}'],
]) {
    const rr = run(payload);
    check('survives ' + label + ' (exit 0)', rr.status === 0);
    check('  ...silently on both streams', (rr.stdout || '') === '' && (rr.stderr || '') === '');
}

const before = fs.readFileSync(LOG, 'utf8').trim().split('\n').length;
run('{"load_reason":"session_start"}');
const after = fs.readFileSync(LOG, 'utf8').trim().split('\n').length;
check('a payload with no file_path writes nothing', before === after);

console.log('');
console.log('check-rules-reachable (analysis)');

const st = spawnSync('node', [CHECK, '--selftest'], { encoding: 'utf8', env });
check('--selftest exits 0', st.status === 0);
check('--selftest names its mutation case', /mutation/i.test(st.stdout || ''));

const F = (p, scoped) => ({ file: path.resolve(p), scoped });
const START = { reason: 'session_start', at: '2026-08-26T00:00:00Z', file: '/r/CLAUDE.md' };

let a = analyse([F('/r/.claude/rules/dead.md', false)], [START]);
check('an unconditional rule never seen is UNREACHABLE', a.unreachable.length === 1);

a = analyse([F('/r/.claude/rules/scoped.md', true)], [START]);
check('a path-scoped rule never seen is unexercised, not a fault',
    a.unexercised.length === 1 && a.unreachable.length === 0);

// THE GUARD THAT CARRIES THE CHECK. Without a session_start in the log, a naive
// subtraction reports every rule in the repo as unreachable on a fresh machine.
// That is a claim about the log wearing a finding's clothes, and it is exactly
// how a detector earns the reputation that gets it muted.
a = analyse([F('/r/.claude/rules/dead.md', false)],
    [{ reason: 'path_glob_match', at: '2026-08-26T00:00:00Z', file: '/r/other.md' }]);
check('no session_start observed means NO EVIDENCE, not findings', a.sawStart === false);

a = analyse([F('/r/.claude/rules/dead.md', false)], []);
check('an empty log is not a pile of findings', a.sawStart === false);

// The report must exit 0 on no-evidence, or a fresh clone fails its own gate.
const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'il-fresh-'));
const rep = spawnSync('node', [CHECK, fresh], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: fresh }),
});
check('a repo with no log exits 0', rep.status === 0);
check('...and says NO EVIDENCE rather than reporting rules', /NO EVIDENCE/.test(rep.stdout || ''));

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* tmp */ }
try { fs.rmSync(fresh, { recursive: true, force: true }); } catch { /* tmp */ }

console.log(failures ? '\nFAILED: ' + failures : '\nall passed');
process.exit(failures ? 1 : 0);
