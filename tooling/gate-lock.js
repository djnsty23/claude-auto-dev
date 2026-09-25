#!/usr/bin/env node
/**
 * gate-lock.js - one full gate at a time on a machine, held by a pid every
 * reader can see.
 *
 * WHY. Two full gates at once are where check:suites and the hook-execution
 * suite time out, so sessions sharing a machine take a lock file before
 * `npm run gate`. Until this script the protocol was prose: create the file
 * exclusively, write your pid, treat the lock as stale when that pid is dead.
 * Every session wrote its own copy, and on Windows the copies disagreed about
 * WHICH pid. Git Bash has two pid tables: `$$` is an MSYS pid that `tasklist`
 * and process.kill() cannot see, and /proc/$$/winpid is a Windows pid that
 * `ps -p` cannot see. `[measured 2026-09-24]` a lock carried the MSYS pid of a
 * live gate, a waiter checked it with tasklist, read the holder as dead, and
 * was about 90 s from setting a running gate's lock aside.
 *
 * WHAT IT DOES.
 *   - `run` makes node itself the holder, so line 1 is always process.pid, a
 *     native pid on every platform. The command's pid follows as a `child`
 *     line: a killed wrapper leaves its gate running, and the lock must not
 *     read dead while that gate still loads the machine.
 *   - A pid counts as alive if EITHER table finds it: process.kill(pid, 0),
 *     or `ps -p` on Windows. That keeps locks from older writers readable.
 *     A coincidental match costs a longer wait, a false "dead" costs a
 *     second concurrent gate, so the tie goes to alive.
 *   - It never removes or renames a lock it does not hold. A dead holder is
 *     reported with the command that sets the lock aside, and left in place.
 *
 * Lock file format, compatible with readers that take line 1 as the pid:
 *   <holder pid>
 *   <label>, started HH:MMZ
 *   child <pid>
 *
 * Usage:
 *   node tooling/gate-lock.js run [--lock <file>] [--label <text>] [--wait <min>] [--poll <s>] -- <command...>
 *   node tooling/gate-lock.js status [--lock <file>]
 *
 * The words after `--` are joined with spaces and run by the shell, so quote
 * them as that shell expects. The lock defaults to
 * ~/.claude/autodev/locks/full-gate.lock.
 *
 * Exit codes:
 *   run     the command's exit status once it ran (1 if it died on a signal),
 *           4 held by a live holder, 3 held by a dead holder, 2 undecidable
 *   status  0 free, 4 held, 3 dead holder, 2 undecidable
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_LOCK = path.join(os.homedir(), '.claude', 'autodev', 'locks', 'full-gate.lock');
const EXIT = { free: 0, held: 4, dead: 3, unknown: 2 };

const USAGE = `gate-lock.js - one full gate at a time, held by a pid every reader can see.

  node tooling/gate-lock.js run [--lock <file>] [--label <text>] [--wait <min>] [--poll <s>] -- <command...>
  node tooling/gate-lock.js status [--lock <file>]

run      takes the lock exclusively with node's own pid, runs the command, and
         releases the lock by renaming it to <file>.released-HHMM. --wait keeps
         trying while a live holder has it. Exit: the command's status, or 4 held,
         3 dead holder, 2 undecidable.
status   prints every pid in the lock with what each pid table says.
         Exit: 0 free, 4 held, 3 dead holder, 2 undecidable.

The lock defaults to ${path.join('~', '.claude', 'autodev', 'locks', 'full-gate.lock')}.
A lock this script does not hold is never removed or renamed.`;

/** Every pid a lock file names: line 1, then each `child <pid>` line. */
function pidsIn(text) {
    const lines = text.split(/\r?\n/);
    const pids = [];
    if (/^\d+$/.test(lines[0].trim())) pids.push(Number(lines[0].trim()));
    for (const l of lines.slice(1)) {
        const m = /^child (\d+)$/.exec(l.trim());
        if (m) pids.push(Number(m[1]));
    }
    return pids;
}

/** process.kill(pid, 0): true alive, false gone. EPERM means it exists. */
function nativeAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * `ps -p` in Git Bash's MSYS table: true found, false not found, null when
 * ps cannot be run or answers in a shape this does not recognise.
 */
