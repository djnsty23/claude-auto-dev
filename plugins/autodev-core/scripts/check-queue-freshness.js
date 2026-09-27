#!/usr/bin/env node
'use strict';
/**
 * Is this queue still describing the world?
 *
 * WHY. `[measured 2026-08-29]` a fleet queue listed eight items for one repo.
 * FOUR were already shipped and a fifth was half done, and a branch merge was
 * nearly assigned that would have rolled VERSION back two releases and deleted
 * two test suites. Nothing caught it but a coordinator re-reading the trunk by
 * hand, one file at a time.
 *
 * check-assignment.js already answers this for ONE assignment. What was missing
 * is the part that reads premises out of a queue and evaluates them in bulk,
 * which is the only version anybody will actually run before dispatching.
 *
 * THE DESIGN PROBLEM, and it is the whole difficulty: a queue item is prose.
 * "The Pro card CTA never reaches checkout" is not machine-checkable, and no
 * amount of parsing makes it so. So an item must CARRY a premise that is:
 *
 *   PREMISE: repo=<name> expect=<present|absent> match=<string> [file=<path>]
 *
 * Anywhere in the item's text. One item may carry several.
 *
 * `expect` is what the ITEM ASSERTS ABOUT OPEN WORK, not what you hope to find:
 *
 *   expect=present   the item says this string is there and is the problem.
 *                    Gone from the trunk  -> STALE: somebody fixed it.
 *   expect=absent    the item says this string is missing and must be added.
 *                    Now on the trunk     -> STALE: somebody added it.
 *
 * An item with NO premise is UNCHECKABLE and is reported as such. It is never
 * counted as fresh. "I could not check" and "I checked and it is fine" are the
 * two states this codebase keeps collapsing, and a freshness checker that
 * collapses them is the joke version of itself.
 *
 * THREE THINGS IT MUST NOT GET WRONG, all of them measured the same day:
 *
 *  1. A MISSING FILE IS NOT AN ABSENT SYMBOL. One of the four stale items was
 *     stale because the file had been deleted. A grep for a symbol inside a
 *     path that no longer exists returns exactly what a removed symbol returns,
 *     so the two get their own verdicts here and MISSING-FILE never counts as
 *     a satisfied `expect=absent`.
 *
 *  2. A MATCH INSIDE A COMMENT COUNTS AS PRESENT, and that is not a bug to be
 *     fixed. Three of the four stale items were closed with a comment naming
 *     what they replaced ("Both buttons used to be href=/login"), which is what
 *     made the verification cheap. A grep cannot tell code from a note about
 *     the code, so this prints the MATCHING LINES and lets a person read
 *     whether a comment means done or means documented. Printing a verdict
 *     without the lines is how a weak signal becomes a wrong answer.
 *
 *  3. IT READS origin/HEAD, AFTER A FETCH, NEVER THE LOCAL CHECKOUT. Every
 *     stale-premise error that day came from reading a tree that had moved.
 *     --no-fetch exists for offline use and says so loudly in the output,
 *     because a stale read is the exact failure this tool exists to prevent.
 *
 * Usage:
 *   node check-queue-freshness.js --queue ~/path/QUEUE.md
 *   node check-queue-freshness.js --queue Q.md --repo-root ~/Code --no-fetch
 *   node check-queue-freshness.js --queue Q.md --json
 *
 * Exit 3 = at least one premise is STALE or names a MISSING-FILE. Exit 2 =
 * nothing could be checked, which is never reported as clear. Exit 0 = every
 * premise checked still holds.
 *
 * A FAILED GIT CALL IS NOT AN ANSWER. `git grep` exits 1 for "no match" and 128
 * or more for an error, and only the first means absent, and only when stderr
 * is empty: it also exits 1 when it could not read an object. A git call that
 * did not run cleanly makes its premise UNCHECKABLE, with a `why` naming git's
 * exit status and stderr. It counts exactly as a premise-less item does: toward
 * exit 2 when nothing else was checked, never toward exit 3, never as fresh.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const QUEUE = val('queue', null);
const NO_FETCH = has('no-fetch');
const AS_JSON = has('json');

// Repos are named, never pathed. A queue file is shared and frequently lives in
// a public tree, and an absolute path names whatever else the machine holds —
// the same exposure that put private repo paths inside a public checkout on
// 2026-08-29. `repo=qr` resolves here; `repo=/Users/someone/qr` never appears.
const REPO_ROOT = val('repo-root', null) || (() => {
    try { return require(path.join(__dirname, 'claude-paths.js')).codeDir(); }
    catch { return null; }
})();

/**
 * Run git and keep everything it reported: status, signal, spawn error, stderr.
 *
 * This was `catch { return null; }` until 2026-09-26, and every caller read null
 * as "git printed nothing". A `git grep` that died read as zero matches, so an
 * expect=present premise came back STALE; a `cat-file -e` that died read as
 * MISSING-FILE. `[measured 2026-09-25]` a gate went red on the dirty-tree case
 * in tooling/test-check-queue-freshness.js (expects FRESH) with 224 node
 * processes running, and that suite then failed 2 of 21 isolated runs and
 * passed 48 of 48 later. The cause was never captured, because this wrapper
 * threw it away.
 *
 * Only the caller knows which status means "no": 1 for `git grep`, an empty
 * listing for `ls-tree`. So this returns the facts and never a verdict.
 *
 * maxBuffer is 64 MiB, not node's 1 MiB default. At 1 MiB a premise naming a
 * common string (an import, a type name) filled the buffer, spawnSync killed
 * git with ENOBUFS, and a string present thousands of times read UNCHECKABLE.
 * Past 64 MiB it still does, and says ENOBUFS: narrow the premise with file=.
 */
