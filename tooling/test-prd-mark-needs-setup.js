#!/usr/bin/env node
'use strict';
// Suite for prd-mark-needs-setup.js — the one writer of `passes: "needs-setup"`.
//
// The property that matters is not that it writes the state; it is that the
// RESULT is read the way the table in CLAUDE.md says: remaining work, not
// actionable work. So every positive case here feeds the written file back
// through prd-states.js and asserts on summarise(), not on the raw string.
//
// Driven as a subprocess, because that is how a skill calls it, and the exit
// code is part of the contract: 2 means "refused, file untouched".
//
// Run: node tooling/test-prd-mark-needs-setup.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'prd-mark-needs-setup.js');
const S = require(path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'prd-states.js'));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mark-needs-setup-')));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
    if (ok) { passed++; return; }
    failures.push(name + (detail !== undefined ? '\n      -> ' + String(detail).slice(0, 400) : ''));
}

let n = 0;
function fixture(prd, { indent = 2 } = {}) {
    const file = path.join(TMP, `prd-${++n}.json`);
    fs.writeFileSync(file, (typeof prd === 'string' ? prd : JSON.stringify(prd, null, indent)) + '\n');
    return file;
}
function run(file, ...args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--prd', file], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', text: fs.readFileSync(file, 'utf8') };
}
const read = (file) => S.storiesOf(JSON.parse(fs.readFileSync(file, 'utf8')));

const FLAT = () => ({
    project: 'fixture',
    stories: {
        'S1-001': { id: 'S1-001', title: 'done', passes: true, notes: 'shipped' },
        'S1-002': { id: 'S1-002', title: 'pending', passes: null, notes: 'the acceptance criterion' },
        'S1-003': { id: 'S1-003', title: 'failed', passes: false, notes: 'x' },
        'S1-004': { id: 'S1-004', title: 'deferred', passes: 'deferred', notes: 'x' },
        'S1-005': { id: 'S1-005', title: 'depends on 002', passes: null, blockedBy: ['S1-002'], notes: 'x' },
    },
});

// ---------------------------------------------------------------- marks
{
    const f = fixture(FLAT());
    const before = S.summarise(read(f));
    const r = run(f, 'S1-002', 'Needs a Supabase project: https://supabase.com/dashboard, then URL + anon key in Vercel env');
    const st = read(f);
    check('mark: exit 0', r.code === 0, r.err);
    check('mark: passes is "needs-setup"', st['S1-002'].passes === 'needs-setup', st['S1-002'].passes);
    check('mark: blockedReason carries the handback', /supabase\.com\/dashboard/.test(st['S1-002'].blockedReason || ''));
    check('mark: blockedAt is a date', /^\d{4}-\d{2}-\d{2}$/.test(st['S1-002'].blockedAt || ''), st['S1-002'].blockedAt);
    check('mark: notes (the acceptance criterion) untouched', st['S1-002'].notes === 'the acceptance criterion');
    check('mark: stdout names the story and the transition', /S1-002 -> needs-setup \(was null\)/.test(r.out), r.out);

    // THE PROPERTY THE TABLE PROMISES: remaining, not actionable.
    const after = S.summarise(st);
    check('summarise: still outstanding (a human is on the hook)', after.outstanding === before.outstanding, [before.outstanding, after.outstanding]);
    check('summarise: no longer actionable (an agent cannot move it)', after.actionable === before.actionable - 1, [before.actionable, after.actionable]);
    check('summarise: counted in needsSetup, not pending', after.needsSetup === 1 && after.pending === before.pending - 1, after);
    check('summarise: nothing unrecognised', after.unrecognised === 0);
    check('isActionable is false on the result', !S.isActionable(st['S1-002']));
    check('isOutstanding is true on the result', S.isOutstanding(st['S1-002']));
    check('a dependent story is not ready while its dep is blocked on a human', !S.isReady(st['S1-005'], st));
    check('summarise.ready excludes the dependent', after.ready === after.actionable - 1, after);
    check('the summary line says "blocked on you" with the id', /blocked on you: S1-002/.test(r.out), r.out);
}

// A failed story may be marked: "tried and failed" can turn out to be "needs a key".
{
    const f = fixture(FLAT());
    const r = run(f, 'S1-003', 'Needs the vendor sandbox enabled at https://vendor.example/console');
    check('a failed (false) story can be marked', r.code === 0 && read(f)['S1-003'].passes === 'needs-setup', r.err);
    check('  and the transition says what it was', /\(was false\)/.test(r.out), r.out);
}

// ---------------------------------------------------------------- refusals
{
    const f = fixture(FLAT());
    const orig = fs.readFileSync(f, 'utf8');
    const r = run(f, 'S9-999', 'anything');
    check('unknown id: exit 2', r.code === 2, r.code);
    check('unknown id: names the id and the population read', /S9-999/.test(r.err) && /5 read/.test(r.err), r.err);
    check('unknown id: file byte-identical', r.text === orig);
}
{
    const f = fixture(FLAT());
    const orig = fs.readFileSync(f, 'utf8');
    const r = run(f, 'S1-001', 'a reason');
    check('done story: exit 2', r.code === 2, r.code);
    check('done story: says why', /done work is not blocked/.test(r.err), r.err);
    check('done story: file byte-identical', r.text === orig);
}
{
    const f = fixture(FLAT());
    const orig = fs.readFileSync(f, 'utf8');
    const r = run(f, 'S1-004', 'a reason');
    check('deferred story: exit 2', r.code === 2, r.code);
    check('deferred story: file byte-identical', r.text === orig);
}
{
    const f = fixture(FLAT());
    const orig = fs.readFileSync(f, 'utf8');
    const r = run(f, 'S1-002', '   ');
    check('empty reason: exit 2', r.code === 2, r.code);
    check('empty reason: file byte-identical', r.text === orig);
    check('empty reason: says what a reason must contain', /console URL/.test(r.err), r.err);
}
{
    const f = fixture('{ not json');
    const r = run(f, 'S1-002', 'a reason');
    check('unparseable prd.json: exit 2, not a crash', r.code === 2, r.code);
    check('unparseable prd.json: left as it was', r.text === '{ not json\n');
}

