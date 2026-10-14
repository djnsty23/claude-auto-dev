#!/usr/bin/env node
'use strict';
/**
 * Acceptance suite for runtime-release.js: the operating layer is released, pinned, launched,
 * backed up and restored, and two schedulers never run one pass at once.
 *
 * It builds a fake ~/.claude in a temp dir with plugin cache folders made from copies of the real
 * scripts folder: 1.0.0, 1.1.0 (whose clock state schema is 2) and 99.0.0 (a newer cache folder
 * that must never run). In each copy, brain-judge.js and worker-reconcile.js are fakes that log
 * which release ran them. Every pass goes through runtime/launch.js, as the scheduled task does.
 *
 * Fields:
 *   restore               a backup restores the clock state byte for byte under the lock, into a
 *                         wiped profile and into a clean one, and the next pass is no baseline.
 *                         A corrupt backup is refused and restores nothing.
 *   selected_hash         the launcher runs the pinned release only while every file matches its
 *                         manifest. A changed, extra or missing file, or an edited manifest, is
 *                         refused with one runtime.refused event. A version is never re-pinned.
 *   newer_cache_ignored   a newer cache folder is never run, by the launcher or by the clock.
 *   schema_rollback       a release that writes schema 2 cannot be rolled back over that state
 *                         without --restore. The old clock refuses the newer state and writes
 *                         nothing. With --restore the compatible backup returns and passes work.
 *   duplicate_schedulers  the number of passes that ran their judge while another pass was inside
 *                         its own. Concurrent launches and a held lock must make it 0.
 *
 * Prints one "PASS <name>" or "FAIL <name>" line per check, then exactly
 *   restore=PASS selected_hash=PASS newer_cache_ignored=PASS schema_rollback=PASS duplicate_schedulers=0
 * and sets a nonzero exitCode on any failure.
 * RUNTIME_RESTORE_SCRIPTS names another scripts folder to release (for planted copies).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const SUBJECT = path.resolve(__dirname, '../plugins/autodev-core/scripts/runtime-release.js');
const SOURCE = process.env.RUNTIME_RESTORE_SCRIPTS ? path.resolve(process.env.RUNTIME_RESTORE_SCRIPTS) : path.dirname(SUBJECT);
const CAPS = ['tick', '--observe', '--act', 'mark-dead,settle-finished,settle-unattended,judge', '--live'];

const results = { restore: [], selected_hash: [], newer_cache_ignored: [], schema_rollback: [], duplicate_schedulers: [] };
function check(field, name, ok, detail) {
    results[field].push(!!ok);
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${field}: ${name}${ok ? '' : ': ' + String(detail === undefined ? '' : detail).slice(0, 500)}\n`);
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readJsonl = (p) => (readOr(p) || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// The clock prints one indented JSON document. The launcher and the fakes print one line.
const lastJson = (s) => {
    const t = String(s || '').trim();
    try { return JSON.parse(t); } catch { /* one line of several */ }
    try { return JSON.parse(t.split(/\r?\n/).pop()); } catch { return null; }
};

// ---------------------------------------------------------------- the fakes
// brain-judge.js: logs which release ran it. In slow mode it holds a marker for RR_SLOW_MS and
// records an overlap when another judge already holds it.
const fakeJudge = (v) => `'use strict';
const fs = require('fs');
const env = process.env;
fs.appendFileSync(env.RR_CALLS, JSON.stringify({ v: ${JSON.stringify(v)}, who: 'judge', release: env.AUTODEV_RUNTIME_RELEASE || null }) + '\\n');
if (env.RR_SLOW_MS) {
  let mine = false;
  try { fs.writeFileSync(env.RR_INSIDE, String(process.pid), { flag: 'wx' }); mine = true; } catch { fs.appendFileSync(env.RR_OVERLAP, process.pid + '\\n'); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.RR_SLOW_MS));
  if (mine) fs.unlinkSync(env.RR_INSIDE);
}
process.stdout.write(JSON.stringify({ ok: true, value: { lines: ['judge ${v}'], events: [] } }) + '\\n');
`;
const fakeReconcile = (v) => `'use strict';
const fs = require('fs');
fs.appendFileSync(process.env.RR_CALLS, JSON.stringify({ v: ${JSON.stringify(v)}, who: 'reconcile', release: process.env.AUTODEV_RUNTIME_RELEASE || null }) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, value: { live: process.argv.includes('--live'), outcomes: [], released: [], line: '0 attempts' } }) + '\\n');
`;
// The newer cache folder's clock: it must never run, so running is a marker on disk.
const fakeNewerClock = `'use strict';
require('fs').writeFileSync(process.env.RR_NEWER_MARKER, 'the 99.0.0 clock ran');
process.stdout.write(JSON.stringify({ ok: true, newer: true }) + '\\n');
`;

