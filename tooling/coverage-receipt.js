#!/usr/bin/env node
// coverage-receipt.js - the record a test run leaves behind so the coverage
// gate can grade that run instead of running every suite a second time.
//
// WHY. The gate chain ran every suite twice: once as `npm test`, then again
// under NODE_V8_COVERAGE as `npm run check:coverage`. The second pass is a full
// suite run (hundreds of seconds here) whose only output that the first pass
// lacked was the coverage dumps. So test-all.js now collects coverage in the
// first pass, one directory per suite, and publishes a receipt when the run has
// settled. check:coverage reads the receipt and spawns no test.
//
// A RECEIPT IS A CLAIM, so the reader trusts none of it by default. It names
// the run, the root, the commit, tree and status it graded, a hash of every
// source the census reads, the Node and V8 that ran it, the suites it expected
// and the ones it ran, every outcome, and a manifest of the reduced coverage
// files with their hashes. check() refuses (exit 2 in the gate) on any of:
//   - no receipt (never run, or a killed runner: the old one is unlinked at
//     the start of every run, so a run that never reached publish leaves none);
//   - another root, another Node, another schema;
//   - a stale tree: HEAD, HEAD^{tree}, the porcelain status or any source hash
//     differs from what was graded;
//   - a partial run: the expected suites are not today's suites, or not every
//     expected suite ran;
//   - a red or indeterminate run;
//   - a missing or altered dump, or a suite that left no dump at all.
// Exit 0 from a suite is not evidence that its coverage was collected, and a
// directory existing is not evidence that its contents are this run's.
//
// SIZE. `[measured 2026-10-02]` a raw V8 dump is about 75 KB per process and
// one suite spawned 84 of them (6.3 MB); keeping every raw dump of a full run
// would be on the order of 1.5 GB. Each suite's dumps are therefore reduced as
// soon as it ends to the plugin sources the census attributes, with per
// function hit counts, and the raw files are deleted.
//
// THE STORE lives outside the repo and outside every suite's temp root:
// $AUTODEV_COVERAGE_STORE, else <os.tmpdir()>/autodev-coverage/<hash of the
// canonical root>. The root is canonicalised with realpathSync.native (8.3
// aliases expanded) and lowercased on win32, so two spellings of one checkout
// share a store and two checkouts never do.
//
//   node tooling/coverage-receipt.js --help
//   node tooling/coverage-receipt.js --show [--root DIR]   # print where the receipt is and what it says

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCHEMA = 1;
const RECEIPT = 'receipt.json';
const POOL_FILE = 'test-all-pool.js';
const RUNNER_FILE = 'test-all.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

// --- identity ----------------------------------------------------------------

function canonicalRoot(root) {
    let p = path.resolve(root);
    try { p = fs.realpathSync.native(p); } catch { /* a missing root is reported by its caller */ }
    return process.platform === 'win32' ? p.toLowerCase() : p;
}

function storeDir(root, env) {
    const e = env || process.env;
    if (e.AUTODEV_COVERAGE_STORE) return path.resolve(e.AUTODEV_COVERAGE_STORE);
    return path.join(os.tmpdir(), 'autodev-coverage', sha256(canonicalRoot(root)).slice(0, 16));
}

function nodeIdentity() {
    return { version: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch };
}

// HEAD, HEAD^{tree} and a hash of `git status --porcelain`, or null outside a
// git repo. A repo with no commit yet has a marker HEAD rather than null, so the
// tree check still runs on it.
function treeIdentity(root) {
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    const st = git(['status', '--porcelain']);
    if (st.status !== 0) return null;
    const h = git(['rev-parse', 'HEAD']);
    const t = git(['rev-parse', 'HEAD^{tree}']);
    const lines = (st.stdout || '').split(/\r?\n/).filter(Boolean);
    return {
        head: h.status === 0 ? h.stdout.trim() : '(no commits)',
        tree: t.status === 0 ? t.stdout.trim() : '(no commits)',
        statusHash: sha256(lines.join('\n')),
        status: lines,
    };
}

// The suites test-all.js runs, in its order. One definition, read by the
// runner and by the gate, so the two cannot disagree about what "every suite"
// means. The optional pool module is not a suite.
function discoverSuites(toolingDir) {
    return fs.readdirSync(toolingDir)
        .filter((f) => /^test-.*\.js$/.test(f) && f !== RUNNER_FILE && f !== POOL_FILE)
        .sort();
}
const expectedLabels = (toolingDir) => discoverSuites(toolingDir).map((f) => f.replace(/\.js$/, '')).concat('validate');

// Every file whose bytes can change the census: the plugin sources, the suites,
// validate.js and the runner. Hashed as bytes, never as text, so a CRLF
// checkout is graded as what is on disk.
function walkPlugins(root, onFile) {
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.(js|mjs|cjs)$/.test(e.name)) onFile(full);
        }
    };
    walk(path.join(root, 'plugins'));
}

