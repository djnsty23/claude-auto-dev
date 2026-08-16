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
// prd.json revisions walked for per-story ages. Measured on three real repos:
// at 40 the >30d COUNT was already right (unresolved stories count as stale) but
// the median and oldest were understated — 57d/94d against a true 61d/99d — and
// two repos had stories older than the scan reached. 120 resolves every story in
// all three; 200 returns byte-identical output because the walk stops as soon as
// the last pending story resolves. Cost of the difference: 3.5s -> 5.2s for the
// whole audit, which is a manual/nightly tool, not a hook.
const PRD_COMMIT_SCAN = 120;
const PRD_BRANCH_SCAN = 40;   // most-recent remote branches checked for carriers

const g = (repo, args) => {
    try {
        return execSync('git ' + args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return ''; }
};

// A story's value at one revision, as a comparable string.
//
// PARSE it. The first version sliced the raw text from `"S-1": {` to the next
// `\n    },`, which is faster and wrong: the LAST story in the object has no
// trailing comma, so its slice ran to end-of-file. Append any new story and the
// previously-last one's slice changes without its content changing — so every
// story reported as "edited" on the day the story after it was added, which is
// precisely the day a backlog grows. Caught by a test whose 90-day-stale story
// read as 1 day old.
function storyValues(text, ids) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return null; }
    const stories = parsed.stories || {};
    const out = {};
    for (const id of ids) {
        out[id] = stories[id] === undefined ? undefined : JSON.stringify(stories[id]);
    }
    return out;
}

// How long has each PENDING story's own entry gone unmodified?
//
// This exists because the whole-file age does not discriminate. Measured across
// three repos it read 4d / 0d / 1d — near-identical — while the median PENDING
// story was 60d, 15d and 1d old. One of those repos had twelve stories nobody
// had edited in a month and two older than three months; the file-level number
// called it four days current.
//
// The rejected alternative, recorded so it is not rebuilt: "age from the last
// commit that changed a `passes` value" sounds sharper and is not. Implemented
// and measured, it returned exactly the current answer in all three repos,
// because a single incremental story-close resets it just as a bulk edit does.
function pendingStoryAges(repo, pendingIds) {
    const revs = g(repo, `log -${PRD_COMMIT_SCAN} --format=%H%x09%ct -- prd.json`)
        .split('\n').filter(Boolean)
        .map((l) => { const [h, t] = l.split('\t'); return { h, t: Number(t) }; });

    // Parse each revision once, not once per story.
    const lastEdit = {};
    let newer = null;
    for (const { h, t } of revs) {
        const text = g(repo, `show ${h}:prd.json`);
        if (!text) continue;
        const vals = storyValues(text, pendingIds);
        // A revision where prd.json did not parse tells us nothing about any
        // story; skip it rather than reading it as "everything changed".
        if (!vals) continue;
        if (newer) {
            for (const id of pendingIds) {
                if (lastEdit[id]) continue;
                if (newer.vals[id] !== vals[id]) lastEdit[id] = newer.t;
            }
        }
        newer = { vals, t };
        if (pendingIds.every((id) => lastEdit[id])) break;
    }

    const now = Date.now() / 1000;
    const days = pendingIds.map((id) => lastEdit[id] ? Math.floor((now - lastEdit[id]) / 86400) : null);
    return {
        known: days.filter((d) => d !== null).sort((a, b) => a - b),
        unresolved: days.filter((d) => d === null).length,
    };
}