// ---------------------------------------------------------------- the world
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-restore-'));
const CLAUDE = path.join(ROOT, 'claude');
const AUTODEV = path.join(CLAUDE, 'autodev');
const STATE = path.join(AUTODEV, 'brain-clock');
const RUNTIME = path.join(AUTODEV, 'runtime');
const LAUNCH = path.join(RUNTIME, 'launch.js');
const EVENTS = path.join(AUTODEV, 'events.jsonl');
const CACHE = path.join(CLAUDE, 'plugins', 'cache', 'autodev', 'autodev-core');
const CALLS = path.join(ROOT, 'calls.jsonl');
const NEWER_MARKER = path.join(ROOT, 'newer-ran.txt');
const DESKTOP = path.join(ROOT, 'desktop');

function makeVersion(v, edit) {
    const dir = path.join(CACHE, v, 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    for (const e of fs.readdirSync(SOURCE, { withFileTypes: true })) if (e.isFile()) fs.copyFileSync(path.join(SOURCE, e.name), path.join(dir, e.name));
    fs.writeFileSync(path.join(dir, 'brain-judge.js'), fakeJudge(v));
    fs.writeFileSync(path.join(dir, 'worker-reconcile.js'), fakeReconcile(v));
    if (edit) edit(dir);
    return dir;
}
function baseEnv(claude) {
    const env = Object.assign({}, process.env, {
        BRAIN_CLOCK_CLAUDE_DIR: claude, BRAIN_CLOCK_DESKTOP_DIR: DESKTOP, BRAIN_CLOCK_ROLE_CHECKER: 'off',
        BRAIN_CLOCK_GH_FIXTURE: path.join(ROOT, 'gh.json'), BRAIN_CLOCK_PS: 'off',
        RR_CALLS: CALLS, RR_NEWER_MARKER: NEWER_MARKER,
    });
    for (const k of ['AUTODEV_RUNTIME_DIR', 'AUTODEV_RUNTIME_RELEASE', 'BRAIN_CLOCK_BRAIN_JUDGE', 'BRAIN_CLOCK_WORKER_RECONCILE', 'BRAIN_CLOCK_HEADLESS_WORKER', 'BRAIN_CLOCK_UNATTENDED_WORKER', 'CLAUDE_CONFIG_DIR']) delete env[k];
    return env;
}
const ENV = baseEnv(CLAUDE);
function node(script, argv, env) {
    const r = spawnSync(process.execPath, [script, ...argv], { env: env || ENV, encoding: 'utf8', timeout: 240000, windowsHide: true });
    return { code: r.status, json: lastJson(r.stdout), out: `${r.stdout}${r.stderr}` };
}
const rr = (v, argv, env) => node(path.join(CACHE, v, 'scripts', 'runtime-release.js'), argv, env);
const pass = (env) => node(LAUNCH, ['run', 'brain-clock.js', ...CAPS], env);
const calls = () => readJsonl(CALLS);
const events = () => readJsonl(EVENTS);
// Every clock state file with its digest, the lock aside.
function stateHashes(dir) {
    const out = {};
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir).sort()) if (!/^lock\.json/.test(f) && fs.statSync(path.join(dir, f)).isFile()) out[f] = sha(fs.readFileSync(path.join(dir, f)));
    return out;
}
const J = (x) => JSON.stringify(x);

