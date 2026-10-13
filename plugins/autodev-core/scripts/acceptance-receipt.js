#!/usr/bin/env node
'use strict';
/**
 * acceptance-receipt.js - verify a worker's result against its brief's acceptance
 * criteria, run by the coordinator and never by the worker, and gate accept on it.
 *
 * WHY. A headless worker's run was accepted on what the worker wrote: its report
 * tail, its own lines claiming checks ran, and a tool-less judge reading that
 * text. A brief could be missing, a criterion could be silently dropped, a check
 * line could be invented, and a verdict reached on one attempt or one tree could
 * stand for another. Nothing bound an accept to WHAT was verified.
 *
 * THE RECEIPT. `verify` binds, in one JSON document:
 *   task id and attempt id     (the attempt is the ledger's attemptId, set at launch or record)
 *   candidate tree             (the git tree hash of the result commit, never a branch name)
 *   brief and report sha256    (the full files)
 *   the criterion set          (every criterion parsed from the brief, each with its id)
 *   rubric version             (RUBRIC_VERSION: the pass rule below)
 *   authority profile sha256   (what the ledger records about how the worker ran)
 * and per criterion the check command, its exit code, and a bounded evidence
 * summary. The verifier runs every check itself, in a clean detached worktree of
 * the result commit it creates in a temp directory and removes afterwards.
 *
 * THE PASS RULE (RUBRIC_VERSION). A criterion passes when its check exits 0 and,
 * when it names `expect:`, a line of the FULL output stream matches it. The match
 * runs while the stream is read, chunk by chunk, so a decisive line anywhere in a
 * long output counts and the stored head and tail never decide anything.
 *
 * OVERSIZED EVIDENCE. Output is never silently cut. Each criterion stores the
 * first HEAD_BYTES and last TAIL_BYTES, the byte and line counts, the stream's
 * sha256, and `truncated: true` with the omitted byte count when it did not fit.
 *
 * WHERE RECEIPTS LIVE. `<config dir>/autodev/acceptance/`, beside and not inside
 * the worker's scratch (`autodev/reports/<task id>`). Each receipt is written
 * once, named by its own sha256, and recorded in `index.jsonl`, an append-only
 * chain whose every line carries the sha256 of the line before it. The gate reads
 * only receipts the index names, re-hashes the file and checks the chain. A file
 * anywhere else, a line in a report saying PASS, or hashes quoted in worker
 * output are never read as evidence. `verify` refuses to run inside a headless
 * worker (AUTODEV_HEADLESS=1), so the worker cannot verify itself.
 *
 * LIMIT, stated so nobody reads more into it. A worker runs as the same OS user,
 * so a process that deliberately rewrites the whole index chain and a receipt
 * together is not stopped by file permissions. Partial edits (a receipt changed
 * in place, a line appended out of chain) are detected and refused.
 *
 * THE GATE. `check` (and unattended-worker.js `verdict --decision accept`) refuses
 * with a named reason when: the brief is missing or changed, the brief has no
 * criteria or a criterion with no check, no receipt exists for this task, the
 * receipts are for another attempt, the receipt or index was tampered with, the
 * rubric, criterion set, report or authority profile changed, the candidate tree
 * is not the verified one, or any criterion failed.
 *
 * BRIEF FORMAT. A section headed "Acceptance criteria" (a markdown heading or a
 * line starting with those words). Each criterion is a bullet with an id, and
 * indented `check:` and optional `expect:` lines under it:
 *
 *     ## Acceptance criteria
 *     - AC1: the suite prints its summary
 *       check: node tooling/test-x.js
 *       expect: /^all=ACCEPT$/
 *
 * The section ends at the next markdown heading. `expect:` takes /regex/flags or
 * a plain substring.
 *
 * Usage: see USAGE below, or `node acceptance-receipt.js --help`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const claudePaths = require('./claude-paths.js');

const USAGE = [
    'Usage: node acceptance-receipt.js verify --task-id <id> [--head <sha>] [--timeout-sec 600] [--ledger <file>]',
    '       node acceptance-receipt.js check --task-id <id> [--head <sha>] [--ledger <file>]',
    '       node acceptance-receipt.js criteria --brief-file <md>',
    'verify: run every acceptance criterion of the task\'s brief against its result commit, in a clean',
    '        detached worktree, and record a receipt the worker cannot have written. Refused inside a worker.',
    'check:  whether an accept would pass the receipt gate now, with the named reason when it would not.',
    'criteria: the criteria parsed from a brief, so a coordinator can see what verify will run.',
    'A brief names its criteria under "Acceptance criteria": "- AC1: text", then "  check: <command>",',
    '        then optionally "  expect: /regex/" matched against every line of the full output.',
    `Receipts: ${path.join('~', '.claude', 'autodev', 'acceptance')} (index.jsonl is an append-only hash chain).`,
    'Output: {"ok":true,"value":{...}} exit 0; {"ok":false,"error":{"code","message"}} exit 1.',
].join('\n') + '\n';

const RUBRIC_VERSION = 'acceptance-1: exit 0 and every expect matched on the full output stream';
const HEAD_BYTES = 4 * 1024;
const TAIL_BYTES = 4 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MATCHED_LINE_MAX = 500;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const LOCK_WAIT_MS = 10 * 1000;
const GENESIS = 'genesis';

// Every reason the gate can refuse with. brain-judge.js turns a judge accept
// refused with one of these into escalate, as it does for a pin refusal.
const REFUSALS = Object.freeze([
    'attempt-unknown', 'brief-missing', 'brief-unbound', 'brief-changed', 'no-criteria', 'criterion-without-check',
    'receipt-missing', 'receipt-other-attempt', 'receipt-tampered', 'receipt-index-broken', 'rubric-changed',
    'criteria-changed', 'candidate-missing', 'candidate-ambiguous', 'tree-changed', 'report-missing', 'report-changed',
    'authority-changed', 'criterion-failed',
]);

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fileSha = (file) => sha256(fs.readFileSync(file));

function parseArgs(argv) {
    const out = { _: [] };
    const known = ['task-id', 'head', 'timeout-sec', 'ledger', 'brief-file'];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const eq = a.indexOf('=');
        const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (!known.includes(key)) fault('usage', `unknown flag --${key}`);
        if (Object.prototype.hasOwnProperty.call(out, key)) fault('usage', `--${key} given twice`);
        const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined || value === '') fault('usage', `--${key} needs a value`);
        out[key] = value;
    }
    return out;
}

function git(repo, args, timeoutMs) {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true });
    if (r.error && r.error.code === 'ETIMEDOUT') return { status: null, stdout: '', stderr: `timed out after ${timeoutMs} ms` };
    if (r.error) fault('git-unavailable', r.error.message);
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function stateDir(env = process.env) { return path.join(claudePaths.configDir(env), 'autodev', 'acceptance'); }
function defaultLedger(env = process.env) { return path.join(claudePaths.configDir(env), 'autodev', 'unattended-workers.json'); }

// ------------------------------------------------------------------ criteria

const SECTION_RE = /^\s{0,3}(?:#{1,6}\s*)?acceptance criteria\b/i;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const ITEM_RE = /^\s*[-*]\s+\[?([A-Z][A-Z0-9_-]*\d+)\]?\s*[:.)]\s*(.*)$/;
const CHECK_RE = /^\s+check:\s*(.+?)\s*$/i;
const EXPECT_RE = /^\s+expect:\s*(.+?)\s*$/i;

/** A `/regex/flags` spec or a plain substring, as a RegExp. Invalid regex faults. */
function expectPattern(spec) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(spec);
    try { return m ? new RegExp(m[1], m[2].replace(/[gy]/g, '')) : new RegExp(spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); } catch (e) { return fault('bad-expect', `expect ${spec}: ${e.message}`); }
}

