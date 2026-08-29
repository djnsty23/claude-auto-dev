#!/usr/bin/env node
'use strict';
// Suite for check-queue-freshness.js — the bulk premise checker.
//
// Run: node tooling/test-check-queue-freshness.js
//
// WHY THIS SUITE'S FIXTURES ARE SYNTHETIC.
//
// The defect this tool exists for is real and specific: a fleet queue listed
// eight items for one repo, four were already shipped, and a branch merge was
// nearly assigned that would have rolled VERSION back two releases. The obvious
// regression test is that queue against that repo.
//
// It cannot be that, for two reasons that are worth stating rather than working
// around silently. The queue lives in a directory with no git history, so
// "the queue as it was that morning" is not recoverable. And the repo it
// describes is private, while THIS repo is public — pinning a fixture to it
// would put a private project's file paths and symbol names into a public tree,
// which is the exposure that put private repo paths inside a public checkout on
// the same day.
//
// So the fixtures below reproduce the four stale SHAPES rather than the four
// stale items. Each is a real git repository built here, with a real origin, and
// the tool reads it exactly as it reads a live one — nothing is stubbed and no
// verdict is faked. The shapes, each taken from one of the real items:
//
//   1. A symbol the item asserts is present, REMOVED on the trunk.
//   2. A symbol the item asserts is absent, now ADDED on the trunk.
//   3. The file the item names, DELETED. Distinct from a removed symbol, and
//      the item that was stale this way is the reason the distinction exists.
//   4. A symbol that survives ONLY inside a comment describing its own removal.
//      This one must report PRESENT, and must print the line, because a grep
//      cannot tell code from a note about the code and only a reader can.
//
// EVERY ZERO ASSERTED HERE SHARES ITS RUN WITH A PLANTED POSITIVE, so a run that
// reports nothing because the tool broke is distinguishable from a run that
// reports nothing because there was nothing to report.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SUBJECT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-queue-freshness.js',
);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; console.log('PASS  ' + name); }
    else { failures.push(name + (detail ? '  -> ' + JSON.stringify(detail) : '')); console.log('FAIL  ' + name); }
}

const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'queuefresh-'));
const CODE = path.join(fixture, 'code');
fs.mkdirSync(CODE, { recursive: true });

