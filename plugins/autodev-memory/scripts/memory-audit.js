#!/usr/bin/env node
// memory-audit.js — inventory every project's memory store and report what needs
// maintenance. Read-only: it never edits or deletes a memory file.
//
// The mechanical half of nightly memory upkeep. It finds the things a machine
// can decide (oversized index, duplicate slugs, near-identical bodies, dead
// [[links]], memories for projects that no longer exist). Merging and rewriting
// stay with Claude, because deciding which of two overlapping memories is right
// is a judgement call and deleting the wrong one is unrecoverable.
//
// Usage: node memory-audit.js [--json] [--stale-days N] [--all]
//   --all         include projects with no recent activity
//   --stale-days  how many days of inactivity marks a project inactive (default 30)
//
// Account-agnostic: every path derives from CLAUDE_CONFIG_DIR or $HOME.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const includeAll = args.includes('--all');
const staleDays = Number((args.find((a) => a.startsWith('--stale-days=')) || '').split('=')[1]) || 30;

const HOME = process.env.HOME || process.env.USERPROFILE;
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS = path.join(CONFIG_DIR, 'projects');

// MEMORY.md is loaded into context every session. Claude Code warns past these.
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25 * 1024;

function decodeProjectDir(slug) {
    // Claude encodes an absolute path by replacing separators with '-'. That is
    // lossy (a real '-' in a directory name is indistinguishable), so treat the
    // decoded path as a best guess and verify it exists before acting on it.
    //
    // A POSIX slug carries a leading '-' ('/home/x' -> '-home-x'); a Windows
    // one starts at the drive instead ('C:\Users\x' -> 'C--Users-x'). Put the
    // drive letter back rather than emitting a rooted path without one — on
    // Windows '/Users/x' is drive-relative and resolves against whichever drive
    // the process happens to be on, so the same slug resolves differently from
    // a D: workspace than from a C: one. Mirrors pathFromSlug in
    // autodev-core/scripts/drift-audit.js; keep the two in step.
    const drive = /^([A-Za-z])--(.*)$/.exec(slug);
    if (drive) return drive[1] + ':/' + drive[2].replace(/-/g, '/');
    return '/' + slug.replace(/^-/, '').replace(/-/g, '/');
}

function daysSince(ms) {
    return Math.floor((Date.now() - ms) / 86400000);
}

function newestMtime(dir) {
    let newest = 0;
    const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            try {
                const st = fs.statSync(p);
                if (e.isDirectory()) walk(p);
                else if (st.mtimeMs > newest) newest = st.mtimeMs;
            } catch { /* unreadable */ }
        }
    };
    walk(dir);
    return newest;
}

function parseFrontmatter(text) {
    const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return { fm: {}, body: text };
    const fm = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
        if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    return { fm, body: text.slice(m[0].length) };
}

