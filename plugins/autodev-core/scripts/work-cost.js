#!/usr/bin/env node
'use strict';
/**
 * work-cost.js - what each merged PR cost, in tokens and list-price dollars.
 *
 * WHY THIS EXISTS. quota-burn.js answers "how much of the week is gone". It
 * cannot answer "what did that PR cost", which is the number a choice between
 * a headless worker and a Desktop session, or between two models, is made on.
 * It spends no model tokens: it reads transcripts and asks gh.
 *
 * WHAT IT READS
 *   - every transcript under <config dir>/projects, rows from the last --days
 *   - the PRs merged in that span in every repo a session worked in (gh)
 *   - the headless and unattended worker ledgers, for passes per story
 *
 * ONE API RESPONSE IS ONE PRICED ROW. A response is written as one row per
 * content block, and every row repeats its input and cache usage. An early row
 * is a streaming partial with a small output count. [measured 2026-09-29] over
 * two days, 14,361 of 24,421 usage rows repeated an earlier row's message id,
 * and they were 60% of the summed cost. Rows are keyed on message id and
 * request id, and the row with the MOST output is priced, a tie going to the
 * later row. quota-burn.js keeps the same row, so the two price one response
 * alike.
 *
 * ATTRIBUTION, strongest evidence first
 *   1. the session ran `gh pr create` and the result names the PR
 *   2. the session ran `git commit` and the result names the branch
 *      ("[branch sha]"), the head branch of a PR merged in the session's repo
 *   3. the session's rows were written on a branch (the transcript's
 *      gitBranch) that is the head of a PR merged in the session's repo.
 *      [measured 2026-09-29] only 52 of 1,105 commit results in 7 days
 *      printed the "[branch sha]" line: most commits run quiet or piped.
 *      A branch that never merged links nothing here, because every worktree
 *      sits on a branch and most of them never become a PR.
 *   4. only when none of those exists: the session ran `gh pr merge`
 * A session linked to several pieces of work splits its cost equally between
 * them. A committed branch that did not merge in the span keeps its share, and
 * is reported as not merged. A session with no link is unattributed. Rows
 * before the span are not counted, so a PR whose work started earlier reads low.
 *
 * Prices come from quota-burn.js priceUsage, required, never copied.
 *
 *   node work-cost.js                   last 7 days, human summary
 *   node work-cost.js --days 14 --json
 *   node work-cost.js --top 20          how many PRs the summary lists
 *   node work-cost.js --repo owner/name also read this repo's merged PRs
 *
 * Exit 0 measured. Exit 2 when an input could not be read: no transcript
 * directory, no merged-PR list from any repo, or a worker ledger that exists
 * and does not parse.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const claudePaths = require('./claude-paths.js');
const { priceUsage, transcripts } = require('./quota-burn.js');

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const all = (n) => argv.flatMap((a, i) => (a === '--' + n && argv[i + 1] ? [argv[i + 1]] : []));

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
// `git commit` prints "[branch sha] subject", and "[branch (root-commit) sha]".
const COMMIT_LINE = /^\[([^\s\]]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\]/gm;
const TRUNK = new Set(['main', 'master', 'HEAD']);
const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^\w[\w./-]*$/;
// Evidence kinds, strongest first.
const KINDS = ['create', 'branch', 'checkout', 'merge'];

function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
}

/**
 * The target of a `gh pr merge` in a command: { repo, number } or { repo, branch }.
 * A command can carry a brief for another session, with "gh pr merge <N>" in
 * its prose. So the command must start where a shell command starts (the
 * start of a line, or after a semicolon, an ampersand, a pipe or an opening
 * paren), the parse stops at a backtick, and a repo or a branch not shaped
 * like one is dropped.
 */
