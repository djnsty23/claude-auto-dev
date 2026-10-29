#!/usr/bin/env node
'use strict';
// Review regressions: real hook subprocesses and sync's public entry point.
// No push command is executed; every state file belongs to this fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const D = require('../plugins/autodev-core/scripts/delivery-outcomes.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-security-'));
const hook = path.resolve(__dirname, '../plugins/autodev-core/hooks/coordinator-write-guard.js');
let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`PASS ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
function push(command, cwd = root) {
    return spawnSync(process.execPath, [hook], {
        input: JSON.stringify({ tool_name: 'Bash', agent_id: 'fixture-agent', cwd, tool_input: { command } }),
        encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: { ...process.env, AUTODEV_BRAIN_ROLE_FILE: path.join(root, 'no-role.json'), CLAUDE_CONFIG_DIR: root },
    });
}
function blocked(command, cwd) {
    const r = push(command, cwd);
    assert.equal(r.status, 2, `${command}: expected block exit 2, got ${r.status} (${r.error || r.stderr})`);
    assert.match(r.stderr, /^Blocked: this subagent's `git push`/);
    assert.equal(r.stdout, '');
}
function allowed(command, cwd) {
    const r = push(command, cwd);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], command);
}
const pr = (n) => `https://github.com/example-org/widget/pull/${n}`;
const now = Date.parse('2026-10-29T00:00:00Z');
function fixture(name, records) {
    const dir = path.join(root, name);
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const ledger = path.join(dir, 'ledger.json');
    fs.writeFileSync(ledger, JSON.stringify({ records: [] }));
    for (const r of records) fs.writeFileSync(path.join(sessionsDir, `local_${r.sessionId}.json`), JSON.stringify(r));
    return { ledger, headlessLedger: path.join(dir, 'none'), judgeDir: dir, sessionsDir, store: path.join(dir, 'outcomes.jsonl') };
}
const session = (id, date, n) => ({ sessionId: id, createdAt: Date.parse(date), spawnedFrom: {}, prs: [{ url: pr(n), state: 'OPEN' }] });
try {
    test('F1 equivalent command spellings block', () => {
        blocked('git push origin HEAD:main'); // known-positive control
        for (const cmd of ['git pu""sh origin HEAD:main', 'env FOO=bar git push origin HEAD:main',
            'env FOO=bar git pu""sh origin HEAD:master', 'git "push" origin HEAD:main']) blocked(cmd);
        allowed('env FOO=bar git pu""sh origin HEAD:claude/topic');
        allowed('echo "git push origin HEAD:main"');
    });
    test('F1 wrapper prefixes, shell -c strings, push aliases and escapes block', () => {
        for (const cmd of ['command git push origin HEAD:main', 'exec git push origin HEAD:main',
            'time git push origin HEAD:main', 'time -p git push origin HEAD:main', 'nice -n 5 git push origin HEAD:main',
            'nohup git push origin HEAD:main', 'sudo -u me git push origin HEAD:main', 'sudo FOO=1 git push origin HEAD:main',
            'command env FOO=1 git push origin HEAD:main', 'git pu\\sh origin HEAD:main', 'git push origin ma\\in',
            'bash -c "git push origin HEAD:main"', "sh -c 'git push origin main'", 'bash -lc "cd x && git push origin main"',
            '/usr/bin/bash -c "git push origin HEAD:main"', 'git -c alias.p=push p origin HEAD:main',
            'git -c "alias.p=!git push origin main" p']) blocked(cmd);
        allowed('command git push origin HEAD:claude/topic');
        allowed('nice -n 5 git push origin HEAD:claude/topic');
        allowed('git pu\\sh origin HEAD:claude/topic');
        blocked('git -c alias.p=push p origin HEAD:claude/topic');
        allowed('git -c alias.st=status st');
        allowed('bash -c "git status"');
    });
    for (const cmd of [
        'git --git-dir=elsewhere/.git push origin HEAD:claude/topic',
        'git --git-dir elsewhere/.git push origin HEAD:claude/topic',
        'git --work-tree=elsewhere push origin HEAD:claude/topic',
        'git --work-tree elsewhere push origin HEAD:claude/topic',
        'git --config-env=push.default=PUSH_MODE push origin HEAD:claude/topic',
        'git --config-env alias.p=PV p origin HEAD:main',
        'git --config-env=alias.p=PV p origin HEAD:main',
        'git -c remote.origin.push=HEAD:main push origin HEAD:claude/topic',
        'git -c push.default=upstream push origin HEAD:claude/topic',
        'git -c alias.p=push push origin HEAD:claude/topic',
        'git -c alias.p=!git\\ push p origin HEAD:main',
        'GIT_DIR=elsewhere/.git git push origin HEAD:claude/topic',
        'GIT_WORK_TREE=elsewhere git push origin HEAD:claude/topic',
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin HEAD:main',
        'env GIT_CONFIG_SYSTEM=elsewhere git push origin HEAD:claude/topic',
    ]) test(`H2 unsafe push configuration: ${cmd}`, () => blocked(cmd));
    test('H2 harmless configuration and non-push controls stay silent', () => {
        for (const cmd of ['git -c alias.st=status st', 'git -c alias.st=status push origin HEAD:claude/topic',
            'git -c color.ui=false push origin HEAD:claude/topic', 'git --git-dir=elsewhere status',
            'git --work-tree=elsewhere status', 'git --config-env=color.ui=COLOR status',
            'GIT_DIR=elsewhere git status', 'git -c remote.origin.url=elsewhere status']) allowed(cmd);
    });
    for (const cmd of [
        'timeout 60 git push origin HEAD:main', 'stdbuf -o0 git push origin HEAD:main',
        'if true; then git push origin HEAD:main; fi', '! git push origin HEAD:main',
        '>/dev/null git push origin HEAD:main', 'g\\it push origin HEAD:main',
        "git $'pu\\x73h' origin HEAD:main", 'p=push; git $p origin HEAD:main',
        'b=main; git push origin HEAD:$b', 'git push origin HEAD:${b}',
        "git push origin HEAD:$'ma\\x69n'", 'git push origin HEAD:ma{i,}n',
        'git {pu,p}sh origin HEAD:main',
        'env -S "git push origin HEAD:main"', 'env --split-string="git push origin HEAD:main"',
        'bash -o pipefail -c "git push origin HEAD:main"',
        'bash <<< "git push origin HEAD:main"', 'echo "git push origin HEAD:main" | bash',
        'cat <<EOF | sh\ngit push origin HEAD:main\nEOF', 'bash <<EOF\ngit push origin HEAD:main\nEOF',
        'cmd //c "git push origin HEAD:main"', 'pwsh -c "git push origin HEAD:main"',
        'eval "git push origin HEAD:main"', 'xargs "git push origin HEAD:main"',
        'xargs git push origin <<< HEAD:main',
    ]) test(`H3 indirect push: ${JSON.stringify(cmd)}`, () => blocked(cmd));
    test('H3 ordinary commands and feature pushes stay silent', () => {
        for (const cmd of ['git status', 'git log --grep=push', 'git commit -m "push the docs"',
            'npm run gate', 'node script.js push', 'git stash push',
            'timeout 60 git push origin HEAD:claude/topic', 'stdbuf -o0 git push origin HEAD:claude/topic',
            '! git push origin HEAD:claude/topic', '>/dev/null git push origin HEAD:claude/topic',
            'g\\it push origin HEAD:claude/topic', 'echo "git push origin main"',
            'printf push | wc -c', 'cat <<EOF\ngit push origin main\nEOF']) allowed(cmd);
    });
    test('H3 tags-only push on main stays silent', () => {
        const dir = path.join(root, 'tags-main');
        const init = spawnSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8', windowsHide: true });
        assert.equal(init.status, 0, init.stderr);
        allowed('git push --tags origin', dir);
        blocked('git push --tags origin main', dir);
        blocked('git push --tags --all origin', dir);
    });
    test('H3 xargs here-string on a feature branch fails closed', () => {
        const dir = path.join(root, 'xargs-feature');
        const init = spawnSync('git', ['init', '-q', '-b', 'claude/topic', dir], { encoding: 'utf8', windowsHide: true });
        assert.equal(init.status, 0, init.stderr);
        allowed('git push origin', dir); // a readable feature branch is the control
        blocked('xargs git push origin <<< HEAD:main', dir);
    });
    test('H5 malformed cwd with a subagent push fails closed', () => blocked('git push origin HEAD:main', 42));
    test('H5 array command containing a subagent push fails closed', () => blocked(['git', 'push', 'origin', 'main']));
    test('H5 throws outside subagent pushes retain exit zero', () => {
        for (const [command, cwd] of [['git status', 42], [123, root]]) {
            const r = push(command, cwd);
            assert.equal(r.status, 0);
            assert.equal(r.stdout, '');
            assert.match(r.stderr, /coordinator-write-guard: skipped/);
        }
        const r = spawnSync(process.execPath, [hook], {
            input: JSON.stringify({ tool_name: 'Bash', cwd: 42, tool_input: { command: 'git push origin main' } }),
            encoding: 'utf8', timeout: 30000, windowsHide: true,
        });
        assert.equal(r.status, 0); // main-thread errors keep their existing contract
        assert.equal(r.stdout, '');
    });
    test('F2 repo options and matching refspecs block', () => {
        // A repo on a feature branch: the current branch reads, so a block here is the
        // --repo parse, not the fail-closed answer to an unreadable branch.
        const feature = path.join(root, 'feature-repo');
        const init = spawnSync('git', ['init', '-q', '-b', 'claude/topic', feature], { encoding: 'utf8', windowsHide: true });
        assert.equal(init.status, 0, `git init: ${init.stderr}`);
        allowed('git push origin', feature); // control: the bare push reads claude/topic
        for (const cmd of ['git push --repo origin HEAD:main', 'git push --repo=origin HEAD:main',
            'git push --repo=origin main']) blocked(cmd, feature);
        for (const cmd of ['git push origin :', 'git push origin +:', 'git push origin "refs/heads/*:refs/heads/*"',
            'git push origin "refs/*:refs/*"', 'git push origin "refs/*/main:refs/*/main"',
            'git push origin "HEAD:refs/heads/ma*"']) blocked(cmd);
        allowed('git push --repo origin HEAD:claude/topic', feature);
        allowed('git push --repo=origin HEAD:claude/topic', feature);
        allowed('git push origin "refs/heads/claude/*:refs/heads/claude/*"');
        allowed('git push origin refs/tags/main:refs/tags/main');
        allowed('git push origin "refs/tags/*:refs/tags/*"');
    });
    test('F2 unknown implicit push destination fails closed', () => {
        blocked('git push', path.join(root, 'missing-repo'));
        blocked('git push --repo');
    });
    test('F3 sync spends budget on oldest task before OPEN refreshes', () => {
        const paths = fixture('ordering', [session('a', '2026-10-28', 1), session('b', '2026-09-01', 2)]);
        for (let run = 0; run < 3; run++) {
            let tick = 0;
            const asked = [];
            const r = D.sync({ paths, now, budgetMs: 2, clock: () => tick++, prFacts: (url) => {
                asked.push(url);
                return url === pr(1) ? { state: 'OPEN' } : { state: 'MERGED', mergedAt: '2026-09-02' };
            } });
            assert.equal(r.outcomes.find((o) => o.taskId === 'side:b').standingDay7, true,
                `run ${run + 1}: older merged task stayed unknown; asked ${asked.join(',')}`);
            assert.equal(asked[0], run === 0 ? pr(2) : pr(1));
            assert.equal(r.outcomes.find((o) => o.taskId === 'side:a').accepted, null);
        }
    });
    test('F3 sideAttempts spends a cost budget on the oldest session first', () => {
        // Records arrive in file-name order, newest first here. A reader with room for
        // one price, like a spent sessionCoster budget, must price the older session.
        let room = 1;
        const costOf = () => (room-- > 0 ? 5 : null);
        const out = D.sideAttempts([session('z-new', '2026-10-28', 1), session('a-old', '2026-09-01', 2)], null, new Map(), costOf);
        const cost = (id) => out.attempts.find((a) => a.taskId === `side:${id}`).costUsd;
        assert.deepEqual([cost('a-old'), cost('z-new')], [5, null], 'the newer session took the only price');
    });
    test('F4 unreadable subtrees remain visible in sync population', () => {
        const paths = fixture('denied', [session('a', '2026-09-01', 1)]);
        const denied = path.join(paths.sessionsDir, 'denied-account');
        fs.mkdirSync(denied);
        const readdir = fs.readdirSync;
        fs.readdirSync = (p, ...args) => {
            if (p === denied) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
            return readdir(p, ...args);
        };
        try {
            const s = D.readSessions(paths.sessionsDir);
            assert.equal(s.records.length, 1); // readable sibling survives
            assert.equal(s.state, 'partial', `state=${s.state}, bad=${s.bad}`);
            assert.equal(s.bad, 1);
            const r = D.sync({ paths, now, prFacts: () => null });
            assert.match(r.population, /side sessions partial: 1 record\(s\), 1 unreadable/);
        } finally { fs.readdirSync = readdir; }
        assert.equal(D.readSessions(paths.sessionsDir).state, 'read');
    });
    test('F4 inaccessible root is unreadable rather than absent', () => {
        const readdir = fs.readdirSync;
        fs.readdirSync = () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); };
        try { assert.equal(D.readSessions('denied-root').state, 'unreadable'); }
        finally { fs.readdirSync = readdir; }
    });
    test('F5 interleaved syncs preserve both cache updates', () => {
        const a = fixture('cache-a', [session('a', '2026-09-01', 1)]);
        const b = fixture('cache-b', [session('b', '2026-09-01', 2)]);
        b.store = a.store; // two worktrees share a store
        let interleave = true;
        const closed = () => ({ state: 'CLOSED', mergedAt: null });
        D.sync({ paths: a, now, prFacts: () => {
            if (interleave) {
                interleave = false;
                D.sync({ paths: b, now, prFacts: closed });
            }
            return closed();
        } });
        const cacheFile = a.store.replace(/\.jsonl$/, '') + '.pr-facts.json';
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        assert.deepEqual(Object.keys(cache).sort(), [pr(1), pr(2)], 'one concurrent cache update was overwritten');
        assert.deepEqual(fs.readdirSync(path.dirname(a.store)).filter((n) => /\.tmp$|write-lock/.test(n)), []);
    });
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`review-security: ${passed} passed, ${failed} failed, ${passed + failed} tests`);
process.exitCode = failed ? 1 : 0;
