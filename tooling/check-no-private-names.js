#!/usr/bin/env node
// check-no-private-names.js — this repo is PUBLIC; private project names are not.
//
// Why this exists, and why it is a denylist rather than a scan:
//
// Four tracked files named three private codebases — one of them a client
// deliverable — alongside their per-repo defect rates. Nothing was secret, and
// that was never the point: a team's defect rate is theirs to publish, and this
// tool had published it for them. Found by asking whether the repo should be
// private, not by anything failing.
//
// The precedent is one of those repos' own preflight, which carries a tripwire
// against verbatim chat quotes in tracked markdown, reasoning "every private
// repo is eventually public". That repo is private and has the guard. This one
// is public and had none.
//
// A GENERIC detector was considered and rejected: "a lowercase word that looks
// like a project name" has no precision at all in a repo full of skill names,
// hook names and CLI flags. A denylist of the names you actually work with is
// small, exact, and the failure mode is benign — you add a name when you start
// a project, and forget one only for a project this repo never discusses.
//
// ---------------------------------------------------------------------------
// WHY THE LIST IS HASHED. DO NOT "RESTORE" THE PLAINTEXT FOR READABILITY.
// ---------------------------------------------------------------------------
//
// Until 2026-08-22 this file listed the names in plaintext, and it was the
// worst leak in the repo: the file that exists to stop a public artefact naming
// a client was itself the public artefact naming them. A denylist discloses
// exactly what it protects. Anyone auditing this repo for a client list would
// have found the canonical, curated one right here — shorter and more reliable
// than grepping for it.
//
// So the names are stored as digests. A token is normalised and hashed, and the
// digest is compared against DIGESTS. The detector keeps working with no name
// written down anywhere in the tree. Two consequences worth knowing:
//
//   * The self-exemption is gone. This file used to be in ALLOW because it "IS
//     the list"; it no longer contains a name, so it is scanned like everything
//     else. The check now covers itself.
//   * You cannot read the list. That is the feature. `--list` prints digests.
//
// HONEST LIMIT: the hash is unsalted, so this is obfuscation, not secrecy. A
// determined reader with a wordlist of plausible project names can confirm a
// guess. It is unsalted deliberately — a salt kept in the repo protects nothing,
// and a salt kept out of it means nobody else can run `--digest` or reproduce a
// check. What this buys is real and bounded: the repo no longer HANDS OVER the
// list, and a digest pasted into a search engine returns nothing, because
// PREFIX below is mixed in before hashing. Treat it as "you must already know
// the name to confirm it", never as "the name is secret".
//
// ADD A NAME WITHOUT EVER COMMITTING IT:
//
//   node tooling/check-no-private-names.js --digest <name>
//
// It prints one hex line. Append that line to DIGESTS. The name itself never
// enters the repo, the diff, or the commit message. `--digest` also reads stdin
// when given no argument, if you would rather keep it out of shell history too.
//
// Usage:
//   node tooling/check-no-private-names.js                  scan the work tree
//   node tooling/check-no-private-names.js --list           print the digests
//   node tooling/check-no-private-names.js --digest <name>  print one digest
//   node tooling/check-no-private-names.js --check-text F   scan one file's text
//   node tooling/check-no-private-names.js --check-message F  ditto, for a commit
//                                                             message (# lines
//                                                             are ignored)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Mixed in before hashing so a digest here is not the bare sha256 of a common
// word, which any online lookup table would resolve instantly. Not a secret and
// not a salt — it is in the file, on purpose, so `--digest` is reproducible by
// anyone holding the name. Changing it invalidates every digest below.
const PREFIX = 'autodev/no-private-names/v1:';
const DIGEST_LEN = 16; // 64 bits — collision odds against a 10-entry list are ~1e-14

