#!/usr/bin/env node
'use strict';
// env-file-read.js: does a Bash command print a .env file into the transcript?
//
// WHY. `[measured 2026-09-29]` a command described as "Show env file structure
// with values masked" ran
//
//     sed -E 's/^([^=#]*)=.*/\1=<v>/' .env.local.stage | sed -E 's/^(#.{0,60}).*/\1/' | ...
//
// and put 9 live credentials into a transcript. The mask handled `KEY=value`
// lines. Its second sed kept the first 60 characters of every comment line,
// and a commented-out key is still a live key. That is the general shape: a
// mask rewrites the lines its pattern matches and passes every other line
// through, so its safety depends on a file nobody has looked at. The prose
// rule (list keys with a capture that prints only the match, never lines) was
// in force that day. This makes it a mechanism.
//
// WHAT IS REFUSED. A segment whose command is a reader (cat, sed, awk, cut,
// grep and their siblings below) and which names a .env file as an input, by
// argument or by `<`. Whatever masking it attempts: `sed 's/=.*//'`, `cut
// -d= -f1` and `awk -F= '{print $1}'` all pass a line with no `=` through
// whole.
//
// WHAT IS ALLOWED, because nothing but a name, a count or a file name reaches
// the transcript:
//   - `grep -oE '^[A-Z][A-Z0-9_]*' .env`: -o with patterns anchored at the
//     line start that match only a key (the rules' sanctioned form). A trailing
//     `=` and top-level alternatives, each anchored, still match only a key.
//   - `grep -c`, `-l`, `-L`, `-q` and their long forms, `rg --files`
//   - a pipe whose output ends in a count or a key: `grep KEY .env | wc -l`,
//     `cat .env | grep -oE '^[A-Z_]*='`
//   - a reader whose stdout goes to a file (`grep -v OLD .env > .env.new`),
//     and `sed -i`, which writes the file back and prints nothing
//   - templates: `.env.example`, `.env.sample`, `.env.template` and the like
//   - anything inside `$(...)` or backticks, whose output is captured:
//     `export $(grep -v '^#' .env | xargs)` loads the file and prints nothing
//   - non-readers: `source .env`, `ls .env*`, `cp`, `node x.js --from .env`
//
// WHAT IT DOES NOT SEE, stated so a green is not over-read: a recursive grep
// over a directory that holds a .env (`grep -rn KEY .`), a file named through
// a variable (`cat "$F"`), a reader run by `bash -c` or `xargs`, an
// interpreter reading it (`node -e`, `python -c`), and PowerShell's
// Get-Content. The permission layer and the output scrubber are the layers
// for those.
//
// The measurement over real transcripts is in the header of the hook that
// calls this, coordinator-write-guard.js.

// Commands that write their input to stdout, or a transform of it.
const READERS = new Set([
    'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'bat', 'batcat',
    'sed', 'awk', 'gawk', 'mawk', 'nawk', 'cut', 'tr', 'paste', 'column',
    'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'diff',
    'strings', 'od', 'xxd', 'hexdump', 'base64',
]);
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg']);
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
// Words that run the next word as the command.
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nice', 'nohup', 'time', 'env', 'builtin']);

// Short options that take a value, per tool: attached (`-m1`) or the next word (`-m 1`).
const VALUE_SHORT = {
    grep: 'efmABCdD', rg: 'efgtTmABCMjrE', sed: 'efl', awk: 'Fvfil', cut: 'dfcb',
    head: 'nc', tail: 'nc', sort: 'ktoST', uniq: 'fsw', nl: 'bdfhilnsvw', od: 'AjNtw', xxd: 'cglos',
};
const VALUE_LONG = new Set([
    'regexp', 'file', 'max-count', 'context', 'after-context', 'before-context', 'include', 'exclude',
    'exclude-dir', 'glob', 'iglob', 'type', 'type-not', 'replace', 'label', 'devices', 'directories',
    'binary-files', 'encoding', 'max-depth', 'max-columns', 'threads', 'pre', 'expression',
    'field-separator', 'assign', 'delimiter', 'fields', 'characters', 'bytes', 'lines', 'key', 'output',
]);
// grep and rg flags whose output is a count, a file name or nothing.
const QUIET_SHORT = 'clLq';
const QUIET_LONG = new Set(['count', 'files-with-matches', 'files-without-match', 'quiet', 'silent', 'files', 'count-matches']);

