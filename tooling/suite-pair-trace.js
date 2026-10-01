#!/usr/bin/env node
'use strict';
// suite-pair-trace.js - the dependency tracer the check:suites pair cache
// preloads into every suite process it may want to reuse.
//
// WHY. suite-pair-cache.js may skip a stub run only when nothing that run
// depended on has changed. V8 coverage (NODE_V8_COVERAGE) names the scripts a
// process loaded, and nothing else: not the fixture a suite read, not the
// directory it listed to discover its inputs, not the native child it started.
// This preload records those, per process, so an incomplete record can make a
// pair uncacheable instead of making it wrong.
//
// HOW. check-suites-can-fail.js starts a traced run with
//   NODE_OPTIONS="... --require <this file>"  AUTODEV_PAIR_TRACE_DIR=<dir>
// and every Node process that inherits that environment loads this file first.
// It wraps the public fs and child_process entry points, records what each call
// names, and writes one JSON-lines file per process: a `start` line at load and
// the collected records plus an `end` line at exit. A process with a `start`
// and no `end` was killed, and the run's evidence is incomplete.
//
// It never changes what a call does: every wrapper records, then calls the
// original with the same receiver and arguments, and a recording failure is
// swallowed. It prints nothing. The originals it saved write its own file, so
// the tracer never records itself.
//
// Required (not preloaded) it does nothing at all: install() runs only when
// this module is a --require preload (require.main is still undefined then)
// and the trace directory is set.
//
// WHAT IT CANNOT SEE: a native child's reads (it records that a native child
// ran, which makes the pair uncacheable unless the suite declares it), reads
// through internal bindings, and anything a process does after it is killed.
//
//   node tooling/suite-pair-trace.js --help

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRACE_DIR_ENV = 'AUTODEV_PAIR_TRACE_DIR';
const COVERAGE_ENV = 'NODE_V8_COVERAGE';
const INSTALLED = Symbol.for('autodev.suitePairTrace');