function sourceHashes(root) {
    const files = [];
    walkPlugins(root, (f) => files.push(f));
    const tooling = path.join(root, 'tooling');
    for (const f of discoverSuites(tooling)) files.push(path.join(tooling, f));
    for (const f of [RUNNER_FILE, 'validate.js']) {
        const p = path.join(tooling, f);
        if (fs.existsSync(p)) files.push(p);
    }
    const map = {};
    for (const f of files.sort()) {
        try { map[posix(path.relative(root, f))] = sha256(fs.readFileSync(f)); } catch { map[posix(path.relative(root, f))] = '(unreadable)'; }
    }
    const digest = sha256(Object.keys(map).sort().map((k) => k + '\0' + map[k]).join('\n'));
    return { digest, count: Object.keys(map).length, files: map };
}

// --- attribution: which dump entries are plugin sources ----------------------
// Shared by the runner's reduction and find-untested-functions.js's fresh
// fold, so a census from a receipt and a census from a fresh run attribute
// the same way by construction.
function attribution(root) {
    const ROOT = path.resolve(root);
    const allSources = new Set();
    const map = new Map();
    const dupes = new Set();
    walkPlugins(ROOT, (full) => {
        allSources.add(path.relative(ROOT, full));
        const b = path.basename(full);
        if (map.has(b)) dupes.add(b); else map.set(b, path.relative(ROOT, full));
    });
    for (const d of dupes) map.delete(d);
    const pluginsDir = path.join(ROOT, 'plugins');
    // V8 emits file:///C:/... on Windows: a leading slash and forward slashes.
    // A copy of a plugin script run from a temp fixture is attributed back by
    // basename, and an ambiguous basename is dropped rather than guessed.
    function attribute(url) {
        if (!url || !url.startsWith('file://')) return null;
        let abs = decodeURIComponent(url.slice('file://'.length));
        if (abs.charAt(0) === '/' && abs.charAt(2) === ':') abs = abs.slice(1);
        abs = path.resolve(abs);
        if (abs.includes('/node_modules/') || abs.includes(path.sep + 'node_modules' + path.sep)) return null;
        if (abs.startsWith(pluginsDir + path.sep)) return path.relative(ROOT, abs);
        return map.get(path.basename(abs)) || null;
    }
    return { root: ROOT, allSources, sourceByBasename: map, attribute };
}

// One V8 dump (parsed) folded into `acc`: { files: { rel: { fnName: maxCount } } }.
// A file with no named function still gets an entry: it RAN, which is a
// different fact from never loaded.
function foldDump(acc, data, attr) {
    for (const script of (data && data.result) || []) {
        const rel = attr.attribute(script.url);
        if (!rel) continue;
        const fns = acc.files[rel] || (acc.files[rel] = {});
        for (const fn of script.functions || []) {
            if (!fn.functionName) continue;
            const count = (fn.ranges && fn.ranges[0] && fn.ranges[0].count) || 0;
            if (!(fn.functionName in fns) || count > fns[fn.functionName]) fns[fn.functionName] = count;
        }
    }
    return acc;
}

// Fold every dump in a directory. Returns { files, dumps, unreadable }.
function foldDir(dir, attr, acc) {
    const out = acc || { files: {}, dumps: 0, unreadable: 0 };
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const f of names) {
        if (!f.endsWith('.json')) continue;
        let data;
        try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { out.unreadable++; continue; }
        out.dumps++;
        foldDump(out, data, attr);
    }
    return out;
}

// Merge a reduced { files } into the census accumulator, max count per function.
function mergeReduced(acc, reduced) {
    for (const [rel, fns] of Object.entries(reduced.files || {})) {
        const into = acc.files[rel] || (acc.files[rel] = {});
        for (const [name, count] of Object.entries(fns)) {
            if (!(name in into) || count > into[name]) into[name] = count;
        }
    }
    return acc;
}

