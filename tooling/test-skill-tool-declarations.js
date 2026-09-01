#!/usr/bin/env node
'use strict';

// Suite for check-skill-tool-declarations.js.
//
// Three layers, because each answers a question the others cannot:
//
//   1. The gate's own --selftest, driven AS A SUBPROCESS so its exit code is
//      observable. No in-process assertion can see an exit code, and the gate
//      is consumed by `npm test` through its status (rule-gate-integrity, 5).
//
//   2. A live run against the real corpus, asserting the POPULATION line rather
//      than the verdict. A scan that read nothing prints the same "0 flagged"
//      as a clean tree, so the count of files read is the only thing that tells
//      those apart.
//
//   3. A MUTATION: the real defect planted in a real skill, with the gate then
//      required to name that exact skill and tool. The planted value is DERIVED
//      FROM THE LIVE CORPUS -- the suite finds a skill that genuinely mandates a
//      tool it genuinely declares, and deletes that one tool. Nothing is
//      invented, so the plant cannot rot as skills are added or renamed, and it
//      cannot be satisfied by a tool name that stopped existing.
//
// The mutation rewrites a tracked file. It is restored in a `finally`, and the
// suite asserts the restore actually happened -- `npm run check:suites` refuses
// a dirty tree, so a leaked mutant would break the next gate run rather than
// merely this one.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GATE = path.resolve(__dirname, 'check-skill-tool-declarations.js');
const { scan } = require(GATE);

const fails = [];
const check = (name, cond) => {
    console.log((cond ? '  ok   ' : '  FAIL ') + name);
    if (!cond) fails.push(name);
};
const run = (args) => spawnSync('node', [GATE].concat(args || []), { encoding: 'utf8' });

console.log('check-skill-tool-declarations');

// --- 1. the gate's own fixtures, through the CLI ---------------------------
let r = run(['--selftest']);
check('--selftest exits 0', r.status === 0);
check('--selftest reports a fixture count', /\d+\/\d+ fixture cases/.test(r.stdout || ''));
check('--selftest covers both directions',
    /MUST FLAG/.test(r.stdout || '') && /MUST NOT FLAG/.test(r.stdout || ''));

// --- 2. the live corpus, judged on its population --------------------------
r = run([]);
const out = r.stdout || '';
const pop = out.match(/(\d+) skills scanned, (\d+) declare allowed-tools/);
check('a live run prints the population it scanned', Boolean(pop));
check('the population is non-empty', pop && Number(pop[1]) > 0);
check('every skill is accounted for as declaring or not',
    pop && /\d+ skills scanned, \d+ declare allowed-tools, \d+ do not/.test(out));
check('the reference count is reported beside the finding count',
    /\d+ tool references seen, \d+ read as mandates, \d+ vetoed as mentions/.test(out));
check('the known limits are printed with every result', /^limits:/m.test(out));

// THE CORPUS MUST BE CLEAN. This is the assertion that makes the check a gate
// rather than a report: any skill added later that mandates a tool its
// frontmatter does not declare turns `npm test` red here.
check('the shipped corpus has no undeclared mandates', /\b0 flagged/.test(out));
check('a clean run exits 0', r.status === 0);

// Every reference is accounted for -- a reference that is neither a mandate nor
// a vetoed mention is one the rule had no opinion about, and a growing pile of
// those would mean the check had quietly stopped judging.
const seen = out.match(/(\d+) tool references seen, (\d+) read as mandates, (\d+) vetoed/);
check('references are judged, not merely counted',
    seen && Number(seen[2]) > 0 && Number(seen[3]) > 0);

