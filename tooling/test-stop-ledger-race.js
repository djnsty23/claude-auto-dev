#!/usr/bin/env node
// Suite for the Stop-hook ledgers under CONCURRENT Stops.
//
// `[measured 2026-09-22]` 20 concurrent stop-brain-report runs against a
// 200-entry ledger left 1 of 220 entries. Each run read the whole shared JSON,
// added its own key and wrote the whole file back, so the last writer won and
// every other session's entry, old and new, was gone. A fleet ends turns
// together more often than not, so this is the normal case, not a corner.
//
// Two layers, both driven as real concurrent PROCESSES, because a race does not
// reproduce inside one event loop:
//   1. the hook itself, 20 at once over a seeded ledger, counting survivors;
//   2. scripts/keyed-ledger.js directly, 40 writers at once, plus the rule that
//      a ledger which cannot be parsed is never written over.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'plugins', 'autodev-core', 'hooks', 'stop-brain-report.js');
const LEDGER = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'keyed-ledger.js');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
}

function runAsync(args, { input, env, cwd } = {}) {
    return new Promise((resolve) => {
        const c = spawn(process.execPath, args, { env: Object.assign({}, process.env, env || {}), cwd, windowsHide: true });
        let out = '';
        let err = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { err += d; });
        c.on('close', (status) => resolve({ out, err, status }));
        c.stdin.end(input || '');
    });
}

/** Every entry the ledger holds, however it is stored: the legacy file and the per-key directory. */
function entriesOf(stateFile) {
    try {
        return require(LEDGER).readAll(stateFile);
    } catch {
        // Before keyed-ledger.js existed the ledger was the one file.
        try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
    }
}

async function hookRace() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'slr-repo-'));
    const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'probe@local');
    git('config', 'user.name', 'probe');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'v1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'v1');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slr-state-'));
    const role = path.join(tmp, 'brain-role.json');
    fs.writeFileSync(role, JSON.stringify({ session_id: 'brain-1' }));
    const state = path.join(tmp, 'state.json');
    const seeded = {};
    const now = Date.now();
    for (let i = 0; i < 200; i++) seeded['old-' + i] = { sha: 'a'.repeat(40), at: now - 60000, reportedAt: null };
    fs.writeFileSync(state, JSON.stringify(seeded, null, 2) + '\n');

    const env = { AUTODEV_BRAIN_ROLE_FILE: role, AUTODEV_BRAIN_REPORT_STATE: state };
    const runs = [];
    for (let i = 0; i < 20; i++) {
        runs.push(runAsync([HOOK], { input: JSON.stringify({ session_id: 'new-' + i, cwd: repo }), env }));
    }
    const results = await Promise.all(runs);
    check('hook race: all 20 concurrent Stops exit 0 and stay silent (first sighting)',
        results.every((r) => r.status === 0 && r.out === '' && r.err === ''),
        results.filter((r) => r.status !== 0 || r.out || r.err).length + ' misbehaved');

    const after = entriesOf(state);
    const olds = Object.keys(after).filter((k) => k.startsWith('old-')).length;
    const news = Object.keys(after).filter((k) => k.startsWith('new-')).length;
    check('hook race: the 200 seeded entries survive 20 concurrent Stops', olds === 200, olds + ' of 200');
    check('hook race: every one of the 20 new sessions recorded its baseline', news === 20, news + ' of 20');
}

