#!/usr/bin/env node
// extract-plugin-types.js — recover `claude-code.d.ts`, the function-hooks
// plugin API's TypeScript declarations, from the installed Claude Code binary.
//
// In a session, `/plugin-types` writes this file. Outside one (a gate, a
// subagent, a `-p` run) that command does not exist, and the declarations are
// still the only authoritative contract for a hooks module: the docs do not
// describe the surface yet and it is marked early access. The text ships
// inside the binary as a zstd frame, so it is read from there.
//
// Output goes to .claude/types/claude-code.d.ts (gitignored): the file is the
// vendor's, marked as changing without notice, and is regenerated per install
// rather than committed. The version that produced it is printed beside the
// line count so a stale copy is visible.
//
// Usage: node tooling/extract-plugin-types.js [--out <file>] [--exe <claude.exe>]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const outFile = path.resolve(ROOT, opt('--out', path.join('.claude', 'types', 'claude-code.d.ts')));

function findBinary() {
    const explicit = opt('--exe');
    if (explicit) return explicit;
    const candidates = [];
    if (process.platform === 'win32' && process.env.APPDATA) {
        candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    }
    const home = process.env.HOME || process.env.USERPROFILE || '';
    candidates.push(path.join(home, '.local', 'bin', 'claude'));
    candidates.push(path.join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
    try {
        const which = cp.spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
        for (const line of (which.stdout || '').split(/\r?\n/)) if (line.trim()) candidates.push(line.trim());
    } catch { /* no resolver */ }
    return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

if (typeof zlib.zstdDecompressSync !== 'function') {
    console.error('extract-plugin-types: this node has no zlib.zstdDecompressSync (node 22.15+ or 24+ needed)');
    process.exit(2);
}

const exe = findBinary();
if (!exe) {
    console.error('extract-plugin-types: no Claude Code binary found; pass --exe <path>');
    process.exit(1);
}

const buf = fs.readFileSync(exe);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HEADER = '// Claude Code function hooks: the plugin API';
let at = 0;
let frames = 0;
let found = null;
while ((at = buf.indexOf(magic, at)) !== -1) {
    frames++;
    try {
        const text = zlib.zstdDecompressSync(buf.subarray(at, Math.min(buf.length, at + 4 * 1024 * 1024))).toString('utf8');
        if (text.startsWith(HEADER)) { found = text; break; }
    } catch { /* a frame that is not this one, or a false magic */ }
    at += 4;
}

let version = 'unknown';
try { version = cp.spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).stdout.trim().split(/\s+/)[0]; } catch { /* keep unknown */ }

if (!found) {
    console.error(`extract-plugin-types: scanned ${frames} zstd frames in ${exe} (${version}) and found no declarations. Either this build predates function hooks or the header changed; check for the string "${HEADER}" in the binary.`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `// Written by tooling/extract-plugin-types.js from Claude Code ${version}.\n` + found);
const lines = found.split('\n').length;
console.log(`extract-plugin-types: ${path.relative(ROOT, outFile)} written from Claude Code ${version}: ${lines} lines, scanned ${frames} frames`);
