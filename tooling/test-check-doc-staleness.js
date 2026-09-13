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
//
// MUTATION RESULTS, `[measured 2026-09-07]`, 14 planted defects, 14 killed and
// 0 survivors. Three rounds were needed and the first two are the reason this
// header says so:
//
//   round 1  9 killed, 5 survived. TWO OF THE SURVIVORS WERE VACUOUS
//            ASSERTIONS HERE, not gaps in the subject. The negation row named
//            a deploy tag and a sha, so it never matched the handle pattern
//            and never reached the veto it claimed to test; the self-resolved
//            row never matched the assert pattern. Both passed while the veto
//            they graded was deleted.
//   round 2  the negation veto turned out to be BROKEN IN THE SUBJECT - it
//            allowed one word between `no` and the verb, so it could not match
//            `NO prod tag is pending`, the sentence it was written for. The
//            fleet census had scored it 0 firings and that read as "unexercised"
//            when it meant "incapable".
//   round 3  a `section` leak survived because the fixture's last section had
//            drifted to one that suppresses nothing. Order matters here:
//            RESUME.md must END inside a suppressing section.
//
// The harness is not committed - it is fifteen string substitutions - but any
// change to the rules below should be re-mutated, because three of these four
// findings were invisible to a green suite.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-doc-staleness.js');
const { checkDocStaleness, OPEN_STATE, CONDITIONAL, DECIDED, DECIDED_SECTION,
    RESOLVED, SECTION_RE, BOOT_DOCS, KIN_DOC, render,
    HANDLE_OPEN_HANDLE, HANDLE_OPEN_ASSERT, HANDLE_OPEN_NEGATED } = require(SUBJECT);
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
    // session-exit.js now nests its status blocks one level down, as `###`
    // inside `## Current state`. Placed after a non-status heading on purpose:
    // if `###` stopped counting as a heading, this row would inherit
    // `What is next` above and go unreported, rather than passing by inheriting
    // a status heading.
    '### Open PRs',
    '',
    '- [#128](https://github.com/o/r/pull/128) `fix/y` - a PR row under the nested form',
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

    // ---- the DISCRIMINATING PAIR for the shipped-section rule --------------
    //
    // A status header naming a RUNNING VERSION is the opposite of a shipped
    // record: it is the section a reader consults for what is still open. The
    // first version of this rule matched `live` and suppressed the claim below,
    // which had been verified half stale by hand. A suppression that removes a
    // TRUE finding is worse than the noise it tuned away.
    '## WHERE THINGS STAND',
    '**Live `v1098 - sw674`** - TestFlight **build 1015** - debug APK green in CI',
    '`[measured 2026-01-02]` the store release is still blocked on a console account.',
    '',

    // ---- a NEGATED marker is not a marker ---------------------------------
    //
    // A census of every token in SHIPPED_SECTION found `done` was the sole
    // reason a section suppressed exactly twice, and BOTH were negations: a
    // heading reading "NOT done" is the opposite of a shipped record. The veto
    // protects every token rather than removing them one at a time.
    '## NOT done - these are redesigns rather than fixes and need direction',
    '`[measured 2026-01-02]` the second pass is still blocked on a layout call.',
    '',
    // The case above documents why `done` left the pattern; with it gone,
    // SHIPPED_SECTION never matches that heading and the veto is never asked.
    // So the veto needs a heading whose marker IS in the pattern, or it is
    // untestable - two mutants survived until this section existed, which is
    // the difference between a redundant guard and a verified one.
    '## NOT shipped to the store yet, and here is what remains',
    '`[measured 2026-01-02]` the upload step is still blocked on a signing cert.',
    '',

    // ---- RULE 2: a PR handle a line CALLS OPEN ----------------------------
    //
    // The regression case, verbatim from qr's trunk RESUME.md:32, over which
    // the tool printed `nothing to re-check`. PR #47 had merged three days
    // earlier. It matches no OPEN_STATE pattern and trips no suppressor: the
    // vocabulary simply never covered "a PR number with `open` next to it",
    // which is the commonest open-state claim these documents actually carry.
    '## The site v2 rebuild, as of 2026-09-04',
    'on main (#44 to #46). Phases 6 and 7 are PR #47, open at f6d1e67, gate green',
    // THE NEGATION. Same grammar as an open claim, opposite meaning.
    //
    // This line CARRIES A PR HANDLE on purpose. The first version named only a
    // deploy tag and a sha, so `HANDLE_OPEN_HANDLE` never matched it and the
    // assertion below passed without the negation veto doing anything at all -
    // a vacuous assertion, caught by mutation: deleting the veto left the
    // suite green. It must reach the veto to grade the veto.
    '> **Prod is serving `prod-v1.60.0`. NO PR #88 is open, and origin/main is clean.**',
    // A row that reports its OWN resolution is an accurate record, not a stale
    // claim. This must MATCH the assert pattern - `is open` - and then be
    // vetoed by SELF_RESOLVED, or the veto is untested for the same reason.
    '- PR #31 is open in the table above, but it was MERGED last week.',
    // `pending` is DELIBERATELY absent from the assert pattern, and this row is
    // the discriminator. Re-admitting it reports this line, which is a weaker
    // and different claim than calling a PR open.
    '- PR #88 is pending review from the design side, which is not the same claim.',
    // ---- an author's explicit carve-out inside a shipped section -----------
    //
    // The section heading is a real closure record and SHOULD suppress its own
    // rows. But a line marked PRE-EXISTING / NOT fixed is the author saying
    // THIS one survived the shipped work, and that outranks the section. The
    // parenthetical below is the shape that caused it: something else closed.
    '## v916 retired the cart hash and redirects to Food (dead end closed)',
    // The sibling row must itself be an OPEN-STATE claim that this section
    // legitimately suppresses. The first version read 'the redirect is
    // verified and the old route is gone', which matches no OPEN_STATE
    // pattern at all - so it could never be a finding, and the assertion
    // guarding it was structurally incapable of failing. A mutant widening
    // the carve-out survived against it with zero reds.
    '`[measured 2026-01-02]` the old bookmark route is still broken, which this change accepts.',
    '`[measured 2026-01-02]` PRE-EXISTING, not introduced here, NOT fixed: editing the hash still blocked on a guard.',
    '',

    '',
].join('\n');

