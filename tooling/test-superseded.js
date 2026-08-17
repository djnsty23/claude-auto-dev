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

const winCurl = run(fixture('wincurl', 'rule-windows/SKILL.md',
    '# windows\n\n- Read: `curl -H "apikey: k" https://example.com`\n'));
check('bare curl in a Windows-scoped file IS a finding',
    /bare-curl-on-windows/.test(winCurl.stdout), 'exit ' + winCurl.status);

// 6. THE GUARD ITSELF. Push a rule that cannot match its own fixture into the
//    real table and confirm selfTest reports it. Without this, the exit-2 path is
//    a claim: it has never been seen firing, and a self-test that cannot fail is
//    the exact defect this detector exists to catch.
const mod = require(GATE);
const before = mod.selfTest();
check('the real table passes its own self-test', before.length === 0, before.join('; '));

mod.SUPERSEDED.push({
    id: 'deliberately-broken',
    re: /this-string-is-not-in-the-fixture/,
    why: 'test rule', replacement: 'n/a',
    positive: ['a line that the pattern above cannot match'],
});
const after = mod.selfTest();
check('a rule that cannot match its fixture is caught',
    after.some((b) => /deliberately-broken/.test(b)), after.join('; ') || '(nothing reported)');
mod.SUPERSEDED.pop();

// And a rule whose exempt swallows its own positive — the other way a rule ends
// up permanently silent.
mod.SUPERSEDED.push({
    id: 'exempt-too-greedy',
    re: /start cmd \/k/,
    exempt: /./,
    why: 'test rule', replacement: 'n/a',
    positive: ['- Use external terminal: `start cmd /k "npm run dev"`'],
});
const greedy = mod.selfTest();
check('a rule whose exempt swallows everything is caught',
    greedy.some((b) => /exempt-too-greedy/.test(b)), greedy.join('; ') || '(nothing reported)');
mod.SUPERSEDED.pop();

check('table restored after mutation', mod.selfTest().length === 0);

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
