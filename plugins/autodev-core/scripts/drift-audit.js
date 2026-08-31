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
const { execSync, execFileSync } = require('child_process');

const asJson = process.argv.includes('--json');
const HOME = process.env.HOME || process.env.USERPROFILE;
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

const findings = [];
const add = (area, severity, detail, fix) => findings.push({ area, severity, detail, fix });

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// Above this many uninstalled plugins in one marketplace, summarise instead of
// naming each. 5 sits between the two real populations measured on this
// machine: a 3-plugin marketplace missing 1, and a 286-plugin catalog missing
// 259. See the comment at the loop for why count is the right discriminator.
const PLUGIN_NAME_LIMIT = 5;

// ---------------------------------------------------------------- plugins
// A verdict with no denominator cannot be told apart from a check that ran on
// nothing. Every auditor records what it EXAMINED here, and a guard that bails
// records NOT CHECKED rather than silently contributing zero - because "found
// no drift" and "never looked" print identically otherwise, and this script is
// the nightly instrument the Stop hook leans on.
const census = [];
let prdAudited = 0, prdSkipped = 0;

function auditPlugins() {
    const installed = readJSON(path.join(CONFIG, 'plugins', 'installed_plugins.json'));
    const markets = readJSON(path.join(CONFIG, 'plugins', 'known_marketplaces.json'));
    if (!installed || !installed.plugins) { census.push('plugins: NOT CHECKED (installed_plugins.json unreadable)'); return; }
    census.push('plugins: ' + Object.keys(installed.plugins).length + ' installed');

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

        const missing = cat.plugins.filter((p) => !installed.plugins[`${p.name}@${marketName}`]);
        if (!missing.length) continue;

        // Naming each one only helps when you have adopted most of a
        // marketplace and a few slipped — that IS drift. Cherry-picking from a
        // large general catalog is not drift, it is what a catalog is for, and
        // the scoping above does not separate the two.
        //
        // Measured 2026-08-19: claude-plugins-official carries 286 plugins with
        // 27 installed, and alone produced 259 of this audit's 277 findings —
        // 95% of the output, burying the 14 warnings underneath it. Meanwhile
        // the case this check exists for (autodev-memory uninstalled while
        // autodev-core was in daily use) sits in a 3-plugin marketplace. The
        // two are separated by COUNT, so summarise past a handful.
        if (missing.length > PLUGIN_NAME_LIMIT) {
            add('plugins', 'info',
                `${marketName}: ${missing.length} of ${cat.plugins.length} published plugins are not installed`,
                `that is normal for a general catalog — browse with /plugin if you want one`);
            continue;
        }
        for (const p of missing) {
            add('plugins', 'info', `${p.name}@${marketName} is published in a marketplace you use, but not installed`,
                `/plugin install ${p.name}@${marketName}`);
        }
    }
}