// A SECOND BOOT DOCUMENT, scanned after RESUME.md, whose first claim sits under
// NO heading of its own.
//
// RESUME.md ENDS inside `## v916 ... (dead end closed)`, which is a shipped
// section that legitimately suppresses its own rows. If `section` leaked from
// one document into the next, this claim would inherit that suppression and
// vanish - so asserting it IS reported grades the reset behaviourally. It
// replaces a source-text regex that matched a fixed 80-character window
// between two statements and broke the moment a comment was added between
// them, which is a test of the formatting rather than of the behaviour.
const ROADMAP_FIXTURE = [
    '`[measured 2026-01-02]` The importer is still broken for multi-tenant accounts.',
].join('\n');

// A SECOND DOCUMENT, so kin detection has a boot-doc sibling to decline and
// the corpus-coverage line has something to say. `DECISIONS.md` is scanned;
// `DECISIONS-2026-09-07.md` is not, and the difference must be visible.
const KIN_FIXTURE = [
    '# A dated DECISIONS sibling the allowlist declines',
    '`[measured 2026-01-02]` The billing migration is still blocked on a schema call.',
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
    fs.writeFileSync(path.join(tmp, 'ROADMAP.md'), ROADMAP_FIXTURE, 'utf8');
    fs.writeFileSync(path.join(tmp, 'DECISIONS-2026-09-07.md'), KIN_FIXTURE, 'utf8');
    fs.writeFileSync(path.join(tmp, 'CHANGELOG.md'), '# not a boot document\n', 'utf8');
    git(['add', 'RESUME.md', 'ROADMAP.md', 'DECISIONS-2026-09-07.md', 'CHANGELOG.md'], tmp);
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
    // Pinned to `trunk` so every assertion below grades the tree it was written
    // for. The two-tree behaviour is graded separately, further down, against a
    // working copy that deliberately differs from the commit.
    const r = checkDocStaleness(tmp, { age: 7, max: 12, source: 'trunk' });

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
    check('a PR row under `### Open PRs`, the level session-exit.js emits, counts too',
        stText.indexOf('/pull/128') !== -1, stText);
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
    // TWO since the carve-out fixture landed: the LIVE+verified row, and the
    // sibling row inside the closure section. That second one moving this
    // count from 1 to 2 is the evidence it is genuinely suppressible - its
    // first draft matched no OPEN_STATE pattern, so it was suppressed by
    // nothing and the assertion guarding it could not fail.
    check('  and the shipped-section suppression is counted separately',
        r.population.suppressedAsShippedSection === 2,
        String(r.population.suppressedAsShippedSection));

    // The discriminating pair. Both sections carry the letters l-i-v-e; only
    // one of them is a record of shipped work. If a future widening of
    // SHIPPED_SECTION re-admits `live`, the second assertion goes red and the
    // first stays green, which names the direction of the mistake.
    check('a LIVE+verified lead DOES suppress',
        !r.findings.some((f) => f.text.indexOf('resume path') !== -1));
    check('a `Live vNNN` status header does NOT suppress',
        r.findings.some((f) => f.text.indexOf('store release') !== -1),
        'matching `live` here removed a hand-verified finding: a lost true positive is invisible');
    check('a heading reading "NOT done" is not treated as shipped',
        r.findings.some((f) => f.text.indexOf('second pass') !== -1),
        'documents why `done` left the pattern');
    check('a NEGATED marker that IS in the pattern does NOT suppress',
        r.findings.some((f) => f.text.indexOf('upload step') !== -1),
        'this is the one that actually exercises the veto: `shipped` matches, `NOT shipped` must not');

    // ---- the carve-out pair, and BOTH halves are the assertion -------------
    check('a line marked PRE-EXISTING / NOT fixed survives a shipped section',
        r.findings.some((f) => f.text.indexOf('editing the hash') !== -1),
        'the author carved it out explicitly; a section-level marker must not bury that');
    check('  and the SAME section still suppresses its ordinary rows',
        !r.findings.some((f) => f.text.indexOf('old bookmark route') !== -1),
        'without this half the rule could pass by disabling the shipped-section check entirely');
    check('    (and that row IS an open-state claim, so the check above can fail)',
        OPEN_STATE.some((re) => re.test('the old bookmark route is still broken, which this change accepts.')),
        'a suppressed-row assertion over a line that never matches OPEN_STATE is vacuous');

    // The precision pass must not buy its numbers by deleting real output.
    check('the known positive still survives every suppressor',
        r.findings.some((f) => f.text.indexOf('the fix is unproven') !== -1),
        'a filter that suppresses the motivating instance is worse than no filter');

    // ---- what is left, and in what order ----------------------------------
    // SEVEN. The newest is the carve-out line: a section that legitimately
    // suppresses its own rows still yields the one the author marked
    // PRE-EXISTING / NOT fixed. Its sibling row in the same section stays
    // suppressed, which is the half that stops the rule passing by simply
    // disabling the shipped-section check.
    // Before that, FIVE. Two came from the shipped-section discriminating pair, whose
    // `Live vNNN` half is reportable BY DESIGN because a status header naming a
    // running version is not a record of shipped work. Two more came from the
    // negation case, and BOTH are correct: the claim under it, and the heading
    // `## NOT done ...` itself, which is an open-state assertion in a heading
    // and is flagged as the longer-half-life kind on purpose.
    check('exactly the eight datable, non-rule claims are reported', r.findings.length === 8,
        r.findings.map((f) => f.doc + ':' + f.line).join(' '));
    check('findings are ordered oldest first',
        r.findings.length === 8
        && r.findings.every((f, i) => i === 0 || r.findings[i - 1].age >= f.age));
    check('the oldest is the 2025 one', r.findings.length === 8 && r.findings[0].age > 300);
    // THE SECTION-RESET CASE, stated as its own assertion so a regression names
    // itself instead of moving a total. RESUME.md ends inside a shipped section;
    // if `section` leaked across documents this claim would be suppressed by it.
    check('a claim opening a SECOND document is not suppressed by the first document\'s section',
        r.findings.some((f) => f.doc === 'ROADMAP.md' && f.text.indexOf('multi-tenant') !== -1),
        'section must reset per document, and RESUME.md ends inside `(dead end closed)`');

    // ---- the population line ----------------------------------------------
    //
    // A verdict with no denominator is indistinguishable from a finder that
    // returned nothing, which is the failure this repo keeps re-learning.
    check('the population names how many boot docs were looked for',
        r.population.bootDocsLookedFor === BOOT_DOCS.length);
    check('the population separates present from absent documents',
        r.population.present === 2 && r.population.absent === BOOT_DOCS.length - 2,
        r.population.present + '/' + r.population.absent);
    check('the population counts open-state AND dated separately from findings',
        r.population.openStateAndDated === 8, String(r.population.openStateAndDated));
    const text = render(r);
    check('render prints the population, not just a verdict', /population:/.test(text));
    check('render prints the trunk it read', /trunk=origin\/main/.test(text));

    // ---- the age threshold is real ----------------------------------------
    const strict = checkDocStaleness(tmp, { age: 99999, max: 12, source: 'trunk' });
    check('a threshold beyond every claim reports nothing', strict.findings.length === 0);
    check('but still reports the same population, so a zero is readable',
        strict.population.openStateAndDated === 8,
        'a zero with no denominator looks identical to a broken probe');

    // ---- RULE 2: the qr false negative, which is a REGRESSION TEST --------
    //
    // Not a synthetic case. This exact line stood on qr's trunk while the tool
    // printed `nothing to re-check` over the document containing it, and a
    // coordinator ranked qr's docs clean on the strength of that run. PR #47
    // had merged three days earlier, and the sha named is not even its head.
    const handleFinds = (r.structural || []).filter((f) => f.kind === 'handle-open');
    const handleText = handleFinds.map((f) => f.text).join(' | ');
    check('a line calling PR #47 open is REPORTED',
        handleText.indexOf('PR #47') !== -1, handleText);
    check('  and it is reported with the handle, so it names its own probe',
        handleFinds.some((f) => f.handle === 'PR #47'),
        'the point of this rule is that one `gh pr view` settles each finding');
    check('  and the lexical path was structurally incapable of finding it',
        !OPEN_STATE.some((re) => re.test(
            'on main (#44 to #46). Phases 6 and 7 are PR #47, open at f6d1e67, gate green')),
        'if a pattern ever covers it, this assertion is the one that says so');
    // Each of the three rows below must REACH its veto, or the assertion grades
    // nothing. The first two versions of this fixture did not, and mutation
    // caught both: deleting either veto left the suite green.
    const NEGROW = '> **Prod is serving `prod-v1.60.0`. NO PR #88 is open, and origin/main is clean.**';
    const SELFROW = '- PR #31 is open in the table above, but it was MERGED last week.';
    check('a NEGATED "NO PR #88 is open" row is NOT reported',
        handleText.indexOf('NO PR #88') === -1, handleText);
    check('  and it genuinely reaches the negation veto rather than missing the handle',
        HANDLE_OPEN_HANDLE.test(NEGROW) && HANDLE_OPEN_ASSERT.test(NEGROW)
        && HANDLE_OPEN_NEGATED.test(NEGROW),
        'it must match handle AND assert, then be vetoed, or the veto is untested');
    check('a handle row reporting its own MERGED state is NOT reported',
        handleText.indexOf('PR #31') === -1, handleText);
    check('  and it genuinely reaches the self-resolved veto',
        HANDLE_OPEN_HANDLE.test(SELFROW) && HANDLE_OPEN_ASSERT.test(SELFROW)
        && !HANDLE_OPEN_NEGATED.test(SELFROW),
        'it must match handle AND assert, then be vetoed by SELF_RESOLVED alone');
    check('a PR called `pending review` is NOT reported',
        handleText.indexOf('pending review') === -1,
        'admitting `pending` widens the rule to a weaker claim and buys nothing on the corpus');
    check('the handle-open population is counted, not silent',
        r.population.handleCalledOpen === 1, String(r.population.handleCalledOpen));

    // ---- coverage: a numerator with no denominator ------------------------
    //
    // `3307 lines considered` was printable over a corpus of 4,179 lines with
    // no hint that 872 were skipped. A clean corpus and a half-read one
    // produced byte-identical output.
    check('the population reports the line DENOMINATOR, not only the numerator',
        r.population.linesPresent > 0
        && r.population.linesPresent > r.population.linesConsidered,
        r.population.linesConsidered + ' of ' + r.population.linesPresent);
    check('the rendered population prints both numbers and a percentage',
        /\d+ of \d+ lines considered \(\d+%\)/.test(render(r)), render(r).split('\n')[1]);

    // ---- coverage: the corpus is larger than the allowlist ----------------
    check('a kin document is NAMED as unexamined',
        (r.population.kinDocNames || []).indexOf('DECISIONS-2026-09-07.md') !== -1,
        String(r.population.kinDocNames));
    check('  and CHANGELOG.md is NOT counted as a declined boot document',
        (r.population.kinDocNames || []).indexOf('CHANGELOG.md') === -1,
        'a 6,283-line changelog in the denominator manufactures alarm, it does not report a gap');
    check('  and a document that WAS scanned is not listed as unexamined',
        (r.population.kinDocNames || []).indexOf('ROADMAP.md') === -1);
    check('undercoverage is a LOUD line, not an inference from two numbers',
        /NOT A WHOLE-CORPUS READ/.test(render(r)), render(r));

    // ---- absence must not print as health ---------------------------------
    //
    // The sentence the qr run ended on. A verdict with no basis attached says
    // the same thing whether the corpus was read or was empty.
    // A GENUINELY CLEAN CORPUS, in its own repository. The main fixture cannot
    // serve here: `--age 99999` silences the lexical findings but NOT the
    // structural ones, which carry no date and so have no threshold to fall
    // under - by design, since a PR handle is checkable whatever its age.
    // Reusing it would have tested the age filter, not the all-clear.
    let cleanRepo = null;
    try {
        cleanRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-staleness-clean-'));
        git(['init', '-q'], cleanRepo);
        git(['config', 'user.email', 'suite@example.invalid'], cleanRepo);
        git(['config', 'user.name', 'suite'], cleanRepo);
        fs.writeFileSync(path.join(cleanRepo, 'RESUME.md'),
            ['# A document with real content and no open-state claim',
             'The importer reads a CSV and writes one row per account, in order.',
             'A 42703 means the column does not exist in that schema, which never changes.',
             'Deployment is described in the runbook rather than here.'].join('\n'), 'utf8');
        // A kin document, so the all-clear has an unexamined corpus to disclose.
        fs.writeFileSync(path.join(cleanRepo, 'PLAN-SITE-V2.md'), '# the partner brief\n', 'utf8');
        git(['add', 'RESUME.md', 'PLAN-SITE-V2.md'], cleanRepo);
        git(['commit', '-q', '-m', 'clean'], cleanRepo);
        git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'], cleanRepo).trim()], cleanRepo);

        const clean = checkDocStaleness(cleanRepo, { age: 7, max: 12, source: 'trunk' });
        const cleanText = render(clean);
        check('the clean fixture really does produce no findings, or the case is not an all-clear',
            clean.findings.length === 0 && clean.structural.length === 0,
            clean.findings.length + '/' + clean.structural.length);
        check('an all-clear is NEVER the bare words "nothing to re-check"',
            !/nothing to re-check\s*$/m.test(cleanText),
            'a verdict with no basis is indistinguishable from a probe that looked at nothing');
        check('  the all-clear carries the basis it stands on, in the same sentence',
            /nothing to re-check in \d+ lines across \d+ document/.test(cleanText), cleanText);
        check('  and the basis is a REAL count, not a zero dressed as health',
            clean.population.linesConsidered > 0, String(clean.population.linesConsidered));
        check('  and it still points at the unexamined documents',
            /but see the unexamined documents above/.test(cleanText), cleanText);
    } catch (e) {
        check('the clean-corpus case could be built', false, String(e.message).slice(0, 160));
    } finally {
        if (cleanRepo) fs.rmSync(cleanRepo, { recursive: true, force: true });
    }

    // ---- WHICH TREE ANSWERED ----------------------------------------------
    //
    // The defect: a session fixes a stale claim, opens a PR, re-runs the sweep
    // and reads its own findings back verbatim. That reads as "my fix failed"
    // and means "not merged yet". Here the working copy has the claim REMOVED
    // while the commit still carries it, which is exactly that state.
    // The claim is DELETED rather than reworded, so every line below it shifts
    // up by one. That is what a real fix looks like, and it is the case that
    // distinguishes matching findings by TEXT from matching them by LINE
    // NUMBER: under a line-number key the shift mislabels the whole tail of
    // the document as newly fixed. Mutation caught this - a line-number key
    // survived a fixture whose edit preserved the line count.
    const FIXED = FIXTURE.split('\n')
        .filter((l) => l.indexOf('the fix is unproven') === -1).join('\n');
    check('the fixture edit really did remove the claim, so the case is live',
        FIXED.indexOf('the fix is unproven') === -1,
        'if the edit missed, both trees would agree and the assertion could not fail');
    check('  and it SHIFTED the lines below it, which is what a real fix does',
        FIXED.split('\n').length === FIXTURE.split('\n').length - 1,
        'without a shift, a line-number key and a text key are indistinguishable');
    fs.writeFileSync(path.join(tmp, 'RESUME.md'), FIXED, 'utf8');

    const both = checkDocStaleness(tmp, { age: 7, max: 12, source: 'both' });
    const stillTrunk = checkDocStaleness(tmp, { age: 7, max: 12, source: 'trunk' });
    const wt = checkDocStaleness(tmp, { age: 7, max: 12, source: 'worktree' });

    const motiv = (x) => (x.findings || []).filter((f) => f.text.indexOf('the fix is unproven') !== -1);
    check('the claim is STILL at the trunk, so the trunk scan is unchanged',
        motiv(stillTrunk).length === 1,
        'if this goes red the fixture, not the subject, has moved');
    check('the working copy alone no longer reports it',
        motiv(wt).length === 0);
    check('reading BOTH still reports it, because the trunk still carries it',
        motiv(both).length === 1,
        'silently dropping it would hide a claim every other reader of the repo sees');
    check('  but labels it FIXED LOCALLY rather than repeating it as open',
        motiv(both).length === 1 && motiv(both)[0].state === 'fixed-locally',
        motiv(both).length ? String(motiv(both)[0].state) : 'n/a');
    check('  and the label reaches the rendered output',
        /FIXED LOCALLY, NOT MERGED/.test(render(both)));
    check('  and it is counted in the population',
        both.population.fixedLocallyNotMerged >= 1,
        String(both.population.fixedLocallyNotMerged));
    check('a claim that is still open in BOTH trees is not mislabelled',
        (both.findings || []).some((f) => f.text.indexOf('multi-tenant') !== -1
            && f.state === 'open'),
        'if everything reads fixed-locally the label carries no information');
    // THE COUNT IS THE SHARP ASSERTION, and it is what a line-number key fails.
    // Exactly one claim was removed, so exactly one finding may read
    // fixed-locally. Keying on line numbers instead of text mislabels every
    // finding BELOW the deletion - six of them here - because they all shifted
    // up by one. The `multi-tenant` check above cannot see that: it lives in
    // ROADMAP.md, which was never edited, so its line number did not move.
    check('  and EXACTLY ONE finding is fixed-locally, not every line below the edit',
        both.population.fixedLocallyNotMerged === 1,
        String(both.population.fixedLocallyNotMerged) + ' — a shift must not read as a fix');
    check('  so the RESUME.md claims below the deletion still read as open',
        (both.findings || []).filter((f) => f.doc === 'RESUME.md' && f.state === 'open').length >= 5,
        String((both.findings || []).filter((f) => f.doc === 'RESUME.md' && f.state === 'open').length));

    // The header line must say which tree answered, or the reader is back to
    // inferring it from a flag they did not pass.
    check('the report NAMES the tree it read',
        /read=trunk origin\/main, compared against the working copy/.test(render(both)),
        render(both).split('\n')[0]);
    check('  and says so differently when only one tree was read',
        /read=trunk origin\/main only/.test(render(stillTrunk)),
        render(stillTrunk).split('\n')[0]);
    check('  and names the working copy when that is what was graded',
        /read=working copy/.test(render(wt)), render(wt).split('\n')[0]);

    // A claim present ONLY in the working copy is one this session is about to
    // ship, and must not be silently merged into the trunk findings.
    const LOCAL = FIXED + '\n## A new note\n`[measured 2026-01-02]` The rollout is still blocked on a DNS change.\n';
    fs.writeFileSync(path.join(tmp, 'RESUME.md'), LOCAL, 'utf8');
    const withLocal = checkDocStaleness(tmp, { age: 7, max: 12, source: 'both' });
    check('a claim only in the working copy is reported SEPARATELY',
        (withLocal.localOnly || []).some((f) => f.text.indexOf('DNS change') !== -1),
        String((withLocal.localOnly || []).map((f) => f.text)));
    check('  and is kept OUT of the trunk findings',
        !(withLocal.findings || []).some((f) => f.text.indexOf('DNS change') !== -1),
        'a claim that is not at the trunk is not something other readers see');
    check('  and the render says which of the two it is',
        /only in the working copy/.test(render(withLocal)));

    // restore, so nothing below reads an edited fixture
    fs.writeFileSync(path.join(tmp, 'RESUME.md'), FIXTURE, 'utf8');

    // ---- BEHIND THE TRUNK IS NOT ABOUT TO SHIP ---------------------------
    //
    // The same content diff — a claim the working copy has and the trunk does not — has two
    // opposite causes, and reporting both as "you are about to ship these" sends sessions to
    // re-fix lines the trunk fixed weeks ago. Measured in a consuming repo 2026-09-11: the main checkout
    // sat 361 commits BEHIND origin/main and 0 ahead, and two already-corrected RESUME.md claims
    // were reported as unshipped work.
    //
    // Built as its OWN repository rather than by mutating `tmp`, because this needs HEAD and the
    // trunk ref to point at different commits and the shared fixture deliberately has them equal.
    let behindRepo = null;
    try {
        behindRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-staleness-behind-'));
        git(['init', '-q'], behindRepo);
        git(['config', 'user.email', 'suite@example.invalid'], behindRepo);
        git(['config', 'user.name', 'suite'], behindRepo);
        // c1 CARRIES the claim.
        fs.writeFileSync(path.join(behindRepo, 'RESUME.md'), FIXTURE, 'utf8');
        git(['add', 'RESUME.md'], behindRepo);
        git(['commit', '-q', '-m', 'c1 with the claim'], behindRepo);
        const c1 = git(['rev-parse', 'HEAD'], behindRepo).trim();
        // c2 REMOVES it, and becomes the trunk.
        fs.writeFileSync(path.join(behindRepo, 'RESUME.md'), FIXED, 'utf8');
        git(['add', 'RESUME.md'], behindRepo);
        git(['commit', '-q', '-m', 'c2 fixes it'], behindRepo);
        const c2 = git(['rev-parse', 'HEAD'], behindRepo).trim();
        git(['update-ref', 'refs/remotes/origin/main', c2], behindRepo);
        // Check out c1: the tree is now BEHIND the trunk and CLEAN.
        git(['checkout', '-q', c1], behindRepo);
    } catch (e) {
        check('the behind-the-trunk fixture could be built', false, String(e.message).slice(0, 200));
        behindRepo = null;
    }

    if (behindRepo) {
        const dirtyNow = git(['status', '--porcelain'], behindRepo).trim();
        check('the behind fixture is CLEAN, so dirtiness cannot explain the result',
            dirtyNow === '', JSON.stringify(dirtyNow));
        check('  and it really is behind: 0 commits the trunk lacks',
            git(['rev-list', '--count', 'HEAD', '--not', 'origin/main'], behindRepo).trim() === '0');

        const behind = checkDocStaleness(behindRepo, { age: 7, max: 12, source: 'both' });
        // Non-vacuity: if the claim is not picked up at all, everything below passes for the
        // wrong reason — the same trap a downstream repo's census PRs were written to close.
        const rows = (behind.localOnly || []).filter((f) => f.text.indexOf('the fix is unproven') !== -1);
        check('the behind-tree claim IS detected, so this case is not vacuously green',
            rows.length === 1, String((behind.localOnly || []).map((f) => f.text)));
        check('  and it is classified stale-checkout, NOT local-only',
            rows.length === 1 && rows[0].state === 'stale-checkout',
            rows.length ? String(rows[0].state) : 'n/a');
        check('  and the render REFUSES to call it about to ship',
            !/about to ship/.test(render(behind)),
            'a tree with nothing the trunk lacks cannot ship anything');
        check('  and the render says it is behind, and that these are stale',
            /BEHIND it/.test(render(behind)) && /STALE/.test(render(behind)),
            render(behind));

        // A dirty peer does not turn clean checkout history into new work.
        fs.writeFileSync(path.join(behindRepo, 'CLAUDE.md'), '# Local\n`[measured 2026-01-02]` The rollout is still blocked on a DNS change.\n', 'utf8');
        const mixed = checkDocStaleness(behindRepo, { age: 7, max: 12, source: 'both' });
        check('mixed population includes both stale history and dirty local work',
            mixed.localOnly.some((f) => f.state === 'stale-checkout')
            && mixed.localOnly.some((f) => f.state === 'local-only'));
        const mixedText = render(mixed);
        check('mixed render distinguishes stale history from local work instead of calling both about to ship',
            /stale-checkout/.test(mixedText) && /local-only/.test(mixedText)
            && !/you are about to ship these/.test(mixedText), mixedText);
        const capped = checkDocStaleness(behindRepo, { age: 7, max: 1, source: 'both' });
        check('capped mixed report displays stale history without labeling it about to ship',
            capped.localOnly.length === 1 && capped.localOnly[0].state === 'stale-checkout'
            && !/about to ship/.test(render(capped)), render(capped));
        fs.unlinkSync(path.join(behindRepo, 'CLAUDE.md'));

        // CANARY, the other direction: dirty the SAME file in the SAME behind tree and the
        // verdict must flip back, or the guard is keying on the tree and ignoring the document.
        fs.writeFileSync(path.join(behindRepo, 'RESUME.md'), FIXTURE + '\n## Later\n`[measured 2026-01-02]` The rollout is still blocked on a DNS change.\n', 'utf8');
        const dirtied = checkDocStaleness(behindRepo, { age: 7, max: 12, source: 'both' });
        const dnsRow = (dirtied.localOnly || []).filter((f) => f.text.indexOf('DNS change') !== -1);
        check('an UNCOMMITTED edit in the same behind tree is still about-to-ship',
            dnsRow.length === 1 && dnsRow[0].state === 'local-only',
            dnsRow.length ? String(dnsRow[0].state) : 'the DNS claim was not detected at all');
        check('  so the guard keys on the DOCUMENT being dirty, not merely on the tree',
            /about to ship/.test(render(dirtied)), render(dirtied));

        fs.rmSync(behindRepo, { recursive: true, force: true });
    }

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

// The trunk is still the POPULATION, which is the invariant the original
// version of this assertion was protecting - worktree copies must not
// double-count. What changed is that the working copy is now read too, purely
// to classify each trunk finding. So this grades both halves: the trunk read
// exists, and the population is taken from the trunk scan rather than the
// working-copy one.
check('the subject still reads the TRACKED tree at the trunk',
    /git\(\['show', trunk \+ ':' \+ doc\]/.test(SRC),
    'the trunk is what every other reader of the repo sees');
check('the working copy is read only to CLASSIFY, never to count',
    /const base = source === 'worktree'/.test(SRC)
    && /present: base\.present, absent: base\.absent/.test(SRC),
    'a working copy has as many current values as there are checkouts');
check('section tracking runs BEFORE the line-length filter',
    SRC_SUBJECT.indexOf('if (sm) section =') < SRC_SUBJECT.indexOf('if (line.length < 20) continue;'),
    'a heading shorter than the filter is invisible otherwise, and nothing in the output says so');
check('the decided test reads the SECTION, not just the line',
    /DECIDED_SECTION\.test\(section\)/.test(SRC_SUBJECT));
// (section reset is graded behaviourally in the fixture above, via a claim in
// ROADMAP.md that a leaked shipped section from RESUME.md would suppress)
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
