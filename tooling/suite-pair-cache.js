#!/usr/bin/env node
'use strict';
// suite-pair-cache.js - remembers the outcome of each check:suites stub run
// (one suite, one stubbed subject: a PAIR) so an unchanged pair need not run
// again.
//
// WHY. check:suites is the gate's longest step: every suite runs once as a
// baseline and once more per stubbed subject. Most pairs did not change since
// the last sweep, and their outcome cannot have changed either, IF everything
// the run depended on is the same. The hard part is that "if", and this module
// is mostly about refusing to answer when it cannot.
//
// MODES. The cache ships in SHADOW mode and changes no verdict there:
//   shadow (default)  every pair runs fresh, and the cache reports what it
//                     would have said, so agreement can be measured first.
//   on                a pair whose entry is valid is NOT run; its recorded
//                     outcome is used. `--cache` or AUTODEV_SUITE_CACHE=on.
//   off               no tracing, no lookups, no entries: the sweep exactly as
//                     it was. `--no-cache` or AUTODEV_SUITE_CACHE=off.
// A flag beats the environment. The baseline run and the special canaries
// (runner, validate.js) always run fresh, in every mode.
//
// THE KEY. An entry lives at
//   <base>/v1/<repo-id>/<key>.json
// base = AUTODEV_SUITE_CACHE_DIR or <home>/.claude/autodev/cache/check-suites.
// The key is a SHA-256 over a canonical serialisation of: the suite's path and
// bytes, the subject's path and ORIGINAL bytes (never the stub's), the checker
// and its helpers, the stub text, Node/V8/platform/arch, package.json and its
// lockfile, the suite environment (with the source tree's path replaced by a
// token), and the native commands the suite declares with the files they read.
// The candidate commit is recorded as provenance and is NOT in the key, so an
// unrelated commit leaves the pair reusable.
//
// THE DEPENDENCIES. What the runs touched is checked, not keyed: each entry
// carries the repository files the baseline and the stub run loaded, read,
// stat-ed and listed, and every require() a repository file made (from V8
// coverage plus suite-pair-trace.js), each with the state it had. A lookup is a hit only when every one still has that state
// and the fresh baseline touched exactly what the recorded one did.
//
// UNCACHEABLE, never guessed. A pair is not stored when a run did not complete,
// a restore conflicted, a traced process did not finish, a Node child ran
// without the trace, a native child ran that the suite does not declare, a
// script ran from outside the repository whose text matches no single
// repository file and was not written by the run itself, or a run read outside
// the repository and its private temp root. V8 coverage is not a filesystem
// tracer, and a native child's reads are invisible: the declaration line is the
// only way such a pair becomes cacheable, and it is the author's claim.
//
//   // suite-pair-cache: native git reads tooling/githooks/commit-msg, VERSION
//   // suite-pair-cache: off
//
// Entries are written only at the end of a run whose restores and source-ref
// checks all passed, through a unique temporary file and a rename with bounded
// retries on Windows sharing errors. A corrupt, unreadable or unwritable cache
// means a fresh run, never a failed sweep: the cache never changes an exit code.
//
//   node tooling/suite-pair-cache.js --help

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const trace = require('./suite-pair-trace.js');

const SCHEMA = 1;
const MODE_ENV = 'AUTODEV_SUITE_CACHE';
const DIR_ENV = 'AUTODEV_SUITE_CACHE_DIR';
const REPORT_ENV = 'AUTODEV_SUITE_CACHE_REPORT';
const CHECKER_FILES = [
    'check-suites-can-fail.js', 'suite-pair-cache.js', 'suite-pair-trace.js', 'subject-evidence.js',
    'suite-verdict-summary.js', 'spawn-budget.js', 'suite-tmp.js',
];
const PACKAGE_FILES = ['package.json', 'package-lock.json'];
const OUTCOMES = ['killed', 'green'];
const KINDS = ['script', 'read', 'stat', 'list', 'resolve'];
const WIN = process.platform === 'win32';
const ROOT_TOKEN = '<root>/';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fold = (p) => (WIN ? p.toLowerCase() : p);

// Stable JSON: object keys sorted at every depth, so equal content is equal text.
function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') {
        return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
}

