#!/usr/bin/env node
'use strict';
/**
 * check-claude-md.js — grade the MECHANICALLY CHECKABLE claims in CLAUDE.md
 * against the tree they describe.
 *
 * WHY. Three failures inside 48 hours, all in the file every session loads
 * before it does anything else:
 *
 *   1. `[measured 2026-09-07]` CLAUDE.md said the gate was TWO steps. It was
 *      six. A session ran the first command, never ran `check:suites`, and
 *      reported a suite green that `check-suites-can-fail.js` had counted as
 *      NOT verified. #180 corrected the prose by hand; #198 adds a seventh step
 *      and has to correct five more sentences by hand again.
 *   2. `[measured 2026-09-08]` "force-push is blocked so the message cannot be
 *      amended" was false. `main` carries no branch protection and no ruleset.
 *      Two sessions took worse paths on that sentence's authority in one
 *      morning — one kept an unwanted merge commit and carried an eleven-file
 *      diff into review, another merged where a rebase was correct.
 *   3. `[measured 2026-08-29]` the `passes` table listed FOUR states for as long
 *      as `needs-setup` had existed, and briefs written from it propagated the
 *      omission to other sessions.
 *
 * CLAUDE.md itself names the cause: "a count is the purest IMPLEMENTATION
 * DESCRIPTION — it is falsified by the ordinary act of doing the work here, and
 * FALSIFYING IT EMITS NOTHING." This is the thing that emits. It does not stop
 * anyone writing a number down; it stops the number going stale in silence.
 *
 * WHAT IT REFUSES TO CHECK, which matters more than what it checks. Prose
 * judgement, rationale, and anything needing interpretation are out of scope. A
 * checker that guesses produces false positives, a gate with false positives
 * gets switched off, and a gate that is switched off protects nothing. Every
 * claim below has a single mechanical authority named in its finding.
 *
 * NOT A DUPLICATE OF `claudemd-audit.js`, which ships in autodev-memory and
 * finds provably stale FILE REFERENCES in any repo's CLAUDE.md. This is repo
 * machinery, it never ships, and it grades this repo's claims about its own
 * gate, schema, protection and population.
 *
 * THREE STATES, following `check:suites`. A claim you could not check is not a
 * claim that passed:
 *
 *   0  every checked claim agrees with the tree (SKIPs are reported, not hidden)
 *   1  a claim disagrees with the tree
 *   2  INDETERMINATE — a claim that should have been checkable was not found in
 *      a shape this script recognises, so it graded nothing and says so
 *
 * NETWORK. Exactly one claim needs the GitHub API, and CI has no credentials
 * for it. That check SKIPs with a printed reason when the API is unreachable
 * and never lets unreachable read as verified. A skip prints; a pass is silent;
 * the two are visibly different states and neither is exit 1.
 *
 *   node tooling/check-claude-md.js
 *   node tooling/check-claude-md.js --json
 *   node tooling/check-claude-md.js --no-network   # force the API claim to SKIP
 *   node tooling/check-claude-md.js --root <dir>   # grade another tree
 *   node tooling/check-claude-md.js --selftest
 *
 * A clean run with nothing skipped emits ZERO BYTES on both streams.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Number words.
//
// The prose counts in this file are spelled, not digits ("chains all six", "the
// other five NEVER RAN"). Both directions are needed: the word to compare, and
// the number to name in the finding so the fix is typeable.
// ---------------------------------------------------------------------------

const CARDINALS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
    'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
    'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

// "ONE SIXTH of the gate" is a fraction whose denominator is the step count.
// `half` is here because "one half" is the form English uses at two.
const ORDINALS = {
    half: 2, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
    eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
    fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
    eighteenth: 18, nineteenth: 19, twentieth: 20,
};

/** A spelled cardinal, or null when the word is not one. Never guesses. */
function cardinal(word) {
    const i = CARDINALS.indexOf(String(word).toLowerCase());
    return i < 0 ? null : i;
}

/** A spelled ordinal used as a fraction denominator, or null. */
function ordinal(word) {
    const n = ORDINALS[String(word).toLowerCase()];
    return n === undefined ? null : n;
}

function spell(n) {
    return CARDINALS[n] !== undefined ? CARDINALS[n] : String(n);
}

// ---------------------------------------------------------------------------
// Findings.
//
// Every finding names the CLAUDE.md line, the claimed value, the actual value,
// and WHERE the actual came from. The last field is the one that makes a
// finding actionable rather than an accusation.
// ---------------------------------------------------------------------------

function makeReport() {
    const findings = [];
    const skips = [];
    const indeterminate = [];
    let checked = 0;
    return {
        findings, skips, indeterminate,
        get checked() { return checked; },
        /** The claim disagrees with the tree. */
        fail(f) { checked++; findings.push(f); },
        /** The claim agrees with the tree. Counted, silent. */
        pass() { checked++; },
        /** Could not reach the authority. Printed, not a failure. */
        skip(family, reason) { skips.push({ family, reason }); },
        /** The claim was not found in a shape this script recognises. */
        unknown(family, reason) { indeterminate.push({ family, reason }); },
    };
}

/** 1-indexed line number of a character offset. */
function lineOf(text, index) {
    if (index < 0) return 0;
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
}

/**
 * Match `re` once and hand back the match with its line number.
 *
 * Every pattern passed here is anchored on several words of surrounding
 * context. That is deliberate and it is the recurring defect in this repo: a
 * review-class path regex once matched `deploy-authorisation` because it
 * contains `auth`, a grep for `ready` returned the words "already" and
 * "readers", and a case-sensitive grep reported "0 RLS policies" over 33 real
 * migrations. A bare /six/ here would match "sixth", "sixty" and the historical
 * counts this file quotes ON PURPOSE as the wrong ones.
 */