async function moduleRace() {
    let ledger;
    try {
        ledger = require(LEDGER);
    } catch {
        check('keyed-ledger.js exists', false, 'module missing');
        return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slr-mod-'));
    const file = path.join(tmp, 'ledger.json');
    const script = path.join(tmp, 'writer.js');
    fs.writeFileSync(script,
        'const l = require(' + JSON.stringify(LEDGER) + ');\n'
        + 'const k = process.argv[2];\n'
        + 'for (let i = 0; i < 5; i++) l.write(' + JSON.stringify(file) + ', k, { n: i, at: Date.now() });\n');
    const keys = [];
    for (let i = 0; i < 40; i++) keys.push('sess:' + i + '/with:odd\\chars');
    await Promise.all(keys.map((k) => runAsync([script, k])));
    const all = ledger.readAll(file);
    const got = keys.filter((k) => all[k] && all[k].n === 4).length;
    check('module race: 40 concurrent writers x 5 writes each, every key holds its last value', got === 40, got + ' of 40');
    const stray = fs.readdirSync(ledger.dirFor(file)).filter((n) => !n.endsWith('.json'));
    check('module race: no tmp file is left behind', stray.length === 0, stray.join(',') || 'none');

    // A transient EPERM on rename is retried, not swallowed. The module race
    // above reproduces it only under load (6 of 12 runs red on a loaded box,
    // 2026-09-24), so this drives the same code path deterministically: the
    // module calls fs.renameSync through the shared fs object, which is patched.
    {
        const realRename = fs.renameSync;
        const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', syscall: 'rename' });
        const rfile = path.join(tmp, 'retry.json');
        let calls = 0;
        fs.renameSync = (a, b) => { calls++; if (calls <= 2) throw eperm(); return realRename(a, b); };
        let wrote;
        try { wrote = ledger.write(rfile, 'r1', { n: 7 }); } finally { fs.renameSync = realRename; }
        const back = ledger.read(rfile, 'r1');
        check('rename: two EPERMs are retried and the write lands', wrote === true && calls === 3
            && back.state === 'ok' && back.entry.n === 7, 'wrote=' + wrote + ' calls=' + calls + ' state=' + back.state);

        calls = 0;
        const t0 = Date.now();
        fs.renameSync = () => { calls++; throw eperm(); };
        try { wrote = ledger.write(rfile, 'r2', { n: 1 }); } finally { fs.renameSync = realRename; }
        const bound = (ledger.RENAME_RETRY_MS || []).length + 1;
        check('rename: a persistent EPERM gives up after the bound, returns false, leaves no tmp', wrote === false
            && calls === bound && ledger.read(rfile, 'r2').state === 'absent'
            && fs.readdirSync(ledger.dirFor(rfile)).every((n) => !n.endsWith('.tmp')),
            'wrote=' + wrote + ' calls=' + calls + ' of ' + bound + ' in ' + (Date.now() - t0) + ' ms');

        calls = 0;
        fs.renameSync = () => { calls++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
        try { wrote = ledger.write(rfile, 'r3', { n: 1 }); } finally { fs.renameSync = realRename; }
        check('rename: an error that is not transient is not retried', wrote === false && calls === 1, 'calls=' + calls);
    }

    // A ledger that cannot be parsed is never written over.
    const k = 'corrupt-me';
    ledger.write(file, k, { n: 1, at: Date.now() });
    const target = ledger.fileFor(file, k);
    fs.writeFileSync(target, '{ half a reco');
    const r = ledger.read(file, k);
    check('corrupt entry reads as corrupt, not as absent', r.state === 'corrupt', 'state=' + r.state);
    const wrote = ledger.writeUnlessCorrupt(file, k, r, { n: 2, at: Date.now() });
    check('a write after a parse failure is refused and the bytes are untouched',
        wrote === false && fs.readFileSync(target, 'utf8') === '{ half a reco',
        'wrote=' + wrote);

    // Pruning removes old entries and leaves fresh ones.
    const oldKey = 'aged';
    ledger.write(file, oldKey, { at: Date.now() - 40 * 864e5 });
    const aged = ledger.fileFor(file, oldKey);
    const past = new Date(Date.now() - 40 * 864e5);
    fs.utimesSync(aged, past, past);
    ledger.write(file, 'fresh', { at: Date.now() }, { maxAgeMs: 30 * 864e5 });
    check('prune: an entry older than maxAge is removed on the next write', !fs.existsSync(aged));
    check('prune: a fresh entry is kept', !!ledger.readAll(file).fresh);

    // The legacy single-file ledger is read, never written.
    const legacy = path.join(tmp, 'legacy.json');
    fs.writeFileSync(legacy, JSON.stringify({ s1: { sha: 'x', at: Date.now() } }));
    const before = fs.readFileSync(legacy, 'utf8');
    const lr = ledger.read(legacy, 's1');
    check('legacy: an entry in the old shared file is still read', lr.state === 'ok' && lr.entry.sha === 'x', 'state=' + lr.state);
    ledger.write(legacy, 's1', { sha: 'y', at: Date.now() });
    check('legacy: writing goes to the per-key file and leaves the shared file byte-identical',
        fs.readFileSync(legacy, 'utf8') === before && ledger.read(legacy, 's1').entry.sha === 'y');
}

(async () => {
    await hookRace();
    await moduleRace();
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
})();
