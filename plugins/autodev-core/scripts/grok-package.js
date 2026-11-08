#!/usr/bin/env node
'use strict';
// grok-package.js: regenerate the shared package the Grok fleet reads.
//
// Four markdown files and a README, built from live sources: memory, recent
// handoffs, the skill catalogue and the harness rules. The output lands in a
// private git mailbox, so every output line passes a redaction pass first. A
// line that matches any rule is replaced whole by LINE_WITHHELD.
//
// The private-name denylist lives in tooling/check-no-private-names.js, which
// does not ship with the plugin. This script therefore runs from a checkout or
// a `git archive` of one, and refuses to write anything when the denylist
// cannot be loaded: a package without its redaction pass must not exist.
//
// Employer and client names are held as digests below, for the same reason the
// denylist is: this repository is public and a plaintext list would disclose
// them. Generate one with `node tooling/check-no-private-names.js --digest <name>`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const USAGE = 'Usage: node grok-package.js [--out <dir>] [--since-days <n>] [--dry-run] [--home <dir>] [--extra-digests <file>]';
const LINE_WITHHELD = '[line withheld]';
const SECTIONS = ['Instructions', 'Identity', 'Career', 'Projects', 'Preferences'];
const DAY_MS = 86400000;

const CLIENT_DIGESTS = new Set([
    '3a20746021433d99', '3a437ea789246759', '9b8cce346180ae1b', '9c3589b1f53f727d',
    'bcb85f84a988d56f', 'd7f913b32ef90c1c', 'de5277960474b511', 'ffe3f6ee0c3515a3',
]);

const CLIENT_NAME_LENGTHS = [4, 6, 8, 9, 11];

// A memory keeps its description and its first lines. The full corpus is over
// 5 MB, which no reader can load, and the opening lines carry the rule.
const MAX_MEMORY_BODY_LINES = 15;

// Each pattern is a reason to withhold a whole line.
const WITHHOLD_PATTERNS = [
    /[\w.+-]*@[a-z0-9.-]+\.[a-z]{2,}/i, // e-mail, and a bare @host.tld
    /(?<!\d)\+?4?0?7\d{8}(?!\d)/, // Romanian mobile
    /(?<!\d)(?:\+?40|0)7\d{2}[ .-]\d{3}[ .-]\d{3}(?!\d)/, // the same, spaced
    /\bRO\d{6,}\b/, // VAT id
    /\bJ\d{2}\/\d+\/\d{4}\b/, // trade register id
    /eyJ[\w-]{20,}/, // JWT
    /sbp_\w*/,
    /\bsk-\w+/,
    /ghp_\w+/,
    /github_pat_\w+/,
    /dop_\w+/,
    /\b[a-f0-9]{32,}\b/i, // long hex
    /\.claude[\\/]comms\b/i, // private message threads
    /\bvault\b/i, // pointers to the document vault
];

// A base64 run is told from a long identifier by mixing all three character
// classes. An all-lowercase kebab name or a path segment has no such mix.
const BASE64_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
function hasBase64Run(line) {
    for (const m of line.matchAll(BASE64_RUN)) {
        if (/\d/.test(m[0]) && /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0])) return true;
    }
    return false;
}

function parseArgs(argv) {
    const home = os.homedir();
    const opts = { out: null, sinceDays: 14, dryRun: false, home, extraDigests: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') opts.help = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--out') opts.out = argv[++i];
        else if (a === '--since-days') opts.sinceDays = Number(argv[++i]);
        else if (a === '--home') opts.home = argv[++i];
        else if (a === '--extra-digests') opts.extraDigests = argv[++i];
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!Number.isFinite(opts.sinceDays) || opts.sinceDays <= 0) throw new Error('--since-days needs a positive number');
    if (!opts.home) throw new Error('--home needs a directory');
    opts.home = path.resolve(opts.home);
    if (!opts.out) opts.out = path.join(opts.home, 'claude-memory', 'mail', 'shared', 'claude-package');
    return opts;
}

