#!/usr/bin/env node
/**
 * worktree-reap.js - removes the linked worktrees whose work has landed. A dry
 * run is the default: it lists every worktree with the evidence that it landed
 * or the reasons it is kept, and removes nothing.
 *
 * WHY. Nothing removed a worktree after its branch merged. Sessions start one
 * per task, and each keeps its checkout, its node_modules and its build output
 * until someone removes it by hand. [measured 2026-10-05] one machine had about
 * 250 linked worktrees, and deleting only the node_modules of 46 idle ones freed
 * about 27 GB.
 *
 * A WORKTREE IS REMOVED ONLY WHEN EVERY ONE OF THESE HOLDS:
 *   1. It is a linked worktree: not the main checkout, not locked, and on a
 *      branch (a detached HEAD has no branch to say where its commits went).
 *   2. Its work landed in origin's default branch, by one of four kinds of
 *      evidence: a pull request for its branch is MERGED or CLOSED with its
 *      head at exactly this HEAD; HEAD was merged by a merge commit (an
 *      ancestor, off the first-parent line); HEAD was fast-forwarded in (on
 *      the first-parent line, and the branch's reflog shows commits made after
 *      it was created, because a branch nobody committed on sits on that line
 *      too); or HEAD was rebased in (`git cherry` finds an equivalent for every
 *      one of its commits). An OPEN pull request for the branch keeps it. When
 *      pull requests cannot be read, an open one cannot be ruled out, so only a
 *      settled one would do, and none can be read: it is kept.
 *   3. Nothing is unpushed: no commit on HEAD is missing from every origin ref,
 *      unless a settled pull request's head is this HEAD (GitHub holds it) or
 *      every commit was rebased in (the change is in the base already).
 *   4. It is idle: no transcript of any profile for this path, and none of its
 *      git admin files (HEAD, index, logs/HEAD), was written within the idle
 *      window (--idle-hours, 24 by default).
 *   5. No lane lock, ticket or lease of the full gate names it, and no running
 *      process has its path in the command line (reap-build-output.js asks the
 *      same three questions before it deletes a `.next`).
 *   6. It is clean: no changed or untracked file, and every gitignored file is
 *      either regenerable (worktree-residue.js) or byte-identical to the main
 *      checkout's file at the same path (a copied `.env.local`).
 * With --apply, each candidate is checked again with fresh probes inside the
 * worktree's lease mutex, and then `git worktree remove` runs WITHOUT --force,
 * so git itself refuses a worktree that became dirty in between. Git leaves a
 * junction behind (an npm workspace link) without following it, and that
 * remainder is unlinked, never followed, once git no longer lists the worktree.
 * The branch is left in place: its commits stay reachable, and the worktree can
 * be added again from it.
 *
 * FAILS CLOSED. A check that cannot be answered (a failed fetch, an unreadable
 * status, a default branch that cannot be resolved) keeps the worktree and says
 * why. An error in one worktree or repo never stops the others.
 *
 *   node worktree-reap.js --repo <main checkout> [--repo ...] [--apply] [--json]
 *                         [--idle-hours N] [--no-fetch] [--lock <gate lock path>]
 *
 * Repositories come only from --repo, each one's worktrees from `git worktree
 * list --porcelain`. Each repo is fetched with --prune first unless --no-fetch.
 *
 * Exit: 0 the run completed (a dry run, or an --apply with no failed removal),
 * 1 an --apply where a removal failed, 2 a usage error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const reap = require('./reap-build-output.js');
const residue = require('./worktree-residue.js');
const ident = require('./gate-identity.js');
const records = require('./gate-records.js');
const queue = require('./full-gate-queue.js');

const DEFAULT_IDLE_HOURS = 24;
const MAX_IGNORED_FILES = 2000;
const TAG = '[worktree-reap]';

function parseArgs(argv) {
    const out = { repos: [], apply: false, json: false, help: false, idleHours: DEFAULT_IDLE_HOURS, fetch: true, lock: null, error: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--repo' || a === '--lock' || a === '--idle-hours') {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) { out.error = `${a} needs a value`; return out; }
            i++;
            if (a === '--repo') out.repos.push(v);
            else if (a === '--lock') out.lock = v;
            else {
                const n = Number(v);
                if (!Number.isFinite(n) || n < 1) { out.error = `--idle-hours must be a number of hours, 1 or more (got ${v})`; return out; }
                out.idleHours = n;
            }
        } else if (a === '--apply') out.apply = true;
        else if (a === '--json') out.json = true;
        else if (a === '--no-fetch') out.fetch = false;
        else if (a === '--help' || a === '-h') out.help = true;
        else { out.error = `unknown argument ${a}`; return out; }
    }
    return out;
}

function git(dir, args, timeout = 60000) {
    try {
        const r = spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });
        if (r.error) return { ok: false, status: null, out: '', why: `git could not run (${r.error.code || r.error.message})` };
        const why = r.status === 0 ? null : `git ${args[0]} exited ${r.status}: ${String(r.stderr || '').trim().split(/\r?\n/)[0]}`;
        return { ok: r.status === 0, status: r.status, out: r.stdout || '', why };
    } catch (e) { return { ok: false, status: null, out: '', why: `git threw (${e.message})` }; }
}

// ---------------------------------------------------------------------------
// Per repository: fetch, the default branch, pull requests.
// ---------------------------------------------------------------------------

/**
 * Pull requests of the repo: { ok, prs: [{ number, state, headRefName, headRefOid }], why }.
 * AUTODEV_REAP_TEST_PRS names a JSON file that replaces gh: that list, or { unreadable: why }.
 */
