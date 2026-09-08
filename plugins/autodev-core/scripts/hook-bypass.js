#!/usr/bin/env node
// hook-bypass.js — recognise a git command that skips a git hook, and say
// which one. Shared by two hooks that already run on every call:
//
//   * coordinator-write-guard.js (PreToolUse on Bash) ASKS before the command
//     runs, with bypassReason();
//   * telemetry.js (PostToolUse on everything) NOTES after it ran, with
//     bypassRecordNote(), so the record still gets asked for when the ask
//     self-resolved: an away window auto-takes the recommended option, and a
//     reason nobody read is not a record.
//
// Neither hook loads this file on its quiet path: both gate the require on
// MAY_BYPASS, a substring test over the command text, so the per-call cost of
// this module in a session that never bypasses anything is one regex.
//
// WHY ASK, NOT DENY. `[measured 2026-09-07]` a push with --no-verify over a
// gate that was red at origin/main for a host-shaped reason (the `claude` on
// PATH was 2.1.233) was the CORRECT call, and its reasoning was written into
// the tree. Across two repos, `git log --all -i --grep=no-verify` finds 4 and
// 0 commits; the 4 are 2 messages each seen twice (branch commit and squash
// merge): one is that recorded bypass, one is prose about the pressure toward
// bypassing. So the constraint is "deliberate and recorded", not "impossible".
// A checker over commit bodies was measured against a population of one
// already-compliant instance and not built.
//
// WHY NOT RUN THE A/B IN THE HOOK. The question that decides whether a bypass
// is right is whether the same red reproduces at the base branch. `[measured
// 2026-09-08]` tooling/validate.js takes 1.8 s here at load 38, the PreToolUse
// budget is 5 s shared with a worktree add, and load reached 162 the same
// night; a timed-out hook drops the ask silently on exactly the case it
// exists for. So the reason NAMES the check and the model runs it.
//
// WHAT IT MATCHES. A word in command position that is `git`, whose subcommand
// is one of six, carrying `--no-verify` as a shell word; or `-n` in a short
// cluster for the two subcommands where `-n` means --no-verify (`[measured
// 2026-09-08]` git 2.50.1: commit and am; on push it is --dry-run, on merge
// and rebase --no-stat, on cherry-pick --no-commit); or a `-c core.hooksPath=`
// global override in front of any of the six; `sh|bash -c "…"` followed one
// level. cherry-pick is on the list from ECC's; on 2.50.1 it does not accept
// the flag at all, so an ask there is about a command git would reject.
//
// WHAT IT DOES NOT MATCH, each with a case in the suites: the string inside a
// quoted -m message, a heredoc body, a here-string, a grep pattern, a comment,
// a piped or redirected echo, a pathspec after `--`, and `-n` on any other
// subcommand. QUOTES DO NOT HIDE A FLAG: the shell strips them before git sees
// the word, so `git push "--no-verify"` is a bypass. What keeps a quoted
// message quiet is that `-m` takes a value, which is why each subcommand
// carries a table of its value-taking options. The first draft keyed on
// whether the `-` was quoted and would have been silent on the quoted
// spelling. Ported from ECC's block-no-verify.js (affaan-m/ecc, MIT): the
// commit value-option table and the short-cluster rule; not its byte-offset
// search.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The cheap gate both hooks test BEFORE requiring this file. Generous on
 * purpose: `--dry-run` passes it and is then rejected by the tokeniser, which
 * costs microseconds; a spelling it misses is a bypass nobody asked about.
 * Kept identical in the two hooks; the suites drive every positive case
 * through each hook, so a prefilter that lost one shows as a red ask.
 */
const MAY_BYPASS = /no-verify|hookspath|(?:^|[\s"'=])-[A-Za-z]*n(?=[\s"']|$)/i;

/** <<EOF / <<-EOF / <<'EOF' / <<"EOF" … up to a line that is the delimiter. */
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?(?:^[ \t]*\2[ \t]*$|$)/gm;

/** Resolve a path argument the way the shell would hand it to git: `~` and `$HOME` expanded, then against `base`. */
function resolvePath(base, raw) {
    const home = os.homedir();
    const expanded = String(raw).replace(/^~(?=$|[/\\])/, home).replace(/^\$HOME(?=$|[/\\])/, home);
    return path.resolve(base, expanded);
}

/** The one sentence both surfaces end on: what a record is, and where it goes. */
const RECORD_WHAT = 'a one-line justification in the commit or PR body that names the gate skipped, why it was red, '
    + 'and whether the same red reproduces at the base branch (a detached worktree of the default branch, same script), '
    + 'so the bypass stays distinguishable from a push that simply skipped the gate.';

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
            if (v !== undefined && t === '-C') dir = resolvePath(dir, v);
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
            if (args.length) here = resolvePath(here, args[0]);
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
function gateFileClause(hit) {
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
    return here;
}

/** "`git push --no-verify` skips the pre-push hook. Here that is …" */
function skipsWhat(hit, here = gateFileClause(hit)) {
    const hooks = BYPASS_SUBCOMMANDS[hit.sub];
    return `\`git ${hit.sub} ${hit.via}\` skips the ${hooks.join(' and ')} hook${hooks.length > 1 ? 's' : ''}.${here}`;
}

/** The PreToolUse ask reason. */
function bypassReason(hit) {
    return `${skipsWhat(hit)} `
        + 'A bypass can be the right call (a gate red at the base commit for a reason that is not this change\'s), '
        + 'but it has to be deliberate and RECORDED, and this hook cannot see the answer to this question. '
        + `Allow it only with ${RECORD_WHAT}`;
}

/** The PostToolUse note, after the command ran and the ask (if any) was answered. */
function bypassRecordNote(hit) {
    return `[no-verify] This call ran \`git ${hit.sub} ${hit.via}\`, and ${skipsWhat(hit).replace(/^`[^`]*` /, '')} `
        + `Record it now, while the reason is in front of you: ${RECORD_WHAT}`;
}

module.exports = { MAY_BYPASS, HEREDOC_RE, BYPASS_SUBCOMMANDS, shellWords, findHookBypass, bypassReason, bypassRecordNote, skipsWhat };

if (require.main === module) {
    const cmd = process.argv.slice(2).filter((a) => a !== '--help' && a !== '-h').join(' ');
    if (!cmd) {
        console.log('usage: hook-bypass.js <command…>   prints the bypass a shell command performs, or "none"\n'
            + 'Library for coordinator-write-guard.js (ask) and telemetry.js (record note); see the header.');
        process.exit(0);
    }
    const hit = findHookBypass(cmd, process.cwd());
    console.log(hit ? bypassReason(hit) : 'none');
}
