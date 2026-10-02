#!/usr/bin/env node
// test-all-pool.js - the optional executor test-all.js loads to run suites
// several at a time. test-all.js owns everything else: discovery, each suite's
// temp root, log, coverage and result record (its runOne), the validator that
// runs after this resolves, the tree check and the verdict. This module decides
// only WHEN each runOne starts.
//
// OFF BY DEFAULT. Without AUTODEV_TEST_POOL, or with a value of 0 or 1, every
// suite runs one at a time in discovery order and prints exactly what the
// serial runner prints. AUTODEV_TEST_POOL=N (2..8) runs at most N suites at
// once; a larger N is held to 8. The pool stays opt-in until ten serial versus
// pooled comparisons on unchanged trees agree on populations, verdicts, tree
// integrity and coverage lists.
//
// WHICH SUITES MAY OVERLAP is a reviewed decision, recorded per suite in
// tooling/suite-isolation.json with the reason and the sha256 of the bytes that
// were reviewed. A suite runs in parallel only when its entry says "parallel"
// AND its bytes still hash to the reviewed value. Anything else runs serial:
// no entry, a changed suite, an unreadable or malformed manifest. A serial suite
// runs ALONE: the pool drains every running suite first, runs it, then resumes.
// That covers both sides of a shared resource: a suite that writes into the
// repo, touches the shared .git, the real profile, a lock or a fixed port never
// overlaps anything, so no reader of those things ever sees it mid-write.
//
// OUTPUT. A parallel suite runs with echo off, and when it ends its whole log
// (test-all.js writes one per suite) is printed under its === header in one
// write, so suites never interleave. With --no-receipt test-all keeps no log,
// so the pool runs everything serially rather than lose a suite's output.
//
// RESULTS come back in discovery order, exactly as runOne made them. Nothing
// resolves before every started suite has settled, because the runner starts
// validate as soon as this resolves. test-all.js refuses any result runOne did
// not produce, any duplicate and any suite left out, so a scheduling defect
// here is a FAIL, never a smaller run.
//
//   node tooling/test-all-pool.js --help
//   node tooling/test-all-pool.js --status   # which suites would run parallel, and why the rest would not
//   node tooling/test-all-pool.js --audit    # the side-effect signals read from each suite's source

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = 'AUTODEV_TEST_POOL';
const MAX_WORKERS = 8;
const MANIFEST_FILE = 'suite-isolation.json';
const SCHEMA = 1;
const TOOLING = __dirname;

// Bytes, never decoded text: *.js is eol=lf in .gitattributes, so a suite
// re-saved with CRLF hashes differently and runs serial until re-reviewed.
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The pool size asked for, never more than MAX_WORKERS. 1 means serial.
function poolSize(env) {
    const raw = (env || {})[ENV];
    if (raw === undefined || raw === '') return { size: 1, warning: null };
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) return { size: 1, warning: `${ENV}=${JSON.stringify(raw)} is not a whole number; running serially` };
    const n = Number(s);
    if (n <= 1) return { size: 1, warning: null };
    if (n > MAX_WORKERS) return { size: MAX_WORKERS, warning: `${ENV}=${n} is above the cap; running at most ${MAX_WORKERS} at once` };
    return { size: n, warning: null };
}

// The reviewed manifest as a Map of suite file -> entry. Never throws: an
// unreadable or malformed manifest is an empty one, which makes every suite
// serial, and the reason comes back for the caller to print.
function loadManifest(file) {
    const suites = new Map();
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return { suites, error: `${path.basename(file)} could not be read (${e.code || e.message}); every suite runs serial` };
    }
    let doc;
    try {
        doc = JSON.parse(text);
    } catch (e) {
        return { suites, error: `${path.basename(file)} is not JSON (${e.message}); every suite runs serial` };
    }
    if (!doc || doc.schema !== SCHEMA || !doc.suites || typeof doc.suites !== 'object' || Array.isArray(doc.suites)) {
        return { suites, error: `${path.basename(file)} is not schema ${SCHEMA} with a suites object; every suite runs serial` };
    }
    const bad = [];
    for (const [name, e] of Object.entries(doc.suites)) {
        const ok = e && (e.isolation === 'parallel' || e.isolation === 'serial')
            && typeof e.reason === 'string' && e.reason.trim() !== ''
            && typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256);
        if (ok) suites.set(name, e);
        else bad.push(name);
    }
    return { suites, error: bad.length ? `${bad.length} malformed entr${bad.length === 1 ? 'y runs' : 'ies run'} serial: ${bad.slice(0, 5).join(', ')}` : null };
}