// The mode and where it came from. An unknown environment value is reported
// and falls back to shadow, which changes no verdict.
function resolveMode(argv, env) {
    const a = argv || [];
    if (a.includes('--no-cache')) return { mode: 'off', source: '--no-cache' };
    if (a.includes('--cache')) return { mode: 'on', source: '--cache' };
    if (a.includes('--cache-shadow')) return { mode: 'shadow', source: '--cache-shadow' };
    const raw = String((env || {})[MODE_ENV] || '').trim().toLowerCase();
    if (!raw) return { mode: 'shadow', source: 'default' };
    if (['off', '0', 'false', 'no'].includes(raw)) return { mode: 'off', source: MODE_ENV };
    if (['on', '1', 'true', 'yes'].includes(raw)) return { mode: 'on', source: MODE_ENV };
    if (raw === 'shadow') return { mode: 'shadow', source: MODE_ENV };
    return { mode: 'shadow', source: `${MODE_ENV}=${raw} not recognised, so shadow` };
}

function reportPath(argv, env) {
    const a = argv || [];
    const i = a.indexOf('--cache-report');
    if (i !== -1 && a[i + 1]) return path.resolve(a[i + 1]);
    return (env || {})[REPORT_ENV] ? path.resolve(env[REPORT_ENV]) : null;
}

function cacheBase(env) {
    const e = env || {};
    return e[DIR_ENV] ? path.resolve(e[DIR_ENV]) : path.join(os.homedir(), '.claude', 'autodev', 'cache', 'check-suites');
}

