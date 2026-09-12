'use strict';
// Acceptance suite for check-deploy-target.js.
//
// THE SUBJECT HAS PRODUCTION SIDE EFFECTS AND IS NEVER RUN AGAINST VERCEL HERE.
// The whole defect being fixed is that `vercel --yes` deploys, so no assertion
// in this file may invoke the CLI. Everything is driven with captured JSON.
//
// PROVENANCE OF THE FIXTURES. The two shapes below are transcribed by hand from
// the 2026-09-08 greenfield run recorded in
// docs/evidence-greenfield-run-2026-09-08-log.txt, which observed
// `target=production` on the accidental first deploy (log line 57) and
// `target=null = preview` on the deliberate redeploy (line 58). They are
// HARDCODED LITERALS and share no source with the subject: narrowing
// check-deploy-target.js cannot narrow these, so a weakened detector goes red
// here rather than quietly agreeing with itself.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Named as a path literal so check-suites-can-fail derives this suite's subject
// without an override entry.
const SUBJECT = path.resolve(__dirname, '..', 'plugins/autodev-core/scripts/check-deploy-target.js');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-target-control-'));

const run = (...a) => {
    const r = spawnSync(process.execPath, [SUBJECT, ...a], { cwd: T, encoding: 'utf8' });
    return { out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
};
const w = (rel, body) => {
    const p = path.join(T, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
    return p;
};

let failed = 0;
let asserted = 0;
const check = (label, ok, detail) => {
    asserted++;
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  -> ' + detail}`);
};

try {
    // ------------------------------------------------------------ fixtures
    // The accidental production deploy. Transcribed from the run log: the
    // deployment id, the alias and the project name are the real ones; the team
    // slug was redacted in the committed evidence and is redacted here too.
    w('production.json', JSON.stringify({
        id: 'dpl_6mu5uzkmfQad5DeqPM75ehLWKZnz',
        name: 'greenfield-run-2026-09-08',
        url: 'greenfield-run-2026-09-08.vercel.app',
        target: 'production',
        readyState: 'READY',
    }, null, 2) + '\n');

    // The deliberate preview redeploy from the same run. target is null, and
    // that null is the thing under test.
    w('preview.json', JSON.stringify({
        id: 'dpl_d1dg4idtzQ9xWm2rTnLkPvB7Hs4A',
        name: 'greenfield-run-2026-09-08',
        url: 'greenfield-run-2026-09-08-d1dg4idtz-team.vercel.app',
        target: null,
        readyState: 'READY',
    }, null, 2) + '\n');

    // ------------------------------------------- 1. the defect, in both moods

    const caught = run('--deployment', 'production.json', '--intent', 'preview');
    check('refuses when a preview was intended and target came back production',
        caught.status === 1 && /REFUSED/.test(caught.out) && /WENT TO PRODUCTION/.test(caught.out),
        'status=' + caught.status + ' ' + caught.out.trim());

    check('the refusal says it ALREADY HAPPENED rather than warning about a next step',
        /ALREADY HAPPENED/.test(caught.out),
        caught.out.trim());

    check('the refusal names the undo command and the project it applies to',
        /vercel remove greenfield-run-2026-09-08 --yes/.test(caught.out),
        caught.out.trim());

    check('the refusal says rollback cannot undo a first deployment',
        /rollback` cannot undo a first deployment|rollback. cannot undo a first deployment/.test(caught.out),
        caught.out.trim());

    check('the refusal names the deployed URL',
        /greenfield-run-2026-09-08\.vercel\.app/.test(caught.out),
        caught.out.trim());

    const ok = run('--deployment', 'preview.json', '--intent', 'preview');
    check('passes when a preview was intended and target is null',
        ok.status === 0 && /^OK/.test(ok.out.trim()),
        'status=' + ok.status + ' ' + ok.out.trim());

    // Without this pair the refusal above could be a check that fires on
    // everything, which proves nothing about the condition it claims to detect.
    const prodOk = run('--deployment', 'production.json', '--intent', 'production');
    check('passes when production was intended and production is what happened',
        prodOk.status === 0,
        'status=' + prodOk.status + ' ' + prodOk.out.trim());

    const underDeploy = run('--deployment', 'preview.json', '--intent', 'production');
    check('refuses the other direction too: production intended, nothing is live',
        underDeploy.status === 1 && /IS A PREVIEW/.test(underDeploy.out),
        'status=' + underDeploy.status + ' ' + underDeploy.out.trim());

    // ------------------------------- 2. a missing target is NOT a preview (2, not 0)

    w('no-target.json', JSON.stringify({ id: 'dpl_x', name: 'p', url: 'p.vercel.app', readyState: 'READY' }) + '\n');
    const noTarget = run('--deployment', 'no-target.json', '--intent', 'preview');
    check('a JSON with no target field is INDETERMINATE, never a pass',
        noTarget.status === 2 && /NO "target" field/.test(noTarget.out),
        'status=' + noTarget.status + ' ' + noTarget.out.trim());

    w('empty.json', '');
    const empty = run('--deployment', 'empty.json', '--intent', 'preview');
    check('an empty file is INDETERMINATE and says it read 0 bytes',
        empty.status === 2 && /read 0 bytes/.test(empty.out),
        'status=' + empty.status + ' ' + empty.out.trim());

    w('broken.json', '{ this is not json');
    const broken = run('--deployment', 'broken.json', '--intent', 'preview');
    check('unparseable JSON is INDETERMINATE, not a pass',
        broken.status === 2 && /could not parse/.test(broken.out),
        'status=' + broken.status + ' ' + broken.out.trim());

    const absent = run('--deployment', 'nope.json', '--intent', 'preview');
    check('a missing file is INDETERMINATE, not a pass',
        absent.status === 2 && /could not read/.test(absent.out),
        'status=' + absent.status + ' ' + absent.out.trim());

    w('weird.json', JSON.stringify({ name: 'p', target: 'staging' }) + '\n');
    const weird = run('--deployment', 'weird.json', '--intent', 'preview');
    check('an unrecognised target value is INDETERMINATE, not read as preview',
        weird.status === 2 && /does not know how to read/.test(weird.out),
        'status=' + weird.status + ' ' + weird.out.trim());

    const noIntent = run('--deployment', 'preview.json');
    check('an undeclared intent is INDETERMINATE, not defaulted',
        noIntent.status === 2 && /--intent must be/.test(noIntent.out),
        'status=' + noIntent.status + ' ' + noIntent.out.trim());

    // The nested envelope, and it must SAY which one it matched.
    w('nested.json', JSON.stringify({ deployment: { name: 'q', url: 'q.vercel.app', target: 'production' } }) + '\n');
    const nested = run('--deployment', 'nested.json', '--intent', 'preview');
    check('finds target nested under deployment and names where it found it',
        nested.status === 1 && /deployment\.target = "production"/.test(nested.out),
        'status=' + nested.status + ' ' + nested.out.trim());

    // stdin, because that is how a shell pipeline would use it.
    const piped = spawnSync(process.execPath, [SUBJECT, '--deployment', '-', '--intent', 'preview'], {
        cwd: T, encoding: 'utf8', input: fs.readFileSync(path.join(T, 'production.json'), 'utf8'),
    });
    check('reads the deployment JSON from stdin',
        piped.status === 1 && /REFUSED/.test((piped.stdout || '') + (piped.stderr || '')),
        'status=' + piped.status + ' ' + ((piped.stdout || '') + (piped.stderr || '')).trim());

    // ------------------------------------------ 3. the .vercelignore subcommand

    fs.mkdirSync(path.join(T, 'bare'), { recursive: true });
    const bare = run('--ignore-file', 'bare');
    check('refuses a directory with no .vercelignore',
        bare.status === 1 && /NO \.vercelignore/.test(bare.out),
        'status=' + bare.status + ' ' + bare.out.trim());

    check('that refusal states the CLI does not read .gitignore',
        /does not read \.gitignore/.test(bare.out),
        bare.out.trim());

    // Presence alone must not satisfy it, or the check is a file-exists test.
    w('hollow/.vercelignore', '# nothing here\n\n   \n');
    const hollow = run('--ignore-file', 'hollow');
    check('refuses a .vercelignore that exists but has no patterns',
        hollow.status === 1 && /HAS NO PATTERNS/.test(hollow.out),
        'status=' + hollow.status + ' ' + hollow.out.trim());

    // Partial coverage. .git and .env are named; .claude and node_modules are not.
    w('partial/.vercelignore', '.git/\n.env\n');
    const partial = run('--ignore-file', 'partial');
    check('refuses when only some required entries are covered, and names which',
        partial.status === 1 && /\.claude\//.test(partial.out) && /node_modules\//.test(partial.out),
        'status=' + partial.status + ' ' + partial.out.trim());

    check('the partial refusal does NOT name the entries that were covered',
        !/missing.*\.git\//.test(partial.out),
        partial.out.trim());

    w('full/.vercelignore', '# ok\n.claude/\n.git/\nnode_modules/\n.env\ndist/\n');
    const full = run('--ignore-file', 'full');
    check('passes a .vercelignore covering every required entry',
        full.status === 0 && /^OK/.test(full.out.trim()),
        'status=' + full.status + ' ' + full.out.trim());

    check('the pass reports how many patterns it actually read, not just OK',
        /5 pattern\(s\)/.test(full.out),
        full.out.trim());

    // Trailing-slash insensitivity, both directions.
    w('noslash/.vercelignore', '.claude\n.git\nnode_modules\n.env\n');
    const noslash = run('--ignore-file', 'noslash');
    check('treats .claude and .claude/ as the same coverage',
        noslash.status === 0,
        'status=' + noslash.status + ' ' + noslash.out.trim());

    const missingDir = run('--ignore-file', 'does-not-exist');
    check('a missing directory is INDETERMINATE, not a refusal and not a pass',
        missingDir.status === 2,
        'status=' + missingDir.status + ' ' + missingDir.out.trim());

    // ------------------------------ 4. the real repo's own .vercelignore passes

    // The fix shipped in this commit has to satisfy the check that ships with
    // it. A detector whose own repo fails it will be switched off.
    const repoRoot = path.resolve(__dirname, '..');
    const real = spawnSync(process.execPath, [SUBJECT, '--ignore-file', repoRoot], { cwd: repoRoot, encoding: 'utf8' });
    check('this repo\'s committed .vercelignore passes the check',
        real.status === 0,
        'status=' + real.status + ' ' + ((real.stdout || '') + (real.stderr || '')).trim());

    // ------------------------------------------------------- 5. arg handling

    const bogus = run('--deployment', 'preview.json', '--intent', 'preview', '--wat');
    check('an unrecognised argument is INDETERMINATE, never silently ignored',
        bogus.status === 2 && /unrecognised argument/.test(bogus.out),
        'status=' + bogus.status + ' ' + bogus.out.trim());

    const bareRun = run();
    check('no arguments prints usage and exits 2, not 0',
        bareRun.status === 2 && /--ignore-file/.test(bareRun.out),
        'status=' + bareRun.status + ' ' + bareRun.out.trim());

    // ---------------------------- 6. the ship skill no longer calls --yes a preview

    // The defect was PROSE, in a file no other assertion here reads. Without
    // this, the whole suite can be green while the skill still tells sessions to
    // run the command that caused the incident.
    const shipSkill = fs.readFileSync(
        path.resolve(__dirname, '..', 'plugins/autodev-core/skills/ship/SKILL.md'), 'utf8');

    check('ship/SKILL.md no longer labels a bare `vercel --yes` as a preview',
        !/#\s*Preview first \(recommended\)\s*\nnpx vercel --yes/.test(shipSkill),
        'the "Preview first (recommended)" + `npx vercel --yes` pair is still there');

    check('ship/SKILL.md tells sessions to verify the target after deploying',
        /check-deploy-target\.js/.test(shipSkill) && /--intent preview/.test(shipSkill),
        'no check-deploy-target.js invocation with --intent in ship/SKILL.md');

    check('ship/SKILL.md carries the first-deployment fact that explains the refusal',
        /first deployment/i.test(shipSkill),
        'ship/SKILL.md does not say why the first deployment goes to production');

    check('ship/SKILL.md names the side-effect-free way to see the upload set',
        /vercel deploy --dry --json/.test(shipSkill) && /without uploading or creating a\s*\n?deployment/.test(shipSkill),
        'no `vercel deploy --dry --json` with its no-upload guarantee in ship/SKILL.md');

    // The honest caveat is the sentence most likely to be tidied away later, and
    // removing it would leave the skill claiming a flag prevents the defect when
    // nobody here established that it does.
    check('ship/SKILL.md marks --target=preview as UNVERIFIED on a first deployment',
        /--target=preview` is NOT known to override the first-deployment rule/.test(shipSkill),
        'the --target=preview caveat is gone; the skill now overclaims the flag');
} finally {
    fs.rmSync(T, { recursive: true, force: true });
}

console.log(`[control] ${asserted} assertion(s), ${asserted - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
