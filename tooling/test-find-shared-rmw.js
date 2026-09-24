#!/usr/bin/env node
// Suite for tooling/find-shared-rmw.js, the read-modify-write detector.
//
// `[measured 2026-09-22]` a shared JSON ledger rewritten whole by every Stop
// kept 1 of 220 entries under 20 concurrent Stops. That hook passed review
// because nothing looked for the shape. The detector looks for it, and this
// suite proves three things about it:
//   1. every hook and every module a hook requires has no open finding and no
//      stale ACCEPTED entry, with the population printed;
//   2. it fires on each shape that has shipped in this repo, planted inline and,
//      where git history is present, on the real shipped files;
//   3. it stays quiet on the shapes that are safe: a keyed path, an append, a
//      blind write in a branch that the read never reaches.

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(__dirname, 'find-shared-rmw.js');
const rmw = require(TOOL);

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rmw-test-'));
const scan = (src) => rmw.scanText(src, 'planted.js');
const PRE = "'use strict';\nconst fs = require('fs');\nconst path = require('path');\nconst os = require('os');\nconst CFG = path.join(os.homedir(), '.claude');\n";

// ---------------------------------------------------------------- the tree

{
    const files = rmw.hookClosure();
    const rels = files.map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    const hooks = rels.filter((r) => /^plugins\/[^/]+\/hooks\/[^/]+\.js$/.test(r));
    const onDisk = [];
    for (const p of fs.readdirSync(path.join(ROOT, 'plugins'))) {
        let names = [];
        try { names = fs.readdirSync(path.join(ROOT, 'plugins', p, 'hooks')); } catch { continue; }
        for (const n of names) if (n.endsWith('.js')) onDisk.push(`plugins/${p}/hooks/${n}`);
    }
    console.log(`population: ${files.length} file(s), ${hooks.length} hook(s), ${files.length - hooks.length} required module(s)`);
    check('scope: every hook on disk is scanned', onDisk.every((h) => rels.includes(h)), `${onDisk.length} on disk`);
    check('scope: a module required with path.join(__dirname, ...) is scanned',
        rels.includes('plugins/autodev-core/scripts/keyed-ledger.js'));
    check('scope: a module required with path.join(PLUGIN_ROOT, ...) is scanned',
        rels.includes('plugins/autodev-memory/scripts/session-carrier.js'));
    check('scope: a CLI script no hook requires is not scanned',
        !rels.includes('plugins/autodev-core/scripts/deploy-ledger.js'));

    const findings = rmw.scanFiles(files);
    const v = rmw.judge(findings, rels);
    for (const f of v.open) console.log(`      OPEN ${f.file}:${f.line} ${f.kind} of ${f.path}`);
    for (const a of v.stale) console.log(`      STALE ${a.file} ${a.kind} of ${a.path}`);
    check('tree: no open finding in a hook or a module a hook requires', v.open.length === 0, `${findings.length} found, ${v.accepted.length} accepted`);
    check('tree: no ACCEPTED entry is stale', v.stale.length === 0);
    check('tree: every ACCEPTED entry carries a reason', rmw.ACCEPTED.every((a) => typeof a.why === 'string' && a.why.length > 40));

    const cli = spawnSync(process.execPath, [TOOL], { encoding: 'utf8', cwd: ROOT });
    check('CLI: exits 0 on the tree and prints its population', cli.status === 0 && /scanned \d+ file\(s\)/.test(cli.stdout), (cli.stdout || '').split('\n')[0]);
}

// ---------------------------------------------------------------- shapes that shipped

{
    const f = scan(PRE + `
function f() {
    const p = path.join(CFG, 'shared.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.x = 1;
    fs.writeFileSync(p, JSON.stringify(j));
}
`);
    check('fires: read then rewrite in one function', f.length === 1 && f[0].kind === 'rewrite', JSON.stringify(f.map((x) => x.kind)));
}