/**
 * Every criterion in the brief's acceptance section, in order. A criterion with
 * no check line keeps `check: null`: the gate names it rather than skipping it.
 */
function parseCriteria(text) {
    const lines = String(text).split(/\r?\n/);
    const criteria = [];
    let inSection = false; let sections = 0; let cur = null;
    for (const line of lines) {
        if (SECTION_RE.test(line)) { inSection = true; sections++; cur = null; continue; }
        if (!inSection) continue;
        if (HEADING_RE.test(line)) { inSection = false; cur = null; continue; }
        const item = ITEM_RE.exec(line);
        if (item) {
            if (criteria.some((c) => c.id === item[1])) fault('bad-criteria', `criterion ${item[1]} is named twice`);
            cur = { id: item[1], text: item[2].trim(), check: null, expect: null };
            criteria.push(cur);
            continue;
        }
        if (!cur) continue;
        const c = CHECK_RE.exec(line);
        if (c) { cur.check = c[1].replace(/^`(.+)`$/, '$1'); continue; }
        const x = EXPECT_RE.exec(line);
        if (x) { cur.expect = x[1].replace(/^`(.+)`$/, '$1'); expectPattern(cur.expect); }
    }
    return { sections, criteria };
}

// ------------------------------------------------------------------ binding

/** The attempt a record stands for: the attemptId launch or record set, else its start time. */
function attemptOf(rec) {
    if (rec && rec.attemptId) return String(rec.attemptId);
    if (rec && rec.startedAt) return `started-${rec.startedAt}`;
    return null;
}