/**
 * Whether a `grep -o` pattern can print a key name and nothing after its `=`:
 * `^[A-Z][A-Z0-9_]*`, `^[A-Z][A-Z0-9_]*=`, `^\s*#?\s*[A-Z_]+\s*[=:]`,
 * `^(export )?[A-Za-z_]\w*=`, `^(DATABASE_URL|DB_NAME)=`. Anchored at the line
 * start, made of word characters, whitespace, `#` and alternation, with `=` or
 * `:` allowed only as the last token. `.`, `[^...]`, `\S` and lookarounds can
 * reach the value, so any of them refuses.
 */
function keyOnlyPattern(pattern) {
    let s = String(pattern);
    // `^A_[A-Z]*|^B_[A-Z]*`: every top-level alternative must hold on its own.
    const alternatives = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '(' || s[i] === '[') depth++;
        else if ((s[i] === ')' || s[i] === ']') && depth > 0) depth--;
        else if (s[i] === '|' && depth === 0) { alternatives.push(s.slice(from, i)); from = i + 1; }
    }
    if (alternatives.length) return alternatives.concat(s.slice(from)).every(keyOnlyPattern);
    if (!s.startsWith('^')) return false;
    s = s.slice(1)
        .replace(/(?:\[[=:]{1,2}\]|[=:])$/, '')
        .replace(/\[:(?:space|blank|upper|lower|alpha|digit|alnum):\]/g, 'a')
        .replace(/\\[wds+?{}()|]/g, 'a')
        .replace(/\(\?:/g, '(');
    return !s.includes('[^') && /^[A-Za-z0-9_\- #[\]()|?*+{},]*$/.test(s);
}

// `.env`, `.env.local`, `.env*`, `.envrc`, `prod.env`. Not `.env.example` and its kin.
const ENV_BASENAME_RE = /^\.env(?:rc)?(?:$|[.\-_*])|^[\w.-]+\.env$/i;
const TEMPLATE_RE = /(?:^|[.\-_])(?:example|sample|template|tmpl|tpl|dist|defaults?|schema)(?:$|[.\-_])/i;

function isEnvFile(word) {
    const base = String(word).replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (!ENV_BASENAME_RE.test(base)) return false;
    return !TEMPLATE_RE.test(base.replace(/^\.env/i, ''));
}

/**
 * Split a command into segments of words, the way the shell groups them.
 * Quotes group and are removed. `$(...)` and backticks are marked `captured`
 * and their contents are not segments here: their output does not print.
 * A heredoc body is skipped to its delimiter line. A `#` at a word start ends
 * the line. A backslash escapes only a quote, a backslash or whitespace; on
 * Windows anything else is a path separator.
 */
function segments(command) {
    const s = String(command);
    const out = [];
    let seg = [];
    let word = null;
    let pendingHeredoc = null;
    const endWord = () => { if (word !== null) { seg.push(word); word = null; } };
    // `pipe` marks a segment whose stdout feeds the next one.
    const endSeg = (pipe = false) => { endWord(); if (seg.length) { seg.pipe = pipe; out.push(seg); } seg = []; };
    const put = (t) => { if (word === null) word = { text: '', captured: false }; word.text += t; };

    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\n' && pendingHeredoc) {
            endSeg();
            const lines = s.slice(i + 1).split('\n');
            let skip = 0;
            for (const line of lines) {
                skip += line.length + 1;
                if ((pendingHeredoc.dash ? line.replace(/^\t+/, '') : line).trim() === pendingHeredoc.word) break;
            }
            i += skip;
            pendingHeredoc = null;
            continue;
        }
        if (c === "'" || c === '"') {
            const q = c;
            put('');
            for (i++; i < s.length && s[i] !== q; i++) {
                if (q === '"' && s[i] === '\\' && /["\\$`]/.test(s[i + 1] || '')) { put(s[++i]); continue; }
                if (q === '"' && s[i] === '$' && s[i + 1] === '(') { word.captured = true; }
                put(s[i]);
            }
            continue;
        }
        if (c === '\\') {
            const n = s[i + 1];
            if (n === '\n') { i++; continue; }
            if (n === ' ' || n === '\t' || n === '"' || n === "'" || n === '\\') { put(n); i++; continue; }
            put(c);
            continue;
        }
        if (c === '$' && s[i + 1] === '{') {
            // `${VAR}`, `${VAR:-x}`: one word, and `}` inside is not a group close.
            const end = s.indexOf('}', i + 2);
            put(end === -1 ? s.slice(i) : s.slice(i, end + 1));
            i = end === -1 ? s.length : end;
            continue;
        }
        if ((c === '$' && s[i + 1] === '(') || c === '`') {
            // Consume to the matching close, quotes respected, into this word.
            const close = c === '`' ? '`' : ')';
            let depth = 0;
            let q = null;
            put(c === '`' ? c : '$(');
            word.captured = true;
            for (i += c === '`' ? 1 : 2, depth = c === '`' ? 0 : 1; i < s.length; i++) {
                const d = s[i];
                word.text += d;
                if (q) { if (d === q) q = null; continue; }
                if (d === "'" || d === '"') { q = d; continue; }
                if (close === ')') {
                    if (d === '(') depth++;
                    else if (d === ')' && --depth === 0) break;
                } else if (d === '`') break;
            }
            continue;
        }
        if (c === '#' && word === null) { while (i + 1 < s.length && s[i + 1] !== '\n') i++; continue; }
        if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && s[i - 1] !== '<') {
            // A heredoc opener: remember the delimiter, skip the body at the newline.
            const m = s.slice(i).match(/^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
            if (m) {
                endWord();
                seg.push({ text: '<<', captured: false });
                pendingHeredoc = { word: m[3], dash: m[1] === '-' };
                i += m[0].length - 1;
                continue;
            }
        }
        if (c === '&' && (s[i + 1] === '>' || /[<>]/.test(s[i - 1] || ''))) { put(c); continue; }
        if (c === '|' && s[i + 1] !== '|' && s[i - 1] !== '|') { endSeg(true); if (s[i + 1] === '&') i++; continue; }
        if (/[;\n|&(){}]/.test(c)) { endSeg(); continue; }
        if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
        if ((c === '<' || c === '>') && word !== null && !/^(?:\d*|&)$/.test(word.text) && !/[<>]$/.test(word.text)) endWord();
        put(c);
    }
    endSeg();
    return out;
}

const REDIRECT_RE = /^(\d*|&)(<<<|<>|<|>>|>|>&|<&)(.*)$/;

/** Split a segment's words into argv, the files it reads by `<`, and whether stdout goes to a file. */
function redirections(words) {
    const argv = [];
    const inputs = [];
    let stdoutToFile = false;
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const m = w.captured ? null : w.text.match(REDIRECT_RE);
        if (!m || w.text === '<<') { if (w.text !== '<<') argv.push(w); continue; }
        const [, fd, op, attached] = m;
        const target = attached || (words[i + 1] && words[++i].text) || '';
        if (op === '<' || op === '<>') { inputs.push(target); continue; }
        if (op === '<<<' || op === '<&') continue;
        // `>` and `>>` on fd 1 (or both with `&>`) to a real file; `>&2` and /dev/std* still print.
        const toStdout = fd === '' || fd === '1' || fd === '&';
        if (toStdout && (op === '>' || op === '>>') && target && !/^&|^\/dev\/(?:std|tty|fd\/[12])/.test(target)) stdoutToFile = true;
    }
    return { argv, inputs, stdoutToFile };
}