function msysAlive(pid) {
    const r = spawnSync('ps', ['-p', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    const lines = (r.stdout || '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length || !/\bPID\b/.test(lines[0])) return null;
    // A row can open with a one-letter state column (I, S, O) before the PID.
    const found = lines.slice(1).some((l) => {
        const t = l.trim().split(/\s+/);
        const first = /^[A-Za-z]$/.test(t[0]) ? t[1] : t[0];
        return Number(first) === pid;
    });
    if (r.status === 0 && !found) return null;
    return found;
}

/** What each pid table says about one pid. */
function probe(pid) {
    const tables = { native: nativeAlive(pid) };
    if (process.platform === 'win32') tables.msys = msysAlive(pid);
    return { pid, tables };
}

/** free | held | dead | unknown, with the pids and the text it was read from. */
function inspect(lock) {
    let text;
    try { text = fs.readFileSync(lock, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return { verdict: 'free', probes: [], text: '' };
        return { verdict: 'unknown', probes: [], text: '', why: `cannot read the lock: ${e.code}` };
    }
    const pids = pidsIn(text);
    if (!pids.length) return { verdict: 'unknown', probes: [], text, why: 'line 1 is not a pid' };
    const probes = pids.map(probe);
    if (probes.some((p) => Object.values(p.tables).includes(true))) return { verdict: 'held', probes, text };
    if (probes.some((p) => Object.values(p.tables).includes(null))) {
        return { verdict: 'unknown', probes, text, why: 'no pid was found alive, but a pid table could not be read' };
    }
    return { verdict: 'dead', probes, text };
}

function describe(lock, s) {
    const out = [`lock ${lock}: ${s.verdict.toUpperCase()}`];
    if (s.text) out.push(...s.text.trimEnd().split(/\r?\n/).map((l) => `  | ${l}`));
    for (const p of s.probes) {
        const t = Object.entries(p.tables).map(([k, v]) => `${k} ${v === null ? 'unreadable' : v ? 'alive' : 'gone'}`);
        out.push(`  pid ${p.pid}: ${t.join(', ')}`);
    }
    if (s.why) out.push(`  ${s.why}`);
    if (s.verdict === 'dead') {
        out.push('  Every pid it names is gone from every table. It is left in place. Once you have checked no gate');
        out.push(`  is running, set it aside with: mv "${lock}" "${lock}.stale-${hhmm('')}"`);
    }
    return out.join('\n');
}

function hhmm(sep = ':') {
    const d = new Date();
    return String(d.getUTCHours()).padStart(2, '0') + sep + String(d.getUTCMinutes()).padStart(2, '0');
}

function parseArgs(argv) {
    const cut = argv.indexOf('--');
    const head = cut < 0 ? argv : argv.slice(0, cut);
    const opts = { cmd: head[0], lock: DEFAULT_LOCK, label: 'gate', wait: 0, poll: 30, command: cut < 0 ? [] : argv.slice(cut + 1) };
    for (let i = 1; i < head.length; i++) {
        const v = head[i + 1];
        if (head[i] === '--lock') { opts.lock = path.resolve(v); i++; }
        else if (head[i] === '--label') { opts.label = v; i++; }
        else if (head[i] === '--wait') { opts.wait = Number(v); i++; }
        else if (head[i] === '--poll') { opts.poll = Number(v); i++; }
        else return { error: `unknown argument: ${head[i]}` };
    }
    if (!(opts.wait >= 0) || !(opts.poll > 0)) return { error: '--wait and --poll take a positive number' };
    return opts;
}

/** Creates the lock exclusively. true on success, false when it exists. */
function tryTake(lock, label) {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
    }
    fs.writeSync(fd, `${process.pid}\n${label}, started ${hhmm()}Z\n`);
    fs.closeSync(fd);
    return true;
}

/** Renames the lock aside, only while line 1 is still this process. */
function release(lock) {
    let text;
    try { text = fs.readFileSync(lock, 'utf8'); } catch { return 'the lock was already gone'; }
    if (pidsIn(text)[0] !== process.pid) return 'the lock no longer names this process, so it was left alone';
    let dest = `${lock}.released-${hhmm('')}`;
    if (fs.existsSync(dest)) dest += `-${process.pid}`;
    fs.renameSync(lock, dest);
    return `released to ${path.basename(dest)}`;
}

function run(opts) {
    if (!opts.command.length) {
        console.error('gate-lock: run needs a command after --');
        process.exitCode = 2;
        return;
    }
    const deadline = Date.now() + opts.wait * 60000;
    const attempt = () => {
        if (!tryTake(opts.lock, opts.label)) {
            const s = inspect(opts.lock);
            if (s.verdict === 'free') { setImmediate(attempt); return; }
            if (s.verdict === 'held' && Date.now() < deadline) { setTimeout(attempt, opts.poll * 1000); return; }
            console.error(describe(opts.lock, s));
            process.exitCode = EXIT[s.verdict];
            return;
        }
        const started = Date.now();
        const child = spawn(opts.command.join(' '), { shell: true, stdio: 'inherit', windowsHide: true });
        if (child.pid) fs.appendFileSync(opts.lock, `child ${child.pid}\n`);
        // Ctrl-C reaches the child too. This process stays until the child has
        // gone, so the lock never reads free while the command still runs.
        for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {});
        let done = false;
        child.on('error', (e) => {
            console.error(`gate-lock: the command did not start: ${e.message}`);
            if (child.pid || done) return;
            done = true;
            console.error(`gate-lock: ${release(opts.lock)}`);
            process.exitCode = 1;
        });
        child.on('close', (code, signal) => {
            if (done) return;
            done = true;
            const note = release(opts.lock);
            const secs = Math.round((Date.now() - started) / 1000);
            console.error(`gate-lock: command exit ${code === null ? `signal ${signal}` : code} after ${secs}s, ${note}`);
            process.exitCode = code === null ? 1 : code;
        });
    };
    attempt();
}

function main(argv) {
    // Only this script's own words: a `--help` after `--` belongs to the command.
    const own = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
    if (own.includes('--help') || own.includes('-h') || !argv.length) {
        console.log(USAGE);
        process.exitCode = argv.length ? 0 : 2;
        return;
    }
    const opts = parseArgs(argv);
    if (opts.error) { console.error(`gate-lock: ${opts.error}\n\n${USAGE}`); process.exitCode = 2; return; }
    if (opts.cmd === 'status') {
        const s = inspect(opts.lock);
        console.log(describe(opts.lock, s));
        process.exitCode = EXIT[s.verdict];
    } else if (opts.cmd === 'run') {
        run(opts);
    } else {
        console.error(`gate-lock: unknown command ${opts.cmd}\n\n${USAGE}`);
        process.exitCode = 2;
    }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { pidsIn, inspect, msysAlive, nativeAlive };