// Cheap similarity: shared word ratio over the smaller body. Good enough to
// surface "these two say the same thing" without pulling in a dependency.
function similarity(a, b) {
    const wa = new Set(a.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    const wb = new Set(b.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    if (!wa.size || !wb.size) return 0;
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared++;
    return shared / Math.min(wa.size, wb.size);
}

if (!fs.existsSync(PROJECTS)) {
    const msg = `No project memory found at ${PROJECTS}.`;
    console.log(asJson ? JSON.stringify({ projects: [] }) : msg);
    process.exit(0);
}

const report = [];

for (const slug of fs.readdirSync(PROJECTS)) {
    const memDir = path.join(PROJECTS, slug, 'memory');
    if (!fs.existsSync(memDir)) continue;

    const projectPath = decodeProjectDir(slug);
    const projectExists = fs.existsSync(projectPath);

    const files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md'));
    const lastTouched = newestMtime(memDir);
    const idleDays = lastTouched ? daysSince(lastTouched) : null;

    // "Active" = memory touched recently, or the repo itself has recent commits.
    let repoIdleDays = null;
    if (projectExists) {
        try {
            const ts = execSync('git log -1 --format=%ct', {
                cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            if (ts) repoIdleDays = daysSince(Number(ts) * 1000);
        } catch { /* not a git repo */ }
    }
    const active = (idleDays !== null && idleDays <= staleDays) ||
                   (repoIdleDays !== null && repoIdleDays <= staleDays);

    if (!active && !includeAll) continue;

    const findings = [];

    // --- index health
    const indexPath = path.join(memDir, 'MEMORY.md');
    let indexLinks = [];
    if (fs.existsSync(indexPath)) {
        const raw = fs.readFileSync(indexPath, 'utf8');
        const lines = raw.split('\n').length;
        const bytes = Buffer.byteLength(raw);
        if (lines > INDEX_MAX_LINES) findings.push({ kind: 'index-too-long', detail: `${lines} lines (max ${INDEX_MAX_LINES})` });
        if (bytes > INDEX_MAX_BYTES) findings.push({ kind: 'index-too-large', detail: `${(bytes / 1024).toFixed(1)}KB (max 25KB)` });
        indexLinks = [...raw.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
    } else if (files.length > 1) {
        findings.push({ kind: 'index-missing', detail: `${files.length} memories with no MEMORY.md index` });
    }

    // --- per-file parse + duplicate detection
    const memories = [];
    for (const f of files) {
        if (f === 'MEMORY.md') continue;
        const raw = fs.readFileSync(path.join(memDir, f), 'utf8');
        const { fm, body } = parseFrontmatter(raw);
        memories.push({ file: f, name: fm.name || f.replace(/\.md$/, ''), type: fm.type || '(none)', body: body.trim() });
        if (!fm.name) findings.push({ kind: 'missing-frontmatter', detail: `${f} has no name:` });
        if (!fm.description) findings.push({ kind: 'missing-frontmatter', detail: `${f} has no description:` });
    }

    const byName = {};
    for (const m of memories) (byName[m.name] = byName[m.name] || []).push(m.file);
    for (const [name, fs_] of Object.entries(byName)) {
        if (fs_.length > 1) findings.push({ kind: 'duplicate-name', detail: `"${name}" in ${fs_.join(', ')}` });
    }

    for (let i = 0; i < memories.length; i++) {
        for (let j = i + 1; j < memories.length; j++) {
            const sim = similarity(memories[i].body, memories[j].body);
            if (sim >= 0.7) {
                findings.push({
                    kind: 'near-duplicate',
                    detail: `${memories[i].file} ~ ${memories[j].file} (${Math.round(sim * 100)}% shared vocabulary)`,
                });
            }
        }
    }

    // --- index/file drift
    const fileSet = new Set(files);
    for (const link of indexLinks) {
        if (!fileSet.has(path.basename(link))) findings.push({ kind: 'dead-index-link', detail: link });
    }
    const linked = new Set(indexLinks.map((l) => path.basename(l)));
    for (const m of memories) {
        if (!linked.has(m.file)) findings.push({ kind: 'unindexed', detail: `${m.file} is not listed in MEMORY.md` });
    }

    // --- wiki links pointing at nothing
    const names = new Set(memories.map((m) => m.name));
    for (const m of memories) {
        for (const l of [...m.body.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1])) {
            if (!names.has(l)) findings.push({ kind: 'dangling-link', detail: `${m.file} → [[${l}]]` });
        }
    }

    if (!projectExists) findings.push({ kind: 'project-gone', detail: `${projectPath} no longer exists on disk` });

    report.push({
        slug, projectPath, projectExists, active,
        memoryCount: memories.length,
        idleDays, repoIdleDays,
        findings,
    });
}

if (asJson) {
    console.log(JSON.stringify({ configDir: CONFIG_DIR, staleDays, projects: report }, null, 2));
    process.exit(0);
}

const needsWork = report.filter((r) => r.findings.length);
console.log(`\nMemory audit — ${report.length} ${includeAll ? '' : 'active '}project(s) under ${CONFIG_DIR}\n`);

if (!report.length) {
    // "None found" and "could not look" print identically unless the config
    // directory is checked first. Only the second is a probe failure, and it
    // is the one that must not exit 0 and read as an all-clear.
    if (!fs.existsSync(CONFIG_DIR)) {
        console.log(`  COULD NOT AUDIT: ${CONFIG_DIR} does not exist.`);
        console.log('  The probe is blind, not the tree clean.\n');
        process.exit(1);
    }
    console.log(`  No project memory stores found. ${CONFIG_DIR} was read and holds none.\n`);
    process.exit(0);
}

for (const r of report) {
    const idle = r.idleDays === null ? 'never written' : `${r.idleDays}d since last write`;
    console.log(`  ${r.slug}`);
    console.log(`    ${r.memoryCount} memories · ${idle}${r.repoIdleDays !== null ? ` · repo ${r.repoIdleDays}d idle` : ''}`);
    if (!r.findings.length) { console.log('    ✓ clean\n'); continue; }
    const grouped = {};
    for (const f of r.findings) (grouped[f.kind] = grouped[f.kind] || []).push(f.detail);
    for (const [kind, details] of Object.entries(grouped)) {
        console.log(`    ${kind} (${details.length})`);
        details.slice(0, 4).forEach((d) => console.log(`      · ${d}`));
        if (details.length > 4) console.log(`      · …and ${details.length - 4} more`);
    }
    console.log('');
}

console.log(needsWork.length
    ? `${needsWork.length} project(s) need attention. Nothing was modified — this tool only reports.\n`
    : 'All memory stores are clean.\n');
