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
const { checkDocStaleness, OPEN_STATE, CONDITIONAL, DECIDED, DECIDED_SECTION,
    RESOLVED, SECTION_RE, BOOT_DOCS, render } = require(SUBJECT);
const SRC = fs.readFileSync(SUBJECT, 'utf8');
const SRC_SUBJECT = SRC;

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
    // A DECIDED section. The claim under it carries no marker of its own,
    // which is why section tracking exists rather than a wider line regex.
    '## Closed as NOT defects, recorded so they are not re-opened',
    '`[measured 2026-01-02]` The critic scores are still broken on the staging tier.',
    '',
    // A SHORT decided heading, deliberately under the line-length filter.
    // Only registers if section tracking runs BEFORE that filter.
    '## Deferred',
    '`[measured 2026-01-02]` The export job is still broken and nobody has looked.',
    '',
    // A past-tense claim about a state that has already moved.
    '## A note written after the fact',
    '`[measured 2026-01-02]` The row above used to say MERGEABLE and blocked on a revert.',
    '',

    // ---- RULE 1 (narrow): the HEADING is the assertion ---------------------
    // No open-state vocabulary and no date on any of these rows. A lexical scan
    // cannot see them; the generated-status heading IS the claim.
    '## Open PRs',
    '',
    '- [#127](https://github.com/o/r/pull/127) `fix/x` - a PR row with a real handle',
    '- a row with no handle at all, which must NOT be reported',
    // A BARE `#N` is not a PR reference. `UI-CONTRACT #1`, `fix #7`, `trap #1`
    // all look like one, and PR #1 and #7 exist in nearly every repo, so a bare
    // number resolves as merged essentially always. Without this row the
    // strict-handle rule is structurally incapable of failing: a mutation that
    // accepted bare `#N` survived the whole suite until this line existed.
    '- see UI-CONTRACT #1 for the row shape, which is not a PR reference',
    '- [#49](https://github.com/o/r/pull/49) is **MERGED**, recorded so nobody redoes it',
    '',
    '## Unpushed commits',
    '',
    '- `8b79aa2 fix(thing): a seven-character sha, which must still count`',
    '',
    // NOT a generated-status heading. The same row shape under a heading that
    // merely SOUNDS open is the broad rule the census rejected at ~8%.
    '## What is next',
    '',
    '- [#900](https://github.com/o/r/pull/900) a row under a heading that only sounds open',
    '',

    // ---- a QUOTED SPAN opening on one line and closing on the next ---------
    '## A record quoting a control name',
    '`[measured 2026-01-02]` the flow offers the plain modal and a \"mark',
    'not done\" undo control, which is a button name rather than a claim.',
    '',

    // ---- a SHIPPED section, whose rows age into false positives forever ----
    '## v626 workout flow',
    '**Five fixes, LIVE+verified:**',
    '`[measured 2026-01-02]` the resume path is still broken on the older client.',
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

    // ---- precision: a decision is not an open claim -----------------------
    //
    // Measured on the first fleet run: 9 findings, 5 of them not open state.
    // Three were decisions and none carried a marker on the claim line.
    check('a claim inside a DECIDED section is not reported',
        !r.findings.some((f) => f.text.indexOf('critic scores') !== -1),
        'the section said closed-as-not-defects; the claim line said nothing');
    check('the claim line really does carry no marker of its own',
        !DECIDED.test('The critic scores are still broken on the staging tier.'),
        'if it did, this case would pass without section tracking and prove nothing');
    check('a SHORT decided heading is still seen, despite the length filter',
        !r.findings.some((f) => f.text.indexOf('export job') !== -1),
        'section tracking must run BEFORE the line-length filter or this is missed');
    check('the short heading really is below the filter', '## Deferred'.length < 20);
    check('a past-tense claim is not reported',
        !r.findings.some((f) => f.text.indexOf('used to say') !== -1));

    check('decided suppressions are counted, not silent',
        r.population.suppressedAsDecided === 2, String(r.population.suppressedAsDecided));
    check('resolved suppressions are counted separately from decided',
        r.population.suppressedAsResolved === 1, String(r.population.suppressedAsResolved));

    // ---- RULE 1 (narrow): the heading is the assertion ---------------------
    //
    // These rows carry NO stale-claim vocabulary and NO date, so every
    // assertion here is invisible to the lexical path by construction. That is
    // the point of the rule and the reason it needed its own census.
    const st = r.structural || [];
    const stText = st.map((f) => f.text).join(' | ');
    check('a PR row under `## Open PRs` is reported with no stale wording on it',
        stText.indexOf('/pull/127') !== -1, stText);
    check('a seven-character sha under `## Unpushed commits` still counts',
        stText.indexOf('8b79aa2') !== -1,
        'tightening the sha pattern to 8+ hex silently dropped real findings once');
    check('a row with NO handle is not reported', stText.indexOf('no handle at all') === -1);
    check('a BARE #N is not accepted as a handle',
        stText.indexOf('UI-CONTRACT') === -1,
        'PR #1 exists in nearly every repo, so a bare number resolves as merged almost always');
    check('a row that reports its OWN resolution is not reported',
        stText.indexOf('/pull/49') === -1,
        'it says MERGED, so it is an accurate record rather than a stale claim');
    check('a heading that merely SOUNDS open does NOT trigger the rule',
        stText.indexOf('/pull/900') === -1,
        'the broad form measured ~8% precision and is an allowlist for that reason');
    check('the generated-status population is printed, not just the findings',
        r.population.generatedStatusRowsSeen >= 4,
        String(r.population.generatedStatusRowsSeen));

    // Structural findings must NOT join the aged list. They carry no date, so
    // an --age threshold cannot apply to them, and merging the two would make
    // `--age 99999` quietly stop meaning "report nothing".
    check('structural findings are kept OUT of the aged findings list',
        !r.findings.some((f) => f.text.indexOf('/pull/127') !== -1));

    // ---- a quoted span that opens on one line and closes on the next -------
    check('vocabulary inside a quoted control name is suppressed',
        !r.findings.some((f) => f.text.indexOf('undo control') !== -1),
        'the closing line has no opening quote, so a line-local check matches it');
    check('  and the quoted-span suppression is counted, not silent',
        r.population.suppressedAsQuotedSpan === 1,
        String(r.population.suppressedAsQuotedSpan));

    // ---- a section that says the work shipped ------------------------------
    check('a claim under a LIVE+verified section is suppressed',
        !r.findings.some((f) => f.text.indexOf('resume path') !== -1));
    check('  and the shipped-section suppression is counted separately',
        r.population.suppressedAsShippedSection === 1,
        String(r.population.suppressedAsShippedSection));

    // The precision pass must not buy its numbers by deleting real output.
    check('the known positive still survives every suppressor',
        r.findings.some((f) => f.text.indexOf('the fix is unproven') !== -1),
        'a filter that suppresses the motivating instance is worse than no filter');

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
check('section tracking runs BEFORE the line-length filter',
    SRC_SUBJECT.indexOf('if (sm) section =') < SRC_SUBJECT.indexOf('if (line.length < 20) continue;'),
    'a heading shorter than the filter is invisible otherwise, and nothing in the output says so');
check('the decided test reads the SECTION, not just the line',
    /DECIDED_SECTION\.test\(section\)/.test(SRC_SUBJECT));
check('section resets per document, so one file cannot inherit another\'s',
    /const rows = body\.split[\s\S]{0,80}let section = ''/.test(SRC_SUBJECT));
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
