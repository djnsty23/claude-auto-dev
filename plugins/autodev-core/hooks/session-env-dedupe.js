#!/usr/bin/env node
// PreCompact, SessionEnd and SessionStart("resume") hook: keep a session's
// env files under the Bash command cap by dropping dead `export` lines.
//
// WHY THIS EXISTS. The harness gives each SessionStart hook its own env file,
// `<config>/session-env/<session>/sessionstart-hook-<N>.sh`, and prefixes every
// Bash tool command with all of them. It never truncates those files when the
// hook runs again; only the cwdchanged and filechanged files are cleared.
// Plugins that append `export NAME=...` on every SessionStart (openai-codex's
// session-lifecycle-hook, vercel's) therefore grow them by a few lines on every
// start, resume and compaction. `[measured 2026-09-25, claude 2.1.280, Windows]`
// at 69 lines the prefix passed the ~8 KB command-line cap and every Bash call
// died at one constant line (`line 70: /dev/nu: Permission denied`); at 72
// lines `echo` returned nothing at all. Upstream: openai/codex-plugin-cc#528
// and anthropics/claude-code#78146, both open when this was written.
//
// WHAT IT DOES. It reads the session's env files in the harness's own order
// (setup, sessionstart, cwdchanged, filechanged, then by index) as ONE script,
// tracking quote state across lines. An `export NAME=<literal>` line is removed
// only when a later line exports NAME again as a literal and no line anywhere
// reads $NAME or ${NAME}. Bash ends up with the same values; every other line
// stays verbatim. The steady state after a compaction is two copies of each
// variable, not an unbounded pile.
//
// EVERY OS, NOT ONLY WINDOWS. The growth is the harness's and happens on every
// platform; only the failure point differs (POSIX argv limits are far larger).
// The rewrite is semantics-preserving, runs on three infrequent events, and a
// Windows-only branch would leave the Linux and macOS CI legs exercising the
// hook through an override instead of the path users run.
//
// RACES. PreCompact and SessionEnd run while no plugin hook writes, so nothing
// can race them. SessionStart hooks run in PARALLEL, so on "resume" a plugin can
// append to a file while this plans. Each replacement is therefore written to a
// temp file, the target is re-read, and the rename happens only if it still
// holds what the plan was made from; after three moved files it gives up. The
// window between that re-read and the rename is not closed: an append landing
// inside it is lost. Only a file that already holds duplicate exports is ever
// rewritten, so what that append would have carried is a repeat of its names.
//
// Silent by contract: zero bytes on stdout and stderr, exit 0 on every path.
// The log is one JSON line per rewritten file, names and counts only, never a
// value, in ${CLAUDE_PLUGIN_DATA}/session-env-dedupe.log. With no plugin data
// dir there is no log.
//
// Manual repair: node session-env-dedupe.js --dir <session dir> | --all [--check]
//   --dir    one session directory
//   --all    every directory under <config>/session-env
//   --check  print what would change, write nothing, exit 1 when anything would

'use strict';
const fs = require('fs');
const path = require('path');

// Both copied from the harness (claude 2.1.281 still carries this exact
// pattern): the files it reads, and the order it reads them in.
const FILE_RE = /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/;
const EVENT_ORDER = { setup: 0, sessionstart: 1, cwdchanged: 2, filechanged: 3 };
const SESSION_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
// A value with no expansion: single-quoted runs, double-quoted runs without $ ` \, and plain words.
const LITERAL_EXPORT_RE = /^export ([A-Za-z_][A-Za-z0-9_]*)=((?:'[^']*'|"[^"$`\\]*"|[A-Za-z0-9_./:@%+,=~-])+)\r?$/;
const MAX_ATTEMPTS = 3;
const USAGE = 'usage: session-env-dedupe.js [--dir <session dir> | --all] [--check]\n'
    + '  with neither, reads hook JSON on stdin, prints nothing, exits 0\n';

function harnessOrder(a, b) {
    const ma = a.match(FILE_RE);
    const mb = b.match(FILE_RE);
    if (ma[1] !== mb[1]) return EVENT_ORDER[ma[1]] - EVENT_ORDER[mb[1]];
    return Number(ma[2]) - Number(mb[2]);
}

// Quote state at the end of `line`, given the state at its start. Lines that
// start inside a quote are the middle of a multi-line value and are never
// candidates.
function quoteStateAfter(line, state) {
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (state === "'") { if (c === "'") state = null; continue; }
        if (state === '"') {
            if (c === '\\') i++;
            else if (c === '"') state = null;
            continue;
        }
        if (c === '\\') i++;
        else if (c === "'" || c === '"') state = c;
    }
    return state;
}

function readSnapshot(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => FILE_RE.test(n)).sort(harnessOrder).map((name) => ({
        name,
        text: fs.readFileSync(path.join(dir, name), 'utf8'),
    }));
}

