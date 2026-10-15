#!/usr/bin/env node
// Tests for tooling/push-guard.js and its wiring in tooling/githooks/pre-push.
//
// The unit half drives refusals() against a throwaway repo with a real history,
// so the fast-forward probe is git's own answer, not a stub. The wiring half
// feeds ref lines to the real pre-push hook in this checkout and reads its exit:
// a guard that is correct but no longer called refuses nothing.
//
// Run: node tooling/test-push-guard.js

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { refusals } = require('./push-guard.js');

const ROOT = path.resolve(__dirname, '..');
const PRE_PUSH = path.join(ROOT, 'tooling', 'githooks', 'pre-push');
const ZERO = '0'.repeat(40);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
    if (ok) { passed++; console.log(`ok ${name}`); } else { failed++; console.log(`FAIL ${name}${detail ? ' | ' + detail : ''}`); }
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'push-guard-test-')));
const git = (...args) => execFileSync('git', args, { cwd: TMP, encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q');
git('config', 'user.email', 'test@example.invalid');
git('config', 'user.name', 'push-guard test');
git('commit', '-q', '--allow-empty', '-m', 'one');
const A = git('rev-parse', 'HEAD');
git('commit', '-q', '--allow-empty', '-m', 'two');
const B = git('rev-parse', 'HEAD');
git('checkout', '-q', '-b', 'side', A);
git('commit', '-q', '--allow-empty', '-m', 'side');
const C = git('rev-parse', 'HEAD');

const line = (localRef, localSha, remoteRef, remoteSha) => `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`;
const r = (input) => refusals(input, { cwd: TMP });

// Allowed: the release path.
check('a fast-forward of main passes', r(line('refs/heads/x', B, 'refs/heads/main', A)).length === 0);
check('a fast-forward of stable passes', r(line(B, B, 'refs/heads/stable', A)).length === 0);
check('creating a new release tag passes', r(line('refs/tags/v9.0.0', B, 'refs/tags/v9.0.0', ZERO)).length === 0);
check('creating stable passes', r(line(B, B, 'refs/heads/stable', ZERO)).length === 0);
check('a force-push to a work branch is none of its business', r(line(C, C, 'refs/heads/feature', B)).length === 0);
check('a v-prefixed branch is not a tag', r(line(C, C, 'refs/heads/v1', B)).length === 0);

// Refused.
check('a force-push to main is refused', /force-push/.test(r(line(C, C, 'refs/heads/main', B)).join()));
check('a force-push to stable is refused', r(line(A, A, 'refs/heads/stable', B)).length === 1);
check('deleting main is refused', /never deleted/.test(r(line('(delete)', ZERO, 'refs/heads/main', B)).join()));
check('moving a release tag is refused', /never moved/.test(r(line(C, C, 'refs/tags/v8.0.0', B)).join()));
check('deleting a release tag is refused', /never deleted/.test(r(line('(delete)', ZERO, 'refs/tags/v8.0.0', B)).join()));
check('an unfetched remote commit fails closed', r(line(B, B, 'refs/heads/main', 'f'.repeat(40))).length === 1);
check('one bad ref among good ones is still refused',
    r(line(B, B, 'refs/heads/main', A) + line(C, C, 'refs/tags/v1.0.0', A) + line('refs/tags/v2', B, 'refs/tags/v2', ZERO)).length === 1);
check('CRLF input is read', r(line(C, C, 'refs/heads/main', B).replace('\n', '\r\n')).length === 1);

// Wiring: the real hook text and the real guard, run in the throwaway repo so
// the history is known. CI checks out one commit, so this repo's own HEAD~1
// may not exist. validate.js is stubbed green: the hook's other half is not
// under test here.
const SH = (() => {
    if (process.platform !== 'win32') return 'sh';
    const gitRoot = path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..');
    for (const rel of ['bin/sh.exe', 'usr/bin/sh.exe']) if (fs.existsSync(path.join(gitRoot, rel))) return path.join(gitRoot, rel);
    return null;
})();
fs.mkdirSync(path.join(TMP, 'tooling', 'githooks'), { recursive: true });
fs.copyFileSync(PRE_PUSH, path.join(TMP, 'tooling', 'githooks', 'pre-push'));
fs.copyFileSync(path.join(ROOT, 'tooling', 'push-guard.js'), path.join(TMP, 'tooling', 'push-guard.js'));
fs.writeFileSync(path.join(TMP, 'tooling', 'validate.js'), 'process.exitCode = 0;\n');
const hook = (input) => spawnSync(SH, [path.join(TMP, 'tooling', 'githooks', 'pre-push'), 'origin', 'https://example.invalid/repo.git'],
    { cwd: TMP, input, encoding: 'utf8', windowsHide: true });
if (!SH) check('a POSIX sh is available to run the hook', false, 'no sh beside git');
else {
    const back = hook(line(A, A, 'refs/heads/stable', B));
    check('the pre-push hook refuses rewinding stable', back.status === 1 && /push-guard/.test(back.stderr), `exit ${back.status} ${back.stderr.slice(-200)}`);
    const fwd = hook(line(B, B, 'refs/heads/stable', A));
    check('the pre-push hook lets stable move forward', fwd.status === 0, `exit ${fwd.status} ${fwd.stderr.slice(-200)}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
