#!/usr/bin/env node
'use strict';
// Daily later-check of live, applied accepts. Configure brain-clock with
// {"id":"acceptance-audit","script":"acceptance-audit.js","everyMin":1440}.
// Only observed reversals are wrong: an unmerged branch is not a failed accept.
// Unknown evidence stays null. No network writes, fetches, or worker mutations.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { configDir } = require('./claude-paths.js');
const { prRefs, ghPrFacts } = require('./delivery-outcomes.js');

function rows(file) {
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((s) => s.trim()).map(JSON.parse); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function git(repo, args) {
    return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
}
function audit(j, task, tasks, previous, facts, now) {
    const later = tasks.find((t) => t.taskId !== j.taskId && t.repo === task.repo
        && Date.parse(t.composedAt || t.startedAt) > Date.parse(j.at)
        && (t.reopensTaskId === j.taskId || (t.slug === j.slug && /\breopen(?:ed)?\b/i.test(t.reason || t.verdict?.reason || ''))));
    if (later) return { foundWrong: true, reason: 'later task reopened the work', reopenedBy: later.taskId };
    let report;
    try { report = fs.readFileSync(task.report, 'utf8'); } catch { return { foundWrong: null, reason: 'report unavailable' }; }
    const prs = prRefs(report);
    const commits = [...report.matchAll(/\b(?:commit|head|sha)[\s*:=]+`?([a-f0-9]{7,40})\b/gi),
        ...report.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/([a-f0-9]{7,40})\b/gi)].map((m) => m[1]);
    const checks = []; const observedCommits = [];
    for (const url of prs) {
        const f = facts(url);
        if (!f || f.state !== 'MERGED' || !(Date.parse(f.mergedAt) <= now)) { checks.push(null); continue; }
        if ([f.revertedAt, f.reopenedAt].some((t) => Date.parse(t) >= Date.parse(f.mergedAt) && Date.parse(t) <= now)) {
            return { foundWrong: true, reason: 'merged PR reverted or issue reopened', pr: url };
        }
        checks.push(false);
    }
    for (const sha of new Set(commits)) {
        if (!task.repo) { checks.push(null); continue; }
        // Resolve both operands first: merge-base exit 1 then means non-ancestry,
        // never an unavailable object or an unreadable repository.
        const base = git(task.repo, ['rev-parse', '--verify', `${task.base || 'origin/main'}^{commit}`]);
        const commit = git(task.repo, ['rev-parse', '--verify', `${sha}^{commit}`]);
        if (base.status !== 0 || commit.status !== 0) { checks.push(null); continue; }
        const head = commit.stdout.trim();
        const ancestor = git(task.repo, ['merge-base', '--is-ancestor', head, base.stdout.trim()]);
        const log = git(task.repo, ['log', '--format=%B', `${head}..${base.stdout.trim()}`]);
        if (log.status === 0 && log.stdout.toLowerCase().includes(`this reverts commit ${head.toLowerCase()}`)) {
            return { foundWrong: true, reason: 'commit reverted', commit: head };
        }
        if (ancestor.status === 0 && log.status === 0) { observedCommits.push(head); checks.push(false); }
        else if (ancestor.status === 1 && (previous?.observedCommits || []).includes(head)) {
            return { foundWrong: true, reason: 'previously merged commit no longer in base', commit: head };
        } else checks.push(null);
    }
    return { foundWrong: checks.length && checks.every((v) => v === false) ? false : null,
        reason: checks.length ? 'report references checked against available evidence' : 'no commit or PR in report', observedCommits };
}
function main(argv) {
    if (argv.includes('--help')) { console.log('Usage: acceptance-audit.js [--config-dir DIR] [--now ISO] [--pr-facts JSON]'); return; }
    const opts = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!['--config-dir', '--now', '--pr-facts'].includes(argv[i]) || !argv[i + 1]) throw new Error('invalid arguments');
        opts[argv[i]] = argv[i + 1];
    }
    const root = path.join(opts['--config-dir'] || configDir(), 'autodev');
    const now = opts['--now'] ? Date.parse(opts['--now']) : Date.now();
    if (!Number.isFinite(now)) throw new Error('invalid time');
    const at = new Date(now).toISOString();
    const judges = rows(path.join(root, 'brain-judge', 'judgements.jsonl'));
    const accepts = new Map();
    for (const j of judges) if (j && j.mode === 'live' && j.decision === 'accept' && j.applied === true && j.taskId && Date.parse(j.at) < now) {
        accepts.set(j.key || `${j.taskId}@${j.at}`, j);
    }
    if (!accepts.size) return;
    const tasks = JSON.parse(fs.readFileSync(path.join(root, 'unattended-workers.json'), 'utf8')).records;
    if (!Array.isArray(tasks)) throw new Error('worker records unavailable');
    const file = path.join(root, 'brain-judge', 'acceptance-audits.jsonl');
    const prior = rows(file); const pending = [];
    const fixture = opts['--pr-facts'] ? JSON.parse(fs.readFileSync(opts['--pr-facts'], 'utf8')) : null;
    const started = Date.now(); const cache = new Map();
    const facts = (url) => {
        if (!cache.has(url)) cache.set(url, fixture ? fixture[url] : Date.now() - started < 45000 ? ghPrFacts(url) : null);
        return cache.get(url);
    };
    // Least recently audited first so the bounded observer eventually covers a backlog.
    const last = (key) => prior.filter((r) => r.key === key).at(-1);
    const ordered = [...accepts].sort(([a], [b]) => (Date.parse(last(a)?.at) || 0) - (Date.parse(last(b)?.at) || 0));
    for (const [key, j] of ordered) {
        const previous = last(key);
        // A confirmed reversal is terminal. Re-stamping it every day would keep
        // the 14-day unsafe-accept counter red forever for one old incident.
        if (previous?.foundWrong === true) continue;
        if (previous?.at.slice(0, 10) === at.slice(0, 10) && typeof previous.foundWrong === 'boolean') continue;
        if (Date.now() - started >= 65000) break;
        const task = tasks.find((t) => t.taskId === j.taskId) || {};
        const result = audit(j, task, tasks, previous, facts, now);
        // Preserve previously observed ancestry even through temporary read failures.
        result.observedCommits = [...new Set([...(previous?.observedCommits || []), ...(result.observedCommits || [])])];
        if (previous?.at.slice(0, 10) === at.slice(0, 10) && previous.foundWrong === result.foundWrong
            && previous.reason === result.reason && JSON.stringify(previous.observedCommits) === JSON.stringify(result.observedCommits)) continue;
        pending.push({ type: 'acceptance-audit', at, key, taskId: j.taskId, acceptedAt: j.at, ...result });
    }
    if (pending.length) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, pending.map((r) => JSON.stringify(r)).join('\n') + '\n');
        console.log(`acceptance-audit: ${pending.length} audited of ${accepts.size} accepts; ${pending.filter((r) => r.foundWrong === true).length} wrong; ${pending.filter((r) => r.foundWrong === null).length} unknown`);
    }
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error(`acceptance-audit: ${e.message}`); process.exitCode = 2; } }
module.exports = { main, audit };
