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
// ERRORS FAIL OPEN except a recognised subagent payload containing push: an
// uncheckable subagent push exits 2. This ships INSTALLED and runs inside
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
// `gh pr merge` is out of scope for THIS ban: it parses `git`, and a GitHub-side
// merge is the transcript ledger's to catch. A separate, opt-in rule further
// down blocks raw `gh pr merge` for every session once the merge-lock marker
// exists (THE THIRD GUARD). Every one of these exclusions has a
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
// A broken install is quiet, never loud: no helper, no opinion.
let configDir;
try { ({ configDir } = require('../scripts/claude-paths.js')); } catch { process.exit(0); }

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage: coordinator-write-guard.js  (PreToolUse hook on Bash; reads hook JSON on stdin)\n'
        + 'Refuses git commit / push / merge / rebase when a Brain role file names this session\n'
        + 'and the work tree or --git-dir is outside the home repos that role file declares.\n'
        + 'pull and fetch are excluded: a coordinator updating a clone to READ it is the job.\n'
        + 'One product push is allowed: `git push [-u] origin claude/<slug>` from the worktree of a CLOSED\n'
        + 'unattended-worker ledger record ($CLAUDE_CONFIG_DIR/autodev/unattended-workers.json) naming that branch.\n'
        + 'Role file: $AUTODEV_BRAIN_ROLE_FILE, else ~/.claude/brain-role.json. Absent = inert.\n'
        + 'Also ASKS (permissionDecision: ask on stdout) before git commit/push/merge/rebase/cherry-pick/am, but only\n'
        + 'when a bypass flag is present: --no-verify, commit/am -n, or -c core.hooksPath=. In an unattended run\n'
        + '(AI_AGENT ends _harness, or CLAUDE_CODE_ENTRYPOINT starts sdk-) the same text is a note, not a gate.\n'
        + 'Either way the justification belongs in the commit or PR body.\n'
        + 'In every session, refuses a SUBAGENT (agent_id in the payload) `git push` that updates main or master:\n'
        + 'a refspec destination, HEAD or no refspec on a checked-out default branch, --all, --mirror or --branches.');
    process.exit(0);
}

const BLOCKED_SUBCOMMANDS = new Set(['commit', 'push', 'merge', 'rebase']);

/**
 * WHO IS ASKING. `[measured 2026-10-14]` this ban blocked two of the Brain's own
 * dispatched workers committing in throwaway repos they had built under
 * ~/.claude/autodev/reports/<run>/<code>/ to test their change. A subagent's
 * hook payload carries the PARENT's session_id, so the role file's claim
 * matched and the worker was judged as the coordinator.
 *
 * A dispatched subagent is the "session that owns that repo" the block message
 * tells the coordinator to brief, so it is not the coordinator. The Claude Code
 * hooks reference: `agent_id` is present only when the hook fires inside a
 * subagent call, and is the field for telling subagent calls from main-thread
 * calls. `agent_type` is NOT the signal, because it is also present on the main
 * thread of a session started with `--agent`. The harness writes the payload,
 * so nothing in the command text can forge this field.
 */
const isSubagent = (data) => typeof data.agent_id === 'string' && data.agent_id.length > 0;

/**
 * Directories that hold scratch repos, never product repos: the autodev reports
 * dir that fleet briefs name for scratch output, and Claude Code's session
 * scratchpad root under the OS temp dir. A commit, merge or rebase in a repo
 * there writes nothing anyone else reads.
 *
 * PUSH IS NOT EXEMPT. A scratch clone of a product repo pushes to the product's
 * remote, which is the incident this rail exists for, so a push from scratch is
 * judged like any other.
 */
const SCRATCH_LOCAL_VERBS = new Set(['commit', 'merge', 'rebase']);
function scratchRoots() {
    return [path.join(configDir(), 'autodev', 'reports'), path.join(os.tmpdir(), 'claude')];
}

