'use strict';
// Case stop-hook-latency: a Stop hook's cost must not grow with the desktop
// session store.
//
// The failure (usage-mine class hook-timeout/<status>, 214 Stop cancellations
// since 2026-10-08, every one with timedOut true): Claude Code cancels a Stop
// hook that outlives its hooks.json timeout, and what it was meant to say is
// lost. 159 of the 214 were "Checking for unreported work...", which is
// stop-brain-report.js under a 5 s budget.
//
// Measured on this machine on 2026-11-05: its git calls take about 35 ms each.
// The time goes to checkBrainRole, which looks the coordinator up in the
// desktop session store. When the role file's desktop id is in the store, a
// name-only walk finds it in 17 ms. When it is not (a coordinator that
// restarted, or a record that moved), it parses every record: 2,818 files and
// 815 MB, 4.77 s, before the hook has done anything else.
//
// The check is hermetic. It builds a 400-record store in a scratch dir, a
// coordinator role whose desktop id is NOT in it, and a session that committed
// since its last sighting, which is the path that consults the role. A preload
// counts the store records each hook process parses. It also runs every Stop
// hook the tree declares against a 55 MB transcript (the p95 size of the
// transcripts over 5 MB on this machine) and times it.
//
// PASS: no Stop hook parses more than MAX_RECORDS store records, and every hook
// exits within 90% of its timeout. CONTROL: the same run with the coordinator's
// id present must parse at least one record, or the counter is not counting.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const TRANSCRIPT_BYTES = 55 * 1024 * 1024;
const STORE_RECORDS = 400;
const MAX_RECORDS = 5;
const MARGIN = 0.9;
// The 2026-11-05 store: 815 MB over 2,818 records, and a full parse took 4.77 s.
const REAL = { records: 2818, msPerRecord: 4770 / 2818 };

