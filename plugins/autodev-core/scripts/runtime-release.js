#!/usr/bin/env node
'use strict';
/**
 * runtime-release.js - pin, launch, back up and restore the operating layer (the Brain clock and
 * the scripts it runs).
 *
 * WHY. A scheduler that ran "the newest script in the plugin cache" could never roll back: an
 * older release stayed active only until any newer cache directory appeared. Here the scheduler
 * runs one launcher, and the launcher runs exactly the release a pointer names, after checking
 * every file of it against the hashes recorded when it was pinned. A newer cache directory is
 * never read.
 *
 * LAYOUT, under <runtime> = AUTODEV_RUNTIME_DIR, else <claude dir>/autodev/runtime:
 *   releases/<version>.json  the manifest: version, root (the scripts folder it runs from),
 *                            stateSchema (brain-clock.js STATE_SCHEMA) and a sha256 per file.
 *   current.json             the pointer: version, the manifest's own sha256, previous version.
 *                            Written by rename, so activation is one atomic switch.
 *   launch.js                a copy of this file from the active release. The scheduler runs it.
 *   backups/<name>/          clock state copies with meta.json (stateSchema, version, hashes).
 * <claude dir> is BRAIN_CLOCK_CLAUDE_DIR, else ~/.claude, the clock's own rule.
 *
 * VERBS. Each prints one JSON line, { ok, value } or { ok: false, error: { code, message } }.
 *   release --from <scripts dir> [--version <v>]
 *       pins a scripts folder (normally the plugin cache copy of a version). The version defaults
 *       to ../.claude-plugin/plugin.json. Re-pinning a version with different bytes is refused.
 *   verify [--version <v>]          rehashes a release (default: the active one).
 *   activate --version <v> [--restore] [--wait-s 60]
 *       verifies the release, takes the clock's lock, backs up the clock state, and switches
 *       current.json. A release whose stateSchema is older than the state's is refused, unless
 *       --restore, which first restores the newest backup that release can read.
 *   rollback [--restore]            activate the previous version.
 *   backup [--wait-s 60]            copies the clock state under the lock.
 *   restore --backup <name|dir> [--wait-s 60]
 *       verifies a backup's hashes and writes its files back under the lock.
 *   run <script.js> [args...]       the launcher: verifies the active release, then runs
 *                                   <root>/<script.js> with the args and returns its exit code.
 *                                   A refusal is one runtime.refused event per distinct reason.
 *   status                          the pointer, the releases and the active release's check.
 *
 * The lock is brain-clock.js's operating lock, taken through its takeLock and dropLock, so no
 * clock pass runs while state is copied, restored or switched.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CLAUDE_DIR = process.env.BRAIN_CLOCK_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const AUTODEV = path.join(CLAUDE_DIR, 'autodev');
const RUNTIME = process.env.AUTODEV_RUNTIME_DIR || path.join(AUTODEV, 'runtime');
const STATE_DIR = path.join(AUTODEV, 'brain-clock');
const EVENTS = path.join(AUTODEV, 'events.jsonl');
const CURRENT = path.join(RUNTIME, 'current.json');
const LAUNCH = path.join(RUNTIME, 'launch.js');
const RELEASES = path.join(RUNTIME, 'releases');
const BACKUPS = path.join(RUNTIME, 'backups');
const LAUNCH_STATE = path.join(RUNTIME, 'launch-state.json');
const KEEP_BACKUPS = 10;
// The scheduler kills a pass after 4 minutes. The launcher stops its child a little before.
const RUN_TIMEOUT_MS = 235 * 1000;
const SCHEMA_RE = /^const STATE_SCHEMA = (\d+);$/m;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

const USAGE = [
    'Usage: node runtime-release.js release --from <scripts dir> [--version <v>]',
    '       node runtime-release.js verify [--version <v>]',
    '       node runtime-release.js activate --version <v> [--restore] [--wait-s 60]',
    '       node runtime-release.js rollback [--restore] [--wait-s 60]',
    '       node runtime-release.js backup [--wait-s 60]',
    '       node runtime-release.js restore --backup <name|dir> [--wait-s 60]',
    '       node runtime-release.js run <script.js> [args...]',
    '       node runtime-release.js status',
    '',
].join('\n');

function fault(code, message) { const e = new Error(message); e.publicCode = code; throw e; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readJsonOr(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}
function writeJson(file, v) { writeAtomic(file, JSON.stringify(v, null, 2) + '\n'); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '').replace(/Z$/, 'Z'); }

// Every regular file under a folder, as forward-slash paths relative to it, sorted.
function listFiles(dir) {
    const out = [];
    (function walk(d, rel) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), r);
            else if (e.isFile()) out.push(r);
        }
    })(dir, '');
    return out.sort();
}
function hashFiles(dir, names) {
    const files = {};
    for (const n of names) files[n] = sha256(fs.readFileSync(path.join(dir, n)));
    return files;
}

// ---------------------------------------------------------------- releases
function manifestPath(version) {
    if (!VERSION_RE.test(String(version))) fault('usage', `a version is x.y.z, not ${version}`);
    return path.join(RELEASES, `${version}.json`);
}
function loadManifest(version) {
    const p = manifestPath(version);
    if (!fs.existsSync(p)) fault('no-release', `release ${version} was never pinned here (no ${p})`);
    const bytes = fs.readFileSync(p);
    let m = null;
    try { m = JSON.parse(bytes.toString('utf8')); } catch { m = null; }
    if (!m || m.version !== version || typeof m.root !== 'string' || !m.files || typeof m.files !== 'object') fault('bad-manifest', `${p} is not a release manifest for ${version}`);
    return { manifest: m, sha: sha256(bytes), file: p };
}
function versionOf(from) {
    const m = readJsonOr(path.join(from, '..', '.claude-plugin', 'plugin.json'), null);
    return m && typeof m.version === 'string' ? m.version : null;
}
function release(opts) {
    if (typeof opts.from !== 'string') fault('usage', 'release needs --from <scripts dir>');
    const root = path.resolve(opts.from);
    for (const f of ['brain-clock.js', 'runtime-release.js', 'ledger-lock.js']) {
        if (!fs.existsSync(path.join(root, f))) fault('not-a-runtime', `${root} has no ${f}, so it cannot run the clock`);
    }
    const version = typeof opts.version === 'string' ? opts.version : versionOf(root);
    if (!version) fault('usage', `no --version and no ../.claude-plugin/plugin.json version beside ${root}`);
    const schema = SCHEMA_RE.exec(fs.readFileSync(path.join(root, 'brain-clock.js'), 'utf8'));
    if (!schema) fault('not-a-runtime', `${root}/brain-clock.js declares no STATE_SCHEMA`);
    const files = hashFiles(root, listFiles(root));
    const p = manifestPath(version);
    const old = readJsonOr(p, null);
    if (old && old.files) {
        // Versions are cache keys: one version never names two trees.
        if (JSON.stringify(old.files) !== JSON.stringify(files) || path.resolve(old.root) !== root) {
            fault('version-reused', `release ${version} is already pinned with other bytes or another root (${old.root}). Pin a new version instead`);
        }
        return { version, root, stateSchema: old.stateSchema, files: Object.keys(files).length, already: true };
    }
    const m = { schema: 1, version, root, stateSchema: Number(schema[1]), pinnedAt: new Date().toISOString(), files };
    writeJson(p, m);
    return { version, root, stateSchema: m.stateSchema, files: Object.keys(files).length, already: false };
}
// Every file of a release against its manifest. A missing, changed or extra file fails it.
function verifyRelease(m) {
    const out = { version: m.version, root: m.root, checked: 0, changed: [], missing: [], extra: [] };
    if (!fs.existsSync(m.root)) { out.missing = Object.keys(m.files); return { ...out, ok: false }; }
    const present = new Set(listFiles(m.root));
    for (const [name, want] of Object.entries(m.files)) {
        if (!present.has(name)) { out.missing.push(name); continue; }
        out.checked++;
        if (sha256(fs.readFileSync(path.join(m.root, name))) !== want) out.changed.push(name);
    }
    for (const name of present) if (!(name in m.files)) out.extra.push(name);
    return { ...out, ok: !out.changed.length && !out.missing.length && !out.extra.length };
}
function verifyText(v) {
    const parts = [];
    if (v.changed.length) parts.push(`changed: ${v.changed.slice(0, 5).join(', ')}`);
    if (v.missing.length) parts.push(`missing: ${v.missing.slice(0, 5).join(', ')}`);
    if (v.extra.length) parts.push(`not pinned: ${v.extra.slice(0, 5).join(', ')}`);
    return `release ${v.version} at ${v.root} does not match its manifest (${parts.join('; ')})`;
}
function current() { return readJsonOr(CURRENT, null); }
function verify(opts) {
    const version = typeof opts.version === 'string' ? opts.version : (current() || {}).version;
    if (!version) fault('no-active-release', `no --version and nothing active (${CURRENT})`);
    const v = verifyRelease(loadManifest(version).manifest);
    if (!v.ok) fault('release-mismatch', verifyText(v));
    return v;
}

// ---------------------------------------------------------------- the lock and the state
// The clock beside this file, or, for launch.js, the active release's. Either names the same lock.
function clockModule() {
    const beside = path.join(__dirname, 'brain-clock.js');
    if (fs.existsSync(beside)) return require(beside);
    const cur = current();
    if (!cur || typeof cur.root !== 'string') fault('no-active-release', `no brain-clock.js beside ${__dirname} and nothing active, so the clock lock cannot be taken`);
    return require(path.join(cur.root, 'brain-clock.js'));
}
function clockLock(opts) {
    const clock = clockModule();
    const waitS = opts['wait-s'] === undefined ? 60 : Number(opts['wait-s']);
    if (!(waitS >= 0)) fault('usage', '--wait-s needs a number of seconds, 0 or more');
    const h = clock.takeLock(Date.now(), { waitMs: waitS * 1000, by: 'runtime-release' });
    if (!h.acquired) fault('lock-held', `the clock lock is held by pid ${h.holder} (${h.by}) and stayed held for ${waitS}s. Nothing changed`);
    return clock;
}
function withLock(opts, fn) {
    const clock = clockLock(opts);
    try { return fn(); } finally { clock.dropLock(); }
}
// The clock state files: everything in the state folder but the lock and staging files.
function stateFiles() {
    if (!fs.existsSync(STATE_DIR)) return [];
    return fs.readdirSync(STATE_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && !/^lock\.json/.test(e.name) && !/\.tmp(-\d+)?$/.test(e.name) && !/\.tmp$/.test(e.name))
        .map((e) => e.name).sort();
}
// The recorded schema of the clock state: null when there is no state, 1 before state-meta.json.
function stateSchema() {
    const names = stateFiles();
    if (!names.length) return null;
    if (!names.includes('state-meta.json')) return 1;
    const m = readJsonOr(path.join(STATE_DIR, 'state-meta.json'), null);
    if (!m || !Number.isInteger(m.schema)) fault('state-unreadable', `${STATE_DIR}/state-meta.json is unreadable, so the state's schema is unknown`);
    return m.schema;
}
function backupNow(reason) {
    const names = stateFiles();
    if (!names.length) return null;
    const schema = stateSchema();
    const cur = current();
    const name = `${stamp()}-s${schema}${cur ? `-v${cur.version}` : ''}`;
    const dir = path.join(BACKUPS, name);
    const tmp = `${dir}.partial`;
    fs.mkdirSync(tmp, { recursive: true });
    for (const n of names) fs.copyFileSync(path.join(STATE_DIR, n), path.join(tmp, n));
    const meta = { at: new Date().toISOString(), reason, version: cur ? cur.version : null, stateSchema: schema, files: hashFiles(tmp, names) };
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    fs.renameSync(tmp, dir);
    pruneBackups();
    return { name, dir, stateSchema: schema, files: names.length };
}
function listBackups() {
    if (!fs.existsSync(BACKUPS)) return [];
    const out = [];
    for (const name of fs.readdirSync(BACKUPS).sort()) {
        if (name.endsWith('.partial')) continue;
        const meta = readJsonOr(path.join(BACKUPS, name, 'meta.json'), null);
        if (meta && meta.files) out.push({ name, dir: path.join(BACKUPS, name), meta });
    }
    return out;
}
// Keeps the newest KEEP_BACKUPS, and always the newest backup of each schema, which a rollback needs.
function pruneBackups() {
    const all = listBackups();
    const keep = new Set(all.slice(-KEEP_BACKUPS).map((b) => b.name));
    const bySchema = new Map();
    for (const b of all) bySchema.set(b.meta.stateSchema, b.name);
    for (const n of bySchema.values()) keep.add(n);
    for (const b of all) if (!keep.has(b.name)) fs.rmSync(b.dir, { recursive: true, force: true });
}
function backupDir(ref) {
    const dir = path.isAbsolute(ref) ? ref : path.join(BACKUPS, ref);
    const meta = readJsonOr(path.join(dir, 'meta.json'), null);
    if (!meta || !meta.files) fault('no-backup', `${dir} is not a clock state backup (no meta.json)`);
    return { dir, meta };
}
// A backup whose files do not match its own meta.json hashes is refused before anything is written.
function verifyBackup(b) {
    const bad = Object.entries(b.meta.files).filter(([n, want]) => !fs.existsSync(path.join(b.dir, n)) || sha256(fs.readFileSync(path.join(b.dir, n))) !== want).map(([n]) => n);
    if (bad.length) fault('backup-corrupt', `backup ${b.dir} does not match its own hashes (${bad.slice(0, 5).join(', ')}). Nothing restored`);
}
// Writes a verified backup's files back and removes state files it does not hold. The lock stays.
function restoreFrom(b) {
    verifyBackup(b);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const names = Object.keys(b.meta.files);
    for (const n of names) writeAtomic(path.join(STATE_DIR, n), fs.readFileSync(path.join(b.dir, n)));
    for (const n of stateFiles()) if (!names.includes(n)) fs.rmSync(path.join(STATE_DIR, n), { force: true });
    return { from: b.dir, stateSchema: b.meta.stateSchema, files: names.length };
}

// ---------------------------------------------------------------- activation
function activate(opts) {
    if (typeof opts.version !== 'string') fault('usage', 'activate needs --version <v>');
    const { manifest: m, sha } = loadManifest(opts.version);
    const v = verifyRelease(m);
    if (!v.ok) fault('release-mismatch', verifyText(v));
    return withLock(opts, () => {
        const cur = current();
        const schema = stateSchema();
        let restored = null;
        if (schema !== null && m.stateSchema < schema) {
            const compat = listBackups().filter((b) => b.meta.stateSchema <= m.stateSchema).pop();
            if (!opts.restore) {
                fault('schema-rollback', `release ${m.version} reads clock state schema ${m.stateSchema}, and the state is schema ${schema}. `
                    + (compat ? `Pass --restore to restore backup ${compat.name} (schema ${compat.meta.stateSchema}) first` : 'No backup it can read exists'));
            }
            if (!compat) fault('no-compatible-backup', `no backup of clock state schema ${m.stateSchema} or older exists, so release ${m.version} cannot run on this state`);
            const backup = backupNow(`before restoring for ${m.version}`);
            restored = { ...restoreFrom(compat), backup: backup && backup.name };
        }
        const backup = restored ? null : backupNow(`before activating ${m.version}`);
        // The launcher first, then the pointer: the pointer is the one switch a pass reads.
        writeAtomic(LAUNCH, fs.readFileSync(path.join(m.root, 'runtime-release.js')));
        const next = { version: m.version, manifestSha256: sha, root: m.root, stateSchema: m.stateSchema, activatedAt: new Date().toISOString(), previous: cur && cur.version !== m.version ? cur.version : (cur && cur.previous) || null };
        writeJson(CURRENT, next);
        return { active: next, backup: backup && backup.name, restored, checked: v.checked };
    });
}
function rollback(opts) {
    const cur = current();
    if (!cur || !cur.previous) fault('no-previous', 'no previous release is recorded, so there is nothing to roll back to');
    return activate({ ...opts, version: cur.previous });
}

// ---------------------------------------------------------------- the launcher
function refuse(code, message) {
    const st = readJsonOr(LAUNCH_STATE, {}) || {};
    const reason = `${code}: ${message}`.slice(0, 400);
    if (st.lastRefusal !== reason) {
        try {
            fs.mkdirSync(AUTODEV, { recursive: true });
            fs.appendFileSync(EVENTS, JSON.stringify({ at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), type: 'runtime.refused', source: 'runtime-release', key: code, detail: { reason } }) + '\n');
            st.lastRefusal = reason;
            writeJson(LAUNCH_STATE, st);
        } catch { /* the refusal still prints */ }
    }
    fault(code, message);
}
function run(argv) {
    const script = argv[0];
    if (!script || !/^[\w.-]+\.js$/.test(script)) fault('usage', 'run needs a script file name, such as brain-clock.js');
    const cur = current();
    if (!cur || typeof cur.version !== 'string') refuse('no-active-release', `nothing is active (${CURRENT}). Run release and activate first`);
    let loaded;
    try { loaded = loadManifest(cur.version); } catch (e) { refuse(e.publicCode || 'bad-manifest', e.message); }
    if (loaded.sha !== cur.manifestSha256) refuse('manifest-changed', `the manifest of ${cur.version} changed after it was activated`);
    const v = verifyRelease(loaded.manifest);
    if (!v.ok) refuse('release-mismatch', verifyText(v));
    if (!(script in loaded.manifest.files)) refuse('not-in-release', `release ${cur.version} has no ${script}`);
    const st = readJsonOr(LAUNCH_STATE, null);
    if (st && st.lastRefusal) { delete st.lastRefusal; writeJson(LAUNCH_STATE, st); }
    const r = spawnSync(process.execPath, [path.join(loaded.manifest.root, script), ...argv.slice(1)], {
        stdio: 'inherit', windowsHide: true, timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, AUTODEV_RUNTIME_RELEASE: cur.version },
    });
    if (r.error) fault('spawn-failed', `${script}: ${r.error.code || r.error.message}`);
    return r.status === null ? 1 : r.status;
}

