#!/usr/bin/env node
// Suite for check-superseded.js.
//
// Two things need proving, and only one of them is "does it find the bad line".
//
// The other is that the detector's OWN self-test can fail. check-superseded
// refuses to report on the tree when a rule stops matching its fixture, which is
// the guard against the failure mode that motivated the whole file: a rule that
// cannot fire is indistinguishable from a clean repo. That guard has never been
// observed failing, so it gets a deliberately broken rule pushed into the real
// table here and must catch it.
//
// Hermetic — SUPERSEDED_REPO_ROOT points the scan at a fixture tree, so this
// never depends on the state of plugins/ and cannot start failing because someone
// legitimately edited a skill.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, 'check-superseded.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superseded-'));
let pass = 0, fail = 0;

const check = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

// Build a fixture repo: <root>/plugins/<name>/SKILL.md
const fixture = (name, file, body) => {
    const root = path.join(tmp, name);
    const dir = path.join(root, 'plugins', path.dirname(file));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins', file), body, 'utf8');
    return root;
};

const run = (root, extra = []) => spawnSync('node', [GATE, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, SUPERSEDED_REPO_ROOT: root },
});

console.log('test-superseded');

// 1. A superseded instruction is found, exits 1, and names the rule.
const dirty = run(fixture('dirty', 'skill-a/SKILL.md',
    '# a\n\n- Use external terminal: `start cmd /k "npm run dev"`\n'));
check('superseded line exits 1', dirty.status === 1, 'got exit ' + dirty.status);
check('names the rule that fired', /dev-server-external-terminal/.test(dirty.stdout),
    dirty.stdout.trim().split('\n').pop());
check('names the file and line', /skill-a\/SKILL\.md:3/.test(dirty.stdout));

// 2. The corrected form exits 0. Without this, case 1 could be "always fails".
const clean = run(fixture('clean', 'skill-a/SKILL.md',
    '# a\n\n- Never `start cmd /k`; use `preview_start` instead.\n'));
check('corrected form exits 0', clean.status === 0, 'got exit ' + clean.status);
check('corrected form reports none found', /no superseded convention found/.test(clean.stdout));
// The header labels: without a ref it must say "working tree", and it must name
// the scoped rules rather than "none". Both are `||` fallbacks that mutation
// testing showed could be inverted with nothing noticing.
check('labels the working tree when no --ref is given', /scan — working tree/.test(clean.stdout));
check('header names the scoped rules', /scoped\s+: bare-curl-on-windows/.test(clean.stdout),
    clean.stdout.split('\n').find((l) => l.includes('scoped')));

// 3. Population is printed either way — a verdict with no denominator is
//    indistinguishable from a scan that read nothing.
check('dirty run prints population', /scanned : \d+ markdown file\(s\), \d+ lines/.test(dirty.stdout));
check('clean run prints population', /scanned : \d+ markdown file\(s\), \d+ lines/.test(clean.stdout));

// 4. requiresNearby: a detached dev server is a finding alone, and NOT a finding
//    when preview_start sits near it. This is the half-migration rule, and it is
//    the one most likely to rot into always-firing or never-firing.
const halfMigrated = run(fixture('half', 'skill-b/SKILL.md',
    '# b\n\nBash({ command: "npm run dev", run_in_background: true })\n'));
check('detached dev server alone is a finding', /dev-server-without-preview-start/.test(halfMigrated.stdout),
    'exit ' + halfMigrated.status);

const migrated = run(fixture('migrated', 'skill-b/SKILL.md',
    '# b\n\nPrefer `preview_start` with a .claude/launch.json entry.\n'
    + 'Bash({ command: "npm run dev", run_in_background: true })\n'));
check('detached dev server near preview_start is not', migrated.status === 0,
    'exit ' + migrated.status + ': ' + migrated.stdout.trim().split('\n').pop());

// 5. Fence scoping: a bare `curl -H` in a bash block of a non-Windows file is
//    correct usage (Git Bash has the real binary) and must stay quiet; the same
//    line in a Windows-scoped file must fire.
const bashCurl = run(fixture('bashcurl', 'skill-c/SKILL.md',
    '# c\n\n```bash\ncurl -H "x: y" https://example.com\n```\n'));
check('bare curl in a bash fence is not a finding', bashCurl.status === 0,
    'exit ' + bashCurl.status + ': ' + bashCurl.stdout.trim().split('\n').pop());