function anchored(text, re) {
    const m = re.exec(text);
    if (!m) return null;
    return { m, line: lineOf(text, m.index), text: m[0] };
}

// ---------------------------------------------------------------------------
// Authorities on disk.
// ---------------------------------------------------------------------------

/** The &&-separated steps of `scripts.gate`, in order. */
function gateSteps(root) {
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { return null; }
    const gate = pkg.scripts && pkg.scripts.gate;
    if (typeof gate !== 'string') return null;
    return gate.split('&&').map((s) => s.trim()).filter(Boolean);
}

/** Every `passes` value prd-states.js distinguishes. The schema's own answer. */
function validPassStates(root) {
    const p = path.join(root, 'plugins', 'autodev-core', 'scripts', 'prd-states.js');
    if (!fs.existsSync(p)) return null;
    try {
        delete require.cache[require.resolve(p)];
        const mod = require(p);
        return Array.isArray(mod.VALID) ? mod.VALID : null;
    } catch { return null; }
}

function listPlugins(root) {
    const dir = path.join(root, 'plugins');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((n) => fs.statSync(path.join(dir, n)).isDirectory())
        .sort();
}

/** Skills are directories carrying a SKILL.md, not every directory. */
function countSkills(root, plugin) {
    const dir = path.join(root, 'plugins', plugin, 'skills');
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir)
        .filter((n) => fs.existsSync(path.join(dir, n, 'SKILL.md'))).length;
}

function countAgents(root, plugin) {
    const dir = path.join(root, 'plugins', plugin, 'agents');
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length;
}

/**
 * Distinct hook EVENTS, which is the number the prose quotes — the keys of the
 * `hooks` object, not the count of scripts wired under them.
 */
function countHookEvents(root, plugin) {
    const p = path.join(root, 'plugins', plugin, 'hooks', 'hooks.json');
    if (!fs.existsSync(p)) return null;
    try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const events = j && typeof j.hooks === 'object' && j.hooks ? j.hooks : null;
        return events ? Object.keys(events).length : null;
    } catch { return null; }
}

/** CI steps gated to one platform, counted from the workflow, not from prose. */
function ubuntuGatedSteps(root) {
    const p = path.join(root, '.github', 'workflows', 'ci.yml');
    if (!fs.existsSync(p)) return null;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const RE = /^\s*if:\s*matrix\.os\s*==\s*'ubuntu-latest'\s*$/;
    return lines.filter((l) => RE.test(l)).length;
}

// ---------------------------------------------------------------------------
// Fenced code blocks, parsed rather than scanned.
// ---------------------------------------------------------------------------

function fencedBlocks(text) {
    const out = [];
    const lines = text.split('\n');
    let open = null;
    for (let i = 0; i < lines.length; i++) {
        const fence = /^\s*```/.test(lines[i]);
        if (!fence) { if (open) open.body.push(lines[i]); continue; }
        if (open) { out.push({ line: open.line, body: open.body.join('\n') }); open = null; }
        else open = { line: i + 2, body: [] }; // first content line, 1-indexed
    }
    return out;
}

// ---------------------------------------------------------------------------
// FAMILY A — the gate chain and its step count.
// Authority: package.json `scripts.gate`.
// ---------------------------------------------------------------------------

/**
 * Every sentence in the Commands section that states the step count, with the
 * arithmetic each one implies. `offset` is what the sentence says relative to
 * the true count: "the other five NEVER RAN" is N-1 because the first step is
 * the one that failed.
 */
const STEP_COUNT_ANCHORS = [
    { id: 'gate-header', re: /THE GATE: ([A-Za-z]+) steps chained with/, kind: 'cardinal', offset: 0 },
    { id: 'step-1-of-n', re: /Step (\d+) of (\d+)\./, kind: 'digit2', offset: 0 },
    { id: 'one-nth', re: /`npm test` is ONE ([A-Za-z]+) of the gate/, kind: 'ordinal', offset: 0 },
    { id: 'chains-all', re: /it chains all ([A-Za-z]+)\./, kind: 'cardinal', offset: 0 },
    { id: 'others-never-ran', re: /means the other\s+([A-Za-z]+) NEVER RAN/, kind: 'cardinal', offset: -1 },
    { id: 'run-remaining', re: /run the remaining ([A-Za-z]+) yourself/, kind: 'cardinal', offset: -1 },
    { id: 'verdict-on-one', re: /a verdict on one step, not on ([A-Za-z]+)/, kind: 'cardinal', offset: 0 },
];

function checkGate(md, root, report) {
    const steps = gateSteps(root);
    if (steps === null) {
        report.unknown('gate', 'package.json has no scripts.gate to grade against');
        return;
    }
    const n = steps.length;

    // A1. The literal chain, compared step for step.
    //
    // The bash block above it also contains the word `npm test`, which is why
    // the whole normalised body must be a chain and not merely contain one:
    // that block carries `#` comments and does not match.
    const CHAIN = /^npm test(?: && npm run [\w:-]+)+$/;
    const chains = fencedBlocks(md)
        .map((b) => ({ ...b, norm: b.body.replace(/\s+/g, ' ').trim() }))
        .filter((b) => CHAIN.test(b.norm));

    if (chains.length !== 1) {
        report.unknown('gate', chains.length === 0
            ? 'no fenced block in CLAUDE.md spells the gate chain; either the '
              + 'Commands section was rewritten or the chain was removed'
            : `${chains.length} fenced blocks spell a gate chain; expected exactly one`);
    } else {
        const claimed = chains[0].norm.split('&&').map((s) => s.trim());
        const same = claimed.length === steps.length && claimed.every((s, i) => s === steps[i]);
        if (same) report.pass();
        else {
            report.fail({
                family: 'gate', line: chains[0].line,
                claim: 'the literal gate chain',
                claimed: claimed.join(' && '),
                actual: steps.join(' && '),
                source: 'package.json scripts.gate',
            });
        }
    }

    // A2. The spelled step counts.
    let matched = 0;
    for (const a of STEP_COUNT_ANCHORS) {
        const hit = anchored(md, a.re);
        if (!hit) continue;
        matched++;
        let claimed = null;
        if (a.kind === 'cardinal') claimed = cardinal(hit.m[1]);
        else if (a.kind === 'ordinal') claimed = ordinal(hit.m[1]);
        else if (a.kind === 'digit2') claimed = Number(hit.m[2]);
        if (claimed === null || Number.isNaN(claimed)) {
            report.unknown('gate', `${a.id} at CLAUDE.md:${hit.line} matched but "${hit.m[1]}" is not a number word`);
            continue;
        }
        const expected = n + a.offset;
        if (claimed === expected) { report.pass(); continue; }
        report.fail({
            family: 'gate', line: hit.line, claim: a.id,
            claimed: `${claimed}  (in "${hit.text.trim()}")`,
            actual: a.offset === 0
                ? `${expected} (${spell(expected)})`
                : `${expected} (${spell(expected)}) — the chain has ${n} steps, this sentence counts N${a.offset}`,
            source: 'package.json scripts.gate, &&-separated',
        });
    }

    // The vacuity guard. A suite in this repo passed yesterday with
    // DOCS = ["NO_SUCH_FILE.md"], asserting nothing. If the prose is reworded
    // past every anchor, this must say so rather than report a clean sweep.
    if (matched === 0) {
        report.unknown('gate',
            'the Commands section states the gate step count in no shape this '
            + 'script recognises (0 of ' + STEP_COUNT_ANCHORS.length + ' anchors matched). '
            + 'Either the section was rewritten — update STEP_COUNT_ANCHORS — or the counts are gone.');
    }
}

// ---------------------------------------------------------------------------
// FAMILY B — the `passes` state table.
// Authority: plugins/autodev-core/scripts/prd-states.js, VALID.
// ---------------------------------------------------------------------------

/**
 * The table's first column, parsed as a markdown table rather than grepped.
 *
 * Anchored on the header row, so the two other pipe tables this file could grow
 * cannot be mistaken for it.
 */
function parsePassesTable(md) {
    const lines = md.split('\n');
    const HEADER = /^\|\s*value\s*\|\s*remaining work\?\s*\|/i;
    const start = lines.findIndex((l) => HEADER.test(l));
    if (start < 0) return null;
    const rows = [];
    for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i];
        if (!/^\s*\|/.test(l)) break;
        if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue; // the |---|---| separator
        const cells = l.split('|').slice(1, -1).map((c) => c.trim());
        if (!cells.length) continue;
        rows.push({ line: i + 1, raw: cells[0] });
    }
    return { line: start + 1, rows };
}

