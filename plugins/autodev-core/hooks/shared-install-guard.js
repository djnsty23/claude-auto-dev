#!/usr/bin/env node
// PreToolUse hook on Bash: deny a package install in a tree whose node_modules
// is shared with the main checkout, and name the command that unshares it.
//
// WHY. scripts/shared-install.js gives a new worktree the main checkout's
// node_modules as hardlinks: the same file data under the worktree's own
// directories. An install there can rewrite a package file in place (an
// install script, patch-package, prisma generate writing its client), and a
// hardlink rewritten in place changes the main checkout's copy too. So the
// link is broken BEFORE any install runs, and the install that follows is a
// private one. This hook is where "before" is enforced for the model's own
// commands.
//
// POPULATION. Inert unless a marker file exists: `<dir>/node_modules/
// .autodev-shared.json`, written only by shared-install.js. A session that has
// never linked a worktree pays one regex test over the command text and exits.
// The command must also put an install verb in COMMAND position (the first
// word of a segment, after variable assignments), so `grep "npm install"`
// and `echo npm ci` never match. That is the line between this and the Bash
// denylist deleted from pre-tool-filter.js on 2026-08-17, which judged text.
//
// WHAT COUNTS AS AN INSTALL. npm install/ci/add/update/uninstall/rebuild/
// dedupe/prune/link and their aliases, the same verbs for pnpm, yarn (bare
// `yarn` included) and bun, `patch-package`, and `prisma generate`, `prisma
// migrate` and `prisma db`, which write into node_modules. `npx` and `bunx`
// in front are looked through. `npm run <script>` is not: what a script runs
// cannot be known from here, and that is the residual this hook leaves.
//
// WHERE IT LOOKS. The session cwd, moved by every `cd`/`pushd` in the command
// in order, or the value of `--prefix`/`-C`/`--cwd`/`--dir`. A path made of
// `$NAME` is resolved from assignments earlier in the same command; one that
// still cannot be resolved falls back to the session cwd. From that directory
// up to the top of its git tree, any marker means deny.
//
// FAILS OPEN. Any throw exits 0 with zero bytes on both streams. This ships
// installed and runs on every Bash call of every session.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const QUICK_RE = /\b(?:npm|pnpm|yarn|bun|patch-package|prisma)\b/;
const MARKER = '.autodev-shared.json';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'shared-install.js');

const NPM_VERBS = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall',
    'add', 'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-test', 'it', 'cit', 'install-ci-test',
    'clean-install-test', 'sit', 'update', 'up', 'upgrade', 'udpate', 'uninstall', 'un', 'unlink', 'remove', 'rm', 'r',
    'rebuild', 'rb', 'dedupe', 'ddp', 'prune', 'link', 'ln']);
const PNPM_VERBS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade',
    'rebuild', 'rb', 'prune', 'dedupe', 'link', 'ln', 'unlink', 'import', 'patch-commit']);