// A remote URL with credentials, case, a trailing .git and slashes removed, so
// two clones of one repository share an id.
function normalizeOrigin(url) {
    let u = String(url || '').trim().toLowerCase();
    u = u.replace(/^[a-z+]+:\/\/[^@/]*@/, (m) => m.replace(/\/\/[^@/]*@/, '//'));
    u = u.replace(/^git@([^:]+):/, 'ssh://$1/').replace(/^[a-z+]+:\/\//, '');
    return u.replace(/\.git$/, '').replace(/\/+$/, '');
}

// The repository identity entries are filed under: the normalised origin when
// there is one, otherwise the canonical common git directory.
function repoIdentity(root) {
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    const origin = git(['config', '--get', 'remote.origin.url']);
    if (origin.status === 0 && origin.stdout.trim()) {
        return { id: sha256(normalizeOrigin(origin.stdout)).slice(0, 16), from: 'origin' };
    }
    const common = git(['rev-parse', '--git-common-dir']);
    if (common.status !== 0) return null;
    let dir = path.resolve(root, common.stdout.trim());
    try { dir = fs.realpathSync.native(dir); } catch { /* keep the resolved form */ }
    return { id: sha256(fold(dir)).slice(0, 16), from: 'git-dir' };
}

// Every spelling of a root a path might arrive in: resolved and native real
// path, case-folded on Windows. 8.3 short names expand only through
// realpathSync.native.
function rootVariants(root) {
    const out = new Set([fold(path.resolve(root))]);
    try { out.add(fold(fs.realpathSync.native(root))); } catch { /* resolved form only */ }
    return [...out];
}

// Is p at or under one of the variants? Returns the relative path with forward
// slashes ('.' for the root itself), or null.
function relUnder(p, variants) {
    const tryOne = (q) => {
        const f = fold(q);
        for (const v of variants) {
            if (f === v) return '.';
            if (f.startsWith(v + path.sep) || f.startsWith(v + '/')) return q.slice(v.length + 1).replace(/\\/g, '/');
        }
        return null;
    };
    const direct = tryOne(path.resolve(p));
    if (direct !== null) return direct;
    try { return tryOne(fs.realpathSync.native(p)); } catch { return null; }
}

// The state of one dependency, as a string that is equal exactly when the
// dependency is unchanged for that kind of use.
function fileState(root, kind, rel) {
    if (kind === 'resolve') return resolveState(root, rel);
    const full = rel === '.' ? root : path.join(root, rel);
    let st;
    try { st = fs.statSync(full); } catch { return 'absent'; }
    if (kind === 'stat') {
        // Type, link-ness, size and permission bits: what a stat-based check
        // can branch on. Times are left out on purpose: a checkout rewrites
        // them, and a verdict that depends on one is not reproducible anyway.
        let link = '';
        try { if (fs.lstatSync(full).isSymbolicLink()) link = 'link:'; } catch { /* stat succeeded */ }
        const type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        return link + type + (st.isFile() ? ':' + st.size : '') + ':' + (st.mode & 0o777).toString(8);
    }
    if (kind === 'list') {
        if (!st.isDirectory()) return st.isFile() ? 'file' : 'other';
        try {
            const names = fs.readdirSync(full, { withFileTypes: true })
                .map((d) => d.name + (d.isDirectory() ? '/' : '')).sort();
            return 'list:' + sha256(names.join('\n'));
        } catch (e) { return 'unreadable:' + (e.code || 'error'); }
    }
    if (st.isDirectory()) return 'dir';
    try { return 'sha256:' + sha256(fs.readFileSync(full)); } catch (e) { return 'unreadable:' + (e.code || 'error'); }
}

// What `require(request)` from parentRel resolves to now, relative to root:
// 'path:<rel>', 'outside:<digest>' or 'unresolved'. rel is parentRel, a
// newline, then the request; an absolute request inside the repository is
// stored as ROOT_TOKEN plus its relative path, because every sweep runs in a
// fresh private worktree. Re-resolving through Node's own resolver is what
// catches a file added beside a requirer that would now win the lookup.
function resolveState(root, rel) {
    const i = rel.indexOf('\n');
    if (i < 0) return 'malformed';
    const Mod = require('module');
    const parentFile = path.join(root, rel.slice(0, i));
    const parent = { id: parentFile, filename: parentFile, paths: Mod._nodeModulePaths(path.dirname(parentFile)) };
    let request = rel.slice(i + 1);
    if (request.startsWith(ROOT_TOKEN)) request = path.join(root, request.slice(ROOT_TOKEN.length));
    // Node caches resolutions per process; this answer must be about the tree now.
    const savedCache = Mod._pathCache;
    let out;
    try {
        Mod._pathCache = Object.create(null);
        out = Mod._resolveFilename(request, parent, false);
    } catch { return 'unresolved'; } finally { Mod._pathCache = savedCache; }
    const r = relUnder(out, rootVariants(root));
    return r !== null ? 'path:' + r : 'outside:' + sha256(fold(path.resolve(out))).slice(0, 16);
}

// The environment a suite runs with, minus what the sweep sets per run, and
// with the source tree's path replaced by a token so two worktrees of one
// repository agree. Returns the digest and a per-name digest for the report.
function envIdentity(env, exclude, rootPaths) {
    const ex = new Set((exclude || []).map((n) => n.toUpperCase()));
    const spellings = [];
    for (const r of rootPaths || []) {
        for (const s of [r, r.replace(/\\/g, '/'), r.replace(/\//g, '\\')]) if (s && !spellings.includes(s)) spellings.push(s);
    }
    spellings.sort((a, b) => b.length - a.length);
    const names = {};
    for (const [k, raw] of Object.entries(env || {})) {
        const name = WIN ? k.toUpperCase() : k;
        if (ex.has(k.toUpperCase())) continue;
        let v = String(raw);
        for (const s of spellings) {
            const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), WIN ? 'gi' : 'g');
            v = v.replace(re, '<root>');
        }
        names[name] = sha256(v).slice(0, 16);
    }
    return { digest: sha256(canonical(names)), names };
}

// The suite's own declarations. `off` makes every pair of the suite
// uncacheable; `native <cmd> [reads <a>, <b>]` declares a native child and the
// repository paths it reads.
function parseDeclarations(text) {
    const out = { off: false, natives: {} };
    for (const m of String(text || '').matchAll(/^\s*\/\/\s*suite-pair-cache:\s*(.+?)\s*$/gm)) {
        const body = m[1];
        if (/^off\b/i.test(body)) { out.off = true; continue; }
        const n = body.match(/^native\s+(\S+)(?:\s+reads\s+(.+))?$/i);
        if (!n) continue;
        const cmd = n[1].toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
        const reads = n[2] ? n[2].split(/[,\s]+/).map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : [];
        out.natives[cmd] = [...new Set((out.natives[cmd] || []).concat(reads))].sort();
    }
    return out;
}

function computeKey(parts) {
    return sha256(canonical(parts));
}

// Each key part's own digest, for the report: two nights' reports differ in
// exactly the part that moved.
function partDigests(parts) {
    const out = {};
    for (const k of Object.keys(parts).sort()) out[k] = sha256(canonical(parts[k])).slice(0, 16);
    return out;
}

// A text-digest index of the repository's tracked files, built once and only
// when a script from outside the repository needs attributing.
function buildTextIndex(root) {
    const idx = new Map();
    const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return null;
    for (const rel of r.stdout.split('\0').filter(Boolean)) {
        let d;
        try { d = trace.textDigest(fs.readFileSync(path.join(root, rel))); } catch { continue; }
        if (!idx.has(d)) idx.set(d, []);
        idx.get(d).push(rel);
    }
    return idx;
}

// Attribute one script's text to the repository: exactly one tracked file with
// that text is an attribution; none or several is not.
function attribute(digest, index) {
    const hits = (index && index.get(digest)) || [];
    if (hits.length === 1) return { rel: hits[0] };
    return { reason: hits.length ? `matches ${hits.length} repository files` : 'matches no repository file' };
}

// Read V8 coverage: the script URLs and the pids that wrote a file.
function readCoverage(dir) {
    const out = { urls: new Set(), pids: new Set(), unreadable: 0, empty: 0 };
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const name of names) {
        const m = name.match(/^coverage-(\d+)-/);
        if (!m) continue;
        out.pids.add(Number(m[1]));
        try {
            const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (!doc || !Array.isArray(doc.result)) { out.unreadable++; continue; }
            // A process that ran anything compiled at least its own file, so
            // coverage naming no file is not coverage of that process.
            let files = 0;
            for (const s of doc.result) {
                if (s && typeof s.url === 'string') { out.urls.add(s.url); if (s.url.startsWith('file:')) files++; }
            }
            if (!files) out.empty++;
        } catch { out.unreadable++; }
    }
    return out;
}

// Turn one traced run into evidence: { cacheable, reasons, deps, natives }.
// deps is a Map of 'kind\0rel' to [kind, rel]; states are taken separately.
function collectEvidence(run, ctx) {
    const reasons = [];
    const deps = new Map();
    const natives = new Set();
    const t = trace.readTraceDir(run.traceDir);
    const cov = readCoverage(run.covDir);
    if (!t.processes.length) reasons.push('no traced process');
    if (t.malformed) reasons.push('trace unreadable');
    if (cov.unreadable) reasons.push('coverage unreadable');
    if (cov.empty) reasons.push('coverage names no script');
    if (t.processes.some((p) => !p.complete)) reasons.push('a traced process did not finish');
    const tracedPids = new Set(t.processes.map((p) => p.pid));
    for (const pid of tracedPids) if (!cov.pids.has(pid)) { reasons.push('coverage missing for a traced process'); break; }
    for (const pid of cov.pids) if (!tracedPids.has(pid)) { reasons.push('a Node process ran without the tracer'); break; }

    const repo = ctx.repoVariants;
    const ignored = [run.tmpRoot, ctx.traceRoot, path.dirname(process.execPath)].filter(Boolean)
        .flatMap((r) => rootVariants(r));
    const nodeDir = rootVariants(path.dirname(process.execPath));
    const preload = fold(path.resolve(ctx.preload));
    const written = new Set();
    const writtenText = new Set();
    const compiled = new Map();
    for (const rec of t.records) {
        if (rec[0] === 'write') { written.add(fold(rec[1])); if (rec[2] && rec[2] !== '-') writtenText.add(rec[2]); }
        else if (rec[0] === 'compile') {
            const k = fold(rec[1]);
            if (!compiled.has(k)) compiled.set(k, new Set());
            compiled.get(k).add(rec[2]);
        } else if (rec[0] === 'native') natives.add(rec[1]);
        else if (rec[0] === 'untraced') reasons.push('a Node child ran without the trace');
    }
    const addDep = (kind, rel, p) => {
        if (rel === '.git' || rel.startsWith('.git/')) { reasons.push('reads git metadata: ' + p); return; }
        deps.set(kind + '\0' + rel, [kind, rel]);
    };

    const scripts = new Set();
    for (const u of cov.urls) {
        if (!u.startsWith('file:')) continue;
        try { scripts.add(require('url').fileURLToPath(u)); } catch { reasons.push('coverage url unreadable'); }
    }
    for (const rec of t.records) if (rec[0] === 'compile') scripts.add(rec[1]);
    for (const p of scripts) {
        if (fold(path.resolve(p)) === preload) continue;
        const rel = relUnder(p, repo);
        if (rel !== null) { addDep('script', rel, p); continue; }
        if (relUnder(p, nodeDir) !== null) continue;         // the runtime's own files
        if (written.has(fold(path.resolve(p)))) continue;   // written by the run itself
        const texts = compiled.get(fold(path.resolve(p)));
        if (!texts) { reasons.push('script outside the repository with no recorded text: ' + p); continue; }
        for (const d of texts) {
            if (writtenText.has(d)) continue;               // its text was written by the run
            if (ctx.textIndex === undefined) ctx.textIndex = buildTextIndex(ctx.sweepRoot);
            const a = attribute(d, ctx.textIndex);
            if (a.rel) addDep('script', a.rel, p);
            else reasons.push(`script outside the repository ${a.reason}: ${p}`);
        }
    }
    for (const rec of t.records) {
        if (!['read', 'stat', 'list'].includes(rec[0])) continue;
        const p = rec[1];
        const rel = relUnder(p, repo);
        if (rel !== null) { addDep(rec[0], rel, p); continue; }
        // Outside the repository and the run's private roots, a read is a
        // reason even when the run wrote that path: the read may have come
        // first, and what it saw is not recorded.
        if (relUnder(p, ignored) !== null) continue;
        reasons.push('reads outside the repository: ' + p);
    }
    // Every require() from a repository file, re-resolved at lookup. One from
    // a script outside the repository is covered by what that script loads.
    for (const rec of t.records) {
        if (rec[0] !== 'resolve') continue;
        const parentRel = relUnder(rec[2], repo);
        if (parentRel === null) continue;
        let request = String(rec[1]);
        if (path.isAbsolute(request)) {
            const inRepo = relUnder(request, repo);
            if (inRepo !== null) request = ROOT_TOKEN + inRepo;
            else if (relUnder(request, ignored) !== null) continue;   // a file this run made: its load is graded above
        }
        addDep('resolve', parentRel + '\n' + request, rec[2]);
    }
    return { cacheable: reasons.length === 0, reasons: [...new Set(reasons)], deps, natives };
}

// [kind, rel, state] for every dependency, sorted, measured now.
function stateList(root, deps) {
    return [...deps.values()].map(([k, r]) => [k, r, fileState(root, k, r)])
        .sort((a, b) => (a[0] + '\0' + a[1] < b[0] + '\0' + b[1] ? -1 : 1));
}

const isDepList = (v) => Array.isArray(v) && v.every((d) => Array.isArray(d) && d.length === 3
    && KINDS.includes(d[0]) && typeof d[1] === 'string' && typeof d[2] === 'string');

// Is this parsed entry well formed for this key? Returns null or the defect.
function entryDefect(entry, key) {
    if (!entry || typeof entry !== 'object') return 'not an object';
    if (entry.schema !== SCHEMA) return 'schema ' + entry.schema;
    if (entry.key !== key) return 'key mismatch';
    if (!OUTCOMES.includes(entry.outcome)) return 'outcome ' + JSON.stringify(entry.outcome);
    if (!entry.deps || !isDepList(entry.deps.baseline) || !isDepList(entry.deps.stub)) return 'dependency list malformed';
    if (!entry.deps.stub.length || !entry.deps.baseline.length) return 'empty dependency list';
    return null;
}

// Does a well-formed entry still hold against the tree at root and the fresh
// baseline? Returns null or the first reason it does not.
function staleness(entry, root, freshBaseline) {
    if (canonical(entry.deps.baseline) !== canonical(freshBaseline)) {
        const was = new Map(entry.deps.baseline.map((d) => [d[0] + ' ' + d[1], d[2]]));
        const now = new Map(freshBaseline.map((d) => [d[0] + ' ' + d[1], d[2]]));
        for (const [k, v] of now) if (was.get(k) !== v) return 'baseline dependency changed: ' + k;
        for (const k of was.keys()) if (!now.has(k)) return 'baseline no longer touches: ' + k;
        return 'baseline dependencies changed';
    }
    for (const [kind, rel, state] of entry.deps.stub) {
        if (fileState(root, kind, rel) !== state) return 'dependency changed: ' + kind + ' ' + rel;
    }
    return null;
}

const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };

// Write text to file through a unique temporary file and a rename, retrying
// the Windows sharing errors a reader or scanner can cause. Never leaves a
// partial entry under the final name. Returns true or the error code.
function writeAtomic(file, text, hooks) {
    const h = hooks || {};
    const rename = h.renameSync || fs.renameSync;
    const tries = h.tries || 6;
    const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    try {
        fs.writeFileSync(tmp, text, { flag: 'wx' });
    } catch (e) { return e.code || 'write-failed'; }
    for (let i = 0; ; i++) {
        try { rename(tmp, file); return true; }
        catch (e) {
            if (i + 1 < tries && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { sleepMs(25 * (2 ** i)); continue; }
            try { fs.unlinkSync(tmp); } catch { /* left as a .tmp-, never read */ }
            return e.code || 'rename-failed';
        }
    }
}

// One sweep's cache. Every method catches its own failures: a cache problem
// becomes a fresh run and a line in the summary, never a thrown error.
function open(opts) {
    const o = opts || {};
    const env = o.env || process.env;
    const log = o.log || ((l) => console.log(l));
    const { mode, source } = resolveMode(o.argv, env);
    const c = {
        mode, source, log, reportFile: reportPath(o.argv, env),
        pairs: [], pending: [], written: 0, writeFailures: [], notice: null, flushed: null,
    };
    if (mode === 'off') return Object.assign(c, inert(c));
    try {
        const id = repoIdentity(o.root);
        if (!id) throw Object.assign(new Error('no repository identity'), { code: 'NO-REPO-ID' });
        c.repoId = id.id;
        c.dir = path.join(cacheBase(env), 'v' + SCHEMA, id.id);
        fs.mkdirSync(c.dir, { recursive: true });
        c.traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adpair'));
    } catch (e) {
        c.notice = `cache unavailable (${e.code || e.message}); every pair runs fresh, untraced`;
        c.mode = 'off';
        return Object.assign(c, inert(c));
    }
    const sweepRoot = o.sweepRoot;
    const ctx = {
        sweepRoot,
        repoVariants: rootVariants(sweepRoot),
        traceRoot: c.traceRoot,
        preload: path.join(sweepRoot, 'tooling', 'suite-pair-trace.js'),
        textIndex: undefined,
    };
    const checker = CHECKER_FILES.map((f) => {
        try { return [f, sha256(fs.readFileSync(path.join(o.checkerDir, f)))]; } catch { return [f, 'absent']; }
    });
    const exclude = (o.excludeEnv || []).concat(['TEMP', 'TMP', 'TMPDIR', 'NODE_V8_COVERAGE',
        trace.TRACE_DIR_ENV, MODE_ENV, DIR_ENV, REPORT_ENV]);
    const envId = envIdentity(o.suiteEnv || {}, exclude, [o.root]);
    const fixed = {
        checker: { files: checker, stub: sha256(String(o.stub || '')) },
        runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
        packages: PACKAGE_FILES.map((f) => [f, fileState(sweepRoot, 'read', f)]),
        env: envId.digest,
    };
    c.envNames = envId.names;
    c.head = o.head || null;
    const declCache = new Map();
    const declarations = (suite) => {
        if (!declCache.has(suite)) {
            let text = '';
            try { text = fs.readFileSync(path.join(sweepRoot, 'tooling', suite), 'utf8'); } catch { /* none */ }
            declCache.set(suite, parseDeclarations(text));
        }
        return declCache.get(suite);
    };

    // The extra environment for one traced run, and its private directories.
    c.beginRun = (baseEnv) => {
        try {
            const dir = fs.mkdtempSync(path.join(c.traceRoot, 'r'));
            const run = { traceDir: path.join(dir, 't'), covDir: path.join(dir, 'c'), dir };
            fs.mkdirSync(run.traceDir);
            fs.mkdirSync(run.covDir);
            const prior = trace.envGet(baseEnv || {}, 'NODE_OPTIONS');
            run.env = {
                NODE_OPTIONS: (prior ? prior + ' ' : '') + '--require "' + ctx.preload.replace(/\\/g, '/') + '"',
                [trace.TRACE_DIR_ENV]: run.traceDir,
                [trace.COVERAGE_ENV]: run.covDir,
            };
            return run;
        } catch { return null; }
    };
    // Evidence from a finished run, then its directories are removed.
    c.endRun = (run, res) => {
        if (!run) return { cacheable: false, reasons: ['trace not started'], deps: new Map(), natives: new Set(), states: [] };
        let ev;
        try {
            run.tmpRoot = res && res.tmpRoot;
            ev = collectEvidence(run, ctx);
            ev.states = stateList(sweepRoot, ev.deps);
        } catch (e) {
            ev = { cacheable: false, reasons: ['evidence unreadable: ' + (e.code || e.message)], deps: new Map(), natives: new Set(), states: [] };
        }
        try { fs.rmSync(run.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ }
        return ev;
    };

    // Look one pair up. base is the fresh baseline's evidence.
    c.pair = (suite, subject, base) => {
        const p = { suite, subject, lookup: 'miss', lookupReason: null, cached: null, fresh: null, agree: null,
            stored: false, cacheable: null, reasons: [] };
        c.pairs.push(p);
        try {
            const decl = declarations(suite);
            const declared = Object.keys(decl.natives).sort()
                .map((cmd) => [cmd, decl.natives[cmd].map((r) => {
                    const st = fileState(sweepRoot, 'read', r);
                    return [r, st === 'dir' ? fileState(sweepRoot, 'list', r) : st];
                })]);
            const parts = Object.assign({
                schema: SCHEMA,
                suite: ['tooling/' + suite, fileState(sweepRoot, 'read', 'tooling/' + suite)],
                subject: [subject, fileState(sweepRoot, 'read', subject)],
                declared,
            }, fixed);
            p.key = computeKey(parts);
            p.parts = partDigests(parts);
            p.file = path.join(c.dir, p.key + '.json');
            p.decl = decl;
            if (decl.off) { p.lookup = 'uncacheable'; p.lookupReason = 'suite declares suite-pair-cache: off'; return p; }
            if (!base || !base.cacheable) {
                p.lookup = 'uncacheable';
                p.lookupReason = 'baseline: ' + ((base && base.reasons[0]) || 'not traced');
                return p;
            }
            let text;
            try { text = fs.readFileSync(p.file, 'utf8'); }
            catch (e) { p.lookupReason = e.code === 'ENOENT' ? 'no entry' : 'unreadable: ' + (e.code || e.message); return p; }
            let entry;
            try { entry = JSON.parse(text); } catch { p.lookup = 'corrupt'; p.lookupReason = 'not JSON'; return p; }
            const defect = entryDefect(entry, p.key);
            if (defect) { p.lookup = 'corrupt'; p.lookupReason = defect; return p; }
            const stale = staleness(entry, sweepRoot, base.states);
            if (stale) { p.lookupReason = stale; return p; }
            p.lookup = 'hit';
            p.cached = entry.outcome;
        } catch (e) {
            p.lookup = 'miss';
            p.lookupReason = 'lookup failed: ' + (e.code || e.message);
        }
        return p;
    };
    // Should this pair be skipped, with this outcome? Only in mode on, only on a hit.
    c.reuse = (p) => (c.mode === 'on' && p && p.lookup === 'hit' ? p.cached : null);

    // Record a fresh run of a pair. restoredClean is false when a restore or
    // install conflicted during it; base and ev are the two runs' evidence.
    c.settle = (p, outcome, base, ev, restoredClean) => {
        try {
            p.fresh = outcome;
            if (p.lookup === 'hit' && outcome !== 'incomplete') p.agree = outcome === p.cached;
            const reasons = [];
            if (outcome === 'incomplete') reasons.push('run incomplete');
            if (!restoredClean) reasons.push('restore conflict');
            if (p.decl && p.decl.off) reasons.push('suite declares suite-pair-cache: off');
            if (!base || !base.cacheable) reasons.push('baseline: ' + ((base && base.reasons[0]) || 'not traced'));
            if (!ev || !ev.cacheable) reasons.push(...((ev && ev.reasons) || ['not traced']));
            const declaredNatives = (p.decl && p.decl.natives) || {};
            for (const n of new Set([...((base && base.natives) || []), ...((ev && ev.natives) || [])])) {
                if (!Object.prototype.hasOwnProperty.call(declaredNatives, n)) reasons.push(`native child ${n} undeclared`);
            }
            if (!p.key) reasons.push('no key');
            p.reasons = [...new Set(reasons)];
            p.cacheable = p.reasons.length === 0;
            if (p.cacheable && ev.states.length && base.states.length) {
                const entry = {
                    schema: SCHEMA, key: p.key, suite: p.suite, subject: p.subject, outcome,
                    deps: { baseline: base.states, stub: ev.states },
                    provenance: { head: c.head, utc: new Date().toISOString(), mode: c.mode, node: process.version },
                };
                c.pending.push({ p, file: p.file, text: JSON.stringify(entry, null, 1) + '\n' });
            } else if (p.cacheable) {
                p.cacheable = false;
                p.reasons.push('no dependencies recorded');
            }
        } catch (e) {
            p.cacheable = false;
            p.reasons = ['settle failed: ' + (e.code || e.message)];
        }
    };

    // Write the queued entries, only when the whole run proved its restores
    // and its source refs.
    c.flush = (runClean) => {
        if (!runClean) { c.flushed = 'withheld: the run had conflicts'; c.pending = []; return; }
        for (const w of c.pending) {
            const r = writeAtomic(w.file, w.text);
            if (r === true) { c.written++; w.p.stored = true; } else c.writeFailures.push(r);
        }
        c.pending = [];
        c.flushed = 'written';
        try { fs.rmSync(c.traceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ }
    };
    c.populations = () => populations(c);
    c.summary = (opts2) => summaryLines(c, opts2);
    c.writeReport = (rows) => writeReport(c, rows);
    return c;
}

// The methods of a cache that does nothing, so the sweep calls one shape.
function inert(c) {
    return {
        beginRun: () => null,
        endRun: () => null,
        pair: () => null,
        reuse: () => null,
        settle: () => {},
        flush: () => {},
        populations: () => populations(c),
        summary: (o) => summaryLines(c, o),
        writeReport: (rows) => writeReport(c, rows),
    };
}

function populations(c) {
    const out = { pairs: c.pairs.length, hit: 0, miss: 0, uncacheable: 0, agreed: 0, disagreed: 0, skipped: 0, reasons: {} };
    for (const p of c.pairs) {
        if (p.lookup === 'hit') {
            out.hit++;
            if (p.fresh === null) out.skipped++;
            if (p.agree === true) out.agreed++;
            if (p.agree === false) out.disagreed++;
        } else if (p.lookup === 'uncacheable' || p.cacheable === false) {
            out.uncacheable++;
            const why = (p.lookup === 'uncacheable' ? p.lookupReason : p.reasons[0]) || 'unknown';
            const bucket = why.replace(/: .*$/, '');
            out.reasons[bucket] = (out.reasons[bucket] || 0) + 1;
        } else out.miss++;
    }
    return out;
}

function summaryLines(c, opts) {
    const o = opts || {};
    if (c.mode === 'off') return ['[pair-cache] off (' + (c.notice || c.source) + '): every pair ran fresh, untraced'];
    const n = populations(c);
    const lines = [];
    lines.push(`[pair-cache] mode ${c.mode} (${c.source}) · ${n.pairs} pair(s): ${n.hit} hit · ${n.miss} miss · `
        + `${n.uncacheable} uncacheable`
        + (c.mode === 'on' ? ` · ${n.skipped} skipped` : ` · shadow: ${n.agreed} of ${n.hit} hit(s) agreed with the fresh run, ${n.disagreed} disagreed`)
        + ` · ${c.written} entr${c.written === 1 ? 'y' : 'ies'} written`
        + (c.writeFailures.length ? ` · ${c.writeFailures.length} write(s) failed (${[...new Set(c.writeFailures)].join(', ')})` : '')
        + (c.flushed && c.flushed !== 'written' ? ` · entries ${c.flushed}` : ''));
    const reasons = Object.entries(n.reasons).sort((a, b) => b[1] - a[1]);
    if (reasons.length) lines.push('[pair-cache] uncacheable by first reason: ' + reasons.map(([k, v]) => `${k} ${v}`).join(' · '));
    for (const p of c.pairs) {
        if (p.agree === false) lines.push(`[pair-cache] DISAGREE ${p.suite} with ${p.subject} stubbed: cache said ${p.cached}, the fresh run said ${p.fresh}`);
        else if (o.verbose) {
            lines.push(`[pair-cache]   ${p.lookup.padEnd(11)} ${p.suite} x ${p.subject}`
                + (p.lookupReason ? ` (${p.lookupReason})` : '')
                + (p.cacheable === false ? ` [not stored: ${p.reasons[0]}]` : ''));
        }
    }
    return lines;
}

// The machine-readable record of this run, for comparing a cached run with an
// uncached one: every pair's lookup, fresh outcome and key parts, and the rows.
function writeReport(c, rows) {
    if (!c.reportFile) return null;
    const doc = {
        schema: SCHEMA, mode: c.mode, source: c.source, repoId: c.repoId || null, head: c.head || null,
        utc: new Date().toISOString(), envNames: c.envNames || null, populations: populations(c),
        pairs: c.pairs.map((p) => ({
            suite: p.suite, subject: p.subject, key: p.key || null, parts: p.parts || null,
            lookup: p.lookup, lookupReason: p.lookupReason, cached: p.cached, fresh: p.fresh, agree: p.agree,
            cacheable: p.cacheable, reasons: p.reasons, stored: p.stored,
        })),
        rows: (rows || []).map((r) => ({ suite: r.suite, status: r.status })),
    };
    const r = writeAtomic(c.reportFile, JSON.stringify(doc, null, 1) + '\n');
    return r === true ? c.reportFile : null;
}

module.exports = {
    SCHEMA, MODE_ENV, DIR_ENV, REPORT_ENV, CHECKER_FILES, canonical, resolveMode, reportPath, cacheBase,
    normalizeOrigin, repoIdentity, rootVariants, relUnder, fileState, envIdentity, parseDeclarations,
    computeKey, partDigests, buildTextIndex, attribute, readCoverage, collectEvidence, stateList,
    entryDefect, staleness, writeAtomic, open, populations, summaryLines,
};

if (require.main === module) {
    console.log('usage: required by tooling/check-suites-can-fail.js; not a command.\n'
        + 'The sweep takes: --cache (reuse valid pairs), --cache-shadow (default: run all, compare),\n'
        + '  --no-cache (off), --cache-report <file> (JSON record of every pair).\n'
        + `Environment: ${MODE_ENV}=on|shadow|off, ${DIR_ENV}=<dir>, ${REPORT_ENV}=<file>.`);
    process.exitCode = 0;
}
