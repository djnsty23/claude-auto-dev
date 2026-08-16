#!/usr/bin/env node
// drift-audit.js — find local state that claims to be current and is not.
//
// Read-only. Every failure this catches is the same shape: something reports
// healthy while being stale, so nothing ever surfaces it. Observed instances:
// an install pinned to 8.0.0 while the marketplace was four releases ahead, a
// plugin never installed at all, and a permission allowlist whose broad rules
// made the deny list beneath them unenforceable.
//
// Usage: node drift-audit.js [--json]
//
// Account-agnostic: paths derive from CLAUDE_CONFIG_DIR or $HOME.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const asJson = process.argv.includes('--json');
const HOME = process.env.HOME || process.env.USERPROFILE;
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

const findings = [];
const add = (area, severity, detail, fix) => findings.push({ area, severity, detail, fix });

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ---------------------------------------------------------------- plugins
function auditPlugins() {
    const installed = readJSON(path.join(CONFIG, 'plugins', 'installed_plugins.json'));
    const markets = readJSON(path.join(CONFIG, 'plugins', 'known_marketplaces.json'));
    if (!installed || !installed.plugins) return;

    for (const [key, entries] of Object.entries(installed.plugins)) {
        const e = (entries || [])[0];
        if (!e) continue;
        const [, marketName] = key.split('@');
        const market = markets && markets[marketName];
        if (!market || !market.installLocation) continue;

        // Is the local clone ahead of what is installed?
        let headSha = '';
        try {
            headSha = execSync('git rev-parse HEAD', {
                cwd: market.installLocation, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
        } catch { continue; }

        if (headSha && e.gitCommitSha && headSha !== e.gitCommitSha) {
            add('plugins', 'warn',
                `${key} is installed at ${e.version} (${String(e.gitCommitSha).slice(0, 8)}) but the marketplace clone is at ${headSha.slice(0, 8)}`,
                `/plugin update ${key.split('@')[0]}`);
        }

        // Does the install path still exist?
        if (e.installPath && !fs.existsSync(path.join(e.installPath, '.claude-plugin', 'plugin.json'))) {
            add('plugins', 'fail', `${key} installPath is missing its manifest: ${e.installPath}`,
                `reinstall with /plugin install ${key}`);
        }
    }

    // Siblings you have not installed from a marketplace you HAVE adopted.
    //
    // Scoped deliberately. The first version reported every uninstalled plugin
    // in every known catalog: 39KB of output naming hundreds of plugins the user
    // had never asked for. Not installing something is the normal state of a
    // catalog, not drift. It is only worth a word when you already use that
    // marketplace — which is how autodev-memory sat uninstalled while
    // autodev-core was in daily use.
    for (const [marketName, m] of Object.entries(markets || {})) {
        const adopted = Object.keys(installed.plugins).some((k) => k.endsWith(`@${marketName}`));
        if (!adopted) continue;
        const cat = readJSON(path.join(m.installLocation || '', '.claude-plugin', 'marketplace.json'));
        if (!cat || !Array.isArray(cat.plugins)) continue;
        for (const p of cat.plugins) {
            if (!installed.plugins[`${p.name}@${marketName}`]) {
                add('plugins', 'info', `${p.name}@${marketName} is published in a marketplace you use, but not installed`,
                    `/plugin install ${p.name}@${marketName}`);
            }
        }
    }
}

// ------------------------------------------------------- scheduled tasks
function auditSchedules() {
    const dir = path.join(CONFIG, 'scheduled-tasks');
    if (!fs.existsSync(dir)) return;
    for (const id of fs.readdirSync(dir)) {
        const skill = path.join(dir, id, 'SKILL.md');
        if (!fs.existsSync(skill)) continue;
        const st = fs.statSync(skill);
        const ageDays = Math.floor((Date.now() - st.mtimeMs) / 86400000);
        // A daily routine whose definition and state have not been touched in a
        // week is very likely not firing. This is the "gate nobody runs" shape.
        if (ageDays > 7) {
            add('schedules', 'warn', `task "${id}" has not been touched in ${ageDays}d — verify it is still firing`,
                'check the Scheduled sidebar, or list_scheduled_tasks for lastRunAt');
        }
    }
}

// ------------------------------------------------------------- settings
// An allow rule that can express everything a deny rule forbids makes the deny
// list decorative. These are the shapes that shipped in a real template.
const SHELL_ESCAPES = [
    { re: /^Bash\((?:ba)?sh\s/, why: 'runs any command, including every denied one' },
    { re: /^Bash\(source\s/, why: 'same, via a sourced script' },
    { re: /^Bash\(eval\s/, why: 'arbitrary evaluation' },
    { re: /^Bash\((?:curl|wget)\s/, why: 'fetch-and-execute, and an exfiltration path' },
    { re: /^Bash\(export\s/, why: 'can rewrite PATH for later commands' },
    { re: /^Bash\(chmod\s/, why: 'makes any written file executable' },
    { re: /^Bash\(rm\s+-f/, why: 'deletion, usually sitting above a deny list about deletion' },
    { re: /^WebFetch\(domain:\*\)/, why: 'blanket approval for every domain' },
];

function auditSettings() {
    const p = path.join(CONFIG, 'settings.json');
    const s = readJSON(p);
    if (!s) return;
    const allow = (s.permissions && s.permissions.allow) || [];
    const deny = (s.permissions && s.permissions.deny) || [];

    for (const rule of allow) {
        for (const esc of SHELL_ESCAPES) {
            if (esc.re.test(rule)) {
                add('settings', deny.length ? 'fail' : 'warn',
                    `allow rule "${rule}" ${esc.why}${deny.length ? ` — and there are ${deny.length} deny rules it can bypass` : ''}`,
                    'remove the rule, or narrow it to the specific command you need');
            }
        }
        // A path rule pointing at something that no longer exists is dead weight
        // and hides the fact that the grant was never revoked.
        // Judge the PARENT, not the leaf. Granting Edit on a log file the tool
        // has not created yet is deliberate; the grant is stale only when the
        // directory it lives in is gone.
        const m = rule.match(/^(?:Read|Edit|Write)\(([^)*]+)/);
        if (m) {
            const base = m[1].replace(/\/+$/, '');
            const parent = path.dirname(base);
            if (base.startsWith('/') && !fs.existsSync(base) && !fs.existsSync(parent)) {
                add('settings', 'info', `allow rule "${rule}" points into a directory that no longer exists`,
                    'remove it — a stale grant is a grant nobody is reviewing');
            }
        }
    }
}

// --------------------------------------------------------------- prd.json
// prd.json is only load-bearing if it is current, and in practice most work
// happens through direct conversation and never reaches it. A stale backlog is
// worse than no backlog: stop-auto-check blocks on stories nobody is working,
// and status reports fiction. Detect the gap instead of assuming the file is
// authoritative.
function auditPrd(repo) {
    const prdPath = path.join(repo, 'prd.json');
    if (!fs.existsSync(prdPath)) return;

    const prd = readJSON(prdPath);
    if (!prd) {
        add('prd', 'warn', `${path.basename(repo)}/prd.json does not parse`,
            'fix or delete it — auto and status both read it');
        return;
    }

    const stories = Object.values(prd.stories || {});
    const pending = stories.filter((s) => s.passes !== true && s.passes !== 'deferred').length;
    if (!pending) return;

    // Age by last COMMIT that changed prd.json, not filesystem mtime. Every
    // prd.json on this machine reported 0 days by mtime — the file gets touched
    // without its content changing, so mtime says "current" about a backlog
    // nobody has reconciled in weeks.
    let prdAgeDays = 0;
    let commitsSince = 0;
    try {
        const lastPrdCommit = Number(execSync(
            'git log -1 --format=%ct -- prd.json',
            { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim());
        if (!lastPrdCommit) return;
        prdAgeDays = Math.floor((Date.now() / 1000 - lastPrdCommit) / 86400);
        if (prdAgeDays < 3) return;

        commitsSince = Number(execSync(
            `git rev-list --count ${lastPrdCommit ? `--since=${lastPrdCommit}` : ''} HEAD`,
            { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim()) || 0;
    } catch { return; }

    if (commitsSince >= 10) {
        add('prd', 'warn',
            `${path.basename(repo)}: prd.json lists ${pending} pending story(ies) but has not been touched in ${prdAgeDays}d, while ${commitsSince} commits landed`,
            'reconcile it, or stop relying on auto/status here — auto will block on work nobody is doing');
    }
}

auditPlugins();
auditSchedules();
auditSettings();

// Project repos, discovered from the memory store rather than hardcoded.
try {
    const projects = path.join(CONFIG, 'projects');
    for (const slug of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
        const guess = '/' + slug.replace(/^-/, '').replace(/-/g, '/');
        if (fs.existsSync(path.join(guess, '.git'))) auditPrd(guess);
    }
} catch { /* discovery is best-effort */ }

if (asJson) { console.log(JSON.stringify({ configDir: CONFIG, findings }, null, 2)); process.exit(findings.some((f) => f.severity === 'fail') ? 1 : 0); }

const order = { fail: 0, warn: 1, info: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);

console.log(`\nDrift audit — ${CONFIG}\n`);
if (!findings.length) { console.log('  ✓ plugins, schedules and settings are all current\n'); process.exit(0); }

let lastArea = '';
for (const f of findings) {
    if (f.area !== lastArea) { console.log(`  [${f.area}]`); lastArea = f.area; }
    const tag = f.severity === 'fail' ? '✗' : f.severity === 'warn' ? '⚠' : '·';
    console.log(`    ${tag} ${f.detail}`);
    console.log(`      fix: ${f.fix}`);
}
console.log(`\n${findings.length} finding(s). Nothing was modified.\n`);
process.exit(findings.some((f) => f.severity === 'fail') ? 1 : 0);
