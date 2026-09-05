#!/usr/bin/env node
// PreToolUse hook on Bash — the coordinator-write ban, as a mechanism.
// Exit 2 = block, exit 0 = allow.
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
//   * It is INERT unless a role file exists. In every session without one — the
//     overwhelming majority, including every user who installs this plugin and
//     never coordinates anything — it reads one path that is not there and
//     exits 0 with zero bytes on both streams.
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
        + 'Role file: $AUTODEV_BRAIN_ROLE_FILE, else ~/.claude/brain-role.json. Absent = inert.');
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

function stripNonCommandText(command) {
    let s = String(command);

    // <<EOF / <<-EOF / <<'EOF' / <<"EOF" … up to a line that is the delimiter.
    s = s.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?(?:^[ \t]*\2[ \t]*$|$)/gm,
        (m) => m.split('\n')[0]);

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

    // Cheapest discriminator first: no role file, no opinion, zero bytes. This
    // is the branch that runs in every session that is not coordinating, so it
    // must cost one failed stat and nothing else.
    const rolePath = roleFilePath();
    let roleRaw;
    try {
        roleRaw = fs.readFileSync(rolePath, 'utf8');
    } catch {
        process.exit(0);
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
        process.exit(0);
    }

    const homes = []
        .concat(Array.isArray(role.home_repos) ? role.home_repos : [])
        .concat(typeof role.home_repo === 'string' ? [role.home_repo] : [])
        .filter((h) => typeof h === 'string' && h.length);
    if (!homes.length) {
        process.stderr.write(`coordinator-write-guard: ${rolePath} declares no home_repo/home_repos, `
            + `so every directory would count as foreign; not guarding rather than blocking everything.\n`);
        process.exit(0);
    }

    const claimed = typeof role.session_id === 'string' && role.session_id.length
        ? role.session_id : null;
    const mine = data.session_id || null;

    const cwd = path.resolve(data.cwd || process.cwd());
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
        process.exit(0);
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
    if (!hits.length) process.exit(0);

    // Would have blocked, but cannot confirm the holder is this session. Say so
    // HERE rather than on every call: a warning that fires constantly gets
    // muted, and a warning that fires only at the moment it matters does not.
    if (claimed && !mine) {
        process.stderr.write(`coordinator-write-guard: ${rolePath} claims session ${claimed}, but this `
            + `hook payload carries no session_id, so the holder could not be confirmed. `
            + `Allowing \`git ${hits[0].sub}\` in ${hits[0].at} UNCHECKED.\n`);
        process.exit(0);
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
