#!/usr/bin/env node
// claudemd-audit.js — find PROVABLY stale file references in a CLAUDE.md.
//
// Read-only. Prints findings; never edits.
//
// Usage: node claudemd-audit.js <repo> [<repo>...] [--json]
//
// Three precision rules, each learned by running a naive version against real
// repos and reading every result:
//
//   1. A bare filename in prose ("the errorHandler.ts module") is not a path
//      claim. Resolving it against the repo root produced 16 findings of which
//      one was real. Bare names are only reported when the basename exists
//      NOWHERE in the repo.
//   2. A filename PATTERN is not a filename. `.claude/reports/qa-YYYY-MM-DD.md`
//      documents a naming convention; it is supposed not to exist.
//   3. Do not guess where a file "moved" to when the basename is ambiguous.
//      `index.ts` matches hundreds of files, and naming the first one is worse
//      than saying nothing.

const fs = require('fs');
const path = require('path');
// No child_process. This script spawns nothing, which is the point of the walk
// below: the one command it used to run does not exist on every platform it
// ships to.

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const repos = args.filter((a) => !a.startsWith('--'));

// Rule 2: things that are patterns, not paths.
const PATTERN_REF = /(YYYY|MM|DD|HH|\{|\}|\[|\]|\*|<|>|\bN\b|\.\.\.|example|placeholder|your-|my-)/i;

const REF = /`([A-Za-z0-9_@./-]+\.(?:md|json|jsonc|js|mjs|cjs|ts|tsx|jsx|sh|ps1|yml|yaml|css|sql|toml))`/g;

// Rule 5: a doc may name a file precisely BECAUSE it is gone — "claude.ts was
// deleted 2026-07-01", "replaces the leaderboard-seed.ts plan". Those sentences
// are the historical record and are correct as written; flagging them pushes an
// author to delete their own changelog.
const HISTORICAL = /\b(was |were )?(delet|remov|drop|replac|retir|deprecat|supersed)(e[sd]?|ing)?\b|\b(no longer|used to|formerly|previously|instead of|migrated (from|off))\b/i;

// Rule 7: historical framing does not license a false present-tense claim. One
// real doc said a file was "no longer in the request path — it still exports
// CATEGORIES", about a file that had been deleted outright. The first half is
// history; the second sends a future session to a file that is not there.
const PRESENT_CLAIM = /\b(still (exports?|contains?|holds?|lives?|provides?)|is consumed by|are consumed by|exports?\b|lives in)\b/i;

// Rule 6: a markdown LINK is a navigational claim — "go read this" — so a dead
// one is broken regardless of the surrounding prose...
const linkRe = (ref) => new RegExp('\\]\\(\\s*\\.?/?' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\)');

// ...unless rule 8 applies: the doc says the file is deliberately not in the
// repo. A real doc linked a checklist and annotated it "(local-only,
// gitignored)" — absent by design, on every machine but the author's. Flagging
// that would ask someone to delete a working instruction.
const NOT_IN_REPO = /\b(local[- ]only|gitignored|git-ignored|not (checked in|committed|tracked)|untracked|private|on your machine|machine[- ]local)\b/i;

// Directories that are never part of a repo's own source. Skipped at ANY depth,
// where the shell version only skipped them at the top level: `-not -path
// "./node_modules/*"` cannot match a nested one, so a vendored copy used to be
// walked and reported.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

// Walk the tree in Node rather than shelling out to `find`.
//
// The shell version was unrunnable on a hosted windows runner and nobody could
// see it, because it fails in the one way a try/catch cannot notice.
// [measured 2026-08-30] `find` on windows resolves to System32\find.exe, a text
// SEARCH utility that shares only the name: given these arguments it answers
// "Access denied - ." and "File not found - -NAME", then exits 0. So the catch
// never fires, the caller receives noise instead of paths, and every reference
// in every scanned repo reads as "exists nowhere". 48 assertions, all of them
// silently meaningless.
//
// It passed on this operator's windows machine for the same reason it failed on
// the runner: `where find` there answers Git's usr\bin\find.exe FIRST, and that
// one is POSIX. The suite was green because of one machine's PATH ordering.
//
// Walking in Node removes the dependency rather than repairing it. Same family
// as the hardcoded /bin/sh fixed earlier today: a POSIX tool assumed present.
function findByBasename(repo, base) {
    const out = [];
    const walk = (dir, rel) => {
        let entries;
        // A directory that cannot be read is not a match and not a crash.
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (SKIP_DIRS.has(e.name)) continue;
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
            else if (e.name === base) out.push(childRel);
        }
    };
    walk(repo, '');
    // Forward slashes regardless of platform: these strings are compared against
    // references written in markdown, which are always posix-shaped.
    return out;
}

