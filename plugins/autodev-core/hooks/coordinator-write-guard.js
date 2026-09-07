#!/usr/bin/env node
// PreToolUse hook on Bash — the coordinator-write ban, as a mechanism, and
// since 2026-09-08 the `--no-verify` ask (second header, further down).
// Exit 2 = block, exit 0 = allow; exit 0 with a JSON decision on stdout = ask.
//
// WHY THIS EXISTS. `[measured 2026-09-01]` A coordinator session told to run the
// fleet with no way to start a worker had two doors: ignore the repo, or work it
// itself. It worked four — five PRs retargeted onto the wrong base, a branch
// merged into a base a briefed session was landing PRs into forty seconds later,
// and a pre-push guard that reported the base had moved and pushed anyway
// because the shell chain used `;` where it needed `&&`. The ban that would have
// stopped all of it existed only as prose in a skill file. `[measured
// 2026-09-02]`, with a control: PreToolUse carried `Read|Write|Edit` and
// `AskUserQuestion`, and `git grep -c "Bash" -- plugins/*/hooks/hooks.json`
// returned 0 against a control returning 1. Unenforced by construction.
//
// THE HISTORY THIS HAS TO ANSWER TO. A Bash command denylist lived in
// pre-tool-filter.js and was deleted on 2026-08-17 on measurement: 57,599 Bash
// calls, 807 blocks, ZERO of them a destructive command. It blocked read-only
// inspection instead. Its header says why, and the reason is structural — a
// denylist over command TEXT cannot tell executing a thing from mentioning one.
//
// This is not that, and the difference is the population rather than the
// cleverness of the regex:
//
//   * The BAN is INERT unless a role file exists. In every session without one
//     — the overwhelming majority, including every user who installs this
//     plugin and never coordinates anything — it reads one path that is not
//     there and exits 0 with zero bytes on both streams. (The --no-verify ASK
//     added 2026-09-08 is always on, and is a question, never a block; its own
//     header below carries its population and its cost.)
//   * It does not judge danger. It enforces a structural fact the model cannot
//     see from inside a single tool call: which repo it is standing in, versus
//     which repo it is the coordinator OF. That is the same frame as the two
//     blocks that survived in pre-tool-filter.js.
//   * The policy is not held here. The role file declares its own home repos,
//     so this hook has no opinion about anyone's directory layout and ships
//     safely to a machine whose paths it has never seen.
//
// FAILS OPEN, EVERYWHERE. Unlike pre-tool-filter.js, whose parse guard fails
// closed, every error path here exits 0. This ships INSTALLED and runs inside
// other people's sessions on every Bash call: a throw kills their turn, and a
// defect survives until they reinstall. A rail that occasionally misses is
// recoverable; one that bricks a stranger's Bash tool is not. The backstop for
// a miss is the transcript ledger C7 scores against, which runs after the fact
// and does not need this hook to be perfect.
//
// THE ROLE FILE. Default `~/.claude/brain-role.json`, overridable with
// AUTODEV_BRAIN_ROLE_FILE (which is how the suite drives it):
//
//     { "session_id": "<the coordinator's session>",
//       "home_repos":  ["/home/you/claude-auto-dev"],
//       "claimed_at":  "2026-09-02T18:00:00Z" }
//
// `home_repo` as a bare string is accepted too. A missing `session_id` means the
// claim is machine-wide rather than session-scoped. Removing the file disarms
// the guard entirely, which is what the mutation test does.
//
// SCOPE: FOUR VERBS, and the list is a decision rather than a default.
// `commit`, `push`, `merge`, `rebase`.
//
// It shipped as two — commit and push, which is what the plan's probe names —
// and merge and rebase were added on 2026-09-02 because S5's measured damage
// was not only the five retargeted PRs. It was also *a branch merged into a
// base a briefed session was landing PRs into forty seconds later*. A guard
// that stops the commit and allows the merge is guarding the half of the
// incident that was cheaper to undo.
//
// `pull` is EXCLUDED, and that is the line worth holding. It merges, so a
// mechanical reading of "block what writes" catches it — but a coordinator
// updating a local clone in order to READ it is the job, and blocking that
// pushes the role back toward guessing at state it could have measured. Same
// reasoning excludes `fetch`. Both are asserted as allowed in the suite, so
// removing the exemption is a visible decision rather than a drift.
//
// `gh pr merge` is out of scope too: this parses `git`, and a GitHub-side merge
// is the transcript ledger's to catch. Every one of these exclusions has a
// passing test case, because the failure mode of a blocking hook is silent
// growth — that is how the 2026-08-17 denylist became something that had to be
// deleted rather than trimmed.
//
// WHAT IT CANNOT SEE, collected here so a quiet run is not over-read. cwd is
// not where a write lands, so `-C`, `--work-tree` and `--git-dir` are followed,
// and `cd` is tracked across command segments — but `cd -` and `pushd`/`popd`
// are not, and a path built from a variable is not. Each of those leaves the
// guard at its last known-good directory rather than at a guess, which is the
// fail-open direction. Silence from this hook is NOT evidence that a write was
// checked; only a block is a positive signal.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage: coordinator-write-guard.js  (PreToolUse hook on Bash; reads hook JSON on stdin)\n'
        + 'Refuses git commit / push / merge / rebase when a Brain role file names this session\n'
        + 'and the work tree or --git-dir is outside the home repos that role file declares.\n'
        + 'pull and fetch are excluded: a coordinator updating a clone to READ it is the job.\n'
        + 'Role file: $AUTODEV_BRAIN_ROLE_FILE, else ~/.claude/brain-role.json. Absent = inert.\n'
        + 'Also ASKS (permissionDecision: ask on stdout) before git commit/push/merge/rebase/cherry-pick/am\n'
        + 'with --no-verify, commit/am -n, or -c core.hooksPath=; the justification belongs in the commit or PR body.');
    process.exit(0);
}

