#!/usr/bin/env node
'use strict';
/**
 * Suite for plugins/autodev-core/scripts/board-sync.js. Drives it as a subprocess against temp fixtures.
 *
 *   node tooling/test-board-sync.js           the suite. Prints "ok <name>" per passing check,
 *                                             "FAIL <name>" per failing one, and exits 1 on any.
 *   node tooling/test-board-sync.js --plant   derives one broken copy of board-sync.js per guarded
 *                                             step, runs the suite against each copy, and exits 1
 *                                             when a copy still passes the check that guards its step.
 *
 * The exporters board-sync runs (open-loops-mirror.js, board-index.js) are the owner's own and do
 * not ship. FAKE_MIRROR and FAKE_INDEX stand in for them: they render the block, the draft files,
 * the Inbox plan and the code index from the dump, with the contract board-sync checks.
 *
 * Every write lands in a fresh os.tmpdir() folder. BRAIN_CLOCK_CLAUDE_DIR and BOARD_SYNC_LIST point
 * there. The real list, autodev folder and lock are never written. brain-clock.js owns the lock rule
 * and is run only against a temp dir. BOARD_SYNC_SUBJECT names the script under test.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPTS = path.resolve(__dirname, '../plugins/autodev-core/scripts');
const REAL = path.resolve(__dirname, '../plugins/autodev-core/scripts/board-sync.js');
const SUBJECT = process.env.BOARD_SYNC_SUBJECT || REAL;
const CLOCK = path.resolve(__dirname, '../plugins/autodev-core/scripts/brain-clock.js');
process.env.BOARD_SYNC_CLOCK = CLOCK; // planted copies of the subject run from a temp dir
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'board-sync-test-'));
const J = (x) => JSON.stringify(x);

let failed = 0;
function check(name, ok, detail) {
    process.stdout.write(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : ': ' + String(detail).slice(0, 600)}\n`);
    if (!ok) failed++;
}

// ---------------------------------------------------------------- the fake exporters
// open-loops-mirror.js: plan reads the Inbox against the dump, export renders the block between
// the markers with its export time and sha, writes the draft files and drops already-applied lines.
const FAKE_MIRROR = `'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const dump = opt('--dump');
const file = opt('--file');
const items = fs.readdirSync(path.join(dump, 'items')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dump, 'items', f), 'utf8')));
const byCode = new Map(items.map((i) => [i.code, i]));
const text = fs.readFileSync(file, 'utf8');
const inbox = text.slice(text.indexOf('## Inbox')).split('\\n').filter((l) => l.startsWith('- '));
if (argv[0] === 'plan') {
  const plan = { apply: [], conflicts: [], ignored: [], alreadyAppliedLines: [] };
  for (const line of inbox) {
    const p = line.slice(2).split(' | ');
    if (p.length < 5) { plan.ignored.push({ line, kind: 'not-parsed' }); continue; }
    const it = byCode.get(p[2]);
    if (it && p[3] === 'done' && it.status === 'done') plan.alreadyAppliedLines.push(line);
    else if (it && Date.parse(p[0].replace(/Z$/, ':00Z')) < Date.parse(it.updatedAt)) plan.conflicts.push({ line, code: p[2] });
    else plan.apply.push({ line, code: p[2] });
  }
  const out = opt('--out');
  if (out) fs.writeFileSync(out, JSON.stringify(plan));
  process.stdout.write(JSON.stringify(plan));
} else if (argv[0] === 'export') {
  if (process.env.STUB_EXPORT === 'fail') { process.stderr.write('open-loops-mirror: planted export failure\\n'); process.exitCode = 1; return; }
  if (process.env.STUB_EXPORT === 'noop') return;
  const week = Date.now() - 7 * 864e5;
  const groups = [['Needs you', (i) => i.status !== 'done' && i.group === 'needs-you'], ['Queued', (i) => i.status !== 'done' && i.group === 'queued'], ['Backlog', (i) => i.status !== 'done' && i.group === 'backlog'], ['Closed in the last 7 days', (i) => i.status === 'done' && Date.parse(i.updatedAt) >= week]];
  const at = new Date().toISOString().slice(0, 16) + 'Z';
  let body = '\\nGenerated from the Open Loops board at ' + at + '\\n';
  for (const [name, f] of groups) {
    const rows = items.filter(f);
    body += '\\n## ' + name + ' (' + rows.length + ')\\n| Code | Title |\\n|---|---|\\n' + rows.map((i) => '| ' + i.code + ' | ' + i.title + ' |\\n').join('');
  }
  const sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  const s = text.indexOf('<!-- open-loops:start');
  const e = text.indexOf('<!-- open-loops:end -->');
  let next = text.slice(0, s) + '<!-- open-loops:start sha256=' + sha + ' -->' + body + text.slice(e);
  const done = opt('--already-applied');
  if (done) {
    const plan = JSON.parse(fs.readFileSync(done, 'utf8'));
    for (const line of plan.alreadyAppliedLines || []) next = next.replace(line + '\\n', '');
  }
  fs.writeFileSync(file, next);
  const drafts = path.join(path.dirname(file), 'open-loops');
  const want = items.filter((i) => Array.isArray(i.drafts) && i.drafts.length);
  if (want.length) fs.mkdirSync(drafts, { recursive: true });
  for (const i of want) fs.writeFileSync(path.join(drafts, i.code + '.md'), i.drafts.map((d) => '## ' + d.label + '\\n\\n' + d.text + '\\n').join('\\n'));
  if (fs.existsSync(drafts)) for (const f of fs.readdirSync(drafts)) if (!want.some((i) => i.code + '.md' === f)) fs.rmSync(path.join(drafts, f));
} else { process.stderr.write('unknown command\\n'); process.exitCode = 1; }
`;
// board-index.js: index <dump> --out <file> writes the counts board-sync stamps.
const FAKE_INDEX = `'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const n = fs.readdirSync(path.join(argv[1], 'items')).filter((f) => f.endsWith('.json')).length;
fs.writeFileSync(argv[argv.indexOf('--out') + 1], JSON.stringify({ generatedAt: new Date().toISOString(), counts: { documents: n, mismatched: 0, duplicateCodes: 0 } }));
`;
const FAKES = path.join(TMP, 'fake-scripts');
fs.mkdirSync(FAKES, { recursive: true });
fs.writeFileSync(path.join(FAKES, 'open-loops-mirror.js'), FAKE_MIRROR, 'utf8');
fs.writeFileSync(path.join(FAKES, 'board-index.js'), FAKE_INDEX, 'utf8');

// ---------------------------------------------------------------- fixtures
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const DAY = 864e5;
function item(code, extra) {
    return Object.assign({ code, title: `title of ${code}`, status: 'open', group: 'needs-you', project: 'p', since: '2026-09-20', updatedAt: '2026-09-20T00:00:00Z' }, extra || {});
}
const BASE_ITEMS = [
    item('A1'),
    item('A2', { group: 'queued', drafts: [{ label: 'Reply', text: 'hello' }] }),
    item('A3', { status: 'done', updatedAt: new Date(Date.now() - DAY).toISOString(), evidence: 'shipped' }),
];
const LIST_TEXT = [
    '# OUTSTANDING', '',
    '<!-- open-loops:start -->', 'old block text', '<!-- open-loops:end -->', '',
    '## Inbox (append only)',
    '- 2026-09-24T08:00Z | tester | NEW | new | fixture: a new line',
    '- 2026-09-19T00:00Z | tester | A1 | note | older than the board, so a conflict',
    '',
].join('\n');

let caseNo = 0;
function fresh(items) {
    const root = path.join(TMP, `c${++caseNo}`);
    const c = { root, claude: path.join(root, 'claude'), list: path.join(root, 'mem', 'OUTSTANDING.md'), dump: path.join(root, 'dump') };
    c.autodev = path.join(c.claude, 'autodev');
    c.stamp = path.join(c.autodev, 'board-sync.json');
    c.index = path.join(c.autodev, 'board-index.json');
    c.plan = path.join(c.autodev, 'board-sync-plan.json');
    c.lock = path.join(c.autodev, 'brain-clock', 'lock.json');
    c.drafts = path.join(root, 'mem', 'open-loops');
    fs.mkdirSync(path.dirname(c.list), { recursive: true });
    fs.writeFileSync(c.list, LIST_TEXT, 'utf8');
    writeDump(c, items || BASE_ITEMS);
    c.env = Object.assign({}, process.env, { BRAIN_CLOCK_CLAUDE_DIR: c.claude, BOARD_SYNC_LIST: c.list, BOARD_SYNC_SCRIPTS_DIR: FAKES });
    delete c.env.CLAUDE_CONFIG_DIR;
    return c;
}
function writeDump(c, items) {
    fs.rmSync(c.dump, { recursive: true, force: true });
    fs.mkdirSync(path.join(c.dump, 'items'), { recursive: true });
    for (const i of items) fs.writeFileSync(path.join(c.dump, 'items', `${i.code}.json`), JSON.stringify(i, null, 2), 'utf8');
}
function many(n) { return Array.from({ length: n }, (_, k) => item(`M${k + 1}`)); }
function sync(c, argv, extraEnv, script) {
    const r = spawnSync(process.execPath, [script || SUBJECT, ...argv], { encoding: 'utf8', env: Object.assign({}, c.env, extraEnv || {}), timeout: 120000 });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// Every file under a folder with its bytes digest, so "nothing written" compares a whole tree.
function tree(dir) {
    const out = {};
    (function walk(d) {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { out[path.relative(dir, p) + '/'] = 'dir'; walk(p); }
            else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex') + ':' + fs.statSync(p).mtimeMs;
        }
    })(dir);
    return out;
}
function blockOf(text) {
    const s = text.indexOf('<!-- open-loops:start'), e = text.indexOf('<!-- open-loops:end -->');
    const le = text.indexOf('-->', s) + 3;
    return { startLine: text.slice(s, le), body: text.slice(le, e) };
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
function deadPid() { return spawnSync(process.execPath, ['-e', '0']).pid; }
function plantLock(c, body) { fs.mkdirSync(path.dirname(c.lock), { recursive: true }); fs.writeFileSync(c.lock, JSON.stringify(body)); }

async function main() {
    // ------------------------------------------------------------ happy path
    {
        const c = fresh();
        const t0 = Date.now();
        const r = sync(c, ['run', '--dump', c.dump]);
        check('happy: run exits 0 with one summary line', r.code === 0 && /^board-sync: exported 3 items at /m.test(r.out), r.all);
        const text = read(c.list) || '';
        const b = blockOf(text);
        const gen = (/Generated from the Open Loops board at (\S+?Z)/.exec(b.body) || [])[1];
        check('happy: block regenerated with this run\'s export time and a matching sha', gen && Date.parse(gen) >= Math.floor(t0 / 60000) * 60000 && b.startLine.includes(`sha256=${sha(b.body)}`) && !b.body.includes('old block text'), b.startLine + ' ' + gen);
        check('happy: rows, drafts and Inbox as expected', /## Needs you \(1\)[\s\S]*\| A1 \|/.test(b.body) && /## Closed in the last 7 days \(1\)[\s\S]*\| A3 \|/.test(b.body) && fs.existsSync(path.join(c.drafts, 'A2.md')) && text.includes('fixture: a new line') && text.includes('older than the board'), text);
        const s = readJson(c.stamp) || {};
        const genIso = gen && Number.isFinite(Date.parse(gen)) ? new Date(Date.parse(gen)).toISOString() : 'no block time';
        check('happy: stamp records the export time, items, conflicts and the default config dir', s.exportedAt === genIso && s.items === 3 && s.conflicts === 1 && s.apply === 1 && s.configDir === '~/.claude' && s.configDirFrom === 'default' && s.lastAttempt && s.lastAttempt.exit === 0, J(s));
        const ix = readJson(c.index);
        check('happy: index and plan written, lock released', ix && ix.counts.documents === 3 && fs.existsSync(c.plan) && !fs.existsSync(c.lock), J(ix && ix.counts) + ' lock ' + fs.existsSync(c.lock));
        const r2 = sync(c, ['run', '--dump', c.dump]);
        check('happy: a second run accepts its own block', r2.code === 0, r2.all);

        const st = sync(c, ['status']);
        const s2 = readJson(c.stamp) || {};
        check('status: agrees with the stamp after a run', st.code === 0 && /^board-sync: fresh, /.test(st.out) && st.out.includes(`(${s2.exportedAt})`) && st.out.includes(`${s2.items} items`) && st.out.includes(`${s2.conflicts} conflicts`) && st.out.trim().split('\n').length === 1, st.all);

        const b2 = blockOf(read(c.list) || '');
        const g = require(SUBJECT).GENERATED_RE.exec(b2.body);
        check('block: the exported time matches the GENERATED_RE export, which readers of the list parse', g && s2.blockGeneratedAt === g[1], J(s2) + ' ' + b2.body.slice(0, 80));
    }

    // ------------------------------------------------------------ empty, missing, unreadable
    {
        const c = fresh([]);
        const before = read(c.list);
        const r = sync(c, ['run', '--dump', c.dump]);
        check('empty dump: exit 2 and says so', r.code === 2 && /holds no items/.test(r.err), r.all);
        const s = readJson(c.stamp);
        check('empty dump: nothing exported (list, drafts, index untouched, no export stamped)', read(c.list) === before && !fs.existsSync(c.drafts) && !fs.existsSync(c.index) && !fs.existsSync(c.plan) && (!s || (!s.exportedAt && s.lastAttempt.exit === 2)), J(s));
        fs.rmSync(path.join(c.dump, 'items'), { recursive: true });
        const r2 = sync(c, ['run', '--dump', c.dump]);
        check('missing items folder: exit 2', r2.code === 2 && /no items folder/.test(r2.err), r2.all);
    }
    {
        const c = fresh();
        fs.writeFileSync(path.join(c.dump, 'items', 'BAD.json'), '{not json', 'utf8');
        const before = read(c.list);
        const r = sync(c, ['run', '--dump', c.dump]);
        check('unreadable dump: exit 2 naming the file', r.code === 2 && /1 of 4 dump files.*BAD\.json/.test(r.err) && read(c.list) === before, r.all);
    }

    // ------------------------------------------------------------ partial dump
    {
        const c = fresh(many(8));
        const r1 = sync(c, ['run', '--dump', c.dump]);
        writeDump(c, many(2));
        const before = read(c.list);
        const r = sync(c, ['run', '--dump', c.dump]);
        check('partial dump: exit 2 against the last sync count', r1.code === 0 && r.code === 2 && /holds 2 items but the last sync read 8/.test(r.err) && read(c.list) === before, r1.all + r.all);
        const r3 = sync(c, ['run', '--dump', c.dump, '--allow-shrink']);
        check('partial dump: --allow-shrink lets it through', r3.code === 0 && (readJson(c.stamp) || {}).items === 2, r3.all);
    }

    // ------------------------------------------------------------ hand-edited block
    {
        const c = fresh();
        const r1 = sync(c, ['run', '--dump', c.dump]);
        const s1 = readJson(c.stamp) || {};
        const edited = read(c.list).replace('| title of A1 |', '| title of A1, edited by a session |');
        fs.writeFileSync(c.list, edited, 'utf8');
        const ixBefore = read(c.index), planBefore = read(c.plan);
        const r = sync(c, ['run', '--dump', c.dump]);
        check('hand-edited block: exit 1 and says it was edited by hand', r1.code === 0 && r.code === 1 && /edited by hand since its last export/.test(r.err) && /delete " sha256=/.test(r.err), r.all);
        const s = readJson(c.stamp) || {};
        check('hand-edited block: list, index and plan untouched, stamp keeps the old export and records the refusal', read(c.list) === edited && read(c.index) === ixBefore && read(c.plan) === planBefore && s.exportedAt === s1.exportedAt && s.lastAttempt && s.lastAttempt.exit === 1 && /edited by hand/.test(s.lastAttempt.reason), J(s));
        const st = sync(c, ['status']);
        check('status: names a failed attempt after the last export', /Last attempt .* exited 1: .*edited by hand/.test(st.out), st.all);
        const d = sync(c, ['run', '--dump', c.dump, '--dry-run']);
        check('dry run: predicts the hand-edit refusal with exit 1', d.code === 1 && /A real run would refuse/.test(d.err), d.all);
    }

    // ------------------------------------------------------------ the lock
    {
        const c = fresh();
        const held = { pid: process.pid, at: iso(Date.now()) };
        plantLock(c, held);
        const lockBytes = read(c.lock);
        const before = read(c.list);
        const t0 = Date.now();
        const r = sync(c, ['run', '--dump', c.dump, '--wait-s', '1']);
        const waited = Date.now() - t0;
        check('lock held: exit 3 after waiting, naming the holder', r.code === 3 && waited >= 900 && r.err.includes(`brain-clock lock is held by pid ${process.pid}`), `${waited}ms ${r.all}`);
        check('lock held: nothing written and the lock left alone', read(c.list) === before && read(c.lock) === lockBytes && !fs.existsSync(c.stamp) && !fs.existsSync(c.index), J(tree(c.claude)));
    }
    {
        const c = fresh();
        plantLock(c, { pid: deadPid(), at: iso(Date.now()) });
        const r = sync(c, ['run', '--dump', c.dump, '--wait-s', '0']);
        check('stale lock: a dead holder is taken over', r.code === 0 && /took over a stale lock/.test(r.out) && !fs.existsSync(c.lock), r.all);
        plantLock(c, { pid: process.pid, at: iso(Date.now() - 11 * 60000) });
        const old = new Date(Date.now() - 11 * 60000);
        fs.utimesSync(c.lock, old, old);
        const liveBytes = read(c.lock);
        const r2 = sync(c, ['run', '--dump', c.dump, '--wait-s', '0']);
        check('live lock: a live holder keeps the lock whatever its age', r2.code === 3 && read(c.lock) === liveBytes && r2.err.includes(`brain-clock lock is held by pid ${process.pid}`), r2.all);
        fs.writeFileSync(c.lock, '');
        fs.utimesSync(c.lock, old, old);
        const r3 = sync(c, ['run', '--dump', c.dump, '--wait-s', '0']);
        check('stale lock: an ownerless lock over 10 minutes old is taken over', r3.code === 0 && !fs.existsSync(c.lock), r3.all);
    }

    // ------------------------------------------------------------ the real clock, both directions
    {
        // One copy of the rule: board-sync takes the clock's lock through the clock's own functions.
        const ours = read(SUBJECT) || '';
        const clockLock = require(CLOCK);
        const sub = require(SUBJECT);
        const oneRule = sub.LOCK === clockLock.LOCK_PATH && typeof clockLock.takeLock === 'function' && typeof clockLock.dropLock === 'function'
            && /clock\.takeLock\(/.test(ours) && /clock\.dropLock\(/.test(ours)
            && !/flag: "wx"|LOCK_STALE_MS|pidAlive|unlinkSync\(LOCK\)|writeFileSync\(LOCK/.test(ours);
        check('clock: board-sync takes the lock only through brain-clock.js', oneRule, `lock ${sub.LOCK} vs ${clockLock.LOCK_PATH}`);

        const c = fresh();
        const helper = path.join(c.root, 'hold-lock.js');
        fs.writeFileSync(helper, [
            "const s = require(process.argv[2]);",
            "const r = s.takeLock(0);",
            "process.stdout.write(JSON.stringify(Object.assign({ pid: process.pid }, r)) + '\\n');",
            "process.stdin.resume();",
            "process.stdin.on('end', () => { s.dropLock(); });",
        ].join('\n'), 'utf8');
        const h = spawn(process.execPath, [helper, SUBJECT], { env: c.env, stdio: ['pipe', 'pipe', 'pipe'] });
        const first = await new Promise((resolve) => {
            let buf = '';
            const done = setTimeout(() => resolve(null), 15000);
            h.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) { clearTimeout(done); resolve(buf.split('\n')[0]); } });
        });
        let got = null;
        try { got = JSON.parse(first); } catch { got = null; }
        const fx = path.join(c.root, 'gh-fixture.json');
        fs.writeFileSync(fx, J({ open: {}, view: {} }));
        const clockEnv = Object.assign({}, process.env, { BRAIN_CLOCK_CLAUDE_DIR: c.claude, BRAIN_CLOCK_DESKTOP_DIR: path.join(c.root, 'desktop'), BRAIN_CLOCK_ROLE_CHECKER: 'off', BRAIN_CLOCK_GH_FIXTURE: fx, BRAIN_CLOCK_WORKER_RECONCILE: 'off', BRAIN_CLOCK_BRAIN_JUDGE: 'off' });
        const k = spawnSync(process.execPath, [CLOCK, 'tick', '--observe'], { encoding: 'utf8', env: clockEnv, timeout: 60000 });
        let tick = null;
        try { tick = JSON.parse(k.stdout); } catch { tick = null; }
        h.stdin.end();
        await new Promise((resolve) => { if (h.exitCode !== null) resolve(); else h.on('exit', resolve); });
        check('clock: brain-clock.js skips its pass while board-sync holds the lock', got && got.acquired && tick && tick.skipped === true && String(tick.reason).includes(`lock held by pid ${got.pid}`) && !fs.existsSync(c.lock), `helper ${first} clock ${k.stdout} ${k.stderr}`);
    }

    // ------------------------------------------------------------ dry run
    {
        const c = fresh();
        const r1 = sync(c, ['run', '--dump', c.dump]);
        writeDump(c, BASE_ITEMS.concat([item('A4', { group: 'backlog' })]).filter((i) => i.code !== 'A1'));
        const before = tree(c.root);
        const d = sync(c, ['run', '--dump', c.dump, '--dry-run']);
        check('dry run: exit 0 and names the rows that would change', r1.code === 0 && d.code === 0 && /Nothing written/.test(d.out) && /open rows added: A4/.test(d.out) && /open rows gone: A1/.test(d.out) && /Needs you 1 -> 0/.test(d.out), d.all);
        check('dry run: writes nothing (whole fixture tree identical)', J(tree(c.root)) === J(before), J(before) + '\n' + J(tree(c.root)));
        const c2 = fresh();
        const before2 = tree(c2.root);
        const d2 = sync(c2, ['run', '--dump', c2.dump, '--dry-run']);
        check('dry run: on a first sync it creates no folder, lock or stamp', d2.code === 0 && J(tree(c2.root)) === J(before2) && !fs.existsSync(c2.claude), d2.all);
    }

    // ------------------------------------------------------------ F1: lines already on the board (2026-10-12)
    {
        const c = fresh();
        const applied = '- 2026-09-24T09:00Z | tester | A3 | done | shipped, the board already shows it done';
        fs.writeFileSync(c.list, LIST_TEXT.replace('## Inbox (append only)\n', `## Inbox (append only)\n${applied}\n`), 'utf8');
        const before = tree(c.root);
        const d = sync(c, ['run', '--dump', c.dump, '--dry-run']);
        check('already applied: dry run counts them apart from the lines to apply and writes nothing', d.code === 0 && /plan: 1 Inbox lines to apply, 1 already on the board \(a real run removes them from the Inbox\), 1 conflicts/.test(d.out) && J(tree(c.root)) === J(before), d.all);
        const r = sync(c, ['run', '--dump', c.dump]);
        const text = read(c.list) || '';
        const s = readJson(c.stamp) || {};
        check('already applied: run removes them from the Inbox and keeps the lines with work', r.code === 0 && !text.includes(applied) && text.includes('fixture: a new line') && text.includes('older than the board') && /1 already on the board, removed from the Inbox/.test(r.out), r.all + text.slice(text.indexOf('## Inbox')));
        check('already applied: the stamp records the count apart from apply', s.apply === 1 && s.alreadyApplied === 1 && s.conflicts === 1, J(s));
        const st = sync(c, ['status']);
        check('already applied: status reports the count separately', st.code === 0 && /, 1 Inbox lines to apply, 1 already on the board and removed from the Inbox,/.test(st.out), st.all);
        const r2 = sync(c, ['run', '--dump', c.dump]);
        check('already applied: the next run finds none left', r2.code === 0 && (readJson(c.stamp) || {}).alreadyApplied === 0 && (readJson(c.stamp) || {}).apply === 1, r2.all);
    }

    // ------------------------------------------------------------ status on its own
    {
        const c = fresh();
        const r = sync(c, ['status']);
        check('status: a missing stamp exits 1', r.code === 1 && /no stamp at/.test(r.out), r.all);
        fs.mkdirSync(c.autodev, { recursive: true });
        fs.writeFileSync(c.stamp, J({ exportedAt: new Date(Date.now() - 30 * 3600000).toISOString(), items: 5, conflicts: 0, apply: 0, configDir: '~/.claude', lastAttempt: { at: new Date(Date.now() - 30 * 3600000).toISOString(), exit: 0, reason: null } }));
        const r2 = sync(c, ['status']);
        check('status: a stamp older than the limit exits 1', r2.code === 1 && /^board-sync: STALE, exported 30h ago/.test(r2.out), r2.all);
        const r3 = sync(c, ['status', '--max-age-h', '48']);
        check('status: --max-age-h moves the limit', r3.code === 0 && /fresh/.test(r3.out) && /limit 48h/.test(r3.out), r3.all);
    }

    // ------------------------------------------------------------ which account ran it
    {
        const c = fresh();
        const r = sync(c, ['run', '--dump', c.dump], { CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude-b') });
        const s = readJson(c.stamp) || {};
        check('account: the stamp names the config dir that ran it', r.code === 0 && s.configDir === '~/.claude-b' && s.configDirFrom === 'CLAUDE_CONFIG_DIR', J(s));
    }

    // ------------------------------------------------------------ a child that fails or lies
    {
        const c = fresh();
        const r = sync(c, ['run', '--dump', c.dump], { STUB_EXPORT: 'fail' });
        check('child failure: an export that exits 1 is named', r.code === 1 && /the export exited 1: open-loops-mirror: planted export failure/.test(r.err) && !(readJson(c.stamp) || {}).exportedAt, r.all);
        const r2 = sync(c, ['run', '--dump', c.dump], { STUB_EXPORT: 'noop' });
        check('child failure: an export that exits 0 but writes nothing is caught', r2.code === 1 && /exited 0 but the block does not carry this run's export/.test(r2.err) && !(readJson(c.stamp) || {}).exportedAt, r2.all);
    }

    // ------------------------------------------------------------ a missing exporter
    {
        const c = fresh();
        const empty = path.join(c.root, 'no-scripts');
        fs.mkdirSync(empty, { recursive: true });
        const before = read(c.list);
        const r = sync(c, ['run', '--dump', c.dump], { BOARD_SYNC_SCRIPTS_DIR: empty });
        check('missing exporter: exit 1 naming the script and the setting, list untouched', r.code === 1 && /needs open-loops-mirror\.js/.test(r.err) && /BOARD_SYNC_SCRIPTS_DIR/.test(r.err) && read(c.list) === before && !fs.existsSync(c.plan) && !fs.existsSync(c.lock), r.all);
    }

    // ------------------------------------------------------------ paths from the runtime config
    {
        const c = fresh();
        delete c.env.BOARD_SYNC_LIST;
        delete c.env.BOARD_SYNC_SCRIPTS_DIR;
        fs.mkdirSync(path.join(c.autodev, 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(c.autodev, 'runtime', 'config.json'), J({ boardSync: { list: c.list, scriptsDir: FAKES } }));
        const r = sync(c, ['run', '--dump', c.dump]);
        check('config: boardSync.list and boardSync.scriptsDir are read when the env is unset', r.code === 0 && blockOf(read(c.list) || '').startLine.includes('sha256=') && !fs.existsSync(path.join(c.autodev, 'OUTSTANDING.md')), r.all);
        fs.rmSync(path.join(c.autodev, 'runtime', 'config.json'));
        const r2 = sync(c, ['run', '--dump', c.dump]);
        check('config: with no env and no config the list defaults under the autodev folder', r2.code === 1 && r2.err.includes('no list at') && r2.err.includes('OUTSTANDING.md'), r2.all);
    }

    // ------------------------------------------------------------ the interface board-sync keeps
    {
        const sub = require(SUBJECT);
        const names = ['tryLock', 'takeLock', 'dropLock', 'readBlock', 'sha', 'LOCK', 'GENERATED_RE'];
        check('interface: exports tryLock, takeLock, dropLock, readBlock, sha, LOCK and GENERATED_RE', names.every((n) => n in sub) && sub.GENERATED_RE instanceof RegExp && typeof sub.sha === 'function', Object.keys(sub).join(','));
        const h = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8' });
        check('interface: --help names the run and status verbs', h.status === 0 && /run --dump <dir>/.test(h.stdout) && /status \[--max-age-h 24\]/.test(h.stdout), h.stdout + h.stderr);
    }

    process.stdout.write(`${failed === 0 ? 'ALL PASSED' : failed + ' FAILED'}\n`);
}

// ---------------------------------------------------------------- plant mode
// Each plant is derived from the subject by one exact, counted replacement. It must make the
// named checks fail. A plant whose anchor is missing or repeated is itself a failure.
const PLANTS = [
    { name: 'skip the empty-dump refusal', find: 'if (!files.length) throw new Fail(2,', replace: 'if (false) throw new Fail(2,', expect: ['empty dump: exit 2'] },
    { name: 'skip the unreadable-file refusal', find: 'if (bad.length) throw new Fail(2,', replace: 'if (false) throw new Fail(2,', expect: ['unreadable dump: exit 2'] },
    { name: 'skip the partial-dump refusal', find: 'if (!prior || allow || count >= Math.ceil(prior.n * SHRINK_FLOOR)) return;', replace: 'return;', expect: ['partial dump: exit 2'] },
    { name: 'skip the hand-edit precheck', find: 'if (!b.recorded || b.recorded === b.actual) return;', replace: 'return;', expect: ['hand-edited block: list, index and plan untouched', 'dry run: predicts the hand-edit refusal'] },
    { name: 'take the lock without writing it', find: 'function takeLock(waitMs) {', replace: 'function takeLock(waitMs) { return { acquired: true };', expect: ['lock held: exit 3', 'clock: brain-clock.js skips its pass'] },
    { name: 'take over an old lock by age', find: '  return clock.takeLock(Date.now(), { waitMs, by: "board-sync" });', replace: '  try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10 * 60000) fs.unlinkSync(LOCK); } catch {}\n  return clock.takeLock(Date.now(), { waitMs, by: "board-sync" });', expect: ['live lock: a live holder keeps the lock', 'clock: board-sync takes the lock only through'] },
    { name: 'ignore --dry-run', find: 'const out = o["dry-run"] ? dryRun(o) : run(o);', replace: 'const out = run(o);', expect: ['dry run: writes nothing', 'dry run: on a first sync'] },
    { name: 'skip the stamp write', find: 'writeJson(STAMP, Object.assign(readJsonOr(STAMP, {}) || {}, exported,', replace: '0 && writeJson(STAMP, Object.assign(readJsonOr(STAMP, {}) || {}, exported,', expect: ['happy: stamp records', 'status: agrees with the stamp'] },
    { name: 'status ignores the age limit', find: 'const stale = age > maxH * 3600000;', replace: 'const stale = false;', expect: ['status: a stamp older than the limit'] },
    { name: 'ignore a child exit code', find: 'if (r.status !== 0) throw new Fail(1,', replace: 'if (false) throw new Fail(1,', expect: ['child failure: an export that exits 1'] },
    { name: 'run a missing exporter anyway', find: 'if (!fs.existsSync(path.join(SCRIPTS, script))) throw new Fail(1,', replace: 'if (false) throw new Fail(1,', expect: ['missing exporter: exit 1 naming the script'] },
    { name: 'ignore the runtime config', find: 'const CONFIG = runtimeConfig();', replace: 'const CONFIG = {};', expect: ['config: boardSync.list and boardSync.scriptsDir'] },
    { name: 'skip the block-time verification', find: 'if (!(gen >= Math.floor(started / 60000) * 60000) || after.recorded !== after.actual) {', replace: 'if (false) {', expect: ['child failure: an export that exits 0 but writes nothing'] },
    { name: 'record a fixed config dir', find: 'const env = process.env.CLAUDE_CONFIG_DIR;', replace: 'const env = "";', expect: ['account: the stamp names the config dir'] },
    { name: 'export without consuming already-applied lines', find: '["export", "--dump", dump, "--file", list, "--already-applied", PLAN]', replace: '["export", "--dump", dump, "--file", list]', expect: ['already applied: run removes them', 'already applied: the next run finds none left'] },
    { name: 'status folds already-applied into nothing', find: 'const applied = Number.isInteger(s.alreadyApplied)', replace: 'const applied = false && Number.isInteger(s.alreadyApplied)', expect: ['already applied: status reports the count separately'] },
];

function plantMain() {
    const real = REAL;
    const src = fs.readFileSync(real, 'utf8');
    const runSuite = (subject) => {
        const r = spawnSync(process.execPath, [__filename], { encoding: 'utf8', env: Object.assign({}, process.env, { BOARD_SYNC_SUBJECT: subject }), timeout: 600000 });
        const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5));
        return { code: r.status, fails, passed: /ALL PASSED/.test(r.stdout || ''), tail: (r.stdout || '').trim().split('\n').slice(-1)[0] + (r.stderr ? ' | ' + r.stderr.trim().slice(0, 300) : '') };
    };
    let bad = 0;
    const control = runSuite(real);
    process.stdout.write(`control (unplanted): ${control.passed && control.code === 0 ? 'all checks pass' : 'FAILED ' + control.fails.join('; ') + ' ' + control.tail}\n`);
    if (!control.passed || control.code !== 0) bad++;
    for (const p of PLANTS) {
        const count = src.split(p.find).length - 1;
        if (count !== 1) { process.stdout.write(`plant "${p.name}": ANCHOR found ${count} times, expected 1\n`); bad++; continue; }
        const dir = path.join(TMP, 'plant-' + crypto.createHash('sha1').update(p.name).digest('hex').slice(0, 8));
        fs.mkdirSync(dir, { recursive: true });
        const planted = path.join(dir, 'board-sync.js');
        fs.writeFileSync(planted, src.replace(p.find, p.replace), 'utf8');
        const r = runSuite(planted);
        const missing = p.expect.filter((e) => !r.fails.some((f) => f.startsWith(e)));
        const fired = r.code !== 0 && missing.length === 0;
        if (!fired) bad++;
        process.stdout.write(`plant "${p.name}": ${fired ? 'fired' : 'SURVIVED'}, ${r.fails.length} checks failed${missing.length ? `, expected to fail but did not: ${missing.join('; ')}` : ''}\n`);
    }
    process.stdout.write(bad ? `${bad} PLANT PROBLEMS\n` : `ALL ${PLANTS.length} PLANTS FIRED\n`);
    return bad ? 1 : 0;
}

(async () => {
    try {
        if (process.argv.includes('--plant')) process.exitCode = plantMain();
        else { await main(); process.exitCode = failed ? 1 : 0; }
    } catch (e) {
        process.stdout.write(`FAIL suite crashed: ${e && e.stack}\n`);
        process.exitCode = 1;
    } finally {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
})();
