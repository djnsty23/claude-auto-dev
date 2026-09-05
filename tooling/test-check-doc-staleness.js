'use strict';
// Suite for plugins/autodev-core/scripts/check-doc-staleness.js.
//
// The subject reports which OPEN-STATE claims in a Brain's boot documents are
// old enough to re-check before being believed. The failure it exists to
// prevent is a Brain reading "the fix is unproven", ranking it top across five
// projects, and spending a session proving something proven eleven hours after
// that sentence was written.
//
// MOST OF THIS SUITE IS BEHAVIOURAL, ON A REAL GIT REPO. A regex unit test
// would grade the patterns; it would not notice the subject reading the
// working copy instead of the trunk, or defining a suppressor it never
// applies. Both are defects the patterns cannot see. So the fixture is a real
// commit in a real repository with a real origin/main ref, and the assertions
// are on the findings that come back.
//
// The fixture carries FOUR shapes on purpose, and each is a case:
//   - the real sentence that motivated the tool          -> must be reported
//   - a conditional RULE that also matches OPEN_STATE    -> must be suppressed
//   - a mechanism claim                                  -> must never match
//   - an open claim with no date within reach            -> must not be aged

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-doc-staleness.js');
const { checkDocStaleness, OPEN_STATE, CONDITIONAL, BOOT_DOCS, render } = require(SUBJECT);
const SRC = fs.readFileSync(SUBJECT, 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

// ---- the fixture -----------------------------------------------------------
//
// Dates are fixed in the past rather than computed from today, so the suite
// grades the ageing arithmetic instead of agreeing with it.

const REAL = 'No real delivery has arrived since, so the fix is unproven.';
const RULE = 'The fix is not done until the family is empty and appended.';
const MECH = 'A 42703 means the column does not exist in that schema.';

const FIXTURE = [
    '# RESUME fixture for check-doc-staleness',
    '',
    '## Payments, the real instance this tool exists to catch',
    '`[measured 2026-01-02]` ' + REAL,
    '',
    '## An older one, so the ordering can be graded as oldest-first',
    '`[measured 2025-11-03]` The nightly export is still broken on the staging tier.',
    '',
    '## A standing RULE, which must be suppressed rather than reported',
    '`[measured 2026-01-02]` ' + RULE,
    '',
    '## A MECHANISM claim, which must never match at all',
    '`[measured 2026-01-02]` ' + MECH,
    '',
    '## An open claim with no date within reach, which must not be aged',
    '',
    '',
    '',
    'This one remains open and nothing near it carries a date, so it cannot be aged.',
    '',
].join('\n');

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let tmp = null;
try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-staleness-'));
    git(['init', '-q'], tmp);
    git(['config', 'user.email', 'suite@example.invalid'], tmp);
    git(['config', 'user.name', 'suite'], tmp);
    fs.writeFileSync(path.join(tmp, 'RESUME.md'), FIXTURE, 'utf8');
    git(['add', 'RESUME.md'], tmp);
    git(['commit', '-q', '-m', 'fixture'], tmp);
    // A trunk without a network: point a remote-tracking ref at the commit.
    // trunkOf() resolves origin/HEAD first, then origin/main, then origin/master.
    const head = git(['rev-parse', 'HEAD'], tmp).trim();
    git(['update-ref', 'refs/remotes/origin/main', head], tmp);
} catch (e) {
    check('the fixture repository could be built', false, String(e.message).slice(0, 200));
    tmp = null;
}