const BLOCKED_SUBCOMMANDS = new Set(['commit', 'push', 'merge', 'rebase']);

/** The role file this run consults. Env first so the suite can point it at a fixture. */
function roleFilePath() {
    return process.env.AUTODEV_BRAIN_ROLE_FILE
        || path.join(os.homedir(), '.claude', 'brain-role.json');
}

/**
 * Remove heredoc bodies, then quoted spans.
 *
 * Both are ARGUMENT text, never command position, and both are how a naive
 * matcher invents a block. `echo "run git push later"` and a `cat <<EOF` block
 * documenting a release both contain the exact bytes this hook looks for. The
 * old denylist had no notion of either, which is how `grep -rn "DROP TABLE"`
 * came to be blocked for containing the words it was searching FOR.
 *
 * Ordering matters: heredocs first, because a heredoc body is free to contain
 * an unbalanced quote that would otherwise swallow the rest of the command.
 *
 * A BACKSLASH IS NOT ALWAYS AN ESCAPE HERE, and the first version of this
 * function assumed it was. `[measured 2026-09-02]` treating `\` as "skip the
 * next character" turned `git -C C:\Users\me\product commit` into
 * `C:Usersmeproduct`, which path.resolve then read as a RELATIVE path under
 * the home repo — so an absolute Windows path walked straight through the
 * guard, silently, while the relative form of the same command blocked. It
 * failed in both directions at once: a foreign absolute path was allowed and a
 * home absolute path was blocked. Five of this suite's cases caught it.
 *
 * So only a quote or another backslash is consumed as an escape. Everything
 * else keeps its backslash, because on Windows that character is a path
 * separator far more often than it is an escape.
 */
const ESCAPED_SPACE = '\u0000';

/** <<EOF / <<-EOF / <<'EOF' / <<"EOF" … up to a line that is the delimiter. */
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?(?:^[ \t]*\2[ \t]*$|$)/gm;