// Normalisation happens on BOTH sides or nothing ever matches: the candidate
// token from the scanned text and the name passed to `--digest` go through this
// same function. Lowercase, then drop everything that is not a letter or digit,
// so `Zarble-Widget`, `zarble_widget` and `ZARBLEWIDGET` all reduce to one form.
// (Examples here are synthetic on purpose — this file is scanned like any other,
// and a real name in a comment would be the leak all over again.)
const normalise = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const digest = (s) =>
    crypto.createHash('sha256').update(PREFIX + normalise(s)).digest('hex').slice(0, DIGEST_LEN);

// Private codebases discussed in this repo's docs, and anything else that should
// never appear in a public artefact. Digests, not names — see the block above.
// Case-insensitive and punctuation-insensitive by construction.
//
// Sorted, so the order carries no information either — an append-ordered list
// would say which entries are recent, and "recent" is a hint about which project
// is active. Re-sort after adding one.
const DIGESTS = [
    '12fb5ca517035265',
    '3a437ea789246759',
    '7c4cb7e522b20b38',
    '935adb84abd3322e',
    '97a5e8ca41e11721',
    'a09c341cc3da5c56',
    'a877b9437d9736a4',
    'b10fb05467abe0a2',
    'c8b7aa8568bc0bfe',
];
const DIGEST_SET = new Set(DIGESTS);

// Files that may legitimately carry a name: none today, and none needed — this
// file no longer holds any. Kept so an exemption is a deliberate, reviewed line
// rather than a regex someone loosened.
const ALLOW = new Set([]);

// Candidate tokens from one line of text.
//
// Unigrams reproduce the old `\b(name)\b` behaviour. Adjacent pairs and triples
// are joined as well, which the regex version could not do: two of the entries
// below are compound product names whose real-world spelling has a space or a
// dot in it, so the plaintext detector matched the squashed form and missed the
// way the name is actually written. `Some Product`, `some-product` and
// `SomeProduct` are one candidate here. Measured on this tree: the n-gram pass
// found one genuine leak the word-boundary regex could not see.
const N = 3;
function candidates(line) {
    const toks = line.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < toks.length; i++) {
        let joined = '';
        for (let k = 0; k < N && i + k < toks.length; k++) {
            joined += toks[i + k];
            out.push(joined);
        }
    }
    return out;
}

// Hashing every token of a 200-file tree is the only cost this check has, and
// token repetition is enormous in prose, so memoise. Measured: the cache turns
// ~500k hashes into ~40k.
const memo = new Map();
function isListed(token) {
    let d = memo.get(token);
    if (d === undefined) { d = digest(token); memo.set(token, d); }
    return DIGEST_SET.has(d);
}