function checkPassesTable(md, root, report) {
    const valid = validPassStates(root);
    if (valid === null) {
        report.unknown('passes', 'prd-states.js did not load, or exports no VALID array');
        return;
    }
    const table = parsePassesTable(md);
    if (!table || table.rows.length === 0) {
        report.unknown('passes',
            'no `| value | remaining work? |` table found in CLAUDE.md; the '
            + 'schema table was renamed, reshaped or removed');
        return;
    }

    // The cell is a literal in backticks: `null`, `true`, `"needs-setup"`.
    // Parsed as JSON, never string-compared, so `"deferred"` and `deferred`
    // cannot both satisfy one row.
    const claimed = [];
    for (const row of table.rows) {
        const m = /^`(.+)`$/.exec(row.raw);
        if (!m) {
            report.unknown('passes', `CLAUDE.md:${row.line} table row "${row.raw}" is not a backticked literal`);
            return;
        }
        try { claimed.push(JSON.parse(m[1])); }
        catch {
            report.unknown('passes', `CLAUDE.md:${row.line} table row \`${m[1]}\` is not a JSON literal`);
            return;
        }
    }

    const key = (v) => JSON.stringify(v);
    const claimedKeys = claimed.map(key);
    const validKeys = valid.map(key);
    const missing = validKeys.filter((k) => !claimedKeys.includes(k));
    const extra = claimedKeys.filter((k) => !validKeys.includes(k));

    if (missing.length === 0 && extra.length === 0) report.pass();
    else {
        report.fail({
            family: 'passes', line: table.line,
            claim: 'the `passes` state table',
            claimed: claimedKeys.join(', ') + ` (${claimedKeys.length} rows)`,
            actual: validKeys.join(', ') + ` (${validKeys.length} states)`
                + (missing.length ? `\n  missing from the table: ${missing.join(', ')}` : '')
                + (extra.length ? `\n  in the table, not in the schema: ${extra.join(', ')}` : ''),
            source: 'plugins/autodev-core/scripts/prd-states.js VALID',
        });
    }

    // The two spelled counts that restate the table.
    const spelled = [
        { id: 'all-n-states', re: /distinguish \*\*all ([A-Za-z]+)\*\* states/, offset: 0 },
        { id: 'not-stop-at-n', re: /not stop at ([A-Za-z]+)\./, offset: -1 },
    ];
    for (const a of spelled) {
        const hit = anchored(md, a.re);
        if (!hit) continue;
        const c = cardinal(hit.m[1]);
        if (c === null) continue;
        const expected = valid.length + a.offset;
        if (c === expected) { report.pass(); continue; }
        report.fail({
            family: 'passes', line: hit.line, claim: a.id,
            claimed: `${c}  (in "${hit.text.trim()}")`,
            actual: `${expected} (${spell(expected)})`,
            source: 'plugins/autodev-core/scripts/prd-states.js VALID',
        });
    }
}