// One normalisation for every content digest the cache compares across a
// write, a compile and a repository file: UTF-8 text with a leading BOM
// removed. Module._compile receives the text with its BOM, a writer may or may
// not have written one, and a BOM is not a reason to call two scripts different.
function textDigest(data) {
    let s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// A path argument as an absolute path, or null for a descriptor or anything
// else that names no file.
function asPath(p) {
    try {
        if (typeof p === 'string') return path.resolve(p);
        if (Buffer.isBuffer(p)) return path.resolve(p.toString('utf8'));
        if (p && typeof p === 'object' && p.protocol === 'file:') return require('url').fileURLToPath(p);
    } catch { /* not a path */ }
    return null;
}

// Is this command a Node binary? `node`, `node.exe`, or the running
// executable, quoted or not.
function isNodeCommand(cmd) {
    if (typeof cmd !== 'string' || !cmd) return false;
    const c = cmd.replace(/^"(.*)"$/, '$1');
    const exec = process.execPath;
    if (process.platform === 'win32' ? c.toLowerCase() === exec.toLowerCase() : c === exec) return true;
    return /^node(\.exe)?$/i.test(path.basename(c));
}

// The first word of a shell command, and whether the line does anything a
// single program start does not (pipes, chains, redirects, substitution).
function shellHead(line) {
    const s = String(line || '').trim();
    const m = s.match(/^"([^"]+)"|^(\S+)/);
    return { head: m ? (m[1] || m[2]) : '', compound: /[&|;<>`$]/.test(s) };
}

// Case-insensitive environment lookup, because Windows names are.
function envGet(env, name) {
    if (!env) return undefined;
    if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
    const up = name.toUpperCase();
    for (const k of Object.keys(env)) if (k.toUpperCase() === up) return env[k];
    return undefined;
}

// Does a child started with this environment carry the same trace? The
// preload must be in its NODE_OPTIONS and both private directories must be
// this run's, or the child's work is invisible to this run.
function carriesTrace(env, preload, traceDir, coverageDir) {
    const opts = String(envGet(env, 'NODE_OPTIONS') || '');
    return opts.includes(preload)
        && envGet(env, TRACE_DIR_ENV) === traceDir
        && envGet(env, COVERAGE_ENV) === coverageDir;
}

// Classify one child-process call into a record, or null when the child is a
// traced Node process. `kind` is the child_process function's name.
function classifyChild(kind, args, ctx) {
    let cmd;
    let options;
    let shell = false;
    if (kind === 'fork') {
        cmd = process.execPath;
        options = Array.isArray(args[1]) ? args[2] : args[1];
    } else if (kind === 'exec' || kind === 'execSync') {
        shell = true;
        cmd = args[0];
        options = typeof args[1] === 'object' ? args[1] : undefined;
    } else {
        cmd = args[0];
        options = Array.isArray(args[1]) ? args[2] : args[1];
        if (options && typeof options === 'object' && options.shell) {
            shell = true;
            cmd = [cmd].concat(Array.isArray(args[1]) ? args[1] : []).join(' ');
        }
    }
    const opts = options && typeof options === 'object' ? options : {};
    let program = cmd;
    if (shell) {
        const h = shellHead(cmd);
        if (h.compound) return ['native', 'shell'];
        program = h.head;
    }
    if (!isNodeCommand(program)) {
        const base = path.basename(String(program || '').replace(/^"(.*)"$/, '$1')).toLowerCase()
            .replace(/\.(exe|cmd|bat|com)$/, '');
        return ['native', base || 'unknown'];
    }
    const env = opts.env || process.env;
    return carriesTrace(env, ctx.preload, ctx.traceDir, ctx.coverageDir) ? null : ['untraced', 'node'];
}

function install() {
    if (global[INSTALLED]) return false;
    const traceDir = process.env[TRACE_DIR_ENV];
    if (!traceDir) return false;
    global[INSTALLED] = true;

    const orig = { writeFileSync: fs.writeFileSync, appendFileSync: fs.appendFileSync };
    const ctx = {
        traceDir,
        coverageDir: process.env[COVERAGE_ENV],
        preload: __filename.replace(/\\/g, '/'),
    };
    let threadId = 0;
    try { threadId = require('worker_threads').threadId; } catch { /* none */ }
    const file = path.join(traceDir, `t-${process.pid}-${threadId}-${crypto.randomBytes(4).toString('hex')}.jsonl`);
    const seen = new Set();
    const records = [];
    const add = (rec) => {
        try {
            const k = JSON.stringify(rec);
            if (seen.has(k)) return;
            seen.add(k);
            records.push(k);
        } catch { /* never let recording change the call */ }
    };
    try {
        orig.writeFileSync(file, JSON.stringify(['start', process.pid, threadId]) + '\n');
    } catch {
        return false;   // no record at all: the run's process census will miss it
    }
    process.on('exit', () => {
        try {
            records.push(JSON.stringify(['end']));
            orig.appendFileSync(file, records.join('\n') + '\n');
        } catch { /* the missing end line marks the evidence incomplete */ }
    });

    const wrap = (obj, name, record) => {
        const fn = obj && obj[name];
        if (typeof fn !== 'function') return;
        const wrapped = function (...args) {
            try { record(args); } catch { /* recording never changes the call */ }
            return fn.apply(this, args);
        };
        try {
            Object.defineProperty(wrapped, 'name', { value: fn.name });
            obj[name] = wrapped;
        } catch { /* left unwrapped */ }
    };
    const one = (kind) => (args) => { const p = asPath(args[0]); if (p) add([kind, p]); };
    const written = (args) => {
        const p = asPath(args[0]);
        if (!p) return;
        const d = args[1];
        add(['write', p, (typeof d === 'string' || Buffer.isBuffer(d)) ? textDigest(d) : '-']);
    };
    const copied = (args) => {
        const a = asPath(args[0]);
        const b = asPath(args[1]);
        if (a) add(['read', a]);
        if (b) add(['write', b, '-']);
    };
    const renamed = (args) => { const b = asPath(args[1]); if (b) add(['write', b, '-']); };
    const opened = (args) => {
        const p = asPath(args[0]);
        if (!p) return;
        const flags = args[1];
        const writes = typeof flags === 'string' ? /[wa+]/.test(flags)
            : (typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : false);
        add(writes ? ['write', p, '-'] : ['read', p]);
    };

    for (const target of [fs, fs.promises]) {
        for (const n of ['readFileSync', 'readFile', 'createReadStream']) wrap(target, n, one('read'));
        for (const n of ['existsSync', 'statSync', 'lstatSync', 'accessSync', 'realpathSync',
            'stat', 'lstat', 'access', 'exists', 'realpath']) wrap(target, n, one('stat'));
        for (const n of ['readdirSync', 'readdir', 'opendirSync', 'opendir']) wrap(target, n, one('list'));
        for (const n of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile']) wrap(target, n, written);
        for (const n of ['copyFileSync', 'copyFile', 'cpSync', 'cp']) wrap(target, n, copied);
        for (const n of ['renameSync', 'rename', 'linkSync', 'link']) wrap(target, n, renamed);
        for (const n of ['openSync', 'open']) wrap(target, n, opened);
        wrap(target, 'createWriteStream', (args) => { const p = asPath(args[0]); if (p) add(['write', p, '-']); });
    }

    const cp = require('child_process');
    for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        wrap(cp, n, (args) => { const r = classifyChild(n, args, ctx); if (r) add(r); });
    }

    // Every CommonJS script this process compiles, with the digest of the
    // text it actually ran. That is what lets a script loaded from a temp copy
    // be attributed to the repository file it was copied from.
    const Module = require('module');
    const compile = Module.prototype._compile;
    if (typeof compile === 'function') {
        Module.prototype._compile = function (content, filename, ...rest) {
            try { if (typeof filename === 'string') add(['compile', path.resolve(filename), textDigest(content)]); }
            catch { /* recording never changes the call */ }
            return compile.call(this, content, filename, ...rest);
        };
    }
    return true;
}

// Parse every trace file in a directory: { processes, records, malformed }.
// A process is complete when its file has both a start and an end line.
function readTraceDir(dir) {
    const out = { processes: [], records: [], malformed: 0 };
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const name of names) {
        if (!/^t-\d+-\d+-[0-9a-f]+\.jsonl$/.test(name)) continue;
        let text = '';
        try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { out.malformed++; continue; }
        const proc = { file: name, pid: null, complete: false };
        for (const line of text.split(/\r?\n/)) {
            if (!line) continue;
            let rec;
            try { rec = JSON.parse(line); } catch { out.malformed++; continue; }
            if (!Array.isArray(rec)) { out.malformed++; continue; }
            if (rec[0] === 'start') proc.pid = rec[1];
            else if (rec[0] === 'end') proc.complete = true;
            else out.records.push(rec);
        }
        out.processes.push(proc);
    }
    return out;
}

module.exports = {
    TRACE_DIR_ENV, COVERAGE_ENV, textDigest, asPath, isNodeCommand, shellHead, envGet,
    carriesTrace, classifyChild, install, readTraceDir,
};

if (require.main === undefined) {
    install();
} else if (require.main === module) {
    console.log('usage: node --require tooling/suite-pair-trace.js <script>   (with ' + TRACE_DIR_ENV + '=<dir>)\n'
        + 'The dependency tracer check-suites-can-fail.js preloads into suite runs for its pair cache.\n'
        + 'Run directly it does nothing: it records only when preloaded with the trace directory set.');
    process.exitCode = 0;
}