// ---------------------------------------------------------------- idempotent
{
    const f = fixture(FLAT());
    const first = run(f, 'S1-002', 'Needs an API key from https://example.com/keys');
    const afterFirst = fs.readFileSync(f, 'utf8');
    const second = run(f, 'S1-002', 'Needs an API key from https://example.com/keys');
    check('second identical mark: exit 0', second.code === 0, second.err);
    check('second identical mark: file byte-identical', second.text === afterFirst);
    check('second identical mark: says so', /already needs-setup/.test(second.out), second.out);
    check('first mark did write', first.code === 0 && afterFirst !== JSON.stringify(FLAT(), null, 2) + '\n');

    // A different reason is an update, not a refusal.
    const third = run(f, 'S1-002', 'Needs an API key AND a webhook secret from https://example.com/keys');
    check('changed reason: exit 0 and rewritten', third.code === 0 && /webhook secret/.test(read(f)['S1-002'].blockedReason), third.err);
    check('changed reason: transition says the reason was updated', /reason updated/.test(third.out), third.out);
}

// ---------------------------------------------------------------- clear
{
    const f = fixture(FLAT());
    run(f, 'S1-002', 'Needs a key from https://example.com/keys');
    const r = run(f, 'S1-002', '--clear');
    const st = read(f);
    check('clear: exit 0', r.code === 0, r.err);
    check('clear: passes back to null', st['S1-002'].passes === null, st['S1-002'].passes);
    check('clear: blockedReason and blockedAt removed', !('blockedReason' in st['S1-002']) && !('blockedAt' in st['S1-002']));
    check('clear: notes still untouched', st['S1-002'].notes === 'the acceptance criterion');
    check('clear: actionable again', S.isActionable(st['S1-002']));
    // Clearing means "an agent may now verify and close it", not "it is done":
    // the dependent stays blocked until the setup story itself passes true.
    check('clear: the dependent is still not ready (dep is pending, not done)', !S.isReady(st['S1-005'], st));
    const c = S.summarise(st);
    check('clear: summarise reads it as pending', c.needsSetup === 0 && c.pending === 2, JSON.stringify(c));
    st['S1-002'].passes = true;
    check('  ...and the dependent becomes ready once the dep is closed', S.isReady(st['S1-005'], st));
}
{
    const f = fixture(FLAT());
    const orig = fs.readFileSync(f, 'utf8');
    const r = run(f, 'S1-002', '--clear');
    check('clear on a story that is not needs-setup: exit 2', r.code === 2, r.code);
    check('clear on a story that is not needs-setup: file byte-identical', r.text === orig);
}

// ---------------------------------------------------------------- list
{
    const f = fixture(FLAT());
    run(f, 'S1-002', 'Needs a key from https://example.com/keys');
    run(f, 'S1-003', 'Needs the vendor sandbox at https://vendor.example/console');
    const r = run(f, '--list');
    check('list: exit 0', r.code === 0, r.err);
    check('list: counts 2 blocked on you', /2 blocked on you: S1-002, S1-003/.test(r.out), r.out);
    check('list: prints each reason', /example\.com\/keys/.test(r.out) && /vendor\.example/.test(r.out), r.out);
    check('list: does not write', r.text === fs.readFileSync(f, 'utf8'));
}

// ---------------------------------------------------------------- nested container
{
    const nested = {
        sprints: [
            { id: 'sprint-1', stories: { 'S1-001': { title: 'old', passes: true } } },
            { id: 'sprint-2', stories: { 'S2-001': { title: 'new', passes: null, notes: 'n' } } },
        ],
    };
    const f = fixture(nested);
    const r = run(f, 'S2-001', 'Needs a DNS record at https://registrar.example');
    const prd = JSON.parse(fs.readFileSync(f, 'utf8'));
    check('nested: exit 0', r.code === 0, r.err);
    check('nested: written INSIDE the sprint that holds the story', prd.sprints[1].stories['S2-001'].passes === 'needs-setup');
    check('nested: no root stories object invented', !('stories' in prd));
    check('nested: summarise via storiesOf sees it', S.summarise(S.storiesOf(prd)).needsSetup === 1);
}

// ---------------------------------------------------------------- formatting
{
    const f = fixture(FLAT(), { indent: 4 });
    run(f, 'S1-002', 'Needs a key from https://example.com/keys');
    const text = fs.readFileSync(f, 'utf8');
    check('four-space file stays four-space', /\n    "stories"/.test(text) && !/\n  "stories"/.test(text));
    check('trailing newline preserved', text.endsWith('\n'));
}

// ---------------------------------------------------------------- help
{
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', timeout: 5000 });
    check('--help returns (exit 0) and prints usage', r.status === 0 && /needs-setup/.test(r.stdout), r.status);
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 5000 });
    check('no arguments: usage and exit 2', none.status === 2);
}

fs.rmSync(TMP, { recursive: true, force: true });

if (failures.length) {
    console.error(`prd-mark-needs-setup: ${failures.length} FAILED, ${passed} passed`);
    for (const f of failures) console.error('  FAIL ' + f);
    process.exit(1);
}
console.log(`prd-mark-needs-setup: ${passed}/${passed} passed — one writer, and the result reads as remaining-not-actionable`);