/** The role file this run consults. Env first so the suite can point it at a fixture. */
function roleFilePath() {
    return process.env.AUTODEV_BRAIN_ROLE_FILE
        || path.join(configDir(), 'brain-role.json');
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


function stripNonCommandText(command) {
    let s = String(command);

    // <<EOF / <<-EOF / <<'EOF' / <<"EOF" … up to a line that is the delimiter.
    // One copy of the heredoc regex, owned by scripts/hook-bypass.js. This
    // function runs only when a role file exists, so the require is off the
    // quiet path.
    const { HEREDOC_RE } = require(path.join(__dirname, '..', 'scripts', 'hook-bypass.js'));
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
            // A quoted space belongs to this argument, just like an escaped
            // space. Keep it opaque until path resolution so -C, cd and the
            // git-dir/work-tree options all receive the complete path.
            if (c === ' ') { out += ESCAPED_SPACE; continue; }
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
 * Git Bash spells drive C as `/c`. `path.resolve` on win32 reads `/c/Users/me`
 * as ROOT-RELATIVE on the base path's drive, so it produces `C:\c\Users\me`.
 * `[measured 2026-09-13]` plugin 8.168.0: `cd /c/Users/<u>/<home-repo> && ...
 * && git merge` was BLOCKED from the coordinator's own home repo, with a
 * message naming `C:\c\Users\...`, while the `~/` spelling of the same command
 * was allowed. Third arrival of the backslash and `~` defect family: a path
 * the shell understands, which Node resolves to a different directory.
 *
 * win32 only. On POSIX `/c/x` is an ordinary absolute path and must stay one.
 * A single letter followed by `/` or the end of the token, so `/cache` and
 * `/tmp` are untouched.
 */
const MSYS_DRIVE = /^\/([A-Za-z])(?=$|\/)/;
function msysDrive(raw) {
    if (process.platform !== 'win32') return raw;
    return raw.replace(MSYS_DRIVE, (_, d) => `${d.toUpperCase()}:/`);
}

/** Every spelling this guard translates into a path Node resolves the same way the shell does. */
const nativePath = (raw) => msysDrive(expandHome(raw));

/**
 * Unwrap, translate, then resolve. Every path this guard derives from a
 * command string goes through here, so a new prefix is handled at one site
 * rather than at the six that previously called `path.resolve` directly.
 */
const resolveArg = (base, raw) => path.resolve(base, nativePath(unwrap(raw)));

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
        // Keep brace expansion in its argument, marked as dynamic. Splitting
        // it as a command group would hide the unknown subcommand/refspec.
        .replace(/\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/g, () => '$')
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
/**
 * Commands that run the command after them unchanged, with the options that
 * take a separate value. `env` applies assignments first; the others change
 * priority, timing, the user or the lookup, never which git subcommand runs.
 */
const WRAPPERS = new Map([
    ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
    ['command', new Set()],
    ['exec', new Set(['-a'])],
    ['time', new Set(['-f', '--format', '-o', '--output'])],
    ['nice', new Set(['-n', '--adjustment'])],
    ['nohup', new Set()],
    ['sudo', new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host',
        '-p', '--prompt', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'])],
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// String.match, not RegExp.exec: validate.js reads `.exec(` in a hook as a child_process spawn site.
const commandName = (tok) => ((tok || '').match(/^(?:.*[/\\])?([^/\\]+?)(?:\.(?:exe|cmd|bat))?$/) || [])[1]?.toLowerCase() || '';

/** The index of the first word that is neither an assignment nor a wrapper or its options. */
function skipWrappers(toks) {
    let i = 0;
    for (;;) {
        // Leading environment assignments: FOO=bar git commit
        while (i < toks.length && ASSIGNMENT.test(toks[i])) i++;
        const valued = WRAPPERS.get(commandName(toks[i]));
        if (!valued) return i;
        i++;
        while (i < toks.length && toks[i].startsWith('-')) {
            const t = toks[i++];
            if (t === '--') break;
            if (valued.has(t)) i++;
        }
    }
}

/** A shell's backslash escape outside quotes: `pu\sh` runs as `push`. */
const unescapeWord = (tok) => tok.replace(/\\(.)/g, '$1');

/**
 * The command string a segment hands to `bash -c` (or sh, zsh, dash, ksh), or
 * null. Quotes are already gone, and separators inside them became spaces, so
 * the string cannot be split again: the caller judges it as a whole.
 */
function shellCommandString(segment) {
    const toks = segment.split(/\s+/).filter(Boolean);
    let i = skipWrappers(toks);
    if (!/^(?:ba|z|da|k)?sh$/.test(commandName(toks[i]))) return null;
    for (i++; i < toks.length && toks[i].startsWith('-'); i++) {
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(toks[i])) return unescapeWord(toks.slice(i + 1).map(unwrap).join(' '));
    }
    return null;
}

function parseGitSegment(segment, cwd) {
    const toks = segment.split(/\s+/).filter(Boolean);
    // Wrappers and shell control words are open-ended. Quoted argument spaces
    // remain opaque, so an echo of a quoted command is still one argument.
    let i = toks.findIndex((t) => commandName(t) === 'git' || commandName(unescapeWord(t)) === 'git');
    if (i < 0) return null;
    const envCount = i;
    i++;

    let dir = cwd;
    let gitDir = null;
    // Global options other than -C, kept so closedRunPush can refuse any that
    // could send a push somewhere its arguments do not name (-c url.*.insteadOf).
    const globals = [];
    // The -c values, so an alias defined on the command line can be expanded.
    const configs = [];
    for (; i < toks.length; i++) {
        const t = toks[i];
        if (t === '-C') { const v = toks[++i]; if (v) dir = resolveArg(dir, v); continue; }
        if (t.startsWith('--work-tree=')) { globals.push(t); dir = resolveArg(dir, t.slice(12)); continue; }
        if (t === '--work-tree') { globals.push(t); const v = toks[++i]; if (v) dir = resolveArg(dir, v); continue; }
        if (t.startsWith('--git-dir=')) { gitDir = resolveArg(dir, t.slice(10)); continue; }
        if (t === '--git-dir') { const v = toks[++i]; if (v) gitDir = resolveArg(dir, v); continue; }
        if (t === '-c') { globals.push(t); const v = toks[++i]; if (v) configs.push(unwrap(v)); continue; }
        if (t === '--config-env') { globals.push(t); const v = toks[++i]; if (v) globals.push(unwrap(v)); continue; }
        if (t === '--exec-path' || t === '--namespace') { globals.push(t); i++; continue; }
        if (t.startsWith('-')) { globals.push(t); continue; }   // any other global flag
        // First non-flag word is the subcommand.
        return { sub: unescapeWord(t).toLowerCase(), dir, gitDir, envCount, globals, configs,
            env: toks.slice(0, envCount).map(unwrap), args: toks.slice(i + 1).map(unwrap) };
    }
    return null;
}

// ===========================================================================
// THE ONE PRODUCT WRITE THE COORDINATOR MAKES: pushing a closed worker's branch.
// Added 2026-10-25. docs/decisions.md, "the Brain pushes a closed worker's branch".
//
// `[measured 2026-10-25]` worker v-li-caption-614b gated vistek 10d8e2c5 green
// and stopped unpushed. A headless builder may not push (worker-authority.js:
// "git push belongs to the Brain"), and this rail refused the Brain the same
// push, so no queued product task could land. The broker the worker authority
// names has to be able to broker.
//
// The exemption is as narrow as the handoff: a `git push` whose effective
// directory is the worktree of an unattended-worker ledger record, where the
// NEWEST record for that worktree is `closed` (its run has ended, so no worker
// is still writing there), with exactly `origin` and that record's branch as
// arguments. No force of any spelling (a `+` refspec, --force*, --mirror,
// --all, --tags, --delete), no `-c`, --git-dir, --work-tree or leading env
// assignment that could send the push somewhere its arguments do not name, and
// no other refspec. Every other product write still blocks. `gh pr create` and
// `node merge-lock.js` were never in this rail's scope: it parses `git`.
//
// The ledger is read only after a push has already been judged foreign, so the
// quiet path does not pay for it. Any failure to read it means no exemption,
// and the block stands: this is the one place in the file that fails CLOSED,
// because failing open here would turn a read error into a product push.
// ===========================================================================

const PUSH_FLAGS_OK = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--porcelain',
    '--dry-run', '--progress', '--no-progress']);

/** The ledger unattended-worker.js writes. Same default it uses. */
const ledgerPath = () => path.join(configDir(), 'autodev', 'unattended-workers.json');

/** The closed ledger record whose branch this push sends, or null. Never throws. */
function closedRunPush(g) {
    try {
        if (g.sub !== 'push' || g.gitDir || g.envCount || g.globals.length) return null;
        const positional = [];
        for (let i = 0; i < g.args.length; i++) {
            const a = g.args[i];
            if (/^\d*[<>]/.test(a)) { if (/^\d*[<>]+$/.test(a)) i++; continue; }
            if (a.startsWith('-')) { if (!PUSH_FLAGS_OK.has(a)) return null; continue; }
            positional.push(a);
        }
        if (positional.length !== 2 || positional[0] !== 'origin') return null;
        const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
        if (!ledger || !Array.isArray(ledger.records)) return null;
        // Records are appended, so the last one naming a worktree is the current
        // claim on it. A reused slug with a live run behind it is not closed.
        const named = ledger.records.filter((r) => r && typeof r.worktree === 'string' && path.isAbsolute(r.worktree)
            && typeof r.branch === 'string' && isInside(r.worktree, g.dir));
        const rec = named[named.length - 1];
        // enqueue names every branch claude/<slug>: a record naming a default
        // branch was not written by it, and never licenses a push to one.
        if (!rec || rec.state !== 'closed' || !/^claude\/[a-z0-9][a-z0-9-]*$/.test(rec.branch)) return null;
        const b = rec.branch;
        const spellings = [b, `refs/heads/${b}`, `${b}:${b}`, `refs/heads/${b}:refs/heads/${b}`];
        return spellings.includes(positional[1]) ? rec : null;
    } catch {
        return null;
    }
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
// THE THIRD GUARD IN THIS FILE: raw merges, opt-in. Added 2026-10-02.
//
// The merge bar is one gate on the frozen candidate, merged by
// scripts/merge-lock.js under a per-repo lock that refuses a moved base and
// reads the merged tree back. A raw `gh pr merge` skips all of that. This rule
// is INERT unless <home>/.claude/autodev/merge-lock.enforce exists, and the
// marker is read only when the command text holds both `gh` and `merge`, so
// the quiet path costs two regex tests. Armed, it blocks (exit 2) a segment that
// runs `gh pr merge`, or `gh api` with a PUT to a `pulls/<n>/merge` path.
// merge-lock.js spawns gh itself, with no shell, so this hook never sees it.
// ===========================================================================

const MERGE_MARKER_PARTS = ['.claude', 'autodev', 'merge-lock.enforce'];

// gh options that take a value. A value is never the subcommand or the endpoint:
// `gh api --input x/pulls/1/merge -X PUT repos/o/n/actions/permissions` is not a merge.
const GH_VALUE_OPTS = new Set(['-R', '--repo', '--hostname']);
const API_VALUE_OPTS = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field',
    '--input', '-q', '--jq', '-t', '--template', '-p', '--preview', '--cache', '--hostname', '-R', '--repo']);

/** The first segment that merges a PR through gh, as a short label, or null. */
function rawMergeSegment(segments) {
    for (const seg of segments) {
        const toks = seg.split(/\s+/).filter(Boolean).map((t) => unwrap(t).replace(/["']/g, ''));
        let i = 0;
        let viaEnv = false;
        for (; i < toks.length; i++) {
            const t = toks[i];
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === 'command' || t === 'exec') continue;
            if (path.basename(t.replace(/\\/g, '/')) === 'env') { viaEnv = true; continue; }
            if (viaEnv && t.startsWith('-')) continue;
            break;
        }
        const bin = path.basename(String(toks[i] || '').replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
        if (bin !== 'gh') continue;
        const rest = toks.slice(i + 1);
        // The subcommand words, skipping gh's own options and their values.
        const words = [];
        let k = 0;
        for (; k < rest.length && words.length < 2; k++) {
            if (GH_VALUE_OPTS.has(rest[k])) { k++; continue; }
            if (rest[k].startsWith('-')) continue;
            words.push(rest[k]);
        }
        if (words[0] === 'pr' && words[1] === 'merge') {
            // Help and cancelling auto-merge do not merge anything.
            if (rest.some((t) => t === '--help' || t === '-h' || t === '--disable-auto')) continue;
            return 'gh pr merge';
        }
        if (words[0] !== 'api') continue;
        let method = null;
        let endpoint = null;
        for (let j = rest.indexOf('api') + 1; j < rest.length; j++) {
            const t = rest[j];
            if (t === '-X' || t === '--method') { method = rest[j + 1] || ''; j++; continue; }
            if (API_VALUE_OPTS.has(t)) { j++; continue; }
            const glued = t.match(/^(?:-X|--method=)(.+)$/);
            if (glued) { method = glued[1]; continue; }
            if (t.startsWith('-')) continue;
            if (endpoint === null) endpoint = t;
        }
        if (!method || !/^put$/i.test(method) || !endpoint) continue;
        const ep = endpoint.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
        if (/(?:^|\/)pulls\/[^/]+\/merge\/?$/.test(ep)) return 'gh api -X PUT .../pulls/<n>/merge';
    }
    return null;
}

// ===========================================================================
// THE FOURTH GUARD IN THIS FILE: a subagent never pushes a default branch.
// Added 2026-10-28, from a colleague's as-built redline (Δ9) that denies every
// subagent push while a mission runs.
//
// `[measured 2026-10-28]` over 30 days, 618 subagent transcripts ran 80 `git
// push` calls: 61 to claude/*, 18 to other feature branches, 1 bare, 0 to main
// or master. The redline as written would have refused all 80, so this keeps
// only the hazard: a push that updates main or master. On a product repo that
// push is a production deploy, and main moves only by PR through merge-lock.js.
//
// Every session, role file or not, because a dispatched subagent is not the
// coordinator (isSubagent above) and the role check exempts it. The main
// thread is not touched: deploy-identity names repos where a required merge
// commit is made locally. A refspec's destination decides, after `+` and
// `refs/heads/`; `HEAD` and a push with no refspec resolve to the current
// branch, read with one `git symbolic-ref` only on that path. --all, --mirror
// and --branches push main too. An unresolved destination fails closed.
// ===========================================================================

const DEFAULT_BRANCHES = new Set(['main', 'master']);
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/** The branch `dir` has checked out, or null. Never throws. */
function currentBranch(dir) {
    try {
        const r = require('child_process').spawnSync('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
            { encoding: 'utf8', timeout: 3000, windowsHide: true });
        return r.status === 0 ? r.stdout.trim() : null;
    } catch {
        return null;
    }
}

/** What a parsed `git push` sends to a default branch, as a short label, or null. */
function defaultBranchPush(g) {
    const positional = [];
    let repoOption = false;
    let options = true;
    let tags = false;
    for (let i = 0; i < g.args.length; i++) {
        const a = g.args[i];
        if (options && a === '--') { options = false; continue; }
        if (!options) { positional.push(a); continue; }
        if (a === '--all' || a === '--mirror' || a === '--branches') return a;
        if (a === '--tags') { tags = true; continue; }
        if (a === '--repo' || a.startsWith('--repo=')) {
            const value = a === '--repo' ? g.args[++i] : a.slice(7);
            if (!value || value.startsWith('-')) return 'an unknown destination (missing --repo value)';
            repoOption = true;
            continue;
        }
        if (PUSH_VALUE_OPTS.has(a)) { i++; continue; }
        if (/^\d*[<>]/.test(a)) { if (/^\d*[<>]+$/.test(a)) i++; continue; }   // a redirection and its target
        if (a.startsWith('-')) continue;
        // A ref name holds no backslash, so one here is a shell escape: `ma\in` is main.
        positional.push(unescapeWord(a));
    }
    // --repo already supplied the remote: the first positional is a refspec.
    const refspecs = positional.slice(repoOption ? 0 : 1);
    let cur;
    const branchOf = (name) => (name === 'HEAD' || name === '@' ? (cur === undefined ? (cur = currentBranch(g.dir)) : cur) : name);
    for (const r of refspecs) {
        const dst = branchOf((r.includes(':') ? r.slice(r.indexOf(':') + 1) : r).replace(/^\+/, '').replace(/^(?:refs\/)?heads\//, ''));
        if (!dst) return 'an unknown destination (matching refspec or unresolved HEAD)';
        // A pattern can update any matching default branch. Keep feature-only
        // patterns and explicitly qualified tags working.
        if (dst.includes('*')) {
            const pattern = new RegExp('^' + dst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$');
            if ([...DEFAULT_BRANCHES].some((b) => pattern.test(b) || pattern.test(`refs/heads/${b}`))) return `main/master (refspec ${r})`;
        }
        if (DEFAULT_BRANCHES.has(dst)) return r === dst ? dst : `${dst} (refspec ${r})`;
    }
    if (refspecs.length) return null;
    if (tags) return null; // --tags alone does not send the current branch.
    const head = branchOf('HEAD');
    if (!head) return 'an unknown destination (current branch unreadable)';
    return DEFAULT_BRANCHES.has(head) ? `${head} (the branch checked out in ${g.dir})` : null;
}

/** The first segment where a subagent pushes a default branch, or null. Tracks `cd` like the role check. */
function subagentDefaultPush(segments, cwd, command) {
    let here = cwd;
    const mentionsPush = /\bpush\b/.test(unescapeWord(command).replace(/["']/g, ''))
        || command.includes("$'") || /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/.test(command);
    for (const seg of segments) {
        const moved = cdTarget(seg, here);
        if (moved) { here = moved; continue; }
        // `bash -c "..."` lost its separators with its quotes, so its destination
        // cannot be read: a push inside one fails closed.
        const inner = shellCommandString(seg);
        if (inner !== null) {
            if (/\bpush\b/.test(inner.replace(/["']/g, ''))) return { target: 'an unknown destination (a push inside a shell -c string)', dir: here };
            continue;
        }
        let g = parseGitSegment(seg, here);
        if (!g) {
            const toks = seg.split(/\s+/).filter(Boolean);
            const shell = /^(?:(?:ba|z|da|k)?sh|pwsh|powershell|cmd)$/.test(commandName(toks[skipWrappers(toks)]));
            const indirect = shell || /^(?:eval|xargs)$/.test(commandName(toks[skipWrappers(toks)]))
                || (commandName(toks[0]) === 'env' && toks.some((t) => /^(?:-S|--split-string)(?:=|$)/.test(t)));
            if (indirect && (/\bpush\b/.test(unescapeWord(unwrap(seg)).replace(/["']/g, ''))
                || (shell && mentionsPush && /<<|\|/.test(command)))) {
                return { target: 'an unknown destination (a push passed to a shell or indirect command)', dir: here };
            }
            continue;
        }
        if (mentionsPush && (/[${}`]/.test(g.sub) || (g.sub === 'push' && g.args.some((a) => /[${}`]/.test(a))))) {
            return { target: 'an unknown destination (shell expansion in a push)', dir: g.dir };
        }
        // xargs appends stdin to git's visible arguments. A here-string or
        // pipeline may therefore add a default-branch refspec to a bare push.
        if (g.sub === 'push' && g.env.some((a) => commandName(a) === 'xargs')) {
            return { target: 'an unknown destination (push arguments supplied by xargs)', dir: g.dir };
        }
        // These options change the repository or destinations independently of
        // the visible refspec. Only a plain, non-push alias is safe to retain.
        const unsafeConfig = g.configs.some((c) => {
            if (/^(?:remote|push)\./i.test(c)) return true;
            if (!/^alias\./i.test(c)) return false;
            const body = c.slice(c.indexOf('=') + 1).trim();
            return !c.includes('=') || !/^[a-z][\w-]*(?:\s+[^!$`;|&{}]*)?$/i.test(body) || /\bpush\b/.test(body);
        });
        const configEnv = g.globals.some((a) => a === '--config-env' || a.startsWith('--config-env='));
        const gitEnv = g.env.some((a) => /^GIT_(?:DIR|WORK_TREE|CONFIG_[A-Z0-9_]+)=/i.test(a));
        const aliasInvocation = g.configs.some((c) => c.toLowerCase().startsWith(`alias.${g.sub}=`))
            || (configEnv && g.globals.some((a) => /alias\./i.test(a)))
            || (gitEnv && /\bpush\b/.test(seg));
        if ((g.sub === 'push' || aliasInvocation) && (g.gitDir || g.globals.some((a) => /^--work-tree(?:=|$)/.test(a))
            || configEnv || gitEnv || unsafeConfig)) {
            return { target: 'an unknown destination (repository or push configuration override)', dir: g.dir };
        }
        if (g.sub !== 'push') {
            // `git -c alias.p=push p ...` runs push. The last definition wins, as in git.
            const def = g.configs.filter((c) => c.toLowerCase().startsWith(`alias.${g.sub}=`)).pop();
            if (!def) continue;
            const body = unescapeWord(def.slice(def.indexOf('=') + 1)).trim();
            const words = body.split(/\s+/);
            if (words[0] === 'push') g = { ...g, sub: 'push', args: words.slice(1).concat(g.args) };
            else if (/\bpush\b/.test(body)) return { target: `an unknown destination (alias ${g.sub} runs ${body})`, dir: g.dir };
            else continue;
        }
        const hit = defaultBranchPush(g);
        if (hit) return { target: hit, dir: g.dir };
    }
    return null;
}

// ===========================================================================
// THE SECOND GUARD IN THIS FILE: `--no-verify` ASKS. Added 2026-09-08.
//
// WHY IT LIVES HERE. `[measured 2026-09-08]` on this machine under load 38,
// interleaved medians of 7 on a no-op `ls -la` payload: a bare
// `process.exit(0)` subprocess 52.8 ms, pre-tool-filter.js on a Bash payload
// 58.5 ms, this hook with no role file 52.4 ms. Any new PreToolUse subprocess
// on Bash pays that floor on EVERY Bash call. A branch in the hook that already
// runs on Bash pays one regex on the quiet path and 10-50 µs of tokenising
// when the regex passes. Putting it in pre-tool-filter.js would also widen
// that hook's matcher to Bash and reverse the 2026-08-17 decision its suite
// asserts by name; this file is the one that already argued, at the top, why
// a narrow Bash guard is not that denylist.
//
// The recogniser, the reason, and the measurements behind both are in
// scripts/hook-bypass.js, shared with telemetry.js's PostToolUse rider, which
// asks for the RECORD after the command ran. An `ask` is a question, never a
// block, and with self-resolving panels it can be answered by nobody; the
// rider is what makes the recommended path the defensible one.
// ===========================================================================

let data;
try {
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

    // The third guard, first: a block beats the ask and the role check.
    // Quotes are removed first: the shell joins `"g""h"` into gh.
    const unquoted = command.replace(/["']/g, '');
    if (/\bgh\b/.test(unquoted) && /merge/.test(unquoted)) {
        const marker = path.join(os.homedir(), ...MERGE_MARKER_PARTS);
        if (fs.existsSync(marker)) {
            // gh expands {owner}, {repo} and {branch} itself; the splitter reads braces as groups.
            const hit = rawMergeSegment(commandSegments(stripNonCommandText(command.replace(/\{(owner|repo|branch)\}/g, '$1'))));
            if (hit) {
                const tool = path.join(__dirname, '..', 'scripts', 'merge-lock.js');
                process.stderr.write(`Blocked: merge-lock enforcement is on (${marker}), and \`${hit}\` merges a PR `
                    + 'outside the per-repo merge lock.\n'
                    + `Merge with: node "${tool}" merge --repo OWNER/NAME --pr N --head SHA --gate-receipt FILE\n`
                    + 'It refuses a head that is not the gated one or a base that moved, merges with '
                    + '--match-head-commit, and reads the merged tree back.\n'
                    + `To turn enforcement off, remove ${marker}.\n`);
                process.exit(2);
            }
        }
    }

    // The fourth guard: blocks before the ask, and before the role file, which exempts subagents.
    // Backslashes go too: the shell runs `pu\sh` as push.
    if (isSubagent(data)) {
        const hit = subagentDefaultPush(commandSegments(stripNonCommandText(command)), cwd, command);
        if (hit) {
            process.stderr.write(`Blocked: this subagent's \`git push\` would update ${hit.target} on the remote `
                + `of ${hit.dir}. A default branch moves only by PR through merge-lock.js, and on a product `
                + 'repo this push is a production deploy.\n'
                + 'Push a claude/<slug> branch instead and open a PR. The parent session merges it.\n');
            process.exit(2);
        }
    }

    // The ask is decided up front and DELIVERED at every allow below, so a
    // block (exit 2) still wins when both apply, and a session with no role
    // file, the common one, still gets asked. Quiet paths stay quiet: with no
    // bypass in the command, allow() writes nothing.
    const MAY_BYPASS = /no-verify|hookspath|(?:^|[\s"'=])-[A-Za-z]*n(?=[\s"']|$)/i;   // same as scripts/hook-bypass.js
    let bypass = null;
    let bypassReason = null;
    if (MAY_BYPASS.test(command)) {
        const lib = require(path.join(__dirname, '..', 'scripts', 'hook-bypass.js'));
        bypass = lib.findHookBypass(command, cwd);
        bypassReason = lib.bypassReason;
    }
    //
    // AN ASK NOBODY CAN ANSWER IS A DENIAL, and this repo has legitimate
    // bypasses, so an unattended session that cannot push is a stall, not a
    // save. [measured 2026-09-08] a hook under `claude -p` from a clean
    // environment sees CLAUDE_CODE_ENTRYPOINT=sdk-cli and AI_AGENT ending
    // _harness; this desktop session sees claude-desktop and _agent. A -p run
    // nested inside the desktop session INHERITS the entrypoint but the child
    // still sets its own AI_AGENT suffix, so both are read and either one means
    // unattended. There the same text goes out as additionalContext with no
    // permissionDecision: the model is told what it is skipping and where the
    // record goes, and is not gated on an answer nobody can give. An
    // interactive terminal session was not measured; if it were ever read as
    // unattended it would get the note instead of the prompt, which fails soft.
    const unattended = /_harness$/.test(process.env.AI_AGENT || '')
        || /^sdk-/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '');
    const allow = () => {
        if (bypass) {
            const reason = bypassReason(bypass);
            const out = { hookEventName: 'PreToolUse' };
            if (unattended) {
                out.additionalContext = '[no-verify] Unattended run, so this is a note rather than a question: ' + reason;
            } else {
                out.permissionDecision = 'ask';
                out.permissionDecisionReason = reason;
            }
            process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + '\n');
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
        .map(nativePath);
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
            /* READ THE FAULT, NOT THE STATE. This asked for `state === 'fault'`
               first, which coupled one question -- is the claimed session live,
               the only thing this rail turns on -- to a verdict that answers a
               different one: whether any ADDRESS in the record still reaches.
               `faults` is empty for `ok` and `absent`, so the find alone is the
               whole condition.

               ⚠️ THIS IS DEFENCE, NOT A FIX, and the comment said otherwise
               until 2026-09-09. It claimed a record "can now be `degraded` while
               `session_id` is dead and this rail is armed for nobody", which is
               UNREACHABLE THROUGH THIS CALL SITE and always was. The call below
               passes `store: null`, so `found.record` is null, so
               `desktop.resolves` is false and the peer/desktop corroboration
               anchor cannot form; a dead `session_id` kills the other anchor.
               `reach.usable` is therefore necessarily empty whenever
               `dead-session` fires, and the state is `fault` every time.
               `[measured 2026-09-09]` all 75 role shapes reachable here were
               enumerated: 30 `fault` with dead-session, 39 `fault` without, 2
               `degraded`, 4 `ok`, and ZERO where the two conditions differ.

               So the two expressions are equivalent at this call site, which is
               why no suite can tell them apart and why the case below asserts
               the equivalence rather than a behaviour change. The reason to
               keep this form is that the equivalence is a property of an
               argument passed twenty lines up: pass a store here one day and
               the old form starts answering the wrong question silently. A
               guard whose correctness depends on a caller's argument should not
               also depend on the reader noticing that. */
            const dead = verdict ? verdict.faults.find((f) => f.code === 'dead-session') : null;
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

    // A dispatched worker is not the coordinator, even though it carries the
    // coordinator's session_id. See isSubagent above.
    if (isSubagent(data)) allow();

    const scratch = scratchRoots();
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
            .filter((d) => !homes.some((h) => isInside(h, d)))
            .filter((d) => !(SCRATCH_LOCAL_VERBS.has(g.sub) && scratch.some((s) => isInside(s, d))));
        if (!foreign.length) continue;
        if (closedRunPush(g)) continue;
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
        + (h.sub === 'push' ? `The one push allowed is a closed unattended-worker run's branch, from its worktree: `
            + `git -C <worktree> push [-u] origin <branch>, as its record in ${ledgerPath()} names them.\n` : '')
        + `To stand down the role deliberately, remove ${rolePath}.\n`);
    process.exit(2);
} catch (err) {
    // Retain the parsed payload across the try: malformed cwd/command types
    // must not turn an uncheckable subagent push into permission to execute it.
    const pushFailed = data && isSubagent(data) && String(data.tool_input?.command || '').includes('push');
    try {
        if (pushFailed) process.stderr.write(`Blocked: this subagent's \`git push\` could not be checked (${err && err.message}).\n`);
        else process.stderr.write(`coordinator-write-guard: skipped (${err && err.message}); `
            + `git writes were NOT guarded on this call\n`);
    } catch { /* stderr itself is gone; there is nothing further to try */ }
    process.exitCode = pushFailed ? 2 : 0;
}
