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
 *   - only the documents a Brain actually reads at boot, about eight per repo,
 *     and it NAMES the kin documents it declined rather than implying eight is
 *     the whole corpus
 *   - the TRACKED tree at the trunk is the population, so worktree copies
 *     cannot double-count; the working copy is read too, but only to say which
 *     findings a session has already fixed and not yet merged
 *   - only claims asserting an OPEN state, which are the ones that decay
 *     silently, plus PR handles a line calls open, which name their own probe
 *   - ranked by age, capped, and it prints the population it scanned WITH its
 *     denominator, because a numerator alone cannot tell a corpus that was read
 *     from one that was half read
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
const fs = require('fs');
const path = require('path');

/** The documents a Brain reads at boot and then acts on. Not the whole repo. */
const BOOT_DOCS = [
    'RESUME.md', 'CLAUDE.md', 'AGENTS.md', 'ROADMAP.md',
    'PUBLISH-QUEUE.md', 'DECISIONS.md', 'GAME.md', 'PLAN.md',
];

/**
 * A KIN DOCUMENT carries a boot document's name with a suffix -
 * `DECISIONS-2026-09-07.md`, `PLAN-SITE-V2.md`. BOOT_DOCS is an allowlist, so
 * the tool declines these in silence, and its population line then reports
 * "6 of 8 boot docs present" over a repo whose Brain-read corpus is larger
 * than eight documents. That reads as 75% coverage of a corpus it never
 * measured.
 *
 * `[measured 2026-09-07]` censused across the five trunks this tool runs
 * against: **11 kin documents**, spread 0 / 0 / 3 / 5 / 3, and they are not
 * marginal. In one product a `PLAN-*.md` is named inside the very RESUME.md
 * the tool DOES read, as "the partner's brief", beside a `*-LEDGER.md`
 * described as "the record"; two other products each carry three dated
 * `DECISIONS-*.md` siblings, which is where the last week of decisions lives
 * while `DECISIONS.md` holds the older ones.
 *
 * DELIBERATELY NOT SCANNED, only NAMED. Reading them would be a different
 * tool: this one is small because it reads about eight documents, and the
 * 683-item sweep it exists to replace is what happens when that stops being
 * true. Naming the gap costs one line and lets a reader tell a clean corpus
 * from a half-read one, which is the entire complaint. Widening the scan is a
 * decision with a precision census attached, and this is not that change.
 *
 * WHY KIN AND NOT EVERY ROOT DOCUMENT. The same census over all root markdown
 * gives autodev 4 unexamined documents totalling 6,873 lines - of which 6,283
 * are `CHANGELOG.md`, which no Brain reads at boot and which would put
 * autodev's "coverage" at 5%. A denominator that wrong is worse than none: it
 * manufactures alarm rather than reporting a gap. Kin is the narrow signal,
 * and it is the one that names documents a Brain demonstrably reads.
 */
const BOOT_STEMS = BOOT_DOCS.map((d) => d.replace(/\.md$/i, ''));
const KIN_DOC = new RegExp('^(' + BOOT_STEMS.join('|') + ')[-_.].+\\.md$', 'i');

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
 *
 * `done` IS ABSENT FOR A SHARPER REASON: it matched its own negation. A census
 * of every token in this pattern across five repos' boot documents asked which
 * token was the SOLE reason a section suppressed, since that is where `live`
 * went wrong. `done` was the sole matcher twice and BOTH were negations:
 *
 *     ## NOT done - these are redesigns, not fixes, and need direction:
 *     ## Deliberately NOT done, with reasons:
 *
 * A section headed "NOT done" is the opposite of a shipped record, and the rule
 * suppressed everything under it. With the negation guard below, `done` would
 * suppress nothing at all in that corpus, so it earns no place.
 *
 * `closed` STAYS, with its one imperfect case recorded rather than hidden. It
 * was the sole matcher six times: five are real closures, and one is a version
 * note reading `(dead end closed)` whose parenthetical suppressed a line saying
 * "PRE-EXISTING ... NOT fixed". Removing it would un-suppress five legitimate
 * closures to fix one, which makes the tool noisier - and noise is what gets a
 * detector muted. Stated as a known cost, not resolved.
 */
const SHIPPED_SECTION =
    /\b(verified|shipped|deployed|landed|merged|closed|complete)/i;