// Returns [{ name, text, next, before, after, removed: {NAME: count} }] for the files that would change.
function plan(snapshot) {
    const lines = [];
    let state = null;
    for (const file of snapshot) {
        const parts = file.text.split('\n');
        if (parts[parts.length - 1] === '') parts.pop();
        for (const line of parts) {
            const m = state === null ? line.match(LITERAL_EXPORT_RE) : null;
            lines.push({ file: file.name, line, name: m ? m[1] : null });
            state = quoteStateAfter(line, state);
        }
    }
    const lastIndex = new Map();
    lines.forEach((l, i) => { if (l.name) lastIndex.set(l.name, i); });
    const isRead = (name) => {
        const re = new RegExp('\\$\\{?' + name + '(?![A-Za-z0-9_])');
        return lines.some((l) => re.test(l.line));
    };
    const readCache = new Map();
    const dead = lines.map((l, i) => {
        if (!l.name || lastIndex.get(l.name) === i) return false;
        if (!readCache.has(l.name)) readCache.set(l.name, isRead(l.name));
        return !readCache.get(l.name);
    });
    const changes = [];
    for (const file of snapshot) {
        const own = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.file === file.name);
        const kept = own.filter(({ i }) => !dead[i]).map(({ l }) => l.line);
        if (kept.length === own.length) continue;
        const removed = {};
        for (const { l, i } of own) if (dead[i]) removed[l.name] = (removed[l.name] || 0) + 1;
        const next = kept.length ? kept.join('\n') + (file.text.endsWith('\n') ? '\n' : '') : '';
        changes.push({ name: file.name, text: file.text, next, before: own.length, after: kept.length, removed });
    }
    return changes;
}

// Replace one file, but only if it still holds what the plan was made from. False means it moved.
function replaceIfUnchanged(dir, change) {
    const target = path.join(dir, change.name);
    const tmp = path.join(dir, `.${change.name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, change.next, 'utf8');
    try {
        if (fs.readFileSync(target, 'utf8') !== change.text) return false;
        fs.renameSync(tmp, target);
        return true;
    } catch {
        return false;
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* renamed away, or never written */ }
    }
}

// `log` is null outside hook mode: a manual run prints the same facts instead.
function dedupeDir(dir, { check, event, log }) {
    const note = (entry) => { if (log) log({ event, session: path.basename(dir), ...entry }); };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const changes = plan(readSnapshot(dir));
        if (check || changes.length === 0) return changes;
        let moved = false;
        for (const change of changes) {
            if (!replaceIfUnchanged(dir, change)) { moved = true; break; }
            note({ file: change.name, before: change.before, after: change.after, removed: change.removed });
        }
        if (!moved) return changes;
    }
    note({ gaveUp: `files changed under ${MAX_ATTEMPTS} attempts` });
    return [];
}

function pluginLog(env) {
    const dataDir = env.CLAUDE_PLUGIN_DATA;
    if (!dataDir) return null;
    const file = path.join(dataDir, 'session-env-dedupe.log');
    return (entry) => {
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
        } catch { /* a log failure must not fail the hook */ }
    };
}

function readHookInput() {
    try {
        const raw = fs.readFileSync(0, 'utf8').trim();
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

// The payload's session_id says WHICH session; it is required, so a payload
// without one does nothing. CLAUDE_ENV_FILE, set on SessionStart, says exactly
// WHERE the harness keeps it, and is trusted only when it names that same
// session: an inherited variable from a parent session must not redirect the
// rewrite into another session's files.
function hookDir(input, env, configDir) {
    const id = input.session_id;
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return null;
    if (env.CLAUDE_ENV_FILE) {
        const dir = path.dirname(env.CLAUDE_ENV_FILE);
        if (path.basename(dir) === id && path.basename(path.dirname(dir)) === 'session-env') return dir;
    }
    return path.join(configDir(env), 'session-env', id);
}

function runHook() {
    const input = readHookInput();
    const { configDir } = require('../scripts/claude-paths.js');
    const dir = hookDir(input, process.env, configDir);
    if (!dir) return;
    const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'hook';
    dedupeDir(dir, { check: false, event, log: pluginLog(process.env) });
}

function runManual(argv) {
    const check = argv.includes('--check');
    let dirs;
    const at = argv.indexOf('--dir');
    if (at !== -1 && argv[at + 1]) dirs = [argv[at + 1]];
    else {
        const { configDir } = require('../scripts/claude-paths.js');
        const root = path.join(configDir(), 'session-env');
        dirs = fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.statSync(d).isDirectory());
    }
    let files = 0;
    let linesRemoved = 0;
    for (const dir of dirs) {
        for (const c of dedupeDir(dir, { check, event: check ? 'check' : 'manual', log: null })) {
            files++;
            linesRemoved += c.before - c.after;
            const names = Object.entries(c.removed).map(([n, k]) => `${n} x${k}`).join(', ');
            process.stdout.write(`${path.basename(dir)}/${c.name}: ${c.before} -> ${c.after} lines (${names})\n`);
        }
    }
    process.stdout.write(`${check ? 'would rewrite' : 'rewrote'} ${files} file(s) in ${dirs.length} session dir(s), ${linesRemoved} dead line(s)\n`);
    return check && files > 0 ? 1 : 0;
}

function main(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(USAGE);
        return 0;
    }
    if (argv.includes('--dir') || argv.includes('--all')) return runManual(argv);
    // Hook mode reads stdin to EOF; on a terminal that would wait forever.
    if (process.stdin.isTTY) {
        process.stdout.write(USAGE);
        return 2;
    }
    try { runHook(); } catch { /* hook mode never fails the session */ }
    return 0;
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    const manual = argv.includes('--dir') || argv.includes('--all');
    try {
        process.exitCode = main(argv);
    } catch (err) {
        if (manual) process.stderr.write(`session-env-dedupe: ${err.message}\n`);
        process.exitCode = manual ? 2 : 0;
    }
}

module.exports = { plan, replaceIfUnchanged, hookDir, quoteStateAfter };