// ------------------------------------------------------- scheduled tasks
function auditSchedules() {
    const dir = path.join(CONFIG, 'scheduled-tasks');
    if (!fs.existsSync(dir)) { census.push('schedules: NOT CHECKED (no scheduled-tasks dir)'); return; }
    const taskIds = fs.readdirSync(dir);
    census.push('schedules: ' + taskIds.length + ' task dir(s)');
    for (const id of taskIds) {
        const skill = path.join(dir, id, 'SKILL.md');
        if (!fs.existsSync(skill)) continue;

        // Heartbeat first. A routine that touches .last-run at the end of every
        // run — clean or not — gives this check something that measures FIRING.
        // The SKILL.md mtime below only measures editing, and a healthy task
        // stops being edited forever: without the stamp, every stable task
        // starts warning 7 days after its last edit, firing or not.
        const stamp = path.join(dir, id, '.last-run');
        if (fs.existsSync(stamp)) {
            // Optional {"cadence_days": N} in the stamp for non-daily tasks;
            // anything unparseable (a bare timestamp) means daily.
            let cadence = 1;
            try {
                const c = JSON.parse(fs.readFileSync(stamp, 'utf8')).cadence_days;
                if (Number.isFinite(c) && c > 0) cadence = c;
            } catch { /* bare-timestamp stamp — daily */ }
            const ageDays = Math.floor((Date.now() - fs.statSync(stamp).mtimeMs) / 86400000);
            // +2 days of slack: a laptop asleep over a weekend is not an outage.
            if (ageDays > cadence + 2) {
                add('schedules', 'warn',
                    `task "${id}" last completed a run ${ageDays}d ago (cadence ${cadence}d) — it has stopped firing`,
                    'check the Scheduled sidebar, or list_scheduled_tasks for lastRunAt');
            }
            continue;
        }

        const st = fs.statSync(skill);
        const ageDays = Math.floor((Date.now() - st.mtimeMs) / 86400000);
        // A daily routine whose definition and state have not been touched in a
        // week is very likely not firing. This is the "gate nobody runs" shape.
        if (ageDays > 7) {
            add('schedules', 'warn', `task "${id}" has not been touched in ${ageDays}d — verify it is still firing`,
                'check the Scheduled sidebar, or list_scheduled_tasks for lastRunAt — or have the task write .last-run at the end of every run, which this check prefers');
        }
    }
}

