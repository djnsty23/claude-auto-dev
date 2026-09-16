#!/usr/bin/env node
'use strict';
// Suite for tooling/check-release-lag.js.
//
// The script turns red when plugin commits sit unreleased after the last
// VERSION bump for longer than a limit, or when the version is untagged. Every
// case builds a throwaway repo with a bare remote under the temp dir, dates its
// commits through GIT_COMMITTER_DATE, and runs the script with that repo as its
// working directory. Nothing here reads this repo's own history.
//
// Each red case has a green control that differs in one thing, so a script that
// was always red, or never red, fails here.
//
// Run: node tooling/test-check-release-lag.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'check-release-lag.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail !== undefined ? '  (' + detail + ')' : '')); }
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-lag-')));
const NO_HOOKS = path.join(TMP, 'no-hooks');
fs.mkdirSync(NO_HOOKS);
const HOUR = 3600;
const nowS = Math.floor(Date.now() / 1000);

// A clean git environment: nothing inherited from a hook or a parent repo.
function gitEnv(extra) {
    const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }, extra || {});
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMITTER_DATE', 'GIT_AUTHOR_DATE']) {
        if (!(extra && k in extra)) delete env[k];
    }
    return env;
}

function git(cwd, args, extra) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv(extra) });
    if (r.status !== 0) throw new Error('fixture git ' + args.join(' ') + ' failed: ' + (r.stderr || r.error));
    return r.stdout;
}

let n = 0;
/** A repo whose first commit sets VERSION, pushed to a bare origin. */
function makeRepo(version, bumpHoursAgo) {
    const base = path.join(TMP, 'r' + (++n));
    const work = path.join(base, 'work');
    const remote = path.join(base, 'remote.git');
    fs.mkdirSync(work, { recursive: true });
    git(base, ['init', '--bare', '--quiet', remote]);
    git(work, ['init', '--quiet', '-b', 'main']);
    git(work, ['config', 'user.name', 'Fixture']);
    git(work, ['config', 'user.email', 'fixture@example.invalid']);
    git(work, ['config', 'commit.gpgsign', 'false']);
    git(work, ['config', 'tag.gpgsign', 'false']);
    git(work, ['config', 'core.hooksPath', NO_HOOKS]);
    git(work, ['remote', 'add', 'origin', remote]);
    fs.mkdirSync(path.join(work, 'plugins', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(work, 'plugins', 'demo', 'hook.js'), '// 0\n');
    fs.writeFileSync(path.join(work, 'docs', 'notes.md'), '0\n');
    commit(work, ['VERSION', 'plugins', 'docs'], 'chore(release): bump to ' + version, bumpHoursAgo, () => fs.writeFileSync(path.join(work, 'VERSION'), version + '\n'));
    git(work, ['push', '--quiet', 'origin', 'main']);
    return work;
}

function commit(work, paths, subject, hoursAgo, write) {
    if (write) write();
    git(work, ['add', ...paths]);
    const date = '@' + (nowS - Math.round(hoursAgo * HOUR)) + ' +0000';
    git(work, ['commit', '--quiet', '-m', subject], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
}
function pluginCommit(work, subject, hoursAgo) {
    commit(work, ['plugins'], subject, hoursAgo, () => fs.appendFileSync(path.join(work, 'plugins', 'demo', 'hook.js'), '// ' + subject + '\n'));
}
function docsCommit(work, subject, hoursAgo) {
    commit(work, ['docs'], subject, hoursAgo, () => fs.appendFileSync(path.join(work, 'docs', 'notes.md'), subject + '\n'));
}
const push = (work) => git(work, ['push', '--quiet', 'origin', 'main']);
const tagAndPush = (work, tag) => { git(work, ['tag', tag]); git(work, ['push', '--quiet', 'origin', tag]); };

function run(cwd, args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv() });
    let json = null;
    if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { json = null; } }
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', json };
}
const detail = (r) => 'exit ' + r.code + ', stdout ' + JSON.stringify(r.out.slice(0, 400)) + ', stderr ' + JSON.stringify(r.err.slice(0, 160));
const population = (r) => /bump commit: /.test(r.out) && /plugin commits since the bump: /.test(r.out) && /\n  tag /.test(r.out);

