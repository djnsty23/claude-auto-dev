// bash-rules.mjs — the Bash rules a shell hook could only warn about, decided
// before the command runs. Pure: takes strings, returns a decision.
//
// Two kinds of rule, and the difference is the whole design:
//
//   rewrite   changes a flag the command should have carried and tells the
//             model it did so. A rewrite cannot block work; the worst case is
//             a flag the command did not need.
//   deny      refuses the call with the rule's reason. Three denies are scoped
//             to THIS repository (`scope: 'repo'`): the commands its CLAUDE.md
//             forbids by name. A text denylist over Bash was measured on
//             2026-08-17 to have blocked 807 legitimate calls and zero
//             dangerous ones, so these are exact shapes, not a list, and a new
//             one needs its own measurement. The fourth, `msys-pathconv`, is
//             Windows-only and unscoped; its measurement is in its comment.
//             The fifth, `argv-credential`, is unscoped too, and so is its
//             measurement. The sixth, `worktree-placement`, is unscoped
//             and measured in its comment.
//
// A rewrite must not change a command's FIRST TOKEN: the permission layer
// matches an allowlist on it, inside next(e), so a prefix that the model never
// wrote turns an allowed command into a prompt. Appending a flag is safe;
// prefixing an env var is not, which is why msys-pathconv is a deny.
//
// The command is split into pipeline segments so a rule reads the command
// that RUNS, not text that mentions it: `grep "git commit -m" file` starts
// with grep and matches nothing. Text after a heredoc opener is not examined,
// since a commit body that quotes this file's own rule must not trip it.

import { CREDENTIAL_FLAG, isPlaceholderValue } from './redact.mjs';

const SEGMENT_SPLIT_RE = /(\s*(?:&&|\|\||;|\|)\s*|\r?\n)/;
const ENV_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const GIT_OPTS = String.raw`(?:(?:-C|--git-dir|--work-tree)\s+\S+\s+|--no-pager\s+|-c\s+\S+\s+)*`;
const GIT_SUBCOMMAND = (name) => new RegExp(`^\\s*${ENV_PREFIX}git\\s+${GIT_OPTS}${name}\\b([\\s\\S]*)$`);

const GIT_COMMIT_RE = GIT_SUBCOMMAND('commit');
const GIT_ADD_RE = GIT_SUBCOMMAND('add');
const GIT_REV_READ_RE = GIT_SUBCOMMAND('(?:cat-file|show)');
const DOPPLER_WRITE_RE = /^(\s*doppler\s+secrets\s+(?:set|delete|del|upload|rm))\b/;
const ARGV_CREDENTIAL_RE = new RegExp(CREDENTIAL_FLAG + String.raw`(?:=|\s+)["']?([^\s"']+)`, 'gi');
// What the shell expands into argv: `$VAR`, `${VAR}`, `$(...)`, backticks, `$env:VAR`, `%VAR%`.
const EXPANDS_INTO_ARGV_RE = /^(?:\$[({A-Za-z_]|\$env:|%[A-Za-z_]|`)/i;

/** A credential flag whose value reaches argv: an expansion, or a literal of
 *  12+ characters that is not a placeholder. A following flag is no value. */
function argvCredential(segment) {
    for (const m of segment.matchAll(ARGV_CREDENTIAL_RE)) {
        const value = m[1];
        if (value.startsWith('-')) continue;
        if (EXPANDS_INTO_ARGV_RE.test(value)) return true;
        if (value.length >= 12 && !isPlaceholderValue(value)) return true;
    }
    return false;
}

// A short-option cluster carrying the letter: `-m`, `-am`, `-sm "x"`.
const SHORT_FLAG = (letter) => new RegExp(`(?:^|\\s)-[a-zA-Z]*${letter}[a-zA-Z]*(?=\\s|=|$)`);
const COMMIT_MESSAGE_RE = new RegExp(`${SHORT_FLAG('m').source}|(?:^|\\s)--message(?:=|\\s|$)`);
const ADD_ALL_RE = new RegExp(`${SHORT_FLAG('A').source}|(?:^|\\s)--all(?=\\s|$)`);
const AMEND_RE = /(?:^|\s)--amend(?=\s|$)/;
// `rev:.path` — a bare leading dot right after the colon is the shape MSYS
// mangles; `rev:./path` and `rev:dir/.file` are fine.
const DOT_LEADING_REV_PATH_RE = /\S+:\.[^\s\\/.]/;

// --- worktree placement -----------------------------------------------------
// Paths are handled as strings with forward slashes, never through node:path:
// the helpers here stay pure, and the session's cwd is a Windows path while the
// command is Git Bash text. `/c/x` is the same directory as `C:/x` there.

/** Split one segment into shell words. Null on an unbalanced quote. A word
 *  that the shell would expand (`$`, backticks) is marked, and so is a leading `~/`. */
function shellWords(segment) {
    const words = [];
    let cur = null;
    const start = () => { if (!cur) cur = { text: '', expands: false, tilde: false }; };
    let quote = null;
    const src = String(segment);
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote === "'") {
            if (c === "'") quote = null; else cur.text += c;
            continue;
        }
        if (quote === '"') {
            if (c === '"') { quote = null; continue; }
            if (c === '\\' && i + 1 < src.length && '$`"\\'.includes(src[i + 1])) { cur.text += src[++i]; continue; }
            if (c === '$' || c === '`') cur.expands = true;
            cur.text += c;
            continue;
        }
        if (/\s/.test(c)) { if (cur) { words.push(cur); cur = null; } continue; }
        start();
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === '\\') { if (i + 1 < src.length) cur.text += src[++i]; continue; }
        if (c === '$' || c === '`') cur.expands = true;
        if (c === '~' && cur.text === '') {
            if (/^(?:\/|\s|$)/.test(src.slice(i + 1, i + 2))) cur.tilde = true; else cur.expands = true;
        }
        cur.text += c;
    }
    if (quote) return null;
    if (cur) words.push(cur);
    return words;
}