/**
 * The authority the worker ran under, as the ledger records it: the channel, the
 * launch options (model, effort, permission mode, config dir), the tool families
 * kept, and the release that ran it. Hashed as canonical JSON.
 */
function authorityProfile(rec) {
    const l = rec.launch || {};
    const h = rec.headless || {};
    const profile = {
        channel: rec.channel || 'scheduled',
        permissionMode: l.permissionMode || null,
        model: l.model || null,
        effort: l.effort || null,
        configDir: l.configDir || null,
        keepTools: Array.isArray(h.keepTools) ? [...h.keepTools].sort() : null,
        version: h.version || rec.version || null,
        dev: rec.dev === undefined ? null : !!rec.dev,
    };
    return { profile, sha256: sha256(JSON.stringify(profile)) };
}

/**
 * The commit that stands for the worker's result, and its tree. `--head` when
 * given, else the local branch and its origin copy, which must agree on the tree.
 */
function candidate(rec, head) {
    const commit = (ref) => { const r = git(rec.repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return r.status === 0 ? r.stdout : null; };
    const tree = (sha) => git(rec.repo, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]).stdout;
    let heads;
    if (head) {
        const sha = commit(head);
        if (!sha) return { error: 'candidate-missing', why: `--head ${head} is not a commit in ${rec.repo}` };
        heads = [{ commit: sha, source: 'flag' }];
    } else {
        const read = () => [
            { commit: commit(`refs/heads/${rec.branch}`), source: 'local branch' },
            { commit: commit(`refs/remotes/origin/${rec.branch}`), source: 'origin branch' },
        ].filter((h) => h.commit);
        heads = read();
        if (!heads.length) {
            git(rec.repo, ['fetch', '--quiet', 'origin', `+refs/heads/${rec.branch}:refs/remotes/origin/${rec.branch}`], FETCH_TIMEOUT_MS);
            heads = read();
        }
    }
    if (!heads.length) return { error: 'candidate-missing', why: `no result commit for ${rec.branch} locally or on origin; name one with --head` };
    for (const h of heads) h.tree = tree(h.commit);
    if (new Set(heads.map((h) => h.tree)).size > 1) {
        return { error: 'candidate-ambiguous', why: `the local and origin copies of ${rec.branch} hold different trees; push or name one with --head` };
    }
    return { commit: heads[0].commit, tree: heads[0].tree, source: heads[0].source };
}

