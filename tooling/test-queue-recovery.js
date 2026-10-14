#!/usr/bin/env node
'use strict';
/**
 * Suite for plugins/autodev-core/scripts/ask-queue.js: durable, account-independent ingestion.
 *
 * Accepts 20 asks and drives them through denied board access, access lost mid-drain, two concurrent
 * drains, a crash at every step of accept and dispatch, a stale claimant and two concurrent edits.
 * Every queue call is a real subprocess. Crashes are real kills (ASK_QUEUE_CRASH_AT). The board is
 * FAKE_BOARD below: an append-only file, so a second delivery of one ask shows up as a second line,
 * the worst case for a non-idempotent effect. No network, and every write lands in a temp dir.
 *
 * Prints one "ok <name>" or "FAIL <name>" per check, then the acceptance line:
 *   accepted=<n> retained=<n> duplicate_dispatches=<n> conflicts_preserved=PASS|FAIL uncertain_effects=HELD|REPLAYED|NOT-HELD
 * Exits 1 when any check fails.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SUBJECT = path.resolve(__dirname, '../plugins/autodev-core/scripts/ask-queue.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-recovery-'));
const BOARD = path.join(TMP, 'board.jsonl');
const MODE = path.join(TMP, 'board-mode');
const FAKE = path.join(TMP, 'fake-board.js');

// deliver appends one line, or exits 3 when the mode denies access. "allow-N" lets N more through.
// lookup answers whether a line for the intent and rev exists.
fs.writeFileSync(FAKE, `'use strict';
const fs = require('fs');
const verb = process.argv[2];
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const mode = fs.readFileSync(process.env.FAKE_BOARD_MODE_FILE, 'utf8').trim();
if (mode === 'deny') { process.stderr.write('board: access denied\\n'); process.exitCode = 3; return; }
const lines = fs.existsSync(process.env.FAKE_BOARD_FILE) ? fs.readFileSync(process.env.FAKE_BOARD_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
if (verb === 'lookup') {
  process.stdout.write(JSON.stringify({ found: lines.some((l) => l.intentId === input.intentId && l.rev === input.rev) }));
  return;
}
const m = /^allow-(\\d+)$/.exec(mode);
if (m) {
  if (Number(m[1]) === 0) { process.stderr.write('board: access lost\\n'); process.exitCode = 3; return; }
  fs.writeFileSync(process.env.FAKE_BOARD_MODE_FILE, 'allow-' + (Number(m[1]) - 1));
}
fs.appendFileSync(process.env.FAKE_BOARD_FILE, JSON.stringify(input) + '\\n');
if (mode === 'write-then-fail') { process.stderr.write('board: timed out\\n'); process.exitCode = 1; return; }
process.stdout.write(JSON.stringify({ receipt: 'line ' + (lines.length + 1) }));
`);

const ENV = Object.assign({}, process.env, {
    BRAIN_CLOCK_CLAUDE_DIR: path.join(TMP, 'claude'),
    ASK_QUEUE_DIR: path.join(TMP, 'queue'),
    ASK_QUEUE_BOARD: FAKE,
    FAKE_BOARD_FILE: BOARD,
    FAKE_BOARD_MODE_FILE: MODE,
});
delete ENV.ASK_QUEUE_CRASH_AT;
delete ENV.ASK_QUEUE_PAUSE_AT;

let failed = 0;
function check(name, ok, detail) {
    process.stdout.write(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : ': ' + String(detail).slice(0, 600)}\n`);
    if (!ok) failed++;
}
function mode(m) { fs.writeFileSync(MODE, m); }
function parse(stdout) { try { return JSON.parse(String(stdout).trim().split('\n').pop()); } catch { return null; } }
function q(argv, extra = {}) {
    const r = spawnSync(process.execPath, [SUBJECT, ...argv], { env: Object.assign({}, ENV, extra), encoding: 'utf8', timeout: 60000, windowsHide: true });
    return { code: r.status, signal: r.signal, out: r.stdout + r.stderr, json: parse(r.stdout) };
}
function qAsync(argv, extra = {}) {
    return new Promise((resolve) => {
        const c = spawn(process.execPath, [SUBJECT, ...argv], { env: Object.assign({}, ENV, extra), windowsHide: true });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { out += d; });
        c.on('close', (code) => resolve({ code, out, json: parse(out) }));
    });
}
function board() { return fs.existsSync(BOARD) ? fs.readFileSync(BOARD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
function onBoard(id) { return board().filter((l) => l.intentId === id).length; }
function record(id) { try { return JSON.parse(fs.readFileSync(path.join(ENV.ASK_QUEUE_DIR, 'intents', `${id}.json`), 'utf8')); } catch { return null; } }
function stateOf(id) { const s = q(['status']); return s.json && s.json.ok ? s.json.value.intents[id] : null; }
// The Brain clock reads the queue as its ask-queue source. Its other sources are absent here.
const CLOCK = path.resolve(__dirname, '../plugins/autodev-core/scripts/brain-clock.js');
function clockPass() {
    const gh = path.join(TMP, 'gh.json');
    if (!fs.existsSync(gh)) fs.writeFileSync(gh, JSON.stringify({ open: {}, view: {} }));
    const env = Object.assign({}, ENV, { BRAIN_CLOCK_DESKTOP_DIR: path.join(TMP, 'desktop'), BRAIN_CLOCK_ROLE_CHECKER: 'off', BRAIN_CLOCK_GH_FIXTURE: gh, BRAIN_CLOCK_WORKER_RECONCILE: 'off', BRAIN_CLOCK_BRAIN_JUDGE: 'off', BRAIN_CLOCK_PS: 'off' });
    const r = spawnSync(process.execPath, [CLOCK, 'tick', '--observe'], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    let doc = null;
    try { doc = JSON.parse(r.stdout); } catch { doc = null; }
    const line = ((doc || {}).sources || []).find((l) => l.startsWith('ask-queue: ')) || '';
    const evFile = path.join(ENV.BRAIN_CLOCK_CLAUDE_DIR, 'autodev', 'events.jsonl');
    const events = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { code: r.status, line, events, out: r.stdout + r.stderr };
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// body -> intent id, filled only by an accept that exited 0. everAccepted keeps every id an accept
// ever returned, so an id that is not stable shows up as extra accepted asks.
const accepted = new Map();
const everAccepted = new Map();
function accept(body, extra) {
    const r = q(['accept', '--source', 'test', '--body', body], extra);
    if (r.code === 0 && r.json && r.json.ok) {
        if (!accepted.has(body)) accepted.set(body, r.json.value.intentId);
        everAccepted.set(r.json.value.intentId, body);
    }
    return r;
}
const id = (body) => accepted.get(body);

async function main() {
    // 1. Board access denied: every ask is accepted locally and retained, nothing reaches the board.
    mode('deny');
    const D = Array.from({ length: 8 }, (_, i) => `denied ask ${i + 1}: rotate the staging key`);
    const da = D.map((b) => accept(b));
    check('accept works while the board is denied', da.every((r) => r.code === 0 && r.json.value.created), da.map((r) => r.out).join(' | '));
    const dd = q(['drain']);
    check('a denied drain retains every ask', dd.code === 0 && dd.json.value.counts.retained === 8 && board().length === 0, dd.out);
    const noAdapter = q(['drain'], { ASK_QUEUE_BOARD: '' });
    check('a drain with no board adapter retains every ask', noAdapter.code === 0 && noAdapter.json.value.counts.retained === 8 && board().length === 0, noAdapter.out);
    const st = q(['status']);
    check('denied asks read as pending', st.json && st.json.value.counts.pending === 8, st.out);

    // 2. Access lost mid-drain: one delivery lands, the rest stay retained.
    const L = Array.from({ length: 3 }, (_, i) => `lost-access ask ${i + 1}: rerun the nightly export`);
    L.forEach((b) => accept(b));
    mode('allow-1');
    const ld = q(['drain']);
    check('access lost mid-drain delivers one and retains ten', ld.code === 0 && ld.json.value.counts.delivered === 1 && ld.json.value.counts.retained === 10 && board().length === 1, ld.out);

    // 3. Access returns: two drains race, and each ask lands once.
    mode('allow');
    const [a, b] = await Promise.all([qAsync(['drain']), qAsync(['drain'])]);
    const both = [...D, ...L].map((x) => onBoard(id(x)));
    check('two concurrent drains deliver each ask once', a.code === 0 && b.code === 0 && both.every((n) => n === 1), `${a.out} | ${b.out} | ${both}`);

    const base = clockPass();
    check('the Brain clock reads the queue as a source', base.code === 0 && /^ask-queue: 11 intents, 0 pending, 0 held/.test(base.line), base.out);

    // 4. A crash at each step.
    const C = Array.from({ length: 6 }, (_, i) => `crash ask ${i + 1}: refresh the price list`);
    const c1 = accept(C[0], { ASK_QUEUE_CRASH_AT: 'accept-before-publish' });
    check('a crash before publish leaves no ack and no record', c1.code !== 0 && !id(C[0]) && q(['status']).json.value.total === 11, c1.out);
    const c1b = accept(C[0]);
    check('the retried accept creates the intent', c1b.code === 0 && c1b.json.value.created === true, c1b.out);
    const c2 = accept(C[1], { ASK_QUEUE_CRASH_AT: 'after-accept' });
    const c2b = accept(C[1]);
    check('a crash after publish, then a retry, is one intent', c2.code !== 0 && c2b.code === 0 && c2b.json.value.created === false && q(['status']).json.value.total === 13, `${c2.out} | ${c2b.out}`);
    C.slice(2).forEach((x) => accept(x));
    const points = ['after-claim', 'after-outbox', 'after-effect', 'after-ack'];
    // An adapter that wrote and then failed gives no clear answer: held, never retried.
    mode('write-then-fail');
    const un = q(['dispatch', '--intent', id(C[1])]);
    mode('allow');
    check('an adapter failure after the write holds the intent', un.code === 0 && un.json.value.outcome === 'held' && onBoard(id(C[1])) === 1, un.out);
    const crashes = points.map((p, i) => q(['dispatch', '--intent', id(C[2 + i])], { ASK_QUEUE_CRASH_AT: p }));
    check('every dispatch crash point killed its process', crashes.every((r) => r.code !== 0 && !(r.json && r.json.ok)), crashes.map((r) => r.out).join(' | '));
    const before = C.slice(2).map((x) => onBoard(id(x)));
    check('the effect crash points left the board as expected', before.join(',') === '0,0,1,1', before.join(','));
    const cd = q(['drain']);
    const after = C.slice(2).map((x) => onBoard(id(x)));
    const states = C.slice(2).map((x) => stateOf(id(x)));
    check('a crash after claim is redispatched under a new epoch', after[0] === 1 && states[0] === 'delivered' && record(id(C[2])).deliveries[0].epoch === 2, `${after} ${states} ${cd.out}`);
    const uncertainHeld = states[1] === 'held' && states[2] === 'held' && stateOf(id(C[1])) === 'held';
    const replayed = after[1] > before[1] || after[2] > before[2] || onBoard(id(C[1])) > 1;
    check('a crash after the outbox mark is held, not replayed', states[1] === 'held' && after[1] === 0, `${states} ${after}`);
    check('a crash after the effect is held, not replayed', states[2] === 'held' && after[2] === 1, `${states} ${after}`);
    check('a crash after ack stays delivered', states[3] === 'delivered' && after[3] === 1, `${states} ${after}`);
    const pass = clockPass();
    const heldEv = pass.events.filter((e) => e.type === 'intent.held').map((e) => e.key).sort();
    check('the Brain clock raises one event per held intent', /, 3 held,/.test(pass.line) && heldEv.join() === [id(C[1]), id(C[3]), id(C[4])].sort().join(), `${pass.line} ${heldEv}`);
    const r4 = q(['reconcile', '--intent', id(C[3])]);
    const r5 = q(['reconcile', '--intent', id(C[4])]);
    const r2 = q(['reconcile', '--intent', id(C[1])]);
    check('reconcile marks the failed-after-write effect as delivered', r2.code === 0 && r2.json.value.found === true && r2.json.value.state === 'delivered', r2.out);
    check('reconcile returns an effect the board lacks to pending', r4.code === 0 && r4.json.value.found === false && r4.json.value.state === 'pending', r4.out);
    check('reconcile marks an effect the board shows as delivered', r5.code === 0 && r5.json.value.found === true && r5.json.value.state === 'delivered', r5.out);
    q(['drain']);
    const crashFinal = C.map((x) => onBoard(id(x)));
    check('every crash ask lands exactly once', crashFinal.every((n) => n === 1), crashFinal.join(','));

    // 5. A stale claimant: A claims with a short lease and stalls, B takes over and delivers, A wakes.
    const S = 'stale-claimant ask: close the duplicate ticket';
    accept(S);
    const gate = path.join(TMP, 'gate');
    const pa = qAsync(['dispatch', '--intent', id(S), '--lease-ms', '300'], { ASK_QUEUE_PAUSE_AT: 'after-claim', ASK_QUEUE_PAUSE_FILE: gate });
    for (let i = 0; i < 500 && !fs.existsSync(`${gate}.reached`); i++) await wait(20);
    await wait(400);
    const sb = q(['dispatch', '--intent', id(S)]);
    fs.writeFileSync(gate, 'go');
    const sa = await pa;
    check('a new claimant takes over an expired lease', sb.code === 0 && sb.json.value.outcome === 'delivered' && sb.json.value.epoch === 2, sb.out);
    check('the stale claimant is refused by the fence', sa.code === 4 && sa.json && sa.json.error.code === 'fenced', sa.out);
    check('the stale claimant wrote nothing to the board', onBoard(id(S)) === 1, onBoard(id(S)));

    // 6. Conflicting edits: both kept, nothing delivered until resolved. A clean edit chain is no conflict.
    const X1 = 'conflict ask: set the launch date';
    const X2 = 'edited ask: pick the newsletter subject';
    accept(X1);
    accept(X2);
    const e1 = q(['edit', '--intent', id(X1), '--base-rev', '1', '--body', 'launch on the 20th', '--by', 'one']);
    const e2 = q(['edit', '--intent', id(X1), '--base-rev', '1', '--body', 'launch on the 27th', '--by', 'two']);
    q(['edit', '--intent', id(X2), '--base-rev', '1', '--body', 'subject: autumn notes']);
    const e3 = q(['edit', '--intent', id(X2), '--base-rev', '2', '--body', 'subject: autumn field notes']);
    check('a sequential edit is not a conflict', e3.json.value.conflict === false && e3.json.value.rev === 3, e3.out);
    const xd = q(['drain']);
    const xr = record(id(X1));
    const headBodies = xr ? xr.revs.filter((r) => !xr.revs.some((o) => o.parents.includes(r.rev))).map((r) => r.body).sort() : [];
    const kept = e1.json.value.conflict === false && e2.json.value.conflict === true && headBodies.join('|') === 'launch on the 20th|launch on the 27th';
    check('two edits from one base keep both bodies', kept, `${e1.out} ${e2.out} ${headBodies}`);
    const refused = xd.json.value.results.some((r) => r.intentId === id(X1) && r.outcome === 'conflict') && onBoard(id(X1)) === 0;
    check('a conflicted intent is not delivered', refused, xd.out);
    const rs = q(['resolve', '--intent', id(X1), '--body', 'launch on the 27th, announce on the 20th']);
    q(['drain']);
    const x1b = board().filter((l) => l.intentId === id(X1));
    const x2b = board().filter((l) => l.intentId === id(X2));
    const resolvedOnce = rs.code === 0 && x1b.length === 1 && x1b[0].body === 'launch on the 27th, announce on the 20th';
    check('the resolved body is delivered once', resolvedOnce, JSON.stringify(x1b));
    check('the clean edit delivers its last rev', x2b.length === 1 && x2b[0].rev === 3, JSON.stringify(x2b));

    // Retained is counted before anything is accepted again, so a lost record cannot be re-created
    // into the count.
    const retainedIds = [...everAccepted].filter(([i, body]) => { const r = record(i); return r && r.revs.some((x) => x.body === body); }).map(([i]) => i);

    // 7. Idempotence: every ask accepted again is the same intent, and a further drain writes nothing.
    const lines = board().length;
    const again = [...accepted.keys()].map((body) => ({ body, r: accept(body) }));
    check('accepting every ask again creates nothing', again.every(({ body, r }) => r.code === 0 && r.json.value.created === false && r.json.value.intentId === accepted.get(body)), again.filter(({ r }) => !(r.json && r.json.value && r.json.value.created === false)).map(({ r }) => r.out).join(' | '));
    const fd = q(['drain']);
    check('a final drain writes nothing new', fd.code === 0 && board().length === lines, `${lines} -> ${board().length}`);
    const fs2 = q(['status']);
    check('every intent ends delivered', fs2.json && fs2.json.value.counts.delivered === fs2.json.value.total && fs2.json.value.total === accepted.size, fs2.out);

    // The tally.
    const ids = [...everAccepted.keys()];
    const groups = new Map();
    for (const l of board()) groups.set(`${l.key}\u0000${l.rev}`, (groups.get(`${l.key}\u0000${l.rev}`) || 0) + 1);
    const dup = [...groups.values()].reduce((s, n) => s + Math.max(0, n - 1), 0);
    check('every accepted ask is on the board once', ids.every((i) => onBoard(i) === 1), ids.map(onBoard).join(','));
    const conflicts = kept && refused && resolvedOnce ? 'PASS' : 'FAIL';
    const uncertain = replayed ? 'REPLAYED' : uncertainHeld ? 'HELD' : 'NOT-HELD';
    process.stdout.write(`accepted=${ids.length} retained=${retainedIds.length} duplicate_dispatches=${dup} conflicts_preserved=${conflicts} uncertain_effects=${uncertain}\n`);
}

main()
    .catch((e) => { check('suite ran', false, e && e.stack); })
    .finally(() => {
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ }
        process.exitCode = failed ? 1 : 0;
    });