{
    // The 8.171.0 context-depth-nudge shape: the top level read the shared
    // ledger, and a function wrote it back with the other sessions' entries.
    const f = scan(PRE + `
function ledgerPath() { return path.join(CFG, 'nudge-ledger.json'); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const ledger = readJson(ledgerPath()) || {};
writeLedger(ledger, 'id', { at: Date.now() });
function writeLedger(all, id, entry) {
    all[id] = entry;
    const p = ledgerPath();
    fs.writeFileSync(p, JSON.stringify(all));
}
`);
    check('fires: a top-level read, then a writer function on the same fixed path (8.171.0)',
        f.length === 1 && f[0].kind === 'rewrite' && f[0].path === 'ledgerPath()', JSON.stringify(f.map((x) => x.path)));
}

{
    const f = scan(PRE + `
const pending = path.join(process.cwd(), '.claude', '.pending');
let raw;
try { raw = fs.readFileSync(pending, 'utf8'); } catch { process.exit(0); }
try { fs.unlinkSync(pending); } catch {}
`);
    check('fires: read then unlink (a consume)', f.length === 1 && f[0].kind === 'consume');
}

{
    const f = scan(PRE + `
function prune(file) {
    const buf = fs.readFileSync(file);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, buf.slice(10));
    fs.renameSync(tmp, file);
}
prune(path.join(CFG, 'log.jsonl'));
`);
    check('fires: read, then a temp file renamed over the original (a replace)', f.some((x) => x.kind === 'replace'));
}

{
    // A read guarded by an if, then a write after it: the stop-auto-check shape,
    // on a path that is NOT keyed.
    const f = scan(PRE + `
const ledger = path.join(CFG, 'notes.json');
let sent = [];
if (fs.existsSync(ledger)) {
    try { sent = JSON.parse(fs.readFileSync(ledger, 'utf8')); } catch {}
}
sent.push('x');
fs.writeFileSync(ledger, JSON.stringify(sent));
`);
    check('fires: a read inside an if, then a write after it', f.length === 1);
}

{
    const f = scan(PRE + `
function readState(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
function writeState(p, v) { fs.writeFileSync(p, JSON.stringify(v)); }
const file = path.join(CFG, 'state.json');
const s = readState(file);
s.n = (s.n || 0) + 1;
writeState(file, s);
`);
    check('fires: a reader helper and a writer helper on one path', f.length === 1 && f[0].via === 'readState -> writeState', f[0] && f[0].via);
}

// The watch-panels.js shape: helpers that take no path and touch a fixed one,
// the set loaded once at the top level and saved from a function a timer runs.
// The read and the write sit in different functions, so the value read at
// startup is what every later save writes back over another watcher's set.
const WATCH = (savePath) => PRE + `
const STATE = path.join(CFG, 'fleet', 'seen.json');
const OTHER = path.join(CFG, 'fleet', 'other.json');
function loadSeen() {
    try { return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch { return new Set(); }
}
function saveSeen(set) {
    try { fs.writeFileSync(${savePath}, JSON.stringify([...set].slice(-500))); } catch {}
}
const seen = loadSeen();
function scan() {
    seen.add(String(Date.now()));
    saveSeen(seen);
}
setInterval(scan, 1000);
`;

{
    const f = scan(WATCH('STATE'));
    check('fires: zero-parameter helpers on a fixed path, loaded at the top level and saved from a timer (watch-panels)',
        f.length === 1 && f[0].kind === 'rewrite' && f[0].fn === 'scan' && f[0].via === 'loadSeen -> saveSeen',
        JSON.stringify(f.map((x) => `${x.fn} ${x.via}`)));
}

{
    // Control derived from the case above: the same helpers, the save aimed at a
    // second fixed path. Nothing read is written back to where it came from.
    const f = scan(WATCH('OTHER'));
    check('  control: the same helpers on two different fixed paths are quiet', f.length === 0, JSON.stringify(f));
}

