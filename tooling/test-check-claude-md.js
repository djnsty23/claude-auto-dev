#!/usr/bin/env node
// Tests for tooling/check-claude-md.js — the gate that grades the mechanically
// checkable claims in CLAUDE.md against the tree.
// Run: node tooling/test-check-claude-md.js
// Exits 1 on any failure; 0 if all pass.
//
// TWO HALVES, and the second is the one that matters.
//
// The subject's own --selftest drives a synthetic fixture: it proves the
// CHECKER's logic, one mutation at a time, independent of today's CLAUDE.md.
// This suite runs it, then does what a selftest cannot — points the checker at
// the REAL repository and asserts both directions there:
//
//   the real tree, unmutated          -> exit 0, and SILENT
//   the real CLAUDE.md, one word off  -> exit 1, naming the line and the source
//
// Why both. `check:suites` grades whether a new suite is verified ABLE TO FAIL,
// and a suite in this repo passed on 2026-09-07 with DOCS = ["NO_SUCH_FILE.md"],
// asserting nothing at all. A selftest that only ever grades its own fixture is
// the same shape: green forever, whatever the repo says. The real-corpus half
// is what ties this suite to the file it is supposed to protect.
//
// EVERY ASSERTION HERE IS ON OUTPUT, not on exit status alone. Stubbing the
// subject leaves an empty .js file, and an empty script exits 0 — so a suite
// that only checked `status === 0` would pass against a subject that had been
// deleted out from under it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tooling/check-claude-md.js');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const run = (args, timeout = 120000) => spawnSync(process.execPath, [GATE, ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout, input: '', maxBuffer: 16 * 1024 * 1024,
});
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error ? r.error.message : 'none'}\n`
    + `${(r.stdout + r.stderr).slice(-900)}`;

// ---------------------------------------------------------------------------
// 1. The checker's own mutation harness.
// ---------------------------------------------------------------------------

const self = run(['--selftest']);
check('selftest exits 0', self.status === 0 && !self.error, detail(self));
check('selftest prints its population line', /population: \d+ assertions run/.test(self.stdout), detail(self));
check('selftest population is the whole harness, not a sample (>= 60)',
    (() => { const m = /population: (\d+) assertions run/.exec(self.stdout); return !!m && +m[1] >= 60; })(),
    detail(self));
check('selftest reports every assertion passing',
    /population: (\d+) assertions run, \1 passed/.test(self.stdout), detail(self));

// The three claim families that motivated the gate must each be exercised by
// the harness. Naming them means a future refactor cannot make this suite pass
// by quietly dropping a family.
for (const [family, pattern] of [
    ['the gate step count', /RED on step count word \(three -> seven\) \(exit 1\)/],
    ['the literal gate chain', /RED on literal chain drifts from package\.json \(exit 1\)/],
    ['the passes state table', /RED on a passes state is missing from the table \(exit 1\)/],
    ['the population counts', /RED on a skill count \(exit 1\)/],
    ['the CI ubuntu-gated step count', /RED on the CI ubuntu-gated step count \(exit 1\)/],
]) {
    check(`harness proves it can fail on: ${family}`, pattern.test(self.stdout), detail(self));
}

check('harness proves a fully-graded clean run emits ZERO BYTES on stdout',
    /PASS {2}a fully-graded clean run emits ZERO BYTES on stdout/.test(self.stdout), detail(self));
check('harness proves a fully-graded clean run emits ZERO BYTES on stderr',
    /PASS {2}a fully-graded clean run emits ZERO BYTES on stderr/.test(self.stdout), detail(self));
check('harness proves INDETERMINATE is a third state, not a pass',
    /PASS {2}a missing gate chain is INDETERMINATE \(exit 2\), not a pass/.test(self.stdout), detail(self));
check('harness proves quoted history is not graded as a claim',
    /PASS {2}the quoted 2026-08-17 counts are NOT graded/.test(self.stdout), detail(self));

// ---------------------------------------------------------------------------
// 2. The real repository. Green, and silent.
//
// --no-network so the verdict is the same on this Mac and on a CI runner with
// no credentials. The one network claim then SKIPs, which PRINTS: a skip is a
// visibly different state from a pass and must never be mistaken for one.
// ---------------------------------------------------------------------------

const real = run(['--no-network']);
check('the real CLAUDE.md agrees with the real tree (exit 0)',
    real.status === 0 && !real.error, detail(real));
check('the real run writes nothing to stderr', real.stderr === '', JSON.stringify(real.stderr));
check('the real run reports no findings',
    !/disagree with the tree/.test(real.stdout), real.stdout);
check('the real run is INDETERMINATE about nothing',
    !/^INDETERMINATE/m.test(real.stdout), real.stdout);
check('offline, the unreachable network claim SKIPs visibly rather than passing silently',
    /^SKIP \[force-push\]/m.test(real.stdout), real.stdout);
check('offline, the skip is the ONLY thing printed',
    real.stdout.split('\n').filter((l) => l.trim()).length === 1, JSON.stringify(real.stdout));

const realJson = run(['--no-network', '--json']);
let parsed = null;
try { parsed = JSON.parse(realJson.stdout); } catch { /* asserted below */ }
check('--json emits a parseable report', !!parsed, realJson.stdout.slice(0, 400));
check('--json reports a real population of graded claims (>= 12)',
    !!parsed && typeof parsed.checked === 'number' && parsed.checked >= 12,
    parsed ? String(parsed.checked) : 'unparsed');
check('--json keeps findings, skips and indeterminate apart',
    !!parsed && Array.isArray(parsed.findings) && Array.isArray(parsed.skips)
    && Array.isArray(parsed.indeterminate),
    parsed ? Object.keys(parsed).join(',') : 'unparsed');

// ---------------------------------------------------------------------------
// 3. The real repository, mutated. Red, on the real file.
//
// A copy, never the working tree: test-all.js snapshots `git status` before the
// suites and fails `tree-inert` if a suite rewrites what it grades.
// ---------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'test-check-claude-md-'));
const copy = (rel) => {
    const dst = path.join(scratch, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dst);
};
try {
    copy('CLAUDE.md');
    copy('package.json');
    copy('.github/workflows/ci.yml');
    for (const h of fs.readdirSync(path.join(ROOT, 'tooling/githooks'))) copy(`tooling/githooks/${h}`);
    fs.cpSync(path.join(ROOT, 'plugins'), path.join(scratch, 'plugins'), { recursive: true });

    const control = run(['--root', scratch, '--no-network']);
    check('the copied real tree is green before mutation (exit 0)',
        control.status === 0, detail(control));

    const MD = path.join(scratch, 'CLAUDE.md');
    const pristine = fs.readFileSync(MD, 'utf8');

    // Each mutation is ONE edit to the REAL file's real sentences. `applied`
    // is asserted first: a mutation that silently matched nothing would make
    // the RED assertion below untestable rather than failing.
    //
    // THIS BLOCK IS ALSO THE VACUITY GUARD FOR THE OPTIONAL CLAIM FAMILIES.
    // The checker treats three families as load-bearing — the gate chain, the
    // `passes` table and the force-push polarity — and goes INDETERMINATE when
    // it cannot find them, because CLAUDE.md must contain all three. The
    // population and CI counts are OPTIONAL: CLAUDE.md is free not to state
    // them, so their absence is silence, not a finding. That leaves a hole —
    // reword one past its anchor and the checker quietly stops grading it. The
    // hole is closed here rather than in the checker: if a sentence drifts out
    // of anchor range, the `mutation applied` assertion below goes red and
    // names the family, which is the signal wanted and costs no false positive
    // in the gate itself.
    const mutations = [
        // The mutated value must be one the gate chain can never actually
        // hold, or the mutation is a no-op the day the real count catches up
        // to it. `[measured 2026-09-08]` this is not hypothetical: these two
        // read `eight` and `9`, and rebasing onto #198 took the chain to
        // EIGHT steps — so the first mutation rewrote "eight steps" as
        // "eight steps" and three assertions below were suddenly grading an
        // unmutated file. The `mutation applied` assertion caught it and the
        // suite went red; without that assertion it would have gone green
        // while testing nothing, which is the whole failure class this suite
        // exists to rule out. Nineteen is not a plausible step count.
        ['the gate step count word', /THE GATE: (\w+) steps/, 'THE GATE: nineteen steps',
            /CLAUDE\.md:\d+ {2}gate-header/],
        ['the "Step 1 of N" digit', /Step 1 of \d+\./, 'Step 1 of 19.',
            /step-1-of-n/],
        ['the literal chain', /&& npm run check:claude-md/, '&& npm run check:nothing',
            /the literal gate chain/],
        ['a row of the passes table', /\| `"needs-setup"` \|[^\n]*\n/, '',
            /missing from the table: "needs-setup"/],
        ['the autodev-core skill count', /core has \*\*(\d+) skills/, 'core has **999 skills',
            /autodev-core skills/],
        // `\s+`, not a space: the real file wraps between the count and "of CI's".
        ['the CI ubuntu-gated step count', /(\w+)\s+of CI's steps are/, "Nineteen of CI's steps are",
            /CI steps gated to ubuntu-latest/],
    ];

    for (const [label, find, replace, wantFinding] of mutations) {
        const mutated = pristine.replace(find, replace);
        check(`mutation applied to the real file: ${label}`, mutated !== pristine, label);
        fs.writeFileSync(MD, mutated);
        const r = run(['--root', scratch, '--no-network']);
        check(`RED on the real CLAUDE.md with ${label} changed (exit 1)`,
            r.status === 1, detail(r));
        check(`  the finding names the claim: ${label}`, wantFinding.test(r.stdout), r.stdout.slice(0, 900));
        check(`  the finding names a CLAUDE.md line and a source: ${label}`,
            /CLAUDE\.md:\d+/.test(r.stdout) && /^ {2}source: {2}\S/m.test(r.stdout), r.stdout.slice(0, 900));
        fs.writeFileSync(MD, pristine);
    }

    // Re-asserting the sentence that was measured false on 2026-09-08 must be
    // caught, and caught by the API rather than by a hardcoded expectation.
    // Skipped rather than failed when `gh` cannot answer — the whole point of
    // the three-state design is that unreachable is not a verdict.
    fs.writeFileSync(MD, pristine.replace(
        /`\[measured 2026-09-08\]` \*\*force-push is not blocked\*\*/,
        '`[measured 2026-09-08]` **force-push is blocked**'));
    const online = run(['--root', scratch]);
    const reachable = !/^SKIP \[force-push\]/m.test(online.stdout);
    check('re-asserting "force-push is blocked" is caught against the live API '
        + (reachable ? '(API reachable)' : '(SKIPPED — API unreachable here)'),
        reachable
            ? online.status === 1 && /force-push IS blocked/.test(online.stdout)
            : online.status === 0 && /NOT VERIFIED/.test(online.stdout),
        detail(online));
    check('an unreachable API never reads as "claim verified"',
        reachable || /Unreachable is not verified/.test(online.stdout), online.stdout.slice(0, 600));
    fs.writeFileSync(MD, pristine);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

let failed = 0;
for (const [label, ok, d] of cases) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
    if (!ok) { failed++; console.log('        ' + String(d).replace(/\n/g, '\n        ')); }
}
console.log(`${cases.length - failed}/${cases.length} assertions passed`);
process.exitCode = failed ? 1 : 0;