/** The brief, as the ledger bound it at enqueue or brief time. */
function readBoundBrief(rec) {
    if (!rec.briefFile || !fs.existsSync(rec.briefFile)) return { error: 'brief-missing', why: `the task has no brief file${rec.briefFile ? ` at ${rec.briefFile}` : ''}` };
    const text = fs.readFileSync(rec.briefFile, 'utf8');
    const sha = sha256(Buffer.from(text, 'utf8'));
    if (!rec.briefSha256) return { error: 'brief-unbound', why: 'the ledger records no brief sha256 to bind the brief to' };
    if (sha !== rec.briefSha256) return { error: 'brief-changed', why: `the brief at ${rec.briefFile} no longer hashes to what the ledger bound at enqueue` };
    return { text, sha256: sha };
}

function briefCriteria(text) {
    const { criteria } = parseCriteria(text);
    if (!criteria.length) return { error: 'no-criteria', why: 'the brief names no acceptance criteria, so nothing can be verified' };
    const bare = criteria.filter((c) => !c.check);
    if (bare.length) return { error: 'criterion-without-check', why: `criterion ${bare.map((c) => c.id).join(', ')} has no check: line` };
    return { criteria };
}

// ------------------------------------------------------------------ evidence

/**
 * Read a captured output file once, start to end, in chunks: count bytes and
 * lines, hash it, and test every complete line against `expect` as it streams.
 * The head and tail kept for a person are read separately and decide nothing.
 */
function scanOutput(file, expect) {
    const re = expect ? expectPattern(expect) : null;
    const size = fs.statSync(file).size;
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CHUNK_BYTES);
    let carry = ''; let lines = 0; let lineNo = 0; let match = null;
    const test = (line) => {
        lineNo++;
        if (re && !match && re.test(line.replace(/\r$/, ''))) match = { lineNo, line: line.replace(/\r$/, '').slice(0, MATCHED_LINE_MAX) };
    };
    try {
        for (;;) {
            const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
            if (!n) break;
            const chunk = buf.subarray(0, n);
            hash.update(chunk);
            const text = carry + chunk.toString('utf8');
            const parts = text.split('\n');
            carry = parts.pop();
            for (const p of parts) { lines++; test(p); }
        }
        if (carry.length) { lines++; test(carry); }
        let tail = '';
        const hb = Buffer.alloc(Math.min(HEAD_BYTES, size));
        fs.readSync(fd, hb, 0, hb.length, 0);
        const head = hb.toString('utf8');
        const truncated = size > HEAD_BYTES + TAIL_BYTES;
        if (size > HEAD_BYTES) {
            const tl = Math.min(TAIL_BYTES, size - HEAD_BYTES);
            const tb = Buffer.alloc(tl);
            fs.readSync(fd, tb, 0, tl, size - tl);
            tail = tb.toString('utf8');
        }
        return {
            bytes: size, lines, sha256: hash.digest('hex'), head, tail, truncated,
            omittedBytes: truncated ? size - HEAD_BYTES - TAIL_BYTES : 0,
            expect: expect ? { pattern: expect, matched: !!match, ...(match ? match : {}) } : null,
        };
    } finally { fs.closeSync(fd); }
}

/** Run one check in `cwd`, both streams to a file, then scan it. */
function runCheck(command, cwd, { expect = null, timeoutMs = CHECK_TIMEOUT_MS, scratch } = {}) {
    const out = path.join(scratch, `out-${crypto.randomUUID()}.log`);
    const fd = fs.openSync(out, 'w');
    let r;
    const started = Date.now();
    try {
        // Not the worker's environment: the verifier's own, minus the worker marker.
        const env = { ...process.env };
        delete env.AUTODEV_HEADLESS;
        r = spawnSync(command, { cwd, shell: true, stdio: ['ignore', fd, fd], timeout: timeoutMs, windowsHide: true, env });
    } finally { fs.closeSync(fd); }
    const evidence = scanOutput(out, expect);
    try { fs.rmSync(out, { force: true }); } catch { /* the scratch dir goes with the run */ }
    const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
    const exit = typeof r.status === 'number' ? r.status : null;
    const pass = !timedOut && exit === 0 && (!evidence.expect || evidence.expect.matched);
    return { exit, signal: r.signal || null, timedOut, spawnError: r.error && !timedOut ? r.error.message : null, durationMs: Date.now() - started, ...evidence, pass };
}

