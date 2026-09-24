#!/usr/bin/env node
// Tests for hooks/instructions-loaded.js and scripts/check-rules-reachable.js
// Run: node tooling/test-instructions-loaded.js
// Exits 1 on any failure; 0 if all pass.
//
// The hook is driven as a subprocess, because that is how it runs and because
// the property that matters most about it cannot be tested any other way: it
// must emit ZERO BYTES on stdout AND stderr. It fires once per instruction file
// per session, so a hook that says anything at all says it many times before
// the user has typed a word, and a noisy hook gets disabled. Mutants have
// survived in this repo by a test checking only one stream, so both are checked
// on every case.
//
// The check's own analysis is unit-tested through its export rather than by
// writing a real log, so a developer's actual ~/.claude/logs is never touched.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'instructions-loaded.js');
const CHECK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-rules-reachable.js');
const { analyse } = require(CHECK);

let failures = 0;
function check(name, cond) {
    if (cond) { console.log('  ok   ' + name); return; }
    console.log('  FAIL ' + name);
    failures += 1;
}

// Point the hook at a scratch config dir so a test never writes to real logs.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'il-'));
const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: sandbox });
const LOG = path.join(sandbox, 'logs', 'instructions-loaded.jsonl');

function run(payload) {
    return spawnSync('node', [HOOK], {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
        env,
    });
}

console.log('instructions-loaded (hook)');