// --- 2b. the blind spot, pinned by hand ------------------------------------
// A short alias with no full mcp__ name anywhere in the corpus is invisible to
// the check, by construction and unfixably without a tool-name registry. The
// three instances found by sweeping that limit on 2026-09-01 are pinned here as
// literals instead, so removing a declaration the gate cannot re-derive still
// turns this suite red. Hardcoded on purpose: a canary that reads the same
// source as the check would weaken in the same motion.
const BLIND_SPOT = [
    ['rule-local-first', 'mcp__Claude_Browser__*', 'preview_start / resize_window'],
    ['sessions', 'mcp__ccd_session_mgmt__archive_session', 'archive_session'],
];
for (const [skill, tool, why] of BLIND_SPOT) {
    const p = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'skills', skill, 'SKILL.md');
    let decl = '';
    try { decl = (fs.readFileSync(p, 'utf8').match(/^allowed-tools:\s*(.*)$/m) || [])[1] || ''; }
    catch { /* reported by the assertion below */ }
    check(skill + ' still declares ' + tool + ' (mandated as ' + why + ')',
        decl.split(',').map((s) => s.trim()).includes(tool));
}

// --- 3. mutation: plant the real defect ------------------------------------
// Find a skill that mandates a tool it declares. That pair is the contract; the
// mutation is its removal.
let subject = null;
for (const res of scan().results) {
    if (!res.declared) continue;
    const hit = res.refs.find((x) => x.mandate && !x.negative && x.declared
        && res.declared.includes(x.canonical));
    if (hit) { subject = { file: res.file, skill: res.skill, tool: hit.canonical, line: hit.line }; break; }
}

check('a declared-and-mandated pair exists to mutate', Boolean(subject));

if (subject) {
    console.log('    planting: ' + subject.skill + ' declares and mandates '
        + subject.tool + ' (line ' + subject.line + ')');
    const original = fs.readFileSync(subject.file, 'utf8');
    try {
        // Remove exactly that one tool from the allowed-tools line.
        const mutated = original.replace(/^(allowed-tools:\s*)(.*)$/m, (m, head, list) => {
            const kept = list.split(',').map((s) => s.trim())
                .filter((s) => s && s !== subject.tool);
            return head + kept.join(', ');
        });
        check('the mutation changed the file', mutated !== original);
        check('the mutation removed only the allowed-tools entry',
            mutated.split('\n').length === original.split('\n').length);

        fs.writeFileSync(subject.file, mutated, 'utf8');
        const m = run([]);
        const mout = m.stdout || '';

        check('THE GATE FIRES on the planted defect', m.status !== 0);
        check('--advisory still prints the finding but exits 0', (() => {
            const a = run(['--advisory']);
            return a.status === 0 && /1 flagged/.test(a.stdout || '');
        })());
        check('it names the mutated skill', mout.includes(subject.skill + '/SKILL.md'));
        // Plain string containment. A regex here was brittle to the subject the
        // suite happens to pick: the first version anchored with \b, which
        // cannot match after the `*` of a namespace tool, so the assertion went
        // red the moment the corpus changed which pair came first.
        check('it names the removed tool',
            mout.includes('mandates ' + subject.tool)
            || mout.includes('(' + subject.tool + ')'));
        check('it names the line the mandate is on',
            mout.includes(subject.skill + '/SKILL.md:' + subject.line));

        // It fired for the RIGHT reason: one more finding than before, not a
        // crash and not a wholesale change of verdict.
        const before = Number((out.match(/(\d+) flagged/) || [])[1]);
        const after = Number((mout.match(/(\d+) flagged/) || [])[1]);
        check('exactly one new finding appeared, not a collapse',
            Number.isFinite(before) && Number.isFinite(after) && after === before + 1);
        check('the new finding is the planted one and nothing else',
            after === 1 && (mout.match(/mandates /g) || []).length === 1);
        check('the population is unchanged by the mutation',
            (mout.match(/(\d+) skills scanned/) || [])[1] === (pop || [])[1]);
    } finally {
        fs.writeFileSync(subject.file, original, 'utf8');
    }
    check('the subject was restored byte-for-byte',
        fs.readFileSync(subject.file, 'utf8') === original);

    const restored = run([]);
    check('the gate returns to its pre-mutation verdict',
        (restored.stdout || '').match(/(\d+) flagged/)?.[1] === out.match(/(\d+) flagged/)?.[1]);
}

console.log(fails.length ? '\nFAILED: ' + fails.join(', ') : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