// ------------------------------------------------------------------ store

function indexFile(dir) { return path.join(dir, 'index.jsonl'); }

/** The index rows, with the chain checked. A broken chain is a refusal, never a skip. */
function readIndex(dir) {
    const file = indexFile(dir);
    if (!fs.existsSync(file)) return { rows: [], lastHash: GENESIS };
    const raw = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length);
    const rows = [];
    let prev = GENESIS;
    for (let i = 0; i < raw.length; i++) {
        let row;
        try { row = JSON.parse(raw[i]); } catch { return { error: 'receipt-index-broken', why: `index line ${i + 1} is not JSON` }; }
        if (!row || row.prev !== prev) return { error: 'receipt-index-broken', why: `index line ${i + 1} does not chain to the line before it` };
        rows.push(row);
        prev = sha256(raw[i]);
    }
    return { rows, lastHash: prev };
}

function withStoreLock(dir, fn) {
    const lock = path.join(dir, 'index.lock');
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
            if (Date.now() > deadline) fault('store-locked', `${lock} is held: ${e.code || e.message}`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
    try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}

/** Write the receipt once under its own hash and append it to the chained index. */
function storeReceipt(dir, receipt) {
    fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
    const body = JSON.stringify(receipt, null, 2) + '\n';
    const hash = sha256(body);
    const rel = `receipts/${receipt.taskId}/${hash}.json`;
    return withStoreLock(dir, () => {
        const idx = readIndex(dir);
        if (idx.error) fault(idx.error, idx.why);
        fs.mkdirSync(path.join(dir, 'receipts', receipt.taskId), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body, { flag: 'wx' });
        const row = { seq: idx.rows.length + 1, at: receipt.verifiedAt, taskId: receipt.taskId, attemptId: receipt.attemptId,
            tree: receipt.candidate.tree, complete: receipt.complete, receiptSha256: hash, file: rel, prev: idx.lastHash };
        fs.appendFileSync(indexFile(dir), JSON.stringify(row) + '\n');
        return { sha256: hash, file: path.join(dir, rel), row };
    });
}

// ------------------------------------------------------------------ verify

function verify(rec, { head = null, timeoutMs = CHECK_TIMEOUT_MS, dir = stateDir() } = {}) {
    if (process.env.AUTODEV_HEADLESS === '1') fault('verifier-in-worker', 'verify runs in the coordinator, never inside a headless worker');
    const attemptId = attemptOf(rec);
    if (!attemptId) fault('attempt-unknown', `task ${rec.taskId} has no attempt: it never started`);
    const brief = readBoundBrief(rec);
    if (brief.error) fault(brief.error, brief.why);
    const crit = briefCriteria(brief.text);
    if (crit.error) fault(crit.error, crit.why);
    if (!rec.report || !fs.existsSync(rec.report)) fault('report-missing', `no report at ${rec.report || '(none recorded)'}`);
    const reportSha256 = fileSha(rec.report);
    const cand = candidate(rec, head);
    if (cand.error) fault(cand.error, cand.why);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-'));
    const wt = path.join(scratch, 'tree');
    const results = [];
    try {
        const add = git(rec.repo, ['worktree', 'add', '--detach', '--quiet', wt, cand.commit], FETCH_TIMEOUT_MS);
        if (add.status !== 0) fault('worktree-failed', `git worktree add exited ${add.status}: ${add.stderr}`);
        const actual = git(wt, ['rev-parse', 'HEAD^{tree}']).stdout;
        if (actual !== cand.tree) fault('worktree-failed', `the clean checkout holds tree ${actual}, not ${cand.tree}`);
        for (const c of crit.criteria) {
            const evidence = runCheck(c.check, wt, { expect: c.expect, timeoutMs, scratch });
            results.push({ id: c.id, text: c.text, check: c.check, expect: c.expect, pass: evidence.pass, evidence });
        }
    } finally {
        git(rec.repo, ['worktree', 'remove', '--force', wt]);
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort: prune below drops the registration */ }
        git(rec.repo, ['worktree', 'prune']);
    }
    const authority = authorityProfile(rec);
    const receipt = {
        schema: 1, rubricVersion: RUBRIC_VERSION, taskId: rec.taskId, attemptId, repo: rec.repo,
        candidate: cand, briefFile: rec.briefFile, briefSha256: brief.sha256, report: rec.report, reportSha256,
        authority, criteria: results, complete: results.every((r) => r.pass),
        failed: results.filter((r) => !r.pass).map((r) => r.id),
        verifiedAt: new Date().toISOString(), verifier: { pid: process.pid, node: process.version },
    };
    const stored = storeReceipt(dir, receipt);
    return { receipt: stored.sha256, file: stored.file, complete: receipt.complete, failed: receipt.failed, tree: cand.tree, attemptId,
        criteria: results.map((r) => ({ id: r.id, pass: r.pass, exit: r.evidence.exit, bytes: r.evidence.bytes, lines: r.evidence.lines, truncated: r.evidence.truncated, expect: r.evidence.expect })) };
}