// Unmerged branches whose prd.json differs from HEAD's.
//
// The case this exists for: a repo's tracker looked stale for weeks while the
// reconciliation sat finished on a branch nobody merged. A staleness check aimed
// at the checked-out tree cannot see that, and draws the opposite conclusion —
// "nobody has reconciled this" when someone had, elsewhere.
//
// Measured on 224 remote branches across three repos: 2 carriers, 0 false
// positives. One held a P0 audit wave (live invite codes tracked in git); the
// other held a finished P0 investigation. Both were worth surfacing.
function prdCarrierBranches(repo) {
    const all = g(repo, `for-each-ref --sort=-committerdate --format='%(refname:short)' refs/remotes`)
        .split('\n').map((b) => b.replace(/'/g, '').trim())
        .filter((b) => b && !/\/HEAD$/.test(b) && b !== 'origin');

    const scanned = all.slice(0, PRD_BRANCH_SCAN);
    const carriers = [];
    for (const b of scanned) {
        const ahead = Number(g(repo, `rev-list --count HEAD..${b}`)) || 0;
        if (!ahead) continue;
        if (!g(repo, `diff --name-only HEAD...${b} -- prd.json`)) continue;
        carriers.push({ b, ahead, date: g(repo, `log -1 --format=%ad --date=format:%Y-%m-%d ${b}`) });
    }
    return { carriers, scanned: scanned.length, skipped: all.length - scanned.length };
}

function auditPrd(repo) {
    const prdPath = path.join(repo, 'prd.json');
    if (!fs.existsSync(prdPath)) return;
    const name = path.basename(repo);

    const prd = readJSON(prdPath);
    if (!prd) {
        add('prd', 'warn', `${name}/prd.json does not parse`,
            'fix or delete it — auto and status both read it');
        return;
    }

    const pendingIds = Object.entries(prd.stories || {})
        .filter(([, s]) => s.passes !== true && s.passes !== 'deferred')
        .map(([id]) => id);
    if (!pendingIds.length) return;

    // --- a reconciliation that exists, on a branch nobody merged
    const { carriers, skipped } = prdCarrierBranches(repo);
    for (const c of carriers) {
        add('prd', 'warn',
            `${name}: ${c.b} is ${c.ahead} commit(s) ahead and its prd.json differs from HEAD's (tip ${c.date}) — this backlog may already be reconciled there`,
            `read it before reconciling by hand: git diff HEAD...${c.b} -- prd.json`);
    }
    if (skipped) {
        add('prd', 'info', `${name}: ${skipped} older remote branch(es) not checked for prd changes (scanned the ${PRD_BRANCH_SCAN} most recent)`,
            'raise PRD_BRANCH_SCAN if this repo keeps long-lived branches');
    }

    // --- per-story staleness
    //
    // Unresolved stories count as stale rather than as unknown. A story whose
    // entry is unchanged across the last PRD_COMMIT_SCAN revisions is older than
    // every story the scan DID resolve, so dropping them biases the answer
    // downward — and it biases it by discarding exactly the worst cases. Caught
    // by measuring: at an 80-revision scan one repo read "12 of 15 stale, median
    // 60d"; at 40 the same repo read "11 of 15, median 48d", because its two
    // oldest stories fell off the end and out of the count.
    const { known, unresolved } = pendingStoryAges(repo, pendingIds);
    const stale = known.filter((d) => d > 30).length + unresolved;
    if (stale) {
        const median = known.length ? known[Math.floor(known.length / 2)] : null;
        const beyond = unresolved ? `; ${unresolved} older than this ${PRD_COMMIT_SCAN}-revision scan reaches` : '';
        add('prd', 'warn',
            `${name}: ${stale} of ${pendingIds.length} pending story(ies) untouched >30d`
            + (median === null ? '' : ` (median ${median}d, oldest resolved ${known[known.length - 1]}d${beyond})`),
            'reconcile those stories, or stop relying on auto/status here — auto blocks on work nobody is doing');
    }

    // --- the file-level view, kept as context rather than as the finding
    //
    // Count by RANGE, not --since. `--since` filters on COMMITTER date, so a
    // rebased commit falls outside a window that <sha>..HEAD includes. Measured
    // across three repos the two disagreed by +2, -1 and 0 — it errs both ways.
    const lastPrd = g(repo, 'log -1 --format=%H -- prd.json');
    const lastPrdTs = Number(g(repo, 'log -1 --format=%ct -- prd.json'));
    if (!lastPrd || !lastPrdTs) return;
    const fileAge = Math.floor((Date.now() / 1000 - lastPrdTs) / 86400);
    const commitsSince = Number(g(repo, `rev-list --count ${lastPrd}..HEAD`)) || 0;
    if (fileAge >= 3 && commitsSince >= 10) {
        add('prd', 'info',
            `${name}: prd.json last changed ${fileAge}d ago with ${commitsSince} commit(s) since`,
            'context for the per-story ages above — a fresh file can still hold a stale backlog');
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