function status() {
    const cur = current();
    const releases = fs.existsSync(RELEASES) ? fs.readdirSync(RELEASES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : [];
    let check = null;
    if (cur) { try { const v = verifyRelease(loadManifest(cur.version).manifest); check = v.ok ? `PASS ${v.checked} files` : verifyText(v); } catch (e) { check = e.message; } }
    return { runtime: RUNTIME, active: cur, releases, check, stateSchema: stateSchema(), backups: listBackups().map((b) => b.name) };
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
            else { out[a.slice(2)] = next; i++; }
        } else out._.push(a);
    }
    return out;
}
function main(argv) {
    const cmd = argv[0];
    if (!cmd || argv.includes('--help') && cmd !== 'run' || cmd === 'help') { process.stdout.write(USAGE); return 0; }
    try {
        if (cmd === 'run') return run(argv.slice(1));
        const opts = parseArgs(argv.slice(1));
        let value;
        if (cmd === 'release') value = release(opts);
        else if (cmd === 'verify') value = verify(opts);
        else if (cmd === 'activate') value = activate(opts);
        else if (cmd === 'rollback') value = rollback(opts);
        else if (cmd === 'backup') value = withLock(opts, () => backupNow('asked') || fault('no-state', `${STATE_DIR} holds no clock state to back up`));
        else if (cmd === 'restore') {
            if (typeof opts.backup !== 'string') fault('usage', 'restore needs --backup <name|dir>');
            const b = backupDir(opts.backup);
            value = withLock(opts, () => {
                // The state being replaced is kept first, so a restore can itself be undone.
                verifyBackup(b);
                const before = backupNow(`before restoring ${path.basename(b.dir)}`);
                return { ...restoreFrom(b), before: before ? before.name : null };
            });
        } else if (cmd === 'status') value = status();
        else fault('usage', `unknown command ${cmd}\n${USAGE}`);
        process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
        return 0;
    } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: e.publicCode || 'internal', message: String(e.message || e) } }) + '\n');
        return e.publicCode && e.publicCode !== 'usage' ? 1 : 2;
    }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { release, verifyRelease, loadManifest, activate, rollback, backupNow, restoreFrom, listBackups, stateSchema, stateFiles, run, status, main, RUNTIME, CURRENT, LAUNCH };