try {
    // ---- green: a fresh plugin commit after the bump, tag on the remote ------
    {
        const w = makeRepo('1.0.0', 100);
        tagAndPush(w, 'v1.0.0');
        pluginCommit(w, 'fix(demo): fresh fix', 1);
        push(w);
        const r = run(w, []);
        check('a plugin commit 1 h after the bump, tagged: exit 0 with the default ref origin/main', r.code === 0, detail(r));
        check('  the population prints: bump, plugin commits, oldest age, tag', population(r) && /plugin commits since the bump: 1, oldest 1(\.\d)? h/.test(r.out) && /v1\.0\.0: local present, origin present/.test(r.out), detail(r));
        check('  the verdict says GREEN', /verdict: GREEN/.test(r.out), detail(r));
    }

    // ---- red: an old plugin commit ----------------------------------------------
    {
        const w = makeRepo('1.0.0', 100);
        tagAndPush(w, 'v1.0.0');
        pluginCommit(w, 'fix(demo): the fix nobody released', 48);
        docsCommit(w, 'docs: later notes', 2);
        push(w);
        const r = run(w, []);
        check('a plugin commit 48 h old after the bump: exit 1', r.code === 1, detail(r));
        check('  the reason counts it and names the limit', /RED: 1 plugin commit\(s\) older than 24 h/.test(r.out), detail(r));
        check('  the stale commit is listed by subject', /48 h old "fix\(demo\): the fix nobody released"/.test(r.out), detail(r));
        check('  and the population still prints on a red run', population(r) && /oldest 48(\.\d)? h/.test(r.out), detail(r));
        const wide = run(w, ['--max-age-hours', '72']);
        check('  CONTROL: the same repo with --max-age-hours 72 is green', wide.code === 0, detail(wide));
        const j = run(w, ['--json']);
        check('  --json carries verdict, version, bump, counts, stale and tag', !!j.json && j.json.verdict === 'red' && j.json.version === '1.0.0'
            && /^[0-9a-f]{40}$/.test((j.json.bump || {}).sha) && j.json.pluginCommitsSince === 1 && j.json.stale.length === 1
            && j.json.tag.name === 'v1.0.0' && j.json.tag.local === true && j.json.tag.remote === true, j.out.slice(0, 300));
    }

    // ---- a later bump releases the old commits --------------------------------
    {
        const w = makeRepo('1.0.0', 100);
        tagAndPush(w, 'v1.0.0');
        pluginCommit(w, 'fix(demo): released by the next bump', 48);
        commit(w, ['VERSION'], 'chore(release): bump to 1.0.1', 1, () => fs.writeFileSync(path.join(w, 'VERSION'), '1.0.1\n'));
        push(w);
        tagAndPush(w, 'v1.0.1');
        const r = run(w, []);
        check('the LAST VERSION commit is the bump: an old commit before it does not count', r.code === 0 && /VERSION 1\.0\.1/.test(r.out) && /since the bump: 0/.test(r.out), detail(r));
    }

    // ---- red: missing tag ---------------------------------------------------------
    {
        const w = makeRepo('2.0.0', 5);
        pluginCommit(w, 'fix(demo): fresh', 1);
        push(w);
        const r = run(w, []);
        check('an untagged VERSION is red: exit 1', r.code === 1, detail(r));
        check('  the reason names the missing tag', /RED: tag v2\.0\.0 is missing, locally and on origin/.test(r.out), detail(r));
        tagAndPush(w, 'v2.0.0');
        const tagged = run(w, []);
        check('  CONTROL: the same repo after tagging is green', tagged.code === 0, detail(tagged));
        git(w, ['tag', '-d', 'v2.0.0']);
        const remoteOnly = run(w, []);
        check('  a tag present only on the remote counts', remoteOnly.code === 0 && /local absent, origin present/.test(remoteOnly.out), detail(remoteOnly));
    }

    // ---- docs-only commits after the bump ---------------------------------------
    {
        const w = makeRepo('3.0.0', 200);
        tagAndPush(w, 'v3.0.0');
        docsCommit(w, 'docs: one', 150);
        docsCommit(w, 'docs: two', 100);
        push(w);
        const r = run(w, []);
        check('old commits that touch only docs/ stay green', r.code === 0 && /since the bump: 0 \(limit 24 h\)/.test(r.out), detail(r));
    }

    // ---- indeterminate: git failures ---------------------------------------------
    {
        const w = makeRepo('4.0.0', 5);
        tagAndPush(w, 'v4.0.0');
        const badRef = run(w, ['--ref', 'origin/does-not-exist']);
        check('a ref that does not resolve exits 2', badRef.code === 2 && /INDETERMINATE: could not resolve origin\/does-not-exist/.test(badRef.out), detail(badRef));
        check('  and still prints the population lines', population(badRef), detail(badRef));
        const notRepo = path.join(TMP, 'not-a-repo');
        fs.mkdirSync(notRepo, { recursive: true });
        const outside = run(notRepo, []);
        check('outside a git repository exits 2', outside.code === 2 && /verdict: INDETERMINATE/.test(outside.out), detail(outside));
    }
    {
        const w = makeRepo('5.0.0', 5);
        pluginCommit(w, 'fix(demo): fresh', 1);
        push(w);
        const r = run(w, ['--remote', 'no-such-remote']);
        check('an unlistable remote with no local tag exits 2, not red and not green', r.code === 2 && /could not list tags on no-such-remote/.test(r.out), detail(r));
        git(w, ['tag', 'v5.0.0']);
        const local = run(w, ['--remote', 'no-such-remote']);
        check('  CONTROL: the same run with the tag present locally is green', local.code === 0 && /local present, no-such-remote unreadable/.test(local.out), detail(local));
    }
    {
        const w = path.join(TMP, 'no-version');
        fs.mkdirSync(w, { recursive: true });
        git(w, ['init', '--quiet', '-b', 'main']);
        git(w, ['config', 'user.name', 'Fixture']);
        git(w, ['config', 'user.email', 'fixture@example.invalid']);
        git(w, ['config', 'commit.gpgsign', 'false']);
        git(w, ['config', 'core.hooksPath', NO_HOOKS]);
        fs.writeFileSync(path.join(w, 'README.md'), 'x\n');
        commit(w, ['README.md'], 'init', 1);
        const r = run(w, ['--ref', 'main']);
        check('a ref where no commit ever changed VERSION exits 2', r.code === 2 && /no commit on main changed VERSION/.test(r.out), detail(r));
    }

    // ---- arguments ----------------------------------------------------------------
    {
        const notRepo = path.join(TMP, 'help-dir');
        fs.mkdirSync(notRepo, { recursive: true });
        const h = run(notRepo, ['--help']);
        check('--help prints usage and exits 0 without touching git', h.code === 0 && /^usage: /.test(h.out) && h.err === '' && !/verdict/.test(h.out), detail(h));
        const bad = run(notRepo, ['--max-age-hours', 'soon']);
        check('a malformed --max-age-hours exits 2', bad.code === 2 && /non-negative number/.test(bad.err), detail(bad));
        const unknown = run(notRepo, ['--refs', 'x']);
        check('an unknown argument exits 2', unknown.code === 2 && /unknown argument --refs/.test(unknown.err), detail(unknown));
    }
} catch (e) {
    fail++;
    console.log('FAIL  the fixture could not be built: ' + ((e && e.message) || e));
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