// ---------------------------------------------------------------------------
// FAMILY C — the force-push claim.
// Authority: the GitHub API, plus the local hooks that could block it.
//
// Graded in BOTH DIRECTIONS on purpose. Checking only for the false positive
// form ("force-push is blocked") would go vacuous the moment the sentence is
// corrected — the exact failure this repo keeps having. So the corrected,
// negative sentence is verified too: enable branch protection tomorrow and this
// tells you the file is now stale the other way round.
// ---------------------------------------------------------------------------

const FORCE_BLOCKED = /force[- ]push(?:es|ing)?\s+(?:is|are)\s+blocked/i;
const FORCE_NOT_BLOCKED = /(?:force[- ]push(?:es|ing)?\s+(?:is|are)\s+not\s+blocked|nothing\s+blocks\s+(?:a\s+)?force[- ]push)/i;

/**
 * Blank out double-quoted spans, preserving length and newlines so every line
 * number computed downstream is still the real one.
 *
 * This file quotes its own corrected sentences verbatim — that is the ⚠️
 * convention it uses for history, and CLAUDE.md's own rule is that "historical
 * framing does not license a false present-tense claim", which cuts both ways:
 * a quoted dead sentence is not a present-tense claim either. Without this, the
 * paragraph recording that "force-push is blocked" WAS false would itself be
 * read as asserting it — the same shape as grading the 2026-08-17 counts the
 * counts paragraph quotes on purpose.
 */
function maskQuotations(text) {
    return text.replace(/"[^"]{0,400}"/g, (q) => q.replace(/[^\n]/g, ' '));
}

/** owner/repo from package.json, never hardcoded. */
function repoSlug(root) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const url = pkg.repository && pkg.repository.url;
        const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(String(url || ''));
        return m ? `${m[1]}/${m[2]}` : null;
    } catch { return null; }
}

/**
 * One `gh api` read, with the three outcomes kept apart.
 *
 * `gh` exits non-zero for "the branch is not protected" AND for "you are not
 * logged in" AND for "there is no network". Collapsing those is precisely how
 * unreachable would come to read as verified, so the authoritative 404 body is
 * matched explicitly and everything else is unreachable.
 */
function ghApi(slugPath) {
    const r = spawnSync('gh', ['api', slugPath], {
        encoding: 'utf8', timeout: 20000, windowsHide: true, input: '',
    });
    if (r.error) return { reachable: false, reason: `gh not runnable (${r.error.code || r.error.message})` };
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (/Branch not protected/i.test(out)) return { reachable: true, body: null, notProtected: true };
    if (r.status === 0) {
        try { return { reachable: true, body: JSON.parse(r.stdout) }; }
        catch { return { reachable: false, reason: 'gh returned unparseable JSON' }; }
    }
    const first = out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || `gh exit ${r.status}`;
    return { reachable: false, reason: first.slice(0, 160) };
}

/** Does any local git hook actually stand in the way of a force-push? */
function localForceEvidence(root) {
    const dir = path.join(root, 'tooling', 'githooks');
    if (!fs.existsSync(dir)) return { hooks: [], blocks: false };
    const hooks = fs.readdirSync(dir).sort();
    const RE = /--force\b|force[- ]push|forcePush|denyNonFastForwards|non[-_]fast[-_]forward/i;
    const blocking = hooks.filter((h) => {
        try { return RE.test(fs.readFileSync(path.join(dir, h), 'utf8')); }
        catch { return false; }
    });
    return { hooks, blocks: blocking.length > 0, blocking };
}

function checkForcePush(md, root, report, { network }) {
    // Graded on the file's OWN voice: quoted history is not an assertion.
    const voice = maskQuotations(md);
    const positive = anchored(voice, FORCE_BLOCKED);
    const negative = anchored(voice, FORCE_NOT_BLOCKED);

    // A file that says both, in its own voice, on different lines is not a file
    // this script may pick a reading from. Choosing one silently is how a stale
    // sentence survives beside its own correction.
    if (positive && negative && positive.line !== negative.line) {
        report.unknown('force-push',
            `CLAUDE.md contradicts itself: line ${positive.line} asserts force-push IS `
            + `blocked, line ${negative.line} asserts it is NOT. Neither was graded. `
            + 'Delete one, or quote the dead one — a quoted sentence is read as history.');
        return;
    }

    // "is not blocked" cannot match the positive pattern (the `not` breaks the
    // adjacency), but a future rewording could put both in one sentence; the
    // negative reading wins there rather than the file failing on a technicality.
    const claim = negative || positive;
    if (!claim) {
        report.unknown('force-push',
            'CLAUDE.md states no polarity on force-push. It said "force-push is '
            + 'blocked" until 2026-09-08 and that was false; the sentence is '
            + 'graded in both directions, so a rewording that drops it silences '
            + 'this check. Restore a stated polarity or delete this family.');
        return;
    }
    const claimsBlocked = claim === positive;

    const local = localForceEvidence(root);

    // The two polarities do NOT need the same evidence, and treating them
    // alike is what forced a network call for an answer already settled.
    // "Blocked" is an existence claim — one blocker settles it, and no API
    // reading can unblock what a local hook refuses. "NOT blocked" is an
    // absence claim over every layer that could block, so it cannot be
    // established from the half of those layers that is on this disk.
    if (claimsBlocked && local.blocks) { report.pass(); return; }

    if (!network) {
        report.skip('force-push',
            `CLAUDE.md:${claim.line} claims force-push ${claimsBlocked ? 'IS' : 'is NOT'} blocked. `
            + 'Not graded: --no-network. Local evidence alone cannot rule out branch '
            + `protection (githooks present: ${local.hooks.join(', ') || 'none'}; `
            + `blocking force: ${local.blocks ? local.blocking.join(', ') : 'none'}).`);
        return;
    }

    const slug = repoSlug(root);
    if (!slug) {
        report.skip('force-push', 'package.json declares no github.com repository URL to query');
        return;
    }

    const branch = defaultBranch(root);
    const protection = ghApi(`repos/${slug}/branches/${branch}/protection`);
    const rulesets = ghApi(`repos/${slug}/rulesets`);

    if (!protection.reachable || !rulesets.reachable) {
        const why = !protection.reachable ? protection.reason : rulesets.reason;
        report.skip('force-push',
            `CLAUDE.md:${claim.line} claims force-push ${claimsBlocked ? 'IS' : 'is NOT'} blocked. `
            + `NOT VERIFIED — the GitHub API was unreachable: ${why}. `
            + 'Unreachable is not verified; re-run where `gh auth status` succeeds.');
        return;
    }

    // What would actually block a force-push, in decreasing authority.
    const reasons = [];
    if (protection.body) {
        const afp = protection.body.allow_force_pushes;
        // `allow_force_pushes.enabled === false` is the API saying it blocks.
        if (!afp || afp.enabled === false) reasons.push(`branch protection on ${branch} disallows force pushes`);
    }
    if (Array.isArray(rulesets.body) && rulesets.body.length > 0) {
        // Deliberately conservative: a ruleset EXISTS, so blocking cannot be
        // ruled out. Reporting "not blocked" here would be a false positive,
        // and one false positive is what gets a gate switched off.
        reasons.push(`${rulesets.body.length} repository ruleset(s) exist and may carry non_fast_forward`);
    }
    if (local.blocks) reasons.push(`local hooks reference force-push: ${local.blocking.join(', ')}`);

    const blocked = reasons.length > 0;
    if (blocked === claimsBlocked) { report.pass(); return; }

    report.fail({
        family: 'force-push', line: claim.line,
        claim: `force-push ${claimsBlocked ? 'IS' : 'is NOT'} blocked`,
        claimed: `${claimsBlocked}  (in "${claim.text.trim()}")`,
        actual: blocked
            ? `blocked — ${reasons.join('; ')}`
            : `NOT blocked — ${branch} carries no branch protection, `
              + `${Array.isArray(rulesets.body) ? rulesets.body.length : 0} rulesets, and no local hook `
              + `mentions force (${local.hooks.join(', ') || 'no githooks'})`,
        source: `GitHub API repos/${slug}/branches/${branch}/protection and /rulesets, plus tooling/githooks/`,
    });
}