// NOTE ON WHAT THESE ASSERT AGAINST.
//
// Never match a rule id in stdout to prove a rule FIRED. The population header
// prints `scoped : bare-curl-on-windows fire only in ...` on every single run, so
// `/bare-curl-on-windows/.test(stdout)` is true even when nothing was found — the
// first version of these two cases did exactly that and passed with fence
// tracking deleted. Assert on the exit status and the `file:line` arrow, which
// only a real finding emits.
const winCurl = run(fixture('wincurl', 'rule-windows/SKILL.md',
    '# windows\n\n- Read: `curl -H "apikey: k" https://example.com`\n'));
check('bare curl in a Windows-scoped file IS a finding',
    winCurl.status === 1 && /→ plugins\/rule-windows\/SKILL\.md:3/.test(winCurl.stdout),
    'exit ' + winCurl.status + ': ' + winCurl.stdout.trim().split('\n').pop());

// 5b. The fence tracking itself, which the bash case above does NOT exercise.
//
// Found by mutation testing: deleting fence detection outright (`if (fence)` ->
// `if (false)`) left the bash case still passing, because that fixture also fails
// the fileScope check — so "no finding" was reached by a path other than the one
// under test. A powershell fence in a file whose NAME does not match fileScope
// can only fire through fenceLang, so it pins the tracking.
const psCurl = run(fixture('pscurl', 'skill-d/SKILL.md',
    '# d\n\n```powershell\ncurl -H "apikey: k" https://example.com\n```\n'));
check('bare curl in a powershell fence IS a finding (via fence, not filename)',
    psCurl.status === 1 && /→ plugins\/skill-d\/SKILL\.md:4/.test(psCurl.stdout),
    'exit ' + psCurl.status + ': ' + psCurl.stdout.trim().split('\n').pop());

// And the fence must CLOSE, so a bash block after a powershell block is not
// still treated as powershell.
const fenceCloses = run(fixture('fenceclose', 'skill-d2/SKILL.md',
    '# d2\n\n```powershell\nWrite-Host hi\n```\n\n```bash\ncurl -H "x: y" https://example.com\n```\n'));
check('a closed powershell fence does not leak into the next block',
    fenceCloses.status === 0, 'exit ' + fenceCloses.status + ': '
    + fenceCloses.stdout.trim().split('\n').pop());

// 5c. --ref reads git, not the working tree.
//
// Untested until mutation testing showed `if (REF)` could be deleted in both
// skillFiles() and readFile() with nothing noticing. This is the path every
// "does the detector still catch the old defect" check runs through, so it needs
// to be pinned. The fixture file is DELETED from the working tree after commit:
// a disk-based read then finds nothing, so a finding proves git was the source.
const gitRoot = fixture('gitref', 'skill-e/SKILL.md',
    '# e\n\n- Use external terminal: `start cmd /k "npm run dev"`\n');