function writeTranscript(file) {
    const fd = fs.openSync(file, 'w');
    const filler = 'x'.repeat(3800);
    let bytes = 0;
    try {
        for (let i = 0; bytes < TRANSCRIPT_BYTES; i++) {
            const u = JSON.stringify({ type: 'user', uuid: `u${i}`, timestamp: '2026-11-05T10:00:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: filler }] } });
            const a = JSON.stringify({ type: 'assistant', uuid: `a${i}`, timestamp: '2026-11-05T10:00:01Z', message: { id: `m${i}`, role: 'assistant', model: 'claude-opus-5-5',
                content: [{ type: 'tool_use', id: `t${i + 1}`, name: 'Bash', input: { command: 'echo ok' } }], usage: { input_tokens: 10, cache_read_input_tokens: 180000, cache_creation_input_tokens: 0, output_tokens: 50 } } });
            const chunk = `${u}\n${a}\n`;
            fs.writeSync(fd, chunk);
            bytes += Buffer.byteLength(chunk);
        }
    } finally {
        fs.closeSync(fd);
    }
    return bytes;
}

/** A synthetic desktop session store: two account dirs, records named local_<uuid>.json. */
function writeStore(dir) {
    const pad = 'y'.repeat(6000);
    for (let i = 0; i < STORE_RECORDS; i++) {
        const sub = path.join(dir, `acct${i % 2}`, 'org');
        fs.mkdirSync(sub, { recursive: true });
        const id = `local_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        fs.writeFileSync(path.join(sub, `${id}.json`), JSON.stringify({ sessionId: id, cliSessionId: `cli-${i}`, isArchived: i % 3 === 0, title: `s${i}`, pad }));
    }
    return `local_00000000-0000-4000-8000-${String(1).padStart(12, '0')}`;
}

/** A preload that counts the store records this process parses, appended to one file per process. */
function writeCounter(dir, store, out) {
    const p = path.join(dir, 'count-store-reads.js');
    fs.writeFileSync(p, [
        "const fs = require('fs'); const path = require('path');",
        `const STORE = ${JSON.stringify(path.resolve(store).toLowerCase())}; const OUT = ${JSON.stringify(out)};`,
        'let n = 0; const orig = fs.readFileSync;',
        'fs.readFileSync = function (f, ...rest) {',
        "  try { if (typeof f === 'string' && path.resolve(f).toLowerCase().startsWith(STORE) && /local_[^\\\\/]*\\.json$/i.test(f)) n++; } catch {}",
        '  return orig.call(this, f, ...rest);',
        '};',
        "process.on('exit', () => { try { fs.appendFileSync(OUT, path.basename(process.argv[1] || '?', '.js') + '\\t' + n + '\\n'); } catch {} });",
    ].join('\n'));
    return p;
}

function check({ repo }) {
    const root = path.join(repo, 'plugins', 'autodev-core');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')); } catch (e) { return { pass: false, indeterminate: true, detail: `cannot read hooks.json: ${e.message}` }; }
    const hooks = [];
    for (const g of (manifest.hooks && manifest.hooks.Stop) || []) for (const h of g.hooks || []) {
        const arg = (h.args || [])[0] || (String(h.command || '').match(/\$\{CLAUDE_PLUGIN_ROOT\}[^\s"']+/) || [])[0];
        if (arg) hooks.push({ script: arg.replace('${CLAUDE_PLUGIN_ROOT}', root), timeout: Number(h.timeout || 60) });
    }
    // Population floor: the 2026-11-05 tree declares 6 Stop hooks, stop-brain-report among them.
    const hasReport = hooks.some((h) => /stop-brain-report/.test(h.script));
    if (hooks.length < 4 || !hasReport) return { pass: false, indeterminate: true, detail: `hooks.json declares ${hooks.length} Stop hooks, stop-brain-report ${hasReport ? 'among them' : 'missing'}: not the manifest this case was written against` };
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-eval-stop-')));
    try {
        const base = { ...process.env, HOME: scratch, USERPROFILE: scratch, APPDATA: path.join(scratch, 'appdata'), CLAUDE_CONFIG_DIR: path.join(scratch, '.claude'), CLAUDE_PLUGIN_ROOT: root, GIT_TERMINAL_PROMPT: '0' };
        delete base.NODE_OPTIONS;
        const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...a], { cwd, env: base, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
        const origin = path.join(scratch, 'origin.git');
        const work = path.join(scratch, 'project');
        g(scratch, 'init', '-q', '--bare', origin);
        g(scratch, 'init', '-q', work);
        fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
        g(work, 'add', 'a.txt');
        g(work, 'commit', '-q', '-m', 'a');
        g(work, 'remote', 'add', 'origin', origin);
        g(work, 'push', '-q', '-u', 'origin', 'main');
        const older = g(work, 'rev-parse', 'HEAD');
        fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
        g(work, 'add', 'b.txt');
        g(work, 'commit', '-q', '-m', 'b');
        const store = path.join(scratch, 'store');
        const presentId = writeStore(store);
        const transcript = path.join(scratch, 'deep.jsonl');
        const bytes = writeTranscript(transcript);
        const ledger = require(path.join(root, 'scripts', 'keyed-ledger.js'));

        const run = (label, desktopId) => {
            const dir = path.join(scratch, label);
            fs.mkdirSync(dir);
            const roleFile = path.join(dir, 'brain-role.json');
            fs.writeFileSync(roleFile, JSON.stringify({ role: 'brain', session_id: 'eval-coordinator', desktop_session_id: desktopId, peer_name: 'brain-eval', cwd: work, claimed_at: new Date(Date.now() - 600e3).toISOString() }));
            // This session was last seen at the older HEAD an hour ago, with no notice since: the path that consults the role.
            const stateFile = path.join(dir, 'brain-report-state.json');
            ledger.write(stateFile, 'eval-stop-latency', { sha: older, at: Date.now() - 3600e3, reportedAt: null });
            const counts = path.join(dir, 'counts.tsv');
            const env = { ...base, NODE_OPTIONS: `--require ${writeCounter(dir, store, counts).replace(/\\/g, '/')}`, CLAUDE_SESSION_STORE: store,
                AUTODEV_SESSIONS_DIR: path.join(dir, 'sessions'), AUTODEV_BRAIN_ROLE_FILE: roleFile, AUTODEV_BRAIN_REPORT_STATE: stateFile, AUTODEV_CONTEXT_NUDGE_STATE_DIR: path.join(dir, 'nudge') };
            const payload = JSON.stringify({ session_id: 'eval-stop-latency', transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false, cwd: work });
            const rows = [];
            for (const h of hooks) {
                if (!fs.existsSync(h.script)) { rows.push({ name: path.basename(h.script), missing: true }); continue; }
                const s = process.hrtime.bigint();
                const r = spawnSync(process.execPath, [h.script], { input: payload, cwd: work, env, encoding: 'utf8', timeout: h.timeout * 1000 * 3, windowsHide: true });
                rows.push({ name: path.basename(h.script, '.js'), ms: Math.round(Number(process.hrtime.bigint() - s) / 1e6), budget: h.timeout * 1000, killed: !!r.error });
            }
            const parsed = {};
            for (const line of (fs.existsSync(counts) ? fs.readFileSync(counts, 'utf8') : '').split('\n').filter(Boolean)) {
                const [name, n] = line.split('\t');
                parsed[name] = (parsed[name] || 0) + Number(n);
            }
            for (const r of rows) r.parsed = parsed[r.name] || 0;
            return rows;
        };

        const control = run('present', presentId);
        const subject = run('stale', 'local_ffffffff-0000-4000-8000-000000000000');
        const missing = subject.filter((r) => r.missing);
        if (missing.length) return { pass: false, indeterminate: true, detail: `hooks.json names scripts that do not exist: ${missing.map((r) => r.name).join(', ')}` };
        if (!control.some((r) => r.parsed >= 1)) return { pass: false, indeterminate: true, detail: 'with the coordinator in the store no hook parsed a store record: the fixture never reached the role lookup, or the counter is not counting' };
        const fmt = (r) => `${r.name} ${r.ms}/${r.budget}ms, ${r.parsed} records`;
        const heavy = subject.filter((r) => r.parsed > MAX_RECORDS);
        const slow = subject.filter((r) => r.killed || r.ms > r.budget * MARGIN);
        const setting = `${STORE_RECORDS}-record store, coordinator id not in it, ${Math.round(bytes / 1048576)} MB transcript`;
        if (heavy.length || slow.length) {
            const why = [
                ...heavy.map((r) => `${r.name} parsed ${r.parsed} of ${STORE_RECORDS} store records (max ${MAX_RECORDS}): on the 2026-11-05 store that is ${(REAL.records * REAL.msPerRecord / 1000).toFixed(1)} s of a ${r.budget / 1000} s budget`),
                ...slow.map((r) => `${r.name} took ${r.ms} of ${r.budget}ms`),
            ];
            return { pass: false, detail: `${why.join('; ')} (${setting})` };
        }
        return { pass: true, detail: `${subject.length} Stop hooks, none parses more than ${MAX_RECORDS} store records or nears its timeout (${setting}): ${subject.map(fmt).join(', ')}` };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

module.exports = { check, TRANSCRIPT_BYTES, STORE_RECORDS, MAX_RECORDS, MARGIN };