// A process that holds the clock lock until its stdin closes.
async function holdLock(env, clockFile) {
    const helper = path.join(ROOT, 'hold-lock.js');
    fs.writeFileSync(helper, [
        "const c = require(process.argv[2]);",
        "const r = c.takeLock(Date.now(), { by: 'test-holder' });",
        "process.stdout.write(JSON.stringify({ pid: process.pid, acquired: r.acquired }) + '\\n');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => { c.dropLock(); });",
    ].join('\n'));
    const h = spawn(process.execPath, [helper, clockFile], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const first = await new Promise((resolve) => {
        let buf = '';
        const t = setTimeout(() => resolve(null), 15000);
        h.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) { clearTimeout(t); resolve(buf.split('\n')[0]); } });
    });
    let info = null;
    try { info = JSON.parse(first); } catch { info = null; }
    return { info, release: () => new Promise((resolve) => { h.stdin.end(); if (h.exitCode !== null) resolve(); else h.on('exit', resolve); }) };
}

async function main() {
    fs.writeFileSync(path.join(ROOT, 'gh.json'), J({ open: {}, view: {} }));
    fs.mkdirSync(path.join(DESKTOP, 'claude-code-sessions', 'acct', 'org'), { recursive: true });
    fs.writeFileSync(path.join(DESKTOP, 'claude-code-sessions', 'acct', 'org', 'scheduled-tasks.json'), J({ scheduledTasks: [] }));
    fs.mkdirSync(AUTODEV, { recursive: true });
    fs.writeFileSync(path.join(AUTODEV, 'headless-workers.json'), J({ version: 1, records: [] }));
    fs.writeFileSync(path.join(AUTODEV, 'unattended-workers.json'), J({ version: 1, records: [] }));
    fs.writeFileSync(path.join(AUTODEV, 'bg-runner.json'), J({ version: 1, workers: [] }));
    fs.mkdirSync(path.join(AUTODEV, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(AUTODEV, 'inbox'), { recursive: true });
    const v1 = makeVersion('1.0.0');
    makeVersion('1.1.0', (dir) => {
        const p = path.join(dir, 'brain-clock.js');
        const src = fs.readFileSync(p, 'utf8');
        if (src.split('const STATE_SCHEMA = 1;').length !== 2) throw new Error('brain-clock.js has no single "const STATE_SCHEMA = 1;" line to raise');
        fs.writeFileSync(p, src.replace('const STATE_SCHEMA = 1;', () => 'const STATE_SCHEMA = 2;'));
    });

    // ------------------------------------------------------------ release, activate, the pinned pass
    const rel = rr('1.0.0', ['release', '--from', v1, '--version', '1.0.0']);
    const act = rr('1.0.0', ['activate', '--version', '1.0.0', '--wait-s', '5']);
    const cur0 = readJson(path.join(RUNTIME, 'current.json'));
    check('selected_hash', 'release pins every file of 1.0.0 by sha256, and activate points current.json at its manifest', rel.code === 0 && rel.json && rel.json.ok && rel.json.value.files === fs.readdirSync(v1).length
        && act.code === 0 && cur0 && cur0.version === '1.0.0' && cur0.manifestSha256 === sha(fs.readFileSync(path.join(RUNTIME, 'releases', '1.0.0.json'))) && fs.existsSync(LAUNCH), rel.out + act.out);
    const p1 = pass();
    const c1 = calls();
    const meta1 = readJson(path.join(STATE, 'state-meta.json'));
    check('selected_hash', 'an untampered release runs through the launcher, reconcile then judge, both from 1.0.0', p1.code === 0 && p1.json && p1.json.ok && J(c1.map((c) => `${c.who} ${c.v} ${c.release}`)) === J(['reconcile 1.0.0 1.0.0', 'judge 1.0.0 1.0.0']), p1.out + J(c1));
    check('schema_rollback', 'a pass records state schema 1, written by the pinned release', meta1 && meta1.schema === 1 && meta1.writtenBy === '1.0.0', J(meta1));

    // ------------------------------------------------------------ selected_hash: tampering is refused
    {
        const judge = path.join(v1, 'brain-judge.js');
        const good = fs.readFileSync(judge);
        const n0 = calls().length;
        fs.appendFileSync(judge, '\n// tampered\n');
        const t1 = pass();
        const t2 = pass();
        const refused = events().filter((e) => e.type === 'runtime.refused');
        check('selected_hash', 'a changed file is refused, names the file, and runs nothing', t1.code !== 0 && t1.json && t1.json.ok === false && t1.json.error.code === 'release-mismatch' && /changed: brain-judge\.js/.test(t1.json.error.message) && calls().length === n0, t1.out);
        check('selected_hash', 'a repeated refusal is one runtime.refused event', t2.code !== 0 && refused.length === 1 && refused[0].key === 'release-mismatch', J(refused));
        fs.writeFileSync(judge, good);
        const ok = pass();
        check('selected_hash', 'the restored bytes run again', ok.code === 0 && ok.json && ok.json.ok && calls().length === n0 + 2, ok.out);

        const extra = path.join(v1, 'planted-extra.js');
        fs.writeFileSync(extra, '// not pinned\n');
        const e1 = pass();
        fs.rmSync(extra);
        check('selected_hash', 'a file the manifest does not pin is refused', e1.code !== 0 && e1.json && e1.json.error && /not pinned: planted-extra\.js/.test(e1.json.error.message), e1.out);

        const gone = path.join(v1, 'worker-reconcile.js');
        const goneBytes = fs.readFileSync(gone);
        fs.rmSync(gone);
        const g1 = pass();
        fs.writeFileSync(gone, goneBytes);
        check('selected_hash', 'a missing file is refused', g1.code !== 0 && g1.json && g1.json.error && /missing: worker-reconcile\.js/.test(g1.json.error.message), g1.out);

        const mf = path.join(RUNTIME, 'releases', '1.0.0.json');
        const mBytes = fs.readFileSync(mf);
        const m = JSON.parse(mBytes.toString('utf8'));
        m.files['brain-judge.js'] = sha('other bytes');
        fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
        const m1 = pass();
        fs.writeFileSync(mf, mBytes);
        check('selected_hash', 'an edited manifest is refused', m1.code !== 0 && m1.json && m1.json.error && m1.json.error.code === 'manifest-changed', m1.out);

        fs.appendFileSync(judge, '\n// other bytes\n');
        const again = rr('1.0.0', ['release', '--from', v1, '--version', '1.0.0']);
        fs.writeFileSync(judge, good);
        check('selected_hash', 'one version is never pinned to two trees', again.code !== 0 && again.json && again.json.error && again.json.error.code === 'version-reused', again.out);
        const v = rr('1.0.0', ['verify']);
        check('selected_hash', 'verify reads the active release back as matching', v.code === 0 && v.json && v.json.ok && v.json.value.checked === fs.readdirSync(v1).length, v.out);
    }

    // ------------------------------------------------------------ selected_hash: the shipped file itself
    // The checks above run copies. These run the repo's runtime-release.js in its own claude dir.
    {
        const claude3 = path.join(ROOT, 'claude-shipped');
        const env3 = baseEnv(claude3);
        const pkg = path.join(ROOT, 'shipped', 'autodev-core');
        const scripts = path.join(pkg, 'scripts');
        fs.mkdirSync(scripts, { recursive: true });
        fs.mkdirSync(path.join(pkg, '.claude-plugin'), { recursive: true });
        for (const e of fs.readdirSync(SOURCE, { withFileTypes: true })) if (e.isFile()) fs.copyFileSync(path.join(SOURCE, e.name), path.join(scripts, e.name));
        fs.writeFileSync(path.join(pkg, '.claude-plugin', 'plugin.json'), J({ name: 'autodev-core', version: '2.0.0' }));
        const shipped = (argv) => node(SUBJECT, argv, env3);
        const none = shipped(['run', 'brain-clock.js', '--help']);
        const ev3 = readJsonl(path.join(claude3, 'autodev', 'events.jsonl'));
        check('selected_hash', 'the shipped launcher refuses with nothing active, as one runtime.refused event', none.code !== 0 && none.json && none.json.error && none.json.error.code === 'no-active-release' && ev3.length === 1 && ev3[0].type === 'runtime.refused', none.out + J(ev3));
        const rel3 = shipped(['release', '--from', scripts]);
        const act3 = shipped(['activate', '--version', '2.0.0', '--wait-s', '5']);
        check('selected_hash', 'release with no --version reads the version from the plugin manifest beside the scripts', rel3.code === 0 && rel3.json && rel3.json.value.version === '2.0.0' && act3.code === 0, rel3.out + act3.out);
        const target = path.join(scripts, 'board-sync.js');
        const good = fs.readFileSync(target);
        fs.appendFileSync(target, '\n// tampered\n');
        const ver3 = shipped(['verify']);
        const run3 = shipped(['run', 'brain-clock.js', '--help']);
        fs.writeFileSync(target, good);
        check('selected_hash', 'the shipped verify and run both name the changed file', ver3.code !== 0 && ver3.json && /changed: board-sync\.js/.test(ver3.json.error.message) && run3.code !== 0 && run3.json && run3.json.error.code === 'release-mismatch', ver3.out + run3.out);
        const ok3 = shipped(['run', 'brain-clock.js', '--help']);
        check('selected_hash', 'the shipped launcher runs the restored release', ok3.code === 0, ok3.out);
    }

    // ------------------------------------------------------------ newer_cache_ignored
    {
        makeVersion('99.0.0', (dir) => fs.writeFileSync(path.join(dir, 'brain-clock.js'), fakeNewerClock));
        const n0 = calls().length;
        const p = pass();
        const after = calls().slice(n0);
        check('newer_cache_ignored', 'the launcher runs the pinned 1.0.0, never the newer 99.0.0 folder', p.code === 0 && p.json && p.json.ok && !fs.existsSync(NEWER_MARKER) && after.length === 2 && after.every((c) => c.v === '1.0.0'), p.out + J(after));
        const d = node(path.join(v1, 'brain-clock.js'), CAPS);
        const direct = calls().slice(n0 + 2);
        check('newer_cache_ignored', 'the 1.0.0 clock run directly takes its helpers from beside itself, not the newest cache folder', d.code === 0 && direct.length === 2 && direct.every((c) => c.v === '1.0.0' && c.release === null) && !fs.existsSync(NEWER_MARKER), d.out + J(direct));
        const st = rr('1.0.0', ['status']);
        check('newer_cache_ignored', 'status still names 1.0.0 as active', st.code === 0 && st.json && st.json.value.active.version === '1.0.0' && /^PASS /.test(st.json.value.check), st.out);
        fs.rmSync(path.join(CACHE, '99.0.0'), { recursive: true, force: true });
    }

    // ------------------------------------------------------------ restore
    {
        pass();
        const want = stateHashes(STATE);
        const b = rr('1.0.0', ['backup', '--wait-s', '5']);
        const name = b.json && b.json.value && b.json.value.name;
        check('restore', 'backup copies every state file with its hashes', b.code === 0 && name && J(readJson(path.join(RUNTIME, 'backups', name, 'meta.json')).files) === J(want) && Object.keys(want).includes('snapshot.json'), b.out + J(want));
        fs.rmSync(STATE, { recursive: true, force: true });
        const r = rr('1.0.0', ['restore', '--backup', name, '--wait-s', '5']);
        check('restore', 'a wiped state is restored byte for byte', r.code === 0 && J(stateHashes(STATE)) === J(want), r.out + J(stateHashes(STATE)));
        const e0 = events().length;
        const p = pass();
        const fresh = events().slice(e0);
        check('restore', 'the next pass reads the restored snapshot, so it is no baseline', p.code === 0 && p.json && p.json.ok && !fresh.some((e) => e.type === 'clock.baseline'), p.out + J(fresh.map((e) => e.type)));

        // A corrupt backup restores nothing.
        const bad = path.join(RUNTIME, 'backups', name, 'snapshot.json');
        const badBytes = fs.readFileSync(bad);
        fs.appendFileSync(bad, ' ');
        const before = stateHashes(STATE);
        const c = rr('1.0.0', ['restore', '--backup', name, '--wait-s', '5']);
        fs.writeFileSync(bad, badBytes);
        check('restore', 'a backup that fails its own hashes is refused and restores nothing', c.code !== 0 && c.json && c.json.error && c.json.error.code === 'backup-corrupt' && J(stateHashes(STATE)) === J(before), c.out);

        // A clean profile: another claude dir, restored from the backup folder by path.
        const claude2 = path.join(ROOT, 'claude-clean');
        const env2 = baseEnv(claude2);
        const r2 = rr('1.0.0', ['restore', '--backup', path.join(RUNTIME, 'backups', name), '--wait-s', '5'], env2);
        check('restore', 'a clean profile is restored from a backup folder by path', r2.code === 0 && J(stateHashes(path.join(claude2, 'autodev', 'brain-clock'))) === J(want), r2.out);
    }

    // ------------------------------------------------------------ schema_rollback
    {
        const v11 = path.join(CACHE, '1.1.0', 'scripts');
        const rel11 = rr('1.1.0', ['release', '--from', v11, '--version', '1.1.0']);
        const act11 = rr('1.1.0', ['activate', '--version', '1.1.0', '--wait-s', '5']);
        const p = pass();
        const meta = readJson(path.join(STATE, 'state-meta.json'));
        check('schema_rollback', '1.1.0 activates and its pass records state schema 2', rel11.code === 0 && rel11.json.value.stateSchema === 2 && act11.code === 0 && act11.json.value.backup && p.code === 0 && meta && meta.schema === 2 && meta.writtenBy === '1.1.0', rel11.out + act11.out + p.out + J(meta));
        const cur = readOr(path.join(RUNTIME, 'current.json'));
        const state = stateHashes(STATE);
        const back = rr('1.0.0', ['activate', '--version', '1.0.0', '--wait-s', '5']);
        check('schema_rollback', 'activating 1.0.0 over schema 2 state is refused and changes nothing', back.code !== 0 && back.json && back.json.error.code === 'schema-rollback' && /--restore/.test(back.json.error.message) && readOr(path.join(RUNTIME, 'current.json')) === cur && J(stateHashes(STATE)) === J(state), back.out);
        const e0 = events().length;
        const old = node(path.join(CACHE, '1.0.0', 'scripts', 'brain-clock.js'), CAPS);
        check('schema_rollback', 'the 1.0.0 clock run on schema 2 state refuses its pass and writes nothing', old.code !== 0 && old.json && old.json.refused === 'state-schema' && old.json.stateSchema === 2 && J(stateHashes(STATE)) === J(state) && events().length === e0, old.out);
        const rb = rr('1.1.0', ['rollback', '--restore', '--wait-s', '5']);
        const cur2 = readJson(path.join(RUNTIME, 'current.json'));
        const meta2 = readJson(path.join(STATE, 'state-meta.json'));
        check('schema_rollback', 'rollback --restore restores the newest schema 1 backup and activates 1.0.0', rb.code === 0 && rb.json.value.restored && rb.json.value.restored.stateSchema === 1 && cur2 && cur2.version === '1.0.0' && cur2.previous === '1.1.0' && meta2 && meta2.schema === 1, rb.out + J(meta2));
        const n0 = calls().length;
        const p2 = pass();
        check('schema_rollback', 'after the rollback the 1.0.0 pass runs on the restored state', p2.code === 0 && p2.json && p2.json.ok && !p2.json.refused && calls().slice(n0).every((c) => c.v === '1.0.0') && calls().length === n0 + 2, p2.out);
        const leftovers = fs.readdirSync(RUNTIME).filter((f) => /\.tmp$|\.partial$/.test(f)).concat(fs.readdirSync(path.join(RUNTIME, 'backups')).filter((f) => f.endsWith('.partial')));
        check('schema_rollback', 'activation leaves no staging files behind (current.json is switched by rename)', leftovers.length === 0, J(leftovers));
    }

    // ------------------------------------------------------------ duplicate_schedulers
    let overlaps = null;
    {
        const overlapFile = path.join(ROOT, 'overlap.txt');
        const env = Object.assign({}, ENV, { RR_SLOW_MS: '1500', RR_INSIDE: path.join(ROOT, 'inside.txt'), RR_OVERLAP: overlapFile });
        const n0 = calls().filter((c) => c.who === 'judge').length;
        const N = 4;
        const outs = await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
            const ch = spawn(process.execPath, [LAUNCH, 'run', 'brain-clock.js', ...CAPS], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            let out = '';
            ch.stdout.on('data', (d) => { out += d; });
            ch.stderr.on('data', (d) => { out += d; });
            ch.on('exit', (code) => resolve({ code, json: lastJson(out), out }));
        })));
        const judged = calls().filter((c) => c.who === 'judge').length - n0;
        const skipped = outs.filter((o) => o.json && o.json.skipped === true).length;
        overlaps = (readOr(overlapFile) || '').split('\n').filter(Boolean).length;
        check('duplicate_schedulers', `${N} concurrent launches: every pass that is not skipped runs alone`, overlaps === 0 && judged >= 1 && judged + skipped === N && outs.every((o) => o.code === 0), J(outs.map((o) => o.out.slice(0, 200))) + ` judged ${judged} skipped ${skipped} overlaps ${overlaps}`);
        check('duplicate_schedulers', 'at least one concurrent launch found the lock held and skipped', skipped >= 1, `skipped ${skipped}`);

        const clockFile = path.join(CACHE, '1.0.0', 'scripts', 'brain-clock.js');
        const h = await holdLock(ENV, clockFile);
        const j0 = calls().length;
        const held = pass();
        const a = rr('1.0.0', ['backup', '--wait-s', '0']);
        await h.release();
        check('duplicate_schedulers', 'while another process holds the lock a pass skips and runs nothing', h.info && h.info.acquired && held.code === 0 && held.json && held.json.skipped === true && calls().length === j0, held.out);
        check('duplicate_schedulers', 'while the lock is held backup, restore and activate refuse rather than wait it out', a.code !== 0 && a.json && a.json.error.code === 'lock-held' && !fs.existsSync(path.join(STATE, 'lock.json')), a.out);
    }

    const field = (k) => (results[k].length && results[k].every(Boolean) ? 'PASS' : 'FAIL');
    const dup = overlaps === null ? 'UNKNOWN' : results.duplicate_schedulers.every(Boolean) ? String(overlaps) : String(overlaps || 'FAIL');
    process.stdout.write(`restore=${field('restore')} selected_hash=${field('selected_hash')} newer_cache_ignored=${field('newer_cache_ignored')} schema_rollback=${field('schema_rollback')} duplicate_schedulers=${dup}\n`);
    return Object.values(results).every((r) => r.length && r.every(Boolean)) && overlaps === 0;
}

(async () => {
    try { process.exitCode = (await main()) ? 0 : 1; } catch (e) {
        process.stdout.write(`FAIL suite crashed: ${e && e.stack}\n`);
        process.exitCode = 1;
    } finally {
        fs.rmSync(ROOT, { recursive: true, force: true });
    }
})();