/**
 * A NEGATED MARKER IS NOT A MARKER. "NOT done", "not shipped", "never merged"
 * are open claims wearing a shipped word, and a section heading is exactly
 * where that phrasing lives. Vetoes the suppression rather than narrowing the
 * pattern, so it protects every token at once instead of one at a time.
 *
 * THIS OVERLAPS WITH REMOVING `done`, DELIBERATELY, AND THE MUTATION SAYS SO.
 * Re-admitting `done` to the pattern above SURVIVES the suite, because this
 * veto already catches both of its census cases. That mutant is recorded as a
 * survivor rather than tuned away: it is not a defect, it is two changes whose
 * effects coincide on the corpus we have. Each earns its place on its own
 * terms - the veto is general and tested, and `done` suppressed nothing
 * legitimate in five repos, so a token that can only misfire is not worth
 * carrying whatever the veto does.
 *
 * The veto needed a section whose marker IS in the pattern before it could be
 * tested at all. With `done` gone, `## NOT done ...` never matches
 * SHIPPED_SECTION, so the veto is never consulted and two mutants survived
 * against it. `## NOT shipped to the store yet` is the case that exercises it.
 */
const NEGATED_MARKER =
    /\b(not|never|n't)\s+(yet\s+)?(verified|shipped|deployed|landed|merged|closed|done|complete)/i;

/**
 * AN AUTHOR'S EXPLICIT CARVE-OUT OUTRANKS A SECTION-LEVEL SHIPPED MARKER.
 *
 * `[measured 2026-09-06]` This resolves the known cost recorded above for
 * `closed`. The instance: a version-note heading ending `(dead end closed)`
 * suppressed a line reading
 * `PRE-EXISTING, not introduced here, NOT fixed: ...`. The section carries no
 * negation, so NEGATED_MARKER cannot see it; the parenthetical describes a
 * DIFFERENT thing that closed, and the line is the author saying this one
 * survived the shipped work.
 *
 * Deliberately narrow: each phrase is a writer marking an exception, not merely
 * another way of stating open state. OPEN_STATE has already matched by the time
 * this is consulted, so a wide pattern here would simply disable the
 * shipped-section rule.
 *
 * CENSUSED BEFORE IT WAS WRITTEN, on the five trunks this tool runs against:
 * SHIPPED_SECTION suppresses **6** lines in total, and **exactly one** carries
 * a carve-out - the instance above. So this un-suppresses one line and leaves
 * the other five suppressions untouched.
 *
 * That census also corrects a number in the comment above. `closed` suppresses
 * **5**, not the 6 recorded there: the earlier count did not replicate the
 * scan's ordering, in which DECIDED runs first, so `Closed as NOT defects` was
 * counted against `closed` when the running code attributes it to `decided`.
 * Measuring "would this pattern match" is not measuring "does this rule
 * suppress", and only the second one is the rule's behaviour.
 *
 * Placed AFTER the decided check, not before it. A decision not to act governs
 * its section whatever a line says; this only overrides SHIPPED.
 */
const LINE_CARVEOUT =
    /\b(pre-existing|preexisting|not introduced here|NOT fixed|still not fixed|unrelated to this|survives this|out of scope here)\b/i;

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

/**
 * A LINE THAT NAMES A PR AND CALLS IT OPEN. This is the false negative that
 * motivated the second half of this file's rewrite.
 *
 * `[measured 2026-09-07]` one product's `RESUME.md:32`, on the trunk, read:
 *
 *     Phases 6 and 7 are PR #47, open at f6d1e67, gate green
 *
 * `gh pr view 47` -> MERGED three days earlier, and the head sha is not the
 * one named: f6d1e67 is a branch tip from four minutes before it. The tool
 * reported `nothing to re-check` over that document, and a coordinator ranked
 * the repo's documents clean on the strength of that run.
 *
 * NOT ONE OF THE OPEN_STATE PATTERNS MATCHES IT, and no suppressor was
 * involved - checked directly rather than assumed, because the standing
 * hypothesis was that a suppression rule had eaten it. `OPEN_STATE` scores
 * zero on that line; `CONDITIONAL`, `DECIDED` and `RESOLVED` are all false.
 * The lexical vocabulary is built around "unproven" and "still broken", and
 * the commonest open-state claim in these documents is none of those: it is a
 * PR number with the word `open` next to it.
 *
 * WHY THIS IS SAFE TO ADD WHEN `## Open PRs` HAD TO BE AN ALLOWLIST. The
 * structural rule could not use a heading that merely SOUNDS open, because a
 * heading governs every row beneath it and the census put that at ~8%. This
 * rule is line-local and demands a HANDLE on the same line, so it reports only
 * claims that NAME THEIR OWN REFUTATION - one `gh pr view` settles each one.
 *
 * CENSUSED BEFORE ADOPTION, on the same five trunks. The first draft also
 * accepted `pending` and `awaiting` and matched 6 lines, of which 3 were
 * false - and two of those were NEGATIONS, `**Prod is serving ... NO prod tag
 * is pending**`, which is the shape that says the opposite. Restricted to
 * `open`/`unmerged`, with the negation veto below, it matches 3 lines:
 *
 *     product A  RESUME.md:32         PR #47   -> MERGED, 3 days earlier
 *     product B  RESUME.md:166        PR #610  -> MERGED, 9 days earlier
 *     product B  PUBLISH-QUEUE.md:367 PR #507  -> MERGED, 15 days earlier
 *
 * **3 of 3 genuine**, each verified with `gh`. Two of them are in a repo
 * nobody had flagged. Compare the structural rule's 4-of-6 at adoption.
 *
 * NO DATE IS REQUIRED, like the structural path and unlike the lexical one. A
 * PR handle is checkable whatever its age, so an age threshold would only
 * discard findings that are already refutable in one call - and these carry no
 * date on the line in two of the three instances above.
 */
const HANDLE_OPEN_HANDLE = /\/pull\/(\d{1,4})\b|\bPR\s+#(\d{1,4})\b/;
const HANDLE_OPEN_ASSERT =
    /\b(is|are|remains?|stays?|still)\s+(still\s+)?(open|unmerged)\b|\bopen\s+at\b|\bstill\s+open\b/i;

/**
 * `NO prod tag is pending` and `NO PR #88 is open` assert the ABSENCE of open
 * work, in the exact grammar of asserting its presence. Both false positives
 * the census threw up were this sentence, in two snapshots of one RESUME.md.
 *
 * THE SUBJECT IS A NOUN PHRASE, NOT A WORD, and the first version of this
 * pattern allowed exactly one token between `no` and the verb. It therefore
 * failed to match `NO prod tag is pending` - the sentence it was written for -
 * and vetoed nothing at all. It read as a working veto for as long as no test
 * drove a line through it, and the fleet census agreed, because the census
 * counted how often it fired rather than whether it could.
 *
 * Caught by mutation: deleting the veto entirely left the suite green.
 */
const HANDLE_OPEN_NEGATED = /\bno\s+(?:[\w#.-]+\s+){0,3}(?:is|are)\b/i;

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
 * Scan ONE tree. Factored out so the trunk and the working copy go through
 * byte-identical logic: a classification that compared two DIFFERENT scanners
 * would report differences the documents do not have.
 *
 * @param {(doc:string)=>(string|null)} readDoc
 * @returns {{findings:Array, structural:Array, counts:object, present:number,
 *            absent:number, linesPresent:number}}
 */
function scanTree(readDoc, ageDays, now) {
    let scanned = 0, missing = 0, lines = 0, dated = 0, linesPresent = 0;
    let conditional = 0, decided = 0, resolved = 0;
    let quoted = 0, shipped = 0, structural = 0, structuralSeen = 0;
    let headings = 0, handleOpen = 0;
    const findings = [];
    const structuralFindings = [];

    for (const doc of BOOT_DOCS) {
        const body = readDoc(doc);
        if (body === null) { missing++; continue; }
        scanned++;
        const rows = body.split('\n');
        // The DENOMINATOR for the lines actually considered. Without it the
        // report prints a numerator alone, and a numerator alone cannot tell a
        // corpus that was read from one that was half read.
        linesPresent += rows.length;
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
                        text: line.trim().slice(0, 150), kind: 'generated-status' });
                }
                continue;
            }

            if (line.length < 20) continue;
            lines++;

            // ---- RULE 2 (narrow): a PR handle CALLED OPEN --------------------
            // Runs before the lexical path and needs no date: the handle is the
            // probe, so one `gh pr view` settles it whatever its age. Placed
            // here rather than inside OPEN_STATE because it must not inherit
            // the date requirement, and because a suppressor tuned for prose
            // has no business vetoing a machine-checkable identifier.
            const ho = line.match(HANDLE_OPEN_HANDLE);
            if (ho && HANDLE_OPEN_ASSERT.test(line)
                && !HANDLE_OPEN_NEGATED.test(line)
                && !SELF_RESOLVED.test(line) && !quotesBefore) {
                handleOpen++;
                structuralFindings.push({ doc, line: i + 1, section: heading,
                    text: line.trim().slice(0, 150), kind: 'handle-open',
                    handle: 'PR #' + (ho[1] || ho[2]) });
                continue;
            }

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
            if (SHIPPED_SECTION.test(section) && !NEGATED_MARKER.test(section)
                && !LINE_CARVEOUT.test(line)) { shipped++; continue; }
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
        findings, structural: structuralFindings, present: scanned, absent: missing,
        linesPresent,
        counts: { lines, dated, conditional, decided, resolved, quoted, shipped,
            structural, structuralSeen, headings, handleOpen },
    };
}

