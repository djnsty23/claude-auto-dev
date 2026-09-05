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
    let headings = 0;
    const findings = [];
    const now = Date.now();

    for (const doc of BOOT_DOCS) {
        // Read the TRACKED tree at the trunk. A working copy has as many current
        // values as there are checkouts, and worktree copies double-count.
        const body = git(['show', trunk + ':' + doc], cwd);
        if (body === null) { missing++; continue; }
        scanned++;
        const rows = body.split('\n');
        let section = '';
        for (let i = 0; i < rows.length; i++) {
            const line = rows[i];
            const sm = line.match(SECTION_RE);
            if (sm) section = sm[1] || sm[2] || '';
            if (line.length < 20) continue;
            lines++;
            if (!OPEN_STATE.some((re) => re.test(line))) continue;
            if (CONDITIONAL.test(line)) { conditional++; continue; }
            if (DECIDED.test(line) || DECIDED_SECTION.test(section)) { decided++; continue; }
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
            assertedInAHeading: headings,
            openStateAndDated: dated, olderThanAgeDays: findings.length },
        findings: findings.slice(0, max), note,
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