function loadDenylist(extraDigestsFile) {
    const file = path.resolve(__dirname, '..', '..', '..', 'tooling', 'check-no-private-names.js');
    const lib = require(file);
    if (!Array.isArray(lib.DIGESTS) || lib.DIGESTS.length === 0) throw new Error('the private-name denylist is empty');
    const digests = new Set(lib.DIGESTS);
    if (extraDigestsFile) {
        for (const l of fs.readFileSync(extraDigestsFile, 'utf8').split(/\r?\n/)) {
            if (l.trim()) digests.add(l.trim());
        }
    }
    const memo = new Map();
    const lookup = (token) => {
        let d = memo.get(token);
        if (d === undefined) { d = lib.digest(token); memo.set(token, d); }
        return d;
    };
    return {
        isPrivate: (line) => lib.candidates(line).some((c) => digests.has(lookup(c))),
        // A trailing number still names the client: a work item is the name plus a counter.
        // A name inside a longer token, such as a domain, still names the client,
        // so every substring of a listed length is hashed. Two-letter names match
        // the whole token only: as substrings they would hit ordinary words.
        // A two-letter name counts only as a token of its own, in either case, because
        // branch names and slugs spell it in lowercase. Joined single letters do not count.
        isClient: (line) => line.split(/[^A-Za-z0-9]+/).some((t) => /^[A-Za-z]{2}\d*$/.test(t)
            && CLIENT_DIGESTS.has(lookup(t.replace(/\d+$/, '')))) || lib.candidates(line).some((c) => {
            const base = c.replace(/\d+$/, '');
            if (base.length > 2 && (CLIENT_DIGESTS.has(lookup(c)) || CLIENT_DIGESTS.has(lookup(base)))) return true;
            for (const len of CLIENT_NAME_LENGTHS) {
                for (let i = 0; i + len <= c.length; i++) {
                    if (CLIENT_DIGESTS.has(lookup(c.slice(i, i + len)))) return true;
                }
            }
            return false;
        }),
    };
}

// Local paths become ~ in every spelling the sources use.
function homeRewriters(homes) {
    const out = [];
    for (const home of new Set(homes.filter(Boolean))) {
        const parts = home.replace(/\\/g, '/').split('/').filter(Boolean);
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sep = '[\\\\/]+';
        const tail = parts.slice(1).map(esc).join(sep);
        const drive = parts[0].replace(':', '');
        out.push(new RegExp(`${esc(drive)}:${sep}${tail}`, 'gi'));
        out.push(new RegExp(`[\\\\/]${esc(drive)}${sep}${tail}`, 'gi'));
        out.push(new RegExp(`${esc(drive)}--${parts.slice(1).map(esc).join('-')}`, 'gi'));
    }
    return out;
}

// The account name can also appear outside any path, so it is replaced on its own.
function accountNames(homes) {
    const names = new Set(homes.filter(Boolean).map((h) => path.basename(h)).filter((n) => n.length >= 3));
    return [...names].map((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'));
}

function makeScrubber(deny, homes) {
    const rewriters = homeRewriters(homes);
    const accounts = accountNames(homes);
    return function scrub(text) {
        let withheld = 0;
        const lines = text.split(/\r?\n/).map((raw) => {
            let line = raw;
            for (const re of rewriters) line = line.replace(re, '~');
            for (const re of accounts) line = line.replace(re, '<user>');
            const hit = WITHHOLD_PATTERNS.some((re) => re.test(line))
                || hasBase64Run(line) || deny.isPrivate(line) || deny.isClient(line);
            if (hit) { withheld++; return LINE_WITHHELD; }
            return line;
        });
        return { text: lines.join('\n'), withheld };
    };
}

// The script has no business in these, whatever a walk or a caller points at.
const REFUSED_PATH = /[\\/]\.claude[\\/]comms[\\/]|[\\/]\.env[^\\/]*$|[\\/]\.doppler/i;
function safeRead(file) {
    if (REFUSED_PATH.test(file)) return null;
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function mtime(file) {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function listDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
    } catch { return []; }
}

// Symlinks and junctions are skipped: Dirent reports them as neither file nor dir.
function walkFiles(dir, depth = 12) {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth > 0 && e.name !== 'node_modules' && e.name !== '.git') out.push(...walkFiles(full, depth - 1));
        else if (e.isFile()) out.push(full);
    }
    return out;
}