{
    // inbox-watch.js: the top level reads the set into `seen`, while claim()
    // writes a fresh listing through writeSeen(seen), whose `seen` is its own
    // parameter. The held value never reaches a write.
    const f = scan(PRE + `
const STATE = path.join(CFG, 'inbox-seen.json');
function readSeen() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function writeSeen(seen) { fs.writeFileSync(STATE, JSON.stringify(seen)); }
function check() { const seen = readSeen(); return seen.claimed || []; }
function claim(files) { writeSeen({ claimed: files }); }
const seen = readSeen();
console.log(seen, check());
`);
    check('quiet: a fixed path read in one function and written fresh in another (inbox-watch)', f.length === 0, JSON.stringify(f));
}

{
    // Across functions the path must be fixed. Here the held value does reach
    // the write, and both paths read path.join(dir, 'seen.json'), but each `dir`
    // is its own function's parameter: this copies directory a into b.
    const f = scan(PRE + `
let seen = [];
function load(dir) { seen = JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8')); }
function save(dir) { fs.writeFileSync(path.join(dir, 'seen.json'), JSON.stringify(seen)); }
load(path.join(CFG, 'a'));
save(path.join(CFG, 'b'));
`);
    check('quiet: the same path text built from each function\'s own parameter', f.length === 0, JSON.stringify(f));
}

{
    // The real file, so the ACCEPTED entry is exercised by a finding the
    // detector produces rather than by a planted copy of it.
    const file = 'plugins/autodev-core/scripts/watch-panels.js';
    const f = rmw.scanText(fs.readFileSync(path.join(ROOT, file), 'utf8'), file);
    const v = rmw.judge(f, [file]);
    check('fires on the current watch-panels.js, and its ACCEPTED entry covers it',
        f.some((x) => x.fn === 'scan' && x.via === 'loadSeen -> saveSeen') && v.open.length === 0 && v.stale.length === 0,
        f.map((x) => `:${x.line} ${x.kind} ${x.via}`).join(', '));
}

