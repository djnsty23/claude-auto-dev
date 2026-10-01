#!/usr/bin/env node
'use strict';

// Tests for plugins/autodev-core/scripts/check-ungated-apps.js.
//
// THE RISK THIS SUITE IS ABOUT is a detector that reads coverage where there
// is none. The incident it exists for was a nested app deliberately EXCLUDED
// from the root app's CI, so the case that matters most is not "a nested app
// with no CI file at all" but "a nested app the CI file names only to leave
// out". Every case plants its own repository and drives the CLI as a
// subprocess, because the exit code is the contract: 1 for an ungated app, 0
// once the same app is wired in, 2 when the run could not check anything.
//
// RED THEN GREEN ON ONE FIXTURE. The first block plants the incident shape and
// asserts red, then wires the SAME app into CI and asserts green. A detector
// that is always red or always green fails one half.

const __sb = require('./spawn-budget.js');
// A stubbed or broken helper is a RED, not an indeterminate run: see
// test-path-filter-deadlock.js for the sweep that taught this.
for (const __fn of ['classify', 'reason', 'runBudgeted', 'tally', 'exitCode']) {
    if (typeof __sb[__fn] !== 'function') {
        console.error('FAIL  spawn-budget.js does not export ' + __fn + '() -- this suite\'s own '
            + 'helper is missing or stubbed. That is a RED, not an indeterminate run.');
        process.exit(1);
    }
}
const { classify, reason, runBudgeted, tally, exitCode } = __sb;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-ungated-apps.js');

let pass = 0;
let fail = 0;
let infra = 0;
const failures = [];
const indeterminate = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ungated-suite-')));

/** Plant a repository: { relPath: content }. Objects are written as JSON. */
function repo(name, files, opts = {}) {
    const r = path.join(tmp, name);
    for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(r, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    }
    if (opts.git) {
        const git = (args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'].concat(args),
            { cwd: r, stdio: 'ignore', windowsHide: true });
        git(['init', '-q']);
        git(['add', '-A']);
        git(['commit', '-q', '-m', 'fixture']);
    }
    return r;
}