function readPrs(main, env = process.env) {
    try {
        if (env.AUTODEV_REAP_TEST_PRS) {
            const v = JSON.parse(fs.readFileSync(env.AUTODEV_REAP_TEST_PRS, 'utf8'));
            if (!Array.isArray(v)) return { ok: false, prs: [], why: String((v && v.unreadable) || 'the planted pull request list is not a list') };
            return { ok: true, prs: v, why: null };
        }
        const url = git(main, ['remote', 'get-url', 'origin']);
        if (!url.ok) return { ok: false, prs: [], why: url.why };
        if (!/github\.com[:/]/i.test(url.out)) return { ok: false, prs: [], why: 'origin is not on GitHub, so gh cannot list its pull requests' };
        const r = spawnSync('gh', ['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,state,headRefName,headRefOid'],
            { cwd: main, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
        if (r.error) return { ok: false, prs: [], why: `gh could not run (${r.error.code || r.error.message})` };
        if (r.status !== 0) return { ok: false, prs: [], why: `gh pr list exited ${r.status}: ${String(r.stderr || '').trim().split(/\r?\n/)[0]}` };
        const prs = JSON.parse(r.stdout);
        if (!Array.isArray(prs)) return { ok: false, prs: [], why: 'gh pr list did not print a list' };
        return { ok: true, prs, why: null };
    } catch (e) {
        return { ok: false, prs: [], why: `pull requests could not be read (${e.message})` };
    }
}

/** origin's default branch as `origin/<name>`, or null. */
function defaultRef(main) {
    const sym = git(main, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (sym.ok && sym.out.trim().startsWith('refs/remotes/')) return sym.out.trim().slice('refs/remotes/'.length);
    for (const name of ['origin/main', 'origin/master']) {
        if (git(main, ['rev-parse', '--verify', '--quiet', `refs/remotes/${name}`]).ok) return name;
    }
    return null;
}

/** Everything one repository's worktrees are judged against: { main, why, base, firstParent, prs, worktrees }. */
function repoContext(repo, opts, env) {
    const main = path.resolve(repo);
    const rc = { repo, main, why: null, base: null, firstParent: new Set(), prs: { ok: false, prs: [], why: 'not read' }, worktrees: [] };
    if (!fs.existsSync(main)) { rc.why = `${main} does not exist`; return rc; }
    const list = git(main, ['worktree', 'list', '--porcelain']);
    if (!list.ok) { rc.why = list.why; return rc; }
    rc.worktrees = reap.parsePorcelain(list.out).filter((w) => !w.bare && !w.prunable).map((w) => ({ ...w, dir: path.resolve(w.path) }));
    if (opts.fetch) {
        const f = git(main, ['fetch', '--prune', '--quiet', 'origin'], 180000);
        if (!f.ok) { rc.why = `fetching origin failed (${f.why}), so what landed cannot be known`; return rc; }
    }
    rc.base = defaultRef(main);
    if (!rc.base) { rc.why = "origin's default branch cannot be resolved"; return rc; }
    const fp = git(main, ['rev-list', '--first-parent', rc.base]);
    if (!fp.ok) { rc.why = `the first-parent line of ${rc.base} cannot be read (${fp.why})`; return rc; }
    rc.firstParent = new Set(fp.out.split(/\r?\n/).filter(Boolean));
    rc.prs = readPrs(main, env);
    return rc;
}

// ---------------------------------------------------------------------------
// Per worktree.
// ---------------------------------------------------------------------------

/** Did the work land? { evidence, settledPr, reason }: exactly one of evidence or reason is set. */
function landed(rc, w) {
    const mine = rc.prs.ok ? rc.prs.prs.filter((p) => p && p.headRefName === w.branch) : [];
    const open = mine.find((p) => p.state === 'OPEN');
    if (open) return { reason: `pull request #${open.number} for its branch is open` };
    const settled = mine.find((p) => (p.state === 'MERGED' || p.state === 'CLOSED') && p.headRefOid === w.head);
    if (settled) return { evidence: `pull request #${settled.number} is ${settled.state.toLowerCase()} at this HEAD`, contentLanded: true };
    const noPrs = (what) => ({ reason: `${what}, but pull requests cannot be read (${rc.prs.why}), so an open one cannot be ruled out` });
    const anc = git(rc.main, ['merge-base', '--is-ancestor', w.head, rc.base]);
    if (anc.status !== 0 && anc.status !== 1) return { reason: `whether it is merged into ${rc.base} cannot be read (${anc.why})` };
    if (anc.status === 0) {
        // On the first-parent line, HEAD is either fast-forwarded work or a
        // branch nobody committed on, which look the same from the graph. The
        // branch's reflog tells them apart: it records where the branch was
        // created, and fast-forwarded work has commits after that point.
        if (rc.firstParent.has(w.head)) {
            const log = git(rc.main, ['reflog', 'show', '--format=%H', `refs/heads/${w.branch}`]);
            const created = log.ok ? log.out.trim().split(/\r?\n/).filter(Boolean).pop() : null;
            if (!created) return { reason: `its HEAD is on the first-parent line of ${rc.base} and the branch has no reflog, so nothing says any work was done on it` };
            if (created === w.head) return { reason: `its HEAD is where the branch was created, on ${rc.base}: nothing was committed on it` };
            const from = git(rc.main, ['merge-base', '--is-ancestor', created, w.head]);
            if (from.status !== 0) return { reason: `its reflog does not show it growing from where it was created, so whether its work landed is unclear` };
            if (!rc.prs.ok) return noPrs(`its commits were fast-forwarded into ${rc.base}`);
            return { evidence: `its commits were fast-forwarded into ${rc.base}` };
        }
        if (!rc.prs.ok) return noPrs(`its HEAD is merged into ${rc.base}`);
        return { evidence: `its HEAD is merged into ${rc.base}` };
    }
    // A rebase merge rewrites every commit, so HEAD is in no ancestry. `git
    // cherry` compares patches instead: a '-' line is a commit whose change is
    // already in the base, a '+' line one whose change is not.
    const ch = git(rc.main, ['cherry', rc.base, w.head], 120000);
    if (!ch.ok) return { reason: `whether its commits are in ${rc.base} cannot be read (${ch.why})` };
    const lines = ch.out.split(/\r?\n/).filter(Boolean);
    const missing = lines.filter((l) => l.startsWith('+')).length;
    if (lines.length && !missing) {
        if (!rc.prs.ok) return noPrs(`every one of its ${lines.length} commits has an equivalent in ${rc.base}`);
        return { evidence: `every one of its ${lines.length} commits has an equivalent in ${rc.base} (rebased in)`, contentLanded: true };
    }
    return { reason: `not landed: ${missing} of its ${lines.length} commits have no equivalent in ${rc.base}, and no merged or closed pull request is at this HEAD` };
}

/** The newest write that says someone works here, and where it was: { ms, source, why }. */
function lastActivity(w, env) {
    const adm = git(w.dir, ['rev-parse', '--absolute-git-dir']);
    if (!adm.ok) return { ms: null, source: null, why: `its git admin directory cannot be found (${adm.why})` };
    const admin = adm.out.trim();
    let ms = 0;
    let source = null;
    for (const f of ['HEAD', 'index', path.join('logs', 'HEAD')]) {
        try { const t = fs.statSync(path.join(admin, f)).mtimeMs; if (t > ms) { ms = t; source = `git ${f.replace(/\\/g, '/')}`; } } catch { /* absent */ }
    }
    const tr = Math.max(residue.newestTranscriptMs(w.dir, env), residue.newestTranscriptMs(w.dir.replace(/\\/g, '/'), env));
    if (tr > ms) { ms = tr; source = 'a session transcript'; }
    return { ms, source, why: null };
}

function sameBytes(a, b) {
    try {
        const sa = fs.statSync(a);
        const sb = fs.statSync(b);
        if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size || sa.size > 64 * 1024 * 1024) return false;
        return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch { return false; }
}

/** `git status -z` porcelain v1 -> [{ xy, path }], a rename's source path dropped. */
function parseStatusZ(out) {
    const toks = out.split('\0');
    const entries = [];
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.length < 4) continue;
        const xy = t.slice(0, 2);
        entries.push({ xy, path: t.slice(3) });
        if (xy[0] === 'R' || xy[0] === 'C') i++;
    }
    return entries;
}

/** Reasons the worktree holds something only it has; empty when removing it loses nothing. */
function residueReasons(rc, w) {
    const st = git(w.dir, ['status', '--porcelain=v1', '-z', '--ignored=traditional', '--untracked-files=normal']);
    if (!st.ok) return [`its status cannot be read (${st.why})`];
    const entries = parseStatusZ(st.out);
    const dirty = entries.filter((e) => e.xy !== '!!').map((e) => e.path);
    const out = [];
    const name = (list) => list.slice(0, 3).join(', ') + (list.length > 3 ? ', ...' : '');
    if (dirty.length) out.push(`${dirty.length} changed or untracked: ${name(dirty)}`);
    const only = [];
    let checked = 0;
    const judge = (rel) => {
        if (residue.isRegenerable(rel)) return;
        if (sameBytes(path.join(w.dir, rel), path.join(rc.main, rel))) return;
        only.push(rel);
    };
    for (const e of entries.filter((x) => x.xy === '!!')) {
        if (residue.isRegenerable(e.path)) continue;
        if (!e.path.endsWith('/')) { judge(e.path); continue; }
        const inside = git(w.dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', e.path]);
        if (!inside.ok) return [...out, `the ignored directory ${e.path} cannot be listed (${inside.why})`];
        for (const f of inside.out.split('\0').filter(Boolean)) {
            if (++checked > MAX_IGNORED_FILES) return [...out, `more than ${MAX_IGNORED_FILES} ignored files to compare, so not all were checked`];
            judge(f);
        }
    }
    if (only.length) out.push(`${only.length} ignored file${only.length === 1 ? '' : 's'} exist only here: ${name(only)}`);
    return out;
}

/**
 * Every reason to keep one worktree, and the evidence that its work landed.
 * The cheap structural checks come first and end the assessment, because a
 * status walk of a worktree that is kept anyway is wasted time.
 */
function judgeWorktree(rc, w, ctx, opts, env) {
    if (w.locked) return { reasons: ['git has it locked'] };
    if (w.detached || !w.branch || !w.head) return { reasons: ['its HEAD is detached, so no branch says where its commits went'] };
    if (w.branch.startsWith('-')) return { reasons: ['its branch name starts with a dash, which git could read as a flag'] };
    const here = path.resolve(process.cwd()).toLowerCase();
    const dirLower = w.dir.toLowerCase();
    if (here === dirLower || here.startsWith(dirLower + path.sep)) return { reasons: ['this command runs inside it'] };
    const l = landed(rc, w);
    if (!l.evidence) return { reasons: [l.reason] };
    const reasons = [];
    if (!l.contentLanded) {
        const un = git(w.dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
        if (!un.ok) reasons.push(`its unpushed commits cannot be counted (${un.why})`);
        else if (Number(un.out.trim()) > 0) reasons.push(`${un.out.trim()} commit(s) on it are on no origin ref`);
    }
    const act = lastActivity(w, env);
    if (act.why) reasons.push(act.why);
    else if (act.ms > ctx.nowMs - opts.idleHours * 3600000) reasons.push(`${act.source} was written ${Math.round((ctx.nowMs - act.ms) / 60000)} minutes ago, within the ${opts.idleHours}h idle window`);
    const wt = { dir: w.dir, canonical: ident.canonicalPath(w.dir) };
    for (const r of [reap.claimedBy(ctx.claims, wt), reap.leaseCovers(ctx.base, wt, ctx.judge), reap.processUses(ctx.procs, wt)]) if (r) reasons.push(r);
    if (!reasons.length) reasons.push(...residueReasons(rc, w));
    return { evidence: l.evidence, reasons };
}

function assess({ repos, base, opts, env = process.env }) {
    const ctx = reap.context(base, 1, env, false);
    const report = { repos: [], worktrees: [] };
    const seen = new Set();
    for (const repo of repos) {
        let rc;
        try { rc = repoContext(repo, opts, env); } catch (e) { rc = { repo, why: `the repo could not be read (${e.message})`, worktrees: [] }; }
        report.repos.push({ repo, base: rc.base || null, worktrees: rc.worktrees.length, why: rc.why, prs: rc.prs && !rc.prs.ok ? rc.prs.why : null });
        rc.worktrees.forEach((w, i) => {
            const key = ident.canonicalPath(w.dir);
            if (i === 0 || seen.has(key)) return;
            seen.add(key);
            let j;
            if (rc.why) j = { reasons: [rc.why] };
            else { try { j = judgeWorktree(rc, w, ctx, opts, env); } catch (e) { j = { reasons: [`the checks threw (${e.message})`] }; } }
            report.worktrees.push({ repo, main: rc.main, path: w.dir, branch: w.branch, head: w.head,
                eligible: j.reasons.length === 0, evidence: j.evidence || null, reasons: j.reasons, rc, w });
        });
    }
    return report;
}

function freeBytes(dir) {
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

/** Removes each eligible worktree after judging it again with fresh probes, inside its lease mutex. */
function apply(report, base, opts, env = process.env) {
    const results = [];
    for (const c of report.worktrees.filter((x) => x.eligible)) {
        const key = ident.pathKey(ident.canonicalPath(c.path));
        const before = freeBytes(c.main);
        let res;
        try {
            res = records.withWorktreeMutex(base, key, () => {
                const again = judgeWorktree(c.rc, c.w, reap.context(base, 1, env, true), opts, env);
                if (again.reasons.length) return { outcome: 'kept', why: `no longer eligible: ${again.reasons.join('; ')}` };
                const r = git(c.main, ['worktree', 'remove', c.path], 600000);
                if (!r.ok) return { outcome: 'failed', why: r.why };
                if (!fs.existsSync(c.path)) return { outcome: 'removed', why: null };
                // [measured 2026-10-05, git 2.54 on Windows] git unregisters the
                // worktree and deletes every file, but leaves a junction (an npm
                // workspace link) and the directories holding it, and exits 0.
                // It does not follow the junction: a canary behind it survived.
                // Node's rmSync unlinks a junction without following it either,
                // so the remainder is removed here once git no longer lists it.
                const still = git(c.main, ['worktree', 'list', '--porcelain']);
                if (!still.ok || reap.parsePorcelain(still.out).some((x) => ident.canonicalPath(path.resolve(x.path)) === ident.canonicalPath(c.path))) {
                    return { outcome: 'failed', why: 'git reported success but still lists the worktree' };
                }
                try { fs.rmSync(c.path, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
                    return { outcome: 'failed', why: `git unregistered it, but what git left (links it does not delete) could not be removed (${e.code || e.message})` };
                }
                return { outcome: 'removed', why: 'git left links it does not delete, removed after it' };
            }, { timeoutMs: 10000 });
        } catch (e) {
            res = { outcome: 'kept', why: `its lease mutex could not be taken (${e.code || e.message})` };
        }
        const after = freeBytes(c.main);
        results.push({ path: c.path, ...res, freedBytes: res.outcome === 'removed' && before !== null && after !== null ? Math.max(0, after - before) : null });
    }
    return results;
}

const HELP = () => {
    const lines = fs.readFileSync(__filename, 'utf8').split('\n');
    const end = lines.findIndex((l) => l.trim() === '*/');
    return lines.slice(2, end).map((l) => l.replace(/^ \* ?/, '')).join('\n');
};

function main(argv = process.argv.slice(2), env = process.env) {
    const args = parseArgs(argv);
    if (args.help) { process.stdout.write(HELP() + '\n'); return 0; }
    if (args.error) { process.stderr.write(`${TAG} ${args.error}\n`); return 2; }
    if (!args.repos.length) { process.stderr.write(`${TAG} name at least one --repo <main checkout>\n`); return 2; }
    const base = path.resolve(args.lock || env.AUTODEV_GATE_LOCK_PATH || queue.defaultLockPath());
    const report = assess({ repos: args.repos, base, opts: args, env });
    const results = args.apply ? apply(report, base, args, env) : [];
    const byPath = new Map(results.map((r) => [r.path, r]));
    const rows = report.worktrees.map(({ rc, w, ...row }) => ({ ...row, ...(byPath.has(row.path) ? { outcome: byPath.get(row.path).outcome, outcomeWhy: byPath.get(row.path).why } : {}) }));
    const removed = results.filter((r) => r.outcome === 'removed');
    const failed = results.filter((r) => r.outcome === 'failed');
    const freed = removed.reduce((n, r) => n + (r.freedBytes || 0), 0);
    if (args.json) {
        process.stdout.write(JSON.stringify({ apply: args.apply, idleHours: args.idleHours, repos: report.repos, worktrees: rows,
            removed: removed.length, failed: failed.length, freedBytes: freed }, null, 2) + '\n');
    } else {
        const out = [];
        for (const r of report.repos) out.push(`${TAG} ${r.repo}: ${r.worktrees} registered${r.base ? `, default ${r.base}` : ''}${r.why ? `, every worktree kept: ${r.why}` : ''}${r.prs ? ` (pull requests: ${r.prs})` : ''}`);
        for (const row of rows) {
            const verb = row.outcome || (row.eligible ? (args.apply ? 'removed' : 'would remove') : 'keep');
            const detail = row.outcome && row.outcome !== 'removed' ? row.outcomeWhy : (row.eligible ? row.evidence : row.reasons[0]);
            out.push(`  ${verb.padEnd(12)} ${row.path}  [${row.branch || 'detached'}] ${detail}`);
        }
        const eligible = rows.filter((r) => r.eligible).length;
        out.push(`${TAG} ${rows.length} linked worktrees: ${eligible} landed and idle, ${rows.length - eligible} kept`
            + (args.apply ? `. Removed ${removed.length}, freed ${(freed / 1048576).toFixed(0)} MB, ${failed.length} failed.` : '. Dry run: pass --apply to remove.'));
        process.stdout.write(out.join('\n') + '\n');
    }
    return failed.length ? 1 : 0;
}

module.exports = { parseArgs, readPrs, defaultRef, repoContext, landed, lastActivity, parseStatusZ, residueReasons, judgeWorktree, assess, apply, main, DEFAULT_IDLE_HOURS };

if (require.main === module) process.exitCode = main();