/** The default branch, from the remote ref when git knows it. */
function defaultBranch(root) {
    const r = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
        cwd: root, encoding: 'utf8', windowsHide: true,
    });
    if (r.status === 0 && r.stdout) {
        const m = /origin\/(.+)/.exec(r.stdout.trim());
        if (m) return m[1];
    }
    return 'main';
}

// ---------------------------------------------------------------------------
// FAMILY D — the population counts, and the plugins named.
// Authority: the tree.
//
// CLAUDE.md says "do not put the numbers back", and then carries four of them
// in a `[measured 2026-09-08]` sentence. That is fine — a dated measurement is
// a legitimate thing to write down. What was not fine is that falsifying it
// emitted nothing. This is the emitter.
//
// The same paragraph QUOTES the 2026-08-17 counts ("43 skills, 4 agents, 7 hook
// events") as the ones that went stale. Those must never be graded, which is
// why the anchor requires the words `core has **` immediately before the
// numbers and the quoted historical form does not have them.
// ---------------------------------------------------------------------------

function checkCounts(md, root, report) {
    const plugins = listPlugins(root);
    if (plugins.length === 0) {
        report.unknown('counts', 'no plugins/ directory to count');
        return;
    }

    // D1. The named plugins. No number in the prose, so nothing to go stale —
    // but a plugin added or removed without touching this line is exactly the
    // drift the section is about.
    const archIdx = md.indexOf('\n## Architecture');
    if (archIdx < 0) {
        report.unknown('counts', 'CLAUDE.md has no `## Architecture` section');
    } else {
        const para = md.slice(archIdx, archIdx + 600);
        const named = [...new Set([...para.matchAll(/`(autodev-[a-z]+)`/g)].map((m) => m[1]))].sort();
        const missing = plugins.filter((p) => !named.includes(p));
        const ghosts = named.filter((p) => !plugins.includes(p));
        if (missing.length === 0 && ghosts.length === 0) report.pass();
        else {
            report.fail({
                family: 'counts', line: lineOf(md, archIdx) + 1,
                claim: 'the plugins named in Architecture',
                claimed: named.join(', ') || '(none)',
                actual: plugins.join(', ')
                    + (missing.length ? `\n  on disk, unnamed: ${missing.join(', ')}` : '')
                    + (ghosts.length ? `\n  named, not on disk: ${ghosts.join(', ')}` : ''),
                source: 'plugins/ on disk',
            });
        }
    }

    // D2. core's three counts, from the one sentence that states them as current.
    const core = anchored(md, /core has \*\*(\d+) skills, (\d+) agents and (\d+) hook events\*\*/);
    if (core) {
        const actual = {
            skills: countSkills(root, 'autodev-core'),
            agents: countAgents(root, 'autodev-core'),
            hooks: countHookEvents(root, 'autodev-core'),
        };
        const claimed = { skills: +core.m[1], agents: +core.m[2], hooks: +core.m[3] };
        for (const k of ['skills', 'agents', 'hooks']) {
            if (actual[k] === null) {
                report.unknown('counts', `autodev-core ${k} could not be counted on disk`);
                continue;
            }
            if (claimed[k] === actual[k]) { report.pass(); continue; }
            report.fail({
                family: 'counts', line: core.line,
                claim: `autodev-core ${k === 'hooks' ? 'hook events' : k}`,
                claimed: String(claimed[k]),
                actual: String(actual[k]),
                source: k === 'skills' ? 'plugins/autodev-core/skills/*/SKILL.md'
                    : k === 'agents' ? 'plugins/autodev-core/agents/*.md'
                        : 'keys of plugins/autodev-core/hooks/hooks.json .hooks',
            });
        }
    }

    // D3. memory's hook events. Its sentence has a different shape from core's
    // and gets its own anchor rather than a shared loose one.
    const mem = anchored(md, /memory's (\d+) is still right/);
    if (mem) {
        const actual = countHookEvents(root, 'autodev-memory');
        if (actual === null) report.unknown('counts', 'autodev-memory hook events could not be counted');
        else if (+mem.m[1] === actual) report.pass();
        else {
            report.fail({
                family: 'counts', line: mem.line,
                claim: 'autodev-memory hook events',
                claimed: mem.m[1],
                actual: String(actual),
                source: 'keys of plugins/autodev-memory/hooks/hooks.json .hooks',
            });
        }
    }
}

// ---------------------------------------------------------------------------
// FAMILY E — how many CI steps are gated to one platform.
// Authority: .github/workflows/ci.yml.
// ---------------------------------------------------------------------------

function checkCi(md, root, report) {
    const hit = anchored(md, /([A-Za-z]+)\s+of CI's steps are `if: matrix\.os == 'ubuntu-latest'`/);
    if (!hit) return; // no claim, nothing to grade
    const claimed = cardinal(hit.m[1]);
    if (claimed === null) {
        report.unknown('ci', `CLAUDE.md:${hit.line} "${hit.m[1]}" is not a number word`);
        return;
    }
    const actual = ubuntuGatedSteps(root);
    if (actual === null) {
        report.unknown('ci', '.github/workflows/ci.yml not found');
        return;
    }
    if (claimed === actual) { report.pass(); return; }
    report.fail({
        family: 'ci', line: hit.line,
        claim: "CI steps gated to ubuntu-latest",
        claimed: `${claimed}  (in "${hit.text.trim()}")`,
        actual: `${actual} (${spell(actual)})`,
        source: ".github/workflows/ci.yml, lines matching `if: matrix.os == 'ubuntu-latest'`",
    });
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

function run(root, opts) {
    const mdPath = path.join(root, 'CLAUDE.md');
    const report = makeReport();
    if (!fs.existsSync(mdPath)) {
        report.unknown('file', `${mdPath} does not exist`);
        return report;
    }
    const md = fs.readFileSync(mdPath, 'utf8');
    checkGate(md, root, report);
    checkPassesTable(md, root, report);
    checkForcePush(md, root, report, opts);
    checkCounts(md, root, report);
    checkCi(md, root, report);
    return report;
}

function render(report) {
    const out = [];
    for (const f of report.findings) {
        out.push(`CLAUDE.md:${f.line}  ${f.claim}`);
        out.push(`  claimed: ${f.claimed}`);
        out.push(`  actual:  ${f.actual}`);
        out.push(`  source:  ${f.source}`);
        out.push('');
    }
    if (report.findings.length) {
        out.push(`${report.findings.length} claim(s) in CLAUDE.md disagree with the tree `
            + `(${report.checked} checked).`);
    }
    for (const s of report.indeterminate) out.push(`INDETERMINATE [${s.family}] ${s.reason}`);
    for (const s of report.skips) out.push(`SKIP [${s.family}] ${s.reason}`);
    return out.join('\n');
}

function exitFor(report) {
    if (report.findings.length) return 1;
    if (report.indeterminate.length) return 2;
    return 0;
}

// ---------------------------------------------------------------------------
// Selftest.
//
// Both directions, on a fixture built from scratch so the assertions are about
// the CHECKER and not about today's CLAUDE.md: the correct fixture must be
// SILENT on both streams, and each mutation must be RED with the right line.
// ---------------------------------------------------------------------------

const FIXTURE_MD = `# CLAUDE.md

## Commands

\`\`\`bash
npm run gate                 # THE GATE: three steps chained with &&. Run this.
npm test                     # every suite. Step 1 of 3.
\`\`\`

**\`npm test\` is ONE THIRD of the gate, and every step it skips fails silently.**

Nothing about the first command hints at the rest, which is why \`npm run gate\`
now exists: it chains all three.

**THE CHAIN IS \`&&\`, so a red first step means the other
two NEVER RAN.** The gate is

\`\`\`
npm test && npm run check:alpha
  && npm run check:beta
\`\`\`

When the first step fails, run the remaining two yourself; the
chain's exit status is a verdict on one step, not on three.

Two of CI's steps are \`if: matrix.os == 'ubuntu-latest'\`, so a green local gate
on macOS and a green CI run are not claims about the same set of checks.

- **\`git commit -F <file>\`, never \`-m\`** — the shell eats backticks, and
  force-push is not blocked, so that is not the reason to avoid an amend.

## Architecture

\`autodev-core\` (the workflow) · \`autodev-memory\` (sqlite memory).

\`[measured 2026-09-08]\` core has **2 skills, 1 agents and 1 hook events**;
memory's 1 is still right, and it is right because nobody has added a memory
hook, not because anything checks.

It was written on 2026-08-17 as "43 skills, 4 agents, 7 hook events" for core.

### The prd.json sprint system

| value | remaining work? | an agent can act on it? |
|---|---|---|
| \`null\` | yes — pending | yes |
| \`true\` | no — done | — |
| \`"deferred"\` | **no** | no |

Anything reading this file must distinguish **all three** states, not treat
\`passes\` as a boolean and not stop at two.
`;

function writeFixture(dir) {
    const w = (rel, body) => {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body);
    };
    w('CLAUDE.md', FIXTURE_MD);
    w('package.json', JSON.stringify({
        repository: { url: 'git+https://github.com/example/nowhere.git' },
        scripts: { gate: 'npm test && npm run check:alpha && npm run check:beta' },
    }, null, 2));
    w('.github/workflows/ci.yml',
        "jobs:\n  test:\n    steps:\n      - run: npm test\n"
        + "      - name: a\n        if: matrix.os == 'ubuntu-latest'\n        run: a\n"
        + "      - name: b\n        if: matrix.os == 'ubuntu-latest'\n        run: b\n");
    w('plugins/autodev-core/skills/one/SKILL.md', '# one');
    w('plugins/autodev-core/skills/two/SKILL.md', '# two');
    w('plugins/autodev-core/skills/not-a-skill/README.md', 'no SKILL.md here');
    w('plugins/autodev-core/agents/solo.md', '# solo');
    w('plugins/autodev-core/hooks/hooks.json', JSON.stringify({ hooks: { Stop: [] } }));
    w('plugins/autodev-memory/hooks/hooks.json', JSON.stringify({ hooks: { SessionStart: [] } }));
    w('plugins/autodev-core/scripts/prd-states.js',
        "'use strict';\nmodule.exports = { VALID: [true, null, 'deferred'] };\n");
    w('tooling/githooks/pre-push', '#!/bin/sh\nnode validate.js\n');
}

function selftest() {
    const cases = [];
    const check = (label, ok, detail) => cases.push([label, ok, detail]);
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-claude-md-'));
    const SELF = __filename;
    const drive = (root, extra = []) => spawnSync(process.execPath,
        [SELF, '--root', root, '--no-network', ...extra],
        { encoding: 'utf8', windowsHide: true, timeout: 60000, input: '' });

    try {
        writeFixture(dir);

        // GREEN. --no-network makes the force-push family SKIP, which must
        // print — a skip is not a pass. Zero bytes is asserted separately
        // below, on the one configuration that has nothing to say at all.
        const green = drive(dir);
        check('correct fixture: no findings, exit 0', green.status === 0,
            `status=${green.status}\n${green.stdout}${green.stderr}`);
        check('correct fixture: the skipped network claim is PRINTED, not silent',
            /^SKIP \[force-push\]/m.test(green.stdout), green.stdout);
        check('correct fixture: a skip is not reported as a finding',
            !/disagree with the tree/.test(green.stdout), green.stdout);

        // ZERO BYTES. The one configuration with nothing to report: the claim
        // is graded rather than skipped. Both streams, not merely stdout.
        //
        // Reached by giving the fixture a positive force-push claim AND a local
        // hook that blocks it, so the offline evidence is decisive on its own.
        const zero = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-claude-md-z-'));
        writeFixture(zero);
        fs.writeFileSync(path.join(zero, 'CLAUDE.md'),
            FIXTURE_MD.replace('force-push is not blocked, so that is not the reason to avoid an amend.',
                'force-push is blocked by the pre-push hook.'));
        fs.writeFileSync(path.join(zero, 'tooling', 'githooks', 'pre-push'),
            '#!/bin/sh\ncase "$*" in *--force*) exit 1;; esac\n');
        const z = drive(zero);
        check('a fully-graded clean run emits ZERO BYTES on stdout',
            z.stdout === '', JSON.stringify(z.stdout));
        check('a fully-graded clean run emits ZERO BYTES on stderr',
            z.stderr === '', JSON.stringify(z.stderr));
        check('a fully-graded clean run exits 0', z.status === 0, `status=${z.status}`);

        // RED, one mutation at a time. Each names the mutated line.
        const mutations = [
            ['step count word (three -> seven)',
                (s) => s.replace('THE GATE: three steps', 'THE GATE: seven steps'),
                /CLAUDE\.md:6\s+gate-header/, /claimed: 7\b/],
            ['fraction (ONE THIRD -> ONE SEVENTH)',
                (s) => s.replace('is ONE THIRD of', 'is ONE SEVENTH of'),
                /one-nth/, /actual:\s+3 \(three\)/],
            ['digit form (Step 1 of 3 -> Step 1 of 7)',
                (s) => s.replace('Step 1 of 3.', 'Step 1 of 7.'),
                /step-1-of-n/, /claimed: 7\b/],
            ['N-1 sentence (other two -> other five)',
                (s) => s.replace('the other\ntwo NEVER RAN', 'the other\nfive NEVER RAN'),
                /others-never-ran/, /this sentence counts N-1/],
            ['literal chain drifts from package.json',
                (s) => s.replace('&& npm run check:beta\n', '&& npm run check:gamma\n'),
                /the literal gate chain/, /actual:\s+npm test && npm run check:alpha && npm run check:beta/],
            ['a passes state is missing from the table',
                (s) => s.replace('| `"deferred"` | **no** | no |\n', ''),
                /the `passes` state table/, /missing from the table: "deferred"/],
            ['a passes state the schema does not have',
                (s) => s.replace('| `true` | no — done | — |', '| `true` | no — done | — |\n| `"invented"` | ? | ? |'),
                /the `passes` state table/, /not in the schema: "invented"/],
            ['the spelled state count (all three -> all four)',
                (s) => s.replace('distinguish **all three** states', 'distinguish **all four** states'),
                /all-n-states/, /actual:\s+3 \(three\)/],
            ['a skill count',
                (s) => s.replace('core has **2 skills', 'core has **9 skills'),
                /autodev-core skills/, /source:\s+plugins\/autodev-core\/skills\/\*\/SKILL\.md/],
            ['an agent count',
                (s) => s.replace('1 agents and', '4 agents and'),
                /autodev-core agents/, /claimed: 4/],
            ['a hook-event count',
                (s) => s.replace('and 1 hook events', 'and 7 hook events'),
                /autodev-core hook events/, /claimed: 7/],
            ["memory's hook-event count",
                (s) => s.replace("memory's 1 is still right", "memory's 4 is still right"),
                /autodev-memory hook events/, /actual:\s+1/],
            ['a plugin on disk goes unnamed',
                (s) => s.replace(' · `autodev-memory` (sqlite memory)', ''),
                /the plugins named in Architecture/, /unnamed: autodev-memory/],
            ["the CI ubuntu-gated step count",
                (s) => s.replace("Two of CI's steps", "Six of CI's steps"),
                /CI steps gated to ubuntu-latest/, /actual:\s+2 \(two\)/],
        ];

        for (const [label, mutate, wantClaim, wantDetail] of mutations) {
            const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-claude-md-m-'));
            writeFixture(d);
            const before = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8');
            const after = mutate(before);
            check(`mutation actually changed the fixture: ${label}`, after !== before, label);
            fs.writeFileSync(path.join(d, 'CLAUDE.md'), after);
            const r = drive(d);
            check(`RED on ${label} (exit 1)`, r.status === 1, `status=${r.status}\n${r.stdout}${r.stderr}`);
            check(`  names the claim: ${label}`, wantClaim.test(r.stdout), r.stdout);
            check(`  names the actual value and its source: ${label}`, wantDetail.test(r.stdout), r.stdout);
            fs.rmSync(d, { recursive: true, force: true });
        }

        // INDETERMINATE is its own state, distinct from both pass and fail.
        const ind = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-claude-md-i-'));
        writeFixture(ind);
        fs.writeFileSync(path.join(ind, 'CLAUDE.md'),
            FIXTURE_MD.replace(/```\nnpm test && npm run check:alpha[\s\S]*?```/, '(the chain used to be here)'));
        const i1 = drive(ind);
        check('a missing gate chain is INDETERMINATE (exit 2), not a pass',
            i1.status === 2, `status=${i1.status}\n${i1.stdout}`);
        check('  and says the chain block is gone',
            /INDETERMINATE \[gate\] no fenced block/.test(i1.stdout), i1.stdout);

        const ind2 = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-claude-md-i2-'));
        writeFixture(ind2);
        fs.writeFileSync(path.join(ind2, 'CLAUDE.md'),
            FIXTURE_MD.replace(/\| value \| remaining work\? \| an agent can act on it\? \|\n\|---\|---\|---\|\n(\|.*\n)+/, ''));
        const i2 = drive(ind2);
        check('a missing passes table is INDETERMINATE (exit 2), not a pass',
            i2.status === 2, `status=${i2.status}\n${i2.stdout}`);

        // A file asserting BOTH polarities in its own voice must refuse to pick
        // one. This is the case that made the masking necessary: a half-applied
        // correction leaves the dead sentence beside the live one.
        const both = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-claude-md-b-'));
        writeFixture(both);
        fs.writeFileSync(path.join(both, 'CLAUDE.md'),
            `${FIXTURE_MD}\nAlso worth knowing: force-push is blocked on this repo.\n`);
        const b = drive(both);
        check('a file asserting BOTH polarities is INDETERMINATE, not silently graded',
            b.status === 2 && /contradicts itself/.test(b.stdout), `status=${b.status}\n${b.stdout}`);

        // ...but the SAME sentence in quotation marks is history, not a claim.
        // Without this, every ⚠️ paragraph recording a correction would trip the
        // contradiction check above.
        const quoted = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-claude-md-q-'));
        writeFixture(quoted);
        fs.writeFileSync(path.join(quoted, 'CLAUDE.md'),
            `${FIXTURE_MD}\nThis line said "force-push is blocked" until 2026-09-08, and it was false.\n`);
        const q = drive(quoted);
        check('the same sentence QUOTED is history, and does not contradict',
            q.status === 0 && !/contradicts itself/.test(q.stdout), `status=${q.status}\n${q.stdout}`);

        const ind3 = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-claude-md-i3-'));
        writeFixture(ind3);
        fs.writeFileSync(path.join(ind3, 'CLAUDE.md'),
            FIXTURE_MD.replace(/force-push is not blocked, so that is not the reason to avoid an amend\./,
                'amending is unwise here.'));
        const i3 = drive(ind3);
        check('dropping the force-push polarity is INDETERMINATE, not silence',
            i3.status === 2 && /INDETERMINATE \[force-push\]/.test(i3.stdout),
            `status=${i3.status}\n${i3.stdout}`);

        // The historical counts this file quotes ON PURPOSE must never be
        // graded. A bare-substring matcher would fail here; this is the
        // regression test for that.
        const hist = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-claude-md-h-'));
        writeFixture(hist);
        const h = drive(hist);
        check('the quoted 2026-08-17 counts are NOT graded (43/4/7 in the fixture)',
            h.status === 0 && !/43/.test(h.stdout), `status=${h.status}\n${h.stdout}`);

        fs.rmSync(zero, { recursive: true, force: true });
        for (const d of [ind, ind2, ind3, hist, both, quoted]) fs.rmSync(d, { recursive: true, force: true });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    let failed = 0;
    for (const [label, ok, detail] of cases) {
        console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
        if (!ok) { failed++; console.log('        ' + String(detail).replace(/\n/g, '\n        ')); }
    }
    console.log(`population: ${cases.length} assertions run, ${cases.length - failed} passed`);
    // Never process.exit() after printing: on darwin a pipe write is async and
    // exit() truncates it. CLAUDE.md documents the 65536-byte instance.
    process.exitCode = failed ? 1 : 0;
}

function main() {
    if (has('--help') || has('-h')) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 60).join('\n'));
        return;
    }
    if (has('--selftest')) { selftest(); return; }

    const root = path.resolve(val('--root', REPO_ROOT));
    const report = run(root, { network: !has('--no-network') });

    if (has('--json')) {
        console.log(JSON.stringify({
            root, checked: report.checked,
            findings: report.findings, skips: report.skips,
            indeterminate: report.indeterminate,
            exit: exitFor(report),
        }, null, 2));
    } else {
        const text = render(report);
        if (text) console.log(text);
    }
    process.exitCode = exitFor(report);
}

main();
