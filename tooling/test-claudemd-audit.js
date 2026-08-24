#!/usr/bin/env node
// Tests for plugins/autodev-memory/scripts/claudemd-audit.js - the detector that
// reports PROVABLY stale file references in a repo's CLAUDE.md.
// Run: node tooling/test-claudemd-audit.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS ONE IS A FALSE-POSITIVE SUITE.
//
// The subject's header lists eight precision rules and every one of them was
// learned the same way: a naive version was run over real repos, and each rule
// is the residue of reading a batch of wrong findings by hand. The first rule
// alone turned 16 findings into 1.
//
// So the failure that matters here is not "the detector went quiet" - that is
// loud, because a repo everyone knows has rot suddenly reports "All clear". The
// failure that matters is a rule silently narrowing: a finding reappears, an
// author is sent to edit a CLAUDE.md sentence that was correct, and the output
// looks exactly like a working run. Nothing in the repo pinned any of the eight.
//
// Hence the shape below: for every EXCLUSION rule, a fixture that the rule
// exists to suppress, asserted absent - and beside it, in the SAME repo, a
// control that must still be reported. A rule tested only by its exclusion is
// indistinguishable from a detector that stopped looking; a rule tested only by
// its inclusion says nothing about the false positive it was written for.
//
// THE SEAM.
//
// claudemd-audit.js takes repo paths on argv and reads <repo>/CLAUDE.md, so the
// seam is the argument: every scenario is a fixture repo in a temp dir, and the
// suite drives the shipped CLI as a subprocess. No live repo, no live git state,
// no CLAUDE.md on this machine is read - so this suite cannot pass on a quiet
// day for the wrong reason, and cannot go red because someone edited a doc.
//
// ONE ENVIRONMENT DEPENDENCY, STATED RATHER THAN HIDDEN.
//
// findByBasename() shells out to `find . -name ...`, so the subject needs a
// POSIX find on PATH. Where there is none the call throws, the catch returns [],
// and EVERY finding degrades to MISSING - including the bare names rule 1 exists
// to protect. The bare-name and wrong-path assertions below are therefore also
// the control for that: if they fail together, read it as "this machine has no
// POSIX find and the subject cannot do its job here", not as a code regression.

'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-memory', 'scripts', 'claudemd-audit.js');

let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  (' + detail + ')'}`);
}

