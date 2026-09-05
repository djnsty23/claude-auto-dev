#!/usr/bin/env node
'use strict';
/**
 * check-doc-staleness.js - at Brain boot, re-check the OPEN-STATE claims in the
 * few documents the Brain is about to believe.
 *
 * THE INSTANCE. `[measured 2026-09-05]` One product's RESUME.md said of a payment
 * webhook fix: "No real delivery has arrived since, so the fix is unproven." That
 * was true when written at 11:18:46Z and false by 22:24:35Z the SAME DAY. It
 * stood for fifteen days. A Brain read it at boot, ranked "the revenue path is
 * unverified" as the highest-priority item across five projects, and spent a
 * session proving something already proven.
 *
 * WHY OPEN-STATE CLAIMS AND NOT ALL CLAIMS. A stale "fixed in PR #N" surfaces the
 * moment anyone looks, because the work is still needed and its absence shows. A
 * stale "still unproven" makes readers SKIP work already done, and skipping emits
 * no output, no failure and no diff. The cost is invisible by construction and
 * compounds for as long as the sentence stands.
 *
 * WHY THIS IS NOT ~/.claude/scripts/memory-staleness-sweep.js, WHICH ALREADY
 * EXISTS AND IS GOOD. That sweep covers MEMORY files and auto-verifies PR and
 * issue state with `gh`. Pointed at a product repo it scanned 1,941 files,
 * reported 5,052 state claims, counted every worktree copy again, emitted 683
 * items needing human re-check, and did NOT find the line above, because that
 * claim names no PR. A 683-item list is not actionable at boot; it is the shape
 * of detector that gets muted. This one is deliberately tiny:
 *
 *   - only the documents a Brain actually reads at boot, about eight per repo
 *   - only the TRACKED tree at the trunk, so worktree copies cannot double-count
 *   - only claims asserting an OPEN state, which are the ones that decay silently
 *   - ranked by age, capped, and it prints the population it scanned
 *
 * It does NOT decide staleness. Deciding needs a probe per claim, and guessing
 * one is how you get a gate that is confidently wrong. It hands a Brain a short
 * list to re-check before trusting, which is the whole job.
 *
 * Usage:
 *   node check-doc-staleness.js --repo <path> [--age 7] [--max 12] [--json]
 *   node check-doc-staleness.js --selftest
 *
 * Exit: 0 always. This is a report, not a gate. A gate that reds on uncertainty
 * gets disabled, and uncertainty is the entire output here.
 */

const { execFileSync } = require('child_process');
const path = require('path');

/** The documents a Brain reads at boot and then acts on. Not the whole repo. */
const BOOT_DOCS = [
    'RESUME.md', 'CLAUDE.md', 'AGENTS.md', 'ROADMAP.md',
    'PUBLISH-QUEUE.md', 'DECISIONS.md', 'GAME.md', 'PLAN.md',
];

/**
 * Assertions that something is NOT done. Deliberately narrow: each must be a
 * claim about state rather than about a mechanism. "a 42703 means the column is
 * missing" stays true forever; "the fix is unproven" does not.
 */
const OPEN_STATE = [
    /\bis (still )?unproven\b/i,
    /\bremains? (open|unproven|broken|unverified|outstanding)\b/i,
    /\bstill (open|broken|failing|unverified|not )\b/i,
    /\bnot (yet )?(proven|verified|fixed|done|wired|configured|armed)\b/i,
    /\bnever (ran|fired|arrived|worked|verified)\b/i,
    /\bno real \w+ has (arrived|happened)\b/i,
    /\bblocked on\b/i,
    /\bcannot be (closed|verified|proven)\b/i,
    /\b(is|are) unverified\b/i,
    /\bhas not been (fixed|verified|proven|done)\b/i,
];

/**
 * A CONDITIONAL is a rule, not a state claim, and rules do not rot.
 * `[measured 2026-09-05]` the first run of this tool returned 7 hits in one repo
 * and 2 were policy: "is not done until the family is appended" and "THE FIX IS
 * NOT DONE UNTIL THE FAMILY IS EMPTY". Both are standing instructions that will
 * read the same in a year. Shipping at that precision is how the 683-item sweep
 * this file exists to replace got muted, so they are suppressed by construction.
 */