/** The command word's name: `/usr/bin/grep.exe` is `grep`. */
const nameOf = (w) => String(w).split(/[/\\]/).pop().replace(/\.exe$/i, '').toLowerCase();

/**
 * Walk a reader's arguments: the files it reads (positionals, minus a grep
 * pattern or a sed or awk script), and the flags that decide what it prints.
 */
function readArgs(tool, args) {
    const family = GREPS.has(tool) ? (tool === 'rg' ? 'rg' : 'grep') : AWKS.has(tool) ? 'awk' : tool;
    const valueShort = VALUE_SHORT[family] || '';
    const flags = new Set();
    const long = new Set();
    const patterns = [];
    const positionals = [];
    let explicitScript = false;
    let endOpts = false;
    for (let i = 0; i < args.length; i++) {
        const t = args[i].text;
        if (endOpts || t === '-' || !t.startsWith('-') || args[i].captured) { positionals.push(args[i]); continue; }
        if (t === '--') { endOpts = true; continue; }
        if (t.startsWith('--')) {
            const [name, value] = t.slice(2).split(/=(.*)/s);
            long.add(name);
            const v = value !== undefined ? value : (VALUE_LONG.has(name) ? (args[++i] || { text: '' }).text : undefined);
            if (name === 'regexp') { patterns.push(v); explicitScript = true; }
            if (name === 'file' || name === 'expression') explicitScript = true;
            continue;
        }
        for (let k = 1; k < t.length; k++) {
            const letter = t[k];
            flags.add(letter);
            if (family === 'sed' && letter === 'i') break;            // -i[SUFFIX]
            if (!valueShort.includes(letter)) continue;
            const v = k + 1 < t.length ? t.slice(k + 1) : (args[++i] || { text: '' }).text;
            if (letter === 'e' && (family === 'grep' || family === 'rg')) patterns.push(v);
            if (letter === 'e' || letter === 'f') explicitScript = explicitScript || family !== 'awk' || letter === 'f';
            break;
        }
    }
    // The first positional is a pattern or a script, not a file, unless -e or -f supplied one.
    const scripted = family === 'grep' || family === 'rg' || family === 'sed' || family === 'awk';
    if (scripted && !explicitScript && positionals.length) {
        const first = positionals.shift();
        if (family === 'grep' || family === 'rg') patterns.push(first.text);
    }
    return { family, flags, long, patterns, files: positionals.map((w) => w.text) };
}