function parseFrontmatter(src) {
    const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
    if (!m) return { meta: {}, body: src };
    const lines = m[1].split(/\r?\n/);
    const meta = {};
    for (let i = 0; i < lines.length; i++) {
        const kv = /^(\s*)([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
        if (!kv || meta[kv[2]] !== undefined) continue;
        const indent = kv[1].length;
        let value = kv[3].trim();
        // An empty value above indented keys is a mapping: its keys parse on their own.
        const opensMapping = value === '' && /^\s+[A-Za-z_-]+:/.test(lines[i + 1] || '');
        if (opensMapping) { meta[kv[2]] = ''; continue; }
        if (value === '' || /^[>|][-+]?$/.test(value)) {
            const held = [];
            while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].match(/^\s*/)[0].length > indent)) {
                i++;
                held.push(lines[i].trim());
            }
            value = held.filter(Boolean).join(' ');
        }
        value = value.replace(/^(["'])(.*)\1$/, '$2').replace(/\\"/g, '"');
        meta[kv[2]] = value;
    }
    return { meta, body: src.slice(m[0].length) };
}

function collapse(text) {
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
}

// ---- 10-memory-export.md ----

const SKIP_MEMORY = /^(MEMORY|MEMORY-archive)\.md$|credential|secret/i;

function memoryFiles(home) {
    const files = walkFiles(path.join(home, '.claude', 'memory'));
    for (const project of listDirs(path.join(home, '.claude', 'projects'))) {
        files.push(...walkFiles(path.join(project, 'memory'), 0));
    }
    return files.filter((f) => f.endsWith('.md') && !SKIP_MEMORY.test(path.basename(f)));
}

function sectionFor(type, slug) {
    if (type === 'project' || type === 'reference') return 'Projects';
    if (/identity|who-?is|he-is-/i.test(slug)) return 'Identity';
    if (/career|linkedin|-cv\b|\bcv-|\bjob\b/i.test(slug)) return 'Career';
    if (type === 'feedback') return 'Instructions';
    return type === 'user' ? 'Preferences' : 'Projects';
}

function buildMemory(home, deny) {
    const seen = new Set();
    const buckets = Object.fromEntries(SECTIONS.map((s) => [s, []]));
    let entries = 0;
    let dropped = 0;
    for (const file of memoryFiles(home)) {
        const src = safeRead(file);
        if (src === null) continue;
        const hash = crypto.createHash('sha1').update(src).digest('hex');
        if (seen.has(hash)) continue;
        seen.add(hash);
        const { meta, body } = parseFrontmatter(src);
        const slug = meta.name || path.basename(file, '.md');
        const description = meta.description || '';
        // A memory about a client is client material on every line, named or not.
        const owner = path.relative(path.join(home, '.claude'), file);
        if (deny.isClient(`${owner} ${src}`)) { dropped++; continue; }
        const tag = /\[(?:stated|measured|inferred)\s+(\d{4}-\d{2}-\d{2})\]/.exec(body);
        const date = tag ? tag[1] : new Date(mtime(file)).toISOString().slice(0, 10);
        // One output line per source line, so a rule withholds that line and not the memory.
        const bodyLines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const texts = [description, ...bodyLines.slice(0, MAX_MEMORY_BODY_LINES)].filter(Boolean);
        if (bodyLines.length > MAX_MEMORY_BODY_LINES) {
            texts.push(`(${bodyLines.length - MAX_MEMORY_BODY_LINES} more lines not exported)`);
        }
        buckets[sectionFor(meta.type, slug)].push({ date, slug, texts });
        entries++;
    }
    const lines = ['```'];
    SECTIONS.forEach((section, i) => {
        if (i > 0) lines.push('');
        lines.push(`## ${section}`);
        buckets[section]
            .sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug))
            .forEach((e) => e.texts.forEach((t) => lines.push(`[${e.date}] - ${e.slug}: ${t}`)));
    });
    lines.push('```');
    lines.push(`Export: ${entries} entries, ${dropped} dropped whole as client material.`);
    return { text: lines.join('\n'), entries, dropped };
}