function stripNonCommandText(command) {
    let s = String(command);

    // <<EOF / <<-EOF / <<'EOF' / <<"EOF" … up to a line that is the delimiter.
    s = s.replace(HEREDOC_RE, (m) => m.split('\n')[0]);

    let out = '';
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === '\\' && quote === '"' && /["\\$`]/.test(s[i + 1] || '')) { out += s[i + 1]; i++; continue; }
            if (c === quote) { quote = null; continue; }
            /* ⚠️ KEEP THE CONTENT. This dropped every character between quotes until
               2026-09-04, which read as prudent — `echo "git push"` must not parse as a
               push — and silently defeated the whole guard, because QUOTING A PATH IS
               THE NORMAL WAY TO WRITE ONE.
               [measured 2026-09-04] `git -C "<foreign-repo>" merge` was ALLOWED: the
               path vanished, `-C` swallowed `merge` as its value, no subcommand was ever
               found, and a no-finding return is an allow. The same collapse turned
               `cd "<home-repo>" && git commit` into a bare `cd`, which is the home
               DIRECTORY, so a legitimate write was BLOCKED and the message named a
               place the caller never mentioned. Two opposite failures, nothing errored.
               Paths here are placeholders on purpose: a realistic one trips the tracked
               -file path gate, which is a finding this comment would otherwise become.
               What quotes actually do is hide SEPARATORS, not arguments, so that is what
               is emulated here: the character survives and anything that could split a
               command becomes a space. `echo "git push"` still reads as one `echo`
               segment, because segmentation looks at a segment's FIRST word. */
            out += /[;&|\n()`]/.test(c) ? ' ' : c;
            continue;
        }
        if (c === '\\') {
            const next = s[i + 1];
            // `\ ` holds a path together. Splitting on it would resolve a
            // SHORTER path and produce a wrong answer in whichever direction
            // that path happened to fall; carrying a placeholder through
            // tokenisation and unwrapping it at resolve time keeps the path whole.
            if (next === ' ' || next === '\t') { out += ESCAPED_SPACE; i++; continue; }
            if (next === '"' || next === "'" || next === '\\') { out += next; i++; continue; }
            out += c;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        out += c;
    }
    return out;
}

/** Undo the escaped-space placeholder on a token about to become a path. */
const unwrap = (tok) => tok.split(ESCAPED_SPACE).join(' ');

/**
 * Prefixes that NAME the home directory without being a directory called that.
 *
 * `path.resolve` has no notion of any of them, so `~/Downloads/code/product`
 * resolved against a cwd inside the home repo lands at
 * `<home-repo>/~/Downloads/code/product` -- which `isInside` then reports as
 * INSIDE the home repo. The guard allowed it. `[measured 2026-09-05]` against
 * this hook, with controls: the absolute and relative spellings of the same
 * command both blocked, and `cd ~/Downloads/code/product && git commit` and
 * `git -C ~/Downloads/code/product commit` were both permitted.
 *
 * This is the 2026-09-02 backslash defect arriving through a different
 * character, and the comment above `stripArgumentText` describes its shape
 * exactly: a path collapses to something shorter, and the shorter thing
 * resolves under the home repo. There it failed in both directions; here it
 * fails only OPEN, which is worse, because a fail-closed guard announces
 * itself the first time it is wrong and this one does not.
 *
 * Anchored at the start, because none of these mean home anywhere else. The
 * bare form (`~`, `$HOME`) must be the WHOLE token or be followed by a
 * separator, or `~foo` (another user's home, which is not ours to expand) and
 * `$HOMEBREW` would be rewritten into paths nobody typed.
 */
const HOME_PREFIXES = [
    /^~(?=$|[/\\])/,
    /^\$HOME(?=$|[/\\])/,
    /^%USERPROFILE%/i,
    /^\$env:USERPROFILE/i,
];

/** Replace a leading home-naming prefix with the real home directory. */
function expandHome(raw) {
    for (const re of HOME_PREFIXES) {
        if (re.test(raw)) return os.homedir() + raw.replace(re, '');
    }
    return raw;
}

/**
 * Unwrap, expand a home prefix, then resolve. Every path this guard derives
 * from a command string goes through here, so a new prefix is handled at one
 * site rather than at the six that previously called `path.resolve` directly.
 */
const resolveArg = (base, raw) => path.resolve(base, expandHome(unwrap(raw)));

/**
 * Split into command-position segments.
 *
 * A shell starts a new command after `;`, `&&`, `||`, `|`, a newline, and at the
 * open of a subshell or command substitution. Splitting on those and only
 * looking at each segment's FIRST word is what keeps `git grep git-commit` and
 * `echo && git commit` telling apart from each other.
 *
 * `{` and `}` are in that set for shell brace GROUPS (`{ git commit; }`), and
 * they also appear in `${VAR}`, where splitting on them is destructive.
 * `[measured 2026-09-05]` `git -C ${HOME}/product rebase main` split into
 * `git -C $`, `HOME` and `/product rebase main`; the first segment has no
 * subcommand after `-C` eats the `$`, so the whole command parsed to nothing
 * and the guard allowed a write it blocks in all four other spellings.
 *
 * Normalising `${NAME}` to `$NAME` first is the smaller fix than teaching the
 * splitter about nesting: the two are the same expansion, and the braced form
 * then reaches `expandHome` by the path the bare form already takes. Only the
 * plain form is rewritten. `${VAR:-default}`, `${#VAR}` and `${VAR/a/b}` are
 * different operators, they are not paths this guard could resolve anyway, and
 * a regex that tried to cover them would be inventing shell semantics.
 *
 * Brace groups keep working regardless, because `;` already ends the command
 * inside one.
 */
function commandSegments(stripped) {
    return String(stripped)
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1')
        .split(/(?:\$\(|[;\n&|()`{}])+/)
        .map((seg) => seg.trim())
        .filter(Boolean);
}

/**
 * The subcommand and the effective directory of one segment, or null.
 *
 * `-C <path>` is the reason this is not a regex. `git -C ../other-repo commit`
 * run from inside the harness repo commits to a product repo while cwd says
 * otherwise, and a cwd-only check waves it through — that is the exact shape
 * of the incident this hook exists for. git applies repeated -C relative to
 * each other, so they compose. `--work-tree=` moves the tree the same way.
 *
 * `--git-dir` is followed too, and returned SEPARATELY rather than folded into
 * `dir`. A git write touches two things — the working tree and the object store
 * — and they are not always the same repo. `git --git-dir=<foreign>/.git commit`
 * from inside the home repo writes foreign objects with a home work tree, and
 * the reverse writes home objects from a foreign tree. Either being outside the
 * declared homes makes it a foreign write, so the caller checks both and names
 * whichever one it caught.
 *
 * No stripping of a trailing `.git` is needed: if `<repo>` is inside a home,
 * `<repo>/.git` is inside it too, and if it is outside, so is its object store.
 */
function parseGitSegment(segment, cwd) {
    const toks = segment.split(/\s+/).filter(Boolean);
    let i = 0;
    // Leading environment assignments: FOO=bar git commit
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    if (i >= toks.length) return null;

    const exe = path.basename(toks[i]).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    if (exe !== 'git') return null;
    i++;

    let dir = cwd;
    let gitDir = null;
    for (; i < toks.length; i++) {
        const t = toks[i];
        if (t === '-C') { const v = toks[++i]; if (v) dir = resolveArg(dir, v); continue; }
        if (t.startsWith('--work-tree=')) { dir = resolveArg(dir, t.slice(12)); continue; }
        if (t === '--work-tree') { const v = toks[++i]; if (v) dir = resolveArg(dir, v); continue; }
        if (t.startsWith('--git-dir=')) { gitDir = resolveArg(dir, t.slice(10)); continue; }
        if (t === '--git-dir') { const v = toks[++i]; if (v) gitDir = resolveArg(dir, v); continue; }
        if (t === '-c' || t === '--exec-path' || t === '--namespace') { i++; continue; }
        if (t.startsWith('-')) continue;               // any other global flag
        return { sub: t.toLowerCase(), dir, gitDir };  // first non-flag word is the subcommand
    }
    return null;
}

/**
 * The directory a `cd` segment moves to, or null if the segment is not a cd.
 *
 * Tracked for the same reason as `-C`, and it matters more: `cd <repo> && git
 * commit` is the ordinary idiom, and the incident this hook exists for was
 * itself a shell chain. A guard that reads only the payload's cwd is defeated
 * by the first `&&`, which would be fixing the path in front of it rather than
 * the event.
 *
 * `cd -` returns null deliberately: OLDPWD is not knowable from here, and
 * guessing would be worse than declining. `pushd`/`popd` are the same case and
 * are not tracked either. Both leave the running directory where it was, so the
 * guard stays at its last known-good answer rather than inventing one.
 */
function cdTarget(segment, cwd) {
    const toks = segment.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    if (toks[i] !== 'cd') return null;
    const args = toks.slice(i + 1).filter((t) => !t.startsWith('-'));
    if (!args.length) return toks.includes('-') ? null : os.homedir();
    return resolveArg(cwd, args[0]);
}

/** True when `child` is `root` or lives under it. Case-insensitive on win32. */
function isInside(root, child) {
    let rel = path.relative(path.resolve(root), path.resolve(child));
    if (process.platform === 'win32') rel = rel.toLowerCase();
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ===========================================================================
// THE SECOND GUARD IN THIS FILE: `--no-verify` ASKS. Added 2026-09-08.
//
// WHY IT LIVES HERE. `[measured 2026-09-08]` on this machine under load 38,
// interleaved medians of 7 on a no-op `ls -la` payload: a bare
// `process.exit(0)` subprocess 52.8 ms, pre-tool-filter.js on a Bash payload
// 58.5 ms, this hook with no role file 52.4 ms. Any new PreToolUse subprocess
// on Bash pays that floor on EVERY Bash call. A branch in the hook that already
// runs on Bash pays the tokeniser below, which is microseconds. Putting it in
// pre-tool-filter.js would also widen that hook's matcher to Bash and reverse
// the 2026-08-17 decision its suite asserts by name; this file is the one that
// already argued, at the top, why a narrow Bash guard is not that denylist.
//
// WHY ASK, NOT DENY. `[measured 2026-09-07]` a push with --no-verify over a
// gate that was red at origin/main for a host-shaped reason (the `claude` on
// PATH was 2.1.233) was the CORRECT call, and its reasoning was written into
// the tree. Across two repos, `git log --all -i --grep=no-verify` finds 4 and
// 0 commits; the 4 are 2 messages each seen twice (branch commit and squash
// merge): one is that recorded bypass, one is prose about the pressure toward
// bypassing. So the constraint is "deliberate and recorded", not "impossible".
// This hook can ask; it cannot see the answer. The RECORD therefore lives in
// the commit or PR body, and the reason says so. A checker over commit bodies
// was measured against a population of one already-compliant instance and
// not built. A headless session cannot answer an ask and is denied, which is
// the right default for an autonomous run skipping a gate.
//
// WHAT IT MATCHES. A word in command position that is `git`, whose subcommand
// is one of six, carrying `--no-verify` as an UNQUOTED flag word; or `-n` in a
// short-option cluster for the two subcommands where `-n` means --no-verify
// (`[measured 2026-09-08]` git 2.50.1: commit and am; on push it is --dry-run,
// on merge and rebase --no-stat, on cherry-pick --no-commit); or a
// `-c core.hooksPath=…` global override in front of any of the six.
// cherry-pick is on the list from ECC's; on 2.50.1 it does not accept the
// flag at all, so an ask there is about a command git would reject, which
// costs one question and no false silence.
//
// WHAT IT DOES NOT MATCH, each with a case in the suite: the string inside a
// quoted commit message, a heredoc body, a grep pattern, a comment, a piped
// `echo`, a pathspec after `--`, and `-n` on any other subcommand. QUOTES DO
// NOT HIDE A FLAG: the shell strips them before git sees the word, so
// `git push "--no-verify"` is a bypass and asks. What keeps a quoted message
// quiet is that `-m` takes a value, which is why each subcommand carries a
// table of its value-taking options. The first draft of this matcher keyed on
// whether the `-` was quoted, and would have stayed silent on the quoted
// spelling; the case is pinned in the suite. This tokeniser is separate from
// stripNonCommandText above on purpose: that one deletes the quote characters
// and keeps the content, which turns `-m "explain --no-verify"` into three
// words. Ported from ECC's block-no-verify.js (affaan-m/ecc, MIT): the commit
// value-option table and the short-cluster rule; not its byte-offset search.
// `sh -c "…"` is followed one level, because a model that has been asked once
// knows the cheapest wrapper.
// ===========================================================================

/** Subcommand -> the git hooks its --no-verify skips (git-scm.com/docs, 2.50). */
const BYPASS_SUBCOMMANDS = {
    commit: ['pre-commit', 'commit-msg'],
    push: ['pre-push'],
    merge: ['pre-merge-commit', 'commit-msg'],
    rebase: ['pre-rebase'],
    'cherry-pick': ['pre-commit', 'commit-msg'],
    am: ['applypatch-msg', 'pre-applypatch'],
};
/** Where `-n` in a short cluster IS --no-verify. Measured, not assumed. */
const SHORT_N_IS_NO_VERIFY = new Set(['commit', 'am']);
/**
 * Options whose NEXT word is their value, so that word is never read as a
 * flag. This is what keeps `git commit -m "explain --no-verify"` quiet: the
 * shell hands git the message unquoted, so quoting is not what protects it.
 */
const VALUE_OPTIONS = {
    commit: new Set(['-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message',
        '--author', '--date', '-t', '--template', '--fixup', '--squash', '--pathspec-from-file', '--trailer']),
    push: new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']),
    merge: new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name']),
    rebase: new Set(['-s', '--strategy', '-X', '--strategy-option', '-x', '--exec', '--onto']),
    'cherry-pick': new Set(['-m', '--mainline', '-X', '--strategy-option', '--strategy']),
    am: new Set(['--directory', '--exclude', '--include', '--patch-format', '--whitespace']),
};
/** Short letters that swallow the REST of a cluster as their value (`-mn` is message "n"). */
const CLUSTER_VALUE_LETTERS = { commit: new Set(['m', 'F', 'C', 'c', 't']), am: new Set(['C', 'p', 'S']) };
/** …and, when last in the cluster, take the NEXT word (`-am msg`). `-S` does not: its key id is joined or absent. */
const CLUSTER_NEXT_WORD_LETTERS = { commit: new Set(['m', 'F', 'C', 'c', 't']), am: new Set(['C', 'p']) };
const GIT_GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace', '--super-prefix']);
const WRAPPER_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

/**
 * Shell words grouped into command segments, with quotes and escapes
 * resolved the way the shell resolves them before git ever sees a word.
 * Quotes GROUP; they do not hide: `git push "--no-verify"` hands git the
 * flag, so it is one. stripNonCommandText above cannot serve here because it
 * turns `-m "explain --no-verify"` into three words.
 */
function shellWords(command) {
    const s = String(command).replace(HEREDOC_RE, (m) => m.split('\n')[0]);
    const segments = [];
    let seg = [];
    let word = null;
    let quote = null;
    let braced = false;                       // inside ${…}, where } is not a group close
    const endWord = () => { if (word !== null) { seg.push(word); word = null; } };
    const endSeg = () => { endWord(); if (seg.length) segments.push(seg); seg = []; };
    const put = (ch) => { word = (word === null ? '' : word) + ch; };
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === quote) { quote = null; continue; }
            if (quote === '"' && c === '\\' && /["\\$`]/.test(s[i + 1] || '')) { put(s[++i]); continue; }
            put(c);
            continue;
        }
        if (c === '"' || c === "'") { quote = c; if (word === null) word = ''; continue; }
        if (c === '\\') {
            const n = s[i + 1];
            if (n === '\n') { i++; continue; }               // line continuation
            if (n !== undefined) { put(n); i++; }            // literal next char
            continue;
        }
        if (c === '#' && word === null) { while (i < s.length && s[i] !== '\n') i++; endSeg(); continue; }
        if (c === '$' && s[i + 1] === '{') { braced = true; put(c); put('{'); i++; continue; }
        if (c === '}' && braced) { braced = false; put(c); continue; }
        if (c === '&' && (s[i + 1] === '>' || /[<>]/.test(s[i - 1] || ''))) { put(c); continue; }   // 2>&1, &>
        if (/[;\n|&(){}`]/.test(c)) { endSeg(); continue; }
        if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
        put(c);
    }
    endSeg();
    return segments;
}

/**
 * Drop redirections and their targets: `<<< "--no-verify"` feeds stdin, and
 * `> out.txt` names a file; neither word reaches git's argv. A joined form
 * (`>out.txt`, `2>&1`) is one word and goes alone.
 */
const REDIRECT_OP = /^[0-9]*(?:<<<|<>|<|>>|>|&>>|&>|<&|>&)$/;
const REDIRECT_JOINED = /^(?:[0-9]*(?:<<<|<>|<|>>|>|<&|>&)|&>>?).+/;
function withoutRedirections(words) {
    const out = [];
    for (let i = 0; i < words.length; i++) {
        if (REDIRECT_OP.test(words[i])) { i++; continue; }
        if (REDIRECT_JOINED.test(words[i])) continue;
        out.push(words[i]);
    }
    return out;
}

/**
 * The bypass one segment performs, or null. `here` is the directory the
 * command runs in, tracked so the reason can name the hook FILE being skipped.
 */
function bypassInSegment(rawWords, here, depth) {
    const words = withoutRedirections(rawWords);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (i >= words.length) return null;
    const exe = path.basename(words[i]).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    if (WRAPPER_SHELLS.has(exe) && depth < 1) {
        const c = words.indexOf('-c', i + 1);
        return c !== -1 && words[c + 1] !== undefined ? findHookBypass(words[c + 1], here, depth + 1) : null;
    }
    if (exe !== 'git') return null;

    let dir = here;
    let hooksPath = false;
    let sub = null;
    for (i++; i < words.length; i++) {
        const t = words[i];
        if (!t.startsWith('-')) { sub = t.toLowerCase(); break; }
        if (GIT_GLOBAL_VALUE_OPTIONS.has(t)) {
            const v = words[i + 1];
            if (v !== undefined && t === '-c' && /^core\.hookspath=/i.test(v)) hooksPath = true;
            if (v !== undefined && t === '-C') dir = resolveArg(dir, v);
            i++;
            continue;
        }
        if (/^-ccore\.hookspath=/i.test(t)) hooksPath = true;
    }
    if (!sub || !BYPASS_SUBCOMMANDS[sub]) return null;
    if (hooksPath) return { sub, via: '-c core.hooksPath=…', dir };

    const values = VALUE_OPTIONS[sub];
    const swallow = CLUSTER_VALUE_LETTERS[sub] || new Set();
    const takesNext = CLUSTER_NEXT_WORD_LETTERS[sub] || new Set();
    for (i++; i < words.length; i++) {
        const t = words[i];
        if (t === '--') break;                              // pathspecs from here on
        if (t === '--no-verify') return { sub, via: '--no-verify', dir };
        if (values.has(t)) { i++; continue; }
        if (!/^-[^-]/.test(t)) continue;                    // positional, or a long option carrying its own value
        for (let k = 1; k < t.length; k++) {
            const ch = t[k];
            if (ch === 'n' && SHORT_N_IS_NO_VERIFY.has(sub)) return { sub, via: '-n', dir };
            if (swallow.has(ch)) { if (k === t.length - 1 && takesNext.has(ch)) i++; break; }
        }
    }
    return null;
}

/** First hook bypass in a command, following `cd` between segments. */
function findHookBypass(command, cwd, depth = 0) {
    let here = cwd;
    for (const words of shellWords(command)) {
        let k = 0;
        while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k++;
        if (words[k] === 'cd') {
            const args = words.slice(k + 1).filter((t) => !t.startsWith('-'));
            if (args.length) here = resolveArg(here, args[0]);
            else if (!words.includes('-')) here = os.homedir();
            continue;
        }
        const hit = bypassInSegment(words, here, depth);
        if (hit) return hit;
    }
    return null;
}

/**
 * The ask text. Names the git hook(s) the flag skips, and, when the repo the
 * command runs in has that hook installed, the FILE and the scripts it runs,
 * read from the hook itself so the reason is true in any repo rather than
 * only this one. `git rev-parse --git-path hooks` honours core.hooksPath
 * (`[measured 2026-09-08]` git 2.50.1: `.git/hooks` unset, `tooling/githooks`
 * set, `../tooling/githooks` from a subdirectory). Only spawned on the ask
 * path, never on the quiet one.
 */
function bypassReason(hit) {
    const hooks = BYPASS_SUBCOMMANDS[hit.sub];
    let here = '';
    try {
        const r = require('child_process').spawnSync('git', ['-C', hit.dir, 'rev-parse', '--git-path', 'hooks'],
            { encoding: 'utf8', timeout: 3000, windowsHide: true });
        if (r.status === 0 && r.stdout.trim()) {
            const hooksDir = path.resolve(hit.dir, r.stdout.trim());
            const found = [];
            for (const h of hooks) {
                const file = path.join(hooksDir, h);
                if (!fs.existsSync(file)) continue;
                const live = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
                const runs = [...new Set((live.match(/(?:[\w.-]+[/\\])+[\w.-]+\.(?:m?js|cjs|sh|py)\b/g) || [])
                    .map((p) => p.split(/[/\\]/).slice(-2).join('/')))];
                const rel = path.relative(hit.dir, file);
                found.push(`${rel && !rel.startsWith('..') ? rel : file}${runs.length ? ` (runs ${runs.join(', ')})` : ''}`);
            }
            if (found.length) here = ` Here that is ${found.join(' and ')}.`;
        }
    } catch { /* no git, or not a repo: the git hook names above still stand */ }
    return `\`git ${hit.sub} ${hit.via}\` skips the ${hooks.join(' and ')} hook${hooks.length > 1 ? 's' : ''}.${here} `
        + 'A bypass can be the right call (a gate red at the base commit for a reason that is not this change\'s), '
        + 'but it has to be deliberate and RECORDED, and this hook cannot see the answer to this question. '
        + 'Allow it only with a one-line justification in the commit or PR body that names the gate skipped and why, '
        + 'so the bypass stays distinguishable from a push that simply skipped the gate.';
}

try {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        // Fail OPEN, silently. An unreadable payload is the harness's problem,
        // and this hook is a rail rather than the last line of defence. Note
        // the divergence from pre-tool-filter.js, which fails closed here: that
        // one is protecting a write it can see, this one is guessing at intent.
        process.exit(0);
    }

    if ((data.tool_name || '') !== 'Bash') process.exit(0);

    const command = (data.tool_input && data.tool_input.command) || '';
    if (!command) process.exit(0);

    const cwd = path.resolve(data.cwd || process.cwd());

    // The ask is decided up front and DELIVERED at every allow below, so a
    // block (exit 2) still wins when both apply, and a session with no role
    // file, the common one, still gets asked. Quiet paths stay quiet: with no
    // bypass in the command, allow() writes nothing.
    const bypass = findHookBypass(command, cwd);
    const allow = () => {
        if (bypass) {
            process.stdout.write(JSON.stringify({ hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'ask',
                permissionDecisionReason: bypassReason(bypass),
            } }) + '\n');
        }
        process.exit(0);
    };

    // Cheapest discriminator first: no role file, no opinion, zero bytes. This
    // is the branch that runs in every session that is not coordinating, so it
    // must cost one failed stat and nothing else.
    const rolePath = roleFilePath();
    let roleRaw;
    try {
        roleRaw = fs.readFileSync(rolePath, 'utf8');
    } catch {
        allow();
    }

    let role;
    try {
        role = JSON.parse(roleRaw);
    } catch (err) {
        // Loud, because this is absent coverage that looks like coverage. A role
        // file the guard cannot read is a guard that is not running, and the
        // session holding it believes otherwise.
        process.stderr.write(`coordinator-write-guard: ${rolePath} is present but did not parse `
            + `(${err.message}); this session's git writes are NOT guarded.\n`);
        allow();
    }

    /* `expandHome` on the CONFIG side, not only the command side.
       #167 taught this guard that `~/product` and `$HOME/product` name a real
       directory rather than one called `~`, and applied it to paths parsed out
       of the command being judged. The role file's own `home_repos` never got
       the same treatment, so the trusted half could not be written portably.

       The consequence was not a missing feature, it was a fail-CLOSED trap.
       `isInside` calls `path.resolve(root)`, and `path.resolve('~/x')` resolves
       against the process cwd, so a role file declaring `~/claude-auto-dev`
       matched no real directory: `homes.some(isInside)` went false for the
       coordinator's own repo, every directory then counted as foreign, and the
       guard blocked the writes it exists to permit. Nothing said why, because a
       home_repo that matches nothing and a home_repo that is genuinely elsewhere
       produce the same verdict.

       This matters beyond tidiness: an absolute path carries a username and a
       drive letter, so a role file written on one machine is wrong on the next
       one in a way that survives a restore. Expanding here is what lets the
       record be device- and account-agnostic. */
    const homes = []
        .concat(Array.isArray(role.home_repos) ? role.home_repos : [])
        .concat(typeof role.home_repo === 'string' ? [role.home_repo] : [])
        .filter((h) => typeof h === 'string' && h.length)
        .map(expandHome);
    if (!homes.length) {
        process.stderr.write(`coordinator-write-guard: ${rolePath} declares no home_repo/home_repos, `
            + `so every directory would count as foreign; not guarding rather than blocking everything.\n`);
        allow();
    }

    const claimed = typeof role.session_id === 'string' && role.session_id.length
        ? role.session_id : null;
    const mine = data.session_id || null;

    const segments = commandSegments(stripNonCommandText(command));

    // A role file with no session_id is a machine-wide claim and applies here.
    // One that names a DIFFERENT session is somebody else's role: exit quiet,
    // with ONE exception, and the exception is the whole reason this file is
    // read by a second checker.
    //
    // `[measured 2026-09-04]` the role file named a session archived the day
    // before, and later that day a fresh claim wrote the desktop uuid into
    // session_id. Both times `claimed !== mine` held for the live Brain, so this
    // branch exited quietly on every one of its git writes, and it worked for
    // hours believing its rail was armed. A rail that silently protects nobody
    // is worse than no rail, because it is believed.
    //
    // So when the claim names no LIVE session, say so, but only at the moment
    // it matters, the way the unconfirmable-holder warning below does: a
    // blocked verb, from a session standing inside the coordinator's own home
    // repo (the Brain itself, or a chip cut from its clone). A worker committing
    // in a product repo gains nothing from the line and would see it on every
    // commit. Liveness comes from scripts/check-brain-role.js reading
    // ~/.claude/sessions/<pid>.json; the desktop store is skipped here because
    // this runs on every git write and the sessions dir alone decides "live".
    // Everything about it fails OPEN: no sibling script, no warning.
    if (claimed && mine && claimed !== mine) {
        const writing = segments.some((seg) => {
            const g = parseGitSegment(seg, cwd);
            return !!(g && BLOCKED_SUBCOMMANDS.has(g.sub));
        });
        if (writing && homes.some((h) => isInside(h, cwd))) {
            let verdict = null;
            try {
                const { checkBrainRole } = require(path.join(__dirname, '..', 'scripts', 'check-brain-role.js'));
                verdict = checkBrainRole({ roleFile: rolePath, role, store: null });
            } catch { verdict = null; }
            const dead = verdict && verdict.state === 'fault'
                ? verdict.faults.find((f) => f.code === 'dead-session') : null;
            if (dead) {
                const sub = segments.map((seg) => parseGitSegment(seg, cwd)).find((g) => g && BLOCKED_SUBCOMMANDS.has(g.sub)).sub;
                process.stderr.write(`coordinator-write-guard: ${rolePath} names session ${claimed} as the coordinator, `
                    + `but no live session has that id (${dead.detail}). The rail is armed for NOBODY. `
                    + `Allowing \`git ${sub}\` in ${cwd} UNCHECKED; whoever holds the Brain role must rewrite the `
                    + `record from ~/.claude/sessions/<pid>.json (check: scripts/check-brain-role.js --status).\n`);
            }
        }
        allow();
    }

    const hits = [];
    let here = cwd;                       // moves with each `cd` segment
    for (const seg of segments) {
        const moved = cdTarget(seg, here);
        if (moved) { here = moved; continue; }
        const g = parseGitSegment(seg, here);
        if (!g || !BLOCKED_SUBCOMMANDS.has(g.sub)) continue;
        // A git write touches the working tree AND the object store, and
        // --git-dir can point them at different repos. Either one landing
        // outside the declared homes makes this a foreign write; report the
        // one that was caught rather than a generic directory.
        const foreign = [g.dir, g.gitDir]
            .filter(Boolean)
            .filter((d) => !homes.some((h) => isInside(h, d)));
        if (!foreign.length) continue;
        hits.push({ ...g, at: foreign[0] });
    }
    if (!hits.length) allow();

    // Would have blocked, but cannot confirm the holder is this session. Say so
    // HERE rather than on every call: a warning that fires constantly gets
    // muted, and a warning that fires only at the moment it matters does not.
    if (claimed && !mine) {
        process.stderr.write(`coordinator-write-guard: ${rolePath} claims session ${claimed}, but this `
            + `hook payload carries no session_id, so the holder could not be confirmed. `
            + `Allowing \`git ${hits[0].sub}\` in ${hits[0].at} UNCHECKED.\n`);
        allow();
    }

    // Population beside the verdict: a reader can tell a block that examined
    // four segments from one that examined the whole command as a single blob.
    const h = hits[0];
    process.stderr.write(
        `Blocked: this session holds the coordinator role (${rolePath}), and \`git ${h.sub}\` here `
        + `would write to ${h.at}, which is outside its home repo`
        + `${homes.length > 1 ? 's' : ''} (${homes.join(', ')}).\n`
        + `The coordinator does not write to product repos. Brief a session that owns that repo, or `
        + `hand the change over — an unattended coordinator retargeting five PRs is what this rail is for.\n`
        + `Scanned ${segments.length} command segment${segments.length === 1 ? '' : 's'}, `
        + `${hits.length} outside the home repo${homes.length > 1 ? 's' : ''}`
        + `${hits.length > 1 ? ` (${hits.map((x) => 'git ' + x.sub).join(', ')})` : ''}.\n`
        + `To stand down the role deliberately, remove ${rolePath}.\n`);
    process.exit(2);
} catch (err) {
    // Never kill a turn. See the header: this ships installed, and a defect here
    // reaches a stranger's every Bash call until they reinstall.
    try {
        process.stderr.write(`coordinator-write-guard: skipped (${err && err.message}); `
            + `git writes were NOT guarded on this call\n`);
    } catch { /* stderr itself is gone; there is nothing further to try */ }
    process.exit(0);
}
