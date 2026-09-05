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

    let scanned = 0, missing = 0, lines = 0, dated = 0, conditional = 0;
    const findings = [];
    const now = Date.now();

    for (const doc of BOOT_DOCS) {
        // Read the TRACKED tree at the trunk. A working copy has as many current
        // values as there are checkouts, and worktree copies double-count.
        const body = git(['show', trunk + ':' + doc], cwd);
        if (body === null) { missing++; continue; }
        scanned++;
        const rows = body.split('\n');
        for (let i = 0; i < rows.length; i++) {
            const line = rows[i];
            if (line.length < 20) continue;
            lines++;
            if (!OPEN_STATE.some((re) => re.test(line))) continue;
            if (CONDITIONAL.test(line)) { conditional++; continue; }
            // Look for a date on the line or within the three above it, which is
            // where a `[measured YYYY-MM-DD]` tag usually sits.
            let m = null;
            for (let k = i; k >= Math.max(0, i - 3) && !m; k--) m = rows[k].match(DATE_RE);
            if (!m) continue;
            dated++;
            const when = Date.UTC(+m[1], +m[2] - 1, +m[3]);
            const age = Math.floor((now - when) / 86400000);
            if (age < ageDays) continue;
            findings.push({ doc, line: i + 1, age, text: line.trim().slice(0, 150) });
        }
    }

    findings.sort((a, b) => b.age - a.age);
    return {
        repo: path.basename(cwd), trunk,
        population: { bootDocsLookedFor: BOOT_DOCS.length, present: scanned, absent: missing,
            linesConsidered: lines, suppressedAsConditional: conditional,
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
        + ' lines considered, ' + (p.openStateAndDated || 0) + ' open-state (' + (p.suppressedAsConditional || 0) + ' suppressed as rules) and dated, '
        + (p.olderThanAgeDays || 0) + ' older than the threshold');
    for (const n of r.note) out.push('    NOTE: ' + n);
    if (!r.findings.length) { out.push('    nothing to re-check'); return out.join('\n'); }
    out.push('    RE-CHECK BEFORE TRUSTING (oldest first):');
    for (const f of r.findings) {
        out.push('      [' + String(f.age).padStart(4) + 'd] ' + f.doc + ':' + f.line);
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

    t('a date is required, so an undated claim is not reported', DATE_RE.test('[measured 2026-08-21]'));
    t('a non-date number is not read as a date', !DATE_RE.test('port 8080 and 5173'));

    console.log('\nselftest: ' + pass + ' passed, ' + fail + ' failed');
    return fail === 0;
}

module.exports = { checkDocStaleness, OPEN_STATE, CONDITIONAL, BOOT_DOCS, render };

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
