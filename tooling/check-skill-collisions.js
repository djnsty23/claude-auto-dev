#!/usr/bin/env node
// check-skill-collisions.js - two skills competing for ONE situation.
//
// THE GAP THIS FILLS. check-skill-triggers.js scores every description alone:
// `!r.hasCondition`, `r.len > 320`, `!r.hasWhenToUse`. Every predicate reads one
// row, and there is no pairwise comparison anywhere in that file. So a corpus
// where two skills describe the same moment passes it completely, while the
// model picks between them by description similarity, which is a lottery.
//
// That is the exact failure `rule-workflow-spine` was written to address, and
// until now the one checker that reads descriptions could not see it. It is
// also section 10 of `rule-gate-integrity`: a floor is a property of one item,
// and "these two do not collide" is a property of a pair.
//
// THE DISCRIMINATOR, and why it is not a similarity threshold. Scoring 66
// descriptions pairwise gives 2,145 pairs, and generic overlap ("use", "when",
// "before", "the user") puts most of them somewhere in the middle, so any
// cutoff is arbitrary and needs retuning whenever the corpus grows.
//
// Instead: a word appearing in EXACTLY TWO descriptions is, by construction,
// evidence about those two and nothing else. A word in twenty descriptions says
// nothing about any pair. So the signal is the count of corpus-rare words a
// pair shares, and it self-calibrates as the corpus changes.
//
// Usage:
//   node tooling/check-skill-collisions.js            audit the repo, exit 1 on findings
//   node tooling/check-skill-collisions.js --list     also print every pair's shared words
//   node tooling/check-skill-collisions.js --selftest
//   node tooling/check-skill-collisions.js --help

const fs = require('fs');
const path = require('path');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log([
        'check-skill-collisions.js: find two skills competing for one situation.',
        '',
        'Usage: node tooling/check-skill-collisions.js [--list] [--selftest] [--help]',
        '',
        '  --list      print the shared rare words for every reported pair',
        '  --selftest  run the planted positive and negative, then exit',
        '  --help, -h  this text',
        '',
        'Exits 1 when any pair shares MIN_SHARED or more corpus-rare words.',
    ].join('\n'));
    process.exit(0);
}

const ROOT = path.resolve(__dirname, '..', 'plugins');

/** A pair sharing this many corpus-rare words is reported. */
const MIN_SHARED = 2;
/** A word in exactly this many descriptions is evidence about those descriptions. */
const RARE_DF = 2;
/** Shorter tokens are structural, not topical. */
const MIN_TOKEN_LEN = 5;

// Pairs a human has read and cleared, each with the reason. Collapsed to a
// COUNT in the output so a new pair is the only thing that stands out, which is
// the point: re-reporting the same known items every run buries the one that
// was not there yesterday.
//
// This is a record of judgements, not a mute switch. A cleared pair still
// appears under --list. Removing a skill's description does not silently clear
// its entry: an entry naming a skill that no longer exists is reported as
// STALE, so the map cannot rot into a blanket exemption.
//
// Triaged 2026-09-03, first run, 3 of 3 candidates cleared and 0 requiring a
// description change. That is a finding about the metric as much as the corpus:
// rare shared words locate pairs built from one TEMPLATE, which correlates with
// competing for a situation without being the same property.
const TRIAGED = new Map([
    ['framework-radar|marketing-radar',
        'Same template, different domain. Both triggers name their domain in the ' +
        'first clause. The discriminating words appear in more than two ' +
        'descriptions, so they are not corpus-rare and this signal cannot see them.'],
    ['grilling|rule-diagnosis',
        'Different moments: before building a plan, versus before stating a cause. ' +
        'rule-diagnosis is unconditional and already resident, so it is not ' +
        'competing to be found.'],
    ['learn-from-fixes|preflight',
        'Sequential, not competing. preflight\'s trigger names learn-from-fixes as ' +
        'its predecessor.'],
]);

const pairKey = (a, b) => [a, b].sort().join('|');

// Deliberately short. A long stopword list is a tuning knob, and the RARE_DF
// filter already removes anything common enough to matter: a word this list
// would catch appears in far more than two descriptions and is dropped anyway.
const STOP = new Set([
    'before', 'after', 'when', 'whenever', 'which', 'their', 'there', 'these',
    'those', 'about', 'would', 'could', 'should', 'every', 'other', 'where',
    'while', 'using', 'used', 'uses', 'into', 'from', 'that', 'this', 'with',
    'load', 'loads', 'invoked', 'user', 'users', 'says', 'asks', 'anything',
]);

function frontmatter(text) {
    if (!text.startsWith('---')) return null;
    const end = text.indexOf('\n---', 3);
    if (end === -1) return null;
    const out = {};
    let key = null;
    for (const line of text.slice(3, end).split('\n')) {
        const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
        if (m) { key = m[1]; out[key] = m[2].trim(); }
        else if (key && line.trim()) out[key] += ' ' + line.trim();
    }
    return out;
}

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name === 'SKILL.md') out.push(p);
    }
    return out;
}

/** Content words, deduped. Order carries no meaning here. */
function tokens(text) {
    return new Set(
        String(text)
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length >= MIN_TOKEN_LEN && !STOP.has(w)),
    );
}

/**
 * @param {{name: string, text: string}[]} rows
 * @returns {{pairs: {a: string, b: string, shared: string[]}[], rareCount: number, comparisons: number}}
 */