// `expect` names an outcome this call site provokes on purpose (exit 2), so it
// reaches the assertion instead of being counted as infrastructure.
function run(args, expect) {
    const r = runBudgeted(process.execPath, [SUBJECT].concat(args), { encoding: 'utf8', timeout: 30000 });
    if (classify(r, expect) === 'infrastructure') {
        infra++;
        const what = 'the subject run ' + JSON.stringify(args);
        indeterminate.push(what + ' (' + reason(r) + ')');
        console.error('infrastructure: ' + what + ' produced no verdict (' + reason(r) + ')');
    }
    return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function json(args, expect) {
    const r = run(args.concat('--json'), expect);
    let parsed = null;
    try { parsed = JSON.parse(r.out); } catch { /* stays null */ }
    return Object.assign(r, { json: parsed });
}

const appOf = (rep, p) => (rep && rep.apps ? rep.apps.find((a) => a.path === p) : null) || null;

// The incident: a root Next app with CI and a gate, and a nested app with its
// own framework and deploy config that reads a database and cookies.
const ROOT_PKG = {
    name: 'shop', private: true,
    scripts: { dev: 'next dev', build: 'next build', lint: 'eslint .', test: 'vitest run', gate: 'npm run lint && npm test && npm run build' },
    dependencies: { next: '15.0.0' },
};
const ADMIN_FILES = {
    'apps/admin/package.json': { name: 'admin', scripts: { dev: 'next dev', build: 'next build', typecheck: 'tsc --noEmit' }, dependencies: { next: '15.0.0', pg: '8.0.0', jose: '5.0.0' } },
    'apps/admin/vercel.json': '{}',
    'apps/admin/middleware.ts': 'export function middleware(req) { const role = req.cookies.get("role"); const ip = req.headers.get("x-forwarded-for"); return role; }\n',
    'apps/admin/lib/db.ts': 'import { Pool } from "pg";\nexport const pool = new Pool({ connectionString: process.env.DATABASE_URL });\nconst k = process.env.ADMIN_SESSION_SECRET;\n',
    'apps/admin/app/page.tsx': 'export default function Page() { return null; }\n',
};
const CI_ROOT_ONLY = 'name: ci\non:\n  pull_request:\n    paths-ignore:\n      - apps/admin/**\n      - apps/admin\njobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/cache@v4\n        with:\n          path: apps/admin\n          key: x\n      - run: npm ci && npm run gate\n';
const CI_WIRED = CI_ROOT_ONLY.replace('      - run: npm ci && npm run gate\n',
    '      - run: npm ci && npm run gate\n      - run: npm ci && npm run typecheck\n        working-directory: apps/admin\n');

// --- red, then green, on one fixture --------------------------------------------
{
    const files = Object.assign({ 'package.json': ROOT_PKG, 'src/a.test.ts': '', '.github/workflows/ci.yml': CI_ROOT_ONLY }, ADMIN_FILES);
    const red = repo('incident', files, { git: true });
    const r = run([red]);
    check('RED: a nested app the CI names only under paths-ignore and a cache path is UNGATED',
        r.status === 1 && /UNGATED\s+apps\/admin/.test(r.out), `exit ${r.status}`);
    check('  the root app beside it is NOT reported', !/UNGATED\s+\.\s/.test(r.out) && !/\[the root app\]/.test(r.out));
    check('  it says what is missing: CI and tests', /missing: CI and tests/.test(r.out));
    check('  the population is printed beside the verdict', /2 apps in 2 package\.jsons/.test(r.out) && /listed by git/.test(r.out));
    check('  it names the gate sources it read', /gate sources read: \.github\/workflows\/ci\.yml; 4 root gate scripts/.test(r.out));
    check('  it counts the commits that touch the app (git mode)', /1 commit touch it/.test(r.out));

    const j = json([red]);
    const admin = appOf(j.json, 'apps/admin');
    const hints = admin ? admin.risk.map((h) => h.hint) : [];
    check('  --json carries the finding with exit 1', j.status === 1 && j.json && j.json.ungated === 1 && j.json.exit === 1, `exit ${j.status}`);
    check('  the risk names database, secrets, cookies, client-ip, auth and the deploy config',
        ['database', 'secrets', 'cookies', 'client-ip', 'auth', 'deploys'].every((h) => hints.includes(h)), hints.join(','));
    check('  the database hint names the driver and the file', admin && admin.risk.some((h) => h.hint === 'database' && /pg/.test(h.detail) && h.files.includes('apps/admin/lib/db.ts')));
    check('  the secrets hint counts names without printing them', admin && admin.risk.some((h) => h.hint === 'secrets' && /1 secret-named env var/.test(h.detail)) && !/ADMIN_SESSION_SECRET/.test(j.out));

    fs.writeFileSync(path.join(red, '.github/workflows/ci.yml'), CI_WIRED);
    const g = run([red]);
    check('GREEN: the same app once a CI step runs in its directory exits 0', g.status === 0 && !/UNGATED/.test(g.out), `exit ${g.status}`);
    const gj = json([red]);
    const ga = appOf(gj.json, 'apps/admin');
    check('  and it names the step that reaches it', ga && ga.gated && ga.gatedBy.some((b) => /ci\.yml \(path\)/.test(b)));
    check('  an app still without tests is advisory by default', /UNTESTED\s+apps\/admin/.test(g.out) && g.status === 0);
    const s = run([red, '--strict']);
    check('  and --strict turns the untested app into exit 1', s.status === 1, `exit ${s.status}`);
}

// --- the other ways a gate reaches an app --------------------------------------------
function wired(name, extra, label) {
    const files = Object.assign({ 'package.json': ROOT_PKG }, ADMIN_FILES, extra);
    const r = json([repo(name, files)]);
    const a = appOf(r.json, 'apps/admin');
    check(`GREEN: ${label}`, r.status === 0 && a && a.gated, `exit ${r.status}; by ${a ? a.gatedBy.join(',') : '-'}`);
}
wired('root-gate-prefix', { 'package.json': Object.assign({}, ROOT_PKG, { scripts: Object.assign({}, ROOT_PKG.scripts, { gate: 'npm test && npm --prefix apps/admin run typecheck' }) }) },
    'a root gate script that passes the app by --prefix');
wired('root-gate-transitive', { 'package.json': Object.assign({}, ROOT_PKG, { scripts: Object.assign({}, ROOT_PKG.scripts, { gate: 'npm test && npm run check:admin', 'check:admin': 'cd apps/admin && npx tsc --noEmit' }) }) },
    'a root script the gate runs, which cds into the app');
wired('bitbucket', { 'bitbucket-pipelines.yml': 'pipelines:\n  default:\n    - step:\n        script:\n          - npm ci\n          - cd apps/admin && npm ci && npm run typecheck\n' },
    'a bitbucket-pipelines.yml step that cds into the app');
wired('gitlab', { '.gitlab-ci.yml': 'admin:\n  script:\n    - npm ci --prefix ./apps/admin\n' }, 'a .gitlab-ci.yml step that passes ./apps/admin');
wired('husky', { '.husky/pre-commit': 'npx lint-staged\nnpm --prefix apps/admin run typecheck\n' }, 'a husky pre-commit hook that runs in the app');
wired('workspace-name', { 'package.json': Object.assign({}, ROOT_PKG, { workspaces: ['apps/*'], scripts: Object.assign({}, ROOT_PKG.scripts, { gate: 'npm test && npm run typecheck --workspace=admin' }) }) },
    'a root gate that runs the app by workspace name');
wired('workspace-wide', { 'package.json': Object.assign({}, ROOT_PKG, { scripts: Object.assign({}, ROOT_PKG.scripts, { gate: 'turbo run lint test' }) }), 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n" },
    'a workspace-wide turbo run, with the app a pnpm workspace member');

// --- references that are not coverage --------------------------------------------------
function ungated(name, extra, label, more) {
    const files = Object.assign({ 'package.json': ROOT_PKG }, ADMIN_FILES, extra);
    const r = json([repo(name, files)]);
    const a = appOf(r.json, 'apps/admin');
    check(`RED: ${label}`, r.status === 1 && a && !a.gated, `exit ${r.status}; by ${a ? a.gatedBy.join(',') : '-'}`);
    if (more) more(a, r);
}
ungated('dev-script', { 'package.json': Object.assign({}, ROOT_PKG, { scripts: Object.assign({}, ROOT_PKG.scripts, { 'dev:admin': 'cd apps/admin && next dev' }) }) },
    'a root script that cds into the app but that no gate runs',
    (a) => check('  and the note names that script', a && a.notes.some((n) => /dev:admin/.test(n) && /no CI step/.test(n))));
ungated('prefix-collision', { '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cd apps/admin-v2 && npm test\n' },
    'a CI step in apps/admin-v2 does not reach apps/admin');
ungated('filtered-workspace', { 'package.json': Object.assign({}, ROOT_PKG, { workspaces: ['apps/*'], scripts: Object.assign({}, ROOT_PKG.scripts, { gate: 'turbo run test --filter=web' }) }) },
    'a turbo run filtered to another workspace does not reach the app');
ungated('excluded-workspace', { 'package.json': Object.assign({}, ROOT_PKG, { workspaces: ['apps/*', '!apps/admin'], scripts: Object.assign({}, ROOT_PKG.scripts, { gate: 'npm test --workspaces' }) }) },
    'a workspace-wide run does not reach an app the workspace globs negate');
ungated('commented-step', { '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      # - run: cd apps/admin && npm test\n      - run: npm test\n' },
    'a commented-out CI step does not reach the app');
ungated('own-ci', { 'apps/admin/.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n' },
    'a CI file inside the app directory is not a gate',
    (a) => check('  and the note says the host never reads it', a && a.notes.some((n) => /never reads/.test(n))));

// --- the population ----------------------------------------------------------------------
{
    const files = Object.assign({
        'package.json': ROOT_PKG, 'src/a.test.ts': '',
        '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci && npm run gate\n',
        'node_modules/some-dep/package.json': { name: 'some-dep', scripts: { build: 'tsc' }, dependencies: { express: '4' } },
        'apps/web/node_modules/x/package.json': { name: 'x', scripts: { start: 'node .' } },
        '.claude/worktrees/feature/package.json': { name: 'shop', scripts: { dev: 'next dev' }, dependencies: { next: '15' } },
        'packages/esm-marker/package.json': { type: 'module' },
    });
    for (const mode of [[], ['--walk']]) {
        const r = json([repo(`population${mode.length ? '-walk' : ''}`, files, { git: !mode.length })].concat(mode));
        const where = mode.length ? 'walk' : 'git';
        check(`GREEN (${where}): an app under node_modules or .claude/worktrees is not in the population`,
            r.status === 0 && r.json && r.json.population.apps === 1 && r.json.apps[0].path === '.', `exit ${r.status}; apps ${r.json && r.json.apps.map((a) => a.path).join(',')}`);
        check(`  (${where}) a package.json that only marks a module type is read but is not an app`,
            r.json && r.json.population.packageJsons === 2 && r.json.population.mode === where);
    }
}
{
    // The same nested app, untracked but not ignored, is part of the repository.
    const r0 = repo('untracked', Object.assign({ 'package.json': ROOT_PKG, '.gitignore': 'node_modules/\n' }), { git: true });
    for (const [rel, body] of Object.entries(ADMIN_FILES)) {
        fs.mkdirSync(path.dirname(path.join(r0, rel)), { recursive: true });
        fs.writeFileSync(path.join(r0, rel), typeof body === 'string' ? body : JSON.stringify(body));
    }
    const r = run([r0, '--no-history']);
    check('RED: an untracked, not-ignored nested app is in the population and UNGATED', r.status === 1 && /UNGATED\s+apps\/admin/.test(r.out), `exit ${r.status}`);
    check('  and --no-history skips the commit count', !/commit.? touch it/.test(r.out));
    fs.writeFileSync(path.join(r0, '.gitignore'), 'node_modules/\napps/admin/\n');
    const i = run([r0]);
    check('  once git ignores it, it is not part of the repository', i.status === 0 && !/apps\/admin/.test(i.out), `exit ${i.status}`);
}

// --- could not check ---------------------------------------------------------------------
{
    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, 'README.md'), 'no package here\n');
    const r = run([bare], 'exit2');
    check('no package.json at all exits 2, never 0', r.status === 2, `exit ${r.status}`);
    check('  and says it vouches for nothing', /vouches for NOTHING/.test(r.out));

    const broken = repo('broken', { 'package.json': '{ "name": ' });
    const b = run([broken], 'exit2');
    check('an unreadable package.json and no finding exits 2', b.status === 2 && /UNREADABLE\s+package\.json/.test(b.out), `exit ${b.status}`);

    const missing = run([path.join(tmp, 'does-not-exist')], 'exit2');
    check('a root that is not a directory exits 2', missing.status === 2 && /not a directory/.test(missing.out), `exit ${missing.status}`);

    const bad = run([bare, '--bogus'], 'exit2');
    check('an unknown flag exits 2 with usage', bad.status === 2 && /unknown argument/.test(bad.err) && /usage:/.test(bad.err), `exit ${bad.status}`);

    const plain = repo('no-apps', { 'package.json': { name: 'tools', devDependencies: { prettier: '3' } } });
    const p = run([plain]);
    check('package.json files with no app among them exit 0 and say why', p.status === 0 && /is an app/.test(p.out), `exit ${p.status}`);
}