if (tmp) {
    const r = checkDocStaleness(tmp, { age: 7, max: 12 });

    check('a trunk was resolved, so the scan actually ran', r.trunk === 'origin/main', String(r.trunk));

    // ---- the known positive, first ----------------------------------------
    //
    // If this ever goes red the tool has lost the only instance it is known to
    // catch, and every other assertion here is worth nothing.
    const found = r.findings.filter((f) => f.text.indexOf('the fix is unproven') !== -1);
    check('the motivating sentence is REPORTED', found.length === 1,
        'this is the known positive; without it the rest of the suite is vacuous');
    check('it is attributed to the right document', found.length === 1 && found[0].doc === 'RESUME.md');
    check('its line number points at the claim, not the file',
        found.length === 1 && found[0].line === 4, found.length ? String(found[0].line) : 'n/a');
    check('it is aged in days, not reported as 0', found.length === 1 && found[0].age > 200);

    // ---- the two suppression rules ----------------------------------------
    check('the conditional RULE is NOT reported',
        !r.findings.some((f) => f.text.indexOf('until the family') !== -1),
        'a rule is a standing instruction and reads the same in a year');
    check('the rule was suppressed deliberately, not missed by the patterns',
        OPEN_STATE.some((re) => re.test(RULE)) && CONDITIONAL.test(RULE),
        'it must MATCH open-state and then be suppressed, or the suppressor is untested');
    check('suppression is counted in the population, not silent',
        r.population.suppressedAsConditional === 1, String(r.population.suppressedAsConditional));

    check('the mechanism claim is NOT reported',
        !r.findings.some((f) => f.text.indexOf('42703') !== -1));
    check('the mechanism claim does not match the patterns at all',
        !OPEN_STATE.some((re) => re.test(MECH)),
        'mechanisms do not decay; sweeping them is how a detector reaches 683 items and gets muted');

    check('an undated open claim is NOT reported',
        !r.findings.some((f) => f.text.indexOf('nothing near it carries a date') !== -1),
        'an age is the whole output; a claim that cannot be aged cannot be ranked');

    // ---- what is left, and in what order ----------------------------------
    check('exactly the two datable, non-rule claims are reported', r.findings.length === 2,
        r.findings.map((f) => f.doc + ':' + f.line).join(' '));
    check('findings are ordered oldest first',
        r.findings.length === 2 && r.findings[0].age > r.findings[1].age);
    check('the oldest is the 2025 one', r.findings.length === 2 && r.findings[0].age > 300);

    // ---- the population line ----------------------------------------------
    //
    // A verdict with no denominator is indistinguishable from a finder that
    // returned nothing, which is the failure this repo keeps re-learning.
    check('the population names how many boot docs were looked for',
        r.population.bootDocsLookedFor === BOOT_DOCS.length);
    check('the population separates present from absent documents',
        r.population.present === 1 && r.population.absent === BOOT_DOCS.length - 1,
        r.population.present + '/' + r.population.absent);
    check('the population counts open-state AND dated separately from findings',
        r.population.openStateAndDated === 2);
    const text = render(r);
    check('render prints the population, not just a verdict', /population:/.test(text));
    check('render prints the trunk it read', /trunk=origin\/main/.test(text));

    // ---- the age threshold is real ----------------------------------------
    const strict = checkDocStaleness(tmp, { age: 99999, max: 12 });
    check('a threshold beyond every claim reports nothing', strict.findings.length === 0);
    check('but still reports the same population, so a zero is readable',
        strict.population.openStateAndDated === 2,
        'a zero with no denominator looks identical to a broken probe');

    // ---- a repo with no trunk says so rather than reporting clean ---------
    let bare = null;
    try {
        bare = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-staleness-bare-'));
        git(['init', '-q'], bare);
        const nr = checkDocStaleness(bare, {});
        check('an unresolvable trunk is NOT reported as clean',
            nr.trunk === null && nr.note.length > 0,
            'nothing scanned is not the same claim as nothing found');
    } catch (e) {
        check('the bare-repo case could be built', false, String(e.message).slice(0, 120));
    } finally {
        if (bare) fs.rmSync(bare, { recursive: true, force: true });
    }

    fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- structural assertions the fixture cannot make --------------------------
//
// These grade WHERE the subject reads and WHETHER the suppressor is wired,
// which a passing fixture cannot distinguish from luck.

check('the subject reads the TRACKED tree at the trunk, never the working copy',
    /git\(\['show', trunk \+ ':' \+ doc\]/.test(SRC),
    'a working copy has as many current values as there are checkouts');
check('the suppressor is APPLIED in the scan loop, not merely defined',
    /CONDITIONAL\.test\(line\)/.test(SRC),
    'a regex defined and never applied is a gate wired to nothing');
check('the suppressor runs AFTER the open-state match, so suppression is countable',
    SRC.indexOf('OPEN_STATE.some') < SRC.indexOf('CONDITIONAL.test(line)'));
check('it is a report, not a gate: the main path always exits 0',
    /const r = checkDocStaleness[\s\S]*process\.exit\(0\);/.test(SRC),
    'a check that reds on uncertainty gets disabled, and uncertainty is the entire output');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