let r = run({ file_path: 'C:/p/CLAUDE.md', load_reason: 'session_start', file_content: '# x', cwd: 'C:/p' });
check('exits 0 on a normal load', r.status === 0);
check('emits zero bytes on stdout', (r.stdout || '') === '');
check('emits zero bytes on stderr', (r.stderr || '') === '');
check('wrote a log line', fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').trim().split('\n').length === 1);

let row = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n')[0]);
check('records the file path', row.file === 'C:/p/CLAUDE.md');
check('records the load reason', row.reason === 'session_start');
check('classifies an unscoped file as unscoped', row.scoped === false);

// The scoped flag is captured AT LOAD TIME on purpose: by the time the check
// runs the file may have changed, and a claim about what loaded has to describe
// the thing that loaded rather than its successor.
run({ file_path: 'C:/p/.claude/rules/api.md', load_reason: 'path_glob_match',
      file_content: '---\npaths:\n  - "src/**/*.ts"\n---\n# api', cwd: 'C:/p' });
row = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n')[1]);
check('detects paths: frontmatter as scoped', row.scoped === true);

// Failure modes. Each must be silent and non-fatal: this hook runs before the
// user can react to anything going wrong, so it must never break a turn.
for (const [label, payload] of [
    ['no stdin at all', ''],
    ['whitespace only', '   \n'],
    ['unparseable JSON', '{not json'],
    ['valid JSON, no file_path', '{"load_reason":"session_start"}'],
    ['file_path of the wrong type', '{"file_path":42}'],
    ['null content', '{"file_path":"C:/p/x.md","file_content":null}'],
]) {
    const rr = run(payload);
    check('survives ' + label + ' (exit 0)', rr.status === 0);
    check('  ...silently on both streams', (rr.stdout || '') === '' && (rr.stderr || '') === '');
}

const before = fs.readFileSync(LOG, 'utf8').trim().split('\n').length;
run('{"load_reason":"session_start"}');
const after = fs.readFileSync(LOG, 'utf8').trim().split('\n').length;
check('a payload with no file_path writes nothing', before === after);

// ---- a full log, shared by every session ----
//
// Every session appends to one log under the config dir, and the load that finds
// it full used to trim it in place: read every line, keep the last 4,000, write
// them back. A row another session appended between that read and that write
// was gone. The race below plants that row deterministically, right after the
// hook's own stat and right after its own read of the log, so a lost row fails
// every run rather than a lucky one.
const { readLog } = require(CHECK);
const race = require('./race-interleave.js');
const PRELOAD = race.preloadPath();
const LOGS = path.join(sandbox, 'logs');
const segments = () => fs.readdirSync(LOGS).filter((n) => /^instructions-loaded\.\d{13}-\d+\.jsonl$/.test(n)).sort();
const pad = 'x'.repeat(150);
function seedFull(lines) {
    for (const n of fs.readdirSync(LOGS)) fs.rmSync(path.join(LOGS, n), { force: true });
    const rows = [];
    for (let i = 0; i < lines; i++) rows.push(JSON.stringify({ at: '2026-09-24T00:00:00Z', file: `C:/p/seed-${i}.md`, reason: 'nested_traversal', scoped: false, bytes: 1, cwd: pad }));
    fs.writeFileSync(LOG, rows.join('\n') + '\n');
}
const loadRow = (file) => ({ file_path: file, load_reason: 'session_start', file_content: '# x', cwd: 'C:/p' });
const filesIn = (rows) => new Set((rows || []).map((x) => x.file));

{
    seedFull(4100);
    const record = path.join(sandbox, 'planted.txt');
    fs.rmSync(record, { force: true });
    const plant = (op, tag) => ({ op, basename: 'instructions-loaded.jsonl', appendTo: LOG, times: 1,
        text: JSON.stringify({ at: '2026-09-24T00:00:01Z', file: `C:/p/peer-${tag}.md`, reason: 'session_start', scoped: false, bytes: 1, cwd: 'C:/p' }) + '\n' });
    const rr = spawnSync('node', ['--require', PRELOAD, HOOK], {
        input: JSON.stringify(loadRow('C:/p/own.md')), encoding: 'utf8',
        env: Object.assign({}, env, { RACE_SPEC: race.spec([plant('statSync', 'after-stat'), plant('readFileSync', 'after-read')], record) }),
    });
    const got = filesIn(readLog(LOG));
    const plantedFiles = race.planted(record).map((l) => JSON.parse(l).file);
    check('full log: the hook exits 0 and silent under the planted race', rr.status === 0 && !rr.stdout && !rr.stderr);
    check('full log: the race planted at least one peer row (the probe fired)', plantedFiles.length >= 1);
    check(`full log: every row a peer appended mid-rotation survives (${plantedFiles.filter((f) => got.has(f)).length} of ${plantedFiles.length})`,
        plantedFiles.length >= 1 && plantedFiles.every((f) => got.has(f)));
    check('full log: the loading session\'s own row survives', got.has('C:/p/own.md'));
    check('full log: the seeded history is still readable', got.has('C:/p/seed-4099.md'));
}

{
    // Twenty sessions load at once on a log that is already over the line.
    seedFull(4100);
    const procs = [];
    for (let i = 0; i < 20; i++) {
        procs.push(new Promise((resolve) => {
            const child = require('child_process').spawn('node', [HOOK], { env, stdio: ['pipe', 'ignore', 'ignore'] });
            child.on('close', resolve);
            child.on('error', resolve);
            child.stdin.end(JSON.stringify(loadRow(`C:/p/concurrent-${i}.md`)));
        }));
    }
    var concurrent = Promise.all(procs).then(() => {
        const got = filesIn(readLog(LOG));
        let n = 0;
        for (let i = 0; i < 20; i++) if (got.has(`C:/p/concurrent-${i}.md`)) n++;
        check(`20 concurrent loads on a full log: all 20 rows survive (${n} of 20)`, n === 20);
    });
}

function retention() {
    // Rotation is bounded: the live log plus the newest segments reaching the
    // cap. Three rotations in a row leave the oldest one gone.
    for (const n of fs.readdirSync(LOGS)) fs.rmSync(path.join(LOGS, n), { force: true });
    for (let k = 0; k < 3; k++) {
        const rows = [];
        for (let i = 0; i < 2800; i++) rows.push(JSON.stringify({ at: '2026-09-24T00:00:00Z', file: `C:/p/gen${k}-${i}.md`, reason: 'nested_traversal', scoped: false, bytes: 1, cwd: pad }));
        fs.writeFileSync(LOG, rows.join('\n') + '\n');
        run(loadRow(`C:/p/after-gen${k}.md`));
        spawnSync('node', ['-e', 'const t=Date.now();while(Date.now()-t<5){}']);
    }
    const segs = segments();
    const got = filesIn(readLog(LOG));
    check(`rotation: at most two segments are kept (${segs.length})`, segs.length >= 1 && segs.length <= 2);
    check('rotation: the oldest generation is dropped', !got.has('C:/p/gen0-0.md'));
    check('rotation: the newest generation is kept', got.has('C:/p/gen2-2799.md') && got.has('C:/p/after-gen2.md'));
    run(loadRow('C:/p/live-after-rotation.md'));
    const rows = readLog(LOG);
    const iOld = rows.findIndex((x) => x.file === 'C:/p/gen2-0.md');
    const iNew = rows.findIndex((x) => x.file === 'C:/p/live-after-rotation.md');
    check('rotation: a load after rotation starts a fresh live log', fs.existsSync(LOG) && fs.statSync(LOG).size < 1024);
    check('rotation: readLog returns segment rows before live rows', iOld !== -1 && iNew !== -1 && iOld < iNew);
}

console.log('');
console.log('check-rules-reachable (analysis)');

const st = spawnSync('node', [CHECK, '--selftest'], { encoding: 'utf8', env });
check('--selftest exits 0', st.status === 0);
check('--selftest names its mutation case', /mutation/i.test(st.stdout || ''));

const F = (p, scoped) => ({ file: path.resolve(p), scoped });
const START = { reason: 'session_start', at: '2026-08-26T00:00:00Z', file: '/r/CLAUDE.md' };

let a = analyse([F('/r/.claude/rules/dead.md', false)], [START]);
check('an unconditional rule never seen is UNREACHABLE', a.unreachable.length === 1);

a = analyse([F('/r/.claude/rules/scoped.md', true)], [START]);
check('a path-scoped rule never seen is unexercised, not a fault',
    a.unexercised.length === 1 && a.unreachable.length === 0);

// THE GUARD THAT CARRIES THE CHECK. Without a session_start in the log, a naive
// subtraction reports every rule in the repo as unreachable on a fresh machine.
// That is a claim about the log wearing a finding's clothes, and it is exactly
// how a detector earns the reputation that gets it muted.
a = analyse([F('/r/.claude/rules/dead.md', false)],
    [{ reason: 'path_glob_match', at: '2026-08-26T00:00:00Z', file: '/r/other.md' }]);
check('no session_start observed means NO EVIDENCE, not findings', a.sawStart === false);

a = analyse([F('/r/.claude/rules/dead.md', false)], []);
check('an empty log is not a pile of findings', a.sawStart === false);

// The report must exit 0 on no-evidence, or a fresh clone fails its own gate.
const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'il-fresh-'));
const rep = spawnSync('node', [CHECK, fresh], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: fresh }),
});
check('a repo with no log exits 0', rep.status === 0);
check('...and says NO EVIDENCE rather than reporting rules', /NO EVIDENCE/.test(rep.stdout || ''));

concurrent.then(() => {
    retention();
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* tmp */ }
    try { fs.rmSync(fresh, { recursive: true, force: true }); } catch { /* tmp */ }
    try { fs.rmSync(path.dirname(PRELOAD), { recursive: true, force: true }); } catch { /* tmp */ }
    console.log(failures ? '\nFAILED: ' + failures : '\nall passed');
    process.exitCode = failures ? 1 : 0;
});