function hashFile(file) {
    try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

// Each item's mode. Parallel needs a reviewed "parallel" entry whose hash still
// matches the suite's bytes; every other case is serial, with the reason.
function classify(items, manifest, dir) {
    const d = dir || TOOLING;
    return items.map((item) => {
        const file = item.label + '.js';
        const entry = manifest.get(file);
        if (!entry) return { item, mode: 'serial', why: 'unknown', reason: 'not in the manifest' };
        if (entry.isolation !== 'parallel') return { item, mode: 'serial', why: 'reviewed', reason: entry.reason };
        const now = hashFile(path.join(d, file));
        if (now !== entry.sha256) return { item, mode: 'serial', why: 'changed', reason: now ? 'changed since it was reviewed' : 'its file could not be read' };
        return { item, mode: 'parallel', why: 'reviewed', reason: entry.reason };
    });
}

// The directory test-all.js is writing this run's logs into. Its run id carries
// the runner's pid (coverage-receipt.js beginRun), and the pool runs inside the
// runner, so the newest run directory with this pid is this run's.
function findRunDir(env, pid, root) {
    try {
        const receipts = require('./coverage-receipt.js');
        const runs = path.join(receipts.storeDir(root || path.resolve(TOOLING, '..'), env), 'runs');
        const mine = fs.readdirSync(runs).filter((n) => n.includes(`-${pid}-`)).sort();
        return mine.length ? path.join(runs, mine[mine.length - 1]) : null;
    } catch {
        return null;
    }
}

// Print a finished parallel suite's whole log under its header, in one write so
// nothing else lands inside it. Returns false, and says so, when the log could
// not be read or was not printed whole.
function printLog(result, runDir, out, err) {
    const label = result && result.label;
    if (!result || !result.log || !runDir) {
        out(`\n=== ${label} ===\n`);
        err(`[pool] ${label}: no log was kept, so its output is not shown\n`);
        return false;
    }
    let buf;
    try {
        buf = fs.readFileSync(path.join(runDir, result.log));
    } catch (e) {
        out(`\n=== ${label} ===\n`);
        err(`[pool] ${label}: its log could not be read (${e.code || e.message})\n`);
        return false;
    }
    const head = Buffer.from(`\n=== ${label} ===\n`);
    const whole = Buffer.concat([head, buf]);
    const wrote = out(whole);
    if (wrote !== whole.length) {
        err(`[pool] ${label}: printed ${Math.max(0, wrote - head.length)} of ${buf.length} log bytes\n`);
        return false;
    }
    return true;
}

// A writer returns the bytes it was handed, so printLog can tell a whole log
// from a cut one.
const writer = (stream) => (chunk) => {
    stream.write(chunk);
    return Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
};

// runSuites(items, runOne, opts) => results in discovery order.
//   opts.env       environment to read the pool size from (process.env)
//   opts.manifest  manifest path (tooling/suite-isolation.json)
//   opts.dir       directory the suites live in (tooling/)
//   opts.noLogs    true when the runner keeps no logs (--no-receipt)
//   opts.runDir    the run directory holding logs (found from the pid)
//   opts.out/err   writers returning the byte count written, for tests
async function runSuites(items, runOne, opts) {
    const o = opts || {};
    const env = o.env || process.env;
    const out = o.out || writer(process.stdout);
    const err = o.err || writer(process.stderr);
    const list = Array.isArray(items) ? items : [];
    const { size, warning } = poolSize(env);
    if (warning) err(`[pool] ${warning}\n`);
    const noLogs = o.noLogs === undefined ? process.argv.includes('--no-receipt') : o.noLogs;

    // The serial path prints and runs exactly what test-all.js's runSerial does.
    const serially = async () => {
        const res = [];
        for (const item of list) {
            out(`\n=== ${item.label} ===\n`);
            res.push(await runOne(item));
        }
        return res;
    };
    if (size <= 1) return serially();
    if (noLogs) {
        err(`[pool] ${ENV}=${size} ignored: with --no-receipt no suite log is kept to print whole, so suites run serially\n`);
        return serially();
    }

    const loaded = loadManifest(o.manifest || path.join(TOOLING, MANIFEST_FILE));
    if (loaded.error) err(`[pool] ${loaded.error}\n`);
    const planned = classify(list, loaded.suites, o.dir);
    const count = (pred) => planned.filter(pred).length;
    err(`[pool] up to ${size} at once: ${count((p) => p.mode === 'parallel')} parallel, ${count((p) => p.mode === 'serial')} serial `
        + `(${count((p) => p.why === 'unknown')} not in the manifest, ${count((p) => p.why === 'changed')} changed since review)\n`);

    let runDir = o.runDir;
    const byLabel = new Map();
    const store = (label, r) => {
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label).push(r);
    };
    const failures = [];
    const active = new Set();
    let logsWork = true;

    const drain = async () => {
        while (active.size) await Promise.race(active);
    };
    const runAlone = async (item) => {
        out(`\n=== ${item.label} ===\n`);
        try { store(item.label, await runOne(item)); } catch (e) { failures.push(`${item.label}: ${e && e.message}`); }
    };

    for (const p of planned) {
        // Wait for a slot first: a suite that ends while this one waits can
        // turn logsWork off, and the decision below must see that.
        if (p.mode === 'parallel') while (active.size >= size) await Promise.race(active);
        if (p.mode === 'serial' || !logsWork) {
            await drain();
            await runAlone(p.item);
            continue;
        }
        const job = (async () => {
            try {
                const r = await runOne(p.item, { echo: false });
                store(p.item.label, r);
                if (runDir === undefined) runDir = findRunDir(env, process.pid);
                if (!printLog(r, runDir, out, err)) logsWork = false;
            } catch (e) {
                failures.push(`${p.item.label}: ${e && e.message}`);
            }
        })();
        active.add(job);
        job.then(() => active.delete(job));
    }
    await drain();

    if (!logsWork) err('[pool] a suite log could not be printed whole, so the suites after it ran serially\n');
    if (failures.length) err(`[pool] ${failures.length} suite(s) left no result: ${failures.slice(0, 5).join('; ')}\n`);
    const results = [];
    for (const item of list) for (const r of byLabel.get(item.label) || []) results.push(r);
    return results;
}