// ------------------------------------------------------------------ gate

const refuse = (code, why) => ({ ok: false, code, why });

/**
 * Whether an accept may be recorded for this record now. Pure reads: the brief,
 * the index, the receipt it names, the result commit and the report. Returns
 * { ok: true, receipt } or { ok: false, code, why } with code in REFUSALS.
 */
function gate(rec, { head = null, dir = stateDir() } = {}) {
    const attemptId = attemptOf(rec);
    if (!attemptId) return refuse('attempt-unknown', `task ${rec.taskId} has no attempt: it never started`);
    const brief = readBoundBrief(rec);
    if (brief.error) return refuse(brief.error, brief.why);
    let crit;
    try { crit = briefCriteria(brief.text); } catch (e) { return refuse('no-criteria', e.message); }
    if (crit.error) return refuse(crit.error, crit.why);

    const idx = readIndex(dir);
    if (idx.error) return refuse(idx.error, idx.why);
    const mine = idx.rows.filter((r) => r.taskId === rec.taskId);
    if (!mine.length) return refuse('receipt-missing', `no verified receipt for ${rec.taskId}: run acceptance-receipt.js verify --task-id ${rec.taskId}`);
    const thisAttempt = mine.filter((r) => r.attemptId === attemptId);
    if (!thisAttempt.length) return refuse('receipt-other-attempt', `the receipts for ${rec.taskId} are for attempt ${mine[mine.length - 1].attemptId}, not ${attemptId}`);
    const row = thisAttempt[thisAttempt.length - 1];
    const file = path.join(dir, row.file);
    if (!/^receipts\/[^/\\]+\/[0-9a-f]{64}\.json$/.test(row.file) || !fs.existsSync(file)) return refuse('receipt-tampered', `the indexed receipt ${row.file} is missing`);
    const body = fs.readFileSync(file);
    if (sha256(body) !== row.receiptSha256) return refuse('receipt-tampered', `${row.file} no longer hashes to the sha256 the index recorded`);
    let receipt;
    try { receipt = JSON.parse(body.toString('utf8')); } catch { return refuse('receipt-tampered', `${row.file} is not JSON`); }
    if (receipt.taskId !== rec.taskId || receipt.attemptId !== attemptId || !receipt.candidate || receipt.candidate.tree !== row.tree) {
        return refuse('receipt-tampered', `${row.file} does not match its index row`);
    }
    if (receipt.rubricVersion !== RUBRIC_VERSION) return refuse('rubric-changed', `receipt rubric ${receipt.rubricVersion}, current ${RUBRIC_VERSION}`);
    if (receipt.briefSha256 !== brief.sha256) return refuse('brief-changed', 'the brief changed after the receipt was verified');
    const want = crit.criteria.map((c) => `${c.id}\u0000${c.check}\u0000${c.expect || ''}`).join('\n');
    const got = (receipt.criteria || []).map((c) => `${c.id}\u0000${c.check}\u0000${c.expect || ''}`).join('\n');
    if (want !== got) return refuse('criteria-changed', 'the receipt does not cover exactly the brief\'s criteria');
    const cand = candidate(rec, head);
    if (cand.error) return refuse(cand.error, cand.why);
    if (cand.tree !== receipt.candidate.tree) return refuse('tree-changed', `the result is tree ${cand.tree.slice(0, 12)}, the receipt verified ${receipt.candidate.tree.slice(0, 12)}`);
    if (!rec.report || !fs.existsSync(rec.report)) return refuse('report-missing', `no report at ${rec.report || '(none recorded)'}`);
    if (fileSha(rec.report) !== receipt.reportSha256) return refuse('report-changed', 'the report changed after the receipt was verified');
    if (authorityProfile(rec).sha256 !== (receipt.authority && receipt.authority.sha256)) return refuse('authority-changed', 'the worker\'s authority profile differs from the verified one');
    const failed = (receipt.criteria || []).filter((c) => c.pass !== true).map((c) => c.id);
    if (failed.length || receipt.complete !== true) return refuse('criterion-failed', `criterion ${failed.join(', ') || '(none listed)'} failed verification`);
    return { ok: true, receipt: { sha256: row.receiptSha256, tree: row.tree, attemptId, verifiedAt: receipt.verifiedAt, criteria: receipt.criteria.map((c) => c.id) } };
}