const git = (...a) => spawnSync('git', ['-C', gitRoot,
    '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
    '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
git('init', '-q');
git('add', '-A');
git('commit', '-q', '-m', 'fixture');
fs.rmSync(path.join(gitRoot, 'plugins', 'skill-e', 'SKILL.md'));

const refRun = run(gitRoot, ['--ref', 'HEAD']);
check('--ref finds a finding that is no longer on disk',
    /dev-server-external-terminal/.test(refRun.stdout), 'exit ' + refRun.status);
check('--ref labels the revision it scanned', /scan — HEAD/.test(refRun.stdout));
const diskRun = run(gitRoot);
check('the same tree on disk has nothing (so --ref really read git)',
    diskRun.status === 0, 'exit ' + diskRun.status);

// 5d. --json carries the population and the findings.
const jsonRun = run(fixture('json', 'skill-f/SKILL.md',
    '# f\n\n- Use external terminal: `start cmd /k "npm run dev"`\n'), ['--json']);
let parsed = null;
try { parsed = JSON.parse(jsonRun.stdout); } catch { /* reported below */ }
check('--json emits parseable JSON', parsed !== null, jsonRun.stdout.slice(0, 80));
check('--json reports the population it scanned',
    !!parsed && parsed.population.filesScanned === 1 && parsed.population.patterns >= 5,
    parsed && JSON.stringify(parsed.population));
check('--json reports the finding with file and line',
    !!parsed && parsed.findings.length === 1 && parsed.findings[0].line === 3,
    parsed && JSON.stringify(parsed.findings));

// 6. THE GUARD ITSELF. Push rules that cannot work into the real table and
//    confirm selfTest reports each one. Without this the exit-2 path is a claim:
//    it had never been seen firing, and a self-test that cannot fail is the exact
//    defect this detector exists to catch.
//
//    RUN IN A CHILD PROCESS, deliberately. Requiring the gate in-process is only
//    safe while its `require.main` guard holds — and mutation testing showed what
//    happens when it does not: the CLI body executes during require and its
//    process.exit() replaces this suite's exit code, so the suite reported success
//    while its own earlier assertions had failed. A suite that can be made to lie
//    about its result is worse than a missing test. Isolating it also means a
//    hijacked exit shows up as unparseable stdout instead of a false green.
//
//    The probe is written from a real function via toString(), so there is no
//    escaped-source string to get wrong.
function probeBody() {
    const mod = require(process.env.SUPERSEDED_GATE);
    const out = { before: mod.selfTest() };

    // A pattern that cannot match its own positive fixture.
    mod.SUPERSEDED.push({
        id: 'deliberately-broken',
        re: /this-string-is-not-in-the-fixture/,
        why: 'test rule', replacement: 'n/a',
        positive: ['a line that the pattern above cannot match'],
    });
    out.brokenPositive = mod.selfTest();
    mod.SUPERSEDED.pop();

    // An exempt so greedy it swallows its own positive — the other way a rule
    // ends up permanently silent.
    mod.SUPERSEDED.push({
        id: 'exempt-too-greedy',
        re: /start cmd \/k/,
        exempt: /./,
        why: 'test rule', replacement: 'n/a',
        positive: ['- Use external terminal: `start cmd /k "npm run dev"`'],
    });
    out.greedyExempt = mod.selfTest();
    mod.SUPERSEDED.pop();

    // A negative fixture the rule DOES match — i.e. a rule that flags its own
    // corrected form. This is the half of the two-sided guard that nothing
    // exercised, so the negative branch of selfTest could be deleted silently.
    mod.SUPERSEDED.push({
        id: 'negative-that-fires',
        re: /start cmd \/k/,
        why: 'test rule', replacement: 'n/a',
        positive: ['- Use external terminal: `start cmd /k "npm run dev"`'],
        negative: ['- this corrected form still says `start cmd /k`, so it matches'],
    });
    out.negativeFires = mod.selfTest();
    mod.SUPERSEDED.pop();

    out.after = mod.selfTest();
    console.log(JSON.stringify(out));
}

const modProbe = path.join(tmp, 'mod-probe.js');
fs.writeFileSync(modProbe, '(' + probeBody.toString() + ')();\n', 'utf8');
const probe = spawnSync('node', [modProbe], {
    encoding: 'utf8',
    env: { ...process.env, SUPERSEDED_GATE: GATE },
});
let p = null;
try { p = JSON.parse(probe.stdout); } catch { /* reported below */ }
check('the module can be required without running the CLI', p !== null,
    'stdout was not JSON: ' + (probe.stdout || probe.stderr || '').slice(0, 100));
check('the real table passes its own self-test', !!p && p.before.length === 0,
    p && p.before.join('; '));
check('a rule that cannot match its fixture is caught',
    !!p && p.brokenPositive.some((b) => /deliberately-broken/.test(b)),
    p && (p.brokenPositive.join('; ') || '(nothing reported)'));
check('a rule whose exempt swallows everything is caught',
    !!p && p.greedyExempt.some((b) => /exempt-too-greedy/.test(b)),
    p && (p.greedyExempt.join('; ') || '(nothing reported)'));
check('a rule that flags its own corrected form is caught',
    !!p && p.negativeFires.some((b) => /negative-that-fires/.test(b)),
    p && (p.negativeFires.join('; ') || '(nothing reported)'));
check('table restored after mutation', !!p && p.after.length === 0, p && p.after.join('; '));

// 7. The exit-2 path end to end, through the CLI, so the refusal is observed and
//    not merely reasoned about. A temporary copy carries the broken rule.
const brokenGate = path.join(tmp, 'broken-gate.js');
fs.writeFileSync(brokenGate,
    fs.readFileSync(GATE, 'utf8').replace(
        /re: \/start\\s\+cmd\\s\+\\\/k\/i,/,
        're: /a-string-that-appears-in-no-fixture/,'),
    'utf8');
const brokenRun = spawnSync('node', [brokenGate], {
    encoding: 'utf8',
    env: { ...process.env, SUPERSEDED_REPO_ROOT: fixture('forbroken', 'skill-a/SKILL.md', '# a\n') },
});
check('a broken rule makes the CLI exit 2', brokenRun.status === 2, 'got exit ' + brokenRun.status);
check('and it says the detector is broken', /DETECTOR BROKEN/.test(brokenRun.stderr),
    (brokenRun.stderr || brokenRun.stdout).trim().split('\n')[0]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