// ---------------------------------------------------------------------------
// --audit: the side-effect signals in a suite's source. EVIDENCE for a review,
// not the decision: the manifest is the decision. Every signal is a reason a
// suite may not overlap others. A suite with none is a parallel candidate that
// a reviewer still reads, and anything ambiguous stays serial.

// Comments out, string contents kept. Quote-aware, because a glob such as
// 'plugins/*/hooks' inside a string would otherwise open a block comment that
// swallows every line up to the next '*/', and with them the signals.
function stripComments(src) {
    let out = '';
    let i = 0;
    let quote = null;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (quote) {
            out += c;
            if (c === '\\') { out += next === undefined ? '' : next; i += 2; continue; }
            if (c === quote) quote = null;
            else if (c === '\n' && quote !== '`') quote = null;
            i++;
            continue;
        }
        if (c === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end < 0 ? src.length : end + 2;
            out += ' ';
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') quote = c;
        out += c;
        i++;
    }
    return out;
}

const reEscape = (s) => s.replace(/[$]/g, '\\$');

// Identifiers whose value is a path inside the repo: assigned from __dirname,
// process.cwd() or another such identifier, and not from a temp directory.
function anchoredNames(src) {
    const names = new Set();
    const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
    const decls = [];
    let m;
    while ((m = decl.exec(src))) decls.push([m[1], m[2]]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [name, rhs] of decls) {
            if (names.has(name)) continue;
            // A temp path is not the repo, and a file's CONTENT is not a path.
            if (/mkdtemp|tmpdir|createSuiteTmp|readFileSync|JSON\.parse/.test(rhs)) continue;
            const hit = /__dirname|process\.cwd\(\)/.test(rhs) || [...names].some((n) => new RegExp(`(^|[^\\w$.])${reEscape(n)}\\b`).test(rhs));
            if (hit) { names.add(name); grew = true; }
        }
    }
    return names;
}