function git(repo, args) {
    const r = spawnSync('git', ['-C', repo].concat(args),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return {
        command: 'git ' + args[0],
        status: r.status,
        signal: r.signal,
        error: r.error ? (r.error.code || r.error.message) : null,
        stdout: r.stdout || '',
        stderr: (r.stderr || '').trim(),
    };
}

/**
 * Did git run to the end, exit with one of `statuses`, and report no error?
 *
 * STDERR COUNTS, and the exit status alone is not enough. `[measured 2026-09-26,
 * git 2.54]` `git grep` over a tree with an unreadable object prints
 * "error: ... unable to read <sha>" and still exits 1 when nothing it DID read
 * matched, and 0 when something did. Either way the search did not cover the
 * tree, so neither "absent" nor "only in comments" can be concluded from it.
 */
function answered(r, statuses) {
    return !r.error && !r.signal && statuses.includes(r.status) && r.stderr === '';
}

/** One line naming the failure: `git grep exited 128: fatal: ...`. */
function describeFailure(r) {
    const how = r.error ? `failed (${r.error})`
        : r.signal ? `was killed by ${r.signal}`
            : `exited ${r.status}`;
    return r.command + ' ' + how + (r.stderr ? ': ' + r.stderr.split('\n')[0] : '');
}

/** The verdict for a git call that did not answer. `notWhat` names the verdict it is not. */
function gitFailed(base, r, notWhat) {
    return Object.assign(base, {
        verdict: 'UNCHECKABLE',
        why: `${describeFailure(r)}. That is git failing to answer, NOT ${notWhat}`,
        gitFailure: { command: r.command, status: r.status, signal: r.signal, error: r.error, stderr: r.stderr },
    });
}

/**
 * Split the queue into items, then pull premises out of each.
 *
 * An item starts at a markdown heading or a bolded/bulleted label and runs to
 * the next one. The exact shape matters less than the guarantee that every
 * PREMISE line lands under the item whose text precedes it, so a premise can
 * never be attributed to the wrong item — which would report the wrong thing as
 * stale, and that is worse than reporting nothing.
 */
const PREMISE_RE = /PREMISE:\s*(.+)$/;

function parseQueue(text) {
    const lines = text.split('\n');
    const items = [];
    let current = null;

    // A `#` HEADING IS A SECTION, NOT AN ITEM. "## qr — the priority project"
    // carries no premise and never will, and counting every heading as an
    // uncheckable item buries the items that genuinely lack one under structural
    // noise — which defeats the purpose of reporting uncheckable at all. The
    // heading is kept as context on the items beneath it instead.
    const isHeading = (l) => /^#{1,6}\s+\S/.test(l);

    const startsItem = (l) =>
        /^\s*[-*]\s+\*\*/.test(l) ||                    // bulleted bold label
        /^\s{0,6}[A-Z]?\w{0,8}\d*[a-z]?\s*·\s*\*\*/.test(l) || // "Q2a · **DONE.**"
        /^\s*\*\*[A-Z]/.test(l);                        // leading bold label

    let section = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isHeading(line)) { section = line.replace(/^#+\s*/, '').trim().slice(0, 80); continue; }
        if (startsItem(line)) {
            current = { label: line.trim().slice(0, 120), section, line: i + 1, premises: [], text: [] };
            items.push(current);
        }
        if (!current) continue;
        current.text.push(line);

        const m = line.match(PREMISE_RE);
        if (m) {
            const p = parsePremise(m[1], i + 1);
            current.premises.push(p);
        }
    }
    return items;
}

/** `repo=qr expect=absent match=billingPortal file=src/x.ts` -> object. */
function parsePremise(spec, lineNo) {
    const out = { raw: spec.trim(), line: lineNo, error: null };
    // Values may be quoted, because a match string can contain spaces and very
    // often does — `href="/login"` is the shape of half of these.
    //
    // ESCAPES ARE HONOURED inside a quoted value, and that is not decoration:
    // the strings these premises search for are usually code, and code is full
    // of quotes. `match="mode: \"payment\""` parsed with a naive `[^"]*` stops
    // at the first inner quote and silently searches for `mode: \` — a premise
    // that then reports STALE because the string it invented is not there.
    // A checker whose failure mode is a confident wrong verdict about staleness
    // is worse than no checker, so the escape is supported and tested.
    for (const m of spec.matchAll(/(\w+)=("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))/g)) {
        const key = m[1];
        let value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
        if (m[3] !== undefined || m[4] !== undefined) value = value.replace(/\\(.)/g, '$1');
        out[key] = value;
    }
    // AN UNQUOTED MULTI-WORD match= IS REFUSED, not silently truncated.
    //
    // Found by running this tool against the real queue it was built for: the
    // premise `match=Unlock brand colours` parses as `Unlock`, because an
    // unquoted value ends at the first space. It then searched for a string
    // nobody wrote and reported a verdict about it with full confidence. That is
    // the same failure as the escaped-quote case above and worse than an error,
    // because the output looks like an answer.
    //
    // A trailing word that is itself `key=value` is the next field and is fine;
    // anything else means the author meant a phrase and did not quote it.
    const rawMatch = spec.match(/match=(?!["'])(\S+)((?:\s+\S+)*)/);
    if (rawMatch && rawMatch[2]) {
        const trailing = rawMatch[2].trim().split(/\s+/).filter(Boolean);
        if (trailing.some((w) => !/^\w+=/.test(w))) {
            out.error = 'match= has unquoted spaces, so only ' + JSON.stringify(rawMatch[1])
                + ' would be searched — quote the whole phrase';
        }
    }

    if (out.error) { /* keep the first, most specific complaint */ }
    else if (!out.repo) out.error = 'no repo=';
    else if (!out.match) out.error = 'no match=';
    else if (out.expect !== 'present' && out.expect !== 'absent') {
        out.error = 'expect= must be present or absent, got ' + JSON.stringify(out.expect || '');
    }
    return out;
}

/**
 * Evaluate one premise against origin/HEAD.
 *
 * Returns a verdict object. Every path out of here is named: there is no branch
 * that returns "fine" because something could not be established.
 */
const fetched = new Set();

/**
 * Does EVERY match sit on a line that is a comment?
 *
 * Deliberately conservative, because the cost of the two errors is not
 * symmetric. Saying "review this" about live code wastes a reader's minute;
 * saying "still open" about finished work re-assigns a session's whole turn,
 * which is the incident. So this only fires when EVERY match looks like a
 * comment — one plain code hit and the answer is no.
 *
 * It tests the text BEFORE the match, not the whole line: a `//` that appears
 * after the match (inside a URL, or a trailing note on a real line of code)
 * does not make the code above it a comment. `"https://x"` in live code is the
 * case that breaks a naive line-contains-slash-slash check, and it is tested.
 */
function allMatchesAreComments(matches) {
    if (!matches.length) return false;
    return matches.every((m) => {
        // "file:line:text" — split off exactly two leading fields.
        const parts = m.split(':');
        const text = parts.length > 2 ? parts.slice(2).join(':') : m;
        const t = text.trim();
        return /^(\/\/|\/\*|\*|#|<!--|--|;)/.test(t) || /^\{\s*\/\*/.test(t);
    });
}

function evaluate(p) {
    const base = { premise: p, matches: [] };
    if (p.error) return Object.assign(base, { verdict: 'UNCHECKABLE', why: p.error });
    if (!REPO_ROOT) {
        return Object.assign(base, {
            verdict: 'UNCHECKABLE',
            why: 'no repo root — pass --repo-root or set AUTODEV_CODE_DIR',
        });
    }

    const repo = path.join(REPO_ROOT, p.repo);
    if (!fs.existsSync(path.join(repo, '.git'))) {
        return Object.assign(base, { verdict: 'UNCHECKABLE', why: `no git repository at ${p.repo}` });
    }

    if (!NO_FETCH && !fetched.has(repo)) {
        fetched.add(repo);
        // A failed fetch is NOT fatal — the ref may still be readable from the
        // last fetch — but it is recorded, so a verdict taken from a stale
        // remote is never presented as a verdict taken from a current one.
        const fetch = git(repo, ['fetch', '--quiet', 'origin']);
        if (fetch.error || fetch.status !== 0) base.fetchFailed = describeFailure(fetch);
    }

    // origin/HEAD is unset on many clones, and the 128 it exits with there is
    // expected, so only the fallback's failure is reported as git's.
    const head = git(repo, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
    let ref = !head.error && head.status === 0 ? head.stdout.trim() : '';
    if (!ref) {
        const main = git(repo, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
        if (answered(main, [0])) ref = 'origin/main';
        else if (answered(main, [1])) {
            return Object.assign(base, { verdict: 'UNCHECKABLE', why: 'could not resolve origin/HEAD' });
        } else return gitFailed(base, main, 'a missing origin/HEAD');
    }
    base.ref = ref;

    // THE FILE, FIRST AND SEPARATELY. A grep scoped to a path that is gone
    // returns "no matches", which is byte-identical to a symbol that was
    // removed from a file still there. One of the four stale items was stale
    // for exactly this reason, so it gets its own verdict rather than being
    // folded into `absent`.
    //
    // `ls-tree`, not `cat-file -e`. `[measured 2026-09-26, git 2.54]` cat-file
    // exits 128 both for a path absent from the tree and for a tree it cannot
    // read, and exits 1 for a path whose blob is unreadable, so none of its
    // statuses means "missing" alone. ls-tree exits 0 with an EMPTY listing
    // when the path is absent and reports anything else as a failure.
    if (p.file) {
        const entry = git(repo, ['ls-tree', '--name-only', ref, '--', p.file]);
        if (!answered(entry, [0])) return gitFailed(base, entry, 'a missing file');
        if (!entry.stdout.trim()) {
            return Object.assign(base, {
                verdict: 'MISSING-FILE',
                why: `${p.file} does not exist on ${ref}`,
            });
        }
    }

    // git grep exits 0 on a match and 1 on none. Any other outcome, or any
    // stderr, is a search that did not happen, and reading it as "no match" is
    // how a crashed grep reported finished work.
    const args = ['grep', '-n', '--fixed-strings', '-e', p.match, ref];
    if (p.file) args.push('--', p.file);
    const found = git(repo, args);
    if (!answered(found, [0, 1])) return gitFailed(base, found, 'an absent string');
    const hits = found.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

    // git grep prefixes every line with "<ref>:" — strip it so the output reads
    // as file:line:text, which is what a person can click.
    base.matches = hits.map((h) => (h.startsWith(ref + ':') ? h.slice(ref.length + 1) : h));
    const present = base.matches.length > 0;

    if (p.expect === 'present') {
        if (present && allMatchesAreComments(base.matches)) {
            // MEASURED, on the real queue this tool was built for: of four items
            // already done, ONE was caught by the verdict alone. The other three
            // survived only as a comment naming what they replaced — "the add-on
            // button was removed on 2026-08-29" — so the premise read as holding
            // while the work was finished.
            //
            // That is the documented behaviour and it is correct: a grep cannot
            // tell code from a note about the code, and guessing would turn a
            // weak signal into a wrong verdict. But leaving the signal only in
            // the printed lines wastes the cheapest evidence there is, so it
            // gets its own bucket.
            //
            // Advisory, NOT a verdict: the exit code is unchanged, because the
            // detector is a heuristic and a false positive here would drop live
            // work. It says "read this one" and nothing stronger.
            return Object.assign(base, {
                verdict: 'REVIEW',
                why: `"${p.match}" appears ONLY inside comments — often what a finished item leaves behind`,
            });
        }
        return Object.assign(base, present
            ? { verdict: 'FRESH', why: 'the string the item names is still there' }
            : { verdict: 'STALE', why: `"${p.match}" is GONE from ${ref} — this looks done` });
    }
    return Object.assign(base, present
        ? { verdict: 'STALE', why: `"${p.match}" is now PRESENT on ${ref} — this looks done` }
        : { verdict: 'FRESH', why: 'still absent, so the work it describes remains' });
}

// ---------------------------------------------------------------- run

// The two refusals below were top-level guards above the function definitions
// until 2026-09-08. They moved here with everything else that can exit: no path
// in this process may call process.exit(), because on POSIX a pipe is an async
// stream and exiting discards whatever has not drained. See the foot of the file.
function main() {
    if (!QUEUE) {
        console.error('REFUSING: --queue <file> is required.');
        console.error('  usage: check-queue-freshness.js --queue <path> [--repo-root <dir>]');
        console.error('         [--no-fetch] [--json]');
        return 2;
    }
    if (!fs.existsSync(QUEUE)) {
        console.error(`COULD NOT CHECK: no queue file at ${QUEUE} — this is NOT "the queue is fresh".`);
        return 2;
    }

    const items = parseQueue(fs.readFileSync(QUEUE, 'utf8'));
    const results = [];
    for (const item of items) {
        if (!item.premises.length) {
            results.push({ item, verdict: 'UNCHECKABLE', why: 'no PREMISE: line', matches: [] });
            continue;
        }
        for (const p of item.premises) results.push(Object.assign({ item }, evaluate(p)));
    }

    const stale = results.filter((r) => r.verdict === 'STALE');
    const missing = results.filter((r) => r.verdict === 'MISSING-FILE');
    const unchk = results.filter((r) => r.verdict === 'UNCHECKABLE');
    const review = results.filter((r) => r.verdict === 'REVIEW');
    const fresh = results.filter((r) => r.verdict === 'FRESH');
    const checked = stale.length + missing.length + fresh.length + review.length;
    // A subset of uncheckable, counted apart: "the queue carried nothing to
    // check" and "git failed while checking" need different fixes.
    const gitFailures = results.filter((r) => r.gitFailure);

    if (AS_JSON) {
        console.log(JSON.stringify({
            queue: QUEUE,
            fetched: !NO_FETCH,
            population: {
                items: items.length,
                premises: results.length,
                checked,
                stale: stale.length,
                missingFile: missing.length,
                review: review.length,
                fresh: fresh.length,
                uncheckable: unchk.length,
                gitFailed: gitFailures.length,
            },
            results: results.map((r) => ({
                item: r.item.label,
                line: r.item.line,
                verdict: r.verdict,
                why: r.why,
                premise: r.premise ? r.premise.raw : null,
                matches: r.matches,
                gitFailure: r.gitFailure,
            })),
        }, null, 2));
    } else {
        console.log(`QUEUE FRESHNESS  ${QUEUE}`);
        console.log(`  ${items.length} item(s), ${results.length} premise(s), `
            + `${checked} checked against origin/HEAD` + (NO_FETCH ? '  [--no-fetch: NOT re-fetched]' : ''));
        const fetchFailure = results.find((r) => r.fetchFailed);
        if (fetchFailure) {
            console.log('  WARNING: a fetch failed. Verdicts below may be taken from a stale remote.');
            console.log(`           ${fetchFailure.fetchFailed}`);
        }
        if (gitFailures.length) {
            console.log(`  WARNING: git itself failed on ${gitFailures.length} premise(s). They are listed as`);
            console.log('           UNCHECKABLE with git\'s own error, and are neither stale nor fresh.');
        }
        console.log('');

        for (const group of [
            ['STALE — the queue is describing work that appears done', stale],
            ['MISSING-FILE — the path the item names is gone', missing],
            ['REVIEW — present only inside comments, which is what a finished item leaves behind', review],
            ['UNCHECKABLE — reported, never counted as fresh', unchk],
            ['FRESH — the premise still holds', fresh],
        ]) {
            const [title, rows] = group;
            if (!rows.length) continue;
            console.log(`  ${title}: ${rows.length}`);
            for (const r of rows) {
                console.log(`    [line ${r.item.line}] ${r.item.label}`);
                console.log(`        ${r.verdict}: ${r.why}`);
                // THE LINES, not just the verdict. A comment naming what it replaced
                // is the cheapest evidence there is, and only a reader can tell that
                // from live code.
                for (const m of r.matches.slice(0, 6)) console.log(`          ${m}`);
                if (r.matches.length > 6) console.log(`          ...and ${r.matches.length - 6} more`);
                if (r.matches.length) {
                    console.log('          (a match inside a COMMENT still counts as present —');
                    console.log('           read the lines before trusting the verdict)');
                }
            }
            console.log('');
        }

        // The summary never says "clear" without naming what went unchecked in the
        // same breath. That collapse is the failure this tool is about.
        if (!checked) {
            console.log('COULD NOT CHECK: 0 premises were evaluated. This is NOT "the queue is fresh".');
            // A premise git failed on is not missing from the queue, so the
            // advice to add one is for the rest only.
            if (gitFailures.length) {
                console.log(`  git failed on ${gitFailures.length} premise(s), named above: fix git, not the queue.`);
            }
            const bare = unchk.length - gitFailures.length;
            if (bare) {
                console.log(`  ${bare} item(s)/premise(s) carried nothing checkable. Add a line like:`);
                console.log('    PREMISE: repo=<name> expect=absent match="someSymbol" file=src/x.ts');
            }
        } else if (stale.length || missing.length) {
            console.log(`LIKELY STALE: ${stale.length} premise(s) falsified, ${missing.length} missing file(s), `
                + `out of ${checked} checked — and ${unchk.length} that could not be checked at all.`);
            console.log('  Re-read those items on the trunk before assigning any of them.');
            if (review.length) {
                console.log(`  ${review.length} more matched ONLY inside comments — read those too; on the real`);
                console.log('  queue this was built for, that was the shape of 3 of the 4 finished items.');
            }
        } else {
            console.log(`NO PREMISE FALSIFIED: ${fresh.length} of ${checked} checked still hold`
                + (review.length ? `, ${review.length} matched only inside COMMENTS and want a human` : '')
                + ` — and ${unchk.length} could NOT be checked, which is not the same as fine.`);
        }
    }

    if (stale.length || missing.length) return 3;
    if (!checked) return 2;
    return 0;
}

// process.exit() TRUNCATES output, and only on some platforms.
//
// node's process.stdout is ASYNCHRONOUS when it is a PIPE on POSIX (Linux and
// macOS alike) and synchronous when it is a pipe on win32; it is synchronous
// for a FILE everywhere. process.exit() terminates without draining a
// pending async write, so a run that prints more than the 64KiB OS pipe buffer
// and then exits delivers exactly 65536 bytes — under exit status 0, because
// the write never failed. A silent wrong answer, not a visible failure. The
// three things that hide it: a file redirect is synchronous so the output looks
// whole, the status is 0 so CI stays green (a Linux pipe is asynchronous too,
// so CI is exposed and cannot see it), and nothing compares byte counts.
//
// Setting process.exitCode instead lets the event loop drain the stream and
// exit on its own with the same status. Nothing here holds the loop open.
// See rendered-layout-gate.js for the case that cost this, and CLAUDE.md under
// conventions that have actually cost something.
process.exitCode = main();
