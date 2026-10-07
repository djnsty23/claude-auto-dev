#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/fast-lane.js: the classifier that
// lets a small, non-sensitive merge candidate skip the full gate, and the
// receipt merge-lock.js accepts in its place.
// Run: node tooling/test-fast-lane.js
// Exits 1 on any failure, 0 when all pass.
//
// THE SUBJECT RUNS AS A SUBPROCESS on a real git repo built under the OS temp
// root, outside this checkout, with real `npm run` steps. Each step script
// appends its name to ran.log (gitignored), so a refusal is checked to have run
// NOTHING, not only to have exited 1. The planted ineligible candidates are
// written here by hand: an auth path, 101 lines, a migration. Every expected
// reason is a literal, so narrowing the subject's pattern list cannot narrow
// these fixtures with it. Merge-lock's side of the receipt is in
// tooling/test-merge-lock.js (F1 to F7).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fast-lane.js');
const fl = require(SUBJECT);

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fastlane'));
const REPO = path.join(root, 'repo');
const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fast-lane-test', GIT_AUTHOR_EMAIL: 'fast-lane-test@invalid',
    GIT_COMMITTER_NAME: 'fast-lane-test', GIT_COMMITTER_EMAIL: 'fast-lane-test@invalid',
    GIT_CONFIG_NOSYSTEM: '1',
};
function git(...args) {
    const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', env: GIT_ENV, windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
}
function write(rel, text) {
    const p = path.join(REPO, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
}
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

const STEP_SCRIPTS = { lint: 'node mark.js lint', typecheck: 'node mark.js typecheck', test: 'node mark.js test', build: 'node mark.js build' };
function pkg(scripts = STEP_SCRIPTS, config) {
    return `${JSON.stringify({ name: 'fixture', private: true, scripts, ...(config ? { autodevFastLane: config } : {}) }, null, 2)}\n`;
}

/** A fresh base commit on branch `base`, with origin/main pointing at it. */
function makeBase(pkgText) {
    git('checkout', '-q', '-f', '--orphan', `base${Date.now()}${Math.random().toString(16).slice(2, 6)}`);
    git('rm', '-q', '-rf', '--ignore-unmatch', '.');
    git('clean', '-q', '-fdx');
    write('.gitignore', 'ran.log\n');
    write('mark.js', "require('fs').appendFileSync('ran.log', process.argv[2] + '\\n');\nprocess.exitCode = Number(process.env['FAIL_' + process.argv[2].toUpperCase()] || 0);\n");
    write('package.json', pkgText);
    write('src/app.js', lines(20));
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const sha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', sha);
    return sha;
}

/** A candidate commit on top of the current origin/main. */
function makeCandidate(files) {
    git('checkout', '-q', '-f', '-B', 'cand', 'refs/remotes/origin/main');
    git('clean', '-q', '-fdx');
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    return git('rev-parse', 'HEAD');
}

function cli(args, envExtra = {}) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env: { ...process.env, ...envExtra }, timeout: 300000, windowsHide: true });
    return { exit: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const ranLog = () => { try { return fs.readFileSync(path.join(REPO, 'ran.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
let outNo = 0;
function runLane(head, envExtra) {
    const out = path.join(root, `receipt-${++outNo}.json`);
    const r = cli(['run', '--repo-dir', REPO, '--head', head, '--out', out], envExtra);
    let receipt = null;
    try { receipt = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* none written */ }
    return { ...r, out, receipt, ran: ranLog() };
}
const detail = (r) => `exit ${r.exit}; ${(r.err || r.out).trim().split('\n').slice(-1)[0].slice(0, 160)}`;
const has = (r, re) => Boolean(r.receipt && r.receipt.classifier && r.receipt.classifier.reasons.some((x) => re.test(x)));

function main() {
    fs.mkdirSync(REPO);
    spawnSync('git', ['init', '-q', REPO], { env: GIT_ENV, windowsHide: true });

    // -----------------------------------------------------------------------
    // A. The classifier alone.
    // -----------------------------------------------------------------------
    const f = (p, added, deleted = 0, oldPath) => ({ path: p, added, deleted, oldPath });
    const a1 = fl.classify([f('src/Footer.tsx', 8, 2), f('README.md', 2)]);
    check('A1. a 12-line diff in two plain files is eligible with no reasons',
        a1.eligible === true && a1.changedLines === 12 && a1.files === 2 && a1.reasons.length === 0, JSON.stringify(a1));
    const at100 = fl.classify([f('src/a.ts', 60, 40)]);
    const at101 = fl.classify([f('src/a.ts', 60, 41)]);
    check('A2. 100 changed lines is eligible and 101 is not, saying why',
        at100.eligible === true && at101.eligible === false && at101.reasons.includes('101 changed lines, over the 100-line limit'),
        `100 ${at100.eligible}, 101 ${JSON.stringify(at101.reasons)}`);
    const planted = [
        ['src/auth/guard.ts', 'auth'], ['app/api/OAuth/callback.ts', 'auth'], ['lib/session.ts', 'session'],
        ['src/middleware.ts', 'middleware'], ['src/payments/charge.ts', 'payment'], ['src/billing/plan.ts', 'billing'],
        ['lib/stripe.ts', 'stripe'], ['app/checkout/page.tsx', 'checkout'], ['db/rls.ts', 'RLS'],
        ['supabase/migrations/0001_init.ts', 'migration'], ['db/schema.sql', 'SQL'], ['app/login/page.tsx', 'login'],
        ['.env.example', 'env file'], ['src/policies/read.ts', 'policy'],
    ];
    const missed = planted.filter(([p, why]) => {
        const v = fl.classify([f(p, 1)]);
        return v.eligible || !v.reasons.includes(`${p} matches the sensitive pattern ${why}`);
    });
    check(`A3. each of ${planted.length} hand-written sensitive paths is ineligible with its own reason`,
        missed.length === 0, missed.map(([p]) => p).join(', '));
    const renamed = fl.classify([f('src/lib/money.ts', 0, 0, 'src/billing/money.ts')]);
    check('A4. a rename is judged on its old path as well as its new one',
        renamed.eligible === false && renamed.reasons.includes('src/billing/money.ts matches the sensitive pattern billing'), JSON.stringify(renamed.reasons));
    const bin = fl.classify([f('public/logo.png', null, null)]);
    const unread = fl.classify(null);
    const empty = fl.classify([]);
    check('A5. a binary file, an unreadable diff and an empty diff are ineligible, never eligible by default',
        !bin.eligible && /has no line count/.test(bin.reasons[0]) && !unread.eligible && unread.reasons[0] === 'the diff could not be read'
        && !empty.eligible && /diff is empty/.test(empty.reasons[0]), `${bin.reasons} | ${unread.reasons} | ${empty.reasons}`);
    const pk = fl.classify([f('package.json', 1, 1)]);
    check('A6. a changed package.json is ineligible, since it names the commands the lane runs',
        !pk.eligible && /package\.json names the commands/.test(pk.reasons[0]), JSON.stringify(pk.reasons));
    const cfg = fl.parseConfig(JSON.stringify({ autodevFastLane: { maxLines: 5, sensitive: ['^docs/legal'], steps: { build: null, typecheck: 'tsc' } } }));
    const viaCfg = fl.classify([f('docs/legal/terms.md', 3), f('src/auth.ts', 1)], cfg);
    check('A7. a config lowers the limit and adds a pattern, and the defaults still apply beside it',
        viaCfg.maxLines === 5 && viaCfg.reasons.includes('docs/legal/terms.md matches the sensitive pattern autodevFastLane.sensitive ^docs/legal')
        && viaCfg.reasons.includes('src/auth.ts matches the sensitive pattern auth') && fl.classify([f('a.ts', 6)], cfg).reasons.includes('6 changed lines, over the 5-line limit'),
        JSON.stringify(viaCfg.reasons));
    const bad = [
        '{ not json', JSON.stringify({ autodevFastLane: [] }), JSON.stringify({ autodevFastLane: { maxLines: -1 } }),
        JSON.stringify({ autodevFastLane: { sensitive: 'auth' } }), JSON.stringify({ autodevFastLane: { steps: { deploy: 'x' } } }),
        JSON.stringify({ autodevFastLane: { steps: { lint: 'a && rm -rf /' } } }), JSON.stringify({ autodevFastLane: { steps: [] } }),
    ];
    const threw = bad.filter((t) => { try { fl.parseConfig(t); return false; } catch { return true; } });
    const none = fl.parseConfig(null);
    check('A8. a malformed config throws in each of its seven shapes, and no package.json means the defaults',
        threw.length === bad.length && none.maxLines === 100 && none.sensitive.length === 0, `${threw.length} of ${bad.length} threw`);
    const plan = fl.planSteps(cfg, { lint: 'x', test: 'x' });
    check('A9. the step plan renames a step, honours a declared-absent one and marks a missing script',
        plan[0].script === 'lint' && !plan[0].missing && plan[1].script === 'tsc' && plan[1].missing === true
        && plan[3].declaredAbsent === true && plan.map((s) => s.step).join() === 'lint,typecheck,test,build', JSON.stringify(plan));
    const cmp = { files: [{ filename: 'a.png', status: 'modified', additions: 0, deletions: 0, changes: 0 }, { filename: 'b.ts', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: '@@' }] };
    const fromCmp = fl.filesFromCompare(cmp);
    const capped = fl.filesFromCompare({ files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, additions: 0, deletions: 0, changes: 0, patch: '' })) });
    check('A10. GitHub\'s file list: a binary has no line count, a text file keeps its counts, and the 300-file cap reads as unreadable',
        fromCmp[0].added === null && fromCmp[1].added === 2 && fromCmp[1].deleted === 1 && capped === null && fl.filesFromCompare({}) === null,
        JSON.stringify(fromCmp));

    // -----------------------------------------------------------------------
    // B. The CLI on a real repo, with real npm steps.
    // -----------------------------------------------------------------------
    makeBase(pkg());
    const small = makeCandidate({ 'src/app.js': lines(25), 'README.md': 'hello\n' });
    const green = runLane(small);
    const tree = git('rev-parse', `${small}^{tree}`);
    const steps = green.receipt ? green.receipt.steps : [];
    check('B1. a small clean candidate runs lint, typecheck, test and build in order and writes a green receipt for its tree',
        green.exit === 0 && green.ran.join() === 'lint,typecheck,test,build' && green.receipt.exit === 0 && green.receipt.tree === tree
        && green.receipt.head === small && steps.length === 4 && steps.every((s) => s.exit === 0 && s.command === `npm run ${s.step}`)
        && green.receipt.classifier.eligible === true && green.receipt.classifier.changedLines === 6, detail(green));
    const accepted = fl.receiptProblem(green.out, small);
    check('B2. merge-lock\'s receipt check accepts that receipt for its head and refuses it for another',
        accepted.receipt && !accepted.problem && /proves .*, not head/.test(fl.receiptProblem(green.out, 'f'.repeat(40)).problem || ''),
        JSON.stringify(accepted.problem || ''));
    const cls = cli(['classify', '--repo-dir', REPO, '--head', small]);
    const clsJson = cli(['classify', '--repo-dir', REPO, '--head', small, '--json']);
    check('B3. classify prints ELIGIBLE and exits 0, and --json carries the same verdict',
        cls.exit === 0 && /ELIGIBLE: 6 changed lines in 2 file/.test(cls.out) && clsJson.exit === 0 && JSON.parse(clsJson.out).eligible === true, detail(cls));

    const plants = [
        ['an auth path', { 'src/auth/guard.js': 'x\n' }, /src\/auth\/guard\.js matches the sensitive pattern auth/],
        ['101 lines', { 'src/big.js': lines(101) }, /^101 changed lines, over the 100-line limit$/],
        ['a migration', { 'migrations/0001_init.js': 'x\n' }, /migrations\/0001_init\.js matches the sensitive pattern migration/],
    ];
    for (const [label, files, re] of plants) {
        const head = makeCandidate(files);
        const r = runLane(head);
        const c = cli(['classify', '--repo-dir', REPO, '--head', head]);
        check(`B4. a planted candidate with ${label} is refused, runs no step, records why, and classify exits 1 naming it`,
            r.exit === 1 && r.ran.length === 0 && r.receipt && r.receipt.classifier.eligible === false && has(r, re)
            && r.receipt.steps.length === 0 && c.exit === 1 && c.out.split('\n').some((l) => re.test(l.replace(/^fast-lane: {3}/, '').trim())) && Boolean(fl.receiptProblem(r.out, head).problem),
            detail(r));
    }
    const hundred = makeCandidate({ 'src/hundred.js': lines(100) });
    check('B5. the boundary on a real diff: 100 added lines classifies eligible',
        cli(['classify', '--repo-dir', REPO, '--head', hundred]).exit === 0);

    const redHead = makeCandidate({ 'src/app.js': lines(21) });
    const red = runLane(redHead, { FAIL_TEST: '3' });
    const redWhy = fl.receiptProblem(red.out, redHead).problem || '';
    check('B6. a red test step stops the run before build, exits 1, records exit 3, and merge-lock refuses the receipt',
        red.exit === 1 && red.ran.join() === 'lint,typecheck,test' && red.receipt.exit === 1
        && red.receipt.steps.map((s) => `${s.step}:${s.exit}`).join() === 'lint:0,typecheck:0,test:3' && /test exited 3/.test(redWhy),
        `${detail(red)}; ${redWhy}`);

    fs.rmSync(path.join(REPO, 'ran.log'), { force: true });
    write('src/app.js', 'dirty\n');
    const dirty = runLane(redHead);
    check('B7. a dirty tree is refused before any step, and no receipt is written',
        dirty.exit === 1 && /uncommitted changes/.test(dirty.err) && dirty.receipt === null && dirty.ran.length === 0, detail(dirty));
    git('checkout', '-q', '-f', 'cand');
    const elsewhere = runLane(small);
    check('B8. a checkout at another commit than --head is refused', elsewhere.exit === 1 && /not --head/.test(elsewhere.err), detail(elsewhere));

    // The base config decides, and a candidate cannot loosen its own bar.
    makeBase(pkg({ lint: STEP_SCRIPTS.lint, 'type-check': STEP_SCRIPTS.typecheck, test: STEP_SCRIPTS.test }, { steps: { typecheck: 'type-check', build: null }, maxLines: 8 }));
    const tuned = makeCandidate({ 'src/app.js': lines(23) });
    const tr = runLane(tuned);
    check('B9. the base config renames typecheck, declares build absent and the run is green with build recorded as declared absent',
        tr.exit === 0 && tr.ran.join() === 'lint,typecheck,test' && tr.receipt.steps[1].command === 'npm run type-check'
        && tr.receipt.steps[3].declaredAbsent === true && !fl.receiptProblem(tr.out, tuned).problem, detail(tr));
    const over = makeCandidate({ 'src/app.js': lines(30) });
    const overR = runLane(over);
    check('B10. the base config\'s 8-line limit refuses a 10-line candidate', overR.exit === 1 && has(overR, /^10 changed lines, over the 8-line limit$/), detail(overR));
    const loosen = makeCandidate({ 'package.json': pkg(STEP_SCRIPTS, { maxLines: 100000 }), 'src/app.js': lines(21) });
    const loosenR = runLane(loosen);
    check('B11. a candidate that rewrites the config to loosen its own limit is refused for changing package.json',
        loosenR.exit === 1 && has(loosenR, /package\.json changes/) && loosenR.ran.length === 0, detail(loosenR));

    makeBase(pkg({ lint: STEP_SCRIPTS.lint, test: STEP_SCRIPTS.test, build: STEP_SCRIPTS.build }));
    const noTc = makeCandidate({ 'src/app.js': lines(21) });
    const noTcR = runLane(noTc);
    check('B12. a step with no script is red, not skipped: the run exits 1 and merge-lock refuses it',
        noTcR.exit === 1 && noTcR.receipt.steps[1].exit === null && /no "typecheck" script/.test(noTcR.err)
        && /typecheck exited null/.test(fl.receiptProblem(noTcR.out, noTc).problem || ''), detail(noTcR));

    const orphanBase = git('rev-parse', 'refs/remotes/origin/main');
    makeBase(pkg());
    const notAnc = cli(['classify', '--repo-dir', REPO, '--head', orphanBase]);
    check('B13. a head that does not contain origin/main is ineligible, naming the rebase',
        notAnc.exit === 1 && /is not an ancestor of .*: rebase onto it first/.test(notAnc.out), detail(notAnc));

    // -----------------------------------------------------------------------
    // C. The CLI surface.
    // -----------------------------------------------------------------------
    const h = cli(['--help']);
    const errs = [
        [[], /no command given/], [['bogus'], /unknown command bogus/], [['classify', '--repo-dir', REPO, '--head', 'abc'], /full 40-character/],
        [['run', '--repo-dir', REPO, '--head', small], /run needs --out/], [['classify', '--repo-dir', path.join(root, 'nope'), '--head', small], /must name a git checkout/],
        [['classify', '--head'], /--head needs a value/], [['classify', '--wat'], /unknown argument --wat/],
    ];
    const wrong = errs.filter(([args, re]) => { const r = cli(args); return !(r.exit === 1 && re.test(r.err)); });
    check('C1. --help exits 0 with usage, and seven malformed invocations each exit 1 with their own message',
        h.exit === 0 && /^usage: node fast-lane\.js classify/.test(h.out) && wrong.length === 0, wrong.map(([a]) => a.join(' ')).join(' | '));

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log('subject: plugins/autodev-core/scripts/fast-lane.js, its classifier in process and its CLI as a subprocess on a real git repo with real npm steps.');
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    process.exitCode = fail ? 1 : 0;
}

try { main(); } catch (e) {
    console.error(`test-fast-lane: ${e && e.stack ? e.stack : e}`);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exitCode = 2;
}