// --- entry points ------------------------------------------------------------------------
{
    const st = run(['--selftest']);
    check('--selftest exits 0 and reports its case count', st.status === 0 && /\d+ passed, 0 failed/.test(st.out) && /cases:/.test(st.out), `exit ${st.status}`);
    const h = run(['--help']);
    check('--help exits 0 with usage and scans nothing', h.status === 0 && /usage:/.test(h.out) && !/listed by/.test(h.out));
}

// --- the pipe delivers every byte ----------------------------------------------------------
// process.exitCode, not process.exit(): an async pipe on POSIX would otherwise
// lose everything past the 64KiB buffer. The first assertion keeps the second
// from passing by construction.
{
    const files = { 'package.json': ROOT_PKG };
    for (let i = 0; i < 260; i++) files[`apps/app-${String(i).padStart(3, '0')}/package.json`] = { name: `app-${i}`, scripts: { dev: 'next dev' } };
    const big = repo('big', files);
    const piped = runBudgeted(process.execPath, [SUBJECT, big, '--json', '--walk'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    const out = path.join(tmp, 'via-file.out');
    const fd = fs.openSync(out, 'w');
    runBudgeted(process.execPath, [SUBJECT, big, '--json', '--walk'], { stdio: ['ignore', fd, 'ignore'], timeout: 60000 });
    fs.closeSync(fd);
    const fileBytes = fs.statSync(out).size;
    const pipeBytes = Buffer.byteLength(piped.stdout || '', 'utf8');
    check('--json over many apps exceeds one pipe buffer', fileBytes > 64 * 1024, `bytes ${fileBytes}`);
    check('  and through a pipe it delivers every byte it writes to a file', pipeBytes === fileBytes, `pipe ${pipeBytes} file ${fileBytes}`);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${tally(pass, fail, infra)}`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), SUBJECT)}; every case plants its own repository. `
    + 'The incident shape goes red and the same app wired into CI goes green; seven wirings read as coverage and six '
    + 'references that are not coverage stay red, including a path under paths-ignore and a cache path.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
process.exitCode = exitCode(fail, infra);