// The text of a call's arguments, from the open paren to its match.
function callArgs(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
    }
    return src.slice(openIdx + 1);
}

// The first argument of a call, splitting on the first comma at depth 0.
function firstArg(args) {
    let depth = 0;
    for (let i = 0; i < args.length; i++) {
        const c = args[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) return args.slice(0, i);
    }
    return args;
}

const WRITE_CALL = /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|cpSync|symlinkSync|linkSync|truncateSync|utimesSync|writeFile|appendFile|unlink|rename|copyFile)\s*\(/g;
const NESTED = /(test-all\.js|check-suites-can-fail|find-vacuous-assertions|find-untested-functions|coverage-receipt|gate-lock|full-gate-queue|gate-fast)/g;
const MUTATING_GIT = ['init', 'add', 'commit', 'worktree', 'config', 'checkout', 'switch', 'branch', 'stash', 'tag', 'update-ref', 'reset', 'push', 'fetch', 'merge', 'rebase', 'rm', 'mv', 'clone', 'notes', 'gc', 'apply', 'am', 'cherry-pick', 'revert'];

function gitVerbs(code) {
    const verbs = new Set();
    // spawn('git', ['-C', dir, 'verb' ...]) and spawn('git', ['verb' ...])
    const arr = /(['"`])git\1\s*,\s*\[([^\]]*)\]/g;
    let m;
    while ((m = arr.exec(code))) {
        const words = (m[2].match(/['"`]([^'"`]+)['"`]/g) || []).map((w) => w.slice(1, -1));
        const verb = words.find((w, i) => !w.startsWith('-') && !(i > 0 && words[i - 1] === '-C'));
        if (verb) verbs.add(verb);
    }
    // 'git verb ...' inside a string literal
    const str = /['"`]git\s+(?:-C\s+\S+\s+)?(?:-c\s+\S+\s+)*([a-z][\w-]*)/g;
    while ((m = str.exec(code))) verbs.add(m[1]);
    return verbs;
}

function auditSource(src) {
    const code = stripComments(src);
    const signals = [];
    const anchored = anchoredNames(code);
    const hitsAnchor = (text) => /__dirname|process\.cwd\(\)/.test(text)
        || [...anchored].some((n) => new RegExp(`(^|[^\\w$.])${reEscape(n)}\\b`).test(text));
    const writes = new Set();
    let m;
    WRITE_CALL.lastIndex = 0;
    while ((m = WRITE_CALL.exec(code))) {
        if (hitsAnchor(firstArg(callArgs(code, m.index + m[0].length - 1)))) writes.add(m[1]);
    }
    if (writes.size) signals.push(`repo-write: ${[...writes].join(', ')} on a path built from the repo root`);
    const verbs = gitVerbs(code);
    const mutating = [...verbs].filter((v) => MUTATING_GIT.includes(v));
    if (mutating.length) signals.push(`git-write: git ${mutating.join(', ')}${verbs.has('init') ? ' (a fixture repo is initialised; every call must target it)' : ''}`);
    if (/\.listen\(\s*[1-9]|\bport\s*[:=]\s*[1-9]\d{1,4}\b|(127\.0\.0\.1|localhost):[1-9]\d{1,4}/.test(code)) signals.push('fixed-port: a non-zero port literal');
    const overridesProfile = /\b(HOME|USERPROFILE|CLAUDE_CONFIG_DIR)\b\s*[:=][^=]|\[\s*['"](HOME|USERPROFILE|CLAUDE_CONFIG_DIR)['"]\s*\]\s*=[^=]/.test(code);
    if (/homedir\(\)/.test(code) && !overridesProfile) signals.push('profile: reads the home directory without overriding HOME or USERPROFILE');
    if (/\b(spawn|spawnSync|execFileSync|execSync|exec|execFile|fork|spawnSuite|spawnSuiteSync)\s*\(/.test(code) && /['"`/\\]plugins['"`/\\]/.test(code) && !overridesProfile) {
        signals.push('profile: runs plugin code without overriding HOME, USERPROFILE or CLAUDE_CONFIG_DIR');
    } else if (/require\([^)]*plugins/.test(code) && !overridesProfile) {
        signals.push('profile: loads plugin code in-process without overriding the profile');
    }
    const nested = code.match(NESTED);
    if (nested) signals.push(`nested-runner: drives ${[...new Set(nested)].join(', ')}`);
    if (/\b(spawn\w*|exec\w*)\(\s*(['"`])npm(\.cmd)?\2|['"`]npm(\.cmd)?\s+(run|test|install|ci|exec)\b/.test(code)) signals.push('npm: spawns npm');
    return signals;
}

function discover(dir) {
    return require('./coverage-receipt.js').discoverSuites(dir || TOOLING);
}

function main(argv, dir) {
    const args = argv || process.argv.slice(2);
    const d = dir || TOOLING;
    const say = (s) => process.stdout.write(s + '\n');
    if (args.includes('--help') || args.length === 0) {
        say('usage: node tooling/test-all-pool.js --status | --audit');
        say('The optional executor test-all.js loads. Off unless ' + ENV + '=N (2..' + MAX_WORKERS + ').');
        say('--status  each discovered suite: parallel or serial under tooling/' + MANIFEST_FILE + ', and why');
        say('--audit   the side-effect signals read from each suite (evidence for a review, not the decision)');
        return 0;
    }
    const suites = discover(d);
    if (args.includes('--audit')) {
        let flagged = 0;
        for (const f of suites) {
            const s = auditSource(fs.readFileSync(path.join(d, f), 'utf8'));
            if (s.length) flagged++;
            say(`${f}\t${s.length ? s.join(' | ') : '(no signal)'}\t${hashFile(path.join(d, f))}`);
        }
        say(`population: ${suites.length} suites, ${flagged} with a signal, ${suites.length - flagged} without`);
        return 0;
    }
    if (args.includes('--status')) {
        const loaded = loadManifest(path.join(d, MANIFEST_FILE));
        if (loaded.error) say('manifest: ' + loaded.error);
        const planned = classify(suites.map((f) => ({ label: f.replace(/\.js$/, '') })), loaded.suites, d);
        for (const p of planned) say(`${p.mode}\t${p.item.label}\t${p.why}: ${p.reason}`);
        const n = (pred) => planned.filter(pred).length;
        say(`population: ${planned.length} suites, ${n((p) => p.mode === 'parallel')} parallel, ${n((p) => p.mode === 'serial')} serial, `
            + `${n((p) => p.why === 'unknown')} not in the manifest, ${n((p) => p.why === 'changed')} changed since review`);
        return 0;
    }
    process.stderr.write('unknown argument(s): ' + args.join(' ') + '\n');
    return 2;
}

module.exports = {
    ENV, MAX_WORKERS, MANIFEST_FILE, SCHEMA, poolSize, loadManifest, hashFile, classify, findRunDir,
    printLog, runSuites, auditSource, anchoredNames, stripComments, gitVerbs, main,
};

if (require.main === module) process.exitCode = main();