function eq(label, actual, expected) {
    check(label, actual === expected,
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// Fixture repos. One per rule, so a red names the rule that broke.
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-audit-'));

const repo = (name) => path.join(fixture, name);

function w(name, rel, body) {
    const p = path.join(fixture, name, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
}

const md = (name, lines) => w(name, 'CLAUDE.md', lines.join('\n') + '\n');

function buildFixture() {
    // -- rule 1: a bare filename in prose is not a path claim -----------------
    // helper.ts is named without a directory and lives three levels down. The
    // naive version resolved bare names against the repo root and reported 16 of
    // these for one real hit. phantom.ts is the control: a bare name that exists
    // NOWHERE is still the one case a bare mention can be wrong about.
    w('bare-name', 'src/deep/helper.ts', 'export const helper = 1;\n');
    md('bare-name', [
        '# Bare names',
        '',
        'The `helper.ts` module does the parsing.',
        'The `phantom.ts` module does nothing at all.',
    ]);

    // -- rule 2: a filename PATTERN is not a filename -------------------------
    // Each of these documents a naming convention and is SUPPOSED not to exist.
    // real-gone.ts is the control - an ordinary path claim in the same document.
    // `src/{name}.ts` is a fifth pattern that never even becomes a ref, because
    // braces are outside the character class one layer earlier; asserted below,
    // since it is the difference between "skipped" and "never seen".
    md('patterns', [
        '# Patterns',
        '',
        'Reports land at `.claude/reports/qa-YYYY-MM-DD.md`.',
        'Each handler is `src/{name}.ts`.',
        'Copy `docs/example.md` when starting one.',
        'Put yours at `path/to/your-file.ts`.',
        'Sprint notes are `docs/sprint-N.md`.',
        'The loader is `src/real-gone.ts`.',
    ]);

    // -- rule 4: a house shorthand is an abbreviation, not a stale path -------
    // The document spells the full path once, which licenses the short form
    // elsewhere. `other-thing/index.ts` is the control: same basename, but it
    // resolves under no prefix this document demonstrates, so it stays a finding.
    w('shorthand', 'supabase/functions/research-tracks/index.ts', 'export {};\n');
    md('shorthand', [
        '# Shorthand',
        '',
        'The handler is `supabase/functions/research-tracks/index.ts`.',
        'To change it, edit `research-tracks/index.ts`.',
        'Unrelated: `other-thing/index.ts`.',
    ]);

    // -- rules 5, 6, 7 and 8, which all live in one block of the subject ------
    //   5  historical prose is a record, not rot            -> skipped
    //   7  historical framing plus a present-tense claim     -> still reported
    //   6  a dead markdown LINK is broken regardless of prose -> still reported
    //   8  ...unless the doc says it is deliberately absent  -> skipped
    // Four refs, none of which exist. Two must be reported and two must not, so
    // neither "flag everything" nor "flag nothing" can pass this repo.
    md('history', [
        '# History',
        '',
        'The `legacy-seed.ts` seeder was deleted on 2026-07-01.',
        'The `categories.ts` file is no longer in the request path, it still exports CATEGORIES.',
        'See the [old checklist](docs/checklist.md) - `docs/checklist.md` was removed last year.',
        'See the [manual pass](docs/local-checklist.md) - `docs/local-checklist.md` is local-only, gitignored.',
    ]);

    // -- rule 3: do not guess where an ambiguous basename moved to ------------
    w('ambiguous', 'pkg/one/index.ts', 'export {};\n');
    w('ambiguous', 'pkg/two/index.ts', 'export {};\n');
    md('ambiguous', [
        '# Ambiguous',
        '',
        'The entry point is `lib/index.ts`.',
    ]);

    // -- the unambiguous counterpart: one match, so say where it went ---------
    w('wrong-path', 'lib/format.ts', 'export {};\n');
    md('wrong-path', [
        '# Moved',
        '',
        'The formatter is `src/utils/format.ts`.',
    ]);

    // -- an absolute ref is counted but never judged --------------------------
    md('absolute', [
        '# Absolute',
        '',
        'The system file is `/etc/hosts.md`.',
    ]);

    // -- a repo with no CLAUDE.md at all -------------------------------------
    fs.mkdirSync(repo('no-file'), { recursive: true });

    // -- a clean repo: every ref resolves, nothing skipped -------------------
    w('clean', 'a.md', '# a\n');
    md('clean', [
        '# Clean',
        '',
        'See `a.md`.',
    ]);
}

// A content census of the whole fixture, so "never edits" is an assertion about
// bytes rather than a promise in a header comment.
function census(dir) {
    const out = [];
    const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
            const p = path.join(d, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) { walk(p, r); continue; }
            out.push(r + ':' + crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
        }
    };
    walk(dir, '');
    return out.join('\n');
}

const ALL = ['bare-name', 'patterns', 'shorthand', 'history', 'ambiguous',
    'wrong-path', 'absolute', 'no-file', 'clean'];

function run(names, extra) {
    const r = spawnSync(process.execPath,
        [SUBJECT, ...names.map(repo), ...(extra || [])], { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const clip = (out) => JSON.stringify(out.slice(0, 900));

/** The findings the JSON report carries for one repo, by name. */
function findingsOf(json, name) {
    const r = json.find((x) => x.repo === name);
    return r ? r.findings : null;
}
function repoOf(json, name) {
    return json.find((x) => x.repo === name) || null;
}
/** One finding as a flat string, so an assertion pins the VALUE not the shape. */
const flat = (f) => f
    ? [f.kind, f.ref, f.actual || '', f.matchCount == null ? '' : f.matchCount].join('|')
    : 'NO-SUCH-FINDING';

// ---------------------------------------------------------------------------

try {
    buildFixture();
    const before = census(fixture);

    const text = run(ALL);
    const jsonRun = run(ALL, ['--json']);
    let json = null;
    try { json = JSON.parse(jsonRun.stdout); } catch { /* asserted below */ }

    // -----------------------------------------------------------------------
    // The report is a report. Callers chain on it; a gate exit would break them.
    // -----------------------------------------------------------------------
    eq('exits 0 even with stale references found', text.status, 0);
    eq('...and writes nothing to stderr', text.stderr, '');
    eq('--json exits 0 as well', jsonRun.status, 0);
    check('--json emits a parseable array, one entry per repo argument',
        Array.isArray(json) && json.length === ALL.length,
        clip(jsonRun.stdout));

    if (!json) { throw new Error('--json did not parse; every assertion below depends on it'); }

    // -----------------------------------------------------------------------
    // RULE 1 - a bare filename in prose is not a path claim.
    //
    // Both halves in one repo: the name that exists somewhere is silent, the
    // name that exists nowhere is still reported. Drop the existence test and
    // the first fires; drop the else-branch entirely and the second goes quiet.
    // -----------------------------------------------------------------------
    {
        const f = findingsOf(json, 'bare-name');
        eq('a bare name that exists somewhere in the repo is not a finding',
            f.filter((x) => x.ref === 'helper.ts').length, 0);
        eq('...while a bare name that exists nowhere still is',
            flat(f.find((x) => x.ref === 'phantom.ts')), 'missing|phantom.ts||');
        eq('...and it is the only finding in that repo', f.length, 1);
        check('...reported with the reason a reader can check',
            text.stdout.includes('  MISSING     phantom.ts  (exists nowhere in the repo)'),
            clip(text.stdout));
        eq('both bare names were checked, not filtered out before the rule ran',
            repoOf(json, 'bare-name').refsChecked, 2);
    }

    // -----------------------------------------------------------------------
    // RULE 2 - a filename PATTERN documents a convention and must not exist.
    // -----------------------------------------------------------------------
    {
        const r = repoOf(json, 'patterns');
        eq('a date pattern, an "example", a "your-" and a bare N are all skipped as patterns',
            r.patternsSkipped, 4);
        eq('...leaving only the real path claim as a finding',
            r.findings.map(flat).join(' '), 'missing|src/real-gone.ts||');
        eq('...and all four skipped refs were counted in the denominator first',
            r.refsChecked, 5);
        check('the header states how many were skipped, so a zero is legible',
            text.stdout.includes('patterns — CLAUDE.md, 9 lines · 5 refs checked · 4 pattern(s) skipped'),
            clip(text.stdout));
        check('a braced placeholder is never recognised as a ref at all',
            !text.stdout.includes('{name}'), clip(text.stdout));
    }

    // -----------------------------------------------------------------------
    // RULE 4 - a house shorthand resolving under a prefix the document itself
    // spells out is an abbreviation, not a stale path.
    //
    // The control matters more than the exclusion here: `other-thing/index.ts`
    // shares the basename, so a rule that skipped by basename rather than by
    // prefix would swallow it and report a clean repo.
    // -----------------------------------------------------------------------
    {
        const f = findingsOf(json, 'shorthand');
        eq('a shorthand path that resolves under a prefix the doc demonstrates is not a finding',
            f.filter((x) => x.ref === 'research-tracks/index.ts').length, 0);
        eq('...while the same basename under no such prefix is still reported',
            flat(f.find((x) => x.ref === 'other-thing/index.ts')),
            'wrong-path|other-thing/index.ts|supabase/functions/research-tracks/index.ts|');
        eq('...and nothing else', f.length, 1);
    }

    // -----------------------------------------------------------------------
    // RULES 5 / 6 / 7 / 8 - four refs, none of which exist, two reported.
    // -----------------------------------------------------------------------
    {
        const r = repoOf(json, 'history');
        const f = r.findings;
        eq('rule 5: a file described as deleted is a record, not rot',
            f.filter((x) => x.ref === 'legacy-seed.ts').length, 0);
        eq('rule 8: a link annotated local-only and gitignored is absent by design',
            f.filter((x) => x.ref === 'docs/local-checklist.md').length, 0);
        eq('...so exactly two mentions were skipped as historical', r.historicalSkipped, 2);

        eq('rule 7: historical framing does not license a present-tense claim',
            flat(f.find((x) => x.ref === 'categories.ts')), 'missing|categories.ts||');
        eq('rule 6: a dead markdown link is broken however the prose frames it',
            flat(f.find((x) => x.ref === 'docs/checklist.md')), 'missing|docs/checklist.md||');
        eq('...and those two are the whole finding list', f.length, 2);
        eq('all four refs were read before any were skipped', r.refsChecked, 4);
        check('the header reports the historical skips beside the refs checked',
            text.stdout.includes('history — CLAUDE.md, 7 lines · 4 refs checked · 2 historical mention(s) skipped'),
            clip(text.stdout));
    }

    // -----------------------------------------------------------------------
    // RULE 3 - an ambiguous basename is named as ambiguous, never resolved to a
    // guess. `index.ts` matched hundreds of files in the repo this came from.
    // -----------------------------------------------------------------------
    {
        const f = findingsOf(json, 'ambiguous');
        eq('an ambiguous basename is reported with its match COUNT',
            flat(f[0]), 'ambiguous|lib/index.ts||2');
        eq('...and only that', f.length, 1);
        check('...and neither candidate path is named at the reader',
            !text.stdout.includes('pkg/one/index.ts') && !text.stdout.includes('pkg/two/index.ts'),
            clip(text.stdout));
        check('...the line says to verify by hand',
            text.stdout.includes('  AMBIGUOUS   lib/index.ts  (2 files share that name — verify by hand)'),
            clip(text.stdout));
    }

    // -----------------------------------------------------------------------
    // The unambiguous case: one match, so the report says where it actually is.
    // -----------------------------------------------------------------------
    {
        eq('a single basename match is reported as a wrong path, with the real one',
            flat(findingsOf(json, 'wrong-path')[0]),
            'wrong-path|src/utils/format.ts|lib/format.ts|');
        check('...printed on its own continuation line',
            text.stdout.includes('  WRONG PATH  src/utils/format.ts\n              → actually at lib/format.ts'),
            clip(text.stdout));
    }

    // -----------------------------------------------------------------------
    // An absolute path belongs to the machine, not the repo. Counted, unjudged.
    // -----------------------------------------------------------------------
    {
        const r = repoOf(json, 'absolute');
        eq('an absolute ref is counted in refs checked', r.refsChecked, 1);
        eq('...but is never judged', r.findings.length, 0);
        eq('...and is not miscounted as a pattern', r.patternsSkipped, 0);
        eq('...nor as a historical mention', r.historicalSkipped, 0);
    }

    // -----------------------------------------------------------------------
    // A repo with no CLAUDE.md is reported as such, not as a clean one.
    // -----------------------------------------------------------------------
    {
        const r = repoOf(json, 'no-file');
        eq('a repo without a CLAUDE.md reports hasFile false', r.hasFile, false);
        eq('...with no findings invented for it', r.findings.length, 0);
        check('...and says so in the text report',
            text.stdout.includes('\nno-file — no CLAUDE.md\n'), clip(text.stdout));
        check('...rather than claiming its references resolve',
            !/no-file — no CLAUDE\.md\n {2}✓/.test(text.stdout), clip(text.stdout));
    }

    // -----------------------------------------------------------------------
    // A clean repo prints the tick, and its header omits both skip clauses -
    // the pair matters: a header that always printed "0 pattern(s) skipped"
    // would make a real skip unremarkable.
    // -----------------------------------------------------------------------
    {
        const r = repoOf(json, 'clean');
        eq('a resolving ref produces no finding', r.findings.length, 0);
        check('...and the repo line reports the tick',
            text.stdout.includes('clean — CLAUDE.md, 4 lines · 1 refs checked\n  ✓ every file reference resolves'),
            clip(text.stdout));
        check('...with no skip clauses on a run that skipped nothing',
            !/clean — CLAUDE\.md[^\n]*skipped/.test(text.stdout), clip(text.stdout));
    }

    // -----------------------------------------------------------------------
    // The total, and the sentence that says nothing was touched.
    // -----------------------------------------------------------------------
    {
        const total = json.reduce((n, r) => n + r.findings.length, 0);
        eq('seven findings across nine repos', total, 7);
        check('...and the summary reports that total, not a repo count',
            text.stdout.includes('\n7 stale reference(s). Nothing was modified.\n'),
            clip(text.stdout.slice(-300)));
    }

    // -----------------------------------------------------------------------
    // A run with nothing to say says "All clear." - a different sentence, so a
    // reader can tell an empty finding list from a zero total.
    // -----------------------------------------------------------------------
    {
        const r = run(['clean', 'absolute', 'no-file']);
        eq('a run with no findings exits 0', r.status, 0);
        check('...and ends with All clear', r.stdout.includes('\nAll clear.\n'), clip(r.stdout));
        check('...never with a stale-reference count of zero',
            !r.stdout.includes('stale reference(s)'), clip(r.stdout));
    }

    // -----------------------------------------------------------------------
    // Read-only, asserted on bytes. The subject shells out inside each repo, so
    // "it only prints" is a claim worth checking rather than trusting.
    // -----------------------------------------------------------------------
    eq('nothing under any scanned repo changed', census(fixture), before);

} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