// ---- 20-handoffs.md ----

const WORKTREE_HANDOFF = /^(HANDOFF-brain-|RESUME-).*\.md$/;
const MAILBOX_HANDOFF = /^(HANDOFF-brain-|RESUME-).*\.md$|handoff.*\.md$/i;

function handoffFiles(home, sinceDays) {
    const cutoff = Date.now() - sinceDays * DAY_MS;
    const found = [];
    for (const wt of listDirs(path.join(home, 'claude-auto-dev', '.claude', 'worktrees'))) {
        for (const sub of ['reports', 'handoffs']) {
            found.push(...walkFiles(path.join(wt, '.claude', sub)).filter((f) => WORKTREE_HANDOFF.test(path.basename(f))));
        }
    }
    found.push(...walkFiles(path.join(home, 'claude-memory', 'handoffs')).filter((f) => MAILBOX_HANDOFF.test(path.basename(f))));
    // The same handoff is copied across worktrees: keep the newest of each name.
    const newest = new Map();
    for (const file of found) {
        const m = mtime(file);
        if (m < cutoff) continue;
        const key = path.basename(file);
        if (!newest.has(key) || newest.get(key).m < m) newest.set(key, { file, m });
    }
    return [...newest.values()].sort((a, b) => b.m - a.m);
}

