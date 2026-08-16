#!/usr/bin/env node
// inbox-watch.js — notice files dropped into a synced inbox, cheaply.
//
// Built for one job: you take a screenshot on your phone, it lands here through
// iCloud, and the next thing you type in Claude Code already knows it arrived.
//
// THE COST RULE: this runs on every prompt, so it must never read file CONTENT.
// It does a readdir plus a stat per entry and nothing else. Images only enter
// context when someone deliberately Reads one — a screenshot is worth roughly a
// thousand tokens, so auto-injecting every arrival would be the expensive
// mistake this design exists to avoid.
//
// Usage:
//   node inbox-watch.js check   # new since last claim; exits 0 silently if none
//   node inbox-watch.js list    # everything currently in the inbox
//   node inbox-watch.js claim   # mark everything seen (the hook does this)
//   node inbox-watch.js path    # print the resolved inbox directory
//
// Inbox location, first match wins:
//   $AUTODEV_INBOX
//   ~/Library/Mobile Documents/com~apple~CloudDocs/claude-inbox   (macOS iCloud)
//   ~/claude-inbox

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;

function resolveInbox() {
    if (process.env.AUTODEV_INBOX) return process.env.AUTODEV_INBOX;
    const icloud = path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'claude-inbox');
    if (fs.existsSync(path.dirname(icloud))) return icloud;
    return path.join(HOME, 'claude-inbox');
}

const INBOX = resolveInbox();
const STATE = path.join(INBOX, '.autodev-seen.json');

const MEDIA = /\.(png|jpe?g|gif|webp|heic|heif|pdf|mov|mp4|txt|md|log|json)$/i;

function listFiles() {
    let entries;
    try { entries = fs.readdirSync(INBOX, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
        if (!e.isFile() || e.name.startsWith('.')) continue;
        if (!MEDIA.test(e.name)) continue;
        const full = path.join(INBOX, e.name);
        try {
            const st = fs.statSync(full);
            // An iCloud file still downloading has a .icloud placeholder sibling;
            // a zero-byte file is mid-sync. Either way it is not ready to read.
            if (st.size === 0) continue;
            out.push({ name: e.name, path: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* vanished mid-scan */ }
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function readSeen() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { lastClaimMs: 0, claimed: [] }; }
}

function writeSeen(seen) {
    try {
        fs.mkdirSync(INBOX, { recursive: true });
        fs.writeFileSync(STATE, JSON.stringify(seen, null, 2) + '\n');
    } catch { /* inbox not writable — checking still works */ }
}

function ageOf(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

// Exported so the UserPromptSubmit hook can call this in-process. Spawning a
// second Node just to read a directory measured 56ms per prompt; importing it
// measures 31ms, and the difference is paid on every single turn.
function check() {
    const files = listFiles();
    const seen = readSeen();
    const claimed = new Set(seen.claimed || []);
    const fresh = files.filter((f) => !claimed.has(idOf(f)));
    if (!fresh.length) return '';
    const lines = [`${fresh.length} new file(s) in the inbox:`];
    for (const f of fresh) {
        lines.push(`  ${f.name} · arrived ${ageOf(f.mtimeMs)} · ${(f.size / 1024).toFixed(0)}KB`);
        lines.push(`    ${f.path}`);
    }
    return lines.join('\n');
}

const idOf = (f) => `${f.name}@${Math.round(f.mtimeMs)}`;

function claim() {
    const files = listFiles();
    writeSeen({ lastClaimMs: Date.now(), claimed: files.map(idOf).slice(-500) });
    return files.length;
}

module.exports = { check, claim, listFiles, resolveInbox, INBOX };

if (require.main !== module) return;

const cmd = process.argv[2] || 'check';

if (cmd === 'path') { console.log(INBOX); process.exit(0); }

const files = listFiles();

if (cmd === 'list') {
    if (!files.length) { console.log(`Inbox is empty: ${INBOX}`); process.exit(0); }
    console.log(`${files.length} file(s) in ${INBOX}\n`);
    for (const f of files) {
        console.log(`  ${f.name}  ·  ${ageOf(f.mtimeMs)}  ·  ${(f.size / 1024).toFixed(0)}KB`);
        console.log(`    ${f.path}`);
    }
    process.exit(0);
}

const seen = readSeen();
const claimed = new Set(seen.claimed || []);
const fresh = files.filter((f) => !claimed.has(idOf(f)));

if (cmd === 'claim') {
    writeSeen({ lastClaimMs: Date.now(), claimed: files.map(idOf).slice(-500) });
    console.log(`Claimed ${fresh.length} new file(s).`);
    process.exit(0);
}

// check
if (!fresh.length) process.exit(0);   // silence is the common case, and free

console.log(`${fresh.length} new file(s) in the inbox:`);
for (const f of fresh) {
    console.log(`  ${f.name} · arrived ${ageOf(f.mtimeMs)} · ${(f.size / 1024).toFixed(0)}KB`);
    console.log(`    ${f.path}`);
}