const CONDITIONAL = /\b(until|unless|as long as|whenever|any time|before you)\b/i;

/**
 * A DECISION NOT TO ACT IS NOT AN OPEN CLAIM. `[measured 2026-09-05]` the
 * first fleet run returned 9 hits and 5 were not open state. Three were
 * decisions, and none carried a marker on the claim line: the marker was the
 * SECTION. "Closed as NOT defects - recorded so they are not re-opened" and
 * "Deliberately NOT done, with reasons" both introduce a list whose every
 * line then reads as an open claim. So this tracks the enclosing heading or
 * bold lead as well as the line.
 *
 * This is prd.json's `deferred` state arriving in prose: counting a decision
 * as remaining work is the same defect that made `auto` block forever.
 */
const DECIDED = /\b(deliberately|by design|on purpose|do-not-implement|won'?t fix|wontfix|yagni|not a defect|decided not to)\b/i;
const DECIDED_SECTION = /\b(closed as|deliberately|not defects|won'?t fix|do-not-implement|decided|deferred|rejected)\b/i;

/**
 * A claim in the PAST TENSE describes a state that has already moved, and the
 * prose around it usually says so outright. The instance: "The row above used
 * to say MERGEABLE and blocked on reverting a depth-of-field effect; both
 * halves were stale."
 */
const RESOLVED = /\b(used to (say|be|read)|was blocked|were stale|is no longer|are no longer|has since|have since|turned out|no longer blocked)\b/i;

/** A markdown heading or a bold lead-in, either of which opens a section. */
const SECTION_RE = /^\s*(?:#{1,6}\s+(.+?)\s*$|>?\s*\*\*(.+?)\*\*)/;

/** A date the writer stamped, so the claim's age is knowable. */
const DATE_RE = /\b(20\d\d)-(\d\d)-(\d\d)\b/;

/**
 * A SECTION THAT SAYS THE WORK SHIPPED describes history, and everything under
 * it ages into a false positive every day it survives.
 *
 * `[measured 2026-09-05]` the instance: one product's RESUME.md was flagged at
 * 54 days on the phrase `not done`, under a dated heading whose lead read
 * `**v626 - Train workout-flow (5 fixes, FLEET agent, LIVE+verified):**`. The
 * section is a shipped-work record; nothing in it is a live claim.
 *
 * Keyed on the SHIPPED MARKER rather than on the heading's date, deliberately.
 * Suppressing every dated heading would also silence `## 2026-09-05 - what is
 * still open`, which is a dated heading over genuinely open work. The marker is
 * the narrower signal and it is the one the instance actually carried.
 *
 * `live` IS DELIBERATELY ABSENT, and its removal is the whole of this rule's
 * first correction. `[measured 2026-09-05]`, running the merged rule across the
 * fleet, it suppressed a genuine finding:
 *
 *     ## WHERE THINGS STAND - 2026-07-31
 *     **Live `v1098 · sw674`** · iOS TestFlight **build 1015** · ...
 *     (release still blocked on Andy: Play Console + Firebase - see below).
 *
 * The only token matching was `Live`, from a DEPLOYMENT VERSION MARKER in a
 * status header. That header is the opposite of a shipped-work record: it is
 * the section a reader consults for what is still open. The claim under it had
 * been verified half stale by hand hours earlier, and the rule removed it.
 *
 * A suppression that removes a TRUE finding is worse than the noise it was
 * tuning away, because the noise is visible and the loss is not. So the marker
 * must describe the WORK's status (`LIVE+verified`, which still matches on
 * `verified`) and never a running version.
 */
const SHIPPED_SECTION =
    /\b(verified|shipped|deployed|landed|merged|closed|done\b|complete)/i;

/**
 * A QUOTED SPAN CAN OPEN ON ONE LINE AND CLOSE ON THE NEXT, so quote state has
 * to be carried ACROSS lines. `[measured 2026-09-05]` the same instance:
 *
 *     line N     ... not the plain modal; "<pencil> mark
 *     line N+1   not done" undo CTA on a DONE session ...
 *
 * `not done` is the tail of a UI LABEL, not a claim about state. The second
 * line opens with a CLOSING quote and contains no opener, so a line-local check
 * mis-pairs it and matches anyway - which is the wrapped-prose trap inverted,
 * reporting PRESENCE with total confidence rather than absence.
 */
const QUOTE_CHARS = /["“”]/g;

/**
 * RULE 1, NARROW ON PURPOSE. Some headings assert openness STRUCTURALLY: every
 * row under `## Open PRs` claims its PR is open, with no stale-claim vocabulary
 * anywhere, so a lexical scan is blind to exactly the machine-generated blocks
 * a reader trusts most.
 *
 * `[measured 2026-09-05]` this repo's own trunk RESUME.md listed a PR as open
 * that had merged six minutes after that snapshot's HEAD time, two commits as
 * unpushed that were both ancestors of main, and 3 of 6 worktrees that no
 * longer existed.
 *
 * THE BROAD FORM WAS CENSUSED AND REJECTED. Across five repos - 557 prose
 * files, 81 headings that "sound open", 1,682 rows under them - matching any
 * such heading yielded 53 candidates, 37 with a resolved handle, and about
 * FOUR genuine after triage: roughly 8% precision. A detector at 8% gets muted,
 * which this fleet has already had to do once. Restricted to the three
 * machine-WRITTEN status headings below it yielded 6 candidates and 4 genuine,
 * about 67%, and all four sat in generated blocks rather than in prose.
 *
 * So this is an allowlist, not a heuristic, and it should stay one. Adding
 * "blocked" or "what is next" here is the change that re-introduces the 8%.
 */
const GENERATED_STATUS = /^\s*(open\s+prs?|unpushed(\s+commits)?|uncommitted(\s+changes)?)\s*$/i;

/**
 * Under those headings the row must carry an UNAMBIGUOUS handle. A bare `#N` in
 * prose is `UI-CONTRACT #1`, `fix #7`, `trap #1 above` - and PR #1 and #7 exist
 * in nearly every repo, so a bare number resolves as merged essentially always.
 * `[measured 2026-09-05]` that single mistake produced most of the broad form's
 * false positives. A plausible identifier is not a valid one.
 */
const STRICT_HANDLE =
    /\/pull\/\d{1,4}\b|\bPR\s+#\d{1,4}\b|\b[0-9a-f]{7,40}\b|\b[A-Z]\d+-[A-Z]{2,5}-\d+\b/;

/**
 * A row that reports its OWN resolution is an accurate record, not a stale
 * claim. `[measured 2026-09-05]` 18 of 37 handle-resolved rows were this:
 * a queue row naming a PR and saying it is **MERGED**, a struck-through item
 * marked DONE. Counting them measured whether the HANDLE had resolved rather
 * than whether the LINE claimed openness - a different question wearing the
 * same output.
 */
const SELF_RESOLVED =
    /~~|\b(done|merged|closed|fixed|shipped|landed|resolved|complete|is pushed|are pushed)\b/i;

function git(args, cwd) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return null; }
}

function trunkOf(cwd) {
    const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
    if (head) return head.trim();
    for (const c of ['origin/main', 'origin/master']) {
        if (git(['rev-parse', '--verify', c], cwd)) return c;
    }
    return null;
}

/**
 * @returns {{repo, trunk, population:object, findings:Array, note:string[]}}
 */
function checkDocStaleness(cwd, opts) {
    opts = opts || {};
    const ageDays = Number(opts.age || 7);
    const max = Number(opts.max || 12);
    const note = [];

    const trunk = trunkOf(cwd);
    if (!trunk) {
        return { repo: cwd, trunk: null, population: {}, findings: [],
            note: ['could not resolve a trunk; nothing scanned, which is NOT the same as nothing found'] };
    }

    let scanned = 0, missing = 0, lines = 0, dated = 0;
    let conditional = 0, decided = 0, resolved = 0;
    let quoted = 0, shipped = 0, structural = 0, structuralSeen = 0;
    let headings = 0;
    const findings = [];
    const structuralFindings = [];
    const now = Date.now();

    for (const doc of BOOT_DOCS) {
        // Read the TRACKED tree at the trunk. A working copy has as many current
        // values as there are checkouts, and worktree copies double-count.
        const body = git(['show', trunk + ':' + doc], cwd);
        if (body === null) { missing++; continue; }
        scanned++;
        const rows = body.split('\n');
        let section = '';
        let heading = '';
        // Quote state is carried ACROSS lines: a label can open on one row and
        // close on the next, and the closing row contains no opener at all.
        let openQuote = false;
        for (let i = 0; i < rows.length; i++) {
            const line = rows[i];
            const quotesBefore = openQuote;
            const qn = (line.match(QUOTE_CHARS) || []).length;
            if (qn % 2 === 1) openQuote = !openQuote;
            const sm = line.match(SECTION_RE);
            if (sm) {
                section = sm[1] || sm[2] || '';
                // Only a real `#` heading opens a structural block; a bold lead
                // is a paragraph marker and does not govern the rows after it.
                if (/^\s{0,3}#{1,6}\s/.test(line)) heading = section;
                openQuote = false;   // a heading cannot sit inside a quoted span
            }

            // ---- RULE 1 (narrow): the HEADING is the assertion ---------------
            // No vocabulary needed and no date required, because these rows are
            // machine-written and carry a handle by construction. This runs
            // BEFORE the lexical path so a generated row is classified once.
            if (GENERATED_STATUS.test(heading) && line.trim() && !sm) {
                structuralSeen++;
                if (STRICT_HANDLE.test(line) && !SELF_RESOLVED.test(line)) {
                    structural++;
                    structuralFindings.push({ doc, line: i + 1, section: heading,
                        text: line.trim().slice(0, 150) });
                }
                continue;
            }

            if (line.length < 20) continue;
            lines++;
            if (!OPEN_STATE.some((re) => re.test(line))) continue;
            // A match inside a span that was ALREADY open when this line began
            // is quoted text - a UI label, an error string - not a claim.
            if (quotesBefore) { quoted++; continue; }
            if (CONDITIONAL.test(line)) { conditional++; continue; }
            if (DECIDED.test(line) || DECIDED_SECTION.test(section)) { decided++; continue; }
            // AFTER `decided`, deliberately. `SHIPPED_SECTION` matches "closed",
            // and a section headed "Closed as NOT defects" is a DECISION, not
            // shipped work. Placed first, this rule silently stole that case
            // from the decided bucket and the suite caught it as a count moving
            // from 2 to 1 - which is the whole reason suppressions are counted
            // per rule rather than summed.
            if (SHIPPED_SECTION.test(section)) { shipped++; continue; }
            if (RESOLVED.test(line)) { resolved++; continue; }
            // Look for a date on the line or within the three above it, which is
            // where a `[measured YYYY-MM-DD]` tag usually sits.
            let m = null;
            for (let k = i; k >= Math.max(0, i - 3) && !m; k--) m = rows[k].match(DATE_RE);
            if (!m) continue;
            dated++;
            const when = Date.UTC(+m[1], +m[2] - 1, +m[3]);
            const age = Math.floor((now - when) / 86400000);
            if (age < ageDays) continue;
            if (sm) headings++;
            findings.push({ doc, line: i + 1, age, isHeading: !!sm, text: line.trim().slice(0, 150) });
        }
    }

    findings.sort((a, b) => b.age - a.age);
    return {
        repo: path.basename(cwd), trunk,
        population: { bootDocsLookedFor: BOOT_DOCS.length, present: scanned, absent: missing,
            linesConsidered: lines, suppressedAsConditional: conditional,
            suppressedAsDecided: decided, suppressedAsResolved: resolved,
            suppressedAsQuotedSpan: quoted, suppressedAsShippedSection: shipped,
            generatedStatusRowsSeen: structuralSeen, structuralFindings: structural,
            assertedInAHeading: headings,
            openStateAndDated: dated, olderThanAgeDays: findings.length },
        findings: findings.slice(0, max),
        structural: structuralFindings.slice(0, max), note,
    };
}

function render(r) {
    const out = [];
    out.push('  ' + r.repo + '  trunk=' + (r.trunk || 'UNRESOLVED'));
    const p = r.population;
    out.push('    population: ' + (p.present || 0) + ' of ' + (p.bootDocsLookedFor || 0)
        + ' boot docs present (' + (p.absent || 0) + ' absent), ' + (p.linesConsidered || 0)
        + ' lines considered, '
        + ((p.suppressedAsConditional || 0) + (p.suppressedAsDecided || 0) + (p.suppressedAsResolved || 0))
        + ' suppressed (' + (p.suppressedAsConditional || 0) + ' rules, ' + (p.suppressedAsDecided || 0)
        + ' decided, ' + (p.suppressedAsResolved || 0) + ' resolved), '
        + (p.openStateAndDated || 0) + ' open-state and dated, '
        + (p.olderThanAgeDays || 0) + ' older than the threshold');
    // The structural path is reported on its own line: it shares no counter with
    // the lexical one, and folding them would hide which rule found what.
    out.push('    structural: ' + (p.generatedStatusRowsSeen || 0)
        + ' rows under a generated status heading, ' + (p.structuralFindings || 0)
        + ' carrying a handle and not self-resolved'
        + '; suppressed ' + (p.suppressedAsQuotedSpan || 0) + ' inside a quoted span, '
        + (p.suppressedAsShippedSection || 0) + ' under a shipped section');
    for (const n of r.note) out.push('    NOTE: ' + n);
    if (!r.findings.length) { out.push('    nothing to re-check'); return out.join('\n'); }
    out.push('    RE-CHECK BEFORE TRUSTING (oldest first):');
    for (const f of r.findings) {
        out.push('      [' + String(f.age).padStart(4) + 'd] ' + f.doc + ':' + f.line
            + (f.isHeading ? '   <- ASSERTED IN A HEADING, longer half-life: readers trust structure' : ''));
        out.push('             ' + f.text);
    }
    return out.join('\n');
}

function selftest() {
    let pass = 0, fail = 0;
    const t = (l, ok, d) => { if (ok) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l + (d ? '  (' + d + ')' : '')); } };

    // The real sentence that motivated this file. If the patterns stop matching
    // it, the tool has lost the only instance it is known to catch.
    const REAL = 'No real delivery has arrived since, so the fix is unproven.';
    t('the motivating sentence matches', OPEN_STATE.some((re) => re.test(REAL)), REAL);

    t('"remains open" matches', OPEN_STATE.some((re) => re.test('This remains open until someone checks.')));
    t('"blocked on" matches', OPEN_STATE.some((re) => re.test('The email send is blocked on the provider.')));
    t('"never ran" matches', OPEN_STATE.some((re) => re.test('The gate never ran on that branch.')));
    t('"not yet configured" matches', OPEN_STATE.some((re) => re.test('Transactional email is not yet configured.')));

    // A MECHANISM claim must NOT match. Mechanisms do not rot; sweeping them is
    // how a detector reaches 683 items and gets muted.
    t('a mechanism claim does NOT match',
        !OPEN_STATE.some((re) => re.test('A 42703 means the column does not exist in that schema.')),
        'mechanism claims do not decay and must stay out');
    t('a plain measurement does NOT match',
        !OPEN_STATE.some((re) => re.test('Measured 2026-09-01: 1,932 completed audits, 1,872 scoreable.')));

    // The two real false positives from this tool's own first run.
    const rule1 = 'is not done until the family is appended to state/qa/patterns.json as ONE';
    const rule2 = 'THE FIX IS NOT DONE UNTIL THE FAMILY IS EMPTY. Ten instances on 2026-07-26';
    t('a conditional RULE is suppressed, not reported',
        OPEN_STATE.some((re) => re.test(rule1)) && CONDITIONAL.test(rule1),
        'it must match OPEN_STATE yet be suppressed, or the suppressor is untested');
    t('the second real false positive is suppressed too',
        OPEN_STATE.some((re) => re.test(rule2)) && CONDITIONAL.test(rule2));
    t('the motivating sentence is NOT suppressed', !CONDITIONAL.test(REAL),
        'suppressing the one instance it exists to catch would make it vacuous');

    // The real false positives from the first fleet run, verbatim.
    const decidedLine = '### One thing deliberately NOT fixed';
    const decidedSect = '**Closed as NOT defects - recorded so they are not re-opened:**';
    const inSection = 'AUTO_CRITIC recalibration (blocked on scores not persisting since 07-30);';
    const resolvedLine = 'The row above used to say MERGEABLE and blocked on reverting a depth effect;';
    const stillOpen = '> **Still open:** 953 dead census keys (prune PER NAMESPACE, never bulk).';
    const ownerBlocked = '(release still blocked on Andy: Play Console + Firebase - see the note below).';

    t('a deliberate NOT-fixed line is suppressed',
        OPEN_STATE.some((re) => re.test(decidedLine)) && DECIDED.test(decidedLine),
        'it must match open-state and then be suppressed, or the suppressor is untested');
    t('a decided SECTION heading is recognised as one', DECIDED_SECTION.test(decidedSect));
    t('a claim inside that section carries no marker of its own',
        !DECIDED.test(inSection),
        'this is why section tracking exists rather than a wider line regex');
    t('the section heading parses as a section', SECTION_RE.test(decidedSect));
    t('a past-tense claim is suppressed as resolved', RESOLVED.test(resolvedLine));

    // The two REAL open claims must survive every suppressor, or the pass
    // bought precision by deleting the output.
    t('a genuinely open claim survives all three suppressors',
        OPEN_STATE.some((re) => re.test(stillOpen))
        && !CONDITIONAL.test(stillOpen) && !DECIDED.test(stillOpen) && !RESOLVED.test(stillOpen));
    t('an owner-blocked claim survives too',
        OPEN_STATE.some((re) => re.test(ownerBlocked))
        && !CONDITIONAL.test(ownerBlocked) && !DECIDED.test(ownerBlocked) && !RESOLVED.test(ownerBlocked));
    t('the motivating sentence survives all three',
        !CONDITIONAL.test(REAL) && !DECIDED.test(REAL) && !RESOLVED.test(REAL),
        'suppressing the one instance it exists to catch would make it vacuous');

    // A heading or bold lead asserting state, which is the high-precision subset.
    t('a bold lead asserting state parses as a section',
        SECTION_RE.test('> **Still open:** 953 dead census keys (prune PER NAMESPACE).'),
        'the live instance is a bold lead inside a blockquote, not a markdown heading');
    t('a markdown heading asserting state parses too', SECTION_RE.test('## Still broken on staging'));
    t('an ordinary sentence does NOT parse as a section',
        !SECTION_RE.test('The nightly export is still broken on the staging tier.'));

    t('a date is required, so an undated claim is not reported', DATE_RE.test('[measured 2026-08-21]'));
    t('a non-date number is not read as a date', !DATE_RE.test('port 8080 and 5173'));

    console.log('\nselftest: ' + pass + ' passed, ' + fail + ' failed');
    return fail === 0;
}

module.exports = { checkDocStaleness, OPEN_STATE, CONDITIONAL, DECIDED, DECIDED_SECTION,
    RESOLVED, SECTION_RE, BOOT_DOCS, render };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
    if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
    if (argv.includes('--help') || !arg('--repo')) {
        console.log('check-doc-staleness.js --repo <path> [--age 7] [--max 12] [--json]\n'
            + 'Re-check the open-state claims in the documents a Brain reads at boot.\n'
            + 'Reports; never decides. Always exits 0.');
        process.exit(0);
    }
    const r = checkDocStaleness(arg('--repo'), { age: arg('--age'), max: arg('--max') });
    console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
    process.exit(0);
}