function workerResults(home) {
    const cutoff = Date.now() - 3 * DAY_MS;
    const out = [];
    for (const dir of listDirs(path.join(home, '.claude', 'autodev', 'reports'))) {
        const report = path.join(dir, 'REPORT.md');
        if (mtime(report) < cutoff) continue;
        const src = safeRead(report);
        if (src === null) continue;
        const results = src.split(/\r?\n/).filter((l) => /^RESULT\b/.test(l));
        if (results.length) out.push({ name: path.basename(dir), line: results[results.length - 1].trim() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

function buildHandoffs(home, sinceDays, deny) {
    const lines = [
        `# Handoffs (Claude Brain fleet, last ${sinceDays} days)`,
        '',
        'What each coordinator or worker left for its successor. Paths are the Windows machine, rewritten to ~.',
    ];
    let entries = 0;
    for (const { file } of handoffFiles(home, sinceDays)) {
        if (deny.isClient(path.basename(file))) continue;
        const src = safeRead(file);
        if (src === null) continue;
        lines.push('', '---', '', `## ${path.basename(file)}`, '', src.trimEnd());
        entries++;
    }
    const results = workerResults(home);
    lines.push('', '---', '', '## Worker reports (RESULT lines, last 3 days)', '');
    results.forEach((r) => lines.push(`- ${r.name}: ${r.line}`));
    entries += results.length;
    return { text: lines.join('\n'), entries };
}

// ---- 30-skills.md ----

function skillLine(file, fallback, schedule) {
    const src = safeRead(file);
    if (src === null) return null;
    const { meta } = parseFrontmatter(src);
    const pin = [meta.model, meta.effort].filter(Boolean).join(' ');
    const when = meta.schedule || meta.cron;
    const tags = [pin, schedule && when ? `schedule: ${when}` : ''].filter(Boolean).join(', ');
    const description = collapse(meta.description || '').slice(0, 300);
    return `- **${meta.name || fallback}**${tags ? ` [${tags}]` : ''}: ${description}`;
}

function skillsIn(dir) {
    return listDirs(dir)
        .map((d) => ({ dir: d, file: path.join(d, 'SKILL.md') }))
        .filter((s) => mtime(s.file) > 0);
}

function versionRank(dir) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(path.basename(dir));
    return m ? [1, Number(m[1]), Number(m[2]), Number(m[3]), 0] : [0, 0, 0, 0, mtime(dir)];
}

function newerVersion(a, b) {
    const ra = versionRank(a);
    const rb = versionRank(b);
    for (let i = 0; i < ra.length; i++) {
        if (ra[i] !== rb[i]) return ra[i] > rb[i];
    }
    return false;
}

function pluginSkillSets(home) {
    const sets = [];
    for (const market of listDirs(path.join(home, '.claude', 'plugins', 'cache'))) {
        if (path.basename(market).startsWith('temp_git_')) continue;
        for (const plugin of listDirs(market)) {
            let latest = null;
            for (const version of listDirs(plugin)) {
                if (!latest || newerVersion(version, latest)) latest = version;
            }
            if (!latest) continue;
            const found = walkFiles(path.join(latest, 'skills'), 3).filter((f) => path.basename(f) === 'SKILL.md');
            if (found.length) {
                sets.push({
                    label: `Plugin ${path.basename(market)}/${path.basename(plugin)} ${path.basename(latest)}`,
                    files: found.sort(),
                });
            }
        }
    }
    return sets;
}

function buildSkills(home) {
    const groups = [];
    const user = skillsIn(path.join(home, '.claude', 'skills'));
    groups.push({ label: 'User skills (~/.claude/skills)', lines: user.map((s) => skillLine(s.file, path.basename(s.dir), false)) });
    for (const set of pluginSkillSets(home)) {
        groups.push({ label: set.label, lines: set.files.map((f) => skillLine(f, path.basename(path.dirname(f)), false)) });
    }
    const routines = skillsIn(path.join(home, '.claude', 'scheduled-tasks'));
    groups.push({ label: 'Routines (scheduled tasks)', lines: routines.map((s) => skillLine(s.file, path.basename(s.dir), true)) });

    let entries = 0;
    const body = [];
    for (const g of groups) {
        const kept = g.lines.filter(Boolean);
        entries += kept.length;
        body.push('', `## ${g.label} (${kept.length})`, '', ...kept);
    }
    const head = [
        `# Skill catalogue (${entries} skills): what every Claude thread on this machine can load`,
        '',
        'Every session (Brain, workers, routines) sees the same set: skills are files on this machine plus the org-synced ones from claude.ai, not per-login. A session loads one by name; `rule-*` skills are never auto-loaded. Routines pin `model:` and `effort:` in their frontmatter.',
    ];
    return { text: [...head, ...body].join('\n'), entries };
}

// ---- 40-harness.md ----

function buildHarness(home) {
    const lines = [
        '# Harness: how the Claude fleet on this machine runs',
        '',
        'The Brain start sequence, the always-loaded rules, the mailbox protocol and the fleet-tick routine.',
    ];
    let entries = 0;
    const add = (title, file) => {
        const src = safeRead(file);
        if (src === null) return;
        lines.push('', '---', '', `## ${title}`, '', src.trimEnd());
        entries++;
    };
    add('BRAIN-START.md (the default takeover)', path.join(home, '.claude', 'autodev', 'BRAIN-START.md'));
    add('BRAIN-DAILY.md', path.join(home, '.claude', 'autodev', 'BRAIN-DAILY.md'));
    const rulesDir = path.join(home, '.claude', 'rules');
    let rules = [];
    try { rules = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md')).sort(); } catch { rules = []; }
    for (const name of rules) {
        const file = path.join(rulesDir, name);
        const src = safeRead(file);
        if (src === null || parseFrontmatter(src).meta.paths !== undefined) continue;
        add(`rules/${name}`, file);
    }
    add('mail/README.md (the mailbox protocol)', path.join(home, 'claude-memory', 'mail', 'README.md'));
    add('fleet-tick routine', path.join(home, '.claude', 'scheduled-tasks', 'fleet-tick', 'SKILL.md'));
    return { text: lines.join('\n'), entries };
}

// ---- 50-status.md ----

// The one file bots read every round, so it has a hard size budget.
const STATUS_MAX_BYTES = 2000;
const STATUS_CELL_CHARS = 200;
const STATUS_MISSING = '# Fleet status\n\n(file missing)';
const STATUS_LABELS = {
    asOf: 'As of',
    weeklyUsagePct: 'Weekly usage',
    claudeWorkersLive: 'Claude workers live',
    readyQueueDepth: 'Ready queue depth',
    breakUntil: 'Break until',
    claudeWorkers: 'Claude workers',
    waitingOnAndy: 'Waiting on Andy',
};

function statusLabel(key) {
    return STATUS_LABELS[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function statusValue(v) {
    if (v === null || v === undefined) return 'none';
    if (typeof v !== 'object') return String(v);
    if (Array.isArray(v)) return v.map(statusValue).join(', ');
    return Object.entries(v).map(([k, x]) => `${k}: ${statusValue(x)}`).join(', ');
}

function usageValue(v) {
    if (v === null || typeof v !== 'object') return v === null || v === undefined ? 'none' : `${v}%`;
    const { value, ...rest } = v;
    const details = statusValue(rest);
    return `${statusValue(value)}%${details ? ` (${details})` : ''}`;
}

function statusCell(text) {
    const flat = collapse(text).replace(/\|/g, '\\|');
    return flat.length > STATUS_CELL_CHARS ? `${flat.slice(0, STATUS_CELL_CHARS)}...` : flat;
}

function buildStatus(home) {
    const src = safeRead(path.join(home, '.claude', 'autodev', 'grok-shared-status.json'));
    let data = null;
    try { data = src === null ? null : JSON.parse(src); } catch { data = null; }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { text: STATUS_MISSING, entries: 1 };

    const rows = [];
    const lists = [];
    for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value)) lists.push({ title: statusLabel(key), items: value.map(statusValue) });
        else rows.push([statusLabel(key), key === 'weeklyUsagePct' ? usageValue(value) : statusValue(value)]);
    }

    const lines = ['# Fleet status', '', '| Field | Value |', '|---|---|'];
    let bytes = Buffer.byteLength(lines.join('\n'));
    let cut = 0;
    const fits = (line) => {
        const size = Buffer.byteLength(line) + 1;
        if (bytes + size > STATUS_MAX_BYTES - 40) { cut++; return false; }
        bytes += size;
        return true;
    };
    for (const [label, value] of rows) {
        const line = `| ${label} | ${statusCell(value)} |`;
        if (fits(line)) lines.push(line);
    }
    for (const list of lists) {
        if (list.items.length === 0) continue;
        const heading = `\n## ${list.title}\n`;
        if (!fits(heading)) { cut += list.items.length; continue; }
        lines.push(heading);
        for (const item of list.items) {
            const line = `- ${statusCell(item)}`;
            if (fits(line)) lines.push(line);
        }
    }
    if (cut) lines.push('', `(${cut} more items not shown)`);
    return { text: lines.join('\n'), entries: Object.keys(data).length };
}

// ---- 00-README.md ----

function formatSize(bytes) {
    return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

function buildReadme(files, dropped, generatedAt) {
    const about = {
        '10-memory-export.md': 'Andy\'s instructions, identity, career, projects and preferences as the Claude fleet recorded them, oldest first, `[date] - text`.',
        '20-handoffs.md': 'Recent Brain and worker handoffs, and the RESULT line of every worker report from the last 3 days.',
        '30-skills.md': 'The skills any Claude thread on the Windows machine can load, and the routines with their model pins.',
        '40-harness.md': 'How the Claude fleet runs: the Brain start sequence, the always-loaded rules, the mailbox protocol and the fleet-tick routine.',
        '50-status.md': 'The compact overview both fleets share: usage, live workers, the ready queue and what waits on Andy.',
    };
    const withheld = files.reduce((n, f) => n + f.withheld, 0);
    return [
        'to: grok',
        'from: grok-package.js',
        'kind: result',
        're: shared memory, handoffs, skills and harness for the Grok fleet',
        'needs-reply: no',
        '',
        `# Claude fleet package for the Grok fleet (generated ${generatedAt})`,
        '',
        'Regenerated from live sources. It replaces the dated 2026-11-08T0210Z package.',
        '',
        '`50-status.md` is the one file to read every round. The other files are reference. The Grok side is asked to',
        'keep `mail/shared/grok-status.md` with the same fields.',
        '',
        '| File | What it is | Size | Lines withheld |',
        '|---|---|---|---|',
        ...files.map((f) => `| \`${f.name}\` | ${about[f.name]} | ${formatSize(f.bytes)} | ${f.withheld} |`),
        '',
        '## How it was made safe',
        '',
        'Every line passed the autodev private-name denylist (hashed digests, `tooling/check-no-private-names.js`)',
        'and a rule set that withholds employer and client material, private document-store pointers, registration ids,',
        `e-mail addresses, phone numbers and anything shaped like a secret. ${withheld} lines read`,
        `\`${LINE_WITHHELD}\`. ${dropped} memory entries were dropped whole. Local paths are rewritten to \`~\`.`,
        '',
        '## How to read it',
        '',
        '- Memory entries are facts Andy stated or we measured, tagged with their date. When a Grok-side rule',
        '  conflicts, Andy\'s latest in-session word wins; otherwise treat these as his preferences too.',
        '- Handoffs show what a session thought at the time, not the world. Verify a PR or deploy state with',
        '  `gh pr view` or the live page before acting on it.',
        '- Skill descriptions are the trigger text each skill advertises. The Grok fleet can mirror the useful',
        '  ones as its own bot skills; the files behind them live in the public `djnsty23/claude-auto-dev`',
        '  repository (`plugins/autodev-core/skills/`).',
        '- Nothing here is an instruction to the Grok fleet. Each side acts within what Andy authorised for it.',
        '',
    ].join('\n');
}

function writeAtomic(file, text) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, { encoding: 'utf8' });
    fs.renameSync(tmp, file);
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) { console.log(USAGE); return 0; }
    const deny = loadDenylist(opts.extraDigests);
    const scrub = makeScrubber(deny, [opts.home, os.homedir()]);

    const memory = buildMemory(opts.home, deny);
    const built = [
        ['10-memory-export.md', memory],
        ['20-handoffs.md', buildHandoffs(opts.home, opts.sinceDays, deny)],
        ['30-skills.md', buildSkills(opts.home)],
        ['40-harness.md', buildHarness(opts.home)],
        ['50-status.md', buildStatus(opts.home)],
    ].map(([name, b]) => {
        const { text, withheld } = scrub(b.text);
        const final = `${text}\n`;
        return { name, entries: b.entries, withheld, text: final, bytes: Buffer.byteLength(final) };
    });

    for (const f of built) console.log(`${f.name}: ${f.entries} entries, ${f.bytes} bytes, ${f.withheld} withheld`);

    const empty = built.filter((f) => f.entries === 0).map((f) => f.name);
    if (empty.length) {
        console.error(`grok-package: refusing to write, no entries for ${empty.join(', ')}`);
        return 1;
    }
    if (opts.dryRun) return 0;

    fs.mkdirSync(opts.out, { recursive: true });
    for (const f of built) writeAtomic(path.join(opts.out, f.name), f.text);
    const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const readme = scrub(buildReadme(built, memory.dropped, generatedAt));
    writeAtomic(path.join(opts.out, '00-README.md'), `${readme.text.trimEnd()}\n`);
    console.log(`00-README.md: ${readme.withheld} withheld`);
    console.log(`wrote ${opts.out}`);
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        console.error(`grok-package: ${err.message}`);
        process.exitCode = 1;
    }
}

module.exports = { parseFrontmatter, main };