const YARN_VERBS = new Set(['install', 'add', 'remove', 'upgrade', 'up', 'link', 'unlink', 'import', 'dedupe']);
const BUN_VERBS = new Set(['install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'link', 'unlink']);
const PRISMA_VERBS = new Set(['generate', 'migrate', 'db']);
const DIR_FLAGS = new Set(['--prefix', '-C', '--cwd', '--dir']);
const VALUE_FLAGS = new Set(['--prefix', '-C', '--cwd', '--dir', '-w', '--workspace', '--filter', '-F', '--registry', '--cache', '--userconfig']);

/** Split a command into segments at && || ; | & and newlines, outside quotes. Text from a heredoc opener on is dropped. */
function segments(command) {
    const src = String(command);
    const out = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            cur += c;
            if (c === quote) quote = null;
            else if (c === '\\' && quote === '"' && i + 1 < src.length) cur += src[++i];
            continue;
        }
        if (c === "'" || c === '"') { quote = c; cur += c; continue; }
        if (c === '\\' && i + 1 < src.length) { cur += c + src[++i]; continue; }
        if (c === '<' && src[i + 1] === '<' && /^<<-?\s*['"]?[A-Za-z_]/.test(src.slice(i))) break;
        if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '(' || c === ')') {
            if (c === '&' && (src[i - 1] === '>' || src[i + 1] === '>')) { cur += c; continue; }
            out.push(cur);
            cur = '';
            continue;
        }
        cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
}

/** Shell words of one segment, quotes removed. A word holding an unresolved `$` or backtick is marked. */
function words(segment, vars) {
    const out = [];
    let cur = null;
    let quote = null;
    const push = () => { if (cur) out.push(cur); cur = null; };
    const add = (ch) => { if (!cur) cur = { text: '', raw: '' }; cur.text += ch; };
    for (let i = 0; i < segment.length; i++) {
        const c = segment[i];
        if (quote === "'") { if (c === "'") quote = null; else add(c); continue; }
        if (c === '$' && quote !== "'") {
            const m = segment.slice(i).match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/);
            if (m && Object.prototype.hasOwnProperty.call(vars, m[1] || m[2])) {
                for (const ch of vars[m[1] || m[2]]) add(ch);
                i += m[0].length - 1;
                continue;
            }
            add(c);
            cur.expands = true;
            continue;
        }
        if (quote === '"') {
            if (c === '"') { quote = null; continue; }
            if (c === '\\' && i + 1 < segment.length && '$`"\\'.includes(segment[i + 1])) { add(segment[++i]); continue; }
            if (c === '`') { add(c); cur.expands = true; continue; }
            add(c);
            continue;
        }
        if (/\s/.test(c)) { push(); continue; }
        if (c === "'" || c === '"') { if (!cur) cur = { text: '', raw: '' }; quote = c; continue; }
        if (c === '\\' && i + 1 < segment.length) { add(segment[++i]); continue; }
        if (c === '`') { add(c); cur.expands = true; continue; }
        add(c);
    }
    push();
    return out;
}

/** A path from command text as an absolute native path, or null when it cannot be known. */
function resolveDir(base, word) {
    if (!word || word.expands) return null;
    let t = word.text;
    if (t === '~' || t.startsWith('~/')) t = os.homedir() + t.slice(1);
    if (process.platform === 'win32') {
        const m = t.match(/^\/([A-Za-z])(?=\/|$)/);
        if (m) t = m[1] + ':' + t.slice(2);
        if (t.startsWith('/')) return null;
    }
    if (path.isAbsolute(t)) return path.resolve(t);
    return base ? path.resolve(base, t) : null;
}

const commandName = (w) => path.basename(w.text).replace(/\.(?:cmd|exe|ps1)$/i, '').toLowerCase();

/**
 * Whether these words run an install, and the directory flag it carries.
 * Returns null, or { tool, dirWord } where dirWord may be null.
 */
function installOf(ws) {
    let i = 0;
    while (i < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i].text)) i++;
    if (i < ws.length && ['time', 'command', 'exec', 'nice'].includes(ws[i].text)) i++;
    if (i >= ws.length) return null;
    let tool = commandName(ws[i]);
    let rest = ws.slice(i + 1);
    if (tool === 'npx' || tool === 'bunx' || tool === 'pnpx') {
        rest = rest.filter((w) => !w.text.startsWith('-'));
        if (!rest.length) return null;
        tool = commandName(rest[0]);
        rest = rest.slice(1);
    }
    let dirWord = null;
    const positional = [];
    for (let j = 0; j < rest.length; j++) {
        const t = rest[j].text;
        const eq = t.match(/^(--[a-z-]+)=(.*)$/);
        if (eq && DIR_FLAGS.has(eq[1])) { dirWord = { text: eq[2], expands: rest[j].expands }; continue; }
        if (VALUE_FLAGS.has(t)) { if (DIR_FLAGS.has(t)) dirWord = rest[j + 1] || null; j++; continue; }
        if (t.startsWith('-')) continue;
        positional.push(t);
    }
    const verb = positional[0];
    const hit = (tool === 'npm' && NPM_VERBS.has(verb))
        || (tool === 'pnpm' && PNPM_VERBS.has(verb))
        || (tool === 'yarn' && (verb === undefined || YARN_VERBS.has(verb)))
        || (tool === 'bun' && BUN_VERBS.has(verb))
        || tool === 'patch-package'
        || (tool === 'prisma' && PRISMA_VERBS.has(verb));
    return hit ? { tool, dirWord } : null;
}

/** The shared node_modules found from dir up to the top of its git tree, or null. */
function sharedAbove(dir) {
    let d = path.resolve(dir);
    for (let n = 0; n < 40; n++) {
        if (fs.existsSync(path.join(d, 'node_modules', MARKER))) return { dir: d, top: gitTop(d) };
        if (fs.existsSync(path.join(d, '.git'))) return null;
        const up = path.dirname(d);
        if (up === d) return null;
        d = up;
    }
    return null;
}

function gitTop(dir) {
    let d = dir;
    for (let n = 0; n < 40; n++) {
        if (fs.existsSync(path.join(d, '.git'))) return d;
        const up = path.dirname(d);
        if (up === d) return dir;
        d = up;
    }
    return dir;
}

/** The deny reason for a command, or null when it may run. */
function decide(command, cwd) {
    if (!QUICK_RE.test(command)) return null;
    const vars = {};
    let dir = cwd || null;
    for (const seg of segments(command)) {
        const ws = words(seg, vars);
        if (!ws.length) continue;
        if (ws.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text))) {
            for (const w of ws) { const at = w.text.indexOf('='); if (!w.expands) vars[w.text.slice(0, at)] = w.text.slice(at + 1); }
            continue;
        }
        if (ws[0].text === 'cd' || ws[0].text === 'pushd') {
            const next = ws.length === 2 ? resolveDir(dir, ws[1]) : null;
            dir = next || cwd || null;
            continue;
        }
        const inst = installOf(ws);
        if (!inst) continue;
        const target = (inst.dirWord && resolveDir(dir, inst.dirWord)) || dir;
        if (!target) continue;
        const found = sharedAbove(target);
        if (!found) continue;
        const nm = path.join(found.dir, 'node_modules').replace(/\\/g, '/');
        const top = found.top.replace(/\\/g, '/');
        return `${nm} is shared with the main checkout by hardlinks (shared-install.js), so \`${inst.tool}\` here could `
            + 'rewrite files the main checkout uses. Unshare it first, then run the same command again: it will be a '
            + `private install.\n\n    node "${SCRIPT.replace(/\\/g, '/')}" unshare "${top}"`;
    }
    return null;
}

module.exports = { segments, words, resolveDir, installOf, sharedAbove, decide };

if (require.main === module) {
    try {
        let data;
        try { data = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
        if (!data || typeof data !== 'object' || data.tool_name !== 'Bash') process.exit(0);
        const command = data.tool_input && typeof data.tool_input.command === 'string' ? data.tool_input.command : '';
        const reason = command ? decide(command, typeof data.cwd === 'string' ? data.cwd : process.cwd()) : null;
        if (reason) {
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
            }) + '\n');
        }
    } catch { /* fail open: zero bytes */ }
}