/**
 * The documents a Brain reads that this tool DECLINES to open, named so the
 * gap is visible rather than inferable. See KIN_DOC.
 */
function kinDocs(cwd, trunk) {
    const listing = git(['ls-tree', '--name-only', trunk], cwd);
    if (listing === null) return [];
    return listing.split('\n')
        .filter((f) => f && !BOOT_DOCS.includes(f) && KIN_DOC.test(f))
        .sort();
}

/**
 * WHICH TREE ANSWERED, AND WHY THE REPORT HAS TO SAY SO.
 *
 * `[measured 2026-09-07]` this tool read `git show <trunk>:<doc>` and nothing
 * else, so a session that FIXED a stale claim, opened a PR and re-ran the
 * sweep saw all four of its findings reported back verbatim. That reads as
 * "my fix failed". It means "not merged yet", and the output could not tell
 * the two apart. Another session hit this for real and had to work out on its
 * own that a repeated finding was not a failed fix.
 *
 * Reading the working copy INSTEAD would be the same defect mirrored: a Brain
 * at boot wants the trunk, because the trunk is what every other session and
 * every reader of the repo will see. So the fix is neither tree - it is
 * reading BOTH and saying which one each claim survives in:
 *
 *   open           at the trunk AND in the working copy -> genuinely stale
 *   fixed-locally  at the trunk, GONE from the working copy -> unmerged fix
 *   local-only     only in the working copy -> a claim not yet pushed
 *
 * THE POPULATION STAYS TRUNK-BASED, which preserves the invariant the original
 * trunk-only design was protecting: "a working copy has as many current values
 * as there are checkouts, and worktree copies double-count." That concern is
 * about a FLEET SWEEP counting one document once per checkout. It does not
 * apply here, because the working copy is used only to CLASSIFY the trunk's
 * findings inside a single repo path - it never contributes a count.
 *
 * @returns {{repo, trunk, source, population:object, findings:Array,
 *            structural:Array, note:string[]}}
 */
