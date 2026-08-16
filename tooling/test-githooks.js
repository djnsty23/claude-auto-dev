#!/usr/bin/env node
// Tests for tooling/githooks/*.
//
// These hooks are the only checks that see things the tree-level gate cannot:
// a commit message, and a push. Both were added after the thing they check for
// actually happened in this repo.
//
// This file derives the denylist at RUNTIME from check-no-private-names.js
// instead of embedding names, for the obvious reason: a test for a private-name
// blocker must not itself carry private names into a public repo.
//
// Run: node tooling/test-githooks.js

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMMIT_MSG = path.join(ROOT, 'tooling', 'githooks', 'commit-msg');
const PRE_PUSH = path.join(ROOT, 'tooling', 'githooks', 'pre-push');
const CHECKER = path.join(ROOT, 'tooling', 'check-no-private-names.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'githooks-test-')));
const cases = [];
const check = (label, ok) => cases.push([label, ok]);

const names = execFileSync('node', [CHECKER, '--list'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

function runCommitMsg(body) {
    const f = path.join(TMP, 'msg-' + Math.abs(body.length + body.charCodeAt(0)) + '.txt');
    fs.writeFileSync(f, body);
    return spawnSync('sh', [COMMIT_MSG, f], { cwd: ROOT, encoding: 'utf8' }).status;
}

check('both hooks exist and are executable', [COMMIT_MSG, PRE_PUSH].every((f) => {
    try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; }
}));

check('the denylist is non-empty', names.length > 0);

// Every name the gate knows must also be blocked in a message, or the two have
// drifted — which is the failure the hook reads NAMES from the gate to avoid.
const missed = names.filter((n) => runCommitMsg(`fix: work on ${n} today\n`) !== 1);
check(`every one of the ${names.length} names is blocked in a commit message`, missed.length === 0);
if (missed.length) console.log('       not blocked:', missed.length, 'name(s)');

check('an anonymised message passes',
    runCommitMsg('fix(x): table\n\n  Project A  16 -> 5\n  Project B  5 -> 3\n') === 0);

// git's own template comments never become part of the message.
check('a name inside a # comment line does not block',
    runCommitMsg(`# on branch main, mentions ${names[0]}\nfix(x): clean subject\n`) === 0);

// Word boundaries: a longer word containing a name is not a hit.
check('a substring of a name does not block',
    runCommitMsg(`fix: ${names[0]}ology is a different word\n`) === 0);

// The hook must be inert where there is no gate to read a list from — it is
// installed per-clone via core.hooksPath and must not break another repo.
check('no checker present means no opinion', (() => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-repo-'));
    spawnSync('git', ['init', '-q', bare]);
    const f = path.join(bare, 'msg.txt');
    fs.writeFileSync(f, `fix: mentions ${names[0]}\n`);
    const st = spawnSync('sh', [COMMIT_MSG, f], { cwd: bare, encoding: 'utf8' }).status;
    fs.rmSync(bare, { recursive: true, force: true });
    return st === 0;
})());

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
