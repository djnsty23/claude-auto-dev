#!/usr/bin/env node
// suite-tmp.js - every suite child gets its own temp root, and loses it on exit.
//
// WHY. `[measured 2026-09-25]` the suites under tooling/test-*.js create their
// fixtures with fs.mkdtempSync(path.join(os.tmpdir(), ...)) and most never
// remove them. The temp directory of the machine that runs the gate most
// gained 62,325 entries in 24 hours, and the disk nearly filled. The same
// debris (198,120 entries) is recorded in
// docs/evidence-check-suites-budget-2026-09-10.md and nobody acted on it,
// because each leak is small and belongs to no one.
//
// Fixing it suite by suite would mean more than a hundred edits and a rule every
// new suite has to remember. The event is "a runner started a suite", and every
// runner goes through here: the suite's child is pointed at a fresh directory
// by TEMP, TMP and TMPDIR (os.tmpdir() reads TEMP then TMP on Windows, TMPDIR on
// POSIX), and that directory is removed when the child ends, whatever its exit
// code, including a timeout kill. A suite that cleans up after itself is
// unaffected. A suite that does not now leaks into a directory that is deleted.
//
// A REMOVAL FAILURE NEVER CHANGES A VERDICT. The suite's exit status is returned
// untouched and the failure is reported on one stderr line naming the path. A
// cleanup step that could turn a green suite red would be read as the suite
// failing, which is the misattribution this repo keeps paying for.
//
// THE DIRECTORY NAME HAS NO DASH, and that is not style. test-drift-audit.js and
// test-memory-audit.js encode fixture paths the way Claude Code encodes a
// project path (every separator becomes '-'), which reverses wrong through any
// directory whose name contains a dash. A sandbox named `autodev-suite-...`
// would sit inside every such path. It is also short, because the sandbox
// lengthens every fixture path under it and Windows MAX_PATH is 260.
//
// The parent is the real os.tmpdir() in the form the runner sees it, never a
// realpath: a suite that compares against realpath(os.tmpdir()) (the macOS
// /var vs /private/var split, the Windows 8.3 short name) sees the same form of
// the same prefix it saw before this existed.
//
// NOT COVERED: a runner killed outright (SIGKILL, a parent's timeout) never
// reaches its cleanup, so the one root in flight at that moment survives. That
// is one directory per kill, against the tens of entries per suite run before.
//
//   node tooling/suite-tmp.js --help
//   node tooling/suite-tmp.js --run tooling/test-a.js [tooling/test-b.js ...] [--timeout MS]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PREFIX = 'adsuite';
const TMP_KEYS = ['TEMP', 'TMP', 'TMPDIR'];

function createSuiteTmp(parent) {
    return fs.mkdtempSync(path.join(parent || os.tmpdir(), PREFIX));
}

// A copy of baseEnv whose temp variables all name dir. Windows env names are
// case-insensitive, and a spread of process.env can carry `Temp` or `tmp`:
// Node keeps only one of two case variants when it builds the child's block,
// so a variant left beside the new key could win and point the child back at
// the shared directory. Every case variant is dropped before the three are set.
function envWithTmp(baseEnv, dir) {
    const env = {};
    for (const [k, v] of Object.entries(baseEnv || {})) {
        if (!TMP_KEYS.includes(k.toUpperCase())) env[k] = v;
    }
    for (const k of TMP_KEYS) env[k] = dir;
    return env;
}

