#!/usr/bin/env node
'use strict';
/**
 * test-deploy-gate.js - deploy-gate.js as a subprocess, with git, gh, the
 * deployment inspect command and the smoke command all replaced by stubs.
 * Nothing here touches the network, a real repository or a real remote.
 *
 * What must hold:
 *   G1  no smoke command (no package.json, no autodevDeployGate, empty smoke) is exit 2, never
 *       PASS, and the gate does not even poll: no inspect call, no ledger line, no notification
 *   G2  no usable production URL is exit 2
 *   G3  PASS: deployment of the sha is READY and production, smoke exits 0 -> exit 0, one PASS
 *       ledger event, one deploy-done notification, and git and gh are never called
 *   G4  the production URL reaches the smoke command as part of ONE argument, whatever it holds
 *   G5  FAIL (smoke exit non-zero, smoke timeout, smoke cannot start, deployment ERROR): exit 1,
 *       one FAIL ledger event, a revert branch, ONE push with exactly the revert refspec, a DRAFT
 *       pr, exactly one notification naming the PR
 *   G6  main is never touched: across every case, every push is a revert/ refspec, and no git
 *       call is a merge, reset, checkout, switch or force
 *   G7  a revert that conflicts pushes nothing and calls no gh; a failed push calls no gh; a
 *       failed gh leaves the pushed branch and says so. Each still sends exactly ONE notification
 *       and exits 1
 *   G8  a merge commit is reverted with -m 1
 *   G9  TIMEOUT (deployment never arrives, serves another sha, carries no sha, is a preview, has
 *       no target field, or the inspect command fails) is exit 3, the smoke command is never
 *       run, nothing is created, one blocked-on-owner notification
 *   G10 the deployment must be the sha asked for: an abbreviated sha of 7+ characters matches,
 *       a different one does not
 *   G11 polling waits through building states and passes once READY
 *   G12 a PASS that cannot be written to the ledger is exit 2, not 0
 *   G13 --dry-run prints the plan (branch and refspec included), changes nothing and exits
 *       4 rather than the 0 of a PASS, and still exits 2 with no smoke command
 *   G14 bad arguments are exit 2
 *   G15 the push and gh guards refuse anything but the revert refspec and a draft PR
 *
 * Run: node tooling/test-deploy-gate.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'deploy-gate.js');
const dg = require(SUBJECT);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-gate-test-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 500) : ''));
}

// ------------------------------------------------------------------- the stubs

const STUBS = path.join(ROOT, 'stubs');
fs.mkdirSync(STUBS, { recursive: true });

const GIT_STUB = path.join(STUBS, 'git-stub.js');
fs.writeFileSync(GIT_STUB, `'use strict';
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.STUB_DIR, 'git.log'), JSON.stringify(a) + '\\n');
let i = 0;
if (a[0] === '-C') i = 2;
const sub = a[i];
const rest = a.slice(i + 1);
const key = sub === 'worktree' ? 'worktree-' + rest[0] : sub === 'rev-list' ? 'rev-list-' + (rest.includes('--count') ? 'count' : 'parents') : sub;
const fail = (process.env.GIT_STUB_FAIL || '').split(',');
const FULL = process.env.STUB_FULL_SHA;
if (fail.includes(key)) { process.stderr.write('stub: ' + key + ' failed on purpose\\n'); process.exitCode = 1; }
else if (key === 'rev-parse') process.stdout.write(FULL + '\\n');
else if (key === 'symbolic-ref') process.stdout.write('origin/main\\n');
else if (key === 'rev-list-parents') process.stdout.write(FULL + ' ' + 'a'.repeat(40) + (process.env.STUB_MERGE ? ' ' + 'b'.repeat(40) : '') + '\\n');
else if (key === 'rev-list-count') process.stdout.write('1\\n');
else if (key === 'worktree-add') fs.mkdirSync(rest[3], { recursive: true });
`, 'utf8');

const GH_STUB = path.join(STUBS, 'gh-stub.js');
fs.writeFileSync(GH_STUB, `'use strict';
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.STUB_DIR, 'gh.log'), JSON.stringify(a) + '\\n');
const bf = a.indexOf('--body-file');
if (bf >= 0) { try { fs.writeFileSync(path.join(process.env.STUB_DIR, 'gh-body.md'), fs.readFileSync(a[bf + 1], 'utf8')); } catch (e) { /* recorded as absent */ } }
if (process.env.GH_STUB_FAIL) { process.stderr.write('stub: gh failed on purpose\\n'); process.exitCode = 1; }
else process.stdout.write('https://example.test/owner/repo/pull/9\\n');
`, 'utf8');

const INSPECT_STUB = path.join(STUBS, 'inspect-stub.js');
fs.writeFileSync(INSPECT_STUB, `'use strict';
const fs = require('fs');
const path = require('path');
const dir = process.env.STUB_DIR;
fs.appendFileSync(path.join(dir, 'inspect.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.STUB_INSPECT_FAIL) { process.stderr.write('stub: inspect failed on purpose\\n'); process.exitCode = 1; }
else {
    const c = path.join(dir, 'inspect-count');
    const n = (fs.existsSync(c) ? Number(fs.readFileSync(c, 'utf8')) : 0) + 1;
    fs.writeFileSync(c, String(n));
    let file = null;
    for (let k = n; k >= 1; k--) {
        const p = path.join(dir, 'inspect-' + k + '.json');
        if (fs.existsSync(p)) { file = p; break; }
    }
    if (!file) { process.stderr.write('stub: no inspect file\\n'); process.exitCode = 1; }
    else process.stdout.write(fs.readFileSync(file, 'utf8'));
}
`, 'utf8');

const SMOKE_STUB = path.join(STUBS, 'smoke-stub.js');
fs.writeFileSync(SMOKE_STUB, `'use strict';
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.STUB_DIR, 'smoke.log'), JSON.stringify(a) + '\\n');
if (a.includes('sleep')) setTimeout(() => {}, 20000);
else process.exitCode = Number(process.env.STUB_SMOKE_EXIT || 0);
`, 'utf8');

// ------------------------------------------------------------------- the runner

const SHA = 'c0ffee1234567890abcdef1234567890abcdef12';
const SHORT = SHA.slice(0, 8);
const URL_PROD = 'https://shop.example.test/';
let caseNo = 0;
const allGitCalls = [];

const dep = (over = {}) => ({ url: 'shop-abc.example.test', target: 'production', readyState: 'READY', meta: { githubCommitSha: SHA }, ...over });
const q = (s) => `"${s}"`;

/**
 * Run the gate once. opts: pkg (object | null | string for the autodevDeployGate), inspect (array of
 * JSON docs, one per poll), args (extra argv), env (extra env), smoke (command line).
 */
function run(opts = {}) {
    const dir = path.join(ROOT, 'case-' + (caseNo++));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    if (opts.pkg !== null) {
        const gateCfg = opts.pkg !== undefined ? opts.pkg : { smoke: opts.smoke || `node ${q(SMOKE_STUB)} {url}`, url: URL_PROD };
        fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', autodevDeployGate: gateCfg }), 'utf8');
    }
    (opts.inspect || [dep()]).forEach((doc, i) => fs.writeFileSync(path.join(dir, `inspect-${i + 1}.json`), typeof doc === 'string' ? doc : JSON.stringify(doc), 'utf8'));
    const env = {
        ...process.env,
        STUB_DIR: dir, STUB_FULL_SHA: SHA,
        AUTODEV_GIT_BIN: GIT_STUB, AUTODEV_GH_BIN: GH_STUB,
        AUTODEV_DEPLOY_INSPECT_CMD: `node ${q(INSPECT_STUB)} {url}`,
        AUTODEV_DEPLOY_EVENTS: path.join(dir, 'ledger', 'events.jsonl'),
        AUTODEV_NOTIFY_DIR: path.join(dir, 'notify'),
        AUTODEV_DIGEST_DIR: path.join(dir, 'digest'),
        AUTODEV_DEPLOY_GATE_POLL_MS: '40',
        ...(opts.env || {}),
    };
    const argv = ['--repo-dir', repo, '--sha', SHA, '--timeout-ms', '800', '--smoke-timeout-ms', '8000', ...(opts.args || [])];
    const r = spawnSync(process.execPath, [SUBJECT, ...argv], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } };
    const json = (f) => lines(f).map((l) => JSON.parse(l));
    const res = {
        dir, status: r.status, out: (r.stdout || '') + (r.stderr || ''),
        git: json(path.join(dir, 'git.log')), gh: json(path.join(dir, 'gh.log')),
        inspect: lines(path.join(dir, 'inspect.log')), smoke: json(path.join(dir, 'smoke.log')),
        ledger: json(path.join(dir, 'ledger', 'events.jsonl')),
        notify: json(path.join(dir, 'notify', 'owner.jsonl')),
        digest: fs.existsSync(path.join(dir, 'digest')) ? fs.readdirSync(path.join(dir, 'digest')) : [],
        body: (() => { try { return fs.readFileSync(path.join(dir, 'gh-body.md'), 'utf8'); } catch { return null; } })(),
    };
    res.git.forEach((c) => allGitCalls.push(c));
    res.sub = (name) => res.git.filter((c) => c[c[0] === '-C' ? 2 : 0] === name);
    return res;
}

const verdicts = (r) => r.ledger.filter((e) => e.kind === 'deploy-gate');

// ------------------------------------------------------------------ G1 no smoke

{
    const cases = [
        ['no package.json', run({ pkg: null })],
        ['empty smoke string', run({ pkg: { smoke: '   ', url: URL_PROD } })],
        ['smoke is not a string', run({ pkg: { smoke: 42, url: URL_PROD } })],
        ['gate config is not an object', run({ pkg: 'oops' })],
        ['gate config is an array', run({ pkg: [] })],
    ];
    for (const [label, r] of cases) {
        check(`G1 ${label}: exit 2`, r.status === 2, `status ${r.status}\n${r.out}`);
        check(`G1 ${label}: says INDETERMINATE and not a pass`, /INDETERMINATE/.test(r.out) && !/\bPASS\b/.test(r.out), r.out);
        check(`G1 ${label}: no polling, no ledger, no notification, no git`, r.inspect.length === 0 && r.ledger.length === 0 && r.notify.length === 0 && r.git.length === 0 && r.digest.length === 0, JSON.stringify({ i: r.inspect.length, l: r.ledger.length, n: r.notify.length }));
    }
    // a package.json with no autodevDeployGate key at all
    const dir = path.join(ROOT, 'case-nokey');
    fs.mkdirSync(path.join(dir, 'repo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'repo', 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'echo' } }), 'utf8');
    const r = spawnSync(process.execPath, [SUBJECT, '--repo-dir', path.join(dir, 'repo'), '--sha', SHA, '--prod-url', URL_PROD], { encoding: 'utf8', env: { ...process.env, AUTODEV_DEPLOY_EVENTS: path.join(dir, 'l.jsonl'), AUTODEV_NOTIFY_DIR: path.join(dir, 'n') } });
    check('G1 no autodevDeployGate key: exit 2 and never PASS', r.status === 2 && /INDETERMINATE/.test(r.stdout) && !fs.existsSync(path.join(dir, 'l.jsonl')), `${r.status} ${r.stdout}`);
}

// ----------------------------------------------------------------- G2 no url

{
    const r = run({ pkg: { smoke: `node ${q(SMOKE_STUB)} {url}` } });
    check('G2 no url anywhere: exit 2, nothing polled', r.status === 2 && r.inspect.length === 0 && /production URL/.test(r.out), `${r.status}\n${r.out}`);
    const r2 = run({ pkg: { smoke: `node ${q(SMOKE_STUB)} {url}`, url: 'ftp://nope.example.test' } });
    check('G2 a non-http url is exit 2', r2.status === 2 && r2.inspect.length === 0, `${r2.status}\n${r2.out}`);
    const r3 = run({ pkg: { smoke: `node ${q(SMOKE_STUB)} {url}` }, args: ['--prod-url', URL_PROD] });
    check('G2 --prod-url alone is enough', r3.status === 0, `${r3.status}\n${r3.out}`);
}

// ------------------------------------------------------------------- G3 PASS

{
    const r = run();
    check('G3 PASS: exit 0', r.status === 0, `${r.status}\n${r.out}`);
    check('G3 PASS: smoke ran once with the url', r.smoke.length === 1 && r.smoke[0][0] === URL_PROD, JSON.stringify(r.smoke));
    check('G3 PASS: exactly one ledger verdict, PASS, with the sha', verdicts(r).length === 1 && verdicts(r)[0].result === 'PASS' && verdicts(r)[0].sha === SHA && r.ledger.length === 1, JSON.stringify(r.ledger));
    check('G3 PASS: one notification, deploy-done, nothing in the digest', r.notify.length === 1 && r.notify[0].kind === 'deploy-done' && r.digest.length === 0, JSON.stringify(r.notify));
    check('G3 PASS: git and gh are never called', r.git.length === 0 && r.gh.length === 0, JSON.stringify([r.git, r.gh]));
    check('G3 PASS: the inspect command got the production url', r.inspect.length >= 1 && JSON.parse(r.inspect[0])[0] === URL_PROD, r.inspect.join('|'));
}

// ---------------------------------------------- G4 the url is one argument

{
    const evil = 'https://shop.example.test/a?x=1;touch%20pwned&y=$(id)';
    const r = run({ args: ['--prod-url', evil], pkg: { smoke: `node ${q(SMOKE_STUB)} --target={url} --flag` } });
    const href = new URL(evil).href;
    check('G4 the url sits inside one argument', r.status === 0 && r.smoke.length === 1 && r.smoke[0].length === 2 && r.smoke[0][0] === `--target=${href}`, JSON.stringify(r.smoke));
    check('G4 nothing was executed from the url', !fs.existsSync(path.join(process.cwd(), 'pwned')) && !fs.existsSync(path.join(r.dir, 'repo', 'pwned')));
}

// ----------------------------------------------------------- G5 FAIL + revert

function expectRevertFlow(label, r, { mergeFlag = false } = {}) {
    check(`G5 ${label}: exit 1`, r.status === 1, `${r.status}\n${r.out}`);
    const v = verdicts(r);
    check(`G5 ${label}: one FAIL verdict in the ledger, plus the revert outcome`, v.length === 1 && v[0].result === 'FAIL' && r.ledger.some((e) => e.kind === 'deploy-gate-revert' && e.ok === true), JSON.stringify(r.ledger));
    const add = r.sub('worktree').find((c) => c.includes('add'));
    check(`G5 ${label}: a temp worktree on a NEW branch revert/${SHORT} off origin/main`, add && add.includes('-b') && add.includes(`revert/${SHORT}`) && add[add.length - 1] === 'origin/main', JSON.stringify(add));
    const rev = r.sub('revert').find((c) => !c.includes('--abort'));
    check(`G5 ${label}: git revert of the sha${mergeFlag ? ' with -m 1' : ''}`, rev && rev.includes('--no-edit') && rev.includes(SHA) && (mergeFlag ? rev.includes('-m') && rev[rev.indexOf('-m') + 1] === '1' : !rev.includes('-m')), JSON.stringify(rev));
    const pushes = r.sub('push');
    const refspec = `refs/heads/revert/${SHORT}:refs/heads/revert/${SHORT}`;
    check(`G5 ${label}: exactly ONE push, exactly the revert refspec to origin`, pushes.length === 1 && pushes[0].slice(pushes[0].indexOf('push')).join(' ') === `push origin ${refspec}`, JSON.stringify(pushes));
    check(`G5 ${label}: no force flag on the push`, !pushes[0].some((x) => /^(-f|--force.*|\+.*)$/.test(x)), JSON.stringify(pushes));
    check(`G5 ${label}: one gh call, a DRAFT pr create against main from the revert branch`, r.gh.length === 1 && r.gh[0][0] === 'pr' && r.gh[0][1] === 'create' && r.gh[0].includes('--draft') && r.gh[0][r.gh[0].indexOf('--base') + 1] === 'main' && r.gh[0][r.gh[0].indexOf('--head') + 1] === `revert/${SHORT}`, JSON.stringify(r.gh));
    check(`G5 ${label}: the PR body names the sha and says draft`, r.body !== null && r.body.includes(SHA) && /DRAFT/.test(r.body), r.body);
    check(`G5 ${label}: the temp worktree is removed`, r.sub('worktree').some((c) => c.includes('remove')), JSON.stringify(r.sub('worktree')));
    check(`G5 ${label}: exactly ONE notification, deploy-failed, naming the draft PR`, r.notify.length === 1 && r.notify[0].kind === 'deploy-failed' && /pull\/9/.test(JSON.stringify(r.notify[0])), JSON.stringify(r.notify));
}

expectRevertFlow('smoke exits 1', run({ env: { STUB_SMOKE_EXIT: '1' } }));
{
    const r = run({ smoke: `node ${q(SMOKE_STUB)} {url} sleep`, pkg: { smoke: `node ${q(SMOKE_STUB)} {url} sleep`, url: URL_PROD }, args: ['--smoke-timeout-ms', '400'] });
    expectRevertFlow('smoke times out', r);
    check('G5 smoke times out: the reason says so', verdicts(r)[0] && /did not finish/.test(verdicts(r)[0].reason), JSON.stringify(verdicts(r)));
}
{
    const r = run({ pkg: { smoke: 'definitely-not-a-binary-xyz {url}', url: URL_PROD } });
    expectRevertFlow('smoke cannot start', r);
    check('G5 smoke cannot start: the reason says so', verdicts(r)[0] && /could not start/.test(verdicts(r)[0].reason), JSON.stringify(verdicts(r)));
}
{
    const r = run({ inspect: [dep({ readyState: 'ERROR' })] });
    expectRevertFlow('deployment ended ERROR', r);
    check('G5 deployment ERROR: the smoke command never ran', r.smoke.length === 0, JSON.stringify(r.smoke));
}
{
    const r = run({ env: { STUB_SMOKE_EXIT: '1', STUB_MERGE: '1' } });
    expectRevertFlow('merge commit', r, { mergeFlag: true });
}
{
    const r = run({ env: { STUB_SMOKE_EXIT: '3' }, args: ['--base', 'trunk', '--repo', 'owner/repo'] });
    const add = r.sub('worktree').find((c) => c.includes('add'));
    check('G5 --base is the start point and the PR base, --repo is passed on', add && add[add.length - 1] === 'origin/trunk' && r.gh[0][r.gh[0].indexOf('--base') + 1] === 'trunk' && r.gh[0][r.gh[0].indexOf('--repo') + 1] === 'owner/repo', JSON.stringify([add, r.gh]));
}

// ---------------------------------------------------- G7 partial revert failures

{
    const conflict = run({ env: { STUB_SMOKE_EXIT: '1', GIT_STUB_FAIL: 'revert' } });
    check('G7 conflicting revert: exit 1, no push, no gh, abort attempted', conflict.status === 1 && conflict.sub('push').length === 0 && conflict.gh.length === 0 && conflict.sub('revert').some((c) => c.includes('--abort')), JSON.stringify(conflict.git));
    check('G7 conflicting revert: ONE notification that says no revert PR was made', conflict.notify.length === 1 && conflict.notify[0].kind === 'deploy-failed' && /No revert PR/.test(conflict.notify[0].text), JSON.stringify(conflict.notify));
    check('G7 conflicting revert: the ledger records the failed revert and the worktree is removed', conflict.ledger.some((e) => e.kind === 'deploy-gate-revert' && e.ok === false && e.step === 'revert') && conflict.sub('worktree').some((c) => c.includes('remove')), JSON.stringify(conflict.ledger));

    const push = run({ env: { STUB_SMOKE_EXIT: '1', GIT_STUB_FAIL: 'push' } });
    check('G7 failed push: exit 1, no gh, one notification', push.status === 1 && push.gh.length === 0 && push.notify.length === 1 && /No revert PR/.test(push.notify[0].text), JSON.stringify([push.gh, push.notify]));

    const gh = run({ env: { STUB_SMOKE_EXIT: '1', GH_STUB_FAIL: '1' } });
    check('G7 failed gh: exit 1, the branch is pushed, ONE notification says the PR was not made', gh.status === 1 && gh.sub('push').length === 1 && gh.notify.length === 1 && /No revert PR/.test(gh.notify[0].text) && /pushed/.test(gh.notify[0].text), JSON.stringify(gh.notify));

    const wt = run({ env: { STUB_SMOKE_EXIT: '1', GIT_STUB_FAIL: 'worktree-add' } });
    check('G7 worktree cannot be made: nothing pushed, no gh, one notification', wt.status === 1 && wt.sub('push').length === 0 && wt.gh.length === 0 && wt.notify.length === 1, JSON.stringify(wt.git));

    const unknown = run({ env: { STUB_SMOKE_EXIT: '1', GIT_STUB_FAIL: 'rev-parse' } });
    check('G7 sha unknown to the repo: nothing created, exit 1, one notification', unknown.status === 1 && unknown.sub('push').length === 0 && unknown.sub('worktree').length === 0 && unknown.notify.length === 1, JSON.stringify(unknown.git));
}

// --------------------------------------------------------------- G9 TIMEOUT

function expectTimeout(label, r) {
    check(`G9 ${label}: exit 3`, r.status === 3, `${r.status}\n${r.out}`);
    check(`G9 ${label}: the smoke command never ran`, r.smoke.length === 0, JSON.stringify(r.smoke));
    check(`G9 ${label}: never reported as PASS`, !/\bPASS\b/.test(r.out) && !r.ledger.some((e) => e.result === 'PASS'), r.out);
    check(`G9 ${label}: a TIMEOUT verdict, one blocked-on-owner notification`, verdicts(r).length === 1 && verdicts(r)[0].result === 'TIMEOUT' && r.notify.length === 1 && r.notify[0].kind === 'blocked-on-owner', JSON.stringify([r.ledger, r.notify]));
    check(`G9 ${label}: nothing created`, r.git.length === 0 && r.gh.length === 0, JSON.stringify([r.git, r.gh]));
    check(`G9 ${label}: it kept polling`, r.inspect.length >= 2, String(r.inspect.length));
}
expectTimeout('still building', run({ inspect: [dep({ readyState: 'BUILDING' })] }));
expectTimeout('production serves another sha', run({ inspect: [dep({ meta: { githubCommitSha: 'f'.repeat(40) } })] }));
expectTimeout('the JSON carries no commit sha', run({ inspect: [{ url: 'x.example.test', target: 'production', readyState: 'READY' }] }));
expectTimeout('the deployment is a preview (target null)', run({ inspect: [dep({ target: null })] }));
expectTimeout('the JSON has no target field', run({ inspect: [{ url: 'x', readyState: 'READY', meta: { githubCommitSha: SHA } }] }));
expectTimeout('the inspect output is not JSON', run({ inspect: ['not json at all'] }));
expectTimeout('the inspect command fails', run({ env: { STUB_INSPECT_FAIL: '1' } }));
expectTimeout('an empty object', run({ inspect: [{}] }));
{
    const r = run({ inspect: [dep({ readyState: 'BUILDING' })] });
    check('G9 the timeout reason names the last thing seen', verdicts(r)[0] && /BUILDING/.test(verdicts(r)[0].reason), JSON.stringify(verdicts(r)));
}

// ----------------------------------------------------------- G10 sha matching

{
    const abbreviated = run({ inspect: [dep({ meta: { githubCommitSha: SHA.slice(0, 7) } })] });
    check('G10 a 7 character sha of the commit matches', abbreviated.status === 0, `${abbreviated.status}\n${abbreviated.out}`);
    const longer = run({ inspect: [dep({ meta: { gitlabCommitSha: SHA.toUpperCase() } })] });
    check('G10 the sha is case-insensitive and read from the other host fields', longer.status === 0, `${longer.status}\n${longer.out}`);
    const nested = run({ inspect: [{ deployment: dep() }] });
    check('G10 a deployment nested under "deployment" is read', nested.status === 0, `${nested.status}\n${nested.out}`);
    const other = run({ inspect: [dep({ meta: { githubCommitSha: SHA.slice(0, 7) + '9'.repeat(33) } })] });
    check('G10 a sha that only shares a 7 character prefix with a LONGER different sha does not match', other.status === 3 && other.smoke.length === 0, `${other.status}`);
}

// -------------------------------------------------------------- G11 sequence

{
    const r = run({ inspect: [dep({ readyState: 'QUEUED', meta: { githubCommitSha: 'e'.repeat(40) } }), dep({ readyState: 'BUILDING' }), dep()], args: ['--timeout-ms', '5000'] });
    check('G11 waits through other-sha and building states, then PASSes', r.status === 0 && r.inspect.length === 3 && r.smoke.length === 1, `${r.status} polls=${r.inspect.length}\n${r.out}`);
    check('G11 the ledger records the poll count', verdicts(r)[0] && verdicts(r)[0].polls === 3, JSON.stringify(verdicts(r)));
}

// ------------------------------------------------------ G12 unrecorded PASS

{
    const blocked = path.join(ROOT, 'a-file-not-a-dir');
    fs.writeFileSync(blocked, 'x', 'utf8');
    const r = run({ env: { AUTODEV_DEPLOY_EVENTS: path.join(blocked, 'events.jsonl') } });
    check('G12 a PASS that cannot be recorded is exit 2, not 0', r.status === 2 && /could not be written/.test(r.out) && !/deploy-gate: PASS/.test(r.out), `${r.status}\n${r.out}`);
    check('G12 and sends no deploy-done', r.notify.length === 0, JSON.stringify(r.notify));
}

// --------------------------------------------------------------- G13 dry run

{
    const r = run({ args: ['--dry-run'] });
    check('G13 dry run: exit 4, its own code, never the 0 of a PASS, and prints the plan', r.status === 4 && dg.EXIT_DRY_RUN === 4 && /DRY RUN/.test(r.out), `${r.status}\n${r.out}`);
    check('G13 dry run: names the branch, the only push and the draft PR', r.out.includes(`revert/${SHORT}`) && r.out.includes(`git push origin refs/heads/revert/${SHORT}:refs/heads/revert/${SHORT}`) && /gh pr create --draft/.test(r.out), r.out);
    check('G13 dry run: names the smoke command with the url filled in', r.out.includes(URL_PROD) && r.out.includes('smoke-stub.js'), r.out);
    check('G13 dry run: nothing ran, nothing was written', r.inspect.length === 0 && r.smoke.length === 0 && r.git.length === 0 && r.gh.length === 0 && r.ledger.length === 0 && r.notify.length === 0 && r.digest.length === 0 && !fs.existsSync(path.join(r.dir, 'ledger')) && !fs.existsSync(path.join(r.dir, 'notify')), JSON.stringify(fs.readdirSync(r.dir)));
    const none = run({ args: ['--dry-run'], pkg: null });
    check('G13 dry run with no smoke command is still exit 2', none.status === 2 && /INDETERMINATE/.test(none.out), `${none.status}\n${none.out}`);
}

// ---------------------------------------------------------------- G14 bad args

for (const [label, args] of [
    ['unknown flag', ['--nope']],
    ['sha that is not hex', ['--sha', 'zzzzzzzz']],
    ['sha too short', ['--sha', 'abc']],
    ['non-numeric timeout', ['--timeout-ms', 'soon']],
    ['zero timeout', ['--timeout-ms', '0']],
    ['base that is a revert branch', ['--base', 'revert/abc']],
    ['bad repo', ['--repo', 'not a repo']],
    ['flag without a value', ['--prod-url']],
]) {
    const dir = path.join(ROOT, 'bad-' + caseNo++);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ autodevDeployGate: { smoke: 'echo {url}', url: URL_PROD } }), 'utf8');
    const r = spawnSync(process.execPath, [SUBJECT, '--repo-dir', dir, '--sha', SHA, ...args], { encoding: 'utf8', env: { ...process.env, AUTODEV_DEPLOY_EVENTS: path.join(dir, 'l.jsonl'), AUTODEV_NOTIFY_DIR: path.join(dir, 'n') } });
    check(`G14 ${label}: exit 2, nothing written`, r.status === 2 && !fs.existsSync(path.join(dir, 'l.jsonl')) && !fs.existsSync(path.join(dir, 'n')), `${r.status} ${r.stdout}${r.stderr}`);
}
{
    const r = spawnSync(process.execPath, [SUBJECT], { encoding: 'utf8' });
    check('G14 no arguments: exit 2 with usage', r.status === 2 && /--repo-dir is required/.test(r.stdout), `${r.status} ${r.stdout}`);
    const h = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8' });
    check('G14 --help: exit 0', h.status === 0 && /deploy-gate/.test(h.stdout));
    const nd = spawnSync(process.execPath, [SUBJECT, '--repo-dir', path.join(ROOT, 'does-not-exist'), '--sha', SHA], { encoding: 'utf8' });
    check('G14 a missing repo dir is exit 2', nd.status === 2, `${nd.status} ${nd.stdout}`);
}

// ----------------------------------------------------------------- G15 guards

{
    const refspec = `refs/heads/revert/${SHORT}:refs/heads/revert/${SHORT}`;
    const ok = ['-C', 'wt', 'push', 'origin', refspec];
    check('G15 the revert push passes the guard', (() => { try { dg.assertPushSafe(ok, `revert/${SHORT}`, 'main'); return true; } catch { return false; } })());
    const refuse = (label, args, branch, base) => check(`G15 push guard refuses ${label}`, (() => { try { dg.assertPushSafe(args, branch, base); return false; } catch { return true; } })());
    refuse('a force flag', ['-C', 'wt', 'push', '--force', 'origin', refspec], `revert/${SHORT}`, 'main');
    refuse('a plus refspec', ['-C', 'wt', 'push', 'origin', '+' + refspec], `revert/${SHORT}`, 'main');
    refuse('main', ['-C', 'wt', 'push', 'origin', 'refs/heads/main:refs/heads/main'], 'main', 'main');
    refuse('a branch that is not revert/', ['-C', 'wt', 'push', 'origin', 'refs/heads/feature:refs/heads/feature'], 'feature', 'main');
    refuse('a revert branch that is the base', ['-C', 'wt', 'push', 'origin', 'refs/heads/revert/x:refs/heads/revert/x'], 'revert/x', 'revert/x');
    refuse('a refspec onto a different remote branch', ['-C', 'wt', 'push', 'origin', `refs/heads/revert/${SHORT}:refs/heads/main`], `revert/${SHORT}`, 'main');
    refuse('an extra argument', ['-C', 'wt', 'push', 'origin', refspec, '--delete'], `revert/${SHORT}`, 'main');
    refuse('a different remote', ['-C', 'wt', 'push', 'upstream', refspec], `revert/${SHORT}`, 'main');
    const ghRefuse = (label, args) => check(`G15 gh guard refuses ${label}`, (() => { try { dg.assertGhSafe(args); return false; } catch { return true; } })());
    ghRefuse('a pr create without --draft', ['pr', 'create', '--title', 't']);
    ghRefuse('a pr merge', ['pr', 'merge', '9', '--draft']);
    ghRefuse('an api call', ['api', 'repos/o/r/merges']);
    check('G15 a draft pr create passes the gh guard', (() => { try { dg.assertGhSafe(['pr', 'create', '--draft']); return true; } catch { return false; } })());
}

// ------------------------------------------------------ G6 main never touched

{
    const pushes = allGitCalls.filter((c) => c.includes('push'));
    check('G6 across every case there were pushes to check', pushes.length >= 6, String(pushes.length));
    check('G6 every push was a revert/ refspec to origin and nothing else', pushes.every((c) => /^refs\/heads\/revert\/[0-9a-f]{8}:refs\/heads\/revert\/[0-9a-f]{8}$/.test(c[c.length - 1]) && c[c.length - 2] === 'origin' && c.length === 5), JSON.stringify(pushes.filter((c) => !(c.length === 5))));
    const verbs = new Set(allGitCalls.map((c) => c[c[0] === '-C' ? 2 : 0]));
    for (const banned of ['merge', 'reset', 'checkout', 'switch', 'rebase', 'cherry-pick', 'commit', 'tag', 'branch']) check(`G6 git ${banned} is never called`, !verbs.has(banned), [...verbs].join(','));
    check('G6 no git call but the temp worktree removal carries a force flag', !allGitCalls.filter((c) => c[c[0] === '-C' ? 2 : 0] !== 'worktree').some((c) => c.some((x) => /^(--force|-f|--force-with-lease.*)$/.test(x))));
    check('G6 the only subcommands used are the expected ones', [...verbs].every((v) => ['rev-parse', 'symbolic-ref', 'fetch', 'rev-list', 'worktree', 'revert', 'push'].includes(v)), [...verbs].join(','));
}

// ----------------------------------------------------------------- units

{
    check('splitArgv: words', JSON.stringify(dg.splitArgv('a b  c')) === '["a","b","c"]');
    check('splitArgv: quotes group', JSON.stringify(dg.splitArgv('node "a b" \'c d\' e')) === '["node","a b","c d","e"]');
    check('splitArgv: an empty quoted token is kept', JSON.stringify(dg.splitArgv('a "" b')) === '["a","","b"]');
    check('splitArgv: an unterminated quote throws', (() => { try { dg.splitArgv('a "b'); return false; } catch { return true; } })());
    check('withUrl: replaces inside a token, never splits one', JSON.stringify(dg.withUrl(['x', '--u={url}', '{url}'], 'https://a b.test/')) === '["x","--u=https://a b.test/","https://a b.test/"]');
    check('judgeDeployment: a non-object is pending', dg.judgeDeployment(null, SHA).state === 'pending' && dg.judgeDeployment([], SHA).state === 'pending' && dg.judgeDeployment('x', SHA).state === 'pending');
    check('judgeDeployment: READY and same sha is a candidate', dg.judgeDeployment(dep(), SHA).state === 'candidate');
    check('judgeDeployment: READY with no sha is pending, never a candidate', dg.judgeDeployment(dep({ meta: {} }), SHA).state === 'pending');
    check('judgeDeployment: ERROR is failed, only for the same sha', dg.judgeDeployment(dep({ readyState: 'ERROR' }), SHA).state === 'failed' && dg.judgeDeployment(dep({ readyState: 'ERROR', meta: { githubCommitSha: 'f'.repeat(40) } }), SHA).state === 'pending');
    check('judgeDeployment: status is read when readyState is absent', dg.judgeDeployment({ ...dep(), readyState: undefined, status: 'READY' }, SHA).state === 'candidate');
    check('judgeDeployment: a sha under 7 characters is not read', dg.shaOf({ meta: { githubCommitSha: 'abc123' } }) === null);
    check('parseArgs: defaults', (() => { const a = dg.parseArgs(['--repo-dir', 'd', '--sha', SHA]); return a.timeoutMs === 15 * 60 * 1000 && a.dryRun === false && a.sha === SHA; })());
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp dir */ }

if (failures.length) {
    console.log(`test-deploy-gate: ${passed} passed, ${failures.length} FAILED`);
    for (const f of failures) console.log('  FAIL ' + f);
    process.exitCode = 1;
} else {
    console.log(`test-deploy-gate: ${passed} passed, 0 failed`);
}