// ------------------------------------------------------------- settings
// An allow rule that can express everything a deny rule forbids makes the deny
// list decorative. These are the shapes that shipped in a real template.
// Two classes, and the difference decides whether narrowing is a real fix.
//
//   always: true  — the command's PURPOSE is arbitrary execution, so no
//   argument makes it safe. `Bash(sh -c *)` is every bit as total as
//   `Bash(sh *)`, and the only honest advice is to delete the rule.
//
//   always: false — an ordinary command where the bare wildcard is the whole
//   problem. `Bash(export *)` also allows `export X=1; <anything>` because the
//   rule matches a prefix; `Bash(export MSYS_NO_PATHCONV=*)` allows one
//   assignment and nothing else.
//
// The distinction was missing, and its absence made this check's own advice
// impossible to follow: the fix line said "narrow it to the specific command
// you need" while the matcher keyed on the command NAME, so a narrowed rule
// stayed flagged and deletion was the only thing that ever cleared a finding.
// Detection was right; the prescribed cure had never been run against the
// detector. Measured on a real settings.json 2026-08-19 — three fail-severity
// findings, none of which narrowing could clear.
const SHELL_ESCAPES = [
    { re: /^Bash\((?:ba)?sh\s/, why: 'runs any command, including every denied one', always: true },
    { re: /^Bash\(source\s/, why: 'same, via a sourced script', always: true },
    { re: /^Bash\(eval\s/, why: 'arbitrary evaluation', always: true },
    { re: /^Bash\((?:curl|wget)\s/, why: 'fetch-and-execute, and an exfiltration path' },
    { re: /^Bash\(export\s/, why: 'can rewrite PATH for later commands' },
    { re: /^Bash\(chmod\s/, why: 'makes any written file executable' },
    { re: /^Bash\(rm\s+-f/, why: 'deletion, usually sitting above a deny list about deletion' },
    { re: /^WebFetch\(domain:\*\)/, why: 'blanket approval for every domain', always: true },
];

// A rule is unconstrained when everything after the command and its flags is a
// bare '*' (or nothing at all). Flags are dropped first so `Bash(rm -f *)` and
// `Bash(chmod +x *)` still read as unconstrained — the wildcard is the target,
// and a flag does not narrow which files it hits.
function unconstrainedRule(rule) {
    const m = rule.match(/^\w+\(([^)]*)\)$/);
    if (!m) return true;
    const rest = m[1].trim().split(/\s+/).slice(1).filter((t) => !/^[-+]/.test(t));
    return rest.length === 0 || (rest.length === 1 && rest[0] === '*');
}

function auditSettings() {
    const p = path.join(CONFIG, 'settings.json');
    const s = readJSON(p);
    if (!s) { census.push('settings: NOT CHECKED (settings.json unreadable)'); return; }
    const allow = (s.permissions && s.permissions.allow) || [];
    census.push('settings: settings.json read, ' + allow.length + ' permission entries');
    const deny = (s.permissions && s.permissions.deny) || [];

    for (const rule of allow) {
        for (const esc of SHELL_ESCAPES) {
            if (esc.re.test(rule) && (esc.always || unconstrainedRule(rule))) {
                add('settings', deny.length ? 'fail' : 'warn',
                    `allow rule "${rule}" ${esc.why}${deny.length ? ` — and there are ${deny.length} deny rules it can bypass` : ''}`,
                    esc.always
                        ? 'delete the rule — this command runs arbitrary code, so no argument narrows it'
                        : 'constrain the argument (e.g. Bash(export MSYS_NO_PATHCONV=*)) rather than leaving a bare *, or delete the rule');
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

// argv form, never a shell. `args` is an ARRAY. Branch names harvested from
// for-each-ref are attacker-controlled on any repo you did not write — `evil;id;x`,
// ``evil`id`x`` and `evil$(id)x` are all legal git refs that survive push → clone →
// for-each-ref — and the old `execSync('git ' + args)` handed them to /bin/sh -c.
// execFileSync passes each element as one literal argument, so a metacharacter is
// data rather than syntax.
const g = (repo, args) => {
    try {
        return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
    // Shared container reader. On a nested file this returned {}, so every id
    // resolved to `undefined` and every story compared equal to every revision
    // of itself — the staleness cache would have reported a whole sprint as
    // untouched forever, and stop-auto-check.js consumes that cache to decide
    // which stories to stop counting.
    const stories = require(path.join(__dirname, 'prd-states.js')).storiesOf(parsed);
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
    const revs = g(repo, ['log', `-${PRD_COMMIT_SCAN}`, '--format=%H%x09%ct', '--', 'prd.json'])
        .split('\n').filter(Boolean)
        .map((l) => { const [h, t] = l.split('\t'); return { h, t: Number(t) }; });

    // Parse each revision once, not once per story.
    const lastEdit = {};
    let newer = null;
    for (const { h, t } of revs) {
        const text = g(repo, ['show', `${h}:prd.json`]);
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
    // `null` = unchanged across the whole scan, i.e. older than it reaches.
    const byId = {};
    for (const id of pendingIds) {
        byId[id] = lastEdit[id] ? Math.floor((now - lastEdit[id]) / 86400) : null;
    }
    const days = Object.values(byId);
    return {
        byId,
        known: days.filter((d) => d !== null).sort((a, b) => a - b),
        unresolved: days.filter((d) => d === null).length,
    };
}

// Publish per-story ages for stop-auto-check, which cannot afford to compute
// them (31ms hook vs a 1,652ms walk, on every Stop).
//
// Under CLAUDE_CONFIG_DIR, never in the repo: "nothing was modified" is a
// promise this tool makes about the repos it inspects.
function writeAgeCache(repo, byId, scanDepth) {
    try {
        const dir = path.join(CONFIG, 'autodev');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'prd-story-ages.json');
        let all = {};
        try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first write */ }
        all[repo] = {
            computedAt: new Date().toISOString(),
            scanDepth,
            // null means "older than the scan reached" — the consumer must treat
            // that as very old, not as unknown.
            ages: byId,
        };
        fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
    } catch { /* the cache is an optimisation; never fail the audit for it */ }
}

// The repo's default branch, as a remote ref. Falls back through the usual
// names and finally to HEAD, so a repo with no origin still gets an answer.
function defaultRef(repo) {
    const sym = g(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    if (sym) return sym.replace(/^refs\/remotes\//, '');
    for (const c of ['origin/main', 'origin/master']) {
        if (g(repo, ['rev-parse', '--verify', '--quiet', c])) return c;
    }
    return 'HEAD';
}

// Unmerged branches whose prd.json differs from the DEFAULT branch's.
//
// The case this exists for: a repo's tracker looked stale for weeks while the
// reconciliation sat finished on a branch nobody merged. A staleness check aimed
// at the checked-out tree cannot see that, and draws the opposite conclusion —
// "nobody has reconciled this" when someone had, elsewhere.
//
// Compared against the DEFAULT BRANCH, not HEAD. The first version compared to
// HEAD, and the moment you sit on a feature branch it reports `origin/main`
// itself as a carrier — main being ahead of your branch is the normal state of
// working on a branch, not drift. Caught by merging one of the real carriers
// and watching the finding fail to clear, because the checkout was on a docs
// branch at the time.
//
// Measured on 224 remote branches across three repos: 2 carriers, 0 false
// positives. One held a P0 audit wave (live invite codes tracked in git); the
// other held a finished P0 investigation. Both were worth surfacing.
function prdCarrierBranches(repo) {
    const base = defaultRef(repo);
    // The format loses its single quotes: there is no shell to strip them now, so
    // keeping them would make git emit them literally. The `.replace(/'/g, '')`
    // below stays — it was what made this work on Windows, where cmd.exe never
    // stripped them either — and is now a no-op on both platforms.
    const all = g(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes'])
        .split('\n').map((b) => b.replace(/'/g, '').trim())
        // A remote's HEAD is not a branch. `%(refname:short)` renders
        // refs/remotes/origin/HEAD as `origin` and refs/remotes/upstream/HEAD as
        // `upstream` — the short form NEVER ends in '/HEAD', so the `!/\/HEAD$/`
        // test this replaces could not fire, and the `b !== 'origin'` beside it
        // caught origin's HEAD only because of what that remote is called. Any
        // second remote's HEAD went through as a branch.
        //
        // Requiring a '/' drops all of them: a real remote branch shortens to
        // `<remote>/<branch>` and a remote HEAD shortens to a bare remote name.
        //
        // And drop anything beginning with '-'. `b` becomes a BARE POSITIONAL at
        // the `log -1 --format=%ad ... b` call below, and git reads a leading
        // dash there as an option: measured on git 2.54, a bogus flag in that
        // slot exits 128 "unrecognized argument" rather than being taken as a
        // rev. Requiring a '/' already makes this hard to reach from a clone
        // (`origin/--evil` shortens with the remote name in front), but a
        // dash-named remote would produce `-x/branch`, and the guard costs one
        // comparison. Rejecting beats `--end-of-options` here because it needs no
        // particular git version.
        .filter((b) => b && b.includes('/') && !b.startsWith('-') && b !== base);

    const scanned = all.slice(0, PRD_BRANCH_SCAN);
    const carriers = [];
    for (const b of scanned) {
        const ahead = Number(g(repo, ['rev-list', '--count', `${base}..${b}`])) || 0;
        if (!ahead) continue;
        if (!g(repo, ['diff', '--name-only', `${base}...${b}`, '--', 'prd.json'])) continue;
        carriers.push({ b, ahead, base, date: g(repo, ['log', '-1', '--format=%ad', '--date=format:%Y-%m-%d', b]) });
    }
    return { carriers, base, scanned: scanned.length, skipped: all.length - scanned.length };
}

function auditPrd(repo) {
    const prdPath = path.join(repo, 'prd.json');
    if (!fs.existsSync(prdPath)) { prdSkipped++; return; }
    prdAudited++;
    const name = path.basename(repo);

    const prd = readJSON(prdPath);
    if (!prd) {
        add('prd', 'warn', `${name}/prd.json does not parse`,
            'fix or delete it — auto and status both read it');
        return;
    }

    // The SECOND independent container read in this file — storyValues() above
    // is the other. Fixing one and calling the file done is the easy miss.
    const pendingIds = Object.entries(require(path.join(__dirname, 'prd-states.js')).storiesOf(prd))
        // isActionable(): needs-setup is blocked on a human, not stale work an
        // agent abandoned, so auditing it for drift blames the wrong party.
        .filter(([, s]) => require(path.join(__dirname, 'prd-states.js')).isActionable(s))
        .map(([id]) => id);
    if (!pendingIds.length) return;

    // --- a reconciliation that exists, on a branch nobody merged
    const { carriers, skipped } = prdCarrierBranches(repo);
    for (const c of carriers) {
        add('prd', 'warn',
            `${name}: ${c.b} is ${c.ahead} commit(s) ahead of ${c.base} and its prd.json differs (tip ${c.date}) — this backlog may already be reconciled there`,
            `read it before reconciling by hand: git diff ${c.base}...${c.b} -- prd.json`);
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
    const { byId, known, unresolved } = pendingStoryAges(repo, pendingIds);

    // Publish the ages for stop-auto-check, which cannot afford to compute them:
    // 31ms hook against a 1,652ms walk, paid on every Stop, for an answer that
    // changes by days. The nightly tool writes; the hook reads.
    writeAgeCache(repo, byId, PRD_COMMIT_SCAN);

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
    const lastPrd = g(repo, ['log', '-1', '--format=%H', '--', 'prd.json']);
    const lastPrdTs = Number(g(repo, ['log', '-1', '--format=%ct', '--', 'prd.json']));
    if (!lastPrd || !lastPrdTs) return;
    const fileAge = Math.floor((Date.now() / 1000 - lastPrdTs) / 86400);
    const commitsSince = Number(g(repo, ['rev-list', '--count', `${lastPrd}..HEAD`])) || 0;
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
//
// The slug is the project path with every separator replaced by '-', which is
// not reversible: '/home/my-project' and '/home/my/project' produce the same
// slug. That much is unfixable, which is why transcripts come first.
//
// The session transcripts inside each slug directory record the real cwd. Read
// that instead of reconstructing it. The reversal stays as a fallback for slug
// directories with no transcript yet — see pathFromSlug for what it can and
// cannot recover.
function pathFromTranscripts(dir) {
    let newest = null;
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        const mtime = fs.statSync(full).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { full, mtime };
    }
    if (!newest) return null;
    // The cwd appears on most records; the first one found is enough, and
    // reading the head avoids pulling a multi-megabyte transcript into memory.
    const head = fs.readFileSync(newest.full, 'utf8').split('\n', 400);
    for (const line of head) {
        const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
        if (m) { try { return JSON.parse('"' + m[1] + '"'); } catch { /* keep looking */ } }
    }
    return null;
}

// Reverse a slug back into a path.
//
// A POSIX path starts at the root, so its slug carries a leading '-'
// ('/home/x' -> '-home-x'). A Windows path starts at the drive, so its slug
// does not ('C:\Users\x' -> 'C--Users-x'). That leading '-' is therefore the
// discriminator, and it needs no platform check: a POSIX slug can never begin
// with a bare letter.
//
// Restoring the drive letter is the whole point. Dropping it produced
// '/C//Users/x', which never existed — and the drive-less '/Users/x' that
// looks like a fix is worse, because on Windows a rooted path with no drive is
// DRIVE-RELATIVE: it resolves against the current drive. The same slug then
// finds a repo when cwd is on C: and misses it when cwd is on D:. That is
// exactly why this suite passed locally and on Linux CI while failing on the
// Windows runner, whose workspace is D:\a\... and whose temp dir is on C:.
// Discovery found zero projects there, so every finding silently vanished.
//
// Still lossy on both platforms: any directory containing a real '-' reverses
// wrong. Callers verify the result exists before acting on it.
function pathFromSlug(slug) {
    const drive = /^([A-Za-z])--(.*)$/.exec(slug);
    if (drive) return drive[1] + ':/' + drive[2].replace(/-/g, '/');
    return '/' + slug.replace(/^-/, '').replace(/-/g, '/');
}

const found = [];
try {
    const projects = path.join(CONFIG, 'projects');
    for (const slug of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
        const dir = path.join(projects, slug);
        if (!fs.statSync(dir).isDirectory()) continue;
        let repo = null;
        try { repo = pathFromTranscripts(dir); } catch { /* fall through to the slug */ }
        if (!repo) repo = pathFromSlug(slug);
        if (fs.existsSync(path.join(repo, '.git'))) found.push(repo);
    }
} catch { /* discovery is best-effort */ }

// One repo, many checkouts. A .claude/worktrees/* entry is a git worktree of
// the project it sits inside, and every worktree shares that project's
// prd.json — so auditing each one reported the same backlog once per checkout.
// Measured on a real machine 2026-08-19: 34 repos reporting, 29 of them
// worktrees, and 103 prd findings describing about a dozen actual projects.
// A tracker warning repeated eleven times is not eleven warnings.
//
// `rev-parse --git-common-dir` is the identity every checkout of a repo agrees
// on: a worktree returns the parent's absolute .git, the main checkout returns
// a relative '.git'. Resolving both against their own directory yields the same
// key. Audit the MAIN checkout where there is one, so the finding names the
// path someone would actually open rather than a scratch worktree.
//
// Both sides go through realpathSync.NATIVE, and the `.native` is the whole
// point. Windows hands out 8.3 short names — a GitHub runner's %TEMP% is
// `C:\Users\RUNNER~1\AppData\Local\Temp` — while git answers with the long
// form, `C:\Users\<ci-account>\...`. Plain realpathSync leaves a short name
// alone (measured: `C:/PROGRA~1` in, `C:\PROGRA~1` out); only `.native`
// expands it to `C:\Program Files`. Comparing raw strings therefore compared
// two spellings of one directory and never matched, which is why the first
// version of this deduplicated locally and did nothing on CI.
const canonical = new Map();
const canonPath = (p) => {
    try { return fs.realpathSync.native(p).toLowerCase(); }
    catch { return path.resolve(p).toLowerCase(); }
};
for (const repo of found) {
    const common = g(repo, ['rev-parse', '--git-common-dir']);
    const key = canonPath(path.resolve(repo, common || '.git'));
    const isMain = key === canonPath(path.resolve(repo, '.git'));
    const seen = canonical.get(key);
    if (!seen || (isMain && !seen.isMain)) canonical.set(key, { repo, isMain });
}
for (const { repo } of canonical.values()) auditPrd(repo);
census.push('prd: ' + prdAudited + ' repo(s) with a prd.json, ' + prdSkipped + ' without, from ' +
    canonical.size + ' distinct repo(s)');

if (asJson) { console.log(JSON.stringify({ configDir: CONFIG, findings }, null, 2)); process.exit(findings.some((f) => f.severity === 'fail') ? 1 : 0); }

const order = { fail: 0, warn: 1, info: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);

console.log(`\nDrift audit — ${CONFIG}\n`);
for (const line of census) console.log('  ' + line);
console.log('');
// A zero here has two causes and they are opposite. Either the population was
// audited and is clean, or nothing was audited at all -- a wrong --config-dir,
// a moved checkout, a permission failure -- and "no drift" is then a statement
// about this probe rather than about the repos. Separate them before printing.
if (!canonical.size) {
    console.log('  COULD NOT AUDIT: 0 repos discovered under ' + CONFIG + '.');
    console.log('  The probe is blind, not the population clean. Check the config dir.\n');
    process.exit(1);
}
if (!findings.length) { console.log('  no drift found in the population above\n'); process.exit(0); }

let lastArea = '';
for (const f of findings) {
    if (f.area !== lastArea) { console.log(`  [${f.area}]`); lastArea = f.area; }
    const tag = f.severity === 'fail' ? '✗' : f.severity === 'warn' ? '⚠' : '·';
    console.log(`    ${tag} ${f.detail}`);
    console.log(`      fix: ${f.fix}`);
}
console.log(`\n${findings.length} finding(s). Nothing was modified.\n`);
process.exit(findings.some((f) => f.severity === 'fail') ? 1 : 0);