function analyse(rows) {
    const toks = rows.map((r) => ({ name: r.name, set: tokens(r.text) }));

    const df = new Map();
    for (const t of toks) for (const w of t.set) df.set(w, (df.get(w) || 0) + 1);
    const rare = new Set([...df.entries()].filter(([, n]) => n === RARE_DF).map(([w]) => w));

    const pairs = [];
    let comparisons = 0;
    for (let i = 0; i < toks.length; i++) {
        for (let j = i + 1; j < toks.length; j++) {
            comparisons++;
            const shared = [...toks[i].set].filter((w) => rare.has(w) && toks[j].set.has(w));
            if (shared.length >= MIN_SHARED) {
                pairs.push({ a: toks[i].name, b: toks[j].name, shared: shared.sort() });
            }
        }
    }
    pairs.sort((x, y) => y.shared.length - x.shared.length);
    return { pairs, rareCount: rare.size, comparisons };
}

function selftest() {
    const cases = [];
    const check = (label, ok, why) => cases.push([label, ok, why]);

    // POSITIVE. The planted words are nonsense, so they cannot occur in a real
    // description and cannot collide with the corpus as it grows. A realistic
    // word would decay into a false alarm the moment a third skill used it.
    const planted = [
        { name: 'alpha', text: 'zorblatt the quibnix before shipping a plinthwise change' },
        { name: 'beta', text: 'reconcile a zorblatt against the quibnix ledger' },
        { name: 'gamma', text: 'entirely unrelated vocabulary concerning migrations and schemas' },
    ];
    const r = analyse(planted);
    check('a planted pair sharing two corpus-rare words is reported',
        r.pairs.length === 1 && r.pairs[0].a === 'alpha' && r.pairs[0].b === 'beta',
        `got ${JSON.stringify(r.pairs)}`);
    check('  and the shared words are named, not just counted',
        r.pairs[0] && r.pairs[0].shared.join(',') === 'quibnix,zorblatt',
        `got ${r.pairs[0] && r.pairs[0].shared.join(',')}`);

    // NEGATIVE. Sharing ONE rare word is below the floor. This is the control
    // that stops the positive above proving only that the function returns rows.
    const one = analyse([
        { name: 'alpha', text: 'zorblatt the pipeline' },
        { name: 'beta', text: 'zorblatt something else entirely different' },
    ]);
    check('control: one shared rare word is below the floor',
        one.pairs.length === 0, `got ${JSON.stringify(one.pairs)}`);

    // NEGATIVE. A word in THREE descriptions is not rare, so it is not
    // evidence about any pair, however many pairs contain it.
    const common = analyse([
        { name: 'alpha', text: 'zorblatt quibnix alpha material' },
        { name: 'beta', text: 'zorblatt quibnix beta material' },
        { name: 'gamma', text: 'zorblatt quibnix gamma material' },
    ]);
    check('control: a word in three descriptions is not rare, so no pair fires',
        common.pairs.length === 0, `got ${JSON.stringify(common.pairs)}`);

    check('control: the analyser compares every pair, not a sample',
        analyse(planted).comparisons === 3, `got ${analyse(planted).comparisons} of an expected 3`);

    let pass = 0, fail = 0;
    for (const [label, ok, why] of cases) {
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
        ok ? pass++ : fail++;
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();

const files = walk(ROOT);
const rows = [];
for (const f of files) {
    const fm = frontmatter(fs.readFileSync(f, 'utf8'));
    if (!fm || !fm.description) continue;
    rows.push({
        name: fm.name || path.basename(path.dirname(f)),
        // Both fields decide dispatch: the description is what the model reads
        // first, and when_to_use narrows it. A collision in either is a collision.
        text: `${fm.description} ${fm.when_to_use || ''}`,
    });
}

const { pairs, rareCount, comparisons } = analyse(rows);

const known = new Set(rows.map((r) => r.name));
const fresh = pairs.filter((p) => !TRIAGED.has(pairKey(p.a, p.b)));
const cleared = pairs.filter((p) => TRIAGED.has(pairKey(p.a, p.b)));
// An entry whose skills are gone is stale. Reported so the map cannot quietly
// become an exemption for a pair nobody can still read.
const stale = [...TRIAGED.keys()].filter((k) => k.split('|').some((n) => !known.has(n)));

// Population beside the verdict. A zero here has three causes that look
// identical without it: no collisions, no skills found, or a tokeniser that
// produced nothing to compare.
console.log(`skill collision audit`);
console.log(
    `  population: ${rows.length} skill(s) with a description, ${comparisons} pair(s) compared, ` +
        `${rareCount} word(s) appearing in exactly ${RARE_DF} descriptions`,
);
console.log(
    `  pairs sharing ${MIN_SHARED}+ of those words: ${pairs.length} (${fresh.length} new, ${cleared.length} triaged)\n`,
);

const LIST = process.argv.includes('--list');
for (const p of fresh) {
    console.log(`  NEW  ${p.a}  <->  ${p.b}   (${p.shared.length} shared)`);
    console.log(`       ${p.shared.join(', ')}`);
}
if (LIST) {
    for (const p of cleared) {
        console.log(`  ok   ${p.a}  <->  ${p.b}   (${p.shared.length} shared)`);
        console.log(`       ${p.shared.join(', ')}`);
        console.log(`       cleared: ${TRIAGED.get(pairKey(p.a, p.b))}`);
    }
}
for (const k of stale) {
    console.log(`  STALE  ${k}  names a skill that no longer has a description`);
}

if (fresh.length) {
    console.log(
        `\nA reported pair is a CANDIDATE, not a verdict. Two skills covering adjacent` +
            `\nground legitimately share vocabulary; two competing for the same moment is a` +
            `\ndispatch lottery. Read both descriptions and either narrow one, or merge` +
            `\nthem. If they are genuinely distinct, add the pair to TRIAGED with the reason.`,
    );
}

process.exit(fresh.length > 0 || stale.length > 0 ? 1 : 0);