function git(repo, args) {
    return execFileSync('git', ['-C', repo].concat(args),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A repo with a real origin, because the tool reads origin/HEAD and nothing
 * else. A fixture with only a local branch would pass against a tool that read
 * the working tree — the exact defect being guarded against — so the fixture
 * has to make that mistake visible.
 */
function makeRepo(name, files) {
    const origin = path.join(fixture, name + '.git');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);

    const work = path.join(CODE, name);
    fs.mkdirSync(work, { recursive: true });
    git(work, ['init', '--quiet', '-b', 'main']);
    git(work, ['config', 'user.email', 'suite@example.invalid']);
    git(work, ['config', 'user.name', 'suite']);
    write(work, files);
    git(work, ['add', '-A']);
    git(work, ['commit', '--quiet', '-m', 'base']);
    git(work, ['remote', 'add', 'origin', origin]);
    git(work, ['push', '--quiet', '-u', 'origin', 'main']);
    // origin/HEAD is what the tool resolves; a bare clone does not set it for us.
    git(work, ['remote', 'set-head', 'origin', 'main']);
    return work;
}

function write(repo, files) {
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(repo, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (body === null) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
        else fs.writeFileSync(p, body);
    }
}

/** Move the trunk on, exactly as a session shipping work would. */
function advance(repo, files, msg) {
    write(repo, files);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', msg]);
    git(repo, ['push', '--quiet', 'origin', 'main']);
}

function run(queueBody, extra) {
    const qf = path.join(fixture, 'Q-' + Math.abs(hash(queueBody)) + '.md');
    fs.writeFileSync(qf, queueBody);
    const r = spawnSync(process.execPath,
        [SUBJECT, '--queue', qf, '--repo-root', CODE, '--no-fetch', '--json'].concat(extra || []),
        { encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* left null on purpose */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

const verdictOf = (res, i) => res.json && res.json.results[i] && res.json.results[i].verdict;

// ---------------------------------------------------------------------------
// The repo, and the four ways its trunk moved out from under the queue.
// ---------------------------------------------------------------------------

const app = makeRepo('demo-app', {
    'src/plan-card.tsx': 'export const Card = () => <a href="/login">Upgrade</a>;\n',
    'src/checkout.ts': 'export function session() {\n  return { mode: "payment" };\n}\n',
    'src/legacy-form.tsx': 'export const Legacy = () => null;\n',
    'src/style-fields.tsx': 'const label = "Unlock brand colours";\nexport default label;\n',
});

// The planted positive: a premise that must stay FRESH in every run below, so a
// run reporting no staleness cannot be a run where the tool silently failed.
const BEACON = 'PREMISE: repo=demo-app expect=present match="mode: \\"payment\\"" file=src/checkout.ts';

{
    // Nothing has moved yet. Every premise must hold — the control that proves
    // the fixtures are readable before any of them is expected to go stale.
    const res = run([
        '## Items',
        '**A · the login CTA** PREMISE: repo=demo-app expect=present match=href="/login" file=src/plan-card.tsx',
        '**B · tax fields missing** PREMISE: repo=demo-app expect=absent match=automatic_tax file=src/checkout.ts',
    ].join('\n'));
    check('an unmoved trunk falsifies nothing', res.status === 0, res.stdout);
    check('...expect=present holds while the string is there', verdictOf(res, 0) === 'FRESH', res.json);
    check('...expect=absent holds while the string is missing', verdictOf(res, 1) === 'FRESH', res.json);
}

// SHAPE 1 + 2: the trunk moves. A present-premise loses its string; an
// absent-premise gains one. Both are "somebody already did this".
advance(app, {
    'src/plan-card.tsx': 'export const Card = () => <a href="/upgrade">Upgrade</a>;\n',
    'src/checkout.ts': 'export function session() {\n  return { mode: "payment", automatic_tax: { enabled: true } };\n}\n',
}, 'ship the checkout work');

{
    const res = run([
        '## Items',
        '**A · the login CTA** PREMISE: repo=demo-app expect=present match=href="/login" file=src/plan-card.tsx',
        '**B · tax fields missing** PREMISE: repo=demo-app expect=absent match=automatic_tax file=src/checkout.ts',
        '**Beacon** ' + BEACON,
    ].join('\n'));
    check('a shipped trunk makes the queue STALE', res.status === 3, res.stdout);
    check('...a present-premise whose string is GONE is stale', verdictOf(res, 0) === 'STALE', res.json);
    check('...an absent-premise whose string ARRIVED is stale', verdictOf(res, 1) === 'STALE', res.json);
    check('...and the planted beacon still reads FRESH in the same run',
        verdictOf(res, 2) === 'FRESH', res.json);
    check('...the stale count is exactly 2', res.json && res.json.population.stale === 2, res.json);
}

// SHAPE 3: the file is deleted. This MUST NOT read as "the symbol is absent".
advance(app, { 'src/legacy-form.tsx': null }, 'delete the legacy form');

{
    const res = run([
        '## Items',
        '**C · legacy form** PREMISE: repo=demo-app expect=present match=Legacy file=src/legacy-form.tsx',
        '**Beacon** ' + BEACON,
    ].join('\n'));
    check('a deleted file gets its OWN verdict', verdictOf(res, 0) === 'MISSING-FILE', res.json);
    check('...and is not counted as a stale symbol', res.json && res.json.population.stale === 0, res.json);
    check('...and still exits non-zero, because the item is not actionable as written',
        res.status === 3, res.stdout);
    check('...beacon unaffected', verdictOf(res, 1) === 'FRESH', res.json);

    // The distinction has to be REAL, not just differently labelled: the same
    // premise against a file that exists and simply lacks the symbol is STALE.
    const other = run('**C2** PREMISE: repo=demo-app expect=present match=Legacy file=src/plan-card.tsx');
    check('a present file missing the symbol is STALE, not MISSING-FILE',
        verdictOf(other, 0) === 'STALE', other.json);
}

// SHAPE 4: the symbol survives only in a comment about its own removal. The
// tool must call that PRESENT and print the line — this is the case that made
// the real verification cheap, and a tool that "helpfully" ignored comments
// would have reported all four items stale for the wrong reason.
advance(app, {
    'src/style-fields.tsx': '// The "Unlock brand colours" add-on was REMOVED on 2026-08-29.\n'
        + '// The free plan already includes it.\nexport default null;\n',
}, 'remove the add-on, leave the note');

{
    const res = run([
        '**D · add-on button** PREMISE: repo=demo-app expect=present match="Unlock brand colours" file=src/style-fields.tsx',
        '**Beacon** ' + BEACON,
    ].join('\n'));
    // NOT stale: the string is genuinely there, and a grep cannot promote "this
    // is a comment" into "the work is done". It is REVIEW rather than FRESH so
    // the signal is not left buried in the printed lines — see the COMMENT-ONLY
    // block below for why that distinction was added and what it must not break.
    check('a match that survives only in a comment is PRESENT, never stale',
        verdictOf(res, 0) === 'REVIEW', res.json);
    check('...and does not fail the run, because a comment is not proof',
        res.status === 0, res.stdout);
    const m = res.json && res.json.results[0].matches;
    check('...and the MATCHING LINE is printed, so a reader can see it is a note',
        Array.isArray(m) && m.length === 1 && /REMOVED/.test(m[0]), m);
    check('...carrying file and line number', Array.isArray(m) && /^src\/style-fields\.tsx:1:/.test(m[0]), m);
}

// ---------------------------------------------------------------------------
// origin/HEAD, NOT the local checkout. Added because a mutation survived.
//
// Every assertion above pushed after every commit, so the local branch and
// origin/main were byte-identical in all of them — which means changing the tool
// to read local HEAD broke NOTHING. Six mutants were run against this suite and
// that was the one that lived, and it is the requirement with the highest cost
// attached: every stale-premise error in the incident came from reading a tree
// that had moved.
//
// So this scenario is the only one where the two refs DISAGREE: a local commit
// that is never pushed. Reading local HEAD reports the item as done; reading
// origin/HEAD reports it as open. A tool that reads the wrong one here does not
// error — it silently drops live work off the queue, which is the same class of
// failure as the one it was built to catch, pointed the other way.
// ---------------------------------------------------------------------------

{
    const solo = makeRepo('unpushed-app', {
        'src/card.tsx': 'export const C = () => <a href="/login">Go</a>;\n',
    });
    // Committed LOCALLY and deliberately not pushed.
    write(solo, { 'src/card.tsx': 'export const C = () => <a href="/upgrade">Go</a>;\n' });
    git(solo, ['add', '-A']);
    git(solo, ['commit', '--quiet', '-m', 'local only, never pushed']);

    const localHas = git(solo, ['grep', '-c', '--fixed-strings', '-e', 'href="/upgrade"', 'HEAD'] );
    check('fixture check: the local branch really has moved ahead of origin',
        !!localHas && localHas.trim().length > 0, localHas);

    const res = run('**U · unpushed** PREMISE: repo=unpushed-app expect=present match=href="/login" file=src/card.tsx');
    check('a premise is judged on origin/HEAD, so an unpushed local fix does NOT mark it stale',
        verdictOf(res, 0) === 'FRESH', res.json);
    check('...and the run exits clear rather than dropping live work', res.status === 0, res.stdout);

    // The other half: once it IS pushed, the same premise must go stale. Without
    // this, the assertion above could pass on a tool that never finds anything.
    git(solo, ['push', '--quiet', 'origin', 'main']);
    const after = run('**U2 · pushed** PREMISE: repo=unpushed-app expect=present match=href="/login" file=src/card.tsx');
    check('...and once pushed, the identical premise DOES go stale',
        verdictOf(after, 0) === 'STALE', after.json);
}

{
    // A dirty working tree must not move a verdict either: the question is about
    // the published trunk, and an in-flight edit by another session is not it.
    const dirty = makeRepo('dirty-app', { 'src/a.ts': 'export const KEEP = 1;\n' });
    fs.writeFileSync(path.join(dirty, 'src/a.ts'), 'export const GONE = 1;\n');
    const res = run('**W · dirty tree** PREMISE: repo=dirty-app expect=present match=KEEP file=src/a.ts');
    check('an uncommitted working-tree edit does not falsify a premise',
        verdictOf(res, 0) === 'FRESH', res.json);
}

// ---------------------------------------------------------------------------
// UNCHECKABLE is its own state and never collapses into fresh.
// ---------------------------------------------------------------------------

{
    const res = run([
        '## Items',
        '**E · prose only, no premise at all**',
        '   The Pro card CTA never reaches checkout.',
        '**Beacon** ' + BEACON,
    ].join('\n'));
    check('an item with no premise is UNCHECKABLE', verdictOf(res, 0) === 'UNCHECKABLE', res.json);
    check('...and is NOT counted among the fresh',
        res.json && res.json.population.fresh === 1 && res.json.population.uncheckable === 1, res.json);
    // The load-bearing one. A summary that says "nothing falsified" without
    // naming what it could not look at is the collapse this tool is about.
    const human = run([
        '**E · prose only**',
        '**Beacon** ' + BEACON,
    ].join('\n'), ['--no-json-marker']);
    check('...and the human summary names the uncheckable count in the same sentence',
        /could NOT be checked/.test(human.stdout) || /uncheckable/i.test(human.stdout), human.stdout.slice(-400));
}

{
    // A malformed premise is UNCHECKABLE with a reason, never silently dropped —
    // a dropped premise is an item that looks checked and was not.
    const res = run([
        '**F** PREMISE: repo=demo-app match=x',
        '**G** PREMISE: expect=present match=x',
        '**H** PREMISE: repo=demo-app expect=maybe match=x',
        '**Beacon** ' + BEACON,
    ].join('\n'));
    check('a premise with no expect= is uncheckable', verdictOf(res, 0) === 'UNCHECKABLE', res.json);
    check('a premise with no repo= is uncheckable', verdictOf(res, 1) === 'UNCHECKABLE', res.json);
    check('a premise with a nonsense expect= is uncheckable', verdictOf(res, 2) === 'UNCHECKABLE', res.json);
    check('...each carrying a reason', res.json && res.json.results.slice(0, 3).every((r) => !!r.why), res.json);
    check('...and the beacon still checked in the same run', verdictOf(res, 3) === 'FRESH', res.json);
}

// ---------------------------------------------------------------------------
// COMMENT-ONLY matches, and the two errors that are NOT symmetric.
//
// Found by running this tool against the real queue it was built for. Of four
// items already finished, exactly ONE was caught by the verdict alone; the other
// three survived as a comment naming what they replaced, so their premises read
// as holding. The lines were printed and a reader could see it — but leaving the
// signal only in the lines wastes the cheapest evidence available.
//
// REVIEW is advisory and deliberately does not change the exit code: the
// detector is a heuristic, and a false positive drops live work, which is the
// expensive direction.
// ---------------------------------------------------------------------------

{
    const commented = makeRepo('comment-app', {
        'src/gone.ts': '// The "brand colours" add-on was REMOVED on 2026-08-29.\nexport default null;\n',
        'src/live.ts': 'const url = "https://example.invalid/x"; // a trailing note\nexport { url };\n',
        'src/mixed.ts': '// legacyFlag is documented here\nexport const legacyFlag = true;\n',
    });
    void commented;

    const res = run([
        '**CO1 · only in a comment** PREMISE: repo=comment-app expect=present match="brand colours" file=src/gone.ts',
        '**CO2 · code with a trailing comment** PREMISE: repo=comment-app expect=present match="https://example.invalid" file=src/live.ts',
        '**CO3 · in a comment AND in code** PREMISE: repo=comment-app expect=present match=legacyFlag file=src/mixed.ts',
    ].join('\n'));

    check('a match found only inside comments is flagged REVIEW',
        verdictOf(res, 0) === 'REVIEW', res.json);
    // The false positive that a naive line-contains-// check produces. The `//`
    // here is inside a URL and again in a trailing note; the code is live.
    check('a URL containing // in live code is NOT flagged as a comment',
        verdictOf(res, 1) === 'FRESH', res.json);
    check('one real code hit beats any number of comment hits',
        verdictOf(res, 2) === 'FRESH', res.json);
    check('REVIEW does not change the exit code — it is advisory, not a verdict',
        res.status === 0, res.stdout);
    check('...and it is counted apart from fresh',
        res.json && res.json.population.review === 1 && res.json.population.fresh === 2, res.json);
}

{
    // An unquoted phrase silently becomes its first word, and the tool then
    // reports a confident verdict about a string nobody wrote. Refused instead.
    const res = run([
        '**P1 · unquoted phrase** PREMISE: repo=demo-app expect=present match=Unlock brand colours file=src/style-fields.tsx',
        '**P2 · quoted phrase** PREMISE: repo=demo-app expect=present match="Unlock brand colours" file=src/style-fields.tsx',
    ].join('\n'));
    check('an unquoted multi-word match= is refused, not truncated',
        verdictOf(res, 0) === 'UNCHECKABLE', res.json);
    check('...and the reason names what would have been searched',
        res.json && /Unlock/.test(res.json.results[0].why), res.json && res.json.results[0].why);
    check('...while the quoted form is evaluated normally',
        verdictOf(res, 1) === 'REVIEW' || verdictOf(res, 1) === 'FRESH' || verdictOf(res, 1) === 'STALE',
        res.json);
}

{
    // A queue whose premises are ALL uncheckable must exit 2, not 0. "I checked
    // nothing" reported as "nothing is wrong" is the whole failure class.
    const res = run('**Z · prose only**\n   nothing machine-readable here.');
    check('a queue with nothing checkable exits 2, never 0', res.status === 2, res.stdout);
    check('...and says so rather than reporting clear',
        /COULD NOT CHECK/.test(res.stdout) || (res.json && res.json.population.checked === 0), res.stdout.slice(0, 300));
}

{
    // An unknown repo cannot be reported as fresh.
    const res = run('**Y** PREMISE: repo=no-such-repo expect=present match=x\n**Beacon** ' + BEACON);
    check('a premise naming a repo that is not there is uncheckable',
        verdictOf(res, 0) === 'UNCHECKABLE', res.json);
    check('...and the run still checks the others', verdictOf(res, 1) === 'FRESH', res.json);
}

{
    // Attribution. A premise must land under the item whose text precedes it,
    // or the tool reports the wrong item as stale — worse than reporting none.
    const res = run([
        '**ITEM-ONE · first**',
        '   PREMISE: repo=demo-app expect=present match=href="/login" file=src/plan-card.tsx',
        '**ITEM-TWO · second**',
        '   ' + BEACON,
    ].join('\n'));
    const first = res.json && res.json.results[0];
    const second = res.json && res.json.results[1];
    check('a premise on its own line attaches to the item above it',
        !!first && /ITEM-ONE/.test(first.item), first);
    check('...and the next item gets its own, not the previous one\'s',
        !!second && /ITEM-TWO/.test(second.item), second);
    check('...with the stale one attributed to the right item',
        !!first && first.verdict === 'STALE', first);
}

{
    // Two premises on one item are both evaluated. An item is only as fresh as
    // its weakest premise, and stopping at the first is how the second goes
    // unchecked while the item reads as covered.
    const res = run([
        '**MULTI · two premises**',
        '   PREMISE: repo=demo-app expect=present match=href="/login" file=src/plan-card.tsx',
        '   PREMISE: repo=demo-app expect=present match="mode: \\"payment\\"" file=src/checkout.ts',
    ].join('\n'));
    check('both premises on one item are evaluated',
        res.json && res.json.results.length === 2, res.json);
    check('...and a stale one is not hidden by a fresh sibling',
        res.json && res.json.population.stale === 1 && res.json.population.fresh === 1, res.json);
}

// ---------------------------------------------------------------------------

fs.rmSync(fixture, { recursive: true, force: true });

const total = passed + failures.length;
if (failures.length) {
    console.error(`\ncheck-queue-freshness: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`\ncheck-queue-freshness: ${passed}/${total} passed — four stale shapes, and uncheckable kept apart from fresh`);