// rmSync retries EBUSY/EPERM/ENOTEMPTY on its own, which covers a Windows
// handle released a moment after the child exits and git's read-only object
// files. The existence check afterwards is the verdict, not the absence of a
// throw.
function removeSuiteTmp(dir, rm) {
    try {
        (rm || fs.rmSync)(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
        return { ok: false, code: e.code || e.message };
    }
    if (fs.existsSync(dir)) return { ok: false, code: 'STILL-PRESENT' };
    return { ok: true };
}

// spawnSync with a private temp root. Returns spawnSync's own result, with
// `tmpRoot` (null when none could be made) and `tmpRemoved` added. Nothing else
// about the result changes, so every caller keeps its own verdict logic.
//
// opts.label names the suite in the one-line reports; opts.parent overrides
// where the root is made; opts.log receives those lines (default stderr);
// opts.rm replaces fs.rmSync, which is how the suite proves a failed removal
// leaves the verdict alone.
function spawnSuiteSync(file, args, options, opts) {
    const o = opts || {};
    const a = args || [];
    const label = o.label || path.basename(String(a.length ? a[a.length - 1] : file));
    const log = o.log || ((line) => process.stderr.write(line + '\n'));
    const base = (options && options.env) || process.env;
    let dir = null;
    try {
        dir = createSuiteTmp(o.parent);
    } catch (e) {
        // A full disk is exactly when this fires. The suite still runs, on the
        // shared temp dir, so its verdict is its own and not this helper's.
        log(`[${label}] temp root not created (${e.code || e.message}); running on the shared temp dir`);
    }
    const env = dir ? envWithTmp(base, dir) : base;
    let res;
    let removed = null;
    try {
        res = spawnSync(file, a, Object.assign({}, options, { env }));
    } finally {
        if (dir) {
            const r = removeSuiteTmp(dir, o.rm);
            removed = r.ok;
            if (!r.ok) log(`[${label}] temp root not removed (${r.code}): ${dir}`);
        }
    }
    res.tmpRoot = dir;
    res.tmpRemoved = removed;
    return res;
}

// The async twin of spawnSuiteSync, for a runner that reads the child's output
// as it arrives (test-all.js tees it to its own stdout and a per-suite log).
// Resolves once the child has closed AND its temp root is gone, never before,
// so a caller that starts the next suite on resolve never overlaps cleanup.
//
// The result has spawnSync's shape: status, signal, error (ETIMEDOUT on a
// timeout kill, the spawn error otherwise), pid, plus tmpRoot and tmpRemoved.
// opts.onStdout / opts.onStderr receive each chunk when that stream is piped.
//
// 'close' waits for every holder of the child's pipes, and a suite that leaves
// a grandchild holding them would hold the runner forever. So after 'exit' the
// pipes get opts.closeGraceMs (default 5000) to drain, then they are destroyed
// and the result says `stdioHeld: true`.
function spawnSuite(file, args, options, opts) {
    const { spawn } = require('child_process');
    const o = opts || {};
    const a = args || [];
    const label = o.label || path.basename(String(a.length ? a[a.length - 1] : file));
    const log = o.log || ((line) => process.stderr.write(line + '\n'));
    const base = (options && options.env) || process.env;
    let dir = null;
    try {
        dir = createSuiteTmp(o.parent);
    } catch (e) {
        log(`[${label}] temp root not created (${e.code || e.message}); running on the shared temp dir`);
    }
    const env = dir ? envWithTmp(base, dir) : base;
    const spawnOpts = Object.assign({}, options, { env });
    const timeout = spawnOpts.timeout;
    delete spawnOpts.timeout;
    const grace = o.closeGraceMs === undefined ? 5000 : o.closeGraceMs;
    return new Promise((resolve) => {
        const res = { status: null, signal: null, error: undefined, pid: undefined, tmpRoot: dir, tmpRemoved: null, stdioHeld: false };
        let settled = false;
        let timer = null;
        let graceTimer = null;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (graceTimer) clearTimeout(graceTimer);
            if (dir) {
                const r = removeSuiteTmp(dir, o.rm);
                res.tmpRemoved = r.ok;
                if (!r.ok) log(`[${label}] temp root not removed (${r.code}): ${dir}`);
            }
            resolve(res);
        };
        let child;
        try {
            child = spawn(file, a, spawnOpts);
        } catch (e) {
            res.error = e;
            finish();
            return;
        }
        res.pid = child.pid;
        if (child.stdout && o.onStdout) child.stdout.on('data', o.onStdout);
        if (child.stderr && o.onStderr) child.stderr.on('data', o.onStderr);
        if (timeout > 0) {
            timer = setTimeout(() => {
                const e = new Error(`spawn ${file} ETIMEDOUT`);
                e.code = 'ETIMEDOUT';
                res.error = e;
                try { child.kill('SIGTERM'); } catch { /* already gone */ }
            }, timeout);
        }
        child.on('error', (e) => {
            if (!res.error) res.error = e;
            // A spawn that never started emits no 'close' on every Node version.
            if (child.pid === undefined) finish();
        });
        child.on('exit', (code, signal) => {
            // Exit settles execution. Pipe holders have a separate drain grace.
            if (timer) clearTimeout(timer);
            res.status = code;
            res.signal = signal;
            graceTimer = setTimeout(() => {
                res.stdioHeld = true;
                for (const s of [child.stdout, child.stderr]) { if (s) s.destroy(); }
                finish();
            }, grace);
        });
        child.on('close', (code, signal) => {
            if (res.status === null && res.signal === null) { res.status = code; res.signal = signal; }
            finish();
        });
    });
}

module.exports = { PREFIX, TMP_KEYS, createSuiteTmp, envWithTmp, removeSuiteTmp, spawnSuiteSync, spawnSuite };

// --- CLI -------------------------------------------------------------------
// This file lives in tooling/ and is not a test-*.js, so check-entrypoints
// probes it with --help and requires it to RETURN. Bare, it prints usage.
//
// --run is the subset runner test-all.js does not have: the named suites, each
// through spawnSuiteSync exactly as the runners call it, one verdict line each.
// Exit 0 when every suite passed, 1 on any failure, 2 when any suite produced
// no verdict (killed, timed out, did not start, or exited 2).
if (require.main === module) {
    const argv = process.argv.slice(2);
    const usage = 'usage: node tooling/suite-tmp.js --run <suite.js> [<suite.js> ...] [--timeout MS]\n'
        + 'Runs each suite with its own temp root (TEMP, TMP, TMPDIR), removed when it ends.';
    const at = argv.indexOf('--run');
    if (at === -1 || argv.includes('--help')) {
        console.log(usage);
        process.exit(0);
    }
    let timeout;
    const files = [];
    for (let i = at + 1; i < argv.length; i++) {
        if (argv[i] === '--timeout') {
            timeout = parseInt(argv[++i], 10);
            if (!(timeout > 0)) { console.error('--timeout needs a positive number of ms'); process.exit(2); }
        } else files.push(argv[i]);
    }
    if (!files.length) { console.error(usage); process.exit(2); }
    let failed = 0;
    let indet = 0;
    for (const f of files) {
        const label = path.basename(f).replace(/\.js$/, '');
        const r = spawnSuiteSync(process.execPath, [path.resolve(f)], { stdio: 'inherit', timeout }, { label });
        let state;
        if (r.error || r.signal || r.status === 2) { state = 'INDET'; indet++; }
        else if (r.status === 0) state = 'PASS ';
        else { state = 'FAIL '; failed++; }
        const why = r.error ? ` (${r.error.code || r.error.message})` : r.signal ? ` (signal ${r.signal})` : '';
        const root = r.tmpRoot === null ? 'not created' : r.tmpRemoved ? 'removed' : 'LEFT';
        console.log(`${state}  ${label}${why}  temp root ${root}`);
    }
    console.log(`${files.length - failed - indet}/${files.length} suites passed`
        + (failed ? `, ${failed} failed` : '') + (indet ? `, ${indet} indeterminate` : ''));
    process.exitCode = indet ? 2 : failed ? 1 : 0;
}