function mergeTarget(command) {
    const m = command.match(/(?:^|[;&|(])\s*(?:\w+=\S*\s+)*gh\s+pr\s+merge\b([^;&|\n`]*)/m);
    if (!m) return null;
    const toks = (m[1].match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
    const WITH_VALUE = new Set(['--body', '-b', '--body-file', '-F', '--subject', '-t',
        '--match-head-commit', '--author-email', '-A']);
    let repo = null;
    let target = null;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t === '--repo' || t === '-R') { repo = toks[++i] || null; continue; }
        if (t.startsWith('--repo=')) { repo = t.slice(7); continue; }
        if (WITH_VALUE.has(t)) { i++; continue; }
        if (t.startsWith('-')) continue;
        if (target === null) target = t;
    }
    if (!target) return null;
    const url = target.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    if (url) return { repo: url[1].toLowerCase(), number: Number(url[2]) };
    const lower = repo && REPO.test(repo) ? repo.toLowerCase() : null;
    if (/^#?\d+$/.test(target)) return { repo: lower, number: Number(target.replace('#', '')) };
    return BRANCH.test(target) ? { repo: lower, branch: target } : null;
}

function newSession(id) {
    return {
        id, cwd: null, created: new Set(), branches: new Set(), onBranch: new Set(), merges: [],
        responses: 0, cost: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    };
}

/** Read every transcript row in the span into sessions and priced responses. */
function scan(projects, sinceMs) {
    const sessions = new Map();
    const responses = new Map();
    const pop = { transcriptsRead: 0, transcriptsSkipped: 0, unreadable: 0, usageRows: 0, repeatedRows: 0, fallbackPriced: 0 };
    const sessionOf = (id) => {
        if (!sessions.has(id)) sessions.set(id, newSession(id));
        return sessions.get(id);
    };
    for (const f of transcripts(projects)) {
        let st;
        try { st = fs.statSync(f); } catch { pop.unreadable++; continue; }
        if (st.mtimeMs < sinceMs) { pop.transcriptsSkipped++; continue; }
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch { pop.unreadable++; continue; }
        pop.transcriptsRead++;
        const fileSession = path.basename(f, '.jsonl');
        const pending = new Map();
        let lineNo = 0;
        for (const line of text.split('\n')) {
            lineNo++;
            const usage = line.includes('"usage"');
            const tool = line.includes('"tool_use"') && (line.includes('commit') || line.includes('gh pr'));
            const result = pending.size > 0 && line.includes('"tool_result"');
            if (!usage && !tool && !result) continue;
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            const t = Date.parse(j.timestamp || '');
            if (!t || t < sinceMs) continue;
            const s = sessionOf(j.sessionId || fileSession);
            if (!s.cwd && j.cwd) s.cwd = j.cwd;
            if (typeof j.gitBranch === 'string' && j.gitBranch && !TRUNK.has(j.gitBranch)) s.onBranch.add(j.gitBranch);
            const msg = j.message || {};
            if (msg.usage) {
                pop.usageRows++;
                const key = msg.id ? msg.id + '|' + (j.requestId || '') : f + ':' + lineNo;
                const kept = responses.get(key);
                if (kept) pop.repeatedRows++;
                // Keep the row with the most output, as quota-burn.js does: a
                // row read after the final one can still be a streaming partial.
                if (!kept || (msg.usage.output_tokens || 0) >= (kept.u.output_tokens || 0)) {
                    responses.set(key, { s, u: msg.usage, model: msg.model || null });
                }
            }
            for (const c of Array.isArray(msg.content) ? msg.content : []) {
                if (!c) continue;
                if (c.type === 'tool_use' && c.name === 'Bash' && c.input && typeof c.input.command === 'string') {
                    const cmd = c.input.command;
                    if (/\bgh\s+pr\s+create\b/.test(cmd) || /\bgit\b[^\n;&|]*\bcommit\b/.test(cmd)) pending.set(c.id, s);
                    const mt = mergeTarget(cmd);
                    if (mt) s.merges.push(mt);
                } else if (c.type === 'tool_result' && pending.has(c.tool_use_id)) {
                    const owner = pending.get(c.tool_use_id);
                    pending.delete(c.tool_use_id);
                    const out = textOf(c.content);
                    for (const m of out.matchAll(PR_URL)) owner.created.add(m[1].toLowerCase() + '#' + m[2]);
                    for (const m of out.matchAll(COMMIT_LINE)) if (!TRUNK.has(m[1])) owner.branches.add(m[1]);
                }
            }
        }
    }
    for (const { s, u, model } of responses.values()) {
        const p = priceUsage(u, model);
        if (!p.known) pop.fallbackPriced++;
        s.responses++;
        s.cost += p.cost;
        for (const k of Object.keys(s.tokens)) s.tokens[k] += p.tokens[k];
    }
    pop.responses = responses.size;
    return { sessions: [...sessions.values()].filter((s) => s.responses > 0), pop };
}

const remotes = new Map();
/** owner/name of the GitHub origin behind a session's cwd, or null. */
function repoOfCwd(cwd) {
    if (!cwd) return null;
    const root = cwd.split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0];
    if (remotes.has(root)) return remotes.get(root);
    let repo = null;
    if (fs.existsSync(root)) {
        const r = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'],
            { encoding: 'utf8', timeout: 15000, windowsHide: true });
        const m = r.status === 0 && String(r.stdout || '').trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
        if (m) repo = m[1].toLowerCase();
    }
    remotes.set(root, repo);
    return repo;
}

/** PRs merged in one repo since sinceMs, through gh (or the WORK_COST_GH stub). */
function mergedPrs(repo, sinceMs) {
    const stub = process.env.WORK_COST_GH;
    const cmd = stub ? process.execPath : 'gh';
    const args = (stub ? [stub] : []).concat(['pr', 'list', '--repo', repo, '--state', 'merged',
        '--search', 'merged:>=' + new Date(sinceMs).toISOString().slice(0, 10),
        '--limit', '1000', '--json', 'number,headRefName,mergedAt,title,url']);
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { ok: false, detail: r.error.message };
    if (r.status !== 0) return { ok: false, detail: `exit ${r.status}: ${String(r.stderr || '').trim().slice(0, 160)}` };
    let list;
    try { list = JSON.parse(r.stdout); } catch { return { ok: false, detail: 'gh printed no JSON' }; }
    if (!Array.isArray(list)) return { ok: false, detail: 'gh printed JSON that is not a list' };
    return { ok: true, prs: list.filter((p) => p && Number.isInteger(p.number) && Date.parse(p.mergedAt) >= sinceMs) };
}

/** Link each session to the work it did: s.links maps a work key to its evidence. */
function attribute(sessions, byBranch) {
    for (const s of sessions) {
        const repo = repoOfCwd(s.cwd);
        const inRepo = (p) => !repo || p.key.startsWith(repo + '#');
        const links = new Map();
        for (const k of s.created) links.set(k, 'create');
        for (const b of s.branches) {
            const hits = (byBranch.get(b) || []).filter(inRepo);
            if (!hits.length) links.set(`branch ${repo || '?'} ${b}`, 'branch');
            for (const p of hits) if (!links.has(p.key)) links.set(p.key, 'branch');
        }
        for (const b of s.onBranch) {
            for (const p of (byBranch.get(b) || []).filter(inRepo)) if (!links.has(p.key)) links.set(p.key, 'checkout');
        }
        if (!links.size) {
            for (const mt of s.merges) {
                const r = mt.repo || repo;
                if (mt.number != null && r) links.set(r + '#' + mt.number, 'merge');
                else if (mt.branch) for (const p of (byBranch.get(mt.branch) || []).filter(inRepo)) links.set(p.key, 'merge');
            }
        }
        s.links = links;
    }
}

function median(xs) {
    if (!xs.length) return null;
    const a = xs.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Read a worker ledger: { present:false } | { ok:false, detail } | { ok:true, records }. */
function readLedger(file) {
    if (!fs.existsSync(file)) return { present: false, ok: true, records: [] };
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(j.records)) return { present: true, ok: false, detail: 'no records array' };
        return { present: true, ok: true, records: j.records.filter((r) => r && typeof r === 'object') };
    } catch (e) {
        return { present: true, ok: false, detail: e.message };
    }
}

/**
 * Runs per story until one settled done. A story is active when any of its
 * runs started in the span, and then all of its runs count. A story is a
 * headless code or an unattended taskId: a retry under a new code or taskId
 * reads as a new story, so these medians are a floor.
 */
function passes(records, keyOf, startOf, isDone, sinceMs) {
    const by = new Map();
    for (const r of records) {
        const k = keyOf(r);
        if (!k) continue;
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(r);
    }
    const counts = [];
    let active = 0;
    let notDone = 0;
    for (const runs of by.values()) {
        if (!runs.some((r) => Date.parse(startOf(r) || '') >= sinceMs)) continue;
        active++;
        runs.sort((a, b) => Date.parse(startOf(a) || '') - Date.parse(startOf(b) || ''));
        const i = runs.findIndex(isDone);
        if (i === -1) notDone++;
        else counts.push(i + 1);
    }
    return { stories: active, done: counts.length, notDone, median: median(counts), max: counts.length ? Math.max(...counts) : null };
}

function measure(opts) {
    const cfg = claudePaths.configDir();
    const projects = path.join(cfg, 'projects');
    try { fs.readdirSync(projects); } catch (e) {
        return { ok: false, reason: 'no transcript directory at ' + projects + ' (' + e.code + ')' };
    }
    const { sessions, pop } = scan(projects, opts.sinceMs);

    const repos = new Set(opts.repos.map((r) => r.toLowerCase()));
    for (const s of sessions) {
        const r = repoOfCwd(s.cwd);
        if (r) repos.add(r);
        for (const k of s.created) repos.add(k.split('#')[0]);
        for (const mt of s.merges) if (mt.repo) repos.add(mt.repo);
    }
    const prs = new Map();
    const byBranch = new Map();
    const unreadable = [];
    for (const repo of [...repos].sort()) {
        const got = mergedPrs(repo, opts.sinceMs);
        if (!got.ok) { unreadable.push(repo + ': ' + got.detail); continue; }
        for (const p of got.prs) {
            const key = repo + '#' + p.number;
            const pr = {
                key, repo, number: p.number, title: String(p.title || ''), url: p.url || null,
                headRefName: p.headRefName || null, mergedAt: p.mergedAt,
                cost: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
                sessions: new Set(), via: { create: 0, branch: 0, checkout: 0, merge: 0 },
            };
            prs.set(key, pr);
            if (pr.headRefName && !TRUNK.has(pr.headRefName)) {
                if (!byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, []);
                byBranch.get(pr.headRefName).push(pr);
            }
        }
    }
    if (repos.size && unreadable.length === repos.size) {
        return { ok: false, reason: 'no merged-PR list from any of ' + repos.size + ' repo(s): ' + unreadable[0] };
    }

    attribute(sessions, byBranch);
    const totals = { cost: 0, merged: 0, notMerged: 0, unattributed: 0 };
    const via = { create: 0, branch: 0, checkout: 0, merge: 0 };
    let linkedToMerged = 0;
    let onlyNotMerged = 0;
    for (const s of sessions) {
        totals.cost += s.cost;
        if (!s.links.size) { totals.unattributed += s.cost; continue; }
        const share = 1 / s.links.size;
        let strongest = null;
        for (const [k, kind] of s.links) {
            const pr = prs.get(k);
            if (!pr) { totals.notMerged += s.cost * share; continue; }
            if (!strongest || KINDS.indexOf(kind) < KINDS.indexOf(strongest)) strongest = kind;
            pr.cost += s.cost * share;
            for (const t of Object.keys(pr.tokens)) pr.tokens[t] += s.tokens[t] * share;
            pr.sessions.add(s.id);
            pr.via[kind]++;
            totals.merged += s.cost * share;
        }
        if (strongest) { linkedToMerged++; via[strongest]++; } else onlyNotMerged++;
    }

    const autodev = path.join(cfg, 'autodev');
    const hl = readLedger(path.join(autodev, 'headless-workers.json'));
    const ul = readLedger(path.join(autodev, 'unattended-workers.json'));
    const bad = [['headless', hl], ['unattended', ul]].filter(([, l]) => !l.ok);
    if (bad.length) return { ok: false, reason: `the ${bad[0][0]} ledger does not parse: ${bad[0][1].detail}` };

    const list = [...prs.values()].sort((a, b) => b.cost - a.cost).map((p) => ({ ...p, sessions: p.sessions.size }));
    return {
        ok: true,
        window: { days: opts.days, since: new Date(opts.sinceMs).toISOString() },
        basis: 'list-price equivalent; NOT a subscription bill',
        population: {
            ...pop,
            sessions: sessions.length, linkedToMerged, onlyNotMerged,
            unattributed: sessions.filter((s) => !s.links.size).length, via,
            repos: repos.size, reposUnreadable: unreadable, mergedPrs: prs.size,
            prsWithSessions: list.filter((p) => p.sessions > 0).length,
        },
        cost: totals,
        prs: list,
        passes: {
            headless: hl.present ? passes(hl.records, (r) => r.code, (r) => r.startedAt,
                (r) => r.result === 'done', opts.sinceMs) : null,
            unattended: ul.present ? passes(ul.records, (r) => r.taskId, (r) => r.startedAt || r.composedAt,
                (r) => r.runStatus === 'succeeded', opts.sinceMs) : null,
        },
    };
}

const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const pct = (n, d) => (d > 0 ? (100 * n / d).toFixed(1) : '0.0') + '%';
function tok(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(Math.round(n));
}

function printHuman(r, top) {
    const p = r.population;
    const lines = [
        `WORK COST  list-price equivalent, NOT a bill  |  PRs merged in the last ${r.window.days} day(s), since ${r.window.since.slice(0, 16)}Z`,
        `transcripts: ${p.transcriptsRead} read, ${p.transcriptsSkipped} older than the span, ${p.unreadable} unreadable`,
        `usage rows: ${p.usageRows} in the span, ${p.repeatedRows} repeated a row of the same response, `
            + `${p.responses} responses priced (${p.fallbackPriced} at the fallback rate)`,
        `sessions: ${p.sessions} with usage, ${p.linkedToMerged} linked to a merged PR (${p.via.create} by gh pr create, `
            + `${p.via.branch} by commit branch, ${p.via.checkout} by the branch it ran on, ${p.via.merge} by gh pr merge only), `
            + `${p.onlyNotMerged} linked only to `
            + `work not merged in the span, ${p.unattributed} unattributed`,
        `merged PRs: ${p.mergedPrs} in ${p.repos} repo(s), ${p.reposUnreadable.length} repo(s) unreadable, `
            + `${p.prsWithSessions} with at least one attributed session`,
        `cost: ${usd(r.cost.cost)} total, ${usd(r.cost.merged)} (${pct(r.cost.merged, r.cost.cost)}) to merged PRs, `
            + `${usd(r.cost.notMerged)} (${pct(r.cost.notMerged, r.cost.cost)}) to work not merged in the span, `
            + `${usd(r.cost.unattributed)} (${pct(r.cost.unattributed, r.cost.cost)}) unattributed`,
    ];
    p.reposUnreadable.forEach((u, i) => lines.push(`  unreadable repo ${i + 1} of ${p.reposUnreadable.length}: ${u}`));
    const shown = r.prs.filter((x) => x.sessions > 0).slice(0, top);
    lines.push(`top ${shown.length} merged PR(s) by cost:`);
    shown.forEach((x, i) => {
        lines.push(`  ${i + 1}. ${x.repo}#${x.number}  ${usd(x.cost)}  ${x.sessions} session(s)  in ${tok(x.tokens.input)}  `
            + `out ${tok(x.tokens.output)}  cache write ${tok(x.tokens.cacheWrite)}  cache read ${tok(x.tokens.cacheRead)}  `
            + x.title.slice(0, 60));
    });
    const h = r.passes.headless;
    lines.push(h ? `headless ledger: ${h.stories} code(s) active in the span, ${h.done} settled done, `
        + `median ${h.median === null ? 'n/a' : h.median} pass(es) to done, max ${h.max === null ? 'n/a' : h.max}, ${h.notDone} never settled done`
        : 'headless ledger: 0 records, no ledger file');
    const u = r.passes.unattended;
    lines.push(u ? `unattended ledger: ${u.stories} task(s) active in the span, ${u.done} succeeded, `
        + `median ${u.median === null ? 'n/a' : u.median} pass(es) to success, max ${u.max === null ? 'n/a' : u.max}, `
        + `${u.notDone} never succeeded`
        : 'unattended ledger: 0 records, no ledger file');
    console.log(lines.join('\n'));
}

function main() {
    if (has('help') || argv.includes('-h')) {
        console.log([
            'work-cost.js - tokens and list-price cost per merged PR, and passes per story',
            '',
            '  node work-cost.js                   last 7 days, human summary',
            '  node work-cost.js --days 14 --json',
            '  node work-cost.js --top 20          how many PRs the summary lists (default 10)',
            '  node work-cost.js --repo owner/name also read this repo\'s merged PRs',
            '',
            'Exit 0 measured, 2 when transcripts, every merged-PR list, or a ledger could not be read.',
        ].join('\n'));
        return;
    }
    const days = Number(val('days', 7));
    if (!(days > 0)) {
        console.error('--days needs a positive number of days');
        process.exitCode = 2;
        return;
    }
    const r = measure({ days, sinceMs: Date.now() - days * 86400000, repos: all('repo') });
    if (!r.ok) {
        if (has('json')) console.log(JSON.stringify({ ok: false, reason: r.reason }));
        console.error('work-cost: COULD NOT MEASURE: ' + r.reason);
        process.exitCode = 2;
        return;
    }
    if (has('json')) { console.log(JSON.stringify(r)); return; }
    printHuman(r, Math.max(1, Number(val('top', 10)) || 10));
}

main();
