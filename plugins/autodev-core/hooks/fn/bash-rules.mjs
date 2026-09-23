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
//             measurement.
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
];

/**
 * Whether `repo` (as `$.session.repo()` returns it) is this plugin's own
 * repository, where the deny rules apply. Matched on the remote's path or the
 * working tree's directory name; a fork under another name is a different
 * repository with its own CLAUDE.md.
 */
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
    const ctx = { windows: isWindowsPath(cwd), inRepo: isAutodevRepo(repo) };

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