function checkDocStaleness(cwd, opts) {
    opts = opts || {};
    const ageDays = Number(opts.age || 7);
    const max = Number(opts.max || 12);
    const source = opts.source || 'both';
    const note = [];

    const trunk = trunkOf(cwd);
    if (!trunk) {
        return { repo: path.basename(cwd), trunk: null, source, population: {},
            findings: [], structural: [], localOnly: [],
            note: ['could not resolve a trunk; nothing scanned, which is NOT the same as nothing found'] };
    }

    const now = Date.now();
    const readTrunk = (doc) => git(['show', trunk + ':' + doc], cwd);
    const readWorktree = (doc) => {
        try { return fs.readFileSync(path.join(cwd, doc), 'utf8'); }
        catch (e) { return null; }
    };

    /**
     * Does the checked-out HEAD carry ANY commit the trunk does not?
     *
     * ⚠️ WITHOUT THIS, "you are about to ship these" IS ASSERTED ABOUT TREES THAT CANNOT SHIP
     * ANYTHING. The local-only set is a pure content diff: a claim the working copy has and the
     * trunk does not. That difference has two causes and they are opposites —
     *   AHEAD   the tree carries new work, and the claim really is about to ship
     *   BEHIND  the tree is an OLD checkout, and the claim is history the trunk already
     *           superseded; nothing can ship from it because it has nothing the trunk lacks
     * and the content diff alone cannot tell them apart. Measured 2026-09-11 in a consuming repo: the
     * main checkout sat on a branch 361 commits BEHIND origin/main and 0 ahead (merge-base ==
     * HEAD), so two RESUME.md claims the trunk had already fixed on 2026-09-07 were reported as
     * unshipped work. Two sessions then spent effort re-fixing lines that were already correct.
     *
     * ⚠️ AHEAD-COUNT ALONE IS NOT THE DISCRIMINATOR, and the suite caught that draft. A tree
     * LEVEL with the trunk (0 ahead) but carrying UNCOMMITTED edits is the original, legitimate
     * "about to ship" case — that is precisely a session writing a claim it has not committed.
     * So the question is per-document and has two parts:
     *   the doc is DIRTY (working copy differs from HEAD)  -> genuinely local work, about to ship
     *   the doc is CLEAN and the tree is BEHIND the trunk   -> the difference is HEAD vs trunk,
     *                                                          i.e. an old checkout: stale
     * Reachability is the question, never a branch-name or content comparison — the same
     * distinction as `git rev-list <head> --not --remotes` for "is this work pushed".
     * Fails OPEN: if git cannot answer, keep the old louder behaviour rather than silently
     * dropping findings, and say the guard did not run.
     */
    /** Documents whose working copy differs from HEAD — genuinely uncommitted local work. */
    const dirtyDocs = () => {
        try {
            const out = execFileSync('git', ['status', '--porcelain', '--'].concat(BOOT_DOCS),
                { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
            return new Set(out.split('\n').filter(Boolean)
                .map((l) => l.slice(3).trim()).filter(Boolean));
        } catch (e) { return null; }
    };

    const aheadOfTrunk = () => {
        try {
            const out = execFileSync('git', ['rev-list', '--count', 'HEAD', '--not', trunk],
                { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            const n = Number(out);
            return Number.isFinite(n) ? { known: true, ahead: n } : { known: false, ahead: null };
        } catch (e) { return { known: false, ahead: null }; }
    };

    // `worktree` grades the working copy alone and reports it as the population,
    // for a session that wants to check what it is ABOUT to commit.
    const base = source === 'worktree'
        ? scanTree(readWorktree, ageDays, now)
        : scanTree(readTrunk, ageDays, now);

    let compared = null;
    let comparedLabel = null;
    if (source === 'both') {
        // A repo with no checked-out working copy - a bare clone, or a path
        // whose documents live only in git - yields nothing to compare, and
        // saying so is better than silently grading one tree and implying two.
        const anyOnDisk = BOOT_DOCS.some((d) => readWorktree(d) !== null);
        if (anyOnDisk) {
            compared = scanTree(readWorktree, ageDays, now);
            comparedLabel = 'working copy';
        } else {
            note.push('no working copy on disk, so every finding is reported at the trunk only');
        }
    }

    // Classify by TEXT rather than by line number: a fix elsewhere in the file
    // shifts every line below it, and matching on position would report the
    // whole tail of a document as newly fixed.
    const key = (f) => f.doc + ' ' + f.text;
    const label = (list, otherList, both, only) => {
        const other = new Set((otherList || []).map(key));
        for (const f of list) f.state = otherList ? (other.has(key(f)) ? both : only) : 'unclassified';
        return list;
    };

    label(base.findings, compared && compared.findings, 'open', 'fixed-locally');
    label(base.structural, compared && compared.structural, 'open', 'fixed-locally');

    // A claim the working copy has and the trunk does not is one this session
    // is about to ship. Reported separately so it cannot be mistaken for a
    // trunk finding, which is the confusion this whole change exists to end.
    const localOnly = [];
    const ahead = compared ? aheadOfTrunk() : { known: false, ahead: null };
    const dirty = compared ? dirtyDocs() : null;
    /* A CLEAN document in a tree that is BEHIND the trunk cannot ship anything: its difference
       from the trunk is the trunk's own later work, i.e. history this checkout has not caught up
       to. Classify it rather than drop it — a stale checkout is worth saying out loud, since it
       is why the same claims keep being re-reported — but never print it as work about to land.
       A DIRTY document is uncommitted work and stays "about to ship" however the tree sits. */
    const behind = ahead.known && ahead.ahead === 0;
    const stateFor = (f) => (behind && dirty && !dirty.has(f.doc) ? 'stale-checkout' : 'local-only');
    if (compared) {
        const atTrunk = new Set(base.findings.map(key));
        const atTrunkS = new Set(base.structural.map(key));
        for (const f of compared.findings) if (!atTrunk.has(key(f))) { f.state = stateFor(f); localOnly.push(f); }
        for (const f of compared.structural) if (!atTrunkS.has(key(f))) { f.state = stateFor(f); localOnly.push(f); }
    }
    const staleCheckout = localOnly.length > 0 && localOnly.every((f) => f.state === 'stale-checkout');

    const c = base.counts;
    const kin = kinDocs(cwd, trunk);
    const fixedLocally = base.findings.filter((f) => f.state === 'fixed-locally').length
        + base.structural.filter((f) => f.state === 'fixed-locally').length;

    return {
        repo: path.basename(cwd), trunk, source,
        comparedAgainst: comparedLabel,
        population: {
            bootDocsLookedFor: BOOT_DOCS.length, present: base.present, absent: base.absent,
            // NUMERATOR AND DENOMINATOR TOGETHER. `linesConsidered` alone was
            // printable over a corpus it had half read.
            linesConsidered: c.lines, linesPresent: base.linesPresent,
            kinDocsNotExamined: kin.length,
            kinDocNames: kin,
            suppressedAsConditional: c.conditional,
            suppressedAsDecided: c.decided, suppressedAsResolved: c.resolved,
            suppressedAsQuotedSpan: c.quoted, suppressedAsShippedSection: c.shipped,
            generatedStatusRowsSeen: c.structuralSeen, structuralFindings: c.structural,
            handleCalledOpen: c.handleOpen,
            assertedInAHeading: c.headings,
            openStateAndDated: c.dated, olderThanAgeDays: base.findings.length,
            fixedLocallyNotMerged: fixedLocally,
            localOnly: localOnly.length,
            staleCheckout,
            aheadOfTrunkKnown: ahead.known,
            aheadOfTrunk: ahead.ahead,
        },
        findings: base.findings.slice(0, max),
        structural: base.structural.slice(0, max),
        localOnly: localOnly.slice(0, max),
        note,
    };
}

/**
 * ABSENCE MUST NOT PRINT AS HEALTH.
 *
 * `[measured 2026-09-07]` the run this rewrite exists for, on qr:
 *
 *     population: 6 of 8 boot docs present, 3307 lines considered, 3 suppressed
 *     nothing to re-check
 *
 * Three separate things are wrong with those two lines and only the third is
 * about a missing finding:
 *
 *  1. `3307 lines considered` has NO DENOMINATOR. The six documents hold 4,179
 *     lines, so 872 were skipped by the length filter. A reader cannot tell
 *     that from the output, and a clean corpus and a half-read one print the
 *     same sentence.
 *  2. The corpus itself is larger than the eight names. qr carries five KIN
 *     documents the tool declined in silence, one of which - PLAN-SITE-V2.md -
 *     the scanned RESUME.md names as the partner's brief.
 *  3. `nothing to re-check` is a VERDICT with no basis attached. It is the
 *     exact sentence this repo's rules call out: a verdict emitted before the
 *     work, saying the same thing whether the corpus was read or was empty.
 *
 * A RATIO ALARM ON (1) WAS MEASURED AND REJECTED, and the measurement is the
 * reason. Line coverage across the five trunks is 73.7% / 69.6% / 84.1% /
 * 79.0% / 75.7% - a band about fourteen points wide, because it is a property
 * of markdown having blank lines, not a property of any repo. Any threshold
 * inside that band fires everywhere or nowhere, which is a light that is
 * always on. So the denominator is PRINTED, and the loud line is keyed to the
 * kin count instead, which ranges 0 to 5 across the same five repos and names
 * documents a reader can go and open.
 */
function render(r) {
    const out = [];
    const p = r.population;
    // WHICH TREE ANSWERED, on the header line, before any finding. A reader who
    // sees their own in-flight fix reported back needs this in the first line
    // they read, not inferable from a flag they did not pass.
    const read = r.source === 'worktree' ? 'working copy'
        : (r.comparedAgainst ? 'trunk ' + r.trunk + ', compared against the ' + r.comparedAgainst
            : 'trunk ' + r.trunk + ' only');
    out.push('  ' + r.repo + '  trunk=' + (r.trunk || 'UNRESOLVED') + '  read=' + read);
    if (!r.trunk) { for (const n of r.note) out.push('    NOTE: ' + n); return out.join('\n'); }

    const pct = p.linesPresent ? Math.round(100 * (p.linesConsidered || 0) / p.linesPresent) : 0;
    out.push('    population: ' + (p.present || 0) + ' of ' + (p.bootDocsLookedFor || 0)
        + ' boot docs present (' + (p.absent || 0) + ' absent), ' + (p.linesConsidered || 0)
        + ' of ' + (p.linesPresent || 0) + ' lines considered (' + pct + '%), '
        + ((p.suppressedAsConditional || 0) + (p.suppressedAsDecided || 0) + (p.suppressedAsResolved || 0))
        + ' suppressed (' + (p.suppressedAsConditional || 0) + ' rules, ' + (p.suppressedAsDecided || 0)
        + ' decided, ' + (p.suppressedAsResolved || 0) + ' resolved), '
        + (p.openStateAndDated || 0) + ' open-state and dated, '
        + (p.olderThanAgeDays || 0) + ' older than the threshold');
    // The structural path is reported on its own line: it shares no counter with
    // the lexical one, and folding them would hide which rule found what.
    out.push('    structural: ' + (p.generatedStatusRowsSeen || 0)
        + ' rows under a generated status heading, ' + (p.structuralFindings || 0)
        + ' carrying a handle and not self-resolved; ' + (p.handleCalledOpen || 0)
        + (p.handleCalledOpen === 1 ? ' line calls' : ' lines call') + ' a PR handle open'
        + '; suppressed ' + (p.suppressedAsQuotedSpan || 0) + ' inside a quoted span, '
        + (p.suppressedAsShippedSection || 0) + ' under a shipped section');

    // THE LOUD LINE. Not an inference the reader has to draw from two numbers.
    if (p.kinDocsNotExamined) {
        out.push('    NOT A WHOLE-CORPUS READ: ' + p.kinDocsNotExamined
            + ' document(s) carry a boot-doc name and were NOT examined: '
            + (p.kinDocNames || []).slice(0, 6).join(', ')
            + ((p.kinDocNames || []).length > 6 ? ', ...' : ''));
    }
    for (const n of r.note) out.push('    NOTE: ' + n);

    const total = (r.findings || []).length + (r.structural || []).length;
    if (!total) {
        // The basis travels WITH the all-clear, in the same sentence, so the
        // absence cannot be quoted onward without it.
        out.push('    nothing to re-check in ' + (p.linesConsidered || 0) + ' lines across '
            + (p.present || 0) + ' document(s)'
            + (p.kinDocsNotExamined ? ' - but see the unexamined documents above' : ''));
    } else {
        out.push('    RE-CHECK BEFORE TRUSTING (oldest first):');
        for (const f of r.findings) {
            out.push('      [' + String(f.age).padStart(4) + 'd] ' + f.doc + ':' + f.line
                + mark(f)
                + (f.isHeading ? '   <- ASSERTED IN A HEADING, longer half-life: readers trust structure' : ''));
            out.push('             ' + f.text);
        }
        for (const f of r.structural) {
            out.push('      [handle] ' + f.doc + ':' + f.line + mark(f)
                + (f.kind === 'handle-open'
                    ? '   <- CALLS ' + f.handle + ' OPEN; one `gh pr view` settles it'
                    : '   <- under `' + f.section + '`'));
            out.push('             ' + f.text);
        }
    }
    if ((r.localOnly || []).length) {
        /* The same content diff means opposite things depending on whether the checked-out tree
           is ahead of the trunk or behind it, so the heading must say which was measured — and
           must not say "about to ship" about a tree that has nothing to ship. */
        const p = r.population || {};
        const mixedStates = new Set(r.localOnly.map((f) => f.state)).size > 1;
        if (mixedStates) {
            out.push('    NOT AT THE TRUNK: mixed stale checkout history and local work; each row is classified below:');
        } else if (r.localOnly.every((f) => f.state === 'stale-checkout')) {
            out.push('    NOT AT THE TRUNK, and this checkout is BEHIND it (0 commits the trunk lacks)'
                + ' — these are STALE, already superseded on the trunk, and nothing here can ship:');
        } else if (p.aheadOfTrunkKnown === false) {
            out.push('    NOT AT THE TRUNK, only in the working copy (could NOT determine whether this'
                + ' checkout is ahead of the trunk, so this may be stale rather than unshipped):');
        } else {
            out.push('    NOT AT THE TRUNK, only in the working copy (you are about to ship these'
                + (p.aheadOfTrunk ? ' — ' + p.aheadOfTrunk + ' commit(s) ahead of the trunk' : '') + '):');
        }
        for (const f of r.localOnly) out.push('      ' + (mixedStates ? '[' + f.state + '] ' : '')
            + f.doc + ':' + f.line + '  ' + f.text);
    }
    return out.join('\n');
}

/**
 * The three-state label. `fixed-locally` is the whole point of reading two
 * trees: without it a session re-running the sweep over its own in-flight fix
 * reads its findings back verbatim and concludes the fix failed.
 */
function mark(f) {
    if (f.state === 'fixed-locally') return '   [FIXED LOCALLY, NOT MERGED]';
    if (f.state === 'local-only') return '   [LOCAL ONLY, not at the trunk]';
    return '';
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

    // ---- RULE 2: a PR handle a line calls OPEN ----------------------------
    //
    // The verbatim line the tool returned `nothing to re-check` over. PR #47
    // merged 2026-09-04T07:28:48Z; the sha named is not even the head.
    const QR = 'on main (#44 to #46). Phases 6 and 7 are PR #47, open at f6d1e67, gate green';
    const openOn = (l) => HANDLE_OPEN_HANDLE.test(l) && HANDLE_OPEN_ASSERT.test(l)
        && !HANDLE_OPEN_NEGATED.test(l) && !SELF_RESOLVED.test(l);
    t('the qr false negative matches the handle-open rule', openOn(QR), QR);
    t('  and it matches NONE of the lexical open-state patterns',
        !OPEN_STATE.some((re) => re.test(QR)),
        'the standing hypothesis was a suppressor ate it; the vocabulary never saw it');
    t('  and no suppressor was involved either',
        !CONDITIONAL.test(QR) && !DECIDED.test(QR) && !RESOLVED.test(QR));
    t('"PR #610 is open and unmerged" matches',
        openOn('Nothing unpushed. **PR #610 is open and unmerged.** The cron in it does not run'));
    t('a pull URL row saying Still open matches',
        openOn('| [#507](https://github.com/o/r/pull/507) | Still open - now verifiable via the harness |'));

    // The three false positives the first draft produced, all from one repo.
    const NEG = '> **Prod is serving `prod-v1.60.0` (`70cec586`). NO prod tag is pending, and `origin/main` ==';
    t('a NEGATED pending claim does NOT match',
        !openOn(NEG),
        'accepting `pending` matched this twice; it asserts the absence of open work');
    t('a row that reports its own MERGED state does not match',
        !openOn('- [#49](https://github.com/o/r/pull/49) is **MERGED**, recorded so nobody redoes it'));
    t('a bare number with no PR handle does not match',
        !HANDLE_OPEN_HANDLE.test('UI-CONTRACT #1 is still open for discussion'),
        'a bare #N is not a PR reference and resolves as merged almost always');

    // ---- kin documents ----------------------------------------------------
    t('a dated DECISIONS sibling is recognised as kin', KIN_DOC.test('DECISIONS-2026-09-07.md'));
    t('a suffixed PLAN is recognised as kin', KIN_DOC.test('PLAN-SITE-V2.md'));
    t('a boot document itself is NOT kin', !KIN_DOC.test('DECISIONS.md'),
        'it is scanned, so naming it as unexamined would be false');
    t('CHANGELOG.md is NOT kin', !KIN_DOC.test('CHANGELOG.md'),
        'a denominator that counts a 6,283-line changelog manufactures alarm');

    console.log('\nselftest: ' + pass + ' passed, ' + fail + ' failed');
    return fail === 0;
}

module.exports = { checkDocStaleness, OPEN_STATE, CONDITIONAL, DECIDED, DECIDED_SECTION,
    RESOLVED, SECTION_RE, BOOT_DOCS, KIN_DOC, render,
    HANDLE_OPEN_HANDLE, HANDLE_OPEN_ASSERT, HANDLE_OPEN_NEGATED };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
    if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
    if (argv.includes('--help') || !arg('--repo')) {
        console.log('check-doc-staleness.js --repo <path> [--age 7] [--max 12] [--json]\n'
            + '                          [--source both|trunk|worktree]\n'
            + 'Re-check the open-state claims in the documents a Brain reads at boot.\n'
            + '\n'
            + '  --source both      (default) grade the trunk, then say which findings the\n'
            + '                     working copy has already fixed but not yet merged\n'
            + '  --source trunk     the trunk alone, for a Brain at boot\n'
            + '  --source worktree  the working copy alone, for what you are about to commit\n'
            + '\n'
            + 'Reports; never decides. Always exits 0.');
        process.exit(0);
    }
    const src = arg('--source') || 'both';
    if (['both', 'trunk', 'worktree'].indexOf(src) === -1) {
        console.error('unknown --source ' + src + '; expected both, trunk or worktree');
        process.exit(0);
    }
    const r = checkDocStaleness(arg('--repo'), { age: arg('--age'), max: arg('--max'), source: src });
    console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
    process.exit(0);
}