// ------------------------------------------------------------------ cli

function loadRecord(opts) {
    if (!opts['task-id']) fault('usage', '--task-id is required');
    const file = opts.ledger || defaultLedger();
    if (!fs.existsSync(file)) fault('unknown-task', `no ledger at ${file}`);
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fault('ledger-unreadable', `${file}: ${e.message}`); }
    const rec = (ledger.records || []).find((r) => r.taskId === opts['task-id']);
    if (!rec) fault('unknown-task', `no ledger record for task ${opts['task-id']}`);
    return rec;
}

function run(argv) {
    const opts = parseArgs(argv);
    if (opts.help) return { help: true };
    const cmd = opts._[0];
    if (cmd === 'criteria') {
        if (!opts['brief-file']) fault('usage', '--brief-file is required');
        const parsed = parseCriteria(fs.readFileSync(opts['brief-file'], 'utf8'));
        return { sections: parsed.sections, criteria: parsed.criteria, unchecked: parsed.criteria.filter((c) => !c.check).map((c) => c.id) };
    }
    if (cmd === 'verify') {
        let timeoutMs = CHECK_TIMEOUT_MS;
        if (opts['timeout-sec'] !== undefined) {
            const n = Number(opts['timeout-sec']);
            if (!Number.isFinite(n) || n <= 0) fault('usage', '--timeout-sec must be a positive number');
            timeoutMs = n * 1000;
        }
        return verify(loadRecord(opts), { head: opts.head || null, timeoutMs });
    }
    if (cmd === 'check') {
        const g = gate(loadRecord(opts), { head: opts.head || null });
        if (!g.ok) fault(g.code, g.why);
        return g;
    }
    fault('usage', cmd ? `unknown command ${cmd}` : 'a command is required');
}

if (require.main === module) {
    try {
        const value = run(process.argv.slice(2));
        if (value.help) process.stdout.write(USAGE);
        else process.stdout.write(JSON.stringify({ ok: true, value }, null, 2) + '\n');
        process.exitCode = 0;
    } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: e.publicCode || 'internal', message: e.message } }) + '\n');
        process.exitCode = 1;
    }
}

module.exports = { parseCriteria, expectPattern, attemptOf, authorityProfile, candidate, scanOutput, runCheck, readIndex, storeReceipt, verify, gate, run, stateDir,
    REFUSALS, RUBRIC_VERSION, HEAD_BYTES, TAIL_BYTES };