const results = [];

for (const repo of repos) {
    const file = path.join(repo, 'CLAUDE.md');
    const name = path.basename(repo);
    if (!fs.existsSync(file)) { results.push({ repo: name, hasFile: false, findings: [] }); continue; }

    const text = fs.readFileSync(file, 'utf8');
    const refs = [...new Set([...text.matchAll(REF)].map((m) => m[1]))];
    const findings = [];
    let skippedPatterns = 0;
    let skippedHistorical = 0;

    // Directory prefixes this document itself demonstrates by spelling a full,
    // existing path. These become legal abbreviation roots for shorter refs.
    const shorthandPrefixes = [...new Set(
        refs
            .filter((r) => r.includes('/') && fs.existsSync(path.join(repo, r)))
            .flatMap((r) => {
                const parts = r.split('/').slice(0, -1);
                return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
            })
    )].sort((a, b) => b.length - a.length);

    // Sentences mentioning each ref, for the historical-language test.
    const sentencesFor = (ref) => text.split('\n')
        .filter((l) => l.includes(ref))
        .join(' ');

    for (const ref of refs) {
        if (ref.startsWith('/')) continue;                 // absolute — not ours to judge
        if (PATTERN_REF.test(ref)) { skippedPatterns++; continue; }

        // A dead markdown link is always broken. Otherwise, prose that describes
        // the file as gone is a record, not a rot.
        const isLink = linkRe(ref).test(text);
        const sentences = sentencesFor(ref);
        if (NOT_IN_REPO.test(sentences)) { skippedHistorical++; continue; }
        const contradicts = HISTORICAL.test(sentences) && PRESENT_CLAIM.test(sentences);
        if (!isLink && !contradicts && HISTORICAL.test(sentences)) { skippedHistorical++; continue; }

        const claimsLocation = ref.includes('/');
        const base = path.basename(ref);

        if (claimsLocation) {
            if (fs.existsSync(path.join(repo, ref))) continue;

            // Rule 4: a doc may use a house shorthand — writing
            // `research-tracks/index.ts` for `supabase/functions/research-tracks/index.ts`
            // while spelling the full path elsewhere. If the reference resolves
            // under a prefix this same document uses, it is an abbreviation, not
            // a stale path. Reporting it would push the author to make their own
            // doc more verbose and no more accurate.
            if (shorthandPrefixes.some((p) => fs.existsSync(path.join(repo, p, ref)))) continue;

            const matches = findByBasename(repo, base);
            if (matches.length === 1) {
                findings.push({ ref, kind: 'wrong-path', actual: matches[0] });
            } else if (matches.length === 0) {
                findings.push({ ref, kind: 'missing' });
            } else {
                // Rule 3: ambiguous. Say so; do not pick one.
                findings.push({ ref, kind: 'ambiguous', matchCount: matches.length });
            }
        } else {
            if (findByBasename(repo, base).length === 0) findings.push({ ref, kind: 'missing' });
        }
    }

    results.push({
        repo: name,
        hasFile: true,
        lines: text.split('\n').length,
        refsChecked: refs.length,
        patternsSkipped: skippedPatterns,
        historicalSkipped: skippedHistorical,
        findings,
    });
}

if (asJson) { console.log(JSON.stringify(results, null, 2)); process.exit(0); }

let total = 0;
for (const r of results) {
    if (!r.hasFile) { console.log(`\n${r.repo} — no CLAUDE.md`); continue; }
    console.log(`\n${r.repo} — CLAUDE.md, ${r.lines} lines · ${r.refsChecked} refs checked` +
        (r.patternsSkipped ? ` · ${r.patternsSkipped} pattern(s) skipped` : '') +
        (r.historicalSkipped ? ` · ${r.historicalSkipped} historical mention(s) skipped` : ''));
    if (!r.findings.length) { console.log('  ✓ every file reference resolves'); continue; }
    for (const f of r.findings) {
        total++;
        if (f.kind === 'wrong-path') console.log(`  WRONG PATH  ${f.ref}\n              → actually at ${f.actual}`);
        else if (f.kind === 'missing') console.log(`  MISSING     ${f.ref}  (exists nowhere in the repo)`);
        else console.log(`  AMBIGUOUS   ${f.ref}  (${f.matchCount} files share that name — verify by hand)`);
    }
}
console.log(total ? `\n${total} stale reference(s). Nothing was modified.\n` : '\nAll clear.\n');