/** Whether this reader, run this way, prints only names, counts or nothing. */
function printsNoValues(r) {
    if (r.family === 'grep' || r.family === 'rg') {
        if ([...QUIET_SHORT].some((f) => r.flags.has(f)) || [...QUIET_LONG].some((f) => r.long.has(f))) return true;
        if ((r.flags.has('o') || r.long.has('only-matching')) && r.patterns.length
            && r.patterns.every(keyOnlyPattern)) return true;
    }
    if (r.family === 'sed' && (r.flags.has('i') || r.long.has('in-place'))) return true;
    return false;
}

/** A segment's command, read past assignments and wrappers: `{ tool, rest }`, or null. */
function commandOf(words) {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text)) i++;
    while (i < words.length && WRAPPERS.has(nameOf(words[i].text))) {
        i++;
        while (i < words.length && (/^-/.test(words[i].text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text))) i++;
    }
    if (i >= words.length || words[i].captured) return null;
    return { tool: nameOf(words[i].text), rest: words.slice(i + 1) };
}

/**
 * Whether what a reader writes into this pipe reaches the transcript. Follows
 * filters that read only stdin (`| cut -d= -f1 | head`) to the end of the
 * chain; a `wc`, or a grep that prints only counts or key names, ends it quietly.
 */
function pipePrints(all, from) {
    for (let k = from; k < all.length && all[k - 1].pipe; k++) {
        const cmd = commandOf(all[k]);
        if (!cmd) return true;
        if (cmd.tool === 'wc') return false;
        if (!READERS.has(cmd.tool)) return true;
        const { argv, inputs, stdoutToFile } = redirections(cmd.rest);
        if (stdoutToFile) return false;
        const r = readArgs(cmd.tool, argv);
        if (r.files.length || inputs.length) return true;
        if (GREPS.has(cmd.tool) && printsNoValues(r)) return false;
    }
    return true;
}

/**
 * The first segment of `command` that prints a .env file, as
 * `{ tool, file }`, or null. Pure: reads nothing but its argument.
 */
function findEnvFileRead(command) {
    const all = segments(command);
    for (let n = 0; n < all.length; n++) {
        const cmd = commandOf(all[n]);
        if (!cmd || !READERS.has(cmd.tool)) continue;
        const { argv, inputs, stdoutToFile } = redirections(cmd.rest);
        if (stdoutToFile) continue;
        const r = readArgs(cmd.tool, argv);
        const file = r.files.concat(inputs).find(isEnvFile);
        if (!file || printsNoValues(r)) continue;
        if (all[n].pipe && !pipePrints(all, n + 1)) continue;
        return { tool: cmd.tool, file };
    }
    return null;
}

function envReadReason(hit) {
    return `Blocked: \`${hit.tool}\` would print ${hit.file} into the transcript, and a .env file holds live credentials. `
        + 'Masking does not make it safe: a mask rewrites the lines its pattern matches and prints every other line, '
        + 'and on 2026-09-29 a masked read printed 9 live keys from commented-out lines.\n'
        + `Keys only: grep -oE '^[A-Z][A-Z0-9_]*' ${hit.file}\n`
        + `Is one key set: grep -c '^KEY=' ${hit.file}\n`
        + 'To use a value, load it in the same command (`set -a; . ./.env; set +a`) and print only facts you construct: its length, present yes or no.\n';
}

// A cheap prefilter for the hook's quiet path: no `.env` in the text, no parse.
const MAY_READ_ENV = /\.env/i;

module.exports = { MAY_READ_ENV, findEnvFileRead, envReadReason, isEnvFile, segments, keyOnlyPattern };

if (require.main === module) {
    const cmd = process.argv.slice(2).join(' ');
    if (!cmd || cmd === '--help' || cmd === '-h') {
        console.log('usage: env-file-read.js <command text>   prints the read it would refuse, or "allowed"');
    } else {
        const hit = findEnvFileRead(cmd);
        console.log(hit ? `refused: ${hit.tool} reads ${hit.file}` : 'allowed');
    }
}