function slashPath(p, windows) {
    let t = String(p).replace(/\\/g, '/');
    if (windows) {
        const m = t.match(/^\/([A-Za-z])(?=\/|$)/);
        if (m) t = m[1] + ':' + t.slice(2);
    }
    return t;
}

function normalizePath(t) {
    const drive = /^[A-Za-z]:/.test(t) ? t.slice(0, 2).toUpperCase() : '';
    const out = [];
    for (const part of (drive ? t.slice(2) : t).split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop(); else out.push(part);
    }
    return drive + '/' + out.join('/');
}

/** An absolute, normalized path, or null when it cannot be known from text. */
function resolvePath(base, p, windows) {
    const t = slashPath(p, windows);
    if (windows ? /^[A-Za-z]:\//.test(t) : t.startsWith('/')) return normalizePath(t);
    // Git Bash maps `/tmp` and friends onto its own install root.
    if (t.startsWith('/') || /^[A-Za-z]:/.test(t) || !base) return null;
    return normalizePath(base + '/' + t);
}

// The home a `~/` names, read from where the session stands: `C:/Users/<me>`,
// `/home/<me>` or `/Users/<me>`. Anywhere else a `~/` word stays unread.
const HOME_RE = /^(?:[A-Z]:\/Users\/[^/]+|\/home\/[^/]+|\/Users\/[^/]+)(?=\/|$)/i;
function resolveWord(word, base, ctx) {
    if (!word || word.expands) return null;
    if (!word.tilde) return resolvePath(base, word.text, ctx.windows);
    const home = ((ctx.start || '').match(HOME_RE) || [])[0];
    return home ? normalizePath(home + '/' + word.text.slice(1)) : null;
}

const pathKey = (p, windows) => (windows ? p.toLowerCase() : p).replace(/\/+$/, '');
function pathInside(child, parent, windows) {
    const c = pathKey(child, windows);
    const q = pathKey(parent, windows);
    return c === q || c.startsWith(q + '/');
}

// Where gate sweeps and exports make throwaway worktrees and remove them:
// worktree-placement.js calls these `transient`, not misplaced.
const TRANSIENT_RE = /(?:^|\/)(?:tmp|temp)(?:\/|$)|^\/(?:private\/)?var\/folders\//i;

// `git [globals] worktree add [options] <path> [<commit-ish>]`
const WORKTREE_VALUE_OPTS = new Set(['-b', '-B', '--reason']);
const REDIRECT_RE = /^\d*(?:>>?|<|>&|&>)/;
// A redirection written alone, whose target is the next word: `2> err.txt`.
const REDIRECT_BARE_RE = /^\d*(?:>>?|<|>&|&>)$/;

/**
 * When this segment is a `git worktree add` whose destination is known from
 * the text and is not under its repository's `.claude/worktrees/` (or a temp
 * dir), what to say. Null for everything else, and for anything it cannot read.
 */
function misplacedWorktree(segment, ctx) {
    if (!/\bworktree\b/.test(segment) || !/\badd\b/.test(segment)) return null;
    try {
        const words = shellWords(segment);
        if (!words) return null;
        let i = 0;
        while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text)) i++;
        if (!words[i] || !/^git(?:\.exe)?$/.test(words[i].text)) return null;
        i++;
        let base = ctx.dir;
        let viaC = false;
        for (; i < words.length && words[i].text.startsWith('-'); i++) {
            const w = words[i].text;
            if (w === '-C') {
                base = resolveWord(words[++i], base, ctx);
                if (!base) return null;
                viaC = true;
            } else if (w === '-c') i++;
            else if (/^--(?:git-dir|work-tree)/.test(w)) return null;
        }
        if (!words[i] || words[i].text !== 'worktree' || !words[i + 1] || words[i + 1].text !== 'add') return null;
        const args = words.slice(i + 2);
        let at = -1;
        for (let k = 0; k < args.length; k++) {
            const w = args[k].text;
            if (w === '--') { at = k + 1 < args.length ? k + 1 : -1; break; }
            if (REDIRECT_RE.test(w)) { if (REDIRECT_BARE_RE.test(w)) k++; continue; }
            if (WORKTREE_VALUE_OPTS.has(w)) { k++; continue; }
            if (w.startsWith('-')) continue;
            at = k;
            break;
        }
        if (at === -1 || !base) return null;
        // Outside any repository, with nothing naming one, git refuses the add itself.
        if (!ctx.repoRoot && !viaC && !ctx.moved) return null;
        const dest = resolveWord(args[at], base, ctx);
        if (!dest || TRANSIENT_RE.test(dest)) return null;

        // The repository the command acts on: the session's own when it stands
        // inside it, else the one a worktree path names, else the directory itself.
        let root;
        if (ctx.repoRoot && pathInside(base, ctx.repoRoot, ctx.windows)) root = ctx.repoRoot;
        else {
            const cut = pathKey(base, ctx.windows).indexOf('/.claude/worktrees/');
            root = cut === -1 ? base : base.slice(0, cut);
        }
        const home = root.replace(/\/+$/, '') + '/.claude/worktrees';
        if (pathInside(dest, home, ctx.windows) && pathKey(dest, ctx.windows) !== pathKey(home, ctx.windows)) return null;

        const name = dest.replace(/\/+$/, '').split('/').pop() || 'wt';
        const correct = home + '/' + name;
        const quote = (t) => (/^[\w@%+=:,./-]+$/.test(t) ? t : '"' + t.replace(/(["\\$`])/g, '\\$1') + '"');
        // The suggestion is the command alone: redirections are left for the caller to put back.
        const shown = [];
        for (let k = 0; k < args.length; k++) {
            if (k !== at && REDIRECT_RE.test(args[k].text)) { if (REDIRECT_BARE_RE.test(args[k].text)) k++; continue; }
            shown.push(k === at ? quote(correct) : quote(args[k].text));
        }
        const rest = shown.join(' ');
        return { dest, root, correct, command: `git -C ${quote(root)} worktree add ${rest}`, viaC };
    } catch {
        return null;
    }
}

/** The directory a `cd` segment moves to; undefined when the segment is no cd, null when unknown. */
function cdTarget(segment, dir, ctx) {
    if (!/^\s*(?:cd|pushd)\b/.test(segment)) return undefined;
    const words = shellWords(segment);
    if (!words || !/^(?:cd|pushd)$/.test(words[0].text)) return undefined;
    const args = words.slice(1).filter((w) => !REDIRECT_RE.test(w.text));
    if (args.length !== 1 || args[0].text === '-') return null;
    return resolveWord(args[0], dir, ctx);
}

export const RULES = [
    {
        id: 'git-commit-m',
        kind: 'deny',
        scope: 'repo',
        test: (segment) => {
            const m = segment.match(GIT_COMMIT_RE);
            return !!m && COMMIT_MESSAGE_RE.test(m[1]);
        },
        reason: 'CLAUDE.md: `git commit -F <file>`, never `-m`. The shell eats backticks in an inline message and force-push is blocked, so a mangled message cannot be amended.',
    },
    {
        id: 'git-commit-amend',
        kind: 'deny',
        scope: 'repo',
        test: (segment) => {
            const m = segment.match(GIT_COMMIT_RE);
            return !!m && AMEND_RE.test(m[1]);
        },
        reason: 'CLAUDE.md: never `git commit --amend` here. Several sessions commit to this clone at once and HEAD moves in seconds; commit small and forward.',
    },
    {
        id: 'git-add-all',
        kind: 'deny',
        scope: 'repo',
        test: (segment) => {
            const m = segment.match(GIT_ADD_RE);
            return !!m && ADD_ALL_RE.test(m[1]);
        },
        reason: 'CLAUDE.md: stage explicit paths, never `git add -A`. The same concurrency sweeps another session\'s in-flight work into your commit.',
    },
    {
        id: 'doppler-silent',
        kind: 'rewrite',
        scope: 'all',
        test: (segment) => DOPPLER_WRITE_RE.test(segment) && !/(?:^|\s)--silent(?=\s|$)/.test(segment),
        apply: (segment) => segment.replace(DOPPLER_WRITE_RE, '$1 --silent'),
        note: 'added `--silent` to a doppler write: without it the CLI prints the whole remaining secret store, values included, on every outcome.',
    },
    {
        // A DENY, not a rewrite, and the only deny that is not repo-scoped.
        // It began as a rewrite that prefixed `MSYS_NO_PATHCONV=1`, and
        // [measured 2026-09-04] that turned an allowlisted `git show` into a
        // command needing approval: the permission layer runs inside next(e)
        // and matches on the command's first token, which the prefix had
        // changed. A prompt for a command the model never wrote reads as the
        // plugin breaking permissions. Refusing with the exact command to run
        // keeps the decision deterministic and makes the prefixed command the
        // model's own, so any prompt it draws is for what the model chose.
        // The unrefused read fails 2 of 2 times on a dot-leading path
        // (rules/verification-traps.md, the `rev:path` table) with "not a
        // valid object name", and a `|| echo` fallback then reports a present
        // file as missing, which is the outcome this rule exists to prevent.
        id: 'msys-pathconv',
        kind: 'deny',
        scope: 'all',
        test: (segment, ctx) => ctx.windows
            && GIT_REV_READ_RE.test(segment)
            && DOT_LEADING_REV_PATH_RE.test(segment)
            && !/(?:^|\s)MSYS_NO_PATHCONV=1\s/.test(segment),
        reason: (segment) => 'Git Bash on Windows rewrites a `rev:.path` argument as a Windows path list, so this read fails as "not a valid object name" and a `|| echo` fallback then reports a present file as missing. Run it with the conversion off, as your own command: `MSYS_NO_PATHCONV=1 '
            + segment.trim() + '` (or through PowerShell, which has no MSYS layer).',
    },
    {
        // Unscoped: a token in argv is readable in the process list by anything
        // on the machine for as long as the process runs, which is how a deploy
        // token leaked on 2026-09-16. `[measured 2026-09-24]` 30 days of
        // transcripts, 137,892 Bash calls: 250 segments passed `--token` a value,
        // and 243 were `$VAR` or `$(...)` handed to vercel or doppler, the leak
        // itself. Of the other 7, five short literals and one placeholder were
        // text inside scripts and stay allowed. One 12+ literal was a JS array
        // inside a `node -e` script, and this rule refuses it: 1 false
        // refusal in 244. The flag is redact.mjs's CREDENTIAL_FLAG.
        id: 'argv-credential',
        kind: 'deny',
        scope: 'all',
        test: (segment) => argvCredential(segment),
        reason: 'A credential on the command line is readable in the process list by anything on the machine while the process runs, '
            + 'and `--token $X` puts the expanded value there. Pass it through the environment variable the CLI reads, in the same command: '
            + '`VERCEL_TOKEN="$(doppler secrets get VERCEL_TOKEN --plain)" vercel deploy --prod`. '
            + 'vercel reads VERCEL_TOKEN, gh reads GH_TOKEN, doppler reads DOPPLER_TOKEN, supabase reads SUPABASE_ACCESS_TOKEN.',
    },
    {
        // Unscoped: every repository keeps its worktrees in <root>/.claude/worktrees/.
        // `[measured 2026-09-22]` twelve worktrees had landed beside their repos
        // in the code root, and on 2026-09-24 three more were still appearing.
        // A sibling worktree is invisible from inside its repo and reads as one
        // more project in the code root. worktree-placement.js finds them after
        // the fact. This refuses the hand-typed `git worktree add` that makes one.
        // EnterWorktree and `isolation: "worktree"` already use the right place.
        //
        // It reads only what the text states. A destination or a `-C` built from
        // `$VAR`, `$(...)`, backticks or `~user` is allowed unread, and so is a
        // temp dir, where gate sweeps make worktrees they remove. A leading `~/`
        // resolves against the home the cwd shows (`C:/Users/<me>`, `/home/<me>`,
        // `/Users/<me>`), and stays unread when the cwd shows none. A literal `cd`
        // earlier in the command moves the base, and an unreadable one stops it.
        //
        // `[measured 2026-09-24]` over 30 days of one operator's transcripts
        // (1,703 files, 144,166 Bash calls, 794 commands naming `worktree add`)
        // it refuses 37 and allows 757. 35 refusals were worktrees beside a repo
        // or loose in the code root. One passed a ref where the path goes, so git
        // would have made a worktree named after the branch, and the refusal
        // names that path. One was a deliberate worktree on another drive: that
        // is the cost, one in 37, and a path held in a variable still passes.
        // Before `~/` was resolved it missed one leak, a `cd ~/...` followed by
        // an absolute sibling path, which it now refuses.
        id: 'worktree-placement',
        kind: 'deny',
        scope: 'all',
        test: (segment, ctx) => !!misplacedWorktree(segment, ctx),
        reason: (segment, ctx) => {
            const m = misplacedWorktree(segment, ctx);
            return `This puts a worktree at ${m.dest}, outside ${m.root}/.claude/worktrees/. A worktree beside its repo is invisible from inside the repo `
                + 'and reads as one more project in the code root. Put it where every other worktree of this repo lives: '
                + `\`${m.command}\``;
        },
    },
];

/**
 * Whether `repo` (as `$.session.repo()` returns it) is this plugin's own
 * repository, where the deny rules apply. Matched on the remote's path or the
 * working tree's directory name; a fork under another name is a different
 * repository with its own CLAUDE.md.
 */
export { misplacedWorktree, shellWords, resolvePath };

export function isAutodevRepo(repo) {
    if (!repo || typeof repo !== 'object') return false;
    const remote = typeof repo.remote === 'string' ? repo.remote : '';
    const root = typeof repo.root === 'string' ? repo.root : '';
    if (/[/:]claude-auto-dev(?:\.git)?\/?$/.test(remote)) return true;
    const base = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return base === 'claude-auto-dev';
}

export function isWindowsPath(p) {
    return /^[A-Za-z]:[\\/]/.test(String(p || ''));
}

/**
 * Decide a Bash command.
 *
 * @param {{ command: string, cwd?: string, repo?: object|null }} input
 * @returns {{ deny: string, rule: string } | { command: string, notes: string[], rules: string[] }}
 */
export function decideBash({ command, cwd, repo }) {
    const original = String(command ?? '');
    const windows = isWindowsPath(cwd);
    const start = typeof cwd === 'string' && cwd ? resolvePath(null, cwd, windows) : null;
    const root = repo && typeof repo.root === 'string' && repo.root ? resolvePath(null, repo.root, windows) : null;
    const ctx = { windows, inRepo: isAutodevRepo(repo), start, dir: start, repoRoot: root, moved: false };

    // Everything from the first heredoc opener on is body text, not commands.
    const heredocAt = original.search(/<<-?\s*['"]?[A-Za-z_]/);
    const head = heredocAt === -1 ? original : original.slice(0, heredocAt);
    const tail = heredocAt === -1 ? '' : original.slice(heredocAt);

    const parts = head.split(SEGMENT_SPLIT_RE);
    const notes = [];
    const rules = [];
    for (let i = 0; i < parts.length; i += 2) {
        let segment = parts[i];
        if (!segment || !segment.trim()) continue;
        const moved = cdTarget(segment, ctx.dir, ctx);
        if (moved !== undefined) { ctx.dir = moved; ctx.moved = true; continue; }
        for (const rule of RULES) {
            if (rule.scope === 'repo' && !ctx.inRepo) continue;
            if (!rule.test(segment, ctx)) continue;
            if (rule.kind === 'deny') {
                const reason = typeof rule.reason === 'function' ? rule.reason(segment, ctx) : rule.reason;
                return { deny: reason, rule: rule.id };
            }
            segment = rule.apply(segment, ctx);
            notes.push(rule.note);
            rules.push(rule.id);
        }
        parts[i] = segment;
    }
    return { command: parts.join('') + tail, notes, rules };
}