// Returns [{ ln, token, text }] for one blob of text. Exported for reuse.
function scanText(src) {
    const found = [];
    src.split('\n').forEach((line, i) => {
        for (const c of candidates(line)) {
            if (isListed(c)) {
                found.push({ ln: i + 1, token: c, text: line.trim().slice(0, 90) });
                return; // one report per line, as before
            }
        }
    });
    return found;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
    if (argv.includes('--digest')) {
        const i = argv.indexOf('--digest');
        const word = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
            ? argv[i + 1]
            : fs.readFileSync(0, 'utf8').trim();
        if (!normalise(word)) {
            console.error('--digest: give a name, as an argument or on stdin');
            return 1;
        }
        console.log(digest(word));
        return 0;
    }

    if (argv.includes('--list')) {
        // Digests, never names. A caller that wants to know HOW MANY names are
        // armed can count these lines; a caller that wants the names cannot.
        console.log(DIGESTS.join('\n'));
        return 0;
    }

    // Scan a single file's text — used by the commit-msg hook, so the hook does
    // not have to reimplement normalisation in shell and drift from it.
    const textFlag = argv.find((a) => a === '--check-text' || a === '--check-message');
    if (textFlag) {
        const file = argv[argv.indexOf(textFlag) + 1];
        if (!file || !fs.existsSync(file)) {
            console.error(`${textFlag}: no such file: ${file}`);
            return 2;
        }
        let src = fs.readFileSync(file, 'utf8');
        // git's own template comments never become part of a commit message.
        if (textFlag === '--check-message') {
            src = src.split('\n').map((l) => (l.startsWith('#') ? '' : l)).join('\n');
        }
        const found = scanText(src);
        if (!found.length) return 0;
        for (const h of found) console.error(`  ${h.ln}: ${h.text}`);
        return 1;
    }

    // Tracked files PLUS untracked-but-not-ignored ones.
    //
    // `git ls-files` alone was the gap, and it let a real leak through the same
    // day this file shipped: a handoff doc naming all three private repos was
    // written, `validate.js` was run and passed, and only THEN was the file
    // `git add`ed and pushed to the public remote. The check could not see it,
    // because it was not tracked yet — which is precisely the moment a new file
    // needs checking. The window is every new file, every time, and it closed
    // only after the push.
    //
    // `--others --exclude-standard` adds untracked files while still honouring
    // .gitignore, so scratch and build output stay out.
    // Returns [] rather than throwing when git is unavailable or this is not a
    // work tree. The throw was worse than the false pass it replaced: an
    // uncaught ENOENT/fatal killed the script before the population floor below
    // could give a readable refusal, so the failure mode was a stack trace
    // instead of an answer.
    const listed = (args) => {
        try {
            return execSync(`git ls-files ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
                .split('\n').filter(Boolean);
        } catch { return []; }
    };
    const tracked = [...new Set([...listed(''), ...listed('--others --exclude-standard')])];

    // POPULATION FLOOR. `git ls-files` returning nothing — run outside a work
    // tree, a broken git, an empty index — would make this report "0 files,
    // clean" and exit 0. A false all-clear on a PUBLIC repo is the one answer
    // this check must never give, and it is indistinguishable from a real pass
    // in the output.
    if (!tracked.length) {
        console.error('\n[no-private-names] REFUSING: git listed 0 files.\n');
        console.error('This check cannot clear a repo it could not read. Verify you are inside the');
        console.error('work tree and that `git ls-files` returns something.\n');
        return 1;
    }

    // Same floor, one level down: a denylist that has been emptied by a bad
    // edit would clear every file in the repo and look identical to a pass.
    if (!DIGESTS.length) {
        console.error('\n[no-private-names] REFUSING: the denylist is empty.\n');
        console.error('Add digests with --digest, or delete this check deliberately.\n');
        return 1;
    }

    // ABSOLUTE HOME PATHS. A separate class from a denylisted name, and the
    // reason it needs its own detector: this file matches NAMES against digests,
    // so a path under a user's home directory leaks an account name while being
    // clean against every digest. The gate reports "clean" and is correct.
    //
    // [measured 2026-08-26] a sibling repo was about to track five generator
    // scripts that had only ever lived in a gitignored directory. They carried
    // EIGHT hardcoded absolute paths containing the username, plus an output
    // path pinned to one clone which was itself a live bug: running a generator
    // from a worktree wrote its output into the main clone. That is the general
    // shape. Code that was never going to be committed accumulates
    // machine-specific constants precisely because nothing ever checked it, and
    // the moment it becomes publishable every one of them ships. Not
    // hypothetical here: .gitignore deliberately narrows rather than ignoring
    // .claude/ wholesale, so files under it are one `git add -A` from public.
    //
    // IT MATCHES THIS MACHINE'S OWN HOME DIRECTORY, NOT ANY HOME-SHAPED PATH.
    // The first version matched structurally, on the reasoning that it would
    // then work on any clone. That was wrong, and its first real run said so:
    // 31 findings of which the first three were `/Users/CHANGEME/`, a comment
    // about `'/home/my-project'` normalisation, and the hosted CI account's own
    // home directory. Structural matching cannot tell a personal account from a
    // placeholder or a shared one, and a detector at that precision gets muted,
    // after which it misses the real thing. Precision is the whole value.
    //
    // That third example is written in prose rather than spelled out, and the
    // reason is this file's own subject. Spelled out, it is a literal that
    // matches the slash pattern below whenever this runs AS that account, so
    // the comment arguing for precise matching was itself a finding on every
    // windows CI run. Third instance of that shape in one day.
    //
    // Keying on os.homedir() narrows it to the only case that is definitely a
    // leak from THIS clone, which is also the only case a pre-publish gate on
    // this machine can be certain about. The cost is real and worth stating: a
    // path naming a DIFFERENT person's home directory passes here. That is a
    // deliberate trade of recall for precision, not an oversight.
    const os = require('os');
    const LOCAL_USER = path.basename(os.homedir() || '');
    // TWO SPELLINGS, and the second is the one that actually leaks here.
    //
    // The first version matched only slash-delimited paths. That misses the
    // DASH-ENCODED form Claude Code uses to name project directories,
    // `C--Users-<name>-Downloads-code-autodev`: the same home path with every
    // separator rewritten. It appears in transcript paths, config keys and
    // tooling constants, so it is arguably likelier to be committed than the
    // slash form.
    //
    // [measured 2026-08-26] the shipped detector exited 0 on a planted
    // dash-encoded username and 1 on a slash-delimited one, in the same file
    // seconds apart. Found because a peer hit this class in another repo: a
    // constant holding the encoded form sat twelve lines above the function
    // that scrubs the slash form out of every file it copies. Their scrubber
    // covered two of three spellings for months and read as complete.
    //
    // The general shape outlasts the fix: a detector that matches one
    // ENCODING of a value is not a detector for the value. Enumerate the
    // spellings before deciding a pattern covers it, and test each, because a
    // partial detector reports clean with total confidence.
    // The segment ABOVE the home directory: "Users" on Windows and macOS,
    // "home" on Linux. Derived rather than listed, so it needs no maintenance
    // and cannot be wrong about a machine nobody anticipated.
    const HOME_PARENT = path.basename(path.dirname(os.homedir() || '')) || '';
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // THIS HALF CAN ONLY EVER SEE ONE PERSON'S HOME, and on a hosted runner
    // that person does not exist.
    //
    // Every pattern below is keyed on os.homedir(), so the half detects paths
    // belonging to THIS host's account and no other. On a build runner that
    // account is an artifact of the platform, which makes the check
    // structurally incapable of catching what it exists for: a developer's home
    // path committed to the repo.
    //
    // [measured 2026-08-30] with the home directory set as a hosted runner has
    // it, a developer's home path planted in a tracked file is NOT CAUGHT in
    // either spelling, slash or dash-encoded. Run as that developer, both are
    // caught. The half is not merely less useful there, it is blind.
    //
    // Narrowing the pattern (above) stops it reporting nonsense there. It does
    // NOT make it protective, and a quiet check that protects nothing reads
    // exactly like a passing one. So say so, out loud, and keep the count out
    // of the clean line rather than reporting "0 absolute home paths" for a
    // scan that never ran.
    //
    // The NAMES half is unaffected and runs everywhere. That is the half a
    // public repo actually depends on, and it is keyed on a denylist rather
    // than on whoever happens to own this machine.
    const CI_HOST = process.env.GITHUB_ACTIONS ? 'GITHUB_ACTIONS'
        : (process.env.CI ? 'CI' : '');
    const HOME_PATH = !CI_HOST && LOCAL_USER && LOCAL_USER.length >= 3
        ? [
            new RegExp('[\\\\\\\\/]' + LOCAL_USER.replace(/[.*+?^${}()|[\]\\\\]/g, '\\\\$&') + '[\\\\\\\\/]', 'gi'),
            // Dash-encoded, and anchored on the PARENT SEGMENT rather than on a
            // bare leading dash.
            //
            // The comment above already named the risk: an unanchored username
            // matches inside unrelated identifiers, and a noisy check gets
            // muted. A single leading dash is not enough to prevent that when
            // the username is an ordinary word.
            //
            // [measured 2026-08-30] on a GitHub-hosted ubuntu runner the build
            // account's name IS an ordinary English word, so LOCAL_USER became
            // that word and the dash pattern reduced to it surrounded by
            // hyphens. It then matched `tooling/test-runner-guard.js`, whose
            // filename contains the same word between hyphens for entirely
            // unrelated reasons. Six findings across three files, not one of
            // them a leak, on every CI run forever: the gate could not pass on
            // Actions at all.
            //
            // Requiring the parent segment keeps exactly what the dash form was
            // built to catch, because the encoding rewrites EVERY separator and
            // therefore always carries the parent: `C--<parent>-<user>-project`
            // is the shape, with the real values substituted. It drops only
            // matches that were never a path to begin with.
            //
            // The examples above are deliberately written with placeholders.
            // An earlier draft of this very comment spelled the runner's real
            // home out in full and tripped the pattern it documents, which is
            // the same trap in a smaller costume: an example realistic enough
            // to illustrate a rule is realistic enough to fire it.
            HOME_PARENT
                ? new RegExp(esc(HOME_PARENT) + '-' + esc(LOCAL_USER) + '(?=[-\\b])', 'gi')
                // No parent segment, e.g. a home directory at the filesystem
                // root. Fall back to the original, broader form rather than
                // silently dropping the check: over-reporting is recoverable
                // here and a missing detector is not.
                : new RegExp('-' + esc(LOCAL_USER) + '(?=[-\\b])', 'gi'),
          ]
        : null;

    function scanHomePaths(src) {
        if (!HOME_PATH) return [];
        const out = [];
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
            let hit = false;
            for (const re of HOME_PATH) {
                re.lastIndex = 0;
                if (re.test(lines[i])) { hit = true; break; }
            }
            if (!hit) continue;
            // Redact the account name in the OUTPUT. A gate that prints the
            // secret it found is a second copy of the leak, and this one's
            // output lands in transcripts and CI logs.
            const redacted = lines[i].trim().slice(0, 160)
                .replace(new RegExp(LOCAL_USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>');
            out.push({ ln: i + 1, text: redacted, kind: 'home path' });
        }
        return out;
    }

    const hits = [];
    let scanned = 0;
    for (const rel of tracked) {
        if (ALLOW.has(rel)) continue;
        const full = path.join(ROOT, rel);
        let src;
        // Binary and unreadable files are not text to scan; skip rather than throw.
        try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
        if (src.includes('\0')) continue;
        scanned++;
        for (const h of scanText(src)) hits.push({ rel, kind: 'private name', ...h });
        for (const h of scanHomePaths(src)) hits.push({ rel, ...h });
    }

    if (!hits.length) {
        // Print the population, not just the verdict: a check that reports only
        // "clean" is indistinguishable from one that read nothing.
        //
        // And where the home-path half did not run, say NOT RUN rather than
        // "0 absolute home paths". Zero-found and never-looked are the same
        // string to a reader and opposite in meaning, which is the whole
        // failure this line was written to avoid.
        const homeNote = CI_HOST
            ? `home paths NOT CHECKED (${CI_HOST} host: keyed on the build account, `
              + `which cannot represent an operator home - this is a coverage gap, not a pass)`
            : `0 absolute home paths (keyed on this machine's home dir)`;
        console.log(`[no-private-names] ${scanned} of ${tracked.length} files read, `
            + `${memo.size} distinct candidate tokens, ${DIGESTS.length} names, `
            + `${homeNote} — names clean`);
        return 0;
    }

    const names = hits.filter((h) => h.kind === 'private name');
    const paths = hits.filter((h) => h.kind === 'home path');
    console.error(`\n[no-private-names] ${hits.length} finding(s) in a PUBLIC repo `
        + `(${names.length} private name, ${paths.length} absolute home path):\n`);
    for (const h of hits) console.error(`  [${h.kind}] ${h.rel}:${h.ln}\n      ${h.text}`);
    console.error(
        '\nAnonymise them (Project A/B/C, keeping the numbers and the product shape), or add a\n'
        + 'reviewed exemption to ALLOW in tooling/check-no-private-names.js.\n'
        + '\nNote: this catches the working tree only. Names already in git history stay there —\n'
        + 'redaction is not removal, and a history rewrite is a separate, deliberate decision.\n'
    );
    return 1;
}

module.exports = { PREFIX, DIGEST_LEN, DIGESTS, normalise, digest, candidates, scanText, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