// The shipped files themselves, where history is present. A shallow clone
// lacks the commits, and that is reported as not run, never as a pass.
{
    const shipped = [
        ['3e4d3ab', 'plugins/autodev-core/hooks/context-depth-nudge.js', '8.171.0 context-depth-nudge'],
        ['2462df0~1', 'plugins/autodev-core/hooks/instructions-loaded.js', 'instructions-loaded before its rotation'],
        ['2462df0~1', 'plugins/autodev-core/hooks/stop-typecheck.js', 'stop-typecheck before its claim'],
        ['2462df0~1', 'plugins/autodev-memory/hooks/memory-capture.js', 'memory-capture before its append'],
    ];
    let ran = 0;
    for (const [rev, file, label] of shipped) {
        let src = null;
        try { src = execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { src = null; }
        if (src === null) { console.log(`NOT RUN  fires on the shipped ${label}: ${rev} is not in this clone`); continue; }
        ran++;
        const f = rmw.scanText(src, file);
        check(`fires on the shipped ${label}`, f.length >= 1, f.map((x) => `:${x.line} ${x.kind}`).join(', '));
        const now = rmw.scanText(fs.readFileSync(path.join(ROOT, file), 'utf8'), file);
        const v = rmw.judge(now, [file]);
        check(`  and the current ${path.basename(file)} has no open finding`, v.open.length === 0);
    }
    console.log(`shipped files: ${ran} of ${shipped.length} measured`);
}

// ---------------------------------------------------------------- safe shapes

{
    const f = scan(PRE + `
function save(sid) {
    const p = path.join(CFG, 'sessions', sid + '.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, JSON.stringify(j));
}
`);
    check('quiet: a path keyed by the session id', f.length === 0);
}

{
    const f = scan(PRE + `
const p = path.join(CFG, 'x.json') + '.' + process.pid;
const j = fs.readFileSync(p, 'utf8');
fs.writeFileSync(p, j);
`);
    check('quiet: a path keyed by the process id', f.length === 0);
}

{
    const f = scan(PRE + `
const log = path.join(CFG, 'log.jsonl');
const seen = fs.readFileSync(log, 'utf8').includes('x');
if (!seen) fs.appendFileSync(log, 'x\\n');
`);
    check('quiet: a read followed by an append', f.length === 0);
}

{
    // fleet-brief.js: --show reads and exits, --set writes blind.
    const f = scan(PRE + `
const BRIEF = path.join(CFG, 'BRIEF.json');
function readBrief() { try { return JSON.parse(fs.readFileSync(BRIEF, 'utf8')); } catch { return null; } }
if (process.argv.includes('--show')) {
    const raw = readBrief();
    console.log(raw);
    process.exit(0);
}
if (process.argv.includes('--set')) {
    fs.writeFileSync(BRIEF, JSON.stringify({ text: 'x' }));
}
`);
    check('quiet: a blind write in a branch the read exits before (fleet-brief)', f.length === 0, JSON.stringify(f));
}

{
    const f = scan(PRE + `
const P = path.join(CFG, 'y.json');
let x;
if (process.argv.length > 3) {
    x = fs.readFileSync(P, 'utf8');
} else {
    fs.writeFileSync(P, 'fresh');
}
`);
    check('quiet: a read in an if and a write in its else', f.length === 0);
}

{
    // Planted negative for the else rule, derived from the case above: the same
    // write after the if/else instead of inside it must fire.
    const f = scan(PRE + `
const P = path.join(CFG, 'y.json');
let x = '';
if (process.argv.length > 3) {
    x = fs.readFileSync(P, 'utf8');
} else {
    x = 'none';
}
fs.writeFileSync(P, x + 'more');
`);
    check('  control: the same write after the if/else fires', f.length === 1);
}

// ---------------------------------------------------------------- the allowlist

{
    const findings = [
        { file: 'a.js', kind: 'rewrite', path: 'p' },
        { file: 'b.js', kind: 'consume', path: 'q' },
    ];
    const accepted = [
        { file: 'a.js', kind: 'rewrite', path: 'p', why: 'x' },
        { file: 'c.js', kind: 'rewrite', path: 'r', why: 'x' },
        { file: 'd.js', kind: 'rewrite', path: 's', why: 'x' },
    ];
    const v = rmw.judge(findings, ['a.js', 'b.js', 'c.js'], accepted);
    check('judge: an accepted finding is not open', !v.open.some((f) => f.file === 'a.js') && v.accepted.length === 1);
    check('judge: an unaccepted finding is open', v.open.length === 1 && v.open[0].file === 'b.js');
    check('judge: an entry for a scanned file with no finding is stale', v.stale.length === 1 && v.stale[0].file === 'c.js');
    check('judge: an entry for a file not scanned is not called stale', !v.stale.some((a) => a.file === 'd.js'));
    const byKind = rmw.judge([{ file: 'a.js', kind: 'consume', path: 'p' }], ['a.js'], accepted);
    check('judge: an entry matches on kind too, not file and path alone', byKind.open.length === 1 && byKind.stale.length === 1);
}

{
    const planted = path.join(TMP, 'planted-hook.js');
    fs.writeFileSync(planted, PRE + "const p = path.join(CFG, 'z.json');\nconst z = fs.readFileSync(p, 'utf8');\nfs.writeFileSync(p, z + '1');\n");
    const r = spawnSync(process.execPath, [TOOL, planted], { encoding: 'utf8' });
    check('CLI: exits 1 on a planted file and names it OPEN', r.status === 1 && /OPEN .*planted-hook\.js:\d+ {2}rewrite/.test(r.stdout), (r.stdout || '').split('\n')[1]);
    const h = spawnSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' });
    check('CLI: --help returns 0 without scanning', h.status === 0 && !/scanned/.test(h.stdout));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* tmp */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
