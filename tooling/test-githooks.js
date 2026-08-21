#!/usr/bin/env node
// Tests for tooling/githooks/*.
//
// These hooks are the only checks that see things the tree-level gate cannot:
// a commit message, and a push. Both were added after the thing they check for
// actually happened in this repo.
//
// This file never carries a private name, for the obvious reason: a test for a
// private-name blocker must not itself put one into a public repo. It used to
// pull them from the checker at runtime; since 2026-08-22 the checker holds
// digests rather than names, so there is nothing to pull, and the blocking cases
// run against a throwaway repo carrying a synthetic sentinel instead.
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

// `--list` prints DIGESTS, not names — since 2026-08-22 there is no plaintext
// list to read, which is the point of the change. So this file can no longer
// feed the hook a name the gate knows, and testing it with a real one would put
// that name into a public repo's test file.
//
// Instead: build a throwaway repo whose checker is the REAL checker with its
// digest list swapped for one synthetic sentinel, and drive the hook against it.
// That exercises the whole path — hook, delegation, normalisation, hashing —
// with nothing private anywhere in it.
const digests = execFileSync('node', [CHECKER, '--list'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

const { digest } = require('./check-no-private-names.js');

// The sentinel must be impossible to confuse with a real entry, and "I picked an
// odd word" is not proof of that. Assert it: its digest must be ABSENT from the
// real list, so this fixture cannot quietly become a test of a live name.
const SENTINEL = 'zarblewidget';
const SENTINEL_PAIR = 'plinth harrow';   // two words — covers the n-gram join

const sentinelRepo = path.join(TMP, 'sentinel');
fs.mkdirSync(path.join(sentinelRepo, 'tooling'), { recursive: true });
spawnSync('git', ['init', '-q', sentinelRepo]);
fs.writeFileSync(
    path.join(sentinelRepo, 'tooling', 'check-no-private-names.js'),
    fs.readFileSync(CHECKER, 'utf8').replace(
        /const DIGESTS = \[[\s\S]*?\];/,
        `const DIGESTS = [\n    '${digest(SENTINEL)}',\n    '${digest(SENTINEL_PAIR)}',\n];`));

function runCommitMsg(body, cwd = sentinelRepo) {
    const f = path.join(TMP, 'msg-' + Math.abs(body.length * 31 + body.charCodeAt(0)) + '.txt');
    fs.writeFileSync(f, body);
    return spawnSync('sh', [COMMIT_MSG, f], { cwd, encoding: 'utf8' }).status;
}

check('both hooks exist and are executable', [COMMIT_MSG, PRE_PUSH].every((f) => {
    try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; }
}));

check(`the real denylist is non-empty (${digests.length} digests)`, digests.length > 0);

check('--list discloses no names, only hex digests',
    digests.every((d) => /^[0-9a-f]{8,64}$/.test(d)));

check('the sentinel is absent from the real denylist',
    !digests.includes(digest(SENTINEL)) && !digests.includes(digest(SENTINEL_PAIR)));

// The load-bearing case: the hook must actually block. Everything else here is
// about not blocking the wrong thing, and a detector that stopped firing would
// still pass all of those.
check('a listed name is blocked in a commit message',
    runCommitMsg(`fix: work on ${SENTINEL} today\n`) === 1);

check('case and punctuation do not evade it',
    runCommitMsg('fix: work on Zarble-Widget today\n') === 1);

check('two words that join into a name are blocked',
    runCommitMsg(`fix: ask the ${SENTINEL_PAIR} team\n`) === 1);

check('an anonymised message passes',
    runCommitMsg('fix(x): table\n\n  Project A  16 -> 5\n  Project B  5 -> 3\n') === 0);

// git's own template comments never become part of the message.
check('a name inside a # comment line does not block',
    runCommitMsg(`# on branch main, mentions ${SENTINEL}\nfix(x): clean subject\n`) === 0);

// Word boundaries: a longer word containing a name is not a hit.
check('a substring of a name does not block',
    runCommitMsg(`fix: ${SENTINEL}ology is a different word\n`) === 0);

// A checker that cannot RUN has cleared nothing. Before 2026-08-22 the hook
// grepped a file and a broken checker simply produced no matches, so it passed —
// an unrecognised state falling through to success is the failure this suite
// exists to keep out.
check('a checker that crashes blocks rather than passes', (() => {
    const bust = path.join(TMP, 'bust');
    fs.mkdirSync(path.join(bust, 'tooling'), { recursive: true });
    spawnSync('git', ['init', '-q', bust]);
    fs.writeFileSync(path.join(bust, 'tooling', 'check-no-private-names.js'),
        'throw new Error("checker is broken");\n');
    return runCommitMsg('fix(x): perfectly ordinary subject\n', bust) === 1;
})());

// The hook must be inert where there is no gate to delegate to — it is
// installed per-clone via core.hooksPath and must not break another repo.
check('no checker present means no opinion', (() => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-repo-'));
    spawnSync('git', ['init', '-q', bare]);
    const st = runCommitMsg(`fix: mentions ${SENTINEL}\n`, bare);
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
