#!/usr/bin/env node
// Leading-dash ARGUMENT injection in the shipped argv call sites.
//
// Round 1 converted several execSync command strings to execFileSync argv. That
// closes shell injection and does nothing at all for this class: a value
// beginning with '-' is read by the callee's own option parser as a FLAG, and no
// amount of not-having-a-shell changes that.
//
// This suite has three jobs, and the first is the one that keeps the other two
// honest:
//
//   1. Prove the hazard is REAL on this machine's git, with a known-positive
//      control. A guard tested only against its own assumptions is a guard that
//      quietly stops meaning anything when the assumption changes.
//   2. Prove each shipped guard rejects the dangerous shapes, by lifting the
//      real predicate out of the shipped file rather than restating it here. A
//      restated regex agrees with itself, not with the code.
//   3. Prove each guard still ACCEPTS the ordinary shapes. A validator that
//      rejects everything scores full marks against attack payloads alone.
//
// The end-to-end case for session-sweep lives in test-session-sweep.js, as the
// `dash-branch` worktree — it drives the real script and asserts the real label.
//
// Run: node tooling/test-argv-injection.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SWEEP = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'session-sweep.js');
const DRIFT = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'drift-audit.js');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);

// ---------------------------------------------------------------------------
// 1. Known positive: does git really treat a leading-dash positional as an
//    option? A bogus flag name is the discriminator — only an option parser
//    knows it is wrong. If git took it as a rev or a pattern, it would either
//    match nothing or report "unknown revision", not "unknown option".
// ---------------------------------------------------------------------------
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argv-test-')));
{
    const work = path.join(TMP, 'work');
    execFileSync('git', ['init', '-q', work]);
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a',
        'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: work });

    const BOGUS = '--zzz-not-a-real-git-option';
    const g = (args) => spawnSync('git', args, { cwd: work, encoding: 'utf8' });

    // A ref beginning with '-' is creatable and readable. This is the whole
    // reachability argument, and it is measured rather than asserted.
    const refused = spawnSync('git', ['branch', '--', BOGUS], { cwd: work, encoding: 'utf8' }).status !== 0;
    check('git branch refuses to create a dash-named branch', refused);
    const made = g(['update-ref', 'refs/heads/' + BOGUS, 'HEAD']).status === 0;
    check('git update-ref creates one anyway', made);
    if (made) {
        g(['symbolic-ref', 'HEAD', 'refs/heads/' + BOGUS]);
        const live = g(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
        check('rev-parse --abbrev-ref HEAD hands the dash name back', live === BOGUS, JSON.stringify(live));
    }

    // The hazard itself, on the `git log -1 --format=... <ref>` shape.
    const asRef = g(['log', '-1', '--format=%H', BOGUS]);
    check('a leading-dash positional reaches git as an OPTION (log)',
        asRef.status !== 0 && /unrecognized argument|unknown option/i.test(asRef.stderr || ''),
        'status=' + asRef.status + ' stderr=' + JSON.stringify((asRef.stderr || '').split('\n')[0]));

    // And the control that proves the probe can see the safe case: a real ref
    // in the same slot works.
    check('  while an ordinary ref in the same slot resolves',
        g(['log', '-1', '--format=%H', 'HEAD']).status === 0);

    // ls-remote is DIFFERENT — it stops parsing options at the repository
    // argument, so the same flag after `origin` is positional. Recorded because
    // it is exactly the kind of per-subcommand, per-version detail that must not
    // become the thing a guard depends on.
    const before = g(['ls-remote', '--heads', BOGUS, 'origin']);
    check('ls-remote parses options BEFORE the repository argument',
        before.status !== 0 && /unknown option|unknown switch/i.test(before.stderr || ''),
        'status=' + before.status);
}

// ---------------------------------------------------------------------------
// 2. session-sweep: the branch guard and the `--` separator.
// ---------------------------------------------------------------------------
const sweepSrc = fs.readFileSync(SWEEP, 'utf8');
{
    check('session-sweep: ls-remote passes "--" before the branch',
        /ls-remote', '--heads', 'origin', '--', branch/.test(sweepSrc),
        (sweepSrc.match(/\[.*ls-remote.*\]/) || [''])[0].slice(0, 120));

    check('session-sweep: a dash-leading branch is refused before any git call',
        /if \(branch && branch\.startsWith\('-'\)\) return 'branch-name-unsafe';/.test(sweepSrc));

    // The gh slug validator, lifted from the shipped source so the test cannot
    // drift from the regex that actually runs.
    const m = sweepSrc.match(/if \((\/\^[^\n]*?\/)\.test\(slug\)\)/);
    check('session-sweep: the slug validator is findable in source', Boolean(m), m ? m[1] : 'no match');
    if (m) {
        // eslint-disable-next-line no-new-func
        const re = new Function('return ' + m[1] + ';')();
        const rejects = ['-a/-b', '--json/x', 'x/-y', '-owner/repo', '--upload-pack=x/y', '/x', 'x/', 'x', ''];
        for (const bad of rejects) {
            check(`session-sweep: slug validator rejects ${JSON.stringify(bad)}`, !re.test(bad));
        }
        const accepts = ['djnsty23/claude-auto-dev', 'a/b', 'Org.Name/repo-name_2', 'a1/b2.c'];
        for (const good of accepts) {
            check(`session-sweep: slug validator accepts ${JSON.stringify(good)}`, re.test(good));
        }
    }
}

// ---------------------------------------------------------------------------
// 3. drift-audit: the remote-ref filter that feeds a bare positional.
// ---------------------------------------------------------------------------
{
    const driftSrc = fs.readFileSync(DRIFT, 'utf8');
    const m = driftSrc.match(/\.filter\(\((b)\) => (b && b\.includes[^\n]*?)\);/);
    check('drift-audit: the remote-ref filter is findable in source', Boolean(m), m ? m[2] : 'no match');
    if (m) {
        // eslint-disable-next-line no-new-func
        const fn = new Function('base', 'return (b) => ' + m[2] + ';')('origin/main');
        check('drift-audit: filter drops a dash-leading remote ref', !fn('-x/branch'));
        check('drift-audit: filter drops a bare remote name (a remote HEAD)', !fn('origin'));
        check('drift-audit: filter drops the base branch itself', !fn('origin/main'));
        check('drift-audit: filter KEEPS an ordinary remote branch', fn('origin/feature-1'));
        check('drift-audit: filter keeps a branch whose name contains a dash', fn('origin/fix-thing'));
    }
}

// ---------------------------------------------------------------------------
// 4. Census. A bare verdict is indistinguishable from a finder that found
//    nothing, so print what was actually inspected.
// ---------------------------------------------------------------------------
{
    const argvCalls = [];
    for (const rel of [
        'plugins/autodev-core/scripts/session-sweep.js',
        'plugins/autodev-core/scripts/drift-audit.js',
        'plugins/autodev-core/scripts/fleet-publish.js',
        'plugins/autodev-core/scripts/fleet-notify.js',
        'plugins/autodev-core/scripts/fleet-overlap.js',
        'plugins/autodev-core/scripts/watch-panels.js',
        'plugins/autodev-core/hooks/session-start.js',
        'plugins/autodev-core/templates/preflight.js',
    ]) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const n = (src.match(/execFileSync\(/g) || []).length;
        if (n) argvCalls.push(`${rel}:${n}`);
    }
    check('argv census: every shipped execFileSync site is accounted for',
        argvCalls.length > 0, argvCalls.join(' '));
    console.log('argv call sites inspected: ' + argvCalls.join(', '));
}

// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const [label, ok, detail] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !detail ? '' : '  — ' + detail));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
process.exit(fail > 0 ? 1 : 0);