// rmSync retries EBUSY/EPERM itself; a rename on Windows can still meet a
// scanner's handle, so it is retried here.
function renameRetry(from, to) {
    let last;
    for (let i = 0; i < 20; i++) {
        try { fs.renameSync(from, to); return; } catch (e) {
            last = e;
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
    throw last;
}
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* reported by the caller's existence check */ } };

// --- the writer (test-all.js) ------------------------------------------------

// Start a run: unlink the published receipt first, so a runner killed before
// publish leaves no receipt rather than an older one.
function beginRun(root, env) {
    const store = storeDir(root, env);
    fs.mkdirSync(path.join(store, 'runs'), { recursive: true });
    const receiptPath = path.join(store, RECEIPT);
    try { fs.unlinkSync(receiptPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (fs.existsSync(receiptPath)) throw new Error('could not remove the previous receipt at ' + receiptPath);
    const runId = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15) + '-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
    const runDir = path.join(store, 'runs', runId);
    for (const d of ['raw', 'dumps', 'logs']) fs.mkdirSync(path.join(runDir, d), { recursive: true });
    return {
        store, runId, runDir, receiptPath,
        root: canonicalRoot(root),
        startedAt: new Date().toISOString(),
        sourcesStart: sourceHashes(root),
        node: nodeIdentity(),
        attr: attribution(root),
    };
}

// After a suite ends: fold its raw dumps into one reduced file and delete them.
function reduceSuite(run, label) {
    const raw = path.join(run.runDir, 'raw', label);
    const folded = foldDir(raw, run.attr);
    const body = JSON.stringify({ schema: SCHEMA, label, rawDumps: folded.dumps, unreadable: folded.unreadable, files: folded.files });
    const file = path.join('dumps', label + '.json');
    fs.writeFileSync(path.join(run.runDir, file), body);
    rmrf(raw);
    return { label, file: posix(file), sha256: sha256(Buffer.from(body)), rawDumps: folded.dumps, unreadable: folded.unreadable, scripts: Object.keys(folded.files).length };
}

// Publish once everything has settled, red or green: the receipt records what
// happened, and the reader refuses anything but a clean pass.
function publish(run, body) {
    const receipt = Object.assign({
        schema: SCHEMA, runId: run.runId, root: run.root, runDir: run.runDir,
        startedAt: run.startedAt, finishedAt: new Date().toISOString(),
        node: run.node,
    }, body);
    const tmp = run.receiptPath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(receipt, null, 1));
    renameRetry(tmp, run.receiptPath);
    fs.writeFileSync(path.join(run.runDir, 'settled'), run.runId);
    // Older runs go once they have settled. An unsettled one may belong to a
    // runner still going; it is left unless it is a day old (a killed runner).
    let others = [];
    try { others = fs.readdirSync(path.join(run.store, 'runs')); } catch { /* nothing to prune */ }
    for (const id of others) {
        if (id === run.runId) continue;
        const d = path.join(run.store, 'runs', id);
        let old = false;
        try { old = Date.now() - fs.statSync(d).mtimeMs > 24 * 3600 * 1000; } catch { continue; }
        if (fs.existsSync(path.join(d, 'settled')) || old) rmrf(d);
    }
    return receipt;
}

// A run that will not publish (it refused, or --no-receipt) leaves nothing.
function abandon(run) {
    if (run) { try { fs.writeFileSync(path.join(run.runDir, 'settled'), 'abandoned'); } catch { /* best effort */ } }
}

// --- the reader (find-untested-functions.js --gate) --------------------------

// Returns { ok: true, receipt, census } or { ok: false, problem, receipt? }.
// `census` is { files, dumps } merged from every suite's reduced file.
function check(root, env) {
    const store = storeDir(root, env);
    const receiptPath = path.join(store, RECEIPT);
    const fail = (problem, receipt) => ({ ok: false, problem, receiptPath, receipt: receipt || null });
    if (!fs.existsSync(receiptPath)) {
        return fail(`no coverage receipt at ${receiptPath}. Run \`npm test\` on this tree first: it collects coverage and publishes the receipt when it settles. A runner killed mid-run leaves none, by design`);
    }
    let r;
    try { r = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch (e) { return fail(`the receipt at ${receiptPath} does not parse (${e.message})`); }
    if (!r || r.schema !== SCHEMA) return fail(`the receipt has schema ${r && r.schema}, this reader needs ${SCHEMA}`, r);
    const want = canonicalRoot(root);
    if (r.root !== want) return fail(`the receipt is for root ${r.root}, not ${want}`, r);
    const node = nodeIdentity();
    for (const k of Object.keys(node)) {
        if (!r.node || r.node[k] !== node[k]) return fail(`the receipt was made by node ${k} ${r.node && r.node[k]}, this is ${node[k]}`, r);
    }
    // A red or indeterminate run first: it is the most useful thing to say.
    if (r.verdict !== 'pass') {
        const bad = (r.outcomes || []).filter((o) => o.state !== 'pass').map((o) => `${o.label} ${o.state.toUpperCase()}${o.log ? ' (log ' + path.join(r.runDir || '', o.log) + ')' : ''}`);
        if (r.treeInert && r.treeInert.state !== 'pass') bad.push(`tree-inert ${r.treeInert.state.toUpperCase()}`);
        return fail(`the run the receipt records did not pass (${r.verdict}): ${bad.join(', ') || 'no outcome named'}. Coverage of a run that did not pass says nothing`, r);
    }
    // Stale: the tree or any source changed since it was graded.
    const tree = treeIdentity(root);
    if (tree && r.tree && r.tree.after) {
        for (const k of ['head', 'tree', 'statusHash']) {
            if (tree[k] !== r.tree.after[k]) return fail(`stale receipt: ${k} is ${String(tree[k]).slice(0, 12)} now, the run graded ${String(r.tree.after[k]).slice(0, 12)}`, r);
        }
    } else if (tree || (r.tree && r.tree.after)) {
        return fail('stale receipt: one of the receipt and this checkout is a git tree and the other is not', r);
    }
    const src = sourceHashes(root);
    if (!r.sources || r.sources.start !== r.sources.end) return fail('the sources changed while the recorded run was going, so it graded a mixture', r);
    if (src.digest !== r.sources.end) {
        const changed = Object.keys(src.files).filter((k) => (r.sources.files || {})[k] !== src.files[k])
            .concat(Object.keys(r.sources.files || {}).filter((k) => !(k in src.files)));
        return fail(`stale receipt: ${changed.length} source file(s) differ from what the run graded (${changed.slice(0, 5).join(', ')})`, r);
    }
    // Partial: every suite today, every suite expected, every suite ran.
    const today = expectedLabels(path.join(path.resolve(root), 'tooling'));
    const exp = r.expectedSuites || [];
    const ran = r.executedSuites || [];
    const missingToday = today.filter((l) => !exp.includes(l));
    if (missingToday.length || exp.length !== today.length) return fail(`partial receipt: it expected ${exp.length} suite(s), this tree has ${today.length} (${missingToday.slice(0, 5).join(', ') || 'a different set'})`, r);
    const notRun = exp.filter((l) => !ran.includes(l));
    if (notRun.length) return fail(`partial receipt: ${notRun.length} expected suite(s) never ran (${notRun.slice(0, 5).join(', ')})`, r);
    const outcomeLabels = new Set((r.outcomes || []).map((o) => o.label));
    const noOutcome = exp.filter((l) => !outcomeLabels.has(l));
    if (noOutcome.length) return fail(`partial receipt: ${noOutcome.length} suite(s) have no recorded outcome (${noOutcome.slice(0, 5).join(', ')})`, r);
    // The dump manifest: one reduced file per suite, present, unaltered, and
    // made from at least one dump (every suite is a node process that exits).
    const manifest = new Map((r.dumps || []).map((d) => [d.label, d]));
    const acc = { files: {}, dumps: 0 };
    for (const label of exp) {
        const d = manifest.get(label);
        if (!d) return fail(`missing dump: the manifest has no coverage entry for ${label}`, r);
        if (!(d.rawDumps > 0)) return fail(`missing dump: ${label} left ${d.rawDumps} coverage dump(s), so its coverage was never collected`, r);
        const p = path.join(r.runDir || '', d.file);
        let buf;
        try { buf = fs.readFileSync(p); } catch { return fail(`missing dump: ${p} is gone`, r); }
        if (sha256(buf) !== d.sha256) return fail(`altered dump: ${p} does not match the hash in the manifest`, r);
        let reduced;
        try { reduced = JSON.parse(buf.toString('utf8')); } catch { return fail(`altered dump: ${p} does not parse`, r); }
        mergeReduced(acc, reduced);
        acc.dumps += d.rawDumps;
    }
    return { ok: true, receipt: r, receiptPath, census: acc };
}

module.exports = {
    SCHEMA, RECEIPT, POOL_FILE, sha256, canonicalRoot, storeDir, nodeIdentity, treeIdentity,
    discoverSuites, expectedLabels, sourceHashes, attribution, foldDump, foldDir, mergeReduced,
    renameRetry, beginRun, reduceSuite, publish, abandon, check,
};

if (require.main === module) {
    const argv = process.argv.slice(2);
    const usage = 'usage: node tooling/coverage-receipt.js --show [--root DIR]\n'
        + 'Prints where the coverage receipt for DIR (default: this checkout) lives and whether\n'
        + 'check:coverage would accept it. Exit 0 accepted, 2 refused.';
    if (!argv.includes('--show') || argv.includes('--help')) {
        console.log(usage);
    } else {
        const i = argv.indexOf('--root');
        const root = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.resolve(__dirname, '..');
        const c = check(root);
        console.log(`store: ${storeDir(root)}`);
        if (c.ok) {
            console.log(`receipt ${c.receipt.runId}: accepted (${c.receipt.expectedSuites.length} suites, ${c.census.dumps} dump(s), ${Object.keys(c.census.files).length} plugin file(s) loaded)`);
            process.exitCode = 0;
        } else {
            console.log(`refused: ${c.problem}`);
            process.exitCode = 2;
        }
    }
}
